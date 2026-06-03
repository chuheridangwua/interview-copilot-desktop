const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  callArkChat,
  confirmManualQuestionWithArk,
  confirmQuestionWithArk,
  decideQuestionMergeWithArk,
  generateFallbackAnswerStreamWithArk,
  inferQuestionWithArk,
  readWindowsEnv,
  rerankCandidateIdsWithArk,
  resolveArkConfig,
} = require("./backend/arkQuestionEnhancer.cjs");
const { DoubaoAsrSession } = require("./backend/doubaoAsr.cjs");
const { InterviewQuestionEngine } = require("./backend/interviewQuestionEngine.cjs");
const {
  Matcher,
  inferQuestionsFromSegments,
  loadQuestionBank,
  normalize,
  parseQuestionBank,
  rewriteTranscriptText,
} = require("./backend/questionMatcher.cjs");

const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";
const COMPANY_QUESTION_ID_OFFSET = 10000;
const QUESTION_CONTEXT_WINDOW_MS = 2 * 60 * 1000;
const QUESTION_CONTEXT_MAX_SEGMENTS = 80;
const QUESTION_CONTEXT_MAX_CHARS = 2400;
const PARTIAL_QUESTION_MIN_CONFIDENCE = 0.72;
const MANUAL_QUESTION_SUPPRESSION_TAIL_MS = 1200;
const isDev = Boolean(process.env.ELECTRON_DEV || process.env.ELECTRON_RENDERER_URL);

let mainWindow = null;
let baseQuestionBank = [];
const matcherBundleCache = new Map();
let resumeText = "";
let currentSession = null;
let questionEngine = null;
let sessionPaused = false;
let manualQuestionMarking = false;
let manualQuestionMarkingStartedAt = 0;
let manualQuestionSuppressionWindows = [];
let removedQuestionMatchIds = new Set();
let recentTranscriptSegments = [];
let recentPartialSegments = [];
let pendingQuestionSegments = [];
let conversationContextSegments = [];
let recentQuestionKeys = [];
let recentStableQuestions = [];
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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalDateTimeForFilename(date = new Date()) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-") + "_" + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join("-");
}

function formatLocalDateTimeForText(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return `${[
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-")} ${[
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join(":")}`;
}

function safeFilenamePart(value, fallback = "interview") {
  const text = String(value ?? "").trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return text || fallback;
}

function projectLogDir() {
  return path.join(process.cwd(), "logs");
}

function projectSessionsDir() {
  return path.join(process.cwd(), "sessions");
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

function emitMicrophoneAudioStatus(payload) {
  emit("microphone_audio_status", payload);
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

function shortHash(value, length = 8) {
  return crypto.createHash("sha1").update(String(value ?? "")).digest("hex").slice(0, length);
}

function addManualQuestionSuppressionWindow(startedAt, endedAt, reason = "") {
  const start = Number(startedAt || 0);
  const end = Number(endedAt || nowMs());
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) return;
  const window = {
    startedAt: Math.min(start, end),
    endedAt: Math.max(start, end) + MANUAL_QUESTION_SUPPRESSION_TAIL_MS,
    reason,
  };
  const current = nowMs();
  manualQuestionSuppressionWindows = [...manualQuestionSuppressionWindows, window]
    .filter((item) => current - Number(item.endedAt || current) <= 5 * 60 * 1000)
    .slice(-20);
}

function setManualQuestionMarkingState(active) {
  const shouldActivate = Boolean(active) && Boolean(currentSession) && !sessionPaused;
  if (shouldActivate) {
    manualQuestionMarking = true;
    manualQuestionMarkingStartedAt = nowMs();
    return true;
  }
  if (manualQuestionMarkingStartedAt) {
    addManualQuestionSuppressionWindow(manualQuestionMarkingStartedAt, nowMs(), "manual_marker_stopped");
  }
  manualQuestionMarking = false;
  manualQuestionMarkingStartedAt = 0;
  return false;
}

function resetManualQuestionMarkingState() {
  manualQuestionMarking = false;
  manualQuestionMarkingStartedAt = 0;
  manualQuestionSuppressionWindows = [];
}

function isWithinManualQuestionSuppressionWindow(receivedAt) {
  const time = Number(receivedAt || 0);
  const current = nowMs();
  manualQuestionSuppressionWindows = manualQuestionSuppressionWindows
    .filter((item) => current - Number(item.endedAt || current) <= 5 * 60 * 1000);
  if (!Number.isFinite(time) || time <= 0) return false;
  return manualQuestionSuppressionWindows.some((item) => (
    time >= Number(item.startedAt || 0) && time <= Number(item.endedAt || 0)
  ));
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

function normalizeCompanyId(value) {
  return String(value ?? "").trim();
}

function resourceRootCandidates() {
  const candidates = [
    path.join(app.getAppPath(), "resources"),
    path.join(process.cwd(), "resources"),
    path.join(process.resourcesPath || "", "resources"),
    process.resourcesPath || "",
  ];
  const seen = new Set();
  return candidates.filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return fs.existsSync(item);
  });
}

function resolveResourceFile(filename) {
  return resourceRootCandidates()
    .map((root) => path.join(root, filename))
    .find((item) => item && fs.existsSync(item));
}

function resolveCompanyRoots() {
  return resourceRootCandidates()
    .map((root) => path.join(root, "company"))
    .filter((item) => fs.existsSync(item));
}

function readTextFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function loadBaseQuestionBank() {
  if (!baseQuestionBank.length) {
    baseQuestionBank = loadQuestionBank(app.getAppPath());
    console.log(`[interview-copilot][electron] base questions loaded: ${baseQuestionBank.length}`);
  }
  return baseQuestionBank;
}

