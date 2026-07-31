import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

const {
  configureTunnelHubRegistrationController,
  deriveTunnelHubRegistrationApiOrigin,
  ensureTunnelHubRegistrationReady
} = require("../dist-electron/main/tunnel-hub-registration.js");
const {
  readTunnelHubSettings,
  saveTunnelHubSettings
} = require("../dist-electron/main/tunnel-hub-settings.js");

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
    },
    getAppPath() {
      return process.cwd();
    },
    getVersion() {
      return "0.0.0-test";
    }
  };
}

function desktopRoot(homePath) {
  return path.join(homePath, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir);
}

function writeSsoSiteToken(homePath, token = "official-site-jwt") {
  const secretsRoot = path.join(desktopRoot(homePath), "secrets");
  fs.mkdirSync(secretsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(secretsRoot, "sso-site-token.json"),
    JSON.stringify({ accessToken: token }),
    "utf8"
  );
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("deriveTunnelHubRegistrationApiOrigin maps relay websocket URLs to HTTP API origins", () => {
  assert.equal(
    deriveTunnelHubRegistrationApiOrigin("tunnel-hub.zenmind.cc"),
    "https://tunnel-hub.zenmind.cc"
  );
  assert.equal(
    deriveTunnelHubRegistrationApiOrigin("https://tunnel-hub.zenmind.cc"),
    "https://tunnel-hub.zenmind.cc"
  );
  assert.equal(
    deriveTunnelHubRegistrationApiOrigin("wss://relay.example.test/tunnel"),
    "https://relay.example.test"
  );
  assert.equal(
    deriveTunnelHubRegistrationApiOrigin("ws://127.0.0.1:9090/tunnel?x=1"),
    "http://127.0.0.1:9090"
  );
});

test("Tunnel Hub registration uses SSO site token and stores agent token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-registration-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const registrations = [];
  const relay = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      registrations.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        deviceId: "mac-mini-office",
        publicHost: "mac-mini-office.relay.example.test",
        publicUrl: "https://mac-mini-office.relay.example.test",
        webSocketUrl: "wss://mac-mini-office.relay.example.test/ws",
        relayUrl: `ws://127.0.0.1:${relay.address().port}/tunnel`,
        agentToken: "returned-relay-token"
      }));
    });
  });
  const relayAddress = await listen(relay);
  t.after(async () => {
    await closeServer(relay);
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(desktopRoot(homePath), "config", "desktop"), { recursive: true });
  fs.writeFileSync(
    path.join(desktopRoot(homePath), "config", "desktop", "profile.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      general: {
        deviceName: "Tunnel Studio",
        preventSleepWhileRunning: true,
        desktopWsServerEnabled: false
      }
    }, null, 2)}\n`,
    "utf8"
  );

  const relayUrl = `ws://127.0.0.1:${relayAddress.port}/tunnel`;
  writeSsoSiteToken(homePath, "site-registration-secret");
  const saved = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl,
    deviceId: "mac-mini-office"
  });
  assert.equal(saved.ok, true);

  configureTunnelHubRegistrationController({
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await ensureTunnelHubRegistrationReady(app);
  assert.equal(result.ok, true);
  assert.equal(result.registered, true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].method, "POST");
  assert.equal(registrations[0].url, "/api/desktop/devices/register");
  assert.equal(registrations[0].authorization, "Bearer site-registration-secret");
  assert.equal(registrations[0].body.deviceId, "mac-mini-office");
  assert.equal(registrations[0].body.deviceName, "Tunnel Studio");
  assert.equal("deviceSecret" in registrations[0].body, false);

  const settings = readTunnelHubSettings(app);
  assert.equal(settings.webSocketUrl, "wss://mac-mini-office.relay.example.test/ws");
  assert.equal(settings.hasRelayToken, true);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "secrets", "tunnel-hub-token")), true);
});

