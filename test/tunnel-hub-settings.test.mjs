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
      if (name === "appData") {
        return path.join(tempRoot, "app-data");
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

function legacyTunnelTokenPath(app) {
  return path.join(desktopRoot(app), "secrets", "tunnel-hub-token");
}

function tunnelRegistrationTokenPath(app) {
  return path.join(desktopRoot(app), "secrets", "tunnel-hub-registration-token");
}

function tunnelDeviceSecretPath(app) {
  return path.join(desktopRoot(app), "secrets", "tunnel-hub-device-secret");
}

function writeDesktopSsoAccessToken(app, token = "desktop-sso-access-token") {
  const tokenPath = path.join(desktopRoot(app), "state", "desktop", "sso-access-token.txt");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
}

test("Tunnel Hub settings normalize host-only relay URL with the canonical SSO token", (t) => {
  const app = createTempApp(t);
  writeDesktopSsoAccessToken(app);

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "tunnel-hub.zenmind.cc",
    tlsInsecureSkipVerify: true,
    reconnectSeconds: 9
  });

  assert.equal(result.ok, true);
  assert.equal(result.settings.enabled, true);
  assert.equal(result.settings.relayUrl, "wss://tunnel-hub.zenmind.cc/tunnel");
  assert.match(result.settings.deviceId, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
  assert.equal(result.settings.tlsInsecureSkipVerify, false);
  assert.equal(result.settings.reconnectSeconds, 9);
  const stored = JSON.parse(fs.readFileSync(tunnelSettingsPath(app), "utf8"));
  assert.equal(stored.tlsInsecureSkipVerify, false);
  assert.equal(readTunnelHubSettings(app).enabled, true);
});

test("Tunnel Hub settings accept the canonical Desktop SSO access token", (t) => {
  const app = createTempApp(t);
  writeDesktopSsoAccessToken(app, "active-desktop-login-token");

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "tunnel-hub.zenmind.cc"
  });

  assert.equal(result.ok, true);
  assert.equal(result.settings.enabled, true);
});

test("Tunnel Hub settings normalize secure remote and canonical loopback relay URLs", (t) => {
  const cases = [
    ["https://tunnel-hub.zenmind.cc", "wss://tunnel-hub.zenmind.cc/tunnel"],
    ["wss://tunnel-hub.zenmind.cc", "wss://tunnel-hub.zenmind.cc/tunnel"],
    ["http://localhost:8080/tunnel", "ws://localhost:8080/tunnel"],
    ["http://127.0.0.1:8080/tunnel", "ws://127.0.0.1:8080/tunnel"],
    ["ws://127.0.0.1:8080/tunnel", "ws://127.0.0.1:8080/tunnel"],
    ["http://[::1]:8080/tunnel", "ws://[::1]:8080/tunnel"]
  ];

  for (const [input, expected] of cases) {
    const app = createTempApp(t);
    writeDesktopSsoAccessToken(app);
    const result = saveTunnelHubSettings(app, {
      enabled: true,
      relayUrl: input
    });
    assert.equal(result.ok, true);
    assert.equal(result.settings.relayUrl, expected);
  }
});

test("Tunnel Hub settings reject remote plaintext and non-canonical loopback relay URLs", (t) => {
  for (const relayUrl of [
    "http://relay.example.test/tunnel",
    "ws://relay.example.test/tunnel",
    "ws://127.0.0.2:8080/tunnel",
    "wss://127.0.0.2:8080/tunnel",
    "ws://demo.localhost:8080/tunnel",
    "wss://demo.localhost:8080/tunnel",
    "ws://0.0.0.0:8080/tunnel"
  ]) {
    const app = createTempApp(t);
    writeDesktopSsoAccessToken(app);

    const result = saveTunnelHubSettings(app, {
      enabled: true,
      relayUrl
    });

    assert.equal(result.ok, false, relayUrl);
    assert.equal(result.settings.enabled, false, relayUrl);
    assert.match(result.message, /Relay URL/u, relayUrl);
  }
});

test("Tunnel Hub settings keep relay URL empty until explicitly configured", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubSettings(app, {
    enabled: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.relayUrl, "");
  const stored = JSON.parse(fs.readFileSync(tunnelSettingsPath(app), "utf8"));
  assert.equal(stored.relayUrl, "");
});

test("Tunnel Hub enable requires an explicit relay URL", (t) => {
  const app = createTempApp(t);
  writeDesktopSsoAccessToken(app);

  const result = saveTunnelHubSettings(app, {
    enabled: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.relayUrl, "");
  assert.match(result.message, /Relay URL/u);
});

test("Tunnel Hub settings persist device ID and clear legacy tunnel credentials", (t) => {
  const app = createTempApp(t);
  writeDesktopSsoAccessToken(app);
  fs.mkdirSync(path.dirname(legacyTunnelTokenPath(app)), { recursive: true });
  for (const secretPath of [legacyTunnelTokenPath(app), tunnelRegistrationTokenPath(app), tunnelDeviceSecretPath(app)]) {
    fs.writeFileSync(secretPath, "legacy-secret\n", "utf8");
  }

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    tlsInsecureSkipVerify: false,
    reconnectSeconds: 5
  });

  assert.equal(result.ok, true);
  assert.equal(result.settings.enabled, true);
  assert.equal(result.settings.deviceId, "mac-mini-office");
  const stored = JSON.parse(fs.readFileSync(tunnelSettingsPath(app), "utf8"));
  assert.equal(stored.deviceId, "mac-mini-office");
  assert.equal("registrationToken" in stored, false);
  assert.equal("deviceSecret" in stored, false);
  assert.equal(fs.existsSync(legacyTunnelTokenPath(app)), false);
  assert.equal(fs.existsSync(tunnelRegistrationTokenPath(app)), false);
  assert.equal(fs.existsSync(tunnelDeviceSecretPath(app)), false);
});