function listCompanies() {
  const companyById = new Map();
  for (const root of resolveCompanyRoots()) {
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const entry of entries) {
      const id = entry.name;
      if (companyById.has(id)) continue;
      const dir = path.join(root, id);
      const introductionPath = path.join(dir, "Introduction.md");
      const questionPath = path.join(dir, "question.md");
      const hasIntroduction = fs.existsSync(introductionPath);
      const hasQuestionBank = fs.existsSync(questionPath);
      if (!hasIntroduction && !hasQuestionBank) continue;
      const questionCount = hasQuestionBank
        ? parseQuestionBank(readTextFileIfExists(questionPath), {
          source: "company",
          sourceLabel: id,
          idOffset: COMPANY_QUESTION_ID_OFFSET,
        }).length
        : 0;
      companyById.set(id, {
        id,
        name: id,
        hasIntroduction,
        hasQuestionBank,
        questionCount,
        dir,
        introductionPath,
        questionPath,
      });
    }
  }
  return [...companyById.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function publicCompanyOption(company) {
  return {
    id: company.id,
    name: company.name,
    hasIntroduction: company.hasIntroduction,
    hasQuestionBank: company.hasQuestionBank,
    questionCount: company.questionCount,
  };
}

function loadCompanyContext(companyId, { strict = false } = {}) {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  if (!normalizedCompanyId) return null;
  const company = listCompanies().find((item) => item.id === normalizedCompanyId);
  if (!company) {
    throw new Error(`未找到面试公司：${normalizedCompanyId}`);
  }

  const introduction = company.hasIntroduction ? readTextFileIfExists(company.introductionPath) : "";
  const companyItems = company.hasQuestionBank
    ? parseQuestionBank(readTextFileIfExists(company.questionPath), {
      source: "company",
      sourceLabel: company.name,
      idOffset: COMPANY_QUESTION_ID_OFFSET,
    })
    : [];

  if (strict && company.hasQuestionBank && companyItems.length === 0) {
    throw new Error(`公司题库为空或格式不正确：resources/company/${company.id}/question.md`);
  }
  if (strict && !introduction.trim() && companyItems.length === 0) {
    throw new Error(`公司资料为空：resources/company/${company.id}`);
  }

  return {
    id: company.id,
    name: company.name,
    introduction,
    questionCount: companyItems.length,
    hasQuestionBank: company.hasQuestionBank,
    hasIntroduction: company.hasIntroduction,
    items: companyItems,
  };
}

function getMatcherBundle(companyId = "") {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  const cacheKey = normalizedCompanyId || "__base__";
  const cached = matcherBundleCache.get(cacheKey);
  if (cached) return cached;

  const baseItems = loadBaseQuestionBank();
  const companyContext = normalizedCompanyId ? loadCompanyContext(normalizedCompanyId, { strict: true }) : null;
  const items = companyContext ? [...baseItems, ...companyContext.items] : [...baseItems];
  const bundle = {
    matcher: new Matcher(items),
    items,
    baseCount: baseItems.length,
    companyCount: companyContext?.items.length ?? 0,
    companyContext,
  };
  matcherBundleCache.set(cacheKey, bundle);
  return bundle;
}

function activeMatcherBundle() {
  return currentSession?.matcherBundle || getMatcherBundle("");
}

function createQuestionEngine() {
  return new InterviewQuestionEngine({
    confirmQuestion: ({ sourceText, localQuestion, previousQuestions, candidateContext }) => confirmQuestionWithArk({
      sourceText,
      localQuestion,
      previousQuestions,
      candidateContext,
      timeoutMs: 2800,
    }),
    mergeDecider: ({ question, existingQuestion, sourceText, existingSourceText, candidateContext, questionType, domainAnchors, existingQuestionType, existingDomainAnchors }) => decideQuestionMergeWithArk({
      question,
      existingQuestion,
      sourceText,
      existingSourceText,
      candidateContext,
      questionType,
      domainAnchors,
      existingQuestionType,
      existingDomainAnchors,
      timeoutMs: 1800,
    }),
  });
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

function createSessionDir(sessionId, startedAt = new Date()) {
  const dirName = `${formatLocalDateTimeForFilename(startedAt)}_${safeFilenamePart(sessionId, "session")}`;
  const dir = path.join(projectSessionsDir(), dirName);
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

function appendSessionJsonl(session, filename, payload) {
  if (!session?.sessionDir) return;
  try {
    fs.appendFileSync(path.join(session.sessionDir, filename), `${JSON.stringify(payload)}\n`);
  } catch (error) {
    console.warn("[interview-copilot][electron] archive jsonl write failed", error?.message || error);
  }
}

function writeSessionTextFile(session, filename, content) {
  if (!session?.sessionDir) return;
  try {
    fs.writeFileSync(path.join(session.sessionDir, filename), content);
  } catch (error) {
    console.warn("[interview-copilot][electron] archive text write failed", filename, error?.message || error);
  }
}

function writeSessionJsonFile(session, filename, payload) {
  writeSessionTextFile(session, filename, `${JSON.stringify(payload, null, 2)}\n`);
}

function compactArchivedCandidate(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    source: candidate.source || "base",
    sourceLabel: candidate.sourceLabel || "通用",
    sourceQuestionId: candidate.sourceQuestionId,
    question: candidate.question,
    score: candidate.score,
    answerLogic: candidate.answerLogic || "",
    answerDetail: candidate.answerDetail || candidate.answer || "",
    answer: candidate.answer || "",
    aiReason: candidate.aiReason || "",
  };
}

function createSessionArchive({ sessionId, startedAt, settings, matcherBundle }) {
  return {
    sessionId,
    startedAt: startedAt.toISOString(),
    startedAtLocal: formatLocalDateTimeForText(startedAt),
    settings,
    company: matcherBundle?.companyContext
      ? {
        id: matcherBundle.companyContext.id,
        name: matcherBundle.companyContext.name,
        questionCount: matcherBundle.companyCount,
      }
      : null,
    systemTranscripts: [],
    microphoneTranscripts: [],
    combinedTranscripts: [],
    questionsByMatchId: new Map(),
  };
}

function transcriptLine(item) {
  return `[${formatLocalDateTimeForText(item.receivedAt)}] ${item.speaker}：${item.text}`;
}

function writeTranscriptSnapshots(session) {
  const archive = session?.archive;
  if (!archive) return;
  writeSessionTextFile(session, "system-transcript.txt", archive.systemTranscripts.map(transcriptLine).join("\n") + (archive.systemTranscripts.length ? "\n" : ""));
  writeSessionJsonFile(session, "system-transcript.json", archive.systemTranscripts);
  writeSessionTextFile(session, "microphone-transcript.txt", archive.microphoneTranscripts.map(transcriptLine).join("\n") + (archive.microphoneTranscripts.length ? "\n" : ""));
  writeSessionJsonFile(session, "microphone-transcript.json", archive.microphoneTranscripts);
  const combined = [...archive.combinedTranscripts].sort((a, b) => Number(a.receivedAt) - Number(b.receivedAt));
  writeSessionTextFile(session, "combined-transcript.txt", combined.map(transcriptLine).join("\n") + (combined.length ? "\n" : ""));
  writeSessionJsonFile(session, "combined-transcript.json", combined);
}

function rememberArchivedTranscript({ role, speaker, text, rawText, rewrittenText, receivedAt, startMs, endMs }) {
  const session = currentSession;
  if (!session?.archive) return;
  const cleanedText = String(text ?? "").trim();
  if (!cleanedText) return;
  const record = {
    role,
    speaker,
    text: cleanedText,
    rawText: rawText || cleanedText,
    rewrittenText: rewrittenText || "",
    receivedAt,
    receivedAtLocal: formatLocalDateTimeForText(receivedAt),
    utteranceStartMs: startMs,
    utteranceEndMs: endMs,
  };
  if (role === "interviewer") {
    session.archive.systemTranscripts.push(record);
    appendSessionJsonl(session, "system-transcript.jsonl", record);
  } else {
    session.archive.microphoneTranscripts.push(record);
    appendSessionJsonl(session, "microphone-transcript.jsonl", record);
  }
  session.archive.combinedTranscripts.push(record);
  appendSessionJsonl(session, "combined-transcript.jsonl", record);
  writeTranscriptSnapshots(session);
}

function sortedArchivedQuestions(session) {
  return [...(session?.archive?.questionsByMatchId?.values?.() ?? [])]
    .sort((a, b) => Number(a.receivedAt || a.updatedAt || 0) - Number(b.receivedAt || b.updatedAt || 0));
}

function questionMarkdownBlock(question, index) {
  const candidates = question.candidates || [];
  const topCandidate = candidates[0] || null;
  const aiAnswer = String(question.aiAnswer || "").trim();
  const displayQuestionText = question.confirmedQuestionText || question.questionText || question.localQuestionText || "未命名问题";
  return [
    `## ${index + 1}. ${displayQuestionText}`,
    "",
    `- matchId: ${question.matchId}`,
    `- 时间: ${formatLocalDateTimeForText(question.receivedAt || question.updatedAt)}`,
    `- 状态: ${question.provisional ? "临时" : "稳定"}${question.enhanced ? " · 方舟增强" : ""}`,
    question.source === "manual_marker" ? `- 来源: 手动标记` : "",
    question.manualStartedAt && question.manualEndedAt ? `- 标记区间: ${formatLocalDateTimeForText(question.manualStartedAt)} - ${formatLocalDateTimeForText(question.manualEndedAt)}` : "",
    question.questionType ? `- 类型: ${question.questionType}${question.topicId ? ` · ${question.topicId}` : ""}` : "",
    question.localQuestionText && question.localQuestionText !== displayQuestionText ? `- 本地问题: ${question.localQuestionText}` : "",
    question.mergedFrom?.length ? `- 合并来源: ${question.mergedFrom.length} 条` : "",
    question.absorbedFrom?.length ? `- 吸收追问: ${question.absorbedFrom.length} 条` : "",
    question.reason ? `- 推断原因: ${question.reason}` : "",
    question.sourceText ? `- ASR 原文: ${question.sourceText}` : "",
    "",
    "### 题库答案",
    topCandidate
      ? [
        `- 命中题: [${topCandidate.sourceLabel || "通用"}] ${topCandidate.question}`,
        `- 分数: ${topCandidate.score}%`,
        topCandidate.sourceQuestionId ? `- 公司原题编号: ${topCandidate.sourceQuestionId}` : "",
        "",
        "回答逻辑：",
        topCandidate.answerLogic || "未提供",
        "",
        "具体内容：",
        topCandidate.answerDetail || topCandidate.answer || "未提供",
      ].filter(Boolean).join("\n")
      : "暂无题库候选。",
    "",
    candidates.length > 1 ? [
      "### 其他候选",
      ...candidates.slice(1).map((candidate, candidateIndex) => `${candidateIndex + 2}. [${candidate.sourceLabel || "通用"}] ${candidate.question}（${candidate.score}%）`),
      "",
    ].join("\n") : "",
    "### AI 答案",
    aiAnswer || question.aiAnswerError || "暂未生成。",
    "",
  ].filter((line) => line !== "").join("\n");
}

function writeQuestionSnapshots(session) {
  const questions = sortedArchivedQuestions(session);
  writeSessionJsonFile(session, "question-list.json", questions.map((question, index) => ({
    index: index + 1,
    matchId: question.matchId,
    questionText: question.confirmedQuestionText || question.questionText,
    localQuestionText: question.localQuestionText,
    confirmedQuestionText: question.confirmedQuestionText,
    sourceText: question.sourceText,
    confidence: question.confidence,
    reason: question.reason,
    questionType: question.questionType,
    topicId: question.topicId,
    domainAnchors: question.domainAnchors || [],
    mergedFrom: question.mergedFrom || [],
    absorbedFrom: question.absorbedFrom || [],
    evidenceTerms: question.evidenceTerms || [],
    mergeReason: question.mergeReason || "",
    source: question.source || "",
    manualStartedAt: question.manualStartedAt,
    manualEndedAt: question.manualEndedAt,
    manualSegments: question.manualSegments || [],
    provisional: question.provisional,
    enhanced: question.enhanced,
    receivedAt: question.receivedAt,
    receivedAtLocal: formatLocalDateTimeForText(question.receivedAt || question.updatedAt),
  })));
  writeSessionTextFile(session, "question-list.txt", questions.map((question, index) => (
    `${index + 1}. [${formatLocalDateTimeForText(question.receivedAt || question.updatedAt)}] ${question.confirmedQuestionText || question.questionText}`
  )).join("\n") + (questions.length ? "\n" : ""));
  writeSessionJsonFile(session, "question-answers.json", questions);
  writeSessionTextFile(session, "question-answers.md", [
    "# 面试问题、题库答案与 AI 答案",
    "",
    `- 面试ID: ${session.sessionId}`,
    `- 开始时间: ${session.archive?.startedAtLocal || ""}`,
    `- 公司: ${session.archive?.company?.name || "无公司"}`,
    "",
    ...questions.map(questionMarkdownBlock),
  ].join("\n"));
}

function upsertArchivedQuestion(matchId, updater) {
  const session = currentSession;
  if (!session?.archive || !matchId) return;
  if (removedQuestionMatchIds.has(matchId)) return;
  const existing = session.archive.questionsByMatchId.get(matchId) || {
    matchId,
    receivedAt: nowMs(),
    candidates: [],
    aiAnswer: "",
    aiAnswerStatus: "",
  };
  const updated = {
    ...existing,
    ...updater(existing),
    updatedAt: nowMs(),
  };
  session.archive.questionsByMatchId.set(matchId, updated);
  writeQuestionSnapshots(session);
}

function archiveMatchEvent(event) {
  const matchId = event?.matchId;
  if (!matchId) return;
  const candidates = (event.candidates || []).map(compactArchivedCandidate).filter(Boolean);
  const displayQuestionText = event.confirmedQuestionText || event.query;
  upsertArchivedQuestion(matchId, () => ({
    matchId,
    questionText: displayQuestionText,
    localQuestionText: event.localQuestionText || event.query,
    confirmedQuestionText: event.confirmedQuestionText || (event.definite && event.enhanced ? displayQuestionText : ""),
    sourceText: event.sourceText || event.query,
    confidence: event.confidence,
    reason: event.reason,
    questionType: event.questionType,
    topicId: event.topicId,
    domainAnchors: event.domainAnchors || [],
    mergedFrom: event.mergedFrom || [],
    absorbedFrom: event.absorbedFrom || [],
    evidenceTerms: event.evidenceTerms || [],
    mergeReason: event.mergeReason || "",
    source: event.source || "",
    manualStartedAt: event.manualStartedAt,
    manualEndedAt: event.manualEndedAt,
    manualSegments: event.manualSegments || [],
    provisional: Boolean(event.provisional),
    enhanced: Boolean(event.enhanced),
    receivedAt: event.receivedAt || nowMs(),
    candidates,
  }));
  appendJsonl("question-events.jsonl", { type: "match", ...event });
}

function archiveModelQuestionUpdate(payload) {
  const candidates = (payload.candidates || []).map(compactArchivedCandidate).filter(Boolean);
  upsertArchivedQuestion(payload.matchId, (existing) => ({
    questionText: payload.questionText || existing.questionText,
    localQuestionText: existing.localQuestionText || existing.questionText,
    confirmedQuestionText: payload.questionText,
    sourceText: payload.sourceText || existing.sourceText,
    confidence: payload.confidence ?? existing.confidence,
    reason: payload.reason || existing.reason,
    questionType: payload.questionType || existing.questionType,
    topicId: payload.topicId || existing.topicId,
    domainAnchors: payload.domainAnchors || existing.domainAnchors || [],
    mergedFrom: payload.mergedFrom || existing.mergedFrom || [],
    absorbedFrom: payload.absorbedFrom || existing.absorbedFrom || [],
    evidenceTerms: payload.evidenceTerms || existing.evidenceTerms || [],
    mergeReason: payload.mergeReason || existing.mergeReason || "",
    source: payload.source || existing.source || "",
    manualStartedAt: payload.manualStartedAt || existing.manualStartedAt,
    manualEndedAt: payload.manualEndedAt || existing.manualEndedAt,
    manualSegments: payload.manualSegments || existing.manualSegments || [],
    enhanced: true,
    candidates: candidates.length ? candidates : existing.candidates,
    receivedAt: existing.receivedAt || payload.receivedAt || nowMs(),
  }));
}

function archiveAiMatchUpdate(payload) {
  const candidates = (payload.candidates || []).map(compactArchivedCandidate).filter(Boolean);
  upsertArchivedQuestion(payload.matchId, (existing) => ({
    questionText: existing.confirmedQuestionText || existing.questionText || payload.questionText,
    aiRerankedCandidates: candidates,
    candidates: candidates.length ? candidates : existing.candidates,
    receivedAt: existing.receivedAt || payload.receivedAt || nowMs(),
  }));
}

function archiveModelAnswerUpdate(payload) {
  upsertArchivedQuestion(payload.matchId, (existing) => ({
    questionText: existing.confirmedQuestionText || existing.questionText || payload.questionText,
    aiAnswerStatus: payload.status,
    aiAnswer: typeof payload.answer === "string" ? payload.answer : existing.aiAnswer,
    aiAnswerError: payload.status === "error" ? payload.message : existing.aiAnswerError,
    aiAnswerReason: payload.reason || existing.aiAnswerReason,
    aiAnswerLatencyMs: payload.latencyMs,
    receivedAt: existing.receivedAt || payload.receivedAt || nowMs(),
  }));
}

function writeWavFromPcmFile(pcmPath, wavPath, { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
  if (!pcmPath || !fs.existsSync(pcmPath)) return false;
  const pcm = fs.readFileSync(pcmPath);
  if (!pcm.length) return false;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(wavPath, Buffer.concat([header, pcm]));
  return true;
}

function mixPcmFiles(systemPcmPath, microphonePcmPath, outputPcmPath) {
  const hasSystem = systemPcmPath && fs.existsSync(systemPcmPath) && fs.statSync(systemPcmPath).size > 0;
  const hasMicrophone = microphonePcmPath && fs.existsSync(microphonePcmPath) && fs.statSync(microphonePcmPath).size > 0;
  if (!hasSystem && !hasMicrophone) return false;
  if (hasSystem && !hasMicrophone) {
    fs.copyFileSync(systemPcmPath, outputPcmPath);
    return true;
  }
  if (!hasSystem && hasMicrophone) {
    fs.copyFileSync(microphonePcmPath, outputPcmPath);
    return true;
  }

  const systemPcm = fs.readFileSync(systemPcmPath);
  const microphonePcm = fs.readFileSync(microphonePcmPath);
  const sampleCount = Math.max(Math.floor(systemPcm.length / 2), Math.floor(microphonePcm.length / 2));
  const output = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const offset = index * 2;
    const left = offset + 1 < systemPcm.length ? systemPcm.readInt16LE(offset) : 0;
    const right = offset + 1 < microphonePcm.length ? microphonePcm.readInt16LE(offset) : 0;
    const mixed = Math.max(-32768, Math.min(32767, Math.round(left * 0.72 + right * 0.72)));
    output.writeInt16LE(mixed, offset);
  }
  fs.writeFileSync(outputPcmPath, output);
  return true;
}

function finalizeSessionArchive(session) {
  if (!session?.sessionDir || !session.archive) return;
  const endedAt = new Date();
  const systemPcmPath = path.join(session.sessionDir, "system-audio.pcm");
  const systemWavPath = path.join(session.sessionDir, "system-audio.wav");
  const microphonePcmPath = path.join(session.sessionDir, "microphone-audio.pcm");
  const microphoneWavPath = path.join(session.sessionDir, "microphone-audio.wav");
  const combinedPcmPath = path.join(session.sessionDir, "combined-audio.pcm");
  const combinedWavPath = path.join(session.sessionDir, "combined-audio.wav");

  let systemWav = false;
  let microphoneWav = false;
  let combinedWav = false;
  try {
    systemWav = writeWavFromPcmFile(systemPcmPath, systemWavPath);
    microphoneWav = writeWavFromPcmFile(microphonePcmPath, microphoneWavPath);
    const combinedPcm = mixPcmFiles(systemPcmPath, microphonePcmPath, combinedPcmPath);
    combinedWav = combinedPcm && writeWavFromPcmFile(combinedPcmPath, combinedWavPath);
  } catch (error) {
    console.warn("[interview-copilot][electron] archive audio finalize failed", error?.message || error);
  }

  writeTranscriptSnapshots(session);
  writeQuestionSnapshots(session);
  const questions = sortedArchivedQuestions(session);
  const summary = {
    sessionId: session.sessionId,
    startedAt: session.archive.startedAt,
    startedAtLocal: session.archive.startedAtLocal,
    endedAt: endedAt.toISOString(),
    endedAtLocal: formatLocalDateTimeForText(endedAt),
    sessionDir: session.sessionDir,
    company: session.archive.company,
    counts: {
      systemTranscript: session.archive.systemTranscripts.length,
      microphoneTranscript: session.archive.microphoneTranscripts.length,
      combinedTranscript: session.archive.combinedTranscripts.length,
      questions: questions.length,
      questionsWithAiAnswer: questions.filter((question) => String(question.aiAnswer || "").trim()).length,
    },
    files: {
      systemAudioPcm: fs.existsSync(systemPcmPath) ? "system-audio.pcm" : "",
      systemAudioWav: systemWav ? "system-audio.wav" : "",
      microphoneAudioPcm: fs.existsSync(microphonePcmPath) ? "microphone-audio.pcm" : "",
      microphoneAudioWav: microphoneWav ? "microphone-audio.wav" : "",
      combinedAudioPcm: fs.existsSync(combinedPcmPath) ? "combined-audio.pcm" : "",
      combinedAudioWav: combinedWav ? "combined-audio.wav" : "",
      systemTranscriptText: "system-transcript.txt",
      microphoneTranscriptText: "microphone-transcript.txt",
      combinedTranscriptText: "combined-transcript.txt",
      questionListText: "question-list.txt",
      questionAnswersMarkdown: "question-answers.md",
    },
  };
  writeSessionJsonFile(session, "session-summary.json", summary);
  writeSessionTextFile(session, "session-summary.md", [
    "# 面试会话归档",
    "",
    `- 面试ID: ${summary.sessionId}`,
    `- 开始时间: ${summary.startedAtLocal}`,
    `- 结束时间: ${summary.endedAtLocal}`,
    `- 公司: ${summary.company?.name || "无公司"}`,
    `- 系统转写: ${summary.counts.systemTranscript} 条`,
    `- 麦克风转写: ${summary.counts.microphoneTranscript} 条`,
    `- 问题数量: ${summary.counts.questions} 条`,
    `- AI 答案数量: ${summary.counts.questionsWithAiAnswer} 条`,
    "",
    "## 主要文件",
    "",
    ...Object.entries(summary.files).filter(([, file]) => file).map(([key, file]) => `- ${key}: ${file}`),
    "",
  ].join("\n"));
  emitLog({ message: `面试归档已保存：${session.sessionDir}` });
}

function rememberConversationContext(role, text, receivedAt = nowMs()) {
  const cleanedText = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!cleanedText) return;
  const normalizedRole = role === "candidate" ? "candidate" : "interviewer";
  const last = conversationContextSegments.at(-1);
  if (last?.role === normalizedRole && normalize(last.text) === normalize(cleanedText)) return;

  conversationContextSegments.push({
    role: normalizedRole,
    text: cleanedText,
    receivedAt,
  });
  conversationContextSegments = conversationContextSegments.slice(-80);
  while (
    conversationContextSegments.length > 12
    && conversationContextSegments.reduce((sum, item) => sum + item.text.length, 0) > 6000
  ) {
    conversationContextSegments.shift();
  }
}

function buildConversationContextText(maxChars = 2000) {
  const lines = conversationContextSegments
    .map((item) => {
      const label = item.role === "candidate" ? "我" : "面试官";
      return `${label}：${item.text}`;
    })
    .filter((line) => line.trim());
  const selected = [];
  let totalLength = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (selected.length > 0 && totalLength + line.length + 1 > maxChars) break;
    selected.push(line);
    totalLength += line.length + 1;
  }
  return selected.reverse().join("\n").slice(-maxChars);
}

