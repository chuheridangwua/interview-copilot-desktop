const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  callArkChat,
  confirmQuestionWithArk,
  generateFallbackAnswerStreamWithArk,
  inferQuestionWithArk,
  readWindowsEnv,
  rerankCandidateIdsWithArk,
  resolveArkConfig,
} = require("./backend/arkQuestionEnhancer.cjs");
const { DoubaoAsrSession } = require("./backend/doubaoAsr.cjs");
const { Matcher, inferQuestionsFromSegments, loadQuestionBank, normalize, rewriteTranscriptText } = require("./backend/questionMatcher.cjs");

const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";
const isDev = Boolean(process.env.ELECTRON_DEV || process.env.ELECTRON_RENDERER_URL);

let mainWindow = null;
let matcher = null;
let questionBank = [];
let resumeText = "";
let currentSession = null;
let sessionPaused = false;
let recentTranscriptSegments = [];
let recentPartialSegments = [];
let pendingQuestionSegments = [];
let recentQuestionKeys = [];
let lastPartialQuestion = null;
let lastPartialMatchedAt = 0;
let arkEnhanceSeq = 0;
let lastArkEnhanceAt = 0;
let fallbackAnswerMatchIds = new Set();

function nowMs() {
  return Date.now();
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function projectLogDir() {
  return path.join(process.cwd(), "logs");
}

function appendProjectJsonl(filename, payload) {
  try {
    const dir = projectLogDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, filename), `${JSON.stringify(payload)}\n`);
  } catch (error) {
    console.warn("[interview-copilot][electron] project log write failed", error?.message || error);
  }
}

function appendModelLog(type, payload = {}) {
  appendProjectJsonl(`model-${dateStamp()}.jsonl`, {
    type,
    receivedAt: nowMs(),
    ...payload,
  });
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
  appendProjectJsonl(`session-${dateStamp()}.jsonl`, { ...event, receivedAt: nowMs() });
  emit("session_log", event);
}

function snippet(value, maxLength = 88) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function emitDebugLog(type, payload = {}) {
  const compactPayload = {
    type,
    receivedAt: nowMs(),
    ...payload,
  };
  const printable = JSON.stringify(compactPayload);
  console.log(`[interview-copilot][debug] ${printable}`);
  appendProjectJsonl(`debug-${dateStamp()}.jsonl`, compactPayload);
  appendJsonl("debug.jsonl", compactPayload);
}

function ensureMatcher() {
  if (!matcher) {
    questionBank = loadQuestionBank(app.getAppPath());
    matcher = new Matcher(questionBank);
    console.log(`[interview-copilot][electron] embedded questions loaded: ${questionBank.length}`);
  }
  return matcher;
}

function resolveResourceFile(filename) {
  const candidates = [
    path.join(app.getAppPath(), "resources", filename),
    path.join(process.cwd(), "resources", filename),
    path.join(process.resourcesPath || "", "resources", filename),
    path.join(process.resourcesPath || "", filename),
  ];
  return candidates.find((item) => item && fs.existsSync(item));
}

function loadResumeText() {
  if (resumeText) return resumeText;
  const resumePath = resolveResourceFile("jianli.md");
  if (!resumePath) {
    console.warn("[interview-copilot][electron] resume file not found: resources/jianli.md");
    return "";
  }
  resumeText = fs.readFileSync(resumePath, "utf8");
  console.log(`[interview-copilot][electron] resume loaded: ${path.basename(resumePath)} · ${resumeText.length} chars`);
  return resumeText;
}

function getEnvValue(names) {
  for (const name of names) {
    const value = String(process.env[name] || readWindowsEnv(name) || "").trim();
    if (value) return { name, value };
  }
  return { name: "", value: "" };
}

function resolveApiKey() {
  const { value } = getEnvValue(["DOUBAO_API_KEY", "VOLCENGINE_ASR_API_KEY"]);
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
  try {
    fs.appendFileSync(path.join(currentSession.sessionDir, filename), `${JSON.stringify(payload)}\n`);
  } catch (error) {
    console.warn("[interview-copilot][electron] session log write failed", error?.message || error);
  }
}

