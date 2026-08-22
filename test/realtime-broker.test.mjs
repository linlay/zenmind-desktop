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

function createHarness(t, options = {}) {
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
      queueMicrotask(() => {
        this.onopen?.();
        if (options.autoHandshake === false) return;
        this.emit({
          frame: "push",
          type: "connected",
          data: {
            protocolVersion: 2,
            sessionId: `platform-${sockets.length}`,
            serverTime: EPOCH_MS,
            liveness: { heartbeatIntervalMs: 30_000, silenceTimeoutMs: 100_000 },
          },
        });
      });
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
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 0,
    acceptanceTimeoutMs: 500,
  });
  t.after(() => {
    broker.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { broker, sockets, token: jwt() };
}

test("physical realtime connection waits for the Platform v2 handshake", async (t) => {
  const { broker, sockets, token } = createHarness(t, { autoHandshake: false });
  const connecting = broker.ensureConnected("http://127.0.0.1:8080", token);
  await nextTurn();
  assert.equal(broker.getConnectionState().phase, "connecting");
  assert.equal(sockets.length, 1);

  sockets[0].emit({
    frame: "push",
    type: "connected",
    data: {
      protocolVersion: 2,
      sessionId: "platform-handshake-1",
      serverTime: EPOCH_MS,
      liveness: { heartbeatIntervalMs: 30_000, silenceTimeoutMs: 100_000 },
    },
  });
  await connecting;
  assert.deepEqual(
    {
      phase: broker.getConnectionState().phase,
      sessionId: broker.getConnectionState().physicalSessionId,
    },
    { phase: "connected", sessionId: "platform-handshake-1" },
  );
});

test("valid heartbeat and business frames continuously refresh physical liveness", async (t) => {
  const { broker, sockets, token } = createHarness(t, { heartbeatTimeoutMs: 35 });
  await broker.ensureConnected("http://127.0.0.1:8080", token);
  await new Promise((resolve) => setTimeout(resolve, 20));
  sockets[0].emit({
    frame: "push",
    type: "heartbeat",
    data: { sessionId: "platform-1", sequence: 1, timestamp: EPOCH_MS + 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  sockets[0].emit({ frame: "push", type: "run.updated", data: { runId: "run-1" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const state = broker.getConnectionState();
  assert.equal(state.phase, "connected");
  assert.equal(state.physicalSessionId, "platform-1");
  assert.ok(state.lastInboundAt >= state.lastHeartbeatAt);
  assert.equal(sockets.length, 1);
});

test("non-monotonic protocol-v2 heartbeat closes without retrying the incompatible connection", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  await broker.ensureConnected("http://127.0.0.1:8080", token);
  sockets[0].emit({
    frame: "push",
    type: "heartbeat",
    data: { sessionId: "platform-1", sequence: 2, timestamp: EPOCH_MS + 2 },
  });
  sockets[0].emit({
    frame: "push",
    type: "heartbeat",
    data: { sessionId: "platform-1", sequence: 2, timestamp: EPOCH_MS + 3 },
  });
  await nextTurn();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(broker.getConnectionState().phase, "closed");
  assert.match(broker.getConnectionState().lastError, /PLATFORM_WS_PROTOCOL_MISMATCH/u);
  assert.equal(sockets.length, 1);
});

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
    owner: { kind: "agent", agentKey: "coder" },
    payload: { marker: "run-1", prompt: "redacted by diagnostics" },
    onEvent: (event) => firstEvents.push(event),
  });
  const second = broker.query({
    baseUrl: "http://127.0.0.1:11789",
    token,
    id: "same-local-id",
    owner: { kind: "team", teamId: "research" },
    payload: { marker: "run-2", prompt: "another" },
    onEvent: (event) => secondEvents.push(event),
  });
  await nextTurn();

  assert.equal(sockets.length, 1);
  const queries = sockets[0].sent.filter((frame) => frame.type === "/api/query");
  assert.equal(queries.length, 2);
  assert.notEqual(queries[0].id, queries[1].id);
  const byRun = new Map(queries.map((frame) => [frame.payload.marker, frame]));
  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, event: {
    type: "chat.start", timestamp: EPOCH_MS, seq: 1, chatId: "chat-1",
  }});
  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, event: {
    type: "request.query", timestamp: EPOCH_MS + 1, seq: 2, chatId: "chat-1", runId: "run-1",
  }});
  sockets[0].emit({ frame: "stream", id: byRun.get("run-2").id, event: {
    type: "run.start", timestamp: EPOCH_MS, seq: 1, runId: "run-2", chatId: "chat-2", teamId: "research",
  }});
  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, event: {
    type: "run.start", timestamp: EPOCH_MS + 2, seq: 3, runId: "run-1", chatId: "chat-1", agentKey: "coder",
  }});
  assert.deepEqual(await first.accepted, {
    chatId: "chat-1", runId: "run-1", owner: { kind: "agent", agentKey: "coder" },
  });
  assert.deepEqual(await second.accepted, {
    chatId: "chat-2", runId: "run-2", owner: { kind: "team", teamId: "research" },
  });
  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, event: {
    type: "run.start", timestamp: EPOCH_MS + 3, seq: 3, runId: "run-1", chatId: "chat-1", agentKey: "coder",
  }});
  await nextTurn();
  assert.deepEqual(firstEvents.map((event) => event.type), ["chat.start", "request.query", "run.start"]);
  assert.deepEqual(secondEvents.map((event) => event.runId), ["run-2"]);

  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, reason: "complete", lastSeq: 3 });
  sockets[0].emit({ frame: "stream", id: byRun.get("run-2").id, reason: "complete", lastSeq: 1 });
  assert.equal((await first.completed).reason, "complete");
  assert.equal((await second.completed).reason, "complete");
  sockets[0].emit({ frame: "stream", id: byRun.get("run-1").id, reason: "complete", lastSeq: 1 });
  await nextTurn();
  assert.equal(broker.getDiagnostics().connection.physicalConnectionCount, 1);
  assert.equal(broker.getDiagnostics().seqRegressionCount, 1);
  assert.equal(broker.getDiagnostics().duplicateTerminalCount, 1);
  assert.ok(broker.getDebugTraceEntries().some((entry) =>
    entry.layer === "platform-ws" &&
    entry.direction === "desktop-to-platform" &&
    entry.data.type === "/api/query",
  ));
  assert.ok(broker.getDebugTraceEntries().some((entry) =>
    entry.layer === "platform-ws" &&
    entry.direction === "platform-to-desktop" &&
    entry.data.frame === "stream",
  ));

  broker.appendDebugTrace({
    layer: "surface-bridge",
    direction: "surface-to-desktop",
    surfaceId: "main-chat",
    data: {
      token: "must-not-leak",
      nested: { authorization: "Bearer must-not-leak" },
      url: "https://example.test/path?access_token=must-not-leak&visible=1",
    },
  });
  const redacted = broker.getDebugTraceEntries().at(-1);
  assert.equal(redacted.data.token, "<REDACTED>");
  assert.equal(redacted.data.nested.authorization, "<REDACTED>");
  assert.match(redacted.data.url, /access_token=<REDACTED>/u);
  assert.equal(JSON.stringify(redacted).includes("must-not-leak"), false);
  broker.clearDebugTrace();
  assert.deepEqual(broker.getDebugTraceEntries(), []);
});

