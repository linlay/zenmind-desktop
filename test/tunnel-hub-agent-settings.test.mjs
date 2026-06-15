import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  readTunnelHubAgentSettings,
  saveTunnelHubAgentSettings
} = await import("../dist-electron/main/tunnel-hub-agent-settings.js");

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
  return path.join(app.getPath("home"), ".zenmind", ".desktop");
}

function tunnelSettingsPath(app) {
  return path.join(desktopRoot(app), "config", "desktop", "tunnel-hub-agent.json");
}

function tunnelTokenPath(app) {
  return path.join(desktopRoot(app), "secrets", "tunnel-hub-agent-token");
}

test("Tunnel Hub settings persist enabled when relay URL and token are configured", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubAgentSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/ws",
    agentToken: "agent-secret",
    tlsInsecureSkipVerify: true,
    reconnectSeconds: 9
  });

  assert.equal(result.ok, true);
  assert.equal(result.settings.enabled, true);
  assert.equal(result.settings.relayUrl, "wss://relay.example.test/ws");
  assert.equal(result.settings.hasAgentToken, true);
  assert.equal(result.settings.agentTokenPreview, "****cret");
  assert.equal(result.settings.tlsInsecureSkipVerify, true);
  assert.equal(result.settings.reconnectSeconds, 9);
  assert.equal(readTunnelHubAgentSettings(app).enabled, true);
});

test("Tunnel Hub enable saves drafts but falls back to disabled when config is incomplete", (t) => {
  const app = createTempApp(t);

  const result = saveTunnelHubAgentSettings(app, {
    enabled: true,
    relayUrl: "",
    agentToken: "agent-secret"
  });

  assert.equal(result.ok, false);
  assert.equal(result.settings.enabled, false);
  assert.match(result.message, /Relay URL/u);
  const stored = JSON.parse(fs.readFileSync(tunnelSettingsPath(app), "utf8"));
  assert.equal(stored.enabled, false);
  assert.equal(stored.relayUrl, "");
  assert.equal(fs.readFileSync(tunnelTokenPath(app), "utf8").trim(), "agent-secret");
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

  assert.equal(readTunnelHubAgentSettings(app).enabled, false);

  fs.writeFileSync(tunnelTokenPath(app), "legacy-token\n", "utf8");
  assert.equal(readTunnelHubAgentSettings(app).enabled, true);
});
