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
  stopDesktopRemoteWsServer
} = require("../dist-electron/main/desktop-ws-server.js");
const {
  readTunnelHubAgentSettings,
  saveTunnelHubAgentSettings
} = require("../dist-electron/main/tunnel-hub-agent-settings.js");

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
    deriveTunnelHubRegistrationApiOrigin("wss://relay.example.test/tunnel"),
    "https://relay.example.test"
  );
  assert.equal(
    deriveTunnelHubRegistrationApiOrigin("ws://127.0.0.1:9090/tunnel?x=1"),
    "http://127.0.0.1:9090"
  );
});

test("Tunnel Hub remote WS registration posts 7083 target and stores Relay response", async (t) => {
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
        publicHost: "mac-mini-office.tunnel-hub.zenmind.cc",
        publicUrl: "https://mac-mini-office.tunnel-hub.zenmind.cc",
        webSocketUrl: "wss://mac-mini-office.tunnel-hub.zenmind.cc/ws",
        relayUrl: `ws://127.0.0.1:${relay.address().port}/tunnel`,
        targetUrl: "http://127.0.0.1:7083",
        agentToken: "returned-agent-token"
      }));
    });
  });
  const relayAddress = await listen(relay);
  t.after(async () => {
    configureTunnelHubRemoteWsController({
      desktopWsServerOptions: {
        app,
        desktopActionOptions: {},
        assistantBridge: {
          listAgents: async () => [],
          startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
        },
        getTaskBoardRuntime: () => null,
        logger: { log() {}, warn() {}, error() {} }
      }
    });
    await stopDesktopRemoteWsServer();
    await closeServer(relay);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const relayUrl = `ws://127.0.0.1:${relayAddress.port}/tunnel`;
  const saved = saveTunnelHubAgentSettings(app, {
    enabled: true,
    relayUrl,
    deviceId: "mac-mini-office",
    registrationToken: "registration-secret"
  });
  assert.equal(saved.ok, true);

  configureTunnelHubRemoteWsController({
    desktopWsServerOptions: {
      app,
      desktopActionOptions: {},
      assistantBridge: {
        listAgents: async () => [],
        startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
      },
      getTaskBoardRuntime: () => null,
      verifyToken: async () => ({
        subject: "app",
        deviceId: "device-1",
        expiresAt: Date.now() + 600_000,
        scope: "app"
      }),
      logger: { log() {}, warn() {}, error() {} }
    },
    startRemoteWsServer: async () => ({
      running: true,
      host: "127.0.0.1",
      port: 7083,
      path: "/ws",
      url: "ws://127.0.0.1:7083/ws",
      webSocketUrl: "ws://127.0.0.1:7083/ws"
    }),
    getRemoteWsServerRuntimeState: () => ({
      running: true,
      host: "127.0.0.1",
      port: 7083,
      path: "/ws",
      url: "ws://127.0.0.1:7083/ws"
    }),
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await ensureTunnelHubRemoteWsReady(app);
  assert.equal(result.ok, true);
  assert.equal(result.registered, true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].method, "POST");
  assert.equal(registrations[0].url, "/api/desktop/devices/register");
  assert.equal(registrations[0].authorization, "Bearer registration-secret");
  assert.equal(registrations[0].body.deviceId, "mac-mini-office");
  assert.equal(typeof registrations[0].body.deviceName, "string");
  assert.equal("deviceSecret" in registrations[0].body, false);
  assert.equal(registrations[0].body.targetUrl, "http://127.0.0.1:7083");
  assert.notEqual(registrations[0].body.targetUrl, "http://127.0.0.1:7082");

  const settings = readTunnelHubAgentSettings(app);
  assert.equal(settings.webSocketUrl, "wss://mac-mini-office.tunnel-hub.zenmind.cc/ws");
  assert.equal(settings.targetUrl, "http://127.0.0.1:7083");
  assert.equal(settings.hasAgentToken, true);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "secrets", "tunnel-hub-agent-token")), true);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "config", "services", "tunnel-hub-agent", ".env")), false);
});

test("Tunnel Hub remote WS registration uses SSO site token before legacy registration token", async (t) => {
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
        targetUrl: "http://127.0.0.1:7083",
        agentToken: "returned-agent-token"
      }));
    });
  });
  const relayAddress = await listen(relay);
  t.after(async () => {
    configureTunnelHubRemoteWsController({
      desktopWsServerOptions: {
        app,
        desktopActionOptions: {},
        assistantBridge: {
          listAgents: async () => [],
          startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
        },
        getTaskBoardRuntime: () => null,
        logger: { log() {}, warn() {}, error() {} }
      }
    });
    await stopDesktopRemoteWsServer();
    await closeServer(relay);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const relayUrl = `ws://127.0.0.1:${relayAddress.port}/tunnel`;
  const saved = saveTunnelHubAgentSettings(app, {
    enabled: true,
    relayUrl,
    deviceId: "mac-mini-office",
    registrationToken: "legacy-registration-secret"
  });
  assert.equal(saved.ok, true);
  const secretsRoot = path.join(desktopRoot(homePath), "secrets");
  fs.mkdirSync(secretsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(secretsRoot, "sso-site-token.json"),
    JSON.stringify({ accessToken: "official-site-jwt" }),
    "utf8"
  );

  configureTunnelHubRemoteWsController({
    desktopWsServerOptions: {
      app,
      desktopActionOptions: {},
      assistantBridge: {
        listAgents: async () => [],
        startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
      },
      getTaskBoardRuntime: () => null,
      logger: { log() {}, warn() {}, error() {} }
    },
    startRemoteWsServer: async () => ({
      running: true,
      host: "127.0.0.1",
      port: 7083,
      path: "/ws",
      url: "ws://127.0.0.1:7083/ws",
      webSocketUrl: "ws://127.0.0.1:7083/ws"
    }),
    getRemoteWsServerRuntimeState: () => ({
      running: true,
      host: "127.0.0.1",
      port: 7083,
      path: "/ws",
      url: "ws://127.0.0.1:7083/ws"
    }),
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await ensureTunnelHubRemoteWsReady(app);
  assert.equal(result.ok, true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].authorization, "Bearer official-site-jwt");
  assert.equal(registrations[0].body.deviceId, "mac-mini-office");
});
