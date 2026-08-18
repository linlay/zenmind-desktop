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
  let destroyed = false;
  sender.id = id;
  sender.messages = [];
  sender.isDestroyed = () => destroyed;
  sender.getType = () => "webview";
  sender.getURL = () => url;
  sender.send = (channel, message) => sender.messages.push({ channel, message });
  sender.destroy = () => {
    destroyed = true;
    sender.emit("destroyed");
  };
  return sender;
}

function createTarget(id, overrides = {}) {
  const url = `http://127.0.0.1:7079/agent/agent-${id}?chatId=chat-${id}`;
  return {
    registrationId: `registration-${id}`,
    surfaceId: "main-chat",
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

function createRegistration(targets, forwardRequest, overrides = {}) {
  const listeners = new Map();
  const handlers = new Map();
  const traces = [];
  const cleaned = [];
  const pushSubscribers = [];
  const dispatched = [];
  const calls = {
    ensureConnected: 0,
    getServiceState: 0,
    issueAccessToken: 0,
    waitForSurface: 0,
  };
  const broker = {
    ensureConnected: async () => {
      calls.ensureConnected += 1;
    },
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
      waitForWebviewSurfaceTarget: async (senderId, timeoutMs, signal) => {
        calls.waitForSurface += 1;
        if (overrides.waitForWebviewSurfaceTarget) {
          return overrides.waitForWebviewSurfaceTarget(senderId, timeoutMs, signal);
        }
        return targets.get(senderId) || null;
      },
    },
    isTrustedAgentWebclientSession: overrides.isTrustedAgentWebclientSession ?? (() => true),
    realtimeBroker: broker,
    getServiceState: async () => {
      calls.getServiceState += 1;
      return { status: "running", healthMeta: { webUrl: "http://127.0.0.1:7078" } };
    },
    issueAccessToken: async () => {
      calls.issueAccessToken += 1;
      return { ok: true, token: "main-only-token", message: "" };
    },
    dispatchWorkPanel: async (input) => {
      dispatched.push(input);
      return { ok: true, workspaceId: "workspace-1" };
    },
  });
  return { broker, calls, cleaned, dispatched, handlers, listeners, pushSubscribers, registration, traces };
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

test("raw Frame Port forwards ordinary Platform request and response frames for a trusted surface", async () => {
  const target = createTarget(45, {
    surfaceId: "overview-45",
    surfaceType: "agent-overview",
    pageRoute: "/overview/chat-45",
    currentUrl: "http://127.0.0.1:7079/overview/chat-45",
    active: false,
  });
  const forwarded = [];
  const runtime = createRegistration(new Map([[45, target]]), async (input) => {
    forwarded.push({
      type: input.type,
      payload: input.payload,
      stream: input.stream,
    });
    input.onFrame({
      frame: "response",
      id: input.localId,
      type: input.type,
      code: 0,
      data: { key: "agent-45" },
    });
  });
  const sender = createSender(45, target.currentUrl);
  await openSocket(runtime, sender, "socket-data-request");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-data-request",
    data: JSON.stringify({
      frame: "request",
      type: "/api/agent",
      id: "agent-detail-45",
      payload: { agentKey: "agent-45" },
    }),
  });
  await flush();

  assert.deepEqual(forwarded, [{
    type: "/api/agent",
    payload: { agentKey: "agent-45" },
    stream: false,
  }]);
  assert.deepEqual(sentFrames(sender).at(-1), {
    frame: "response",
    id: "agent-detail-45",
    type: "/api/agent",
    code: 0,
    data: { key: "agent-45" },
  });
  assert.equal(runtime.registration.getDiagnostics().activeLiveSurfaceCount, 0);
  assert.equal(runtime.registration.getDiagnostics().activeStreamCount, 0);
});

