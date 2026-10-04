import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  encodePairingPayloadV2,
  normalizeDesktopWsUrlInput
} = require("../dist-electron/shared/desktop-ws-protocol.js");

test("desktop ws protocol helper encodes pairing v2 payloads as base64url JSON", () => {
  const payload = {
    v: 2,
    kind: "desktop-ws",
    targetMode: "tunnel",
    wsUrl: "wss://desktop.example.test/debug?token=old&source=qr#debug",
    tokenMode: "query",
    token: "desktop-token",
    expiresAtMs: Date.now() + 600_000,
    desktopDeviceId: "desktop-device-1"
  };

  const encoded = encodePairingPayloadV2(payload);
  assert.ok(encoded.startsWith("zmpair:v2:"));
  const body = encoded.slice("zmpair:v2:".length);
  assert.match(body, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(JSON.parse(Buffer.from(body, "base64url").toString("utf8")), payload);
});

test("desktop ws protocol helper normalizes websocket URLs", () => {
  assert.equal(
    normalizeDesktopWsUrlInput("desktop.example.test"),
    "wss://desktop.example.test/ws"
  );
  assert.equal(
    normalizeDesktopWsUrlInput("wss://desktop.example.test/custom?source=old&deviceId=old#debug"),
    "wss://desktop.example.test/ws"
  );
});