function rememberQuestionKey(questionText) {
  const key = normalize(questionText);
  if (!key) return false;
  if (recentQuestionKeys.includes(key)) return true;
  recentQuestionKeys.push(key);
  recentQuestionKeys = recentQuestionKeys.slice(-12);
  return false;
}

function shouldEmitPartialQuestion(questionText, receivedAt) {
  const key = normalize(questionText);
  if (!key) return false;
  if (lastPartialQuestion?.key === key && receivedAt - lastPartialQuestion.receivedAt < 1200) return false;
  if (receivedAt - lastPartialMatchedAt < 240) return false;
  lastPartialQuestion = { key, receivedAt };
  lastPartialMatchedAt = receivedAt;
  return true;
}

function shouldCallArkEnhancer(receivedAt) {
  if (receivedAt - lastArkEnhanceAt < 900) return false;
  lastArkEnhanceAt = receivedAt;
  return true;
}

function isIncompleteQuestion(questionText) {
  const value = String(questionText ?? "").replace(/[？?]$/g, "").trim();
  return /什么样一$|什么样一个$|什么样一个人员$|为什么想从$|为什么想$|为什么从$/.test(value) || value.length < 5;
}

function hasQuestionIntent(segment) {
  return inferQuestionsFromSegments([segment]).length > 0;
}

function createMatchId(receivedAt, definite, enhanced) {
  return `match-${receivedAt}-${definite ? "f" : "p"}-${enhanced ? "m" : "l"}-${crypto.randomUUID().slice(0, 8)}`;
}

function emitModelQuestionUpdate(payload) {
  emit("model_question_update", payload);
  appendJsonl("model-question-updates.jsonl", payload);
  appendModelLog("question_update", {
    matchId: payload.matchId,
    question: snippet(payload.questionText, 160),
    confidence: payload.confidence,
    reason: payload.reason,
    candidates: (payload.candidates ?? []).map((item) => `#${item.id}:${item.score}`).join(","),
  });
}

function emitAiMatchUpdate(payload) {
  emit("ai_match_update", payload);
  appendJsonl("ai-matches.jsonl", payload);
  appendModelLog("match_update", {
    matchId: payload.matchId,
    status: payload.status,
    question: snippet(payload.questionText, 160),
    candidates: (payload.candidates ?? []).map((item) => `#${item.id}:${item.score}`).join(","),
    latencyMs: payload.latencyMs,
    message: payload.message,
  });
}

function emitModelAnswerUpdate(payload) {
  emit("model_answer_update", payload);
  appendJsonl("model-answers.jsonl", payload);
  appendModelLog("answer_update", {
    matchId: payload.matchId,
    status: payload.status,
    question: snippet(payload.questionText, 160),
    delta: snippet(payload.delta, 220),
    answerLength: String(payload.answer ?? "").length,
    reason: payload.reason,
    latencyMs: payload.latencyMs,
    message: payload.message,
  });
}

