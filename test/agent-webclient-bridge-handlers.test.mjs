import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerAgentWebclientBridgeIpcHandlers } = require("../dist-electron/main/ipc/agent-webclient-bridge-handlers.js");
const {
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_OPEN_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_CLOSE_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL,
  AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL,
} = require("../dist-electron/shared/contracts/agent-webclient-bridge.js");
const {
  __testInternals: deprecatedCompatibilityInternals,
} = require("../dist-electron/main/deprecated-compatibility.js");

const EPOCH_MS = 1_788_000_000_000;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createSender(id, url) {
  const sender = new EventEmitter();
  let destroyed = false;
  let currentUrl = url;
  sender.id = id;
  sender.messages = [];
  sender.isDestroyed = () => destroyed;
  sender.getType = () => "webview";
  sender.getURL = () => currentUrl;
  sender.setURL = (nextUrl) => { currentUrl = nextUrl; };
  sender.send = (channel, message) => sender.messages.push({ channel, message });
  sender.destroy = () => {
    destroyed = true;
    sender.emit("destroyed");
  };
  return sender;
}

function mainTarget(id = 101, overrides = {}) {
  const chatId = overrides.ownerChatId ?? "chat-1";
  const currentUrl = `http://127.0.0.1:7079/agent/agent-1?chatId=${chatId}`;
  return {
    registrationId: "main-g1",
    surfaceId: "main-chat",
    surfaceKind: "service",
    surfaceType: "agent-chat",
    serviceId: "agent-webclient",
    pageRoute: `/agent/agent-1?chatId=${chatId}`,
    pageRouteIdentity: `/agent/agent-1?chatId=${chatId}`,
    tabId: "main-tab",
    webContentsId: id,
    ownerWebContentsId: 1,
    active: true,
    currentUrl,
    label: "Main Chat",
    ownerChatId: chatId,
    surfaceRole: "main-chat",
    surfaceLevel: "root",
    interaction: "interactive",
    ...overrides,
  };
}

function childTarget(id, role, surfaceType, overrides = {}) {
  return {
    registrationId: `${role}-g1`,
    surfaceId: `${role}:chat-1`,
    surfaceKind: "service",
    surfaceType,
    serviceId: "agent-webclient",
    pageRoute: `/agent/agent-1/${role}?chatId=chat-1`,
    pageRouteIdentity: `/agent/agent-1/${role}?chatId=chat-1`,
    tabId: `${role}-tab`,
    webContentsId: id,
    ownerWebContentsId: 1,
    active: true,
    currentUrl: `http://127.0.0.1:7079/agent/agent-1/${role}?chatId=chat-1`,
    label: role,
    ownerChatId: "chat-1",
    surfaceRole: role,
    surfaceLevel: "child",
    parentSurfaceId: "main-chat",
    interaction: role === "overview" || role === "debug" ? "read-only" : "interactive",
    ...overrides,
  };
}

function sentFrames(sender) {
  return sender.messages.flatMap(({ channel, message }) =>
    channel === AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL && message.type === "frame"
      ? [message.frame]
      : [],
  );
}

