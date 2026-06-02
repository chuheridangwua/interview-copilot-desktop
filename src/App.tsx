import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  CheckCircle2,
  CircleStop,
  FileText,
  LoaderCircle,
  Mic,
  OctagonAlert,
  Pause,
  Play,
  Save,
  Settings,
  X,
} from "lucide-react";
import {
  api,
  AiMatchUpdateEvent,
  AudioSource,
  AudioStatusEvent,
  AsrTextEvent,
  CaptureMode,
  CompanyOption,
  HealthStatusEvent,
  HealthStatusItem,
  isDesktopRuntime,
  listenEvent,
  MatchCandidate,
  MatchCandidatesEvent,
  MediaDeviceOptions,
  ModelAnswerUpdateEvent,
  ModelQuestionUpdateEvent,
  SessionSettings,
} from "./desktopClient";

const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";

type SessionState = "idle" | "running" | "paused" | "ended";

interface TranscriptSegment {
  id: string;
  text: string;
  rewrittenText?: string;
  receivedAt: number;
}

interface QuestionRecord {
  id: string;
  matchId: string;
  questionText: string;
  sourceText: string;
  confidence: number;
  reason?: string;
  provisional: boolean;
  enhanced: boolean;
  receivedAt: number;
  candidates: MatchCandidate[];
  selectedCandidate: MatchCandidate | null;
  modelAnswerStatus?: "streaming" | "done" | "error";
  modelAnswer?: string;
  modelAnswerError?: string;
  modelAnswerReason?: string;
  modelAnswerLatencyMs?: number;
}

const HEALTH_ITEMS: Array<[string, string]> = [
  ["audio", "音频"],
  ["asr", "ASR"],
  ["bank", "题库"],
  ["resume", "简历"],
  ["ark", "AI"],
];

