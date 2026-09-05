const DISCORD_API = "https://discord.com/api/v10";

async function discordJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `Discord respondeu HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function exchangeDiscordCode({ code, clientId, clientSecret, fetchImpl = fetch }) {
  if (!code || !clientId || !clientSecret) throw new Error("OAuth do Discord não está configurado.");
  return discordJson(fetchImpl, `${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code })
  });
}

export async function getDiscordUser(accessToken, fetchImpl = fetch) {
  return discordJson(fetchImpl, `${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}

export async function getActivityInstance({ clientId, instanceId, botToken, fetchImpl = fetch }) {
  if (!botToken) throw new Error("DISCORD_BOT_TOKEN não está configurado.");
  return discordJson(
    fetchImpl,
    `${DISCORD_API}/applications/${encodeURIComponent(clientId)}/activity-instances/${encodeURIComponent(instanceId)}`,
    { headers: { Authorization: `Bot ${botToken}` } }
  );
}

export async function authenticateActivityUser(options) {
  const oauth = await exchangeDiscordCode(options);
  const user = await getDiscordUser(oauth.access_token, options.fetchImpl);
  const instance = await getActivityInstance(options);
  if (instance.application_id !== options.clientId || instance.instance_id !== options.instanceId) {
    throw new Error("A instância retornada pelo Discord não corresponde a esta Activity.");
  }
  if (!Array.isArray(instance.users) || !instance.users.includes(user.id)) {
    const error = new Error("O usuário não está conectado a esta instância da Activity.");
    error.status = 403;
    throw error;
  }
  return { oauth, user, instance };
}

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.global_name || user.username,
    avatar: user.avatar || null
  };
}
