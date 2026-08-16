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

const eventStreamBytes = Buffer.from([
  'event: message\ndata: {"seq":1,"type":"chat.start","shareVersion":1,"chatName":"Release plan","timestamp":1700000000000}',
  'event: message\ndata: {"seq":2,"type":"request.query","message":"hello","timestamp":1700000000000}',
  'event: message\ndata: {"seq":3,"type":"content.snapshot","text":"ready","timestamp":1700000001000}',
  'event: message\ndata: {"seq":4,"type":"run.complete","timestamp":1700000001000}',
  "event: message\ndata: [DONE]",
  ""
].join("\n\n"), "utf8");

test("createConversationShare uploads the platform event stream bytes unchanged", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const result = await createConversationShare(
    app,
    { downloadChatShareEventStream: async () => ({ ok: true, bytes: eventStreamBytes }) },
    "chat-1",
    async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        id: "opaque_abc",
        url: "https://share.example.test/share/opaque_abc",
        createdAt: "2026-08-10T12:00:00Z"
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.url, "https://share.example.test/share/opaque_abc");
  assert.equal(calls[0].url, "https://tunnel.example.test/api/desktop/shares");
  assert.equal(calls[0].init.headers.Authorization.startsWith("Bearer header."), true);
  assert.equal(calls[0].init.headers["Content-Type"], "text/event-stream");
  assert.equal(Buffer.compare(Buffer.from(calls[0].init.body), eventStreamBytes), 0);
});

test("createConversationShare does not upload when the platform export fails", async (t) => {
  const app = createFixture(t);
  let called = false;
  const result = await createConversationShare(
    app,
    { downloadChatShareEventStream: async () => ({ ok: false, message: "unsupported" }) },
    "chat-1",
    async () => {
      called = true;
      return new Response();
    }
  );

  assert.deepEqual(result, { ok: false, message: "unsupported" });
  assert.equal(called, false);
});

test("the Desktop share event stream path contains no parsing or reserialization step", () => {
  const controllerSource = fs.readFileSync(
    new URL("../src/main/assistant/core/conversation-share-controller.ts", import.meta.url),
    "utf8"
  );
  const bridgeSource = fs.readFileSync(
    new URL("../src/main/assistant/core/agent-platform-bridge.ts", import.meta.url),
    "utf8"
  );
  const downloadMethod = bridgeSource.slice(
    bridgeSource.indexOf("async downloadChatShareEventStream"),
    bridgeSource.indexOf("async downloadRawChatJSONL")
  );

  assert.match(controllerSource, /body: eventStreamResult\.bytes/u);
  assert.doesNotMatch(downloadMethod, /JSON\.(?:parse|stringify)/u);
  assert.doesNotMatch(downloadMethod, /\.text\(\)/u);
  assert.equal(fs.existsSync(new URL(
    "../src/main/assistant/core/conversation-share-types.ts",
    import.meta.url
  )), false);
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

test("revokeConversationShare accepts a prefixless opaque id", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const result = await revokeConversationShare(app, "opaque-abc_123", async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://tunnel.example.test/api/desktop/shares/opaque-abc_123");
});