test("RealtimeBroker locally fans one Run out to Agent, Copilot, Overview and Debug", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:11789",
    token,
    id: "primary-agent-query",
    owner: { kind: "agent", agentKey: "coder" },
    payload: { prompt: "fan out" },
    onEvent() {},
  });
  await nextTurn();
  const upstreamQuery = sockets[0].sent.find((frame) => frame.type === "/api/query");
  sockets[0].emit({ frame: "stream", id: upstreamQuery.id, event: {
    type: "run.start", timestamp: EPOCH_MS, seq: 1,
    chatId: "chat-shared", runId: "run-shared", agentKey: "coder",
  }});
  await query.accepted;

  const observed = new Map();
  const subscriptions = ["agent", "copilot", "overview", "debug"].map((surface) => {
    observed.set(surface, []);
    return broker.subscribeRun({
      baseUrl: "http://127.0.0.1:11789",
      token,
      chatId: "chat-shared",
      runId: "run-shared",
      kind: "surface",
      consumerId: `surface-${surface}`,
      onEvent: (event) => observed.get(surface).push(event.type),
    });
  });
  await nextTurn();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "/api/attach").length, 0);

  sockets[0].emit({ frame: "stream", id: upstreamQuery.id, event: {
    type: "assistant.delta", timestamp: EPOCH_MS + 1, seq: 2,
    chatId: "chat-shared", runId: "run-shared", delta: "hello",
  }});
  await nextTurn();
  for (const surface of observed.keys()) {
    assert.deepEqual(observed.get(surface), ["run.start", "assistant.delta"], surface);
  }
  assert.equal(broker.getDiagnostics().connection.physicalConnectionCount, 1);

  sockets[0].emit({ frame: "stream", id: upstreamQuery.id, reason: "complete", lastSeq: 2 });
  await query.completed;
  for (const subscription of subscriptions) subscription.unsubscribe();
});

