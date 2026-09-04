import assert from "node:assert/strict";
import test from "node:test";
import { authenticateActivityUser } from "../server/discordAuth.js";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("OAuth associa o usuário à instância confirmada pelo Discord", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/oauth2/token")) return response({ access_token: "access", expires_in: 3600 });
    if (url.endsWith("/users/@me")) return response({ id: "42", username: "bernardo" });
    return response({ application_id: "123", instance_id: "i-valid-instance-123", users: ["42"] });
  };
  const result = await authenticateActivityUser({ code: "code", clientId: "123", clientSecret: "secret", botToken: "bot", instanceId: "i-valid-instance-123", fetchImpl });
  assert.equal(result.user.id, "42");
  assert.equal(calls.length, 3);
});

test("OAuth recusa usuário ausente da instância", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/token")) return response({ access_token: "access" });
    if (url.endsWith("/users/@me")) return response({ id: "42", username: "bernardo" });
    return response({ application_id: "123", instance_id: "i-valid-instance-123", users: ["99"] });
  };
  await assert.rejects(
    authenticateActivityUser({ code: "code", clientId: "123", clientSecret: "secret", botToken: "bot", instanceId: "i-valid-instance-123", fetchImpl }),
    /não está conectado/
  );
});