test("Tunnel Hub registration refreshes the Desktop JWT once after a 401", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-refresh-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSsoSiteToken(homePath, "stale-desktop-jwt");
  const saved = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office"
  });
  assert.equal(saved.ok, true);

  const authorizations = [];
  let refreshCalls = 0;
  configureTunnelHubRegistrationController({
    fetch: async (_url, init) => {
      authorizations.push(init.headers.Authorization);
      if (init.headers.Authorization === "Bearer stale-desktop-jwt") {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: async () => "unauthorized"
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          deviceId: "mac-mini-office",
          relayUrl: "wss://relay.example.test/tunnel",
          relayToken: "relay-token"
        })
      };
    },
    refreshIdentityToken: async () => {
      refreshCalls += 1;
      return "fresh-desktop-jwt";
    },
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await ensureTunnelHubRegistrationReady(app);
  assert.equal(result.registered, true);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(authorizations, [
    "Bearer stale-desktop-jwt",
    "Bearer fresh-desktop-jwt"
  ]);
});

test("Tunnel Hub registration ignores legacy registration token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-site-token-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const registrations = [];
  const relay = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      registrations.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        deviceId: "mac-mini-office",
        publicHost: "zm1234567890.m.zenmind.cc",
        publicUrl: "https://zm1234567890.m.zenmind.cc",
        webSocketUrl: "wss://zm1234567890.m.zenmind.cc/ws",
        relayUrl: `ws://127.0.0.1:${relay.address().port}/tunnel`,
        agentToken: "returned-relay-token"
      }));
    });
  });
  const relayAddress = await listen(relay);
  t.after(async () => {
    await closeServer(relay);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const relayUrl = `ws://127.0.0.1:${relayAddress.port}/tunnel`;
  writeSsoSiteToken(homePath);
  const saved = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl,
    deviceId: "mac-mini-office"
  });
  assert.equal(saved.ok, true);
  const secretsRoot = path.join(desktopRoot(homePath), "secrets");
  fs.writeFileSync(
    path.join(secretsRoot, "tunnel-hub-registration-token"),
    "legacy-registration-secret\n",
    "utf8"
  );

  configureTunnelHubRegistrationController({
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await ensureTunnelHubRegistrationReady(app);
  assert.equal(result.ok, true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].authorization, "Bearer official-site-jwt");
  assert.equal(registrations[0].body.deviceId, "mac-mini-office");
});

test("Tunnel Hub registration reports an unavailable Desktop API without exposing nginx HTML", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-api-unavailable-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSsoSiteToken(homePath);
  const saved = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office"
  });
  assert.equal(saved.ok, true);
  configureTunnelHubRegistrationController({
    fetch: async () => ({
      ok: false,
      status: 405,
      statusText: "Not Allowed",
      text: async () => "<html><h1>405 Not Allowed</h1></html>"
    }),
    logger: { log() {}, warn() {}, error() {} }
  });

  await assert.rejects(
    ensureTunnelHubRegistrationReady(app),
    (error) => {
      assert.match(error.message, /Desktop 注册接口|Desktop registration API/u);
      assert.doesNotMatch(error.message, /<html>/u);
      return true;
    }
  );
});

test("Tunnel Hub registration preserves endpoint and network cause in fetch failures", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-network-error-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSsoSiteToken(homePath);
  const saved = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "ws://127.0.0.1:11961/tunnel",
    deviceId: "mac-mini-office"
  });
  assert.equal(saved.ok, true);
  configureTunnelHubRegistrationController({
    fetch: async () => {
      const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11961"), {
        code: "ECONNREFUSED",
        address: "127.0.0.1",
        port: 11961
      });
      throw new Error("fetch failed", { cause });
    },
    logger: { log() {}, warn() {}, error() {} }
  });

  await assert.rejects(
    ensureTunnelHubRegistrationReady(app),
    (error) => {
      assert.match(error.message, /registration request could not reach http:\/\/127\.0\.0\.1:11961/u);
      assert.match(error.message, /fetch failed/u);
      assert.match(error.message, /ECONNREFUSED/u);
      return true;
    }
  );
});
