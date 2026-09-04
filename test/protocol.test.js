import assert from "node:assert/strict";
import test from "node:test";
import { isInstanceId, parseJsonMessage, validateMimeType } from "../server/protocol.js";

test("valida instanceId e formatos codificados permitidos", () => {
  assert.equal(isInstanceId("i-1276580072400224306-gc-912952092627435520"), true);
  assert.equal(isInstanceId("sala-digitada"), false);
  assert.equal(validateMimeType("video/webm;codecs=vp8,opus"), "video/webm;codecs=vp8,opus");
  assert.equal(validateMimeType("video/mp4"), "video/mp4");
  assert.equal(validateMimeType('video/mp4;codecs="avc1.42E01E,mp4a.40.2"'), 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"');
  assert.equal(validateMimeType("video/ogg"), null);
  assert.equal(validateMimeType("video/webm;codecs=<script>"), null);
});

test("protocolo JSON rejeita mensagens inválidas", () => {
  assert.equal(parseJsonMessage(Buffer.from("{" )).ok, false);
  assert.deepEqual(parseJsonMessage(Buffer.from('{"type":"ping"}')), { ok: true, value: { type: "ping" } });
});
