const { execFileSync } = require("node:child_process");

const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_ARK_MODEL = "doubao-seed-2-0-mini-260428";
const DEFAULT_ARK_FAST_MODEL = "doubao-1-5-lite-32k-250115";
const WINDOWS_ENV_REGISTRY_KEYS = [
  "HKCU\\Environment",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
];
const windowsEnvCache = new Map();

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readWindowsEnv(name) {
  if (process.platform !== "win32") return "";
  if (windowsEnvCache.has(name)) return windowsEnvCache.get(name);

  const namePattern = new RegExp(`^${escapeRegExp(name)}\\s+REG_\\w+\\s+(.+)$`, "i");
  for (const registryKey of WINDOWS_ENV_REGISTRY_KEYS) {
    try {
      const output = execFileSync("reg", ["query", registryKey, "/v", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const line = output
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => namePattern.test(item));
      const match = line?.match(namePattern);
      if (match?.[1]) {
        const value = match[1].trim();
        windowsEnvCache.set(name, value);
        return value;
      }
    } catch {
      // Missing variables are expected when users rely on process env only.
    }
  }

  return "";
}

function getEnv(name) {
  return String(process.env[name] || readWindowsEnv(name) || "").trim();
}

function looksLikeArkApiKey(value) {
  return /^ark-[a-z0-9-]{20,}$/i.test(String(value ?? "").trim());
}

function resolveArkApiKey() {
  const explicitKey = getEnv("ARK_API_KEY") || getEnv("VOLCENGINE_ARK_API_KEY") || getEnv("DOUBAO_ARK_API_KEY");
  if (explicitKey) return explicitKey;

  const legacyDoubaoKey = getEnv("DOUBAO_API_KEY");
  return looksLikeArkApiKey(legacyDoubaoKey) ? legacyDoubaoKey : "";
}

function resolveArkConfig() {
  const apiKey = resolveArkApiKey();
  return {
    apiKey,
    baseUrl: String(getEnv("ARK_BASE_URL") || DEFAULT_ARK_BASE_URL).replace(/\/+$/, ""),
    model: String(getEnv("ARK_MODEL") || getEnv("DOUBAO_ARK_MODEL") || DEFAULT_ARK_MODEL).trim(),
    fastModel: String(getEnv("ARK_FAST_MODEL") || getEnv("DOUBAO_ARK_FAST_MODEL") || "").trim(),
    enabled: String(getEnv("ARK_QUESTION_ENHANCER") || "1") !== "0",
  };
}

function resolveArkFastModel(model) {
  if (model) return String(model).trim();
  const config = resolveArkConfig();
  return config.fastModel || config.model || DEFAULT_ARK_FAST_MODEL;
}

function supportsThinkingControl(model) {
  return /doubao-seed|deepseek/i.test(String(model ?? ""));
}

function extractJsonObject(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {}
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeQuestion(value) {
  const question = String(value ?? "").replace(/\s+/g, "").trim();
  if (!question) return "";
  return /[？?]$/.test(question) ? question : `${question}？`;
}

async function callArkChat({
  messages,
  maxTokens = 256,
  temperature = 0,
  signal,
  timeoutMs = 5000,
  model,
  disableThinking = true,
}) {
  const config = resolveArkConfig();
  const modelId = String(model || config.model || "").trim();
  if (!config.enabled || !config.apiKey || !modelId) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const body = {
      model: modelId,
      temperature,
      max_tokens: maxTokens,
      messages,
    };
    if (disableThinking && supportsThinkingControl(modelId)) {
      body.thinking = { type: "disabled" };
    }
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`方舟调用失败 ${response.status}: ${body.slice(0, 180)}`);
    }
    const payload = await response.json();
    return payload?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

async function streamArkChat({
  messages,
  maxTokens = 520,
  temperature = 0.25,
  signal,
  timeoutMs = 9000,
  model,
  disableThinking = true,
  onDelta,
}) {
  const config = resolveArkConfig();
  const modelId = String(model || config.model || "").trim();
  if (!config.enabled || !config.apiKey || !modelId) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const body = {
      model: modelId,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      messages,
    };
    if (disableThinking && supportsThinkingControl(modelId)) {
      body.thinking = { type: "disabled" };
    }
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`方舟流式调用失败 ${response.status}: ${bodyText.slice(0, 180)}`);
    }
    if (!response.body?.getReader) {
      throw new Error("方舟流式响应不可读");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    function consumeLine(line) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) return false;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return data === "[DONE]";
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        return false;
      }
      const delta = parsed?.choices?.[0]?.delta?.content
        ?? parsed?.choices?.[0]?.message?.content
        ?? "";
      if (!delta) return false;
      fullText += delta;
      if (typeof onDelta === "function") onDelta(delta, fullText);
      return false;
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      let shouldStop = false;
      for (const line of lines) {
        shouldStop = consumeLine(line) || shouldStop;
      }
      if (shouldStop) break;
    }
    if (buffer.trim()) consumeLine(buffer);
    return fullText.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function inferQuestionWithArk({ text, previousQuestions = [], signal, timeoutMs = 2500, model }) {
  const content = await callArkChat({
    signal,
    timeoutMs,
    model: resolveArkFastModel(model),
    maxTokens: 120,
    messages: [
      {
        role: "system",
        content: [
          "从最近两分钟实时ASR里抽取最新一个完整面试官问题。",
          "如果最新内容是同一问题的后半段，要结合上下文补全成完整问题，不要截断。",
          "同一追问合并，不拆小问；如果只是重复前面已记录的问题、候选人回答或寒暄，返回否。",
          "只输出JSON:{\"ok\":boolean,\"q\":\"\",\"c\":0-1}。",
        ].join(""),
      },
      {
        role: "user",
        content: JSON.stringify({
          previous_questions: previousQuestions.slice(-5),
          asr_context: String(text ?? "").slice(-1800),
        }),
      },
    ],
  });
  if (!content) return null;
  const parsed = extractJsonObject(content);
  if (!parsed || (parsed.ok !== true && parsed.is_question !== true)) return null;
  const questionText = normalizeQuestion(parsed.q || parsed.question);
  if (!questionText || questionText.length < 4) return null;
  const confidence = Math.max(0, Math.min(0.96, Number(parsed.c ?? parsed.confidence) || 0.72));
  return {
    questionText,
    sourceText: String(text ?? "").trim(),
    confidence,
    reason: "方舟小模型",
  };
}