test("RealtimeBroker replays and fans out a forwarded visible Run without upstream attach", async (t) => {
  const { broker, sockets } = createHarness(t);
  broker.beginForwardedVisibleRun({
    sourceId: "frame-port:main:query-1",
    chatId: "chat-visible",
    runId: "run-visible",
    owner: { kind: "agent", agentKey: "coder" },
    primarySurfaceId: "surface:main",
  });
  broker.appendForwardedVisibleRunEvent({
    sourceId: "frame-port:main:query-1",
    runId: "run-visible",
    event: {
      type: "run.start", timestamp: EPOCH_MS, seq: 1,
      chatId: "chat-visible", runId: "run-visible", agentKey: "coder",
    },
  });

  const overviewEvents = [];
  const debugEvents = [];
  const completed = [];
  const overview = broker.subscribeVisibleRun({
    chatId: "chat-visible",
    runId: "run-visible",
    lastSeq: 0,
    owner: { kind: "agent", agentKey: "coder" },
    kind: "surface",
    consumerId: "overview-consumer",
    surfaceId: "surface:overview",
    onEvent: (event) => overviewEvents.push(event.type),
    onComplete: (result) => completed.push(result.reason),
  });
  const debug = broker.subscribeVisibleRun({
    chatId: "chat-visible",
    runId: "run-visible",
    lastSeq: 1,
    kind: "surface",
    consumerId: "debug-consumer",
    surfaceId: "surface:debug",
    onEvent: (event) => debugEvents.push(event.type),
  });
  await Promise.all([overview.ready, debug.ready]);

  broker.appendForwardedVisibleRunEvent({
    sourceId: "frame-port:main:query-1",
    runId: "run-visible",
    event: {
      type: "content.delta", timestamp: EPOCH_MS + 1, seq: 2,
      chatId: "chat-visible", runId: "run-visible", delta: "hello",
    },
  });
  assert.deepEqual(overviewEvents, ["run.start", "content.delta"]);
  assert.deepEqual(debugEvents, ["content.delta"]);
  assert.equal(sockets.length, 0);
  assert.equal(broker.getDiagnostics().visibleBinding.consumerCount, 3);

  assert.equal(broker.completeForwardedVisibleRun({
    sourceId: "frame-port:main:query-1",
    runId: "run-visible",
    reason: "complete",
    lastSeq: 2,
  }), true);
  assert.deepEqual(completed, ["complete"]);
  assert.equal(broker.getVisibleBinding(), null);
  overview.unsubscribe();
  debug.unsubscribe();
});

