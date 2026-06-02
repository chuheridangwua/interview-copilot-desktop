const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DoubaoAsrSession } = require("./backend/doubaoAsr.cjs");
const { Matcher, loadQuestionBank } = require("./backend/questionMatcher.cjs");

const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";
const isDev = Boolean(process.env.ELECTRON_DEV || process.env.ELECTRON_RENDERER_URL);

let mainWindow = null;
let matcher = null;
let questionBank = [];
let matchingPaused = false;
let lockedAnswer = null;
let currentSession = null;

function nowMs() {
  return Date.now();
}

function emit(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function emitAudioStatus(payload) {
  emit("audio_status", payload);
}

function emitLog(payload) {
  const event = {
    message: payload.message,
    asrLogId: payload.asrLogId,
    saveAudio: currentSession?.settings?.saveAudio ?? false,
    asrLatencyMs: payload.asrLatencyMs,
    matchLatencyMs: payload.matchLatencyMs,
  };
  const suffix = [
    event.asrLogId ? `logid=${event.asrLogId}` : "",
    typeof event.asrLatencyMs === "number" ? `asr_latency=${event.asrLatencyMs}ms` : "",
    typeof event.matchLatencyMs === "number" ? `match_latency=${event.matchLatencyMs}ms` : "",
  ].filter(Boolean).join(" · ");
  console.log(`[interview-copilot][electron] ${event.message}${suffix ? ` · ${suffix}` : ""}`);
  emit("session_log", event);
}

function ensureMatcher() {
  if (!matcher) {
    questionBank = loadQuestionBank(app.getAppPath());
    matcher = new Matcher(questionBank);
    console.log(`[interview-copilot][electron] embedded questions loaded: ${questionBank.length}`);
  }
  return matcher;
}

function resolveApiKey() {
  const value = String(process.env.DOUBAO_API_KEY || process.env.VOLCENGINE_ASR_API_KEY || "").trim();
  if (!value) {
    throw new Error("未检测到豆包 API Key。请在 Windows 用户环境变量中配置 DOUBAO_API_KEY，重启应用后会自动读取。");
  }
  if (value.length < 16) {
    throw new Error("豆包 API Key 看起来过短，请检查 Windows 环境变量 DOUBAO_API_KEY。");
  }
  return value;
}

function createSessionDir(sessionId) {
  const dir = path.join(app.getPath("userData"), "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(filename, payload) {
  if (!currentSession?.sessionDir) return;
  fs.appendFileSync(path.join(currentSession.sessionDir, filename), `${JSON.stringify(payload)}\n`);
}

function handleTranscript(transcript) {
  const receivedAt = nowMs();
  const asrEvent = {
    text: transcript.text,
    definite: transcript.definite,
    utteranceStartMs: transcript.startMs,
    utteranceEndMs: transcript.endMs,
    receivedAt,
  };
  emit(transcript.definite ? "asr_final" : "asr_partial", asrEvent);
  appendJsonl("transcript.jsonl", asrEvent);

  if (matchingPaused) return;
  const activeMatcher = ensureMatcher();
  const event = activeMatcher.searchWithEvent(transcript.text, null);
  event.locked = Boolean(lockedAnswer);
  event.definite = transcript.definite;
  event.receivedAt = receivedAt;
  appendJsonl("matches.jsonl", event);
  emit("match_candidates", event);
  emitLog({
    message: transcript.definite ? "稳定分句已触发匹配" : "流式候选已刷新",
    asrLatencyMs: transcript.asrLatencyMs,
    matchLatencyMs: event.latencyMs,
  });
}

function closeCurrentSession() {
  if (currentSession?.asr) currentSession.asr.close();
  if (currentSession?.audioFile) currentSession.audioFile.end();
  currentSession = null;
  matchingPaused = false;
  lockedAnswer = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Interview Copilot",
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    fullscreen: false,
    resizable: true,
    backgroundColor: "#12110f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || "http://127.0.0.1:1420");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      const source = sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source, audio: "loopback" });
    } catch (error) {
      console.error("[interview-copilot][electron] display media request failed", error);
      callback({});
    }
  });
}

