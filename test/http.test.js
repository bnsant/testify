import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../server/app.js";
import { RoomRegistry } from "../server/rooms.js";
import { ExpiringTokenStore } from "../server/tokenStore.js";
import { createMembershipVerifier } from "../server/membership.js";

test("HTTP: OAuth, presença, captura de uso único e configuração sem credenciais TURN", { timeout: 10_000 }, async (context) => {
  const rooms = new RoomRegistry();
  const sessions = new ExpiringTokenStore({ ttlMs: 60_000 });
  const captureTokens = new ExpiringTokenStore({ ttlMs: 60_000 });
  const captureSessions = new ExpiringTokenStore({ ttlMs: 60_000 });
  const instanceId = "i-http-test-instance-123";
  const config = { clientId: "123", clientSecret: "secret", botToken: "bot", publicBaseUrl: "https://testify.example",
    captureTokenTtlMs: 120_000, sessionTtlMs: 60_000, rtcConfig: { iceServers: [{ credential: "private-turn" }] }, distDirectory: "nonexistent-test-directory" };
  const fetchImpl = async (url) => ({ ok: true, json: async () =>
    url.endsWith("/oauth2/token") ? { access_token: "test-token" } : url.endsWith("/users/@me")
      ? { id: "42", username: "Testify" } : { application_id: "123", instance_id: instanceId, users: ["42"] } });
  const server = http.createServer(createApp({ config, sessions, captureTokens, captureSessions, rooms, fetchImpl }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, token) => fetch(base + route, { method: "POST", headers: {
    "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {})
  }, body: JSON.stringify(body) });
  const exchange = await request("/api/auth/exchange", { code: "test-code", instanceId });
  assert.equal(exchange.status, 200);
  const { sessionToken } = await exchange.json();
  assert.equal((await request("/api/capture-token", {}, sessionToken)).status, 403);
  rooms.addViewer(instanceId, "owner", { user: { id: "42" }, socket: {} });
  const issued = await request("/api/capture-token", {}, sessionToken);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const url = new URL((await issued.json()).captureUrl);
  assert.equal(url.search, "");
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const claimed = await request("/api/capture/claim", { token });
  assert.equal(claimed.status, 200);
  assert.ok((await claimed.json()).captureSessionToken);
  assert.equal((await request("/api/capture/claim", { token })).status, 401);
  const runtime = await (await fetch(base + "/api/runtime-config")).text();
  assert.ok(!runtime.includes("private-turn"));
  assert.equal((await request("/api/auth/exchange", { code: "test-code", instanceId: "arbitrary-room" })).status, 400);
});

test("verificador de instância mantém isolamento por usuário mesmo usando cache", async () => {
  let calls = 0;
  const verify = createMembershipVerifier({ clientId: "app", botToken: "test" }, async () => {
    calls++;
    return { ok: true, json: async () => ({ application_id: "app", instance_id: "i-membership-123", users: ["yes"] }) };
  });
  await verify({ instanceId: "i-membership-123", user: { id: "yes" } });
  await assert.rejects(verify({ instanceId: "i-membership-123", user: { id: "no" } }), /não está/);
  assert.equal(calls, 1);
});
