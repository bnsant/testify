import { DiscordSDK, Events } from "@discord/embedded-app-sdk";

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
let sdk;

export function isBrowserPreview() {
  return window.self === window.top && import.meta.env.VITE_ENABLE_BROWSER_PREVIEW !== "false";
}

export function getDiscordSdk() {
  if (!clientId) throw new Error("VITE_DISCORD_CLIENT_ID não foi configurado.");
  if (!sdk) sdk = new DiscordSDK(clientId);
  return sdk;
}

export async function initializeDiscord() {
  const discordSdk = getDiscordSdk();
  const instanceId = discordSdk.instanceId;
  if (!instanceId) throw new Error("O Discord não forneceu um instanceId.");
  await discordSdk.ready();
  return { discordSdk, instanceId };
}

export { Events };
