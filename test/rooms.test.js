import assert from "node:assert/strict";
import test from "node:test";
import { RoomRegistry } from "../server/rooms.js";

test("servidor escolhe um único broadcaster e destrói sala vazia", () => {
  const rooms = new RoomRegistry();
  const room = rooms.addViewer("i-test-room-123", "viewer", { socket: {} });
  rooms.startBroadcast(room.instanceId, { connectionId: "capture-a", user: { id: "1" } });
  assert.throws(() => rooms.startBroadcast(room.instanceId, { connectionId: "capture-b", user: { id: "2" } }), /Outra pessoa/);
  const stopped = rooms.removeConnection("capture-a");
  assert.equal(stopped.broadcasterStopped, true);
  assert.equal(room.broadcaster, null);
  rooms.removeConnection("viewer");
  assert.equal(rooms.rooms.size, 0);
});

test("limita a cinco viewers", () => {
  const rooms = new RoomRegistry();
  rooms.addViewer("i-test-room-456", "owner", { user: { id: "owner" } });
  for (let index = 0; index < 5; index += 1) rooms.addViewer("i-test-room-456", `v${index}`, { user: { id: `v${index}` } });
  assert.throws(() => rooms.addViewer("i-test-room-456", "v5", { user: { id: "v5" } }), /5 espectadores/);
  const room = rooms.startBroadcast("i-test-room-456", { connectionId: "capture", user: { id: "owner" } });
  assert.equal(rooms.viewerCount(room), 5);
});

test("o mesmo transmissor substitui o socket sem encerrar a sala", () => {
  const rooms = new RoomRegistry();
  rooms.addViewer("i-test-room-replace", "owner-view", { user: { id: "owner" } });
  const room = rooms.startBroadcast("i-test-room-replace", { connectionId: "old", user: { id: "owner" } });
  rooms.startBroadcast("i-test-room-replace", { connectionId: "fresh", user: { id: "owner" } });
  assert.equal(room.broadcaster.connectionId, "fresh");
  assert.equal(rooms.removeConnection("old"), null);
  assert.equal(room.broadcaster.connectionId, "fresh");
});
