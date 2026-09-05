// Prefer the live edge over uninterrupted playback. WebSocket is ordered, so
// stale media must be abandoned instead of being played several seconds late.
const LIVE_TARGET_SECONDS = 0.65;
const LIVE_MAX_SECONDS = 1.35;
const MAX_TRANSPORT_MS = 1_100;
const MAX_QUEUE_BYTES = 1536 * 1024;
const MAX_QUEUE_CHUNKS = 12;

export class MediaSourcePlayer {
  constructor(video, { onError = () => {}, onStats = () => {}, onLatencyExceeded = onError } = {}) {
    this.video = video; this.onError = onError; this.onStats = onStats; this.onLatencyExceeded = onLatencyExceeded;
    this.queue = []; this.queuedBytes = 0; this.generation = 0;
    this.staleChunks = 0; this.transportMs = 0;
  }
  start(mimeType) {
    this.destroy();
    const Impl = globalThis.MediaSource || globalThis.ManagedMediaSource;
    if (!Impl?.isTypeSupported(mimeType)) throw new Error("Este dispositivo não reproduz o formato da transmissão.");
    const source = new Impl();
    const generation = this.generation;
    this.mediaSource = source;
    this.video.disableRemotePlayback = true;
    this.video.srcObject = null;
    this.objectUrl = URL.createObjectURL(source);
    this.video.src = this.objectUrl;
    this.streaming = true;
    this.failed = false;
    this.startedAt = Date.now();
    this.lastProgressAt = Date.now();
    this.lastTime = 0;
    this.primed = false;
    this.staleChunks = 0;
    this.transportMs = 0;
    this.onVideoError = () => this.fail(new Error("Falha ao decodificar a transmissão. Ressincronizando…"));
    this.video.addEventListener("error", this.onVideoError);
    source.addEventListener("sourceopen", () => {
      if (generation !== this.generation || source.readyState !== "open") return;
      try {
        this.sourceBuffer = source.addSourceBuffer(mimeType);
        // Preserve muxed timestamps. Sequence mode can collapse audio/video timing.
        this.sourceBuffer.mode = "segments";
        this.sourceBuffer.addEventListener("error", () => { if (generation === this.generation) this.fail(new Error("Fragmento de vídeo inválido. Ressincronizando…")); });
        this.sourceBuffer.addEventListener("updateend", () => this.flush());
        this.flush();
      } catch (error) { this.fail(error); }
    }, { once: true });
    source.addEventListener("startstreaming", () => { this.streaming = true; this.flush(); });
    source.addEventListener("endstreaming", () => { this.streaming = false; });
    this.syncTimer = setInterval(() => this.syncToLiveEdge(), 500);
    this.video.play().catch(() => {});
  }
  fail(error) {
    if (this.failed || !this.mediaSource) return;
    this.failed = true;
    this.queue = []; this.queuedBytes = 0;
    this.onError(error);
  }
  push(packet) {
    if (this.failed || !this.mediaSource) return;
    const chunk = packet?.data || packet;
    const transportMs = Number(packet?.transportMs);
    if (Number.isFinite(transportMs)) {
      this.transportMs = Math.max(0, transportMs);
      this.staleChunks = this.transportMs > MAX_TRANSPORT_MS ? this.staleChunks + 1 : 0;
      if (this.staleChunks >= 2) {
        this.failed = true;
        this.queue = []; this.queuedBytes = 0;
        this.onLatencyExceeded(new Error('Player atrasado. Ressincronizando...'));
        return;
      }
    }
    const bytes = new Uint8Array(chunk);
    if (this.queuedBytes + bytes.byteLength > MAX_QUEUE_BYTES || this.queue.length >= MAX_QUEUE_CHUNKS) {
      this.failed = true;
      this.queue = []; this.queuedBytes = 0;
      this.onLatencyExceeded(new Error('Player atrasado. Ressincronizando...'));
      return;
    }
    this.queue.push(bytes); this.queuedBytes += bytes.byteLength;
    this.flush();
  }
  flush() {
    const buffer = this.sourceBuffer;
    if (this.failed || this.mediaSource?.readyState !== "open" || !buffer || buffer.updating || !this.streaming || !this.queue.length) return;
    const chunk = this.queue[0];
    try {
      buffer.appendBuffer(chunk);
      this.queue.shift(); this.queuedBytes -= chunk.byteLength;
    } catch (error) {
      if (error.name === "QuotaExceededError" && buffer.buffered.length && this.video.currentTime - buffer.buffered.start(0) > 2) {
        try { buffer.remove(buffer.buffered.start(0), this.video.currentTime - 1); }
        catch (removeError) { this.fail(removeError); }
        // Keep the SAME chunk queued for the updateend retry.
      } else this.fail(error);
    }
  }
  syncToLiveEdge() {
    const buffer = this.sourceBuffer, video = this.video;
    if (this.failed) return;
    if (!buffer || this.mediaSource?.readyState !== "open") {
      if (Date.now() - this.startedAt > 12_000 && document.visibilityState !== "hidden") {
        this.fail(new Error("O player não iniciou. Ressincronizando…"));
      }
      return;
    }
    const ranges = buffer.buffered;
    if (video.currentTime > this.lastTime + 0.01) {
      this.lastTime = video.currentTime; this.lastProgressAt = Date.now();
    }
    if (Date.now() - this.lastProgressAt > 20_000 && document.visibilityState !== "hidden") {
      this.fail(new Error("A transmissão parou de avançar. Ressincronizando…")); return;
    }
    if (!ranges.length || video.seeking) return;
    const start = ranges.start(ranges.length - 1), edge = ranges.end(ranges.length - 1);
    const behind = Math.max(0, edge - video.currentTime);
    if ((!this.primed && edge - start > LIVE_TARGET_SECONDS) || video.currentTime < start || behind > LIVE_MAX_SECONDS) {
      try { video.currentTime = Math.max(start, edge - LIVE_TARGET_SECONDS); } catch { /* seek on next tick */ }
      this.primed = true;
      video.play().catch(() => {});
    }
    video.playbackRate = behind > LIVE_TARGET_SECONDS + 0.25 && behind <= LIVE_MAX_SECONDS ? 1.08 : 1;
    if (!buffer.updating && video.currentTime - ranges.start(0) > 8) {
      try { buffer.remove(ranges.start(0), video.currentTime - 4); } catch { /* retry */ }
    }
    const quality = video.getVideoPlaybackQuality?.();
    this.onStats({ bufferSeconds: behind, transportMs: this.transportMs, stalled: video.readyState < 3,
      decodedFrames: quality?.totalVideoFrames || 0, droppedFrames: quality?.droppedVideoFrames || 0 });
  }
  destroy() {
    this.generation++;
    clearInterval(this.syncTimer);
    if (this.onVideoError) this.video.removeEventListener("error", this.onVideoError);
    try { if (this.mediaSource?.readyState === "open" && this.sourceBuffer?.updating) this.sourceBuffer.abort(); } catch {}
    this.mediaSource = null; this.sourceBuffer = null;
    this.queue = []; this.queuedBytes = 0;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.video.removeAttribute("src");
    this.video.load(); this.video.playbackRate = 1;
  }
}
