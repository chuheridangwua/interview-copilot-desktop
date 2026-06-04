const fs = require("node:fs");
const path = require("node:path");

function splitAnswerSections(answer) {
  const logicMarker = "回答逻辑：";
  const detailMarker = "具体内容：";
  const logicStart = answer.indexOf(logicMarker);
  if (logicStart < 0) return { answerLogic: "", answerDetail: answer.trim() };
  const logicContentStart = logicStart + logicMarker.length;
  const detailStart = answer.indexOf(detailMarker, logicContentStart);
  if (detailStart < 0) {
    return { answerLogic: answer.slice(logicContentStart).trim(), answerDetail: "" };
  }
  return {
    answerLogic: answer.slice(logicContentStart, detailStart).trim(),
    answerDetail: answer.slice(detailStart + detailMarker.length).trim(),
  };
}

function parseQuestionBank(content, options = {}) {
  const source = options.source || "base";
  const sourceLabel = options.sourceLabel || (source === "company" ? "公司" : "通用");
  const idOffset = Number(options.idOffset || 0);
  const heading = /^(\d+)\.\s+(.+)$/gm;
  const matches = [...content.matchAll(heading)];
  return matches
    .map((match, index) => {
      const sourceQuestionId = Number(match[1]);
      const next = matches[index + 1];
      const answerStart = match.index + match[0].length;
      const answerEnd = next ? next.index : content.length;
      const answer = content.slice(answerStart, answerEnd).trim();
      const { answerLogic, answerDetail } = splitAnswerSections(answer);
      return {
        id: sourceQuestionId + idOffset,
        source,
        sourceLabel,
        sourceQuestionId: source === "company" ? sourceQuestionId : undefined,
        question: match[2].trim(),
        answer,
        answerLogic,
        answerDetail,
      };
    })
    .filter((item) => item.id && item.question && item.answer);
}

const curatedHints = new Map([
  [2, ["前端开发", "转向", "转型", "AI产品经理", "产品经理", "适合做产品", "为什么做产品", "技术转产品"]],
  [3, ["产品能力", "需求拆解", "价值判断", "持续迭代", "技术背景", "产品优势"]],
  [4, ["离开", "离职", "国企", "传统制造业", "薪资", "机会"]],
  [5, ["期望薪资", "薪资", "工资", "给不到", "多少钱", "待遇", "薪酬"]],
  [6, ["职业规划", "未来规划", "1到3年", "发展方向", "短期目标", "中期目标"]],
  [7, ["优势", "短板", "缺点", "候选人", "竞争力"]],
  [8, ["代表项目", "AI产品项目", "项目介绍", "合同评审", "投标评审"]],
  [9, ["badcase", "反馈", "迭代", "机制", "准确率", "评测集", "标错", "漏标"]],
  [10, ["负责什么", "团队分工", "关键决策", "产品负责人", "职责"]],
  [17, ["badcase", "负反馈", "收集", "迭代", "优化", "评测集", "准确率"]],
  [20, ["合同评审", "投标评审", "合同", "标书", "风险报告", "流程", "项目", "合同投标智能评审", "智能评审", "合同审核", "投标审核", "标书审核", "千页级标书", "资质证照", "多源上传", "内容解析", "要求抽取", "多模态检索", "多Agent核查", "人工复核", "结果批注导出", "初审周期", "废标风险"]],
  [22, ["商机智能推送平台", "商机智能推送", "商机推送平台", "商机推送", "商机平台", "商机解析", "招采信息", "招标采购", "招标信息", "采购线索", "线索分散", "高价值商机", "外部数据采集", "去重", "匿名详情初筛", "候选详情复核", "AI结构化评分", "商机入库", "钉钉通知", "企业画像", "目标商机", "主营产品", "项目金额", "风险因素", "业务匹配", "产品匹配", "中标概率", "推荐度", "有效商机", "市场销售投标", "全国先进计算技术创新大赛银牌"]],
  [23, ["集团AI中台", "集团 AI 中台", "AI中台", "AI 中台", "云端智能体平台", "智能体平台", "集团AI统一接入层", "统一接入层", "模型分发", "模型映射", "模型路由", "渠道配置", "健康监控", "失败切换", "用量日志", "AI网关", "模型接入", "统一权限体系", "API分发", "成本监控", "异常处理", "钉钉统一登录", "组织体系", "权限映射", "智能体工作台", "CRM", "文书处理", "多场景复用"]],
  [24, ["rag", "RAG", "复杂PDF", "PDF", "表格", "扫描件", "OCR", "知识库", "幻觉", "切片", "召回", "重排序", "向量"]],
  [25, ["agent", "Agent", "workflow", "Workflow", "tool", "Tool", "mcp", "MCP", "function calling", "Function Calling", "函数调用", "工作流", "LangChain", "LangGraph", "Langfuse", "n8n", "Dify", "工具调用", "短期会话记忆", "长期经验库", "SOP", "运维智能体", "截图识别", "知识库检索"]],
]);

