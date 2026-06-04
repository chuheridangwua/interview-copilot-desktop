const { contextBridge, ipcRenderer } = require("electron");

const EVENT_CHANNELS = new Set([
  "audio_status",
  "microphone_audio_status",
  "asr_partial",
  "asr_final",
  "mic_asr_partial",
  "mic_asr_final",
  "match_candidates",
  "session_log",
  "model_question_update",
  "ai_match_update",
  "model_answer_update",
  "health_status",
]);
const PCM_SAMPLE_RATE = 16000;
const PCM_CHUNK_BYTES = PCM_SAMPLE_RATE * 2 / 5;

let mediaStream = null;
let audioContext = null;
let processor = null;
let sourceNode = null;
let silentGain = null;
let pendingPcm = Buffer.alloc(0);
let microphoneStream = null;
let microphoneAudioContext = null;
let microphoneProcessor = null;
let microphoneSourceNode = null;
let microphoneSilentGain = null;
let pendingMicrophonePcm = Buffer.alloc(0);
let capturePaused = false;

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
  if (capturePaused) {
    pendingPcm = Buffer.alloc(0);
    return;
  }
  pendingPcm = Buffer.concat([pendingPcm, pcm]);
  while (pendingPcm.length >= PCM_CHUNK_BYTES) {
    const chunk = pendingPcm.subarray(0, PCM_CHUNK_BYTES);
    pendingPcm = pendingPcm.subarray(PCM_CHUNK_BYTES);
    ipcRenderer.send("audio_chunk", { pcm: Uint8Array.from(chunk), volume });
  }
}

function flushMicrophonePcm(pcm, volume) {
  if (capturePaused) {
    pendingMicrophonePcm = Buffer.alloc(0);
    return;
  }
  pendingMicrophonePcm = Buffer.concat([pendingMicrophonePcm, pcm]);
  while (pendingMicrophonePcm.length >= PCM_CHUNK_BYTES) {
    const chunk = pendingMicrophonePcm.subarray(0, PCM_CHUNK_BYTES);
    pendingMicrophonePcm = pendingMicrophonePcm.subarray(PCM_CHUNK_BYTES);
    ipcRenderer.send("mic_audio_chunk", { pcm: Uint8Array.from(chunk), volume });
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
  capturePaused = false;
}

async function stopMicrophoneCapture() {
  if (microphoneProcessor) {
    microphoneProcessor.disconnect();
    microphoneProcessor.onaudioprocess = null;
    microphoneProcessor = null;
  }
  if (microphoneSourceNode) {
    microphoneSourceNode.disconnect();
    microphoneSourceNode = null;
  }
  if (microphoneSilentGain) {
    microphoneSilentGain.disconnect();
    microphoneSilentGain = null;
  }
  if (microphoneAudioContext) {
    await microphoneAudioContext.close().catch(() => undefined);
    microphoneAudioContext = null;
  }
  if (microphoneStream) {
    for (const track of microphoneStream.getTracks()) track.stop();
    microphoneStream = null;
  }
  pendingMicrophonePcm = Buffer.alloc(0);
}

async function stopAllAudioCapture() {
  await Promise.all([
    stopSystemAudioCapture(),
    stopMicrophoneCapture(),
  ]);
  capturePaused = false;
}

async function startSystemAudioCapture() {
  await stopSystemAudioCapture();
  capturePaused = false;
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

async function startMicrophoneCapture(deviceId) {
  await stopMicrophoneCapture();
  const selectedDeviceId = String(deviceId ?? "").trim();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: selectedDeviceId
      ? {
        deviceId: { exact: selectedDeviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      : {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
  });
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("没有拿到麦克风音频轨道。");
  }
  microphoneStream = stream;
  microphoneAudioContext = new AudioContext();
  microphoneSourceNode = microphoneAudioContext.createMediaStreamSource(new MediaStream(audioTracks));
  microphoneProcessor = microphoneAudioContext.createScriptProcessor(4096, 1, 1);
  microphoneSilentGain = microphoneAudioContext.createGain();
  microphoneSilentGain.gain.value = 0;
  microphoneProcessor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const volume = computeVolume(input);
    const downsampled = downsample(input, microphoneAudioContext.sampleRate, PCM_SAMPLE_RATE);
    flushMicrophonePcm(floatTo16BitPcm(downsampled), volume);
  };
  microphoneSourceNode.connect(microphoneProcessor);
  microphoneProcessor.connect(microphoneSilentGain);
  microphoneSilentGain.connect(microphoneAudioContext.destination);
}

async function listMediaDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { audioInputs: [], audioOutputs: [] };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const normalizeDevice = (device, index, fallbackPrefix) => ({
    id: device.deviceId || "",
    label: device.label || `${fallbackPrefix} ${index + 1}`,
    isDefault: device.deviceId === "default" || device.deviceId === "",
    groupId: device.groupId || "",
  });
  const audioInputs = devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => normalizeDevice(device, index, "麦克风"));
  const audioOutputs = devices
    .filter((device) => device.kind === "audiooutput")
    .map((device, index) => normalizeDevice(device, index, "系统输出"));
  return { audioInputs, audioOutputs };
}

