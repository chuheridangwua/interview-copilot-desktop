import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CompanyFirstMatcher,
  Matcher,
  inferQuestionFromSegments,
  inferQuestionsFromSegments,
  parseQuestionBank,
  rewriteTranscriptText,
} = require("../electron/backend/questionMatcher.cjs");
const {
  InterviewQuestionEngine,
  isNoiseText,
} = require("../electron/backend/interviewQuestionEngine.cjs");

const embeddedQuestionBankPath = new URL("../resources/question_bank_embedded.md", import.meta.url);
const fixtureQuestionBankPath = new URL("./fixtures/interview-questions.sample.md", import.meta.url);
const shumeiQuestionBankPath = new URL("../resources/company/数美/question.md", import.meta.url);
const questionBankPath = process.env.QUESTION_BANK_PATH
  || (fs.existsSync(embeddedQuestionBankPath) ? embeddedQuestionBankPath : fixtureQuestionBankPath);

const questionBankContent = fs.readFileSync(questionBankPath, "utf8");
const expectedQuestionCount = [...questionBankContent.matchAll(/^(\d+)\.\s+(.+)$/gm)].length;
const bank = parseQuestionBank(questionBankContent);
const matcher = new Matcher(bank);

assert.equal(bank.length, expectedQuestionCount, `should parse ${expectedQuestionCount} numbered questions`);
assert.ok(bank.every((item) => item.id && item.question && item.answer), "each item should contain id, question, and answer");
assert.ok(bank.every((item) => item.answerLogic && item.answerDetail), "each item should contain answer logic and detail sections");
assert.ok(bank.every((item) => item.source === "base" && item.sourceLabel === "通用"), "base items should carry source metadata");
assert.equal(bank[0].answerLogic, "基本身份——核心经历——岗位匹配");
assert.ok(bank[0].answerDetail.startsWith("【基本身份】"));

assert.ok(fs.existsSync(shumeiQuestionBankPath), "数美 company question bank should exist");
const shumeiBank = parseQuestionBank(fs.readFileSync(shumeiQuestionBankPath, "utf8"), {
  source: "company",
  sourceLabel: "数美",
  idOffset: 10000,
});
const mergedBank = [...bank, ...shumeiBank];
const mergedIds = new Set(mergedBank.map((item) => item.id));
const shumeiMatcher = new Matcher(mergedBank);

assert.ok(shumeiBank.length > 0, "数美 company question bank should parse at least one question");
assert.equal(mergedBank.length, bank.length + shumeiBank.length, "merged bank should include base and company questions");
assert.equal(mergedIds.size, mergedBank.length, "merged bank ids should not collide");
assert.ok(shumeiBank.every((item) => item.id >= 10000 && item.source === "company"), "company items should be remapped and tagged");
assert.ok(shumeiBank.every((item) => item.sourceLabel === "数美" && typeof item.sourceQuestionId === "number"), "company items should keep source labels and original ids");

const baseOnlyCompanyQueryHits = matcher.search("你为什么想来数美科技", 10);
assert.ok(baseOnlyCompanyQueryHits.every((item) => item.source === "base" && item.sourceLabel === "通用"), "base matcher should only return base candidates");

const shumeiCompanyQueryHits = shumeiMatcher.search("你为什么想来数美科技", 10);
assert.equal(shumeiCompanyQueryHits[0]?.source, "company", "company matcher should prioritize company question for company-specific query");
assert.equal(shumeiCompanyQueryHits[0]?.sourceLabel, "数美");
assert.equal(typeof shumeiCompanyQueryHits[0]?.sourceQuestionId, "number");

const shumeiCompanyFirstMatcher = new CompanyFirstMatcher({
  companyMatcher: new Matcher(shumeiBank),
  baseMatcher: matcher,
});
const shumeiCompanyFirstHits = shumeiCompanyFirstMatcher.search("你为什么想来数美科技", 10);
assert.ok(shumeiCompanyFirstHits.length > 0, "company-first matcher should find company candidates first");
assert.ok(
  shumeiCompanyFirstHits.every((item) => item.source === "company" && item.sourceLabel === "数美"),
  "company-first matcher should not mix base candidates when company hits exist",
);

