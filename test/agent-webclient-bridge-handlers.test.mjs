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
  const visibleRuns = new Map();
  const visibleSubscriptions = new Map();
  const runReadiness = new Map();
  const canonicalSyncs = [];
  let visibleBinding = null;
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
    beginForwardedVisibleRun: (input) => {
      const run = visibleRuns.get(input.runId) ?? {
        chatId: input.chatId,
        runId: input.runId,
        owner: input.owner,
        sourceId: input.sourceId,
        replay: [],
        subscribers: new Set(),
      };
      run.sourceId = input.sourceId;
      visibleRuns.set(input.runId, run);
      visibleBinding = { ...input };
    },
    registerForwardedRunActionGrant: (input) => {
      runReadiness.set(input.runId, input);
    },
    getVisibleBinding: () => visibleBinding,
    appendForwardedVisibleRunEvent: ({ sourceId, runId, event }) => {
      const run = visibleRuns.get(runId);
      if (!run || run.sourceId !== sourceId) throw new Error("visible source unavailable");
      run.replay.push(event);
      for (const id of run.subscribers) visibleSubscriptions.get(id)?.onEvent(event);
    },
    completeForwardedVisibleRun: ({ sourceId, runId, reason, lastSeq }) => {
      const run = visibleRuns.get(runId);
      if (!run || run.sourceId !== sourceId) return false;
      for (const id of [...run.subscribers]) {
        visibleSubscriptions.get(id)?.onComplete?.({ reason, lastSeq });
      }
      visibleBinding = null;
      run.sourceId = null;
      return true;
    },
    releaseForwardedVisibleRun: (sourceId) => {
      const run = [...visibleRuns.values()].find((candidate) => candidate.sourceId === sourceId);
      if (!run) return false;
      for (const id of [...run.subscribers]) {
        visibleSubscriptions.get(id)?.onError?.(Object.assign(new Error("replay required"), { name: "replay_required" }));
      }
      visibleBinding = null;
      run.sourceId = null;
      return true;
    },
    subscribeVisibleRun: (input) => {
      const run = visibleRuns.get(input.runId);
      if (!visibleBinding || !run || run.chatId !== input.chatId || run.sourceId !== visibleBinding.sourceId) {
        throw Object.assign(new Error("visible Run unavailable"), { name: "target_unavailable" });
      }
      const id = `visible-${visibleSubscriptions.size + 1}`;
      visibleSubscriptions.set(id, input);
      run.subscribers.add(id);
      for (const event of run.replay) {
        if ((Number(event.seq) || 0) > (input.lastSeq || 0)) input.onEvent(event);
      }
      return {
        ready: Promise.resolve(),
        unsubscribe: () => {
          visibleSubscriptions.delete(id);
          run.subscribers.delete(id);
        },
      };
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
    syncCanonicalChat: overrides.syncCanonicalChat ?? (async (_ownerWebContentsId, input) => {
      canonicalSyncs.push(input);
      const target = targets.get(input.guestWebContentsId);
      if (target) {
        target.ownerChatId = input.chatId;
        const url = new URL(target.currentUrl);
        url.searchParams.delete("newChat");
        url.searchParams.set("chatId", input.chatId);
        target.currentUrl = url.toString();
      }
      return { requestId: `sync-${canonicalSyncs.length}`, ok: true };
    }),
    dispatchWorkPanel: async (input) => {
      dispatched.push(input);
      return { ok: true, workspaceId: "workspace-1" };
    },
  });
  return {
    broker, calls, cleaned, dispatched, handlers, listeners, pushSubscribers,
    canonicalSyncs, registration, runReadiness, traces, visibleRuns, visibleSubscriptions,
  };
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
  const target = createTarget(41, {
    ownerChatId: "chat-1",
    pageRoute: "/agent/agent-1?chatId=chat-1",
    currentUrl: "http://127.0.0.1:7079/agent/agent-1?chatId=chat-1",
  });
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

