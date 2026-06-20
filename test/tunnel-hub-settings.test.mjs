import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { APP_BRAND } = await import("../dist-electron/shared/brand.js");
const {
  recordTunnelHubRegistrationResult,
  readTunnelHubSettings,
  saveTunnelHubSettings
} = await import("../dist-electron/main/tunnel-hub-settings.js");

function createTempApp(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-hub-settings-"));
  const homeRoot = path.join(tempRoot, "home");
  const app = {
    getPath(name) {
      if (name === "home") {
        return homeRoot;
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return app;
}

function desktopRoot(app) {
  return path.join(app.getPath("home"), APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir);
}

function tunnelSettingsPath(app) {
  return path.join(desktopRoot(app), "config", "desktop", "tunnel-hub.json");
}

function tunnelTokenPath(app) {
  return path.join(desktopRoot(app), "secrets", "tunnel-hub-token");
}

function tunnelRegistrationTokenPath(app) {
  return path.join(desktopRoot(app), "secrets", "tunnel-hub-registration-token");
}

test("Tunnel Hub settings persist enabled when relay URL and token are configured", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/ws",
    relayToken: "relay-secret",
    tlsInsecureSkipVerify: true,
    reconnectSeconds: 9
  });

  assert.equal(result.ok, true);
  assert.equal(result.settings.enabled, true);
  assert.equal(result.settings.relayUrl, "wss://relay.example.test/ws");
  assert.match(result.settings.deviceId, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
  assert.equal(result.settings.hasRelayToken, true);
  assert.equal(result.settings.relayTokenPreview, "****cret");
  assert.equal(result.settings.tlsInsecureSkipVerify, true);
  assert.equal(result.settings.reconnectSeconds, 9);
  assert.equal(readTunnelHubSettings(app).enabled, true);
});

test("Tunnel Hub settings keep relay URL empty until explicitly configured", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubSettings(app, {
    enabled: false,
    relayToken: "relay-secret"
  });

  assert.equal(result.ok, true);
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.relayUrl, "");
  const stored = JSON.parse(fs.readFileSync(tunnelSettingsPath(app), "utf8"));
  assert.equal(stored.relayUrl, "");
});

test("Tunnel Hub enable requires an explicit relay URL", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayToken: "relay-secret"
  });

  assert.equal(result.ok, false);
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.relayUrl, "");
  assert.match(result.message, /Relay URL/u);
});

test("Tunnel Hub settings persist device ID and mask registration token", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    registrationToken: "desktop-registration-secret",
    tlsInsecureSkipVerify: false,
    reconnectSeconds: 5
  });

  assert.equal(result.ok, true);
  assert.equal(result.settings.enabled, true);
  assert.equal(result.settings.deviceId, "mac-mini-office");
  assert.equal(result.settings.hasRegistrationToken, true);
  assert.equal(result.settings.registrationTokenPreview, "****cret");
  assert.equal(result.settings.hasRelayToken, false);
  assert.equal(fs.readFileSync(tunnelRegistrationTokenPath(app), "utf8").trim(), "desktop-registration-secret");
  const stored = JSON.parse(fs.readFileSync(tunnelSettingsPath(app), "utf8"));
  assert.equal(stored.deviceId, "mac-mini-office");
  assert.equal("registrationToken" in stored, false);
  assert.equal("deviceSecret" in stored, false);
});

test("Tunnel Hub settings validate DNS-label device IDs", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "Bad_Device",
    registrationToken: "desktop-registration-secret"
  });

  assert.equal(result.ok, false);
  assert.equal(result.settings.enabled, false);
  assert.match(result.message, /Device ID/u);
});

test("Tunnel Hub registration result stores returned relay token", (t) => {
  const app = createTempApp(t);
  const saved = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    registrationToken: "desktop-registration-secret"
  });
  assert.equal(saved.ok, true);

  const settings = recordTunnelHubRegistrationResult(app, {
    deviceId: "mac-mini-office",
    relayUrl: "wss://relay.example.test/tunnel",
    publicHost: "mac-mini-office.relay.example.test",
    publicUrl: "https://mac-mini-office.relay.example.test",
    webSocketUrl: "wss://mac-mini-office.relay.example.test/ws",
    targetUrl: "http://127.0.0.1:7083",
    relayToken: "returned-relay-token"
  });

  assert.equal(settings.webSocketUrl, "wss://mac-mini-office.relay.example.test/ws");
  assert.equal(settings.targetUrl, "http://127.0.0.1:7083");
  assert.equal(settings.hasRelayToken, true);
  assert.equal(fs.readFileSync(tunnelTokenPath(app), "utf8").trim(), "returned-relay-token");
});

test("Tunnel Hub enable saves drafts but falls back to disabled when config is incomplete", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "https://relay.example.test/tunnel",
    relayToken: "relay-secret"
  });

  assert.equal(result.ok, false);
  assert.equal(result.settings.enabled, false);
  assert.match(result.message, /Relay URL/u);
  const stored = JSON.parse(fs.readFileSync(tunnelSettingsPath(app), "utf8"));
  assert.equal(stored.enabled, false);
  assert.equal(stored.relayUrl, "https://relay.example.test/tunnel");
  assert.equal(fs.readFileSync(tunnelTokenPath(app), "utf8").trim(), "relay-secret");
});

test("Tunnel Hub legacy settings without enabled are treated as enabled only when complete", (t) => {
  const app = createTempApp(t);
  fs.mkdirSync(path.dirname(tunnelSettingsPath(app)), { recursive: true });
  fs.mkdirSync(path.dirname(tunnelTokenPath(app)), { recursive: true });
  fs.writeFileSync(tunnelSettingsPath(app), `${JSON.stringify({
    relayUrl: "wss://legacy.example.test/ws",
    tlsInsecureSkipVerify: false,
    reconnectSeconds: 3
  }, null, 2)}\n`, "utf8");

  assert.equal(readTunnelHubSettings(app).enabled, false);

  fs.writeFileSync(tunnelTokenPath(app), "legacy-token\n", "utf8");
  assert.equal(readTunnelHubSettings(app).enabled, true);
});
