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
  isTauriRuntime,
  listenEvent,
  MatchCandidate,
  MatchCandidatesEvent,
  SessionLogEvent,
  SessionSettings,
} from "./tauriClient";

const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";

interface TranscriptLine {
  text: string;
  definite: boolean;
  receivedAt: number;
}

function cls(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
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
    state: isTauriRuntime() ? "idle" : "error",
    message: isTauriRuntime() ? "等待开始监听系统声音" : "未检测到 Tauri 桌面端后端",
  });
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [partialText, setPartialText] = useState("");
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<MatchCandidate | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [sessionLogs, setSessionLogs] = useState<SessionLogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId && source.captureMode === captureMode),
    [captureMode, selectedSourceId, sources],
  );

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
      if (!isTauriRuntime()) return;
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
        setTranscript((lines) => [...lines.slice(-80), { text: payload.text, definite: true, receivedAt: payload.receivedAt }]);
      }));

      unlisteners.push(await listenEvent<MatchCandidatesEvent>("match_candidates", (payload) => {
        setLastQuery(payload.query);
        setCandidates(payload.candidates);
        setLocked(payload.locked);
        if (!payload.locked && payload.candidates[0]) {
          setSelectedCandidate(payload.candidates[0]);
        }
      }));

      unlisteners.push(await listenEvent<SessionLogEvent>("session_log", (payload) => {
        setSessionLogs((logs) => [...logs.slice(-8), payload]);
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
      setCandidates([]);
      setSelectedCandidate(null);
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
      } else if (candidate) {
        await api.lockAnswer(candidate.id);
        setLocked(true);
        setSelectedCandidate({ ...candidate, status: "locked" });
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
      setLastQuery(searchQuery.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const latestTranscript = partialText || transcript[transcript.length - 1]?.text || "等待面试官系统声音...";
  const volumePercent = typeof audioStatus.volume === "number" ? Math.min(100, Math.round(audioStatus.volume * 100)) : null;
  const answerTerms = selectedCandidate?.highlightTerms ?? selectedCandidate?.hitTerms ?? [];

  return (
    <main className="shell">
      <header className="topbar">
        <section className="brand">
          <div className="brand-mark">
            <AudioLines size={21} />
          </div>
          <div>
            <h1>Interview Copilot</h1>
            <p>系统声音实时识别 · 本地问题匹配 · 完整原文提示</p>
          </div>
        </section>

        <section className="status-strip" aria-label="运行状态">
          <div className={cls("status-pill", audioStatus.state === "capturing" && "good", audioStatus.state === "error" && "bad")}>
            <Activity size={16} />
            <span>{audioStatus.message}{volumePercent !== null ? ` · 音量 ${volumePercent}%` : ""}</span>
          </div>
          <div className="status-pill">
            <ShieldCheck size={16} />
            <span>Key 自动读取</span>
          </div>
          <div className={cls("status-pill", locked && "locked")}>
            {locked ? <Lock size={16} /> : <Unlock size={16} />}
            <span>{locked ? "答案已锁定" : matchingPaused ? "匹配已暂停" : "候选实时刷新"}</span>
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
        <button className="icon-button" type="button" onClick={() => toggleLock(selectedCandidate)} disabled={!selectedCandidate} title="锁定当前答案，避免后续转写覆盖">
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
        <aside className="panel transcript-panel">
          <div className="panel-title">
            <FileText size={18} />
            <h2>实时转写</h2>
          </div>
          <div className="live-line">
            <span className={partialText ? "streaming-dot" : "steady-dot"} />
            <p>{latestTranscript}</p>
          </div>
          <div className="transcript-list">
            {transcript.length === 0 ? <p className="muted">稳定分句会出现在这里。系统只监听桌面声音，不采集麦克风。</p> : null}
            {transcript
              .slice()
              .reverse()
              .map((line, index) => (
                <article key={`${line.receivedAt}-${index}`} className="transcript-row">
                  <span>{new Date(line.receivedAt).toLocaleTimeString()}</span>
                  <p>{line.text}</p>
                </article>
              ))}
          </div>
        </aside>

        <section className="panel candidate-panel">
          <div className="panel-title split">
            <div>
              <h2>Top 3 候选</h2>
              <p>{lastQuery ? `当前问题：${lastQuery}` : "识别后自动刷新候选问题"}</p>
            </div>
            <button className="icon-only" type="button" onClick={() => setCandidates([])} title="清空候选">
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
              placeholder="ASR 误识别时手动搜：RAG / 薪资 / badcase"
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
                onClick={() => setSelectedCandidate(candidate)}
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
                  <small>{index === 0 ? (locked ? "已锁定" : "最可能命中") : "备选相关问题"}</small>
                </div>
              </button>
            ))}
          </div>
        </section>

        <article className="panel answer-panel">
          <div className="panel-title split">
            <div>
              <h2>完整原文答案</h2>
              <p>{selectedCandidate ? `#${selectedCandidate.id} · ${selectedCandidate.question}` : "选择一个候选问题查看答案"}</p>
            </div>
            <button className="icon-button compact" type="button" onClick={() => toggleLock(selectedCandidate)} disabled={!selectedCandidate}>
              {locked ? <Unlock size={16} /> : <Lock size={16} />}
              <span>{locked ? "解锁" : "锁定"}</span>
            </button>
          </div>

          {selectedCandidate ? (
            <div className="answer-body">
              {highlightAnswer(selectedCandidate.answer, answerTerms)}
            </div>
          ) : (
            <div className="answer-placeholder">
              <p>候选问题出现后，这里会展示清单里的完整原文答案，并高亮和面试官问题最相关的词句。</p>
            </div>
          )}
        </article>
      </section>

      <footer className="bottom-log">
        <div>
          <strong>设备</strong>
          <span>{selectedSource?.name ?? "未选择"}</span>
        </div>
        <div>
          <strong>会话</strong>
          <span>{running ? "运行中" : "未启动"}</span>
        </div>
        <div className="log-stream">
          {sessionLogs.length === 0 ? <span>日志：等待会话事件</span> : sessionLogs.map((log, index) => <span key={`${log.message}-${index}`}>{log.message}</span>)}
        </div>
      </footer>
    </main>
  );
}