async function confirmQuestionWithArk({ sourceText, localQuestion, previousQuestions = [], signal, timeoutMs = 2500, model }) {
  const content = await callArkChat({
    signal,
    timeoutMs,
    model: resolveArkFastModel(model),
    maxTokens: 120,
    messages: [
      {
        role: "system",
        content: [
          "校准AI产品经理面试问题，输出最新一个完整面试官问题。",
          "修正ASR截断/错字/误拼接；同一追问合并；如果只是重复前面已记录的问题、候选人回答或寒暄，返回否。",
          "只输出JSON:{\"ok\":boolean,\"q\":\"\",\"c\":0-1,\"r\":\"\"}。",
        ].join(""),
      },
      {
        role: "user",
        content: JSON.stringify({
          local_question: String(localQuestion ?? "").slice(0, 180),
          previous_questions: previousQuestions.slice(-5),
          asr_context: String(sourceText ?? "").slice(-1800),
          target_role: "AI产品经理",
        }),
      },
    ],
  });
  if (!content) return null;
  const parsed = extractJsonObject(content);
  if (!parsed || (parsed.ok !== true && parsed.is_question !== true)) return null;
  const questionText = normalizeQuestion(parsed.q || parsed.question);
  if (!questionText || questionText.length < 4) return null;
  return {
    questionText,
    sourceText: String(sourceText ?? "").trim(),
    confidence: Math.max(0, Math.min(0.98, Number(parsed.c ?? parsed.confidence) || 0.78)),
    reason: parsed.r || parsed.reason ? `方舟确认：${String(parsed.r || parsed.reason).slice(0, 60)}` : "方舟确认",
  };
}