test("management File surface forwards /api/file but cannot acquire a live Run lease", async () => {
  const target = createTarget(46, {
    surfaceId: "file:project-path",
    surfaceType: "agent-management",
    surfaceRole: "file",
    surfaceLevel: "child",
    parentSurfaceId: "main-chat",
    interaction: "read-only",
    ownerChatId: "chat-46",
    pageRoute: "/file-viewer/agent-46",
    currentUrl: "http://127.0.0.1:7079/file-viewer/agent-46?path=%2FUsers%2Fdemo%2FProject%2Fsrc%2Fapp.ts",
  });
  const forwarded = [];
  const runtime = createRegistration(new Map([[46, target]]), async (input) => {
    forwarded.push(input.type);
    input.onFrame({
      frame: "response",
      id: input.localId,
      type: input.type,
      code: 0,
      data: { requestedPath: "/Users/demo/Project/src/app.ts", content: "export {};" },
    });
  });
  const sender = createSender(46, target.currentUrl);
  await openSocket(runtime, sender, "socket-file-data");

  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-file-data",
    data: JSON.stringify({
      frame: "request",
      type: "/api/file",
      id: "file-detail-46",
      payload: { agentKey: "agent-46", path: "/Users/demo/Project/src/app.ts" },
    }),
  });
  await flush();

  assert.deepEqual(forwarded, ["/api/file"]);
  assert.deepEqual(sentFrames(sender).at(-1), {
    frame: "response",
    id: "file-detail-46",
    type: "/api/file",
    code: 0,
    data: { requestedPath: "/Users/demo/Project/src/app.ts", content: "export {};" },
  });

  for (const [type, id, payload] of [
    ["/api/query", "file-query-denied", { agentKey: "agent-46", message: "no" }],
    ["/api/attach", "file-attach-denied", { agentKey: "agent-46", runId: "run-46", lastSeq: 0 }],
    ["/api/btw", "file-btw-denied", { agentKey: "agent-46", chatId: "chat-46", message: "no" }],
  ]) {
    runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
      socketId: "socket-file-data",
      data: JSON.stringify({ frame: "request", type, id, payload }),
    });
    await flush();
    assert.equal(sentFrames(sender).at(-1).type, "surface_unavailable");
    assert.equal(sentFrames(sender).at(-1).id, id);
  }

  assert.deepEqual(forwarded, ["/api/file"]);
  assert.equal(runtime.registration.getDiagnostics().activeLiveSurfaceCount, 0);
  assert.equal(runtime.registration.getDiagnostics().activeStreamCount, 0);
});

test("Frame Port waits for a trusted WebView surface registration before opening", async () => {
  const targets = new Map();
  const forwarded = [];
  let releaseSurface = () => undefined;
  let markWaitStarted = () => undefined;
  const waitStarted = new Promise((resolve) => {
    markWaitStarted = resolve;
  });
  const runtime = createRegistration(targets, async (input) => {
    forwarded.push(input.type);
    input.onFrame({
      frame: "response",
      id: input.localId,
      type: input.type,
      code: 0,
      data: { key: "agent-81" },
    });
  }, {
    waitForWebviewSurfaceTarget: (_senderId, timeoutMs) => {
      assert.equal(timeoutMs, 1_500);
      markWaitStarted();
      return new Promise((resolve) => {
        releaseSurface = resolve;
      });
    },
  });
  const target = createTarget(81);
  const sender = createSender(81, target.currentUrl);

  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_OPEN_CHANNEL)(
    { sender },
    { socketId: "socket-delayed-surface" },
  );
  await waitStarted;

  assert.deepEqual(sender.messages, []);
  assert.deepEqual(runtime.calls, {
    ensureConnected: 0,
    getServiceState: 0,
    issueAccessToken: 0,
    waitForSurface: 1,
  });

  targets.set(sender.id, target);
  releaseSurface(target);
  await flush();
  await flush();

  assert.equal(
    sender.messages.filter(({ message }) => message.type === "open").length,
    1,
  );
  assert.equal(runtime.calls.ensureConnected, 1);
  assert.equal(runtime.calls.getServiceState, 1);
  assert.equal(runtime.calls.issueAccessToken, 1);

  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-delayed-surface",
    data: JSON.stringify({
      frame: "request",
      type: "/api/agent",
      id: "agent-after-registration",
      payload: { agentKey: "agent-81" },
    }),
  });
  await flush();

  assert.deepEqual(forwarded, ["/api/agent"]);
  assert.equal(sentFrames(sender).at(-1).data.key, "agent-81");
});

test("Frame Port rejects a missing surface after the bounded registration wait", async () => {
  const runtime = createRegistration(new Map(), async () => {
    assert.fail("request must not reach the Broker");
  }, {
    waitForWebviewSurfaceTarget: async (_senderId, timeoutMs) => {
      assert.equal(timeoutMs, 1_500);
      return null;
    },
  });
  const sender = createSender(82, "http://127.0.0.1:7079/agent/agent-82");

  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_OPEN_CHANNEL)(
    { sender },
    { socketId: "socket-missing-surface" },
  );
  await flush();
  await flush();

  assert.deepEqual(sender.messages.map(({ message }) => message.type), ["error", "close"]);
  assert.equal(sender.messages.at(-1).message.code, 1008);
  assert.equal(sender.messages.at(-1).message.reason, "surface_unavailable");
  assert.equal(runtime.calls.ensureConnected, 0);
  assert.equal(runtime.calls.getServiceState, 0);
  assert.equal(runtime.calls.issueAccessToken, 0);
});