const resumeProjectHotwords = [
  "山东金钟",
  "山东金钟科技集团",
  "金钟科技",
  "集团AI中台",
  "集团 AI 中台",
  "AI中台",
  "AI 中台",
  "云端智能体平台",
  "智能体平台",
  "统一接入层",
  "合同投标智能评审",
  "合同/投标智能评审",
  "合同评审",
  "投标评审",
  "智能评审",
  "商机智能推送平台",
  "商机智能推送",
  "商机推送平台",
  "商机推送",
  "商机平台",
  "商机解析",
  "招采信息",
  "招标采购",
  "采购线索",
  "运维智能体",
  "运维值守",
  "云端智能体",
  "CRM",
  "文书处理",
  "企业画像",
  "AI结构化评分",
  "中标概率",
  "推荐度",
  "钉钉通知",
  "模型分发",
  "模型路由",
  "健康监控",
  "失败切换",
  "用量日志",
  "AI网关",
  "LangChain",
  "LangGraph",
  "Langfuse",
  "Dify",
  "n8n",
  "MCP",
  "SOP",
  "经验库",
];

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[，。！？；：、（）【】《》“”"'`~!?,.;:()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rewriteTranscriptText(text) {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(^|[，。！？；、\s])(嗯|呃|额|啊|噢|哦)(?=$|[，。！？；、\s])/g, "$1")
    .replace(/([，。！？；、]){2,}/g, "$1")
    .replace(/\s*([，。！？；：、])\s*/g, "$1")
    .replace(/^\s*[，。！？；、]+/, "")
    .replace(/[，,、]+$/, "")
    .trim();
}

function tokenize(text) {
  const normalized = normalize(text);
  const result = new Set();
  for (const item of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (item.length >= 2) result.add(item);
  }
  const chinese = [...normalized.replace(/[^\u4e00-\u9fa5]/g, "")];
  for (const ch of chinese) result.add(ch);
  for (let i = 0; i < chinese.length - 1; i += 1) {
    result.add(chinese.slice(i, i + 2).join(""));
  }
  for (let i = 0; i < chinese.length - 2; i += 1) {
    result.add(chinese.slice(i, i + 3).join(""));
  }
  return result;
}

