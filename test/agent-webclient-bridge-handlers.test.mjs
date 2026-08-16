import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerAgentWebclientBridgeIpcHandlers } = require("../dist-electron/main/ipc/agent-webclient-bridge-handlers.js");
const {
  AGENT_WEBCLIENT_PLATFORM_WS_OPEN_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_WS_CLOSE_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_WS_EVENT_CHANNEL,
  AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL,
} = require("../dist-electron/shared/contracts/agent-webclient-bridge.js");

function createSender(id, url) {
  const sender = new EventEmitter();
  sender.id = id;
  sender.messages = [];
  sender.isDestroyed = () => false;
  sender.getType = () => "webview";
  sender.getURL = () => url;
  sender.send = (channel, message) => sender.messages.push({ channel, message });
  return sender;
}

function createTarget(id, overrides = {}) {
  const url = `http://127.0.0.1:7079/agent/agent-${id}?chatId=chat-${id}`;
  return {
    registrationId: `registration-${id}`,
    surfaceId: `agent-webclient-chat`,
    surfaceKind: "service",
    surfaceType: "agent-chat",
    serviceId: "agent-webclient",
    pageRoute: `/agent/agent-${id}`,
    tabId: `chat-${id}`,
    webContentsId: id,
    ownerWebContentsId: 1,
    active: true,
    currentUrl: url,
    label: "Chat",
    ownerChatId: `chat-${id}`,
    ...overrides,
  };
}

function createRegistration(targets, forwardRequest) {
  const listeners = new Map();
  const handlers = new Map();
  const traces = [];
  const cleaned = [];
  const pushSubscribers = [];
  const dispatched = [];
  const broker = {
    ensureConnected: async () => undefined,
    forwardRequest,
    subscribePush: ({ onPush }) => {
      pushSubscribers.push(onPush);
      return () => undefined;
    },
    cleanupConsumer: (id) => cleaned.push(id),
    appendDebugTrace: (entry) => traces.push(entry),
  };
  const registration = registerAgentWebclientBridgeIpcHandlers({
    on(channel, handler) { listeners.set(channel, handler); },
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    app: {},
    browserSurfaces: {
      resolveWebviewSurfaceTarget: (senderId) => targets.get(senderId) || null,
    },
    isTrustedAgentWebclientSession: () => true,
    realtimeBroker: broker,
    getServiceState: async () => ({ status: "running", healthMeta: { webUrl: "http://127.0.0.1:7078" } }),
    issueAccessToken: async () => ({ ok: true, token: "main-only-token", message: "" }),
    dispatchWorkPanel: async (input) => {
      dispatched.push(input);
      return { ok: true, workspaceId: "workspace-1" };
    },
  });
  return { broker, cleaned, dispatched, handlers, listeners, pushSubscribers, registration, traces };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function openSocket(runtime, sender, socketId) {
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_OPEN_CHANNEL)(
    { sender },
    { socketId },
  );
  await flush();
  assert.deepEqual(sender.messages.at(-1), {
    channel: AGENT_WEBCLIENT_PLATFORM_WS_EVENT_CHANNEL,
    message: { socketId, type: "open" },
  });
}

function sentFrames(sender) {
  return sender.messages.flatMap(({ channel, message }) =>
    channel === AGENT_WEBCLIENT_PLATFORM_WS_EVENT_CHANNEL && message.type === "message"
      ? [JSON.parse(message.data)]
      : [],
  );
}

test("raw Frame Port forwards each Platform stream frame immediately and unchanged", async () => {
  const target = createTarget(41);
  const targets = new Map([[41, target]]);
  const incoming = [
    { frame: "stream", id: "wss-1", streamId: "s-1", event: { seq: 1, type: "run.start", chatId: "chat-1", runId: "run-1", agentKey: "agent-1", timestamp: 1_786_890_000_001 } },
    { frame: "stream", id: "wss-1", streamId: "s-1", event: { seq: 2, type: "content.delta", delta: "你", chatId: "chat-1", runId: "run-1", timestamp: 1_786_890_000_002 } },
    { frame: "stream", id: "wss-1", streamId: "s-1", event: { seq: 3, type: "content.delta", delta: "好", chatId: "chat-1", runId: "run-1", timestamp: 1_786_890_000_003 } },
  ];
  const runtime = createRegistration(targets, async ({ localId, onFrame }) => {
    for (const frame of incoming) onFrame({ ...frame, id: localId });
  });
  const sender = createSender(41, target.currentUrl);
  await openSocket(runtime, sender, "socket-1");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-1",
    data: JSON.stringify({ frame: "request", type: "/api/query", id: "wss-1", payload: { requestId: "req-1", message: "hello", agentKey: "agent-1" } }),
  });
  await flush();

  assert.deepEqual(sentFrames(sender), incoming);
  assert.equal(runtime.registration.getDiagnostics().activeLiveSurfaceCount, 1);
  assert.equal(runtime.registration.getDiagnostics().activeStreamCount, 1);
  assert.ok(runtime.traces.some((entry) => entry.direction === "surface-to-desktop"));
  assert.ok(runtime.traces.some((entry) => entry.direction === "desktop-to-surface"));
});

