export const MAX_VIEWERS = 5;
export const MAX_JSON_BYTES = 16 * 1024;
export const MAX_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
export const INSTANCE_ID_RE = /^i-[A-Za-z0-9_-]{8,220}$/;

// O MediaRecorder emite WebM (VP8/VP9/Opus) no desktop e fMP4 (H.264/AAC) em
// navegadores recentes. O fMP4 é o único contêiner que Safari/iOS reproduzem via
// ManagedMediaSource, portanto ambos são aceitos. A string opcional de `codecs`
// é limitada a ASCII imprimível e a um tamanho curto; o servidor apenas a
// repassa aos viewers, que a entregam ao `addSourceBuffer`.
export const MEDIA_TYPE_RE = /^video\/(webm|mp4)(;codecs=["']?[a-z0-9.,\- ]{1,70}["']?)?$/i;

export function isInstanceId(value) {
  return typeof value === "string" && INSTANCE_ID_RE.test(value);
}

export function parseJsonMessage(raw) {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) return { ok: false, error: "Mensagem grande demais." };
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, error: "JSON inválido." }; }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
    return { ok: false, error: "Mensagem inválida." };
  }
  return { ok: true, value };
}

export function validateMimeType(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > 120 || !MEDIA_TYPE_RE.test(trimmed)) return null;
  return trimmed;
}