function compactCandidate(candidate) {
  return {
    id: candidate.id,
    question: candidate.question,
    sourceLabel: candidate.sourceLabel || "通用",
    score: candidate.score,
    answerLogic: String(candidate.answerLogic || "").slice(0, 320),
    answerDetail: String(candidate.answerDetail || candidate.answer || "").slice(0, 1000),
  };
}

async function rerankCandidatesWithArk({ question, candidates, resumeText, signal, timeoutMs = 9000 }) {
  const content = await callArkChat({
    signal,
    timeoutMs,
    maxTokens: 520,
    messages: [
      {
        role: "system",
        content: [
          "你是 AI 产品经理面试实时辅助系统里的题库匹配和作答助手。",
          "你会收到面试官问题、本地召回候选题、候选人的简历。",
          "任务1：从候选题中选择最相关的 Top3，只能使用候选题 id，不要编造不存在的 id。",
          "任务2：基于面试官问题、简历和最相关候选题，给出一段可直接口述的中文回答。",
          "回答要贴合 AI 产品经理岗位，突出企业 AI 转型、0-1 落地、需求拆解、业务结果和候选人简历事实。",
          "回答要简洁但具体，优先 4-5 句话，不要使用 markdown。",
          "输出严格 JSON，不要解释。",
          "字段：top3(array<{id:number, score:number, reason:string}>), answer(string)。",
        ].join(""),
      },
      {
        role: "user",
        content: JSON.stringify({
          target_role: "AI产品经理",
          question: String(question ?? "").slice(0, 240),
          candidates: (candidates ?? []).slice(0, 5).map(compactCandidate),
          resume: String(resumeText ?? "").slice(0, 3000),
        }),
      },
    ],
  });
  if (!content) return null;
  const parsed = extractJsonObject(content);
  if (!parsed) return null;
  const candidateById = new Map((candidates ?? []).map((candidate) => [Number(candidate.id), candidate]));
  const top3 = (Array.isArray(parsed.top3) ? parsed.top3 : [])
    .map((item) => {
      const id = Number(item?.id);
      const candidate = candidateById.get(id);
      if (!candidate) return null;
      return {
        ...candidate,
        score: Math.max(0, Math.min(99, Math.round(Number(item.score) || candidate.score || 0))),
        aiReason: String(item.reason || "").slice(0, 80),
      };
    })
    .filter(Boolean)
    .slice(0, 3);
  if (!top3.length) return null;
  return {
    candidates: top3,
    answer: String(parsed.answer || "").trim().slice(0, 1200),
  };
}

