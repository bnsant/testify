import { useEffect, useRef, useState } from "react";
import Participants from "./components/Participants.jsx";
import Status from "./components/Status.jsx";
import StreamControls from "./components/StreamControls.jsx";
import VideoPlayer from "./components/VideoPlayer.jsx";
import { authenticateWithDiscord } from "./discord/auth.js";
import { initializeDiscord, isBrowserPreview } from "./discord/sdk.js";
import { watchParticipants } from "./discord/participants.js";
import { issueCaptureToken, claimCaptureToken, startBroadcast } from "./streaming/broadcast.js";
import { canCaptureInsideActivity, requestDisplayStream, stopStream } from "./streaming/capture.js";
import { ActivitySocket } from "./streaming/signaling.js";

const previewPeople = [
  { id: "preview-me", username: "Bernardo", global_name: "Bernardo", avatar: null },
  { id: "preview-friend", username: "Convidado", global_name: "Convidado", avatar: null }
];

function tokenFromCaptureUrl(url) { return new URL(url).searchParams.get("token"); }

export default function App() {
  const [phase, setPhase] = useState("Inicializando o Discord…");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [room, setRoom] = useState({ broadcaster: null, viewerCount: 0 });
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview] = useState(isBrowserPreview());
  const playerRef = useRef(null);
  const socketRef = useRef(null);
  const discordRef = useRef(null);
  const broadcastRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    if (preview) {
      setParticipants(previewPeople); setSession({ user: { id: "preview-me", displayName: "Bernardo" } }); setConnected(true); setPhase("Preview no navegador");
      return undefined;
    }
    let cancelled = false;
    let unsubscribe;
    let socket;
    (async () => {
      const { discordSdk, instanceId } = await initializeDiscord();
      if (cancelled) return;
      discordRef.current = discordSdk;
      setPhase("Autenticando…");
      const authenticated = await authenticateWithDiscord(discordSdk, instanceId);
      if (cancelled) return;
      setSession(authenticated);
      unsubscribe = await watchParticipants(discordSdk, setParticipants);
      socket = new ActivitySocket(authenticated.sessionToken);
      socketRef.current = socket;
      socket.addEventListener("connected", () => setConnected(true));
      socket.addEventListener("disconnected", () => setConnected(false));
      socket.addEventListener("media", (event) => playerRef.current?.push(event.detail));
      socket.addEventListener("message", (event) => {
        if (event.detail.type === "room-state") setRoom(event.detail);
        if (event.detail.type === "broadcast-stopped") setRoom((value) => ({ ...value, broadcaster: null }));
        if (event.detail.type === "error") setError(event.detail.message);
      });
      socket.connect();
      setPhase("Conectado à Activity");
    })().catch((caught) => { if (!cancelled) { setError(caught.message); setPhase("Não foi possível abrir a Activity"); } });
    return () => { cancelled = true; unsubscribe?.(); socket?.close(); stopStream(streamRef.current); broadcastRef.current?.stop(); };
  }, [preview]);

  async function openExternalCapture() {
    const grant = await issueCaptureToken(session.sessionToken);
    await discordRef.current.commands.openExternalLink({ url: grant.captureUrl });
  }

  async function share() {
    if (!session || busy) return;
    setBusy(true); setError("");
    const capability = canCaptureInsideActivity();
    console.info("[capture probe]", capability);
    try {
      if (!capability.supported) {
        await openExternalCapture();
        setPhase(`Captura externa aberta: ${capability.reason}`);
        return;
      }
      try {
        const stream = await requestDisplayStream();
        streamRef.current = stream;
        const grant = await issueCaptureToken(session.sessionToken);
        const claimed = await claimCaptureToken(tokenFromCaptureUrl(grant.captureUrl));
        broadcastRef.current = await startBroadcast({ stream, captureSessionToken: claimed.captureSessionToken });
        const media = stream.getAudioTracks().length ? "Vídeo e áudio" : "Vídeo (sem áudio do sistema)";
        const reach = broadcastRef.current.mimeType.includes("mp4") ? "MP4 · desktop e celular" : "WebM · somente desktop";
        setPhase(`${media} em transmissão — ${reach}`);
      } catch (captureError) {
        stopStream(streamRef.current); streamRef.current = null;
        if (!["NotAllowedError", "SecurityError", "NotSupportedError"].includes(captureError.name)) throw captureError;
        await openExternalCapture();
        setPhase("O Discord bloqueou a captura interna; use a página que foi aberta.");
      }
    } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }

  async function stop() {
    await broadcastRef.current?.stop();
    stopStream(streamRef.current); streamRef.current = null; broadcastRef.current = null;
  }

  async function invite() {
    try { await discordRef.current.commands.openInviteDialog(); }
    catch { setError("O convite não está disponível em DMs ou você não tem permissão neste canal."); }
  }

  const currentUserId = session?.user?.id;
  const isMine = room.broadcaster?.userId === currentUserId;
  return <div className="app-frame">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><span /></div><div><h1>Testify</h1><p>{participants.length} {participants.length === 1 ? "participante" : "participantes"}</p></div></div>
      <div className="secure-badge"><i /> INSTÂNCIA PRIVADA</div>
    </header>
    <main className="main-grid">
      <section className="stage-card">
        <div className="stage-heading"><Status connected={connected} broadcaster={room.broadcaster} currentUserId={currentUserId} /><span className="transport">WS · baixa latência</span></div>
        <div className="stage"><VideoPlayer ref={playerRef} broadcaster={room.broadcaster} /></div>
        <div className="stage-footer"><div><strong>{phase}</strong><span>{isMine && !broadcastRef.current ? "Encerre pela janela de captura externa." : "A transmissão termina quando a captura é fechada."}</span></div><StreamControls busy={busy} isMine={isMine} canStopHere={Boolean(broadcastRef.current)} onShare={share} onStop={stop} onInvite={invite} preview={preview} /></div>
      </section>
      <Participants participants={participants} broadcasterId={room.broadcaster?.userId} currentUserId={currentUserId} />
    </main>
    {error && <button className="error-toast" type="button" onClick={() => setError("")}>{error}<span>×</span></button>}
  </div>;
}