function createRuntime(targets, overrides = {}) {
  const listeners = new Map();
  const handlers = new Map();
  const lifecycleListeners = new Set();
  const calls = {
    queries: [],
    attaches: [],
    clones: [],
    forwarded: [],
    releasedRoots: [],
    releasedRuns: [],
    cloneUnsubscribes: 0,
    debugTraces: [],
  };
  let activeRoot = null;
  let mainChatRoot = null;
  const broker = {
    ensureConnected: async () => undefined,
    getConnectionState: () => ({
      phase: "connected",
      generation: 1,
      physicalConnectionCount: 1,
      reconnectCount: 0,
      key: { endpoint: "http://127.0.0.1:7078", identitySessionId: "identity-1" },
      physicalSessionId: "platform-1",
    }),
    subscribeConnection: ({ onState }) => {
      onState(broker.getConnectionState());
      return () => undefined;
    },
    subscribePush: () => () => undefined,
    activateRootObserver: (observer) => {
      const next = { ...observer, contextEpoch: `context:${observer.token}`, runIds: new Set() };
      if (observer.kind === "main_chat") mainChatRoot = next;
      activeRoot = next;
      return next;
    },
    getActiveRootObserver: () => activeRoot,
    getMainChatRootObserver: () => mainChatRoot,
    promoteMainChatRootObserver: (token, chatId) => {
      if (!mainChatRoot || mainChatRoot.token !== token) throw new Error("stale Main Chat root");
      mainChatRoot.contextId = chatId;
      return mainChatRoot;
    },
    releaseRootObserver: (token) => {
      calls.releasedRoots.push(token);
      if (activeRoot?.token === token) activeRoot = null;
      if (mainChatRoot?.token === token) mainChatRoot = null;
      return true;
    },
    releaseObservedRun: (token, runId, reason) => {
      calls.releasedRuns.push({ token, runId, reason });
      return true;
    },
    query: (input) => {
      calls.queries.push(input);
      const runId = String(input.payload.runId || "run-generated");
      const chatId = String(input.payload.chatId || "chat-1");
      const owner = input.owner || { kind: "agent", agentKey: "agent-1" };
      const event = {
        type: "run.start",
        timestamp: EPOCH_MS,
        seq: 1,
        runId,
        chatId,
        ...(owner.kind === "agent" ? { agentKey: owner.agentKey } : { teamId: owner.teamId }),
      };
      queueMicrotask(() => void input.onEvent(event, `test.${runId}`));
      return {
        accepted: Promise.resolve({ runId, chatId, owner }),
        completed: new Promise(() => undefined),
      };
    },
    subscribeRun: (input) => {
      calls.attaches.push(input);
      return { ready: Promise.resolve(), unsubscribe: () => undefined };
    },
    subscribeClone: async (input) => {
      calls.clones.push(input);
      return {
        ready: Promise.resolve(),
        unsubscribe: () => { calls.cloneUnsubscribes += 1; },
      };
    },
    forwardRequest: async (input) => {
      calls.forwarded.push(input);
      input.onFrame({ frame: "response", id: input.localId, type: input.type, code: 0, data: { ok: true } });
      return `upstream-${input.localId}`;
    },
    registerRunActionGrant: () => undefined,
    cleanupConsumer: () => undefined,
    appendDebugTrace: (entry) => calls.debugTraces.push(entry),
    ...overrides.realtimeBroker,
  };
  const registration = registerAgentWebclientBridgeIpcHandlers({
    on: (channel, handler) => listeners.set(channel, handler),
    handle: (channel, handler) => handlers.set(channel, handler),
  }, {
    app: {},
    browserSurfaces: {
      resolveWebviewSurfaceTarget: (id) => targets.get(id) || null,
      waitForWebviewSurfaceTarget: async (id) => targets.get(id) || null,
      waitForWebviewSurfaceTargetMatching: async (id, predicate) => {
        const target = targets.get(id) || null;
        return target && predicate(target) ? target : null;
      },
      subscribeLifecycle: (listener) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      },
      ...overrides.browserSurfaces,
    },
    isTrustedAgentWebclientSession: () => true,
    realtimeBroker: broker,
    getServiceState: async () => ({ status: "running", healthMeta: { webUrl: "http://127.0.0.1:7078" } }),
    issueAccessToken: async () => ({ ok: true, token: "token", message: "" }),
    syncCanonicalChat: overrides.syncCanonicalChat
      || (async () => ({ requestId: "sync-1", ok: true })),
    dispatchWorkPanel: overrides.dispatchWorkPanel
      || (async () => ({ ok: true, workspaceId: "workspace-1" })),
    openResource: overrides.openResource
      || (async () => ({ ok: true, workspaceId: "workspace-1", itemId: "item-1", renderer: "native-image" })),
    openDocument: overrides.openDocument
      || (async () => ({ ok: true, workspaceId: "workspace-1", itemId: "item-2", renderer: "native-document" })),
  });
  const emitLifecycle = (event) => lifecycleListeners.forEach((listener) => listener(event));
  for (const target of targets.values()) {
    if (target.surfaceId !== "main-chat" || target.surfaceRole !== "main-chat" || !target.active) continue;
    emitLifecycle({
      type: "registered",
      surface: {
        registrationId: target.registrationId,
        surfaceId: target.surfaceId,
        surfaceRole: target.surfaceRole,
        surfaceIdentityKey: target.surfaceIdentityKey || "",
        active: target.active,
        ownerChatId: target.ownerChatId || "",
        ownerWebContentsId: target.ownerWebContentsId,
        guestWebContentsIds: [target.webContentsId],
      },
    });
  }
  return {
    broker,
    calls,
    registration,
    listeners,
    handlers,
    emitLifecycle,
  };
}

