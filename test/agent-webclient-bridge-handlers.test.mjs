import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerAgentWebclientBridgeIpcHandlers } = require("../dist-electron/main/ipc/agent-webclient-bridge-handlers.js");
const {
  AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL,
  AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL,
} = require("../dist-electron/shared/contracts/agent-webclient-bridge.js");

function createSender(id = 41) {
  const sender = new EventEmitter();
  sender.id = id;
  sender.messages = [];
  sender.isDestroyed = () => false;
  sender.getType = () => "webview";
  sender.getURL = () => "http://127.0.0.1:7079/overview?chatId=chat-1";
  sender.session = { getPartition: () => "persist:zenmind-service-agent-webclient" };
  sender.send = (channel, message) => sender.messages.push({ channel, message });
  return sender;
}

function createRegistration(targetOverrides = {}) {
  const handlers = new Map();
  const cleanups = [];
  const cleared = [];
  const dispatched = [];
  const traces = [];
  const target = {
    registrationId: "registration-1",
    surfaceId: "overview-1",
    surfaceKind: "service",
    surfaceType: "agent-overview",
    serviceId: "agent-webclient",
    pageRoute: "/overview",
    tabId: "overview-1",
    webContentsId: 41,
    ownerWebContentsId: 1,
    active: true,
    currentUrl: "http://127.0.0.1:7079/overview?chatId=chat-1",
    label: "Overview",
    ownerChatId: "chat-1",
    ...targetOverrides,
  };
  const broker = {
    getConnectionPhase: () => "connected",
    getConnectionState: () => ({ generation: 7 }),
    getVisibleBinding: () => null,
    subscribeConnection: ({ onState }) => {
      onState({ phase: "connected", generation: 7, key: null, physicalConnectionCount: 1, reconnectCount: 0 });
      return () => cleanups.push("connection");
    },
    ensureConnected: async () => {},
    subscribePush: () => {
      const unsubscribe = () => cleanups.push("push");
      return unsubscribe;
    },
    cleanupConsumer: (id) => cleanups.push(id),
    clearVisibleBinding: (id) => cleared.push(id),
    appendDebugTrace: (entry) => traces.push(entry),
  };
  const registration = registerAgentWebclientBridgeIpcHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, {
    app: {},
    browserSurfaces: { resolveWebviewSurfaceTarget: () => target },
    isTrustedAgentWebclientSession: () => true,
    realtimeBroker: broker,
    getServiceState: async () => ({ status: "running", healthMeta: { webUrl: "http://127.0.0.1:7078" } }),
    issueAccessToken: async () => ({ ok: true, token: "main-only-token", message: "" }),
    dispatchWorkPanel: async (input) => {
      dispatched.push(input);
      return { ok: true, workspaceId: "workspace-1" };
    },
  });
  return { broker, cleanups, cleared, dispatched, handlers, registration, target, traces };
}

test("Bridge diagnostics correlate inbound calls and outbound delivery with trusted surfaceId", async () => {
  const { handlers, registration, traces } = createRegistration();
  const sender = createSender();
  const realtime = handlers.get(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL);
  await realtime({ sender }, { method: "hello", input: { version: 2 } });

  assert.ok(traces.some((entry) =>
    entry.direction === "surface-to-desktop" &&
    entry.surfaceId === "overview-1" &&
    entry.data.method === "hello",
  ));
  assert.ok(traces.some((entry) =>
    entry.direction === "desktop-to-surface" &&
    entry.surfaceId === "overview-1" &&
    entry.data.kind === "connection",
  ));
  assert.deepEqual(registration.getDiagnostics().surfaces, [{
    surfaceId: "overview-1",
    webContentsId: 41,
    kind: "agent-overview",
    active: true,
    ownerChatId: "chat-1",
    route: "/overview",
    updatedAt: registration.getDiagnostics().surfaces[0].updatedAt,
    subscriptionCount: 0,
    pendingOperationCount: 0,
    batchQueueCount: 0,
  }]);
});

