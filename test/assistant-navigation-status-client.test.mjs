import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  AssistantNavigationStatusClient,
  applyAssistantNavigationChatPush,
  applyAssistantNavigationPush,
  buildAssistantCopilotAgentsFromPlatformAgents,
  buildAssistantNavigationChatsSnapshotFromPlatform,
  buildAssistantNavigationChatsFromPlatform,
  buildAssistantNavigationAgentsFromPlatformAgents,
  enrichNavigationAgentsWithGitBranches,
  readAssistantNavigationActivityAgentsFromPlatform,
  readAssistantCopilotAgentsFromPlatform,
  readAssistantNavigationAgentsFromPlatform,
  resolveAssistantWorkspaceGitBranch,
} = require("../dist-electron/main/assistant/core/assistant-navigation-status-client.js");

const EPOCH_MS = 1_783_000_000_000;

function createAgent(overrides = {}) {
  return {
    agentKey: "zenmi",
    displayName: "Zenmi",
    role: "",
    unreadCount: 0,
    unreadChatCount: 0,
    chatCount: 0,
    hasPendingAwaiting: false,
    latestChatId: null,
    latestPreview: "",
    updatedAt: EPOCH_MS,
    recentChats: [],
    ...overrides,
  };
}

function findChat(items, chatId) {
  return items.flatMap((agent) => agent.recentChats).find((chat) => chat.chatId === chatId);
}

function createNavigationChat(overrides = {}) {
  return {
    chatId: "chat-1",
    chatName: "Chat one",
    agentKey: "zenmi",
    createdAt: EPOCH_MS,
    updatedAt: EPOCH_MS,
    lastRunId: "",
    lastRunContent: "",
    isRead: true,
    hasActiveRun: false,
    hasPendingAwaiting: false,
    ...overrides,
  };
}

