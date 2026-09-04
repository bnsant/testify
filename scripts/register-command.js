import "dotenv/config";

// Registra (ou atualiza) o Entry Point command que o Discord exige para iniciar
// a Activity. O Discord deixou de criar esse comando automaticamente, então sem
// ele o launcher mostra "seu app habilitou atividades, mas não possui comandos".
// Idempotente: rodar de novo apenas sobrescreve o mesmo comando.

const clientId = (process.env.DISCORD_CLIENT_ID || process.env.VITE_DISCORD_CLIENT_ID || "").trim();
const botToken = (process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || "").trim();

if (!clientId || !botToken) {
  console.error("Defina DISCORD_CLIENT_ID e DISCORD_BOT_TOKEN no .env antes de rodar.");
  process.exit(1);
}

const command = {
  name: "launch",
  description: "Abrir Testify",
  type: 4, // PRIMARY_ENTRY_POINT
  handler: 2, // DISCORD_LAUNCH_ACTIVITY (o Discord abre a Activity, sem app interaction)
  integration_types: [0, 1], // guild install + user install
  contexts: [0, 1, 2] // guild, bot DM, GDM/DM
};

const response = await fetch(`https://discord.com/api/v10/applications/${clientId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
  body: JSON.stringify([command])
});

const body = await response.text();
if (!response.ok) {
  console.error(`Discord respondeu ${response.status}:`, body);
  process.exit(1);
}

console.log("Entry Point command registrado. Reinicie o Discord para vê-lo no launcher.");
