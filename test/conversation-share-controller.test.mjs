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
const {
  TunnelConversationShareError
} = await import("../dist-electron/main/assistant/core/tunnel-conversation-share-client.js");

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
  const tokenPath = path.join(desktopRoot, "state", "desktop", "sso-access-token.txt");
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
  fs.writeFileSync(tokenPath, `header.${payload}.signature\n`);
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return app;
}

function shareRecord(overrides = {}) {
  return {
    shareId: "opaque_abc",
    url: "https://share.example.test/share/opaque_abc",
    createdAt: 1_786_363_200_000,
    expiresAt: 1_788_955_200_000,
    lastAccessedAt: null,
    singleUse: false,
    ...overrides
  };
}

test("createConversationShare renders once, then forwards the same Buffer to Tunnel", async (t) => {
  const app = createFixture(t);
  const html = Buffer.from("<!doctype html><title>share</title>");
  const calls = [];
  const renderer = {
    async renderChatHtml(chatId, assetOrigin) {
      calls.push({ method: "render", chatId, assetOrigin });
      return { ok: true, bytes: html, filename: "chat.html" };
    }
  };
  const client = {
    async create(input) {
      calls.push({ method: "create", input });
      return shareRecord();
    }
  };

  const result = await createConversationShare(app, renderer, client, {
    chatId: " chat-1 ",
    expiration: "30d"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.method), ["render", "create"]);
  assert.equal(calls[0].chatId, "chat-1");
  assert.equal(calls[0].assetOrigin, "https://tunnel.example.test");
  assert.equal(calls[1].input.html, html);
  assert.equal(calls[1].input.conversationId, "chat-1");
  assert.equal(calls[1].input.expiration, "30d");
  assert.equal(calls[1].input.target.origin, "https://tunnel.example.test");
  assert.match(calls[1].input.target.accessToken, /^header\./u);
});

test("createConversationShare resolves login and Tunnel before rendering HTML", async (t) => {
  const app = createFixture(t);
  const desktopRoot = path.join(app.getPath("home"), APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir);
  fs.rmSync(path.join(desktopRoot, "state", "desktop", "sso-access-token.txt"));
  let rendered = false;
  let created = false;

  const result = await createConversationShare(app, {
    async renderChatHtml() {
      rendered = true;
      return { ok: true, bytes: Buffer.from("html"), filename: "chat.html" };
    }
  }, {
    async create() {
      created = true;
      return shareRecord();
    }
  }, { chatId: "chat-1", expiration: "30d" });

  assert.equal(result.ok, false);
  assert.equal(rendered, false);
  assert.equal(created, false);
});

test("createConversationShare does not call Tunnel when HTML generation fails", async (t) => {
  const app = createFixture(t);
  let created = false;
  const result = await createConversationShare(app, {
    async renderChatHtml() {
      return { ok: false, message: "render failed" };
    }
  }, {
    async create() {
      created = true;
      return shareRecord();
    }
  }, { chatId: "chat-1", expiration: "30d" });

  assert.deepEqual(result, { ok: false, message: "render failed" });
  assert.equal(created, false);
});

test("createConversationShare rejects removed and invalid expirations before resolving dependencies", async (t) => {
  const app = createFixture(t);
  for (const expiration of ["5m", "30m", "1h", "5d", "15d", "90d"]) {
    let called = false;
    const result = await createConversationShare(app, {
      async renderChatHtml() {
        called = true;
        return { ok: true, bytes: Buffer.from("html"), filename: "chat.html" };
      }
    }, {
      async create() {
        called = true;
        return shareRecord();
      }
    }, { chatId: "chat-1", expiration });

    assert.equal(result.ok, false, expiration);
    assert.equal(called, false, expiration);
  }
});