test("trusted bridge derives Overview capabilities and rejects control and forged chat identity", async () => {
  const { handlers, dispatched } = createRegistration();
  const sender = createSender();
  const realtime = handlers.get(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL);
  const hello = await realtime({ sender }, { method: "hello" });
  assert.equal(hello.version, 2);
  assert.equal(hello.surface.kind, "agent-overview");
  assert.equal(hello.surface.ownerChatId, "chat-1");
  assert.equal(hello.surface.capabilities.includes("run.control"), false);
  assert.equal(hello.surface.capabilities.includes("workpanel.open"), true);
  const workpanel = handlers.get(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL);
  const opened = await workpanel({ sender }, { method: "openItem", input: {
    version: 2,
    descriptor: { kind: "web", url: "https://example.test/overview-target" },
  }});
  assert.equal(opened.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].action, "openItem");
  const mismatched = await realtime({ sender }, { method: "hello", input: { version: 1 } });
  assert.equal(mismatched.error.code, "version_mismatch");

  const control = await realtime({ sender }, { method: "request", input: {
    version: 2, operationId: "operation-1", kind: "run.control", control: "interrupt",
    chatId: "chat-1", runId: "run-1", payload: {},
  }});
  assert.equal(control.error.code, "capability_denied");

  const forgedChat = await realtime({ sender }, { method: "subscribe", input: {
    version: 2, kind: "run", role: "overview", chatId: "chat-forged", runId: "run-1", lastSeq: 0,
    owner: { kind: "agent", agentKey: "agent-1" },
  }});
  assert.equal(forgedChat.error.code, "capability_denied");
  const legacyRole = await realtime({ sender }, { method: "subscribe", input: {
    version: 2, kind: "run", role: "summary", chatId: "chat-1", runId: "run-1", lastSeq: 0,
    owner: { kind: "agent", agentKey: "agent-1" },
  }});
  assert.equal(legacyRole.error.code, "invalid_request");
});

test("trusted WorkPanel bridge binds owner chat in Main and rejects an unregistered sender", async () => {
  const registered = createRegistration({ surfaceType: "agent-project", ownerChatId: "chat-owner" });
  const sender = createSender();
  const workpanel = registered.handlers.get(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL);
  const result = await workpanel({ sender }, { method: "openItem", input: {
    version: 2,
    descriptor: { kind: "web", url: "https://example.test/" },
  }});
  assert.equal(result.ok, true);
  assert.equal(registered.dispatched[0].ownerChatId, "chat-owner");
  assert.equal("ownerChatId" in registered.dispatched[0].args, false);

  const forged = createRegistration();
  forged.registration.target = null;
  const deniedHandlerMap = new Map();
  registerAgentWebclientBridgeIpcHandlers({ handle: (channel, handler) => deniedHandlerMap.set(channel, handler) }, {
    app: {}, browserSurfaces: { resolveWebviewSurfaceTarget: () => null }, realtimeBroker: forged.broker,
    isTrustedAgentWebclientSession: () => true,
    getServiceState: async () => ({ status: "running", healthMeta: { webUrl: "http://127.0.0.1" } }),
    issueAccessToken: async () => ({ ok: true, token: "token", message: "" }),
    dispatchWorkPanel: async () => ({ ok: true }),
  });
  const denied = await deniedHandlerMap.get(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL)({ sender }, {
    method: "openItem", input: { version: 2, descriptor: { kind: "web", url: "https://example.test" } },
  });
  assert.equal(denied.error.code, "surface_unavailable");
});

test("destroyed guest automatically cleans subscriptions, pending consumers, and visible binding", async () => {
  const { handlers, cleanups, cleared } = createRegistration();
  const sender = createSender();
  const realtime = handlers.get(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL);
  const subscribed = await realtime({ sender }, { method: "subscribe", input: {
    version: 2, kind: "push", types: ["chat.updated"], filter: { chatId: "chat-1" },
  }});
  assert.equal(subscribed.ok, true);
  sender.emit("destroyed");
  assert.ok(cleanups.includes("push"));
  assert.ok(cleanups.includes("connection"));
  assert.ok(cleanups.includes("agent-webclient-surface:41"));
  assert.deepEqual(cleared, ["surface:41"]);
});

test("reloading a guest clears subscriptions before the next preload registers", async () => {
  const { handlers, cleanups, cleared } = createRegistration({ webContentsId: 42 });
  const sender = createSender(42);
  const realtime = handlers.get(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL);
  const subscribed = await realtime({ sender }, { method: "subscribe", input: {
    version: 2, kind: "push", types: ["chat.updated"], filter: { chatId: "chat-1" },
  }});
  assert.equal(subscribed.ok, true);
  sender.emit("did-start-loading");
  assert.ok(cleanups.includes("push"));
  assert.ok(cleanups.includes("agent-webclient-surface:42"));
  assert.deepEqual(cleared, ["surface:42"]);
});