function dedupe(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const cleaned = String(value ?? "").trim();
    if (!cleaned) continue;
    const key = normalize(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function compactText(text) {
  return String(text ?? "").replace(/\s+/g, "");
}

function hasResumeProjectHotword(text) {
  const value = compactText(text).toLowerCase();
  if (!value) return false;
  return resumeProjectHotwords.some((hotword) => {
    const item = compactText(hotword).toLowerCase();
    return item && value.includes(item);
  });
}

function isProjectIntroIntent(text) {
  return /(简单)?介绍一下|讲一下|说一下|聊一下|聊聊|介绍介绍|讲讲|说说|介绍.*呗|讲.*呗|说.*呗/.test(String(text ?? ""));
}

function canonicalProjectQuestion(text) {
  const value = compactText(text);
  if (!value) return "";
  if (/商机.*(推送|平台|解析)|招采|招标采购|采购线索/.test(value)) {
    return "请介绍一下商机智能推送平台？";
  }
  if (/(集团)?AI中台|云端智能体平台|智能体平台|统一接入层/.test(value)) {
    return "请介绍一下集团AI中台和云端智能体平台？";
  }
  if (/合同.*投标.*(评审|审核)|合同评审|投标评审|智能评审/.test(value)) {
    return "请介绍一下合同投标智能评审项目？";
  }
  if (/运维智能体|运维值守|经验库|SOP/.test(value)) {
    return "请介绍一下运维智能体项目？";
  }
  return "";
}

const lowSignalTokens = new Set([
  "你",
  "们",
  "我",
  "想",
  "问",
  "为",
  "什",
  "么",
  "怎",
  "如",
  "何",
  "可",
  "以",
  "能",
  "不",
  "请",
  "说",
  "讲",
  "聊",
  "题",
  "问一",
  "一下",
  "为什",
  "什么",
  "为什么",
  "怎么",
  "如何",
  "介绍",
  "说一下",
  "讲一下",
  "聊一下",
  "请问",
  "能不能",
  "可不可以",
  "问题",
]);

function isSingleChineseToken(token) {
  return /^[\u4e00-\u9fa5]$/.test(token);
}

function tokenScoreWeight(token, idf) {
  const base = idf.get(token) ?? 1;
  if (lowSignalTokens.has(token)) return base * 0.12;
  if (isSingleChineseToken(token)) return base * 0.28;
  return base;
}

function isUsefulHitToken(token) {
  return [...token].length >= 2 && !lowSignalTokens.has(token);
}

function vectorize(tokens, idf) {
  const vector = new Map();
  for (const token of tokens) vector.set(token, (vector.get(token) ?? 0) + tokenScoreWeight(token, idf));
  return vector;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of a.values()) normA += value * value;
  for (const value of b.values()) normB += value * value;
  for (const [token, value] of a) dot += value * (b.get(token) ?? 0);
  if (!normA || !normB) return 0;
  return dot / Math.sqrt(normA * normB);
}

function itemCuratedHints(item) {
  if (item.source && item.source !== "base") return [];
  return curatedHints.get(item.id) ?? [];
}

function hintHits(query, item) {
  const queryNorm = normalize(query);
  const itemHints = itemCuratedHints(item);
  return itemHints.filter((hint) => {
    const hintNorm = normalize(hint);
    return queryNorm.includes(hintNorm) || hintNorm.includes(queryNorm);
  });
}

function candidateFromItem(item, score, hitTerms, highlightTerms = []) {
  return {
    id: item.id,
    question: item.question,
    answer: item.answer,
    answerLogic: item.answerLogic,
    answerDetail: item.answerDetail,
    source: item.source || "base",
    sourceLabel: item.sourceLabel || "通用",
    sourceQuestionId: item.sourceQuestionId,
    score,
    hitTerms: dedupe(hitTerms),
    highlightTerms: dedupe([...highlightTerms, ...itemCuratedHints(item).slice(0, 8)]),
    status: "candidate",
  };
}

class Matcher {
  constructor(items) {
    this.items = items;
    this.docs = items.map((item) => {
      const hints = itemCuratedHints(item);
      const hintTokens = new Set(hints.flatMap((hint) => [...tokenize(hint)]));
      const answerPreview = `${item.answerLogic} ${String(item.answerDetail || item.answer).slice(0, 700)}`;
      return {
        item,
        questionTokens: tokenize(item.question),
        hintTokens,
        answerTokens: new Set([...tokenize(answerPreview), ...hintTokens]),
        semanticTokens: new Set([...tokenize(item.question), ...tokenize(answerPreview), ...hintTokens]),
      };
    });
    this.idf = this.computeIdf();
    this.docs.forEach((doc) => {
      doc.semanticVector = vectorize(doc.semanticTokens, this.idf);
    });
  }

  computeIdf() {
    const df = new Map();
    for (const doc of this.docs) {
      const all = new Set([...doc.questionTokens, ...doc.answerTokens]);
      for (const token of all) df.set(token, (df.get(token) ?? 0) + 1);
    }
    const total = this.docs.length || 1;
    const idf = new Map();
    for (const [token, count] of df) {
      idf.set(token, Math.max(0.35, Math.log(((total - count + 0.5) / (count + 0.5)) + 1)));
    }
    return idf;
  }

  search(query, limit = 3) {
    const cleanedQuery = String(query ?? "").trim();
    if (!cleanedQuery) return [];
    const queryTokens = tokenize(cleanedQuery);
    const queryNorm = normalize(cleanedQuery);

    const queryVector = vectorize(queryTokens, this.idf);

    return this.docs
      .map((doc) => {
        const hints = hintHits(cleanedQuery, doc.item);
        const hitTerms = [...hints];
        let lexicalScore = 0;
        let titleScore = 0;
        let hintScore = hints.length * 22;
        let answerScore = 0;
        for (const token of queryTokens) {
          const weight = tokenScoreWeight(token, this.idf);
          if (doc.questionTokens.has(token)) {
            titleScore += 7 * weight;
            lexicalScore += 4 * weight;
            if (isUsefulHitToken(token)) hitTerms.push(token);
          }
          if (doc.hintTokens.has(token)) {
            hintScore += 8 * weight;
            if (isUsefulHitToken(token)) hitTerms.push(token);
          }
          if (doc.answerTokens.has(token)) answerScore += 1.1 * weight;
        }
        const questionNorm = normalize(doc.item.question);
        if (questionNorm.includes(queryNorm)) titleScore += 34;
        if (queryNorm.includes(questionNorm) && questionNorm.length >= 6) titleScore += 18;
        const semanticScore = cosineSimilarity(queryVector, doc.semanticVector) * 48;
        const rawScore = titleScore + hintScore + lexicalScore + answerScore + semanticScore;
        const displayScore = Math.max(0, Math.min(99, Math.round(rawScore)));
        const highlightTerms = [...queryTokens].filter(isUsefulHitToken).slice(0, 10);
        return { doc, rawScore, score: displayScore, hitTerms, highlightTerms };
      })
      .filter((item) => item.rawScore > 0)
      .sort((a, b) => b.rawScore - a.rawScore || a.doc.item.id - b.doc.item.id)
      .slice(0, limit)
      .map(({ doc, score, hitTerms, highlightTerms }) => candidateFromItem(doc.item, score, hitTerms, highlightTerms));
  }

  searchWithEvent(query, limit = 3) {
    const started = Date.now();
    return {
      query: String(query ?? ""),
      definite: false,
      receivedAt: 0,
      candidates: this.search(query, limit),
      latencyMs: Date.now() - started,
    };
  }
}

class CompanyFirstMatcher {
  constructor({ companyMatcher, baseMatcher }) {
    this.companyMatcher = companyMatcher;
    this.baseMatcher = baseMatcher;
  }

  search(query, limit = 3) {
    const companyHits = this.companyMatcher?.search(query, limit) ?? [];
    if (companyHits.length) return companyHits;
    return this.baseMatcher?.search(query, limit) ?? [];
  }

  searchWithEvent(query, limit = 3) {
    const started = Date.now();
    return {
      query: String(query ?? ""),
      definite: false,
      receivedAt: 0,
      candidates: this.search(query, limit),
      latencyMs: Date.now() - started,
    };
  }
}

const strongQuestionIntentPatterns = [
  /为什么/,
  /怎么/,
  /如何/,
  /能不能/,
  /可不可以/,
  /是否/,
  /吗$/,
  /呢$/,
  /什么/,
  /哪/,
  /是什么/,
  /自我介绍|介绍一下自己|简单介绍/,
  /区别/,
  /负责什么|负责.*吗|职责是什么|什么.*职责/,
  /规划/,
  /期望/,
  /优势|短板|缺点/,
  /离开|离职/,
  /毕业.*吗|应届|哪年毕业|几年经验/,
  /为什么.*转|转向.*吗|转型.*吗/,
  /为什么.*适合|适合.*吗/,
  /薪资|薪酬/,
  /机制/,
  /介绍.*呗|讲.*呗|说.*呗/,
];

const softQuestionIntentPatterns = [
  /介绍一下/,
  /讲一下/,
  /说一下/,
  /聊一下|聊聊/,
  /讲讲|说说|介绍介绍/,
];

const questionDomainPatterns = [
  /项目|经历|案例|产品|能力|背景|专业|学校|学历|实习/,
  /RAG|Agent|Workflow|MCP|Function\s*Calling/i,
  /合同|投标|商机|招采|招标|采购|知识库|PDF|OCR/i,
  /badcase|反馈|迭代/i,
  /国企|制造业|前端|AI/i,
  /中台|智能体|平台|CRM|运维|钉钉|企业画像|模型路由|权限|监控|SOP|经验库/i,
];

const nonQuestionContextPatterns = [
  /今天流程|流程安排|先简单聊|简单聊一下/,
  /听得到|声音|麦克风|网络|测试/,
  /你好|辛苦|稍等|等一下/,
];

function cleanInferredQuestion(text) {
  const projectQuestion = canonicalProjectQuestion(text);
  if (projectQuestion) return projectQuestion;
  if (/自我介绍|介绍一下自己/.test(String(text ?? ""))) {
    return "请你做一个简单的自我介绍？";
  }
  let value = String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/^[嗯啊呃额好的那行然后所以这个那个\s，。！？、：；]*/g, "")
    .replace(/^(那你先|你先|先)/, "")
    .replace(/^(我想问一下|我就想问一下|我想问下|我就想问下|想问一下|想问下|问一下|问下|请问一下|请问|想了解一下|我们想了解一下|可以说一下|能说一下|麻烦说一下|你这边|你能不能|能不能|可以|请你|请)/, "")
    .replace(/^(下一个问题是|这个问题是|问题是)/, "");
  value = value.replace(/[。；;,.，、]+$/g, "");
  if (value && !/[？?]$/.test(value)) value += "？";
  return value;
}