const priorityBaseItems = parseQuestionBank([
  "1. 通用兜底问题",
  "回答逻辑：通用逻辑",
  "具体内容：这条通用答案包含 baseonly。",
].join("\n"));
const priorityCompanyItems = parseQuestionBank([
  "1. 公司专属问题",
  "回答逻辑：公司逻辑",
  "具体内容：这条公司答案包含 companyonly。",
].join("\n"), {
  source: "company",
  sourceLabel: "测试公司",
  idOffset: 10000,
});
const priorityMatcher = new CompanyFirstMatcher({
  companyMatcher: new Matcher(priorityCompanyItems),
  baseMatcher: new Matcher(priorityBaseItems),
});
const mixedPriorityHits = priorityMatcher.search("companyonly baseonly", 10);
assert.ok(mixedPriorityHits.length > 0, "company-first matcher should return primary hits");
assert.ok(mixedPriorityHits.every((item) => item.source === "company"), "company hits should suppress base fallback");
assert.equal(priorityMatcher.search("baseonly", 10)[0]?.source, "base", "base matcher should be used only when company has no hit");
assert.equal(priorityMatcher.searchWithEvent("baseonly", 10).candidates[0]?.source, "base", "searchWithEvent should use the same fallback rule");

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

const inferredLongWindowQuestion = inferQuestionFromSegments([
  { rewrittenText: "先看一下你简历里提到的风控项目。" },
  { rewrittenText: "风险域业务面会考察简历里面标签的理解。" },
  { rewrittenText: "比如一个需求怎么转化为标签。" },
  { rewrittenText: "笔试可能会给你类目和文本样本。" },
  { rewrittenText: "让你进行标注，你会为什么这么设计？" },
], { maxSegments: 80, maxChars: 1200 });
assert.equal(inferredLongWindowQuestion?.questionText, "你会为什么这么设计？");
assert.ok(
  inferredLongWindowQuestion.sourceText.includes("先看一下你简历里提到的风控项目"),
  "expanded question context should keep older segments when requested",
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

assert.equal(isNoiseText("能听到吗？"), true, "hearing check should be treated as noise");
assert.equal(isNoiseText("我们开始啊，可以吗？"), true, "process chatter should be treated as noise");
assert.equal(isNoiseText("后面有什么消息？"), true, "closing chatter should be treated as noise");

const replayBaseTime = 1780398031000;

const noiseEngine = new InterviewQuestionEngine();
const noiseOutputs = await noiseEngine.processEvent({
  type: "interviewer_final",
  text: "能听到吗？",
  receivedAt: replayBaseTime,
});
assert.equal(noiseOutputs[0]?.type, "question_rejected", "noise final should not create a question");
assert.equal(noiseEngine.finalQuestions.length, 0, "noise should not enter final history");

const partialEngine = new InterviewQuestionEngine();
const partialOutputs = await partialEngine.processEvent({
  type: "interviewer_partial",
  text: "你们这个合同评审流程是怎么设计的",
  receivedAt: replayBaseTime + 1000,
});
assert.equal(partialOutputs[0]?.type, "partial_preview", "partial should produce only a live preview");
assert.equal(partialEngine.finalQuestions.length, 0, "partial preview should not enter final history");

const confirmingEngine = new InterviewQuestionEngine({
  confirmQuestion: async ({ localQuestion, sourceText }) => ({
    questionText: sourceText.includes("两类客户")
      ? "两类客户的需求差异是什么，分别想解决什么问题？"
      : localQuestion,
    confidence: 0.9,
    reason: "测试确认",
  }),
});
const firstCareer = await confirmingEngine.processEvent({
  type: "interviewer_final",
  text: "你未来三年的职业规划是什么？",
  receivedAt: replayBaseTime + 2000,
});
const duplicateCareer = await confirmingEngine.processEvent({
  type: "interviewer_final",
  text: "你未来三年的职业规划是什么？",
  receivedAt: replayBaseTime + 3000,
});
assert.equal(firstCareer[0]?.type, "question_finalized", "first career question should finalize");
assert.equal(duplicateCareer[0]?.type, "question_updated", "duplicate career question should update the existing item");
assert.equal(duplicateCareer[0]?.question.questionId, firstCareer[0]?.question.questionId);
assert.equal(confirmingEngine.finalQuestions.length, 1, "duplicate career question should not append a second history item");

const longContextEngine = new InterviewQuestionEngine({
  confirmQuestion: async ({ sourceText }) => ({
    questionText: sourceText.includes("两类客户")
      ? "两类客户的需求差异是什么，分别想解决什么问题？"
      : "候选问题是什么？",
    sourceText,
    confidence: 0.91,
    reason: "测试长上下文合并",
  }),
});
await longContextEngine.processEvent({
  type: "interviewer_final",
  text: "我们这边有两类客户，一类是品牌客户，一类是平台客户。",
  receivedAt: replayBaseTime + 4000,
});
const longContextOutputs = await longContextEngine.processEvent({
  type: "interviewer_final",
  text: "你觉得他们的需求差异是什么？分别想解决什么问题？",
  receivedAt: replayBaseTime + 5000,
});
assert.equal(longContextOutputs[0]?.type, "question_finalized", "long business context should finalize once the trigger arrives");
assert.equal(
  longContextOutputs[0]?.question.questionText,
  "两类客户的需求差异是什么，分别想解决什么问题？",
  "confirmed full question should win over the local fragment",
);
assert.ok(longContextOutputs[0]?.question.sourceText.includes("两类客户"), "source text should retain business context");

const followupEngine = new InterviewQuestionEngine({
  confirmQuestion: async ({ localQuestion, candidateContext }) => {
    if (localQuestion.includes("主要原因") && candidateContext.includes("模型效果不好")) {
      return {
        questionText: "模型效果不好的主要原因有哪些？",
        confidence: 0.88,
        reason: "测试候选人上下文补全",
      };
    }
    return null;
  },
});
await followupEngine.processEvent({
  type: "candidate_final",
  text: "刚才我提到模型效果不好，可能和数据质量、标签一致性、样本覆盖有关。",
  receivedAt: replayBaseTime + 6000,
});
const followupOutputs = await followupEngine.processEvent({
  type: "interviewer_final",
  text: "主要原因有哪些呢？",
  receivedAt: replayBaseTime + 7000,
});
assert.equal(followupOutputs[0]?.type, "question_finalized", "confirmed short follow-up should finalize");
assert.equal(followupOutputs[0]?.question.questionText, "识别类模型效果不好的主要原因有哪些？");
assert.equal(followupOutputs[0]?.question.localQuestionText, "主要原因有哪些呢？");
assert.equal(followupOutputs[0]?.question.confirmedQuestionText, "");

const weakProductEngine = new InterviewQuestionEngine({
  confirmQuestion: async ({ localQuestion }) => ({
    questionText: localQuestion,
    confidence: 0.9,
    reason: "测试确认",
  }),
});
const weakProductPending = await weakProductEngine.processEvent({
  type: "interviewer_final",
  text: "你对外设计的产品是不是？",
  receivedAt: replayBaseTime + 8000,
});
assert.equal(weakProductPending[0]?.type, "question_rejected", "weak product follow-up should not finalize immediately");
assert.equal(weakProductPending[0]?.reason, "pending_weak");
const weakProductAbsorbed = await weakProductEngine.processEvent({
  type: "interviewer_final",
  text: "最终产品形态是什么，用户具体怎么用？",
  receivedAt: replayBaseTime + 12000,
});
assert.equal(weakProductAbsorbed[0]?.type, "question_finalized", "later complete product usage question should finalize");
assert.equal(weakProductAbsorbed.some((item) => item.type === "question_absorbed"), true, "weak product follow-up should be absorbed");
assert.equal(weakProductEngine.finalQuestions.length, 1, "absorbed weak product follow-up should not create its own history item");
assert.equal(
  weakProductEngine.finalQuestions.some((item) => item.questionText.includes("你对外设计的产品是不是")),
  false,
  "weak product follow-up must not appear as final question",
);

const processAbsorbEngine = new InterviewQuestionEngine({
  confirmQuestion: async ({ localQuestion }) => ({
    questionText: localQuestion,
    confidence: 0.9,
    reason: "测试确认",
  }),
});
await processAbsorbEngine.processEvent({
  type: "interviewer_final",
  text: "审完就出去了是吧？",
  receivedAt: replayBaseTime + 13000,
});
const processAbsorbOutputs = await processAbsorbEngine.processEvent({
  type: "interviewer_final",
  text: "合同评审的完整流程具体是怎么设计的？",
  receivedAt: replayBaseTime + 15000,
});
assert.equal(processAbsorbOutputs[0]?.type, "question_finalized", "process flow question should finalize");
assert.equal(processAbsorbOutputs.some((item) => item.type === "question_absorbed"), true, "short process confirmation should be absorbed");
assert.equal(processAbsorbEngine.finalQuestions.length, 1, "absorbed process weak question should not create a second final item");

const hallucinationGuardEngine = new InterviewQuestionEngine({
  confirmQuestion: async () => ({
    questionText: "大模型如何判断合同信息是否正确？",
    confidence: 0.94,
    reason: "测试错误扩写",
    evidenceTerms: ["大模型", "合同", "判断"],
    questionType: "model_judgement",
  }),
});
const hallucinationGuardOutputs = await hallucinationGuardEngine.processEvent({
  type: "interviewer_final",
  text: "开发那个平台是吗？",
  receivedAt: replayBaseTime + 16000,
});
assert.equal(hallucinationGuardOutputs[0]?.type, "question_rejected", "short source hallucination should be rejected");
assert.equal(hallucinationGuardOutputs[0]?.reason, "model_evidence_mismatch");
assert.equal(hallucinationGuardEngine.finalQuestions.length, 0, "hallucinated Ark question should not enter final history");

const recognitionMergeEngine = new InterviewQuestionEngine({
  confirmQuestion: async ({ localQuestion }) => ({
    questionText: localQuestion,
    confidence: 0.9,
    reason: "测试确认",
  }),
});
const recognitionFirst = await recognitionMergeEngine.processEvent({
  type: "interviewer_final",
  text: "你刚才说识别不出来，具体指的是什么场景下识别不出来？",
  receivedAt: replayBaseTime + 17000,
});
const recognitionSecond = await recognitionMergeEngine.processEvent({
  type: "interviewer_final",
  text: "这里说的识别不出来具体指什么？",
  receivedAt: replayBaseTime + 17000 + 210000,
});
assert.equal(recognitionFirst[0]?.type, "question_finalized", "first recognition clarification should finalize");
assert.equal(recognitionSecond[0]?.type, "question_updated", "repeated recognition clarification should merge/update");
assert.equal(recognitionMergeEngine.finalQuestions.length, 1, "recognition clarification duplicate should keep one final question");

const contractMergeEngine = new InterviewQuestionEngine({
  confirmQuestion: async ({ localQuestion }) => ({
    questionText: localQuestion,
    confidence: 0.9,
    reason: "测试确认",
  }),
});
await contractMergeEngine.processEvent({
  type: "interviewer_final",
  text: "大模型怎么判断合同金额和合同方信息是否正确？",
  receivedAt: replayBaseTime + 18000,
});
const contractMergeOutputs = await contractMergeEngine.processEvent({
  type: "interviewer_final",
  text: "这个模型是如何判断标书里的合同方信息、金额这些内容是否正确的？",
  receivedAt: replayBaseTime + 18000 + 312000,
});
assert.equal(contractMergeOutputs[0]?.type, "question_updated", "contract model judgement should merge across the topic window");
assert.equal(contractMergeEngine.finalQuestions.length, 1, "contract model judgement duplicate should keep one final question");
assert.equal(contractMergeEngine.finalQuestions[0]?.mergedFrom?.length, 1, "merged question should keep source metadata");

const labelFollowupEngine = new InterviewQuestionEngine();
const labelFollowupOutputs = await labelFollowupEngine.processEvent({
  type: "interviewer_final",
  text: "只是说这个标签的效果是吧？",
  receivedAt: replayBaseTime + 400000,
});
assert.equal(labelFollowupOutputs[0]?.type, "question_finalized", "label short follow-up should still complete locally");
assert.equal(labelFollowupOutputs[0]?.question.questionText, "标签能力的效果应该从哪些维度评价？");

console.log("Question parser, inference, and matcher tests passed.");
console.table(matchCases.map(([query]) => {
  const [top] = matcher.search(query);
  return { query, top: `#${top.id} ${top.question}`, score: top.score };
}));
