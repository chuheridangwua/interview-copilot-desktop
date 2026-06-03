const crypto = require("node:crypto");
const {
  inferQuestionsFromSegments,
  normalize,
  rewriteTranscriptText,
} = require("./questionMatcher.cjs");

const DEFAULT_CONTEXT_WINDOW_MS = 3 * 60 * 1000;
const DEFAULT_MAX_INTERVIEWER_CHARS = 2600;
const DEFAULT_MAX_CANDIDATE_CHARS = 2000;
const DEFAULT_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_TOPIC_WINDOW_MS = 5 * 60 * 1000 + 30 * 1000;
const DEFAULT_WEAK_PENDING_MS = 90 * 1000;

function compactQuestionKey(questionText) {
  return normalize(questionText).replace(/\s+/g, "");
}

function hashText(text) {
  return crypto.createHash("sha1").update(String(text ?? "")).digest("hex").slice(0, 8);
}

function stripQuestionEnding(text) {
  return String(text ?? "").replace(/[？?]+$/g, "").trim();
}

function charBigrams(text) {
  const value = compactQuestionKey(text);
  if (value.length <= 1) return value ? [value] : [];
  const result = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2));
  }
  return result;
}

function questionSimilarity(left, right) {
  const leftKey = compactQuestionKey(left);
  const rightKey = compactQuestionKey(right);
  if (!leftKey || !rightKey) return 0;
  if (leftKey === rightKey) return 1;
  if (leftKey.includes(rightKey) || rightKey.includes(leftKey)) {
    return Math.min(leftKey.length, rightKey.length) / Math.max(leftKey.length, rightKey.length);
  }
  const leftBigrams = new Set(charBigrams(leftKey));
  const rightBigrams = new Set(charBigrams(rightKey));
  if (!leftBigrams.size || !rightBigrams.size) return 0;
  let intersection = 0;
  for (const item of leftBigrams) {
    if (rightBigrams.has(item)) intersection += 1;
  }
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

function isNoiseText(text) {
  const value = compactQuestionKey(text);
  if (!value) return true;
  if (/^(嗯+|啊+|呃+|哦+|行+|好的|好嘞|ok|okay|hello|你好|拜拜|再见)$/i.test(value)) return true;
  if (/^(能听到吗|听得到吗|可以听到吗|能听见吗|声音可以吗)$/.test(value)) return true;
  if (/^(我们开始啊可以吗|我们开始可以吗|开始啊可以吗|可以吗|行吧)$/.test(value)) return true;
  if (/^(后面有什么消息|面有什么消息|有什么消息|今天就先到这|我让人力.*|好吧)$/.test(value)) return true;
  return false;
}

function hasQuestionCue(text) {
  return /(？|\?|为什么|怎么|如何|什么|哪些|哪种|能不能|可不可以|介绍|讲一下|说一下|聊一下|负责|角色|构成|设计|策略|标签|标注|评估|指标|效果|原因|流程|方案|风险|难点|挑战|理解|分析|解决|判断|衡量|比对|需求|问题)/.test(String(text ?? ""));
}

function isWeakQuestion(text) {
  const value = stripQuestionEnding(compactQuestionKey(text));
  if (!value || value.length < 8) return true;
  return [
    /^主要做什么$/,
    /^主要是做什么$/,
    /^流程主要做什么$/,
    /^你觉得是什么$/,
    /^是什么$/,
    /^你是怎么理解的$/,
    /^怎么理解的$/,
    /^想解决什么问题$/,
    /^分别遇到了是什么问题$/,
    /^就分别遇到了是什么问题$/,
    /^主要原因会有哪些呢?$/,
    /^主要原因会有哪些$/,
    /^具体做了什么呀?$/,
    /^你具体做了什么呀?$/,
    /^你指的是什么意思$/,
    /^指的是什么意思$/,
    /^发现了什么$/,
    /^就用户怎么用$/,
    /^用户怎么用$/,
    /^你对外设计的产品是不是$/,
    /^对外设计的产品是不是$/,
    /^审完就出去了是吧$/,
    /^要比较这个要做得好吗$/,
    /^要做得好吗$/,
    /^只是说这个标签的效果是吧$/,
    /^需要去做支撑吧$/,
    /^后面有什么消息$/,
    /^面有什么消息$/,
  ].some((pattern) => pattern.test(value));
}

function isCanonicalShortInterviewQuestion(text) {
  const value = stripQuestionEnding(compactQuestionKey(text));
  if (!value) return false;
  return /(自我介绍|介绍一下自己|自己情况|公司是做什么|了解.*公司|岗位职责|需求.*(来源|从哪来|从哪来的|需求方)|职业规划|未来规划|期望薪资)/.test(value);
}

function hasDomainAnchor(text) {
  return /(AI|产品|平台|经理|模型|大模型|RAG|Agent|Workflow|MCP|合同|标书|金额|合同方|投标|评审|知识库|标签|标注|内容安全|风控|需求|业务|客户|流程|指标|准确率|召回率|误杀|数据质量|职业规划|岗位|职责|公司|数美|视觉|识别|YOLO)/i.test(String(text ?? ""));
}

const QUESTION_SUPPORT_TERMS = [
  "自我介绍",
  "自己情况",
  "公司",
  "岗位",
  "职责",
  "AI产品经理",
  "AI产品",
  "产品经理",
  "产品",
  "需求方",
  "需求来源",
  "需求收集",
  "需求",
  "主动",
  "挖掘",
  "发现",
  "问题",
  "合同科",
  "合同评审",
  "投标评审",
  "合同",
  "标书",
  "金额",
  "合同方",
  "投标",
  "评审",
  "平台",
  "产品形态",
  "用户使用",
  "流程",
  "模型",
  "大模型",
  "知识库",
  "幻觉",
  "准确",
  "占比",
  "客户",
  "识别",
  "指标",
  "召回",
  "误杀",
  "数据质量",
  "数据",
  "质量",
  "标签",
  "标注",
  "职业规划",
  "规划",
  "任职",
  "时长",
  "一年",
].map((item) => compactQuestionKey(item));

function supportTerms(text) {
  const value = compactQuestionKey(text);
  return new Set(QUESTION_SUPPORT_TERMS.filter((term) => term && value.includes(term)));
}

const DOMAIN_ANCHOR_RULES = [
  ["intro", /自我介绍|介绍一下自己|自己情况/],
  ["company", /公司|数美/],
  ["role", /岗位|职责|AI产品经理|产品经理|角色/],
  ["demand", /需求|需求方|挖掘|发现|问题发现/],
  ["process", /流程|评审|审核|审完|合同科|投标/],
  ["product", /产品|产品形态|平台|用户|使用|怎么用|对外设计/],
  ["contract", /合同|标书|金额|合同方|甲方|乙方|投标/],
  ["model", /模型|大模型|AI|算法|识别|判断|抽取|比对/],
  ["hallucination", /幻觉|不准|准确|校验|纠错/],
  ["knowledge", /知识库|RAG|文档库/],
  ["career", /职业规划|未来规划|规划/],
  ["customer", /客户|品牌客户|平台客户|两类客户|需求差异/],
  ["metric", /指标|准确率|召回率|误杀|精确率|效果/],
  ["data", /数据|样本|训练集|质量|数据质量/],
  ["label", /标签|标注/],
  ["vision", /视觉|YOLO|图像|识别类/],
];

const BUSINESS_EVIDENCE_TERMS = [
  "自我介绍",
  "公司",
  "数美",
  "岗位",
  "职责",
  "AI产品经理",
  "产品经理",
  "需求",
  "需求方",
  "需求来源",
  "挖掘",
  "发现",
  "合同",
  "合同评审",
  "合同方",
  "投标",
  "标书",
  "金额",
  "评审",
  "审核",
  "流程",
  "平台",
  "产品",
  "产品形态",
  "用户",
  "使用",
  "模型",
  "大模型",
  "判断",
  "识别",
  "幻觉",
  "准确",
  "知识库",
  "客户",
  "两类客户",
  "需求差异",
  "指标",
  "召回",
  "误杀",
  "数据质量",
  "数据",
  "样本",
  "训练集",
  "质量",
  "标签",
  "标注",
  "能力",
  "评价",
  "职业规划",
].map((item) => compactQuestionKey(item));

const KNOWN_QUESTION_TYPES = new Set([
  "intro",
  "company",
  "role",
  "demand_source",
  "demand_discovery",
  "process_flow",
  "product_usage",
  "model_judgement",
  "hallucination",
  "knowledge_base",
  "career",
  "customer_scenario",
  "metric",
  "root_cause",
  "data_quality",
  "tag_evaluation",
  "unknown",
]);

function normalizeQuestionType(value) {
  const type = String(value || "").trim();
  return KNOWN_QUESTION_TYPES.has(type) ? type : "unknown";
}

function classifyQuestionType(questionText, sourceText = "") {
  const value = compactQuestionKey(`${questionText}\n${sourceText}`);
  if (!value) return "unknown";
  if (/自我介绍|介绍一下自己|自己情况/.test(value)) return "intro";
  if (/了解.*公司|公司.*做什么|对.*公司|数美/.test(value)) return "company";
  if (/需求.*(来源|从哪|哪里|谁|需求方)|需求方|谁给.*需求|需求从/.test(value)) return "demand_source";
  if (/发现需求|挖掘需求|主动.*需求|需求.*发现|问题发现|需求收集|发现.*问题/.test(value)) return "demand_discovery";
  if (/合同评审|投标评审|评审流程|审核流程|合同科|审完|流程/.test(value)) return "process_flow";
  if (/产品形态|用户.*(怎么用|使用)|怎么.*使用|怎么被用户使用|就用户怎么用|对外设计的产品|平台.*(怎么用|使用|产品)/.test(value)) return "product_usage";
  if (/(大模型|模型).*(判断|识别|抽取|比对|合同|标书|金额|合同方|信息)|合同.*(信息|金额|合同方).*(判断|识别|模型)|标书.*(判断|识别|模型)/.test(value)) return "model_judgement";
  if (/幻觉|不准|不准确|准确.*(保证|校验|提升)|怎么保证.*准确/.test(value)) return "hallucination";
  if (/知识库|RAG|文档库|构建知识/.test(value)) return "knowledge_base";
  if (/职业规划|未来规划|后续规划|规划是什么/.test(value)) return "career";
  if (/两类客户|客户.*需求.*差异|需求差异|品牌客户|平台客户/.test(value)) return "customer_scenario";
  if (/指标|准确率|召回率|误杀|精确率|识别类模型.*效果|效果.*指标/.test(value)) return "metric";
  if (/数据质量|质量问题|数据.*质量/.test(value)) return "data_quality";
  if (/(标签|标注).*(能力|效果|评价|维度)|标签能力|标签的效果/.test(value)) return "tag_evaluation";
  if (/模型效果不好|效果不好|识别不出来|识别失败|主要原因|原因有哪些|为什么.*不好/.test(value)) return "root_cause";
  if (/岗位职责|岗位.*职责|AI产品经理.*(职责|做什么|角色)|产品经理.*(职责|做什么|角色)/.test(value)) return "role";
  return "unknown";
}

function extractDomainAnchors(text) {
  const value = compactQuestionKey(text);
  const anchors = [];
  for (const [anchor, pattern] of DOMAIN_ANCHOR_RULES) {
    if (pattern.test(value)) anchors.push(anchor);
  }
  return [...new Set(anchors)].sort();
}

function buildTopicId(questionType, domainAnchors = []) {
  const type = questionType || "unknown";
  const anchors = (domainAnchors || []).slice().sort().slice(0, 4).join("-");
  return anchors ? `${type}:${anchors}` : type;
}

function businessEvidenceTerms(text) {
  const value = compactQuestionKey(text);
  if (!value) return [];
  const result = [];
  for (const term of BUSINESS_EVIDENCE_TERMS) {
    if (term && value.includes(term)) result.push(term);
  }
  return [...new Set(result)];
}

function evidenceOverlapCount(questionText, contexts = []) {
  const questionTerms = businessEvidenceTerms(questionText);
  const contextTerms = new Set(businessEvidenceTerms((contexts || []).join("\n")));
  return questionTerms.filter((term) => contextTerms.has(term)).length;
}

function hasEvidenceBoundSupport(questionText, { sourceText = "", localQuestion = "", candidateContext = "" } = {}) {
  if (isCanonicalShortInterviewQuestion(questionText)) return true;
  const questionTerms = businessEvidenceTerms(questionText);
  if (!questionTerms.length) return hasQuestionContextSupport(questionText, [sourceText, localQuestion, candidateContext]);
  const sourceLocalTerms = new Set(businessEvidenceTerms(`${sourceText}\n${localQuestion}`));
  const contextTerms = new Set(businessEvidenceTerms(`${sourceText}\n${localQuestion}\n${candidateContext}`));
  let hits = 0;
  let sourceLocalHits = 0;
  for (const term of questionTerms) {
    if (contextTerms.has(term)) hits += 1;
    if (sourceLocalTerms.has(term)) sourceLocalHits += 1;
  }
  const shortSource = compactQuestionKey(sourceText).length < 12 || compactQuestionKey(localQuestion).length < 12;
  if (shortSource) {
    return sourceLocalHits >= 1 && hits >= Math.min(2, questionTerms.length);
  }
  return hits >= Math.min(2, questionTerms.length) || (hits >= 1 && questionTerms.length <= 2);
}

function isAbsorbableWeakQuestion(text) {
  const value = stripQuestionEnding(compactQuestionKey(text));
  if (!value) return false;
  return [
    /^(就是)?(你)?(你)?对外设计的产品是不是$/,
    /^审完就出去了是吧$/,
    /^(你)?具体做了什么呀$/,
    /^(你)?指的是什么意思$/,
    /^(你是)?怎么理解的$/,
    /^主要原因(会)?有哪些(呢)?$/,
    /^(就)?(他们)?用户怎么用$/,
    /^(就)?分别遇到了是什么问题$/,
    /^想解决什么问题$/,
    /^只是说这个标签的效果是吧$/,
    /^要比较这个要做得好吗$/,
    /^要做得好吗$/,
  ].some((pattern) => pattern.test(value));
}

function anchorOverlap(left = [], right = []) {
  const rightSet = new Set(right);
  return (left || []).filter((item) => rightSet.has(item)).length;
}

function mergeUniqueText(existingText, nextText, maxChars = 3600) {
  const existing = String(existingText || "").trim();
  const next = String(nextText || "").trim();
  if (!existing) return next.slice(-maxChars);
  if (!next || existing.includes(next)) return existing.slice(-maxChars);
  if (next.includes(existing)) return next.slice(-maxChars);
  return `${existing}\n${next}`.slice(-maxChars);
}

function mergeUniqueArray(left = [], right = []) {
  return [...new Set([...(left || []), ...(right || [])].filter(Boolean))];
}

function isContractJudgementFamily(text) {
  const value = compactQuestionKey(text);
  return /(合同|标书|金额|合同方)/.test(value) && /(模型|大模型|判断|识别|信息|正确)/.test(value);
}

function isRecognitionFailureFamily(text) {
  const value = compactQuestionKey(text);
  return /(识别不出来|识别失败|识别不准|效果不好)/.test(value) && /(具体|什么|场景|原因|指的是|指的是什么|模型)/.test(value);
}

function recognitionFailureMergeKind(text) {
  const value = compactQuestionKey(text);
  if (/(识别不出来|识别失败|识别不准)/.test(value) && /(具体|指的是什么|指的是|什么场景|场景)/.test(value)) {
    return "clarification";
  }
  if (/(效果不好|准确率不足|原因|为什么不好)/.test(value)) return "cause";
  return "";
}

function hasFollowupTopicSupport(questionText, { sourceText = "", localQuestion = "", previousQuestions = [] } = {}) {
  const questionType = classifyQuestionType(questionText, sourceText);
  const source = compactQuestionKey(`${sourceText}\n${localQuestion}`);
  const previous = compactQuestionKey((previousQuestions || []).join("\n"));
  if (questionType === "process_flow") {
    return /(合同|合同科|评审|审核|流程|审)/.test(previous + source)
      && /(耗时|怎么审|审的|审完|分析|后续|流程|处理)/.test(source);
  }
  if (questionType === "product_usage") {
    return /(产品|平台|用户|合同|AI产品)/.test(previous + source)
      && /(怎么用|使用|平台|工作内容|提效|解决啥|解决什么)/.test(source);
  }
  if (questionType === "customer_scenario") {
    return /(客户|需求|两类客户|需求差异)/.test(previous + source)
      && /(怎么理解|什么问题|解决什么|需求差异|第二类)/.test(source);
  }
  if (questionType === "demand_discovery") {
    return /(需求|问题|合同|评审|流程|客户)/.test(previous + source)
      && /(耗时|分析|后续|发现|理解|需求|问题)/.test(source);
  }
  return false;
}

function isAcceptableShortBusinessQuestion(questionText, sourceText = "", previousQuestions = []) {
  const question = normalizeQuestionText(questionText);
  const value = stripQuestionEnding(compactQuestionKey(question));
  if (!value || isNoiseText(question) || /要比较|要做得好吗|能听|开始|拜拜|消息/.test(value)) return false;
  const context = compactQuestionKey(`${sourceText}\n${(previousQuestions || []).join("\n")}`);
  if (/后续做了哪些分析|做了哪些分析/.test(value)) return /(合同|评审|流程|需求|问题)/.test(context);
  if (/最耗时的是谁|最耗时.*环节|耗时最大/.test(value)) return /(合同|评审|流程|需求|问题)/.test(context);
  if (/都是提效相关|提效相关的是吧/.test(value)) return /(产品|合同|标书|商机|AI|工作内容|审核)/i.test(context + value);
  if (/接触过模型/.test(value)) return true;
  if (/视觉主要解决.*问题|视觉.*解决啥问题/.test(value)) return true;
  if (/主要工作内容是啥|工作内容是啥|主要负责做什么/.test(value)) return /(产品|AI|职责|工作内容)/i.test(context + value);
  if (/他对我们的需求呢|对我们的需求呢/.test(value)) return /(客户|社交|AI应用|需求|两类客户)/i.test(context + value);
  return false;
}

function shouldPreferCandidateText(existingText, nextText, candidate = {}) {
  const existingLength = compactQuestionKey(existingText).length;
  const nextLength = compactQuestionKey(nextText).length;
  return nextLength > existingLength * 1.12 || (candidate.confirmed && !candidate.existingConfirmed);
}

function hasQuestionContextSupport(questionText, contexts) {
  if (isCanonicalShortInterviewQuestion(questionText)) return true;
  const questionTerms = supportTerms(questionText);
  if (!questionTerms.size) return true;
  const contextTerms = supportTerms((contexts || []).join("\n"));
  let hits = 0;
  for (const term of questionTerms) {
    if (contextTerms.has(term)) hits += 1;
  }
  if (hits >= Math.min(2, questionTerms.size)) return true;
  if (hits >= 1 && questionTerms.size <= 2) return true;
  return false;
}

function isSelfContainedQuestion(text) {
  const value = stripQuestionEnding(compactQuestionKey(text));
  if (!value || isNoiseText(value)) return false;
  if (isCanonicalShortInterviewQuestion(value)) return true;
  if (isWeakQuestion(value)) return false;
  if (value.length >= 18) return true;
  return value.length >= 10 && hasDomainAnchor(text);
}

function pruneByTime(items, receivedAt, windowMs) {
  return (items ?? []).filter((item) => receivedAt - Number(item.receivedAt || receivedAt) <= windowMs);
}

function trimTextWindow(lines, maxChars) {
  const selected = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = String(lines[index] ?? "").trim();
    if (!line) continue;
    if (selected.length > 0 && total + line.length + 1 > maxChars) break;
    selected.push(line);
    total += line.length + 1;
  }
  return selected.reverse().join("\n").slice(-maxChars);
}

