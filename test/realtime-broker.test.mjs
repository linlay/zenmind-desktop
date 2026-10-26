import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RealtimeBroker } = require("../dist-electron/main/modules/agent-platform/realtime/realtime-broker.js");
const { getDesktopActionDefinition } = require("../dist-electron/shared/desktop-actions.js");
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
  const sourceByLane = { primary: "desktop-main", btw: "desktop-btw", "selection-explain": "desktop-explain" };
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
  const type = "/api/query";
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
    assert.equal(url.searchParams.get("source"), "desktop-explain");
    assert.equal(url.searchParams.get("surfaceId"), "desktop-explain");
    assert.equal(url.searchParams.get("deviceId"), "desktop-test");
    assert.equal(states.at(-1).phase, "connected");
    assert.equal(h.broker.getDiagnostics().connections["selection-explain"].physicalConnectionCount, 1);
    assert.equal(requestOfType(run.socket, "/api/query").length, 1);
    assert.equal(requestOfType(run.socket, "/api/btw").length, 0);
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
  assert.equal(requestOfType(run.socket, "/api/query").length, 1);
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
  assert.equal(requestOfType(run.socket, "/api/query").length, 1);
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
    const upstream = current.sent.find((frame) => frame.type === "/api/query" || frame.type === "/api/attach");
    current.emit({ frame: "stream", id: upstream.id, event: runEvent("content.delta", "explain", "chat-1", seq) });
    await nextTurn();
    current.disconnect();
    await h.broker.ensureConnected("http://127.0.0.1:8080", h.token, "selection-explain");
    current = h.sockets.filter((item) => item.source === "desktop-explain").at(-1);
    await waitUntil(() => requestOfType(current, "/api/attach").length === 1);
    assert.equal(requestOfType(current, "/api/attach")[0].payload.lastSeq, seq);
    assert.equal(requestOfType(current, "/api/query").length, 0);
    assert.equal(h.broker.getConnectionStates().primary.generation, before.primary.generation);
    assert.equal(h.broker.getConnectionStates().btw.generation, before.btw.generation);
    assert.equal(primary.socket.closed, undefined);
    assert.equal(btw.socket.closed, undefined);
  }
  assert.equal(h.broker.getDiagnostics().replay.find((run) => run.runId === "explain").restoreCount, 2);
  assert.equal(h.sockets.flatMap((socket) => requestOfType(socket, "/api/query")).filter((frame) => frame.payload.runId === "explain").length, 1);
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
  const releasedScopes = [];
  const wrongQuery = h.broker.query({ baseUrl: request.baseUrl, token: h.token, lane: "btw", id: "wrong-lane-query", runId: "explain",
    siteControlScope: { release: (reason) => releasedScopes.push(reason) }, payload: {}, onEvent() {} });
  await assert.rejects(wrongQuery.accepted, { name: "invalid_request" });
  await assert.rejects(wrongQuery.completed, { name: "invalid_request" });
  assert.deepEqual(releasedScopes, ["The query was not accepted."]);
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

for (const lane of ["primary", "selection-explain"]) {
  test(`explanation query rejects and releases page-control authority on ${lane}`, async (t) => {
    const h = createHarness(t), observer = explanationObserver();
    h.broker.activateRootObserver(observer);
    const releasedScopes = [];
    const query = h.broker.query({ baseUrl: "http://127.0.0.1:8080", token: h.token, id: "explanation-with-page-control",
      lane, observerToken: observer.token, chatId: "chat-1", payload: {}, onEvent() {},
      siteControlScope: { release: (reason) => releasedScopes.push(reason) } });
    await assert.rejects(query.accepted, { name: "invalid_request" });
    await assert.rejects(query.completed, { name: "invalid_request" });
    assert.deepEqual(releasedScopes, ["The query was not accepted."]);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.broker.getDiagnostics().runCount, 0);
  });
}

test("an explanation disconnect fails only its unaccepted query and pending requests", async (t) => {
  const h = createHarness(t), main = rootObserver(); h.broker.activateRootObserver(main);
  const primary = await acceptedRun(h, { lane: "primary", runId: "main", observerToken: main.token });
  const btw = await acceptedRun(h, { lane: "btw", runId: "side", observerToken: main.token });
  let otherRunCompleted = false;
  void primary.query.completed.then(() => { otherRunCompleted = true; }, () => { otherRunCompleted = true; });
  void btw.query.completed.then(() => { otherRunCompleted = true; }, () => { otherRunCompleted = true; });
  const query = h.broker.query({ baseUrl: "http://127.0.0.1:8080", token: h.token, id: "pending-explain", lane: "selection-explain",
    chatId: "chat-1", observerToken: main.token, payload: { chatId: "chat-1" }, onEvent() {} });
  await waitUntil(() => h.socket("selection-explain")?.sent.some((frame) => frame.type === "/api/query"));
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

test("each lane reserves only one stream before Run acceptance while different lanes run in parallel", async (t) => {
  const h = createHarness(t);
  const options = { baseUrl: "http://127.0.0.1:8080", token: h.token, payload: { message: "private body" }, onEvent() {} };
  const queries = ["primary", "btw", "selection-explain"].map((lane) => h.broker.query({ ...options, lane, id: `first-${lane}`, consumerId: `internal:${lane}` }));
  await waitUntil(() => h.sockets.length === 3 && h.sockets.every((socket) => requestOfType(socket, "/api/query").length === 1));
  for (const lane of ["primary", "btw", "selection-explain"]) {
    const second = h.broker.query({ ...options, lane, id: `second-${lane}` });
    const validate = (error) => {
      const frame = error.platformErrorFrame;
      assert.equal(frame.code, 409);
      const info = frame.data.error.diagnostics;
      assert.equal(info.lane, lane);
      assert.equal(info.activeStream.requestId, requestOfType(h.socket(lane), "/api/query")[0].id);
      assert.equal(info.activeStream.consumerId, `internal:${lane}`);
      assert.equal(info.activeStream.state, "reserving");
      assert.equal(JSON.stringify(info).includes("private body"), false);
      return true;
    };
    await Promise.all([assert.rejects(second.accepted, validate), assert.rejects(second.completed, /active_stream_exists/)]);
    assert.equal(requestOfType(h.socket(lane), "/api/query").length, 1);
  }
  for (const [index, lane] of ["primary", "btw", "selection-explain"].entries()) {
    const socket = h.socket(lane), id = requestOfType(socket, "/api/query")[0].id;
    socket.emit({ frame: "stream", id, event: runEvent("run.start", `run-${lane}`, "chat-1", 1) });
    await queries[index].accepted;
    socket.emit({ frame: "stream", id, reason: "done", lastSeq: 1 });
    await queries[index].completed;
  }
  assert.equal(h.broker.getDiagnostics().activeStreamCount, 0);
});

for (const completion of ["push", "event"]) {
test(`Run completion ${completion} waits for its terminal stream frame before sending again`, async (t) => {
  const h = createHarness(t);
  const old = await acceptedRun(h, { lane: "primary", runId: "run-old" });
  if (completion === "push") {
    old.socket.emit({ frame: "push", type: "run.finished", data: { runId: "run-old", chatId: "chat-1", finishedAt: EPOCH_MS, status: "done" } });
    await old.query.completed;
  } else {
    old.socket.emit({ frame: "stream", id: old.request.id, event: runEvent("run.complete", "run-old", "chat-1", 2) });
  }
  const options = { baseUrl: "http://127.0.0.1:8080", token: h.token, payload: {}, onEvent() {} };
  const next = h.broker.query({ ...options, id: "next" });
  await nextTurn();
  assert.equal(requestOfType(old.socket, "/api/query").length, 1, "new query must wait for transport release");
  assert.equal(h.broker.getDiagnostics().activeStreamCount, 1);
  old.socket.emit({ frame: "stream", id: old.request.id, reason: "done", lastSeq: 2 });
  await waitUntil(() => requestOfType(old.socket, "/api/query").length === 2);
  const request = requestOfType(old.socket, "/api/query")[1];
  old.socket.emit({ frame: "stream", id: request.id, event: runEvent("run.start", "run-next", "chat-1", 1) });
  await next.accepted;
  old.socket.emit({ frame: "stream", id: old.request.id, reason: "done" });
  assert.equal(h.broker.getDiagnostics().laneStreams[0].requestId, request.id, "late old frame cannot free new slot");
  old.socket.emit({ frame: "stream", id: request.id, reason: "done" });
  await next.completed;
});

}

for (const failure of ["rejected", "timeout", "malformed"]) {
  test(`detach ${failure} keeps the occupying stream and reports its origin`, async (t) => {
    const h = createHarness(t);
    h.broker.activateRootObserver(rootObserver());
    const old = await acceptedRun(h, { lane: "primary", runId: "run-old", observerToken: rootObserver().token });
    const nextRoot = rootObserver({ token: "new-root", contextId: "chat-2" });
    h.broker.activateRootObserver(nextRoot);
    await waitUntil(() => requestOfType(old.socket, "/api/detach").length === 1);
    const detach = requestOfType(old.socket, "/api/detach")[0];
    const query = h.broker.query({ baseUrl: "http://127.0.0.1:8080", token: h.token, id: "new-query", chatId: "chat-2", observerToken: nextRoot.token,
      payload: { chatId: "chat-2" }, onEvent() {} });
    const rejected = Promise.all([assert.rejects(query.accepted, (error) => {
      const occupant = error.platformErrorFrame.data.error.diagnostics.activeStream;
      assert.equal(occupant.runId, "run-old");
      assert.equal(occupant.consumerId, "source:run-old");
      assert.equal(occupant.surfaceId, "main-chat");
      assert.equal(occupant.state, "release_unconfirmed");
      assert.ok(occupant.lastDetachError);
      return true;
    }), assert.rejects(query.completed, /active_stream_exists/)]);
    if (failure === "timeout") {
      // Exercise the actual pending-request timeout without a 30s wall-clock delay.
      const pending = h.broker.pendingRequests.get(detach.id);
      pending.timer._onTimeout();
    } else if (failure === "rejected") {
      old.socket.emit({ frame: "error", id: detach.id, type: "detach_denied", code: 403, msg: "detach denied" });
    } else {
      old.socket.emit({ frame: "response", id: detach.id, data: { accepted: true, streamRequestId: "wrong-request" } });
    }
    await rejected;
    assert.equal(requestOfType(old.socket, "/api/query").length, 1);
    assert.ok(h.diagnostics.some((entry) => entry.startsWith("run_stream_detach_failed:")));
  });
}

test("local acceptance timeout keeps its request reservation until the upstream releases it", async (t) => {
  const h = createHarness(t);
  const options = { baseUrl: "http://127.0.0.1:8080", token: h.token, payload: {}, onEvent() {} };
  const first = h.broker.query({ ...options, id: "slow" });
  await waitUntil(() => h.socket("primary")?.sent.some((frame) => frame.type === "/api/query"));
  const rejected = Promise.all([assert.rejects(first.accepted, /acceptance timed out/), assert.rejects(first.completed, /acceptance timed out/)]);
  const transaction = [...h.broker.queriesByRequestId.values()][0];
  transaction.acceptanceTimer._onTimeout();
  await rejected;
  const second = h.broker.query({ ...options, id: "second" });
  await Promise.all([assert.rejects(second.accepted, /active_stream_exists/), assert.rejects(second.completed, /active_stream_exists/)]);
  assert.equal(requestOfType(h.socket("primary"), "/api/query").length, 1);
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

test("selection explanation observer stays isolated while regular roots replace one another", (t) => {
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
  const activated = broker.activateRootObserver(explanation);
  assert.equal(activated.token, explanation.token);
  assert.equal(broker.getDiagnostics().auxiliaryRootObservers[0].token, explanation.token);
  assert.equal(broker.getMainChatRootObserver().token, main.token);
  assert.equal(broker.getActiveRootObserver().token, main.token);
  broker.activateRootObserver(copilot);
  assert.equal(broker.getMainChatRootObserver(), null);
  assert.equal(broker.getActiveRootObserver().token, copilot.token);
  assert.equal(broker.getDiagnostics().auxiliaryRootObservers[0].token, explanation.token);
  const replacement = rootObserver({ token: "main-chat:g4:4:404", generation: "g4", webContentsId: 404 });
  broker.activateRootObserver(replacement);
  assert.equal(broker.getMainChatRootObserver().token, replacement.token);
  assert.equal(broker.getActiveRootObserver().token, replacement.token);
  assert.equal(broker.getDiagnostics().auxiliaryRootObservers[0].token, explanation.token);
  assert.equal(broker.releaseRootObserver(explanation.token, "surface_inactive"), true);
  assert.deepEqual(broker.getDiagnostics().auxiliaryRootObservers, []);
  assert.equal(broker.getMainChatRootObserver().token, replacement.token);
  assert.equal(broker.getActiveRootObserver().token, replacement.token);
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
  const { broker, token, socket } = createHarness(t);
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
    broker.releaseRootObserver(observer.token);
    await waitUntil(() => requestOfType(socket("primary"), "/api/detach").length === index + 1);
    const detach = requestOfType(socket("primary"), "/api/detach").at(-1);
    const attach = requestOfType(socket("primary"), "/api/attach").at(-1);
    socket("primary").emit({ frame: "response", id: detach.id, data: { accepted: true, streamRequestId: attach.id, lastSeq: 0 } });
    await nextTurn();
  }
  assert.equal(broker.getDiagnostics().pendingClones.length, 0);
  assert.equal(broker.getDiagnostics().overviewLease, null);
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

for (const lane of ["primary", "selection-explain"]) {
  test(`a ${lane} observer closed during connection setup never attaches its Run`, async (t) => {
    const h = createHarness(t, { autoHandshake: false });
    const observer = lane === "primary" ? rootObserver() : explanationObserver();
    h.broker.activateRootObserver(observer);
    const pending = h.broker.subscribeRun({ baseUrl: "http://127.0.0.1:8080", token: h.token, lane,
      runId: "cold-run", chatId: "chat-1", owner: { kind: "agent", agentKey: "agent-1" },
      kind: "surface", observerToken: observer.token, consumerId: "cold-observer", onEvent() {} });
    await waitUntil(() => h.socket(lane));
    h.broker.releaseRootObserver(observer.token);
    h.socket(lane).emit({ frame: "push", type: "connected", data: {
      protocolVersion: 2, sessionId: "cold-session", serverTime: EPOCH_MS,
      liveness: { heartbeatIntervalMs: 30_000, silenceTimeoutMs: 100_000 },
    } });
    await pending.ready;
    assert.equal(requestOfType(h.socket(lane), "/api/attach").length, 0);
    assert.equal(requestOfType(h.socket(lane), "/api/interrupt").length, 0);
    assert.equal(h.broker.getDiagnostics().localRunSubscriberCount, 0);
  });
}

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

test("attach wait snapshot with seq 0 reaches subscribers without moving the cursor or replay", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const rootEvents = [];
  const restored = broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080",
    token,
    lane: "primary",
    runId: "run-wait",
    chatId: "chat-1",
    lastSeq: 145,
    owner: { kind: "agent", agentKey: "agent-1" },
    kind: "surface",
    role: "root_observer",
    observerToken: observer.token,
    consumerId: "main-chat",
    onEvent: (event) => rootEvents.push(event),
  });
  await restored.ready;
  const attach = requestOfType(socket("primary"), "/api/attach")[0];
  assert.equal(attach.payload.lastSeq, 145);
  const wait = { toolId: "wait-1", startedAt: EPOCH_MS, deadlineAt: EPOCH_MS + 30_000, attachSnapshot: true };
  socket("primary").emit({ frame: "stream", id: attach.id, event: runEvent("tool.wait.update", "run-wait", "chat-1", 0, wait) });
  await nextTurn();

  assert.deepEqual(rootEvents.map((event) => [event.type, event.seq, event.toolId]), [["tool.wait.update", 0, "wait-1"]]);
  const channel = () => broker.getDiagnostics().replay.find((run) => run.runId === "run-wait");
  assert.equal(channel().lastSeq, 145);
  assert.equal(channel().eventCount, 0);

  socket("primary").emit({ frame: "stream", id: attach.id, event: runEvent("tool.output", "run-wait", "chat-1", 146, { toolId: "other" }) });
  await nextTurn();
  assert.deepEqual(rootEvents.map((event) => event.seq), [0, 146]);

  const lateEvents = [];
  const late = broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080", token, runId: "run-wait", chatId: "chat-1", lastSeq: 146,
    owner: { kind: "agent", agentKey: "agent-1" }, kind: "internal", role: "internal", consumerId: "late-reader",
    onEvent: (event) => lateEvents.push(event),
  });
  assert.deepEqual(lateEvents.map((event) => [event.type, event.seq, event.toolId, event.attachSnapshot]),
    [["tool.wait.update", 0, "wait-1", true]]);
  late.unsubscribe();

  socket("primary").emit({ frame: "stream", id: attach.id, event: runEvent("tool.result", "run-wait", "chat-1", 147, { toolId: "wait-1" }) });
  await nextTurn();
  const afterResult = [];
  broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080", token, runId: "run-wait", chatId: "chat-1", lastSeq: 147,
    owner: { kind: "agent", agentKey: "agent-1" }, kind: "internal", role: "internal", consumerId: "after-result",
    onEvent: (event) => afterResult.push(event),
  }).unsubscribe();
  assert.deepEqual(afterResult, [], "a completed wait must not be revived");
  assert.equal(channel().lastSeq, 147);
  assert.equal(requestOfType(socket("primary"), "/api/attach").length, 1);
});

