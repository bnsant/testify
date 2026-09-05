import test from "node:test";
import assert from "node:assert/strict";
import { MediaSourcePlayer } from "../client/src/streaming/mediaSource.js";

test("player preserva fragmento se appendBuffer falha por quota", () => {
  const player = new MediaSourcePlayer({ currentTime: 12 });
  const chunk = new Uint8Array([1, 2, 3]);
  player.mediaSource = { readyState: "open" }; player.streaming = true;
  player.queue = [chunk]; player.queuedBytes = 3;
  let removed = false, appended = false;
  player.sourceBuffer = { updating: false, buffered: { length: 1, start: () => 0 },
    appendBuffer() { if (!removed) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); appended = true; },
    remove() { removed = true; } };
  player.flush();
  assert.equal(player.queue[0], chunk);
  assert.equal(player.queuedBytes, 3);
  player.flush();
  assert.ok(appended);
  assert.equal(player.queuedBytes, 0);
});

test("player interrompe fila excessiva e exige nova sequência completa", () => {
  let error;
  const player = new MediaSourcePlayer({}, { onError: (value) => { error = value; } });
  player.mediaSource = { readyState: "closed" };
  player.push(new ArrayBuffer(5 * 1024 * 1024));
  assert.match(error.message, /Ressincronizando/);
  assert.equal(player.queue.length, 0);
  assert.equal(player.failed, true);
});

test("player abandona fragmentos consecutivos que chegaram atrasados", () => {
  let reset = false;
  const player = new MediaSourcePlayer({}, { onLatencyExceeded: () => { reset = true; } });
  player.mediaSource = { readyState: "closed" };
  player.push({ data: new ArrayBuffer(1), transportMs: 1500 });
  assert.equal(reset, false);
  player.push({ data: new ArrayBuffer(1), transportMs: 1600 });
  assert.equal(reset, true);
  assert.equal(player.queue.length, 0);
});