test("Frame Port never waits for an untrusted or already-invalid surface", async () => {
  const untrustedRuntime = createRegistration(new Map(), async () => undefined, {
    isTrustedAgentWebclientSession: () => false,
    waitForWebviewSurfaceTarget: async () => {
      assert.fail("untrusted sender must not enter the registration wait");
    },
  });
  const untrustedSender = createSender(83, "http://127.0.0.1:7079/agent/agent-83");
  untrustedRuntime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_OPEN_CHANNEL)(
    { sender: untrustedSender },
    { socketId: "socket-untrusted" },
  );
  await flush();
  assert.equal(untrustedRuntime.calls.waitForSurface, 0);
  assert.equal(untrustedSender.messages.at(-1).message.code, 1008);

  for (const [id, overrides] of [
    [84, { serviceId: "other-service" }],
    [85, { currentUrl: "http://127.0.0.1:9999/agent/agent-85" }],
  ]) {
    const target = createTarget(id, overrides);
    const runtime = createRegistration(new Map([[id, target]]), async () => undefined, {
      waitForWebviewSurfaceTarget: async () => {
        assert.fail("an already-invalid target must not enter the registration wait");
      },
    });
    const sender = createSender(id, createTarget(id).currentUrl);
    runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_OPEN_CHANNEL)(
      { sender },
      { socketId: `socket-invalid-${id}` },
    );
    await flush();
    assert.equal(runtime.calls.waitForSurface, 0);
    assert.equal(sender.messages.at(-1).message.code, 1008);
  }
});

test("Frame Port cancels a pending surface wait when the guest is destroyed", async () => {
  const runtime = createRegistration(new Map(), async () => {
    assert.fail("destroyed guest must not reach the Broker");
  }, {
    waitForWebviewSurfaceTarget: (_senderId, _timeoutMs, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    }),
  });
  const sender = createSender(86, "http://127.0.0.1:7079/agent/agent-86");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_OPEN_CHANNEL)(
    { sender },
    { socketId: "socket-destroyed-before-registration" },
  );
  await flush();

  sender.destroy();
  await flush();
  await flush();

  assert.deepEqual(sender.messages, []);
  assert.equal(runtime.calls.waitForSurface, 1);
  assert.equal(runtime.calls.ensureConnected, 0);
});

test("same-surface route loading does not destroy the logical socket or truncate its stream", async () => {
  const target = createTarget(43);
  let deliverFrame = () => undefined;
  const runtime = createRegistration(new Map([[43, target]]), async ({ onFrame }) => {
    deliverFrame = onFrame;
  });
  const sender = createSender(43, target.currentUrl);
  await openSocket(runtime, sender, "socket-route-promotion");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-route-promotion",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-route-promotion",
      payload: { requestId: "req-route-promotion", message: "我是谁", agentKey: "agent-43" },
    }),
  });
  await flush();

  deliverFrame({
    frame: "stream",
    id: "query-route-promotion",
    streamId: "stream-route-promotion",
    event: { seq: 1, type: "chat.start", chatId: "chat-canonical", timestamp: 1_786_898_607_643 },
  });
  sender.emit("did-start-loading");
  deliverFrame({
    frame: "stream",
    id: "query-route-promotion",
    streamId: "stream-route-promotion",
    event: {
      seq: 2,
      type: "request.query",
      requestId: "req-route-promotion",
      chatId: "chat-canonical",
      runId: "run-canonical",
      agentKey: "agent-43",
      timestamp: 1_786_898_607_644,
    },
  });
  deliverFrame({
    frame: "stream",
    id: "query-route-promotion",
    streamId: "stream-route-promotion",
    event: { seq: 5, type: "content.delta", delta: "仍然收到", timestamp: 1_786_898_607_650 },
  });

  assert.equal(runtime.registration.getDiagnostics().logicalSocketCount, 1);
  assert.equal(runtime.registration.getDiagnostics().activeStreamCount, 1);
  assert.deepEqual(sentFrames(sender).map((frame) => frame.event?.seq), [1, 2, 5]);
  assert.equal(
    sender.messages.some(({ message }) => message.type === "close" && message.reason === "surface destroyed"),
    false,
  );
});

