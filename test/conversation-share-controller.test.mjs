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
const {
  buildConversationShareSnapshot,
  parseChatTranscriptExport,
  parseChatTranscriptJSONL,
  validateConversationShareSnapshot
} = await import("../dist-electron/main/assistant/core/conversation-share-types.js");

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
  const tokenPath = path.join(desktopRoot, "state", "desktop", "sso-access-token.txt");
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
  fs.writeFileSync(tokenPath, `header.${payload}.signature\n`);
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return app;
}

const transcript = {
  exportVersion: 1,
  kind: "chat-transcript",
  title: "Release plan",
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  turns: [{
    startedAt: 1700000000000,
    completedAt: 1700000001000,
    items: [
      { kind: "user-message", content: "hello", createdAt: 1700000000000 },
      { kind: "assistant-reasoning", content: "compare options", label: "分析问题", createdAt: 1700000000500 },
      { kind: "assistant-message", content: "ready", createdAt: 1700000001000 }
    ]
  }]
};

const snapshot = {
  schemaVersion: 1,
  title: "Release plan",
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  entries: [
    { type: "message", role: "user", content: "hello", createdAt: 1700000000000 },
    { type: "reasoning", content: "compare options", label: "分析问题", durationMs: 1000, createdAt: 1700000000500 },
    { type: "message", role: "assistant", content: "ready", createdAt: 1700000001000 }
  ]
};

test("Desktop parses extensible transcripts and builds a strict share snapshot", () => {
  const parsed = parseChatTranscriptExport({
    ...transcript,
    platformExtension: { runId: "must-not-pass-through" },
    turns: [{
      ...transcript.turns[0],
      futureField: true,
      items: [
        ...transcript.turns[0].items,
        { kind: "future-item", secret: "must-not-pass-through" }
      ]
    }]
  });
  assert.ok(parsed);
  assert.deepEqual(buildConversationShareSnapshot(parsed), snapshot);
  assert.equal(JSON.stringify(buildConversationShareSnapshot(parsed)).includes("must-not-pass-through"), false);
  assert.equal(validateConversationShareSnapshot(snapshot), null);
});

test("Desktop parses extensible JSONL transcript records", () => {
  const jsonl = [
    JSON.stringify({
      type: "metadata",
      exportVersion: 1,
      kind: "chat-transcript",
      title: "Release plan",
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      platformExtension: true
    }),
    JSON.stringify({
      type: "turn",
      startedAt: 1700000000000,
      completedAt: 1700000001000,
      futureField: true,
      items: [
        { ...transcript.turns[0].items[0], runId: "must-not-pass-through" },
        ...transcript.turns[0].items.slice(1),
        { kind: "future-item", secret: "must-not-pass-through" }
      ]
    })
  ].join("\n") + "\n";
  const parsed = parseChatTranscriptJSONL(jsonl);
  assert.ok(parsed);
  assert.deepEqual(buildConversationShareSnapshot(parsed), snapshot);
  assert.equal(JSON.stringify(parsed).includes("must-not-pass-through"), false);
});

test("Desktop preserves JSONL turn order and derives each reasoning duration", () => {
  const jsonl = [
    JSON.stringify({
      type: "metadata",
      exportVersion: 1,
      kind: "chat-transcript",
      title: "Ordered turns",
      createdAt: 1700000000000,
      updatedAt: 1700000005000
    }),
    JSON.stringify({
      type: "turn",
      startedAt: 1700000000000,
      completedAt: 1700000001000,
      items: [{ kind: "assistant-reasoning", content: "first", createdAt: 1700000000500 }]
    }),
    JSON.stringify({
      type: "turn",
      startedAt: 1700000002000,
      completedAt: 1700000005000,
      items: [{ kind: "assistant-reasoning", content: "second", createdAt: 1700000003000 }]
    })
  ].join("\n");

  const parsed = parseChatTranscriptJSONL(jsonl);
  assert.ok(parsed);
  assert.deepEqual(buildConversationShareSnapshot(parsed).entries, [
    { type: "reasoning", content: "first", durationMs: 1000, createdAt: 1700000000500 },
    { type: "reasoning", content: "second", durationMs: 3000, createdAt: 1700000003000 }
  ]);
});