function normalizeQuestionText(text) {
  const value = String(text ?? "").replace(/\s+/g, "").trim();
  if (!value) return "";
  return /[？?]$/.test(value) ? value : `${value}？`;
}

function completeContextualWeakQuestion(localQuestion, sourceText, candidateContext) {
  const local = compactQuestionKey(localQuestion);
  const context = compactQuestionKey(`${sourceText}\n${candidateContext}`);
  if (!local || !context) return "";
  if (/(标签的效果|标签效果|标签能力)/.test(context) && /(标签|效果|能力|维度|评价|是吧)/.test(local)) {
    return "标签能力的效果应该从哪些维度评价？";
  }
  if (/(模型效果不好|识别类模型效果|准确率不足|召回率|误杀)/.test(context) && /(主要原因|原因有哪些|你觉得是什么)/.test(local)) {
    return "识别类模型效果不好的主要原因有哪些？";
  }
  if (/(产品形态|合同评审|标书审核|AI产品)/.test(context) && /(用户怎么用|他们怎么用|怎么用)/.test(local)) {
    return "你设计的AI产品具体是怎么被用户使用的？";
  }
  return "";
}

class InterviewQuestionEngine {
  constructor(options = {}) {
    this.confirmQuestion = options.confirmQuestion;
    this.mergeDecider = options.mergeDecider;
    this.contextWindowMs = Number(options.contextWindowMs || DEFAULT_CONTEXT_WINDOW_MS);
    this.maxInterviewerChars = Number(options.maxInterviewerChars || DEFAULT_MAX_INTERVIEWER_CHARS);
    this.maxCandidateChars = Number(options.maxCandidateChars || DEFAULT_MAX_CANDIDATE_CHARS);
    this.duplicateWindowMs = Number(options.duplicateWindowMs || DEFAULT_DUPLICATE_WINDOW_MS);
    this.topicWindowMs = Number(options.topicWindowMs || DEFAULT_TOPIC_WINDOW_MS);
    this.weakPendingMs = Number(options.weakPendingMs || DEFAULT_WEAK_PENDING_MS);
    this.interviewerBuffer = [];
    this.candidateSegments = [];
    this.finalQuestions = [];
    this.pendingWeakQuestions = [];
    this.mergeDecisionCache = new Map();
    this.lastPartial = null;
    this.processing = Promise.resolve();
  }

