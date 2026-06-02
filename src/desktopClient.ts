export type CaptureMode = "wasapi_loopback" | "virtual_audio_device";

export interface AudioSource {
  id: string;
  name: string;
  captureMode: CaptureMode;
  isDefault: boolean;
  available: boolean;
  note?: string;
}

export interface SessionSettings {
  resourceId: string;
  captureMode: CaptureMode;
  audioDeviceId?: string;
  saveAudio: boolean;
}

export interface AudioStatusEvent {
  state: "idle" | "starting" | "capturing" | "paused" | "error" | "stopped";
  deviceName?: string;
  volume?: number;
  message: string;
}

export interface AsrTextEvent {
  text: string;
  rewrittenText?: string;
  definite: boolean;
  utteranceStartMs?: number;
  utteranceEndMs?: number;
  receivedAt: number;
}

export interface MatchCandidate {
  id: number;
  question: string;
  answer: string;
  answerLogic: string;
  answerDetail: string;
  score: number;
  hitTerms: string[];
  highlightTerms: string[];
  status: "candidate";
  aiReason?: string;
}

export interface MatchCandidatesEvent {
  matchId?: string;
  query: string;
  definite: boolean;
  receivedAt: number;
  candidates: MatchCandidate[];
  latencyMs: number;
  sourceText?: string;
  confidence?: number;
  reason?: string;
  provisional?: boolean;
  enhanced?: boolean;
}

export interface ModelQuestionUpdateEvent {
  matchId: string;
  questionText: string;
  sourceText: string;
  confidence: number;
  reason?: string;
  candidates: MatchCandidate[];
  receivedAt: number;
}

export interface AiMatchUpdateEvent {
  matchId: string;
  status: "ready" | "error";
  questionText: string;
  candidates: MatchCandidate[];
  answer: string;
  message?: string;
  receivedAt: number;
  latencyMs: number;
}

export type HealthItemState = "checking" | "ok" | "warning" | "error";

export interface HealthStatusItem {
  state: HealthItemState;
  label: string;
  message: string;
  latencyMs?: number;
  model?: string;
}

export interface HealthStatusEvent {
  checkedAt: number;
  items: Record<string, HealthStatusItem>;
  logDir: string;
}

export interface ModelAnswerUpdateEvent {
  matchId: string;
  status: "streaming" | "done" | "error";
  questionText: string;
  delta?: string;
  answer?: string;
  message?: string;
  reason?: string;
  receivedAt: number;
  latencyMs: number;
}

export interface SessionLogEvent {
  message: string;
  asrLogId?: string;
  saveAudio: boolean;
  asrLatencyMs?: number;
  matchLatencyMs?: number;
}

export interface DesktopBridge {
  listAudioSources: () => Promise<AudioSource[]>;
  startSession: (settings: SessionSettings) => Promise<{ sessionId: string }>;
  stopSession: () => Promise<void>;
  pauseSession: () => Promise<void>;
  resumeSession: () => Promise<void>;
  searchQuestions: (query: string) => Promise<MatchCandidate[]>;
  getHealthStatus: () => Promise<HealthStatusEvent>;
  listen: <T>(event: string, handler: (payload: T) => void) => () => void;
}

declare global {
  interface Window {
    interviewCopilot?: DesktopBridge;
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.interviewCopilot);
}

function bridge(): DesktopBridge {
  if (!window.interviewCopilot) {
    throw new Error("当前页面未连接 Electron 桌面端后端。请用桌面客户端启动。");
  }
  return window.interviewCopilot;
}

export async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isDesktopRuntime()) return () => undefined;
  return bridge().listen<T>(event, handler);
}

export const api = {
  listAudioSources: () => bridge().listAudioSources(),
  startSession: (settings: SessionSettings) => bridge().startSession(settings),
  stopSession: () => bridge().stopSession(),
  pauseSession: () => bridge().pauseSession(),
  resumeSession: () => bridge().resumeSession(),
  searchQuestions: (query: string) => bridge().searchQuestions(query),
  getHealthStatus: () => bridge().getHealthStatus(),
};
