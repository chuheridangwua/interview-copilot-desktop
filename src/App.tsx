import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AudioLines,
  CircleStop,
  FileText,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Unlock,
} from "lucide-react";
import {
  api,
  AudioSource,
  AudioStatusEvent,
  AsrTextEvent,
  CaptureMode,
  isDesktopRuntime,
  listenEvent,
  MatchCandidate,
  MatchCandidatesEvent,
  SessionSettings,
} from "./desktopClient";

const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";

interface TranscriptLine {
  text: string;
  receivedAt: number;
}

interface QuestionRecord {
  id: string;
  query: string;
  receivedAt: number;
  candidates: MatchCandidate[];
  selectedCandidate: MatchCandidate | null;
  locked: boolean;
}

function cls(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

function formatTime(value: number) {
  return new Date(value || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function isTextInputTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

function highlightAnswer(answer: string, terms: string[]) {
  const cleanedTerms = [...new Set(terms.filter((term) => term.trim().length >= 2))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 16);

  if (cleanedTerms.length === 0) {
    return answer.split(/\n+/).map((line, index) => <p key={index}>{line}</p>);
  }

  return answer.split(/\n+/).map((line, paragraphIndex) => {
    const parts: Array<string | JSX.Element> = [line];
    cleanedTerms.forEach((term) => {
      const lowerTerm = term.toLowerCase();
      const nextParts: Array<string | JSX.Element> = [];
      parts.forEach((part, partIndex) => {
        if (typeof part !== "string") {
          nextParts.push(part);
          return;
        }
        const lower = part.toLowerCase();
        const foundAt = lower.indexOf(lowerTerm);
        if (foundAt < 0) {
          nextParts.push(part);
          return;
        }
        nextParts.push(part.slice(0, foundAt));
        nextParts.push(
          <mark key={`${paragraphIndex}-${partIndex}-${term}-${foundAt}`}>{part.slice(foundAt, foundAt + term.length)}</mark>,
        );
        nextParts.push(part.slice(foundAt + term.length));
      });
      parts.splice(0, parts.length, ...nextParts);
    });

    return <p key={paragraphIndex}>{parts}</p>;
  });
}

export default function App() {
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("wasapi_loopback");
  const [resourceId, setResourceId] = useState(DEFAULT_RESOURCE_ID);
  const [saveAudio, setSaveAudio] = useState(false);
  const [running, setRunning] = useState(false);
  const [matchingPaused, setMatchingPaused] = useState(false);
  const [locked, setLocked] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatusEvent>({
    state: isDesktopRuntime() ? "idle" : "error",
    message: isDesktopRuntime() ? "空格开始监听系统声音" : "未检测到 Electron 桌面端后端",
  });
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [partialText, setPartialText] = useState("");
  const [questionRecords, setQuestionRecords] = useState<QuestionRecord[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<MatchCandidate | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const compatibleSources = useMemo(
    () => sources.filter((source) => source.captureMode === captureMode),
    [captureMode, sources],
  );

  const hasVirtualSource = useMemo(
    () => sources.some((source) => source.captureMode === "virtual_audio_device"),
    [sources],
  );

  useEffect(() => {
    let disposed = false;

    async function loadSources() {
      if (!isDesktopRuntime()) return;
      try {
        const nextSources = await api.listAudioSources();
        if (disposed) return;
        setSources(nextSources);
        const defaultSource = nextSources.find((source) => source.isDefault && source.captureMode === "wasapi_loopback") ?? nextSources[0];
        if (defaultSource) {
          setSelectedSourceId(defaultSource.id);
          setCaptureMode(defaultSource.captureMode);
        }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    }

    loadSources();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (sources.length === 0) return;
    if (captureMode === "virtual_audio_device" && !hasVirtualSource) {
      setCaptureMode("wasapi_loopback");
      return;
    }
    const current = sources.find((source) => source.id === selectedSourceId && source.captureMode === captureMode);
    if (current) return;
    const next = sources.find((source) => source.captureMode === captureMode && source.isDefault)
      ?? sources.find((source) => source.captureMode === captureMode);
    setSelectedSourceId(next?.id ?? "");
  }, [captureMode, hasVirtualSource, selectedSourceId, sources]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let mounted = true;

    async function attachEvents() {
      unlisteners.push(await listenEvent<AudioStatusEvent>("audio_status", (payload) => {
        setAudioStatus(payload);
        if (payload.state === "error") setError(payload.message);
      }));

      unlisteners.push(await listenEvent<AsrTextEvent>("asr_partial", (payload) => {
        setPartialText(payload.text);
      }));

      unlisteners.push(await listenEvent<AsrTextEvent>("asr_final", (payload) => {
        setPartialText("");
        setTranscript((lines) => [...lines.slice(-14), { text: payload.text, receivedAt: payload.receivedAt }]);
      }));

      unlisteners.push(await listenEvent<MatchCandidatesEvent>("match_candidates", (payload) => {
        const topCandidate = payload.candidates[0] ?? null;
        const recordId = `${payload.receivedAt || Date.now()}-${topCandidate?.id ?? "none"}`;

        if (payload.locked) {
          setLocked(true);
          return;
        }

        setLastQuery(payload.query);
        setCandidates(payload.candidates);
        setLocked(false);

        if (payload.definite && payload.query.trim()) {
          const record: QuestionRecord = {
            id: recordId,
            query: payload.query,
            receivedAt: payload.receivedAt || Date.now(),
            candidates: payload.candidates,
            selectedCandidate: topCandidate,
            locked: payload.locked,
          };
          setQuestionRecords((records) => {
            const withoutDuplicate = records.filter((item) => item.id !== record.id);
            return [record, ...withoutDuplicate].slice(0, 30);
          });
          if (!payload.locked && topCandidate) {
            setSelectedRecordId(recordId);
            setSelectedCandidate(topCandidate);
          }
          return;
        }

        if (!payload.locked && topCandidate) {
          setSelectedRecordId(null);
          setSelectedCandidate(topCandidate);
        }
      }));

      if (!mounted) unlisteners.splice(0).forEach((unlisten) => unlisten());
    }

    attachEvents();
    return () => {
      mounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  async function startSession() {
    setError(null);
    const source = sources.find((item) => item.id === selectedSourceId && item.captureMode === captureMode);
    if (!source) {
      setError(captureMode === "virtual_audio_device"
        ? "未检测到可用虚拟声卡。请安装 VB-CABLE / Voicemeeter 后重启应用，或切回 WASAPI 系统声音。"
        : "请选择正在播放会议声音的系统输出设备。"
      );
      return;
    }

    const settings: SessionSettings = {
      resourceId: resourceId.trim() || DEFAULT_RESOURCE_ID,
      captureMode,
      audioDeviceId: source.id,
      saveAudio,
    };

    try {
      await api.startSession(settings);
      setRunning(true);
      setMatchingPaused(false);
      setLocked(false);
      setTranscript([]);
      setPartialText("");
      setQuestionRecords([]);
      setSelectedRecordId(null);
      setCandidates([]);
      setSelectedCandidate(null);
      setLastQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stopSession() {
    try {
      await api.stopSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setMatchingPaused(false);
      setLocked(false);
    }
  }

  async function prepareNextQuestion() {
    try {
      if (running) await api.unlockAnswer();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocked(false);
      setPartialText("");
      setTranscript([]);
      setCandidates([]);
      setSelectedCandidate(null);
      setSelectedRecordId(null);
      setLastQuery("");
    }
  }

  async function togglePause() {
    try {
      if (matchingPaused) {
        await api.resumeMatching();
        setMatchingPaused(false);
      } else {
        await api.pauseMatching();
        setMatchingPaused(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleLock(candidate?: MatchCandidate | null) {
    try {
      if (locked) {
        await api.unlockAnswer();
        setLocked(false);
        setSelectedCandidate((current) => current ? { ...current, status: "candidate" as const } : current);
        if (selectedRecordId) {
          setQuestionRecords((records) => records.map((record) => (
            record.id === selectedRecordId
              ? {
                  ...record,
                  locked: false,
                  selectedCandidate: record.selectedCandidate
                    ? { ...record.selectedCandidate, status: "candidate" as const }
                    : record.selectedCandidate,
                }
              : record
          )));
        }
      } else if (candidate) {
        await api.lockAnswer(candidate.id);
        const lockedCandidate = { ...candidate, status: "locked" as const };
        setLocked(true);
        setSelectedCandidate(lockedCandidate);
        if (selectedRecordId) {
          setQuestionRecords((records) => records.map((record) => (
            record.id === selectedRecordId
              ? { ...record, locked: true, selectedCandidate: lockedCandidate }
              : record
          )));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runSearch() {
    if (!searchQuery.trim()) return;
    try {
      const results = await api.searchQuestions(searchQuery.trim());
      setCandidates(results);
      setSelectedCandidate(results[0] ?? null);
      setSelectedRecordId(null);
      setLastQuery(searchQuery.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function selectRecord(record: QuestionRecord) {
    setSelectedRecordId(record.id);
    setCandidates(record.candidates);
    setSelectedCandidate(record.selectedCandidate ?? record.candidates[0] ?? null);
    setLastQuery(record.query);
    setLocked(record.locked);
  }

  function selectCandidate(candidate: MatchCandidate) {
    const nextCandidate = locked ? { ...candidate, status: "locked" as const } : candidate;
    setSelectedCandidate(nextCandidate);
    if (selectedRecordId) {
      setQuestionRecords((records) => records.map((record) => (
        record.id === selectedRecordId ? { ...record, selectedCandidate: nextCandidate } : record
      )));
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== "Space" || event.repeat || isTextInputTarget(event.target)) return;
      event.preventDefault();
      if (!running) {
        void startSession();
        return;
      }
      if (locked) {
        void prepareNextQuestion();
        return;
      }
      if (selectedCandidate) {
        void toggleLock(selectedCandidate);
        return;
      }
      void prepareNextQuestion();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [locked, running, selectedCandidate, selectedSourceId, captureMode, resourceId, saveAudio, sources]);

  const latestTranscript = partialText || transcript[transcript.length - 1]?.text || "空格开始监听，等待面试官系统声音...";
  const volumePercent = typeof audioStatus.volume === "number" ? Math.min(100, Math.round(audioStatus.volume * 100)) : null;
  const answerTerms = selectedCandidate?.highlightTerms ?? selectedCandidate?.hitTerms ?? [];
  const answerLogic = selectedCandidate?.answerLogic?.trim() ?? "";
  const answerDetail = selectedCandidate?.answerDetail?.trim() || selectedCandidate?.answer || "";
  const selectedRecord = questionRecords.find((record) => record.id === selectedRecordId) ?? null;
  const spaceHint = !running ? "空格开始监听" : locked ? "空格进入下一题" : selectedCandidate ? "空格锁定答案" : "等待候选";

  return (
    <main className="shell">
      <header className="topbar">
        <section className="brand">
          <div className="brand-mark">
            <AudioLines size={21} />
          </div>
          <div>
            <h1>Interview Copilot</h1>
            <p>系统声音实时识别 · 分段问题匹配 · 空格推进</p>
          </div>
        </section>

        <section className="status-strip" aria-label="运行状态">
          <div className={cls("status-pill", audioStatus.state === "capturing" && "good", audioStatus.state === "error" && "bad")}>
            <Activity size={16} />
            <span>{audioStatus.message}{volumePercent !== null ? ` · 音量 ${volumePercent}%` : ""}</span>
          </div>
          <div className="status-pill">
            <ShieldCheck size={16} />
            <span>Key 环境变量读取</span>
          </div>
          <div className={cls("status-pill", locked && "locked")}>
            {locked ? <Lock size={16} /> : <Unlock size={16} />}
            <span>{spaceHint}</span>
          </div>
        </section>
      </header>

      <section className="controls">
        <label>
          <span>Resource ID</span>
          <input value={resourceId} onChange={(event) => setResourceId(event.target.value)} />
        </label>
        <div className="inline-info">
          <span>问题库</span>
          <strong>已内置 31 题</strong>
        </div>
        <label>
          <span>采集模式</span>
          <select value={captureMode} onChange={(event) => setCaptureMode(event.target.value as CaptureMode)}>
            <option value="wasapi_loopback">WASAPI 系统声音</option>
            <option value="virtual_audio_device" disabled={!hasVirtualSource}>虚拟声卡{hasVirtualSource ? "" : "（未检测到）"}</option>
          </select>
        </label>
        <label>
          <span>音频设备</span>
          <select value={selectedSourceId} onChange={(event) => setSelectedSourceId(event.target.value)}>
            {compatibleSources.length === 0 ? (
              <option value="">{captureMode === "virtual_audio_device" ? "未检测到虚拟声卡" : "等待桌面端列出设备"}</option>
            ) : null}
            {compatibleSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </label>
        <button className={cls("icon-button", saveAudio && "active")} type="button" onClick={() => setSaveAudio((value) => !value)} title="手动开启保存音频和日志">
          <Save size={17} />
          <span>{saveAudio ? "保存开启" : "不保存"}</span>
        </button>
        {!running ? (
          <button className="primary-command" type="button" onClick={startSession}>
            <Play size={18} />
            <span>开始监听</span>
          </button>
        ) : (
          <button className="danger-command" type="button" onClick={stopSession}>
            <CircleStop size={18} />
            <span>停止</span>
          </button>
        )}
        <button className="icon-button" type="button" onClick={togglePause} disabled={!running} title="继续转写，但暂停或恢复答案刷新">
          {matchingPaused ? <Play size={17} /> : <Pause size={17} />}
          <span>{matchingPaused ? "继续匹配" : "暂停匹配"}</span>
        </button>
        <button className="icon-button" type="button" onClick={() => toggleLock(selectedCandidate)} disabled={!selectedCandidate} title="锁定当前答案，下一次空格进入下一题">
          {locked ? <Unlock size={17} /> : <Lock size={17} />}
          <span>{locked ? "解锁" : "锁定"}</span>
        </button>
      </section>

      {error ? (
        <div className="error-banner">
          <strong>需要处理：</strong>
          <span>{error}</span>
        </div>
      ) : null}

      <section className="workspace">
        <aside className="left-column">
          <section className="panel question-panel">
            <div className="panel-title split">
              <div>
                <h2>问题列表</h2>
                <p>每段稳定识别独立匹配</p>
              </div>
              <button className="icon-only" type="button" onClick={() => setQuestionRecords([])} title="清空问题列表">
                <RotateCcw size={17} />
              </button>
            </div>
            <div className="question-list">
              {questionRecords.length === 0 ? (
                <div className="empty-state compact-empty">
                  <FileText size={24} />
                  <p>面试官说完一段问题后，这里会新增一条匹配记录。</p>
                </div>
              ) : null}
              {questionRecords.map((record) => {
                const top = record.selectedCandidate ?? record.candidates[0] ?? null;
                return (
                  <button
                    type="button"
                    key={record.id}
                    className={cls("question-record", selectedRecordId === record.id && "selected", record.locked && "locked")}
                    onClick={() => selectRecord(record)}
                  >
                    <div className="record-meta">
                      <span>{formatTime(record.receivedAt)}</span>
                      {record.locked ? <strong>已锁定</strong> : null}
                    </div>
                    <p className="record-query">{record.query}</p>
                    {top ? <p className="record-match">#{top.id} {top.question} · {top.score}%</p> : <p className="record-match">未匹配到候选</p>}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel transcript-panel">
            <div className="panel-title">
              <AudioLines size={18} />
              <h2>实时转写</h2>
            </div>
            <div className="live-line">
              <span className={partialText ? "streaming-dot" : "steady-dot"} />
              <p>{latestTranscript}</p>
            </div>
            <div className="transcript-list">
              {transcript.length === 0 ? <p className="muted">只监听系统声音，不采集麦克风。</p> : null}
              {transcript
                .slice()
                .reverse()
                .map((line, index) => (
                  <article key={`${line.receivedAt}-${index}`} className="transcript-row">
                    <span>{formatTime(line.receivedAt)}</span>
                    <p>{line.text}</p>
                  </article>
                ))}
            </div>
          </section>
        </aside>

        <section className="panel candidate-panel">
          <div className="panel-title split">
            <div>
              <h2>Top 3 候选</h2>
              <p>{lastQuery ? `当前段：${lastQuery}` : "等待稳定识别或手动搜索"}</p>
            </div>
            <button className="icon-only" type="button" onClick={prepareNextQuestion} title="清空当前候选，准备下一题">
              <RotateCcw size={17} />
            </button>
          </div>

          <div className="manual-search">
            <Search size={16} />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch();
              }}
              placeholder="手动搜：RAG / 薪资 / badcase"
            />
            <button type="button" onClick={runSearch}>搜索</button>
          </div>

          <div className="candidate-list">
            {candidates.length === 0 ? (
              <div className="empty-state">
                <AudioLines size={28} />
                <p>等待系统声音识别结果，或手动搜索问题库。</p>
              </div>
            ) : null}
            {candidates.map((candidate, index) => (
              <button
                type="button"
                key={candidate.id}
                className={cls("candidate-card", selectedCandidate?.id === candidate.id && "selected")}
                onClick={() => selectCandidate(candidate)}
              >
                <div className="candidate-rank">#{candidate.id}</div>
                <div className="candidate-main">
                  <div className="candidate-heading">
                    <h3>{candidate.question}</h3>
                    <span>{candidate.score}%</span>
                  </div>
                  <div className="term-row">
                    {(candidate.hitTerms.length ? candidate.hitTerms : candidate.highlightTerms).slice(0, 8).map((term) => (
                      <span key={`${candidate.id}-${term}`}>{term}</span>
                    ))}
                  </div>
                  {candidate.answerLogic ? <p className="logic-preview">逻辑：{candidate.answerLogic}</p> : null}
                  <small>{index === 0 ? (locked ? "答案已锁定" : "最可能命中") : "备选相关问题"}</small>
                </div>
              </button>
            ))}
          </div>
        </section>

        <article className="panel answer-panel">
          <div className="panel-title split">
            <div>
              <h2>完整原文答案</h2>
              <p>{selectedCandidate ? `#${selectedCandidate.id} · ${selectedCandidate.question}` : "选择候选问题查看答案"}</p>
              {selectedRecord ? <p className="answer-source">来源：{formatTime(selectedRecord.receivedAt)} · {selectedRecord.query}</p> : null}
            </div>
            <button className="icon-button compact" type="button" onClick={() => toggleLock(selectedCandidate)} disabled={!selectedCandidate}>
              {locked ? <Unlock size={16} /> : <Lock size={16} />}
              <span>{locked ? "解锁" : "锁定"}</span>
            </button>
          </div>

          {selectedCandidate ? (
            <div className="answer-body">
              <section className="answer-section logic-section">
                <h3>回答逻辑：</h3>
                {answerLogic ? <p>{answerLogic}</p> : <p className="section-empty">原文未提供回答逻辑。</p>}
              </section>
              <section className="answer-section detail-section">
                <h3>具体内容：</h3>
                {highlightAnswer(answerDetail, answerTerms)}
              </section>
            </div>
          ) : (
            <div className="answer-placeholder">
              <p>候选问题出现后，这里会展示清单里的完整原文答案。</p>
            </div>
          )}
        </article>
      </section>
    </main>
  );
}
