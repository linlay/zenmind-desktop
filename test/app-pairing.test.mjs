import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { createAppPairingPayload } = require("../dist-electron/main/app-pairing.js");

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function createToken(payload = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return [
    encodeJwtPart({ alg: "RS256", typ: "JWT" }),
    encodeJwtPart({
      sub: "desktop-agent",
      scope: "app",
      device_id: "desktop-device-1",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      ...payload
    }),
    "signature"
  ].join(".");
}

function connectedTunnelStatus(overrides = {}) {
  return {
    enabled: true,
    running: true,
    connected: true,
    phase: "connected",
    deviceId: "desktop-device-1",
    relayUrl: "wss://relay.example.test/tunnel",
    publicHost: "desktop.example.test",
    publicUrl: "https://desktop.example.test",
    webSocketUrl: "wss://desktop.example.test/ws",
    reconnectSeconds: 3,
    ...overrides
  };
}

function decodePairingPayloadText(payloadText) {
  assert.match(payloadText, /^zmpair:v2:/u);
  return JSON.parse(Buffer.from(payloadText.slice("zmpair:v2:".length), "base64url").toString("utf8"));
}

test("createAppPairingPayload returns compact tunnel desktop ws v2 payload", async () => {
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const token = createToken({ exp, device_id: "desktop-device-explicit" });
  const originalFetch = globalThis.fetch;
  let tokenIssues = 0;
  let legacyPairingStartCalls = 0;

  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/auth/pairing/start")) {
      legacyPairingStartCalls += 1;
    }
    throw new Error("createAppPairingPayload should not call fetch");
  };

  try {
    const result = await createAppPairingPayload(
      {},
      {
        getTunnelHubRuntimeStatus: () => connectedTunnelStatus({
          webSocketUrl: "wss://desktop.example.test/debug?token=old#debug"
        }),
        issueAccessToken: async () => {
          tokenIssues += 1;
          return { ok: true, token, message: "issued" };
        }
      }
    );

    assert.equal(result.ok, true);
    assert.equal(tokenIssues, 1);
    assert.equal(legacyPairingStartCalls, 0);
    assert.equal(result.payload.kind, "desktop-ws");
    assert.equal(result.payload.targetMode, "tunnel");
    assert.equal(result.payload.wsUrl, "wss://desktop.example.test/ws");
    assert.equal(result.payload.tokenMode, "query");
    assert.equal(result.payload.token, token);
    assert.equal(result.payload.desktopDeviceId, "desktop-device-explicit");
    assert.equal(result.payload.expiresAtMs, exp * 1000);
    assert.equal(result.display.wsUrl, result.payload.wsUrl);

    const decoded = decodePairingPayloadText(result.payloadText);
    assert.deepEqual(decoded, result.payload);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createAppPairingPayload requires connected Tunnel runtime before issuing token", async () => {
  let tokenIssues = 0;
  const result = await createAppPairingPayload(
    {},
    {
      getTunnelHubRuntimeStatus: () => connectedTunnelStatus({
        connected: false,
        phase: "reconnecting"
      }),
      issueAccessToken: async () => {
        tokenIssues += 1;
        return { ok: true, token: createToken(), message: "issued" };
      }
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /Tunnel is not connected yet|隧道尚未连接/u);
  assert.equal(tokenIssues, 0);
});

test("createAppPairingPayload rejects connected Tunnel runtime without WS address before issuing token", async () => {
  let tokenIssues = 0;
  const result = await createAppPairingPayload(
    {},
    {
      getTunnelHubRuntimeStatus: () => connectedTunnelStatus({ webSocketUrl: "" }),
      issueAccessToken: async () => {
        tokenIssues += 1;
        return { ok: true, token: createToken(), message: "issued" };
      }
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /Tunnel WS address is not available yet|隧道 WS 地址尚不可用/u);
  assert.equal(tokenIssues, 0);
});