test("local validation returns a standard error frame with the original request id", async () => {
  const target = createTarget(42, {
    surfaceId: "overview-42",
    surfaceType: "agent-overview",
    pageRoute: "/overview",
    currentUrl: "http://127.0.0.1:7079/overview?chatId=chat-42",
  });
  let forwarded = false;
  const runtime = createRegistration(new Map([[42, target]]), async () => { forwarded = true; });
  const sender = createSender(42, target.currentUrl);
  await openSocket(runtime, sender, "socket-2");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-2",
    data: JSON.stringify({ frame: "request", type: "/api/attach", id: "attach-denied", payload: { runId: "run-1", agentKey: "agent-1", lastSeq: 0 } }),
  });
  await flush();
  assert.equal(forwarded, false);
  assert.deepEqual(sentFrames(sender).at(-1), {
    frame: "error",
    id: "attach-denied",
    type: "surface_unavailable",
    code: 400,
    status: 400,
    msg: "only the active Chat surface may open a live Run stream",
    data: {
      code: "surface_unavailable",
      message: "only the active Chat surface may open a live Run stream",
    },
  });
});

test("surface handoff writes detach before the next live request", async () => {
  const firstTarget = createTarget(51, { ownerChatId: "chat-1" });
  const secondTarget = createTarget(52, {
    surfaceId: "agent-webclient-copilot-dock",
    surfaceType: "agent-copilot",
    ownerChatId: "chat-2",
  });
  const order = [];
  const runtime = createRegistration(new Map([[51, firstTarget], [52, secondTarget]]), async (input) => {
    order.push(input.type);
    if (input.type === "/api/query") {
      input.onFrame({
        frame: "stream",
        id: input.localId,
        streamId: `stream-${order.length}`,
        event: {
          seq: 1,
          type: "run.start",
          chatId: order.length === 1 ? "chat-1" : "chat-2",
          runId: order.length === 1 ? "run-1" : "run-2",
          agentKey: "agent-1",
          timestamp: 1_786_890_000_001,
        },
      });
    }
  });
  const first = createSender(51, firstTarget.currentUrl);
  const second = createSender(52, secondTarget.currentUrl);
  await openSocket(runtime, first, "first");
  await openSocket(runtime, second, "second");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: first }, {
    socketId: "first",
    data: JSON.stringify({ frame: "request", type: "/api/query", id: "query-1", payload: { requestId: "req-1", message: "one", agentKey: "agent-1" } }),
  });
  await flush();
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: second }, {
    socketId: "second",
    data: JSON.stringify({ frame: "request", type: "/api/query", id: "query-2", payload: { requestId: "req-2", message: "two", agentKey: "agent-1" } }),
  });
  await flush();
  assert.deepEqual(order, ["/api/query", "/api/detach", "/api/query"]);
  assert.equal(runtime.registration.getDiagnostics().activeLiveSurfaceCount, 1);
});

test("push broadcasts without acquiring live capability and close only cleans the logical socket", async () => {
  const target = createTarget(61);
  const runtime = createRegistration(new Map([[61, target]]), async () => undefined);
  const sender = createSender(61, target.currentUrl);
  await openSocket(runtime, sender, "socket-push");
  runtime.pushSubscribers[0]({ frame: "push", type: "chat.created", data: { chatId: "chat-new" } });
  assert.deepEqual(sentFrames(sender).at(-1), {
    frame: "push",
    type: "chat.created",
    data: { chatId: "chat-new" },
  });
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_CLOSE_CHANNEL)({ sender }, {
    socketId: "socket-push",
    code: 1000,
    reason: "guest closed",
  });
  assert.ok(runtime.cleaned.some((id) => id.includes("agent-webclient-frame-port")));
  assert.equal(runtime.registration.getDiagnostics().logicalSocketCount, 0);
});

test("WorkPanel retains an independent host capability query and version check", async () => {
  const target = createTarget(71);
  const runtime = createRegistration(new Map([[71, target]]), async () => undefined);
  const sender = createSender(71, target.currentUrl);
  const workpanel = runtime.handlers.get(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL);
  assert.deepEqual(await workpanel({ sender }, { method: "getCapabilities" }), {
    ok: true,
    capabilities: ["workpanel.open", "workpanel.activate", "workpanel.close"],
  });
  const opened = await workpanel({ sender }, {
    method: "openItem",
    input: { version: 3, descriptor: { kind: "web", url: "https://example.test/" } },
  });
  assert.equal(opened.ok, true);
  assert.equal(runtime.dispatched[0].ownerChatId, "chat-71");
  const incompatible = await workpanel({ sender }, {
    method: "openItem",
    input: { version: 2, descriptor: { kind: "web", url: "https://example.test/" } },
  });
  assert.equal(incompatible.error.code, "version_mismatch");
});
