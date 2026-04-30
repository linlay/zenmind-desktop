import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const {
  readChannelsYaml,
  upsertChannel,
  removeChannel
} = require("../dist-electron/main/agent-platform-channels.js");
const {
  getBridgeRegistrationState
} = require("../dist-electron/main/bridge-registrar.js");

test("getBridgeRegistrationState returns default state for unknown service", () => {
  const state = getBridgeRegistrationState("nonexistent-service");
  assert.equal(state.registered, false);
  assert.equal(state.channelId, null);
  assert.equal(state.channelName, null);
  assert.equal(state.lastError, null);
});

test("channels yml is correctly structured for bridge entry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-channels-test-"));
  const channelEntry = {
    name: "企业微信",
    type: "bridge",
    "default-agent": "",
    agents: "*",
    gateway: {
      url: "ws://127.0.0.1:11970/ws/agent?channel=wecom",
      "jwt-token": "eyJhbGciOiJIUzI1NiJ9.test"
    }
  };

  upsertChannel(tempDir, "wecom", channelEntry);

  const channels = readChannelsYaml(tempDir);
  assert.ok("wecom" in channels);
  assert.equal(channels.wecom.name, "企业微信");
  assert.equal(channels.wecom.type, "bridge");
  assert.equal(channels.wecom["default-agent"], "");
  assert.equal(channels.wecom.agents, "*");
  assert.equal(channels.wecom.gateway.url, "ws://127.0.0.1:11970/ws/agent?channel=wecom");
  assert.equal(channels.wecom.gateway["jwt-token"], "eyJhbGciOiJIUzI1NiJ9.test");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("multiple bridge channels can coexist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-channels-test-"));

  upsertChannel(tempDir, "wecom", {
    name: "企业微信",
    type: "bridge",
    "default-agent": "",
    agents: "*",
    gateway: { url: "ws://127.0.0.1:11970/ws/agent?channel=wecom", "jwt-token": "token1" }
  });

  upsertChannel(tempDir, "weixin", {
    name: "微信",
    type: "bridge",
    "default-agent": "",
    agents: "*",
    gateway: { url: "ws://127.0.0.1:11971/ws/agent?channel=weixin", "jwt-token": "token2" }
  });

  const channels = readChannelsYaml(tempDir);
  assert.ok("wecom" in channels);
  assert.ok("weixin" in channels);
  assert.equal(channels.wecom.gateway["jwt-token"], "token1");
  assert.equal(channels.weixin.gateway["jwt-token"], "token2");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("removing one bridge does not affect others", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-channels-test-"));

  upsertChannel(tempDir, "wecom", {
    name: "企业微信",
    type: "bridge",
    "default-agent": "",
    agents: "*",
    gateway: { url: "ws://127.0.0.1:11970/ws/agent?channel=wecom", "jwt-token": "token1" }
  });

  upsertChannel(tempDir, "weixin", {
    name: "微信",
    type: "bridge",
    "default-agent": "",
    agents: "*",
    gateway: { url: "ws://127.0.0.1:11971/ws/agent?channel=weixin", "jwt-token": "token2" }
  });

  removeChannel(tempDir, "wecom");

  const channels = readChannelsYaml(tempDir);
  assert.ok(!("wecom" in channels));
  assert.ok("weixin" in channels);
  assert.equal(channels.weixin.name, "微信");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("channel entry can be updated with new gateway info", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-channels-test-"));

  upsertChannel(tempDir, "wecom", {
    name: "企业微信",
    type: "bridge",
    "default-agent": "",
    agents: "*",
    gateway: { url: "ws://old-url", "jwt-token": "old-token" }
  });

  upsertChannel(tempDir, "wecom", {
    name: "企业微信",
    type: "bridge",
    "default-agent": "",
    agents: "*",
    gateway: { url: "ws://new-url", "jwt-token": "new-token" }
  });

  const channels = readChannelsYaml(tempDir);
  assert.equal(channels.wecom.gateway.url, "ws://new-url");
  assert.equal(channels.wecom.gateway["jwt-token"], "new-token");

  fs.rmSync(tempDir, { recursive: true, force: true });
});
