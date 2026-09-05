import "dotenv/config";
import dotenv from "dotenv";
import { loadConfig, missingDiscordConfig } from "../server/config.js";
dotenv.config({ path: ".env.local", override: true, quiet: true });
const config = loadConfig();
const missing = missingDiscordConfig(config);
console.log("Testify · diagnóstico local (nenhum segredo é exibido)");
console.log("Node:", process.versions.node);
console.log("Credenciais:", missing.length ? "faltam " + missing.join(", ") : "campos preenchidos");
console.log("Captura externa:", config.publicBaseUrl + "/capture");
console.log("Backend:", config.host + ":" + config.port);
console.log("Origins:", [...config.allowedOrigins].join(", "));
if (config.publicBaseUrl.startsWith("http:")) console.log("Para testar no Discord, configure PUBLIC_BASE_URL com um túnel HTTPS.");
if (process.env.VITE_DISCORD_CLIENT_ID && process.env.VITE_DISCORD_CLIENT_ID.trim() !== config.clientId) {
  console.error("DISCORD_CLIENT_ID e VITE_DISCORD_CLIENT_ID precisam ser iguais."); process.exitCode = 1;
}
if (missing.length) process.exitCode = 1;