test("RealtimeBroker hands an internal observer to Main Chat without treating detached as Run completion", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const owner = { kind: "agent", agentKey: "coder" };
  const internalEvents = [];
  const completed = [];
  const internal = broker.subscribeRun({
    baseUrl: "http://127.0.0.1:11789",
    token,
    chatId: "chat-handoff",
    runId: "run-handoff",
    owner,
    kind: "internal",
    consumerId: "desktop-pet-stream:run-handoff",
    onEvent: (event) => internalEvents.push(event.type),
    onComplete: (result) => completed.push(result.reason),
  });
  await internal.ready;
  const brokerAttach = sockets[0].sent.find((frame) => frame.type === "/api/attach");
  assert.ok(brokerAttach);

  assert.equal(await broker.prepareForwardedVisibleRun({
    baseUrl: "http://127.0.0.1:11789",
    token,
    chatId: "chat-handoff",
    runId: "run-handoff",
    owner,
  }), true);
  broker.beginForwardedVisibleRun({
    sourceId: "main-chat:attach-handoff",
    chatId: "chat-handoff",
    runId: "run-handoff",
    owner,
    primarySurfaceId: "surface:main-chat",
  });
  await broker.forwardRequest({
    baseUrl: "http://127.0.0.1:11789",
    token,
    localId: "main-attach-handoff",
    consumerId: "frame-port:main-chat",
    type: "/api/attach",
    payload: { runId: "run-handoff", agentKey: "coder", lastSeq: 0 },
    stream: true,
    onFrame() {},
    onError() {},
  });
  assert.deepEqual(
    sockets[0].sent.filter((frame) => ["/api/attach", "/api/detach"].includes(frame.type)).map((frame) => frame.type),
    ["/api/attach", "/api/detach", "/api/attach"],
  );

  sockets[0].emit({
    frame: "stream",
    id: brokerAttach.id,
    reason: "detached",
    lastSeq: 0,
  });
  await nextTurn();
  broker.appendForwardedVisibleRunEvent({
    sourceId: "main-chat:attach-handoff",
    runId: "run-handoff",
    event: {
      type: "content.delta",
      timestamp: EPOCH_MS,
      seq: 1,
      chatId: "chat-handoff",
      runId: "run-handoff",
      delta: "still running",
    },
  });
  assert.deepEqual(internalEvents, ["content.delta"]);
  assert.deepEqual(completed, []);
  assert.equal(broker.getDiagnostics().observerReleaseCount, 1);
  assert.equal(broker.getDiagnostics().replay.find((run) => run.runId === "run-handoff").state, "active");
  assert.equal(broker.getDiagnostics().replay.find((run) => run.runId === "run-handoff").observerSource, "forwarded");

  const mirrored = broker.subscribeRun({
    baseUrl: "http://127.0.0.1:11789",
    token,
    chatId: "chat-handoff",
    runId: "run-handoff",
    owner,
    kind: "internal",
    consumerId: "second-internal",
    onEvent() {},
  });
  await mirrored.ready;
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "/api/attach").length, 2);

  assert.equal(broker.completeForwardedVisibleRun({
    sourceId: "main-chat:attach-handoff",
    runId: "run-handoff",
    reason: "done",
    lastSeq: 1,
  }), true);
  assert.deepEqual(completed, ["done"]);
  assert.throws(
    () => broker.beginForwardedVisibleRun({
      sourceId: "main-chat:retry-after-done",
      chatId: "chat-handoff",
      runId: "run-handoff",
      owner,
      primarySurfaceId: "surface:main-chat",
    }),
    (error) => {
      assert.equal(error.name, "target_unavailable");
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, {
        stage: "broker_visible_registration",
        reason: "run_registry_terminal",
        terminalSource: "forwarded_stream",
        terminalReason: "done",
        hasUpstreamObserver: false,
        hasForwardedSource: false,
      });
      return true;
    },
  );
  internal.unsubscribe();
  mirrored.unsubscribe();
});

