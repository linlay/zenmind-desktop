import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { RealtimeBroker } = require("../dist-electron/main/modules/agent-platform/realtime/realtime-broker.js");
const { createBrowserSurfaceRegistry } = require("../dist-electron/main/modules/web-surfaces/browser-surface-registry.js");
const { registerAgentWebclientBridgeIpcHandlers } = require("../dist-electron/main/modules/agent-platform/ipc.js");
const { createSurfaceIdentity } = require("../dist-electron/shared/surface-identity.js");
const {
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_OPEN_CHANNEL: OPEN,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL: SEND,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL: EVENT,
} = require("../dist-electron/shared/contracts/agent-webclient-bridge.js");

const EPOCH = 1_788_000_000_000;
const origin = "http://127.0.0.1:7079";
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for bridge state");
}

async function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-new-chat-"));
  const sockets = [];
  const runRequests = new Map();
  class Socket {
    constructor() {
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        this.onopen?.();
        this.emit({ frame: "push", type: "connected", data: {
          protocolVersion: 2, sessionId: "test-session", serverTime: EPOCH,
          liveness: { heartbeatIntervalMs: 30_000, silenceTimeoutMs: 100_000 },
        } });
      });
    }
    emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    send(raw) {
      const frame = JSON.parse(raw);
      this.sent.push(frame);
      if (frame.type === "/api/detach") queueMicrotask(() => this.emit({
        frame: "response", id: frame.id, type: frame.type, code: 0,
        data: { accepted: true, streamRequestId: runRequests.get(frame.payload.runId), lastSeq: 3 },
      }));
    }
    close() {}
  }
  const broker = new RealtimeBroker({
    app: { getPath: () => root },
    issueAccessToken: async () => ({ ok: true, token: "test-token", message: "" }),
    getDesktopDeviceId: () => "test-device",
    createWebSocket: () => new Socket(),
    heartbeatTimeoutMs: 0,
    acceptanceTimeoutMs: 2_000,
  });
  t.after(() => { broker.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await broker.ensureConnected("http://127.0.0.1:7078", "test-token");
  const sender = Object.assign(new EventEmitter(), {
    id: 101, url: "", messages: [],
    isDestroyed: () => false, getType: () => "webview",
    getURL() { return this.url; },
    send(channel, message) { this.messages.push({ channel, message }); },
  });
  const registry = createBrowserSurfaceRegistry({
    webContents: { fromId: (id) => id === sender.id ? sender : null, getAllWebContents: () => [sender] },
    listWebEntries: () => ({ items: [] }), getCurrentPageSnapshot: () => null,
  });
  const listeners = new Map();
  const syncs = [];
  let beforeCanonicalSync = null;
  let currentRegistration;
  const register = (route, ownerChatId = "", options = {}) => {
    if (options.navigate !== false) sender.url = origin + route;
    currentRegistration = {
      ...createSurfaceIdentity("main-chat"), registrationId: options.generation || "main-g1",
      surfaceKind: "service", surfaceType: "agent-chat", serviceId: "agent-webclient",
      pageRoute: route.split("?")[0], pageRouteIdentity: route, ownerChatId,
      label: "Main Chat", url: origin + route, active: options.active !== false,
      tabs: [{ tabId: "main-tab", currentUrl: sender.url, title: "Chat", webContentsId: sender.id,
        canGoBack: false, canGoForward: false, isLoading: false }], activeTabId: "main-tab",
    };
    assert.deepEqual(registry.registerSurfaceResult(currentRegistration, 1), { ok: true });
    return broker.getMainChatRootObserver();
  };
  const registration = registerAgentWebclientBridgeIpcHandlers({
    on: (channel, handler) => listeners.set(channel, handler), handle() {},
  }, {
    app: {}, browserSurfaces: registry, realtimeBroker: broker,
    isTrustedAgentWebclientSession: (guest) => guest === sender,
    getServiceState: async () => ({ status: "running", healthMeta: { webUrl: "http://127.0.0.1:7078" } }),
    issueAccessToken: async () => ({ ok: true, token: "test-token", message: "" }),
    syncCanonicalChat: async (_owner, input) => {
      syncs.push(input);
      if (beforeCanonicalSync) await beforeCanonicalSync(input);
      const route = new URL(sender.url);
      if (route.searchParams.get("newChat") !== input.newChat) {
        return { requestId: "sync", ok: false, code: "stale_source", message: "source changed" };
      }
      register(`/agent/${input.agentKey}?chatId=${input.chatId}`, input.chatId);
      return { requestId: "sync", ok: true };
    },
    dispatchWorkPanel: async () => ({ ok: true }), openResource: async () => ({ ok: true }),
    openDocument: async () => ({ ok: true }), normalizeWorkPanelOpenLocalResourceRequest: (v) => v,
  });
  const frames = () => sender.messages.flatMap(({ channel, message }) =>
    channel === EVENT && message.type === "frame" ? [message.frame] : []);
  const submit = (id, payload = {}) => {
    listeners.get(SEND)({ sender }, { sessionId: "port", frame: {
      frame: "request", type: "/api/query", id,
      payload: { agentKey: "agent-1", requestId: id, message: "test", ...payload },
    } });
  };
  const query = async (id, payload = {}) => {
    submit(id, payload);
    await until(() => sockets[0].sent.some((f) => f.type === "/api/query" && f.payload.requestId === id) ||
      frames().some((f) => f.id === id && f.frame === "error"));
    const request = sockets[0].sent.find((f) => f.type === "/api/query" && f.payload.requestId === id);
    assert.ok(request, `query ${id} rejected: ${JSON.stringify(frames().filter((f) => f.id === id))}`);
    return request;
  };
  const accept = async (request, chatId, runId, attachments = false) => {
    runRequests.set(runId, request.id);
    const types = attachments ? ["request.query", "run.start"] : ["chat.start", "request.query", "run.start"];
    types.forEach((type, i) => sockets[0].emit({ frame: "stream", id: request.id, event: {
      type, timestamp: EPOCH + i, seq: i + 1, chatId, runId,
      agentKey: request.payload.agentKey, requestId: request.payload.requestId,
    } }));
    await flush();
  };
  const open = async () => {
    listeners.get(OPEN)({ sender }, { sessionId: "port" });
    await until(() => sender.messages.some(({ message }) => message.type === "state" && message.state.phase === "connected"));
  };
  return { broker, registry, sender, sockets, syncs, frames, submit, query, accept, open, register, registration,
    repeat: () => assert.deepEqual(registry.registerSurfaceResult(currentRegistration, 1), { ok: true }),
    beforeSync: (callback) => { beforeCanonicalSync = callback; },
  };
}

// Uses the real Registry, IPC handlers and Broker; only Electron and the Platform socket are fake.
test("successive New Chats reuse the guest and connection but replace the complete Broker context", async (t) => {
  const h = await harness(t);
  const first = h.register("/agent/agent-1?newChat=1788000000000");
  h.repeat();
  assert.equal(h.broker.getMainChatRootObserver().token, first.token);
  await h.open();
  await h.accept(await h.query("query-a"), "chat-a", "run-a");
  const promoted = h.broker.getMainChatRootObserver();
  assert.equal(promoted.contextId, "chat-a");
  assert.equal(promoted.token, first.token);
  assert.equal(promoted.contextEpoch, first.contextEpoch);
  h.repeat();
  assert.equal(h.broker.getMainChatRootObserver().token, first.token);
  const completed = [];
  for (const kind of ["overview", "debug"]) {
    const clone = await h.broker.subscribeClone({ kind, runId: "run-a", chatId: "chat-a", lastSeq: 0,
      owner: { kind: "agent", agentKey: "agent-1" }, consumerId: kind, onEvent() {},
      onComplete: (result) => completed.push([kind, result.reason]),
    });
    await clone.ready;
  }
  const second = h.register("/agent/agent-1?newChat=1788000000001");
  assert.notEqual(second.token, first.token);
  assert.notEqual(second.contextEpoch, first.contextEpoch);
  assert.equal(second.generation, first.generation);
  assert.equal(second.webContentsId, first.webContentsId);
  assert.equal(h.broker.getDiagnostics().overviewLease.state, "pending_chat_identity");
  assert.equal(h.broker.getDiagnostics().overviewLease.runCount, 0);
  assert.deepEqual(completed.sort(), [["debug", "detached"], ["overview", "detached"]]);
  await h.accept(await h.query("query-b"), "chat-b", "run-b");
  assert.equal(h.broker.getMainChatRootObserver().contextId, "chat-b");
  assert.equal(h.broker.getMainChatRootObserver().token, second.token);
  await until(() => h.broker.getDiagnostics().replay.find((r) => r.runId === "run-a")?.upstreamState === "detached");
  assert.equal(h.broker.getDiagnostics().replay.find((r) => r.runId === "run-a").state, "dormant");
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].sent.filter((f) => f.type === "/api/query").length, 2);
  assert.equal(h.sockets[0].sent.filter((f) => f.type === "/api/detach").length, 1);
  assert.equal(h.sockets[0].sent.some((f) => f.type === "/api/interrupt"), false);
  assert.equal(h.frames().some((f) => f.frame === "error"), false);
  const actions = [];
  h.broker.setDesktopBridgeProvider({
    action: async (request) => { actions.push(request); return { ok: true, action: request.action, result: {} }; },
    cdp: async () => ({ ok: true }),
  });
  h.sockets[0].emit({ frame: "request", type: "desktop.workpanel.openWeb", id: "background-action",
    source: { chatId: "chat-a", runId: "run-a", agentKey: "agent-1" },
    payload: { url: "https://example.test/result" },
  });
  await until(() => h.sockets[0].sent.some((f) => f.id === "background-action"));
  assert.equal(actions.length, 1, "switching Chat must preserve the accepted Run's WorkPanel grant");
  assert.equal(h.sockets[0].sent.find((f) => f.id === "background-action").frame, "response");
  // Returning to the exact old nonce must not resurrect its previous token.
  const returned = h.register("/agent/agent-1?newChat=1788000000000");
  assert.notEqual(returned.token, first.token);
});