test("assistant navigation reads global REACT chats over WebSocket and keeps displayed chat status live", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  const snapshots = [];
  const debugMessages = [];
  const temporaryAppData = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-nav-ws-"));
  const chatResponses = [[
    {
      chatId: "react-newest",
      chatName: "Newest React chat",
      agentKey: "zenmi",
      createdAt: EPOCH_MS + 30,
      updatedAt: EPOCH_MS + 40,
      lastRunId: "run-newest",
      lastRunContent: "latest response",
      read: { isRead: false },
      activeRun: false,
    },
    {
      chatId: "team-without-agent",
      chatName: "Team chat",
      agentKey: "",
      createdAt: EPOCH_MS + 20,
      updatedAt: EPOCH_MS + 21,
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      chatId: `react-${index}`,
      chatName: `React ${index}`,
      agentKey: "zenmi",
      createdAt: EPOCH_MS + index,
      updatedAt: EPOCH_MS + index,
    })),
  ], [
    {
      chatId: "react-newest",
      chatName: "Newest React chat",
      agentKey: "zenmi",
      createdAt: EPOCH_MS + 30,
      updatedAt: EPOCH_MS + 70,
      lastRunId: "run-newest",
      lastRunContent: "latest response",
      read: { isRead: false },
      awaiting: {
        awaitingId: "awaiting-1",
        mode: "approval",
        status: "awaiting",
        createdAt: EPOCH_MS + 70,
      },
    },
  ], [
    {
      chatId: "react-newest",
      chatName: "Newest React chat",
      agentKey: "zenmi",
      createdAt: EPOCH_MS + 30,
      updatedAt: EPOCH_MS + 80,
      lastRunId: "run-newest",
      lastRunContent: "latest response",
      read: { isRead: false },
    },
  ]];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }

    send(data) {
      const request = JSON.parse(data);
      this.sent.push(request);
      if (request.type === "/api/chats") {
        const response = chatResponses[Math.min(this.sent.filter((frame) => frame.type === "/api/chats").length - 1, chatResponses.length - 1)];
        queueMicrotask(() => this.onmessage?.({
          data: JSON.stringify({
            frame: "response",
            type: "/api/chats",
            id: request.id,
            code: 0,
            data: response,
          }),
        }));
      }
    }

    emit(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }

    emitClose() {
      this.onclose?.();
    }

    close() {}
  }

  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { code: 0, data: [{ key: "zenmi", name: "Zenmi", chats: [] }] };
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    fs.rmSync(temporaryAppData, { recursive: true, force: true });
  });

  const client = new AssistantNavigationStatusClient({
    app: { getPath: () => temporaryAppData },
    getServiceState: async () => ({
      status: "running",
      healthMeta: { webUrl: "http://127.0.0.1:11789" },
    }),
    issueAccessToken: async () => ({ ok: true, token: "secret-token", message: "" }),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDebug: (message) => debugMessages.push(message),
  });
  t.after(() => client.stop());

  const first = await client.refreshNow();
  const firstRequest = sockets[0].sent.find((frame) => frame.type === "/api/chats");
  assert.deepEqual(firstRequest.payload, { mode: "REACT", limit: 9 });
  assert.deepEqual(
    first.chatItems.map((chat) => chat.chatId),
    ["react-newest", "react-0", "react-1", "react-2", "react-3", "react-4", "react-5", "react-6"],
  );
  assert.equal(first.chatItems[0].isRead, false);
  assert.equal(first.chatItems[0].hasActiveRun, false);
  assert.equal(first.chatItemsHasMore, true);
  const connected = client.getLiveStatus();
  assert.equal(connected.phase, "connected");
  assert.equal(connected.source, "desktop-nav");
  assert.equal(connected.endpoint, "ws://127.0.0.1:11789/ws");
  assert.equal(typeof connected.connectedAt, "number");
  assert.equal(JSON.stringify(connected).includes("secret-token"), false);
  assert.equal(JSON.stringify(connected).includes("deviceId"), false);
  assert.equal(JSON.stringify(connected).includes("latest response"), false);
  assert.ok(connected.recentFrames.every((frame) =>
    Object.keys(frame).sort().join(",") === "at,direction,kind,type",
  ));
  assert.deepEqual(
    connected.recentFrames.map(({ direction, kind, type }) => ({ direction, kind, type })),
    [
      { direction: "connection", kind: "connecting", type: null },
      { direction: "connection", kind: "connected", type: null },
      { direction: "outbound", kind: "request", type: "/api/chats" },
      { direction: "inbound", kind: "response", type: "/api/chats" },
    ],
  );
  const mutableStatus = client.getLiveStatus();
  mutableStatus.recentFrames[0].type = "tampered";
  assert.equal(client.getLiveStatus().recentFrames[0].type, null);

  sockets[0].onmessage?.({ data: "invalid-navigation-frame" });
  assert.equal(client.getLiveStatus().recentFrames.at(-1)?.kind, "invalid");

  for (let index = 0; index < 21; index += 1) {
    sockets[0].emit({ frame: "response", type: `diagnostic-${index}` });
  }
  const boundedFrames = client.getLiveStatus().recentFrames;
  assert.equal(boundedFrames.length, 20);
  assert.deepEqual(
    boundedFrames.map((frame) => frame.type),
    Array.from({ length: 20 }, (_, index) => `diagnostic-${index + 1}`),
  );
  assert.ok(boundedFrames.every((frame) => frame.direction === "inbound" && frame.kind === "response"));

  sockets[0].emit({ frame: "push", type: "chat.updated", data: {
    chatId: "react-newest",
    lastRunId: "run-newest",
    lastRunContent: "updated from navigation push",
    updatedAt: EPOCH_MS + 50,
  }});
  assert.equal(client.getSnapshot().chatItems[0].lastRunContent, "updated from navigation push");
  assert.equal(client.getSnapshot().chatItems[0].updatedAt, EPOCH_MS + 50);
  assert.equal(debugMessages.some((message) => message.includes("time_contract_violation")), false);

  sockets[0].emit({ frame: "push", type: "run.started", data: {
    agentKey: "zenmi",
    chatId: "react-newest",
    runId: "run-newest",
    startedAt: EPOCH_MS + 60,
  }});
  assert.equal(client.getSnapshot().chatItems[0].hasActiveRun, true);

  sockets[0].emit({ frame: "push", type: "awaiting.asking", data: {
    agentKey: "zenmi",
    chatId: "react-newest",
    awaitingId: "awaiting-1",
    createdAt: EPOCH_MS + 70,
    mode: "approval",
  }});
  assert.equal(client.getSnapshot().chatItems[0].hasPendingAwaiting, true);
  assert.equal(client.getSnapshot().chatItems[0].awaitingMode, "approval");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "/api/chats").length, 2);
  assert.equal(client.getSnapshot().chatItems[0].hasPendingAwaiting, true);

  sockets[0].emit({ frame: "push", type: "awaiting.answered", data: {
    agentKey: "zenmi",
    chatId: "react-newest",
    awaitingId: "awaiting-1",
    answeredAt: EPOCH_MS + 80,
  }});
  assert.equal(client.getSnapshot().chatItems[0].hasPendingAwaiting, false);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "/api/chats").length, 3);
  assert.equal(client.getSnapshot().chatItems[0].hasPendingAwaiting, false);

  sockets[0].emit({ frame: "push", type: "awaiting.asking", data: {
    agentKey: "not-listed",
    chatId: "not-listed",
    createdAt: EPOCH_MS + 90,
    mode: "question",
  }});
  assert.equal(client.getSnapshot().chatItems.some((chat) => chat.chatId === "not-listed"), false);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "/api/chats").length, 4);
  assert.ok(snapshots.some((snapshot) => snapshot.chatItems.length === 8));

  sockets[0].emit({ frame: "push", type: "chat.created", data: {
    agentKey: "zenmi",
    chatId: "created-without-optimistic-insert",
    chatName: "Newly created chat",
    createdAt: EPOCH_MS + 100,
  }});
  assert.equal(
    client.getSnapshot().chatItems.some((chat) => chat.chatId === "created-without-optimistic-insert"),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "/api/chats").length, 5);

  sockets[0].emitClose();
  const reconnecting = client.getLiveStatus();
  assert.equal(reconnecting.phase, "reconnecting");
  assert.match(reconnecting.lastError, /WebSocket closed/);
  assert.ok(reconnecting.recentFrames.some((frame) =>
    frame.kind === "push" && frame.type === "awaiting.answered",
  ));
  assert.equal(reconnecting.recentFrames.at(-1)?.kind, "closed");
});