  reset() {
    this.interviewerBuffer = [];
    this.candidateSegments = [];
    this.finalQuestions = [];
    this.pendingWeakQuestions = [];
    this.mergeDecisionCache = new Map();
    this.lastPartial = null;
    this.processing = Promise.resolve();
  }

  rememberCandidate(event) {
    const receivedAt = Number(event.receivedAt || Date.now());
    const text = String(event.rewrittenText || event.text || "").trim();
    if (!text) return;
    this.candidateSegments = pruneByTime([...this.candidateSegments, { text, receivedAt }], receivedAt, this.contextWindowMs);
  }

  rememberInterviewer(event) {
    const receivedAt = Number(event.receivedAt || Date.now());
    const rawText = String(event.rewrittenText || event.text || "").trim();
    const text = rawText || rewriteTranscriptText(event.text);
    if (!text) return null;
    const next = { text, rewrittenText: text, receivedAt };
    this.interviewerBuffer = pruneByTime([...this.interviewerBuffer, next], receivedAt, this.contextWindowMs);
    return next;
  }

  buildInterviewerContext(extraSegments = []) {
    const lines = [...this.interviewerBuffer, ...extraSegments]
      .map((item) => String(item?.rewrittenText || item?.text || "").trim())
      .filter(Boolean);
    return trimTextWindow(lines, this.maxInterviewerChars).replace(/\n/g, "。");
  }

