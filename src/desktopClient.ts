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
  state: "idle" | "starting" | "capturing" | "error" | "stopped";
  deviceName?: string;
  volume?: number;
  message: string;
}

export interface AsrTextEvent {
  text: string;
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
  status: "candidate" | "locked";
}

export interface MatchCandidatesEvent {
  query: string;
  locked: boolean;
  definite: boolean;
  receivedAt: number;
  candidates: MatchCandidate[];
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
  pauseMatching: () => Promise<void>;
  resumeMatching: () => Promise<void>;
  lockAnswer: (questionId: number) => Promise<void>;
  unlockAnswer: () => Promise<void>;
  searchQuestions: (query: string) => Promise<MatchCandidate[]>;
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
  pauseMatching: () => bridge().pauseMatching(),
  resumeMatching: () => bridge().resumeMatching(),
  lockAnswer: (questionId: number) => bridge().lockAnswer(questionId),
  unlockAnswer: () => bridge().unlockAnswer(),
  searchQuestions: (query: string) => bridge().searchQuestions(query),
};