test("Overview attaches to the Main Chat visible Run locally without another upstream stream", async () => {
  const mainTarget = createTarget(47, {
    ownerChatId: "chat-shared",
    pageRoute: "/agent/agent-1?chatId=chat-shared",
    currentUrl: "http://127.0.0.1:7079/agent/agent-1?chatId=chat-shared",
  });
  const overviewTarget = createTarget(48, {
    surfaceId: "overview:chat-shared",
    surfaceType: "agent-overview",
    surfaceRole: "overview",
    surfaceLevel: "child",
    parentSurfaceId: "main-chat",
    interaction: "read-only",
    ownerChatId: "chat-shared",
    pageRoute: "/overview/chat-shared",
    currentUrl: "http://127.0.0.1:7079/overview/chat-shared",
  });
  const forwarded = [];
  let deliverMain = () => undefined;
  const runtime = createRegistration(
    new Map([[47, mainTarget], [48, overviewTarget]]),
    async (input) => {
      forwarded.push(input.type);
      if (input.type === "/api/query") deliverMain = input.onFrame;
    },
  );
  const main = createSender(47, mainTarget.currentUrl);
  const overview = createSender(48, overviewTarget.currentUrl);
  await openSocket(runtime, main, "socket-main-visible");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: main }, {
    socketId: "socket-main-visible",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-main-visible",
      payload: { requestId: "req-visible", message: "hello", agentKey: "agent-1" },
    }),
  });
  await flush();
  const first = {
    frame: "stream",
    id: "query-main-visible",
    event: {
      type: "run.start",
      timestamp: 1_786_890_100_001,
      seq: 1,
      chatId: "chat-shared",
      runId: "run-shared",
      agentKey: "agent-1",
    },
  };
  deliverMain(first);

  await openSocket(runtime, overview, "socket-overview-visible");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: overview }, {
    socketId: "socket-overview-visible",
    data: JSON.stringify({
      frame: "request",
      type: "/api/attach",
      id: "attach-overview-visible",
      payload: { runId: "run-shared", agentKey: "agent-1", lastSeq: 0 },
    }),
  });
  await flush();

  const second = {
    frame: "stream",
    id: "query-main-visible",
    event: {
      type: "content.delta",
      timestamp: 1_786_890_100_002,
      seq: 2,
      chatId: "chat-shared",
      runId: "run-shared",
      delta: "live",
    },
  };
  deliverMain(second);
  await flush();

  assert.deepEqual(forwarded, ["/api/query"]);
  assert.deepEqual(sentFrames(main), [first, second]);
  assert.deepEqual(
    sentFrames(overview).filter((frame) => frame.frame === "stream").map((frame) => frame.event?.seq),
    [1, 2],
  );
  assert.equal(runtime.registration.getDiagnostics().activeLiveSurfaceCount, 1);

  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: overview }, {
    socketId: "socket-overview-visible",
    data: JSON.stringify({
      frame: "request",
      type: "/api/detach",
      id: "detach-overview-visible",
      payload: { runId: "run-shared", agentKey: "agent-1", reason: "surface_inactive" },
    }),
  });
  await flush();
  assert.deepEqual(forwarded, ["/api/query"]);
  assert.deepEqual(sentFrames(overview).at(-1), {
    frame: "response",
    id: "detach-overview-visible",
    type: "/api/detach",
    code: 0,
    data: {},
  });
});

test("Overview seq_expired errors retain retryability and replay-window diagnostics", async () => {
  const overviewTarget = createTarget(148, {
    surfaceId: "overview:chat-expired",
    surfaceType: "agent-overview",
    surfaceRole: "overview",
    surfaceLevel: "child",
    parentSurfaceId: "main-chat",
    interaction: "read-only",
    ownerChatId: "chat-expired",
    pageRoute: "/overview/chat-expired",
    currentUrl: "http://127.0.0.1:7079/overview/chat-expired",
  });
  const runtime = createRegistration(new Map([[148, overviewTarget]]), async () => {
    throw new Error("Overview must not open an upstream stream");
  });
  runtime.broker.beginForwardedVisibleRun({
    sourceId: "main-chat-source",
    chatId: "chat-expired",
    runId: "run-expired",
    owner: { kind: "agent", agentKey: "agent-1" },
  });
  const details = {
    requestedLastSeq: 0,
    firstAvailableSeq: 3,
    latestSeq: 2_002,
    replayEventCount: 2_000,
    replayBytes: 123_456,
  };
  runtime.broker.subscribeVisibleRun = () => {
    throw Object.assign(
      new Error("seq_expired: requested Run cursor is outside the local replay window"),
      { name: "seq_expired", retryable: true, details },
    );
  };

  const overview = createSender(148, overviewTarget.currentUrl);
  await openSocket(runtime, overview, "socket-overview-expired");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: overview }, {
    socketId: "socket-overview-expired",
    data: JSON.stringify({
      frame: "request",
      type: "/api/attach",
      id: "attach-overview-expired",
      payload: { runId: "run-expired", agentKey: "agent-1", lastSeq: 0 },
    }),
  });
  await flush();

  assert.deepEqual(sentFrames(overview).at(-1), {
    frame: "error",
    id: "attach-overview-expired",
    type: "seq_expired",
    code: 400,
    status: 400,
    msg: "seq_expired: requested Run cursor is outside the local replay window",
    data: {
      code: "seq_expired",
      message: "seq_expired: requested Run cursor is outside the local replay window",
      retryable: true,
      details,
      error: {
        code: "seq_expired",
        message: "seq_expired: requested Run cursor is outside the local replay window",
        retryable: true,
        details,
      },
    },
  });
});

