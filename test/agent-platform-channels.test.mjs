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
  removeChannel,
  getChannelEntry
} = require("../dist-electron/main/agent-platform-channels.js");

test("readChannelsYaml returns empty object when file does not exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const result = readChannelsYaml(tempDir);
  assert.deepEqual(result, {});
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("readChannelsYaml returns existing channels", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const configsDir = path.join(tempDir, "configs");
  fs.mkdirSync(configsDir, { recursive: true });
  const channelsPath = path.join(configsDir, "channels.yml");
  fs.writeFileSync(channelsPath, `
channels:
  wecom:
    name: 企业微信
    type: bridge
    default-agent: customer-service
    agents: "*"
    gateway:
      url: ws://127.0.0.1:11970/ws/agent
      jwt-token: test-token
`.trim(), "utf8");

  const result = readChannelsYaml(tempDir);
  assert.ok("wecom" in result);
  assert.equal(result.wecom.name, "企业微信");
  assert.equal(result.wecom.type, "bridge");
  assert.equal(result.wecom.gateway.url, "ws://127.0.0.1:11970/ws/agent");
  assert.equal(result.wecom.gateway["jwt-token"], "test-token");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("upsertChannel creates new channel entry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const channelEntry = {
    name: "企业微信",
    type: "bridge",
    "default-agent": "agent1",
    agents: "*",
    gateway: {
      url: "ws://127.0.0.1:11970/ws/agent",
      "jwt-token": "token123"
    }
  };

  upsertChannel(tempDir, "wecom", channelEntry);

  const result = readChannelsYaml(tempDir);
  assert.ok("wecom" in result);
  assert.equal(result.wecom.name, "企业微信");
  assert.equal(result.wecom.gateway.url, "ws://127.0.0.1:11970/ws/agent");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("upsertChannel updates existing channel entry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const configsDir = path.join(tempDir, "configs");
  fs.mkdirSync(configsDir, { recursive: true });
  fs.writeFileSync(path.join(configsDir, "channels.yml"), `
channels:
  wecom:
    name: 企业微信
    type: bridge
    default-agent: old-agent
    agents: "*"
    gateway:
      url: ws://old-url
      jwt-token: old-token
`.trim(), "utf8");

  const newEntry = {
    name: "企业微信更新",
    type: "bridge",
    "default-agent": "new-agent",
    agents: "*",
    gateway: {
      url: "ws://127.0.0.1:11970/ws/agent",
      "jwt-token": "new-token"
    }
  };

  upsertChannel(tempDir, "wecom", newEntry);

  const result = readChannelsYaml(tempDir);
  assert.ok("wecom" in result);
  assert.equal(result.wecom.name, "企业微信更新");
  assert.equal(result.wecom.gateway.url, "ws://127.0.0.1:11970/ws/agent");
  assert.equal(result.wecom.gateway["jwt-token"], "new-token");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("upsertChannel does not affect other channel entries", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const configsDir = path.join(tempDir, "configs");
  fs.mkdirSync(configsDir, { recursive: true });
  fs.writeFileSync(path.join(configsDir, "channels.yml"), `
channels:
  wecom:
    name: 企业微信
    type: bridge
    default-agent: agent1
    agents: "*"
    gateway:
      url: ws://127.0.0.1:11970/ws/agent
      jwt-token: token1
  feishu:
    name: 飞书
    type: bridge
    default-agent: agent2
    agents: "*"
    gateway:
      url: ws://127.0.0.1:11971/ws/agent
      jwt-token: token2
`.trim(), "utf8");

  upsertChannel(tempDir, "wecom", {
    name: "企业微信更新",
    type: "bridge",
    "default-agent": "agent1",
    agents: "*",
    gateway: {
      url: "ws://new-url",
      "jwt-token": "new-token"
    }
  });

  const result = readChannelsYaml(tempDir);
  assert.ok("wecom" in result);
  assert.equal(result.wecom.name, "企业微信更新");
  assert.ok("feishu" in result);
  assert.equal(result.feishu.name, "飞书");
  assert.equal(result.feishu.gateway.url, "ws://127.0.0.1:11971/ws/agent");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("removeChannel removes existing channel", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const configsDir = path.join(tempDir, "configs");
  fs.mkdirSync(configsDir, { recursive: true });
  fs.writeFileSync(path.join(configsDir, "channels.yml"), `
channels:
  wecom:
    name: 企业微信
    type: bridge
    default-agent: agent1
    agents: "*"
    gateway:
      url: ws://127.0.0.1:11970/ws/agent
      jwt-token: token1
`.trim(), "utf8");

  removeChannel(tempDir, "wecom");

  const result = readChannelsYaml(tempDir);
  assert.ok(!("wecom" in result));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("removeChannel is no-op when channel does not exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const configsDir = path.join(tempDir, "configs");
  fs.mkdirSync(configsDir, { recursive: true });
  fs.writeFileSync(path.join(configsDir, "channels.yml"), `
channels:
  wecom:
    name: 企业微信
    type: bridge
    default-agent: agent1
    agents: "*"
    gateway:
      url: ws://127.0.0.1:11970/ws/agent
      jwt-token: token1
`.trim(), "utf8");

  removeChannel(tempDir, "nonexistent");

  const result = readChannelsYaml(tempDir);
  assert.ok("wecom" in result);
  assert.equal(result.wecom.name, "企业微信");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("removeChannel deletes file when last channel is removed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const configsDir = path.join(tempDir, "configs");
  fs.mkdirSync(configsDir, { recursive: true });
  fs.writeFileSync(path.join(configsDir, "channels.yml"), `
channels:
  wecom:
    name: 企业微信
    type: bridge
    default-agent: agent1
    agents: "*"
    gateway:
      url: ws://127.0.0.1:11970/ws/agent
      jwt-token: token1
`.trim(), "utf8");

  removeChannel(tempDir, "wecom");

  const channelsPath = path.join(configsDir, "channels.yml");
  assert.ok(!fs.existsSync(channelsPath));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("getChannelEntry returns entry when channel exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const channelEntry = {
    name: "企业微信",
    type: "bridge",
    "default-agent": "agent1",
    agents: "*",
    gateway: {
      url: "ws://127.0.0.1:11970/ws/agent",
      "jwt-token": "token123"
    }
  };

  upsertChannel(tempDir, "wecom", channelEntry);

  const result = getChannelEntry(tempDir, "wecom");
  assert.ok(result !== null);
  assert.equal(result.name, "企业微信");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("getChannelEntry returns null when channel does not exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-test-"));
  const result = getChannelEntry(tempDir, "nonexistent");
  assert.equal(result, null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
