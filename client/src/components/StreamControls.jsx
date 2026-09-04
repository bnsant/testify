export default function StreamControls({ busy, isMine, canStopHere, onShare, onStop, onInvite, preview }) {
  return <div className="control-bar">
    {isMine && canStopHere
      ? <button className="action danger" type="button" onClick={onStop}><span className="stop-icon" /> Encerrar</button>
      : <button className="action primary" type="button" onClick={onShare} disabled={busy || isMine || preview}>
          <span className="screen-icon">▰</span>{busy ? "Preparando…" : isMine ? "Transmitindo" : "Compartilhar tela"}
        </button>}
    <button className="action secondary" type="button" onClick={onInvite} disabled={preview}><span>＋</span> Convidar</button>
  </div>;
}