test("a restored Main Chat attach exposes its visible Run before the first upstream event", async () => {
  const mainTarget = createTarget(49, {
    ownerChatId: "chat-restored",
    currentUrl: "http://127.0.0.1:7079/agent/agent-1?chatId=chat-restored",
  });
  const overviewTarget = createTarget(50, {
    surfaceId: "overview:chat-restored",
    surfaceType: "agent-overview",
    surfaceRole: "overview",
    surfaceLevel: "child",
    parentSurfaceId: "main-chat",
    interaction: "read-only",
    ownerChatId: "chat-restored",
    pageRoute: "/overview/chat-restored",
    currentUrl: "http://127.0.0.1:7079/overview/chat-restored",
  });
  const forwarded = [];
  let deliverMain = () => undefined;
  const runtime = createRegistration(
    new Map([[49, mainTarget], [50, overviewTarget]]),
    async (input) => {
      forwarded.push(input.type);
      if (input.type === "/api/attach") deliverMain = input.onFrame;
    },
  );
  const main = createSender(49, mainTarget.currentUrl);
  const overview = createSender(50, overviewTarget.currentUrl);
  await openSocket(runtime, main, "socket-main-restored");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: main }, {
    socketId: "socket-main-restored",
    data: JSON.stringify({
      frame: "request",
      type: "/api/attach",
      id: "attach-main-restored",
      payload: { runId: "run-restored", agentKey: "agent-1", lastSeq: 12 },
    }),
  });
  await flush();

  await openSocket(runtime, overview, "socket-overview-restored");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: overview }, {
    socketId: "socket-overview-restored",
    data: JSON.stringify({
      frame: "request",
      type: "/api/attach",
      id: "attach-overview-restored",
      payload: { runId: "run-restored", agentKey: "agent-1", lastSeq: 12 },
    }),
  });
  await flush();
  assert.deepEqual(forwarded, ["/api/attach"]);

  deliverMain({
    frame: "stream",
    id: "attach-main-restored",
    event: {
      type: "planning.update",
      timestamp: 1_786_890_200_013,
      seq: 13,
      chatId: "chat-restored",
      runId: "run-restored",
    },
  });
  await flush();
  assert.deepEqual(
    sentFrames(overview).filter((frame) => frame.frame === "stream").map((frame) => frame.event?.seq),
    [13],
  );
});

