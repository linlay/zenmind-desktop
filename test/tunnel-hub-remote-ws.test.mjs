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
  configureTunnelHubRemoteWsController,
  deriveTunnelHubRegistrationApiOrigin,
  ensureTunnelHubRemoteWsReady
} = require("../dist-electron/main/tunnel-hub-remote-ws.js");
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-remote-ws-"));
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

  configureTunnelHubRemoteWsController({
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await ensureTunnelHubRemoteWsReady(app);
  assert.equal(result.ok, true);
  assert.equal(result.registered, true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].method, "POST");
  assert.equal(registrations[0].url, "/api/desktop/devices/register");
  assert.equal(registrations[0].authorization, "Bearer site-registration-secret");
  assert.equal(registrations[0].body.deviceId, "mac-mini-office");
  assert.equal(registrations[0].body.deviceName, "Tunnel Studio");
  assert.equal("deviceSecret" in registrations[0].body, false);
  assert.equal("targetUrl" in registrations[0].body, false);

  const settings = readTunnelHubSettings(app);
  assert.equal(settings.webSocketUrl, "wss://mac-mini-office.relay.example.test/ws");
  assert.equal(settings.targetUrl, "");
  assert.equal(settings.hasRelayToken, true);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "secrets", "tunnel-hub-token")), true);
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

  configureTunnelHubRemoteWsController({
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await ensureTunnelHubRemoteWsReady(app);
  assert.equal(result.ok, true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].authorization, "Bearer official-site-jwt");
  assert.equal(registrations[0].body.deviceId, "mac-mini-office");
});
