export function canCaptureInsideActivity() {
  if (!navigator.mediaDevices?.getDisplayMedia) return { supported: false, reason: "getDisplayMedia indisponível" };
  const policy = document.permissionsPolicy || document.featurePolicy;
  if (policy?.allowsFeature && !policy.allowsFeature("display-capture")) {
    return { supported: false, reason: "display-capture bloqueado pela Permissions Policy" };
  }
  return { supported: true, reason: "API e política disponíveis; a confirmação real ocorre no seletor do sistema" };
}

export async function requestDisplayStream() {
  // getDisplayMedia só aceita `ideal`/`max` (nada de `min`) para superfícies de tela.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 }
    },
    audio: true
  });
  // Alguns navegadores só sobem de 30 fps se pedirmos de novo via applyConstraints.
  for (const track of stream.getVideoTracks()) {
    try { await track.applyConstraints({ frameRate: { ideal: 60 } }); }
    catch { /* mantém o que o navegador entregou */ }
  }
  return stream;
}

export function stopStream(stream) {
  for (const track of stream?.getTracks?.() || []) track.stop();
}