test("a new document socket detaches and supersedes the previous socket for the same surface", async () => {
  const target = createTarget(44);
  const forwardedTypes = [];
  const runtime = createRegistration(new Map([[44, target]]), async (input) => {
    forwardedTypes.push(input.type);
    if (input.type === "/api/query") {
      input.onFrame({
        frame: "stream",
        id: input.localId,
        streamId: "stream-old-document",
        event: {
          seq: 1,
          type: "request.query",
          chatId: "chat-old-document",
          runId: "run-old-document",
          agentKey: "agent-44",
          timestamp: 1_786_898_607_643,
        },
      });
    }
  });
  const sender = createSender(44, target.currentUrl);
  await openSocket(runtime, sender, "socket-old-document");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-old-document",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-old-document",
      payload: { requestId: "req-old-document", message: "hello", agentKey: "agent-44" },
    }),
  });
  await flush();

  await openSocket(runtime, sender, "socket-new-document");

  assert.deepEqual(forwardedTypes, ["/api/query", "/api/detach"]);
  assert.equal(runtime.registration.getDiagnostics().logicalSocketCount, 1);
  assert.deepEqual(
    sender.messages.find(({ message }) =>
      message.type === "close" && message.socketId === "socket-old-document"
    )?.message,
    {
      socketId: "socket-old-document",
      type: "close",
      code: 1000,
      reason: "logical socket superseded",
    },
  );
});

test("local validation returns a standard error frame with the original request id", async () => {
  const target = createTarget(42, {
    surfaceId: "overview-42",
    surfaceType: "agent-overview",
    pageRoute: "/overview/chat-42",
    currentUrl: "http://127.0.0.1:7079/overview/chat-42",
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
    msg: "only the active Chat or BTW surface may open this live Run stream",
    data: {
      code: "surface_unavailable",
      message: "only the active Chat or BTW surface may open this live Run stream",
    },
  });
});

test("active BTW child may start or attach BTW streams but cannot start a main query", async () => {
  const target = createTarget(49, {
    surfaceId: "btw:child",
    surfaceType: "agent-btw",
    surfaceRole: "btw",
    surfaceLevel: "child",
    parentSurfaceId: "main-chat",
    ownerChatId: "chat-49",
    pageRoute: "/btw/chat-49",
    currentUrl: "http://127.0.0.1:7079/btw/chat-49",
  });
  const forwarded = [];
  const runtime = createRegistration(new Map([[49, target]]), async ({ type }) => forwarded.push(type));
  const sender = createSender(49, target.currentUrl);
  await openSocket(runtime, sender, "socket-btw");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-btw",
    data: JSON.stringify({ frame: "request", type: "/api/btw", id: "btw-1", payload: { chatId: "chat-49", message: "why", agentKey: "agent-49" } }),
  });
  await flush();
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-btw",
    data: JSON.stringify({ frame: "request", type: "/api/query", id: "query-denied", payload: { chatId: "chat-49", message: "no", agentKey: "agent-49" } }),
  });
  await flush();
  assert.deepEqual(forwarded, ["/api/btw"]);
  assert.equal(sentFrames(sender).at(-1).type, "surface_unavailable");
});

test("surface handoff writes detach before the next live request", async () => {
  const firstTarget = createTarget(51, { ownerChatId: "chat-1" });
  const secondTarget = createTarget(52, {
    surfaceId: "copilot-dock",
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

test("surface handoff waits for an explicit detach write and does not send a duplicate detach", async () => {
  const firstTarget = createTarget(53, { ownerChatId: "chat-explicit-1" });
  const secondTarget = createTarget(54, {
    surfaceId: "copilot-dock",
    surfaceType: "agent-copilot",
    ownerChatId: "chat-explicit-2",
  });
  const order = [];
  let releaseExplicitDetach = () => undefined;
  const explicitDetachWritten = new Promise((resolve) => {
    releaseExplicitDetach = resolve;
  });
  const runtime = createRegistration(new Map([[53, firstTarget], [54, secondTarget]]), async (input) => {
    order.push(input.type);
    if (input.type === "/api/query") {
      input.onFrame({
        frame: "stream",
        id: input.localId,
        streamId: `stream-explicit-${order.length}`,
        event: {
          seq: 1,
          type: "run.start",
          chatId: order.length === 1 ? "chat-explicit-1" : "chat-explicit-2",
          runId: order.length === 1 ? "run-explicit-1" : "run-explicit-2",
          agentKey: "agent-1",
          timestamp: 1_786_890_000_001,
        },
      });
    }
    if (input.type === "/api/detach") {
      await explicitDetachWritten;
    }
  });
  const first = createSender(53, firstTarget.currentUrl);
  const second = createSender(54, secondTarget.currentUrl);
  await openSocket(runtime, first, "first-explicit");
  await openSocket(runtime, second, "second-explicit");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: first }, {
    socketId: "first-explicit",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-explicit-1",
      payload: { requestId: "req-explicit-1", message: "one", agentKey: "agent-1" },
    }),
  });
  await flush();
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: first }, {
    socketId: "first-explicit",
    data: JSON.stringify({
      frame: "request",
      type: "/api/detach",
      id: "detach-explicit-1",
      payload: { runId: "run-explicit-1", agentKey: "agent-1", reason: "surface_inactive" },
    }),
  });
  await flush();
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: second }, {
    socketId: "second-explicit",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-explicit-2",
      payload: { requestId: "req-explicit-2", message: "two", agentKey: "agent-1" },
    }),
  });
  await flush();
  assert.deepEqual(order, ["/api/query", "/api/detach"]);

  releaseExplicitDetach();
  await flush();
  await flush();

  assert.deepEqual(order, ["/api/query", "/api/detach", "/api/query"]);
  assert.equal(order.filter((type) => type === "/api/detach").length, 1);
});