test("WorkPanel bridge keeps the v4/v5 compatibility matrix and deduplicates diagnostics by version and method", async () => {
  const target = mainTarget();
  const runtime = createRuntime(new Map([[target.webContentsId, target]]));
  const sender = createSender(target.webContentsId, target.currentUrl);
  const invoke = runtime.handlers.get(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL);
  const warnings = [];
  const originalWarn = console.warn;
  deprecatedCompatibilityInternals.resetDesktopVersion();
  deprecatedCompatibilityInternals.clearReportedCompatibilityUses();
  console.warn = (...args) => warnings.push(args);
  try {
    const v4Item = {
      method: "openItem",
      input: { version: 4, descriptor: { kind: "web", id: "legacy-item" } },
    };
    assert.equal((await invoke({ sender }, v4Item)).ok, true);
    assert.equal((await invoke({ sender }, v4Item)).ok, true);
    assert.equal((await invoke({ sender }, {
      method: "activateItem",
      input: { version: 4, itemId: "legacy-item" },
    })).ok, true);
    assert.equal((await invoke({ sender }, {
      method: "openResource",
      input: { version: 4 },
    })).error.code, "version_mismatch");

    const v5Resource = {
      method: "openResource",
      input: {
        version: 5,
        profile: "artifact",
        agentKey: "agent-1",
        chatId: "chat-1",
        resourceId: "resource-1",
        relativePath: "artifacts/images/example.png",
      },
    };
    assert.equal((await invoke({ sender }, v5Resource)).ok, true);
    assert.equal((await invoke({ sender }, v5Resource)).ok, true);
    assert.equal((await invoke({ sender }, {
      method: "openDocument",
      input: { version: 5, source: { kind: "workspace-file", agentKey: "agent-1", path: "README.md" } },
    })).error.code, "version_mismatch");
    assert.equal((await invoke({ sender }, {
      method: "openDocument",
      input: { version: 6, source: { kind: "workspace-file", agentKey: "agent-1", path: "README.md" } },
    })).ok, true);
    assert.equal((await invoke({ sender }, {
      method: "openItem",
      input: { version: 7, descriptor: { kind: "web", id: "future-item" } },
    })).error.code, "version_mismatch");

    const compatibilityWarnings = warnings.filter((args) => args[0] === "[deprecated-compatibility]");
    assert.deepEqual(
      compatibilityWarnings.map((args) => args[1]),
      [
        { id: "agent-webclient.bridge-v4", version: 4, method: "openItem" },
        { id: "agent-webclient.bridge-v4", version: 4, method: "activateItem" },
        { id: "agent-webclient.bridge-v5", version: 5, method: "openResource" },
      ],
    );
  } finally {
    console.warn = originalWarn;
    deprecatedCompatibilityInternals.clearReportedCompatibilityUses();
  }
});

async function openSession(runtime, sender, sessionId) {
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_OPEN_CHANNEL)({ sender }, { sessionId });
  await flush();
  const state = sender.messages.find(({ message }) => message.sessionId === sessionId && message.type === "state");
  assert.equal(state.message.state.phase, "connected");
}

function send(runtime, sender, sessionId, frame) {
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL)({ sender }, { sessionId, frame });
}

function emitRegisteredTarget(runtime, target) {
  runtime.emitLifecycle({
    type: "registered",
    surface: {
      registrationId: target.registrationId,
      surfaceId: target.surfaceId,
      surfaceRole: target.surfaceRole,
      surfaceIdentityKey: target.surfaceIdentityKey || "",
      active: target.active,
      ownerChatId: target.ownerChatId || "",
      ownerWebContentsId: target.ownerWebContentsId,
      guestWebContentsIds: [target.webContentsId],
    },
  });
}

test("Main Chat query is Broker-owned on the Primary lane and keeps FramePort v2 ids", async () => {
  const target = mainTarget();
  const runtime = createRuntime(new Map([[target.webContentsId, target]]));
  const sender = createSender(target.webContentsId, target.currentUrl);
  await openSession(runtime, sender, "main-session");
  send(runtime, sender, "main-session", {
    frame: "request",
    id: "local-query-1",
    type: "/api/query",
    payload: { requestId: "request-1", runId: "run-1", agentKey: "agent-1", message: "hello" },
  });
  await flush();

  assert.equal(runtime.calls.queries.length, 1);
  assert.equal(runtime.calls.queries[0].lane, "primary");
  assert.equal(runtime.calls.queries[0].requestType, "/api/query");
  assert.equal(runtime.calls.queries[0].payload.chatId, "chat-1");
  assert.equal(runtime.calls.queries[0].consumerId, "agent-webclient-frame-port:101:main-session");
  assert.equal(runtime.calls.forwarded.length, 0);
  assert.equal(runtime.broker.getActiveRootObserver().kind, "main_chat");
  assert.equal(sentFrames(sender)[0].id, "local-query-1");
  assert.equal(sentFrames(sender)[0].event.type, "run.start");
});