function maybeGenerateFallbackAnswer({ matchId, questionText, candidates, reason }) {
  const cleanedQuestion = String(questionText ?? "").trim();
  if (!currentSession || !matchId || !cleanedQuestion) return;
  if (fallbackAnswerMatchIds.has(matchId)) return;

  fallbackAnswerMatchIds.add(matchId);
  const requestSessionSeq = arkEnhanceSeq;
  const started = nowMs();
  let answer = "";
  const resume = loadResumeText();
  const pool = (candidates ?? []).slice(0, 5);
  const topScore = Number(pool[0]?.score ?? 0);
  const mode = topScore >= 65 ? "answer_guided" : "resume_generated";

  emitDebugLog("model_answer_start", {
    matchId,
    reason,
    mode,
    question: snippet(cleanedQuestion, 140),
    candidates: pool.map((item) => `#${item.id}:${item.score}`).join(","),
    hasResume: resume.length > 0,
  });
  emitModelAnswerUpdate({
    matchId,
    status: "streaming",
    questionText: cleanedQuestion,
    delta: "",
    answer: "",
    reason: reason || mode,
    receivedAt: nowMs(),
    latencyMs: 0,
  });

  generateFallbackAnswerStreamWithArk({
    question: cleanedQuestion,
    candidates: pool,
    resumeText: resume,
    mode,
    timeoutMs: 10000,
    onDelta: (delta, fullText) => {
      if (!currentSession || requestSessionSeq !== arkEnhanceSeq) return;
      answer = fullText;
      emitModelAnswerUpdate({
        matchId,
        status: "streaming",
        questionText: cleanedQuestion,
        delta,
        answer,
        reason: reason || mode,
        receivedAt: nowMs(),
        latencyMs: nowMs() - started,
      });
    },
  })
    .then((result) => {
      if (!currentSession || requestSessionSeq !== arkEnhanceSeq) return;
      answer = String(result || answer || "").trim();
      if (!answer) {
        emitModelAnswerUpdate({
          matchId,
          status: "error",
          questionText: cleanedQuestion,
          answer: "",
          message: "方舟未返回可用答案",
          reason: reason || mode,
          receivedAt: nowMs(),
          latencyMs: nowMs() - started,
        });
        emitDebugLog("model_answer_empty", {
          matchId,
          question: snippet(cleanedQuestion, 120),
          latencyMs: nowMs() - started,
        });
        return;
      }
      emitModelAnswerUpdate({
        matchId,
        status: "done",
        questionText: cleanedQuestion,
        answer,
        reason: reason || mode,
        receivedAt: nowMs(),
        latencyMs: nowMs() - started,
      });
      emitDebugLog("model_answer_done", {
        matchId,
        question: snippet(cleanedQuestion, 120),
        answer: snippet(answer, 180),
        latencyMs: nowMs() - started,
      });
    })
    .catch((error) => {
      emitModelAnswerUpdate({
        matchId,
        status: "error",
        questionText: cleanedQuestion,
        answer,
        message: error.message,
        reason: reason || mode,
        receivedAt: nowMs(),
        latencyMs: nowMs() - started,
      });
      emitDebugLog("model_answer_error", {
        matchId,
        question: snippet(cleanedQuestion, 120),
        message: error.message,
        latencyMs: nowMs() - started,
      });
      emitLog({ message: `方舟兜底答案跳过：${error.message}` });
    });
}