test("pending New Chat switches isolate late acceptance and distinguish Agent identity", async (t) => {
  const h = await harness(t);
  const first = h.register("/agent/agent-1?newChat=1788000000000");
  await h.open();
  const oldRequest = await h.query("old-query");
  const second = h.register("/agent/agent-1?newChat=1788000000001");
  const third = h.register("/agent/agent-2?newChat=1788000000001");
  assert.notEqual(first.token, second.token);
  assert.notEqual(second.token, third.token);
  assert.notEqual(second.contextEpoch, third.contextEpoch);
  await h.accept(oldRequest, "old-chat", "old-run");
  assert.equal(h.syncs.length, 0);
  assert.equal(h.broker.getMainChatRootObserver().token, third.token);
  assert.equal(h.broker.getDiagnostics().overviewLease.state, "pending_chat_identity");
  await h.accept(await h.query("new-query", { agentKey: "agent-2" }), "new-chat", "new-run");
  assert.equal(h.syncs.length, 1);
  assert.equal(h.broker.getMainChatRootObserver().contextId, "new-chat");
  assert.equal(h.frames().some((f) => f.id === "old-query" && f.frame === "error"), false);
});

test("attachment-precreated Chat promotes in place and duplicate pending registration preserves its stream", async (t) => {
  const h = await harness(t);
  const first = h.register("/agent/agent-1?newChat=1788000000000");
  h.beforeSync(() => {
    assert.equal(h.broker.getMainChatRootObserver().contextId, "attachment-chat");
    h.repeat();
    assert.equal(h.broker.getMainChatRootObserver().token, first.token);
    assert.equal(h.broker.getDiagnostics().overviewLease.state, "ready");
  });
  await h.open();
  await h.accept(await h.query("attachment-query", { chatId: "attachment-chat" }), "attachment-chat", "attachment-run", true);
  assert.equal(h.broker.getMainChatRootObserver().token, first.token);
  assert.equal(h.frames().some((f) => f.event?.type === "run.start"), true);
  assert.equal(h.frames().some((f) => f.frame === "error" || f.reason === "detached"), false);
});