test("assistant navigation chat reducer updates displayed chats without checking agent mode", () => {
  const current = [createNavigationChat({ agentKey: "coder-agent", mode: "CODER" })];
  const unread = applyAssistantNavigationChatPush(current, {
    frame: "push",
    type: "chat.unread",
    data: {
      agentKey: "coder-agent",
      chatId: "chat-1",
      createdAt: EPOCH_MS + 1,
    },
  });
  assert.equal(unread.changed, true);
  assert.equal(unread.items[0].isRead, false);
  assert.equal(unread.items[0].updatedAt, EPOCH_MS + 1);

  const read = applyAssistantNavigationChatPush(unread.items, {
    frame: "push",
    type: "chat.read",
    data: {
      agentKey: "coder-agent",
      chatId: "chat-1",
      readAt: EPOCH_MS + 2,
    },
  });
  assert.equal(read.changed, true);
  assert.equal(read.items[0].isRead, true);
  assert.equal(read.items[0].updatedAt, EPOCH_MS + 2);

  const started = applyAssistantNavigationChatPush(read.items, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: "coder-agent",
      chatId: "chat-1",
      runId: "run-1",
      startedAt: EPOCH_MS + 3,
    },
  });
  assert.equal(started.changed, true);
  assert.equal(started.items[0].hasActiveRun, true);

  const asked = applyAssistantNavigationChatPush(started.items, {
    frame: "push",
    type: "awaiting.asking",
    data: {
      agentKey: "coder-agent",
      chatId: "chat-1",
      createdAt: EPOCH_MS + 4,
      mode: "question",
    },
  });
  assert.equal(asked.changed, true);
  assert.equal(asked.items[0].hasPendingAwaiting, true);
  assert.equal(asked.items[0].awaitingMode, "question");

  const completed = applyAssistantNavigationChatPush(asked.items, {
    frame: "push",
    type: "run.finished",
    data: {
      agentKey: "coder-agent",
      chatId: "chat-1",
      runId: "run-1",
      finishedAt: EPOCH_MS + 5,
    },
  });
  assert.equal(completed.changed, true);
  assert.equal(completed.items[0].hasActiveRun, false);

  const answered = applyAssistantNavigationChatPush(completed.items, {
    frame: "push",
    type: "awaiting.answered",
    data: {
      agentKey: "coder-agent",
      chatId: "chat-1",
      answeredAt: EPOCH_MS + 6,
    },
  });
  assert.equal(answered.changed, true);
  assert.equal(answered.items[0].hasPendingAwaiting, false);

  const absent = applyAssistantNavigationChatPush(answered.items, {
    frame: "push",
    type: "awaiting.asking",
    data: {
      agentKey: "other-agent",
      chatId: "not-listed",
      createdAt: EPOCH_MS + 7,
      mode: "question",
    },
  });
  assert.equal(absent.changed, false);
  assert.equal(absent.shouldRefresh, true);
  assert.deepEqual(absent.items.map((chat) => chat.chatId), ["chat-1"]);
});

test("assistant navigation live status reports WebSocket setup failures without credentials", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });
  globalThis.WebSocket = undefined;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { code: 0, data: [{ key: "zenmi", name: "Zenmi", chats: [] }] };
    },
  });

  const client = new AssistantNavigationStatusClient({
    app: { getPath: () => os.tmpdir() },
    getServiceState: async () => ({
      status: "running",
      healthMeta: { webUrl: "http://127.0.0.1:11789" },
    }),
    issueAccessToken: async () => ({ ok: true, token: "secret-token", message: "" }),
    onSnapshot: () => {},
  });
  t.after(() => client.stop());

  const result = await client.refreshNow();
  const status = client.getLiveStatus();
  assert.equal(result.ok, false);
  assert.equal(status.phase, "error");
  assert.equal(status.endpoint, "ws://127.0.0.1:11789/ws");
  assert.match(status.lastError, /WebSocket is unavailable/);
  assert.equal(JSON.stringify(status).includes("secret-token"), false);
  assert.deepEqual(status.recentFrames.map(({ direction, kind, type }) => ({ direction, kind, type })), [
    { direction: "connection", kind: "error", type: null },
  ]);
});

test("assistant navigation retains its last valid snapshot when a refreshed batch violates the time contract", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const temporaryAppData = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-nav-time-contract-"));
  let chatResponse = [createNavigationChat()];

  class FakeWebSocket {
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }

    send(data) {
      const request = JSON.parse(data);
      if (request.type === "/api/chats") {
        queueMicrotask(() => this.onmessage?.({
          data: JSON.stringify({
            frame: "response",
            type: "/api/chats",
            id: request.id,
            code: 0,
            data: chatResponse,
          }),
        }));
      }
    }

    close() {}
  }

  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { code: 0, data: [{ key: "zenmi", name: "Zenmi", chats: [] }] };
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    fs.rmSync(temporaryAppData, { recursive: true, force: true });
  });

  const client = new AssistantNavigationStatusClient({
    app: { getPath: () => temporaryAppData },
    getServiceState: async () => ({
      status: "running",
      healthMeta: { webUrl: "http://127.0.0.1:11789" },
    }),
    issueAccessToken: async () => ({ ok: true, token: "desktop-token", message: "" }),
    onSnapshot: () => {},
  });
  t.after(() => client.stop());

  const first = await client.refreshNow();
  chatResponse = [{
    ...createNavigationChat({ chatId: "invalid" }),
    updatedAt: "2026-07-13T00:00:00.000Z",
  }];

  await assert.rejects(
    client.refreshNow(),
    /time_contract_violation: navigation\.chats\[0\]\.updatedAt/u,
  );
  assert.strictEqual(client.getSnapshot(), first);
  assert.equal(client.getSnapshot().ok, true);
  assert.deepEqual(client.getSnapshot().chatItems.map((chat) => chat.chatId), ["chat-1"]);
});

test("assistant navigation chat mapper preserves server order while still filtering non-time semantic omissions", () => {
  const chats = buildAssistantNavigationChatsFromPlatform([
    { chatId: "second", agentKey: "zenmi", createdAt: EPOCH_MS + 2, updatedAt: EPOCH_MS + 2 },
    { chatId: "missing-agent", createdAt: EPOCH_MS + 1, updatedAt: EPOCH_MS + 1 },
    { chatId: "first", agentKey: "cutej", createdAt: EPOCH_MS, updatedAt: EPOCH_MS },
  ]);

  assert.deepEqual(chats.map((chat) => chat.chatId), ["second", "first"]);
});