test("RealtimeBroker explains why a requested visible Run cannot be subscribed", (t) => {
  const { broker } = createHarness(t);
  assert.throws(
    () => broker.subscribeVisibleRun({
      chatId: "chat-missing",
      runId: "run-missing",
      kind: "surface",
      consumerId: "overview-missing",
      surfaceId: "surface:overview",
      onEvent() {},
    }),
    (error) => {
      assert.equal(error.name, "target_unavailable");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, {
        stage: "broker_subscribe",
        reason: "visible_binding_missing",
        visibleBindingPresent: false,
        runRegistered: false,
      });
      return true;
    },
  );

  broker.beginForwardedVisibleRun({
    sourceId: "frame-port:main:query-present",
    chatId: "chat-present",
    runId: "run-present",
    owner: { kind: "agent", agentKey: "coder" },
    primarySurfaceId: "surface:main",
  });
  assert.throws(
    () => broker.subscribeVisibleRun({
      chatId: "chat-requested",
      runId: "run-requested",
      kind: "surface",
      consumerId: "overview-mismatch",
      surfaceId: "surface:overview",
      onEvent() {},
    }),
    (error) => {
      assert.equal(error.name, "target_unavailable");
      assert.equal(error.retryable, true);
      assert.equal(error.details.stage, "broker_subscribe");
      assert.equal(error.details.reason, "visible_binding_identity_mismatch");
      assert.equal(error.details.visibleBindingPresent, true);
      assert.equal(error.details.runRegistered, false);
      assert.equal(typeof error.details.bindingEpoch, "number");
      assert.equal(JSON.stringify(error.details).includes("chat-present"), false);
      assert.equal(JSON.stringify(error.details).includes("run-present"), false);
      return true;
    },
  );
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
  let expiredError;
  assert.throws(() => broker.subscribeRun({
    baseUrl: "http://127.0.0.1:11789", token, runId: "run-replay", chatId: "chat-replay", lastSeq: 0,
    kind: "surface", consumerId: "late", onEvent: () => {},
  }), (error) => {
    expiredError = error;
    return /seq_expired/.test(error.message);
  });
  const replay = broker.getDiagnostics().replay.find((entry) => entry.runId === "run-replay");
  assert.equal(replay.eventCount, 2_000);
  assert.equal(broker.getDiagnostics().replayEvictionCount, 2);
  assert.equal(expiredError.retryable, true);
  assert.deepEqual(expiredError.details, {
    requestedLastSeq: 0,
    firstAvailableSeq: 3,
    latestSeq: 2_002,
    replayEventCount: 2_000,
    replayBytes: replay.bytes,
  });
});

