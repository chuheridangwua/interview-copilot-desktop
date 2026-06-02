import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  Matcher,
  inferQuestionFromSegments,
  inferQuestionsFromSegments,
  parseQuestionBank,
  rewriteTranscriptText,
} = require("../electron/backend/questionMatcher.cjs");

const embeddedQuestionBankPath = new URL("../resources/question_bank_embedded.md", import.meta.url);
const fixtureQuestionBankPath = new URL("./fixtures/interview-questions.sample.md", import.meta.url);
const questionBankPath = process.env.QUESTION_BANK_PATH
  || (fs.existsSync(embeddedQuestionBankPath) ? embeddedQuestionBankPath : fixtureQuestionBankPath);

const bank = parseQuestionBank(fs.readFileSync(questionBankPath, "utf8"));
const matcher = new Matcher(bank);

assert.equal(bank.length, 31, "should parse 31 numbered questions");
assert.ok(bank.every((item) => item.id && item.question && item.answer), "each item should contain id, question, and answer");
assert.ok(bank.every((item) => item.answerLogic && item.answerDetail), "each item should contain answer logic and detail sections");
assert.equal(bank[0].answerLogic, "基本身份——核心经历——岗位匹配");
assert.ok(bank[0].answerDetail.startsWith("【基本身份】"));

const matchCases = [
  ["你们的 RAG 是怎么做的，复杂 PDF 和表格怎么处理", 24],
  ["Agent、Workflow、MCP、Function Calling 区别是什么", 25],
  ["为什么离开国企", 4],
  ["期望薪资是多少", 5],
  ["我想问下你为什么从前端转 AI 产品", 2],
  ["自我介绍", 1],
  ["这个商机推送的平台，你简单介绍一下呗", 22],
  ["商机智能推送平台评分规则怎么做", 22],
  ["集团 AI 中台模型路由权限监控怎么设计", 23],
];

for (const [query, expectedId] of matchCases) {
  const hits = matcher.search(query);
  assert.equal(hits[0]?.id, expectedId, `${query} should match #${expectedId}, got ${hits[0]?.id}`);
}

const inferredCareerQuestion = inferQuestionFromSegments([
  { text: "我就想问一下，你为什么从前端开发转向 AI 产品经理" },
]);
assert.equal(inferredCareerQuestion?.questionText, "你为什么从前端开发转向AI产品经理？");
assert.equal(matcher.search(inferredCareerQuestion.questionText)[0]?.id, 2);

const inferredContextQuestion = inferQuestionFromSegments([
  { text: "先介绍一下项目背景" },
  { text: "然后你在里面负责什么" },
]);
assert.equal(inferredContextQuestion?.questionText, "介绍一下项目背景，你在里面负责什么？");

const inferredIntroQuestion = inferQuestionFromSegments([
  { text: "你先自我介绍一下" },
]);
assert.equal(inferredIntroQuestion?.questionText, "请你做一个简单的自我介绍？");
assert.equal(matcher.search(inferredIntroQuestion.questionText)[0]?.id, 1);

const inferredGraduationQuestion = inferQuestionFromSegments([
  { text: "你是去年毕业的吗" },
]);
assert.equal(inferredGraduationQuestion?.questionText, "你是去年毕业的吗？");

const inferredPartialQuestion = inferQuestionFromSegments([
  { text: "你先自我介绍一下" },
  { text: "然后说一下你为什么从前端转 AI 产品" },
]);
assert.equal(inferredPartialQuestion?.questionText, "说一下你为什么从前端转AI产品？");

const inferredCompositeProjectQuestion = inferQuestionFromSegments([
  { rewrittenText: "你们这个项目落地是用什么去落地呢" },
  { text: "你在里面主要是什么角色，什么样一个人员构成" },
]);
assert.equal(
  inferredCompositeProjectQuestion?.questionText,
  "你们这个项目落地是用什么去落地呢，你在里面主要是什么角色，什么样一个人员构成？",
);

const inferredBusinessOpportunityQuestion = inferQuestionFromSegments([
  { rewrittenText: "这个商机推送的这个平台，你简单介绍一下呗。" },
]);
assert.equal(inferredBusinessOpportunityQuestion?.questionText, "请介绍一下商机智能推送平台？");
assert.equal(matcher.search(inferredBusinessOpportunityQuestion.questionText)[0]?.id, 22);

const inferredBusinessOpportunityQuestionFromSplit = inferQuestionFromSegments([
  { rewrittenText: "这个商机推送的这个平台" },
  { rewrittenText: "你简单介绍一下呗。" },
]);
assert.equal(inferredBusinessOpportunityQuestionFromSplit?.questionText, "请介绍一下商机智能推送平台？");

const inferredBusinessOpportunityProjectOnly = inferQuestionFromSegments([
  { rewrittenText: "这个商机推送的这个平台" },
]);
assert.equal(inferredBusinessOpportunityProjectOnly?.questionText, "请介绍一下商机智能推送平台？");
assert.equal(matcher.search(inferredBusinessOpportunityProjectOnly.questionText)[0]?.id, 22);

const inferredQuestionHistory = inferQuestionsFromSegments([
  { rewrittenText: "请自我介绍一下。你是去年毕业的吗，对，是的。" },
  { rewrittenText: "你所在的这个团队是？" },
  { rewrittenText: "构成，然后什么样一个人员构成？" },
  { rewrittenText: "你在里面是主要是什么角色？" },
]);
assert.deepEqual(
  inferredQuestionHistory.map((item) => item.questionText),
  [
    "请你做一个简单的自我介绍？",
    "你是去年毕业的吗？",
    "你所在的这个团队是什么样一个人员构成，你在里面是主要是什么角色？",
  ],
);

assert.deepEqual(
  inferQuestionsFromSegments([
    { rewrittenText: "面试官您好，我叫陈乐祥，之前是在这家公司做的一个自我介绍。" },
  ]).map((item) => item.questionText),
  ["请你做一个简单的自我介绍？"],
);

assert.deepEqual(
  inferQuestionsFromSegments([
    { rewrittenText: "是24年底，正好 deepseek 出来，然后开了 AI 转型这么一个项目和部门。" },
    { rewrittenText: "你所在的这个团队是？" },
  ]).map((item) => item.questionText),
  ["你所在的这个团队是？"],
);

assert.deepEqual(
  inferQuestionsFromSegments([
    { rewrittenText: "你所在的这个团队是？" },
    { rewrittenText: "什么样一个" },
    { rewrittenText: "构成，然后什么样一个人员构成？" },
  ]).map((item) => item.questionText),
  ["你所在的这个团队是什么样一个人员构成？"],
);

assert.equal(rewriteTranscriptText("嗯， 你们这个项目落地是用什么去落地呢，，"), "你们这个项目落地是用什么去落地呢");

const nonQuestion = inferQuestionFromSegments([
  { text: "好的我们先简单聊一下今天流程" },
]);
assert.equal(nonQuestion, null, "plain process chatter should not create a question");

const badcaseHits = matcher.search("你们 badcase 怎么反馈和迭代").map((item) => item.id);
assert.ok(badcaseHits.includes(9) || badcaseHits.includes(17), `badcase query should include #9 or #17, got ${badcaseHits.join(", ")}`);

console.log("Question parser, inference, and matcher tests passed.");
console.table(matchCases.map(([query]) => {
  const [top] = matcher.search(query);
  return { query, top: `#${top.id} ${top.question}`, score: top.score };
}));