test("canonical Main Chat query waits for stale owner registration to converge", async () => {
  const stale = mainTarget(101, { active: false });
  const ready = mainTarget(101, {
    ownerChatId: "chat-2",
    pageRoute: "/agent/agent-1?chatId=chat-2",
    pageRouteIdentity: "/agent/agent-1?chatId=chat-2",
    currentUrl: "http://127.0.0.1:7079/agent/agent-1?chatId=chat-2",
  });
  const targets = new Map([[101, stale]]);
  const runtime = createRuntime(targets, {
    browserSurfaces: {
      waitForWebviewSurfaceTargetMatching: async (id, predicate) => {
        targets.set(id, ready);
        emitRegisteredTarget(runtime, ready);
        return predicate(ready) ? ready : null;
      },
    },
  });
  const sender = createSender(101, ready.currentUrl);
  await openSession(runtime, sender, "main-transition");
  send(runtime, sender, "main-transition", {
    frame: "request",
    id: "query-chat-2",
    type: "/api/query",
    payload: {
      requestId: "request-chat-2",
      runId: "run-chat-2",
      chatId: "chat-2",
      agentKey: "agent-1",
      message: "continue",
    },
  });
  await flush();

  assert.equal(runtime.calls.queries.length, 1);
  assert.equal(runtime.calls.queries[0].payload.chatId, "chat-2");
  assert.equal(sentFrames(sender).some((frame) => frame.frame === "error"), false);
});

test("Main Chat convergence never authorizes a payload that disagrees with the sender route", async () => {
  const stale = mainTarget(101, { active: false });
  const sender = createSender(
    101,
    "http://127.0.0.1:7079/agent/agent-1?chatId=chat-2",
  );
  const runtime = createRuntime(new Map([[101, stale]]), {
    browserSurfaces: {
      waitForWebviewSurfaceTargetMatching: async () => {
        throw new Error("mismatched query must not enter the convergence wait");
      },
    },
  });
  await openSession(runtime, sender, "main-mismatched-transition");
  send(runtime, sender, "main-mismatched-transition", {
    frame: "request",
    id: "query-chat-3",
    type: "/api/query",
    payload: {
      requestId: "request-chat-3",
      runId: "run-chat-3",
      chatId: "chat-3",
      agentKey: "agent-1",
      message: "stale",
    },
  });
  await flush();

  assert.equal(runtime.calls.queries.length, 0);
  assert.equal(sentFrames(sender).at(-1).type, "protocol_error");
});

test("registered ownerless new Chat query enters the Broker without convergence waiting", async () => {
  const newChatUrl = "http://127.0.0.1:7079/agent/agent-1?newChat=new-source-ready";
  const ready = mainTarget(101, {
    ownerChatId: undefined,
    pageRoute: "/agent/agent-1?newChat=new-source-ready",
    pageRouteIdentity: "/agent/agent-1?newChat=new-source-ready",
    currentUrl: newChatUrl,
  });
  let waitCalls = 0;
  const targets = new Map([[101, ready]]);
  const runtime = createRuntime(targets, {
    browserSurfaces: {
      waitForWebviewSurfaceTargetMatching: async () => {
        waitCalls += 1;
        return null;
      },
    },
    realtimeBroker: {
      query: (input) => {
        runtime.calls.queries.push(input);
        const owner = { kind: "agent", agentKey: "agent-1" };
        queueMicrotask(() => {
          void input.onEvent({
            type: "chat.start",
            timestamp: EPOCH_MS,
            seq: 1,
            chatId: "chat-ready",
            agentKey: "agent-1",
          }, "test.ready-new-chat.chat-start");
          void input.onEvent({
            type: "run.start",
            timestamp: EPOCH_MS,
            seq: 2,
            runId: "run-ready",
            chatId: "chat-ready",
            agentKey: "agent-1",
          }, "test.ready-new-chat.run-start");
        });
        return {
          accepted: Promise.resolve({ runId: "run-ready", chatId: "chat-ready", owner }),
          completed: new Promise(() => undefined),
        };
      },
    },
  });
  const sender = createSender(101, newChatUrl);
  await openSession(runtime, sender, "main-new-chat-ready");
  send(runtime, sender, "main-new-chat-ready", {
    frame: "request",
    id: "query-new-chat-ready",
    type: "/api/query",
    payload: {
      requestId: "request-new-chat-ready",
      runId: "run-ready",
      agentKey: "agent-1",
      message: "new",
    },
  });
  await flush();

  assert.equal(waitCalls, 0);
  assert.equal(runtime.calls.queries.length, 1);
  assert.equal(sentFrames(sender).some((frame) => frame.frame === "error"), false);
});

