import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RealtimeBroker } = require("../dist-electron/main/realtime/realtime-broker.js");
const {
  createAgentPlatformIdentitySessionId,
  normalizeAgentPlatformRealtimeEndpoint,
} = require("../dist-electron/main/realtime/agent-platform-realtime-client.js");

const EPOCH_MS = 1_771_888_000_000;

function jwt(claims = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ iss: "test", sub: "user", sid: "session", ...claims })}.signature`;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-realtime-broker-"));
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    emit(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }

    disconnect() {
      this.onclose?.();
    }

    close() {}
  }
  const broker = new RealtimeBroker({
    app: { getPath: () => root },
    issueAccessToken: async () => ({ ok: true, token: jwt(), message: "" }),
    createWebSocket: (url) => new FakeSocket(url),
    connectTimeoutMs: 100,
    heartbeatTimeoutMs: 0,
    acceptanceTimeoutMs: 500,
  });
  t.after(() => {
    broker.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { broker, sockets, token: jwt() };
}

test("realtime connection identity excludes token rotation claims and normalizes endpoint", () => {
  const first = jwt({ exp: 100, jti: "one" });
  const second = jwt({ exp: 200, jti: "two" });
  assert.equal(
    createAgentPlatformIdentitySessionId(first, "device-1"),
    createAgentPlatformIdentitySessionId(second, "device-1"),
  );
  assert.notEqual(
    createAgentPlatformIdentitySessionId(first, "device-1"),
    createAgentPlatformIdentitySessionId(jwt({ sid: "different" }), "device-1"),
  );
  assert.equal(normalizeAgentPlatformRealtimeEndpoint("HTTP://127.0.0.1:11789///?token=never-keyed"), "http://127.0.0.1:11789");
});

test("RealtimeBroker multiplexes concurrent Runs and local request ids over one physical socket", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const firstEvents = [];
  const secondEvents = [];
  const first = broker.query({
    baseUrl: "http://127.0.0.1:11789",
    token,
    id: "same-local-id",
    runId: "run-1",
    chatId: "chat-1",
    payload: { marker: "run-1", prompt: "redacted by diagnostics" },
    onEvent: (event) => firstEvents.push(event),
  });
  const second = broker.query({
    baseUrl: "http://127.0.0.1:11789",
    token,
    id: "same-local-id",
    runId: "run-2",
    chatId: "chat-2",
    payload: { marker: "run-2", prompt: "another" },
    onEvent: (event) => secondEvents.push(event),
  });
  await nextTurn();

  assert.equal(sockets.length, 1);
  const queries = sockets[0].sent.filter((frame) => frame.type === "/api/query");
  assert.equal(queries.length, 2);
  assert.notEqual(queries[0].id, queries[1].id);
  const byRun = new Map(queries.map((frame) => [frame.payload.marker, frame]));
  sockets[0].emit({ frame: "stream", id: byRun.get("run-2").id, event: {
    type: "run.start", timestamp: EPOCH_MS, seq: 1, runId: "run-2", chatId: "chat-2", agentKey: "zenmi",
  }});
  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, event: {
    type: "run.start", timestamp: EPOCH_MS + 1, seq: 1, runId: "run-1", chatId: "chat-1", agentKey: "coder",
  }});
  assert.deepEqual(await first.accepted, { agentKey: "coder" });
  assert.deepEqual(await second.accepted, { agentKey: "zenmi" });
  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, event: {
    type: "run.start", timestamp: EPOCH_MS + 2, seq: 1, runId: "run-1", chatId: "chat-1", agentKey: "coder",
  }});
  await nextTurn();
  assert.deepEqual(firstEvents.map((event) => event.runId), ["run-1"]);
  assert.deepEqual(secondEvents.map((event) => event.runId), ["run-2"]);

  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, reason: "complete", lastSeq: 1 });
  sockets[0].emit({ frame: "stream", id: byRun.get("run-2").id, reason: "complete", lastSeq: 1 });
  assert.equal((await first.completed).reason, "complete");
  assert.equal((await second.completed).reason, "complete");
  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, reason: "complete", lastSeq: 1 });
  await nextTurn();
  assert.equal(broker.getDiagnostics().connection.physicalConnectionCount, 1);
  assert.equal(broker.getDiagnostics().seqRegressionCount, 1);
  assert.equal(broker.getDiagnostics().duplicateTerminalCount, 1);
});

test("RealtimeBroker singleflights attach and strictly pairs rewritten response ids", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const firstEvents = [];
  const secondEvents = [];
  broker.subscribeRun({
    baseUrl: "http://127.0.0.1:11789", token, runId: "run-shared", chatId: "chat-shared",
    kind: "surface", consumerId: "surface-1", onEvent: (event) => firstEvents.push(event),
  });
  broker.subscribeRun({
    baseUrl: "http://127.0.0.1:11789", token, runId: "run-shared", chatId: "chat-shared",
    kind: "internal", consumerId: "pet", onEvent: (event) => secondEvents.push(event),
  });
  await nextTurn();
  const attaches = sockets[0].sent.filter((frame) => frame.type === "/api/attach");
  assert.equal(attaches.length, 1);
  sockets[0].emit({ frame: "stream", id: attaches[0].id, event: {
    type: "assistant.delta", timestamp: EPOCH_MS, seq: 1, runId: "run-shared", chatId: "chat-shared",
  }});
  await nextTurn();
  assert.equal(firstEvents.length, 1);
  assert.equal(secondEvents.length, 1);

  const paired = [];
  const errors = [];
  await Promise.all([
    broker.forwardRequest({
      baseUrl: "http://127.0.0.1:11789", token, localId: "collision", consumerId: "one",
      type: "/api/one", onFrame: (frame) => paired.push(["one", frame.id]), onError: (error) => errors.push(error),
    }),
    broker.forwardRequest({
      baseUrl: "http://127.0.0.1:11789", token, localId: "collision", consumerId: "two",
      type: "/api/two", onFrame: (frame) => paired.push(["two", frame.id]), onError: (error) => errors.push(error),
    }),
  ]);
  const requests = sockets[0].sent.filter((frame) => frame.type === "/api/one" || frame.type === "/api/two");
  assert.notEqual(requests[0].id, requests[1].id);
  const one = requests.find((frame) => frame.type === "/api/one");
  const two = requests.find((frame) => frame.type === "/api/two");
  sockets[0].emit({ frame: "response", id: two.id, type: two.type, code: 0, data: {} });
  sockets[0].emit({ frame: "response", id: one.id, type: one.type, code: 0, data: {} });
  await nextTurn();
  assert.deepEqual(paired, [["two", "collision"], ["one", "collision"]]);
  assert.deepEqual(errors, []);
});

test("RealtimeBroker reports seq_expired instead of fabricating an evicted replay prefix", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const subscription = broker.subscribeRun({
    baseUrl: "http://127.0.0.1:11789", token, runId: "run-replay", chatId: "chat-replay",
    kind: "internal", consumerId: "first", onEvent: () => {},
  });
  await subscription.ready;
  const attach = sockets[0].sent.find((frame) => frame.type === "/api/attach");
  for (let seq = 1; seq <= 2_002; seq += 1) {
    sockets[0].emit({ frame: "stream", id: attach.id, event: {
      type: "assistant.delta", timestamp: EPOCH_MS + seq, seq,
      runId: "run-replay", chatId: "chat-replay", content: "x",
    }});
  }
  await nextTurn();
  subscription.unsubscribe();
  assert.throws(() => broker.subscribeRun({
    baseUrl: "http://127.0.0.1:11789", token, runId: "run-replay", chatId: "chat-replay", lastSeq: 0,
    kind: "surface", consumerId: "late", onEvent: () => {},
  }), /seq_expired/);
  const replay = broker.getDiagnostics().replay.find((entry) => entry.runId === "run-replay");
  assert.equal(replay.eventCount, 2_000);
  assert.equal(broker.getDiagnostics().replayEvictionCount, 2);
});

test("RealtimeBroker restores an accepted Run with attach(lastSeq) and never resends query", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const handle = broker.query({
    baseUrl: "http://127.0.0.1:11789", token, id: "operation-1", runId: "run-recover", chatId: "chat-recover",
    payload: {}, onEvent: () => {},
  });
  await nextTurn();
  const query = sockets[0].sent.find((frame) => frame.type === "/api/query");
  sockets[0].emit({ frame: "stream", id: query.id, event: {
    type: "run.start", timestamp: EPOCH_MS, seq: 1, runId: "run-recover", chatId: "chat-recover", agentKey: "coder",
  }});
  await handle.accepted;
  sockets[0].emit({ frame: "stream", id: query.id, event: {
    type: "assistant.delta", timestamp: EPOCH_MS + 1, seq: 3, runId: "run-recover", chatId: "chat-recover",
  }});
  await nextTurn();
  sockets[0].disconnect();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(sockets.length, 2);
  const restored = sockets[1].sent.find((frame) => frame.type === "/api/attach");
  assert.deepEqual(restored.payload, { runId: "run-recover", chatId: "chat-recover", lastSeq: 3, agentKey: "coder" });
  assert.equal(sockets[1].sent.some((frame) => frame.type === "/api/query"), false);
  assert.equal(broker.getDiagnostics().seqGapCount, 1);
});

test("RealtimeBroker closes the old identity generation before starting work for a new identity", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const first = broker.query({
    baseUrl: "http://127.0.0.1:11789", token, id: "identity-one", runId: "run-one", chatId: "chat-one",
    payload: {}, onEvent: () => {},
  });
  await nextTurn();
  const firstQuery = sockets[0].sent.find((frame) => frame.type === "/api/query");
  sockets[0].emit({ frame: "stream", id: firstQuery.id, event: {
    type: "run.start", timestamp: EPOCH_MS, seq: 1, runId: "run-one", chatId: "chat-one", agentKey: "coder",
  }});
  await first.accepted;

  const second = broker.query({
    baseUrl: "http://127.0.0.1:11789", token: jwt({ sid: "new-session" }),
    id: "identity-two", runId: "run-two", chatId: "chat-two", payload: {}, onEvent: () => {},
  });
  await assert.rejects(first.completed, /identity was invalidated/);
  sockets[0].emit({ frame: "push", type: "chat.updated", data: { chatId: "stale" } });
  await nextTurn();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].sent.some((frame) => frame.type === "/api/attach"), false);
  assert.equal(broker.getDiagnostics().staleFrameCount, 1);
  const secondQuery = sockets[1].sent.find((frame) => frame.type === "/api/query");
  assert.ok(secondQuery);
  sockets[1].emit({ frame: "stream", id: secondQuery.id, event: {
    type: "run.start", timestamp: EPOCH_MS + 1, seq: 1, runId: "run-two", chatId: "chat-two", agentKey: "coder",
  }});
  await second.accepted;
  sockets[1].emit({ frame: "stream", id: secondQuery.id, reason: "complete", lastSeq: 1 });
  assert.equal((await second.completed).reason, "complete");
});
