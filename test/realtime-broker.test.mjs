import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RealtimeBroker } = require("../dist-electron/main/modules/agent-platform/realtime/realtime-broker.js");
const {
  createAgentPlatformIdentitySessionId,
  normalizeAgentPlatformRealtimeEndpoint,
} = require("../dist-electron/main/modules/agent-platform/realtime/agent-platform-realtime-client.js");

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
    disconnect() { this.closed = true; this.onclose?.(); }
    close() { this.closed = true; }
  }

  const broker = new RealtimeBroker({
    app: { getPath: () => root },
    issueAccessToken: async () => ({ ok: true, token: jwt(), message: "" }),
    getDesktopDeviceId: () => "desktop-test",
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
  const sourceByLane = { primary: "desktop-main", btw: "desktop-btw", "selection-explain": "desktop-selection-explain" };
  const socket = (lane) => sockets.find((candidate) => candidate.source === sourceByLane[lane]);
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

function explanationObserver(overrides = {}) {
  return rootObserver({ token: "explanation:g1:2:202", kind: "selection_explain", surfaceId: "selection-explain",
    generation: "g1", contextId: "chat-1", webContentsId: 202, ...overrides });
}

async function acceptedRun(h, { lane, runId, observerToken, onEvent = () => {}, signal }) {
  const type = lane === "primary" ? "/api/query" : "/api/btw";
  const query = h.broker.query({ baseUrl: "http://127.0.0.1:8080", token: h.token, id: `op-${runId}`,
    lane, runId, chatId: "chat-1", owner: { kind: "agent", agentKey: "agent-1" }, observerToken,
    consumerId: `source:${runId}`, signal, payload: { runId, chatId: "chat-1", agentKey: "agent-1", message: runId }, onEvent });
  await waitUntil(() => h.socket(lane)?.sent.some((frame) => frame.type === type && frame.payload?.runId === runId));
  const socket = h.socket(lane);
  const request = socket.sent.find((frame) => frame.type === type && frame.payload?.runId === runId);
  socket.emit({ frame: "stream", id: request.id, event: runEvent("run.start", runId, "chat-1", 1) });
  await query.accepted;
  await nextTurn();
  return { query, socket, request };
}

for (const platform of ["darwin", "win32"]) {
  test(`Desktop explanation lane is lazy and separately identified on ${platform}`, async (t) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    t.after(() => Object.defineProperty(process, "platform", originalPlatform));
    const h = createHarness(t);
    const states = [];
    h.broker.subscribeConnection({ lane: "selection-explain", consumerId: "explain-window", onState: (state) => states.push(state) });
    assert.equal(h.sockets.length, 0);
    assert.equal(h.broker.getConnectionStates()["selection-explain"].physicalConnectionCount, 0);
    await h.broker.ensureConnected("http://127.0.0.1:8080", h.token, "primary");
    await h.broker.ensureConnected("http://127.0.0.1:8080", h.token, "btw");
    assert.equal(h.sockets.length, 2);
    assert.equal(states.length, 1, "other lanes must not publish into the explanation connection subscription");
    const observer = explanationObserver(); h.broker.activateRootObserver(observer);
    const run = await acceptedRun(h, { lane: "selection-explain", runId: "run-explain", observerToken: observer.token });
    assert.equal(h.sockets.length, 3);
    const url = new URL(run.socket.url);
    assert.equal(url.searchParams.get("source"), "desktop-selection-explain");
    assert.equal(url.searchParams.get("surfaceId"), "desktop-selection-explain");
    assert.equal(url.searchParams.get("deviceId"), "desktop-test");
    assert.equal(states.at(-1).phase, "connected");
    assert.equal(h.broker.getDiagnostics().connections["selection-explain"].physicalConnectionCount, 1);
    assert.equal(requestOfType(run.socket, "/api/query").length, 0);
  });
}

test("explanation handoff keeps one upstream stream, detaches only its source, and closes independently", async (t) => {
  const h = createHarness(t), main = rootObserver();
  h.broker.activateRootObserver(main);
  await acceptedRun(h, { lane: "primary", runId: "run-main", observerToken: main.token });
  await acceptedRun(h, { lane: "btw", runId: "run-side", observerToken: main.token });
  const sourceEvents = [], explanationEvents = [], sourceAbort = new AbortController();
  const run = await acceptedRun(h, { lane: "selection-explain", runId: "run-explain", observerToken: main.token,
    signal: sourceAbort.signal, onEvent: (event) => sourceEvents.push(event.type) });
  run.socket.emit({ frame: "stream", id: run.request.id, event: runEvent("content.delta", "run-explain", "chat-1", 2) });
  await nextTurn();
  const observer = explanationObserver(); h.broker.activateRootObserver(observer);
  const observed = h.broker.subscribeRun({ baseUrl: "http://127.0.0.1:8080", token: h.token, lane: "selection-explain",
    runId: "run-explain", chatId: "chat-1", owner: { kind: "agent", agentKey: "agent-1" }, kind: "surface",
    role: "root_observer", observerToken: observer.token, consumerId: "explanation-window",
    onEvent: (event) => explanationEvents.push(event.type) });
  await observed.ready;
  assert.deepEqual(await run.query.completed, { reason: "detached", lastSeq: 2 });
  assert.deepEqual([...h.broker.getMainChatRootObserver().runIds].sort(), ["run-main", "run-side"]);
  assert.deepEqual([...h.broker.getDiagnostics().auxiliaryRootObservers[0].runIds], ["run-explain"]);
  assert.equal(requestOfType(run.socket, "/api/btw").length, 1);
  assert.equal(requestOfType(run.socket, "/api/attach").length, 0);
  assert.equal(requestOfType(run.socket, "/api/detach").length, 0);
  sourceAbort.abort();
  h.broker.cleanupConsumer("source:run-explain");
  run.socket.emit({ frame: "stream", id: run.request.id, event: runEvent("content.delta", "run-explain", "chat-1", 3) });
  await nextTurn();
  assert.deepEqual(sourceEvents, ["run.start", "content.delta"]);
  assert.deepEqual(explanationEvents, ["run.start", "content.delta", "content.delta"]);

  h.broker.releaseRootObserver(observer.token);
  await waitUntil(() => requestOfType(run.socket, "/api/detach").length === 1);
  const detach = requestOfType(run.socket, "/api/detach")[0];
  run.socket.emit({ frame: "response", id: detach.id, data: { accepted: true, streamRequestId: run.request.id, lastSeq: 3 } });
  await nextTurn();
  assert.equal(requestOfType(run.socket, "/api/interrupt").length, 0);
  assert.equal(requestOfType(h.socket("primary"), "/api/detach").length, 0);
  assert.equal(requestOfType(h.socket("btw"), "/api/detach").length, 0);
  assert.equal(h.broker.getDiagnostics().replay.find((item) => item.runId === "run-explain").state, "dormant");
  assert.deepEqual([...h.broker.getMainChatRootObserver().runIds].sort(), ["run-main", "run-side"]);

  const reopened = explanationObserver({ token: "explanation:g2:2:203", generation: "g2", webContentsId: 203 });
  h.broker.activateRootObserver(reopened);
  const restored = h.broker.subscribeRun({ baseUrl: "http://127.0.0.1:8080", token: h.token, lane: "selection-explain",
    runId: "run-explain", chatId: "chat-1", lastSeq: 3, owner: { kind: "agent", agentKey: "agent-1" },
    kind: "surface", observerToken: reopened.token, consumerId: "reopened-explanation", onEvent() {} });
  await restored.ready;
  assert.equal(requestOfType(run.socket, "/api/attach").length, 1);
  assert.equal(requestOfType(run.socket, "/api/attach")[0].payload.lastSeq, 3);
  assert.equal(requestOfType(run.socket, "/api/btw").length, 1);
});

test("explanation-only reconnect restores a handed-off stream repeatedly without replaying the query", async (t) => {
  const h = createHarness(t), main = rootObserver(); h.broker.activateRootObserver(main);
  const primary = await acceptedRun(h, { lane: "primary", runId: "main", observerToken: main.token });
  const btw = await acceptedRun(h, { lane: "btw", runId: "side", observerToken: main.token });
  const explanation = await acceptedRun(h, { lane: "selection-explain", runId: "explain", observerToken: main.token });
  const observer = explanationObserver(); h.broker.activateRootObserver(observer);
  await h.broker.subscribeRun({ baseUrl: "http://127.0.0.1:8080", token: h.token, lane: "selection-explain",
    runId: "explain", chatId: "chat-1", owner: { kind: "agent", agentKey: "agent-1" }, kind: "surface",
    observerToken: observer.token, consumerId: "explanation", onEvent() {} }).ready;
  await explanation.query.completed;
  const before = h.broker.getConnectionStates();
  let current = explanation.socket;
  for (const seq of [2, 3]) {
    const upstream = current.sent.find((frame) => frame.type === "/api/btw" || frame.type === "/api/attach");
    current.emit({ frame: "stream", id: upstream.id, event: runEvent("content.delta", "explain", "chat-1", seq) });
    await nextTurn();
    current.disconnect();
    await h.broker.ensureConnected("http://127.0.0.1:8080", h.token, "selection-explain");
    current = h.sockets.filter((item) => item.source === "desktop-selection-explain").at(-1);
    await waitUntil(() => requestOfType(current, "/api/attach").length === 1);
    assert.equal(requestOfType(current, "/api/attach")[0].payload.lastSeq, seq);
    assert.equal(requestOfType(current, "/api/btw").length, 0);
    assert.equal(h.broker.getConnectionStates().primary.generation, before.primary.generation);
    assert.equal(h.broker.getConnectionStates().btw.generation, before.btw.generation);
    assert.equal(primary.socket.closed, undefined);
    assert.equal(btw.socket.closed, undefined);
  }
  assert.equal(h.broker.getDiagnostics().replay.find((run) => run.runId === "explain").restoreCount, 2);
  assert.equal(h.sockets.flatMap((socket) => requestOfType(socket, "/api/btw")).filter((frame) => frame.payload.runId === "explain").length, 1);
});

test("explanation controls infer the registered lane and reject explicit cross-lane requests", async (t) => {
  const h = createHarness(t), observer = explanationObserver(); h.broker.activateRootObserver(observer);
  const run = await acceptedRun(h, { lane: "selection-explain", runId: "explain", observerToken: observer.token });
  const request = { baseUrl: "http://127.0.0.1:8080", token: h.token, localId: "stop-explanation", consumerId: "explanation",
    type: "/api/interrupt", payload: { runId: "explain", agentKey: "agent-1" }, onFrame() {}, onError() {} };
  const upstreamId = await h.broker.forwardRequest(request);
  assert.equal(requestOfType(run.socket, "/api/interrupt").length, 1);
  assert.equal(h.sockets.length, 1);
  run.socket.emit({ frame: "response", id: upstreamId, data: { accepted: true } });
  await assert.rejects(h.broker.forwardRequest({ ...request, lane: "primary" }), { name: "invalid_request" });
  await assert.rejects(h.broker.forwardRequest({ ...request, lane: "btw" }), { name: "invalid_request" });
  assert.throws(() => h.broker.subscribeRun({ baseUrl: request.baseUrl, token: h.token, lane: "btw", runId: "explain", chatId: "chat-1",
    kind: "surface", observerToken: observer.token, consumerId: "wrong-lane", onEvent() {} }), { name: "invalid_request" });
  const main = rootObserver(); h.broker.activateRootObserver(main);
  assert.throws(() => h.broker.subscribeRun({ baseUrl: request.baseUrl, token: h.token, lane: "primary", runId: "explain", chatId: "chat-1",
    kind: "surface", observerToken: main.token, consumerId: "main-wrong-lane", onEvent() {} }), { name: "invalid_request" });
  const wrongQuery = h.broker.query({ baseUrl: request.baseUrl, token: h.token, lane: "btw", id: "wrong-lane-query", runId: "explain",
    payload: {}, onEvent() {} });
  await assert.rejects(wrongQuery.accepted, { name: "invalid_request" });
  await assert.rejects(wrongQuery.completed, { name: "invalid_request" });
  assert.equal(h.sockets.length, 1);
  assert.equal(h.broker.getDiagnostics().runCount, 1);
});

test("selection explanation lane rejects ordinary queries without connecting", async (t) => {
  const h = createHarness(t);
  const query = h.broker.query({ baseUrl: "http://127.0.0.1:8080", token: h.token, id: "invalid-explanation",
    lane: "selection-explain", requestType: "/api/query", payload: {}, onEvent() {} });
  await assert.rejects(query.accepted, { name: "invalid_request" });
  await assert.rejects(query.completed, { name: "invalid_request" });
  await assert.rejects(h.broker.forwardRequest({ baseUrl: "http://127.0.0.1:8080", token: h.token, localId: "invalid-forward",
    consumerId: "explanation", lane: "selection-explain", type: "/api/query", onFrame() {}, onError() {} }), { name: "invalid_request" });
  assert.equal(h.sockets.length, 0);
});

test("an explanation disconnect fails only its unaccepted query and pending requests", async (t) => {
  const h = createHarness(t), main = rootObserver(); h.broker.activateRootObserver(main);
  const primary = await acceptedRun(h, { lane: "primary", runId: "main", observerToken: main.token });
  const btw = await acceptedRun(h, { lane: "btw", runId: "side", observerToken: main.token });
  let otherRunCompleted = false;
  void primary.query.completed.then(() => { otherRunCompleted = true; }, () => { otherRunCompleted = true; });
  void btw.query.completed.then(() => { otherRunCompleted = true; }, () => { otherRunCompleted = true; });
  const query = h.broker.query({ baseUrl: "http://127.0.0.1:8080", token: h.token, id: "pending-explain", lane: "selection-explain",
    chatId: "chat-1", observerToken: main.token, payload: { chatId: "chat-1" }, onEvent() {} });
  await waitUntil(() => h.socket("selection-explain")?.sent.some((frame) => frame.type === "/api/btw"));
  const requestErrors = [];
  await h.broker.forwardRequest({ baseUrl: "http://127.0.0.1:8080", token: h.token, localId: "pending-read", consumerId: "explain",
    lane: "selection-explain", type: "/api/chat", payload: { chatId: "chat-1" }, onFrame() {}, onError: (error) => requestErrors.push(error) });
  h.socket("selection-explain").disconnect();
  await assert.rejects(query.accepted, { name: "connection_lost_before_acceptance" });
  await assert.rejects(query.completed, { name: "connection_lost_before_acceptance" });
  await nextTurn();
  assert.equal(requestErrors.length, 1);
  assert.equal(otherRunCompleted, false);
  assert.equal(h.broker.getConnectionState("primary").phase, "connected");
  assert.equal(h.broker.getConnectionState("btw").phase, "connected");
  assert.equal(h.broker.getConnectionState("selection-explain").phase, "reconnecting");
});

test("an explanation stream error after handoff is delivered only to its current observer", async (t) => {
  const h = createHarness(t), main = rootObserver(); h.broker.activateRootObserver(main);
  await acceptedRun(h, { lane: "primary", runId: "main", observerToken: main.token });
  const run = await acceptedRun(h, { lane: "selection-explain", runId: "explain", observerToken: main.token });
  const observer = explanationObserver(); h.broker.activateRootObserver(observer);
  const failures = [], completed = [];
  await h.broker.subscribeRun({ baseUrl: "http://127.0.0.1:8080", token: h.token, lane: "selection-explain", runId: "explain",
    chatId: "chat-1", owner: { kind: "agent", agentKey: "agent-1" }, kind: "surface", observerToken: observer.token,
    consumerId: "explanation", onEvent() {}, onError: (error) => failures.push(error), onComplete: (result) => completed.push(result) }).ready;
  assert.equal((await run.query.completed).reason, "detached");
  run.socket.emit({ frame: "error", id: run.request.id, type: "invalid_request", msg: "explanation failed" });
  await nextTurn();
  assert.equal(failures.length, 1);
  assert.equal(completed.length, 0);
  assert.equal(h.broker.getDiagnostics().replay.find((item) => item.runId === "explain").state, "terminal");
  assert.equal(h.broker.getDiagnostics().replay.find((item) => item.runId === "explain").terminalSource, "query_stream");
  assert.equal(h.broker.getDiagnostics().replay.find((item) => item.runId === "main").state, "observed");
});

test("global push and Desktop actions never escape the dedicated explanation lane", async (t) => {
  const h = createHarness(t), pushes = [], actions = [];
  h.broker.subscribePush({ types: ["chat.updated"], kind: "internal", consumerId: "navigation", onPush: (frame) => pushes.push(frame) });
  h.broker.setDesktopBridgeProvider({
    action: async (request) => { actions.push(request); return {}; },
    cdp: async (request) => { actions.push(request); return {}; },
  });
  await h.broker.ensureConnected("http://127.0.0.1:8080", h.token, "selection-explain");
  const socket = h.socket("selection-explain");
  socket.emit({ frame: "push", type: "chat.updated", data: { chatId: "chat-1" } });
  socket.emit({ frame: "request", id: "unexpected-action", type: "desktop.runtime.info", payload: {},
    source: { runId: "explain", chatId: "chat-1", agentKey: "agent-1" } });
  await nextTurn();
  assert.deepEqual(pushes, []);
  assert.deepEqual(actions, []);
  assert.ok(socket.sent.some((frame) => frame.id === "unexpected-action" && frame.frame === "error"));
});

test("identity changes see an explanation-only connection and dispose closes every instantiated lane", async (t) => {
  const h = createHarness(t), observer = explanationObserver(); h.broker.activateRootObserver(observer);
  const run = await acceptedRun(h, { lane: "selection-explain", runId: "explain", observerToken: observer.token });
  await h.broker.ensureConnected("http://127.0.0.1:8080", jwt({ sid: "different-session" }), "primary");
  assert.equal(run.socket.closed, true);
  assert.deepEqual(h.broker.getDiagnostics().auxiliaryRootObservers, []);
  assert.equal(h.broker.getDiagnostics().runCount, 0);
  assert.equal(h.broker.getDiagnostics().laneRotationCount, 3);
  await assert.rejects(run.query.completed, { name: "connection_unavailable" });
  const token = jwt({ sid: "different-session" });
  await h.broker.ensureConnected("http://127.0.0.1:8080", token, "btw");
  await h.broker.ensureConnected("http://127.0.0.1:8080", token, "selection-explain");
  h.broker.dispose();
  assert.ok(h.sockets.every((socket) => socket.closed));
  assert.equal(h.broker.getConnectionStates()["selection-explain"].physicalConnectionCount, 0);
});

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

test("push-only consumers never race Query RunChannel registration", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const pushRunIds = [];
  broker.subscribePush({
    types: ["run.started", "run.finished", "chat.updated"],
    kind: "internal",
    consumerId: "desktop-pet-status",
    onPush: (frame) => pushRunIds.push(frame.data?.runId),
  });

  const execute = async (runId, pushFirst) => {
    const primaryBefore = socket("primary");
    const queryCountBefore = primaryBefore ? requestOfType(primaryBefore, "/api/query").length : 0;
    const query = broker.query({
      baseUrl: "http://127.0.0.1:8080",
      token,
      id: `query-${runId}`,
      chatId: "chat-1",
      owner: { kind: "agent", agentKey: "agent-1" },
      observerToken: observer.token,
      consumerId: `main-chat:${runId}`,
      payload: { chatId: "chat-1", agentKey: "agent-1", message: runId },
      onEvent: () => undefined,
    });
    await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === queryCountBefore + 1);
    const upstream = requestOfType(socket("primary"), "/api/query").at(-1);
    const startedPush = {
      frame: "push",
      type: "run.started",
      data: { runId, chatId: "chat-1", agentKey: "agent-1", startedAt: EPOCH_MS + 1 },
    };
    const startedStream = {
      frame: "stream",
      id: upstream.id,
      event: runEvent("run.start", runId, "chat-1", 1),
    };
    if (pushFirst) socket("primary").emit(startedPush);
    socket("primary").emit(startedStream);
    if (!pushFirst) socket("primary").emit(startedPush);
    await query.accepted;
    assert.equal(requestOfType(socket("primary"), "/api/attach").length, 0);
    socket("primary").emit({ frame: "stream", id: upstream.id, reason: "complete", lastSeq: 1 });
    await query.completed;
  };

  await execute("run-push-first", true);
  await execute("run-stream-first", false);

  assert.deepEqual(pushRunIds, ["run-push-first", "run-stream-first"]);
  assert.equal(requestOfType(socket("primary"), "/api/query").length, 2);
  assert.equal(requestOfType(socket("primary"), "/api/attach").length, 0);
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
    kind: "overview",
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
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("plan.update", "run-clone", "chat-1", 3, { tasks: [] }) });
  await nextTurn();

  assert.deepEqual(mainEvents, ["run.start", "content.delta", "plan.update"]);
  assert.deepEqual(cloneEvents, ["run.start", "content.delta", "plan.update"]);
  assert.equal(requestOfType(socket("primary"), "/api/attach").length, 0);
  const diagnostics = broker.getDiagnostics();
  assert.deepEqual(diagnostics.overviewLease.runIds, ["run-clone"]);
  assert.deepEqual(diagnostics.overviewLease.subscribers, [{
    runId: "run-clone",
    chatId: "chat-1",
    lastSeq: 3,
  }]);
  assert.equal(diagnostics.replay[0].lastEventType, "plan.update");
  assert.equal(diagnostics.replay[0].lastEventSeq, 3);
  assert.equal(diagnostics.replay[0].lastPlanTaskEventType, "plan.update");
  assert.equal(diagnostics.replay[0].lastPlanTaskEventSeq, 3);
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