test("Overview waits for a new Main Chat query to publish its canonical Run identity", async () => {
  const mainTarget = createTarget(51, {
    ownerChatId: "chat-racing",
    pageRoute: "/agent/agent-1?chatId=chat-racing",
    currentUrl: "http://127.0.0.1:7079/agent/agent-1?chatId=chat-racing",
  });
  const overviewTarget = createTarget(52, {
    surfaceId: "overview:chat-racing",
    surfaceType: "agent-overview",
    surfaceRole: "overview",
    surfaceLevel: "child",
    parentSurfaceId: "main-chat",
    interaction: "read-only",
    ownerChatId: "chat-racing",
    pageRoute: "/overview/chat-racing",
    currentUrl: "http://127.0.0.1:7079/overview/chat-racing",
  });
  let deliverMain = () => undefined;
  const forwarded = [];
  const runtime = createRegistration(
    new Map([[51, mainTarget], [52, overviewTarget]]),
    async (input) => {
      forwarded.push(input.type);
      if (input.type === "/api/query") deliverMain = input.onFrame;
    },
  );
  const main = createSender(51, mainTarget.currentUrl);
  const overview = createSender(52, overviewTarget.currentUrl);
  await openSocket(runtime, main, "socket-main-racing");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: main }, {
    socketId: "socket-main-racing",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-main-racing",
      payload: { requestId: "req-racing", message: "hello", agentKey: "agent-1" },
    }),
  });
  await flush();

  await openSocket(runtime, overview, "socket-overview-racing");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender: overview }, {
    socketId: "socket-overview-racing",
    data: JSON.stringify({
      frame: "request",
      type: "/api/attach",
      id: "attach-overview-racing",
      payload: { runId: "run-racing", agentKey: "agent-1", lastSeq: 0 },
    }),
  });
  await flush();
  assert.equal(sentFrames(overview).some((frame) => frame.frame === "error"), false);

  deliverMain({
    frame: "stream",
    id: "query-main-racing",
    event: {
      type: "run.start",
      timestamp: 1_786_890_300_001,
      seq: 1,
      chatId: "chat-racing",
      runId: "run-racing",
      agentKey: "agent-1",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(forwarded, ["/api/query"]);
  assert.deepEqual(
    sentFrames(overview).filter((frame) => frame.frame === "stream").map((frame) => frame.event?.seq),
    [1],
  );
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

test("management Planning surface replays chat without live or WorkPanel-open capability", async () => {
  const target = createTarget(47, {
    surfaceId: "planning:chat-47:plan-47",
    surfaceType: "agent-management",
    surfaceRole: "planning",
    surfaceLevel: "child",
    parentSurfaceId: "main-chat",
    interaction: "read-only",
    ownerChatId: "chat-47",
    pageRoute: "/planning-viewer/plan-47",
    currentUrl: "http://127.0.0.1:7079/planning-viewer/plan-47?chatId=chat-47",
  });
  const forwarded = [];
  const runtime = createRegistration(new Map([[47, target]]), async (input) => {
    forwarded.push(input.type);
    input.onFrame({
      frame: "response",
      id: input.localId,
      type: input.type,
      code: 0,
      data: { id: "chat-47", messages: [] },
    });
  });
  const sender = createSender(47, target.currentUrl);
  await openSocket(runtime, sender, "socket-planning-data");

  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-planning-data",
    data: JSON.stringify({
      frame: "request",
      type: "/api/chat",
      id: "planning-replay-47",
      payload: { chatId: "chat-47" },
    }),
  });
  await flush();
  assert.deepEqual(forwarded, ["/api/chat"]);
  assert.equal(sentFrames(sender).at(-1).id, "planning-replay-47");

  for (const [type, id, payload] of [
    ["/api/query", "planning-query-denied", { agentKey: "agent-47", message: "no" }],
    ["/api/attach", "planning-attach-denied", { agentKey: "agent-47", runId: "run-47", lastSeq: 0 }],
    ["/api/btw", "planning-btw-denied", { agentKey: "agent-47", chatId: "chat-47", message: "no" }],
  ]) {
    runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
      socketId: "socket-planning-data",
      data: JSON.stringify({ frame: "request", type, id, payload }),
    });
    await flush();
    assert.equal(sentFrames(sender).at(-1).type, "surface_unavailable");
    assert.equal(sentFrames(sender).at(-1).id, id);
  }

  const workpanel = runtime.handlers.get(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL);
  assert.deepEqual(await workpanel({ sender }, { method: "getCapabilities" }), {
    ok: true,
    capabilities: ["workpanel.activate", "workpanel.close"],
  });
  const opened = await workpanel({ sender }, {
    method: "openItem",
    input: { version: 3, descriptor: { kind: "web", url: "https://example.test/" } },
  });
  assert.equal(opened.error.code, "capability_denied");
  assert.deepEqual(runtime.dispatched, []);
  assert.deepEqual(forwarded, ["/api/chat"]);
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
  const target = createTarget(43, {
    surfaceRole: "main-chat",
    surfaceLevel: "root",
    interaction: "interactive",
    ownerChatId: undefined,
    currentUrl: "http://127.0.0.1:7079/agent/agent-43?newChat=new-43",
  });
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
  assert.equal(runtime.canonicalSyncs.length, 1);
  assert.equal(runtime.canonicalSyncs[0].chatId, "chat-canonical");
  assert.equal(target.ownerChatId, "chat-canonical");
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

test("Main Chat query fails closed until an Agent switch route is fully registered", async () => {
  const target = createTarget(143, {
    surfaceRole: "main-chat",
    surfaceLevel: "root",
    interaction: "interactive",
    ownerChatId: "chat-agent-a",
    pageRoute: "/agent/agent-a?chatId=chat-agent-a",
    currentUrl: "http://127.0.0.1:7079/agent/agent-b",
  });
  const forwarded = [];
  const runtime = createRegistration(new Map([[143, target]]), async (input) => {
    forwarded.push(input.type);
  });
  const sender = createSender(143, target.currentUrl);
  await openSocket(runtime, sender, "socket-agent-switch");
  const serviceStateCallsBeforeQuery = runtime.calls.getServiceState;

  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-agent-switch",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-agent-switch-too-early",
      payload: {
        requestId: "req-agent-switch-too-early",
        message: "too early",
        agentKey: "agent-b",
      },
    }),
  });
  await flush();

  assert.deepEqual(forwarded, []);
  assert.equal(runtime.calls.getServiceState, serviceStateCallsBeforeQuery);
  assert.deepEqual(sentFrames(sender).at(-1), {
    frame: "error",
    id: "query-agent-switch-too-early",
    type: "protocol_error",
    code: 400,
    status: 400,
    msg: "query Agent owner does not match its active Main Chat route",
    data: {
      code: "protocol_error",
      message: "query Agent owner does not match its active Main Chat route",
    },
  });

  const switchedUrl = "http://127.0.0.1:7079/agent/agent-b?newChat=1786898700001";
  target.pageRoute = "/agent/agent-b?newChat=1786898700001";
  target.currentUrl = switchedUrl;
  target.ownerChatId = undefined;
  sender.setURL(switchedUrl);
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-agent-switch",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-agent-switch-ready",
      payload: {
        requestId: "req-agent-switch-ready",
        message: "ready",
        agentKey: "agent-b",
      },
    }),
  });
  await flush();

  assert.deepEqual(forwarded, ["/api/query"]);
  assert.equal(
    sentFrames(sender).some((frame) =>
      frame.id === "query-agent-switch-ready" && frame.frame === "error"
    ),
    false,
  );
});

