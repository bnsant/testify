export async function authenticateWithDiscord(discordSdk, instanceId) {
  const { code } = await discordSdk.commands.authorize({
    client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
    response_type: "code",
    prompt: "none",
    scope: ["identify"]
  });
  const response = await fetch("/api/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, instanceId })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Falha ao autenticar.");
  const auth = await discordSdk.commands.authenticate({ access_token: payload.accessToken });
  if (!auth?.user) throw new Error("O Discord não confirmou a autenticação.");
  // O access token foi necessário apenas para o comando oficial authenticate.
  // Não o retenha no estado React depois do handshake.
  return { sessionToken: payload.sessionToken, user: payload.user };
}
