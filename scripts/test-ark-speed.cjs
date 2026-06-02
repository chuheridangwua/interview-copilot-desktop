const { Matcher, loadQuestionBank } = require("../electron/backend/questionMatcher.cjs");
const {
  confirmQuestionWithArk,
  inferQuestionWithArk,
  rerankCandidateIdsWithArk,
  resolveArkConfig,
} = require("../electron/backend/arkQuestionEnhancer.cjs");

function unique(values) {
  return [...new Set(values.filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
}

function summarizeResult(result) {
  if (!result) return null;
  if (Array.isArray(result)) {
    return result.map((item) => `#${item.id}`).join(",");
  }
  return {
    questionText: result.questionText,
    confidence: result.confidence,
  };
}

async function timed(task, run) {
  const started = Date.now();
  try {
    const result = await run();
    console.log(JSON.stringify({
      task,
      ok: Boolean(result && (!Array.isArray(result) || result.length)),
      elapsedMs: Date.now() - started,
      result: summarizeResult(result),
    }));
    return result;
  } catch (error) {
    console.log(JSON.stringify({
      task,
      ok: false,
      elapsedMs: Date.now() - started,
      error: String(error?.message || error).slice(0, 220),
    }));
    return null;
  }
}

async function main() {
  const config = resolveArkConfig();
  console.log(JSON.stringify({
    enabled: config.enabled,
    hasKey: Boolean(config.apiKey),
    keyLength: config.apiKey.length,
    baseUrl: config.baseUrl,
    defaultModel: config.model,
    fastModel: config.fastModel,
  }));

  const models = unique((process.env.ARK_SPEED_MODELS || `${config.fastModel || "doubao-1-5-lite-32k-250115"},${config.model}`)
    .split(","));

  const matcher = new Matcher(loadQuestionBank(process.cwd()));
  const sampleContext = [
    "你现在是在青岛还是在哪。",
    "为什么想从，想面试青岛这边的岗位啊。",
    "你简单介绍一下这个合同投标评审的这个项目吧。",
  ].join("");
  const localQuestion = "你简单介绍一下这个合同投标评审的这个项目吧？";
  const candidates = matcher.search(localQuestion, 5);
  console.log(JSON.stringify({
    sampleQuestion: localQuestion,
    localCandidates: candidates.map((item) => `#${item.id}:${item.score}`).join(","),
  }));

  for (const model of models) {
    console.log(JSON.stringify({ model }));
    await timed("confirm_question", () => confirmQuestionWithArk({
      sourceText: sampleContext,
      localQuestion,
      timeoutMs: 4500,
      model,
    }));
    await timed("rerank_ids", () => rerankCandidateIdsWithArk({
      question: localQuestion,
      candidates,
      timeoutMs: 4500,
      model,
    }));
    await timed("infer_question", () => inferQuestionWithArk({
      text: sampleContext,
      timeoutMs: 4500,
      model,
    }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