test("new Main Chat run.start registers a WorkPanel grant against chat.start synchronization", async () => {
  const target = createTarget(73, {
    surfaceRole: "main-chat",
    surfaceLevel: "root",
    interaction: "interactive",
    ownerChatId: undefined,
    currentUrl: "http://127.0.0.1:7079/agent/agent-73?newChat=nonce-73",
  });
  let deliverFrame = () => undefined;
  let finishSync;
  const syncResult = new Promise((resolve) => { finishSync = resolve; });
  const runtime = createRegistration(
    new Map([[73, target]]),
    async ({ onFrame }) => { deliverFrame = onFrame; },
    { syncCanonicalChat: async () => syncResult },
  );
  const sender = createSender(73, target.currentUrl);
  await openSocket(runtime, sender, "socket-canonical-ready");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-canonical-ready",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-canonical-ready",
      payload: { requestId: "req-73", message: "open", agentKey: "agent-73" },
    }),
  });
  await flush();
  deliverFrame({
    frame: "stream",
    id: "query-canonical-ready",
    event: {
      seq: 1,
      payload: {
        type: "chat.start",
        timestamp: 1_786_898_700_001,
        chatId: "chat-73",
      },
    },
  });
  assert.equal(runtime.runReadiness.size, 0);
  deliverFrame({
    frame: "stream",
    id: "query-canonical-ready",
    event: {
      type: "run.start",
      timestamp: 1_786_898_700_002,
      seq: 2,
      chatId: "chat-73",
      runId: "run-73",
      agentKey: "agent-73",
    },
  });
  const readiness = runtime.runReadiness.get("run-73");
  assert.ok(readiness);
  let ready = false;
  void readiness.ready.then(() => { ready = true; });
  await flush();
  assert.equal(ready, false);
  finishSync({ requestId: "sync-73", ok: true });
  await readiness.ready;
  assert.equal(ready, true);
});

