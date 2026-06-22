import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  applyDesktopTokenToUrl,
  buildDesktopBusinessFrame,
  buildDesktopTokenTransport,
  encodePairingPayloadV2,
  normalizeDesktopWsUrlInput,
  parsePairingPayload
} = require("../dist-electron/shared/desktop-ws-protocol.js");

test("desktop ws protocol helper encodes and parses pairing v2 payloads", () => {
  const payload = {
    v: 2,
    kind: "desktop-ws",
    targetMode: "local",
    wsUrl: "ws://127.0.0.1:7082/debug?token=old&source=qr#debug",
    tokenMode: "query",
    token: "desktop-token",
    expiresAtMs: Date.now() + 600_000,
    desktopDeviceId: "desktop-device-1"
  };

  const parsed = parsePairingPayload(encodePairingPayloadV2(payload));

  assert.equal(parsed.transportKind, "desktop-ws");
  assert.equal(parsed.payload.kind, "desktop-ws");
  assert.equal(parsed.payload.wsUrl, "ws://127.0.0.1:7082/ws");
  assert.equal(parsed.payload.token, "desktop-token");
  assert.equal(parsed.payload.desktopDeviceId, "desktop-device-1");
});

test("desktop ws protocol helper keeps legacy v1 parsing compatible", () => {
  const parsed = parsePairingPayload(JSON.stringify({
    desktopDeviceId: "desktop-1",
    desktopHostname: "office-mac",
    apiBaseUrl: "http://127.0.0.1:7080///",
    pairingId: "pairing-1",
    secret: "secret-1"
  }));

  assert.equal(parsed.transportKind, "http");
  assert.equal(parsed.payload.desktopDeviceId, "desktop-1");
  assert.equal(parsed.payload.apiBaseUrl, "http://127.0.0.1:7080");
  assert.equal(parsed.payload.pairingId, "pairing-1");
  assert.equal(parsed.payload.secret, "secret-1");
});

test("desktop ws protocol helper rejects invalid pairing text without echoing secrets", () => {
  assert.throws(
    () => parsePairingPayload("zmpair:v2:not-json-secret-token"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /二维码/u);
      assert.equal(error.message.includes("secret-token"), false);
      return true;
    }
  );
});

test("desktop ws protocol helper builds token transports and request frames", () => {
  assert.equal(
    normalizeDesktopWsUrlInput("desktop.example.test"),
    "wss://desktop.example.test/ws"
  );
  assert.equal(
    normalizeDesktopWsUrlInput("wss://desktop.example.test/custom?source=old&deviceId=old#debug"),
    "wss://desktop.example.test/ws"
  );
  assert.equal(
    applyDesktopTokenToUrl("ws://127.0.0.1:7082/ws?source=mobile&token=old", "query", "desktop-token"),
    "ws://127.0.0.1:7082/ws?token=desktop-token"
  );
  assert.deepEqual(
    buildDesktopTokenTransport("wss://desktop.example.test/ws?token=old", "subprotocol", "desktop-token"),
    {
      url: "wss://desktop.example.test/ws",
      tokenMode: "subprotocol",
      protocols: ["bearer.desktop-token"]
    }
  );
  for (const ns of ["d", "ap", "wa"]) {
    const type = ns === "d" ? "session.hello" : "/api/chats";
    assert.deepEqual(buildDesktopBusinessFrame(ns, type, undefined, "req-1"), {
      ns,
      frame: "request",
      type,
      id: "req-1",
      payload: {}
    });
  }
});
