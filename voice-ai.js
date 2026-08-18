function downsample(input, sourceRate, targetRate = 16000) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

function floatToPcm16(input) {
  const output = new ArrayBuffer(input.length * 2);
  const view = new DataView(output);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return output;
}

function pcm16ToFloat(input) {
  const view = new DataView(input);
  const output = new Float32Array(Math.floor(input.byteLength / 2));
  for (let index = 0; index < output.length; index += 1) output[index] = view.getInt16(index * 2, true) / 32768;
  return output;
}

function socketUrl() {
  const configuredBase = String(globalThis.WORDSAIL_CONFIG?.apiBase || "").replace(/\/$/, "");
  if (configuredBase) {
    const endpoint = new URL(configuredBase);
    const protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${endpoint.host}${endpoint.pathname.replace(/\/$/, "")}/api/voice`;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/voice`;
}

export class VoiceAIClient {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.socket = null;
    this.stream = null;
    this.captureContext = null;
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.playbackContext = null;
    this.playbackCursor = 0;
    this.playingSources = new Set();
    this.muted = false;
    this.ready = false;
    this.closed = false;
  }

  async start(settings) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持麦克风访问，请使用最新版 Chrome。 ");
    this.closed = false;
    this.callbacks.onState?.("permission");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.playbackContext = new AudioContextClass();
    await this.playbackContext.resume();

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(socketUrl());
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      const timeout = setTimeout(() => reject(new Error("连接词舟语音服务超时，请检查本地服务。")), 18000);

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "start", ...settings }));
      };
      socket.onmessage = async event => {
        if (typeof event.data !== "string") {
          const audio = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();
          this.enqueueAudio(audio, 24000);
          return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "ready") {
          clearTimeout(timeout);
          this.ready = true;
          await this.startCapture();
          this.callbacks.onReady?.(message);
          resolve();
        }
        if (message.type === "state") {
          if (message.state === "user_speaking") this.stopPlayback();
          this.callbacks.onState?.(message.state);
        }
        if (message.type === "asr" && message.text) this.callbacks.onTranscript?.("user", message.text, message);
        if (message.type === "assistant" && message.text) this.callbacks.onTranscript?.("assistant", message.text, message);
        if (message.type === "error") {
          clearTimeout(timeout);
          const error = new Error(message.message || "语音服务发生错误");
          error.code = message.code;
          this.callbacks.onError?.(error);
          if (!this.ready) reject(error);
        }
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        const error = new Error("无法连接词舟语音服务，请确认网页服务已经启动。");
        this.callbacks.onError?.(error);
        reject(error);
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        if (!this.closed) this.callbacks.onState?.("closed");
      };
    });
  }

  async startCapture() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.captureContext = new AudioContextClass();
    await this.captureContext.resume();
    this.source = this.captureContext.createMediaStreamSource(this.stream);
    this.processor = this.captureContext.createScriptProcessor(2048, 1, 1);
    this.silentGain = this.captureContext.createGain();
    this.silentGain.gain.value = 0;
    this.processor.onaudioprocess = event => {
      if (this.muted || !this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
      const samples = event.inputBuffer.getChannelData(0);
      const pcm = floatToPcm16(downsample(samples, this.captureContext.sampleRate, 16000));
      this.socket.send(pcm);
    };
    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.captureContext.destination);
  }

  enqueueAudio(arrayBuffer, sampleRate) {
    if (!arrayBuffer?.byteLength || !this.playbackContext) return;
    const samples = pcm16ToFloat(arrayBuffer);
    const buffer = this.playbackContext.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackContext.destination);
    const now = this.playbackContext.currentTime;
    this.playbackCursor = Math.max(this.playbackCursor, now + 0.04);
    source.start(this.playbackCursor);
    this.playbackCursor += buffer.duration;
    this.playingSources.add(source);
    source.onended = () => this.playingSources.delete(source);
  }

  stopPlayback() {
    for (const source of this.playingSources) {
      try { source.stop(); } catch { /* Already stopped. */ }
    }
    this.playingSources.clear();
    if (this.playbackContext) this.playbackCursor = this.playbackContext.currentTime;
  }

  setMuted(value) {
    this.muted = Boolean(value);
    for (const track of this.stream?.getAudioTracks?.() || []) track.enabled = !this.muted;
  }

  sendPrompt(content) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "prompt", content }));
  }

  async stop() {
    this.closed = true;
    this.ready = false;
    try {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "finish" }));
      this.socket?.close();
    } catch { /* Socket already closed. */ }
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    for (const track of this.stream?.getTracks?.() || []) track.stop();
    this.stopPlayback();
    await Promise.allSettled([this.captureContext?.close?.(), this.playbackContext?.close?.()]);
    this.socket = null;
    this.stream = null;
    this.captureContext = null;
    this.playbackContext = null;
  }
}
