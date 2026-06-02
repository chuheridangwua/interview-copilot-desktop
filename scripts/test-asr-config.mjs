import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildFullClientRequest,
  extractTranscript,
} = require("../electron/backend/doubaoAsr.cjs");

function unpackFullClientRequest(frame) {
  const headerSize = (frame[0] & 0x0f) * 4;
  const compression = frame[2] & 0x0f;
  let cursor = headerSize;
  const size = frame.readUInt32BE(cursor);
  cursor += 4;
  const payload = frame.subarray(cursor, cursor + size);
  const bytes = compression === 1 ? zlib.gunzipSync(payload) : payload;
  return JSON.parse(bytes.toString("utf8"));
}

const request = unpackFullClientRequest(buildFullClientRequest(["AI产品经理"]));
assert.equal(request.request.show_utterances, true);
assert.equal(request.request.result_type, "single");
assert.equal(request.request.end_window_size, 350);

const transcript = extractTranscript({
  result: {
    text: "累计文本不应优先",
    utterances: [
      {
        text: "你是去年毕业的吗",
        definite: false,
        start_time: 120,
        end_time: 900,
      },
    ],
  },
});
assert.deepEqual(transcript, {
  text: "你是去年毕业的吗",
  definite: false,
  startMs: 120,
  endMs: 900,
});

console.log("ASR config and transcript extraction tests passed.");
