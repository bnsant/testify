import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { ExpiringTokenStore } from "../server/tokenStore.js";
import { attachWebSocketServer } from "../server/websocket.js";

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, binary) => resolve(binary ? data : JSON.parse(data.toString())));
    socket.once("error", reject);
  });
}

function nextMatching(socket, predicate) {
  return new Promise((resolve, reject) => {
    function onMessage(data, binary) {
      const value = binary ? data : JSON.parse(data.toString());
      if (!predicate(value, binary)) return;
      cleanup(); resolve(value);
    }
    function cleanup() { socket.off("message", onMessage); socket.off("error", onError); }
    function onError(error) { cleanup(); reject(error); }
    socket.on("message", onMessage); socket.once("error", onError);
  });
}

test("viewer autenticado recebe mídia binária do broadcaster autorizado", async (context) => {
  const server = http.createServer((_req, res) => res.end());
  const sessions = new ExpiringTokenStore({ ttlMs: 60_000 });
  const captureSessions = new ExpiringTokenStore({ ttlMs: 60_000 });
  const realtime = attachWebSocketServer(server, {
    config: { allowedOrigins: new Set(["http://localhost"]), development: true }, sessions, captureSessions
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    realtime.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  const viewerToken = sessions.issue({ instanceId: "i-integration-room-123", user: { id: "1", displayName: "Viewer", avatar: null } });
  const captureToken = captureSessions.issue({ instanceId: "i-integration-room-123", user: { id: "2", displayName: "Broadcaster", avatar: null } });
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://localhost" });
  await new Promise((resolve) => viewer.once("open", resolve));
  viewer.send(JSON.stringify({ type: "authenticate", sessionToken: viewerToken }));
  assert.equal((await nextMessage(viewer)).type, "authenticated");

  const capture = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://localhost" });
  await new Promise((resolve) => capture.once("open", resolve));
  capture.send(JSON.stringify({ type: "authenticate-capture", captureSessionToken: captureToken }));
  assert.equal((await nextMessage(capture)).type, "capture-authenticated");
  const readyPromise = nextMatching(capture, (value) => value.type === "broadcast-ready");
  const livePromise = nextMatching(viewer, (value, binary) => !binary && value.type === "room-state" && value.broadcaster);
  capture.send(JSON.stringify({ type: "start-broadcast", mimeType: "video/webm;codecs=vp8" }));
  assert.equal((await readyPromise).type, "broadcast-ready");
  await livePromise;
  const mediaPromise = nextMatching(viewer, (_value, binary) => binary);
  capture.send(Buffer.from([1, 2, 3]));
  assert.deepEqual([...await mediaPromise], [1, 2, 3]);
  viewer.close(); capture.close();
});