test("Bridge v2 accepts an ownerless active Agent surface query and returns canonical identity", async () => {
  const registered = createRegistration({
    surfaceType: "agent-chat",
    ownerChatId: undefined,
    pageRoute: "/agent/agent-1",
  });
  let brokerQuery;
  registered.broker.query = (input) => {
    brokerQuery = input;
    queueMicrotask(() => input.onEvent({
      type: "run.start",
      timestamp: 1_771_888_000_000,
      seq: 1,
      chatId: "chat-canonical",
      runId: "run-canonical",
      agentKey: "agent-1",
    }));
    return {
      accepted: Promise.resolve({
        chatId: "chat-canonical",
        runId: "run-canonical",
        owner: { kind: "agent", agentKey: "agent-1" },
      }),
      completed: new Promise(() => {}),
    };
  };
  registered.broker.bindVisibleRun = () => ({ epoch: 9 });
  const sender = createSender();
  const realtime = registered.handlers.get(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL);
  const result = await realtime({ sender }, { method: "request", input: {
    version: 2,
    operationId: "operation-new",
    kind: "run.query",
    owner: { kind: "agent", agentKey: "agent-1" },
    payload: { message: "hello", agentKey: "agent-1" },
  }});
  assert.deepEqual(result, { ok: true, operationId: "operation-new" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal("runId" in brokerQuery.payload, false);
  assert.equal("chatId" in brokerQuery.payload, false);
  assert.deepEqual(sender.messages.find(({ message }) => message.kind === "run.accepted").message, {
    version: 2,
    kind: "run.accepted",
    operationId: "operation-new",
    chatId: "chat-canonical",
    runId: "run-canonical",
    owner: { kind: "agent", agentKey: "agent-1" },
  });

  const detached = await realtime({ sender }, { method: "detach", input: {
    version: 2,
    target: { kind: "operation", operationId: "operation-new" },
  }});
  assert.deepEqual(detached, { ok: true, operationId: "operation-new" });
});

test("Bridge v2 returns the real Platform control response", async () => {
  const registered = createRegistration({ surfaceType: "agent-chat" });
  registered.broker.forwardRequest = async ({ localId, onFrame }) => {
    onFrame({
      frame: "error",
      id: localId,
      type: "awaiting_conflict",
      code: 409,
      msg: "awaiting state changed",
      data: { awaitingId: "awaiting-1" },
    });
  };
  const sender = createSender();
  const realtime = registered.handlers.get(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL);
  const result = await realtime({ sender }, { method: "request", input: {
    version: 2,
    operationId: "submit-1",
    kind: "run.control",
    control: "submitAwaiting",
    chatId: "chat-1",
    runId: "run-1",
    owner: { kind: "agent", agentKey: "agent-1" },
    payload: { awaitingId: "awaiting-1", params: [] },
  }});
  assert.deepEqual(result, {
    ok: true,
    operationId: "submit-1",
    response: {
      status: 409,
      code: 409,
      msg: "awaiting state changed",
      data: { awaitingId: "awaiting-1" },
    },
  });
});

test("Bridge v2 routes all five Run controls over the Broker and preserves success payloads", async () => {
  const registered = createRegistration({ surfaceType: "agent-chat" });
  const forwarded = [];
  registered.broker.forwardRequest = async (options) => {
    forwarded.push({ type: options.type, payload: options.payload });
    options.onFrame({
      frame: "response",
      id: options.localId,
      code: 0,
      msg: "success",
      data: { routed: options.type },
    });
  };
  const sender = createSender();
  const realtime = registered.handlers.get(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL);
  const controls = [
    ["interrupt", { message: "stop" }],
    ["submitAwaiting", { awaitingId: "awaiting-1", params: [] }],
    ["submitTool", { toolId: "tool-1", params: { accepted: true } }],
    ["steer", { message: "continue" }],
    ["updateAccessLevel", { accessLevel: "auto_approve" }],
  ];
  for (const [index, [control, payload]] of controls.entries()) {
    const result = await realtime({ sender }, { method: "request", input: {
      version: 2,
      operationId: `control-${index}`,
      kind: "run.control",
      control,
      chatId: "chat-1",
      runId: "run-1",
      owner: { kind: "agent", agentKey: "agent-1" },
      payload,
    }});
    assert.equal(result.response.status, 200, control);
    assert.equal(result.response.code, 0, control);
  }
  assert.deepEqual(forwarded.map(({ type }) => type), [
    "/api/interrupt",
    "/api/submit",
    "/api/submit",
    "/api/steer",
    "/api/access-level",
  ]);
  for (const { payload } of forwarded) {
    assert.equal(payload.chatId, "chat-1");
    assert.equal(payload.runId, "run-1");
    assert.equal(payload.agentKey, "agent-1");
  }
});