test("selection explanation observer stays isolated from Main Chat and active roots", (t) => {
  const { broker } = createHarness(t);
  const main = rootObserver();
  const copilot = rootObserver({
    token: "copilot-dock:g2:2:202",
    kind: "copilot_dock",
    surfaceId: "copilot-dock",
    generation: "g2",
    contextId: "context-2:chat-2",
    webContentsId: 202,
  });
  const explanation = rootObserver({
    token: "selection-explain:g3:3:303:chat-1",
    kind: "selection_explain",
    surfaceId: "selection-explain",
    generation: "g3",
    contextId: "chat-1",
    webContentsId: 303,
  });
  broker.activateRootObserver(main);
  broker.activateRootObserver(copilot);
  const activated = broker.activateRootObserver(explanation);
  assert.equal(activated.token, explanation.token);
  assert.equal(broker.getDiagnostics().auxiliaryRootObservers[0].token, explanation.token);
  assert.equal(broker.getMainChatRootObserver().token, main.token);
  assert.equal(broker.getActiveRootObserver().token, copilot.token);
  assert.equal(broker.releaseRootObserver(explanation.token, "surface_inactive"), true);
  assert.deepEqual(broker.getDiagnostics().auxiliaryRootObservers, []);
  assert.equal(broker.getMainChatRootObserver().token, main.token);
  assert.equal(broker.getActiveRootObserver().token, copilot.token);
});

