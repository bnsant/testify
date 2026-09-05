import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} deve ser um inteiro positivo.`);
  return parsed;
}

function parseOrigins(value, clientId, publicBaseUrl) {
  const origins = new Set();
  for (const item of (value || "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    // Um Origin de request é sempre esquema+host; normaliza entradas sem esquema
    // para que a comparação no upgrade do WebSocket realmente bata.
    try { origins.add(new URL(/^https?:\/\//i.test(item) ? item : `https://${item}`).origin); }
    catch { /* ignora entrada malformada */ }
  }
  origins.add(new URL(publicBaseUrl).origin);
  if (clientId) origins.add(`https://${clientId}.discordsays.com`);
  return origins;
}

// Provedores (Railway etc.) muitas vezes expõem o host sem esquema. Assume HTTPS
// quando faltar, para o `new URL()` não estourar com "Invalid URL".
function normalizeBaseUrl(value) {
  const trimmed = (value || "http://localhost:5173").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function loadConfig(env = process.env) {
  const publicBaseUrl = normalizeBaseUrl(env.PUBLIC_BASE_URL);
  const parsedPublicUrl = new URL(publicBaseUrl);
  if (env.NODE_ENV === "production" && parsedPublicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL precisa usar HTTPS em produção.");
  }

  const clientId = (env.DISCORD_CLIENT_ID || env.VITE_DISCORD_CLIENT_ID || "").trim();
  const iceServers = [];
  if (env.STUN_URL?.trim()) iceServers.push({ urls: env.STUN_URL.trim() });
  if (env.TURN_URL?.trim()) iceServers.push({
    urls: env.TURN_URL.trim(),
    username: env.TURN_USERNAME || "",
    credential: env.TURN_PASSWORD || ""
  });
  return {
    host: env.HOST || (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
    port: positiveInteger(env.PORT, 3001, "PORT"),
    publicBaseUrl,
    clientId,
    clientSecret: (env.DISCORD_CLIENT_SECRET || "").trim(),
    botToken: (env.DISCORD_BOT_TOKEN || env.DISCORD_TOKEN || "").trim(),
    sessionTtlMs: positiveInteger(env.SESSION_TTL_SECONDS, 3600, "SESSION_TTL_SECONDS") * 1000,
    captureTokenTtlMs: positiveInteger(env.CAPTURE_TOKEN_TTL_SECONDS, 120, "CAPTURE_TOKEN_TTL_SECONDS") * 1000,
    rtcConfig: { iceServers },
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS, clientId, publicBaseUrl),
    distDirectory: path.join(rootDirectory, "dist"),
    development: env.NODE_ENV !== "production"
  };
}

export function missingDiscordConfig(config) {
  return [
    ["DISCORD_CLIENT_ID", config.clientId],
    ["DISCORD_CLIENT_SECRET", config.clientSecret],
    ["DISCORD_BOT_TOKEN", config.botToken]
  ].filter(([, value]) => !value).map(([name]) => name);
}