function createInitialHealthItems(): Record<string, HealthStatusItem> {
  return Object.fromEntries(HEALTH_ITEMS.map(([key, label]) => [
    key,
    { state: "checking", label, message: "启动自检中" },
  ]));
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

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[，。！？；：、（）【】《》“”"'`~!?,.;:()[\]{}<>]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function isNearDuplicate(a: string, b: string) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function appendTranscriptSegment(segments: TranscriptSegment[], next: TranscriptSegment) {
  const last = segments[segments.length - 1];
  const nextText = next.rewrittenText || next.text;
  const lastText = last ? last.rewrittenText || last.text : "";
  if (last && isNearDuplicate(lastText, nextText)) {
    const replacement = normalizeText(nextText).length >= normalizeText(lastText).length ? next : last;
    return [...segments.slice(0, -1), replacement].slice(-80);
  }
  const duplicate = segments.slice(-8).some((item) => isNearDuplicate(item.rewrittenText || item.text, nextText));
  if (duplicate) return segments;
  return [...segments, next].slice(-80);
}

function splitParagraphs(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseModelAnswer(text: string) {
  const value = String(text ?? "").trim();
  if (!value) return { logic: "", detail: "" };
  const logicMatch = value.match(/回答逻辑\s*[:：]/);
  const detailMatch = value.match(/具体内容\s*[:：]/);
  if (!logicMatch && !detailMatch) return { logic: "", detail: value };

  const logicStart = logicMatch ? (logicMatch.index ?? 0) + logicMatch[0].length : 0;
  const detailStart = detailMatch ? (detailMatch.index ?? value.length) : value.length;
  const detailContentStart = detailMatch ? detailStart + detailMatch[0].length : value.length;
  return {
    logic: value.slice(logicStart, detailStart).trim(),
    detail: value.slice(detailContentStart).trim(),
  };
}

function mergeCandidateList(primary: MatchCandidate[], fallback: MatchCandidate[], limit = 10) {
  const seen = new Set<number>();
  const merged: MatchCandidate[] = [];
  for (const candidate of [...primary, ...fallback]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    merged.push(candidate);
    if (merged.length >= limit) break;
  }
  return merged;
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
  const [mediaDevices, setMediaDevices] = useState<MediaDeviceOptions>({ audioInputs: [], audioOutputs: [] });
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState("");
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("wasapi_loopback");
  const [resourceId, setResourceId] = useState(DEFAULT_RESOURCE_ID);
  const [saveAudio, setSaveAudio] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const sessionStateRef = useRef<SessionState>("idle");
  const [liveTranscript, setLiveTranscript] = useState<TranscriptSegment | null>(null);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [microphoneLiveTranscript, setMicrophoneLiveTranscript] = useState<TranscriptSegment | null>(null);
  const [microphoneTranscriptSegments, setMicrophoneTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [questionRecords, setQuestionRecords] = useState<QuestionRecord[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const selectedRecordIdRef = useRef<string | null>(null);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<MatchCandidate | null>(null);
  const [systemAudioVolumePercent, setSystemAudioVolumePercent] = useState<number | null>(null);
  const [microphoneVolumePercent, setMicrophoneVolumePercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [healthItems, setHealthItems] = useState<Record<string, HealthStatusItem>>(() => createInitialHealthItems());
  const [healthCheckedAt, setHealthCheckedAt] = useState<number | null>(null);
  const [logDir, setLogDir] = useState("");

  useEffect(() => {
    sessionStateRef.current = sessionState;
  }, [sessionState]);

  useEffect(() => {
    selectedRecordIdRef.current = selectedRecordId;
  }, [selectedRecordId]);

  const hasVirtualSource = useMemo(
    () => sources.some((source) => source.captureMode === "virtual_audio_device"),
    [sources],
  );

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );

  const selectedAudioOutput = useMemo(
    () => mediaDevices.audioOutputs.find((device) => device.id === selectedAudioOutputId) ?? null,
    [mediaDevices.audioOutputs, selectedAudioOutputId],
  );

  const selectedMicrophone = useMemo(
    () => mediaDevices.audioInputs.find((device) => device.id === selectedMicrophoneId) ?? null,
    [mediaDevices.audioInputs, selectedMicrophoneId],
  );

  const companySelectorDisabled = sessionState === "running" || sessionState === "paused";
  const deviceSelectorDisabled = sessionState === "running" || sessionState === "paused";
  const bankSummary = healthItems.bank?.message || "等待题库自检";

  function clearInterviewResults() {
    setLiveTranscript(null);
    setTranscriptSegments([]);
    setMicrophoneLiveTranscript(null);
    setMicrophoneTranscriptSegments([]);
    setQuestionRecords([]);
    setSelectedRecordId(null);
    setCandidates([]);
    setSelectedCandidate(null);
  }

  async function refreshHealthStatus() {
    if (!isDesktopRuntime()) return;
    setHealthItems(createInitialHealthItems());
    try {
      const status = await api.getHealthStatus(selectedCompanyId || undefined);
      setHealthItems((items) => ({ ...items, ...status.items }));
      setHealthCheckedAt(status.checkedAt);
      setLogDir(status.logDir || "");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setHealthItems((items) => ({
        ...items,
        ark: { state: "error", label: "AI", message: `启动自检失败：${message}` },
      }));
    }
  }

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
    let disposed = false;

    async function loadMediaDevices() {
      if (!isDesktopRuntime()) return;
      try {
        const nextDevices = await api.listMediaDevices();
        if (disposed) return;
        setMediaDevices(nextDevices);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    }

    loadMediaDevices();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    async function loadCompanies() {
      if (!isDesktopRuntime()) return;
      try {
        const nextCompanies = await api.listCompanies();
        if (disposed) return;
        setCompanies(nextCompanies);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    }

    loadCompanies();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    void refreshHealthStatus();
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    if (companies.some((company) => company.id === selectedCompanyId)) return;
    setSelectedCompanyId("");
    clearInterviewResults();
  }, [companies, selectedCompanyId]);

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
    if (selectedAudioOutputId && !mediaDevices.audioOutputs.some((device) => device.id === selectedAudioOutputId)) {
      setSelectedAudioOutputId("");
    }
    if (selectedMicrophoneId && !mediaDevices.audioInputs.some((device) => device.id === selectedMicrophoneId)) {
      setSelectedMicrophoneId("");
    }
  }, [mediaDevices, selectedAudioOutputId, selectedMicrophoneId]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let mounted = true;

    async function attachEvents() {
      unlisteners.push(await listenEvent<AudioStatusEvent>("audio_status", (payload) => {
        if (typeof payload.volume === "number") {
          setSystemAudioVolumePercent(Math.min(100, Math.round(payload.volume * 100)));
        }
        if (payload.state === "error") setError(payload.message);
      }));

      unlisteners.push(await listenEvent<AudioStatusEvent>("microphone_audio_status", (payload) => {
        if (typeof payload.volume === "number") {
          setMicrophoneVolumePercent(Math.min(100, Math.round(payload.volume * 100)));
        }
      }));

      unlisteners.push(await listenEvent<HealthStatusEvent>("health_status", (payload) => {
        setHealthItems((items) => ({ ...items, ...payload.items }));
        setHealthCheckedAt(payload.checkedAt);
        setLogDir(payload.logDir || "");
      }));

      unlisteners.push(await listenEvent<AsrTextEvent>("asr_final", (payload) => {
        if (sessionStateRef.current !== "running") return;
        const nextSegment = {
          id: `${payload.receivedAt}-${normalizeText(payload.text).slice(0, 18)}`,
          text: payload.text,
          rewrittenText: payload.rewrittenText,
          receivedAt: payload.receivedAt,
        };
        setLiveTranscript(nextSegment);
        const timelineText = typeof payload.rewrittenText === "string" ? payload.rewrittenText : payload.text;
        if (timelineText.trim()) {
          setTranscriptSegments((segments) => appendTranscriptSegment(segments, nextSegment));
        }
      }));

      unlisteners.push(await listenEvent<AsrTextEvent>("asr_partial", (payload) => {
        if (sessionStateRef.current !== "running" || !payload.text.trim()) return;
        setLiveTranscript({
          id: `live-${payload.receivedAt}`,
          text: payload.text,
          rewrittenText: payload.rewrittenText,
          receivedAt: payload.receivedAt,
        });
      }));

      unlisteners.push(await listenEvent<AsrTextEvent>("mic_asr_final", (payload) => {
        if (sessionStateRef.current !== "running") return;
        const nextSegment = {
          id: `mic-${payload.receivedAt}-${normalizeText(payload.text).slice(0, 18)}`,
          text: payload.text,
          rewrittenText: payload.rewrittenText,
          receivedAt: payload.receivedAt,
        };
        setMicrophoneLiveTranscript(nextSegment);
        const timelineText = typeof payload.rewrittenText === "string" ? payload.rewrittenText : payload.text;
        if (timelineText.trim()) {
          setMicrophoneTranscriptSegments((segments) => appendTranscriptSegment(segments, nextSegment));
        }
      }));

      unlisteners.push(await listenEvent<AsrTextEvent>("mic_asr_partial", (payload) => {
        if (sessionStateRef.current !== "running" || !payload.text.trim()) return;
        setMicrophoneLiveTranscript({
          id: `mic-live-${payload.receivedAt}`,
          text: payload.text,
          rewrittenText: payload.rewrittenText,
          receivedAt: payload.receivedAt,
        });
      }));

      unlisteners.push(await listenEvent<MatchCandidatesEvent>("match_candidates", (payload) => {
        if (sessionStateRef.current !== "running") return;
        const topCandidate = payload.candidates[0] ?? null;
        const questionText = payload.query.trim();
        if (!questionText) return;
        const matchId = payload.matchId || `${payload.receivedAt || Date.now()}-${normalizeText(questionText).slice(0, 16)}`;
        const recordId = payload.provisional
          ? "question-live"
          : matchId;
        const record: QuestionRecord = {
          id: recordId,
          matchId,
          questionText,
          sourceText: payload.sourceText || questionText,
          confidence: payload.confidence ?? 0.72,
          reason: payload.reason,
          provisional: Boolean(payload.provisional),
          enhanced: Boolean(payload.enhanced),
          receivedAt: payload.receivedAt || Date.now(),
          candidates: payload.candidates,
          selectedCandidate: topCandidate,
        };

        setCandidates(payload.candidates);
        setQuestionRecords((records) => {
          const baseRecords = payload.definite ? records.filter((item) => item.id !== "question-live") : records;
          const duplicateIndex = baseRecords.findIndex((item) => (
            item.id === record.id || isNearDuplicate(item.questionText, record.questionText)
          ));
          if (duplicateIndex >= 0) {
            const next = [...baseRecords];
            const existing = next[duplicateIndex];
            if (record.provisional && !existing.provisional) {
              return next.slice(0, 40);
            }
            next[duplicateIndex] = {
              ...existing,
              ...record,
              id: existing.provisional && !record.provisional ? record.id : existing.id,
              matchId: record.matchId,
              provisional: record.provisional && !record.enhanced,
            };
            return next.slice(0, 40);
          }
          return [record, ...baseRecords].slice(0, 40);
        });
        setSelectedRecordId((current) => (
          payload.definite || payload.enhanced || current === "question-live" || current === null ? recordId : current
        ));
        if (topCandidate) setSelectedCandidate(topCandidate);
      }));

      unlisteners.push(await listenEvent<ModelQuestionUpdateEvent>("model_question_update", (payload) => {
        setQuestionRecords((records) => {
          let changedRecordId: string | null = null;
          const next = records.map((record) => {
            if (record.matchId !== payload.matchId) return record;
            changedRecordId = record.id;
            const selected = record.selectedCandidate && payload.candidates.some((candidate) => candidate.id === record.selectedCandidate?.id)
              ? record.selectedCandidate
              : payload.candidates[0] ?? record.selectedCandidate;
            return {
              ...record,
              questionText: payload.questionText,
              sourceText: payload.sourceText || record.sourceText,
              confidence: payload.confidence,
              reason: payload.reason || record.reason,
              enhanced: true,
              candidates: payload.candidates.length ? payload.candidates : record.candidates,
              selectedCandidate: selected,
            };
          });
          if (changedRecordId && selectedRecordIdRef.current === changedRecordId) {
            const current = next.find((record) => record.id === changedRecordId);
            if (current) {
              setCandidates(current.candidates);
              setSelectedCandidate(current.selectedCandidate ?? current.candidates[0] ?? null);
            }
          }
          return next;
        });
      }));

      unlisteners.push(await listenEvent<AiMatchUpdateEvent>("ai_match_update", (payload) => {
        if (payload.status !== "ready" || payload.candidates.length === 0) return;
        setQuestionRecords((records) => {
          let changedRecordId: string | null = null;
          const next = records.map((record) => {
            if (record.matchId !== payload.matchId) return record;
            changedRecordId = record.id;
            const mergedCandidates = mergeCandidateList(payload.candidates, record.candidates, 10);
            const selected = record.selectedCandidate && mergedCandidates.some((candidate) => candidate.id === record.selectedCandidate?.id)
              ? mergedCandidates.find((candidate) => candidate.id === record.selectedCandidate?.id) ?? record.selectedCandidate
              : mergedCandidates[0] ?? record.selectedCandidate;
            return {
              ...record,
              candidates: mergedCandidates,
              selectedCandidate: selected,
            };
          });
          if (changedRecordId && selectedRecordIdRef.current === changedRecordId) {
            const current = next.find((record) => record.id === changedRecordId);
            if (current) {
              setCandidates(current.candidates);
              setSelectedCandidate(current.selectedCandidate ?? current.candidates[0] ?? null);
            }
          }
          return next;
        });
      }));

      unlisteners.push(await listenEvent<ModelAnswerUpdateEvent>("model_answer_update", (payload) => {
        setQuestionRecords((records) => records.map((record) => {
          if (record.matchId !== payload.matchId) return record;
          const nextAnswer = typeof payload.answer === "string"
            ? payload.answer
            : `${record.modelAnswer || ""}${payload.delta || ""}`;
          return {
            ...record,
            modelAnswerStatus: payload.status,
            modelAnswer: nextAnswer,
            modelAnswerError: payload.status === "error" ? payload.message : undefined,
            modelAnswerReason: payload.reason || record.modelAnswerReason,
            modelAnswerLatencyMs: payload.latencyMs,
          };
        }));
      }));

      if (!mounted) unlisteners.splice(0).forEach((unlisten) => unlisten());
    }

    attachEvents();
    return () => {
      mounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  async function startInterview() {
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
      audioOutputDeviceId: selectedAudioOutputId || undefined,
      audioOutputDeviceName: selectedAudioOutput?.label || "默认系统输出",
      microphoneDeviceId: selectedMicrophoneId || undefined,
      microphoneDeviceName: selectedMicrophone?.label || "默认麦克风",
      saveAudio,
      companyId: selectedCompanyId || undefined,
    };

    setSystemAudioVolumePercent(0);
    setMicrophoneVolumePercent(0);
    try {
      await api.startSession(settings);
      void api.listMediaDevices().then(setMediaDevices).catch(() => undefined);
      sessionStateRef.current = "running";
      setSessionState("running");
      setLiveTranscript(null);
      setTranscriptSegments([]);
      setMicrophoneLiveTranscript(null);
      setMicrophoneTranscriptSegments([]);
      setQuestionRecords([]);
      setSelectedRecordId(null);
      setCandidates([]);
      setSelectedCandidate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pauseInterview() {
    try {
      await api.pauseSession();
      sessionStateRef.current = "paused";
      setSessionState("paused");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resumeInterview() {
    try {
      await api.resumeSession();
      sessionStateRef.current = "running";
      setSessionState("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function endInterview() {
    try {
      await api.stopSession();
      sessionStateRef.current = "ended";
      setSessionState("ended");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function selectRecord(record: QuestionRecord) {
    setSelectedRecordId(record.id);
    setCandidates(record.candidates);
    setSelectedCandidate(record.selectedCandidate ?? record.candidates[0] ?? null);
  }

  function selectCandidate(candidate: MatchCandidate) {
    setSelectedCandidate(candidate);
    if (selectedRecordId) {
      setQuestionRecords((records) => records.map((record) => (
        record.id === selectedRecordId ? { ...record, selectedCandidate: candidate } : record
      )));
    }
  }

  function handleCompanyChange(nextCompanyId: string) {
    if (companySelectorDisabled) return;
    setSelectedCompanyId(nextCompanyId);
    clearInterviewResults();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== "Space" || event.repeat || isTextInputTarget(event.target)) return;
      event.preventDefault();
      if (sessionStateRef.current === "running") {
        void pauseInterview();
        return;
      }
      if (sessionStateRef.current === "paused") {
        void resumeInterview();
        return;
      }
      void startInterview();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    selectedSourceId,
    selectedAudioOutputId,
    selectedMicrophoneId,
    captureMode,
    resourceId,
    saveAudio,
    selectedCompanyId,
    selectedAudioOutput,
    selectedMicrophone,
    sources,
  ]);

  const answerTerms = selectedCandidate?.highlightTerms ?? selectedCandidate?.hitTerms ?? [];
  const answerLogic = selectedCandidate?.answerLogic?.trim() ?? "";
  const answerDetail = selectedCandidate?.answerDetail?.trim() || selectedCandidate?.answer || "";
  const selectedRecord = questionRecords.find((record) => record.id === selectedRecordId) ?? null;
  const modelAnswer = selectedRecord?.modelAnswer?.trim() ?? "";
  const parsedModelAnswer = parseModelAnswer(modelAnswer);
  const modelAnswerDetail = parsedModelAnswer.detail || (!parsedModelAnswer.logic ? modelAnswer : "");
  const modelAnswerParagraphs = splitParagraphs(modelAnswerDetail);
  const modelAnswerStreaming = selectedRecord?.modelAnswerStatus === "streaming";
  const modelAnswerVisible = Boolean(selectedRecord && (modelAnswer || modelAnswerStreaming || selectedRecord.modelAnswerStatus === "error"));
  const displayedTranscriptSegments = [...transcriptSegments].reverse();
  const displayedMicrophoneTranscriptSegments = [...microphoneTranscriptSegments].reverse();
  return (
    <main className="shell">
      <header className="topbar">
        <section className="brand">
          <div className="brand-mark">
            <AudioLines size={21} />
          </div>
          <div>
            <h1>Interview Copilot</h1>
          </div>
        </section>

        <section className="topbar-actions">
          <div className="command-strip">
            <div className="volume-cluster">
              <div className="volume-indicator" title={`系统声音音量${selectedAudioOutput ? ` · ${selectedAudioOutput.label}` : ""}`}>
                <AudioLines size={15} />
                <span>系统 {systemAudioVolumePercent === null ? "--" : systemAudioVolumePercent}%</span>
              </div>
              <div className="volume-indicator microphone-volume" title={`麦克风音量${selectedMicrophone ? ` · ${selectedMicrophone.label}` : ""}`}>
                <Mic size={14} />
                <span>麦克风 {microphoneVolumePercent === null ? "--" : microphoneVolumePercent}%</span>
              </div>
            </div>
            <button
              className="health-strip"
              type="button"
              onClick={refreshHealthStatus}
              title={logDir ? `点击重测 · 日志目录：${logDir}` : "点击重测启动自检"}
            >
              {HEALTH_ITEMS.map(([key, fallbackLabel]) => {
                const item = healthItems[key] ?? { state: "checking", label: fallbackLabel, message: "启动自检中" };
                const title = [
                  item.message,
                  item.model ? `模型：${item.model}` : "",
                  typeof item.latencyMs === "number" ? `耗时：${item.latencyMs}ms` : "",
                  healthCheckedAt ? `检测时间：${formatTime(healthCheckedAt)}` : "",
                  logDir ? `日志：${logDir}` : "",
                ].filter(Boolean).join("\n");
                const Icon = item.state === "ok" ? CheckCircle2 : item.state === "checking" ? LoaderCircle : OctagonAlert;
                return (
                  <span key={key} className={cls("health-pill", `health-${item.state}`)} title={title}>
                    <Icon size={13} />
                    <span>{item.label || fallbackLabel}</span>
                  </span>
                );
              })}
            </button>
            <label className="company-selector" title={selectedCompany ? `当前面试公司：${selectedCompany.name}` : "当前仅使用通用题库"}>
              <span>面试公司</span>
              <select
                value={selectedCompanyId}
                disabled={companySelectorDisabled}
                onChange={(event) => handleCompanyChange(event.target.value)}
              >
                <option value="">无公司</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="icon-button settings-command" type="button" onClick={() => setSettingsOpen(true)} title="打开采集和 ASR 设置">
              <Settings size={16} />
              <span>设置</span>
            </button>
            {sessionState === "running" ? (
              <button className="icon-button" type="button" onClick={pauseInterview}>
                <Pause size={17} />
                <span>暂停面试</span>
              </button>
            ) : sessionState === "paused" ? (
              <button className="primary-command" type="button" onClick={resumeInterview}>
                <Play size={17} />
                <span>继续面试</span>
              </button>
            ) : (
              <button className="primary-command" type="button" onClick={startInterview}>
                <Play size={17} />
                <span>开始面试</span>
              </button>
            )}
            {(sessionState === "running" || sessionState === "paused") ? (
              <button className="danger-command" type="button" onClick={endInterview}>
                <CircleStop size={17} />
                <span>结束面试</span>
              </button>
            ) : null}
          </div>
        </section>
      </header>

      {settingsOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="客户端设置" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-head">
              <div>
                <h2>客户端设置</h2>
                <p>系统声音、麦克风、ASR Resource 和本地保存</p>
              </div>
              <button className="icon-only" type="button" onClick={() => setSettingsOpen(false)} title="关闭设置">
                <X size={17} />
              </button>
            </div>
            <div className="settings-grid">
              <label className="wide-setting">
                <span>Resource ID</span>
                <input value={resourceId} onChange={(event) => setResourceId(event.target.value)} />
              </label>
              <div className="inline-info">
                <span>问题库</span>
                <strong title={bankSummary}>{bankSummary}</strong>
              </div>
              <label>
                <span>采集模式</span>
                <select value={captureMode} onChange={(event) => setCaptureMode(event.target.value as CaptureMode)}>
                  <option value="wasapi_loopback">WASAPI 系统声音</option>
                  <option value="virtual_audio_device" disabled={!hasVirtualSource}>虚拟声卡{hasVirtualSource ? "" : "（未检测到）"}</option>
                </select>
              </label>
              <label className="wide-setting">
                <span>系统音频输出设备</span>
                <select
                  value={selectedAudioOutputId}
                  disabled={deviceSelectorDisabled}
                  onChange={(event) => setSelectedAudioOutputId(event.target.value)}
                >
                  <option value="">默认系统输出</option>
                  {mediaDevices.audioOutputs.map((device) => (
                    <option key={device.id || device.label} value={device.id}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wide-setting">
                <span>麦克风输入设备</span>
                <select
                  value={selectedMicrophoneId}
                  disabled={deviceSelectorDisabled}
                  onChange={(event) => setSelectedMicrophoneId(event.target.value)}
                >
                  <option value="">默认麦克风</option>
                  {mediaDevices.audioInputs.map((device) => (
                    <option key={device.id || device.label} value={device.id}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className={cls("setting-toggle", saveAudio && "active")} type="button" onClick={() => setSaveAudio((value) => !value)}>
                <Save size={17} />
                <span>{saveAudio ? "保存音频和日志" : "不保存音频"}</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {error ? (
        <div className="error-banner">
          <strong>需要处理：</strong>
          <span>{error}</span>
        </div>
      ) : null}

      <section className="workspace">
        <section className="left-stack">
          <section className="panel question-panel">
            <div className="panel-title split">
              <div>
                <h2>面试官问题列表</h2>
              </div>
            </div>
            <div className="question-list">
              {questionRecords.length === 0 ? (
                <div className="empty-state compact-empty">
                  <FileText size={22} />
                  <p>识别到面试官问题后会按时间倒序显示。</p>
                </div>
              ) : null}
              {questionRecords.map((record) => (
                <button
                  type="button"
                  key={record.id}
                  className={cls(
                    "question-record",
                    selectedRecordId === record.id && "selected",
                    record.provisional && "provisional",
                    record.enhanced && "enhanced",
                  )}
                  onClick={() => selectRecord(record)}
                >
                  <span className="record-time">{formatTime(record.receivedAt)}</span>
                  <p className="record-query">{record.questionText}</p>
                </button>
              ))}
            </div>
          </section>

          <section className="panel candidate-panel">
            <div className="panel-title split">
              <div>
                <h2>匹配到的问题</h2>
              </div>
            </div>

            <div className="candidate-list">
              {candidates.length === 0 ? (
                <div className="empty-state">
                  <AudioLines size={24} />
                  <p>推断出问题后，这里会实时显示本地 Top 10 匹配。</p>
                </div>
              ) : null}
              {candidates.map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  className={cls("candidate-card", selectedCandidate?.id === candidate.id && "selected")}
                  onClick={() => selectCandidate(candidate)}
                >
                  <div className="candidate-main">
                    <div className="candidate-heading">
                      <h3>{candidate.question}</h3>
                      <span>{candidate.score}%</span>
                    </div>
                    <div className="candidate-meta">
                      <span className={cls("source-badge", candidate.source === "company" && "company-source")}>
                        {candidate.sourceLabel || "通用"}
                      </span>
                      {candidate.source === "company" && typeof candidate.sourceQuestionId === "number" ? (
                        <span>原题 #{candidate.sourceQuestionId}</span>
                      ) : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </section>

        <section className="answer-split">
          <article className="panel answer-panel original-answer-panel">
            <div className="panel-title split">
              <div>
                <h2>匹配原文答案</h2>
              </div>
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
                <p>选择候选题后显示题库原文答案。</p>
              </div>
            )}
          </article>

          <article className="panel answer-panel ai-answer-panel">
            <div className="panel-title split">
              <div>
                <h2>AI 输出答案</h2>
              </div>
            </div>

            {selectedRecord ? (
              <div className="answer-body">
                <section className={cls("answer-section", "model-answer-section", modelAnswerStreaming && "streaming")}>
                  <div className="model-answer-head">
                    <h3>模型口述稿：</h3>
                    {modelAnswerStreaming ? <span>生成中</span> : null}
                    {!modelAnswerStreaming && typeof selectedRecord.modelAnswerLatencyMs === "number" ? (
                      <span>{selectedRecord.modelAnswerLatencyMs}ms</span>
                    ) : null}
                  </div>
                  {modelAnswerVisible && (modelAnswerParagraphs.length || parsedModelAnswer.logic) ? (
                    <div className="model-answer-content">
                      {parsedModelAnswer.logic ? (
                        <section className="model-answer-block model-answer-logic">
                          <h4>回答逻辑：</h4>
                          <p>{parsedModelAnswer.logic}</p>
                        </section>
                      ) : null}
                      {modelAnswerParagraphs.length ? (
                        <section className="model-answer-block model-answer-detail">
                          <h4>具体内容：</h4>
                          {modelAnswerParagraphs.map((line, index) => <p key={index}>{line}</p>)}
                        </section>
                      ) : null}
                    </div>
                  ) : (
                    <p className="section-empty">
                      {selectedRecord.modelAnswerError || "等待稳定问题后生成 AI 口述稿。"}
                    </p>
                  )}
                </section>
              </div>
            ) : (
              <div className="answer-placeholder">
                <p>选择面试官问题后显示 AI 口述稿。</p>
              </div>
            )}
          </article>
        </section>

        <section className="panel transcript-panel">
          <div className="panel-title">
            <AudioLines size={18} />
            <div>
              <h2>语音识别</h2>
            </div>
          </div>
          <section className="live-transcript-grid">
            <section className="live-transcript">
              <div className="subpanel-title">系统实时</div>
              <p>{liveTranscript?.text || "等待系统声音"}</p>
            </section>
            <section className="live-transcript microphone-live">
              <div className="subpanel-title">麦克风实时</div>
              <p>{microphoneLiveTranscript?.text || "等待麦克风"}</p>
            </section>
          </section>
          <section className="transcript-streams">
            <section className="transcript-stream">
              <div className="subpanel-title timeline-title">系统转写</div>
              <div className="transcript-list">
                {displayedTranscriptSegments.length === 0 ? <p className="muted">暂无内容</p> : null}
                {displayedTranscriptSegments.map((line) => (
                  <article key={line.id} className="transcript-row">
                    <span>{formatTime(line.receivedAt)}</span>
                    <p>{line.rewrittenText || line.text}</p>
                  </article>
                ))}
              </div>
            </section>
            <section className="transcript-stream">
              <div className="subpanel-title timeline-title">麦克风转写</div>
              <div className="transcript-list">
                {displayedMicrophoneTranscriptSegments.length === 0 ? <p className="muted">暂无内容</p> : null}
                {displayedMicrophoneTranscriptSegments.map((line) => (
                  <article key={line.id} className="transcript-row microphone-row">
                    <span>{formatTime(line.receivedAt)}</span>
                    <p>{line.rewrittenText || line.text}</p>
                  </article>
                ))}
              </div>
            </section>
          </section>
        </section>
      </section>
    </main>
  );
}
