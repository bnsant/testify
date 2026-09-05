import { openSocket, sendJson, waitForMessage, waitForOpen } from "./signaling.js";
import { applyCaptureProfile, enforceCapturedAudioSafety, stopStream } from "./capture.js";
import { MIME_TYPES, PROTOCOL_VERSION, QUALITY_PROFILES, profileFor, lowerProfile } from "../../../shared/streaming.js";

const TIMESLICE_MS = 200;
const MAX_SOCKET_QUEUE_MS = 750;

export function captureSourceFingerprint(stream) {
  const track = stream?.getVideoTracks?.()[0];
  const settings = track?.getSettings?.() || {};
  return [track?.label || "", settings.displaySurface || "", settings.deviceId || "", settings.logicalSurface ?? ""].join("|");
}
export async function issueCaptureToken(sessionToken) {
  const response = await fetch("/api/capture-token", { method: "POST", headers: { Authorization: `Bearer ${sessionToken}` } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Não foi possível abrir a captura.");
  return payload;
}
export async function claimCaptureToken(token) {
  const response = await fetch("/api/capture/claim", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Link de captura inválido.");
  return payload;
}
function chooseMimeType(hasAudio, acceptedTypes) {
  return MIME_TYPES.find((type) => {
    const includesAudio = /opus|mp4a/.test(type);
    return includesAudio === hasAudio && acceptedTypes.includes(type) && MediaRecorder.isTypeSupported(type);
  });
}
export async function startBroadcast({
  stream, captureSessionToken, profile = "balanced", automatic = true, onStatus = () => {}, onStats = () => {}
}) {
  let socket, recorder, mimeType;
  let stopped = false;
  let reconnectTimer, restartTimer, statsTimer, sourceTimer;
  let reconnectAttempts = 0;
  let serial = Promise.resolve();
  let pendingData = Promise.resolve();
  let activeProfile = Object.hasOwn(QUALITY_PROFILES, profile) ? profile : "balanced";
  let changedAt = 0;
  let sentBytes = 0;
  let lastBytes = 0;
  let congestedSamples = 0;
  let intentionalSocket;
  let epochBlocked = false;
  let restartWithFreshSocket = false;
  let sequence = 0;
  let serverClockOffset = 0;
  let acceptedMimeTypes = [];
  let sourceFingerprint = captureSourceFingerprint(stream);
  let pendingSourceChange = false;
  let mutedAt = 0;
  const videoTrack = stream.getVideoTracks()[0];
  const ended = () => { void stop(); };
  const sourceChanged = () => {
    if (stopped) return;
    pendingSourceChange = true;
    sourceFingerprint = captureSourceFingerprint(stream);
    onStatus("switching", "Aplicando a nova tela sem carregar o atraso anterior…");
    scheduleRestart(true);
  };
  const trackMuted = () => { mutedAt = Date.now(); };
  const trackUnmuted = () => {
    const switchDuration = mutedAt ? Date.now() - mutedAt : 0;
    mutedAt = 0;
    if (switchDuration > 0 && switchDuration < 30_000) sourceChanged();
  };
  videoTrack.addEventListener("ended", ended, { once: true });
  videoTrack.addEventListener("mute", trackMuted);
  videoTrack.addEventListener("unmute", trackUnmuted);
  videoTrack.addEventListener("capturehandlechange", sourceChanged);

  function enqueue(operation) {
    const result = serial.then(operation);
    serial = result.catch(() => {});
    return result;
  }
  async function stopRecorder() {
    const current = recorder;
    recorder = null;
    if (current && current.state !== "inactive") {
      await new Promise((resolve) => {
        current.addEventListener("stop", resolve, { once: true });
        current.stop();
      });
    }
    await pendingData.catch(() => {});
  }
  async function beginEpoch() {
    await stopRecorder();
    if (stopped || socket?.readyState !== WebSocket.OPEN) return;
    if (pendingSourceChange) {
      enforceCapturedAudioSafety(stream);
      pendingSourceChange = false;
    }
    await applyCaptureProfile(stream, activeProfile);
    if (stopped || socket?.readyState !== WebSocket.OPEN) return;
    mimeType = chooseMimeType(stream.getAudioTracks().length > 0, acceptedMimeTypes);
    if (!mimeType) throw new Error("Não há formato compatível para a nova tela selecionada.");
    sourceFingerprint = captureSourceFingerprint(stream);
    const activeSocket = socket;
    const options = { mimeType, videoBitsPerSecond: profileFor(activeProfile).bitrate,
      audioBitsPerSecond: 128_000, videoKeyFrameIntervalDuration: 1000 };
    const nextRecorder = new MediaRecorder(stream, options);
    const ready = waitForMessage(activeSocket, "broadcast-ready");
    sendJson(activeSocket, { type: "start-broadcast", mimeType, profile: activeProfile });
    await ready;
    if (stopped || activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN) return;
    recorder = nextRecorder;
    epochBlocked = false;
    nextRecorder.addEventListener("dataavailable", (event) => {
      if (!event.data.size) return;
      pendingData = pendingData.then(async () => {
        const buffer = await event.data.arrayBuffer();
        if (stopped || epochBlocked || activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN) return;
        const queueBudget = Math.max(96_000, profileFor(activeProfile).bitrate / 8 * MAX_SOCKET_QUEUE_MS / 1000);
        if (activeSocket.bufferedAmount > queueBudget) {
          if (automatic) activeProfile = lowerProfile(activeProfile);
          scheduleRestart(true);
          return;
        }
        sendJson(activeSocket, { type: 'media-meta', capturedAt: Date.now() + serverClockOffset, sequence: sequence++ });
        activeSocket.send(buffer);
        sentBytes += buffer.byteLength;
      }).catch((error) => { onStatus("error", error.message); void stop(); });
    });
    nextRecorder.addEventListener("error", (event) => {
      onStatus("error", event.error?.message || "Erro na codificação.");
      void stop();
    });
    nextRecorder.start(TIMESLICE_MS);
    changedAt = Date.now();
    onStatus("live", profileFor(activeProfile).label);
  }
  function scheduleRestart(freshSocket = false) {
    if (stopped) return;
    restartWithFreshSocket ||= freshSocket;
    if (restartTimer) return;
    // Once bytes are skipped, never continue the same container sequence.
    // Congestion and source switches also replace the socket, which is the
    // only way to discard bytes already queued by ordered TCP transport.
    epochBlocked = true;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      const replace = restartWithFreshSocket;
      restartWithFreshSocket = false;
      if (replace) {
        enqueue(() => connect(true)).catch((error) => { onStatus('error', error.message); void stop(); });
        return;
      }
      enqueue(beginEpoch).catch((error) => { onStatus("error", error.message); void stop(); });
    }, 100);
  }
  function reduceQuality() {
    if (!automatic || Date.now() - changedAt < 15_000) return;
    const next = lowerProfile(activeProfile);
    if (next === activeProfile) return;
    activeProfile = next; changedAt = Date.now();
    restartWithFreshSocket = true;
    onStatus("adapting", profileFor(activeProfile).label);
    scheduleRestart();
  }
  async function connect(replacing = false) {
    const previous = replacing ? socket : null;
    const next = openSocket();
    socket = next;
    await waitForOpen(next);
    const clockReady = waitForMessage(next, 'server-clock');
    const authenticated = waitForMessage(next, "capture-authenticated");
    sendJson(next, { type: "authenticate-capture", captureSessionToken, protocolVersion: PROTOCOL_VERSION });
    const [grant, clock] = await Promise.all([authenticated, clockReady]);
    if (stopped) { next.close(); return; }
    if (Number.isFinite(clock.serverTime)) serverClockOffset = clock.serverTime - Date.now();
    acceptedMimeTypes = grant.mimeTypes || [];
    mimeType = chooseMimeType(stream.getAudioTracks().length > 0, acceptedMimeTypes);
    if (!mimeType) throw new Error("Não há formato de vídeo compatível entre o Chrome e os participantes. Tente sem áudio ou use Chrome/Edge para assistir.");
    next.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || socket !== next) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "resync-request") scheduleRestart();
      if (message.type === "reduce-quality") reduceQuality();
      if (message.type === "broadcast-stopped") void stop();
      if (message.type === "error") onStatus("error", message.message);
    });
    next.addEventListener("close", (event) => {
      if (stopped || intentionalSocket === next || socket !== next) return;
      void stopRecorder();
      if (event.code === 1008 || reconnectAttempts >= 3) {
        onStatus("error", "A conexão terminou. Volte à Activity para abrir uma nova captura.");
        void stop(); return;
      }
      if (automatic && event.code === 4000) activeProfile = lowerProfile(activeProfile);
      onStatus("reconnecting", "Reconectando a transmissão…");
      const delay = Math.min(8000, 1000 * 2 ** reconnectAttempts++);
      reconnectTimer = setTimeout(() => {
        enqueue(connect).catch((error) => { onStatus("error", error.message); void stop(); });
      }, delay);
    });
    await beginEpoch();
    if (previous && previous !== next) {
      intentionalSocket = previous;
      try { previous.close(4001, 'Nova sequencia ao vivo'); } catch { /* already closed */ }
    }
  }
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(restartTimer); clearTimeout(reconnectTimer); clearInterval(statsTimer); clearInterval(sourceTimer);
    videoTrack.removeEventListener("ended", ended);
    videoTrack.removeEventListener("mute", trackMuted);
    videoTrack.removeEventListener("unmute", trackUnmuted);
    videoTrack.removeEventListener("capturehandlechange", sourceChanged);
    stopStream(stream);
    await stopRecorder();
    if (socket?.readyState === WebSocket.OPEN) sendJson(socket, { type: "stop-broadcast" });
    intentionalSocket = socket; socket?.close();
    onStatus("stopped");
  }
  try {
    if (!globalThis.MediaRecorder) throw new Error("Este navegador não consegue transmitir. Use Chrome ou Edge.");
    await enqueue(connect);
    sourceTimer = setInterval(() => {
      const nextFingerprint = captureSourceFingerprint(stream);
      if (nextFingerprint !== sourceFingerprint) sourceChanged();
    }, 750);
    if (!stopped) statsTimer = setInterval(() => {
      const buffered = socket?.bufferedAmount || 0;
      const stats = stream.getVideoTracks()[0]?.getSettings() || {};
      onStats({ profile: activeProfile, width: stats.width, height: stats.height, fps: stats.frameRate,
        bitrate: (sentBytes - lastBytes) * 8 / 2, bufferedBytes: buffered, mimeType });
      lastBytes = sentBytes;
      congestedSamples = buffered > profileFor(activeProfile).bitrate / 8 ? congestedSamples + 1 : 0;
      if (congestedSamples >= 2) reduceQuality();
    }, 2000);
  } catch (error) { await stop(); throw error; }
  return {
    stop,
    get socket() { return socket; },
    get recorder() { return recorder; },
    get mimeType() { return mimeType; },
    get profile() { return activeProfile; },
    refreshSource: sourceChanged,
    setProfile(name) {
      if (!Object.hasOwn(QUALITY_PROFILES, name) || stopped) return;
      activeProfile = name; changedAt = 0; scheduleRestart(true);
    }
  };
}
