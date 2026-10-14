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
} = require("../dist-electron/main/modules/tunnel/registration.js");
const {
  readTunnelHubSettings,
  saveTunnelHubSettings
} = require("../dist-electron/main/modules/tunnel/settings.js");

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

function writeDesktopSsoAccessToken(homePath, token = "canonical-desktop-jwt") {
  const stateRoot = path.join(desktopRoot(homePath), "state", "desktop");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "sso-access-token.txt"), `${token}\n`, "utf8");
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

test("Tunnel Hub registration reuses the canonical Desktop SSO token", async (t) => {
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
        accountId: "account", deviceId: "mac-mini-office",
        publicHost: "mac-mini-office.relay.example.test",
        publicUrl: "https://mac-mini-office.relay.example.test",
        webSocketUrl: "wss://mac-mini-office.relay.example.test/ws",
        relayUrl: `ws://127.0.0.1:${relay.address().port}/tunnel`
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
  writeDesktopSsoAccessToken(homePath, "canonical-registration-secret");
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
  assert.equal(result.identityToken, "canonical-registration-secret");
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].method, "POST");
  assert.equal(registrations[0].url, "/api/desktop/devices/register");
  assert.equal(registrations[0].authorization, "Bearer canonical-registration-secret");
  assert.equal(registrations[0].body.deviceId, "mac-mini-office");
  assert.equal(registrations[0].body.deviceName, "Tunnel Studio");
  assert.equal("deviceSecret" in registrations[0].body, false);

  const settings = readTunnelHubSettings(app);
  assert.equal(settings.webSocketUrl, "wss://mac-mini-office.relay.example.test/ws");
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "secrets", "tunnel-hub-token")), false);
});

test("Tunnel Hub registration refreshes the Desktop JWT once after a 401", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-refresh-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeDesktopSsoAccessToken(homePath, "stale-desktop-jwt");
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
          accountId: "account", deviceId: "mac-mini-office",
          relayUrl: "wss://relay.example.test/tunnel"
        })
      };
    },
    refreshIdentityToken: async () => {
      refreshCalls += 1;
      writeDesktopSsoAccessToken(homePath, "fresh-desktop-jwt");
      return "fresh-desktop-jwt";
    },
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await ensureTunnelHubRegistrationReady(app);
  assert.equal(result.registered, true);
  assert.equal(result.identityToken, "fresh-desktop-jwt");
  assert.equal(refreshCalls, 1);
  assert.deepEqual(authorizations, [
    "Bearer stale-desktop-jwt",
    "Bearer fresh-desktop-jwt"
  ]);
});

test("Tunnel Hub registration ignores legacy registration token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-canonical-token-"));
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
        accountId: "account", deviceId: "mac-mini-office",
        publicHost: "zm1234567890.m.zenmind.cc",
        publicUrl: "https://zm1234567890.m.zenmind.cc",
        webSocketUrl: "wss://zm1234567890.m.zenmind.cc/ws",
        relayUrl: `ws://127.0.0.1:${relay.address().port}/tunnel`
      }));
    });
  });
  const relayAddress = await listen(relay);
  t.after(async () => {
    await closeServer(relay);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const relayUrl = `ws://127.0.0.1:${relayAddress.port}/tunnel`;
  writeDesktopSsoAccessToken(homePath);
  const saved = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl,
    deviceId: "mac-mini-office"
  });
  assert.equal(saved.ok, true);
  const secretsRoot = path.join(desktopRoot(homePath), "secrets");
  fs.mkdirSync(secretsRoot, { recursive: true });
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
  assert.equal(registrations[0].authorization, "Bearer canonical-desktop-jwt");
  assert.equal(registrations[0].body.deviceId, "mac-mini-office");
});

test("Tunnel Hub registration reports an unavailable Desktop API without exposing nginx HTML", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-api-unavailable-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeDesktopSsoAccessToken(homePath);
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

test("account logout skips unregistered Desktop and releases UUID for the next login", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-registration-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const homePath = path.join(root, "home"); const app = createApp(homePath);
  const {revokeTunnelAccountDevice} = require("../dist-electron/main/modules/tunnel/registration.js");
  const {hasTunnelHubAccountRegistration} = require("../dist-electron/main/modules/tunnel/settings.js");
  writeDesktopSsoAccessToken(homePath);
  saveTunnelHubSettings(app, { enabled: true, relayUrl: "wss://relay.example.test/tunnel", deviceId: "unregistered-device" });
  const calls = [];
  configureTunnelHubRegistrationController({ fetch: async (url, init) => {
    calls.push({url, body: JSON.parse(init.body)});
    return {ok: true, status: url.endsWith("/register") ? 200 : 204, statusText: "OK", text: async () => JSON.stringify(url.endsWith("/register") ? {accountId: "account", deviceId: JSON.parse(init.body).deviceId, publicHost: "device.example.test"} : {})};
  } });
  await revokeTunnelAccountDevice(app); assert.equal(calls.length, 0);
  await ensureTunnelHubRegistrationReady(app); assert.equal(hasTunnelHubAccountRegistration(app), true);
  const target = readTunnelHubSettings(app).deviceId;
  saveTunnelHubSettings(app, {enabled: false}); assert.equal(hasTunnelHubAccountRegistration(app), true);
  await revokeTunnelAccountDevice(app);
  assert.equal(calls[1].body.targetDesktopId, target);
  assert.equal(hasTunnelHubAccountRegistration(app), false);
  assert.notEqual(readTunnelHubSettings(app).deviceId, target);
  assert.equal(readTunnelHubSettings(app).publicHost, "");
  assert.equal(readTunnelHubSettings(app).enabled, false);
  saveTunnelHubSettings(app, {enabled: true}); writeDesktopSsoAccessToken(homePath, "next-login");
  await ensureTunnelHubRegistrationReady(app);
  assert.notEqual(calls[2].body.deviceId, target);
});

test("late account registration cannot overwrite a changed canonical session", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "late-account-registration-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const homePath = path.join(root, "home"); const app = createApp(homePath);
  writeDesktopSsoAccessToken(homePath, "old-login");
  saveTunnelHubSettings(app, {enabled: true, relayUrl: "wss://relay.example.test/tunnel", deviceId: "initial-device"});
  let finish;
  configureTunnelHubRegistrationController({fetch: () => new Promise(resolve => {finish = resolve;})});
  const pending = ensureTunnelHubRegistrationReady(app);
  writeDesktopSsoAccessToken(homePath, "new-login");
  finish({ok: true, status: 200, text: async () => JSON.stringify({accountId: "old-account", deviceId: "old-account-device"})});
  await assert.rejects(pending, /superseded/);
  assert.equal(readTunnelHubSettings(app).deviceId, "initial-device");
});