test("late canonical synchronization cannot replace the new context or report an error into it", async (t) => {
  const h = await harness(t);
  h.register("/agent/agent-1?newChat=1788000000000");
  let release;
  h.beforeSync(() => new Promise((resolve) => { release = resolve; }));
  await h.open();
  await h.accept(await h.query("old-query"), "old-chat", "old-run");
  assert.ok(release);
  const second = h.register("/agent/agent-1?newChat=1788000000001");
  release();
  await flush();
  assert.equal(h.broker.getMainChatRootObserver().token, second.token);
  assert.equal(h.broker.getDiagnostics().overviewLease.state, "pending_chat_identity");
  assert.equal(h.frames().some((f) => f.id === "old-query" && f.frame === "error"), false);
  h.beforeSync(null);
  await h.accept(await h.query("new-query"), "new-chat", "new-run");
  assert.equal(h.broker.getMainChatRootObserver().contextId, "new-chat");
});

test("opening history and replacing the guest generation retire pending contexts", async (t) => {
  const h = await harness(t);
  const first = h.register("/agent/agent-1?newChat=1788000000000");
  await h.open();
  const oldRequest = await h.query("old-query");
  const history = h.register("/agent/agent-1?chatId=history-chat", "history-chat");
  assert.notEqual(history.token, first.token);
  assert.equal(h.broker.getDiagnostics().overviewLease.state, "ready");
  const replacement = h.register("/agent/agent-1?chatId=history-chat", "history-chat", { generation: "main-g2" });
  assert.notEqual(replacement.token, history.token);
  assert.notEqual(replacement.contextEpoch, history.contextEpoch);
  assert.equal(h.registry.unregisterSurface({ surfaceId: "main-chat", registrationId: "main-g1" }, 1), false);
  await h.accept(oldRequest, "old-chat", "old-run");
  assert.equal(h.syncs.length, 0);
  assert.equal(h.broker.getMainChatRootObserver().token, replacement.token);
  await h.accept(await h.query("history-query", { chatId: "history-chat" }), "history-chat", "history-run", true);
  assert.equal(h.frames().some((f) => f.id === "history-query" && f.event?.type === "run.start"), true);
});

test("mismatched new-chat source fails locally with a diagnostic and never repairs the Broker during query", async (t) => {
  const h = await harness(t);
  const registered = h.register("/agent/agent-1?newChat=1788000000000");
  await h.open();
  const stale = h.broker.activateRootObserver({ ...registered, token: "stale-observer", newChatSourceKey: "old-source" });
  h.submit("rejected-query");
  await until(() => h.frames().some((f) => f.id === "rejected-query"));
  assert.equal(h.frames().find((f) => f.id === "rejected-query").type, "target_unavailable");
  assert.equal(h.sockets[0].sent.some((f) => f.type === "/api/query"), false);
  assert.equal(h.broker.getMainChatRootObserver().token, stale.token);
  const trace = h.broker.getDebugTraceEntries().find((entry) => entry.data?.event === "main-chat-query-bundle-rejected");
  assert.equal(trace.data.sourceMatches, false);
  assert.equal(trace.data.contextMatches, true);
  assert.equal(JSON.stringify(trace.data).includes("test-token"), false);
});
