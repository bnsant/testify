import { claimCaptureToken, startBroadcast } from "../streaming/broadcast.js";
import { requestDisplayStream, stopStream } from "../streaming/capture.js";
import { QUALITY_PROFILES } from "../../../shared/streaming.js";
import "../styles/capture.css";

const root = document.getElementById("capture-root");
let grant, stream, broadcast;
let selectedProfile = "balanced", automatic = true, withAudio = true;
let busy = false, lastError = "", status = "loading";
function render(state, message = "") {
  status = state;
  root.innerHTML = `<section class="capture-card">
    <div class="capture-brand"><span class="capture-logo"><i></i></span><span>TESTIFY</span></div>
    <div class="capture-visual ${state === "live" ? "is-live" : ""}"><div class="monitor"><span></span></div><i class="pulse one"></i><i class="pulse two"></i></div>
    <p class="capture-kicker">SUA TELA, NA SUA ACTIVITY</p>
    <h1>${state === "live" ? "Sua tela está no ar" : state === "error" ? "Não foi possível continuar" : state === "stopped" ? "Transmissão encerrada" : "Escolha o que compartilhar"}</h1>
    <p class="capture-copy" role="status"></p>
    ${["ready", "live"].includes(state) ? `<label class="capture-field">Qualidade<select id="quality">${Object.entries(QUALITY_PROFILES).map(([id, value]) => `<option value="${id}" ${id === selectedProfile ? "selected" : ""}>${value.label}</option>`).join("")}</select></label>` : ""}
    ${state === "ready" ? `<label class="capture-check"><input id="audio" type="checkbox" ${withAudio ? "checked" : ""}> Compartilhar áudio quando disponível</label><label class="capture-check"><input id="automatic" type="checkbox" ${automatic ? "checked" : ""}> Reduzir qualidade se a conexão precisar</label>` : ""}
    <div class="capture-actions">
      ${state === "ready" ? '<button id="start-capture" class="capture-primary">Escolher tela</button>' : ""}
      ${["live", "reconnecting"].includes(state) ? '<button id="stop-capture" class="capture-danger">Encerrar transmissão</button>' : ""}
    </div>
    <p id="capture-stats" class="capture-stats" aria-live="off"></p>
    <div class="capture-security"><span>◆</span><p>Mantenha esta página e a Activity abertas. Para compartilhar uma guia com som, marque a opção de áudio no seletor do Chrome. Seu microfone continua na call do Discord.</p></div>
  </section>`;
  root.querySelector(".capture-copy").textContent = message || "Escolha uma tela, janela ou guia no Chrome. Depois, volte ao Discord para acompanhar.";
  document.getElementById("quality")?.addEventListener("change", (event) => {
    selectedProfile = event.target.value;
    broadcast?.setProfile(selectedProfile);
  });
  document.getElementById("audio")?.addEventListener("change", (event) => { withAudio = event.target.checked; });
  document.getElementById("automatic")?.addEventListener("change", (event) => { automatic = event.target.checked; });
  document.getElementById("start-capture")?.addEventListener("click", begin);
  document.getElementById("stop-capture")?.addEventListener("click", stop);
}
async function begin() {
  if (busy) return;
  busy = true; lastError = "";
  try {
    render("loading", "Aguardando sua escolha no seletor do sistema…");
    stream = await requestDisplayStream(selectedProfile, withAudio);
    broadcast = await startBroadcast({
      stream, captureSessionToken: grant.captureSessionToken, profile: selectedProfile, automatic,
      onStatus(state, detail) {
        if (state === "error") { lastError = detail; render("error", detail); }
        else if (state === "stopped") render(lastError ? "error" : "stopped", lastError || "Você pode fechar esta página e voltar ao Discord.");
        else if (state === "reconnecting") render("reconnecting", detail);
        else if (state === "live") render("live", stream.getAudioTracks().length
          ? "Vídeo e áudio estão sendo enviados para a Activity. Volte ao Discord; deixe esta página aberta."
          : "Seu vídeo está na Activity. Esta captura está sem áudio.");
      },
      onStats(stats) {
        if (status !== "live") return;
        const element = document.getElementById("capture-stats");
        if (element) element.textContent = `${stats.width || "?"} × ${stats.height || "?"} · ${Math.round(stats.fps || 0)} fps na captura · ${(stats.bitrate / 1e6).toFixed(1)} Mbps enviados`;
        selectedProfile = stats.profile;
        const select = document.getElementById("quality");
        if (select) select.value = selectedProfile;
      }
    });
  } catch (error) {
    stopStream(stream);
    if (error.name === "NotAllowedError" || error.name === "AbortError") render("ready", "Seleção cancelada. Clique em Escolher tela quando quiser tentar novamente.");
    else render("error", error.message);
  } finally { busy = false; }
}
async function stop() {
  await broadcast?.stop(); stopStream(stream);
  render("stopped", "Você pode fechar esta página e voltar ao Discord.");
}
(async () => {
  const url = new URL(location.href);
  const token = new URLSearchParams(url.hash.slice(1)).get("token") || url.searchParams.get("token");
  // Remove the grant before any request, rendering or failure.
  history.replaceState(null, "", "/capture");
  if (!token) return render("error", "Abra a Activity do Testify no Discord e clique em Compartilhar tela.");
  try {
    render("loading", "Validando o link temporário…");
    grant = await claimCaptureToken(token);
    render("ready");
  } catch (error) { render("error", error.message); }
})();
addEventListener("pagehide", () => { void broadcast?.stop(); stopStream(stream); });
