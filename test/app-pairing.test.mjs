import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { createAppPairingPayload } = require("../dist-electron/main/app-pairing.js");
const {
  DESKTOP_WS_HOST,
  DESKTOP_WS_LAN_BIND_HOST,
  DESKTOP_WS_PATH,
  DESKTOP_WS_PORT
} = require("../dist-electron/shared/desktop-ws.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "app-data");
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

function runtimeState(running, overrides = {}) {
  return {
    running,
    host: DESKTOP_WS_HOST,
    port: DESKTOP_WS_PORT,
    path: DESKTOP_WS_PATH,
    url: `ws://${DESKTOP_WS_HOST}:${DESKTOP_WS_PORT}${DESKTOP_WS_PATH}`,
    ...overrides
  };
}

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

function decodePairingPayloadText(payloadText) {
  assert.match(payloadText, /^zmpair:v2:/u);
  return JSON.parse(Buffer.from(payloadText.slice("zmpair:v2:".length), "base64url").toString("utf8"));
}

test("createAppPairingPayload returns compact desktop ws v2 payload", async () => {
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const token = createToken({ exp, device_id: "desktop-device-explicit" });
  const originalFetch = globalThis.fetch;
  let tokenIssues = 0;
  let serverStarts = 0;
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
      { targetMode: "local" },
      {
        getDesktopWsServerRuntimeState: () => runtimeState(true, { port: 7199 }),
        startDesktopWsServer: async () => {
          serverStarts += 1;
          return runtimeState(true);
        },
        issueAccessToken: async () => {
          tokenIssues += 1;
          return { ok: true, token, message: "issued" };
        }
      }
    );

    assert.equal(result.ok, true);
    assert.equal(serverStarts, 0);
    assert.equal(tokenIssues, 1);
    assert.equal(legacyPairingStartCalls, 0);
    assert.equal(result.payload.kind, "desktop-ws");
    assert.equal(result.payload.targetMode, "local");
    assert.equal(result.payload.wsUrl, "ws://127.0.0.1:7199/ws");
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

test("createAppPairingPayload upgrades loopback server to LAN binding for LAN target", async (t) => {
  const originalNetworkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({
    en0: [{ family: "IPv4", internal: false, address: "192.168.8.25" }],
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }]
  });
  t.after(() => {
    os.networkInterfaces = originalNetworkInterfaces;
  });

  const token = createToken();
  const startOptions = [];
  const result = await createAppPairingPayload(
    {},
    { targetMode: "lan" },
    {
      getDesktopWsServerRuntimeState: () => runtimeState(true, { host: DESKTOP_WS_HOST, port: 7199 }),
      startDesktopWsServer: async (options) => {
        startOptions.push(options);
        return runtimeState(true, { host: DESKTOP_WS_LAN_BIND_HOST, port: 7199 });
      },
      issueAccessToken: async () => ({ ok: true, token, message: "issued" })
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(startOptions, [{ host: DESKTOP_WS_LAN_BIND_HOST }]);
  assert.equal(result.payload.targetMode, "lan");
  assert.equal(result.payload.wsUrl, "ws://192.168.8.25:7199/ws");
});

test("createAppPairingPayload delegates LAN binding reuse to desktop ws server", async (t) => {
  const originalNetworkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({
    en0: [{ family: "IPv4", internal: false, address: "10.0.0.8" }]
  });
  t.after(() => {
    os.networkInterfaces = originalNetworkInterfaces;
  });

  const token = createToken();
  const startOptions = [];
  const result = await createAppPairingPayload(
    {},
    { targetMode: "lan" },
    {
      getDesktopWsServerRuntimeState: () => runtimeState(true, { host: DESKTOP_WS_LAN_BIND_HOST, port: 7199 }),
      startDesktopWsServer: async (options) => {
        startOptions.push(options);
        return runtimeState(true, { host: DESKTOP_WS_LAN_BIND_HOST, port: 7199 });
      },
      issueAccessToken: async () => ({ ok: true, token, message: "issued" })
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(startOptions, [{ host: DESKTOP_WS_LAN_BIND_HOST }]);
  assert.equal(result.payload.wsUrl, "ws://10.0.0.8:7199/ws");
});

test("createAppPairingPayload guards unavailable LAN before starting server or issuing token", async (t) => {
  const originalNetworkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }]
  });
  t.after(() => {
    os.networkInterfaces = originalNetworkInterfaces;
  });

  let tokenIssues = 0;
  let serverStarts = 0;
  const result = await createAppPairingPayload(
    {},
    { targetMode: "lan" },
    {
      getDesktopWsServerRuntimeState: () => runtimeState(false),
      startDesktopWsServer: async () => {
        serverStarts += 1;
        return runtimeState(true);
      },
      issueAccessToken: async () => {
        tokenIssues += 1;
        return { ok: true, token: createToken(), message: "issued" };
      }
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /No private LAN IPv4 address is available|当前没有可用的局域网私有 IPv4 地址/u);
  assert.equal(serverStarts, 0);
  assert.equal(tokenIssues, 0);
});

test("createAppPairingPayload guards unavailable tunnel before starting server or issuing token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-app-pairing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let tokenIssues = 0;
  let serverStarts = 0;
  const result = await createAppPairingPayload(
    createApp(path.join(root, "home")),
    { targetMode: "tunnel" },
    {
      getDesktopWsServerRuntimeState: () => runtimeState(false),
      startDesktopWsServer: async () => {
        serverStarts += 1;
        return runtimeState(true);
      },
      issueAccessToken: async () => {
        tokenIssues += 1;
        return { ok: true, token: createToken(), message: "issued" };
      }
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /Tunnel WS address is not available yet|隧道 WS 地址尚不可用/u);
  assert.equal(serverStarts, 0);
  assert.equal(tokenIssues, 0);
});
