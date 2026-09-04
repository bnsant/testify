import { openSocket, sendJson, waitForMessage } from "./signaling.js";

// Cada fragmento do MediaRecorder só sai depois de acumular este tempo de mídia,
// então ele é o piso de latência do transporte. 300 ms corta bastante da latência
// original (500 ms) sem gerar fragmentos pequenos demais, que picotam em redes
// instáveis. Sub-200 ms exigiria WebRTC, que o proxy de Activities não suporta.
const TIMESLICE_MS = 300;
// 6 Mbps sustenta 1080p60 de tela (conteúdo comprime bem) sem afogar uploads
// domésticos nem o túnel de dev. Suba com cautela — bitrate alto vira latência.
const VIDEO_BITS_PER_SECOND = 6_000_000;

export async function issueCaptureToken(sessionToken) {
  const response = await fetch("/api/capture-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}` }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Não foi possível abrir a captura.");
  return payload;
}

export async function claimCaptureToken(token) {
  const response = await fetch("/api/capture/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Link de captura inválido.");
  return payload;
}

function chooseMimeType(hasAudio) {
  // MP4/H.264 primeiro: é o que Safari/iOS conseguem reproduzir via
  // ManagedMediaSource. WebM/VP8-9 fica como fallback para navegadores cujo
  // MediaRecorder ainda não grava MP4 (aí só quem assiste no desktop vê).
  const choices = hasAudio
    ? [
        'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
        "video/mp4",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm"
      ]
    : [
        'video/mp4;codecs="avc1.42E01E"',
        "video/mp4",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
      ];
  return choices.find((value) => MediaRecorder.isTypeSupported(value)) || "";
}

export async function startBroadcast({ stream, captureSessionToken, onStatus = () => {} }) {
  const socket = openSocket();
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Falha ao conectar ao servidor.")), { once: true });
  });
  sendJson(socket, { type: "authenticate-capture", captureSessionToken });
  await waitForMessage(socket, "capture-authenticated");

  const mimeType = chooseMimeType(stream.getAudioTracks().length > 0);
  if (!mimeType) throw new Error("Este navegador não oferece MediaRecorder compatível (WebM ou MP4).");
  sendJson(socket, { type: "start-broadcast", mimeType });
  await waitForMessage(socket, "broadcast-ready");

  // Prioriza taxa de quadros sobre nitidez: conteúdo de tela com movimento (jogo,
  // scroll) fica fluido a 60 fps em vez de "travadinho" e nítido.
  for (const track of stream.getVideoTracks()) {
    track.contentHint = "motion";
  }

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: 128_000,
    // Keyframe a cada 1 s: sem isto o encoder de tela espaça keyframes por vários
    // segundos, e o player só consegue "colar" na borda ao vivo num keyframe —
    // era a maior fonte do delay de ~5 s. Ignorado por navegadores que não
    // suportam a opção.
    videoKeyFrameIntervalDuration: 1000
  });
  let pending = Promise.resolve();
  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data.size) return;
    pending = pending.then(() => event.data.arrayBuffer()).then((buffer) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(buffer);
    });
  });
  recorder.addEventListener("error", (event) => onStatus("error", event.error?.message || "Erro na codificação."));
  recorder.start(TIMESLICE_MS);
  onStatus("live", mimeType);

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (recorder.state !== "inactive") recorder.stop();
    await pending.catch(() => {});
    if (socket.readyState === WebSocket.OPEN) sendJson(socket, { type: "stop-broadcast" });
    setTimeout(() => socket.close(), 150);
    onStatus("stopped");
  }
  for (const track of stream.getVideoTracks()) track.addEventListener("ended", stop, { once: true });
  socket.addEventListener("close", () => onStatus("disconnected"));
  return { stop, socket, recorder, mimeType };
}