test("chat.start promotes the Desktop owner before the guest promotion guard ACK", async () => {
  const newChatUrl = "http://127.0.0.1:7079/agent/agent-1?newChat=new-source-promote";
  const ready = mainTarget(101, {
    ownerChatId: undefined,
    pageRoute: "/agent/agent-1?newChat=new-source-promote",
    pageRouteIdentity: "/agent/agent-1?newChat=new-source-promote",
    currentUrl: newChatUrl,
  });
  let resolveCanonicalSync;
  const canonicalSync = new Promise((resolve) => {
    resolveCanonicalSync = resolve;
  });
  const runtime = createRuntime(new Map([[101, ready]]), {
    syncCanonicalChat: () => canonicalSync,
    realtimeBroker: {
      query: (input) => {
        runtime.calls.queries.push(input);
        const owner = { kind: "agent", agentKey: "agent-1" };
        queueMicrotask(() => {
          void input.onEvent({
            type: "chat.start",
            timestamp: EPOCH_MS,
            seq: 1,
            chatId: "chat-promoted",
            agentKey: "agent-1",
          }, "test.promote-new-chat.chat-start");
        });
        return {
          accepted: Promise.resolve({
            runId: "run-promoted",
            chatId: "chat-promoted",
            owner,
          }),
          completed: new Promise(() => undefined),
        };
      },
    },
  });
  const sender = createSender(101, newChatUrl);
  await openSession(runtime, sender, "main-new-chat-promote");
  send(runtime, sender, "main-new-chat-promote", {
    frame: "request",
    id: "query-new-chat-promote",
    type: "/api/query",
    payload: {
      requestId: "request-new-chat-promote",
      agentKey: "agent-1",
      message: "new",
    },
  });
  await flush();

  assert.equal(
    runtime.broker.getMainChatRootObserver()?.contextId,
    "chat-promoted",
  );
  assert.equal(
    sentFrames(sender).some((frame) => frame.event?.type === "chat.start"),
    false,
  );

  resolveCanonicalSync({ requestId: "sync-promote", ok: true });
  await flush();
  assert.equal(
    sentFrames(sender).some((frame) => frame.event?.type === "chat.start"),
    true,
  );
});

test("new Chat query waits for a stale canonical owner to become the new-chat source", async () => {
  const stale = mainTarget(101, { active: false });
  const newChatUrl = "http://127.0.0.1:7079/agent/agent-1?newChat=new-source-2";
  const ready = mainTarget(101, {
    ownerChatId: undefined,
    pageRoute: "/agent/agent-1?newChat=new-source-2",
    pageRouteIdentity: "/agent/agent-1?newChat=new-source-2",
    currentUrl: newChatUrl,
  });
  const targets = new Map([[101, stale]]);
  const runtime = createRuntime(targets, {
    browserSurfaces: {
      waitForWebviewSurfaceTargetMatching: async (id, predicate) => {
        targets.set(id, ready);
        emitRegisteredTarget(runtime, ready);
        return predicate(ready) ? ready : null;
      },
    },
    realtimeBroker: {
      query: (input) => {
        runtime.calls.queries.push(input);
        const owner = { kind: "agent", agentKey: "agent-1" };
        queueMicrotask(() => {
          void input.onEvent({
            type: "chat.start",
            timestamp: EPOCH_MS,
            seq: 1,
            chatId: "chat-2",
            agentKey: "agent-1",
          }, "test.new-chat.chat-start");
          void input.onEvent({
            type: "run.start",
            timestamp: EPOCH_MS,
            seq: 2,
            runId: "run-new-chat-2",
            chatId: "chat-2",
            agentKey: "agent-1",
          }, "test.new-chat.run-start");
        });
        return {
          accepted: Promise.resolve({ runId: "run-new-chat-2", chatId: "chat-2", owner }),
          completed: new Promise(() => undefined),
        };
      },
    },
  });
  const sender = createSender(101, newChatUrl);
  await openSession(runtime, sender, "main-new-chat-transition");
  send(runtime, sender, "main-new-chat-transition", {
    frame: "request",
    id: "query-new-chat-2",
    type: "/api/query",
    payload: {
      requestId: "request-new-chat-2",
      runId: "run-new-chat-2",
      chatId: "chat-2",
      agentKey: "agent-1",
      message: "new",
    },
  });
  await flush();

  assert.equal(runtime.calls.queries.length, 1);
  assert.equal(runtime.calls.queries[0].payload.chatId, "chat-2");
  assert.equal(sentFrames(sender).some((frame) => frame.frame === "error"), false);
});