function compactQuestionKey(questionText) {
  return normalize(questionText).replace(/\s+/g, "");
}

function pruneQuestionContextSegments(segments, receivedAt = nowMs()) {
  return (segments ?? [])
    .filter((item) => {
      const itemReceivedAt = Number(item?.receivedAt || receivedAt);
      return receivedAt - itemReceivedAt <= QUESTION_CONTEXT_WINDOW_MS;
    })
    .slice(-QUESTION_CONTEXT_MAX_SEGMENTS);
}

function inferLatestQuestionFromContext(segments) {
  const inferredList = inferQuestionsFromSegments(segments, {
    maxSegments: QUESTION_CONTEXT_MAX_SEGMENTS,
    maxChars: QUESTION_CONTEXT_MAX_CHARS,
  }) || [];
  return {
    inferredList,
    latest: inferredList.at(-1) ?? null,
  };
}

function buildQuestionSourceText(segments, maxChars = QUESTION_CONTEXT_MAX_CHARS) {
  const text = (segments ?? [])
    .map((item) => String(item?.rewrittenText || item?.text || "").trim())
    .filter(Boolean)
    .join("。");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function hasSoftQuestionCue(text) {
  return /(？|\?|为什么|怎么|如何|什么|哪些|哪种|能不能|可不可以|介绍|讲一下|说一下|聊一下|负责|角色|构成|设计|策略|标签|标注|评估|指标|效果|原因|流程|方案|风险|难点|挑战)/.test(String(text ?? ""));
}

function rememberStableQuestion(questionText, receivedAt = nowMs()) {
  const key = compactQuestionKey(questionText);
  if (!key) return;
  const existingIndex = recentStableQuestions.findIndex((item) => (
    item.key === key || key.includes(item.key) || item.key.includes(key)
  ));
  if (existingIndex >= 0) {
    const existing = recentStableQuestions[existingIndex];
    if (key.length >= existing.key.length) {
      recentStableQuestions[existingIndex] = { questionText, key, receivedAt };
    }
  } else {
    recentStableQuestions.push({ questionText, key, receivedAt });
  }
  recentStableQuestions = recentStableQuestions
    .filter((item) => receivedAt - Number(item.receivedAt || receivedAt) <= 10 * 60 * 1000)
    .slice(-12);
}

function recentStableQuestionTexts(maxCount = 5) {
  return recentStableQuestions.slice(-maxCount).map((item) => item.questionText);
}

function rememberQuestionKey(questionText) {
  const key = compactQuestionKey(questionText);
  if (!key) return false;
  for (const existingKey of recentQuestionKeys) {
    if (existingKey === key) return true;
    if (existingKey.includes(key) && key.length < existingKey.length * 0.9) return true;
  }
  recentQuestionKeys = recentQuestionKeys.filter((existingKey) => (
    !(key.includes(existingKey) && key.length > existingKey.length * 1.08)
  ));
  recentQuestionKeys.push(key);
  recentQuestionKeys = recentQuestionKeys.slice(-12);
  return false;
}

function shouldEmitPartialQuestion(questionText, receivedAt) {
  const key = compactQuestionKey(questionText);
  if (!key) return false;
  if (lastPartialQuestion?.key === key && receivedAt - lastPartialQuestion.receivedAt < 2000) return false;
  if (receivedAt - lastPartialMatchedAt < 1000) return false;
  lastPartialQuestion = { key, receivedAt };
  lastPartialMatchedAt = receivedAt;
  return true;
}

function shouldCallArkEnhancer(receivedAt, definite = false) {
  const minIntervalMs = definite ? 450 : 1200;
  if (receivedAt - lastArkEnhanceAt < minIntervalMs) return false;
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
  archiveModelQuestionUpdate(payload);
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
  archiveAiMatchUpdate(payload);
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
  archiveModelAnswerUpdate(payload);
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
  const companyContext = currentSession?.matcherBundle?.companyContext || null;
  const conversationContext = buildConversationContextText(2000);
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
    company: companyContext?.name || "",
    conversationContextLength: conversationContext.length,
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
    companyContext,
    conversationContext,
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
  const activeMatcher = activeMatcherBundle().matcher;
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
      previousQuestions: recentStableQuestionTexts(5),
      candidateContext: inferred.candidateContext || buildConversationContextText(2000),
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
        source: inferred.source || event.source || "",
        manualStartedAt: inferred.manualStartedAt,
        manualEndedAt: inferred.manualEndedAt,
        manualSegments: inferred.manualSegments || [],
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

function emitPreviewForQuestion({ inferred, receivedAt, transcript }) {
  const activeMatcher = activeMatcherBundle().matcher;
  const event = activeMatcher.searchWithEvent(inferred.questionText, 10);
  const matchId = inferred.questionId || "question-live";
  event.matchId = matchId;
  event.definite = false;
  event.receivedAt = receivedAt;
  event.sourceText = inferred.sourceText;
  event.localQuestionText = inferred.localQuestionText || inferred.questionText;
  event.confirmedQuestionText = inferred.confirmedQuestionText || "";
  event.confidence = inferred.confidence;
  event.reason = inferred.reason;
  event.questionType = inferred.questionType;
  event.topicId = inferred.topicId;
  event.domainAnchors = inferred.domainAnchors || [];
  event.mergedFrom = inferred.mergedFrom || [];
  event.absorbedFrom = inferred.absorbedFrom || [];
  event.evidenceTerms = inferred.evidenceTerms || [];
  event.mergeReason = inferred.mergeReason || "";
  event.source = inferred.source || "";
  event.manualStartedAt = inferred.manualStartedAt;
  event.manualEndedAt = inferred.manualEndedAt;
  event.manualSegments = inferred.manualSegments || [];
  event.provisional = true;
  event.enhanced = false;
  emit("match_candidates", event);
  emitDebugLog("question_emit", {
    definite: false,
    enhanced: false,
    question: snippet(inferred.questionText, 120),
    source: snippet(inferred.sourceText, 160),
    confidence: inferred.confidence,
    reason: inferred.reason,
    top: event.candidates[0] ? `#${event.candidates[0].id} ${snippet(event.candidates[0].question, 80)} (${event.candidates[0].score}%)` : "none",
  });
  emitLog({
    message: "流式中间结果已生成临时问题预览",
    asrLatencyMs: transcript.asrLatencyMs,
    matchLatencyMs: event.latencyMs,
  });
}

function emitMatchForQuestion({ inferred, receivedAt, transcript, definite, enhanced = false, matchId, skipQuestionConfirm = false }) {
  const activeMatcher = activeMatcherBundle().matcher;
  const event = activeMatcher.searchWithEvent(inferred.questionText, 10);
  const resolvedMatchId = matchId || inferred.questionId || createMatchId(receivedAt, definite, enhanced);
  const rerankPool = activeMatcher.search(inferred.questionText, 10);
  event.matchId = resolvedMatchId;
  event.definite = definite;
  event.receivedAt = receivedAt;
  event.sourceText = inferred.sourceText;
  event.localQuestionText = inferred.localQuestionText || inferred.questionText;
  event.confirmedQuestionText = inferred.confirmedQuestionText || (enhanced ? inferred.questionText : "");
  event.confidence = inferred.confidence;
  event.reason = inferred.reason;
  event.questionType = inferred.questionType;
  event.topicId = inferred.topicId;
  event.domainAnchors = inferred.domainAnchors || [];
  event.mergedFrom = inferred.mergedFrom || [];
  event.absorbedFrom = inferred.absorbedFrom || [];
  event.evidenceTerms = inferred.evidenceTerms || [];
  event.mergeReason = inferred.mergeReason || "";
  event.source = inferred.source || "";
  event.manualStartedAt = inferred.manualStartedAt;
  event.manualEndedAt = inferred.manualEndedAt;
  event.manualSegments = inferred.manualSegments || [];
  event.provisional = !definite;
  event.enhanced = enhanced;
  if (definite) {
    appendJsonl("matches.jsonl", event);
    archiveMatchEvent(event);
  }
  if (definite) rememberStableQuestion(inferred.questionText, receivedAt);
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
    matchId: resolvedMatchId,
    inferred,
    event,
    rerankPool,
    transcript,
    skipQuestionConfirm,
  });
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

function normalizeQuestionTextForManual(text) {
  const value = String(text ?? "").replace(/\s+/g, "").trim();
  if (!value) return "";
  return /[？?]$/.test(value) ? value : `${value}？`;
}

function normalizeManualSegments(segments = []) {
  const seen = new Set();
  return (Array.isArray(segments) ? segments : [])
    .map((item) => {
      const text = String(item?.rewrittenText || item?.text || "").trim();
      const receivedAt = Number(item?.receivedAt || 0);
      if (!text || !Number.isFinite(receivedAt)) return null;
      const key = `${receivedAt}:${compactQuestionKey(text)}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        text: String(item?.text || text).trim(),
        rewrittenText: text,
        receivedAt,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0));
}

function buildManualQuestionSource(payload = {}) {
  const segments = normalizeManualSegments(payload.segments);
  const explicitSourceText = String(payload.sourceText || "").trim();
  const segmentText = segments
    .map((item) => item.rewrittenText || item.text)
    .filter(Boolean)
    .join("。")
    .replace(/。+/g, "。")
    .trim();
  const sourceText = (explicitSourceText || segmentText).replace(/\s+/g, " ").trim();
  return { sourceText, segments };
}

function inferManualQuestionLocally(sourceText, segments) {
  const inferenceSegments = segments.length
    ? segments.map((item) => ({
      text: item.text,
      rewrittenText: item.rewrittenText || item.text,
      receivedAt: item.receivedAt,
    }))
    : [{ text: sourceText, rewrittenText: sourceText, receivedAt: nowMs() }];
  const inferredList = inferQuestionsFromSegments(inferenceSegments, {
    maxSegments: 80,
    maxChars: QUESTION_CONTEXT_MAX_CHARS,
  }) || [];
  const latest = inferredList.at(-1);
  if (latest?.questionText) {
    return {
      questionText: normalizeQuestionTextForManual(latest.questionText),
      confidence: latest.confidence ?? 0.78,
      reason: latest.reason || "手动标记本地推断",
    };
  }
  if (hasQuestionIntent({ text: sourceText, rewrittenText: sourceText })) {
    return {
      questionText: normalizeQuestionTextForManual(sourceText.slice(-220)),
      confidence: 0.72,
      reason: "手动标记原文兜底",
    };
  }
  return null;
}

async function resolveManualQuestion(payload = {}) {
  const { sourceText, segments } = buildManualQuestionSource(payload);
  const compactSource = compactQuestionKey(sourceText);
  if (compactSource.length < 4) {
    throw new Error("标记区间内没有可用面试官转写");
  }
  const local = inferManualQuestionLocally(sourceText, segments);
  let confirmed = null;
  try {
    confirmed = await confirmManualQuestionWithArk({
      sourceText,
      timeoutMs: 2800,
    });
  } catch (error) {
    emitDebugLog("manual_question_confirm_error", {
      source: snippet(sourceText, 160),
      message: error.message,
    });
  }
  const resolvedQuestion = confirmed?.questionText
    ? {
      questionText: normalizeQuestionTextForManual(confirmed.questionText),
      localQuestionText: local?.questionText || normalizeQuestionTextForManual(confirmed.questionText),
      confirmedQuestionText: normalizeQuestionTextForManual(confirmed.questionText),
      confidence: confirmed.confidence ?? local?.confidence ?? 0.82,
      reason: confirmed.reason || "手动标记方舟整理",
      confirmed: true,
      questionType: confirmed.questionType,
      evidenceTerms: confirmed.evidenceTerms || [],
    }
    : local
      ? {
        questionText: normalizeQuestionTextForManual(local.questionText),
        localQuestionText: normalizeQuestionTextForManual(local.questionText),
        confirmedQuestionText: "",
        confidence: local.confidence ?? 0.72,
        reason: local.reason || "手动标记本地推断",
        confirmed: false,
        questionType: "",
        evidenceTerms: [],
      }
      : null;
  if (!resolvedQuestion?.questionText || compactQuestionKey(resolvedQuestion.questionText).length < 4) {
    throw new Error("标记区间内没有可用面试官转写");
  }
  return {
    ...resolvedQuestion,
    sourceText,
    segments,
  };
}

async function submitManualQuestionSegment(payload = {}) {
  if (!currentSession) throw new Error("当前没有正在进行的面试会话");
  if (sessionPaused) throw new Error("面试暂停中，不能提交手动问题");
  const startedAt = Number(payload.startedAt || nowMs());
  const endedAt = Number(payload.endedAt || nowMs());
  const receivedAt = Number.isFinite(endedAt) ? endedAt : nowMs();
  addManualQuestionSuppressionWindow(startedAt || manualQuestionMarkingStartedAt, receivedAt, "manual_question_submit");
  manualQuestionMarking = false;
  manualQuestionMarkingStartedAt = 0;
  const resolved = await resolveManualQuestion(payload);
  const matchId = `manual-${receivedAt}-${shortHash(`${resolved.questionText}\n${resolved.sourceText}`)}`;
  removedQuestionMatchIds.delete(matchId);
  const inferred = {
    questionId: matchId,
    questionText: resolved.questionText,
    localQuestionText: resolved.localQuestionText || resolved.questionText,
    confirmedQuestionText: resolved.confirmedQuestionText || "",
    sourceText: resolved.sourceText,
    confidence: resolved.confidence,
    reason: resolved.reason,
    questionType: resolved.questionType,
    evidenceTerms: resolved.evidenceTerms || [],
    source: "manual_marker",
    manualStartedAt: startedAt,
    manualEndedAt: receivedAt,
    manualSegments: resolved.segments,
  };
  emitDebugLog("manual_question_submit", {
    matchId,
    question: snippet(resolved.questionText, 140),
    source: snippet(resolved.sourceText, 180),
    segmentCount: resolved.segments.length,
  });
  emitMatchForQuestion({
    inferred,
    receivedAt,
    transcript: { asrLatencyMs: 0 },
    definite: true,
    enhanced: Boolean(resolved.confirmed),
    matchId,
    skipQuestionConfirm: true,
  });
  return {
    matchId,
    questionText: resolved.questionText,
    sourceText: resolved.sourceText,
    receivedAt,
  };
}

function undoManualQuestion(matchId) {
  const session = currentSession;
  const id = String(matchId || "").trim();
  if (!session?.archive || !id) return { ok: false, removed: false };
  const existing = session.archive.questionsByMatchId.get(id);
  if (!existing || existing.source !== "manual_marker") return { ok: false, removed: false };
  session.archive.questionsByMatchId.delete(id);
  removedQuestionMatchIds.add(id);
  fallbackAnswerMatchIds.delete(id);
  writeQuestionSnapshots(session);
  appendJsonl("question-events.jsonl", {
    type: "manual_question_undone",
    matchId: id,
    receivedAt: nowMs(),
  });
  emitDebugLog("manual_question_undone", {
    matchId: id,
    question: snippet(existing.questionText || existing.confirmedQuestionText || "", 140),
  });
  return { ok: true, removed: true, matchId: id };
}

function maybeEnhanceQuestionWithArk({ segments, receivedAt, transcript, definite, localConfidence = 0 }) {
  if (!shouldCallArkEnhancer(receivedAt, definite)) return;
  const sourceText = buildQuestionSourceText(segments);
  if (sourceText.length < 6) return;
  const previousQuestions = recentStableQuestionTexts(5);

  const requestSeq = ++arkEnhanceSeq;
  emitDebugLog("ark_request", {
    definite,
    localConfidence,
    source: snippet(sourceText, 180),
    previousQuestions,
  });
  inferQuestionWithArk({ text: sourceText, previousQuestions })
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

function handleQuestionEngineOutputs(outputs, transcript) {
  for (const output of outputs || []) {
    if (output.type === "partial_preview") {
      emitPreviewForQuestion({
        inferred: output.question,
        receivedAt: output.question.receivedAt || nowMs(),
        transcript,
      });
      continue;
    }
    if (output.type === "question_finalized" || output.type === "question_updated") {
      const outputReceivedAt = Number(
        output.question?.updatedAt
        || output.question?.receivedAt
        || output.receivedAt
        || transcript?.receivedAt
        || 0
      );
      const suppressedByManualWindow = isWithinManualQuestionSuppressionWindow(outputReceivedAt);
      if (manualQuestionMarking || suppressedByManualWindow) {
        emitDebugLog("question_skip", {
          reason: suppressedByManualWindow ? "manual_marker_window" : "manual_marker_active",
          outputReceivedAt,
          question: snippet(output.question?.questionText || "", 120),
          source: snippet(output.question?.sourceText || "", 160),
        });
        continue;
      }
      const question = output.question;
      emitMatchForQuestion({
        inferred: {
          questionId: question.questionId,
          questionText: question.questionText,
          localQuestionText: question.localQuestionText,
          confirmedQuestionText: question.confirmedQuestionText,
          sourceText: question.sourceText,
          candidateContext: question.candidateContext,
          confidence: question.confidence,
          reason: question.reason,
          questionType: question.questionType,
          topicId: question.topicId,
          domainAnchors: question.domainAnchors || [],
          mergedFrom: question.mergedFrom || [],
          absorbedFrom: question.absorbedFrom || [],
          evidenceTerms: question.evidenceTerms || [],
          mergeReason: question.mergeReason || "",
        },
        receivedAt: question.updatedAt || question.receivedAt || nowMs(),
        transcript,
        definite: true,
        enhanced: Boolean(question.confirmed),
        matchId: question.questionId,
        skipQuestionConfirm: true,
      });
      continue;
    }
    if (output.type === "question_absorbed") {
      const event = {
        type: "question_absorbed",
        pendingId: output.pendingId,
        questionText: output.questionText,
        sourceText: output.sourceText,
        targetQuestionId: output.targetQuestionId,
        targetQuestionText: output.targetQuestionText,
        reason: output.reason,
        receivedAt: output.receivedAt || nowMs(),
      };
      appendJsonl("question-events.jsonl", event);
      emitDebugLog("question_absorbed", {
        question: snippet(output.questionText || "", 120),
        target: snippet(output.targetQuestionText || "", 120),
        reason: output.reason || "",
      });
      continue;
    }
    if (output.type === "question_rejected") {
      emitDebugLog("question_skip", {
        reason: output.reason || "engine_rejected",
        question: snippet(output.questionText || output.localQuestion || output.confirmedQuestion || "", 120),
        source: snippet(output.sourceText || "", 160),
      });
    }
  }
}

function processQuestionEngineEvent(event, transcript) {
  const engine = questionEngine;
  if (!engine) return;
  const requestSessionSeq = arkEnhanceSeq;
  Promise.resolve(engine.processEvent(event))
    .then((outputs) => {
      if (!currentSession || requestSessionSeq !== arkEnhanceSeq || sessionPaused) return;
      handleQuestionEngineOutputs(outputs, transcript);
    })
    .catch((error) => {
      emitDebugLog("question_engine_error", {
        type: event.type,
        message: error.message,
      });
      emitLog({ message: `问题抽取引擎跳过：${error.message}` });
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
    rememberConversationContext("interviewer", rewrittenText || transcript.text, receivedAt);
    rememberArchivedTranscript({
      role: "interviewer",
      speaker: "面试官",
      text: rewrittenText || transcript.text,
      rawText: transcript.text,
      rewrittenText,
      receivedAt,
      startMs: transcript.startMs,
      endMs: transcript.endMs,
    });
    processQuestionEngineEvent({
      type: "interviewer_final",
      text: transcript.text,
      rewrittenText,
      receivedAt,
      startMs: transcript.startMs,
      endMs: transcript.endMs,
    }, transcript);
    return;
  }

  processQuestionEngineEvent({
    type: "interviewer_partial",
    text: transcript.text,
    rewrittenText,
    receivedAt,
    startMs: transcript.startMs,
    endMs: transcript.endMs,
  }, transcript);
}

function handleMicTranscript(transcript) {
  if (sessionPaused) return;
  const receivedAt = nowMs();
  const text = String(transcript.text ?? "").trim();
  if (!text) return;
  const asrEvent = {
    text,
    definite: transcript.definite,
    utteranceStartMs: transcript.startMs,
    utteranceEndMs: transcript.endMs,
    receivedAt,
  };
  emit(transcript.definite ? "mic_asr_final" : "mic_asr_partial", asrEvent);
  if (!transcript.definite) return;

  rememberConversationContext("candidate", text, receivedAt);
  rememberArchivedTranscript({
    role: "candidate",
    speaker: "我",
    text,
    rawText: text,
    receivedAt,
    startMs: transcript.startMs,
    endMs: transcript.endMs,
  });
  emitDebugLog("mic_asr_final", {
    raw: snippet(text, 180),
    asrLatencyMs: transcript.asrLatencyMs,
    conversationContextLength: buildConversationContextText(2000).length,
  });
  processQuestionEngineEvent({
    type: "candidate_final",
    text,
    receivedAt,
    startMs: transcript.startMs,
    endMs: transcript.endMs,
  }, transcript);
}

function closeCurrentSession() {
  const sessionToClose = currentSession;
  currentSession = null;
  if (sessionToClose?.asr) sessionToClose.asr.close();
  if (sessionToClose?.micAsr) sessionToClose.micAsr.close();
  sessionPaused = false;
  recentTranscriptSegments = [];
  recentPartialSegments = [];
  pendingQuestionSegments = [];
  conversationContextSegments = [];
  recentQuestionKeys = [];
  recentStableQuestions = [];
  questionEngine = null;
  resetManualQuestionMarkingState();
  lastPartialQuestion = null;
  lastPartialMatchedAt = 0;
  arkEnhanceSeq += 1;
  lastArkEnhanceAt = 0;
  fallbackAnswerMatchIds = new Set();
  if (!sessionToClose) return Promise.resolve();

  const streams = [sessionToClose.audioFile, sessionToClose.micAudioFile].filter(Boolean);
  return Promise.all(streams.map((stream) => new Promise((resolve) => {
    try {
      stream.end(resolve);
    } catch {
      resolve();
    }
  }))).then(() => {
    finalizeSessionArchive(sessionToClose);
  });
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
      ? "Electron 通过桌面捕获拿系统输出声音用于识别面试官问题；麦克风只在开始面试后作为答案上下文采集。"
      : "非 Windows 仅用于界面开发；真实面试系统声音请在 Windows 本机调试。",
  },
  ];
}

function healthItem(state, label, message, extra = {}) {
  return { state, label, message, ...extra };
}

async function buildHealthStatus(companyId = "") {
  const checkedAt = nowMs();
  const items = {};
  const normalizedCompanyId = normalizeCompanyId(companyId);

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
    const bundle = getMatcherBundle(normalizedCompanyId);
    const company = bundle.companyContext;
    const message = company
      ? bundle.companyCount > 0
        ? `通用 ${bundle.baseCount} 题 · ${company.name} ${bundle.companyCount} 题`
        : `通用 ${bundle.baseCount} 题 · ${company.name} 仅注入公司资料`
      : `通用 ${bundle.baseCount} 题`;
    items.bank = bundle.items.length
      ? healthItem(company && bundle.companyCount === 0 ? "warning" : "ok", "题库", message)
      : healthItem("error", "题库", "题库为空");
    if (!bundle.matcher) {
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
    companyId: normalizedCompanyId,
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
    companyId: normalizedCompanyId,
  });
  return payload;
}

ipcMain.handle("list_audio_sources", async () => getAudioSources());

ipcMain.handle("list_companies", async () => listCompanies().map(publicCompanyOption));

ipcMain.handle("get_health_status", async (_event, companyId) => {
  const payload = await buildHealthStatus(companyId);
  emit("health_status", payload);
  return payload;
});

ipcMain.handle("start_session", async (_event, settings) => {
  await closeCurrentSession();
  const normalizedCompanyId = normalizeCompanyId(settings?.companyId);
  const matcherBundle = getMatcherBundle(normalizedCompanyId);
  const apiKey = resolveApiKey();
  const sessionId = crypto.randomUUID();
  const startedAt = new Date();
  const normalizedSettings = {
    resourceId: String(settings?.resourceId || DEFAULT_RESOURCE_ID).trim() || DEFAULT_RESOURCE_ID,
    captureMode: settings?.captureMode || "wasapi_loopback",
    audioDeviceId: settings?.audioDeviceId || "electron-loopback",
    audioOutputDeviceId: String(settings?.audioOutputDeviceId || "").trim(),
    audioOutputDeviceName: String(settings?.audioOutputDeviceName || "").trim(),
    microphoneDeviceId: String(settings?.microphoneDeviceId || "").trim(),
    microphoneDeviceName: String(settings?.microphoneDeviceName || "").trim(),
    saveAudio: true,
    requestedSaveAudio: Boolean(settings?.saveAudio),
    companyId: matcherBundle.companyContext?.id || "",
    microphoneContextEnabled: Boolean(settings?.microphoneContextEnabled),
  };
  const sessionDir = createSessionDir(sessionId, startedAt);
  const audioFile = fs.createWriteStream(path.join(sessionDir, "system-audio.pcm"), { flags: "a" });
  const micAudioFile = sessionDir && normalizedSettings.microphoneContextEnabled
    ? fs.createWriteStream(path.join(sessionDir, "microphone-audio.pcm"), { flags: "a" })
    : null;
  const archive = createSessionArchive({ sessionId, startedAt, settings: normalizedSettings, matcherBundle });
  const sessionMetadata = {
    sessionId,
    startedAt: startedAt.toISOString(),
    startedAtLocal: formatLocalDateTimeForText(startedAt),
    sessionDir,
    settings: normalizedSettings,
    company: archive.company,
    files: {
      systemAudioPcm: "system-audio.pcm",
      systemAudioWav: "system-audio.wav",
      microphoneAudioPcm: normalizedSettings.microphoneContextEnabled ? "microphone-audio.pcm" : "",
      microphoneAudioWav: normalizedSettings.microphoneContextEnabled ? "microphone-audio.wav" : "",
      combinedAudioPcm: "combined-audio.pcm",
      combinedAudioWav: "combined-audio.wav",
      systemTranscript: "system-transcript.txt",
      microphoneTranscript: "microphone-transcript.txt",
      combinedTranscript: "combined-transcript.txt",
      questionList: "question-list.txt",
      questionAnswers: "question-answers.md",
    },
  };
  fs.writeFileSync(path.join(sessionDir, "session-metadata.json"), `${JSON.stringify(sessionMetadata, null, 2)}\n`);
  sessionPaused = false;
  recentTranscriptSegments = [];
  recentPartialSegments = [];
  pendingQuestionSegments = [];
  conversationContextSegments = [];
  recentQuestionKeys = [];
  recentStableQuestions = [];
  resetManualQuestionMarkingState();
  removedQuestionMatchIds = new Set();
  lastPartialQuestion = null;
  lastPartialMatchedAt = 0;
  arkEnhanceSeq += 1;
  lastArkEnhanceAt = 0;
  fallbackAnswerMatchIds = new Set();
  questionEngine = createQuestionEngine();

  emitAudioStatus({
    state: "starting",
    deviceName: normalizedSettings.audioOutputDeviceName || "Electron loopback",
    volume: 0,
    message: "系统声音已授权，正在连接豆包 ASR",
  });
  const companySuffix = matcherBundle.companyContext ? ` · company=${matcherBundle.companyContext.name}` : "";
  emitLog({ message: `正在连接豆包流式 ASR · resource=${normalizedSettings.resourceId}${companySuffix} · request=${sessionId}` });

  const asr = new DoubaoAsrSession({
    apiKey,
    resourceId: normalizedSettings.resourceId,
    requestId: sessionId,
    emitLog,
    onTranscript: handleTranscript,
  });
  currentSession = { sessionId, settings: normalizedSettings, asr, micAsr: null, sessionDir, audioFile, micAudioFile, matcherBundle, archive };
  writeTranscriptSnapshots(currentSession);
  writeQuestionSnapshots(currentSession);
  try {
    await asr.start();
  } catch (error) {
    await closeCurrentSession();
    throw error;
  }

  if (normalizedSettings.microphoneContextEnabled) {
    emitMicrophoneAudioStatus({
      state: "starting",
      deviceName: normalizedSettings.microphoneDeviceName || "麦克风",
      volume: 0,
      message: "麦克风已授权，正在连接上下文 ASR",
    });
    const micAsr = new DoubaoAsrSession({
      apiKey,
      resourceId: normalizedSettings.resourceId,
      requestId: `${sessionId}-mic`,
      emitLog: (payload) => emitLog({ ...payload, message: `麦克风上下文：${payload.message}` }),
      onTranscript: handleMicTranscript,
    });
    currentSession.micAsr = micAsr;
    try {
      await micAsr.start();
      emitMicrophoneAudioStatus({
        state: "starting",
        deviceName: normalizedSettings.microphoneDeviceName || "麦克风",
        volume: 0,
        message: "麦克风上下文 ASR 已连接",
      });
      emitLog({ message: "麦克风上下文 ASR 已连接，只用于生成回答上下文" });
    } catch (error) {
      micAsr.close();
      currentSession.micAsr = null;
      normalizedSettings.microphoneContextEnabled = false;
      emitMicrophoneAudioStatus({
        state: "error",
        deviceName: normalizedSettings.microphoneDeviceName || "麦克风",
        volume: undefined,
        message: `麦克风上下文 ASR 未启用：${error.message}`,
      });
      emitLog({ message: `麦克风上下文 ASR 未启用：${error.message}` });
    }
  }

  emitAudioStatus({
    state: "starting",
    deviceName: normalizedSettings.audioOutputDeviceName || "Electron loopback",
    volume: 0,
    message: "ASR 已连接，正在采集系统声音",
  });
  return { sessionId };
});

ipcMain.handle("stop_session", async () => {
  await closeCurrentSession();
  emitAudioStatus({ state: "stopped", deviceName: undefined, volume: 0, message: "面试已结束" });
  emitMicrophoneAudioStatus({ state: "stopped", deviceName: undefined, volume: 0, message: "麦克风上下文已停止" });
});

ipcMain.handle("pause_session", async () => {
  if (manualQuestionMarkingStartedAt) {
    addManualQuestionSuppressionWindow(manualQuestionMarkingStartedAt, nowMs(), "manual_marker_pause");
  }
  sessionPaused = true;
  manualQuestionMarking = false;
  manualQuestionMarkingStartedAt = 0;
  emitAudioStatus({ state: "paused", deviceName: currentSession?.settings?.audioOutputDeviceName || "Electron loopback", volume: 0, message: "面试已暂停" });
  if (currentSession?.settings?.microphoneContextEnabled) {
    emitMicrophoneAudioStatus({ state: "paused", deviceName: currentSession.settings.microphoneDeviceName || "麦克风", volume: 0, message: "麦克风上下文已暂停" });
  }
});

ipcMain.handle("resume_session", async () => {
  sessionPaused = false;
  emitAudioStatus({ state: "capturing", deviceName: currentSession?.settings?.audioOutputDeviceName || "Electron loopback", volume: 0, message: "面试已继续，正在采集系统声音" });
  if (currentSession?.settings?.microphoneContextEnabled) {
    emitMicrophoneAudioStatus({ state: "capturing", deviceName: currentSession.settings.microphoneDeviceName || "麦克风", volume: 0, message: "麦克风上下文已继续" });
  }
});

ipcMain.handle("search_questions", async (_event, query, companyId) => (
  getMatcherBundle(companyId).matcher.search(String(query ?? ""))
));

ipcMain.handle("set_manual_question_marking", async (_event, active) => {
  manualQuestionMarking = setManualQuestionMarkingState(active);
  emitDebugLog("manual_question_marking", { active: manualQuestionMarking });
  return { active: manualQuestionMarking };
});

ipcMain.handle("submit_manual_question_segment", async (_event, payload) => (
  submitManualQuestionSegment(payload)
));

ipcMain.handle("undo_manual_question", async (_event, matchId) => (
  undoManualQuestion(matchId)
));

ipcMain.handle("audio_capture_error", async (_event, message) => {
  emitAudioStatus({ state: "error", deviceName: "Electron loopback", volume: undefined, message: `系统声音捕获失败：${message}` });
  emitLog({ message: `系统声音捕获失败：${message}` });
});

ipcMain.handle("microphone_capture_error", async (_event, message) => {
  emitMicrophoneAudioStatus({ state: "error", deviceName: "麦克风", volume: undefined, message: `麦克风捕获失败：${message}` });
  emitLog({ message: `麦克风上下文采集未启用：${message}` });
});

ipcMain.on("audio_chunk", (_event, payload) => {
  if (!currentSession?.asr || sessionPaused) return;
  const pcm = Buffer.from(payload?.pcm ?? []);
  if (!pcm.length) return;
  currentSession.asr.sendAudio(pcm);
  if (currentSession.audioFile) currentSession.audioFile.write(pcm);
  emitAudioStatus({
    state: "capturing",
    deviceName: currentSession.settings.audioOutputDeviceName || "Electron loopback",
    volume: typeof payload?.volume === "number" ? payload.volume : undefined,
    message: "正在采集系统声音并发送豆包 ASR",
  });
});

ipcMain.on("mic_audio_chunk", (_event, payload) => {
  if (!currentSession?.micAsr || sessionPaused) return;
  const pcm = Buffer.from(payload?.pcm ?? []);
  if (!pcm.length) return;
  currentSession.micAsr.sendAudio(pcm);
  if (currentSession.micAudioFile) currentSession.micAudioFile.write(pcm);
  emitMicrophoneAudioStatus({
    state: "capturing",
    deviceName: currentSession.settings.microphoneDeviceName || "麦克风",
    volume: typeof payload?.volume === "number" ? payload.volume : undefined,
    message: "正在采集麦克风并发送上下文 ASR",
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
  closeCurrentSession().finally(() => {
    if (process.platform !== "darwin") app.quit();
  });
});
