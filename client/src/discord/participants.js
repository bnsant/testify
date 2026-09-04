import { Events } from "./sdk.js";

function listFrom(payload) {
  return Array.isArray(payload?.participants) ? payload.participants : [];
}

export async function watchParticipants(discordSdk, onChange) {
  const initial = await discordSdk.commands.getInstanceConnectedParticipants();
  onChange(listFrom(initial));
  const listener = (payload) => onChange(listFrom(payload));
  await discordSdk.subscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, listener);
  return () => discordSdk.unsubscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, listener);
}

export function participantName(participant) {
  return participant.global_name || participant.nickname || participant.username || "Pessoa";
}

export function avatarUrl(participant) {
  if (participant.avatar) return `/api/avatar/${encodeURIComponent(participant.id)}/${encodeURIComponent(participant.avatar)}`;
  try {
    const index = Number((BigInt(participant.id) >> 22n) % 6n);
    return `/api/avatar/default/${index}`;
  } catch {
    return "/api/avatar/default/0";
  }
}
