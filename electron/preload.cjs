const { contextBridge, ipcRenderer } = require("electron");

const EVENT_CHANNELS = new Set(["audio_status", "asr_partial", "asr_final", "match_candidates", "session_log"]);
const PCM_SAMPLE_RATE = 16000;
const PCM_CHUNK_BYTES = PCM_SAMPLE_RATE * 2 / 5;

let mediaStream = null;
let audioContext = null;
let processor = null;
let sourceNode = null;
let silentGain = null;
let pendingPcm = Buffer.alloc(0);

function computeVolume(floatSamples) {
  let sum = 0;
  for (let i = 0; i < floatSamples.length; i += 1) sum += floatSamples[i] * floatSamples[i];
  return floatSamples.length ? Math.sqrt(sum / floatSamples.length) : 0;
}

function downsample(input, inputRate, outputRate) {
  if (outputRate === inputRate) return input;
  if (outputRate > inputRate) throw new Error("输出采样率不能高于输入采样率");
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j];
      count += 1;
    }
    output[i] = count ? sum / count : 0;
  }
  return output;
}

function floatTo16BitPcm(samples) {
  const output = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    output.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, i * 2);
  }
  return output;
}

function flushPcm(pcm, volume) {
  pendingPcm = Buffer.concat([pendingPcm, pcm]);
  while (pendingPcm.length >= PCM_CHUNK_BYTES) {
    const chunk = pendingPcm.subarray(0, PCM_CHUNK_BYTES);
    pendingPcm = pendingPcm.subarray(PCM_CHUNK_BYTES);
    ipcRenderer.send("audio_chunk", { pcm: Uint8Array.from(chunk), volume });
  }
}

async function stopSystemAudioCapture() {
  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (audioContext) {
    await audioContext.close().catch(() => undefined);
    audioContext = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  pendingPcm = Buffer.alloc(0);
}

async function startSystemAudioCapture() {
  await stopSystemAudioCapture();
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("没有拿到系统音频轨道。请确认选择了屏幕/窗口，并允许共享系统音频。");
  }
  for (const track of stream.getVideoTracks()) track.enabled = false;
  mediaStream = stream;
  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const volume = computeVolume(input);
    const downsampled = downsample(input, audioContext.sampleRate, PCM_SAMPLE_RATE);
    flushPcm(floatTo16BitPcm(downsampled), volume);
  };
  sourceNode.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);
}

const api = {
  listAudioSources: () => ipcRenderer.invoke("list_audio_sources"),
  startSession: async (settings) => {
    try {
      await startSystemAudioCapture();
    } catch (error) {
      await ipcRenderer.invoke("audio_capture_error", error instanceof Error ? error.message : String(error));
      throw error;
    }
    try {
      return await ipcRenderer.invoke("start_session", settings);
    } catch (error) {
      await stopSystemAudioCapture();
      throw error;
    }
  },
  stopSession: async () => {
    await stopSystemAudioCapture();
    return ipcRenderer.invoke("stop_session");
  },
  pauseMatching: () => ipcRenderer.invoke("pause_matching"),
  resumeMatching: () => ipcRenderer.invoke("resume_matching"),
  lockAnswer: (questionId) => ipcRenderer.invoke("lock_answer", questionId),
  unlockAnswer: () => ipcRenderer.invoke("unlock_answer"),
  searchQuestions: (query) => ipcRenderer.invoke("search_questions", query),
  listen: (channel, handler) => {
    if (!EVENT_CHANNELS.has(channel)) return () => undefined;
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("interviewCopilot", api);