test("createConversationShare rejects an invalid conversation id before rendering", async (t) => {
  const app = createFixture(t);
  let called = false;
  const result = await createConversationShare(app, {
    async renderChatHtml() {
      called = true;
      return { ok: true, bytes: Buffer.from("html"), filename: "chat.html" };
    }
  }, {
    async create() {
      called = true;
      return shareRecord();
    }
  }, { chatId: `chat-${"x".repeat(256)}`, expiration: "30d" });

  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("development allows canonical loopback Tunnel origins while packaged Desktop rejects plaintext", async (t) => {
  for (const [relayUrl, expectedOrigin] of [
    ["ws://localhost:18181/tunnel", "http://localhost:18181"],
    ["ws://127.0.0.1:18181/tunnel", "http://127.0.0.1:18181"],
    ["ws://[::1]:18181/tunnel", "http://[::1]:18181"]
  ]) {
    const developmentApp = createFixture(t, { relayUrl });
    developmentApp.isPackaged = false;
    let developmentOrigin = "";
    const renderer = {
      async renderChatHtml(_chatId, assetOrigin) {
        developmentOrigin = assetOrigin;
        return { ok: true, bytes: Buffer.from("html"), filename: "chat.html" };
      }
    };
    const client = { async create() { return shareRecord(); } };
    const developmentResult = await createConversationShare(
      developmentApp,
      renderer,
      client,
      { chatId: "chat-1", expiration: "30d" }
    );
    assert.equal(developmentResult.ok, true, relayUrl);
    assert.equal(developmentOrigin, expectedOrigin, relayUrl);

    const packagedApp = createFixture(t, { relayUrl });
    packagedApp.isPackaged = true;
    let packagedRendered = false;
    const packagedResult = await createConversationShare(packagedApp, {
      async renderChatHtml() {
        packagedRendered = true;
        return { ok: true, bytes: Buffer.from("html"), filename: "chat.html" };
      }
    }, client, { chatId: "chat-1", expiration: "30d" });
    assert.equal(packagedResult.ok, false, relayUrl);
    assert.equal(packagedRendered, false, relayUrl);
  }
});

test("list and revoke use only the Tunnel client", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const client = {
    async list(target, conversationId) {
      calls.push({ method: "list", target, conversationId });
      return [shareRecord({ expiresAt: null })];
    },
    async revoke(target, shareId) {
      calls.push({ method: "revoke", target, shareId });
    }
  };

  const listed = await listConversationShares(app, client, " chat-1 ");
  const revoked = await revokeConversationShare(app, client, "opaque-abc_123");

  assert.equal(listed.ok, true);
  assert.equal(revoked.ok, true);
  assert.deepEqual(calls.map((call) => call.method), ["list", "revoke"]);
  assert.equal(calls[0].conversationId, "chat-1");
  assert.equal(calls[1].shareId, "opaque-abc_123");
  assert.equal(calls[0].target.origin, "https://tunnel.example.test");
});

test("controller maps typed Tunnel failures without exposing secrets", async (t) => {
  const app = createFixture(t);
  const cases = [
    [new TunnelConversationShareError("rejected", 401), /权限|credential|permission/iu],
    [new TunnelConversationShareError("rejected", 413), /过大|too large/iu],
    [new TunnelConversationShareError("invalid_response"), /无效|invalid/iu],
    [new TunnelConversationShareError("timeout"), /不可用|unavailable/iu],
    [new TunnelConversationShareError("rejected", 503), /不可用|unavailable/iu]
  ];
  for (const [error, messagePattern] of cases) {
    const result = await listConversationShares(app, {
      async list() {
        throw error;
      }
    }, "chat-1");
    assert.equal(result.ok, false);
    assert.match(result.message, messagePattern);
    assert.doesNotMatch(result.message, /Bearer|header\./u);
  }

  const revoked = await revokeConversationShare(app, {
    async revoke() {
      throw new TunnelConversationShareError("rejected", 404);
    }
  }, "share_abc");
  assert.equal(revoked.ok, false);
  assert.match(revoked.message, /不存在|revoked|no longer exists/iu);
});

test("Desktop sharing source keeps HTML rendering separate from Tunnel persistence", () => {
  const controllerSource = fs.readFileSync(
    new URL("../src/main/assistant/core/conversation-share-controller.ts", import.meta.url),
    "utf8"
  );
  const bridgeSource = fs.readFileSync(
    new URL("../src/main/assistant/core/agent-platform-bridge.ts", import.meta.url),
    "utf8"
  );

  assert.match(controllerSource, /renderChatHtml/u);
  assert.match(controllerSource, /shareCreator\.create/u);
  assert.doesNotMatch(bridgeSource, /createChatShare|listChatShares|revokeChatShare/u);
  assert.doesNotMatch(bridgeSource, /X-Conversation-Share-Authorization/u);
});
