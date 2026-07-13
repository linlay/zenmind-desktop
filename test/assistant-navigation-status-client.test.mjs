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
    {
      chatId: "invalid-time",
      chatName: "Invalid time",
      agentKey: "zenmi",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: EPOCH_MS + 20,
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
        mode: "question",
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
    issueAccessToken: async () => ({ ok: true, token: "token", message: "" }),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  t.after(() => client.stop());

  const first = await client.refreshNow();
  const firstRequest = sockets[0].sent.find((frame) => frame.type === "/api/chats");
  assert.deepEqual(firstRequest.payload, { agentMode: "REACT", limit: 8 });
  assert.deepEqual(
    first.chatItems.map((chat) => chat.chatId),
    ["react-newest", "react-0", "react-1", "react-2", "react-3", "react-4", "react-5", "react-6"],
  );
  assert.equal(first.chatItems[0].isRead, false);
  assert.equal(first.chatItems[0].hasActiveRun, false);
  const connected = client.getLiveStatus();
  assert.equal(connected.phase, "connected");
  assert.equal(connected.source, "desktop-nav");
  assert.equal(connected.endpoint, "ws://127.0.0.1:11789/ws");
  assert.equal(typeof connected.connectedAt, "number");
  assert.equal(JSON.stringify(connected).includes("token"), false);

  sockets[0].emit({ frame: "push", type: "run.started", data: {
    agentKey: "zenmi",
    chatId: "react-newest",
    runId: "run-newest",
    timestamp: EPOCH_MS + 60,
  }});
  assert.equal(client.getSnapshot().chatItems[0].hasActiveRun, true);

  sockets[0].emit({ frame: "push", type: "awaiting.asking", data: {
    agentKey: "zenmi",
    chatId: "react-newest",
    awaitingId: "awaiting-1",
    createdAt: EPOCH_MS + 70,
    mode: "question",
  }});
  assert.equal(client.getSnapshot().chatItems[0].hasPendingAwaiting, true);
  assert.equal(client.getSnapshot().chatItems[0].awaitingMode, "question");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "/api/chats").length, 2);
  assert.equal(client.getSnapshot().chatItems[0].hasPendingAwaiting, true);

  sockets[0].emit({ frame: "push", type: "awaiting.answered", data: {
    agentKey: "zenmi",
    chatId: "react-newest",
    awaitingId: "awaiting-1",
    resolvedAt: EPOCH_MS + 80,
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

  sockets[0].emitClose();
  assert.equal(client.getLiveStatus().phase, "reconnecting");
  assert.match(client.getLiveStatus().lastError, /WebSocket closed/);
});

test("assistant navigation chat reducer updates displayed chats without checking agent mode", () => {
  const current = [createNavigationChat({ agentKey: "coder-agent", agentMode: "CODER" })];
  const started = applyAssistantNavigationChatPush(current, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: "coder-agent",
      chatId: "chat-1",
      runId: "run-1",
      timestamp: EPOCH_MS + 1,
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
      createdAt: EPOCH_MS + 2,
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
      timestamp: EPOCH_MS + 3,
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
      resolvedAt: EPOCH_MS + 4,
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
      createdAt: EPOCH_MS + 5,
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
});

test("assistant navigation chat mapper preserves server order and rejects missing agent keys or timestamps", () => {
  const chats = buildAssistantNavigationChatsFromPlatform([
    { chatId: "second", agentKey: "zenmi", createdAt: EPOCH_MS + 2, updatedAt: EPOCH_MS + 2 },
    { chatId: "missing-agent", createdAt: EPOCH_MS + 1, updatedAt: EPOCH_MS + 1 },
    { chatId: "missing-updated-at", agentKey: "zenmi", createdAt: EPOCH_MS + 1 },
    { chatId: "first", agentKey: "cutej", createdAt: EPOCH_MS, updatedAt: EPOCH_MS },
  ]);

  assert.deepEqual(chats.map((chat) => chat.chatId), ["second", "first"]);
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
      timestamp: 1781940164377,
    },
  });

  const started = applyAssistantNavigationPush(created.items, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: "zenmi",
      chatId,
      runId: "mqm5r2wf",
      timestamp: 1781947868278,
    },
  });

  const chat = findChat(started.items, chatId);
  assert.equal(started.changed, true);
  assert.equal(chat?.chatName, "# Query Settings 菜单项配色");
  assert.equal(chat?.lastRunContent, "");
  assert.equal(chat?.lastRunId, "mqm5r2wf");
  assert.equal(chat?.hasActiveRun, true);
});

test("assistant navigation rejects a run.started push without an epoch-ms timestamp", () => {
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

test("assistant navigation applies standard awaiting.answered pushes with resolvedAt", () => {
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
  const resolvedAt = 1783938200453;
  const answered = applyAssistantNavigationPush(asked.items, {
    frame: "push",
    type: "awaiting.answered",
    data: {
      agentKey: "askUserBudget.demo",
      awaitingId: "call_function_7frdxe0cb31e_1",
      chatId,
      resolvedAt,
      runId: "mrj2qklh",
    },
  });

  const [agent] = answered.items;
  const chat = findChat(answered.items, chatId);
  assert.equal(answered.changed, true);
  assert.equal(chat?.updatedAt, resolvedAt);
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
      timestamp: EPOCH_MS + 52,
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
      timestamp: EPOCH_MS + 70,
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
      timestamp: EPOCH_MS + 71,
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
      timestamp: EPOCH_MS + 72,
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
      timestamp: EPOCH_MS + 82,
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
      timestamp: EPOCH_MS + 84,
    },
  });
  assert.equal(
    findChat(created.items, "new-created-at-chat")?.createdAt,
    EPOCH_MS + 83,
  );
});

test("assistant navigation rejects string, seconds, fractional, and zero push timestamps", () => {
  const current = [createAgent()];
  for (const timestamp of [String(EPOCH_MS), Math.floor(EPOCH_MS / 1000), EPOCH_MS + 0.5, 0]) {
    const result = applyAssistantNavigationPush(current, {
      frame: "push",
      type: "chat.updated",
      data: { agentKey: "zenmi", chatId: "strict-time", timestamp },
    });
    assert.equal(result.changed, false);
    assert.equal(result.shouldRefresh, true);
    assert.equal(findChat(result.items, "strict-time"), undefined);
  }
});

test("assistant navigation rejects malformed optional structured times instead of falling back", () => {
  const result = applyAssistantNavigationPush([createAgent()], {
    frame: "push",
    type: "chat.created",
    data: {
      agentKey: "zenmi",
      chatId: "invalid-created-at",
      timestamp: EPOCH_MS,
      createdAt: "2026-07-10T01:02:03.000Z",
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.shouldRefresh, true);
  assert.equal(findChat(result.items, "invalid-created-at"), undefined);
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