  buildCandidateContext(receivedAt = Date.now()) {
    this.candidateSegments = pruneByTime(this.candidateSegments, receivedAt, this.contextWindowMs);
    return trimTextWindow(this.candidateSegments.map((item) => `我：${item.text}`), this.maxCandidateChars);
  }

  inferLocalQuestion(extraSegments = []) {
    const segments = [...this.interviewerBuffer, ...extraSegments];
    const inferredList = inferQuestionsFromSegments(segments, {
      maxSegments: 80,
      maxChars: this.maxInterviewerChars,
    }) || [];
    return inferredList.at(-1) ?? null;
  }

  enrichCandidate(candidate) {
    const modelQuestionType = normalizeQuestionType(candidate.questionType);
    const questionType = modelQuestionType !== "unknown"
      ? modelQuestionType
      : classifyQuestionType(candidate.questionText, candidate.sourceText);
    const domainAnchors = candidate.domainAnchors?.length
      ? candidate.domainAnchors
      : extractDomainAnchors(`${candidate.questionText}\n${candidate.sourceText}`);
    return {
      ...candidate,
      questionType,
      domainAnchors,
      topicId: candidate.topicId || buildTopicId(questionType, domainAnchors),
      evidenceTerms: mergeUniqueArray(candidate.evidenceTerms, businessEvidenceTerms(`${candidate.questionText}\n${candidate.sourceText}`)).slice(0, 12),
    };
  }