function segmentText(item) {
  if (typeof item === "string") return item;
  return typeof item?.rewrittenText === "string" ? item.rewrittenText : item?.text || "";
}

function scoreQuestionUnit(candidate, index, total) {
  const strongHits = strongQuestionIntentPatterns.filter((pattern) => pattern.test(candidate)).length;
  const softHits = softQuestionIntentPatterns.filter((pattern) => pattern.test(candidate)).length;
  const domainHits = questionDomainPatterns.filter((pattern) => pattern.test(candidate)).length;
  const resumeHotwordHit = hasResumeProjectHotword(candidate);
  const hasQuestionMark = /[？?]/.test(candidate);
  const isNonQuestionContext = nonQuestionContextPatterns.some((pattern) => pattern.test(candidate));
  const hasSoftDomainIntent = softHits > 0 && (domainHits > 0 || resumeHotwordHit);
  const hasCanonicalProjectQuestion = Boolean(canonicalProjectQuestion(candidate));
  const isProjectAnchor = resumeHotwordHit && /^(这个|那个|你们|我们|商机|集团|合同|投标|运维|AI|CRM)/.test(cleanQuestionUnit(candidate));
  if (!hasQuestionMark && strongHits === 0 && !hasSoftDomainIntent && !isProjectAnchor && !hasCanonicalProjectQuestion) return null;
  if (isNonQuestionContext && strongHits === 0 && !hasQuestionMark) return null;
  const lengthBonus = candidate.length >= 8 && candidate.length <= 110 ? 0.08 : 0;
  const recentBonus = index === total - 1 ? 0.05 : 0;
  const base = strongHits > 0 ? 0.56 : isProjectAnchor ? 0.5 : 0.44;
  const intentScore = Math.min(0.3, strongHits * 0.09 + softHits * 0.05 + domainHits * 0.04 + (resumeHotwordHit ? 0.08 : 0));
  const score = base + intentScore + (hasQuestionMark ? 0.18 : 0) + lengthBonus + recentBonus;
  return { candidate, score, strongHits, softHits, domainHits, resumeHotwordHit, isProjectAnchor, hasCanonicalProjectQuestion, hasQuestionMark, index };
}

