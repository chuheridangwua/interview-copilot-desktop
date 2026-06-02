const zlib = require("node:zlib");
const WebSocket = require("ws");

const MSG_FULL_CLIENT_REQUEST = 0x1;
const MSG_AUDIO_ONLY_REQUEST = 0x2;
const MSG_FULL_SERVER_RESPONSE = 0x9;
const MSG_ERROR = 0xf;
const FLAG_NO_SEQUENCE = 0x0;
const FLAG_POS_SEQUENCE = 0x1;
const FLAG_NEG_SEQUENCE = 0x3;
const SERIALIZATION_NONE = 0x0;
const SERIALIZATION_JSON = 0x1;
const COMPRESSION_NONE = 0x0;
const COMPRESSION_GZIP = 0x1;

function defaultEndpoint() {
  return "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
}

function defaultHotwords() {
  return [
    "AI产品经理",
    "RAG",
    "Agent",
    "Workflow",
    "MCP",
    "Function Calling",
    "badcase",
    "MVP",
    "AI中台",
    "合同评审",
    "投标评审",
    "商机推送",
    "复杂PDF",
    "知识库",
  ];
}

function packPayload(messageType, flags, serialization, compression, sequence, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
  const chunks = [Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4) | compression, 0x00])];
  if (typeof sequence === "number") {
    const seq = Buffer.alloc(4);
    seq.writeInt32BE(sequence, 0);
    chunks.push(seq);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  chunks.push(size, body);
  return Buffer.concat(chunks);
}

function buildFullClientRequest(hotwords = defaultHotwords()) {
  const hotwordJson = {
    hotwords: hotwords.map((word) => ({ word })),
  };
  const payload = {
    user: { uid: "interview-copilot-electron" },
    audio: {
      format: "pcm",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: "bigmodel",
      enable_nonstream: true,
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      show_utterances: true,
      result_type: "single",
      end_window_size: 350,
      corpus: {
        context: JSON.stringify(hotwordJson),
      },
    },
  };
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  return packPayload(MSG_FULL_CLIENT_REQUEST, FLAG_NO_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_GZIP, undefined, bytes);
}

function buildAudioRequest(sequence, pcm, isLast = false) {
  const compressed = zlib.gzipSync(Buffer.from(pcm ?? []));
  const flags = isLast ? FLAG_NEG_SEQUENCE : FLAG_POS_SEQUENCE;
  const seq = isLast ? -Math.abs(sequence) : Math.abs(sequence);
  return packPayload(MSG_AUDIO_ONLY_REQUEST, flags, SERIALIZATION_NONE, COMPRESSION_GZIP, seq, compressed);
}

function buildLastAudioRequest(sequence) {
  return buildAudioRequest(sequence, Buffer.alloc(0), true);
}

function readU32(frame, cursor) {
  if (cursor + 4 > frame.length) throw new Error("豆包 ASR 帧缺少 u32 字段");
  return frame.readUInt32BE(cursor);
}

function parseServerFrame(input) {
  const frame = Buffer.from(input);
  if (frame.length < 8) throw new Error("豆包 ASR 返回帧过短");
  const headerSize = (frame[0] & 0x0f) * 4;
  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const compression = frame[2] & 0x0f;
  let cursor = headerSize;

  if (messageType === MSG_ERROR) {
    const code = readU32(frame, cursor);
    cursor += 4;
    const size = readU32(frame, cursor);
    cursor += 4;
    const message = frame.subarray(cursor, cursor + size).toString("utf8");
    throw new Error(`豆包 ASR 错误 ${code}: ${message}`);
  }

  if (messageType !== MSG_FULL_SERVER_RESPONSE) return { type: "ack" };
  if (flags === FLAG_POS_SEQUENCE || flags === FLAG_NEG_SEQUENCE) cursor += 4;
  const payloadSize = readU32(frame, cursor);
  cursor += 4;
  const payload = frame.subarray(cursor, cursor + payloadSize);
  let bytes;
  if (compression === COMPRESSION_GZIP) bytes = zlib.gunzipSync(payload);
  else if (compression === COMPRESSION_NONE) bytes = payload;
  else throw new Error(`不支持的豆包 ASR 压缩类型: ${compression}`);

  const value = JSON.parse(bytes.toString("utf8"));
  const transcript = extractTranscript(value);
  return transcript ? { type: "transcript", transcript } : { type: "ack" };
}

