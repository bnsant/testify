import assert from "node:assert/strict";
import test from "node:test";
import { ExpiringTokenStore } from "../server/tokenStore.js";

test("tokens expiram e tokens consumidos não podem ser reutilizados", () => {
  let time = 1_000;
  const store = new ExpiringTokenStore({ ttlMs: 100, now: () => time });
  const once = store.issue({ room: "a" });
  assert.deepEqual(store.consume(once), { room: "a" });
  assert.equal(store.consume(once), null);
  const expiring = store.issue({ room: "b" });
  time += 101;
  assert.equal(store.get(expiring), null);
});
