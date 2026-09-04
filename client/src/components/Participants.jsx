import { avatarUrl, participantName } from "../discord/participants.js";

export default function Participants({ participants, broadcasterId, currentUserId }) {
  return <aside className="participants-card">
    <div className="panel-title"><span>Pessoas</span><b>{participants.length}</b></div>
    <div className="people-list">
      {participants.map((participant) => {
        const live = participant.id === broadcasterId;
        return <div className="person" key={participant.id}>
          <div className="avatar-wrap"><img src={avatarUrl(participant)} alt="" /><i className={live ? "live" : ""} /></div>
          <div className="person-copy"><strong>{participantName(participant)}{participant.id === currentUserId ? " (você)" : ""}</strong><span>{live ? "Compartilhando a tela" : "Na Activity"}</span></div>
          {live && <span className="mini-live">LIVE</span>}
        </div>;
      })}
    </div>
    <div className="privacy-note"><span>◈</span><p><strong>Sala privada</strong><br />Somente pessoas nesta instância da Activity entram aqui.</p></div>
  </aside>;
}
