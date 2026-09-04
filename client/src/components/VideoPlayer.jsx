import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MediaSourcePlayer } from "../streaming/mediaSource.js";

const VideoPlayer = forwardRef(function VideoPlayer({ broadcaster }, ref) {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const [muted, setMuted] = useState(true);
  const [error, setError] = useState("");

  useImperativeHandle(ref, () => ({
    push(chunk) { playerRef.current?.push(chunk); }
  }), []);

  useEffect(() => {
    if (!broadcaster || !videoRef.current) return undefined;
    try {
      const player = new MediaSourcePlayer(videoRef.current);
      player.start(broadcaster.mimeType);
      playerRef.current = player;
      setError("");
      return () => { player.destroy(); playerRef.current = null; };
    } catch (caught) {
      setError(caught.message);
      return undefined;
    }
  }, [broadcaster?.userId, broadcaster?.mimeType]);

  if (!broadcaster) {
    return <div className="empty-stage"><div className="empty-orbit"><span /></div><h2>A sala está pronta</h2><p>Aguardando alguém compartilhar a tela.</p></div>;
  }

  return <div className="video-shell">
    <video ref={videoRef} autoPlay playsInline muted={muted} />
    <div className="video-topline"><span className="live-pill"><i /> AO VIVO</span><span>{broadcaster.displayName}</span></div>
    {error && <div className="player-error">{error}</div>}
    <div className="player-controls">
      <button type="button" onClick={() => setMuted((value) => !value)}>{muted ? "Ativar áudio" : "Silenciar"}</button>
      <button type="button" onClick={() => videoRef.current?.requestFullscreen?.()}>Tela cheia</button>
    </div>
  </div>;
});

export default VideoPlayer;