async function generateFallbackAnswerStreamWithArk({
  question,
  candidates,
  resumeText,
  companyContext,
  conversationContext,
  mode = "answer_guided",
  signal,
  timeoutMs = 9000,
  model,
  onDelta,
}) {
  const pool = (candidates ?? []).slice(0, 5).map(compactCandidate);
  const topScore = Number(candidates?.[0]?.score ?? 0);
  const companyName = String(companyContext?.name || "").trim();
  const companyIntroduction = String(companyContext?.introduction || "").trim();
  const content = await streamArkChat({
    signal,
    timeoutMs,
    model: resolveArkFastModel(model),
    maxTokens: 760,
    temperature: 0.2,
    onDelta,
    messages: [
      {
        role: "system",
        content: [
          "你是AI产品经理面试实时辅助系统。",
          "你会收到当前问题、最近对话上下文、候选人的题库答案片段和简历。",
          "最近对话上下文只用于理解面试进度、候选人刚才说过的背景和追问承接；当前问题仍然是唯一要回答的问题。",
          "上下文里“我：”开头的是候选人麦克风识别内容，只能作为已说过内容和补充背景，不能当成面试官问题去回答。",
          "如果题库候选分数高或题目明显匹配，必须优先按照题库里的回答逻辑和具体内容来组织，只做压缩、口语化和贴合当前问法。",
          "如果题库没有可靠命中，再基于简历事实和相近题库片段生成通用回答。",
          "如果提供了面试公司信息，回答公司相关问题时要优先结合公司定位、岗位JD、公司产品、公司题库片段和候选人经历做匹配。",
          "不要编造简历和公司资料之外的事实；题库不匹配时，用简历里的真实经历和公司资料组织通用回答。",
          "必须严格按下面格式输出，不要输出其他标题、markdown、序号或寒暄：",
          "回答逻辑：",
          "用一行短语概括，例如：基本身份——核心经历——岗位匹配",
          "",
          "具体内容：",
          "分成2到4段，每段用【段落主题】开头，段落之间用空行分隔。",
          "具体内容整体4到7句，清晰具体，偏AI产品经理岗位。",
        ].join(""),
      },
      {
        role: "user",
        content: JSON.stringify({
          target_role: "AI产品经理",
          mode,
          question: String(question ?? "").slice(0, 260),
          conversation_context: String(conversationContext ?? "").slice(-2200),
          top_local_score: topScore,
          local_question_bank_candidates: pool,
          resume: String(resumeText ?? "").slice(0, 3200),
          company_name: companyName,
          company_introduction: companyIntroduction.slice(0, 5200),
        }),
      },
    ],
  });
  return String(content || "").trim();
}

async function rerankCandidateIdsWithArk({ question, candidates, signal, timeoutMs = 2200, model }) {
  const pool = (candidates ?? []).slice(0, 5);
  if (!String(question ?? "").trim() || !pool.length) return null;
  const content = await callArkChat({
    signal,
    timeoutMs,
    model: resolveArkFastModel(model),
    maxTokens: 48,
    messages: [
      {
        role: "system",
        content: [
          "你只做面试题库候选重排。",
          "从候选id中选最相关3个，不得编造id。",
          "只输出JSON:{\"ids\":[数字,数字,数字]}。",
        ].join(""),
      },
      {
        role: "user",
        content: JSON.stringify({
          q: String(question ?? "").slice(0, 160),
          c: pool.map((candidate) => ({
            id: candidate.id,
            q: candidate.question,
          })),
        }),
      },
    ],
  });
  if (!content) return null;
  const parsed = extractJsonObject(content);
  const rawIds = Array.isArray(parsed?.ids)
    ? parsed.ids
    : Array.isArray(parsed?.top3)
      ? parsed.top3.map((item) => (typeof item === "number" ? item : item?.id))
      : [];
  const candidateById = new Map(pool.map((candidate) => [Number(candidate.id), candidate]));
  const seen = new Set();
  const reranked = rawIds
    .map((item) => Number(item))
    .filter((id) => Number.isFinite(id) && candidateById.has(id) && !seen.has(id) && seen.add(id))
    .map((id, index) => {
      const candidate = candidateById.get(id);
      return {
        ...candidate,
        score: Math.max(candidate.score || 0, 96 - index * 4),
        aiReason: "小模型重排",
      };
    })
    .slice(0, 3);
  if (!reranked.length) return null;
  const localFill = pool
    .filter((candidate) => !seen.has(Number(candidate.id)))
    .slice(0, Math.max(0, 3 - reranked.length));
  return [...reranked, ...localFill].slice(0, 3);
}

module.exports = {
  callArkChat,
  confirmQuestionWithArk,
  generateFallbackAnswerStreamWithArk,
  inferQuestionWithArk,
  rerankCandidateIdsWithArk,
  rerankCandidatesWithArk,
  resolveArkConfig,
  streamArkChat,
  readWindowsEnv,
};
