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
  const target = {
    registrationId: "registration-1",
    surfaceId: "overview-1",
    surfaceKind: "service",
    surfaceType: "agent-summary",
    serviceId: "agent-webclient",
    pageRoute: "/overview",
    tabId: "overview-1",
    webContentsId: 41,
    ownerWebContentsId: 1,
    active: true,
    currentUrl: "http://127.0.0.1:7079/overview?chatId=chat-1",
    label: "Summary",
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
  return { broker, cleanups, cleared, dispatched, handlers, registration, target };
}

test("trusted bridge derives Summary capabilities and rejects control and forged chat identity", async () => {
  const { handlers } = createRegistration();
  const sender = createSender();
  const realtime = handlers.get(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL);
  const hello = await realtime({ sender }, { method: "hello" });
  assert.equal(hello.version, 1);
  assert.equal(hello.surface.kind, "agent-summary");
  assert.equal(hello.surface.ownerChatId, "chat-1");
  assert.equal(hello.surface.capabilities.includes("run.control"), false);
  const mismatched = await realtime({ sender }, { method: "hello", input: { version: 2 } });
  assert.equal(mismatched.error.code, "version_mismatch");

  const control = await realtime({ sender }, { method: "request", input: {
    version: 1, operationId: "operation-1", kind: "run.control", control: "interrupt",
    chatId: "chat-1", runId: "run-1", payload: {},
  }});
  assert.equal(control.error.code, "capability_denied");

  const forgedChat = await realtime({ sender }, { method: "subscribe", input: {
    version: 1, kind: "run", role: "summary", chatId: "chat-forged", runId: "run-1", lastSeq: 0,
  }});
  assert.equal(forgedChat.error.code, "capability_denied");
});

test("trusted WorkPanel bridge binds owner chat in Main and rejects an unregistered sender", async () => {
  const registered = createRegistration({ surfaceType: "agent-project", ownerChatId: "chat-owner" });
  const sender = createSender();
  const workpanel = registered.handlers.get(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL);
  const result = await workpanel({ sender }, { method: "openItem", input: {
    version: 1,
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
    method: "openItem", input: { version: 1, descriptor: { kind: "web", url: "https://example.test" } },
  });
  assert.equal(denied.error.code, "surface_unavailable");
});

test("destroyed guest automatically cleans subscriptions, pending consumers, and visible binding", async () => {
  const { handlers, cleanups, cleared } = createRegistration();
  const sender = createSender();
  const realtime = handlers.get(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL);
  const subscribed = await realtime({ sender }, { method: "subscribe", input: {
    version: 1, kind: "push", types: ["chat.updated"], filter: { chatId: "chat-1" },
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
    version: 1, kind: "push", types: ["chat.updated"], filter: { chatId: "chat-1" },
  }});
  assert.equal(subscribed.ok, true);
  sender.emit("did-start-loading");
  assert.ok(cleanups.includes("push"));
  assert.ok(cleanups.includes("agent-webclient-surface:42"));
  assert.deepEqual(cleared, ["surface:42"]);
});
