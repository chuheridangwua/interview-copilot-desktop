import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  FileText,
  Flag,
  LoaderCircle,
  Mic,
  MicOff,
  Moon,
  OctagonAlert,
  Pause,
  Play,
  Save,
  Settings,
  Sun,
  Undo2,
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
  ManualQuestionSegment,
  MatchCandidate,
  MatchCandidatesEvent,
  MediaDeviceOptions,
  ModelAnswerUpdateEvent,
  ModelQuestionUpdateEvent,
  SessionSettings,
} from "./desktopClient";

const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";
const THEME_STORAGE_KEY = "interview-copilot-theme";
const CANDIDATE_DISPLAY_LIMIT = 3;
const MANUAL_MARKER_PREROLL_MS = 10_000;

type SessionState = "idle" | "running" | "paused" | "ended";
type ThemeMode = "dark" | "light";
type ManualMarkerState = "idle" | "marking" | "submitting";
type ModelAnswerVariant = "mini" | "pro";

interface ModelAnswerState {
  status?: "streaming" | "done" | "error";
  answer?: string;
  error?: string;
  reason?: string;
  latencyMs?: number;
  model?: string;
  label?: string;
  serviceTier?: string;
}

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
  source?: string;
  manualStartedAt?: number;
  manualEndedAt?: number;
  manualSegments?: ManualQuestionSegment[];
  provisional: boolean;
  enhanced: boolean;
  receivedAt: number;
  candidates: MatchCandidate[];
  selectedCandidate: MatchCandidate | null;
  modelAnswers?: Partial<Record<ModelAnswerVariant, ModelAnswerState>>;
  modelAnswerStatus?: "streaming" | "done" | "error";
  modelAnswer?: string;
  modelAnswerError?: string;
  modelAnswerReason?: string;
  modelAnswerLatencyMs?: number;
}