test("live tool.wait is projected to late subscribers until its tool.result", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080", token, id: "wait-query", runId: "run-live-wait", chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" }, observerToken: observer.token, consumerId: "main-chat",
    payload: { runId: "run-live-wait", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: () => undefined,
  });
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-live-wait", "chat-1", 1) });
  await query.accepted;
  socket("primary").emit({ frame: "stream", id: upstream.id,
    event: runEvent("tool.wait", "run-live-wait", "chat-1", 2, { toolId: "wait-1", deadlineAt: EPOCH_MS + 30_000 }) });
  await nextTurn();

  const subscribe = (consumerId, lastSeq) => {
    const events = [];
    broker.subscribeRun({
      baseUrl: "http://127.0.0.1:8080", token, runId: "run-live-wait", chatId: "chat-1", lastSeq,
      owner: { kind: "agent", agentKey: "agent-1" }, kind: "internal", role: "internal", consumerId,
      onEvent: (event) => events.push([event.type, event.seq, event.attachSnapshot === true]),
    }).unsubscribe();
    return events;
  };
  assert.deepEqual(subscribe("reader-1", 2), [["tool.wait.update", 0, true]]);

  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("run.complete", "run-live-wait", "chat-1", 3) });
  await nextTurn();
  assert.deepEqual(subscribe("reader-2", 3), []);
});

for (const loss of ["detach", "disconnect"]) {
test(`wait cache is not projected after ${loss} until upstream reconfirms it`, async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080", token, id: `stale-wait-${loss}`, runId: "run-stale-wait", chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" }, observerToken: observer.token, consumerId: "main-chat",
    payload: { runId: "run-stale-wait", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: () => undefined,
  });
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-stale-wait", "chat-1", 1) });
  await query.accepted;
  socket("primary").emit({ frame: "stream", id: upstream.id,
    event: runEvent("tool.wait", "run-stale-wait", "chat-1", 2, { toolId: "wait-1", deadlineAt: EPOCH_MS + 30_000 }) });
  await nextTurn();

  if (loss === "detach") {
    broker.releaseRootObserver(observer.token);
    await waitUntil(() => requestOfType(socket("primary"), "/api/detach").length === 1);
    const detach = requestOfType(socket("primary"), "/api/detach")[0];
    socket("primary").emit({ frame: "response", id: detach.id, data: { accepted: true, streamRequestId: upstream.id, lastSeq: 2 } });
    await query.completed;
  } else {
    socket("primary").disconnect();
  }
  await nextTurn();

  // The wait finished in the background at seq 3; this reader already loaded history through seq 4.
  const events = [];
  broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080", token, runId: "run-stale-wait", chatId: "chat-1", lastSeq: 4,
    owner: { kind: "agent", agentKey: "agent-1" }, kind: "internal", role: "internal", consumerId: "history-reader",
    onEvent: (event) => events.push([event.type, event.seq]),
  }).unsubscribe();
  assert.deepEqual(events, [], "an unconfirmed wait cache must not be projected");
});
}

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
  await waitUntil(() => requestOfType(socket("btw"), "/api/query").length === 1);
  const upstream = requestOfType(socket("btw"), "/api/query")[0];
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

test("Platform query errors retain the authoritative error code", async (t) => {
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
  await waitUntil(() => requestOfType(socket("btw"), "/api/query").length === 1);
  const upstream = requestOfType(socket("btw"), "/api/query")[0];
  socket("btw").emit({ frame: "error", id: upstream.id, type: "invalid_request", msg: "query rejected" });
  await assert.rejects(query.accepted, (error) => error.name === "invalid_request");
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

function observeRun(h, observer, { lastSeq, onEvent = () => {}, onComplete, onError, consumerId = "main-chat-frame-port" } = {}) {
  return h.broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080", token: h.token, runId: "run-long", chatId: "chat-1", agentKey: "agent-1",
    kind: "surface", role: "root_observer", observerToken: observer.token, consumerId,
    ...(lastSeq === undefined ? {} : { lastSeq }), onEvent, onComplete, onError,
  });
}