  rememberPendingWeakQuestion(localQuestion, sourceText, candidateContext, receivedAt) {
    const questionType = classifyQuestionType(localQuestion, sourceText);
    const domainAnchors = extractDomainAnchors(`${localQuestion}\n${sourceText}`);
    const pending = {
      pendingId: `weak-${receivedAt}-${hashText(localQuestion)}`,
      questionText: localQuestion,
      sourceText,
      candidateContext,
      questionType,
      domainAnchors,
      topicId: buildTopicId(questionType, domainAnchors),
      receivedAt,
      reason: "pending_weak",
    };
    const key = compactQuestionKey(localQuestion);
    const existing = this.pendingWeakQuestions.find((item) => (
      compactQuestionKey(item.questionText) === key
      && receivedAt - Number(item.receivedAt || receivedAt) <= this.weakPendingMs
    ));
    if (existing) {
      existing.sourceText = mergeUniqueText(existing.sourceText, sourceText);
      existing.candidateContext = mergeUniqueText(existing.candidateContext, candidateContext, this.maxCandidateChars);
      existing.receivedAt = receivedAt;
      return existing;
    }
    this.pendingWeakQuestions = pruneByTime([...this.pendingWeakQuestions, pending], receivedAt, this.weakPendingMs);
    return pending;
  }

  consumeAbsorbableWeakQuestions(candidate, receivedAt) {
    const kept = [];
    const absorbed = [];
    for (const pending of this.pendingWeakQuestions) {
      const age = receivedAt - Number(pending.receivedAt || receivedAt);
      if (age > this.weakPendingMs) continue;
      const sameType = pending.questionType === "unknown" || candidate.questionType === "unknown"
        ? false
        : pending.questionType === candidate.questionType;
      const overlap = anchorOverlap(pending.domainAnchors, candidate.domainAnchors);
      const shouldAbsorb = sameType
        || overlap > 0
        || (candidate.questionType === "product_usage" && /产品|平台|用户|怎么用/.test(compactQuestionKey(pending.questionText)))
        || (candidate.questionType === "process_flow" && /审完|流程|评审|审核/.test(compactQuestionKey(pending.questionText)))
        || (candidate.questionType === "root_cause" && /原因|指的是什么|是什么意思/.test(compactQuestionKey(pending.questionText)))
        || (candidate.questionType === "tag_evaluation" && /标签|效果|能力/.test(compactQuestionKey(pending.questionText)));
      if (shouldAbsorb) {
        absorbed.push(pending);
      } else {
        kept.push(pending);
      }
    }
    this.pendingWeakQuestions = kept;
    return absorbed;
  }

  deterministicMergeDecision(candidate, existing, receivedAt) {
    const key = compactQuestionKey(candidate.questionText);
    const existingKey = compactQuestionKey(existing.questionText);
    if (!key || !existingKey) return null;
    const age = receivedAt - Number(existing.updatedAt || existing.receivedAt || receivedAt);
    const similarity = questionSimilarity(candidate.questionText, existing.questionText);
    if (age <= this.duplicateWindowMs) {
      if (existingKey === key) return { sameQuestion: true, reason: "exact_duplicate", confidence: 1 };
      if (existingKey.includes(key) || key.includes(existingKey)) return { sameQuestion: true, reason: "contained_duplicate", confidence: 0.94 };
      if (similarity >= 0.82) return { sameQuestion: true, reason: "near_duplicate", confidence: similarity };
    }
    if (age > this.topicWindowMs) return null;
    const sameType = candidate.questionType && candidate.questionType !== "unknown" && candidate.questionType === existing.questionType;
    const overlap = anchorOverlap(candidate.domainAnchors, existing.domainAnchors);
    if (isContractJudgementFamily(candidate.questionText) && isContractJudgementFamily(existing.questionText)) {
      return { sameQuestion: true, reason: "topic_merge_contract_model_judgement", confidence: Math.max(0.78, similarity) };
    }
    if (isRecognitionFailureFamily(candidate.questionText) && isRecognitionFailureFamily(existing.questionText)) {
      const candidateKind = recognitionFailureMergeKind(candidate.questionText);
      const existingKind = recognitionFailureMergeKind(existing.questionText);
      if (candidateKind && candidateKind === existingKind) {
        return { sameQuestion: true, reason: `topic_merge_recognition_failure_${candidateKind}`, confidence: Math.max(0.76, similarity) };
      }
    }
    if (sameType && overlap > 0 && similarity >= 0.68) {
      return { sameQuestion: true, reason: "topic_merge_similarity", confidence: similarity };
    }
    if (sameType && overlap >= 2 && similarity >= 0.58) {
      return { sameQuestion: true, reason: "topic_merge_anchor_overlap", confidence: similarity };
    }
    if (sameType && overlap > 0 && similarity >= 0.52) {
      return { sameQuestion: "borderline", reason: "borderline_topic_merge", confidence: similarity };
    }
    return null;
  }

