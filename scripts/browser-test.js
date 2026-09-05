// Local-only media test. Synthetic canvas/audio, test tokens and test Discord responses.
// No production credentials, accounts, screen capture or Railway writes are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocket } from "ws";
import { ExpiringTokenStore } from "../server/tokenStore.js";
import { RoomRegistry } from "../server/rooms.js";
import { createApp } from "../server/app.js";
import { attachWebSocketServer } from "../server/websocket.js";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME_PATH || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"
].find(existsSync);
if (!chrome) throw new Error("Chrome não encontrado. Configure CHROME_PATH.");
const profile = await mkdtemp(path.join(os.tmpdir(), "testify-browser-"));
const sessions = new ExpiringTokenStore({ ttlMs: 180_000 });
const captureSessions = new ExpiringTokenStore({ ttlMs: 180_000 });
const captureTokens = new ExpiringTokenStore({ ttlMs: 180_000 });
const rooms = new RoomRegistry();
const instanceId = "i-browser-test-instance-123";
const app = express();
app.use("/modules", express.static(path.join(root, "client/src")));
app.use("/shared", express.static(path.join(root, "shared")));
app.get("/harness", (_req, res) => res.type("html").send('<!doctype html><html><body><video id="video" autoplay muted playsinline></video></body></html>'));
const config = {
  allowedOrigins: new Set(), development: true, publicBaseUrl: "", distDirectory: path.join(root, "dist"),
  clientId: "local-test", clientSecret: "local-test", botToken: "local-test", sessionTtlMs: 180_000, captureTokenTtlMs: 60_000
};
app.use(createApp({ config, sessions, captureSessions, captureTokens, rooms }));
const server = http.createServer(app);
const relay = attachWebSocketServer(server, { config, sessions, captureSessions, rooms });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
config.publicBaseUrl = base; config.allowedOrigins.add(base);
let child, cdp;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await pause(150); }
  throw new Error(message);
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.errors = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params.exceptionDetails.text + ": " + (message.params.exceptionDetails.exception?.description || ""));
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async page(url) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("Page.enable", {}, sessionId);
    await this.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await this.send("Page.navigate", { url }, sessionId);
    await until(async () => {
      try { return await this.evaluate(sessionId, 'document.readyState === "complete" && location.href !== "about:blank"'); } catch { return false; }
    }, "Página não carregou");
    return sessionId;
  }
  async evaluate(sessionId, expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}
