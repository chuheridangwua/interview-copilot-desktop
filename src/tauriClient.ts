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
  doubaoApiKey?: string;
  resourceId: string;
  captureMode: CaptureMode;
  audioDeviceId?: string;
  saveAudio: boolean;
  questionBankPath: string;
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
  score: number;
  hitTerms: string[];
  highlightTerms: string[];
  status: "candidate" | "locked";
}

export interface MatchCandidatesEvent {
  query: string;
  locked: boolean;
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

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("当前页面未连接 Tauri 桌面端后端。请用桌面应用启动。");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (message) => handler(message.payload));
}

export const api = {
  listAudioSources: () => invokeCommand<AudioSource[]>("list_audio_sources"),
  startSession: (settings: SessionSettings) => invokeCommand<{ sessionId: string }>("start_session", { settings }),
  stopSession: () => invokeCommand<void>("stop_session"),
  pauseMatching: () => invokeCommand<void>("pause_matching"),
  resumeMatching: () => invokeCommand<void>("resume_matching"),
  lockAnswer: (questionId: number) => invokeCommand<void>("lock_answer", { questionId }),
  unlockAnswer: () => invokeCommand<void>("unlock_answer"),
  searchQuestions: (query: string) => invokeCommand<MatchCandidate[]>("search_questions", { query }),
};