function cleanQuestionUnit(text) {
  const projectQuestion = canonicalProjectQuestion(text);
  if (projectQuestion) return projectQuestion.replace(/[？?]$/g, "");
  if (/自我介绍|介绍一下自己/.test(String(text ?? ""))) {
    return "请你做一个简单的自我介绍";
  }
  let value = String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/^[嗯啊呃额好的那行然后所以这个那个\s，。！？、：；]*/g, "")
    .replace(/^(那你先|你先|先)/, "")
    .replace(/^(我想问一下|我就想问一下|我想问下|我就想问下|想问一下|想问下|问一下|问下|请问一下|请问|想了解一下|我们想了解一下|可以说一下|能说一下|麻烦说一下|你这边|你能不能|能不能|可以|请你|请)/, "")
    .replace(/^(下一个问题是|这个问题是|问题是)/, "")
    .replace(/[？?。；;,.，、]+$/g, "");
  value = value
    .replace(/什么样一个(?:构成)?[。；;，,、]*然后?什么样一个/g, "什么样一个")
    .replace(/[。；;]+然后/g, "")
    .replace(/^然后/, "");
  return value;
}

const projectTopicPattern = /项目|团队|角色|负责|职责|人员|构成|落地|产品|平台|商机|招采|开发|测试|负责人|分工/;
const techTopicPattern = /RAG|Agent|Workflow|MCP|Function\s*Calling|PDF|OCR|知识库|合同|投标|商机|中台|智能体|模型路由|权限|监控|SOP|badcase/i;
const introTopicPattern = /自我介绍|介绍一下自己|简单介绍|先介绍一下自己/;

