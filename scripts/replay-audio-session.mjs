import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  buildReplayReport,
  createReplayCollector,
  createReplayEngine,
  ensureReplayGolden,
  loadReplayMatcherBundle,
  parseCommonReplayArgs,
  writeReplayReport,
} from "./replay-interview-utils.mjs";

const require = createRequire(import.meta.url);
const { DoubaoAsrSession } = require("../electron/backend/doubaoAsr.cjs");
const { rewriteTranscriptText } = require("../electron/backend/questionMatcher.cjs");
const { readWindowsEnv, resolveArkConfig } = require("../electron/backend/arkQuestionEnhancer.cjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAudioArgs(argv) {
  const commonArgv = [];
  const audioArgs = {
    chunkMs: 200,
    speed: 1,
    resourceId: "volc.seedasr.sauc.duration",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--chunk-ms") {
      audioArgs.chunkMs = Math.max(20, Number(argv[index + 1]) || audioArgs.chunkMs);
      index += 1;
      continue;
    }
    if (item === "--speed") {
      audioArgs.speed = Math.max(0.1, Number(argv[index + 1]) || audioArgs.speed);
      index += 1;
      continue;
    }
    if (item === "--resource-id") {
      audioArgs.resourceId = argv[index + 1] || audioArgs.resourceId;
      index += 1;
      continue;
    }
    commonArgv.push(item);
  }
  const args = parseCommonReplayArgs(commonArgv);
  args.chunkMs = 200;
  args.speed = 1;
  args.resourceId = "volc.seedasr.sauc.duration";
  Object.assign(args, audioArgs);
  return args;
}

function getAsrApiKey() {
  const key = process.env.DOUBAO_API_KEY
    || process.env.VOLCENGINE_ASR_API_KEY
    || readWindowsEnv("DOUBAO_API_KEY")
    || readWindowsEnv("VOLCENGINE_ASR_API_KEY")
    || "";
  if (!key || key.length < 16) {
    throw new Error("缺少 DOUBAO_API_KEY / VOLCENGINE_ASR_API_KEY，无法执行音频端到端回放。");
  }
  return key;
}

function readPcmIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
}

async function startAsrSession({ apiKey, resourceId, requestId, onTranscript }) {
  const session = new DoubaoAsrSession({
    apiKey,
    resourceId,
    requestId,
    emitLog: (payload) => {
      const message = String(payload?.message || "");
      if (!message) return;
      const chunkMatch = message.match(/chunks=(\d+)/);
      if (chunkMatch && Number(chunkMatch[1]) % 500 !== 0) return;
      console.error(`[asr] ${message}`);
    },
    onTranscript,
  });
  await session.start();
  return session;
}

async function main() {
  const startedAt = new Date();
  const args = parseAudioArgs(process.argv.slice(2));
  const golden = ensureReplayGolden(args.goldenPath);
  const matcherBundle = loadReplayMatcherBundle(args.companyId);
  const engine = createReplayEngine({ useArk: args.useArk });
  const collector = createReplayCollector({ matcherBundle });
  const apiKey = getAsrApiKey();
  const pendingTranscripts = new Set();

  async function processTranscript(role, transcript) {
    const receivedAt = Date.now();
    const text = String(transcript.text || "").trim();
    if (!text || !transcript.definite) return;
    const event = role === "interviewer"
      ? {
        role,
        type: "interviewer_final",
        text,
        rewrittenText: rewriteTranscriptText(text),
        receivedAt,
        startMs: transcript.startMs,
        endMs: transcript.endMs,
      }
      : {
        role,
        type: "candidate_final",
        text,
        receivedAt,
        startMs: transcript.startMs,
        endMs: transcript.endMs,
      };
    const outputs = await engine.processEvent(event);
    collector.collect(outputs, event);
  }

  function enqueueTranscript(role, transcript) {
    const task = processTranscript(role, transcript)
      .catch((error) => {
        console.error(`[replay] ${role} transcript failed: ${error.message}`);
      })
      .finally(() => pendingTranscripts.delete(task));
    pendingTranscripts.add(task);
  }

  let systemAsr = null;
  let micAsr = null;
  try {
    systemAsr = await startAsrSession({
      apiKey,
      resourceId: args.resourceId,
      requestId: `replay-system-${Date.now()}`,
      onTranscript: (transcript) => enqueueTranscript("interviewer", transcript),
    });
    micAsr = await startAsrSession({
      apiKey,
      resourceId: args.resourceId,
      requestId: `replay-mic-${Date.now()}`,
      onTranscript: (transcript) => enqueueTranscript("candidate", transcript),
    });

    const bytesPerChunk = Math.round(16000 * 2 * (args.chunkMs / 1000));
    for (const sessionDir of args.sessionDirs) {
      const systemPcm = readPcmIfExists(path.join(sessionDir, "system-audio.pcm"));
      const micPcm = readPcmIfExists(path.join(sessionDir, "microphone-audio.pcm"));
      const chunks = Math.max(
        Math.ceil(systemPcm.length / bytesPerChunk),
        Math.ceil(micPcm.length / bytesPerChunk),
      );
      for (let index = 0; index < chunks; index += 1) {
        const start = index * bytesPerChunk;
        const end = start + bytesPerChunk;
        const systemChunk = systemPcm.subarray(start, end);
        const micChunk = micPcm.subarray(start, end);
        if (systemChunk.length) systemAsr.sendAudio(systemChunk);
        if (micChunk.length) micAsr.sendAudio(micChunk);
        await sleep(args.chunkMs / args.speed);
      }
    }
    await sleep(3000);
    await Promise.all([...pendingTranscripts]);
  } finally {
    if (systemAsr) systemAsr.close();
    if (micAsr) micAsr.close();
  }

  const finishedAt = new Date();
  const report = buildReplayReport({
    mode: "audio",
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
      && report.summary.exactDuplicateCount === 0
      && report.summary.blockedFinalQuestionHitCount === 0
      && report.summary.topicLimitViolationCount === 0,
    mode: report.mode,
    useArk: report.useArk,
    arkModel: resolveArkConfig().model,
    finalQuestionCount: report.summary.finalQuestionCount,
    target: `${report.summary.targetMin}-${report.summary.targetMax}`,
    requiredHits: `${report.summary.requiredHitCount}/${report.summary.requiredTotal}`,
    forbiddenHitCount: report.summary.forbiddenHitCount,
    archivedPartialCount: report.summary.archivedPartialCount,
    exactDuplicateCount: report.summary.exactDuplicateCount,
    semanticDuplicateCount: report.summary.semanticDuplicateCount,
    absorbedQuestionCount: report.summary.absorbedQuestionCount,
    mergedQuestionCount: report.summary.mergedQuestionCount,
    evidenceMismatchRejectCount: report.summary.evidenceMismatchRejectCount,
    blockedFinalQuestionHitCount: report.summary.blockedFinalQuestionHitCount,
    topicLimitViolationCount: report.summary.topicLimitViolationCount,
    speed: args.speed,
    chunkMs: args.chunkMs,
    jsonPath: paths.jsonPath,
    mdPath: paths.mdPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
