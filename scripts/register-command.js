import "dotenv/config";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", override: true, quiet: true });
const clientId = (process.env.DISCORD_CLIENT_ID || process.env.VITE_DISCORD_CLIENT_ID || "").trim();
const botToken = (process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || "").trim();
if (!clientId || !botToken) throw new Error("Configure DISCORD_CLIENT_ID e DISCORD_BOT_TOKEN.");
const url = `https://discord.com/api/v10/applications/${clientId}/commands`;
const headers = { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" };
const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`Discord respondeu HTTP ${response.status} ao consultar comandos.`);
const existing = (await response.json()).find((command) => command.type === 4);
const command = { name: existing?.name || "launch", description: "Abrir Testify", type: 4,
  handler: 2, integration_types: [0, 1], contexts: [0, 1, 2] };
// Never bulk-overwrite the bot's other commands.
const saved = await fetch(existing ? `${url}/${existing.id}` : url, {
  method: existing ? "PATCH" : "POST", headers, body: JSON.stringify(command), signal: AbortSignal.timeout(15_000)
});
if (!saved.ok) throw new Error(`Discord respondeu HTTP ${saved.status} ao registrar o ponto de entrada.`);
console.log("Ponto de entrada do Testify configurado. Os demais comandos foram preservados.");