async function dormantRunAt(h, lastSeq) {
  const observer = rootObserver();
  h.broker.activateRootObserver(observer);
  await observeRun(h, observer, { lastSeq: 0 }).ready;
  const attach = requestOfType(h.socket("primary"), "/api/attach")[0];
  for (let seq = 1; seq <= lastSeq; seq += 1) {
    h.socket("primary").emit({ frame: "stream", id: attach.id, event: runEvent("reasoning.delta", "run-long", "chat-1", seq, { delta: "x" }) });
  }
  h.broker.releaseRootObserver(observer.token, "surface_inactive");
  await waitUntil(() => requestOfType(h.socket("primary"), "/api/detach").length === 1);
  const detach = requestOfType(h.socket("primary"), "/api/detach")[0];
  h.socket("primary").emit({ frame: "stream", id: attach.id, reason: "detached", lastSeq });
  h.socket("primary").emit({ frame: "response", id: detach.id, type: "/api/detach", data: { accepted: true, streamRequestId: attach.id, lastSeq } });
  await nextTurn();
  assert.equal(h.broker.getDiagnostics().replay.find((run) => run.runId === "run-long").state, "dormant");
  const back = rootObserver({ token: "main-chat:g2:1:101", generation: "g2" });
  h.broker.activateRootObserver(back);
  return back;
}

test("a dormant Run resumes from the returning observer's newer cursor instead of its stale Channel seq", async (t) => {
  const h = createHarness(t);
  const back = await dormantRunAt(h, 1_087);
  const events = [];
  await observeRun(h, back, { lastSeq: 13_000, onEvent: (event) => events.push(event) }).ready;
  const attach = requestOfType(h.socket("primary"), "/api/attach")[1];
  assert.equal(attach.payload.lastSeq, 13_000);
  h.socket("primary").emit({ frame: "stream", id: attach.id, event: runEvent("awaiting.ask", "run-long", "chat-1", 13_001, { awaitingId: "aw-1" }) });
  await nextTurn();
  assert.deepEqual(events.map((event) => `${event.type}@${event.seq}`), ["awaiting.ask@13001"]);
  const run = h.broker.getDiagnostics().replay.find((item) => item.runId === "run-long");
  assert.equal(run.state, "observed");
  assert.equal(run.upstreamState, "attached");
});

test("a dormant Run resumes upstream when the observer cursor predates its local replay", async (t) => {
  const h = createHarness(t);
  const back = await dormantRunAt(h, 2_100);
  await observeRun(h, back, { lastSeq: 50 }).ready;
  assert.equal(requestOfType(h.socket("primary"), "/api/attach")[1].payload.lastSeq, 50);
});

test("an expired Platform resume cursor suspends the Channel without ending the Run", async (t) => {
  const h = createHarness(t);
  const back = await dormantRunAt(h, 1_087);
  const errors = [];
  const completions = [];
  await observeRun(h, back, { lastSeq: 900, onError: (error) => errors.push(error.name), onComplete: (result) => completions.push(result) }).ready;
  const expired = requestOfType(h.socket("primary"), "/api/attach")[1];
  assert.equal(expired.payload.lastSeq, 1_087);
  h.socket("primary").emit({ frame: "error", id: expired.id, type: "seq_expired", code: 409, msg: "SEQ_EXPIRED",
    data: { runId: "run-long", chatId: "chat-1", lastSeq: 1_087, oldestSeq: 3_138, latestSeq: 13_137 } });
  await nextTurn();
  assert.deepEqual(errors, ["seq_expired"]);
  assert.deepEqual(completions, []);
  const run = h.broker.getDiagnostics().replay.find((item) => item.runId === "run-long");
  assert.notEqual(run.state, "terminal");
  assert.equal(run.upstreamState, "detached");
  assert.match(h.diagnostics.join("\n"), /attach_cursor_expired/u);

  const events = [];
  await observeRun(h, back, { lastSeq: 13_137, onEvent: (event) => events.push(event.type) }).ready;
  const resumed = requestOfType(h.socket("primary"), "/api/attach")[2];
  assert.equal(resumed.payload.lastSeq, 13_137);
  h.socket("primary").emit({ frame: "stream", id: resumed.id, event: runEvent("awaiting.ask", "run-long", "chat-1", 13_138, { awaitingId: "aw-1" }) });
  await nextTurn();
  assert.deepEqual(events, ["awaiting.ask"]);
});

test("replacing the active Root Observer ends its live Run streams locally as detached", async (t) => {
  const h = createHarness(t);
  const observer = rootObserver();
  h.broker.activateRootObserver(observer);
  const completions = [];
  const errors = [];
  await observeRun(h, observer, { onComplete: (result) => completions.push(result), onError: (error) => errors.push(error) }).ready;
  const attach = requestOfType(h.socket("primary"), "/api/attach")[0];
  h.socket("primary").emit({ frame: "stream", id: attach.id, event: runEvent("content.delta", "run-long", "chat-1", 1) });
  await nextTurn();
  h.broker.activateRootObserver(rootObserver({ token: "copilot-dock:g9:1:202", kind: "copilot_dock", surfaceId: "copilot-dock",
    generation: "g9", contextId: "dock:chat-9", webContentsId: 202 }));
  assert.deepEqual(completions, [{ reason: "detached", lastSeq: 1 }]);
  assert.deepEqual(errors, []);
  await waitUntil(() => requestOfType(h.socket("primary"), "/api/detach").length === 1);
});

test("an unsolicited upstream detach of an observed attach stream resumes from the last delivered seq", async (t) => {
  const h = createHarness(t);
  const observer = rootObserver();
  h.broker.activateRootObserver(observer);
  const events = [];
  const completions = [];
  await observeRun(h, observer, { onEvent: (event) => events.push(event.type), onComplete: (result) => completions.push(result) }).ready;
  const first = requestOfType(h.socket("primary"), "/api/attach")[0];
  for (let seq = 1; seq <= 5; seq += 1) {
    h.socket("primary").emit({ frame: "stream", id: first.id, event: runEvent("content.delta", "run-long", "chat-1", seq) });
  }
  // Platform drops its slow observer and ends the stream on its own.
  h.socket("primary").emit({ frame: "stream", id: first.id, reason: "detached", lastSeq: 5 });
  await nextTurn();
  assert.equal(requestOfType(h.socket("primary"), "/api/detach").length, 0);
  const resumed = requestOfType(h.socket("primary"), "/api/attach")[1];
  assert.equal(resumed.payload.lastSeq, 5);
  assert.match(h.diagnostics.join("\n"), /upstream_stream_lost/u);
  h.socket("primary").emit({ frame: "stream", id: resumed.id, event: runEvent("awaiting.ask", "run-long", "chat-1", 6, { awaitingId: "aw-1" }) });
  await nextTurn();
  assert.equal(events.at(-1), "awaiting.ask");
  assert.deepEqual(completions, []);
});

test("a repeated unsolicited upstream detach without progress stops auto-resume", async (t) => {
  const h = createHarness(t);
  const observer = rootObserver();
  h.broker.activateRootObserver(observer);
  await observeRun(h, observer).ready;
  const first = requestOfType(h.socket("primary"), "/api/attach")[0];
  h.socket("primary").emit({ frame: "stream", id: first.id, event: runEvent("content.delta", "run-long", "chat-1", 1) });
  h.socket("primary").emit({ frame: "stream", id: first.id, reason: "detached", lastSeq: 1 });
  await nextTurn();
  const resumed = requestOfType(h.socket("primary"), "/api/attach")[1];
  h.socket("primary").emit({ frame: "stream", id: resumed.id, reason: "detached", lastSeq: 1 });
  await nextTurn();
  assert.equal(requestOfType(h.socket("primary"), "/api/attach").length, 2);
  const run = h.broker.getDiagnostics().replay.find((item) => item.runId === "run-long");
  assert.equal(run.upstreamState, "detached");
  assert.equal(run.lastRestoreResult, "observer_released:detached");
});

