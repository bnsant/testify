import { profileFor } from "../../../shared/streaming.js";

const audioSafetyByStream = new WeakMap();

export function enforceCapturedAudioSafety(stream) {
  const videoTrack = stream?.getVideoTracks?.()[0];
  const settings = videoTrack?.getSettings?.() || {};
  const label = String(videoTrack?.label || '');
  const normalizedLabel = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const entireScreen = settings.displaySurface === 'monitor'
    || (!settings.displaySurface && /entire screen|tela inteira|monitor|screen [0-9]/.test(normalizedLabel));
  const discordWindow = /(^|[^a-z])discord(?: canary| ptb)?([^a-z]|$)/.test(normalizedLabel);
  const reason = entireScreen ? 'entire-screen' : discordWindow ? 'discord' : null;
  const audioTracks = stream?.getAudioTracks?.() || [];

  if (reason) {
    for (const track of audioTracks) {
      try { track.stop(); } catch { /* A faixa pode já ter terminado. */ }
      try { stream.removeTrack?.(track); } catch { /* Alguns navegadores não expõem removeTrack. */ }
    }
  }

  const result = Object.freeze({
    reason,
    removedTracks: reason ? audioTracks.length : 0,
    displaySurface: settings.displaySurface || '',
    label
  });
  if (stream && typeof stream === 'object') audioSafetyByStream.set(stream, result);
  return result;
}

export function captureAudioSafetyFor(stream) {
  return audioSafetyByStream.get(stream)
    || Object.freeze({ reason: null, removedTracks: 0, displaySurface: '', label: '' });
}

export function canCaptureInsideActivity() {
  if (!navigator.mediaDevices?.getDisplayMedia) return { supported: false, reason: "getDisplayMedia indisponível" };
  const policy = document.permissionsPolicy || document.featurePolicy;
  if (policy?.allowsFeature && !policy.allowsFeature("display-capture")) {
    return { supported: false, reason: "display-capture bloqueado pela Permissions Policy" };
  }
  return { supported: true, reason: "A confirmação real depende do seletor do sistema." };
}

export async function applyCaptureProfile(stream, name) {
  const profile = profileFor(name);
  for (const track of stream.getVideoTracks()) {
    track.contentHint = profile.hint;
    try {
      await track.applyConstraints({
        width: { ideal: profile.width, max: profile.width },
        height: { ideal: profile.height, max: profile.height },
        frameRate: { ideal: profile.fps, max: profile.fps }
      });
    } catch { /* Bitrate remains bounded if the source rejects resizing. */ }
  }
}

export async function requestDisplayStream(name = "balanced", withAudio = true) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Abra esta página no Chrome ou Edge do computador para compartilhar a tela.");
  }
  const profile = profileFor(name);
  let stream;
  const options = {
    video: { width: { ideal: profile.width }, height: { ideal: profile.height }, frameRate: { ideal: profile.fps } },
    audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    systemAudio: "include", selfBrowserSurface: "exclude", surfaceSwitching: "include"
  };
  try { stream = await navigator.mediaDevices.getDisplayMedia(options); }
  catch (error) {
    if (!withAudio || !["NotReadableError", "OverconstrainedError"].includes(error.name)) throw error;
    stream = await navigator.mediaDevices.getDisplayMedia({ ...options, audio: false });
  }
  enforceCapturedAudioSafety(stream);
  await applyCaptureProfile(stream, name);
  return stream;
}
export function stopStream(stream) {
  for (const track of stream?.getTracks?.() || []) track.stop();
}
