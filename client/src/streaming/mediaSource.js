// Safari/iOS não expõem `MediaSource` no iPhone, apenas `ManagedMediaSource`
// (iOS 17.1+). A API é compatível o suficiente para uso ao vivo; as diferenças
// tratadas aqui são: exigir `disableRemotePlayback` no <video> antes de anexar e
// só crescer o buffer enquanto o navegador estiver pedindo dados.
const MediaSourceImpl =
  (typeof window !== "undefined" && (window.ManagedMediaSource || window.MediaSource)) || null;

// Alvo de atraso entre o player e a borda ao vivo. Folga suficiente para o jitter
// da rede, apertada o bastante para não parecer gravado. Acima de LIVE_MAX o
// player salta para a borda; entre o alvo e o máximo ele acelera de leve,
// proporcional ao quanto está atrasado, para queimar o excesso em poucos
// segundos sem soar acelerado.
const LIVE_TARGET_SECONDS = 0.8;
const LIVE_MAX_SECONDS = 2.2;
const MAX_CATCHUP_RATE = 1.15;
const BUFFER_BEHIND_SECONDS = 8;

function isContainerSupported(mimeType) {
  return Boolean(MediaSourceImpl?.isTypeSupported?.(mimeType));
}

export class MediaSourcePlayer {
  constructor(video) {
    this.video = video;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.objectUrl = null;
    this.streaming = true;
    this.syncTimer = null;
  }

  start(mimeType) {
    this.destroy();
    if (!MediaSourceImpl || !isContainerSupported(mimeType)) {
      throw new Error(`O player não suporta ${mimeType}.`);
    }
    this.streaming = true;
    this.mediaSource = new MediaSourceImpl();
    // Sem isto o ManagedMediaSource lança ao anexar no Safari/iOS.
    try { this.video.disableRemotePlayback = true; } catch { /* ignore */ }
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.srcObject = null;
    this.video.src = this.objectUrl;

    this.mediaSource.addEventListener("sourceopen", () => {
      if (this.mediaSource.readyState !== "open") return;
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
      this.sourceBuffer.mode = "sequence";
      this.sourceBuffer.addEventListener("updateend", () => this.flush());
      this.flush();
    }, { once: true });

    // Hints do ManagedMediaSource: pausa/retoma a anexação para poupar memória e
    // bateria no celular. Em MediaSource comum estes eventos nunca disparam.
    this.mediaSource.addEventListener("startstreaming", () => { this.streaming = true; this.flush(); });
    this.mediaSource.addEventListener("endstreaming", () => { this.streaming = false; });

    this.primed = false;
    // Correção num timer curto — rápido o suficiente para não deixar o atraso
    // acumular, espaçado o suficiente para não reagir a cada hiccup.
    this.syncTimer = setInterval(() => this.syncToLiveEdge(), 700);

    this.video.play().catch(() => {});
  }

  push(chunk) {
    this.queue.push(new Uint8Array(chunk));
    // Enquanto o navegador não pede dados, limita a fila para não estourar a
    // memória numa transmissão longa; ao retomar, parte do próximo fragmento.
    if (!this.streaming && this.queue.length > 240) this.queue.splice(0, this.queue.length - 240);
    this.flush();
  }

  flush() {
    if (this.mediaSource?.readyState !== "open") return;
    if (!this.sourceBuffer || this.sourceBuffer.updating || !this.streaming || !this.queue.length) return;
    try { this.sourceBuffer.appendBuffer(this.queue.shift()); }
    catch (error) {
      if (error.name === "QuotaExceededError" && this.sourceBuffer.buffered.length) {
        const end = this.sourceBuffer.buffered.end(0);
        this.sourceBuffer.remove(0, Math.max(0, end - 20));
      } else throw error;
    }
  }

  // Mantém a reprodução perto da borda ao vivo. Ao vivo, o buffer à frente do
  // cursor É a latência; deixá-lo crescer é o "delay de 5 s". Por isso: assim que
  // dá pra tocar, pula pra borda; depois só deixa acelerar de leve ou salta se
  // estourar o teto.
  syncToLiveEdge() {
    const buffer = this.sourceBuffer;
    const video = this.video;
    if (!buffer || !video || video.seeking || this.mediaSource?.readyState !== "open") return;
    if (!buffer.buffered.length) return;

    const liveEdge = buffer.buffered.end(buffer.buffered.length - 1);
    const start = buffer.buffered.start(0);
    const seekable = liveEdge - LIVE_TARGET_SECONDS;
    const latency = liveEdge - video.currentTime;

    // Primeiro sync após ter mídia suficiente: cola na borda de uma vez.
    if (!this.primed && video.readyState >= 2 && liveEdge - start > LIVE_TARGET_SECONDS) {
      this.primed = true;
      try { video.currentTime = Math.max(start + 0.05, seekable); } catch { /* ignore */ }
      video.play().catch(() => {});
      return;
    }

    if (video.currentTime < start - 0.1 || latency > LIVE_MAX_SECONDS) {
      try { video.currentTime = Math.max(start + 0.05, seekable); } catch { /* ignore */ }
      video.playbackRate = 1;
    } else if (latency > LIVE_TARGET_SECONDS + 0.25) {
      // Proporcional: quanto mais atrás, mais rápido — até MAX_CATCHUP_RATE.
      const over = latency - LIVE_TARGET_SECONDS;
      video.playbackRate = Math.min(MAX_CATCHUP_RATE, 1 + over * 0.3);
    } else if (video.playbackRate !== 1) {
      video.playbackRate = 1;
    }

    if (!buffer.updating && video.currentTime - start > BUFFER_BEHIND_SECONDS) {
      try { buffer.remove(start, video.currentTime - BUFFER_BEHIND_SECONDS / 2); } catch { /* ignore */ }
    }
  }

  destroy() {
    this.queue = [];
    this.streaming = true;
    this.primed = false;
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.sourceBuffer?.updating) this.sourceBuffer.abort();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    if (this.video) { this.video.removeAttribute("src"); this.video.load(); this.video.playbackRate = 1; }
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.objectUrl = null;
  }
}
