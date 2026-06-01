import fs from "node:fs";
import assert from "node:assert/strict";

const embeddedQuestionBankPath = new URL("../src-tauri/src/question_bank_embedded.md", import.meta.url);
const fixtureQuestionBankPath = new URL("./fixtures/interview-questions.sample.md", import.meta.url);
const questionBankPath = process.env.QUESTION_BANK_PATH || (fs.existsSync(embeddedQuestionBankPath) ? embeddedQuestionBankPath : fixtureQuestionBankPath);

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
  return matches.map((match, index) => {
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
  });
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
  return text
    .toLowerCase()
    .replace(/[，。！？；：、（）【】《》“”"'`~!?,.;:()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
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

function hintHits(query, item) {
  const queryNorm = normalize(query);
  const itemHints = curatedHints.get(item.id) ?? [];
  return itemHints.filter((hint) => queryNorm.includes(normalize(hint)) || normalize(hint).includes(queryNorm));
}

function search(query, bank) {
  const queryTokens = tokens(query);
  return bank
    .map((item) => {
      const questionTokens = tokens(item.question);
      const answerTokens = tokens(item.answer);
      const hints = hintHits(query, item);
      let score = hints.length * 18;
      for (const token of queryTokens) {
        if (questionTokens.has(token)) score += 5;
        if (answerTokens.has(token)) score += 1.25;
      }
      if (normalize(item.question).includes(normalize(query))) score += 30;
      return {
        ...item,
        score: Math.min(99, Math.round(score)),
        hitTerms: [...new Set([...hints, ...[...queryTokens].filter((token) => questionTokens.has(token)).slice(0, 8)])],
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

const bank = parseQuestionBank(fs.readFileSync(questionBankPath, "utf8"));
assert.equal(bank.length, 31, "should parse 31 numbered questions");
assert.ok(bank.every((item) => item.id && item.question && item.answer), "each item should contain id, question, and answer");
assert.ok(bank.every((item) => item.answerLogic && item.answerDetail), "each item should contain answer logic and detail sections");
assert.equal(bank[0].answerLogic, "基本身份——核心经历——岗位匹配");
assert.ok(bank[0].answerDetail.startsWith("【基本身份】"));

const cases = [
  ["你们的 RAG 是怎么做的，复杂 PDF 和表格怎么处理", 24],
  ["Agent、Workflow、MCP、Function Calling 区别是什么", 25],
  ["为什么离开国企", 4],
  ["期望薪资是多少", 5],
];

for (const [query, expectedId] of cases) {
  const hits = search(query, bank);
  assert.equal(hits[0]?.id, expectedId, `${query} should match #${expectedId}, got ${hits[0]?.id}`);
}

const badcaseHits = search("你们 badcase 怎么反馈和迭代", bank).map((item) => item.id);
assert.ok(badcaseHits.includes(9) || badcaseHits.includes(17), `badcase query should include #9 or #17, got ${badcaseHits.join(", ")}`);

console.log("Question parser and matcher tests passed.");
console.table(cases.map(([query]) => {
  const [top] = search(query, bank);
  return { query, top: `#${top.id} ${top.question}`, score: top.score };
}));

