// Shared protocol values; these contain no credentials.
export const PROTOCOL_VERSION = 2;
export const QUALITY_PROFILES = Object.freeze({
  balanced: { label: "Equilibrado · 1080p30", width: 1920, height: 1080, fps: 30, bitrate: 3_000_000, hint: "detail" },
  motion: { label: "Movimento · 720p60", width: 1280, height: 720, fps: 60, bitrate: 2_500_000, hint: "motion" },
  economy: { label: "Econômico · 720p30", width: 1280, height: 720, fps: 30, bitrate: 1_500_000, hint: "detail" },
  fallback: { label: "Conexão limitada · 576p15", width: 1024, height: 576, fps: 15, bitrate: 600_000, hint: "detail" }
});
export const MIME_TYPES = [
  'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9',
  'video/mp4;codecs="avc1.42E028,mp4a.40.2"', 'video/mp4;codecs="avc1.42E028"'
];
export function profileFor(name) { return QUALITY_PROFILES[name] || QUALITY_PROFILES.balanced; }
export function lowerProfile(name) {
  return name === "fallback" ? "fallback" : name === "economy" ? "fallback" : "economy";
}
export function supportedPlaybackTypes() {
  const impl = globalThis.MediaSource || globalThis.ManagedMediaSource;
  return MIME_TYPES.filter((type) => impl?.isTypeSupported(type));
}