function shouldCombineQuestionUnits(units, sourceText) {
  if (units.length < 2) return false;
  const joined = units.map((item) => item.candidate).join("");
  const hasIntroQuestion = units.some((item) => introTopicPattern.test(item.candidate));
  if (hasIntroQuestion && units.some((item) => !introTopicPattern.test(item.candidate))) {
    return false;
  }
  const compact = joined.length <= 130;
  if (!compact) return false;
  const projectUnitCount = units.filter((item) => projectTopicPattern.test(item.candidate)).length;
  const techUnitCount = units.filter((item) => techTopicPattern.test(item.candidate)).length;
  const hasResumeProjectAnchor = units.some((item) => item.resumeHotwordHit || hasResumeProjectHotword(item.candidate));
  const hasProjectIntroIntent = units.some((item) => isProjectIntroIntent(item.candidate));
  if (hasResumeProjectAnchor && hasProjectIntroIntent) return true;
  const hasProjectAnchor = projectUnitCount >= 1;
  const hasProjectContinuation = units.some((item) => /什么样|人员构成|什么角色|主要是什么角色|分工/.test(item.candidate));
  if (hasProjectAnchor && hasProjectContinuation) return true;
  const hasSharedProjectTopic = projectUnitCount >= 2;
  const hasSharedTechTopic = techUnitCount >= 2;
  if (hasSharedProjectTopic || hasSharedTechTopic) return true;
  return false;
}

function mergeQuestionPieces(pieces) {
  return pieces.reduce((result, piece) => {
    const previous = result[result.length - 1];
    if (previous && /是$/.test(previous) && /^什么样/.test(piece)) {
      result[result.length - 1] = `${previous}${piece}`;
      return result;
    }
    if (previous && /什么样一个$/.test(previous) && /^什么样一个/.test(piece)) {
      result[result.length - 1] = `${previous.replace(/什么样一个$/, "")}${piece}`;
      return result;
    }
    result.push(piece);
    return result;
  }, []);
}

function composeQuestionGroup(group) {
  const strongGroup = group.filter((item) => item.score >= 0.55);
  if (shouldCombineQuestionUnits(strongGroup)) {
    const pieces = mergeQuestionPieces(dedupe(strongGroup.map((item) => cleanQuestionUnit(item.candidate))).filter(Boolean));
    if (pieces.length >= 1) {
      const questionText = `${pieces.join("，")}？`;
      const confidence = Math.min(0.96, Math.max(...strongGroup.map((item) => item.score)) + 0.04);
      return {
        questionText,
        confidence: Number(confidence.toFixed(2)),
        reason: strongGroup.some((item) => item.hasQuestionMark) ? "复合疑问句" : "复合疑问意图",
      };
    }
  }

  const best = [...group].sort((a, b) => b.score - a.score || b.index - a.index)[0];
  if (!best || best.score < 0.55) return null;
  return {
    questionText: cleanInferredQuestion(best.candidate),
    confidence: Math.min(0.96, Number(best.score.toFixed(2))),
    reason: best.hasQuestionMark ? "疑问句" : "疑问意图",
  };
}

