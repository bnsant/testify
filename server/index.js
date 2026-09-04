import "dotenv/config";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { loadConfig, missingDiscordConfig } from "./config.js";
import { ExpiringTokenStore } from "./tokenStore.js";
import { attachWebSocketServer } from "./websocket.js";

export function createServer(options = {}) {
  const config = options.config || loadConfig();
  const sessions = new ExpiringTokenStore({ ttlMs: config.sessionTtlMs });
  const captureTokens = new ExpiringTokenStore({ ttlMs: config.captureTokenTtlMs });
  const captureSessions = new ExpiringTokenStore({ ttlMs: config.sessionTtlMs });
  const app = createApp({ config, sessions, captureTokens, captureSessions, fetchImpl: options.fetchImpl });
  const server = http.createServer(app);
  const realtime = attachWebSocketServer(server, { config, sessions, captureSessions });
  const sweep = setInterval(() => {
    sessions.sweep(); captureTokens.sweep(); captureSessions.sweep();
  }, 60_000);
  sweep.unref();

  return {
    app, server, realtime, config,
    async close() {
      clearInterval(sweep);
      realtime.close();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

export async function startServer() {
  const instance = createServer();
  await new Promise((resolve, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(instance.config.port, instance.config.host, resolve);
  });
  console.log(`[server] http://${instance.config.host}:${instance.config.port}`);
  const missing = missingDiscordConfig(instance.config);
  if (missing.length) console.warn(`[server] configure ${missing.join(", ")} para autenticar a Activity.`);
  return instance;
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) startServer().catch((error) => { console.error(error); process.exitCode = 1; });