const grant = (id) => ({ instanceId, user: { id, displayName: id, avatar: null } });
async function viewer(id) {
  const sessionId = await cdp.page(base + "/harness");
  const token = sessions.issue(grant(id));
  await cdp.evaluate(sessionId, `(async () => {
    const { ActivitySocket } = await import("/modules/streaming/signaling.js");
    const { MediaSourcePlayer } = await import("/modules/streaming/mediaSource.js");
    window.errors = []; window.epochs = 0; window.authenticated = false; window.lastStream = null;
    window.player = new MediaSourcePlayer(document.querySelector("video"), {
      onError(error) { window.errors.push(error.message); },
      onStats(stats) { window.stats = stats; }
    });
    window.socket = new ActivitySocket(${JSON.stringify(token)});
    socket.addEventListener("connected", () => { window.authenticated = true; });
    socket.addEventListener("media", event => player.push(event.detail));
    socket.addEventListener("message", event => {
      if (event.detail.type === "stream-start") { window.epochs++; window.lastStream = event.detail.broadcaster; player.start(event.detail.broadcaster.mimeType); }
      if (event.detail.type === "broadcast-stopped") { window.stopped = true; player.destroy(); }
      if (event.detail.type === "error") window.errors.push(event.detail.message);
    });
    socket.connect();
  })()`);
  await until(() => cdp.evaluate(sessionId, "window.authenticated"), "Viewer não autenticou");
  return sessionId;
}
try {
  child = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"],
    { windowsHide: true, stdio: "ignore" });
  let launchError;
  child.on("error", (error) => { launchError = error; });
  const active = await until(async () => {
    if (launchError) throw launchError;
    try { return (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"); } catch { return null; }
  }, "Chrome não iniciou");
  const socket = new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  cdp = new CDP(socket);
  const owner = await viewer("owner");
  const first = await viewer("first");
  const capture = await cdp.page(base + "/harness");
  const token = captureSessions.issue(grant("owner"));
  await cdp.evaluate(capture, `(async () => {
    const { startBroadcast } = await import("/modules/streaming/broadcast.js");
    const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
    document.body.append(canvas); const ctx = canvas.getContext("2d");
    let frame = 0;
    window.paint = setInterval(() => {
      ctx.fillStyle = frame % 2 ? "#463080" : "#214578"; ctx.fillRect(0,0,1280,720);
      ctx.fillStyle = "white"; ctx.font = "80px sans-serif"; ctx.fillText("Testify " + frame++, 50, 180);
    }, 33);
    window.stream = canvas.captureStream(30);
    window.audio = new AudioContext(); await audio.resume();
    const tone = audio.createOscillator(); const gain = audio.createGain(); gain.gain.value = 0.01;
    const destination = audio.createMediaStreamDestination(); tone.connect(gain).connect(destination); tone.start();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    window.states = [];
    window.broadcast = await startBroadcast({ stream, captureSessionToken: ${JSON.stringify(token)},
      onStatus: (state, detail) => window.states.push({state, detail}) });
  })()`);
  await cdp.send("Page.bringToFront", {}, first);
  await until(() => cdp.evaluate(first, 'document.querySelector("video").getVideoPlaybackQuality().totalVideoFrames > 10 && document.querySelector("video").currentTime > 0.2'), "Vídeo inicial não decodificou").catch(async (error) => {
    console.log("Viewer diagnostics:", await cdp.evaluate(first, '({errors, epochs, stats:window.stats, source:player.mediaSource?.readyState, queued:player.queuedBytes, buffer:player.sourceBuffer?.buffered.length, time:document.querySelector("video").currentTime, ready:document.querySelector("video").readyState, paused:document.querySelector("video").paused, frames:document.querySelector("video").getVideoPlaybackQuality(), mediaError:document.querySelector("video").error?.message})'));
    console.log("Capture diagnostics:", await cdp.evaluate(capture, '({states, recorder:broadcast.recorder?.state, socket:broadcast.socket.readyState, tracks:stream.getTracks().map(t=>({kind:t.kind,state:t.readyState,settings:t.getSettings()}))})'));
    console.log("Chrome exceptions:", cdp.errors);
    throw error;
  });
  console.log("PASS Chrome: canvas + áudio → MediaRecorder → WebSocket → MediaSource");
  const late = await viewer("late");
  await cdp.send("Page.bringToFront", {}, late);
  await until(() => cdp.evaluate(late, 'document.querySelector("video").getVideoPlaybackQuality().totalVideoFrames > 10 && document.querySelector("video").currentTime > 0.2'), "Entrada tardia não reproduziu");
  console.log("PASS Chrome: entrada tardia com nova sequência de mídia");
  await cdp.send("Page.bringToFront", {}, first);
  const initialEpoch = await cdp.evaluate(first, "window.epochs");
  await cdp.evaluate(capture, 'broadcast.setProfile("economy")');
  await until(() => cdp.evaluate(first, `window.epochs > ${initialEpoch} && window.lastStream.profile === "economy" && document.querySelector("video").currentTime > 0.3`), "Troca de qualidade falhou");
  console.log("PASS Chrome: mudança de qualidade durante transmissão");
  const beforeSourceSwitch = await cdp.evaluate(first, "window.epochs");
  await cdp.evaluate(capture, "broadcast.refreshSource()");
  await until(() => cdp.evaluate(first, `window.epochs > ${beforeSourceSwitch} && document.querySelector("video").currentTime > 0.3`), "Troca de tela não iniciou uma sequência limpa");
  assert.equal(await cdp.evaluate(capture, "broadcast.socket.readyState"), 1);
  console.log("PASS Chrome: troca de tela inicia nova sequência sem desconectar a captura");
  await cdp.send("Page.bringToFront", {}, late);
  const beforeReconnect = await cdp.evaluate(late, "window.epochs");
  await cdp.evaluate(late, 'socket.socket.close(4001, "Teste de reconexao")');
  await until(() => cdp.evaluate(late, `window.epochs > ${beforeReconnect} && document.querySelector("video").currentTime > 0.3`), "Reconexão não recuperou");
  console.log("PASS Chrome: viewer reconectou e voltou a decodificar");
  await cdp.send("Page.bringToFront", {}, first);
  const beforeCaptureReconnect = await cdp.evaluate(first, "window.epochs");
  await cdp.evaluate(capture, 'broadcast.socket.close(4001, "Teste de captura")');
  await until(() => cdp.evaluate(first, `window.epochs > ${beforeCaptureReconnect} && document.querySelector("video").currentTime > 0.3`), "Captura não reconectou");
  console.log("PASS Chrome: captura reconectou sem pedir a tela novamente");
  const extra = [];
  for (let index = 0; index < 3; index++) {
    const page = await viewer("extra-" + index);
    extra.push(page);
    await cdp.send("Page.bringToFront", {}, page);
    await until(() => cdp.evaluate(page, 'document.querySelector("video").currentTime > 0.3'), "Viewer adicional não reproduziu");
  }
  assert.equal(relay.rooms.viewerCount(relay.rooms.rooms.get(instanceId)), 5);
  await cdp.send("Page.bringToFront", {}, first);
  await until(() => cdp.evaluate(first, 'document.querySelector("video").currentTime > 0.3'), "Player não retomou ao voltar à aba");
  const timeBefore = await cdp.evaluate(first, 'document.querySelector("video").currentTime');
  await pause(20_000);
  const metrics = await cdp.evaluate(first, '({stats:window.stats, epochs:window.epochs, mime:window.lastStream.mimeType, errors:window.errors, time:document.querySelector("video").currentTime, audioBytes:document.querySelector("video").webkitAudioDecodedByteCount, retainedSeconds:player.sourceBuffer.buffered.end(0)-player.sourceBuffer.buffered.start(0)})');
  assert.ok(metrics.time > timeBefore + 10, "Player deve continuar avançando");
  assert.ok(metrics.retainedSeconds < 15, "Buffer antigo deve ser removido");
  assert.ok(metrics.audioBytes > 0, "Áudio precisa ser realmente decodificado");
  console.log("PASS Chrome: cinco viewers, áudio decodificado e buffer limitado durante reprodução contínua");
  assert.deepEqual(metrics.errors, []);
  assert.match(metrics.mime, /opus|mp4a/, "áudio deve estar no contêiner");
  await cdp.evaluate(owner, 'socket.send({type:"stop-broadcast"})');
  await until(() => cdp.evaluate(capture, 'stream.getTracks().every(track => track.readyState === "ended")'), "Encerrar na Activity não liberou tracks");
  console.log("PASS Chrome: encerrar pela Activity libera vídeo e áudio");
  const page = await cdp.page(base + "/capture");
  assert.match(await cdp.evaluate(page, "document.body.innerText"), /Abra a Activity do Testify/);
  const attack = captureTokens.issue(grant("owner"));
  const capturePage = await cdp.page(base + "/capture#token=" + attack);
  await until(() => cdp.evaluate(capturePage, 'Boolean(document.getElementById("start-capture"))'), "Página de captura não validou token");
  assert.equal(await cdp.evaluate(capturePage, "location.hash"), "");
  await mkdir(path.join(root, "test-results"), { recursive: true });
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" }, capturePage);
  await writeFile(path.join(root, "test-results/capture.png"), Buffer.from(screenshot.data, "base64"));
  const preview = await cdp.page(base);
  await until(() => cdp.evaluate(preview, 'document.body.innerText.includes("Testify")'), "Preview da Activity não renderizou");
  assert.equal(await cdp.evaluate(preview, 'Array.from(document.querySelectorAll("button")).some(button => button.textContent.includes("Compartilhar tela") && button.disabled)'), true);
  assert.equal(await cdp.evaluate(preview, 'Array.from(document.querySelectorAll("button")).some(button => button.textContent.includes("Encerrar"))'), false);
  const previewImage = await cdp.send("Page.captureScreenshot", { format: "png" }, preview);
  await writeFile(path.join(root, "test-results/activity.png"), Buffer.from(previewImage.data, "base64"));
  assert.deepEqual(cdp.errors, []);
  await writeFile(path.join(root, "test-results/browser.json"), JSON.stringify({ checkedAt: new Date().toISOString(), metrics, browserExceptions: cdp.errors, note: "Synthetic media on localhost; not a Discord two-PC test." }, null, 2));
  console.log("PASS Chrome: capture page, token removido da URL, preview React e ausência de exceções");
  console.log(JSON.stringify(metrics));
} finally {
  if (cdp) { try { await cdp.send("Browser.close"); } catch {} cdp.socket.close(); }
  if (child && child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), pause(2000)]);
    if (child.exitCode === null) child.kill();
  }
  relay.close(); await new Promise((resolve) => server.close(resolve));
  // Only delete the exact temporary Chrome profile created by this test.
  const relative = path.relative(os.tmpdir(), profile);
  if (!relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(profile).startsWith("testify-browser-")) {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
}
