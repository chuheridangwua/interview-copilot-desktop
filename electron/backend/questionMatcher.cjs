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

function parseQuestionBank(content) {
  const heading = /^(\d+)\.\s+(.+)$/gm;
  const matches = [...content.matchAll(heading)];
  return matches
    .map((match, index) => {
      const next = matches[index + 1];
      const answerStart = match.index + match[0].length;
      const answerEnd = next ? next.index : content.length;
      const answer = content.slice(answerStart, answerEnd).trim();
      const { answerLogic, answerDetail } = splitAnswerSections(answer);
      return {
        id: Number(match[1]),
        question: match[2].trim(),
        answer,
        answerLogic,
        answerDetail,
      };
    })
    .filter((item) => item.id && item.question && item.answer);
}

const curatedHints = new Map([
  [4, ["离开", "离职", "国企", "传统制造业", "薪资", "机会"]],
  [5, ["期望薪资", "薪资", "工资", "给不到", "多少钱", "待遇", "薪酬"]],
  [9, ["badcase", "反馈", "迭代", "机制", "准确率", "评测集", "标错", "漏标"]],
  [17, ["badcase", "负反馈", "收集", "迭代", "优化", "评测集", "准确率"]],
  [20, ["合同评审", "投标评审", "合同", "标书", "风险报告", "流程", "项目"]],
  [24, ["rag", "RAG", "复杂PDF", "PDF", "表格", "扫描件", "OCR", "知识库", "幻觉", "切片", "召回", "重排序", "向量"]],
  [25, ["agent", "Agent", "workflow", "Workflow", "tool", "Tool", "mcp", "MCP", "function calling", "Function Calling", "函数调用", "工作流"]],
]);

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[，。！？；：、（）【】《》“”"'`~!?,.;:()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
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

function hintHits(query, item) {
  const queryNorm = normalize(query);
  const itemHints = curatedHints.get(item.id) ?? [];
  return itemHints.filter((hint) => {
    const hintNorm = normalize(hint);
    return queryNorm.includes(hintNorm) || hintNorm.includes(queryNorm);
  });
}

function candidateFromItem(item, score, hitTerms, status = "candidate", highlightTerms = []) {
  return {
    id: item.id,
    question: item.question,
    answer: item.answer,
    answerLogic: item.answerLogic,
    answerDetail: item.answerDetail,
    score,
    hitTerms: dedupe(hitTerms),
    highlightTerms: dedupe([...highlightTerms, ...(curatedHints.get(item.id) ?? []).slice(0, 8)]),
    status,
  };
}

class Matcher {
  constructor(items) {
    this.items = items;
    this.docs = items.map((item) => {
      const hints = curatedHints.get(item.id) ?? [];
      return {
        item,
        questionTokens: tokenize(item.question),
        answerTokens: new Set([...tokenize(item.answer), ...hints.flatMap((hint) => [...tokenize(hint)])]),
      };
    });
    this.idf = this.computeIdf();
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

  search(query, lockedId = null) {
    if (lockedId) {
      const doc = this.docs.find((item) => item.item.id === lockedId);
      return doc ? [candidateFromItem(doc.item, 100, ["锁定"], "locked", ["锁定"])] : [];
    }

    const cleanedQuery = String(query ?? "").trim();
    if (!cleanedQuery) return [];
    const queryTokens = tokenize(cleanedQuery);
    const queryNorm = normalize(cleanedQuery);

    return this.docs
      .map((doc) => {
        const hints = hintHits(cleanedQuery, doc.item);
        const hitTerms = [...hints];
        let rawScore = hints.length * 18;
        for (const token of queryTokens) {
          const weight = this.idf.get(token) ?? 1;
          if (doc.questionTokens.has(token)) {
            rawScore += 5 * weight;
            if ([...token].length >= 2) hitTerms.push(token);
          }
          if (doc.answerTokens.has(token)) rawScore += 1.25 * weight;
        }
        if (normalize(doc.item.question).includes(queryNorm)) rawScore += 30;
        const highlightTerms = [...queryTokens].filter((token) => [...token].length >= 2).slice(0, 10);
        return { doc, score: Math.max(0, Math.min(99, Math.round(rawScore))), hitTerms, highlightTerms };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.doc.item.id - b.doc.item.id)
      .slice(0, 3)
      .map(({ doc, score, hitTerms, highlightTerms }) => candidateFromItem(doc.item, score, hitTerms, "candidate", highlightTerms));
  }

  searchWithEvent(query, lockedId = null) {
    const started = Date.now();
    return {
      query: String(query ?? ""),
      locked: Boolean(lockedId),
      definite: false,
      receivedAt: 0,
      candidates: this.search(query, lockedId),
      latencyMs: Date.now() - started,
    };
  }
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
  Matcher,
  parseQuestionBank,
  loadQuestionBank,
  tokenize,
  normalize,
};
