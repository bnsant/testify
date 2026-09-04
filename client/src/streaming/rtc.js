// O proxy de Activities não suporta WebRTC atualmente. Este arquivo concentra a
// fronteira para uma futura troca de transporte sem espalhar RTCPeerConnection pela UI.
export const RTC_ACTIVITY_SUPPORT = false;
export const RTC_LIMITATION = "O proxy oficial do Discord Activities não suporta WebRTC.";

export async function loadPreparedRtcConfig() {
  const response = await fetch("/api/runtime-config");
  if (!response.ok) return { iceServers: [] };
  const payload = await response.json();
  return payload.rtcConfig;
}