function scheduleModelMatchReview({ matchId, inferred, event, rerankPool, transcript, skipQuestionConfirm = false }) {
  const started = nowMs();
  if (!event.definite) {
    emitDebugLog("model_review_skip", {
      matchId,
      reason: "provisional_local_only",
      question: snippet(inferred.questionText || event.query, 120),
    });
    return;
  }

  const requestSessionSeq = arkEnhanceSeq;
  const sourceText = String(inferred.sourceText || event.sourceText || inferred.questionText || "").trim();
  const originalQuestion = String(inferred.questionText || event.query || "").trim();
  const activeMatcher = ensureMatcher();
  const originalPool = rerankPool.length ? rerankPool : activeMatcher.search(originalQuestion, 5);
  emitDebugLog("model_review_start", {
    matchId,
    question: snippet(originalQuestion, 120),
    candidates: originalPool.map((item) => `#${item.id}`).join(","),
    skipQuestionConfirm,
  });

  const confirmPromise = skipQuestionConfirm
    ? Promise.resolve({ ...inferred, reason: inferred.reason || "方舟确认" })
    : confirmQuestionWithArk({
      sourceText,
      localQuestion: originalQuestion,
      timeoutMs: 2800,
    });

  rerankCandidateIdsWithArk({
    question: originalQuestion,
    candidates: originalPool,
    timeoutMs: 2200,
  })
    .then((modelCandidates) => {
      if (!currentSession || requestSessionSeq !== arkEnhanceSeq) return;
      if (!modelCandidates?.length) {
        emitDebugLog("model_rerank_empty", {
          matchId,
          question: snippet(originalQuestion, 100),
          latencyMs: nowMs() - started,
        });
        return;
      }
      emitAiMatchUpdate({
        matchId,
        status: "ready",
        questionText: originalQuestion,
        candidates: modelCandidates,
        answer: "",
        receivedAt: nowMs(),
        latencyMs: nowMs() - started,
      });
      emitDebugLog("model_rerank_ready", {
        matchId,
        question: snippet(originalQuestion, 120),
        top: modelCandidates.map((item) => `#${item.id}(${item.score})`).join(","),
        latencyMs: nowMs() - started,
      });
    })
    .catch((error) => {
      emitDebugLog("model_rerank_error", {
        matchId,
        question: snippet(originalQuestion, 100),
        message: error.message,
        latencyMs: nowMs() - started,
      });
      emitLog({ message: `方舟候选重排跳过：${error.message}` });
    });

  confirmPromise
    .then(async (confirmed) => {
      if (!currentSession || requestSessionSeq !== arkEnhanceSeq) return;
      if (!confirmed?.questionText) {
        emitDebugLog("model_question_rejected", {
          matchId,
          original: snippet(originalQuestion, 100),
          latencyMs: nowMs() - started,
        });
        return;
      }

      const reviewedQuestion = confirmed.questionText;
      const confirmedCandidates = activeMatcher.search(reviewedQuestion, 10);
      emitModelQuestionUpdate({
        matchId,
        questionText: reviewedQuestion,
        sourceText: confirmed.sourceText || sourceText,
        confidence: confirmed.confidence,
        reason: confirmed.reason,
        candidates: confirmedCandidates,
        receivedAt: nowMs(),
      });
      emitDebugLog("model_question_confirmed", {
        matchId,
        original: snippet(originalQuestion, 100),
        confirmed: snippet(reviewedQuestion, 100),
        confidence: confirmed.confidence,
        latencyMs: nowMs() - started,
      });
      maybeGenerateFallbackAnswer({
        matchId,
        questionText: reviewedQuestion,
        candidates: confirmedCandidates,
        reason: confirmedCandidates.length ? "confirmed_answer_guided" : "confirmed_no_match",
      });

      if (normalize(reviewedQuestion) === normalize(originalQuestion)) return;
      const confirmedPool = activeMatcher.search(reviewedQuestion, 5);
      const modelCandidates = await rerankCandidateIdsWithArk({
        question: reviewedQuestion,
        candidates: confirmedPool.length ? confirmedPool : originalPool,
        timeoutMs: 2200,
      });
      if (!currentSession || requestSessionSeq !== arkEnhanceSeq || !modelCandidates?.length) return;
      emitAiMatchUpdate({
        matchId,
        status: "ready",
        questionText: reviewedQuestion,
        candidates: modelCandidates,
        answer: "",
        receivedAt: nowMs(),
        latencyMs: nowMs() - started,
      });
      emitDebugLog("model_rerank_ready_after_confirm", {
        matchId,
        question: snippet(reviewedQuestion, 120),
        top: modelCandidates.map((item) => `#${item.id}(${item.score})`).join(","),
        latencyMs: nowMs() - started,
      });
    })
    .catch((error) => {
      emitDebugLog("model_question_error", {
        matchId,
        question: snippet(originalQuestion, 100),
        message: error.message,
        latencyMs: nowMs() - started,
      });
      emitLog({ message: `方舟问题确认跳过：${error.message}` });
    });
}

function emitMatchForQuestion({ inferred, receivedAt, transcript, definite, enhanced = false }) {
  const activeMatcher = ensureMatcher();
  const event = activeMatcher.searchWithEvent(inferred.questionText, 10);
  const matchId = createMatchId(receivedAt, definite, enhanced);
  const rerankPool = activeMatcher.search(inferred.questionText, 10);
  event.matchId = matchId;
  event.definite = definite;
  event.receivedAt = receivedAt;
  event.sourceText = inferred.sourceText;
  event.confidence = inferred.confidence;
  event.reason = inferred.reason;
  event.provisional = !definite;
  event.enhanced = enhanced;
  appendJsonl("matches.jsonl", event);
  emit("match_candidates", event);
  emitDebugLog("question_emit", {
    definite,
    enhanced,
    question: snippet(inferred.questionText, 120),
    source: snippet(inferred.sourceText, 160),
    confidence: inferred.confidence,
    reason: inferred.reason,
    top: event.candidates[0] ? `#${event.candidates[0].id} ${snippet(event.candidates[0].question, 80)} (${event.candidates[0].score}%)` : "none",
  });
  scheduleModelMatchReview({
    matchId,
    inferred,
    event,
    rerankPool,
    transcript,
    skipQuestionConfirm: enhanced,
  });
  if (definite) {
    maybeGenerateFallbackAnswer({
      matchId,
      questionText: inferred.questionText,
      candidates: event.candidates,
      reason: event.candidates.length ? "local_answer_guided" : "local_no_match",
    });
  }
  emitLog({
    message: enhanced
      ? "方舟小模型已增强问题推断并触发匹配"
      : definite
        ? "稳定分句已推断面试官问题并触发题库匹配"
        : "流式中间结果已抢跑推断问题并触发匹配",
    asrLatencyMs: transcript.asrLatencyMs,
    matchLatencyMs: event.latencyMs,
  });
}

