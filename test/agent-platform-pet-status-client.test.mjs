import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  AgentPlatformPetStatusClient,
  applyAgentPlatformPetPush,
} = require("../dist-electron/main/assistant/pet/pet-status-client.js");
const { DesktopPetSseParser } = require("../dist-electron/main/assistant/pet/desktop-pet-preview.js");

const EPOCH_MS = 1_783_000_000_000;

function createStatus(overrides = {}) {
  return {
    agentKey: "zenmi",
    displayName: "Zenmi",
    role: "assistant",
    presence: "available",
    unreadCount: 0,
    latestPreview: "Previous reply",
    chatId: "chat-1",
    hasPendingAwaiting: false,
    stale: false,
    updatedAt: EPOCH_MS,
    ...overrides,
  };
}

test("desktop pet status applies semantic push times and preserves read-all freshness", () => {
  const current = createStatus();
  const started = applyAgentPlatformPetPush(current, "zenmi", {
    frame: "push",
    type: "run.started",
    data: { agentKey: "zenmi", chatId: "chat-1", runId: "run-1", startedAt: EPOCH_MS + 1 },
  });
  assert.equal(started?.presence, "busy");
  assert.equal(started?.updatedAt, EPOCH_MS + 1);

  const unread = applyAgentPlatformPetPush(started, "zenmi", {
    frame: "push",
    type: "chat.unread",
    data: { agentKey: "zenmi", chatId: "chat-1", createdAt: EPOCH_MS + 2 },
  });
  assert.equal(unread?.unreadCount, 1);
  assert.equal(unread?.updatedAt, EPOCH_MS + 2);

  const read = applyAgentPlatformPetPush(unread, "zenmi", {
    frame: "push",
    type: "chat.read",
    data: { agentKey: "zenmi", chatId: "chat-1", readAt: EPOCH_MS + 3 },
  });
  assert.equal(read?.unreadCount, 0);
  assert.equal(read?.updatedAt, EPOCH_MS + 3);

  const readAll = applyAgentPlatformPetPush(read, "zenmi", {
    frame: "push",
    type: "chat.read_all",
    data: { agentKey: "zenmi" },
  });
  assert.equal(readAll?.unreadCount, 0);
  assert.equal(readAll?.updatedAt, EPOCH_MS + 3);

  const finished = applyAgentPlatformPetPush(readAll, "zenmi", {
    frame: "push",
    type: "run.finished",
    data: { agentKey: "zenmi", chatId: "chat-1", runId: "run-1", finishedAt: EPOCH_MS + 4 },
  });
  assert.equal(finished?.presence, "away");
  assert.equal(finished?.updatedAt, EPOCH_MS + 4);

  const legacy = applyAgentPlatformPetPush(finished, "zenmi", {
    frame: "push",
    type: "run.started",
    data: { agentKey: "zenmi", chatId: "chat-1", runId: "run-2", timestamp: EPOCH_MS + 5 },
  });
  assert.strictEqual(legacy, finished);
});

test("desktop pet status callbacks use run startedAt and finishedAt", (t) => {
  const callbacks = [];
  const client = new AgentPlatformPetStatusClient({
    app: {},
    getServiceState: async () => ({ status: "stopped", healthMeta: { webUrl: "" } }),
    issueAccessToken: async () => ({ ok: false, token: "", message: "" }),
    onStatus: () => {},
    onRunStarted: (event) => callbacks.push({ kind: "started", ...event }),
    onRunFinished: (event) => callbacks.push({ kind: "finished", ...event }),
  });
  t.after(() => client.stop());
  client.latestStatus = createStatus();

  client.handleWebSocketMessage(JSON.stringify({
    frame: "push",
    type: "run.started",
    data: { agentKey: "zenmi", chatId: "chat-1", runId: "run-1", startedAt: EPOCH_MS + 10 },
  }));
  client.handleWebSocketMessage(JSON.stringify({
    frame: "push",
    type: "run.finished",
    data: { agentKey: "zenmi", chatId: "chat-1", runId: "run-1", finishedAt: EPOCH_MS + 11 },
  }));

  assert.deepEqual(callbacks.map(({ kind, timestamp }) => ({ kind, timestamp })), [
    { kind: "started", timestamp: EPOCH_MS + 10 },
    { kind: "finished", timestamp: EPOCH_MS + 11 },
  ]);
});

test("SSE and frame stream events retain their timestamp contract", () => {
  const parser = new DesktopPetSseParser();
  const sse = parser.push(`event: content.delta\ndata: ${JSON.stringify({
    type: "content.delta",
    runId: "run-1",
    chatId: "chat-1",
    timestamp: EPOCH_MS,
  })}\n\n`);
  assert.equal(sse.events[0]?.createdAt, EPOCH_MS);

  const client = new AgentPlatformPetStatusClient({
    app: {},
    getServiceState: async () => ({ status: "stopped", healthMeta: { webUrl: "" } }),
    issueAccessToken: async () => ({ ok: false, token: "", message: "" }),
    onStatus: () => {},
  });
  client.latestStatus = createStatus();
  client.handleWebSocketMessage(JSON.stringify({
    frame: "stream",
    type: "content.delta",
    data: { timestamp: EPOCH_MS },
  }));
  assert.equal(client.latestStatus.updatedAt, EPOCH_MS);
  client.stop();
});
