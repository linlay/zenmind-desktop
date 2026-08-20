import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { APP_BRAND } = await import("../dist-electron/shared/brand.js");
const {
  createConversationShare,
  listConversationShares,
  revokeConversationShare
} = await import("../dist-electron/main/assistant/core/conversation-share-controller.js");

function createFixture(t, tunnelOverrides = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-share-"));
  const homeRoot = path.join(tempRoot, "home");
  const app = {
    getPath(name) {
      if (name === "home") return homeRoot;
      if (name === "appData") return path.join(tempRoot, "app-data");
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
  const desktopRoot = path.join(homeRoot, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir);
  const configPath = path.join(desktopRoot, "config", "desktop", "tunnel-hub.json");
  const tokenPath = path.join(desktopRoot, "secrets", "sso-site-token.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    relayUrl: "wss://tunnel.example.test/tunnel",
    deviceId: "share-test-device",
    tlsInsecureSkipVerify: false,
    reconnectSeconds: 3,
    ...tunnelOverrides
  }));
  const payload = Buffer.from(JSON.stringify({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  fs.writeFileSync(tokenPath, JSON.stringify({ accessToken: `header.${payload}.signature` }));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return app;
}

function successfulShare(recordOverrides = {}) {
  return {
    ok: true,
    message: "created",
    record: {
      shareId: "opaque_abc",
      url: "https://share.example.test/share/opaque_abc",
      createdAt: 1_786_363_200_000,
      expiresAt: 1_788_955_200_000,
      lastAccessedAt: null,
      ...recordOverrides
    }
  };
}

function bridgeWithCalls(calls, result = successfulShare()) {
  return {
    async createChatShare(input) {
      calls.push({ method: "create", input });
      return result;
    },
    async listChatShares(input) {
      calls.push({ method: "list", input });
      return { ok: true, message: "", records: [result.record] };
    },
    async revokeChatShare(input) {
      calls.push({ method: "revoke", input });
      return { ok: true, message: "revoked", shareId: input.shareId };
    }
  };
}

function shareRequest(chatId, expiration = "30d") {
  return { chatId, expiration };
}

test("createConversationShare delegates HTML share orchestration to Agent Platform", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const result = await createConversationShare(app, bridgeWithCalls(calls), shareRequest(" chat-1 "));

  assert.equal(result.ok, true);
  assert.equal(result.record.url, "https://share.example.test/share/opaque_abc");
  assert.equal(result.record.expiresAt, 1_788_955_200_000);
  assert.equal(calls[0].method, "create");
  assert.equal(calls[0].input.chatId, "chat-1");
  assert.equal(calls[0].input.expiration, "30d");
  assert.equal(calls[0].input.tunnelOrigin, "https://tunnel.example.test");
  assert.equal(calls[0].input.tunnelAuthorization.startsWith("Bearer header."), true);
});

test("development share accepts only the three canonical loopback Tunnel hosts", async (t) => {
  for (const [relayUrl, expectedOrigin] of [
    ["ws://localhost:18181/tunnel", "http://localhost:18181"],
    ["ws://127.0.0.1:18181/tunnel", "http://127.0.0.1:18181"],
    ["ws://[::1]:18181/tunnel", "http://[::1]:18181"]
  ]) {
    const app = createFixture(t, { relayUrl });
    app.isPackaged = false;
    const calls = [];

    const result = await createConversationShare(app, bridgeWithCalls(calls), shareRequest("chat-1"));

    assert.equal(result.ok, true, relayUrl);
    assert.equal(calls[0].input.tunnelOrigin, expectedOrigin, relayUrl);
    assert.equal(calls[0].input.tunnelAuthorization.startsWith("Bearer header."), true, relayUrl);
  }
});

test("packaged Desktop rejects plaintext Tunnel sharing for all canonical loopback hosts", async (t) => {
  for (const relayUrl of [
    "ws://localhost:18181/tunnel",
    "ws://127.0.0.1:18181/tunnel",
    "ws://[::1]:18181/tunnel"
  ]) {
    const app = createFixture(t, { relayUrl });
    app.isPackaged = true;
    const calls = [];

    const result = await createConversationShare(app, bridgeWithCalls(calls), shareRequest("chat-1"));

    assert.equal(result.ok, false, relayUrl);
    assert.equal(calls.length, 0, relayUrl);
  }
});

test("development share fails closed for disabled, remote plaintext, or reserved local Tunnel settings", async (t) => {
  for (const tunnelOverrides of [
    { enabled: false },
    { relayUrl: "ws://192.0.2.1:18181/tunnel" },
    { relayUrl: "wss://127.0.0.2:18181/tunnel" },
    { relayUrl: "wss://demo.localhost:18181/tunnel" },
    { relayUrl: "wss://0.0.0.0:18181/tunnel" }
  ]) {
    const app = createFixture(t, tunnelOverrides);
    app.isPackaged = false;
    const calls = [];

    const result = await createConversationShare(app, bridgeWithCalls(calls), shareRequest("chat-1"));

    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  }
});

test("createConversationShare resolves login before calling Agent Platform", async (t) => {
  const app = createFixture(t);
  const desktopRoot = path.join(app.getPath("home"), APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir);
  fs.rmSync(path.join(desktopRoot, "secrets", "sso-site-token.json"));
  let called = false;
  const result = await createConversationShare(app, {
    async createChatShare() {
      called = true;
      return successfulShare();
    },
    async revokeChatShare() {
      called = true;
      return { ok: true, message: "revoked" };
    }
  }, shareRequest("chat-1"));

  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("createConversationShare does not expose private authorization on bridge failures", async (t) => {
  const app = createFixture(t);
  const result = await createConversationShare(app, {
    async createChatShare(input) {
      throw new Error(input.tunnelAuthorization);
    },
    async revokeChatShare() {
      return { ok: true, message: "revoked" };
    }
  }, shareRequest("chat-1"));

  assert.equal(result.ok, false);
  assert.doesNotMatch(result.message, /Bearer|header\./u);
});

test("createConversationShare rejects unsupported expiration before calling Agent Platform", async (t) => {
  const app = createFixture(t);
  let called = false;
  const bridge = bridgeWithCalls([]);
  const originalCreate = bridge.createChatShare;
  bridge.createChatShare = async (...args) => {
    called = true;
    return originalCreate(...args);
  };
  const result = await createConversationShare(app, bridge, {
    chatId: "chat-1",
    expiration: "90d"
  });

  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("Desktop share controller contains no SSE, HTML bytes, or direct Tunnel data-plane request", () => {
  const controllerSource = fs.readFileSync(
    new URL("../src/main/assistant/core/conversation-share-controller.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(controllerSource, /downloadChatShareEventStream|text\/event-stream|\/api\/desktop\/shares|body:\s*.*bytes/u);
  assert.doesNotMatch(controllerSource, /Date\.parse|RFC3339|isIsoTimestamp/u);
  assert.match(controllerSource, /assistantBridge\.createChatShare/u);
  assert.match(controllerSource, /assistantBridge\.listChatShares/u);
  assert.match(controllerSource, /assistantBridge\.revokeChatShare/u);
});

test("listConversationShares delegates to Agent Platform with the current chat and Tunnel connection", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const result = await listConversationShares(app, bridgeWithCalls(calls), " chat-1 ");

  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.equal(calls[0].method, "list");
  assert.equal(calls[0].input.chatId, "chat-1");
  assert.equal(calls[0].input.tunnelOrigin, "https://tunnel.example.test");
});

test("revokeConversationShare delegates to Agent Platform with current Tunnel connection", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const result = await revokeConversationShare(app, bridgeWithCalls(calls), "share_abc");

  assert.equal(result.ok, true);
  assert.equal(calls[0].method, "revoke");
  assert.equal(calls[0].input.shareId, "share_abc");
  assert.equal(calls[0].input.tunnelOrigin, "https://tunnel.example.test");
  assert.equal(calls[0].input.tunnelAuthorization.startsWith("Bearer header."), true);
});

test("revokeConversationShare accepts a prefixless opaque id", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const result = await revokeConversationShare(app, bridgeWithCalls(calls), "opaque-abc_123");

  assert.equal(result.ok, true);
  assert.equal(calls[0].input.shareId, "opaque-abc_123");
});