function getLatestQuestionRecord(records: QuestionRecord[]) {
  return records.reduce<QuestionRecord | null>((latest, record) => (
    !latest || record.receivedAt > latest.receivedAt ? record : latest
  ), null);
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

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function formatTime(value: number) {
  return new Date(value || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isTextInputTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return ["button", "input", "select", "textarea"].includes(tagName) || target.isContentEditable;
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
  const fallbackDetailMatch = !detailMatch && logicMatch
    ? value.slice(logicStart).match(/【[^】]{2,24}】/)
    : null;
  const fallbackDetailStart = fallbackDetailMatch
    ? logicStart + (fallbackDetailMatch.index ?? 0)
    : value.length;
  const detailStart = detailMatch ? (detailMatch.index ?? value.length) : fallbackDetailStart;
  const detailContentStart = detailMatch ? detailStart + detailMatch[0].length : fallbackDetailStart;
  return {
    logic: value.slice(logicStart, detailStart).trim(),
    detail: value.slice(detailContentStart).trim(),
  };
}

function renderModelAnswerText(text: string) {
  const value = String(text ?? "");
  if (!value) return null;
  const nodes: Array<string | JSX.Element> = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null = null;
  function pushAutoHighlighted(segment: string, keyPrefix: string) {
    const terms = [
      "权限对象",
      "权限来源",
      "权限隔离",
      "权限映射",
      "隔离审计",
      "调用链路",
      "知识库",
      "数据源",
      "工具",
      "角色",
      "部门",
      "岗位",
      "业务对象",
      "评分维度",
      "动态权重",
      "权重",
      "规则",
      "风险指标",
      "落地效果",
      "召回",
      "过滤",
      "审计",
      "监控",
      "成本",
      "版本",
      "权限",
      "风险",
      "平台",
      "中台",
      "模型",
      "Agent",
      "AI",
    ];
    const escapedTerms = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const autoPattern = new RegExp(`(${escapedTerms.join("|")})`, "g");
    let segmentCursor = 0;
    let autoMatch: RegExpExecArray | null = null;
    while ((autoMatch = autoPattern.exec(segment)) !== null) {
      if (autoMatch.index > segmentCursor) nodes.push(segment.slice(segmentCursor, autoMatch.index));
      nodes.push(
        <strong className="model-answer-emphasis auto-emphasis" key={`${keyPrefix}-${autoMatch.index}-${autoMatch[1]}`}>
          {autoMatch[1]}
        </strong>,
      );
      segmentCursor = autoMatch.index + autoMatch[0].length;
    }
    if (segmentCursor < segment.length) nodes.push(segment.slice(segmentCursor));
  }

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) pushAutoHighlighted(value.slice(cursor, match.index), `auto-${cursor}`);
    nodes.push(
      <strong className="model-answer-emphasis" key={`${match.index}-${match[1]}`}>
        {match[1]}
      </strong>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) pushAutoHighlighted(value.slice(cursor), `auto-${cursor}`);
  return nodes.length ? nodes : value;
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
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getInitialTheme());
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [mediaDevices, setMediaDevices] = useState<MediaDeviceOptions>({ audioInputs: [], audioOutputs: [] });
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState("");
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("wasapi_loopback");
  const [resourceId, setResourceId] = useState(DEFAULT_RESOURCE_ID);
  const saveAudio = true;
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const sessionStateRef = useRef<SessionState>("idle");
  const [manualMarkerState, setManualMarkerState] = useState<ManualMarkerState>("idle");
  const manualMarkerStateRef = useRef<ManualMarkerState>("idle");
  const [manualStartAt, setManualStartAt] = useState<number | null>(null);
  const manualStartAtRef = useRef<number | null>(null);
  const [manualElapsedMs, setManualElapsedMs] = useState(0);
  const [lastManualMatchId, setLastManualMatchId] = useState<string | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<TranscriptSegment | null>(null);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const transcriptSegmentsRef = useRef<TranscriptSegment[]>([]);
  const liveTranscriptRef = useRef<TranscriptSegment | null>(null);
  const [microphoneLiveTranscript, setMicrophoneLiveTranscript] = useState<TranscriptSegment | null>(null);
  const [microphoneTranscriptSegments, setMicrophoneTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [questionRecords, setQuestionRecords] = useState<QuestionRecord[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const selectedRecordIdRef = useRef<string | null>(null);
  const autoFollowLatestQuestionRef = useRef(true);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<MatchCandidate | null>(null);
  const [systemAudioVolumePercent, setSystemAudioVolumePercent] = useState<number | null>(null);
  const [microphoneVolumePercent, setMicrophoneVolumePercent] = useState<number | null>(null);
  const [microphoneCaptureEnabled, setMicrophoneCaptureEnabled] = useState(false);
  const [microphoneToggleBusy, setMicrophoneToggleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [companyMenuOpen, setCompanyMenuOpen] = useState(false);
  const companySelectorRef = useRef<HTMLDivElement | null>(null);
  const [healthItems, setHealthItems] = useState<Record<string, HealthStatusItem>>(() => createInitialHealthItems());
  const [healthCheckedAt, setHealthCheckedAt] = useState<number | null>(null);
  const [logDir, setLogDir] = useState("");

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = themeMode;
    root.style.colorScheme = themeMode;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Storage can be unavailable in locked-down desktop shells; keep the live theme applied.
    }
  }, [themeMode]);

  useEffect(() => {
    sessionStateRef.current = sessionState;
  }, [sessionState]);

  useEffect(() => {
    manualMarkerStateRef.current = manualMarkerState;
  }, [manualMarkerState]);

  useEffect(() => {
    manualStartAtRef.current = manualStartAt;
  }, [manualStartAt]);

  useEffect(() => {
    transcriptSegmentsRef.current = transcriptSegments;
  }, [transcriptSegments]);

  useEffect(() => {
    liveTranscriptRef.current = liveTranscript;
  }, [liveTranscript]);

  useEffect(() => {
    if (manualMarkerState !== "marking" || !manualStartAt) {
      setManualElapsedMs(0);
      return undefined;
    }
    const timer = window.setInterval(() => {
      setManualElapsedMs(Date.now() - manualStartAt);
    }, 250);
    return () => window.clearInterval(timer);
  }, [manualMarkerState, manualStartAt]);

  useEffect(() => {
    selectedRecordIdRef.current = selectedRecordId;
  }, [selectedRecordId]);

  useEffect(() => {
    if (!companyMenuOpen) return undefined;

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && companySelectorRef.current?.contains(target)) return;
      setCompanyMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setCompanyMenuOpen(false);
    }

    window.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [companyMenuOpen]);

  useEffect(() => {
    if (questionRecords.length === 0) return;
    const visibleRecord = autoFollowLatestQuestionRef.current
      ? getLatestQuestionRecord(questionRecords)
      : questionRecords.find((record) => record.id === selectedRecordIdRef.current) ?? null;
    if (visibleRecord) showRecord(visibleRecord);
  }, [questionRecords]);

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

  useEffect(() => {
    if (companySelectorDisabled) setCompanyMenuOpen(false);
  }, [companySelectorDisabled]);

  function clearInterviewResults() {
    setLiveTranscript(null);
    setTranscriptSegments([]);
    transcriptSegmentsRef.current = [];
    liveTranscriptRef.current = null;
    setMicrophoneLiveTranscript(null);
    setMicrophoneTranscriptSegments([]);
    setQuestionRecords([]);
    selectedRecordIdRef.current = null;
    setSelectedRecordId(null);
    autoFollowLatestQuestionRef.current = true;
    setCandidates([]);
    setSelectedCandidate(null);
    setManualMarkerState("idle");
    manualMarkerStateRef.current = "idle";
    setManualStartAt(null);
    manualStartAtRef.current = null;
    setManualElapsedMs(0);
    setLastManualMatchId(null);
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
        } else if (payload.state === "paused" || payload.state === "stopped" || payload.state === "error") {
          setMicrophoneVolumePercent(0);
        }
        if (payload.state === "starting" || payload.state === "capturing" || payload.state === "paused") {
          setMicrophoneCaptureEnabled(true);
        } else if (payload.state === "idle" || payload.state === "stopped" || payload.state === "error") {
          setMicrophoneCaptureEnabled(false);
        }
        if (payload.state === "error") setError(payload.message);
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
        if (manualMarkerStateRef.current === "marking" && payload.definite && payload.source !== "manual_marker") return;
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
          source: payload.source,
          manualStartedAt: payload.manualStartedAt,
          manualEndedAt: payload.manualEndedAt,
          manualSegments: payload.manualSegments,
          provisional: Boolean(payload.provisional),
          enhanced: Boolean(payload.enhanced),
          receivedAt: payload.receivedAt || Date.now(),
          candidates: payload.candidates,
          selectedCandidate: topCandidate,
        };

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
            const updatedRecord = {
              ...existing,
              ...record,
              id: existing.provisional && !record.provisional ? record.id : existing.id,
              matchId: record.matchId,
              provisional: record.provisional && !record.enhanced,
            };
            next[duplicateIndex] = updatedRecord;
            return next.slice(0, 40);
          }
          return [record, ...baseRecords].slice(0, 40);
        });
      }));

      unlisteners.push(await listenEvent<ModelQuestionUpdateEvent>("model_question_update", (payload) => {
        setQuestionRecords((records) => {
          return records.map((record) => {
            if (record.matchId !== payload.matchId) return record;
            const selected = record.selectedCandidate && payload.candidates.some((candidate) => candidate.id === record.selectedCandidate?.id)
              ? record.selectedCandidate
              : payload.candidates[0] ?? record.selectedCandidate;
            return {
              ...record,
              questionText: payload.questionText,
              sourceText: payload.sourceText || record.sourceText,
              confidence: payload.confidence,
              reason: payload.reason || record.reason,
              source: payload.source || record.source,
              manualStartedAt: payload.manualStartedAt || record.manualStartedAt,
              manualEndedAt: payload.manualEndedAt || record.manualEndedAt,
              manualSegments: payload.manualSegments || record.manualSegments,
              enhanced: true,
              candidates: payload.candidates.length ? payload.candidates : record.candidates,
              selectedCandidate: selected,
            };
          });
        });
      }));

      unlisteners.push(await listenEvent<AiMatchUpdateEvent>("ai_match_update", (payload) => {
        if (payload.status !== "ready" || payload.candidates.length === 0) return;
        setQuestionRecords((records) => {
          return records.map((record) => {
            if (record.matchId !== payload.matchId) return record;
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
        });
      }));

      unlisteners.push(await listenEvent<ModelAnswerUpdateEvent>("model_answer_update", (payload) => {
        setQuestionRecords((records) => records.map((record) => {
          if (record.matchId !== payload.matchId) return record;
          const variant: ModelAnswerVariant = payload.variant === "pro" ? "pro" : "mini";
          const previousAnswerState = record.modelAnswers?.[variant] ?? (variant === "mini" ? {
            status: record.modelAnswerStatus,
            answer: record.modelAnswer,
            error: record.modelAnswerError,
            reason: record.modelAnswerReason,
            latencyMs: record.modelAnswerLatencyMs,
          } : {});
          const nextAnswer = typeof payload.answer === "string"
            ? payload.answer
            : `${previousAnswerState.answer || ""}${payload.delta || ""}`;
          const nextAnswerState: ModelAnswerState = {
            ...previousAnswerState,
            status: payload.status,
            answer: nextAnswer,
            error: payload.status === "error" ? payload.message : undefined,
            reason: payload.reason || previousAnswerState.reason,
            latencyMs: payload.latencyMs,
            model: payload.model || previousAnswerState.model,
            label: payload.label || previousAnswerState.label,
            serviceTier: payload.serviceTier || previousAnswerState.serviceTier,
          };
          return {
            ...record,
            modelAnswers: {
              ...(record.modelAnswers || {}),
              [variant]: nextAnswerState,
            },
            ...(variant === "mini" ? {
              modelAnswerStatus: payload.status,
              modelAnswer: nextAnswer,
              modelAnswerError: payload.status === "error" ? payload.message : undefined,
              modelAnswerReason: payload.reason || record.modelAnswerReason,
              modelAnswerLatencyMs: payload.latencyMs,
            } : {}),
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

    if (!selectedCompanyId) {
      const confirmed = window.confirm(
        "当前未选择面试公司，将只使用通用题库，AI 回答不会结合公司介绍、JD 或公司题库。\n\n确认继续开始面试吗？",
      );
      if (!confirmed) return;
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
    setMicrophoneCaptureEnabled(false);
    setMicrophoneToggleBusy(false);
    try {
      const result = await api.startSession(settings);
      void api.listMediaDevices().then(setMediaDevices).catch(() => undefined);
      sessionStateRef.current = "running";
      setSessionState("running");
      setMicrophoneCaptureEnabled(Boolean(result.microphoneContextEnabled));
      setLiveTranscript(null);
      liveTranscriptRef.current = null;
      setTranscriptSegments([]);
      transcriptSegmentsRef.current = [];
      setMicrophoneLiveTranscript(null);
      setMicrophoneTranscriptSegments([]);
      setQuestionRecords([]);
      selectedRecordIdRef.current = null;
      setSelectedRecordId(null);
      autoFollowLatestQuestionRef.current = true;
      setCandidates([]);
      setSelectedCandidate(null);
      setManualMarkerState("idle");
      manualMarkerStateRef.current = "idle";
      setManualStartAt(null);
      manualStartAtRef.current = null;
      setManualElapsedMs(0);
      setLastManualMatchId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pauseInterview() {
    try {
      if (manualMarkerStateRef.current !== "idle") await cancelManualQuestionMark();
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

  async function toggleMicrophoneCapture() {
    const nextEnabled = !microphoneCaptureEnabled;
    const canStop = microphoneCaptureEnabled && (sessionStateRef.current === "running" || sessionStateRef.current === "paused");
    const canStart = !microphoneCaptureEnabled && sessionStateRef.current === "running";
    if ((nextEnabled && !canStart) || (!nextEnabled && !canStop)) return;

    setError(null);
    setMicrophoneToggleBusy(true);
    try {
      const result = await api.setMicrophoneCaptureEnabled(nextEnabled, {
        microphoneDeviceId: selectedMicrophoneId || undefined,
        microphoneDeviceName: selectedMicrophone?.label || "默认麦克风",
      });
      setMicrophoneCaptureEnabled(result.enabled);
      if (!result.enabled) {
        setMicrophoneVolumePercent(0);
        setMicrophoneLiveTranscript(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (nextEnabled) setMicrophoneCaptureEnabled(false);
    } finally {
      setMicrophoneToggleBusy(false);
    }
  }

  async function endInterview() {
    try {
      if (manualMarkerStateRef.current !== "idle") await cancelManualQuestionMark();
      await api.stopSession();
      sessionStateRef.current = "ended";
      setSessionState("ended");
      setMicrophoneCaptureEnabled(false);
      setMicrophoneToggleBusy(false);
      setMicrophoneVolumePercent(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function showRecord(record: QuestionRecord) {
    selectedRecordIdRef.current = record.id;
    setSelectedRecordId(record.id);
    setCandidates(record.candidates);
    setSelectedCandidate(record.selectedCandidate ?? record.candidates[0] ?? null);
  }

  function followLatestQuestion() {
    autoFollowLatestQuestionRef.current = true;
    const latestRecord = getLatestQuestionRecord(questionRecords);
    if (latestRecord) showRecord(latestRecord);
  }

  function selectRecord(record: QuestionRecord) {
    const latestRecord = getLatestQuestionRecord(questionRecords);
    autoFollowLatestQuestionRef.current = latestRecord?.id === record.id;
    showRecord(record);
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
    setCompanyMenuOpen(false);
    setSelectedCompanyId(nextCompanyId);
    clearInterviewResults();
  }

  function collectManualQuestionSegments(startedAt: number, endedAt: number) {
    const captureStartedAt = Math.max(0, startedAt - MANUAL_MARKER_PREROLL_MS);
    const selectedSegments = transcriptSegmentsRef.current
      .filter((segment) => segment.receivedAt >= captureStartedAt && segment.receivedAt <= endedAt)
      .sort((a, b) => a.receivedAt - b.receivedAt);
    const live = liveTranscriptRef.current;
    const liveText = String(live?.rewrittenText || live?.text || "").trim();
    const shouldAppendLive = Boolean(
      live
      && liveText
      && live.receivedAt >= captureStartedAt
      && live.receivedAt <= endedAt + 800
      && !selectedSegments.some((segment) => isNearDuplicate(segment.rewrittenText || segment.text, liveText)),
    );
    const segments = shouldAppendLive ? [...selectedSegments, live as TranscriptSegment] : selectedSegments;
    return segments.map<ManualQuestionSegment>((segment) => ({
      text: segment.text,
      rewrittenText: segment.rewrittenText,
      receivedAt: segment.receivedAt,
    }));
  }

  function buildManualSourceText(segments: ManualQuestionSegment[]) {
    return segments
      .map((segment) => String(segment.rewrittenText || segment.text || "").trim())
      .filter(Boolean)
      .reduce<string[]>((items, text) => {
        if (items.some((item) => isNearDuplicate(item, text))) return items;
        return [...items, text];
      }, [])
      .join("。")
      .replace(/。+/g, "。")
      .trim();
  }

  async function beginManualQuestionMark() {
    if (sessionStateRef.current !== "running" || manualMarkerStateRef.current !== "idle") return;
    const startedAt = Date.now();
    setError(null);
    setManualMarkerState("marking");
    manualMarkerStateRef.current = "marking";
    setManualStartAt(startedAt);
    manualStartAtRef.current = startedAt;
    setManualElapsedMs(0);
    try {
      const result = await api.setManualQuestionMarking(true);
      if (!result.active) {
        setManualMarkerState("idle");
        manualMarkerStateRef.current = "idle";
        setManualStartAt(null);
        manualStartAtRef.current = null;
        setManualElapsedMs(0);
        setError("当前没有正在进行的面试会话，不能标记问题");
      }
    } catch (err) {
      setManualMarkerState("idle");
      manualMarkerStateRef.current = "idle";
      setManualStartAt(null);
      manualStartAtRef.current = null;
      setManualElapsedMs(0);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function cancelManualQuestionMark() {
    if (manualMarkerStateRef.current === "idle") return;
    setManualMarkerState("idle");
    manualMarkerStateRef.current = "idle";
    setManualStartAt(null);
    manualStartAtRef.current = null;
    setManualElapsedMs(0);
    try {
      await api.setManualQuestionMarking(false);
    } catch {
      // Marker cancellation should keep the UI responsive even if the backend session has ended.
    }
  }

  async function finishManualQuestionMark() {
    const startedAt = manualStartAtRef.current;
    if (sessionStateRef.current !== "running" || manualMarkerStateRef.current !== "marking" || !startedAt) return;
    const endedAt = Date.now();
    const segments = collectManualQuestionSegments(startedAt, endedAt);
    const sourceText = buildManualSourceText(segments);
    if (!sourceText.trim()) {
      setError("标记区间内没有可用面试官转写");
      await cancelManualQuestionMark();
      return;
    }
    setManualMarkerState("submitting");
    manualMarkerStateRef.current = "submitting";
    try {
      const result = await api.submitManualQuestionSegment({
        sourceText,
        segments,
        startedAt,
        endedAt,
        companyId: selectedCompanyId || undefined,
      });
      setLastManualMatchId(result.matchId);
      setManualMarkerState("idle");
      manualMarkerStateRef.current = "idle";
      setManualStartAt(null);
      manualStartAtRef.current = null;
      setManualElapsedMs(0);
    } catch (err) {
      await api.setManualQuestionMarking(false).catch(() => undefined);
      setManualMarkerState("idle");
      manualMarkerStateRef.current = "idle";
      setManualStartAt(null);
      manualStartAtRef.current = null;
      setManualElapsedMs(0);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleManualQuestionMark() {
    if (manualMarkerStateRef.current === "marking") {
      void finishManualQuestionMark();
      return;
    }
    if (manualMarkerStateRef.current === "idle") {
      void beginManualQuestionMark();
    }
  }

  async function undoLatestManualQuestion() {
    const latestManualRecord = questionRecords
      .filter((record) => record.source === "manual_marker" && !record.provisional)
      .sort((a, b) => b.receivedAt - a.receivedAt)[0];
    const matchId = latestManualRecord?.matchId || lastManualMatchId;
    if (!matchId) return;
    try {
      const result = await api.undoManualQuestion(matchId);
      if (!result.ok || !result.removed) {
        setError("未能撤销手动问题：当前会话归档中未找到这条手动问题");
        return;
      }
      const removingSelectedRecord = Boolean(
        selectedRecordIdRef.current
        && questionRecords.some((record) => record.matchId === matchId && record.id === selectedRecordIdRef.current),
      );
      setQuestionRecords((records) => records.filter((record) => record.matchId !== matchId));
      if (removingSelectedRecord) {
        selectedRecordIdRef.current = null;
        setSelectedRecordId(null);
        setCandidates([]);
        setSelectedCandidate(null);
      }
      setLastManualMatchId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || isTextInputTarget(event.target)) return;
      if (event.code === "KeyM") {
        event.preventDefault();
        toggleManualQuestionMark();
        return;
      }
      if (event.code !== "Space") return;
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
    selectedCompanyId,
    selectedAudioOutput,
    selectedMicrophone,
    sources,
    manualMarkerState,
    manualStartAt,
    transcriptSegments,
    liveTranscript,
    questionRecords,
    lastManualMatchId,
  ]);

  const answerTerms = selectedCandidate?.highlightTerms ?? selectedCandidate?.hitTerms ?? [];
  const answerLogic = selectedCandidate?.answerLogic?.trim() ?? "";
  const answerDetail = selectedCandidate?.answerDetail?.trim() || selectedCandidate?.answer || "";
  const selectedRecord = questionRecords.find((record) => record.id === selectedRecordId) ?? null;
  const latestManualRecord = questionRecords
    .filter((record) => record.source === "manual_marker" && !record.provisional)
    .sort((a, b) => b.receivedAt - a.receivedAt)[0] ?? null;
  const miniAnswerState: ModelAnswerState = selectedRecord?.modelAnswers?.mini ?? {
    status: selectedRecord?.modelAnswerStatus,
    answer: selectedRecord?.modelAnswer,
    error: selectedRecord?.modelAnswerError,
    reason: selectedRecord?.modelAnswerReason,
    latencyMs: selectedRecord?.modelAnswerLatencyMs,
    label: "Mini",
  };
  const proAnswerState: ModelAnswerState = selectedRecord?.modelAnswers?.pro ?? {
    label: "Pro Fast",
    model: "doubao-seed-2-0-pro-260215",
    serviceTier: "fast",
  };
  const displayedCandidates = candidates.slice(0, CANDIDATE_DISPLAY_LIMIT);
  const selectedInterviewQuestion = selectedRecord?.questionText.trim() ?? "";
  const selectedInterviewQuestionMeta = selectedRecord
    ? [
      selectedRecord.source === "manual_marker" ? "手动标记" : "自动识别",
      typeof selectedRecord.confidence === "number" ? `${Math.round(selectedRecord.confidence * 100)}%` : "",
      selectedRecord.enhanced ? "已增强" : "",
    ].filter(Boolean).join(" · ")
    : "暂无问题";
  const displayedTranscriptSegments = [...transcriptSegments].reverse();
  const displayedMicrophoneTranscriptSegments = [...microphoneTranscriptSegments].reverse();
  const canStopMicrophoneCapture = microphoneCaptureEnabled && (sessionState === "running" || sessionState === "paused");
  const canStartMicrophoneCapture = !microphoneCaptureEnabled && sessionState === "running";
  const microphoneToggleDisabled = microphoneToggleBusy || (!canStopMicrophoneCapture && !canStartMicrophoneCapture);
  const microphoneToggleLabel = microphoneCaptureEnabled ? "停止麦克风" : "开启麦克风";
  const manualMarkerDisabled = sessionState !== "running" || manualMarkerState === "submitting";
  const manualMarkerLabel = manualMarkerState === "marking"
    ? `结束标记 ${formatDuration(manualElapsedMs)}`
    : manualMarkerState === "submitting"
      ? "提交中"
      : "标记问题";
  const topbarQuestionRecords = questionRecords
    .filter((record) => record.questionText.trim())
    .slice(0, 6);
  const topbarQuestionMidpoint = Math.ceil(topbarQuestionRecords.length / 2);
  const topbarQuestionLeftRecords = topbarQuestionRecords.slice(0, topbarQuestionMidpoint).reverse();
  const topbarQuestionRightRecords = topbarQuestionRecords.slice(topbarQuestionMidpoint);

  function renderModelAnswerCard(
    variant: ModelAnswerVariant,
    title: string,
    fallbackState: ModelAnswerState,
  ) {
    const answer = fallbackState.answer?.trim() ?? "";
    const parsedAnswer = parseModelAnswer(answer);
    const answerDetail = parsedAnswer.detail || (!parsedAnswer.logic ? answer : "");
    const answerParagraphs = splitParagraphs(answerDetail);
    const streaming = fallbackState.status === "streaming";
    const visible = Boolean(selectedRecord && (answer || streaming || fallbackState.status === "error"));
    const latencyText = !streaming && typeof fallbackState.latencyMs === "number"
      ? `${fallbackState.latencyMs}ms`
      : "";
    const tierText = fallbackState.serviceTier ? ` · ${fallbackState.serviceTier}` : "";
    const modelText = fallbackState.model ? `${fallbackState.model}${tierText}` : "";

    return (
      <section className={cls("model-answer-section", "model-answer-card", `${variant}-answer-card`, streaming && "streaming")}>
        <div className="model-answer-head">
          <div>
            <h3>{title}</h3>
            {modelText ? <p>{modelText}</p> : null}
          </div>
          {streaming ? <span>生成中</span> : null}
          {latencyText ? <span>{latencyText}</span> : null}
        </div>
        {visible && (answerParagraphs.length || parsedAnswer.logic) ? (
          <div className="model-answer-content">
            {parsedAnswer.logic ? (
              <section className="model-answer-block model-answer-logic">
                <h4>回答逻辑：</h4>
                <p>{renderModelAnswerText(parsedAnswer.logic)}</p>
              </section>
            ) : null}
            {answerParagraphs.length ? (
              <section className="model-answer-block model-answer-detail">
                <h4>具体内容：</h4>
                {answerParagraphs.map((line, index) => <p key={index}>{renderModelAnswerText(line)}</p>)}
              </section>
            ) : null}
          </div>
        ) : (
          <p className="section-empty">
            {fallbackState.error || "等待稳定问题后生成输出答案。"}
          </p>
        )}
      </section>
    );
  }

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

        <section className="topbar-question-rail left" aria-label="最近面试官问题">
          {topbarQuestionLeftRecords.map((record) => (
            <button
              key={record.id}
              className={cls(
                "topbar-question-chip",
                selectedRecordId === record.id && "selected",
                record.provisional && "provisional",
                record.source === "manual_marker" && "manual",
              )}
              type="button"
              onClick={() => selectRecord(record)}
              title={record.questionText}
            >
              {record.source === "manual_marker" ? <Flag size={13} /> : <AudioLines size={13} />}
              <span>{record.questionText}</span>
            </button>
          ))}
        </section>

        <section className="topbar-marker">
          <button
            className={cls("manual-marker-command", manualMarkerState === "marking" && "active", manualMarkerState === "submitting" && "submitting")}
            type="button"
            disabled={manualMarkerDisabled}
            onClick={toggleManualQuestionMark}
            title="按 M 开始或结束手动标记问题"
          >
            {manualMarkerState === "submitting" ? <LoaderCircle size={16} /> : <Flag size={16} />}
            <span>{manualMarkerLabel}</span>
          </button>
          {manualMarkerState === "marking" ? (
            <button className="manual-cancel-command" type="button" onClick={cancelManualQuestionMark} title="取消当前标记">
              <X size={16} />
              <span>取消</span>
            </button>
          ) : null}
        </section>

        <section className="topbar-question-rail right" aria-label="最近面试官问题">
          {topbarQuestionRightRecords.map((record) => (
            <button
              key={record.id}
              className={cls(
                "topbar-question-chip",
                selectedRecordId === record.id && "selected",
                record.provisional && "provisional",
                record.source === "manual_marker" && "manual",
              )}
              type="button"
              onClick={() => selectRecord(record)}
              title={record.questionText}
            >
              {record.source === "manual_marker" ? <Flag size={13} /> : <AudioLines size={13} />}
              <span>{record.questionText}</span>
            </button>
          ))}
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
              <div className="setting-toggle active auto-save-note" title="每场面试都会自动保存音频、转写、问题和答案归档">
                <Save size={17} />
                <span>自动保存已开启</span>
              </div>
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

      <section
        className={cls("current-match-strip", !selectedInterviewQuestion && "empty")}
        title={selectedInterviewQuestion || "等待用户选择面试官问题"}
      >
        <div className="current-match-icon">
          {selectedInterviewQuestion ? <CheckCircle2 size={15} /> : <AudioLines size={15} />}
        </div>
        <span className="current-match-label">当前匹配问题</span>
        <p>{selectedInterviewQuestion || "等待选择面试官问题"}</p>
        <span className="current-match-meta">{selectedInterviewQuestionMeta}</span>
      </section>

      <section className="workspace">
        <section className="left-stack">
          <article className="panel answer-panel original-answer-panel">
            <div className="panel-title split">
              <div>
                <h2>匹配原文答案</h2>
              </div>
            </div>

            <section className="candidate-strip">
              <div className="candidate-strip-head">
                <h3>匹配到的问题</h3>
                <span>{displayedCandidates.length ? `Top ${displayedCandidates.length}` : "暂无匹配"}</span>
              </div>
              <div className="candidate-list">
                {candidates.length === 0 ? (
                  <div className="empty-state candidate-empty">
                    <AudioLines size={18} />
                    <p>推断出问题后，这里会显示最好的 3 个匹配。</p>
                  </div>
                ) : null}
                {displayedCandidates.map((candidate) => (
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
        </section>

        <section className="answer-split">
          <section className="panel question-panel">
            <div className="panel-title split">
              <button
                className="panel-title-button"
                type="button"
                onClick={followLatestQuestion}
                title="切回自动跟随最新问题"
              >
                <h2>面试官问题列表</h2>
              </button>
              {latestManualRecord && (sessionState === "running" || sessionState === "paused") ? (
                <button
                  className="undo-command"
                  type="button"
                  onClick={undoLatestManualQuestion}
                  title="撤销最近一条手动标记问题"
                >
                  <Undo2 size={14} />
                  <span>撤销手动</span>
                </button>
              ) : null}
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
                    record.source === "manual_marker" && "manual",
                  )}
                  onClick={() => selectRecord(record)}
                >
                  <span className="record-time">
                    {formatTime(record.receivedAt)}
                    {record.source === "manual_marker" ? <span className="manual-badge">手动</span> : null}
                  </span>
                  <p className="record-query">{record.questionText}</p>
                </button>
              ))}
            </div>
          </section>

          <article className="panel answer-panel ai-answer-panel">
            <div className="panel-title split">
              <div>
                <h2>输出答案</h2>
              </div>
            </div>

            {selectedRecord ? (
              <div className="answer-body model-answer-stack">
                {renderModelAnswerCard("mini", "Mini 口述稿", miniAnswerState)}
                {renderModelAnswerCard("pro", "Pro Fast 口述稿", proAnswerState)}
              </div>
            ) : (
              <div className="answer-placeholder">
                <p>选择面试官问题后显示输出答案。</p>
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
              <p>{microphoneLiveTranscript?.text || (microphoneCaptureEnabled ? "等待麦克风" : "麦克风已停止")}</p>
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
          <section className="operation-pad">
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
                className={cls("icon-button", "microphone-command", !microphoneCaptureEnabled && "muted")}
                type="button"
                onClick={toggleMicrophoneCapture}
                disabled={microphoneToggleDisabled}
                aria-pressed={microphoneCaptureEnabled}
                title={microphoneCaptureEnabled ? "停止麦克风收音，只保留系统声音识别" : "重新开启麦克风收音，继续作为回答上下文"}
              >
                {microphoneCaptureEnabled ? <MicOff size={16} /> : <Mic size={16} />}
                <span>{microphoneToggleBusy ? "处理中" : microphoneToggleLabel}</span>
              </button>
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
              <div
                ref={companySelectorRef}
                className={cls("company-selector", companyMenuOpen && "open", companySelectorDisabled && "disabled")}
                title={selectedCompany ? `当前面试公司：${selectedCompany.name}` : "当前仅使用通用题库"}
              >
                <span>面试公司</span>
                <button
                  className="company-selector-button"
                  type="button"
                  disabled={companySelectorDisabled}
                  aria-haspopup="listbox"
                  aria-expanded={companyMenuOpen}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    if (companySelectorDisabled) return;
                    setCompanyMenuOpen((open) => !open);
                  }}
                >
                  <span>{selectedCompany?.name || "无公司"}</span>
                  <ChevronDown size={14} />
                </button>
                {companyMenuOpen && !companySelectorDisabled ? (
                  <div className="company-menu" role="listbox" aria-label="选择面试公司">
                    <button
                      className={cls("company-option", !selectedCompanyId && "selected")}
                      type="button"
                      role="option"
                      aria-selected={!selectedCompanyId}
                      onClick={() => handleCompanyChange("")}
                    >
                      <span>无公司</span>
                      {!selectedCompanyId ? <CheckCircle2 size={13} /> : null}
                    </button>
                    {companies.map((company) => (
                      <button
                        key={company.id}
                        className={cls("company-option", selectedCompanyId === company.id && "selected")}
                        type="button"
                        role="option"
                        aria-selected={selectedCompanyId === company.id}
                        onClick={() => handleCompanyChange(company.id)}
                      >
                        <span>{company.name}</span>
                        {selectedCompanyId === company.id ? <CheckCircle2 size={13} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button className="icon-button settings-command" type="button" onClick={() => setSettingsOpen(true)} title="打开采集和 ASR 设置">
                <Settings size={16} />
                <span>设置</span>
              </button>
              <button
                className={cls("icon-button", "theme-command", themeMode === "dark" && "active")}
                type="button"
                onClick={() => setThemeMode((mode) => (mode === "dark" ? "light" : "dark"))}
                aria-pressed={themeMode === "dark"}
                title={themeMode === "dark" ? "切换到浅色模式" : "切换到深色模式"}
              >
                {themeMode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
                <span>{themeMode === "dark" ? "深色" : "浅色"}</span>
              </button>
              {sessionState === "running" ? (
                <button className="icon-button session-command" type="button" onClick={pauseInterview}>
                  <Pause size={17} />
                  <span>暂停面试</span>
                </button>
              ) : sessionState === "paused" ? (
                <button className="primary-command session-command" type="button" onClick={resumeInterview}>
                  <Play size={17} />
                  <span>继续面试</span>
                </button>
              ) : (
                <button className="primary-command session-command" type="button" onClick={startInterview}>
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
        </section>
      </section>
    </main>
  );
}