function maybeEnhanceQuestionWithArk({ segments, receivedAt, transcript, definite, localConfidence = 0 }) {
  if (!shouldCallArkEnhancer(receivedAt)) return;
  const sourceText = (segments ?? [])
    .map((item) => (typeof item?.rewrittenText === "string" ? item.rewrittenText : item?.text || item))
    .map((text) => String(text ?? "").trim())
    .filter(Boolean)
    .join("。");
  if (sourceText.length < 6) return;

  const requestSeq = ++arkEnhanceSeq;
  emitDebugLog("ark_request", {
    definite,
    localConfidence,
    source: snippet(sourceText, 180),
  });
  inferQuestionWithArk({ text: sourceText })
    .then((inferred) => {
      if (!inferred || sessionPaused || !currentSession || requestSeq < arkEnhanceSeq - 2) {
        emitDebugLog("ark_skip", { reason: "stale_or_empty", definite });
        return;
      }
      if (inferred.confidence < Math.max(0.66, localConfidence)) {
        emitDebugLog("ark_skip", { reason: "low_confidence", question: snippet(inferred.questionText), confidence: inferred.confidence, localConfidence });
        return;
      }
      if (definite && rememberQuestionKey(inferred.questionText)) {
        emitDebugLog("ark_skip", { reason: "duplicate_final", question: snippet(inferred.questionText) });
        return;
      }
      if (!definite && !shouldEmitPartialQuestion(inferred.questionText, nowMs())) {
        emitDebugLog("ark_skip", { reason: "partial_throttle", question: snippet(inferred.questionText) });
        return;
      }
      emitMatchForQuestion({ inferred, receivedAt: nowMs(), transcript, definite, enhanced: true });
    })
    .catch((error) => {
      emitLog({ message: `方舟问题抽取跳过：${error.message}` });
    });
}