test("attachment-prebound new Chat synchronizes from the matching canonical request.query", async () => {
  const target = createTarget(76, {
    surfaceRole: "main-chat",
    surfaceLevel: "root",
    interaction: "interactive",
    ownerChatId: undefined,
    currentUrl: "http://127.0.0.1:7079/agent/agent-76?newChat=nonce-76",
  });
  let deliverFrame = () => undefined;
  const runtime = createRegistration(new Map([[76, target]]), async ({ onFrame }) => {
    deliverFrame = onFrame;
  });
  const sender = createSender(76, target.currentUrl);
  await openSocket(runtime, sender, "socket-attachment-prebound");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-attachment-prebound",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-attachment-prebound",
      payload: {
        requestId: "req-76",
        message: "edit this attachment",
        agentKey: "agent-76",
        chatId: "chat-76",
        references: [{ id: "ref-76", type: "file", name: "form.docx" }],
      },
    }),
  });
  await flush();
  deliverFrame({
    frame: "stream",
    id: "query-attachment-prebound",
    event: {
      type: "request.query",
      timestamp: 1_786_898_700_010,
      seq: 1,
      requestId: "req-76",
      chatId: "chat-76",
      runId: "run-76",
      agentKey: "agent-76",
    },
  });
  assert.equal(runtime.canonicalSyncs.length, 1);
  assert.equal(runtime.canonicalSyncs[0].chatId, "chat-76");
  deliverFrame({
    frame: "stream",
    id: "query-attachment-prebound",
    event: {
      type: "run.start",
      timestamp: 1_786_898_700_011,
      seq: 2,
      chatId: "chat-76",
      runId: "run-76",
      agentKey: "agent-76",
    },
  });
  await runtime.runReadiness.get("run-76").ready;
  assert.equal(sentFrames(sender).some((frame) => frame.frame === "error"), false);
});

test("canonical Main Chat owner permits continuation while the guest URL still has newChat", async () => {
  const target = createTarget(77, {
    surfaceRole: "main-chat",
    surfaceLevel: "root",
    interaction: "interactive",
    ownerChatId: "chat-77",
    currentUrl: "http://127.0.0.1:7079/agent/agent-77?newChat=stale-nonce-77",
  });
  let deliverFrame = () => undefined;
  const runtime = createRegistration(new Map([[77, target]]), async ({ onFrame }) => {
    deliverFrame = onFrame;
  });
  const sender = createSender(77, target.currentUrl);
  await openSocket(runtime, sender, "socket-canonical-continuation");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-canonical-continuation",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-canonical-continuation",
      payload: {
        requestId: "req-77",
        message: "continue",
        agentKey: "agent-77",
        chatId: "chat-77",
      },
    }),
  });
  await flush();
  deliverFrame({
    frame: "stream",
    id: "query-canonical-continuation",
    event: {
      type: "run.start",
      timestamp: 1_786_898_700_012,
      seq: 1,
      chatId: "chat-77",
      runId: "run-77",
      agentKey: "agent-77",
    },
  });
  await runtime.runReadiness.get("run-77").ready;
  assert.equal(runtime.canonicalSyncs.length, 0);
  assert.equal(sentFrames(sender).some((frame) => frame.frame === "error"), false);
});

test("new Main Chat run.start without chat.start fails closed", async () => {
  const target = createTarget(74, {
    surfaceRole: "main-chat",
    surfaceLevel: "root",
    interaction: "interactive",
    ownerChatId: undefined,
    currentUrl: "http://127.0.0.1:7079/agent/agent-74?newChat=nonce-74",
  });
  let deliverFrame = () => undefined;
  const runtime = createRegistration(new Map([[74, target]]), async ({ onFrame }) => {
    deliverFrame = onFrame;
  });
  const sender = createSender(74, target.currentUrl);
  await openSocket(runtime, sender, "socket-missing-chat-start");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-missing-chat-start",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-missing-chat-start",
      payload: { requestId: "req-74", message: "open", agentKey: "agent-74" },
    }),
  });
  await flush();
  deliverFrame({
    frame: "stream",
    id: "query-missing-chat-start",
    event: {
      type: "run.start",
      timestamp: 1_786_898_700_003,
      seq: 1,
      chatId: "chat-74",
      runId: "run-74",
      agentKey: "agent-74",
    },
  });
  assert.match(sentFrames(sender).at(-1).msg, /requires chat\.start or a matching canonical request\.query/u);
  assert.equal(runtime.registration.getDiagnostics().activeStreamCount, 0);
  await assert.rejects(runtime.runReadiness.get("run-74").ready, /requires chat\.start or a matching canonical request\.query/u);
});

