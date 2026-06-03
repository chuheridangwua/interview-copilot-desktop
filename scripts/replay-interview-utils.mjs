import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  Matcher,
  normalize,
  parseQuestionBank,
  rewriteTranscriptText,
} = require("../electron/backend/questionMatcher.cjs");
const {
  InterviewQuestionEngine,
  questionSimilarity,
} = require("../electron/backend/interviewQuestionEngine.cjs");
const {
  confirmQuestionWithArk,
  decideQuestionMergeWithArk,
  resolveArkConfig,
} = require("../electron/backend/arkQuestionEnhancer.cjs");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const REPLAY_ROOT = path.join(REPO_ROOT, "sessions", "replay");
export const REPLAY_REPORT_DIR = path.join(REPLAY_ROOT, "reports");
export const DEFAULT_GOLDEN_PATH = path.join(REPLAY_ROOT, "golden-2026-06-02-shumei.json");
export const DEFAULT_REPLAY_SESSION_DIRS = [
  path.join(REPO_ROOT, "sessions", "2026-06-02_19-00-26_75b676fb-0b94-4875-ab76-2160d08e25cf"),
  path.join(REPO_ROOT, "sessions", "2026-06-02_19-27-07_10d8c8e6-7013-480b-a159-18f16d423921"),
];