test("an unsolicited upstream detach of an observed query stream keeps the query open on a resumed attach", async (t) => {
  const h = createHarness(t);
  const observer = rootObserver();
  h.broker.activateRootObserver(observer);
  const events = [];
  const query = h.broker.query({
    baseUrl: "http://127.0.0.1:8080", token: h.token, id: "op-lost", runId: "run-lost", chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" }, observerToken: observer.token,
    payload: { runId: "run-lost", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: (event) => events.push(event.type),
  });
  await waitUntil(() => requestOfType(h.socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(h.socket("primary"), "/api/query")[0];
  h.socket("primary").emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-lost", "chat-1", 1) });
  await query.accepted;
  h.socket("primary").emit({ frame: "stream", id: upstream.id, reason: "detached", lastSeq: 1 });
  await nextTurn();
  const resumed = requestOfType(h.socket("primary"), "/api/attach")[0];
  assert.equal(resumed.payload.lastSeq, 1);
  h.socket("primary").emit({ frame: "stream", id: resumed.id, event: runEvent("awaiting.ask", "run-lost", "chat-1", 2, { awaitingId: "aw-1" }) });
  h.socket("primary").emit({ frame: "stream", id: resumed.id, event: runEvent("run.complete", "run-lost", "chat-1", 3) });
  h.socket("primary").emit({ frame: "stream", id: resumed.id, reason: "done", lastSeq: 3 });
  assert.deepEqual(await query.completed, { reason: "done", lastSeq: 3 });
  assert.deepEqual(events, ["run.start", "awaiting.ask", "run.complete"]);
});

test("only Primary dispatches reverse Desktop Actions and preserves duplicate protection", async (t) => {
  assert.equal(getDesktopActionDefinition("desktop.awcp.manual"), null);
  assert.equal(getDesktopActionDefinition("desktop.awcp.invoke"), null);
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

test("ordinary Chat Surface requests require a live canonical Run grant", async (t) => {
  const { broker, socket, token } = createHarness(t);
  let calls = 0;
  broker.setDesktopBridgeProvider({
    action: async () => { calls++; return { ok: true, result: {} }; },
    cdp: async () => { calls++; return { ok: true, result: {} }; },
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  const source = { chatId: "chat-surface", runId: "run-surface", agentKey: "agent-1" };
  const requests = [
    { frame: "request", type: "desktop.web.listSurfaces", source, payload: {} },
    { frame: "request", type: "desktop.cdp.call", payload: { method: "Surface.list", source } },
  ];
  async function send(suffix, expected) {
    for (const [index, request] of requests.entries()) {
      const id = `surface-${suffix}-${index}`;
      socket("primary").emit({ ...request, id });
      await waitUntil(() => socket("primary").sent.some((frame) => frame.id === id));
      const result = socket("primary").sent.find((frame) => frame.id === id);
      assert.equal(result.frame, expected);
      if (expected === "error") assert.equal(result.type, "source_chat_not_ready");
    }
  }
  await send("unbound", "error");
  assert.equal(calls, 0);
  broker.registerRunActionGrant({ sourceId: "main-chat:surface", chatId: source.chatId, runId: source.runId,
    owner: { kind: "agent", agentKey: source.agentKey }, ready: Promise.resolve() });
  await send("ready", "response");
  assert.equal(calls, 2);
  socket("primary").emit({ frame: "push", type: "run.finished", data: { ...source,
    status: "completed", finishReason: "complete", finishedAt: EPOCH_MS + 10 } });
  await send("finished", "error");
  assert.equal(calls, 2);
});

test("Primary chunks large reverse Desktop responses below 256 KiB", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const screenshot = Buffer.alloc(420_000, 7).toString("base64");
  broker.siteControlGrants.bind({ runId: "run-1", chatId: "chat-1", owner: { kind: "agent", agentKey: "agent-1" } },
    { release() {}, activate() {}, readContainer() { return { tabs: [] }; } });
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

test("AWCP business failures stay in response frames while host failures stay AGW errors", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const scope = { release() {}, activate() {}, readContainer() { return { tabs: [] }; } };
  broker.siteControlGrants.bind(
    { runId: "run-awcp", chatId: "chat-awcp", owner: { kind: "agent", agentKey: "agent-1" } },
    scope,
  );
  const calls = [];
  broker.setDesktopBridgeProvider({
    action: async (request) => ({ ok: false, action: request.action, error: { code: "ordinary_failure", message: "failed" } }),
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
    awcpManual: async (_requestId, payload, granted, signal) => {
      calls.push({ manual: true, payload, granted, signal });
      return { ok: true, method: "AWCP.getManual", revision: "revision-a",
        site: { name: "Orders", description: "Order operations." }, sections: [] };
    },
    awcpInvoke: async (requestId, payload, granted, signal) => {
      calls.push({ requestId, payload, granted, signal });
      return { ok: false, requestId, action: payload.action, error: { code: "stale_revision", message: "stale" } };
    },
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  const source = { runId: "run-awcp", chatId: "chat-awcp", agentKey: "agent-1" };
  socket("primary").emit({ frame: "request", type: "desktop.awcp.manual", id: "awcp-manual", source, payload: {} });
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === "awcp-manual"));
  const manual = socket("primary").sent.find((frame) => frame.id === "awcp-manual");
  assert.equal(manual.frame, "response");
  assert.deepEqual(manual.data, { ok: true, method: "AWCP.getManual", revision: "revision-a",
    site: { name: "Orders", description: "Order operations." }, sections: [] });
  assert.equal(calls[0].granted, scope);

  socket("primary").emit({ frame: "request", type: "desktop.awcp.manual", id: "awcp-manual-extra", source, payload: { targetId: "forged" } });
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === "awcp-manual-extra"));
  assert.equal(socket("primary").sent.find((frame) => frame.id === "awcp-manual-extra").frame, "error");
  assert.equal(calls.length, 1);

  socket("primary").emit({ frame: "request", type: "desktop.awcp.manual", id: "awcp-manual-legacy", source,
    payload: { section: "orders.read" } });
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === "awcp-manual-legacy"));
  assert.equal(socket("primary").sent.find((frame) => frame.id === "awcp-manual-legacy").frame, "error");
  assert.equal(calls.length, 1);

  socket("primary").emit({ frame: "request", type: "desktop.awcp.invoke", id: "awcp-1", source,
    payload: { revision: "revision-a", action: "orders.read", args: {} } });
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === "awcp-1"));
  const awcp = socket("primary").sent.find((frame) => frame.id === "awcp-1");
  assert.equal(awcp.frame, "response");
  assert.deepEqual(awcp.data, { ok: false, requestId: "awcp-1", action: "orders.read", error: { code: "stale_revision", message: "stale" } });
  assert.equal(calls[1].granted, scope);

  socket("primary").emit({ frame: "request", type: "desktop.pet.show", id: "ordinary-1", source, payload: {} });
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === "ordinary-1"));
  assert.equal(socket("primary").sent.find((frame) => frame.id === "ordinary-1").frame, "error");

  broker.setDesktopBridgeProvider({
    action: async () => ({ ok: true, action: "desktop.pet.show", result: {} }),
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
    awcpManual: async () => ({ ok: true, method: "AWCP.getManual", revision: "revision-a",
      site: { name: "Orders", description: "Order operations." }, sections: [] }),
    awcpInvoke: async () => { throw Object.assign(new Error("invalid page response"), {
      code: "awcp_invalid_response",
      statusCode: 502,
      details: { reason: "response_shape_mismatch" },
    }); },
  });
  socket("primary").emit({ frame: "request", type: "desktop.awcp.invoke", id: "awcp-2", source,
    payload: { revision: "revision-a", action: "orders.read", args: {} } });
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === "awcp-2"));
  const hostFailure = socket("primary").sent.find((frame) => frame.id === "awcp-2");
  assert.equal(hostFailure.frame, "error");
  assert.equal(hostFailure.type, "awcp_invalid_response");
  assert.deepEqual(hostFailure.data, { reason: "response_shape_mismatch" });
});

test("AWCP routes manual and invoke by surfaceId without forwarding host selectors to the page", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const scope = { release() {}, activate() {}, readContainer() { return { tabs: [] }; } };
  const source = { runId: "run-surface-awcp", chatId: "chat-awcp", agentKey: "agent-1" };
  broker.siteControlGrants.bind({ ...source, owner: { kind: "agent", agentKey: "agent-1" } }, scope);
  const calls = [];
  const handle = async (requestId, payload, granted, signal, surfaceId) => {
    calls.push({ payload, granted, surfaceId });
    return { ok: true, requestId };
  };
  broker.setDesktopBridgeProvider({
    action: async () => assert.fail("AWCP entered desktop_action"),
    cdp: async () => assert.fail("AWCP entered raw CDP"),
    awcpManual: handle, awcpInvoke: handle,
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  let sequence = 0;
  const send = async (type, payload) => {
    const id = `surface-awcp-${++sequence}`;
    socket("primary").emit({ frame: "request", type, id, source, payload });
    await waitUntil(() => socket("primary").sent.some(frame => frame.id === id));
    return socket("primary").sent.find(frame => frame.id === id);
  };
  for (const [type, payload] of [
    ["desktop.awcp.manual", {}],
    ["desktop.awcp.manual", { section: "orders.read", revision: "revision-a" }],
    ["desktop.awcp.invoke", { action: "orders.read", revision: "revision-a", args: {} }],
  ]) {
    assert.equal((await send(type, { ...payload, surfaceId: "page:selected" })).frame, "response");
    assert.deepEqual(calls.at(-1), { payload, granted: scope, surfaceId: "page:selected" });
    for (const invalid of ["", " ", 7, null]) {
      assert.equal((await send(type, { ...payload, surfaceId: invalid })).type, "protocol_error");
    }
  }
  assert.equal(calls.length, 3);
  assert.equal((await send("desktop.awcp.manual", { surfaceId: "page:selected", section: "orders.read" })).type, "protocol_error");
  assert.equal((await send("desktop.awcp.manual", { targetId: "removed" })).type, "protocol_error");
  assert.equal(calls.length, 3);
});

test("AWCP preflight proof is sent directly in AGW error data, not a nested details envelope", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const scope = { release() {}, activate() {}, readContainer() { return { tabs: [] }; } };
  const source = { runId: "run-preflight", chatId: "chat-preflight", agentKey: "agent-1" };
  broker.siteControlGrants.bind({ ...source, owner: { kind: "agent", agentKey: "agent-1" } }, scope);
  const proof = { stage: "desktop_preflight", executionStarted: false, reason: "page_changed" };
  broker.setDesktopBridgeProvider({
    action: async () => assert.fail("AWCP entered desktop_action"),
    cdp: async () => assert.fail("AWCP entered raw CDP"),
    awcpManual: async () => assert.fail("unexpected manual"),
    awcpInvoke: async () => { throw Object.assign(new Error("Invalid input"), {
      code: "awcp_preflight_rejected", statusCode: 400, details: proof,
    }); },
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  socket("primary").emit({ frame: "request", type: "desktop.awcp.invoke", id: "preflight-input", source,
    payload: { revision: "revision-a", action: "orders.read", args: {} } });
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === "preflight-input"));
  const frame = socket("primary").sent.find((frame) => frame.id === "preflight-input");
  assert.equal(frame.frame, "error");
  assert.equal(frame.type, "awcp_preflight_rejected");
  assert.equal(frame.code, 400);
  assert.deepEqual(frame.data, proof);
  assert.equal(frame.data.details, undefined);
});

test("desktop.bridge.cancel aborts the exact in-flight AWCP request without a terminal frame", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const scope = { release() {}, activate() {}, readContainer() { return { tabs: [] }; } };
  broker.siteControlGrants.bind(
    { runId: "run-awcp-cancel", chatId: "chat-awcp-cancel", owner: { kind: "agent", agentKey: "agent-1" } },
    scope,
  );
  let invocationSignal;
  broker.setDesktopBridgeProvider({
    action: async () => ({ ok: true, action: "desktop.pet.show", result: {} }),
    cdp: async () => ({ ok: true, method: "Runtime.evaluate", result: {} }),
    awcpManual: async () => ({ ok: true, method: "AWCP.getManual", revision: "revision-a",
      site: { name: "Orders", description: "Order operations." }, sections: [] }),
    awcpInvoke: async (requestId, payload, _granted, signal) => {
      invocationSignal = signal;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({
        ok: false,
        requestId,
        action: payload.action,
        error: { code: "cancelled", message: "cancelled" },
      }), { once: true }));
    },
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  socket("primary").emit({
    frame: "request",
    type: "desktop.awcp.invoke",
    id: "awcp-cancel",
    source: { runId: "run-awcp-cancel", chatId: "chat-awcp-cancel", agentKey: "agent-1" },
    payload: { revision: "revision-a", action: "orders.read", args: {} },
  });
  await waitUntil(() => invocationSignal);
  socket("primary").emit({ frame: "push", type: "desktop.bridge.cancel", payload: { requestId: "awcp-cancel" } });
  await waitUntil(() => invocationSignal.aborted);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket("primary").sent.some((frame) => frame.id === "awcp-cancel"), false);
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
      owner: { kind: 'agent', agentKey: 'agent-1' }, observerToken: observer.token, siteControlScope: scope, onEvent() {} });
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
      const surface = granted.readContainer(); calls.push(surface);
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
    owner: { kind: 'agent', agentKey: 'agent-1' }, observerToken: observer.token, siteControlScope: scope, onEvent() {} });
  void request.completed.catch(() => undefined);
  await waitUntil(() => requestOfType(socket('primary') ?? { sent: [] }, '/api/query').length === 1);
  const outbound = requestOfType(socket('primary'), '/api/query')[0];
  socket('primary').emit({ frame: 'stream', id: outbound.id, event: runEvent('run.start', 'run-site', 'chat-site', 1) });
  await request.accepted;
  broker.releaseRootObserver(observer.token);
  socket('primary').disconnect();
  await broker.ensureConnected('http://127.0.0.1:8080', token);
  assert.equal(scope.readContainer().surfaceId, a.surfaceId);
  assert.equal(sockets.flatMap((socket) => requestOfType(socket, '/api/query')).length, 1);
  broker.rotateIdentity();
  assert.throws(() => scope.readContainer(), { code: 'site_control_unavailable' });
  assert.equal(h.contents.get(a.tabs[0].webContentsId).throttle, true);
});

