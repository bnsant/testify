export default function StreamControls({ busy, isMine, onShare, onStop, onInvite, preview, disabled }) {
  return <div className="control-bar">
    {isMine
      ? <button className="action danger" type="button" onClick={onStop}><span className="stop-icon" /> Encerrar</button>
      : <button className="action primary" type="button" onClick={onShare} disabled={busy || disabled || preview}>
          <span className="screen-icon">▰</span>{busy ? "Preparando…" : "Compartilhar tela"}
        </button>}
    <button className="action secondary" type="button" onClick={onInvite} disabled={preview}><span>＋</span> Convidar</button>
  </div>;
}
