function websocketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

export class ActivitySocket extends EventTarget {
  constructor(sessionToken) {
    super();
    this.sessionToken = sessionToken;
    this.socket = null;
    this.retry = 0;
    this.closed = false;
    this.timer = null;
  }

  connect() {
    if (this.closed) return;
    const socket = new WebSocket(websocketUrl());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.retry = 0;
      socket.send(JSON.stringify({ type: "authenticate", sessionToken: this.sessionToken }));
      this.dispatchEvent(new Event("connected"));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        this.dispatchEvent(new CustomEvent("media", { detail: event.data }));
        return;
      }
      try { this.dispatchEvent(new CustomEvent("message", { detail: JSON.parse(event.data) })); } catch { /* ignore */ }
    });
    socket.addEventListener("close", () => {
      this.dispatchEvent(new Event("disconnected"));
      if (!this.closed) {
        const delay = Math.min(10_000, 700 * (2 ** this.retry++));
        this.timer = setTimeout(() => this.connect(), delay);
      }
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.close();
  }
}

export function openSocket() {
  const socket = new WebSocket(websocketUrl());
  socket.binaryType = "arraybuffer";
  return socket;
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

export function sendJson(socket, payload) {
  socket.send(JSON.stringify(payload));
}