for (const [from, to] of [["main_chat", "kanban_chat"], ["copilot_dock", "kanban_chat"], ["kanban_chat", "main_chat"], ["main_chat", "copilot_dock"]]) {
  test(`${from} to ${to} retires the old root and waits for detach before a different Chat attaches`, async (t) => {
    const { broker, socket, sockets, token } = createHarness(t);
    const first = rootObserver({ token: "first", kind: from });
    broker.activateRootObserver(first);
    const options = { baseUrl: "http://127.0.0.1:8080", token, owner: { kind: "agent", agentKey: "agent-1" }, kind: "surface", onEvent: () => {} };
    const old = broker.subscribeRun({ ...options, observerToken: first.token, consumerId: "old", runId: "old-run", chatId: "chat-1" });
    await old.ready;
    const upstream = requestOfType(socket("primary"), "/api/attach")[0];
    const second = rootObserver({ token: "second", kind: to, contextId: "chat-2" });
    broker.activateRootObserver(second);
    const next = broker.subscribeRun({ ...options, observerToken: second.token, consumerId: "new", runId: "new-run", chatId: "chat-2", lastSeq: 7 });
    await waitUntil(() => requestOfType(socket("primary"), "/api/detach").length === 1);
    assert.equal(requestOfType(socket("primary"), "/api/attach").length, 1);
    assert.equal(broker.getActiveRootObserver().token, second.token);
    assert.equal(broker.getMainChatRootObserver()?.token ?? null, to === "main_chat" ? second.token : null);
    assert.throws(() => broker.subscribeRun({ ...options, observerToken: first.token, consumerId: "stale", runId: "old-run", chatId: "chat-1" }), /no longer active/);
    const detach = requestOfType(socket("primary"), "/api/detach")[0];
    socket("primary").emit({ frame: "response", id: detach.id, data: { accepted: true, streamRequestId: upstream.id, lastSeq: 3 } });
    await next.ready;
    assert.equal(requestOfType(socket("primary"), "/api/attach").length, 2);
    assert.equal(requestOfType(socket("primary"), "/api/attach")[1].payload.lastSeq, 7);
    assert.equal(requestOfType(socket("primary"), "/api/interrupt").length, 0);
    assert.equal(sockets.length, 1);
    assert.equal(broker.getDiagnostics().replay.find((run) => run.runId === "old-run").state, "dormant");
    broker.releaseRootObserver(second.token);
    await waitUntil(() => requestOfType(socket("primary"), "/api/detach").length === 2);
    assert.equal(broker.getActiveRootObserver(), null);
  });
}

test("a query for the replacement root waits for detach and stale waiting queries never send", async (t) => {
  const { broker, socket, token } = createHarness(t);
  broker.activateRootObserver(rootObserver());
  const options = { baseUrl: "http://127.0.0.1:8080", token, owner: { kind: "agent", agentKey: "agent-1" }, onEvent: () => {} };
  const old = broker.subscribeRun({ ...options, kind: "surface", observerToken: rootObserver().token, consumerId: "old", runId: "old-run", chatId: "chat-1" });
  await old.ready;
  const upstream = requestOfType(socket("primary"), "/api/attach")[0];
  const nextRoot = rootObserver({ token: "new-root", contextId: "chat-2" });
  broker.activateRootObserver(nextRoot);
  const query = broker.query({ ...options, id: "waiting-query", chatId: "chat-2", observerToken: nextRoot.token, payload: { chatId: "chat-2", agentKey: "agent-1", message: "hello" } });
  const rejected = Promise.all([assert.rejects(query.accepted, /changed before query delivery/), assert.rejects(query.completed, /changed before query delivery/)]);
  await waitUntil(() => requestOfType(socket("primary"), "/api/detach").length === 1);
  assert.equal(requestOfType(socket("primary"), "/api/query").length, 0);
  broker.activateRootObserver(rootObserver({ token: "newer-root", contextId: "chat-3" }));
  const current = broker.query({ ...options, id: "current-query", chatId: "chat-3", observerToken: "newer-root", payload: { chatId: "chat-3", agentKey: "agent-1", message: "hello" } });
  const detach = requestOfType(socket("primary"), "/api/detach")[0];
  socket("primary").emit({ frame: "response", id: detach.id, data: { accepted: true, streamRequestId: upstream.id, lastSeq: 3 } });
  await rejected;
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const request = requestOfType(socket("primary"), "/api/query")[0];
  assert.equal(request.payload.chatId, "chat-3");
  socket("primary").emit({ frame: "stream", id: request.id, event: runEvent("run.start", "new-run", "chat-3", 1) });
  await current.accepted;
  socket("primary").emit({ frame: "stream", id: request.id, reason: "complete", lastSeq: 1 });
  await current.completed;
});

