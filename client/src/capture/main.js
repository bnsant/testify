import { claimCaptureToken, startBroadcast } from "../streaming/broadcast.js";
import { requestDisplayStream, stopStream } from "../streaming/capture.js";
import "../styles/capture.css";

const root = document.getElementById("capture-root");
let grant;
let stream;
let broadcast;

function render(state, message = "") {
  root.innerHTML = `<section class="capture-card">
    <div class="capture-brand"><span class="capture-logo"><i></i></span><span>TESTIFY</span></div>
    <div class="capture-visual ${state === "live" ? "is-live" : ""}"><div class="monitor"><span></span></div><i class="pulse one"></i><i class="pulse two"></i></div>
    <p class="capture-kicker">JANELA DE CAPTURA SEGURA</p>
    <h1>${state === "live" ? "Sua tela está no ar" : state === "error" ? "Não foi possível continuar" : "Escolha o que compartilhar"}</h1>
    <p class="capture-copy">${message || "O navegador pedirá uma tela, janela ou guia. Volte ao Discord depois de iniciar."}</p>
    <div class="capture-actions">
      ${state === "ready" ? '<button id="start-capture" class="capture-primary">Escolher tela</button>' : ""}
      ${state === "live" ? '<button id="stop-capture" class="capture-danger">Encerrar transmissão</button>' : ""}
    </div>
    <div class="capture-security"><span>◆</span><p>O link é temporário e de uso único. Nenhuma credencial do Discord aparece nesta URL.</p></div>
  </section>`;
  document.getElementById("start-capture")?.addEventListener("click", begin);
  document.getElementById("stop-capture")?.addEventListener("click", stop);
}

async function begin() {
  try {
    render("loading", "Aguardando sua escolha no seletor do sistema…");
    stream = await requestDisplayStream();
    broadcast = await startBroadcast({ stream, captureSessionToken: grant.captureSessionToken, onStatus(status) { if (status === "disconnected") render("error", "A conexão com o servidor foi encerrada."); } });
    render("live", stream.getAudioTracks().length ? "Vídeo e áudio do sistema estão sendo enviados para a Activity." : "O vídeo está sendo enviado. Esta fonte não disponibilizou áudio do sistema.");
  } catch (error) {
    stopStream(stream);
    render("error", error.name === "NotAllowedError" ? "A seleção foi cancelada. Reabra a Activity para tentar novamente." : error.message);
  }
}

async function stop() {
  await broadcast?.stop();
  stopStream(stream);
  render("stopped", "Transmissão encerrada. Você pode fechar esta página e voltar ao Discord.");
}

(async () => {
  const token = new URL(location.href).searchParams.get("token");
  if (!token) return render("error", "O token de captura não foi informado.");
  try {
    render("loading", "Validando o link temporário…");
    grant = await claimCaptureToken(token);
    history.replaceState(null, "", "/capture");
    render("ready");
  } catch (error) { render("error", error.message); }
})();

addEventListener("beforeunload", () => { broadcast?.stop(); stopStream(stream); });