const api = {
  listAudioSources: () => ipcRenderer.invoke("list_audio_sources"),
  listMediaDevices,
  listCompanies: () => ipcRenderer.invoke("list_companies"),
  startSession: async (settings) => {
    try {
      await startSystemAudioCapture();
    } catch (error) {
      await ipcRenderer.invoke("audio_capture_error", error instanceof Error ? error.message : String(error));
      throw error;
    }
    let microphoneContextEnabled = false;
    try {
      await startMicrophoneCapture(settings?.microphoneDeviceId);
      microphoneContextEnabled = true;
    } catch (error) {
      await stopMicrophoneCapture();
      await ipcRenderer.invoke("microphone_capture_error", error instanceof Error ? error.message : String(error));
    }
    try {
      return await ipcRenderer.invoke("start_session", { ...settings, microphoneContextEnabled });
    } catch (error) {
      await stopAllAudioCapture();
      throw error;
    }
  },
  stopSession: async () => {
    await stopAllAudioCapture();
    return ipcRenderer.invoke("stop_session");
  },
  pauseSession: async () => {
    capturePaused = true;
    pendingPcm = Buffer.alloc(0);
    pendingMicrophonePcm = Buffer.alloc(0);
    return ipcRenderer.invoke("pause_session");
  },
  resumeSession: async () => {
    capturePaused = false;
    return ipcRenderer.invoke("resume_session");
  },
  setMicrophoneCaptureEnabled: async (enabled, settings = {}) => {
    if (enabled) {
      try {
        await startMicrophoneCapture(settings?.microphoneDeviceId);
      } catch (error) {
        await stopMicrophoneCapture();
        await ipcRenderer.invoke("microphone_capture_error", error instanceof Error ? error.message : String(error));
        throw error;
      }
      try {
        return await ipcRenderer.invoke("set_microphone_capture_enabled", true, settings);
      } catch (error) {
        await stopMicrophoneCapture();
        throw error;
      }
    }
    await stopMicrophoneCapture();
    return ipcRenderer.invoke("set_microphone_capture_enabled", false, settings);
  },
  setManualQuestionMarking: (active) => ipcRenderer.invoke("set_manual_question_marking", Boolean(active)),
  submitManualQuestionSegment: (payload) => ipcRenderer.invoke("submit_manual_question_segment", payload),
  undoManualQuestion: (matchId) => ipcRenderer.invoke("undo_manual_question", matchId),
  searchQuestions: (query, companyId) => ipcRenderer.invoke("search_questions", query, companyId),
  getHealthStatus: (companyId) => ipcRenderer.invoke("get_health_status", companyId),
  listen: (channel, handler) => {
    if (!EVENT_CHANNELS.has(channel)) return () => undefined;
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("interviewCopilot", api);