test("reverse CDP validation retains field diagnostics in the error frame", async (t) => {
  const { handleDesktopCdpRequest } = require("../dist-electron/main/modules/desktop-actions/runtime.js");
  const { broker, socket, token } = createHarness(t);
  let executed = false;
  broker.siteControlGrants.bind({ runId: "run-1", chatId: "chat-1", owner: { kind: "agent", agentKey: "agent-1" } },
    { release() {}, activate() {}, readContainer() { return { tabs: [] }; } });
  broker.setDesktopBridgeProvider({
    action: async () => ({ ok: true }),
    cdp: (request) => handleDesktopCdpRequest({ executeCdpCommand: async () => { executed = true; return { result: {} }; } }, request)
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  socket("primary").emit({
    frame: "request", type: "desktop.cdp.call", id: "invalid-mouse",
    payload: {
      method: "Input.dispatchMouseEvent", surfaceId: "page:test",
      params: { type: "mousePressed", x: "646", y: "344", button: "left", clickCount: "1" },
      source: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1" }
    }
  });
  await waitUntil(() => socket("primary").sent.some((frame) => frame.id === "invalid-mouse"));
  const frame = socket("primary").sent.find((frame) => frame.id === "invalid-mouse");
  assert.equal(frame.frame, "error");
  assert.equal(frame.type, "invalid_args");
  assert.equal(frame.code, 400);
  assert.equal(frame.data.method, "Input.dispatchMouseEvent");
  assert.equal(frame.data.error.details.issues.length, 3);
  assert.equal(frame.data.error.details.executed, false);
  assert.equal(frame.data.error.details.surfaceId, "page:test");
  assert.equal(executed, false);
});

test("Desktop action errors use flat transport diagnostics without internal result envelope", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const details = { category: "validation", stage: "arguments", executionState: "not_started", issues: [{ path: "args.input", code: "required", expected: "object", actual: "missing" }], recovery: { strategy: "fix_input", message: "Read @connectors/builtin.platform-control/skills/platform-control/references/kanban.md" } };
  broker.setDesktopBridgeProvider({
    action: async request => ({ ok: false, action: request.action, error: { code: "invalid_args", message: "args.input must be an object.", details } }),
    cdp: async () => ({ ok: true }),
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  socket("primary").emit({ frame: "request", type: "desktop.kanban.createIssue", id: "action-invalid", source: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1" }, payload: {} });
  await waitUntil(() => socket("primary").sent.some(frame => frame.id === "action-invalid"));
  assert.deepEqual(socket("primary").sent.find(frame => frame.id === "action-invalid"), {
    frame: "error", type: "invalid_args", id: "action-invalid", code: 400, msg: "args.input must be an object.",
    data: { action: "desktop.kanban.createIssue", details },
  });
});

test("Desktop Worker internal failures preserve causes and use a server error frame", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const details = { category: "internal", stage: "internal", executionState: "not_started", cause: { code: "ENOENT", message: "Worker entry missing" }, recovery: { strategy: "repair_host", message: "Rebuild Main and Worker together." }, diagnosticId: "diagnostic-worker-1" };
  broker.setDesktopBridgeProvider({
    action: async request => ({ ok: false, action: request.action, error: { code: "tooling_worker_unavailable", message: "Worker entry missing", details } }),
    cdp: async () => ({ ok: true }),
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  socket("primary").emit({ frame: "request", type: "desktop.webapp.package.init", id: "worker-missing", source: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1" }, payload: {} });
  await waitUntil(() => socket("primary").sent.some(frame => frame.id === "worker-missing"));
  const frame = socket("primary").sent.find(frame => frame.id === "worker-missing");
  assert.equal(frame.code, 500);
  assert.equal(frame.type, "tooling_worker_unavailable");
  assert.deepEqual(frame.data.details, details);
});

test("ordinary Chat AWCP requires live Run ownership and reuses the exact page scope until termination", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const source = { chatId: "chat-awcp-wp", runId: "run-awcp-wp", agentKey: "agent-1" };
  let acquired = 0, released = 0, calls = 0;
  const scope = { readContainer() { return { tabs: [] }; }, release() { released++; } };
  broker.setDesktopBridgeProvider({
    acquireWorkPanelAwcpScope: (surfaceId, chatId) => {
      assert.equal(surfaceId, "page:workpanel"); assert.equal(chatId, source.chatId); acquired++; return scope;
    },
    awcpManual: async (_id, _payload, granted) => { assert.equal(granted, scope); calls++; return { ok: true }; },
    awcpInvoke: async (_id, _payload, granted) => { assert.equal(granted, scope); calls++; return { ok: true }; },
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  let sequence = 0;
  async function send(type = "desktop.awcp.manual", payload = { surfaceId: "page:workpanel" }, caller = source) {
    const id = `wp-awcp-${++sequence}`;
    socket("primary").emit({ frame: "request", type, id, source: caller, payload });
    await waitUntil(() => socket("primary").sent.some((frame) => frame.id === id));
    return socket("primary").sent.find((frame) => frame.id === id);
  }
  assert.equal((await send()).type, "source_chat_not_ready");
  broker.registerRunActionGrant({ sourceId: "main-chat:awcp", ...source,
    owner: { kind: "agent", agentKey: source.agentKey }, ready: Promise.resolve() });
  assert.equal((await send("desktop.awcp.manual", {})).type, "protocol_error");
  assert.equal((await send()).frame, "response");
  assert.equal((await send("desktop.awcp.manual", { surfaceId: "page:workpanel", revision: "v1", section: "read" })).frame, "response");
  assert.equal((await send("desktop.awcp.invoke", { surfaceId: "page:workpanel", revision: "v1", action: "read", args: {} })).frame, "response");
  assert.equal(acquired, 1); assert.equal(calls, 3);
  assert.equal((await send(undefined, undefined, { ...source, chatId: "chat-other" })).frame, "error");
  assert.equal((await send(undefined, undefined, { ...source, agentKey: "agent-other" })).frame, "error");
  socket("primary").emit({ frame: "push", type: "run.finished", data: { ...source,
    status: "completed", finishReason: "complete", finishedAt: EPOCH_MS + 10 } });
  assert.equal((await send()).type, "source_chat_not_ready");
  assert.equal(released, 1); assert.equal(calls, 3);
});

async function createChatAwcpRoutingHarness(t, options = {}) {
  const h = createHarness(t);
  const source = { chatId: 'chat-chrome-awcp', runId: 'run-chrome-awcp', agentKey: 'agent-1' };
  const calls = { browser: [], acquired: [], native: [] };
  const scope = { release() {}, activate() {}, readContainer() { return { tabs: [] }; } };
  h.broker.setDesktopBridgeProvider({
    action: async () => assert.fail('AWCP must not become a desktop action'),
    cdp: async () => assert.fail('AWCP must not become raw CDP'),
    acquireWorkPanelAwcpScope(surfaceId, chatId) {
      calls.acquired.push({ surfaceId, chatId });
      assert.equal(options.workpanel, true, 'a Chrome rejection must not fall back to a WorkPanel scope');
      return scope;
    },
    async awcpManual(requestId, payload, granted, signal, surfaceId) {
      calls.native.push({ requestId, payload, granted, signal, surfaceId });
      return { ok: true, method: 'AWCP.getManual', revision: 'v1', site: { name: 'Orders', description: 'Fixture' }, sections: [] };
    },
    async awcpInvoke() { assert.fail('Chrome invoke must not use the native provider'); },
    async browserAwcp(requestId, method, payload, caller, signal, surfaceId) {
      calls.browser.push({ requestId, method, payload, source: caller, signal, surfaceId });
      if (options.browserAwcp) return options.browserAwcp(requestId, method, payload, caller, signal, surfaceId);
      if (surfaceId !== 'chrome:selected') throw Object.assign(new Error('The selected Chrome page is unavailable.'), { code: 'target_not_found', statusCode: 409 });
      return { handled: true, result: method === 'AWCP.invoke'
        ? { ok: false, requestId, action: payload.action, error: { code: 'invalid_arguments', message: 'A fixture field is invalid.' } }
        : { ok: true, method, revision: 'v1', site: { name: 'Orders', description: 'Fixture' }, sections: [] } };
    },
  });
  h.broker.registerRunActionGrant({ sourceId: 'main-chat:chrome-awcp', ...source,
    owner: { kind: 'agent', agentKey: source.agentKey }, ready: options.ready ?? Promise.resolve() });
  await h.broker.ensureConnected('http://127.0.0.1:8080', h.token, 'primary');
  let sequence = 0;
  const send = async (type = 'desktop.awcp.manual', payload = { surfaceId: 'chrome:selected' }, caller = source) => {
    const id = `chrome-awcp-route-${++sequence}`;
    h.socket('primary').emit({ frame: 'request', id, type, source: caller, payload });
    await waitUntil(() => h.socket('primary').sent.some(frame => frame.id === id));
    return h.socket('primary').sent.find(frame => frame.id === id);
  };
  return { ...h, source, calls, scope, send };
}

test('Chrome AWCP routing waits for canonical readiness and preserves business failure responses', async t => {
  let ready;
  const h = await createChatAwcpRoutingHarness(t, { ready: new Promise(resolve => { ready = resolve; }) });
  const manual = h.send();
  await nextTurn();
  assert.equal(h.calls.browser.length, 0);
  assert.equal(h.calls.acquired.length, 0);
  ready();
  assert.equal((await manual).frame, 'response');
  const first = h.calls.browser[0];
  assert.equal(first.method, 'AWCP.getManual');
  assert.deepEqual(first.payload, {}, 'surfaceId is a host selector, not a page parameter');
  assert.deepEqual(first.source, h.source);
  assert.equal(first.surfaceId, 'chrome:selected');
  const failed = await h.send('desktop.awcp.invoke', { surfaceId: 'chrome:selected', revision: 'v1', action: 'orders.read', args: {} });
  assert.equal(failed.frame, 'response');
  assert.equal(failed.data.ok, false);
  assert.equal(failed.data.error.code, 'invalid_arguments');
  assert.equal(h.calls.browser[1].method, 'AWCP.invoke');
  assert.deepEqual(h.calls.browser[1].payload, { revision: 'v1', action: 'orders.read', args: {} });
  assert.equal(h.calls.acquired.length, 0);
  assert.equal(h.calls.native.length, 0);
});

test('Chrome AWCP rejects unowned sources, missing exact surfaces and malformed envelopes before page execution', async t => {
  const h = await createChatAwcpRoutingHarness(t);
  for (const caller of [{ ...h.source, chatId: 'other-chat' }, { ...h.source, agentKey: 'other-agent' },
    { ...h.source, runId: 'unknown-run' }, { chatId: h.source.chatId, runId: h.source.runId }]) {
    assert.equal((await h.send(undefined, undefined, caller)).frame, 'error');
  }
  for (const payload of [{}, { surfaceId: '' }, { surfaceId: null }, { surfaceId: 'chrome:selected', targetId: 'forged' }]) {
    assert.equal((await h.send('desktop.awcp.manual', payload)).type, 'protocol_error');
  }
  for (const payload of [{ surfaceId: 'chrome:selected', revision: 'v1', action: 'orders.read', args: '', },
    { surfaceId: 'chrome:selected', revision: 'v1', action: 'orders.read', args: {}, script: 'forged' }]) {
    assert.equal((await h.send('desktop.awcp.invoke', payload)).type, 'awcp_invalid_request');
  }
  assert.equal(h.calls.browser.length, 0);
  assert.equal((await h.send('desktop.awcp.manual', { surfaceId: 'chrome:other-chat' })).type, 'target_not_found');
  assert.equal(h.calls.browser.length, 1);
  assert.equal(h.calls.acquired.length, 0);
  assert.equal(h.calls.native.length, 0);
});

test('failed canonical readiness rejects Chrome AWCP before either browser or WorkPanel can execute', async t => {
  let failReady;
  const h = await createChatAwcpRoutingHarness(t, { ready: new Promise((_resolve, reject) => { failReady = reject; }) });
  const reply = h.send();
  await nextTurn();
  failReady(new Error('The source Chat is unavailable.'));
  assert.equal((await reply).type, 'source_chat_not_ready');
  assert.equal(h.calls.browser.length, 0); assert.equal(h.calls.acquired.length, 0); assert.equal(h.calls.native.length, 0);
});

test('Chrome AWCP host failures retain the original AGW error and cannot acquire a native fallback', async t => {
  const proof = { stage: 'desktop_preflight', executionStarted: false, reason: 'page_changed' };
  const h = await createChatAwcpRoutingHarness(t, { browserAwcp: async () => {
    throw Object.assign(new Error('The AWCP page changed.'), { code: 'awcp_preflight_rejected', statusCode: 409, details: proof });
  } });
  const frame = await h.send('desktop.awcp.invoke', { surfaceId: 'chrome:selected', revision: 'v1', action: 'orders.read', args: {} });
  assert.equal(frame.frame, 'error'); assert.equal(frame.type, 'awcp_preflight_rejected'); assert.equal(frame.code, 409);
  assert.deepEqual(frame.data, proof); assert.equal(frame.data.details, undefined);
  assert.equal(h.calls.acquired.length, 0); assert.equal(h.calls.native.length, 0);
});

test('explicit non-Chrome AWCP dispatch keeps the exact WorkPanel path while native app scopes bypass the browser hook', async t => {
  const h = await createChatAwcpRoutingHarness(t, { workpanel: true, browserAwcp: async () => ({ handled: false }) });
  assert.equal((await h.send('desktop.awcp.manual', { surfaceId: 'page:workpanel' })).frame, 'response');
  assert.deepEqual(h.calls.acquired, [{ surfaceId: 'page:workpanel', chatId: h.source.chatId }]);
  assert.equal(h.calls.native[0].granted, h.scope);
  h.broker.siteControlGrants.bind({ ...h.source, owner: { kind: 'agent', agentKey: h.source.agentKey } }, h.scope);
  assert.equal((await h.send('desktop.awcp.manual', {})).frame, 'response');
  assert.equal(h.calls.browser.length, 1, 'an existing app grant must not enter Chrome routing');
  assert.equal(h.calls.acquired.length, 1);
  assert.equal(h.calls.native.length, 2);
});

for (const phase of ['readiness', 'browser']) {
test(`Chrome AWCP cancellation during ${phase} cannot return a late result or acquire WorkPanel`, async t => {
  let releaseReady;
  let invocationSignal;
  const ready = phase === 'readiness' ? new Promise(resolve => { releaseReady = resolve; }) : Promise.resolve();
  const h = await createChatAwcpRoutingHarness(t, { ready, browserAwcp: async (_id, _method, _payload, _source, signal) => {
    invocationSignal = signal;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ handled: false }), { once: true }));
  } });
  const id = 'chrome-awcp-route-cancel';
  h.socket('primary').emit({ frame: 'request', id, type: 'desktop.awcp.manual', source: h.source, payload: { surfaceId: 'chrome:selected' } });
  if (phase === 'browser') await waitUntil(() => invocationSignal);
  else await nextTurn();
  h.socket('primary').emit({ frame: 'push', type: 'desktop.bridge.cancel', payload: { requestId: id } });
  releaseReady?.();
  await nextTurn();
  if (phase === 'browser') assert.equal(invocationSignal.aborted, true);
  else assert.equal(h.calls.browser.length, 0);
  assert.equal(h.socket('primary').sent.some(frame => frame.id === id), false);
  assert.equal(h.calls.acquired.length, 0); assert.equal(h.calls.native.length, 0);
});
}

for (const lane of ["primary", "btw", "selection-explain"]) {
  test(`${lane} unified query preserves current selection annotations through acceptance and steer`, async (t) => {
    const h = createHarness(t);
    const references = [{ id: "selection-1", type: "selection", text: "selected original", annotation: "user instruction", annotationIndex: 7 }];
    const payload = { chatId: "chat-1", agentKey: "agent-1", message: "explain", references };
    const query = h.broker.query({ baseUrl: "http://127.0.0.1:8080", token: h.token,
      id: `selection-${lane}`, lane, requestType: lane === "primary" ? "/api/query" : "/api/btw",
      chatId: "chat-1", payload, onEvent() {} });
    await waitUntil(() => h.socket(lane)?.sent.some((frame) => frame.type === "/api/query"));
    const socket = h.socket(lane);
    const request = requestOfType(socket, "/api/query")[0];
    assert.deepEqual(request.payload, payload);
    assert.equal(requestOfType(socket, "/api/btw").length, 0);
    socket.emit({ frame: "stream", id: request.id, event: runEvent("run.start", `run-${lane}`, "chat-1", 1) });
    await query.accepted;
    const id = await h.broker.forwardRequest({ baseUrl: "http://127.0.0.1:8080", token: h.token,
      localId: "selection-steer", consumerId: "test", type: "/api/steer",
      payload: { runId: `run-${lane}`, references }, onFrame() {}, onError() {} });
    assert.deepEqual(requestOfType(socket, "/api/steer")[0].payload.references, references);
    assert.equal(h.sockets.length, 1);
    socket.emit({ frame: "response", id, data: { accepted: true } });
    socket.emit({ frame: "stream", id: request.id, event: runEvent("run.complete", `run-${lane}`, "chat-1", 2) });
    socket.emit({ frame: "stream", id: request.id, reason: "done", lastSeq: 2 });
    await query.completed;
  });
}

for (const platform of ['darwin', 'win32']) {
  test(`SSO transitions preserve all lanes and the existing New Chat on ${platform}`, async (t) => {
    const { issueAgentAccessToken } = require('../dist-electron/main/modules/identity/agent-auth.js');
    const h = createHarness(t);
    const app = { getPath: name => `/fixture/sso-broker/${platform}/${name}` };
    const localToken = async () => (await issueAgentAccessToken(app, 'missing',
      async () => ({token: jwt({sub: 'app'})}))).token;
    const observer = rootObserver({ contextId: 'main-chat:g1' });
    h.broker.activateRootObserver(observer);
    for (const lane of ['primary', 'btw', 'selection-explain']) {
      await h.broker.ensureConnected('http://127.0.0.1:8080', await localToken(), lane);
    }
    const { registerSsoIpcHandlers } = require('../dist-electron/main/modules/identity/ipc.js');
    const handlers = new Map();
    let account = 'alice';
    const noop = async () => undefined;
    registerSsoIpcHandlers({handle: (name, handler) => handlers.set(name, handler)}, {
      app,
      desktopSsoController: {broadcastStatus() {}, returnToApp() {}, syncBrowserCookies: noop,
        exchangeWebSession: noop, exchangeBrowserCookieAccessToken: noop,
        logoutWebSession: noop, clearBrowserCookies: noop, clearWebSessionCookies: noop},
      getDesktopSsoStatus: () => ({authenticated: !!account}),
      startDesktopSsoLogin: async (_app, hooks) => {
        const status = {authenticated: true, user: {sub: account}};
        await hooks.onBeforeStatusChanged(status);
        await hooks.onAfterStatusChanged(status);
        hooks.onStatusChanged(status);
        return {ok: true, status};
      },
      logoutDesktopSso: async (_app, hooks) => {
        const status = {authenticated: false}; hooks.onStatusChanged(status);
        return {ok: true, status};
      },
      issueAgentAccessToken: async () => ({ok: true, token: await localToken()}),
    });
    for (const sub of ['alice', 'bob', null]) {
      account = sub;
      const result = await handlers.get(sub ? 'sso.startLogin' : 'sso.logout')();
      assert.equal(result.ok, true);
      for (const lane of ['primary', 'btw', 'selection-explain']) {
        await h.broker.ensureConnected('http://127.0.0.1:8080', await localToken(), lane);
      }
      assert.equal(h.broker.getMainChatRootObserver().token, observer.token);
      assert.equal(h.broker.getDiagnostics().overviewLease.state, 'pending_chat_identity');
    }
    assert.equal(h.sockets.length, 3);
    assert.equal(h.broker.getDiagnostics().laneRotationCount, 0);
    // Submit using the original page binding, without re-registering the surface.
    h.token = await localToken();
    await acceptedRun(h, { lane: 'primary', runId: 'after-sso', observerToken: observer.token });
    assert.equal(h.broker.getDiagnostics().laneRotationCount, 0);
  });
}

test("ordinary Desktop Action receives trusted tool deadline and upstream cancellation", async t => {
  const { broker, socket, token } = createHarness(t);
  let invocationSignal;
  let receivedDeadline;
  broker.setDesktopBridgeProvider({
    action: async (_request, _scope, signal, deadlineAt) => {
      invocationSignal = signal;
      receivedDeadline = deadlineAt;
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      return { ok: false, error: { code: "request_aborted", message: "cancelled" } };
    },
    cdp: async () => ({ ok: true }),
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  const deadlineAt = Date.now() + 60_000;
  socket("primary").emit({ frame: "request", id: "action-cancel", type: "desktop.theme.set", deadlineAt,
    source: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1" }, payload: { themeMode: "dark" } });
  await waitUntil(() => invocationSignal);
  assert.equal(receivedDeadline, deadlineAt);
  socket("primary").emit({ frame: "push", type: "desktop.bridge.cancel", payload: { requestId: "action-cancel" } });
  await waitUntil(() => invocationSignal.aborted);
  await nextTurn();
  assert.equal(socket("primary").sent.some(frame => frame.id === "action-cancel"), false);
});

test("credential actions receive the Run's Website/WebApp page authorization like webpage actions", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const scope = { release() {}, activate() {}, readContainer() { return { tabs: [] }; } };
  broker.siteControlGrants.bind({ runId: "run-1", chatId: "chat-1", owner: { kind: "agent", agentKey: "agent-1" } }, scope);
  const received = new Map();
  broker.setDesktopBridgeProvider({
    action: async (request, actionScope) => {
      received.set(request.action, actionScope);
      return { ok: true, action: request.action, result: {} };
    },
    cdp: async (request) => ({ ok: true, method: request.method, result: {} }),
  });
  await broker.ensureConnected("http://127.0.0.1:8080", token, "primary");
  const source = { runId: "run-1", chatId: "chat-1", agentKey: "agent-1" };
  const actions = ["desktop.credentials.list", "desktop.credentials.fill", "desktop.web.listSurfaces", "desktop.theme.get"];
  for (const type of actions) {
    socket("primary").emit({ frame: "request", type, id: type, source, payload: { surfaceId: "page:1" } });
  }
  await waitUntil(() => actions.every((id) => socket("primary").sent.some((frame) => frame.frame === "response" && frame.id === id)));
  assert.equal(received.get("desktop.credentials.list"), scope);
  assert.equal(received.get("desktop.credentials.fill"), scope);
  assert.equal(received.get("desktop.web.listSurfaces"), scope);
  assert.equal(received.get("desktop.theme.get"), undefined);
});


test("raw Run forwarding is rejected so all consumers use the channel lifecycle", async (t) => {
  const h = createHarness(t);
  for (const type of ["/api/query", "/api/attach"]) {
    await assert.rejects(h.broker.forwardRequest({ baseUrl: "http://127.0.0.1:8080", token: h.token,
      localId: "raw", consumerId: "mobile", type, stream: true, onFrame() {}, onError() {} }), /query or subscribeRun/);
  }
  assert.equal(h.sockets.length, 0);
});

const { AgentPlatformWsBridge } = require("../dist-electron/main/modules/desktop-protocol/ws-platform-adapter.js");
function mobile(h, id = "mobile") {
  const frames = [];
  const connection = { id, closed: false, transport: { sendText(text) { frames.push(JSON.parse(text)); } } };
  const bridge = new AgentPlatformWsBridge({ app: { getPath: () => os.tmpdir() }, agentPlatformBridge: {
    realtimeBroker: h.broker,
    getServiceState: async () => ({ status: "running", healthMeta: { webUrl: "http://127.0.0.1:8080" } }),
    issueAccessToken: async () => ({ ok: true, token: h.token }),
  } }, connection, console);
  return { bridge, frames, request(type, payload) {
    return bridge.forwardRequest({ ns: "ap", frame: "request", type, id: `${id}-request`, payload });
  } };
}

test("query cancellation settles its caller while a PC subscriber keeps receiving the shared stream", { timeout: 2_000 }, async (t) => {
  const h = createHarness(t), controller = new AbortController(), observer = rootObserver();
  h.broker.activateRootObserver(observer);
  const source = [];
  const run = await acceptedRun(h, { lane: "primary", runId: "run-cancelled-source", signal: controller.signal, onEvent: event => source.push(event) });
  const pc = [];
  const subscription = h.broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080", token: h.token, runId: "run-cancelled-source", chatId: "chat-1",
    agentKey: "agent-1", kind: "surface", consumerId: "pc", observerToken: observer.token, onEvent: event => pc.push(event)
  });
  await subscription.ready;
  const cancelled = assert.rejects(run.query.completed, /query aborted/);
  controller.abort();
  await cancelled;
  await nextTurn();
  const sourceCount = source.length;
  run.socket.emit({ frame: "stream", id: run.request.id, event: runEvent("content.delta", "run-cancelled-source", "chat-1", 2, { delta: "still streaming" }) });
  await nextTurn();
  assert.equal(pc.at(-1).delta, "still streaming");
  assert.equal(source.length, sourceCount);
  assert.equal(requestOfType(run.socket, "/api/detach").length, 0);
  assert.equal(requestOfType(run.socket, "/api/interrupt").length, 0);
  subscription.unsubscribe();
});

test("mobile query and an early PC subscriber share one stream through replay, reconnect and peer closure", async (t) => {
  const h = createHarness(t), m = mobile(h), observer = rootObserver();
  t.after(() => m.bridge.close());
  h.broker.activateRootObserver(observer);
  await m.request("/api/query", { requestId: "mobile-message", chatId: "chat-1", agentKey: "agent-1", message: "报告" });
  await waitUntil(() => requestOfType(h.socket("primary"), "/api/query").length === 1);
  let socket = h.socket("primary");
  const upstream = requestOfType(socket, "/api/query")[0];
  socket.emit({ frame: "push", type: "run.started", data: { chatId: "chat-1", runId: "run-mobile", agentKey: "agent-1", startedAt: EPOCH_MS } });
  const pc = [];
  const subscription = h.broker.subscribeRun({ baseUrl: "http://127.0.0.1:8080", token: h.token, runId: "run-mobile", chatId: "chat-1",
    agentKey: "agent-1", kind: "surface", consumerId: "pc", observerToken: observer.token, onEvent: event => pc.push(event) });
  socket.emit({ frame: "stream", id: upstream.id, event: runEvent("request.query", "run-mobile", "chat-1", 1,
    { requestId: "mobile-message", message: "报告" }) });
  socket.emit({ frame: "stream", id: upstream.id, event: runEvent("run.start", "run-mobile", "chat-1", 2) });
  await subscription.ready;
  socket.emit({ frame: "stream", id: upstream.id, event: runEvent("content.delta", "run-mobile", "chat-1", 3, { delta: "一" }) });
  await nextTurn();
  assert.equal(pc.filter(e => e.type === "content.delta").length, 1);
  assert.equal(m.frames.filter(f => f.event?.type === "content.delta").length, 1);
  assert.equal(m.frames.find(f => f.event?.type === "request.query").id, "mobile-request");
  assert.equal(requestOfType(socket, "/api/attach").length, 0);
  assert.equal(h.diagnostics.some(d => d.includes("active_stream_exists")), false);
  socket.disconnect();
  await waitUntil(() => h.sockets.length === 2);
  socket = h.sockets.at(-1);
  await waitUntil(() => requestOfType(socket, "/api/attach").length === 1);
  const attach = requestOfType(socket, "/api/attach")[0];
  assert.equal(attach.payload.lastSeq, 3);
  socket.emit({ frame: "stream", id: attach.id, event: runEvent("content.delta", "run-mobile", "chat-1", 4, { delta: "二" }) });
  await nextTurn();
  assert.deepEqual(pc.filter(e => e.type === "content.delta").map(e => e.delta), ["一", "二"]);
  assert.equal(h.sockets.flatMap(s => requestOfType(s, "/api/query")).length, 1);
  const seen = m.frames.length;
  m.bridge.close();
  await nextTurn();
  assert.equal(requestOfType(socket, "/api/detach").length, 0);
  socket.emit({ frame: "stream", id: attach.id, event: runEvent("content.delta", "run-mobile", "chat-1", 5, { delta: "三" }) });
  await nextTurn();
  assert.equal(m.frames.length, seen);
  assert.equal(pc.at(-1).delta, "三");
  subscription.unsubscribe();
  await waitUntil(() => requestOfType(socket, "/api/detach").length === 1);
  assert.equal(requestOfType(socket, "/api/interrupt").length, 0);
});

test("mobile attach joins the PC query, replays once and does not interrupt the surviving peer", async (t) => {
  const h = createHarness(t), observer = rootObserver(); h.broker.activateRootObserver(observer);
  const pc = [];
  const run = await acceptedRun(h, { lane: "primary", runId: "run-pc", observerToken: observer.token, onEvent: e => pc.push(e) });
  const m = mobile(h); t.after(() => m.bridge.close());
  await m.request("/api/attach", { runId: "run-pc", chatId: "chat-1", agentKey: "agent-1", lastSeq: 0 });
  run.socket.emit({ frame: "stream", id: run.request.id, event: runEvent("content.delta", "run-pc", "chat-1", 2, { delta: "共享" }) });
  await nextTurn();
  assert.equal(m.frames.filter(f => f.event?.type === "run.start").length, 1);
  assert.equal(m.frames.filter(f => f.event?.delta === "共享").length, 1);
  assert.equal(pc.filter(e => e.delta === "共享").length, 1);
  assert.equal(requestOfType(run.socket, "/api/attach").length, 0);
  h.broker.releaseRootObserver(observer.token);
  await nextTurn();
  assert.equal(requestOfType(run.socket, "/api/detach").length, 0);
  m.bridge.close();
  await waitUntil(() => requestOfType(run.socket, "/api/detach").length === 1);
  assert.equal(requestOfType(run.socket, "/api/interrupt").length, 0);
});

test("closing a mobile query before Run acceptance waits for its canonical identity and detaches once", async (t) => {
  const h = createHarness(t), m = mobile(h); t.after(() => m.bridge.close());
  await m.request("/api/query", { chatId: "chat-1", agentKey: "agent-1", message: "工作" });
  await waitUntil(() => requestOfType(h.socket("primary"), "/api/query").length === 1);
  const socket = h.socket("primary"), query = requestOfType(socket, "/api/query")[0];
  m.bridge.close();
  socket.emit({ frame: "stream", id: query.id, event: runEvent("request.query", "run-late", "chat-1", 1, { message: "工作" }) });
  socket.emit({ frame: "stream", id: query.id, event: runEvent("run.start", "run-late", "chat-1", 2) });
  await waitUntil(() => requestOfType(socket, "/api/detach").length === 1);
  assert.equal(m.frames.filter(f => f.frame === "stream").length, 0);
  assert.equal(requestOfType(socket, "/api/interrupt").length, 0);
});

test("closing the mobile connection during availability checks never submits a query", async (t) => {
  const h = createHarness(t), m = mobile(h); t.after(() => m.bridge.close());
  const sending = m.request("/api/query", { chatId: "chat-1", agentKey: "agent-1", message: "工作" });
  m.bridge.close();
  await sending;
  assert.equal(h.sockets.length, 0);
});

test("mobile detach releases only the named connection consumer and is idempotent", async (t) => {
  const h = createHarness(t), observer = rootObserver(); h.broker.activateRootObserver(observer);
  const pc = [];
  const run = await acceptedRun(h, { lane: "primary", runId: "run-detach", observerToken: observer.token, onEvent: e => pc.push(e) });
  const m = mobile(h); t.after(() => m.bridge.close());
  await m.request("/api/attach", { runId: "run-detach", chatId: "chat-1", agentKey: "agent-1" });
  const count = m.frames.length;
  for (const id of ["release-1", "release-2"]) await m.bridge.forwardRequest({ ns: "ap", frame: "request", type: "/api/detach", id,
    payload: { streamRequestId: "mobile-request", runId: "run-detach" } });
  assert.equal(m.frames.find(f => f.id === "release-1").data.accepted, true);
  assert.equal(m.frames.find(f => f.id === "release-2").data.accepted, false);
  const ended = m.frames.length;
  run.socket.emit({ frame: "stream", id: run.request.id, event: runEvent("content.delta", "run-detach", "chat-1", 2, { delta: "继续" }) });
  await nextTurn();
  assert.equal(m.frames.length, ended);
  assert.ok(ended > count);
  assert.equal(pc.at(-1).delta, "继续");
  assert.equal(requestOfType(run.socket, "/api/detach").length, 0);
  assert.equal(requestOfType(run.socket, "/api/interrupt").length, 0);
});

test("upstream requests follow the Agent's detail level unless a Run asks for one", async (t) => {
  const h = createHarness(t);
  const options = { baseUrl: "http://127.0.0.1:8080", token: h.token, payload: {}, onEvent() {} };
  const query = h.broker.query({ ...options, id: "detail-query" });
  query.accepted.catch(() => {});
  query.completed.catch(() => {});
  await waitUntil(() => h.socket("primary")?.sent.some((frame) => frame.type === "/api/query"));
  assert.equal(requestOfType(h.socket("primary"), "/api/query")[0].detail, undefined);

  for (const type of ["/api/chat", "/api/agents"]) {
    void h.broker.forwardRequest({
      baseUrl: options.baseUrl, token: h.token, lane: "primary", localId: `detail-${type}`,
      consumerId: "detail-test", type, payload: { chatId: "chat-1" }, onFrame() {}, onError() {},
    }).catch(() => {});
  }
  await waitUntil(() => requestOfType(h.socket("primary"), "/api/chat").length === 1 &&
    requestOfType(h.socket("primary"), "/api/agents").length === 1);
  assert.equal(requestOfType(h.socket("primary"), "/api/chat")[0].detail, undefined);
  assert.equal(requestOfType(h.socket("primary"), "/api/agents")[0].detail, undefined);
});

test("a Run that reads tool events asks for the full detail level explicitly", async (t) => {
  const h = createHarness(t);
  const query = h.broker.query({ baseUrl: "http://127.0.0.1:8080", token: h.token, payload: {}, onEvent() {}, id: "detail-full", detail: "full" });
  query.accepted.catch(() => {});
  query.completed.catch(() => {});
  await waitUntil(() => h.socket("primary")?.sent.some((frame) => frame.type === "/api/query"));
  assert.equal(requestOfType(h.socket("primary"), "/api/query")[0].detail, "full");
});


test("progress activities forward duplicates without changing cursors or replay; retries remain ordered", () => {
  const { createRunChannels } = require("../dist-electron/main/modules/agent-platform/realtime/run-channels.js");
  const received = [];
  const diagnostics = { seqRegressionCount: 0, seqGapCount: 0 };
  const subscription = { lastSeq: 5, onEvent: event => received.push(event) };
  const channels = createRunChannels({
    diagnostics, options: {}, runSubscriptions: new Map([["reader", subscription]]),
  });
  const run = {
    runId: "activity-run", chatId: "activity-chat", lane: "primary", lastSeq: 5,
    subscribers: new Set(["reader"]), activeWaits: new Map(), replay: [], replayBytes: 0,
  };
  for (const kind of ["announce", "announce", "thinking", "idle"]) {
    const event = runEvent("run.activity", run.runId, run.chatId, 0, {kind, message: kind === "idle" ? "" : "Read Jira"});
    channels.consumeRunEvent(run, event, null);
    // Bootstrap commits use the same replay entry point.
    channels.appendReplay(run, event, 0);
  }
  assert.equal(received.length, 4);
  assert.equal(run.lastSeq, 5);
  assert.equal(subscription.lastSeq, 5);
  assert.deepEqual(run.replay, []);
  assert.equal(run.replayBytes, 0);
  assert.equal(diagnostics.seqRegressionCount, 0);
  const retry = runEvent("run.activity", run.runId, run.chatId, 6, {retry: {attempt: 2}});
  channels.consumeRunEvent(run, retry, null);
  channels.consumeRunEvent(run, retry, null);
  assert.equal(received.length, 5);
  assert.equal(run.lastSeq, 6);
  assert.equal(subscription.lastSeq, 6);
  assert.equal(run.replay.length, 1);
  assert.equal(diagnostics.seqRegressionCount, 1);
});


test("query bootstrap and live progress survive seq zero without entering replay", async (t) => {
  const { broker, socket, token } = createHarness(t);
  const observer = rootObserver();
  broker.activateRootObserver(observer);
  const events = [];
  const query = broker.query({
    baseUrl: "http://127.0.0.1:8080", token, id: "activity-query", runId: "run-activity", chatId: "chat-1",
    owner: { kind: "agent", agentKey: "agent-1" }, observerToken: observer.token, consumerId: "main-chat",
    payload: { runId: "run-activity", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
    onEvent: event => events.push(event),
  });
  await waitUntil(() => requestOfType(socket("primary"), "/api/query").length === 1);
  const upstream = requestOfType(socket("primary"), "/api/query")[0];
  const emit = (type, seq, extra = {}) => socket("primary").emit({
    frame: "stream", id: upstream.id, event: runEvent(type, "run-activity", "chat-1", seq, extra),
  });
  emit("run.activity", 0, {kind: "thinking", message: "Thinking"});
  emit("run.start", 1, {agentKey: "agent-1"});
  await query.accepted;
  for (let i = 0; i < 2; i++) emit("run.activity", 0, {kind: "announce", message: "Read Jira"});
  emit("run.activity", 0, {kind: "idle", message: ""});
  emit("run.activity", 2, {retry: {attempt: 2}});
  emit("run.activity", 2, {retry: {attempt: 2}});
  await nextTurn();
  assert.deepEqual(events.filter(e => e.type === "run.activity" && !e.retry).map(e => e.message),
    ["Thinking", "Read Jira", "Read Jira", ""]);
  assert.equal(events.filter(e => e.retry).length, 1);
  const replay = [];
  broker.subscribeRun({
    baseUrl: "http://127.0.0.1:8080", token, runId: "run-activity", chatId: "chat-1", lastSeq: 0,
    owner: { kind: "agent", agentKey: "agent-1" }, kind: "internal", role: "internal", consumerId: "late-reader",
    onEvent: event => replay.push(event),
  }).unsubscribe();
  assert.deepEqual(replay.map(e => [e.type, e.seq]), [["run.start", 1], ["run.activity", 2]]);
  const channel = broker.getDiagnostics().replay.find(run => run.runId === "run-activity");
  assert.equal(channel.lastSeq, 2);
});