test("new Chat convergence expiry stays local and records the observed route state", async () => {
  const newChatUrl = "http://127.0.0.1:7079/agent/agent-1?newChat=new-source-expired";
  const stale = mainTarget(101, {
    active: false,
    currentUrl: newChatUrl,
  });
  const runtime = createRuntime(new Map([[101, stale]]), {
    browserSurfaces: {
      waitForWebviewSurfaceTargetMatching: async (_id, _predicate, timeoutMs) => {
        assert.equal(timeoutMs, 1_500);
        return null;
      },
    },
  });
  const sender = createSender(101, newChatUrl);
  await openSession(runtime, sender, "main-new-chat-expired");
  send(runtime, sender, "main-new-chat-expired", {
    frame: "request",
    id: "query-new-chat-expired",
    type: "/api/query",
    payload: {
      requestId: "request-new-chat-expired",
      runId: "run-expired",
      agentKey: "agent-1",
      message: "new",
    },
  });
  await flush();

  assert.equal(runtime.calls.queries.length, 0);
  const error = sentFrames(sender).at(-1);
  assert.equal(error.type, "protocol_error");
  assert.equal(error.msg, "Main Chat identity did not converge before query authorization");
  const failedTrace = runtime.calls.debugTraces.findLast((entry) =>
    entry.data?.event === "main-chat-query-identity-convergence" &&
    entry.data?.state === "failed"
  );
  assert.equal(failedTrace.data.reason, "registration_wait_expired");
  assert.equal(failedTrace.data.observedActive, false);
  assert.equal(failedTrace.data.ownerPresent, true);
  assert.equal(failedTrace.data.observedPageRouteKind, "canonical");
  assert.equal(failedTrace.data.observedGuestRouteKind, "new-chat");
  assert.equal(failedTrace.data.senderRouteKind, "new-chat");
});

test("trusted Main Chat registration creates the Broker bundle before FramePort open", () => {
  const main = mainTarget();
  const runtime = createRuntime(new Map([[main.webContentsId, main]]));
  const root = runtime.broker.getMainChatRootObserver();
  assert.equal(root.kind, "main_chat");
  assert.equal(root.generation, main.registrationId);
  assert.equal(root.contextId, main.ownerChatId);
});