test("assistant navigation probes the ninth eligible Chat without exposing it in the sidebar snapshot", () => {
  const snapshot = buildAssistantNavigationChatsSnapshotFromPlatform(
    Array.from({ length: 9 }, (_item, index) => ({
      chatId: `chat-${index + 1}`,
      agentKey: "zenmi",
      createdAt: EPOCH_MS + index,
      updatedAt: EPOCH_MS + index,
    })),
  );

  assert.equal(snapshot.chatItems.length, 8);
  assert.equal(snapshot.chatItemsHasMore, true);
  assert.deepEqual(
    snapshot.chatItems.map((chat) => chat.chatId),
    ["chat-1", "chat-2", "chat-3", "chat-4", "chat-5", "chat-6", "chat-7", "chat-8"],
  );
});

test("assistant navigation keeps Agent Mode separate from awaiting mode", () => {
  const chats = buildAssistantNavigationChatsFromPlatform([
    {
      chatId: "react-idle",
      agentKey: "zenmi",
      createdAt: EPOCH_MS,
      updatedAt: EPOCH_MS,
      mode: "REACT",
    },
    {
      chatId: "react-awaiting",
      agentKey: "zenmi",
      createdAt: EPOCH_MS + 1,
      updatedAt: EPOCH_MS + 1,
      mode: "REACT",
      awaiting: { mode: "question", status: "awaiting" },
    },
  ]);

  assert.equal(chats[0].hasPendingAwaiting, false);
  assert.equal(chats[0].awaitingMode, undefined);
  assert.equal(chats[1].hasPendingAwaiting, true);
  assert.equal(chats[1].awaitingMode, "question");
});

test("assistant navigation keeps approval awaitings pending when approval details are omitted", () => {
  const [agent] = buildAssistantNavigationAgentsFromPlatformAgents([{
    key: "approval-project",
    name: "Approval project",
    mode: "CODER",
    chats: [{
      chatId: "approval-summary",
      createdAt: EPOCH_MS,
      updatedAt: EPOCH_MS,
      awaiting: {
        awaitingId: "awaiting-approval",
        mode: "approval",
        status: "awaiting",
      },
    }],
  }]);

  const chat = agent.recentChats[0];
  assert.equal(agent.hasPendingAwaiting, true);
  assert.equal(chat?.hasPendingAwaiting, true);
  assert.equal(chat?.awaitingCount, 1);
  assert.equal(chat?.awaitingMode, "approval");
});

test("assistant navigation ignores completed, answered, and cancelled approval awaitings", () => {
  const chats = buildAssistantNavigationChatsFromPlatform(
    ["completed", "answered", "cancelled"].map((status, index) => ({
      chatId: `approval-${status}`,
      agentKey: "zenmi",
      createdAt: EPOCH_MS + index,
      updatedAt: EPOCH_MS + index,
      awaiting: {
        awaitingId: `awaiting-${status}`,
        mode: "approval",
        status,
      },
    })),
  );

  assert.deepEqual(
    chats.map((chat) => ({
      hasPendingAwaiting: chat.hasPendingAwaiting,
      awaitingCount: chat.awaitingCount,
    })),
    [
      { hasPendingAwaiting: false, awaitingCount: 0 },
      { hasPendingAwaiting: false, awaitingCount: 0 },
      { hasPendingAwaiting: false, awaitingCount: 0 },
    ],
  );
});

test("assistant navigation accepts zero as a valid epoch-ms value", () => {
  const [chat] = buildAssistantNavigationChatsFromPlatform([{
    chatId: "epoch-zero",
    agentKey: "zenmi",
    createdAt: 0,
    updatedAt: 0,
  }]);

  assert.equal(chat?.createdAt, 0);
  assert.equal(chat?.updatedAt, 0);
});

test("assistant navigation atomically rejects malformed chat snapshot times", () => {
  for (const value of [
    "2026-07-13T00:00:00.000Z",
    String(EPOCH_MS),
    EPOCH_MS / 1_000,
    EPOCH_MS + 0.5,
    -1,
    undefined,
  ]) {
    assert.throws(
      () => buildAssistantNavigationChatsFromPlatform([
        { chatId: "valid", agentKey: "zenmi", createdAt: EPOCH_MS, updatedAt: EPOCH_MS },
        {
          chatId: "invalid",
          agentKey: "zenmi",
          createdAt: EPOCH_MS,
          ...(value === undefined ? {} : { updatedAt: value }),
        },
      ]),
      /time_contract_violation: navigation\.chats\[1\]\.updatedAt/u,
    );
  }
});

test("assistant navigation rejects a batch with a malformed nested awaiting time", () => {
  assert.throws(
    () => buildAssistantNavigationChatsFromPlatform([
      { chatId: "valid", agentKey: "zenmi", createdAt: EPOCH_MS, updatedAt: EPOCH_MS },
      {
        chatId: "invalid-awaiting",
        agentKey: "zenmi",
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS,
        awaiting: { createdAt: "2026-07-13T00:00:00.000Z" },
      },
    ]),
    /time_contract_violation: navigation\.chats\[1\]\.awaiting\.createdAt/u,
  );
});

