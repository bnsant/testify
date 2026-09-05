import { PROTOCOL_VERSION, supportedPlaybackTypes } from "../../../shared/streaming.js";

const MAX_TRANSPORT_MS = 1_100;

function websocketUrl() {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
}
export class ActivitySocket extends EventTarget {
  constructor(sessionToken) {
    super();
    this.sessionToken = sessionToken;
    this.retry = 0;
    this.closed = false;
    this.serverClockOffset = 0;
    this.staleMediaChunks = 0;
  }
  connect() {
    if (this.closed) return;
    const socket = openSocket();
    this.socket = socket;
    socket.addEventListener("open", () => {
      sendJson(socket, { type: "authenticate", sessionToken: this.sessionToken,
        protocolVersion: PROTOCOL_VERSION, mimeTypes: supportedPlaybackTypes() });
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket || this.closed) return;
      if (typeof event.data !== 'string') {
        const meta = this.pendingMediaMeta;
        this.pendingMediaMeta = null;
        const transportMs = Number.isFinite(meta?.capturedAt)
          ? Math.max(0, Date.now() + this.serverClockOffset - meta.capturedAt)
          : 0;
        this.staleMediaChunks = transportMs > MAX_TRANSPORT_MS ? this.staleMediaChunks + 1 : 0;
        if (this.staleMediaChunks >= 2) {
          this.refreshMedia();
          return;
        }
        this.dispatchEvent(new CustomEvent('media', { detail: {
          data: event.data, sequence: meta?.sequence, transportMs
        } }));
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'server-clock' && Number.isFinite(message.serverTime)) {
        this.serverClockOffset = message.serverTime - Date.now();
      }
      if (message.type === 'media-meta') {
        this.pendingMediaMeta = message;
        return;
      }
      if (message.type === "authenticated") {
        this.retry = 0;
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          if (socket === this.socket && socket.readyState === WebSocket.OPEN) {
            sendJson(socket, { type: "ping" });
          }
        }, 15_000);
        this.dispatchEvent(new Event("connected"));
      }
      this.dispatchEvent(new CustomEvent("message", { detail: message }));
    });
    socket.addEventListener("close", (event) => {
      if (socket !== this.socket) return;
      clearInterval(this.heartbeat);
      if (!this.closed) this.dispatchEvent(new Event("disconnected"));
      if (event.code === 1008) {
        this.closed = true;
        this.dispatchEvent(new CustomEvent("message", { detail: { type: "error", message: "A sessão terminou ou o acesso foi recusado. Feche e reabra a Activity." } }));
      }
      if (!this.closed) {
        const delay = Math.min(5_000, 500 * 2 ** this.retry++) + Math.random() * 250;
        this.timer = setTimeout(() => this.connect(), delay);
      }
    });
    socket.addEventListener("error", () => { /* close handles reconnection */ });
  }
  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) sendJson(this.socket, payload);
  }
  refreshMedia() {
    if (this.closed) return;
    const stale = this.socket;
    this.socket = null;
    this.pendingMediaMeta = null;
    this.staleMediaChunks = 0;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.retry = 0;
    try { stale?.close(4001, 'Atualizando midia'); } catch { /* the fresh socket takes over */ }
    this.connect();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.socket?.close();
  }
}
export function openSocket() {
  const socket = new WebSocket(websocketUrl());
  socket.binaryType = "arraybuffer";
  return socket;
}
export function waitForOpen(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Tempo esgotado ao conectar ao Testify.")), timeoutMs);
    const onOpen = () => finish();
    const onError = () => finish(new Error("Não foi possível conectar ao Testify."));
    function finish(error) {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onError);
      if (error) { socket.close(); reject(error); } else resolve();
    }
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onError, { once: true });
  });
}
export function waitForMessage(socket, type, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Tempo esgotado ao conectar com a transmissão.")), timeoutMs);
    function onMessage(event) {
      if (typeof event.data !== "string") return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "error") return finish(new Error(message.message));
      if (message.type === type) finish(null, message);
    }
    function onClose() { finish(new Error("A conexão foi encerrada.")); }
    function finish(error, value) {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      error ? reject(error) : resolve(value);
    }
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}
export function sendJson(socket, payload) { socket.send(JSON.stringify(payload)); }