test("RealtimeBroker restores an accepted Run with attach(lastSeq) and never resends query", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const handle = broker.query({
    baseUrl: "http://127.0.0.1:11789", token, id: "operation-1", runId: "run-recover", chatId: "chat-recover",
    owner: { kind: "agent", agentKey: "coder" },
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
    owner: { kind: "agent", agentKey: "coder" },
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
    id: "identity-two", runId: "run-two", chatId: "chat-two",
    owner: { kind: "agent", agentKey: "coder" }, payload: {}, onEvent: () => {},
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

test("RealtimeBroker dispatches reverse Desktop Action and maps provider failures", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const calls = [];
  broker.setDesktopBridgeProvider({
    action: async (request) => {
      calls.push(request);
      return request.action === "desktop.theme.get"
        ? { ok: true, action: request.action, result: { theme: "dark" } }
        : { ok: false, action: request.action, error: { code: "unknown_action", message: "unknown" } };
    },
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
  });
  await broker.ensureConnected("http://127.0.0.1:11789", token);

  sockets[0].emit({
    frame: "request",
    type: "desktop.action.call",
    id: "desktop-action-ok",
    payload: { requestId: "action-1", action: "desktop.theme.get", args: {}, source: { chatId: "chat-1" } },
  });
  sockets[0].emit({
    frame: "request",
    type: "desktop.action.call",
    id: "desktop-action-error",
    payload: { requestId: "action-2", action: "desktop.missing", args: {}, source: { chatId: "chat-1" } },
  });
  await nextTurn();

  assert.equal(calls.length, 2);
  assert.deepEqual(sockets[0].sent.find((frame) => frame.id === "desktop-action-ok"), {
    frame: "response",
    type: "desktop.action.call",
    id: "desktop-action-ok",
    code: 0,
    msg: "success",
    data: { ok: true, action: "desktop.theme.get", result: { theme: "dark" } },
  });
  assert.deepEqual(sockets[0].sent.find((frame) => frame.id === "desktop-action-error"), {
    frame: "error",
    type: "unknown_action",
    id: "desktop-action-error",
    code: 400,
    msg: "unknown",
    data: { ok: false, action: "desktop.missing", error: { code: "unknown_action", message: "unknown" } },
  });

  sockets[0].emit({
    frame: "request",
    type: "desktop.action.call",
    id: "desktop-action-ok",
    payload: { requestId: "action-1", action: "desktop.theme.get", args: {}, source: { chatId: "chat-1" } },
  });
  await nextTurn();
  assert.equal(calls.length, 2);
  assert.deepEqual(sockets[0].sent.filter((frame) => frame.id === "desktop-action-ok").at(-1), {
    frame: "error",
    type: "duplicate_id",
    id: "desktop-action-ok",
    code: 409,
    msg: "Desktop bridge request id was already used",
  });
});

test("RealtimeBroker waits for a forwarded canonical Chat grant before WorkPanel actions", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const calls = [];
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  broker.registerForwardedRunActionGrant({
    sourceId: "main-chat:query-1",
    chatId: "chat-ready",
    runId: "run-ready",
    owner: { kind: "agent", agentKey: "coder" },
    ready,
  });
  broker.setDesktopBridgeProvider({
    action: async (request) => {
      calls.push(request);
      return { ok: true, action: request.action, result: { workspaceId: "workpanel:chat-ready" } };
    },
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
  });
  await broker.ensureConnected("http://127.0.0.1:11789", token);

  sockets[0].emit({
    frame: "request",
    type: "desktop.action.call",
    id: "workpanel-before-ready",
    payload: {
      action: "desktop.workpanel.openWeb",
      args: { url: "https://example.test/document" },
      source: { chatId: "chat-ready", runId: "run-ready", agentKey: "coder" },
    },
  });
  await nextTurn();
  assert.equal(calls.length, 0);

  releaseReady();
  await nextTurn();
  assert.equal(calls.length, 1);
  assert.equal(
    sockets[0].sent.find((frame) => frame.id === "workpanel-before-ready")?.frame,
    "response",
  );
});

test("RealtimeBroker fails WorkPanel closed when canonical Chat synchronization failed", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const calls = [];
  const rejected = Promise.reject(new Error("surface registration rejected"));
  rejected.catch(() => undefined);
  broker.registerForwardedRunActionGrant({
    sourceId: "main-chat:query-failed",
    chatId: "chat-failed",
    runId: "run-failed",
    owner: { kind: "agent", agentKey: "coder" },
    ready: rejected,
  });
  broker.setDesktopBridgeProvider({
    action: async (request) => {
      calls.push(request);
      return { ok: true, action: request.action, result: {} };
    },
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
  });
  await broker.ensureConnected("http://127.0.0.1:11789", token);
  sockets[0].emit({
    frame: "request",
    type: "desktop.action.call",
    id: "workpanel-sync-failed",
    payload: {
      action: "desktop.workpanel.openWeb",
      args: { url: "https://example.test/document" },
      source: { chatId: "chat-failed", runId: "run-failed", agentKey: "coder" },
    },
  });
  await nextTurn();
  assert.equal(calls.length, 0);
  assert.deepEqual(sockets[0].sent.find((frame) => frame.id === "workpanel-sync-failed"), {
    frame: "error",
    type: "source_chat_not_ready",
    id: "workpanel-sync-failed",
    code: 409,
    msg: "source_chat_not_ready: surface registration rejected",
    data: { retryable: false, details: { recovery: "reattach_source_chat" } },
  });
});