function handleTranscript(transcript) {
  if (sessionPaused) return;
  const receivedAt = nowMs();
  const rewrittenText = rewriteTranscriptText(transcript.text);
  const asrEvent = {
    text: transcript.text,
    rewrittenText,
    definite: transcript.definite,
    utteranceStartMs: transcript.startMs,
    utteranceEndMs: transcript.endMs,
    receivedAt,
  };
  emit(transcript.definite ? "asr_final" : "asr_partial", asrEvent);
  appendJsonl("transcript.jsonl", asrEvent);
  if (transcript.definite) {
    emitDebugLog("asr_final", {
      raw: snippet(transcript.text, 180),
      rewritten: snippet(rewrittenText, 180),
      asrLatencyMs: transcript.asrLatencyMs,
    });
  }

  if (transcript.definite) {
    recentTranscriptSegments = [...recentTranscriptSegments, asrEvent].slice(-6);
    recentPartialSegments = [];
    const currentQuestionish = hasQuestionIntent(asrEvent);
    if (currentQuestionish) {
      pendingQuestionSegments = [...pendingQuestionSegments, asrEvent].slice(-4);
    } else if (rewrittenText) {
      pendingQuestionSegments = [];
    }

    const inferredList = currentQuestionish ? inferQuestionsFromSegments(pendingQuestionSegments) : [];
    emitDebugLog("question_infer_final", {
      count: inferredList.length,
      questions: inferredList.map((item) => snippet(item.questionText, 100)),
      pending: pendingQuestionSegments.map((item) => snippet(item.rewrittenText || item.text, 80)),
    });
    if (!inferredList.length) {
      if (currentQuestionish) {
        maybeEnhanceQuestionWithArk({ segments: pendingQuestionSegments, receivedAt, transcript, definite: true });
      }
      return;
    }
    const maxLocalConfidence = Math.max(...inferredList.map((item) => item.confidence));
    if (maxLocalConfidence < 0.74) {
      maybeEnhanceQuestionWithArk({
        segments: pendingQuestionSegments,
        receivedAt,
        transcript,
        definite: true,
        localConfidence: maxLocalConfidence,
      });
    }
    for (const inferred of inferredList) {
      if (isIncompleteQuestion(inferred.questionText)) {
        emitDebugLog("question_skip", { reason: "incomplete_final", question: snippet(inferred.questionText) });
        continue;
      }
      if (rememberQuestionKey(inferred.questionText)) {
        emitDebugLog("question_skip", { reason: "duplicate_final", question: snippet(inferred.questionText) });
        continue;
      }
      emitMatchForQuestion({ inferred, receivedAt, transcript, definite: true });
    }
    return;
  }

  recentPartialSegments = [...pendingQuestionSegments.slice(-2), asrEvent].slice(-3);
  const inferredList = inferQuestionsFromSegments(recentPartialSegments);
  const inferred = inferredList.at(-1) ?? null;
  if (!inferred) {
    maybeEnhanceQuestionWithArk({ segments: recentPartialSegments, receivedAt, transcript, definite: false });
    return;
  }
  if (inferred.confidence < 0.76) {
    maybeEnhanceQuestionWithArk({
      segments: recentPartialSegments,
      receivedAt,
      transcript,
      definite: false,
      localConfidence: inferred.confidence,
    });
  }
  if (inferred.confidence < 0.58) {
    emitDebugLog("question_skip", { reason: "partial_low_confidence", question: snippet(inferred.questionText), confidence: inferred.confidence });
    return;
  }
  if (isIncompleteQuestion(inferred.questionText)) {
    emitDebugLog("question_skip", { reason: "partial_incomplete", question: snippet(inferred.questionText), confidence: inferred.confidence });
    return;
  }
  if (!shouldEmitPartialQuestion(inferred.questionText, receivedAt)) {
    emitDebugLog("question_skip", { reason: "partial_throttle", question: snippet(inferred.questionText), confidence: inferred.confidence });
    return;
  }
  emitDebugLog("question_infer_partial", {
    question: snippet(inferred.questionText, 110),
    confidence: inferred.confidence,
    source: snippet(inferred.sourceText, 160),
  });
  emitMatchForQuestion({ inferred, receivedAt, transcript, definite: false });
}

