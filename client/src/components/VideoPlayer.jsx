import { forwardRef, useImperativeHandle, useRef, useState, useEffect } from "react";
import { MediaSourcePlayer } from "../streaming/mediaSource.js";

const VideoPlayer = forwardRef(function VideoPlayer({ broadcaster, isMine, onResync, onLatencyExceeded, onFeedback }, ref) {
  const videoRef = useRef(null), playerRef = useRef(null), callbacks = useRef({});
  callbacks.current = { onResync, onLatencyExceeded, onFeedback };
  const [muted, setMuted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [buffer, setBuffer] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const hasPlayed = useRef(false);
  const recoveryTimer = useRef(null);
  const lastFeedback = useRef(0);
  useEffect(() => () => {
    clearTimeout(recoveryTimer.current);
    playerRef.current?.destroy();
  }, []);
  useEffect(() => { if (isMine) setMuted(true); }, [isMine]);
  useEffect(() => {
    if (!expanded) return undefined;
    const onKeyDown = (event) => { if (event.key === "Escape") setExpanded(false); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded]);
  useEffect(() => { if (!broadcaster) setExpanded(false); }, [broadcaster]);
  useImperativeHandle(ref, () => ({
    start(description) {
      clearTimeout(recoveryTimer.current);
      playerRef.current?.destroy();
      if (!hasPlayed.current) setLoading(true);
      setBuffer(null);
      const player = new MediaSourcePlayer(videoRef.current, {
        onError() {
          clearTimeout(recoveryTimer.current);
          recoveryTimer.current = setTimeout(() => callbacks.current.onResync?.(), 750);
        },
        onLatencyExceeded(stats) {
          if (callbacks.current.onLatencyExceeded) callbacks.current.onLatencyExceeded(stats);
          else callbacks.current.onResync?.();
        },
        onStats(stats) {
          setBuffer(stats.bufferSeconds);
          if (Date.now() - lastFeedback.current > 1500) {
            lastFeedback.current = Date.now(); callbacks.current.onFeedback?.(stats);
          }
        }
      });
      playerRef.current = player;
      try { player.start(description.mimeType); }
      catch { recoveryTimer.current = setTimeout(() => callbacks.current.onResync?.(), 750); }
    },
    push(chunk) { playerRef.current?.push(chunk); },
    reset() {
      clearTimeout(recoveryTimer.current);
      playerRef.current?.destroy(); playerRef.current = null;
      hasPlayed.current = false;
      setLoading(true); setBuffer(null); setExpanded(false);
    }
  }), []);

  async function toggleAudio() {
    if (isMine) return;
    const next = !muted;
    videoRef.current.muted = next;
    setMuted(next);
    try { await videoRef.current.play(); } catch { /* O próximo gesto pode iniciar o áudio. */ }
  }

  return <div className={`video-shell${expanded ? " is-expanded" : ""}`}>
    <video ref={videoRef} autoPlay playsInline muted={isMine || muted} hidden={!broadcaster}
      onPlaying={() => { hasPlayed.current = true; setLoading(false); }}
      onWaiting={() => { if (!hasPlayed.current) setLoading(true); }} />
    {!broadcaster && <div className="empty-stage"><div className="empty-orbit"><span /></div><h2>A sala está pronta</h2><p>Aguardando alguém compartilhar a tela.</p></div>}
    {broadcaster && <>
      <div className="video-topline"><span className="live-pill"><i /> AO VIVO</span><span>{broadcaster.displayName}</span></div>
      {loading && !hasPlayed.current && <div className="player-loading" role="status">Preparando transmissão…</div>}
      <div className="player-controls">
        <button type="button" onClick={toggleAudio} disabled={isMine}
          title={isMine ? "O áudio do seu próprio player fica mudo para impedir eco." : ""}>
          {isMine ? "Áudio local bloqueado" : muted ? "Ativar áudio" : "Silenciar"}
        </button>
        <button type="button" onClick={() => setExpanded((value) => !value)} aria-pressed={expanded}>{expanded ? "Sair da tela cheia" : "Tela cheia"}</button>
        {buffer !== null && <span className="player-buffer" title="Vídeo disponível à frente do player; não é a latência de ponta a ponta.">Buffer {buffer.toFixed(1)} s</span>}
      </div>
    </>}
  </div>;
});
export default VideoPlayer;
