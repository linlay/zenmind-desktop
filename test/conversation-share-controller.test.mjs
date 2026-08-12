import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { APP_BRAND } = await import("../dist-electron/shared/brand.js");
const {
  createConversationShare,
  revokeConversationShare
} = await import("../dist-electron/main/assistant/core/conversation-share-controller.js");
const { parseSharedConversationSnapshot } = await import(
  "../dist-electron/main/assistant/core/conversation-share-types.js"
);

function createFixture(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-conversation-share-"));
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
    reconnectSeconds: 3
  }));
  const payload = Buffer.from(JSON.stringify({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  fs.writeFileSync(tokenPath, JSON.stringify({ accessToken: `header.${payload}.signature` }));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return app;
}

const snapshot = {
  schemaVersion: 1,
  title: "Release plan",
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  entries: [
    { type: "message", role: "user", content: "hello", createdAt: 1700000000000 },
    { type: "reasoning", content: "compare options", label: "分析问题", durationMs: 900, createdAt: 1700000000500 },
    { type: "message", role: "assistant", content: "ready", createdAt: 1700000001000 }
  ]
};

test("Desktop accepts only the final strict entries snapshot", () => {
  assert.deepEqual(parseSharedConversationSnapshot(snapshot), snapshot);
  assert.equal(parseSharedConversationSnapshot({ ...snapshot, messages: [] }), null);
  assert.equal(parseSharedConversationSnapshot({
    ...snapshot,
    entries: [{ type: "reasoning", role: "assistant", content: "private metadata" }]
  }), null);
  assert.equal(parseSharedConversationSnapshot({
    ...snapshot,
    entries: [{ type: "reasoning", content: "invalid duration", durationMs: -1 }]
  }), null);
});

test("createConversationShare uploads a safe platform snapshot with the SSO site token", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const result = await createConversationShare(
    app,
    { downloadChatShareSnapshot: async () => ({ ok: true, snapshot }) },
    "chat-1",
    async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        id: "share_abc",
        url: "https://share.example.test/share/share_abc",
        createdAt: "2026-08-10T12:00:00Z"
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.url, "https://share.example.test/share/share_abc");
  assert.equal(calls[0].url, "https://tunnel.example.test/api/desktop/shares");
  assert.equal(calls[0].init.headers.Authorization.startsWith("Bearer header."), true);
  assert.deepEqual(JSON.parse(calls[0].init.body), snapshot);
});

test("createConversationShare does not upload when Agent Platform lacks the safe share contract", async (t) => {
  const app = createFixture(t);
  let called = false;
  const result = await createConversationShare(
    app,
    { downloadChatShareSnapshot: async () => ({ ok: false, message: "unsupported" }) },
    "chat-1",
    async () => {
      called = true;
      return new Response();
    }
  );
  assert.deepEqual(result, { ok: false, message: "unsupported" });
  assert.equal(called, false);
});

test("revokeConversationShare calls the owner-authenticated Tunnel endpoint", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const result = await revokeConversationShare(app, "share_abc", async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://tunnel.example.test/api/desktop/shares/share_abc");
  assert.equal(calls[0].init.method, "DELETE");
});