test("Root Observer token cannot silently change context or registration identity", (t) => {
  const { broker } = createHarness(t);
  const pending = rootObserver({ contextId: "main-chat:g1", newChatSourceKey: '["agent-1","nonce-1"]' });
  const original = broker.activateRootObserver(pending);
  assert.equal(broker.activateRootObserver(pending).contextEpoch, original.contextEpoch);
  const canonical = { ...pending, contextId: "chat-canonical" };
  assert.equal(broker.activateRootObserver(canonical).contextEpoch, original.contextEpoch);
  assert.equal(broker.activateRootObserver(canonical).contextId, "chat-canonical");
  for (const conflict of [pending, { ...canonical, contextId: "another-chat" },
    { ...canonical, generation: "g2" }, { ...canonical, webContentsId: 102 },
    { ...canonical, newChatSourceKey: '["agent-1","nonce-2"]' }]) {
    assert.throws(() => broker.activateRootObserver(conflict), /Root Observer (context changed|token conflicts)/u);
    assert.equal(broker.getMainChatRootObserver().contextId, "chat-canonical");
    assert.equal(broker.getMainChatRootObserver().contextEpoch, original.contextEpoch);
  }
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
    payload: { method: "Page.captureScreenshot", params: {}, source: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1" } },
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

for (const switchBeforeAcceptance of [false, true]) {
  test(`Copilot site authority survives Dock detach ${switchBeforeAcceptance ? 'before' : 'after'} canonical acceptance`, async (t) => {
    const { createSiteHarness } = require('./fixtures/site-cdp-harness.cjs');
    const { broker, socket, token } = createHarness(t);
    const h = createSiteHarness(); const a = h.site('a'); const b = h.site('b');
    const scope = h.capture(a);
    const observer = rootObserver({ token: 'copilot:g1', kind: 'copilot_dock', surfaceId: 'copilot-dock', contextId: 'website:a' });
    broker.activateRootObserver(observer);
    const request = broker.query({ baseUrl: 'http://127.0.0.1:8080', token, id: 'site-query', payload: { agentKey: 'agent-1' },
      owner: { kind: 'agent', agentKey: 'agent-1' }, observerToken: observer.token, siteCdpScope: scope, onEvent() {} });
    void request.completed.catch(() => undefined);
    await waitUntil(() => requestOfType(socket('primary') ?? { sent: [] }, '/api/query').length === 1);
    const outbound = requestOfType(socket('primary'), '/api/query')[0];
    const detach = () => { h.foreground(b); broker.releaseRootObserver(observer.token); };
    if (switchBeforeAcceptance) detach();
    socket('primary').emit({ frame: 'stream', id: outbound.id, event: runEvent('run.start', 'run-site', 'chat-site', 1) });
    await request.accepted;
    if (!switchBeforeAcceptance) detach();
    const added = h.addTab(a);
    const calls = [];
    broker.setDesktopBridgeProvider({ action: async () => ({ ok: true }), cdp: async (_request, granted) => {
      const surface = granted.readSurface(); calls.push(surface);
      return { ok: true, method: 'Target.getTargets', result: { count: surface.tabs.length } };
    } });
    const invoke = async (id, source = { runId: 'run-site', chatId: 'chat-site', agentKey: 'agent-1' }) => {
      socket('primary').emit({ frame: 'request', type: 'desktop.cdp.call', id, payload: { method: 'Target.getTargets', source } });
      await waitUntil(() => socket('primary').sent.some((frame) => frame.id === id));
      return socket('primary').sent.find((frame) => frame.id === id);
    };
    assert.equal((await invoke('site-read')).frame, 'response');
    assert.equal(calls.at(-1).surfaceId, a.surfaceId);
    assert.equal(calls.at(-1).tabs.at(-1).webContentsId, added.webContentsId);
    assert.equal((await invoke('bad-source', { runId: 'run-site', chatId: 'other', agentKey: 'agent-1' })).type, 'site_control_unavailable');
    assert.equal(calls.length, 1);
    socket('primary').emit({ frame: 'push', type: 'run.finished', data: { runId: 'run-site', chatId: 'chat-site', finishedAt: EPOCH_MS + 10 } });
    assert.equal((await invoke('after-finish')).type, 'site_control_unavailable');
    assert.equal(h.contents.get(added.webContentsId).throttle, true);
    assert.equal(calls.length, 1);
  });
}

test('same-identity reconnect preserves site authority while account rotation revokes it', async (t) => {
  const { createSiteHarness } = require('./fixtures/site-cdp-harness.cjs');
  const { broker, socket, sockets, token } = createHarness(t);
  const h = createSiteHarness(); const a = h.site('a'); const scope = h.capture(a);
  const observer = rootObserver({ token: 'copilot:g1', kind: 'copilot_dock', surfaceId: 'copilot-dock' });
  broker.activateRootObserver(observer);
  const request = broker.query({ baseUrl: 'http://127.0.0.1:8080', token, id: 'site-query', payload: {},
    owner: { kind: 'agent', agentKey: 'agent-1' }, observerToken: observer.token, siteCdpScope: scope, onEvent() {} });
  void request.completed.catch(() => undefined);
  await waitUntil(() => requestOfType(socket('primary') ?? { sent: [] }, '/api/query').length === 1);
  const outbound = requestOfType(socket('primary'), '/api/query')[0];
  socket('primary').emit({ frame: 'stream', id: outbound.id, event: runEvent('run.start', 'run-site', 'chat-site', 1) });
  await request.accepted;
  broker.releaseRootObserver(observer.token);
  socket('primary').disconnect();
  await broker.ensureConnected('http://127.0.0.1:8080', token);
  assert.equal(scope.readSurface().surfaceId, a.surfaceId);
  assert.equal(sockets.flatMap((socket) => requestOfType(socket, '/api/query')).length, 1);
  broker.rotateIdentity();
  assert.throws(() => scope.readSurface(), { code: 'site_control_unavailable' });
  assert.equal(h.contents.get(a.tabs[0].webContentsId).throttle, true);
});