  async modelMergeDecision(candidate, existing) {
    if (typeof this.mergeDecider !== "function") return null;
    const left = compactQuestionKey(candidate.questionText);
    const right = compactQuestionKey(existing.questionText);
    if (!left || !right) return null;
    const cacheKey = [left, right].sort().join("|");
    if (this.mergeDecisionCache.has(cacheKey)) return this.mergeDecisionCache.get(cacheKey);
    let decision = null;
    try {
      decision = await this.mergeDecider({
        question: candidate.questionText,
        existingQuestion: existing.questionText,
        sourceText: candidate.sourceText,
        existingSourceText: existing.sourceText,
        candidateContext: candidate.candidateContext || "",
        questionType: candidate.questionType,
        domainAnchors: candidate.domainAnchors,
        existingQuestionType: existing.questionType,
        existingDomainAnchors: existing.domainAnchors,
      });
    } catch (error) {
      decision = { sameQuestion: false, reason: `merge_model_error:${String(error?.message || error).slice(0, 40)}` };
    }
    const normalized = {
      sameQuestion: decision?.sameQuestion === true || decision?.same_question === true,
      reason: decision?.reason || decision?.r || "model_merge_decision",
      confidence: Math.max(0, Math.min(0.98, Number(decision?.confidence ?? decision?.c) || 0)),
    };
    this.mergeDecisionCache.set(cacheKey, normalized);
    if (this.mergeDecisionCache.size > 100) {
      this.mergeDecisionCache.delete(this.mergeDecisionCache.keys().next().value);
    }
    return normalized;
  }

  async findMergeTarget(candidate, receivedAt) {
    const enriched = this.enrichCandidate(candidate);
    for (let index = this.finalQuestions.length - 1; index >= 0; index -= 1) {
      const existing = this.finalQuestions[index];
      const decision = this.deterministicMergeDecision(enriched, existing, receivedAt);
      if (!decision) continue;
      if (decision.sameQuestion === true) return { existing, decision };
      if (decision.sameQuestion === "borderline") {
        const modelDecision = await this.modelMergeDecision(enriched, existing);
        if (modelDecision?.sameQuestion) {
          const overlap = anchorOverlap(enriched.domainAnchors, existing.domainAnchors);
          if (overlap > 0 || evidenceOverlapCount(enriched.questionText, [existing.questionText, existing.sourceText]) >= 1) {
            return {
              existing,
              decision: {
                ...modelDecision,
                reason: modelDecision.reason || decision.reason,
              },
            };
          }
        }
      }
    }
    return null;
  }

  applyMerge(existing, candidate, receivedAt, decision) {
    const candidateConfirmed = Boolean(candidate.confirmed);
    const preferCandidate = shouldPreferCandidateText(existing.questionText, candidate.questionText, {
      confirmed: candidateConfirmed,
      existingConfirmed: existing.confirmed,
    });
    if (preferCandidate) {
      existing.questionText = candidate.questionText;
      existing.localQuestionText = candidate.localQuestionText || existing.localQuestionText;
      existing.confirmedQuestionText = candidateConfirmed ? candidate.questionText : existing.confirmedQuestionText;
    }
    existing.sourceText = mergeUniqueText(existing.sourceText, candidate.sourceText || candidate.questionText);
    existing.candidateContext = mergeUniqueText(existing.candidateContext, candidate.candidateContext, this.maxCandidateChars);
    existing.confidence = Math.max(Number(existing.confidence || 0), Number(candidate.confidence || 0));
    existing.reason = candidate.reason || existing.reason;
    existing.confirmed = Boolean(existing.confirmed || candidateConfirmed);
    existing.questionType = existing.questionType || candidate.questionType;
    existing.domainAnchors = mergeUniqueArray(existing.domainAnchors, candidate.domainAnchors).sort();
    existing.topicId = existing.topicId || buildTopicId(existing.questionType, existing.domainAnchors);
    existing.evidenceTerms = mergeUniqueArray(existing.evidenceTerms, candidate.evidenceTerms).slice(0, 12);
    existing.mergedFrom = [
      ...(existing.mergedFrom || []),
      {
        questionText: candidate.questionText,
        localQuestionText: candidate.localQuestionText || "",
        sourceText: candidate.sourceText || "",
        receivedAt,
        confidence: candidate.confidence,
        reason: decision?.reason || "merged_duplicate",
      },
    ];
    existing.absorbedFrom = [
      ...(existing.absorbedFrom || []),
      ...(candidate.absorbedFrom || []),
    ];
    existing.mergeReason = decision?.reason || "merged_duplicate";
    existing.updatedAt = receivedAt;
    this.interviewerBuffer = [];
    return {
      type: "question_updated",
      question: existing,
      mergeReason: existing.mergeReason,
    };
  }

  async rememberFinalQuestion(candidate, receivedAt) {
    const enriched = this.enrichCandidate(candidate);
    const mergeTarget = await this.findMergeTarget(enriched, receivedAt);
    if (mergeTarget?.existing) {
      return this.applyMerge(mergeTarget.existing, enriched, receivedAt, mergeTarget.decision);
    }

    const questionId = `question-${receivedAt}-${hashText(enriched.questionText)}`;
    const question = {
      questionId,
      questionText: enriched.questionText,
      localQuestionText: enriched.localQuestionText || enriched.questionText,
      confirmedQuestionText: enriched.confirmed ? enriched.questionText : "",
      sourceText: enriched.sourceText || enriched.questionText,
      candidateContext: enriched.candidateContext || "",
      confidence: enriched.confidence ?? 0.78,
      reason: enriched.reason || (enriched.confirmed ? "方舟确认" : "本地推断"),
      confirmed: Boolean(enriched.confirmed),
      questionType: enriched.questionType,
      topicId: enriched.topicId,
      domainAnchors: enriched.domainAnchors,
      mergedFrom: enriched.mergedFrom || [],
      absorbedFrom: enriched.absorbedFrom || [],
      evidenceTerms: enriched.evidenceTerms || [],
      mergeReason: enriched.mergeReason || "",
      receivedAt,
      updatedAt: receivedAt,
    };
    this.finalQuestions.push(question);
    this.finalQuestions = pruneByTime(this.finalQuestions, receivedAt, 15 * 60 * 1000).slice(-80);
    this.interviewerBuffer = [];
    return { type: "question_finalized", question };
  }