test("Desktop rejects invalid JSONL transcript record order and content", () => {
  const metadataRecord = {
    type: "metadata",
    exportVersion: 1,
    kind: "chat-transcript",
    title: "Release plan",
    createdAt: 1700000000000,
    updatedAt: 1700000001000
  };
  const metadata = JSON.stringify(metadataRecord);
  const turn = JSON.stringify({ type: "turn", ...transcript.turns[0] });
  assert.equal(parseChatTranscriptJSONL(`${turn}\n${metadata}\n`), null);
  assert.equal(parseChatTranscriptJSONL(`${metadata}\n${metadata}\n`), null);
  assert.equal(parseChatTranscriptJSONL(`${metadata}\n{"type":"future-record"}\n`), null);
  assert.equal(parseChatTranscriptJSONL(`${metadata}\nnot-json\n`), null);
  assert.equal(parseChatTranscriptJSONL(`${metadata}\n\n${turn}\n`), null);
  assert.equal(parseChatTranscriptJSONL(`${metadata}\n`), null);
  assert.equal(parseChatTranscriptJSONL(`${JSON.stringify({ ...metadataRecord, updatedAt: 1 })}\n${turn}\n`), null);
  assert.equal(parseChatTranscriptJSONL(`${metadata}\n${JSON.stringify({
    type: "turn",
    ...transcript.turns[0],
    completedAt: transcript.turns[0].startedAt - 1
  })}\n`), null);
});

test("Desktop rejects invalid known transcript fields and unreliable completion times", () => {
  assert.equal(parseChatTranscriptExport({ ...transcript, exportVersion: 2 }), null);
  assert.equal(parseChatTranscriptExport({
    ...transcript,
    turns: [{ ...transcript.turns[0], completedAt: transcript.turns[0].startedAt - 1 }]
  }), null);
  assert.equal(parseChatTranscriptExport({
    ...transcript,
    turns: [{ ...transcript.turns[0], items: [{ kind: "user-message", content: "", createdAt: 1700000000000 }] }]
  }), null);
});

test("Desktop omits reasoning duration for an unfinished turn", () => {
  const parsed = parseChatTranscriptExport({
    ...transcript,
    turns: [{
      startedAt: 1700000000000,
      items: [{ kind: "assistant-reasoning", content: "still working", createdAt: 1700000000500 }]
    }]
  });
  assert.ok(parsed);
  assert.deepEqual(buildConversationShareSnapshot(parsed).entries, [
    { type: "reasoning", content: "still working", createdAt: 1700000000500 }
  ]);
});

test("Desktop rejects empty and oversized share snapshots before upload", () => {
  assert.equal(validateConversationShareSnapshot({ ...snapshot, entries: [] }), "empty");
  assert.equal(validateConversationShareSnapshot({
    ...snapshot,
    entries: Array.from({ length: 2001 }, (_, index) => ({
      type: "message",
      role: "user",
      content: String(index),
      createdAt: 1700000000000
    }))
  }), "entry-limit");
  assert.equal(validateConversationShareSnapshot({
    ...snapshot,
    entries: [{ type: "message", role: "user", content: "x".repeat(200001) }]
  }), "entry-size");
});

test("createConversationShare converts a platform transcript before uploading", async (t) => {
  const app = createFixture(t);
  const calls = [];
  const result = await createConversationShare(
    app,
    { downloadChatTranscriptExport: async () => ({ ok: true, transcript }) },
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

test("createConversationShare does not upload invalid or empty platform exports", async (t) => {
  const app = createFixture(t);
  let called = false;
  const result = await createConversationShare(
    app,
    { downloadChatTranscriptExport: async () => ({ ok: true, transcript: { ...transcript, turns: [] } }) },
    "chat-1",
    async () => {
      called = true;
      return new Response();
    }
  );
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("createConversationShare does not upload when structured export is unsupported", async (t) => {
  const app = createFixture(t);
  let called = false;
  const result = await createConversationShare(
    app,
    { downloadChatTranscriptExport: async () => ({ ok: false, message: "unsupported" }) },
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