test("assistant navigation preserves absent optional agent times and rejects malformed present values", () => {
  const agents = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "timestamped",
      name: "Timestamped",
      updatedAt: EPOCH_MS,
      chats: [createNavigationChat({ agentKey: "timestamped", updatedAt: EPOCH_MS + 1 })],
    },
    {
      key: "without-time",
      name: "Without time",
      chats: [createNavigationChat({ agentKey: "without-time", updatedAt: EPOCH_MS + 100 })],
    },
  ]);
  assert.deepEqual(agents.map((agent) => agent.agentKey), ["timestamped", "without-time"]);
  assert.equal(Object.hasOwn(agents[1], "updatedAt"), false);

  const copilotAgents = buildAssistantCopilotAgentsFromPlatformAgents([
    { key: "copilot-without-time", name: "Without time" },
    { key: "copilot-timestamped", name: "Timestamped", updatedAt: EPOCH_MS },
  ]);
  assert.deepEqual(copilotAgents.map((agent) => agent.agentKey), ["copilot-timestamped", "copilot-without-time"]);
  assert.equal(Object.hasOwn(copilotAgents[1], "updatedAt"), false);

  for (const value of [
    "2026-07-13T00:00:00.000Z",
    String(EPOCH_MS),
    EPOCH_MS / 1_000,
    EPOCH_MS + 0.5,
    -1,
  ]) {
    assert.throws(
      () => buildAssistantNavigationAgentsFromPlatformAgents([
        { key: "invalid", name: "Invalid", updatedAt: value },
      ]),
      /time_contract_violation: navigation\.agents\[0\]\.updatedAt/u,
    );
    assert.throws(
      () => buildAssistantCopilotAgentsFromPlatformAgents([
        { key: "invalid", name: "Invalid", updatedAt: value },
      ]),
      /time_contract_violation: copilot\.agents\[0\]\.updatedAt/u,
    );
  }
});

test("assistant navigation preserves explicit null optional agent times", () => {
  const [agent] = buildAssistantNavigationAgentsFromPlatformAgents([
    { key: "null-time", name: "Null time", updatedAt: null },
  ]);
  const [copilotAgent] = buildAssistantCopilotAgentsFromPlatformAgents([
    { key: "null-time", name: "Null time", updatedAt: null },
  ]);

  assert.equal(Object.hasOwn(agent, "updatedAt"), true);
  assert.equal(agent.updatedAt, null);
  assert.equal(Object.hasOwn(copilotAgent, "updatedAt"), true);
  assert.equal(copilotAgent.updatedAt, null);
});

test("assistant copilot agents fall back to nav scope when the copilot scope is empty", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    const data = String(url).includes("scope=copilot")
      ? []
      : [{ key: "cutej", name: "小君", role: "平台总管" }];
    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data };
      },
    };
  };

  const items = await readAssistantCopilotAgentsFromPlatform("http://127.0.0.1:11789", "token");

  assert.deepEqual(requestedUrls.map((url) => new URL(url).searchParams.get("scope")), ["copilot", "nav"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].agentKey, "cutej");
});

test("assistant copilot agents keep the copilot scope when it has results", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data: [{ key: "sidekick", name: "Sidekick" }] };
      },
    };
  };

  const items = await readAssistantCopilotAgentsFromPlatform("http://127.0.0.1:11789", "token");

  assert.deepEqual(requestedUrls.map((url) => new URL(url).searchParams.get("scope")), ["copilot"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].agentKey, "sidekick");
});

test("assistant navigation activity agents include copilot-only chats for desktop pet state", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    requestedUrls.push({
      scope: parsed.searchParams.get("scope"),
      includeChats: parsed.searchParams.get("includeChats"),
    });
    const data = parsed.searchParams.get("scope") === "copilot"
      ? [{
          key: "net-yu",
          name: "网驭智能体",
          role: "网络协同",
          stats: { unreadCount: 1 },
          chats: [{
            chatId: "copilot-chat-1",
            agentKey: "net-yu",
            chatName: "网络诊断",
            lastRunContent: "已完成网络诊断",
            isRead: false,
            createdAt: EPOCH_MS,
            updatedAt: EPOCH_MS + 1,
          }],
        }]
      : [{ key: "zenmi", name: "Zenmi" }];
    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data };
      },
    };
  };

  const items = await readAssistantNavigationActivityAgentsFromPlatform("http://127.0.0.1:11789", "token");

  assert.deepEqual(requestedUrls, [
    { scope: "nav", includeChats: "50" },
    { scope: "copilot", includeChats: "50" },
  ]);
  const copilotAgent = items.find((item) => item.agentKey === "net-yu");
  assert.equal(copilotAgent?.displayName, "网驭智能体");
  assert.equal(copilotAgent?.unreadCount, 1);
  assert.equal(copilotAgent?.recentChats[0]?.chatId, "copilot-chat-1");
  assert.equal(copilotAgent?.recentChats[0]?.lastRunContent, "已完成网络诊断");
});

test("assistant navigation requests enough chat history for sidebar attention priority", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          data: [{ key: "zenmi", name: "Zenmi", chats: [] }],
        };
      },
    };
  };

  await readAssistantNavigationAgentsFromPlatform("http://127.0.0.1:11789", "token");

  assert.equal(new URL(requestedUrls[0]).searchParams.get("includeChats"), "50");
});

test("assistant navigation preserves platform modes without agent types", () => {
  const agents = buildAssistantNavigationAgentsFromPlatformAgents([
    { key: "coder", name: "代码项目", mode: "CODER" },
    { key: "kbase", name: "知识库项目", mode: "KBASE" },
    { key: "regular", name: "普通智能体", mode: "CHAT", role: "助手" },
  ]);

  assert.equal(agents.find((agent) => agent.agentKey === "coder")?.mode, "CODER");
  assert.equal(agents.find((agent) => agent.agentKey === "kbase")?.mode, "KBASE");
  assert.equal(Object.hasOwn(agents.find((agent) => agent.agentKey === "regular") ?? {}, "agentType"), false);
});

test("assistant navigation keeps nested read state for desktop sidebar history", () => {
  const [agent] = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "zenmi",
      name: "Zenmi",
      stats: { totalCount: 2 },
      chats: [
        {
          chatId: "read-object-unread",
          agentKey: "zenmi",
          chatName: "Unread from read object",
          createdAt: EPOCH_MS + 10,
          updatedAt: EPOCH_MS + 11,
          read: { isRead: false, readAt: EPOCH_MS + 12, readRunId: "run_1" },
        },
        {
          chatId: "read-object-read",
          agentKey: "zenmi",
          chatName: "Read from read object",
          createdAt: EPOCH_MS + 20,
          updatedAt: EPOCH_MS + 21,
          read: { isRead: true },
        },
      ],
    },
  ], 50);

  assert.equal(agent.unreadCount, 1);
  assert.equal(agent.unreadChatCount, 1);
  assert.equal(agent.recentChats.find((chat) => chat.chatId === "read-object-unread")?.isRead, false);
  assert.equal(agent.recentChats.find((chat) => chat.chatId === "read-object-read")?.isRead, true);
});

