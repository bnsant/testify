export default function Status({ connected, broadcaster, currentUserId }) {
  const text = !connected
    ? "Reconectando…"
    : !broadcaster
      ? "Pronto para transmitir"
      : broadcaster.userId === currentUserId
        ? "Você está transmitindo"
        : `${broadcaster.displayName} está transmitindo`;
  return <div className="status-line"><i className={broadcaster ? "live" : connected ? "online" : ""} /><span>{text}</span></div>;
}