function closeCurrentSession() {
  if (currentSession?.asr) currentSession.asr.close();
  if (currentSession?.audioFile) currentSession.audioFile.end();
  currentSession = null;
  sessionPaused = false;
  recentTranscriptSegments = [];
  recentPartialSegments = [];
  pendingQuestionSegments = [];
  recentQuestionKeys = [];
  lastPartialQuestion = null;
  lastPartialMatchedAt = 0;
  arkEnhanceSeq += 1;
  lastArkEnhanceAt = 0;
  fallbackAnswerMatchIds = new Set();
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
    backgroundColor: "#f5f9ff",
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

async function getAudioSources() {
  return [
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
  ];
}

function healthItem(state, label, message, extra = {}) {
  return { state, label, message, ...extra };
}

async function buildHealthStatus() {
  const checkedAt = nowMs();
  const items = {};

  try {
    const sources = await getAudioSources();
    const available = sources.filter((source) => source.available);
    items.audio = available.length
      ? healthItem("ok", "音频", `检测到 ${available.length} 个可用采集源`)
      : healthItem("error", "音频", "未检测到可用音频采集源");
  } catch (error) {
    items.audio = healthItem("error", "音频", `音频源检测失败：${error.message}`);
  }

  try {
    const env = getEnvValue(["DOUBAO_API_KEY", "VOLCENGINE_ASR_API_KEY"]);
    if (!env.value) {
      items.asr = healthItem("error", "ASR", "未读取到 DOUBAO_API_KEY 或 VOLCENGINE_ASR_API_KEY");
    } else if (env.value.length < 16) {
      items.asr = healthItem("error", "ASR", `${env.name} 长度过短`);
    } else {
      items.asr = healthItem("ok", "ASR", `已读取 ${env.name}，长度 ${env.value.length}`);
    }
  } catch (error) {
    items.asr = healthItem("error", "ASR", `ASR Key 检测失败：${error.message}`);
  }

  try {
    const activeMatcher = ensureMatcher();
    items.bank = questionBank.length
      ? healthItem("ok", "题库", `已加载 ${questionBank.length} 道题`)
      : healthItem("error", "题库", "题库为空");
    if (!activeMatcher) {
      items.bank = healthItem("error", "题库", "题库 matcher 未初始化");
    }
  } catch (error) {
    items.bank = healthItem("error", "题库", `题库加载失败：${error.message}`);
  }

  try {
    const resume = loadResumeText();
    items.resume = resume.length
      ? healthItem("ok", "简历", `已加载简历 ${resume.length} 字`)
      : healthItem("warning", "简历", "未找到 resources/jianli.md，兜底答案会缺少简历事实");
  } catch (error) {
    items.resume = healthItem("warning", "简历", `简历读取失败：${error.message}`);
  }

  const arkStarted = nowMs();
  try {
    const config = resolveArkConfig();
    const model = config.fastModel || config.model;
    if (!config.enabled) {
      items.ark = healthItem("warning", "AI", "ARK_QUESTION_ENHANCER=0，小模型增强已关闭", { model });
    } else if (!config.apiKey) {
      items.ark = healthItem("error", "AI", "未读取到 ARK_API_KEY / VOLCENGINE_ARK_API_KEY / DOUBAO_ARK_API_KEY", { model });
    } else {
      const result = await callArkChat({
        model,
        maxTokens: 4,
        timeoutMs: 3000,
        messages: [
          { role: "system", content: "只输出OK。" },
          { role: "user", content: "ping" },
        ],
      });
      const latencyMs = nowMs() - arkStarted;
      items.ark = result
        ? healthItem("ok", "AI", `方舟可用 · ${model} · ${latencyMs}ms`, { latencyMs, model })
        : healthItem("error", "AI", `方舟未返回内容 · ${model}`, { latencyMs, model });
    }
  } catch (error) {
    items.ark = healthItem("error", "AI", `方舟检测失败：${error.message}`, {
      latencyMs: nowMs() - arkStarted,
      model: resolveArkConfig().fastModel || resolveArkConfig().model,
    });
  }

  const payload = {
    checkedAt,
    items,
    logDir: projectLogDir(),
  };
  emitDebugLog("health_check", {
    items: Object.fromEntries(Object.entries(items).map(([key, item]) => [key, {
      state: item.state,
      message: item.message,
      latencyMs: item.latencyMs,
      model: item.model,
    }])),
    logDir: payload.logDir,
  });
  appendModelLog("health_check", {
    ark: items.ark,
    asr: { state: items.asr?.state, message: items.asr?.message },
    bank: { state: items.bank?.state, message: items.bank?.message },
    resume: { state: items.resume?.state, message: items.resume?.message },
  });
  return payload;
}

ipcMain.handle("list_audio_sources", async () => getAudioSources());

ipcMain.handle("get_health_status", async () => {
  const payload = await buildHealthStatus();
  emit("health_status", payload);
  return payload;
});

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
  sessionPaused = false;
  recentTranscriptSegments = [];
  recentPartialSegments = [];
  pendingQuestionSegments = [];
  recentQuestionKeys = [];
  lastPartialQuestion = null;
  lastPartialMatchedAt = 0;
  arkEnhanceSeq += 1;
  lastArkEnhanceAt = 0;

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
  emitAudioStatus({ state: "stopped", deviceName: undefined, volume: 0, message: "面试已结束" });
});

ipcMain.handle("pause_session", async () => {
  sessionPaused = true;
  emitAudioStatus({ state: "paused", deviceName: "Electron loopback", volume: 0, message: "面试已暂停" });
});

ipcMain.handle("resume_session", async () => {
  sessionPaused = false;
  emitAudioStatus({ state: "capturing", deviceName: "Electron loopback", volume: 0, message: "面试已继续，正在采集系统声音" });
});

ipcMain.handle("search_questions", async (_event, query) => ensureMatcher().search(String(query ?? "")));

ipcMain.handle("audio_capture_error", async (_event, message) => {
  emitAudioStatus({ state: "error", deviceName: "Electron loopback", volume: undefined, message: `系统声音捕获失败：${message}` });
  emitLog({ message: `系统声音捕获失败：${message}` });
});

ipcMain.on("audio_chunk", (_event, payload) => {
  if (!currentSession?.asr || sessionPaused) return;
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