test("assistant navigation trusts stats unread count when present", () => {
  const [agent] = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "zenmi",
      name: "Zenmi",
      stats: { totalCount: 3, unreadCount: 3 },
      chats: [
        {
          chatId: "read-newer",
          agentKey: "zenmi",
          createdAt: EPOCH_MS + 30,
          updatedAt: EPOCH_MS + 33,
          read: { isRead: true },
        },
        {
          chatId: "unread-middle",
          agentKey: "zenmi",
          createdAt: EPOCH_MS + 31,
          updatedAt: EPOCH_MS + 32,
          read: { isRead: false },
        },
        {
          chatId: "read-older",
          agentKey: "zenmi",
          createdAt: EPOCH_MS + 30,
          updatedAt: EPOCH_MS + 31,
          read: { isRead: true },
        },
      ],
    },
  ], 50);

  assert.equal(agent.chatCount, 3);
  assert.equal(agent.recentChats.length, 3);
  assert.equal(agent.unreadCount, 3);
  assert.equal(agent.unreadChatCount, 3);
});

test("assistant navigation counts row read states when stats unread count is absent", () => {
  const [agent] = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "zenmi",
      name: "Zenmi",
      stats: { totalCount: 3 },
      chats: [
        {
          chatId: "read-newer",
          agentKey: "zenmi",
          createdAt: EPOCH_MS + 40,
          updatedAt: EPOCH_MS + 43,
          read: { isRead: true },
        },
        {
          chatId: "unread-middle",
          agentKey: "zenmi",
          createdAt: EPOCH_MS + 41,
          updatedAt: EPOCH_MS + 42,
          read: { isRead: false },
        },
        {
          chatId: "read-older",
          agentKey: "zenmi",
          createdAt: EPOCH_MS + 40,
          updatedAt: EPOCH_MS + 41,
          read: { isRead: true },
        },
      ],
    },
  ], 50);

  assert.equal(agent.chatCount, 3);
  assert.equal(agent.recentChats.length, 3);
  assert.equal(agent.unreadCount, 1);
  assert.equal(agent.unreadChatCount, 1);
});

test("assistant navigation run.started keeps a newly created chat title instead of writing Thinking", () => {
  const chatId = "fdc7af9d-31d4-4853-b2b8-de25c2a89f78";
  const created = applyAssistantNavigationPush([createAgent()], {
    frame: "push",
    type: "chat.created",
    data: {
      agentKey: "zenmi",
      chatId,
      chatName: "# Query Settings 菜单项配色",
      createdAt: 1781940164377,
    },
  });

  const started = applyAssistantNavigationPush(created.items, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: "zenmi",
      chatId,
      runId: "mqm5r2wf",
      startedAt: 1781947868278,
    },
  });

  const chat = findChat(started.items, chatId);
  assert.equal(started.changed, true);
  assert.equal(chat?.chatName, "# Query Settings 菜单项配色");
  assert.equal(chat?.lastRunContent, "");
  assert.equal(chat?.lastRunId, "mqm5r2wf");
  assert.equal(chat?.hasActiveRun, true);
});

