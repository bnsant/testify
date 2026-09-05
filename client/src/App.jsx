import { useEffect, useRef, useState } from "react";
import Participants from "./components/Participants.jsx";
import Status from "./components/Status.jsx";
import StreamControls from "./components/StreamControls.jsx";
import VideoPlayer from "./components/VideoPlayer.jsx";
import { authenticateWithDiscord } from "./discord/auth.js";
import { initializeDiscord, isBrowserPreview } from "./discord/sdk.js";
import { watchParticipants } from "./discord/participants.js";
import { issueCaptureToken } from "./streaming/broadcast.js";
import { ActivitySocket } from "./streaming/signaling.js";

export default function App() {
  const [phase, setPhase] = useState("Inicializando o Discord…");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [room, setRoom] = useState({ broadcaster: null, viewerCount: 0 });
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview] = useState(isBrowserPreview());
  const playerRef = useRef(null), socketRef = useRef(null), discordRef = useRef(null);

  useEffect(() => {
    if (preview) { setPhase("Prévia do Testify · abra a Activity no Discord para transmitir"); return; }
    let cancelled = false, unsubscribe, socket;
    (async () => {
      const { discordSdk, instanceId } = await initializeDiscord();
      if (cancelled) return;
      discordRef.current = discordSdk;
      setPhase("Autenticando…");
      const authenticated = await authenticateWithDiscord(discordSdk, instanceId);
      if (cancelled) return;
      setSession(authenticated);
      unsubscribe = await watchParticipants(discordSdk, (value) => { if (!cancelled) setParticipants(value); });
      if (cancelled) { unsubscribe?.(); return; }
      socket = new ActivitySocket(authenticated.sessionToken);
      socketRef.current = socket;
      socket.addEventListener("connected", () => { setConnected(true); setPhase("Conectado à Activity"); setError(""); });
      socket.addEventListener("disconnected", () => {
        setConnected(false); setPhase("Reconectando ao Testify…");
        // Preserve the last frame while the socket reconnects. The server sends
        // a fresh media epoch after authentication, so resetting here only
        // created a disruptive black screen during short network changes.
      });
      socket.addEventListener("media", (event) => playerRef.current?.push(event.detail));
      socket.addEventListener("message", (event) => {
        const message = event.detail;
        if (message.type === "stream-start") {
          // Initialize synchronously BEFORE the next binary WebSocket event.
          playerRef.current?.start(message.broadcaster);
          setRoom((value) => ({ ...value, broadcaster: message.broadcaster }));
          setPhase("Transmissão conectada");
        }
        if (message.type === "room-state") {
          setRoom(message);
          if (!message.broadcaster) playerRef.current?.reset();
        }
        if (message.type === "broadcast-stopped") {
          playerRef.current?.reset();
          setRoom((value) => ({ ...value, broadcaster: null }));
          setPhase("Transmissão encerrada");
        }
        if (message.type === "error") setError(message.message);
      });
      socket.connect();
    })().catch((caught) => { if (!cancelled) { setError(caught.message); setPhase("Não foi possível abrir a Activity"); } });
    return () => { cancelled = true; unsubscribe?.(); socket?.close(); };
  }, [preview]);

  async function share() {
    if (!session || busy || !connected || room.broadcaster) return;
    setBusy(true); setError("");
    try {
      const grant = await issueCaptureToken(session.sessionToken);
      const result = await discordRef.current.commands.openExternalLink({ url: grant.captureUrl });
      setPhase(result?.opened === false ? "A abertura foi cancelada. Clique em Compartilhar tela para tentar novamente." : "No navegador, clique em Escolher tela. Mantenha esta Activity aberta.");
    } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }
  function stop() { socketRef.current?.send({ type: "stop-broadcast" }); }
  async function invite() {
    try { await discordRef.current.commands.openInviteDialog(); }
    catch { setError("O convite não está disponível em DMs ou você não tem permissão neste canal."); }
  }
  const currentUserId = session?.user?.id;
  const isMine = Boolean(currentUserId && room.broadcaster?.userId === currentUserId);
  return <div className="app-frame">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><span /></div><div><h1>Testify</h1><p>{participants.length} {participants.length === 1 ? "participante" : "participantes"}</p></div></div>
      <div className="secure-badge"><i /> INSTÂNCIA PRIVADA</div>
    </header>
    <main className="main-grid">
      <section className="stage-card">
        <div className="stage-heading"><Status preview={preview} connected={connected} broadcaster={room.broadcaster} currentUserId={currentUserId} /><span className="transport">Só para esta sala</span></div>
        <div className="stage"><VideoPlayer ref={playerRef} broadcaster={room.broadcaster} isMine={isMine}
          onResync={() => socketRef.current?.send({ type: "request-resync" })}
          onLatencyExceeded={() => socketRef.current?.refreshMedia()}
          onFeedback={(stats) => socketRef.current?.send({ type: "viewer-feedback", bufferSeconds: stats.bufferSeconds, transportMs: stats.transportMs, stalled: stats.stalled })} /></div>
        <div className="stage-footer"><div><strong>{phase}</strong><span>{isMine ? "Você pode encerrar aqui ou na janela de captura. Mantenha seu player sem áudio para evitar eco." : "Compartilhe pelo navegador e assista aqui, na mesma Activity."}</span></div>
          <StreamControls busy={busy} isMine={isMine} onShare={share} onStop={stop} onInvite={invite}
            disabled={!connected || Boolean(room.broadcaster)} preview={preview} /></div>
      </section>
      <Participants participants={participants} broadcasterId={room.broadcaster?.userId} currentUserId={currentUserId} />
    </main>
    {error && <button className="error-toast" type="button" role="alert" onClick={() => setError("")}>{error}<span>×</span></button>}
  </div>;
}