function shouldMergeClauseWithNext(current, next) {
  const left = cleanQuestionUnit(current);
  const right = cleanQuestionUnit(next);
  if (!left || !right) return false;
  if (/[？?吗呢]$/.test(String(current ?? "").trim())) return false;
  if (hasResumeProjectHotword(left) && isProjectIntroIntent(right)) return true;
  if (isProjectIntroIntent(left) && hasResumeProjectHotword(right)) return true;
  if (/^(为什么|怎么|如何)/.test(left) && left.length <= 14) return true;
  if (/(为什么想从|为什么想|为什么从|从|这个|那个|什么样一|什么样一个|团队是|主要是|介绍一下这个)$/.test(left)) return true;
  if (
    /^(想|面试|转|从|到|这个|那个|人员|构成|角色|项目|合同|投标|评审|审批|中台|平台|商机|招采|运维|智能体)/.test(right)
    && /(为什么|怎么|如何|介绍一下|讲一下|说一下|团队|项目|负责|什么样|商机|中台|平台|合同|投标|运维|智能体)/.test(left)
  ) {
    return true;
  }
  return false;
}

function mergeClauseFragments(clauses) {
  const result = [];
  for (const clause of clauses) {
    const current = String(clause ?? "").trim();
    if (!current) continue;
    const previous = result[result.length - 1];
    if (previous && shouldMergeClauseWithNext(previous, current)) {
      result[result.length - 1] = `${previous}${current}`;
      continue;
    }
    result.push(current);
  }
  return result;
}

function inferQuestionsFromSegments(segments, options = {}) {
  const maxSegments = Math.max(1, Number(options.maxSegments || 4));
  const maxChars = Math.max(80, Number(options.maxChars || 0));
  const sourceItems = (segments ?? [])
    .map(segmentText)
    .map((text) => String(text ?? "").trim())
    .filter(Boolean)
    .slice(-maxSegments);
  if (!sourceItems.length) return null;

  const joinedSourceText = sourceItems.join("。");
  const sourceText = maxChars > 0 && joinedSourceText.length > maxChars
    ? joinedSourceText.slice(-maxChars)
    : joinedSourceText;
  const clauses = mergeClauseFragments(sourceText
    .split(/(?<=[。！？?；;])|[，,、]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4));
  const candidates = clauses.length ? clauses : [sourceText];
  const scored = candidates
    .map((candidate, index) => scoreQuestionUnit(candidate, index, candidates.length))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  const groups = [];
  let currentGroup = [];
  for (const item of scored) {
    if (!currentGroup.length) {
      currentGroup = [item];
      continue;
    }
    const nextGroup = [...currentGroup, item];
    if (shouldCombineQuestionUnits(nextGroup, sourceText)) {
      currentGroup = nextGroup;
      continue;
    }
    groups.push(currentGroup);
    currentGroup = [item];
  }
  if (currentGroup.length) groups.push(currentGroup);

  const seen = new Set();
  return groups
    .map(composeQuestionGroup)
    .filter(Boolean)
    .map((item) => ({
      questionText: item.questionText,
      sourceText,
      confidence: item.confidence,
      reason: item.reason,
    }))
    .filter((item) => {
      if (!item.questionText || normalize(item.questionText).length < 4) return false;
      const key = normalize(item.questionText);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function inferQuestionFromSegments(segments, options = {}) {
  return (inferQuestionsFromSegments(segments, options) || []).at(-1) ?? null;
}

function resolveQuestionBankPath(appPath = process.cwd()) {
  const candidates = [
    path.join(appPath, "resources", "question_bank_embedded.md"),
    path.join(process.cwd(), "resources", "question_bank_embedded.md"),
    path.join(process.resourcesPath || "", "resources", "question_bank_embedded.md"),
    path.join(process.resourcesPath || "", "question_bank_embedded.md"),
  ];
  return candidates.find((item) => item && fs.existsSync(item));
}

function loadQuestionBank(appPath = process.cwd()) {
  const questionBankPath = resolveQuestionBankPath(appPath);
  if (!questionBankPath) {
    throw new Error("未找到内置问题库 resources/question_bank_embedded.md");
  }
  return parseQuestionBank(fs.readFileSync(questionBankPath, "utf8"));
}

module.exports = {
  CompanyFirstMatcher,
  Matcher,
  inferQuestionFromSegments,
  inferQuestionsFromSegments,
  parseQuestionBank,
  loadQuestionBank,
  rewriteTranscriptText,
  tokenize,
  normalize,
};