test("assistant navigation rejects a run.started push without startedAt", () => {
  const chatId = "fresh-chat";
  const result = applyAssistantNavigationPush([createAgent()], {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: "zenmi",
      chatId,
      runId: "run-1",
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.shouldRefresh, true);
  assert.equal(findChat(result.items, chatId), undefined);
});

test("assistant navigation applies untimestamped read-all and archive pushes to known chats", () => {
  const current = [createAgent({
    unreadCount: 1,
    unreadChatCount: 1,
    chatCount: 1,
    recentChats: [createNavigationChat({ isRead: false })],
  })];
  const readAll = applyAssistantNavigationPush(current, {
    frame: "push",
    type: "chat.read_all",
    data: { agentKey: "zenmi", agentUnreadCount: 0 },
  });
  assert.equal(readAll.changed, true);
  assert.equal(findChat(readAll.items, "chat-1")?.isRead, true);

  const archived = applyAssistantNavigationPush(readAll.items, {
    frame: "push",
    type: "chat.archived",
    data: {
      agentKey: "zenmi",
      chatId: "chat-1",
    },
  });

  assert.equal(archived.changed, true);
  assert.equal(archived.shouldRefresh, true);
  assert.equal(findChat(archived.items, "chat-1"), undefined);
});

test("assistant navigation applies standard awaiting.asking project pushes with createdAt", () => {
  const createdAt = 1783938199453;
  const result = applyAssistantNavigationPush([createAgent({
    agentKey: "askUserBudget.demo",
    mode: "CODER",
  })], {
    frame: "push",
    type: "awaiting.asking",
    data: {
      agentKey: "askUserBudget.demo",
      awaitingId: "call_function_7frdxe0cb31e_1",
      chatId: "6bfee0ad-5263-41c9-9f13-4983882ff7ad",
      createdAt,
      mode: "question",
      ownerType: "agent",
      runId: "mrj2qklh",
      timeout: 600,
      viewportKey: "question",
      viewportType: "builtin",
    },
  });

  const [agent] = result.items;
  const chat = findChat(result.items, "6bfee0ad-5263-41c9-9f13-4983882ff7ad");
  assert.equal(result.changed, true);
  assert.equal(chat?.createdAt, createdAt);
  assert.equal(chat?.updatedAt, createdAt);
  assert.equal(chat?.hasPendingAwaiting, true);
  assert.equal(chat?.awaitingCount, 1);
  assert.equal(chat?.awaitingMode, "question");
  assert.equal(agent?.hasPendingAwaiting, true);
});

test("assistant navigation applies standard awaiting.answered pushes with answeredAt", () => {
  const chatId = "6bfee0ad-5263-41c9-9f13-4983882ff7ad";
  const asked = applyAssistantNavigationPush([createAgent({
    agentKey: "askUserBudget.demo",
    mode: "CODER",
  })], {
    frame: "push",
    type: "awaiting.asking",
    data: {
      agentKey: "askUserBudget.demo",
      chatId,
      createdAt: 1783938199453,
      mode: "question",
      runId: "mrj2qklh",
    },
  });
  const answeredAt = 1783938200453;
  const answered = applyAssistantNavigationPush(asked.items, {
    frame: "push",
    type: "awaiting.answered",
    data: {
      agentKey: "askUserBudget.demo",
      awaitingId: "call_function_7frdxe0cb31e_1",
      chatId,
      answeredAt,
      runId: "mrj2qklh",
    },
  });

  const [agent] = answered.items;
  const chat = findChat(answered.items, chatId);
  assert.equal(answered.changed, true);
  assert.equal(chat?.updatedAt, answeredAt);
  assert.equal(chat?.hasPendingAwaiting, false);
  assert.equal(chat?.awaitingCount, 0);
  assert.equal(chat?.awaitingMode, undefined);
  assert.equal(agent?.hasPendingAwaiting, false);
});

test("assistant navigation rejects timestamp-only awaiting.asking pushes", () => {
  const result = applyAssistantNavigationPush([createAgent({ mode: "CODER" })], {
    frame: "push",
    type: "awaiting.asking",
    data: {
      agentKey: "zenmi",
      chatId: "legacy-awaiting-asking",
      mode: "question",
      timestamp: EPOCH_MS,
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.shouldRefresh, true);
  assert.equal(findChat(result.items, "legacy-awaiting-asking"), undefined);
});

test("assistant navigation rejects timestamp-only awaiting.answered pushes", () => {
  const result = applyAssistantNavigationPush([createAgent({ mode: "CODER" })], {
    frame: "push",
    type: "awaiting.answered",
    data: {
      agentKey: "zenmi",
      chatId: "legacy-awaiting-answered",
      timestamp: EPOCH_MS,
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.shouldRefresh, true);
  assert.equal(findChat(result.items, "legacy-awaiting-answered"), undefined);
});

test("assistant navigation run.started preserves an existing real preview", () => {
  const chatId = "existing-chat";
  const result = applyAssistantNavigationPush([
    createAgent({
      chatCount: 1,
      latestChatId: chatId,
      recentChats: [{
        chatId,
        chatName: "Existing title",
        agentKey: "zenmi",
        createdAt: EPOCH_MS + 50,
        updatedAt: EPOCH_MS + 51,
        lastRunId: "old-run",
        lastRunContent: "Previous reply",
        isRead: true,
        hasActiveRun: false,
        hasPendingAwaiting: false,
      }],
    }),
  ], {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: "zenmi",
      chatId,
      runId: "new-run",
      startedAt: EPOCH_MS + 52,
    },
  });

  const chat = findChat(result.items, chatId);
  assert.equal(chat?.lastRunContent, "Previous reply");
  assert.equal(chat?.lastRunId, "new-run");
  assert.equal(chat?.hasActiveRun, true);
});

test("assistant navigation still applies real preview text from chat.updated and run.complete", () => {
  const chatId = "preview-chat";
  const started = applyAssistantNavigationPush([createAgent()], {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: "zenmi",
      chatId,
      runId: "run-1",
      startedAt: EPOCH_MS + 70,
    },
  });
  const updated = applyAssistantNavigationPush(started.items, {
    frame: "push",
    type: "chat.updated",
    data: {
      agentKey: "zenmi",
      chatId,
      chatName: "Preview title",
      lastRunContent: "Updated elsewhere",
      updatedAt: EPOCH_MS + 71,
    },
  });
  const completed = applyAssistantNavigationPush(updated.items, {
    frame: "push",
    type: "run.finished",
    data: {
      agentKey: "zenmi",
      chatId,
      runId: "run-1",
      message: "Final answer",
      finishedAt: EPOCH_MS + 72,
    },
  });

  const updatedChat = findChat(updated.items, chatId);
  const completedChat = findChat(completed.items, chatId);
  assert.equal(updatedChat?.lastRunContent, "Updated elsewhere");
  assert.equal(completedChat?.lastRunContent, "Final answer");
  assert.equal(completedChat?.hasActiveRun, false);
  assert.equal(completed.shouldRefresh, true);
});

test("assistant navigation preserves chat creation time from summaries and pushes", () => {
  const chatId = "created-at-chat";
  const [agent] = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "zenmi",
      name: "Zenmi",
      chats: [{
        chatId,
        createdAt: EPOCH_MS + 80,
        updatedAt: EPOCH_MS + 81,
      }],
    },
  ]);
  assert.equal(agent.recentChats[0]?.createdAt, EPOCH_MS + 80);

  const updated = applyAssistantNavigationPush([agent], {
    frame: "push",
    type: "chat.updated",
    data: {
      agentKey: "zenmi",
      chatId,
      updatedAt: EPOCH_MS + 82,
    },
  });
  assert.equal(findChat(updated.items, chatId)?.createdAt, EPOCH_MS + 80);

  const created = applyAssistantNavigationPush([createAgent()], {
    frame: "push",
    type: "chat.created",
    data: {
      agentKey: "zenmi",
      chatId: "new-created-at-chat",
      createdAt: EPOCH_MS + 83,
    },
  });
  assert.equal(
    findChat(created.items, "new-created-at-chat")?.createdAt,
    EPOCH_MS + 83,
  );
});

