import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { ExpiringTokenStore } from "../server/tokenStore.js";
import { attachWebSocketServer } from "../server/websocket.js";
import { MIME_TYPES, PROTOCOL_VERSION } from "../shared/streaming.js";

function nextMatching(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Mensagem esperada não chegou")), 5000);
    function onMessage(data, binary) {
      const value = binary ? data : JSON.parse(data.toString());
      if (predicate(value, binary)) finish(null, value);
    }
    function finish(error, value) {
      clearTimeout(timer); socket.off("message", onMessage);
      error ? reject(error) : resolve(value);
    }
    socket.on("message", onMessage);
  });
}
const message = (socket, type) => nextMatching(socket, (value, binary) => !binary && value.type === type);
const send = (socket, value) => socket.send(JSON.stringify(value));

async function setup(context) {
  const server = http.createServer((_req, res) => res.end());
  const sessions = new ExpiringTokenStore({ ttlMs: 60_000 });
  const captureSessions = new ExpiringTokenStore({ ttlMs: 60_000 });
  const realtime = attachWebSocketServer(server, { config: { allowedOrigins: new Set(["http://localhost"]) }, sessions, captureSessions });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { realtime.close(); await new Promise((resolve) => server.close(resolve)); });
  async function connect(userId, role = "viewer", instanceId = "i-integration-room-123") {
    const token = (role === "capture" ? captureSessions : sessions).issue({ instanceId, user: { id: userId, displayName: userId, avatar: null } });
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { origin: "http://localhost" });
    await new Promise((resolve) => socket.once("open", resolve));
    const ready = message(socket, role === "capture" ? "capture-authenticated" : "authenticated");
    send(socket, { type: role === "capture" ? "authenticate-capture" : "authenticate",
      protocolVersion: PROTOCOL_VERSION, mimeTypes: MIME_TYPES,
      ...(role === "capture" ? { captureSessionToken: token } : { sessionToken: token }) });
    await ready;
    return socket;
  }
  async function start(capture) {
    const ready = message(capture, "broadcast-ready");
    send(capture, { type: "start-broadcast", mimeType: "video/webm;codecs=vp8", profile: "balanced" });
    return ready;
  }
  return { realtime, connect, start, server, sessions, captureSessions };
}

test("mídia autorizada; entrada tardia espera cabeçalho novo; isolamento entre instâncias", { timeout: 15_000 }, async (context) => {
  const { connect, start } = await setup(context);
  const owner = await connect("owner");
  const viewer = await connect("viewer");
  const outsider = await connect("outsider", "viewer", "i-another-room-123");
  let leaked = 0; outsider.on("message", (_data, binary) => { if (binary) leaked++; });
  const capture = await connect("owner", "capture");
  const epoch = message(viewer, "stream-start");
  await start(capture);
  const first = await epoch;
  const relayedMeta = message(viewer, "media-meta");
  const received = nextMatching(viewer, (_value, binary) => binary);
  send(capture, { type: "media-meta", capturedAt: Date.now(), sequence: 7 });
  capture.send(Buffer.from([1, 2, 3]));
  assert.equal((await relayedMeta).sequence, 7);
  assert.deepEqual([...await received], [1, 2, 3]);
  const resync = message(capture, "resync-request");
  const late = await connect("late");
  let premature = 0; late.on("message", (_data, binary) => { if (binary) premature++; });
  capture.send(Buffer.from([4, 5, 6]));
  await resync;
  assert.equal(premature, 0, "late viewer must not receive arbitrary old deltas");
  const nextEpoch = message(late, "stream-start");
  await start(capture);
  assert.notEqual((await nextEpoch).broadcaster.streamId, first.broadcaster.streamId);
  const header = nextMatching(late, (_value, binary) => binary);
  capture.send(Buffer.from([7, 8, 9]));
  assert.deepEqual([...await header], [7, 8, 9]);
  assert.equal(leaked, 0);
  owner.close();
});

test("somente dono encerra externamente; concorrência de broadcasters é recusada", { timeout: 10_000 }, async (context) => {
  const { connect, start, realtime } = await setup(context);
  const owner = await connect("owner");
  const friend = await connect("friend");
  const capture = await connect("owner", "capture");
  await start(capture);
  const intruder = await connect("friend", "capture");
  const conflict = message(intruder, "error");
  send(intruder, { type: "start-broadcast", mimeType: "video/webm;codecs=vp8", profile: "balanced" });
  assert.match((await conflict).message, /Outra pessoa/);
  const forbidden = message(friend, "error");
  send(friend, { type: "stop-broadcast" });
  assert.match((await forbidden).message, /não pode/);
  const stopped = message(capture, "broadcast-stopped");
  send(owner, { type: "stop-broadcast" });
  await stopped;
  assert.equal([...realtime.rooms.rooms.values()][0].broadcaster, null);
});

test("viewer não injeta mídia e origem não autorizada não conecta", { timeout: 10_000 }, async (context) => {
  const { connect, server } = await setup(context);
  const viewer = await connect("viewer");
  const forbidden = message(viewer, "error");
  viewer.send(Buffer.from([0]));
  assert.match((await forbidden).message, /Somente o transmissor/);
  const bad = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { origin: "https://other.example" });
  const error = await new Promise((resolve) => bad.once("error", resolve));
  assert.match(error.message, /403/);
});

test("viewer lento permanece conectado e recebe ressincronização sem queda do socket", { timeout: 10_000 }, async (context) => {
  const { connect, start, realtime } = await setup(context);
  const owner = await connect("owner");
  const viewer = await connect("slow-viewer");
  const capture = await connect("owner", "capture");
  await start(capture);
  const room = [...realtime.rooms.rooms.values()][0];
  const serverViewer = [...room.viewers.values()].find((entry) => entry.user.id === "slow-viewer");
  Object.defineProperty(serverViewer.socket, "bufferedAmount", { configurable: true, value: 10_000_000 });
  const resync = message(capture, "resync-request");
  capture.send(Buffer.from([1, 2, 3]));
  await resync;
  assert.equal(viewer.readyState, WebSocket.OPEN);
  assert.equal(serverViewer.waitingForStream, true);
  owner.close();
});

test("captura exige dono presente; versão antiga recebe erro em vez de corromper player", { timeout: 10_000 }, async (context) => {
  const { server, captureSessions } = await setup(context);
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { origin: "http://localhost" });
  await new Promise((resolve) => socket.once("open", resolve));
  const token = captureSessions.issue({ instanceId: "i-empty-instance-123", user: { id: "absent" } });
  const error = message(socket, "error");
  send(socket, { type: "authenticate-capture", protocolVersion: PROTOCOL_VERSION, captureSessionToken: token });
  assert.match((await error).message, /Mantenha sua Activity/);
});
