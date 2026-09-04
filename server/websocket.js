import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_MEDIA_CHUNK_BYTES, parseJsonMessage, validateMimeType } from "./protocol.js";
import { RoomRegistry } from "./rooms.js";

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function publicBroadcaster(broadcaster) {
  if (!broadcaster) return null;
  return {
    userId: broadcaster.user.id,
    displayName: broadcaster.user.displayName,
    avatar: broadcaster.user.avatar,
    mimeType: broadcaster.mimeType
  };
}

export function attachWebSocketServer(httpServer, { config, sessions, captureSessions, rooms = new RoomRegistry() }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MEDIA_CHUNK_BYTES });

  function roomState(room) {
    return { type: "room-state", broadcaster: publicBroadcaster(room.broadcaster), viewerCount: rooms.viewerCount(room) };
  }

  function broadcastState(room) {
    const message = roomState(room);
    for (const viewer of room.viewers.values()) send(viewer.socket, message);
    if (room.broadcaster) send(room.broadcaster.socket, message);
  }

  function fail(socket, message, close = false) {
    send(socket, { type: "error", message });
    if (close) socket.close(1008, message.slice(0, 120));
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    const origin = request.headers.origin;
    const originAllowed = origin && config.allowedOrigins.has(origin);
    if (url.pathname !== "/ws" || (!originAllowed && (!config.development || origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client));
  });

  wss.on("connection", (socket) => {
    const connectionId = crypto.randomBytes(12).toString("base64url");
    socket.isAlive = true;
    socket.context = null;
    socket.on("pong", () => { socket.isAlive = true; });

    socket.on("message", (raw, isBinary) => {
      const context = socket.context;
      if (isBinary) {
        if (context?.role !== "capture") return fail(socket, "Somente o transmissor pode enviar mídia.", true);
        const room = rooms.rooms.get(context.instanceId);
        if (room?.broadcaster?.connectionId !== connectionId) return fail(socket, "Transmissão não iniciada.", true);
        if (!room.initSegment) room.initSegment = Buffer.from(raw);
        for (const viewer of room.viewers.values()) {
          if (viewer.socket.readyState !== WebSocket.OPEN) continue;
          if (viewer.socket.bufferedAmount > 8 * 1024 * 1024) {
            viewer.socket.close(1013, "Espectador muito lento");
            continue;
          }
          viewer.socket.send(raw, { binary: true });
        }
        return;
      }

      const parsed = parseJsonMessage(raw);
      if (!parsed.ok) return fail(socket, parsed.error);
      const message = parsed.value;

      if (!context) {
        if (message.type === "authenticate") {
          const session = sessions.get(message.sessionToken);
          if (!session) return fail(socket, "Sessão expirada. Reabra a Activity.", true);
          try {
            const room = rooms.addViewer(session.instanceId, connectionId, { connectionId, socket, user: session.user });
            socket.context = { role: "viewer", instanceId: session.instanceId, user: session.user };
            send(socket, { type: "authenticated", connectionId, user: session.user });
            send(socket, roomState(room));
            if (room.broadcaster && room.initSegment) socket.send(room.initSegment, { binary: true });
            broadcastState(room);
          } catch (error) {
            fail(socket, error.message, true);
          }
          return;
        }
        if (message.type === "authenticate-capture") {
          const capture = captureSessions.get(message.captureSessionToken);
          if (!capture) return fail(socket, "Sessão de captura expirada.", true);
          socket.context = { role: "capture", instanceId: capture.instanceId, user: capture.user };
          send(socket, { type: "capture-authenticated", user: capture.user });
          return;
        }
        return fail(socket, "Autentique a conexão primeiro.", true);
      }

      if (message.type === "start-broadcast" && context.role === "capture") {
        const mimeType = validateMimeType(message.mimeType);
        if (!mimeType) return fail(socket, "Formato de mídia não suportado.");
        try {
          const room = rooms.startBroadcast(context.instanceId, {
            connectionId, socket, user: context.user, mimeType
          });
          send(socket, { type: "broadcast-ready" });
          broadcastState(room);
        } catch (error) {
          fail(socket, error.message);
        }
        return;
      }

      if (message.type === "stop-broadcast" && context.role === "capture") {
        const room = rooms.stopBroadcast(context.instanceId, connectionId);
        if (room) broadcastState(room);
        send(socket, { type: "broadcast-stopped" });
        return;
      }

      if (message.type === "ping") return send(socket, { type: "pong" });
      fail(socket, "Mensagem não permitida para esta conexão.");
    });

    socket.on("close", () => {
      const result = rooms.removeConnection(connectionId);
      if (result?.broadcasterStopped) {
        for (const viewer of result.room.viewers.values()) send(viewer.socket, { type: "broadcast-stopped" });
      }
      if (result && rooms.rooms.has(result.room.instanceId)) broadcastState(result.room);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) socket.terminate();
      else { socket.isAlive = false; socket.ping(); }
    }
  }, 30_000);
  heartbeat.unref();

  return {
    wss,
    rooms,
    close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    }
  };
}