export const DEFAULT_GOLDEN = {
  schemaVersion: 2,
  name: "2026-06-02 19:00-19:35 数美 AI 产品经理面试",
  targetQuestionCount: { min: 35, max: 48 },
  audioTargetQuestionCount: { min: 35, max: 52 },
  duplicateWindowMaxPerCluster: 2,
  forbiddenNoise: [
    "我们开始啊，可以吗",
    "能听到吗",
    "要比较这个。要做得好吗",
    "要比较这个要做得好吗",
    "面有什么消息",
    "后面有什么消息",
    "OK, OK",
    "拜拜",
  ],
  blockedFinalQuestions: [
    "你对外设计的产品是不是",
  ],
  topicQuestionLimits: [
    { id: "contract_model_judgement", label: "大模型如何判断合同信息", all: ["大模型", "判断", "合同"], max: 1 },
    { id: "recognition_failure", label: "识别不出来具体指什么", all: ["识别不出来"], max: 1 },
  ],
  requiredQuestions: [
    { id: "self_intro", label: "自我介绍", any: ["自我介绍", "介绍一下自己", "自己情况"] },
    { id: "company_understanding", label: "公司了解", any: ["了解我们公司", "对我们公司", "我们公司是做什么", "公司是做什么", "数美"] },
    { id: "job_responsibility", label: "岗位职责", any: ["岗位职责", "这个岗位", "职责"] },
    { id: "ai_pm_responsibility", label: "AI 产品经理职责", any: ["AI产品经理", "产品经理", "主要做什么"] },
    { id: "demand_source", label: "需求来源", any: ["需求来源", "需求从哪里", "需求方", "从哪来", "从哪来的", "谁给你的需求"] },
    { id: "demand_discovery", label: "需求发现", any: ["发现需求", "挖掘需求", "怎么发现", "需求收集", "问题发现", "需求和问题的发现", "主动挖掘", "挖掘企业内部"] },
    { id: "contract_review_flow", label: "合同评审流程", any: ["合同评审", "投标评审", "流程"] },
    { id: "product_shape_usage", label: "产品形态/用户怎么用", any: ["产品形态", "用户怎么用", "怎么使用", "用户使用", "被用户使用", "怎么被用户使用"] },
    { id: "contract_model_judgement", label: "模型如何判断合同信息", any: ["模型", "判断", "合同"] },
    { id: "hallucination_accuracy", label: "AI 幻觉/不准", any: ["幻觉", "不准", "准确"] },
    { id: "llm_ratio", label: "大模型占比", any: ["大模型", "占比", "比例"] },
    { id: "knowledge_base", label: "知识库构建", any: ["知识库", "构建"] },
    { id: "career_plan", label: "职业规划", any: ["职业规划", "未来规划", "后续规划", "职业上的规划", "职业规划大概"] },
    { id: "two_customer_needs", label: "两类客户需求差异", any: ["两类客户", "客户需求", "需求差异"] },
    { id: "vision_model_metrics", label: "识别类模型指标", any: ["识别", "模型", "指标"] },
    { id: "bad_model_reason", label: "模型效果不好原因", any: ["模型效果不好", "效果不好", "原因"] },
    { id: "data_quality_reason", label: "数据质量问题原因", any: ["数据质量", "质量问题", "原因"] },
    { id: "label_capability_eval", label: "标签能力评价维度", any: ["标签", "能力", "评价"] },
  ],
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1} JSONL 解析失败: ${error.message}`);
      }
    });
}

export function ensureReplayGolden(goldenPath = DEFAULT_GOLDEN_PATH) {
  ensureDir(path.dirname(goldenPath));
  if (!fs.existsSync(goldenPath)) {
    fs.writeFileSync(goldenPath, `${JSON.stringify(DEFAULT_GOLDEN, null, 2)}\n`, "utf8");
    return readJsonFile(goldenPath);
  }
  const existing = readJsonFile(goldenPath);
  const shouldUpgradeSchema = Number(existing.schemaVersion || 0) < Number(DEFAULT_GOLDEN.schemaVersion || 0);
  const defaultRequiredById = new Map(DEFAULT_GOLDEN.requiredQuestions.map((item) => [item.id, item]));
  const existingRequiredById = new Map((existing.requiredQuestions || []).map((item) => [item.id, item]));
  const requiredQuestions = [...defaultRequiredById.keys()].map((id) => {
    const fallback = defaultRequiredById.get(id);
    const current = existingRequiredById.get(id) || {};
    return {
      ...fallback,
      ...current,
      any: [...new Set([...(fallback.any || []), ...(current.any || [])])],
    };
  });
  const merged = {
    ...DEFAULT_GOLDEN,
    ...existing,
    schemaVersion: DEFAULT_GOLDEN.schemaVersion,
    targetQuestionCount: shouldUpgradeSchema
      ? DEFAULT_GOLDEN.targetQuestionCount
      : {
        ...DEFAULT_GOLDEN.targetQuestionCount,
        ...(existing.targetQuestionCount || {}),
      },
    audioTargetQuestionCount: shouldUpgradeSchema
      ? DEFAULT_GOLDEN.audioTargetQuestionCount
      : {
        ...DEFAULT_GOLDEN.audioTargetQuestionCount,
        ...(existing.audioTargetQuestionCount || {}),
      },
    forbiddenNoise: [...new Set([...DEFAULT_GOLDEN.forbiddenNoise, ...(existing.forbiddenNoise || [])])],
    blockedFinalQuestions: [...new Set([...DEFAULT_GOLDEN.blockedFinalQuestions, ...(existing.blockedFinalQuestions || [])])],
    topicQuestionLimits: shouldUpgradeSchema
      ? DEFAULT_GOLDEN.topicQuestionLimits
      : (existing.topicQuestionLimits || DEFAULT_GOLDEN.topicQuestionLimits),
    requiredQuestions,
  };
  if (JSON.stringify(existing) !== JSON.stringify(merged)) {
    fs.writeFileSync(goldenPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }
  return merged;
}

function normalizeForMatch(value) {
  return normalize(String(value ?? "")).replace(/\s+/g, "").toLowerCase();
}

export function textIncludesAny(text, phrases) {
  const value = normalizeForMatch(text);
  return (phrases ?? []).some((phrase) => value.includes(normalizeForMatch(phrase)));
}

export function textIncludesAll(text, phrases) {
  const value = normalizeForMatch(text);
  return (phrases ?? []).every((phrase) => value.includes(normalizeForMatch(phrase)));
}

function loadTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function loadReplayMatcherBundle(companyId = "数美") {
  const basePath = path.join(REPO_ROOT, "resources", "question_bank_embedded.md");
  const baseItems = parseQuestionBank(loadTextIfExists(basePath));
  const companyQuestionPath = companyId ? path.join(REPO_ROOT, "resources", "company", companyId, "question.md") : "";
  const companyItems = companyQuestionPath && fs.existsSync(companyQuestionPath)
    ? parseQuestionBank(loadTextIfExists(companyQuestionPath), {
      source: "company",
      sourceLabel: companyId,
      idOffset: 10000,
    })
    : [];
  const items = [...baseItems, ...companyItems];
  return {
    matcher: new Matcher(items),
    items,
    baseCount: baseItems.length,
    companyCount: companyItems.length,
    companyId,
  };
}

export function createReplayEngine({ useArk = true, timeoutMs = 2800 } = {}) {
  return new InterviewQuestionEngine({
    confirmQuestion: useArk
      ? ({ sourceText, localQuestion, previousQuestions, candidateContext }) => confirmQuestionWithArk({
        sourceText,
        localQuestion,
        previousQuestions,
        candidateContext,
        timeoutMs,
      })
      : undefined,
    mergeDecider: useArk
      ? ({ question, existingQuestion, sourceText, existingSourceText, candidateContext, questionType, domainAnchors, existingQuestionType, existingDomainAnchors }) => decideQuestionMergeWithArk({
        question,
        existingQuestion,
        sourceText,
        existingSourceText,
        candidateContext,
        questionType,
        domainAnchors,
        existingQuestionType,
        existingDomainAnchors,
        timeoutMs: Math.min(1800, timeoutMs),
      })
      : undefined,
  });
}

export function createReplayCollector({ matcherBundle }) {
  const questionsById = new Map();
  const rejected = [];
  const partialPreviews = [];
  const absorbed = [];
  const merged = [];

  function collect(outputs, event = {}) {
    for (const output of outputs || []) {
      if (output.type === "partial_preview") {
        partialPreviews.push({
          ...output.question,
          eventRole: event.role,
        });
        continue;
      }
      if (output.type === "question_rejected") {
        rejected.push({
          reason: output.reason,
          questionText: output.questionText || output.localQuestion || output.confirmedQuestion || "",
          confirmedQuestion: output.confirmedQuestion || "",
          rejectReason: output.rejectReason || "",
          sourceText: output.sourceText || "",
          receivedAt: output.receivedAt || event.receivedAt,
        });
        continue;
      }
      if (output.type === "question_absorbed") {
        absorbed.push({
          pendingId: output.pendingId,
          questionText: output.questionText || "",
          sourceText: output.sourceText || "",
          targetQuestionId: output.targetQuestionId || "",
          targetQuestionText: output.targetQuestionText || "",
          reason: output.reason || "",
          receivedAt: output.receivedAt || event.receivedAt,
        });
        continue;
      }
      if (output.type === "question_finalized" || output.type === "question_updated") {
        const question = output.question;
        const candidates = matcherBundle.matcher.search(question.questionText, 5);
        if (output.type === "question_updated" && question.mergedFrom?.length) {
          merged.push({
            questionId: question.questionId,
            questionText: question.questionText,
            mergeReason: question.mergeReason || output.mergeReason || "",
            mergedFrom: question.mergedFrom,
            receivedAt: question.updatedAt || question.receivedAt,
          });
        }
        questionsById.set(question.questionId, {
          ...question,
          outputType: output.type,
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            sourceLabel: candidate.sourceLabel || "通用",
            question: candidate.question,
            score: candidate.score,
          })),
        });
      }
    }
  }

  return {
    collect,
    getFinalQuestions: () => [...questionsById.values()]
      .sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0)),
    getRejected: () => rejected,
    getPartialPreviews: () => partialPreviews,
    getAbsorbed: () => absorbed,
    getMerged: () => merged,
  };
}

export function sessionDisplayName(sessionDir) {
  return path.basename(path.resolve(sessionDir));
}

export function loadTranscriptReplayEvents(sessionDirs) {
  const events = [];
  for (const sessionDir of sessionDirs) {
    const systemPath = path.join(sessionDir, "system-transcript.jsonl");
    const micPath = path.join(sessionDir, "microphone-transcript.jsonl");
    for (const item of readJsonl(systemPath)) {
      events.push({
        session: sessionDisplayName(sessionDir),
        role: "interviewer",
        type: "interviewer_final",
        text: item.text || item.rawText || "",
        rewrittenText: item.rewrittenText || rewriteTranscriptText(item.text || item.rawText || ""),
        receivedAt: Number(item.receivedAt || 0),
        startMs: item.utteranceStartMs,
        endMs: item.utteranceEndMs,
      });
    }
    for (const item of readJsonl(micPath)) {
      events.push({
        session: sessionDisplayName(sessionDir),
        role: "candidate",
        type: "candidate_final",
        text: item.text || item.rawText || "",
        rewrittenText: item.rewrittenText || "",
        receivedAt: Number(item.receivedAt || 0),
        startMs: item.utteranceStartMs,
        endMs: item.utteranceEndMs,
      });
    }
  }
  return events
    .filter((item) => item.text || item.rewrittenText)
    .sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0));
}

export async function feedReplayEvents({ engine, collector, events }) {
  for (const event of events) {
    const outputs = await engine.processEvent(event);
    collector.collect(outputs, event);
  }
}

function buildDuplicateClusters(questions) {
  const clusters = [];
  for (const question of questions) {
    const existing = clusters.find((cluster) => (
      questionSimilarity(cluster.items[0].questionText, question.questionText) >= 0.82
    ));
    if (existing) {
      existing.items.push(question);
    } else {
      clusters.push({ key: question.questionText, items: [question] });
    }
  }
  return clusters
    .filter((cluster) => cluster.items.length > 1)
    .map((cluster) => ({
      key: cluster.key,
      count: cluster.items.length,
      questions: cluster.items.map((item) => ({
        questionId: item.questionId,
        questionText: item.questionText,
        receivedAt: item.receivedAt,
      })),
    }));
}

function buildExactDuplicateCount(questions) {
  const counts = new Map();
  for (const question of questions) {
    const key = normalizeForMatch(question.questionText);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let duplicateCount = 0;
  for (const count of counts.values()) {
    if (count > 1) duplicateCount += count - 1;
  }
  return duplicateCount;
}

function anchorsOverlap(left = [], right = []) {
  const rightSet = new Set(right || []);
  return (left || []).filter((item) => rightSet.has(item)).length;
}

function buildSemanticDuplicateClusters(questions) {
  const clusters = [];
  for (const question of questions) {
    const existing = clusters.find((cluster) => {
      const first = cluster.items[0];
      const sameType = question.questionType && first.questionType && question.questionType === first.questionType;
      const overlap = anchorsOverlap(question.domainAnchors, first.domainAnchors);
      const similarity = questionSimilarity(first.questionText, question.questionText);
      return similarity >= 0.82 || (sameType && overlap > 0 && similarity >= 0.68);
    });
    if (existing) {
      existing.items.push(question);
    } else {
      clusters.push({ key: question.questionText, items: [question] });
    }
  }
  return clusters
    .filter((cluster) => cluster.items.length > 1)
    .map((cluster) => ({
      key: cluster.key,
      count: cluster.items.length,
      questions: cluster.items.map((item) => ({
        questionId: item.questionId,
        questionText: item.questionText,
        questionType: item.questionType,
        topicId: item.topicId,
        receivedAt: item.receivedAt,
      })),
    }));
}

function evaluateRequiredQuestions(questions, golden) {
  return (golden.requiredQuestions || []).map((requirement) => {
    const matched = questions.find((question) => (
      textIncludesAny(question.questionText, requirement.any)
    ));
    return {
      id: requirement.id,
      label: requirement.label,
      ok: Boolean(matched),
      matchedQuestionId: matched?.questionId || "",
      matchedQuestionText: matched?.questionText || "",
      any: requirement.any || [],
    };
  });
}

function evaluateForbiddenNoise(questions, golden) {
  return (golden.forbiddenNoise || []).map((phrase) => {
    const matches = questions.filter((question) => textIncludesAny(question.questionText, [phrase]));
    return {
      phrase,
      count: matches.length,
      matches: matches.map((question) => ({
        questionId: question.questionId,
        questionText: question.questionText,
      })),
    };
  });
}

function evaluateBlockedFinalQuestions(questions, golden) {
  return (golden.blockedFinalQuestions || []).map((phrase) => {
    const matches = questions.filter((question) => textIncludesAny(question.questionText, [phrase]));
    return {
      phrase,
      count: matches.length,
      matches: matches.map((question) => ({
        questionId: question.questionId,
        questionText: question.questionText,
      })),
    };
  });
}

function evaluateTopicLimits(questions, golden) {
  return (golden.topicQuestionLimits || []).map((limit) => {
    const matches = questions.filter((question) => textIncludesAll(question.questionText, limit.all || []));
    return {
      id: limit.id,
      label: limit.label,
      max: Number(limit.max || 1),
      count: matches.length,
      ok: matches.length <= Number(limit.max || 1),
      matches: matches.map((question) => ({
        questionId: question.questionId,
        questionText: question.questionText,
        questionType: question.questionType,
        topicId: question.topicId,
      })),
    };
  });
}

export function buildReplayReport({
  mode,
  sessionDirs,
  matcherBundle,
  golden,
  useArk,
  finalQuestions,
  partialPreviews,
  rejected,
  absorbed = [],
  merged = [],
  startedAt = new Date(),
  finishedAt = new Date(),
}) {
  const target = mode === "audio" ? golden.audioTargetQuestionCount || golden.targetQuestionCount : golden.targetQuestionCount;
  const duplicateClusters = buildDuplicateClusters(finalQuestions);
  const semanticDuplicateClusters = buildSemanticDuplicateClusters(finalQuestions);
  const required = evaluateRequiredQuestions(finalQuestions, golden);
  const forbidden = evaluateForbiddenNoise(finalQuestions, golden);
  const blockedFinalQuestions = evaluateBlockedFinalQuestions(finalQuestions, golden);
  const topicLimitViolations = evaluateTopicLimits(finalQuestions, golden).filter((item) => !item.ok);
  const finalQuestionCount = finalQuestions.length;
  const requiredHitCount = required.filter((item) => item.ok).length;
  const forbiddenHitCount = forbidden.reduce((sum, item) => sum + item.count, 0);
  const blockedFinalQuestionHitCount = blockedFinalQuestions.reduce((sum, item) => sum + item.count, 0);
  const excessiveDuplicateClusters = duplicateClusters
    .filter((cluster) => cluster.count > Number(golden.duplicateWindowMaxPerCluster || 2));
  const exactDuplicateCount = buildExactDuplicateCount(finalQuestions);
  const semanticDuplicateCount = semanticDuplicateClusters.length;
  const evidenceMismatchRejects = rejected.filter((item) => /evidence|context/.test(String(item.reason || "")));

  return {
    mode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
    useArk,
    arkModel: resolveArkConfig().model,
    sessions: sessionDirs.map((dir) => path.relative(REPO_ROOT, dir)),
    matcher: {
      baseCount: matcherBundle.baseCount,
      companyId: matcherBundle.companyId,
      companyCount: matcherBundle.companyCount,
      totalCount: matcherBundle.items.length,
    },
    summary: {
      finalQuestionCount,
      targetMin: target?.min,
      targetMax: target?.max,
      countInRange: finalQuestionCount >= Number(target?.min || 0) && finalQuestionCount <= Number(target?.max || Number.POSITIVE_INFINITY),
      partialPreviewCount: partialPreviews.length,
      archivedPartialCount: 0,
      forbiddenHitCount,
      requiredHitCount,
      requiredTotal: required.length,
      excessiveDuplicateClusterCount: excessiveDuplicateClusters.length,
      exactDuplicateCount,
      semanticDuplicateCount,
      absorbedQuestionCount: absorbed.length,
      mergedQuestionCount: merged.length,
      evidenceMismatchRejectCount: evidenceMismatchRejects.length,
      blockedFinalQuestionHitCount,
      topicLimitViolationCount: topicLimitViolations.length,
      rejectedCount: rejected.length,
    },
    required,
    forbidden,
    blockedFinalQuestions,
    topicLimitViolations,
    duplicateClusters,
    semanticDuplicateClusters,
    excessiveDuplicateClusters,
    absorbedQuestions: absorbed,
    mergedQuestions: merged,
    evidenceMismatchRejects,
    finalQuestions: finalQuestions.map((question, index) => ({
      index: index + 1,
      questionId: question.questionId,
      questionText: question.questionText,
      localQuestionText: question.localQuestionText,
      confirmedQuestionText: question.confirmedQuestionText,
      sourceText: question.sourceText,
      candidateContext: question.candidateContext,
      confidence: question.confidence,
      reason: question.reason,
      confirmed: question.confirmed,
      questionType: question.questionType,
      topicId: question.topicId,
      domainAnchors: question.domainAnchors || [],
      mergedFrom: question.mergedFrom || [],
      absorbedFrom: question.absorbedFrom || [],
      evidenceTerms: question.evidenceTerms || [],
      mergeReason: question.mergeReason || "",
      receivedAt: question.receivedAt,
      candidates: question.candidates,
    })),
    partialPreviews: partialPreviews.slice(-50),
    rejected: rejected.slice(-120),
  };
}

function reportMarkdown(report) {
  const missing = report.required.filter((item) => !item.ok);
  const forbidden = report.forbidden.filter((item) => item.count > 0);
  const blocked = report.blockedFinalQuestions.filter((item) => item.count > 0);
  return [
    `# Interview Replay Report`,
    "",
    `- Mode: ${report.mode}`,
    `- Ark: ${report.useArk ? `on (${report.arkModel})` : "off"}`,
    `- Sessions: ${report.sessions.join(", ")}`,
    `- Final questions: ${report.summary.finalQuestionCount} (target ${report.summary.targetMin}-${report.summary.targetMax})`,
    `- Partial previews: ${report.summary.partialPreviewCount}; archived partials: ${report.summary.archivedPartialCount}`,
    `- Required hits: ${report.summary.requiredHitCount}/${report.summary.requiredTotal}`,
    `- Forbidden noise hits: ${report.summary.forbiddenHitCount}`,
    `- Excessive duplicate clusters: ${report.summary.excessiveDuplicateClusterCount}`,
    `- Exact duplicates: ${report.summary.exactDuplicateCount}; semantic duplicate clusters: ${report.summary.semanticDuplicateCount}`,
    `- Absorbed weak questions: ${report.summary.absorbedQuestionCount}; merged questions: ${report.summary.mergedQuestionCount}`,
    `- Evidence mismatch rejects: ${report.summary.evidenceMismatchRejectCount}`,
    `- Blocked final question hits: ${report.summary.blockedFinalQuestionHitCount}; topic limit violations: ${report.summary.topicLimitViolationCount}`,
    "",
    "## Missing Required",
    missing.length
      ? missing.map((item) => `- ${item.label}: ${item.any.join(" / ")}`).join("\n")
      : "- None",
    "",
    "## Forbidden Noise",
    forbidden.length
      ? forbidden.map((item) => `- ${item.phrase}: ${item.count}`).join("\n")
      : "- None",
    "",
    "## Blocked Final Questions",
    blocked.length
      ? blocked.map((item) => `- ${item.phrase}: ${item.count}`).join("\n")
      : "- None",
    "",
    "## Topic Limit Violations",
    report.topicLimitViolations.length
      ? report.topicLimitViolations.map((item) => `- ${item.label}: ${item.count}/${item.max}`).join("\n")
      : "- None",
    "",
    "## Final Questions",
    ...report.finalQuestions.map((question) => [
      `### ${question.index}. ${question.questionText}`,
      `- id: ${question.questionId}`,
      `- confidence: ${question.confidence ?? ""}; reason: ${question.reason || ""}`,
      question.questionType ? `- type: ${question.questionType}; topic: ${question.topicId || ""}` : "",
      question.mergedFrom?.length ? `- mergedFrom: ${question.mergedFrom.length}; mergeReason: ${question.mergeReason || ""}` : "",
      question.absorbedFrom?.length ? `- absorbedFrom: ${question.absorbedFrom.length}` : "",
      question.localQuestionText && question.localQuestionText !== question.questionText ? `- local: ${question.localQuestionText}` : "",
      question.sourceText ? `- source: ${question.sourceText}` : "",
      question.candidates?.[0] ? `- top: #${question.candidates[0].id} ${question.candidates[0].question} (${question.candidates[0].score}%)` : "- top: none",
      "",
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

export function writeReplayReport(report, reportDir = REPLAY_REPORT_DIR) {
  ensureDir(reportDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `replay-${report.mode}-${stamp}`;
  const jsonPath = path.join(reportDir, `${baseName}.json`);
  const mdPath = path.join(reportDir, `${baseName}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdPath, reportMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

export function parseCommonReplayArgs(argv) {
  const args = {
    useArk: true,
    companyId: "数美",
    goldenPath: DEFAULT_GOLDEN_PATH,
    sessionDirs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--no-ark") {
      args.useArk = false;
      continue;
    }
    if (item === "--ark") {
      args.useArk = true;
      continue;
    }
    if (item === "--company") {
      args.companyId = argv[index + 1] || args.companyId;
      index += 1;
      continue;
    }
    if (item === "--golden") {
      args.goldenPath = path.resolve(argv[index + 1] || args.goldenPath);
      index += 1;
      continue;
    }
    if (item === "--session") {
      args.sessionDirs.push(path.resolve(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (!item.startsWith("--")) {
      args.sessionDirs.push(path.resolve(item));
    }
  }
  if (!args.sessionDirs.length) args.sessionDirs = [...DEFAULT_REPLAY_SESSION_DIRS];
  return args;
}
