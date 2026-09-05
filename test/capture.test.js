import test from "node:test";
import assert from "node:assert/strict";
import { captureAudioSafetyFor, enforceCapturedAudioSafety } from "../client/src/streaming/capture.js";
import { captureSourceFingerprint } from "../client/src/streaming/broadcast.js";

function capture({ displaySurface = "", label = "", audioCount = 1 } = {}) {
  const video = { label, getSettings: () => ({ displaySurface }) };
  const audio = Array.from({ length: audioCount }, () => ({ stopped: false, stop() { this.stopped = true; } }));
  const removed = [];
  const stream = {
    getVideoTracks: () => [video],
    getAudioTracks: () => audio.filter((track) => !removed.includes(track)),
    removeTrack(track) { removed.push(track); }
  };
  return { stream, audio };
}

test("proteção antieco remove áudio ao compartilhar a tela inteira", () => {
  const value = capture({ displaySurface: "monitor", label: "Entire Screen" });
  const policy = enforceCapturedAudioSafety(value.stream);
  assert.equal(policy.reason, "entire-screen");
  assert.equal(policy.removedTracks, 1);
  assert.equal(value.audio[0].stopped, true);
  assert.equal(value.stream.getAudioTracks().length, 0);
  assert.deepEqual(captureAudioSafetyFor(value.stream), policy);
});

test("proteção antieco remove áudio de uma janela do Discord", () => {
  const value = capture({ displaySurface: "window", label: "Discord" });
  const policy = enforceCapturedAudioSafety(value.stream);
  assert.equal(policy.reason, "discord");
  assert.equal(value.stream.getAudioTracks().length, 0);
});

test("áudio opcional continua em uma guia comum", () => {
  const value = capture({ displaySurface: "browser", label: "YouTube" });
  const policy = enforceCapturedAudioSafety(value.stream);
  assert.equal(policy.reason, null);
  assert.equal(policy.removedTracks, 0);
  assert.equal(value.stream.getAudioTracks().length, 1);
  assert.equal(value.audio[0].stopped, false);
});

test("troca de superfície altera a impressão digital da captura", () => {
  const first = capture({ displaySurface: "browser", label: "YouTube" });
  const second = capture({ displaySurface: "monitor", label: "Entire Screen" });
  assert.notEqual(captureSourceFingerprint(first.stream), captureSourceFingerprint(second.stream));
});