ipcMain.handle("list_audio_sources", async () => ([
  {
    id: "electron-loopback",
    name: process.platform === "win32" ? "系统声音：Electron loopback" : "系统声音：Electron desktop capture",
    captureMode: "wasapi_loopback",
    isDefault: true,
    available: true,
    note: process.platform === "win32"
      ? "Electron 通过桌面捕获拿系统输出声音，不采集麦克风。"
      : "非 Windows 仅用于界面开发；真实面试系统声音请在 Windows 本机调试。",
  },
]));

ipcMain.handle("start_session", async (_event, settings) => {
  closeCurrentSession();
  ensureMatcher();
  const apiKey = resolveApiKey();
  const sessionId = crypto.randomUUID();
  const normalizedSettings = {
    resourceId: String(settings?.resourceId || DEFAULT_RESOURCE_ID).trim() || DEFAULT_RESOURCE_ID,
    captureMode: settings?.captureMode || "wasapi_loopback",
    audioDeviceId: settings?.audioDeviceId || "electron-loopback",
    saveAudio: Boolean(settings?.saveAudio),
  };
  const sessionDir = normalizedSettings.saveAudio ? createSessionDir(sessionId) : null;
  const audioFile = sessionDir ? fs.createWriteStream(path.join(sessionDir, "system-audio.pcm"), { flags: "a" }) : null;

  emitAudioStatus({
    state: "starting",
    deviceName: "Electron loopback",
    volume: 0,
    message: "系统声音已授权，正在连接豆包 ASR",
  });
  emitLog({ message: `正在连接豆包流式 ASR · resource=${normalizedSettings.resourceId} · request=${sessionId}` });

  const asr = new DoubaoAsrSession({
    apiKey,
    resourceId: normalizedSettings.resourceId,
    requestId: sessionId,
    emitLog,
    onTranscript: handleTranscript,
  });
  currentSession = { sessionId, settings: normalizedSettings, asr, sessionDir, audioFile };
  await asr.start();

  emitAudioStatus({
    state: "starting",
    deviceName: "Electron loopback",
    volume: 0,
    message: "ASR 已连接，正在采集系统声音",
  });
  return { sessionId };
});

ipcMain.handle("stop_session", async () => {
  closeCurrentSession();
  emitAudioStatus({ state: "stopped", deviceName: undefined, volume: 0, message: "监听已停止" });
});

ipcMain.handle("pause_matching", async () => {
  matchingPaused = true;
});

ipcMain.handle("resume_matching", async () => {
  matchingPaused = false;
});

ipcMain.handle("lock_answer", async (_event, questionId) => {
  lockedAnswer = Number(questionId);
});

ipcMain.handle("unlock_answer", async () => {
  lockedAnswer = null;
});

ipcMain.handle("search_questions", async (_event, query) => ensureMatcher().search(String(query ?? ""), null));

ipcMain.handle("audio_capture_error", async (_event, message) => {
  emitAudioStatus({ state: "error", deviceName: "Electron loopback", volume: undefined, message: `系统声音捕获失败：${message}` });
  emitLog({ message: `系统声音捕获失败：${message}` });
});

ipcMain.on("audio_chunk", (_event, payload) => {
  if (!currentSession?.asr) return;
  const pcm = Buffer.from(payload?.pcm ?? []);
  if (!pcm.length) return;
  currentSession.asr.sendAudio(pcm);
  if (currentSession.audioFile) currentSession.audioFile.write(pcm);
  emitAudioStatus({
    state: "capturing",
    deviceName: "Electron loopback",
    volume: typeof payload?.volume === "number" ? payload.volume : undefined,
    message: "正在采集系统声音并发送豆包 ASR",
  });
});

app.whenReady().then(() => {
  installDisplayMediaHandler();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  closeCurrentSession();
  if (process.platform !== "darwin") app.quit();
});