test("same surface re-entry waits for its explicit detach write before attach", async () => {
  const target = createTarget(55, { ownerChatId: "chat-same-surface" });
  const order = [];
  let releaseExplicitDetach = () => undefined;
  const explicitDetachWritten = new Promise((resolve) => {
    releaseExplicitDetach = resolve;
  });
  const runtime = createRegistration(new Map([[55, target]]), async (input) => {
    order.push(input.type);
    if (input.type === "/api/query") {
      input.onFrame({
        frame: "stream",
        id: input.localId,
        streamId: "stream-same-surface",
        event: {
          seq: 1,
          type: "run.start",
          chatId: "chat-same-surface",
          runId: "run-same-surface",
          agentKey: "agent-1",
          timestamp: 1_786_890_000_001,
        },
      });
    }
    if (input.type === "/api/detach") await explicitDetachWritten;
  });
  const sender = createSender(55, target.currentUrl);
  await openSocket(runtime, sender, "same-surface");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "same-surface",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-same-surface",
      payload: { requestId: "req-same-surface", message: "one", agentKey: "agent-1" },
    }),
  });
  await flush();
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "same-surface",
    data: JSON.stringify({
      frame: "request",
      type: "/api/detach",
      id: "detach-same-surface",
      payload: { runId: "run-same-surface", agentKey: "agent-1", reason: "surface_inactive" },
    }),
  });
  await flush();
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "same-surface",
    data: JSON.stringify({
      frame: "request",
      type: "/api/attach",
      id: "attach-same-surface",
      payload: { runId: "run-same-surface", agentKey: "agent-1", lastSeq: 1 },
    }),
  });
  await flush();
  assert.deepEqual(order, ["/api/query", "/api/detach"]);

  releaseExplicitDetach();
  await flush();
  await flush();

  assert.deepEqual(order, ["/api/query", "/api/detach", "/api/attach"]);
  assert.equal(order.filter((type) => type === "/api/detach").length, 1);
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

test("Overview WorkPanel child may open a Resource Viewer tab", async () => {
  const target = createTarget(72, {
    surfaceId: "ov:chat-72",
    surfaceType: "agent-overview",
    surfaceRole: "overview",
    surfaceLevel: "child",
    parentSurfaceId: "main-chat",
    ownerChatId: "chat-72",
    pageRoute: "/overview/chat-72",
    currentUrl: "http://127.0.0.1:7079/overview/chat-72",
  });
  const runtime = createRegistration(new Map([[72, target]]), async () => undefined);
  const sender = createSender(72, target.currentUrl);
  const workpanel = runtime.handlers.get(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL);

  assert.deepEqual(await workpanel({ sender }, { method: "getCapabilities" }), {
    ok: true,
    capabilities: ["workpanel.open", "workpanel.activate", "workpanel.close"],
  });

  const descriptor = {
    kind: "webclient",
    module: "artifact",
    route: "/resource-viewer/agent-72?chatId=chat-72&file=artifacts%2Frun-1%2Freport.md",
    context: {
      agentKey: "agent-72",
      chatId: "chat-72",
      artifactId: "artifact-72",
    },
  };
  const opened = await workpanel({ sender }, {
    method: "openItem",
    input: { version: 3, descriptor },
  });

  assert.equal(opened.ok, true);
  assert.deepEqual(runtime.dispatched.at(-1), {
    action: "openItem",
    ownerChatId: "chat-72",
    args: { descriptor },
  });
});