test("assistant navigation rejects supplied malformed navigation times", () => {
  const current = [createAgent({ recentChats: [createNavigationChat({ chatId: "strict-time" })] })];
  for (const updatedAt of [
    "2026-07-13T00:00:00.000Z",
    String(EPOCH_MS),
    EPOCH_MS / 1_000,
    EPOCH_MS + 0.5,
    -1,
  ]) {
    const result = applyAssistantNavigationPush(current, {
      frame: "push",
      type: "chat.updated",
      data: {
        agentKey: "zenmi",
        chatId: "strict-time",
        updatedAt,
      },
    });
    assert.equal(result.changed, false);
    assert.equal(result.shouldRefresh, true);
    assert.equal(findChat(result.items, "strict-time")?.updatedAt, EPOCH_MS);
  }
});

test("assistant navigation refreshes without replacing a chat preview when chat.updated lacks updatedAt", () => {
  const current = [createAgent({
    recentChats: [createNavigationChat({
      chatId: "missing-updated-at",
      lastRunContent: "current preview",
      updatedAt: EPOCH_MS + 10,
    })],
  })];
  const result = applyAssistantNavigationPush(current, {
    frame: "push",
    type: "chat.updated",
    data: {
      agentKey: "zenmi",
      chatId: "missing-updated-at",
      lastRunContent: "stale preview must not replace current",
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.shouldRefresh, true);
  assert.equal(findChat(result.items, "missing-updated-at")?.lastRunContent, "current preview");
  assert.equal(findChat(result.items, "missing-updated-at")?.updatedAt, EPOCH_MS + 10);
});

test("assistant navigation rejects malformed optional structured times instead of falling back", () => {
  const result = applyAssistantNavigationPush([createAgent()], {
    frame: "push",
    type: "chat.created",
    data: {
      agentKey: "zenmi",
      chatId: "invalid-created-at",
      createdAt: "2026-07-10T01:02:03.000Z",
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.shouldRefresh, true);
  assert.equal(findChat(result.items, "invalid-created-at"), undefined);
});

test("assistant navigation ignores a push with a malformed nested awaiting time", () => {
  const result = applyAssistantNavigationPush([createAgent()], {
    frame: "push",
    type: "awaiting.asking",
    data: {
      agentKey: "zenmi",
      chatId: "nested-awaiting",
      createdAt: EPOCH_MS,
      awaiting: { createdAt: "2026-07-13T00:00:00.000Z" },
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.shouldRefresh, true);
  assert.equal(findChat(result.items, "nested-awaiting"), undefined);
});

test("assistant navigation reads and caches Git branches with platform-specific commands", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-nav-git-"));
  t.after(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  const cache = new Map();
  const commands = [];
  const runCommand = async (command, args) => {
    commands.push([command, args]);
    return "feature/chat-card\n";
  };
  const macBranch = await resolveAssistantWorkspaceGitBranch(workspaceDir, {
    platform: "darwin",
    cache,
    now: () => 100,
    runCommand,
  });
  assert.equal(macBranch, "feature/chat-card");
  assert.deepEqual(commands, [["git", ["-C", workspaceDir, "branch", "--show-current"]]]);

  const cachedBranch = await resolveAssistantWorkspaceGitBranch(workspaceDir, {
    platform: "darwin",
    cache,
    now: () => 101,
    runCommand: async () => {
      throw new Error("cache miss");
    },
  });
  assert.equal(cachedBranch, "feature/chat-card");

  const windowsCommands = [];
  const windowsBranch = await resolveAssistantWorkspaceGitBranch(workspaceDir, {
    platform: "win32",
    cache: new Map(),
    runCommand: async (command, args) => {
      windowsCommands.push([command, args]);
      return "main";
    },
  });
  assert.equal(windowsBranch, "main");
  assert.equal(windowsCommands[0]?.[0], "git.exe");

  const unavailableBranch = await resolveAssistantWorkspaceGitBranch(workspaceDir, {
    cache: new Map(),
    runCommand: async () => {
      throw new Error("not a repository");
    },
  });
  assert.equal(unavailableBranch, "");
  assert.equal(await resolveAssistantWorkspaceGitBranch(path.join(workspaceDir, "missing")), "");
});

test("assistant navigation enriches both Coder and Knowledge Base project branches", async () => {
  const requestedWorkspaces = [];
  const items = await enrichNavigationAgentsWithGitBranches([
    createAgent({
      agentKey: "coder",
      mode: "CODER",
      workspaceDir: "/tmp/coder-project",
      workspaceDirExists: true,
    }),
    createAgent({
      agentKey: "kbase",
      mode: "KBASE",
      workspaceDir: "/tmp/kbase-project",
      workspaceDirExists: true,
    }),
    createAgent({
      agentKey: "chat",
      mode: "CHAT",
      workspaceDir: "/tmp/chat-agent",
      workspaceDirExists: true,
    }),
  ], async (workspaceDir) => {
    requestedWorkspaces.push(workspaceDir);
    return workspaceDir.includes("kbase") ? "docs" : "main";
  });

  assert.deepEqual(requestedWorkspaces.sort(), ["/tmp/coder-project", "/tmp/kbase-project"]);
  assert.equal(items.find((item) => item.agentKey === "coder")?.gitBranch, "main");
  assert.equal(items.find((item) => item.agentKey === "kbase")?.gitBranch, "docs");
  assert.equal(items.find((item) => item.agentKey === "chat")?.gitBranch, undefined);
});
