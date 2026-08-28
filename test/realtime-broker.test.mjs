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

const EPOCH_MS = 1_788_000_000_000;

function jwt(claims = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ iss: "test", sub: "user", sid: "session", ...claims })}.signature`;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-realtime-broker-"));
  const sockets = [];
  const diagnostics = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.source = new URL(url).searchParams.get("source");
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
            sessionId: `${this.source}-${sockets.length}`,
            serverTime: EPOCH_MS,
            liveness: { heartbeatIntervalMs: 30_000, silenceTimeoutMs: 100_000 },
          },
        });
      });
    }

    send(data) { this.sent.push(JSON.parse(data)); }
    emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    disconnect() { this.onclose?.(); }
    close() {}
  }

  const broker = new RealtimeBroker({
    app: { getPath: () => root },
    issueAccessToken: async () => ({ ok: true, token: jwt(), message: "" }),
    createWebSocket: (url) => new FakeSocket(url),
    connectTimeoutMs: 100,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 0,
    acceptanceTimeoutMs: 500,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  t.after(() => {
    broker.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const socket = (lane) => sockets.find((candidate) =>
    candidate.source === (lane === "primary" ? "desktop-main" : "desktop-btw"),
  );
  return { broker, diagnostics, sockets, socket, token: jwt() };
}

function rootObserver(overrides = {}) {
  return {
    token: "main-chat:g1:1:101",
    kind: "main_chat",
    surfaceId: "main-chat",
    generation: "g1",
    contextId: "chat-1",
    webContentsId: 101,
    ...overrides,
  };
}

function runEvent(type, runId, chatId, seq, extra = {}) {
  return {
    type,
    runId,
    chatId,
    agentKey: "agent-1",
    seq,
    timestamp: EPOCH_MS + seq,
    ...extra,
  };
}

function requestOfType(socket, type) {
  return socket.sent.filter((frame) => frame.frame === "request" && frame.type === type);
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
  assert.equal(broker.getConnectionState().physicalSessionId, "platform-handshake-1");
});

test("identity fingerprint ignores token rotation claims and normalizes endpoint", () => {
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
  assert.equal(normalizeAgentPlatformRealtimeEndpoint("HTTP://127.0.0.1:11789///?token=hidden"), "http://127.0.0.1:11789");
});

test("Primary and BTW lanes stay at exactly two physical sockets and multiplex Runs", async (t) => {
  const { broker, sockets, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const received = [];
  const queries = [
    ["primary", "/api/query", "run-main-1"],
    ["primary", "/api/query", "run-main-2"],
    ["btw", "/api/btw", "run-btw-1"],
    ["btw", "/api/btw", "run-btw-2"],
  ].map(([lane, requestType, runId]) => broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    id: `op-${runId}`,
    lane,
    requestType,
    runId,
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    observerToken: observer.token,
    consumerId: `surface:${runId}`,
    payload: { runId, chatId: "chat-1", agentKey: "agent-1", message: runId },
    onEvent: (event) => received.push([runId, event.type]),
  }));

  await waitUntil(() => sockets.length === 2 && requestOfType(socket("primary"), "/api/query").length === 2 && requestOfType(socket("btw"), "/api/btw").length === 2);
  assert.deepEqual(sockets.map((item) => item.source).sort(), ["desktop-btw", "desktop-main"]);

  for (const [lane, , runId] of [
    ["primary", "/api/query", "run-main-1"],
    ["primary", "/api/query", "run-main-2"],
    ["btw", "/api/btw", "run-btw-1"],
    ["btw", "/api/btw", "run-btw-2"],
  ]) {
    const request = socket(lane).sent.find((frame) => frame.payload?.runId === runId);
    socket(lane).emit({ frame: "stream", id: request.id, event: runEvent("run.start", runId, "chat-1", 1) });
  }
  await Promise.all(queries.map((query) => query.accepted));
  await nextTurn();
  assert.equal(sockets.length, 2);
  assert.equal(broker.getDiagnostics().replay.filter((run) => run.lane === "primary").length, 2);
  assert.equal(broker.getDiagnostics().replay.filter((run) => run.lane === "btw").length, 2);
  assert.equal(received.filter(([, type]) => type === "run.start").length, 4);
});

test("Main Chat clones use local replay and never create upstream attach", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const mainEvents = [];
  const cloneEvents = [];
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    id: "main-query",
    runId: "run-clone",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    observerToken: observer.token,
    consumerId: "main-chat",
    payload: { runId: "run-clone", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: (event) => mainEvents.push(event.type),
  });
  const pendingClone = broker.subscribeClone({
    runId: "run-clone",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    consumerId: "overview",
    onEvent: (event) => cloneEvents.push(event.type),
  });
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-clone", "chat-1", 1) });
  const clone = await pendingClone;
  await query.accepted;
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("content.delta", "run-clone", "chat-1", 2, { delta: "A" }) });
  await nextTurn();

  assert.deepEqual(mainEvents, ["run.start", "content.delta"]);
  assert.deepEqual(cloneEvents, ["run.start", "content.delta"]);
  assert.equal(requestOfType(socket("primary"), "/api/attach").length, 0);
  clone.unsubscribe();
  assert.equal(requestOfType(socket("primary"), "/api/detach").length, 0);
});

test("Main Chat activation atomically creates its Overview lease before any live frame", (t) => {
  const { broker } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);

  const diagnostics = broker.getDiagnostics();
  assert.equal(diagnostics.rootObserver.token, observer.token);
  assert.equal(diagnostics.overviewLease.state, "ready");
  assert.equal(diagnostics.overviewLease.parentGeneration, observer.generation);
  assert.equal(diagnostics.overviewLease.chatId, observer.contextId);
  assert.equal(diagnostics.overviewLease.runCount, 0);
  assert.equal(diagnostics.overviewLease.pendingSubscriberCount, 0);
  assert.equal(diagnostics.overviewLease.uiSubscriberCount, 0);
});

test("Overview waits on its existing lease until the Main Chat Run is registered", async (t) => {
  const { broker, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const events = [];
  let settled = false;
  const pendingOverview = broker.subscribeClone({
    kind: "overview",
    runId: "run-late-main",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    consumerId: "overview-first-open",
    onEvent: (event) => events.push(event.type),
  }).then((subscription) => {
    settled = true;
    return subscription;
  });
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(broker.getDiagnostics().overviewLease.pendingSubscriberCount, 1);

  const main = broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080",
    token,
    runId: "run-late-main",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    kind: "surface",
    role: "root_observer",
    observerToken: observer.token,
    consumerId: "main-chat-late-attach",
    onEvent: () => undefined,
  });
  const overview = await pendingOverview;
  await main.ready;

  assert.equal(settled, true);
  assert.equal(broker.getDiagnostics().overviewLease.pendingSubscriberCount, 0);
  assert.equal(broker.getDiagnostics().overviewLease.uiSubscriberCount, 1);
  assert.equal(broker.getDiagnostics().upstreamAttachCount, 1);
  overview.unsubscribe();
  assert.equal(broker.getDiagnostics().overviewLease.uiSubscriberCount, 0);
  assert.deepEqual(events, []);
});

test("ownerless Main Chat promotes its Overview lease in place", (t) => {
  const { broker } = createHarness(t);
  const observer = rootObserver({ contextId: "main-chat:g1" });
  const before = broker.activateRootObserver(observer);
  assert.equal(broker.getDiagnostics().overviewLease.state, "pending_chat_identity");

  const promoted = broker.promoteMainChatRootObserver(observer.token, "chat-canonical");
  assert.equal(promoted.token, before.token);
  assert.equal(promoted.contextEpoch, before.contextEpoch);
  assert.equal(promoted.contextId, "chat-canonical");
  assert.equal(broker.getDiagnostics().overviewLease.state, "ready");
  assert.equal(broker.getDiagnostics().overviewLease.chatId, "chat-canonical");
});

test("normal Main Chat replacement completes Overview locally instead of reporting parent release", async (t) => {
  const { broker, token } = createHarness(t);
  const first = rootObserver();
  broker.activateRootObserver(first);
  const main = broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080",
    token,
    runId: "run-replaced",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    kind: "surface",
    role: "root_observer",
    observerToken: first.token,
    consumerId: "main-before-replace",
    onEvent: () => undefined,
  });
  await main.ready;
  const completions = [];
  const errors = [];
  await broker.subscribeClone({
    kind: "overview",
    runId: "run-replaced",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    consumerId: "overview-before-replace",
    onEvent: () => undefined,
    onComplete: (result) => completions.push(result),
    onError: (error) => errors.push(error.message),
  });

  broker.activateRootObserver(rootObserver({
    token: "main-chat:g2:1:102:chat-2",
    generation: "g2",
    contextId: "chat-2",
    webContentsId: 102,
  }));
  assert.equal(broker.getMainChatRootObserver().contextId, "chat-2");
  assert.deepEqual(completions.map((result) => result.reason), ["detached"]);
  assert.deepEqual(errors, []);
});

test("pending Overview also completes locally when its Main Chat is replaced", async (t) => {
  const { broker } = createHarness(t);
  broker.activateRootObserver(rootObserver());
  const completions = [];
  const errors = [];
  const pending = broker.subscribeClone({
    kind: "overview",
    runId: "run-never-opened",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    consumerId: "overview-pending-replace",
    onEvent: () => undefined,
    onComplete: (result) => completions.push(result.reason),
    onError: (error) => errors.push(error.message),
  });
  await nextTurn();
  broker.activateRootObserver(rootObserver({
    token: "main-chat:g2:1:102:chat-2",
    generation: "g2",
    contextId: "chat-2",
    webContentsId: 102,
  }));
  await pending;
  await nextTurn();
  assert.deepEqual(completions, ["detached"]);
  assert.deepEqual(errors, []);
  assert.equal(broker.getDiagnostics().pendingClones.length, 0);
});

test("thirty Main Chat and Overview attach interleavings bind without retry", async (t) => {
  const { broker, token } = createHarness(t);
  for (let index = 0; index < 30; index += 1) {
    const chatId = `chat-interleave-${index}`;
    const runId = `run-interleave-${index}`;
    const observer = rootObserver({
      token: `main-chat:g${index}:1:101:${chatId}`,
      generation: `g${index}`,
      contextId: chatId,
    });
    broker.activateRootObserver(observer);
    const subscribeOverview = () => broker.subscribeClone({
      kind: "overview",
      runId,
      chatId,
      owner: { kind: "agent", agentKey: "agent-1" },
      consumerId: `overview-interleave-${index}`,
      onEvent: () => undefined,
    });
    let overviewPromise;
    if (index % 2 === 0) overviewPromise = subscribeOverview();
    const main = broker.subscribeRun({
      baseUrl: "http://127.0.0.1:8080",
      token,
      runId,
      chatId,
      owner: { kind: "agent", agentKey: "agent-1" },
      kind: "surface",
      role: "root_observer",
      observerToken: observer.token,
      consumerId: `main-interleave-${index}`,
      onEvent: () => undefined,
    });
    overviewPromise ??= subscribeOverview();
    const overview = await overviewPromise;
    await main.ready;
    overview.unsubscribe();
  }
  assert.equal(broker.getDiagnostics().pendingClones.length, 0);
  assert.equal(broker.getDiagnostics().overviewLease.uiSubscriberCount, 0);
});

test("unknown clone Run fails deterministically without a readiness timeout", async (t) => {
  const { broker } = createHarness(t);
  broker.activateRootObserver(rootObserver());
  await assert.rejects(
    broker.subscribeClone({
      runId: "missing-run",
      chatId: "chat-1",
      owner: { kind: "agent", agentKey: "agent-1" },
      consumerId: "debug",
      onEvent: () => undefined,
    }),
    (error) => {
      assert.equal(error.name, "target_unavailable");
      assert.equal(error.details.reason, "run_not_registered");
      return true;
    },
  );
});

test("pending clone is cancelled when its query fails before run.start", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    id: "failed-parent-query",
    runId: "run-never-registered",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    observerToken: observer.token,
    payload: { runId: "run-never-registered", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: () => undefined,
  });
  const clone = broker.subscribeClone({
    runId: "run-never-registered",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    consumerId: "overview",
    onEvent: () => undefined,
  });
  assert.deepEqual(broker.getDiagnostics().pendingClones, [{
    observerToken: observer.token,
    parentGeneration: observer.generation,
    runId: "run-never-registered",
    chatId: "chat-1",
    waitReason: "awaiting_run_start",
  }]);
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  socket("primary").emit({ frame: "error", id: upstream.id, type: "invalid_request", msg: "rejected" });
  await assert.rejects(query.accepted);
  await assert.rejects(clone, (error) => {
    assert.equal(error.name, "target_unavailable");
    assert.equal(error.details.reason, "run_not_registered");
    return true;
  });
  assert.equal(broker.getDiagnostics().pendingClones.length, 0);
  assert.equal(broker.getDiagnostics().lastCloneCancellationReason, "run_not_registered");
});

test("superseded Root Observer cannot read Run replay", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const first = rootObserver();
  broker.activateRootObserver(first);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    id: "replay-security-query",
    runId: "run-replay-security",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    observerToken: first.token,
    payload: { runId: "run-replay-security", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: () => undefined,
  });
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-replay-security", "chat-1", 1) });
  await query.accepted;
  const second = rootObserver({ token: "main-chat:g2:1:102:chat-2", generation: "g2", contextId: "chat-2", webContentsId: 102 });
  broker.activateRootObserver(second);
  const leaked = [];
  assert.throws(() => broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080",
    token,
    runId: "run-replay-security",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    kind: "surface",
    role: "root_observer",
    observerToken: first.token,
    consumerId: "stale-main-chat",
    onEvent: (event) => leaked.push(event),
  }), (error) => error.name === "surface_generation_superseded");
  assert.deepEqual(leaked, []);
});

test("canonical run.start never rewrites the trusted Root Observer context", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver({
    token: "copilot-dock:g1:1:101:desktop-route-home:chat-copilot",
    kind: "copilot_dock",
    surfaceId: "copilot-dock",
    contextId: "desktop-route:/home:chat-copilot",
  });
  broker.activateRootObserver(observer);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    id: "copilot-context-query",
    runId: "run-copilot-context",
    chatId: "chat-copilot",
    owner: { kind: "agent", agentKey: "agent-1" },
    observerToken: observer.token,
    payload: { runId: "run-copilot-context", chatId: "chat-copilot", agentKey: "agent-1", message: "hello" },
    onEvent: () => undefined,
  });
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  socket("primary").emit({
    frame: "stream",
    id: upstream.id,
    event: runEvent("run.start", "run-copilot-context", "chat-copilot", 1),
  });
  await query.accepted;
  assert.equal(broker.getActiveRootObserver().contextId, observer.contextId);
});

test("last Root Observer release detaches once, keeps the Run dormant, then reattaches from lastSeq", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    id: "detach-query",
    runId: "run-detach",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    observerToken: observer.token,
    consumerId: "main-chat",
    payload: { runId: "run-detach", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: () => undefined,
  });
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-detach", "chat-1", 1) });
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("content.delta", "run-detach", "chat-1", 2) });
  await query.accepted;

  broker.releaseRootObserver(observer.token);
  await waitUntil(() => requestOfType(socket("primary"), "/api/detach").length === 1);
  const detach = requestOfType(socket("primary"), "/api/detach")[0];
  socket("primary").emit({
    frame: "response",
    id: detach.id,
    data: { accepted: true, streamRequestId: upstream.id, lastSeq: 2 },
  });
  assert.deepEqual(await query.completed, { reason: "detached", lastSeq: 2 });
  await nextTurn();
  const dormant = broker.getDiagnostics().replay.find((run) => run.runId === "run-detach");
  assert.equal(dormant.state, "dormant");
  assert.equal(dormant.lastSeq, 2);
  assert.equal(dormant.terminalReason, undefined);

  const nextObserver = rootObserver({ token: "main-chat:g2:1:102", generation: "g2", webContentsId: 102 });
  broker.activateRootObserver(nextObserver);
  const restored = broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080",
    token,
    lane: "primary",
    runId: "run-detach",
    chatId: "chat-1",
    lastSeq: 2,
    owner: { kind: "agent", agentKey: "agent-1" },
    kind: "surface",
    role: "root_observer",
    observerToken: nextObserver.token,
    consumerId: "main-chat-2",
    onEvent: () => undefined,
  });
  await restored.ready;
  const attaches = requestOfType(socket("primary"), "/api/attach");
  assert.equal(attaches.length, 1);
  assert.equal(attaches[0].payload.lastSeq, 2);
  assert.equal(requestOfType(socket("primary"), "/api/query").length, 1);
});

test("a replacement observer before detach write cancels the old detach", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const first = rootObserver();
  broker.activateRootObserver(first);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    id: "cancel-detach-query",
    runId: "run-cancel-detach",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    observerToken: first.token,
    consumerId: "main-1",
    payload: { runId: "run-cancel-detach", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: () => undefined,
  });
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-cancel-detach", "chat-1", 1) });
  await query.accepted;

  broker.releaseRootObserver(first.token);
  const second = rootObserver({ token: "main-chat:g2:1:102", generation: "g2", webContentsId: 102 });
  broker.activateRootObserver(second);
  const replacement = broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080",
    token,
    runId: "run-cancel-detach",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    kind: "surface",
    role: "root_observer",
    observerToken: second.token,
    consumerId: "main-2",
    onEvent: () => undefined,
  });
  await replacement.ready;
  await nextTurn();
  assert.equal(requestOfType(socket("primary"), "/api/detach").length, 0);
  assert.equal(requestOfType(socket("primary"), "/api/attach").length, 0);
});

test("Primary push can terminate a BTW Run while BTW push is ignored", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    lane: "btw",
    requestType: "/api/btw",
    id: "btw-query",
    runId: "run-btw-push",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    observerToken: observer.token,
    consumerId: "btw",
    payload: { runId: "run-btw-push", chatId: "chat-1", message: "side" },
    onEvent: () => undefined,
  });
  await waitUntil(() => requestOfType(socket("btw"), "/api/btw").length === 1);
  const upstream = requestOfType(socket("btw"), "/api/btw")[0];
  socket("btw").emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-btw-push", "chat-1", 1) });
  await query.accepted;
  socket("btw").emit({ frame: "push", type: "run.finished", data: { runId: "run-btw-push", status: "wrong", finishedAt: EPOCH_MS + 2 } });
  await nextTurn();
  assert.equal(broker.getDiagnostics().replay.find((run) => run.runId === "run-btw-push").state, "observed");

  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  socket("primary").emit({ frame: "push", type: "run.finished", data: { runId: "run-btw-push", status: "finished", finishedAt: EPOCH_MS + 3 } });
  assert.deepEqual(await query.completed, { reason: "finished" });
  assert.equal(broker.getDiagnostics().replay.find((run) => run.runId === "run-btw-push").state, "terminal");
});

test("old Platform /api/btw route failure becomes btw_ws_unsupported", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    lane: "btw",
    requestType: "/api/btw",
    id: "old-platform",
    runId: "run-old",
    chatId: "chat-1",
    payload: { runId: "run-old", chatId: "chat-1", message: "side" },
    onEvent: () => undefined,
  });
  await waitUntil(() => requestOfType(socket("btw"), "/api/btw").length === 1);
  const upstream = requestOfType(socket("btw"), "/api/btw")[0];
  socket("btw").emit({ frame: "error", id: upstream.id, type: "invalid_request", msg: "unknown type: /api/btw" });
  await assert.rejects(query.accepted, (error) => error.name === "btw_ws_unsupported");
});

test("replay window reports seq_expired instead of fabricating a prefix", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080",
    token,
    id: "replay-query",
    runId: "run-replay",
    chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    observerToken: observer.token,
    payload: { runId: "run-replay", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: () => undefined,
  });
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-replay", "chat-1", 1) });
  await query.accepted;
  for (let seq = 2; seq <= 2_010; seq += 1) {
    socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("content.delta", "run-replay", "chat-1", seq, { delta: "x" }) });
  }
  await waitUntil(() => broker.getDiagnostics().replay.find((run) => run.runId === "run-replay")?.lastSeq === 2_010);
  assert.throws(() => broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080",
    token,
    runId: "run-replay",
    chatId: "chat-1",
    lastSeq: 0,
    owner: { kind: "agent", agentKey: "agent-1" },
    kind: "internal",
    role: "internal",
    consumerId: "late-reader",
    onEvent: () => undefined,
  }), (error) => error.name === "seq_expired" && error.details.firstAvailableSeq > 1);
});

test("only Primary dispatches reverse Desktop Actions and preserves duplicate protection", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const calls = [];
  broker.setDesktopBridgeProvider({
    action: async (request) => {
      calls.push(request);
      return { ok: true, action: request.action, result: { themeMode: "dark" } };
    },
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
  });
  await Promise.all([
    broker.ensureConnected("http://127.0.0.1:8080", token, "primary"),
    broker.ensureConnected("http://127.0.0.1:8080", token, "btw"),
  ]);

  const request = {
    frame: "request",
    type: "desktop.theme.get",
    id: "desktop-action-1",
    source: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1" },
    payload: {},
  };
  socket("primary").emit(request);
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === request.id));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    requestId: request.id,
    action: request.type,
    args: {},
    source: request.source,
  });
  assert.equal(socket("primary").sent.find((frame) => frame.id === request.id).frame, "response");

  socket("primary").emit(request);
  await waitUntil(() => socket("primary").sent.filter((frame) => frame.id === request.id).length === 2);
  assert.equal(socket("primary").sent.filter((frame) => frame.id === request.id).at(-1).type, "duplicate_id");
  assert.equal(calls.length, 1);

  socket("btw").emit({ ...request, id: "btw-action" });
  await waitUntil(() => socket("btw").sent.some((frame) => frame.id === "btw-action"));
  assert.equal(socket("btw").sent.find((frame) => frame.id === "btw-action").type, "unknown_request_type");
  assert.equal(calls.length, 1);
});

test("WorkPanel waits for its canonical Run grant and terminal Push revokes it", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const calls = [];
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  broker.registerRunActionGrant({
    sourceId: "main-chat:query-1",
    chatId: "chat-ready",
    runId: "run-ready",
    owner: { kind: "agent", agentKey: "agent-1" },
    ready,
  });
  broker.setDesktopBridgeProvider({
    action: async (request) => {
      calls.push(request);
      return { ok: true, action: request.action, result: { workspaceId: "workpanel:chat-ready" } };
    },
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");

  const action = {
    frame: "request",
    type: "desktop.workpanel.openWeb",
    id: "workpanel-before-ready",
    source: { chatId: "chat-ready", runId: "run-ready", agentKey: "agent-1" },
    payload: { url: "https://example.test/document" },
  };
  socket("primary").emit(action);
  await nextTurn();
  assert.equal(calls.length, 0);
  releaseReady();
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === action.id));
  assert.equal(calls.length, 1);
  assert.equal(socket("primary").sent.find((frame) => frame.id === action.id).frame, "response");

  socket("primary").emit({
    frame: "push",
    type: "run.finished",
    data: {
      runId: "run-ready",
      chatId: "chat-ready",
      status: "completed",
      finishReason: "complete",
      finishedAt: EPOCH_MS + 10,
    },
  });
  socket("primary").emit({ ...action, id: "workpanel-after-terminal" });
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === "workpanel-after-terminal"));
  const rejected = socket("primary").sent.find((frame) => frame.id === "workpanel-after-terminal");
  assert.equal(rejected.frame, "error");
  assert.equal(rejected.type, "source_chat_not_ready");
  assert.equal(calls.length, 1);
});

test("Primary chunks large reverse Desktop responses below 256 KiB", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const screenshot = Buffer.alloc(420_000, 7).toString("base64");
  broker.setDesktopBridgeProvider({
    action: async (request) => ({
      ok: true,
      action: request.action,
      result: { text: "x".repeat(420_000) },
    }),
    cdp: async (request) => ({
      ok: true,
      method: request.method,
      result: { data: screenshot },
    }),
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  socket("primary").emit({
    frame: "request",
    type: "desktop.controlCenter.readServiceLog",
    id: "large-json",
    source: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1" },
    payload: {},
  });
  socket("primary").emit({
    frame: "request",
    type: "desktop.cdp.call",
    id: "large-screenshot",
    payload: { method: "Page.captureScreenshot", params: {} },
  });
  await waitUntil(() => ["large-json", "large-screenshot"].every((id) =>
    socket("primary").sent.some((frame) => frame.frame === "response" && frame.id === id),
  ));

  for (const id of ["large-json", "large-screenshot"]) {
    const chunks = socket("primary").sent.filter((frame) => frame.frame === "stream" && frame.id === id);
    assert.ok(chunks.length > 1, id);
    assert.deepEqual(chunks.map((frame) => frame.event.seq), chunks.map((_, index) => index + 1));
    assert.ok(chunks.every((frame) => frame.event.chunk.length <= 256 * 1024), id);
    const terminal = socket("primary").sent.find((frame) => frame.frame === "response" && frame.id === id);
    assert.equal(terminal.code, 0);
    assert.equal(terminal.data.streamed ?? terminal.data.result?.data?.streamed, true);
  }
});
