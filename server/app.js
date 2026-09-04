import fs from "node:fs";
import path from "node:path";
import express from "express";
import { authenticateActivityUser, publicUser } from "./discordAuth.js";
import { isInstanceId } from "./protocol.js";
import { missingDiscordConfig } from "./config.js";

function activitySecurityHeaders(_request, response, next) {
  response.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), display-capture=(self)",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors https://discord.com https://*.discord.com"
    ].join("; ")
  });
  next();
}

function bearerToken(request) {
  const match = request.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  return match?.[1] || null;
}

export function createApp({ config, sessions, captureTokens, captureSessions, fetchImpl = fetch }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(activitySecurityHeaders);
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, discordConfigured: missingDiscordConfig(config).length === 0 });
  });

  app.get("/api/runtime-config", (_request, response) => {
    response.set("Cache-Control", "no-store").json({
      transport: "websocket-media",
      webRtcSupportedInActivity: false,
      maxViewers: 5,
      rtcConfig: config.rtcConfig
    });
  });

  app.get("/api/avatar/default/:index", async (request, response) => {
    const index = /^[0-5]$/.test(request.params.index) ? request.params.index : "0";
    try {
      const upstream = await fetchImpl(`https://cdn.discordapp.com/embed/avatars/${index}.png`);
      if (!upstream.ok) throw new Error("avatar indisponível");
      response.set("Cache-Control", "public, max-age=86400").type("png").send(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.status(404).end(); }
  });

  app.get("/api/avatar/:userId/:hash", async (request, response) => {
    const { userId, hash } = request.params;
    if (!/^\d{5,30}$/.test(userId) || !/^[A-Za-z0-9_]{2,128}$/.test(hash)) return response.status(400).end();
    try {
      const upstream = await fetchImpl(`https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=96`);
      if (!upstream.ok) throw new Error("avatar indisponível");
      response.set("Cache-Control", "public, max-age=86400").type("png").send(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.status(404).end(); }
  });

  app.post("/api/auth/exchange", async (request, response) => {
    const { code, instanceId } = request.body || {};
    if (typeof code !== "string" || code.length < 4 || !isInstanceId(instanceId)) {
      return response.status(400).json({ error: "Código OAuth ou instanceId inválido." });
    }
    const missing = missingDiscordConfig(config);
    if (missing.length) return response.status(503).json({ error: `Configuração ausente: ${missing.join(", ")}.` });

    try {
      const { oauth, user } = await authenticateActivityUser({
        code,
        instanceId,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        botToken: config.botToken,
        fetchImpl
      });
      const safeUser = publicUser(user);
      const sessionToken = sessions.issue({ user: safeUser, instanceId });
      response.set("Cache-Control", "no-store").json({
        accessToken: oauth.access_token,
        sessionToken,
        user: safeUser
      });
    } catch (error) {
      console.warn("[OAuth]", error.message);
      response.status(error.status === 403 ? 403 : 401).json({ error: "Não foi possível validar sua sessão com o Discord." });
    }
  });

  app.post("/api/capture-token", (request, response) => {
    const session = sessions.get(bearerToken(request));
    if (!session) return response.status(401).json({ error: "Sessão expirada." });
    const token = captureTokens.issue({ user: session.user, instanceId: session.instanceId });
    response.set("Cache-Control", "no-store").json({
      captureUrl: `${config.publicBaseUrl}/capture?token=${encodeURIComponent(token)}`,
      expiresInSeconds: Math.floor(config.captureTokenTtlMs / 1000)
    });
  });

  app.post("/api/capture/claim", (request, response) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    const grant = captureTokens.consume(token);
    if (!grant) return response.status(401).json({ error: "Este link de captura expirou ou já foi usado." });
    const captureSessionToken = captureSessions.issue(grant, config.sessionTtlMs);
    response.set("Cache-Control", "no-store").json({ captureSessionToken, user: grant.user });
  });

  if (fs.existsSync(config.distDirectory)) {
    app.get("/capture", (_request, response) => {
      response.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      response.sendFile(path.join(config.distDirectory, "capture.html"));
    });
    app.use(express.static(config.distDirectory, { index: false, maxAge: config.development ? 0 : "1h" }));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/") || request.path === "/ws") return next();
      response.sendFile(path.join(config.distDirectory, "index.html"));
    });
  }

  app.use((error, _request, response, _next) => {
    console.error("[HTTP]", error);
    response.status(500).json({ error: "Erro interno." });
  });
  return app;
}