test("RealtimeBroker keeps a WorkPanel grant after the visible observer detaches", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const calls = [];
  const owner = { kind: "agent", agentKey: "coder" };
  broker.beginForwardedVisibleRun({
    sourceId: "main-chat:query-background",
    chatId: "chat-background",
    runId: "run-background",
    owner,
    primarySurfaceId: "surface:main-chat",
  });
  broker.registerForwardedRunActionGrant({
    sourceId: "main-chat:query-background",
    chatId: "chat-background",
    runId: "run-background",
    owner,
    ready: Promise.resolve(),
  });
  assert.equal(broker.releaseForwardedVisibleRun("main-chat:query-background"), true);
  broker.setDesktopBridgeProvider({
    action: async (request) => {
      calls.push(request);
      return { ok: true, action: request.action, result: { workspaceId: "workpanel:chat-background" } };
    },
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
  });
  await broker.ensureConnected("http://127.0.0.1:11789", token);

  sockets[0].emit({
    frame: "request",
    type: "desktop.action.call",
    id: "workpanel-after-detach",
    payload: {
      action: "desktop.workpanel.openWeb",
      args: { url: "https://example.test/background" },
      source: { chatId: "chat-background", runId: "run-background", agentKey: "coder" },
    },
  });
  await nextTurn();

  assert.equal(calls.length, 1);
  assert.equal(sockets[0].sent.find((frame) => frame.id === "workpanel-after-detach")?.frame, "response");

  sockets[0].emit({
    frame: "request",
    type: "desktop.action.call",
    id: "workpanel-wrong-owner",
    payload: {
      action: "desktop.workpanel.openWeb",
      args: { url: "https://example.test/forged" },
      source: { chatId: "chat-background", runId: "run-background", agentKey: "other-agent" },
    },
  });
  await nextTurn();
  assert.equal(calls.length, 1);
  assert.equal(sockets[0].sent.find((frame) => frame.id === "workpanel-wrong-owner")?.type, "protocol_error");
});

test("RealtimeBroker lets a canonical reattach replace a stale WorkPanel grant attempt", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const calls = [];
  const owner = { kind: "agent", agentKey: "coder" };
  let rejectStale;
  const staleReady = new Promise((_, reject) => { rejectStale = reject; });
  broker.registerForwardedRunActionGrant({
    sourceId: "main-chat:query-stale",
    chatId: "chat-recovered",
    runId: "run-recovered",
    owner,
    ready: staleReady,
  });
  broker.setDesktopBridgeProvider({
    action: async (request) => {
      calls.push(request);
      return { ok: true, action: request.action, result: {} };
    },
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
  });
  await broker.ensureConnected("http://127.0.0.1:11789", token);
  sockets[0].emit({
    frame: "request",
    type: "desktop.action.call",
    id: "workpanel-after-reattach",
    payload: {
      action: "desktop.workpanel.openWeb",
      args: { url: "https://example.test/recovered" },
      source: { chatId: "chat-recovered", runId: "run-recovered", agentKey: "coder" },
    },
  });
  await nextTurn();
  assert.equal(calls.length, 0);

  broker.registerForwardedRunActionGrant({
    sourceId: "main-chat:attach-recovered",
    chatId: "chat-recovered",
    runId: "run-recovered",
    owner,
    ready: Promise.resolve(),
  });
  await nextTurn();
  rejectStale(new Error("stale source finished late"));
  await nextTurn();

  assert.equal(calls.length, 1);
  assert.equal(sockets[0].sent.find((frame) => frame.id === "workpanel-after-reattach")?.frame, "response");
});

test("RealtimeBroker revokes a background WorkPanel grant at the forwarded Run terminal", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const owner = { kind: "agent", agentKey: "coder" };
  broker.beginForwardedVisibleRun({
    sourceId: "main-chat:query-terminal",
    chatId: "chat-terminal",
    runId: "run-terminal",
    owner,
    primarySurfaceId: "surface:main-chat",
  });
  broker.registerForwardedRunActionGrant({
    sourceId: "main-chat:query-terminal",
    chatId: "chat-terminal",
    runId: "run-terminal",
    owner,
    ready: Promise.resolve(),
  });
  broker.releaseForwardedVisibleRun("main-chat:query-terminal");
  broker.setDesktopBridgeProvider({
    action: async (request) => ({ ok: true, action: request.action, result: {} }),
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
  });
  await broker.ensureConnected("http://127.0.0.1:11789", token);
  sockets[0].emit({
    frame: "push",
    type: "run.finished",
    data: {
      runId: "run-terminal",
      chatId: "chat-terminal",
      status: "completed",
      finishReason: "complete",
      finishedAt: EPOCH_MS,
    },
  });
  sockets[0].emit({
    frame: "request",
    type: "desktop.action.call",
    id: "workpanel-after-terminal",
    payload: {
      action: "desktop.workpanel.openWeb",
      args: { url: "https://example.test/terminal" },
      source: { chatId: "chat-terminal", runId: "run-terminal", agentKey: "coder" },
    },
  });
  await nextTurn();

  const terminal = sockets[0].sent.find((frame) => frame.id === "workpanel-after-terminal");
  assert.equal(terminal?.frame, "error");
  assert.equal(terminal?.type, "source_chat_not_ready");
  assert.equal(terminal?.data?.retryable, false);
});