test("Overview may attach before the Main Chat live request without parent observer failure", async () => {
  const main = mainTarget();
  const overview = childTarget(102, "overview", "agent-overview");
  const runtime = createRuntime(new Map([[101, main], [102, overview]]));
  const overviewSender = createSender(102, overview.currentUrl);
  await openSession(runtime, overviewSender, "overview-first");
  send(runtime, overviewSender, "overview-first", {
    frame: "request",
    id: "overview-first-attach",
    type: "/api/attach",
    payload: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1", lastSeq: 0 },
  });
  await flush();

  assert.equal(runtime.calls.clones.length, 1);
  assert.equal(runtime.calls.clones[0].kind, "overview");
  assert.equal(sentFrames(overviewSender).some((frame) =>
    frame.data?.error?.details?.reason === "parent_observer_closed"
  ), false);

  const mainSender = createSender(101, main.currentUrl);
  await openSession(runtime, mainSender, "main-after-overview");
  send(runtime, mainSender, "main-after-overview", {
    frame: "request",
    id: "main-after-overview-query",
    type: "/api/query",
    payload: { requestId: "rq", runId: "run-1", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
  });
  await flush();
  assert.equal(runtime.calls.queries.length, 1);
});

test("Overview and Debug attach only as local Main Chat clones", async () => {
  const main = mainTarget();
  const overview = childTarget(102, "overview", "agent-overview");
  const debug = childTarget(103, "debug", "agent-debug");
  const runtime = createRuntime(new Map([[101, main], [102, overview], [103, debug]]));
  const mainSender = createSender(101, main.currentUrl);
  await openSession(runtime, mainSender, "main");
  send(runtime, mainSender, "main", {
    frame: "request", id: "q", type: "/api/query",
    payload: { requestId: "rq", runId: "run-1", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
  });
  await flush();

  for (const [target, sessionId] of [[overview, "overview"], [debug, "debug"]]) {
    const sender = createSender(target.webContentsId, target.currentUrl);
    await openSession(runtime, sender, sessionId);
    send(runtime, sender, sessionId, {
      frame: "request", id: `${sessionId}-attach`, type: "/api/attach",
      payload: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1", lastSeq: 0 },
    });
    await flush();
  }

  assert.equal(runtime.calls.clones.length, 2);
  assert.equal(runtime.calls.attaches.length, 0);
  assert.equal(runtime.calls.forwarded.length, 0);
});

test("clone detach is local and never releases or detaches the upstream Run", async () => {
  const main = mainTarget();
  const overview = childTarget(102, "overview", "agent-overview");
  const runtime = createRuntime(new Map([[101, main], [102, overview]]));
  const mainSender = createSender(101, main.currentUrl);
  await openSession(runtime, mainSender, "main");
  send(runtime, mainSender, "main", {
    frame: "request", id: "q", type: "/api/query",
    payload: { requestId: "rq", runId: "run-1", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
  });
  await flush();
  const sender = createSender(102, overview.currentUrl);
  await openSession(runtime, sender, "overview");
  send(runtime, sender, "overview", {
    frame: "request", id: "a", type: "/api/attach",
    payload: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1", lastSeq: 0 },
  });
  await flush();
  send(runtime, sender, "overview", {
    frame: "request", id: "d", type: "/api/detach",
    payload: { runId: "run-1", agentKey: "agent-1" },
  });
  await flush();
  assert.equal(runtime.calls.cloneUnsubscribes, 1);
  assert.equal(runtime.calls.releasedRuns.length, 0);
  assert.equal(runtime.calls.forwarded.length, 0);
});

test("Overview FramePort close releases only its UI subscriber", async () => {
  const main = mainTarget();
  const overview = childTarget(102, "overview", "agent-overview");
  const runtime = createRuntime(new Map([[101, main], [102, overview]]));
  const sender = createSender(102, overview.currentUrl);
  await openSession(runtime, sender, "overview-close");
  send(runtime, sender, "overview-close", {
    frame: "request",
    id: "overview-close-attach",
    type: "/api/attach",
    payload: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1", lastSeq: 0 },
  });
  await flush();

  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_CLOSE_CHANNEL)(
    { sender },
    { sessionId: "overview-close", reason: "surface_inactive" },
  );
  await flush();
  assert.equal(runtime.calls.cloneUnsubscribes, 1);
  assert.equal(runtime.calls.releasedRuns.length, 0);
  assert.equal(runtime.calls.releasedRoots.length, 0);
});

test("BTW query and attach reuse the Main Chat observer but route to the BTW lane", async () => {
  const main = mainTarget();
  const btw = childTarget(104, "btw", "agent-btw");
  const runtime = createRuntime(new Map([[101, main], [104, btw]]));
  const mainSender = createSender(101, main.currentUrl);
  await openSession(runtime, mainSender, "main");
  send(runtime, mainSender, "main", {
    frame: "request", id: "q", type: "/api/query",
    payload: { requestId: "rq", runId: "run-main", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
  });
  await flush();

  const sender = createSender(104, btw.currentUrl);
  await openSession(runtime, sender, "btw");
  send(runtime, sender, "btw", {
    frame: "request", id: "bq", type: "/api/btw",
    payload: { runId: "run-btw", chatId: "chat-1", agentKey: "agent-1", message: "side" },
  });
  await flush();
  send(runtime, sender, "btw", {
    frame: "request", id: "ba", type: "/api/attach",
    payload: { runId: "run-btw", chatId: "chat-1", agentKey: "agent-1", lastSeq: 1 },
  });
  await flush();

  assert.equal(runtime.calls.queries.at(-1).lane, "btw");
  assert.equal(runtime.calls.queries.at(-1).requestType, "/api/btw");
  assert.equal(runtime.calls.attaches[0].lane, "btw");
  assert.equal(runtime.calls.attaches[0].observerToken, runtime.broker.getActiveRootObserver().token);
});

test("Overview cannot survive without an active Main Chat observer", async () => {
  const overview = childTarget(102, "overview", "agent-overview");
  const runtime = createRuntime(new Map([[102, overview]]));
  const sender = createSender(102, overview.currentUrl);
  await openSession(runtime, sender, "overview");
  send(runtime, sender, "overview", {
    frame: "request", id: "a", type: "/api/attach",
    payload: { runId: "run-1", chatId: "chat-1", agentKey: "agent-1", lastSeq: 0 },
  });
  await flush();
  const error = sentFrames(sender).at(-1);
  assert.equal(error.type, "target_unavailable");
  assert.equal(error.data.error.details.reason, "parent_observer_closed");
  assert.equal(runtime.calls.clones.length, 0);
});

test("only Main Chat, Copilot Dock and Kanban Chat can become Root Observers", async () => {
  const kanban = mainTarget(105, {
    registrationId: "kanban-g1",
    surfaceId: "kanban-chat",
    surfaceRole: "kanban-chat",
    pageRoute: "/kanban",
    pageRouteIdentity: "/kanban",
    currentUrl: "http://127.0.0.1:7079/kanban?chatId=chat-1",
  });
  const project = childTarget(106, "project", "agent-project");
  const runtime = createRuntime(new Map([[105, kanban], [106, project]]));
  const kanbanSender = createSender(105, kanban.currentUrl);
  await openSession(runtime, kanbanSender, "kanban");
  send(runtime, kanbanSender, "kanban", {
    frame: "request", id: "kq", type: "/api/query",
    payload: { requestId: "rk", runId: "run-k", chatId: "chat-1", agentKey: "agent-1", message: "run" },
  });
  await flush();
  assert.equal(runtime.broker.getActiveRootObserver().kind, "kanban_chat");

  const projectSender = createSender(106, project.currentUrl);
  await openSession(runtime, projectSender, "project");
  send(runtime, projectSender, "project", {
    frame: "request", id: "pq", type: "/api/query",
    payload: { requestId: "rp", runId: "run-p", chatId: "chat-1", agentKey: "agent-1", message: "no" },
  });
  await flush();
  assert.equal(sentFrames(projectSender).at(-1).type, "surface_unavailable");
  assert.equal(runtime.calls.queries.length, 1);
});

test("Registry inactivity releases the Root Observer without closing the FramePort session", async () => {
  const main = mainTarget();
  const runtime = createRuntime(new Map([[101, main]]));
  const sender = createSender(101, main.currentUrl);
  await openSession(runtime, sender, "main");
  send(runtime, sender, "main", {
    frame: "request", id: "q", type: "/api/query",
    payload: { requestId: "rq", runId: "run-1", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
  });
  await flush();
  runtime.emitLifecycle({
    type: "registered",
    surface: {
      registrationId: "main-g1",
      surfaceId: "main-chat",
      surfaceRole: "main-chat",
      surfaceIdentityKey: "",
      active: false,
      ownerChatId: "chat-1",
      ownerWebContentsId: 1,
      guestWebContentsIds: [101],
    },
  });
  assert.equal(runtime.broker.getActiveRootObserver(), null);
  assert.equal(sender.messages.some(({ message }) => message.type === "close"), false);
  assert.equal(sentFrames(sender).some((frame) => frame.id === "q" && frame.reason === "detached"), true);

  send(runtime, sender, "main", {
    frame: "request", id: "chat", type: "/api/chat", payload: { chatId: "chat-2" },
  });
  await flush();
  assert.equal(runtime.calls.forwarded.at(-1).type, "/api/chat");
  assert.equal(sentFrames(sender).at(-1).id, "chat");
});

test("Registry context identity change atomically replaces the old Main Chat bundle", async () => {
  const main = mainTarget();
  const runtime = createRuntime(new Map([[101, main]]));
  const sender = createSender(101, main.currentUrl);
  await openSession(runtime, sender, "main");
  send(runtime, sender, "main", {
    frame: "request", id: "q", type: "/api/query",
    payload: { requestId: "rq", runId: "run-1", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
  });
  await flush();
  runtime.emitLifecycle({
    type: "registered",
    surface: {
      registrationId: "main-g1",
      surfaceId: "main-chat",
      surfaceRole: "main-chat",
      surfaceIdentityKey: "",
      active: true,
      ownerChatId: "",
      ownerWebContentsId: 1,
      guestWebContentsIds: [101],
    },
  });
  assert.equal(runtime.broker.getMainChatRootObserver().contextId, "main-chat:main-g1");
  assert.equal(sender.messages.some(({ message }) => message.type === "close"), false);
  assert.equal(sentFrames(sender).some((frame) => frame.id === "q" && frame.reason === "detached"), true);
});

test("FramePort close keeps the Registry-owned Main Chat bundle alive", async () => {
  const main = mainTarget();
  const runtime = createRuntime(new Map([[101, main]]));
  const sender = createSender(101, main.currentUrl);
  await openSession(runtime, sender, "main");
  send(runtime, sender, "main", {
    frame: "request", id: "q", type: "/api/query",
    payload: { requestId: "rq", runId: "run-1", chatId: "chat-1", agentKey: "agent-1", message: "hello" },
  });
  await flush();
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_CLOSE_CHANNEL)(
    { sender },
    { sessionId: "main", reason: "surface_inactive" },
  );
  assert.equal(runtime.calls.releasedRoots.length, 0);
  assert.equal(runtime.broker.getMainChatRootObserver().contextId, "chat-1");
  assert.equal(runtime.calls.forwarded.some((call) => call.type === "/api/interrupt"), false);
});

test("ordinary non-live requests still use the Broker request multiplexer", async () => {
  const project = childTarget(106, "project", "agent-project");
  const runtime = createRuntime(new Map([[106, project]]));
  const sender = createSender(106, project.currentUrl);
  await openSession(runtime, sender, "project");
  send(runtime, sender, "project", {
    frame: "request", id: "file-1", type: "/api/file", payload: { path: "README.md" },
  });
  await flush();
  assert.equal(runtime.calls.forwarded.length, 1);
  assert.equal(runtime.calls.forwarded[0].stream, false);
  assert.equal(sentFrames(sender).at(-1).id, "file-1");
});