test("Tunnel Hub settings validate DNS-label device IDs", (t) => {
  const app = createTempApp(t);
  writeDesktopSsoAccessToken(app);

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "Bad_Device"
  });

  assert.equal(result.ok, false);
  assert.equal(result.settings.enabled, false);
  assert.match(result.message, /Device ID/u);
});

test("Tunnel Hub registration result stores public routing metadata without tunnel credentials", (t) => {
  const app = createTempApp(t);
  writeDesktopSsoAccessToken(app);
  const saved = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office"
  });
  assert.equal(saved.ok, true);

  const settings = recordTunnelHubRegistrationResult(app, {
    deviceId: "mac-mini-office",
    relayUrl: "wss://relay.example.test/tunnel",
    publicHost: "mac-mini-office.relay.example.test",
    publicUrl: "https://mac-mini-office.relay.example.test",
    webSocketUrl: "wss://mac-mini-office.relay.example.test/ws"
  });

  assert.equal(settings.publicHost, "mac-mini-office.relay.example.test");
  assert.equal(settings.publicUrl, "https://mac-mini-office.relay.example.test");
  assert.equal(settings.webSocketUrl, "wss://mac-mini-office.relay.example.test/ws");
  assert.equal(fs.existsSync(legacyTunnelTokenPath(app)), false);
  const stored = JSON.parse(fs.readFileSync(tunnelSettingsPath(app), "utf8"));
  assert.equal(stored.publicHost, "mac-mini-office.relay.example.test");
  assert.equal("publicUrl" in stored, false);
  assert.equal("webSocketUrl" in stored, false);
});

test("Tunnel Hub settings derive public URLs from host and recover legacy URL-only settings", (t) => {
  const app = createTempApp(t);
  fs.mkdirSync(path.dirname(tunnelSettingsPath(app)), { recursive: true });
  fs.writeFileSync(tunnelSettingsPath(app), `${JSON.stringify({
    enabled: false,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    publicUrl: "https://legacy-public.example.test/path",
    webSocketUrl: "wss://ignored-public.example.test/ws"
  }, null, 2)}\n`, "utf8");

  const settings = readTunnelHubSettings(app);

  assert.equal(settings.publicHost, "legacy-public.example.test");
  assert.equal(settings.publicUrl, "https://legacy-public.example.test");
  assert.equal(settings.webSocketUrl, "wss://legacy-public.example.test/ws");
});

test("Tunnel Hub enable saves drafts but falls back to disabled when config is incomplete", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "https://relay.example.test/tunnel"
  });

  assert.equal(result.ok, false);
  assert.equal(result.settings.enabled, false);
  assert.match(result.message, /Sign in/u);
  assert.doesNotMatch(result.message, /Registration token/u);
  const stored = JSON.parse(fs.readFileSync(tunnelSettingsPath(app), "utf8"));
  assert.equal(stored.enabled, false);
  assert.equal(stored.relayUrl, "wss://relay.example.test/tunnel");
  assert.equal(fs.existsSync(legacyTunnelTokenPath(app)), false);
});

test("Tunnel Hub ignores and clears legacy registration token without SSO", (t) => {
  const app = createTempApp(t);
  fs.mkdirSync(path.dirname(tunnelRegistrationTokenPath(app)), { recursive: true });
  fs.writeFileSync(tunnelRegistrationTokenPath(app), "legacy-registration-secret\n", "utf8");

  const result = saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel"
  });

  assert.equal(result.ok, false);
  assert.equal(result.settings.enabled, false);
  assert.match(result.message, /Sign in/u);
  assert.equal(fs.existsSync(tunnelRegistrationTokenPath(app)), false);
});

test("Tunnel Hub legacy settings without enabled are treated as enabled only when complete", (t) => {
  const app = createTempApp(t);
  fs.mkdirSync(path.dirname(tunnelSettingsPath(app)), { recursive: true });
  fs.mkdirSync(path.dirname(legacyTunnelTokenPath(app)), { recursive: true });
  fs.writeFileSync(tunnelSettingsPath(app), `${JSON.stringify({
    relayUrl: "wss://legacy.example.test/ws",
    tlsInsecureSkipVerify: true,
    reconnectSeconds: 3
  }, null, 2)}\n`, "utf8");

  assert.equal(readTunnelHubSettings(app).enabled, false);
  assert.equal(readTunnelHubSettings(app).tlsInsecureSkipVerify, false);

  fs.writeFileSync(legacyTunnelTokenPath(app), "legacy-token\n", "utf8");
  assert.equal(readTunnelHubSettings(app).enabled, false);

  writeDesktopSsoAccessToken(app);
  assert.equal(readTunnelHubSettings(app).enabled, true);
});