  async confirmOrFallback(local, sourceText, candidateContext, receivedAt) {
    const localQuestion = normalizeQuestionText(local?.questionText || "");
    if (!localQuestion || isNoiseText(localQuestion)) {
      return { rejected: true, reason: "noise_or_empty", localQuestion };
    }
    if (isAbsorbableWeakQuestion(localQuestion) && !completeContextualWeakQuestion(localQuestion, sourceText, candidateContext)) {
      this.rememberPendingWeakQuestion(localQuestion, sourceText, candidateContext, receivedAt);
      return {
        rejected: true,
        pending: true,
        reason: "pending_weak",
        localQuestion,
      };
    }

    const localFallback = (reason) => ({
      questionText: localQuestion,
      localQuestionText: localQuestion,
      sourceText,
      candidateContext,
      confidence: local.confidence,
      reason,
      confirmed: false,
      questionType: classifyQuestionType(localQuestion, sourceText),
      domainAnchors: extractDomainAnchors(`${localQuestion}\n${sourceText}`),
      evidenceTerms: businessEvidenceTerms(`${localQuestion}\n${sourceText}`).slice(0, 12),
    });
    const contextualQuestion = normalizeQuestionText(completeContextualWeakQuestion(localQuestion, sourceText, candidateContext));
    if (contextualQuestion && isSelfContainedQuestion(contextualQuestion)) {
      const questionType = classifyQuestionType(contextualQuestion, sourceText);
      const domainAnchors = extractDomainAnchors(`${contextualQuestion}\n${sourceText}`);
      return {
        questionText: contextualQuestion,
        localQuestionText: localQuestion,
        sourceText,
        candidateContext,
        confidence: Math.max(0.84, Number(local.confidence || 0)),
        reason: "本地上下文补全",
        confirmed: false,
        questionType,
        domainAnchors,
        evidenceTerms: businessEvidenceTerms(`${contextualQuestion}\n${sourceText}`).slice(0, 12),
      };
    }
    const previousQuestions = this.finalQuestions.slice(-5).map((item) => item.questionText);
    if (typeof this.confirmQuestion === "function") {
      let confirmed = null;
      try {
        confirmed = await this.confirmQuestion({
          sourceText,
          localQuestion,
          previousQuestions,
          candidateContext,
        });
      } catch (error) {
        if (Number(local.confidence || 0) >= 0.84 && isSelfContainedQuestion(localQuestion)) {
          return localFallback(`方舟确认异常，本地高置信兜底：${String(error?.message || error).slice(0, 40)}`);
        }
        return {
          rejected: true,
          reason: "model_error",
          localQuestion,
          message: String(error?.message || error),
        };
      }
      if (!confirmed?.questionText) {
        if (isAcceptableShortBusinessQuestion(localQuestion, sourceText, previousQuestions)) {
          return localFallback("方舟拒绝，本地短业务追问兜底");
        }
        if (Number(local.confidence || 0) >= 0.84 && isSelfContainedQuestion(localQuestion)) {
          return localFallback("本地高置信兜底");
        }
        return { rejected: true, reason: "model_rejected", localQuestion };
      }
      const confirmedQuestion = normalizeQuestionText(confirmed.questionText);
      if (!isSelfContainedQuestion(confirmedQuestion)) {
        if (isAcceptableShortBusinessQuestion(confirmedQuestion, sourceText, previousQuestions)) {
          const questionType = classifyQuestionType(confirmedQuestion, sourceText);
          const domainAnchors = extractDomainAnchors(`${confirmedQuestion}\n${sourceText}`);
          return {
            questionText: confirmedQuestion,
            localQuestionText: localQuestion,
            sourceText: confirmed.sourceText || sourceText,
            candidateContext,
            confidence: confirmed.confidence ?? local.confidence ?? 0.76,
            reason: confirmed.reason || "方舟短业务追问确认",
            confirmed: true,
            questionType,
            domainAnchors,
            evidenceTerms: mergeUniqueArray(confirmed.evidenceTerms, businessEvidenceTerms(`${confirmedQuestion}\n${sourceText}`)).slice(0, 12),
          };
        }
        if (Number(local.confidence || 0) >= 0.84 && isSelfContainedQuestion(localQuestion)) {
          return localFallback("方舟低信息，本地高置信兜底");
        }
        return { rejected: true, reason: "model_low_information", localQuestion, confirmedQuestion };
      }
      const hasEvidenceSupport = hasEvidenceBoundSupport(confirmedQuestion, { sourceText, localQuestion, candidateContext })
        || hasFollowupTopicSupport(confirmedQuestion, { sourceText, localQuestion, previousQuestions });
      if (!hasEvidenceSupport) {
        if (isAcceptableShortBusinessQuestion(confirmedQuestion, sourceText, previousQuestions)) {
          const questionType = classifyQuestionType(confirmedQuestion, sourceText);
          const domainAnchors = extractDomainAnchors(`${confirmedQuestion}\n${sourceText}`);
          return {
            questionText: confirmedQuestion,
            localQuestionText: localQuestion,
            sourceText: confirmed.sourceText || sourceText,
            candidateContext,
            confidence: confirmed.confidence ?? local.confidence ?? 0.76,
            reason: confirmed.reason || "方舟短业务追问确认",
            confirmed: true,
            questionType,
            domainAnchors,
            evidenceTerms: mergeUniqueArray(confirmed.evidenceTerms, businessEvidenceTerms(`${confirmedQuestion}\n${sourceText}`)).slice(0, 12),
          };
        }
        if (Number(local.confidence || 0) >= 0.84 && isSelfContainedQuestion(localQuestion)) {
          return localFallback("方舟证据不匹配，本地高置信兜底");
        }
        return {
          rejected: true,
          reason: "model_evidence_mismatch",
          localQuestion,
          confirmedQuestion,
          rejectReason: confirmed.rejectReason || confirmed.reason || "confirmed_question_lacks_source_evidence",
        };
      }
      if (!hasQuestionContextSupport(confirmedQuestion, [sourceText, localQuestion, candidateContext])) {
        if (Number(local.confidence || 0) >= 0.84 && isSelfContainedQuestion(localQuestion)) {
          return localFallback("方舟上下文不匹配，本地高置信兜底");
        }
        return { rejected: true, reason: "model_context_mismatch", localQuestion, confirmedQuestion };
      }
      const modelQuestionType = normalizeQuestionType(confirmed.questionType);
      const questionType = modelQuestionType !== "unknown" ? modelQuestionType : classifyQuestionType(confirmedQuestion, sourceText);
      const domainAnchors = extractDomainAnchors(`${confirmedQuestion}\n${sourceText}`);
      return {
        questionText: confirmedQuestion,
        localQuestionText: localQuestion,
        sourceText: confirmed.sourceText || sourceText,
        candidateContext,
        confidence: confirmed.confidence ?? local.confidence ?? 0.78,
        reason: confirmed.reason || "方舟确认",
        confirmed: true,
        questionType,
        domainAnchors,
        evidenceTerms: mergeUniqueArray(confirmed.evidenceTerms, businessEvidenceTerms(`${confirmedQuestion}\n${sourceText}`)).slice(0, 12),
      };
    }

    if (Number(local.confidence || 0) >= 0.82 && isSelfContainedQuestion(localQuestion)) {
      return localFallback(local.reason || "本地推断");
    }
    if (isAcceptableShortBusinessQuestion(localQuestion, sourceText, previousQuestions || [])) {
      return localFallback("本地短业务追问兜底");
    }
    return { rejected: true, reason: "local_low_information", localQuestion };
  }