test("RealtimeBroker chunks large Desktop JSON and screenshot responses below 256 KiB", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  const screenshot = Buffer.alloc(420_000, 7).toString("base64");
  broker.setDesktopBridgeProvider({
    action: async (request) => ({ ok: true, action: request.action, result: { text: "x".repeat(420_000) } }),
    cdp: async (request) => ({ ok: true, method: request.method, result: { data: screenshot } }),
  });
  await broker.ensureConnected("http://127.0.0.1:11789", token);

  sockets[0].emit({
    frame: "request", type: "desktop.action.call", id: "large-json",
    payload: { action: "desktop.controlCenter.readServiceLog", args: {}, source: { chatId: "chat-1" } },
  });
  sockets[0].emit({
    frame: "request", type: "desktop.cdp.call", id: "large-screenshot",
    payload: { method: "Page.captureScreenshot", params: {}, source: { chatId: "chat-1" } },
  });
  for (let index = 0; index < 8; index += 1) await nextTurn();

  for (const id of ["large-json", "large-screenshot"]) {
    const chunks = sockets[0].sent.filter((frame) => frame.frame === "stream" && frame.id === id);
    assert.ok(chunks.length > 1, id);
    assert.deepEqual(chunks.map((frame) => frame.event.seq), chunks.map((_, index) => index + 1));
    assert.ok(chunks.every((frame) => frame.event.chunk.length <= 256 * 1024), id);
    const terminal = sockets[0].sent.find((frame) => frame.frame === "response" && frame.id === id);
    assert.equal(terminal.code, 0);
    assert.equal(terminal.data.streamed ?? terminal.data.result?.data?.streamed, true);
    assert.equal(terminal.data.chunkCount ?? terminal.data.result?.data?.chunkCount, chunks.length);
  }
  assert.equal(
    sockets[0].sent.find((frame) => frame.frame === "stream" && frame.id === "large-json").event.type,
    "desktop.bridge.response.delta",
  );
  assert.equal(
    sockets[0].sent.find((frame) => frame.frame === "stream" && frame.id === "large-screenshot").event.type,
    "desktop.cdp.screenshot.delta",
  );
});

test("RealtimeBroker stops reverse Desktop chunks after desktop.bridge.cancel", async (t) => {
  const { broker, sockets, token } = createHarness(t);
  broker.setDesktopBridgeProvider({
    action: async (request) => ({ ok: true, action: request.action, result: { text: "x".repeat(4_000_000) } }),
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
  });
  await broker.ensureConnected("http://127.0.0.1:11789", token);
  sockets[0].emit({
    frame: "request", type: "desktop.action.call", id: "cancel-large",
    payload: { action: "desktop.controlCenter.readServiceLog", args: {}, source: { chatId: "chat-1" } },
  });
  await nextTurn();
  const chunksBeforeCancel = sockets[0].sent.filter((frame) => frame.frame === "stream" && frame.id === "cancel-large").length;
  assert.ok(chunksBeforeCancel > 0);
  sockets[0].emit({ frame: "push", type: "desktop.bridge.cancel", payload: { requestId: "cancel-large" } });
  for (let index = 0; index < 3; index += 1) await nextTurn();

  const frames = sockets[0].sent.filter((frame) => frame.id === "cancel-large");
  assert.equal(frames.some((frame) => frame.frame === "response" || frame.frame === "error"), false);
  assert.equal(frames.filter((frame) => frame.frame === "stream").length, chunksBeforeCancel);
});