test("new Main Chat rejects conflicting chat.start and run.start identities", async () => {
  const target = createTarget(75, {
    surfaceRole: "main-chat",
    surfaceLevel: "root",
    interaction: "interactive",
    ownerChatId: undefined,
    currentUrl: "http://127.0.0.1:7079/agent/agent-75?newChat=nonce-75",
  });
  let deliverFrame = () => undefined;
  const runtime = createRegistration(new Map([[75, target]]), async ({ onFrame }) => {
    deliverFrame = onFrame;
  });
  const sender = createSender(75, target.currentUrl);
  await openSocket(runtime, sender, "socket-conflicting-chat");
  runtime.listeners.get(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL)({ sender }, {
    socketId: "socket-conflicting-chat",
    data: JSON.stringify({
      frame: "request",
      type: "/api/query",
      id: "query-conflicting-chat",
      payload: { requestId: "req-75", message: "open", agentKey: "agent-75" },
    }),
  });
  await flush();
  deliverFrame({
    frame: "stream",
    id: "query-conflicting-chat",
    event: { type: "chat.start", timestamp: 1_786_898_700_004, seq: 1, chatId: "chat-75-a" },
  });
  deliverFrame({
    frame: "stream",
    id: "query-conflicting-chat",
    event: {
      type: "run.start",
      timestamp: 1_786_898_700_005,
      seq: 2,
      chatId: "chat-75-b",
      runId: "run-75",
      agentKey: "agent-75",
    },
  });
  assert.match(sentFrames(sender).at(-1).msg, /conflicts with the canonical Chat identity/u);
  await assert.rejects(runtime.runReadiness.get("run-75").ready, /conflicts with the canonical Chat identity/u);
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
  const firstTarget = createTarget(51, {
    ownerChatId: "chat-1",
    pageRoute: "/agent/agent-1?chatId=chat-1",
    currentUrl: "http://127.0.0.1:7079/agent/agent-1?chatId=chat-1",
  });
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
  assert.equal(runtime.runReadiness.has("run-1"), true);
  assert.deepEqual(runtime.runReadiness.get("run-1").owner, { kind: "agent", agentKey: "agent-1" });
});

test("surface handoff waits for an explicit detach write and does not send a duplicate detach", async () => {
  const firstTarget = createTarget(53, {
    ownerChatId: "chat-explicit-1",
    pageRoute: "/agent/agent-1?chatId=chat-explicit-1",
    currentUrl: "http://127.0.0.1:7079/agent/agent-1?chatId=chat-explicit-1",
  });
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
  const target = createTarget(55, {
    ownerChatId: "chat-same-surface",
    pageRoute: "/agent/agent-1?chatId=chat-same-surface",
    currentUrl: "http://127.0.0.1:7079/agent/agent-1?chatId=chat-same-surface",
  });
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
  assert.match(runtime.runReadiness.get("run-same-surface").sourceId, /attach-same-surface/u);
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

test("Overview WorkPanel child may open Resource Viewer and Planning tabs", async () => {
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

  const planningDescriptor = {
    kind: "webclient",
    module: "planning",
    route: "/planning-viewer/plan-72?chatId=chat-72",
    context: { chatId: "chat-72", planningId: "plan-72" },
  };
  const planningOpened = await workpanel({ sender }, {
    method: "openItem",
    input: { version: 3, descriptor: planningDescriptor },
  });
  assert.equal(planningOpened.ok, true);
  assert.deepEqual(runtime.dispatched.at(-1), {
    action: "openItem",
    ownerChatId: "chat-72",
    args: { descriptor: planningDescriptor },
  });
});