  processPartial(event) {
    const receivedAt = Number(event.receivedAt || Date.now());
    const text = rewriteTranscriptText(event.rewrittenText || event.text || "");
    if (!text || isNoiseText(text) || !hasQuestionCue(text)) return [];
    const partialSegment = { text, rewrittenText: text, receivedAt };
    const local = this.inferLocalQuestion([partialSegment]);
    if (!local?.questionText) return [];
    const questionText = normalizeQuestionText(local.questionText);
    if (!isSelfContainedQuestion(questionText)) return [];
    const key = compactQuestionKey(questionText);
    if (this.lastPartial?.key === key && receivedAt - this.lastPartial.receivedAt < 2500) return [];
    this.lastPartial = { key, receivedAt };
    return [{
      type: "partial_preview",
      question: {
        questionId: "question-live",
        questionText,
        localQuestionText: questionText,
        sourceText: this.buildInterviewerContext([partialSegment]),
        confidence: local.confidence,
        reason: local.reason || "本地临时推断",
        questionType: classifyQuestionType(questionText, text),
        domainAnchors: extractDomainAnchors(`${questionText}\n${text}`),
        receivedAt,
      },
    }];
  }

  async processFinal(event) {
    const receivedAt = Number(event.receivedAt || Date.now());
    const text = rewriteTranscriptText(event.rewrittenText || event.text || "");
    if (!text) return [];
    if (isNoiseText(text)) {
      return [{ type: "question_rejected", reason: "noise", questionText: text, receivedAt }];
    }
    const segment = this.rememberInterviewer({ ...event, rewrittenText: text });
    if (!segment) return [];
    const sourceText = this.buildInterviewerContext();
    if (!hasQuestionCue(sourceText)) return [];
    const local = this.inferLocalQuestion();
    if (!local?.questionText) {
      return [{ type: "question_rejected", reason: "no_local_question", sourceText, receivedAt }];
    }
    const candidateContext = this.buildCandidateContext(receivedAt);
    const candidate = await this.confirmOrFallback(local, sourceText, candidateContext, receivedAt);
    if (candidate.rejected) {
      return [{ type: "question_rejected", ...candidate, sourceText, receivedAt }];
    }
    const enrichedCandidate = this.enrichCandidate(candidate);
    const absorbed = this.consumeAbsorbableWeakQuestions(enrichedCandidate, receivedAt);
    if (absorbed.length) {
      enrichedCandidate.absorbedFrom = [
        ...(enrichedCandidate.absorbedFrom || []),
        ...absorbed.map((item) => ({
          pendingId: item.pendingId,
          questionText: item.questionText,
          sourceText: item.sourceText,
          receivedAt: item.receivedAt,
          reason: item.reason,
        })),
      ];
      enrichedCandidate.sourceText = absorbed.reduce(
        (text, item) => mergeUniqueText(text, item.sourceText),
        enrichedCandidate.sourceText,
      );
    }
    const finalized = await this.rememberFinalQuestion(enrichedCandidate, receivedAt);
    const targetQuestionId = finalized?.question?.questionId || "";
    return [
      finalized,
      ...absorbed.map((item) => ({
        type: "question_absorbed",
        pendingId: item.pendingId,
        questionText: item.questionText,
        sourceText: item.sourceText,
        receivedAt: item.receivedAt,
        targetQuestionId,
        targetQuestionText: finalized?.question?.questionText || enrichedCandidate.questionText,
        reason: "absorbed_into_topic_question",
      })),
    ];
  }

  async processEventNow(event) {
    if (!event?.type) return [];
    if (event.type === "candidate_final") {
      this.rememberCandidate(event);
      return [];
    }
    if (event.type === "interviewer_partial") return this.processPartial(event);
    if (event.type === "interviewer_final") return this.processFinal(event);
    return [];
  }

  processEvent(event) {
    const run = () => this.processEventNow(event);
    const next = this.processing.then(run, run);
    this.processing = next.catch(() => {});
    return next;
  }
}

module.exports = {
  InterviewQuestionEngine,
  compactQuestionKey,
  hasQuestionCue,
  isNoiseText,
  classifyQuestionType,
  extractDomainAnchors,
  isSelfContainedQuestion,
  isWeakQuestion,
  questionSimilarity,
};