function extractTranscript(value) {
  const result = value?.result;
  const resultObj = Array.isArray(result) ? result[0] : result;
  const utterances = Array.isArray(resultObj?.utterances) ? resultObj.utterances : [];
  const last = utterances[utterances.length - 1] ?? {};
  const utteranceText = String(last?.text ?? last?.utterance ?? "").trim();
  const text = utteranceText || String(resultObj?.text ?? "").trim();
  if (!text) return null;
  const definite = utterances.length ? Boolean(last?.definite) : Boolean(resultObj?.definite);
  return {
    text,
    definite,
    startMs: typeof last?.start_time === "number" ? last.start_time : undefined,
    endMs: typeof last?.end_time === "number" ? last.end_time : undefined,
  };
}

class DoubaoAsrSession {
  constructor({ apiKey, resourceId, requestId, emitLog, onTranscript }) {
    this.apiKey = apiKey;
    this.resourceId = resourceId;
    this.requestId = requestId;
    this.emitLog = emitLog;
    this.onTranscript = onTranscript;
    this.ws = null;
    this.sequence = 1;
    this.audioChunksSent = 0;
    this.lastAudioSentAt = Date.now();
    this.closed = false;
    this.asrLogId = undefined;
  }

  start() {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const ws = new WebSocket(defaultEndpoint(), {
        headers: {
          "X-Api-Key": this.apiKey,
          "X-Api-Resource-Id": this.resourceId,
          "X-Api-Request-Id": this.requestId,
          "X-Api-Sequence": "-1",
        },
      });
      this.ws = ws;
      const timeout = setTimeout(() => {
        reject(new Error("连接豆包流式 ASR 超时，请检查网络或服务开通状态"));
        try { ws.close(); } catch {}
      }, 20000);

      ws.on("upgrade", (response) => {
        const rawLogId = response.headers?.["x-tt-logid"] ?? response.headers?.["X-Tt-Logid"];
        this.asrLogId = Array.isArray(rawLogId) ? rawLogId[0] : rawLogId;
      });

      ws.once("open", () => {
        clearTimeout(timeout);
        try {
          ws.send(buildFullClientRequest(defaultHotwords()));
          this.emitLog?.({
            message: `豆包流式 ASR 已连接 · ${Date.now() - startedAt}ms · 热词 ${defaultHotwords().length} 个`,
            asrLogId: this.asrLogId,
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      ws.on("message", (data) => {
        try {
          const parsed = parseServerFrame(data);
          if (parsed.type === "transcript") {
            this.onTranscript?.({
              ...parsed.transcript,
              asrLatencyMs: Date.now() - this.lastAudioSentAt,
            });
          }
        } catch (error) {
          this.emitLog?.({ message: `豆包响应解析失败：${error.message}`, asrLogId: this.asrLogId });
        }
      });

      ws.once("error", (error) => {
        clearTimeout(timeout);
        if (!this.closed) reject(error);
      });

      ws.once("close", () => {
        this.closed = true;
        this.emitLog?.({ message: "豆包流式 ASR 已关闭", asrLogId: this.asrLogId });
      });
    });
  }

  sendAudio(pcm) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) return;
    this.sequence += 1;
    this.audioChunksSent += 1;
    this.lastAudioSentAt = Date.now();
    this.ws.send(buildAudioRequest(this.sequence, pcm, false));
    if (this.audioChunksSent === 1 || this.audioChunksSent % 10 === 0) {
      this.emitLog?.({
        message: `豆包音频包已发送 · chunks=${this.audioChunksSent} · seq=${this.sequence} · bytes=${Buffer.byteLength(pcm)}`,
        asrLogId: this.asrLogId,
      });
    }
  }

  close() {
    this.closed = true;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(buildLastAudioRequest(this.sequence + 1));
      this.emitLog?.({ message: `停止信号已发送到豆包 ASR · audio_chunks=${this.audioChunksSent}`, asrLogId: this.asrLogId });
    } catch {}
    try { this.ws.close(); } catch {}
  }
}

module.exports = {
  DoubaoAsrSession,
  buildFullClientRequest,
  buildAudioRequest,
  buildLastAudioRequest,
  extractTranscript,
  parseServerFrame,
};
