import {
  buildReplayReport,
  createReplayCollector,
  createReplayEngine,
  ensureReplayGolden,
  feedReplayEvents,
  loadReplayMatcherBundle,
  loadTranscriptReplayEvents,
  parseCommonReplayArgs,
  writeReplayReport,
} from "./replay-interview-utils.mjs";

async function main() {
  const startedAt = new Date();
  const args = parseCommonReplayArgs(process.argv.slice(2));
  const golden = ensureReplayGolden(args.goldenPath);
  const matcherBundle = loadReplayMatcherBundle(args.companyId);
  const engine = createReplayEngine({ useArk: args.useArk });
  const collector = createReplayCollector({ matcherBundle });
  const events = loadTranscriptReplayEvents(args.sessionDirs);

  await feedReplayEvents({ engine, collector, events });

  const finishedAt = new Date();
  const report = buildReplayReport({
    mode: "transcript",
    sessionDirs: args.sessionDirs,
    matcherBundle,
    golden,
    useArk: args.useArk,
    finalQuestions: collector.getFinalQuestions(),
    partialPreviews: collector.getPartialPreviews(),
    rejected: collector.getRejected(),
    absorbed: collector.getAbsorbed(),
    merged: collector.getMerged(),
    startedAt,
    finishedAt,
  });
  const paths = writeReplayReport(report);
  console.log(JSON.stringify({
    ok: report.summary.countInRange
      && report.summary.archivedPartialCount === 0
      && report.summary.forbiddenHitCount === 0
      && report.summary.requiredHitCount === report.summary.requiredTotal
      && report.summary.excessiveDuplicateClusterCount === 0
      && report.summary.exactDuplicateCount === 0
      && report.summary.semanticDuplicateCount === 0
      && report.summary.blockedFinalQuestionHitCount === 0
      && report.summary.topicLimitViolationCount === 0,
    mode: report.mode,
    useArk: report.useArk,
    arkModel: report.arkModel,
    finalQuestionCount: report.summary.finalQuestionCount,
    target: `${report.summary.targetMin}-${report.summary.targetMax}`,
    requiredHits: `${report.summary.requiredHitCount}/${report.summary.requiredTotal}`,
    forbiddenHitCount: report.summary.forbiddenHitCount,
    partialPreviewCount: report.summary.partialPreviewCount,
    archivedPartialCount: report.summary.archivedPartialCount,
    excessiveDuplicateClusterCount: report.summary.excessiveDuplicateClusterCount,
    exactDuplicateCount: report.summary.exactDuplicateCount,
    semanticDuplicateCount: report.summary.semanticDuplicateCount,
    absorbedQuestionCount: report.summary.absorbedQuestionCount,
    mergedQuestionCount: report.summary.mergedQuestionCount,
    evidenceMismatchRejectCount: report.summary.evidenceMismatchRejectCount,
    blockedFinalQuestionHitCount: report.summary.blockedFinalQuestionHitCount,
    topicLimitViolationCount: report.summary.topicLimitViolationCount,
    jsonPath: paths.jsonPath,
    mdPath: paths.mdPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
