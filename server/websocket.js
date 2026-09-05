import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_MEDIA_CHUNK_BYTES, parseJsonMessage, validateMimeType } from "./protocol.js";
import { RoomRegistry } from "./rooms.js";
import { MIME_TYPES, PROTOCOL_VERSION, QUALITY_PROFILES, profileFor } from "../shared/streaming.js";

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function publicBroadcaster(b) {
  if (!b) return null;
  return { userId: b.user.id, displayName: b.user.displayName, avatar: b.user.avatar,
    mimeType: b.mimeType, streamId: b.streamId, profile: b.profile };
}
export function attachWebSocketServer(httpServer, {
  config, sessions, captureSessions, rooms = new RoomRegistry(), verifyMembership = async () => {}
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MEDIA_CHUNK_BYTES, perMessageDeflate: false });
  const timers = new Set();
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timer.unref(); timers.add(timer); return timer;
  };
  function roomState(room) {
    return { type: "room-state", broadcaster: publicBroadcaster(room.broadcaster), viewerCount: rooms.viewerCount(room) };
  }
  function broadcastState(room) {
    for (const viewer of room.viewers.values()) send(viewer.socket, roomState(room));
  }
  function fail(socket, message, close = false) {
    send(socket, { type: "error", message });
    if (close) socket.close(1008, "Acesso encerrado");
  }
  function requestResync(room) {
    if (!room.broadcaster || room.resyncTimer) return;
    // Coalesce joins; a new recorder epoch starts with a complete container header.
    room.resyncTimer = later(() => {
      room.resyncTimer = null;
      if (room.broadcaster) send(room.broadcaster.socket, { type: "resync-request" });
    }, Math.max(50, 500 - (Date.now() - (room.lastEpochAt || 0))));
  }
  function stopRoom(room) {
    if (!room?.broadcaster) return;
    const capture = room.broadcaster;
    rooms.stopBroadcast(room.instanceId, capture.connectionId);
    send(capture.socket, { type: "broadcast-stopped" });
    for (const viewer of room.viewers.values()) send(viewer.socket, { type: "broadcast-stopped" });
    broadcastState(room);
  }
  const onUpgrade = (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    const origin = request.headers.origin;
    if (url.pathname !== "/ws" || !origin || !config.allowedOrigins.has(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client));
  };
  httpServer.on("upgrade", onUpgrade);
  wss.on("connection", (socket) => {
    const connectionId = crypto.randomBytes(12).toString("base64url");
    socket.isAlive = true;
    socket.context = null;
    let authenticating = false;
    let controls = 0;
    let controlWindow = Date.now();
    const authTimer = later(() => { if (!socket.context) socket.close(1008, "Autenticacao pendente"); }, 10_000);
    socket.on("error", () => { /* ws close owns cleanup */ });
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", async (raw, isBinary) => {
      try {
        const context = socket.context;
        if (isBinary) {
          if (context?.role !== "capture") return fail(socket, "Somente o transmissor pode enviar mídia.", true);
          const room = rooms.rooms.get(context.instanceId);
          if (room?.broadcaster?.connectionId !== connectionId) return;
          if (!raw.byteLength) return;
          const budget = Math.max(96_000, profileFor(room.broadcaster.profile).bitrate / 8 * 0.75);
          const mediaMeta = context.pendingMediaMeta;
          context.pendingMediaMeta = null;
          for (const viewer of room.viewers.values()) {
            if (viewer.waitingForStream || viewer.socket.readyState !== WebSocket.OPEN) continue;
            if (viewer.socket.bufferedAmount > budget) {
              // Keep the participant connected. Stop feeding an already full
              // socket and start a clean media epoch once joins/resyncs are
              // coalesced, instead of closing the Activity connection.
              viewer.waitingForStream = true;
              requestResync(room);
              continue;
            }
            if (mediaMeta) send(viewer.socket, { type: 'media-meta', ...mediaMeta });
            viewer.socket.send(raw, { binary: true });
          }
          return;
        }
        if (Date.now() - controlWindow > 1000) { controls = 0; controlWindow = Date.now(); }
        if (++controls > 30) return fail(socket, "Mensagens em excesso.", true);
        const parsed = parseJsonMessage(raw);
        if (!parsed.ok) return fail(socket, parsed.error, true);
        const message = parsed.value;
        if (!context) {
          if (authenticating) return;
          if (message.protocolVersion !== PROTOCOL_VERSION) return fail(socket, "Atualize ou reabra o Testify para continuar.", true);
          const isCapture = message.type === "authenticate-capture";
          const store = isCapture ? captureSessions : sessions;
          const token = isCapture ? message.captureSessionToken : message.sessionToken;
          const grant = message.type === "authenticate" || isCapture ? store.get(token) : null;
          if (!grant) return fail(socket, "Sessão expirada. Reabra a Activity.", true);
          authenticating = true;
          await verifyMembership(grant);
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.context = { role: isCapture ? "capture" : "viewer", ...grant, token };
          send(socket, { type: 'server-clock', serverTime: Date.now() });
          clearTimeout(authTimer); timers.delete(authTimer);
          if (isCapture) {
            if (!rooms.hasUser(grant.instanceId, grant.user.id)) return fail(socket, "Mantenha sua Activity aberta para transmitir.", true);
            const room = rooms.rooms.get(grant.instanceId);
            const mimeTypes = MIME_TYPES.filter((type) => [...room.viewers.values()].every((v) => v.mimeTypes.includes(type)));
            send(socket, { type: "capture-authenticated", user: grant.user, mimeTypes });
          } else {
            const mimeTypes = Array.isArray(message.mimeTypes) ? MIME_TYPES.filter((type) => message.mimeTypes.includes(type)) : [];
            if (!mimeTypes.length) return fail(socket, "Este navegador não possui um player compatível.", true);
            const viewer = { connectionId, socket, user: grant.user, mimeTypes, waitingForStream: true };
            const room = rooms.addViewer(grant.instanceId, connectionId, viewer);
            send(socket, { type: "authenticated", connectionId, user: grant.user });
            broadcastState(room);
            if (room.broadcaster) {
              if (!mimeTypes.includes(room.broadcaster.mimeType)) {
                send(socket, { type: "error", message: "O formato atual não é compatível. Peça ao transmissor para encerrar e iniciar novamente." });
              } else requestResync(room);
            }
          }
          return;
        }
        const room = rooms.rooms.get(context.instanceId);
        if (message.type === 'media-meta' && context.role === 'capture') {
          const capturedAt = Number(message.capturedAt);
          const sequence = Number(message.sequence);
          context.pendingMediaMeta = {
            capturedAt: Number.isFinite(capturedAt) && Math.abs(Date.now() - capturedAt) < 60_000 ? capturedAt : Date.now(),
            sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0
          };
          return;
        }
        if (message.type === "start-broadcast" && context.role === "capture") {
          if (!rooms.hasUser(context.instanceId, context.user.id)) return fail(socket, "Mantenha sua Activity aberta para transmitir.", true);
          const mimeType = validateMimeType(message.mimeType);
          if (!mimeType || !MIME_TYPES.includes(mimeType)) return fail(socket, "Formato de mídia não suportado.");
          if (!Object.hasOwn(QUALITY_PROFILES, message.profile)) return fail(socket, "Perfil de qualidade inválido.");
          const nextRoom = rooms.startBroadcast(context.instanceId, {
            connectionId, socket, user: context.user, mimeType, profile: message.profile, streamId: crypto.randomUUID()
          });
          nextRoom.lastEpochAt = Date.now();
          if (nextRoom.resyncTimer) {
            clearTimeout(nextRoom.resyncTimer); timers.delete(nextRoom.resyncTimer); nextRoom.resyncTimer = null;
          }
          for (const viewer of nextRoom.viewers.values()) {
            viewer.waitingForStream = !viewer.mimeTypes.includes(mimeType);
            if (!viewer.waitingForStream) send(viewer.socket, { type: "stream-start", broadcaster: publicBroadcaster(nextRoom.broadcaster) });
          }
          send(socket, { type: "broadcast-ready", streamId: nextRoom.broadcaster.streamId });
          broadcastState(nextRoom);
          return;
        }
        if (message.type === "stop-broadcast") {
          if (room?.broadcaster && room.broadcaster.user.id === context.user.id) stopRoom(room);
          else fail(socket, "Você não pode encerrar a transmissão de outra pessoa.");
          return;
        }
        if (message.type === "request-resync" && context.role === "viewer" && room?.broadcaster) {
          const viewer = room.viewers.get(connectionId);
          if (viewer && viewer.mimeTypes.includes(room.broadcaster.mimeType) && Date.now() - (viewer.lastResync || 0) > 1500) {
            viewer.lastResync = Date.now(); viewer.waitingForStream = true; requestResync(room);
          }
          return;
        }
        if (message.type === "viewer-feedback" && context.role === "viewer" && room?.broadcaster) {
          const viewer = room.viewers.get(connectionId);
          if (viewer && Date.now() - (viewer.lastFeedback || 0) > 1200) {
            viewer.lastFeedback = Date.now();
            const lag = Number(message.bufferSeconds);
            const transportMs = Number(message.transportMs);
            viewer.badSamples = (Number.isFinite(lag) && lag > 1.2) || (Number.isFinite(transportMs) && transportMs > 900) || message.stalled === true
              ? (viewer.badSamples || 0) + 1 : 0;
            if (viewer.badSamples >= 2 && Date.now() - (room.lastCongestion || 0) > 5_000) {
              room.lastCongestion = Date.now(); viewer.badSamples = 0;
              send(room.broadcaster.socket, { type: "reduce-quality" });
            }
          }
          return;
        }
        if (message.type === "ping") return send(socket, { type: "pong" });
        fail(socket, "Mensagem não permitida para esta conexão.");
      } catch (error) {
        fail(socket, error.message || "Não foi possível validar o acesso.", !socket.context);
      }
    });
    socket.on("close", () => {
      clearTimeout(authTimer); timers.delete(authTimer);
      const result = rooms.removeConnection(connectionId);
      if (!result) return;
      if (result.broadcasterStopped) {
        for (const viewer of result.room.viewers.values()) send(viewer.socket, { type: "broadcast-stopped" });
      }
      if (rooms.rooms.has(result.room.instanceId)) broadcastState(result.room);
      const owner = result.room.broadcaster?.user.id;
      if (owner && !rooms.hasUser(result.room.instanceId, owner)) {
        later(() => {
          const room = rooms.rooms.get(result.room.instanceId);
          if (room?.broadcaster?.user.id === owner && !rooms.hasUser(room.instanceId, owner)) stopRoom(room);
        }, 8000);
      }
    });
  });
  const heartbeat = setInterval(async () => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false; socket.ping();
      const context = socket.context;
      if (!context) continue;
      const store = context.role === "capture" ? captureSessions : sessions;
      if (!store.get(context.token)) { fail(socket, "Sessão expirada. Reabra a Activity.", true); continue; }
      try {
        await verifyMembership(context);
        socket.membershipFailures = 0;
      } catch (error) {
        socket.membershipFailures = (socket.membershipFailures || 0) + 1;
        // A confirmed departure is immediate. Temporary Discord/API failures
        // need three consecutive checks before ending an otherwise healthy WS.
        if (error?.code === "NOT_ACTIVITY_MEMBER" || socket.membershipFailures >= 3) {
          fail(socket, "Você saiu desta instância ou não foi possível confirmar seu acesso.", true);
        }
      }
    }
  }, 30_000);
  heartbeat.unref();
  return { wss, rooms, close() {
    clearInterval(heartbeat);
    for (const timer of timers) clearTimeout(timer);
    httpServer.off("upgrade", onUpgrade);
    for (const socket of wss.clients) socket.terminate();
    wss.close();
  } };
}
