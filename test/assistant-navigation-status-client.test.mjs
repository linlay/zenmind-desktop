import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  AssistantNavigationStatusClient,
  applyAssistantNavigationPush,
  readAssistantCopilotAgentsFromPlatform,
  buildAssistantNavigationAgentsFromPlatformAgents,
  readAssistantNavigationAgentsFromPlatform,
  __testInternals
} = require("../dist-electron/main/copilot/core/assistant-navigation-status-client.js");

test("assistant navigation snapshot uses /api/agents includeChats and agent stats", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    return new Response(JSON.stringify({
      code: 0,
      msg: "success",
      data: [
        {
          key: "codeAssistant",
          name: "代码助手",
          role: "CLI 代码助手",
          icon: { color: "#2563eb", name: "code" },
          stats: { totalCount: 12, unreadCount: 3 },
          chats: [
            {
              chatId: "chat-old",
              chatName: "旧会话",
              agentKey: "codeAssistant",
              updatedAt: 1000,
              lastRunContent: "older",
              isRead: true
            },
            {
              chatId: "chat-new",
              chatName: "新会话",
              agentKey: "codeAssistant",
              updatedAt: 2000,
              lastRunContent: "newer reply",
              isRead: false,
              status: "awaiting"
            }
          ]
        }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const items = await readAssistantNavigationAgentsFromPlatform("http://127.0.0.1:18888", "desktop-token", 5);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/agents?includeChats=5&scope=nav");
    assert.equal(items.length, 1);
    assert.equal(items[0].agentKey, "codeAssistant");
    assert.equal(items[0].displayName, "代码助手");
    assert.equal(items[0].role, "CLI 代码助手");
    assert.deepEqual(items[0].icon, { color: "#2563eb", name: "code" });
    assert.equal(items[0].chatCount, 12);
    assert.equal(items[0].unreadCount, 3);
    assert.equal(items[0].unreadChatCount, 3);
    assert.equal(items[0].latestChatId, "chat-new");
    assert.equal(items[0].latestPreview, "newer reply");
    assert.equal(items[0].hasPendingAwaiting, true);
    assert.deepEqual(items[0].recentChats.map((chat) => chat.chatId), ["chat-new", "chat-old"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assistant copilot picker snapshot uses /api/agents scope without chats", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    return new Response(JSON.stringify({
      code: 0,
      msg: "success",
      data: [
        {
          key: "desktopAssistant",
          name: "桌面助手",
          role: "侧边助手",
          icon: { color: "#2563eb", name: "sparkles" },
          chats: [{ chatId: "should-not-be-used" }],
          stats: { totalCount: 12, unreadCount: 3 }
        }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const items = await readAssistantCopilotAgentsFromPlatform("http://127.0.0.1:18888", "desktop-token");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/agents?scope=copilot");
    assert.equal(items.length, 1);
    assert.equal(items[0].agentKey, "desktopAssistant");
    assert.equal(items[0].displayName, "桌面助手");
    assert.equal(items[0].role, "侧边助手");
    assert.deepEqual(items[0].icon, { color: "#2563eb", name: "sparkles" });
    assert.equal(items[0].chatCount, 0);
    assert.equal(items[0].unreadCount, 0);
    assert.deepEqual(items[0].recentChats, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assistant navigation snapshot flattens chats from agents only", () => {
  const items = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "zenmi",
      name: "小宅",
      stats: { totalCount: 1, unreadCount: 0 },
      chats: [
        {
          chatId: "chat-1",
          firstAgentKey: "zenmi",
          chatName: "平台状态",
          updatedAt: "2026-05-20T01:00:00.000Z",
          read: { isRead: true }
        }
      ]
    },
    { name: "缺少 key", chats: [{ chatId: "ignored" }] }
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].agentKey, "zenmi");
  assert.equal(items[0].chatCount, 1);
  assert.equal(items[0].recentChats[0].agentKey, "zenmi");
});

test("assistant navigation snapshot ignores finished awaiting payloads", () => {
  const items = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "zenmi",
      name: "小宅",
      stats: { totalCount: 1, unreadCount: 0 },
      chats: [
        {
          chatId: "chat-finished",
          chatName: "已结束等待项",
          updatedAt: 1000,
          awaiting: {
            type: "awaiting.answer",
            status: "error",
            awaitingId: "await-1"
          }
        }
      ]
    }
  ]);

  assert.equal(items[0].hasPendingAwaiting, false);
  assert.equal(items[0].recentChats[0].hasPendingAwaiting, false);
});

test("assistant navigation snapshot ignores empty approval awaitings", () => {
  const items = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "zenmi",
      name: "小宅",
      stats: { totalCount: 1, unreadCount: 0 },
      chats: [
        {
          chatId: "chat-empty-approval",
          chatName: "空审批",
          updatedAt: 1000,
          awaiting: {
            type: "awaiting.ask",
            mode: "approval",
            runId: "run-1",
            awaitingId: "await-1"
          }
        }
      ]
    }
  ]);

  assert.equal(items[0].hasPendingAwaiting, false);
  assert.equal(items[0].recentChats[0].hasPendingAwaiting, false);
});

test("assistant navigation snapshot reads compatible agent chat fields", () => {
  const items = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "alpha",
      name: "Alpha",
      stats: { totalCount: 6, unreadCount: 0 },
      recentChats: Array.from({ length: 6 }, (_value, index) => ({
        chatId: `recent-${index}`,
        chatName: `Recent ${index}`,
        updatedAt: 1000 + index
      }))
    },
    {
      key: "beta",
      name: "Beta",
      stats: { totalCount: 7, unreadCount: 0 },
      relatedChats: [
        {
          id: "related-1",
          title: "Related title",
          lastMessage: "Related preview",
          updatedAt: 2000
        }
      ]
    }
  ]);

  const alpha = items.find((item) => item.agentKey === "alpha");
  const beta = items.find((item) => item.agentKey === "beta");

  assert.ok(alpha);
  assert.equal(alpha.chatCount, 6);
  assert.equal(alpha.recentChats.length, 5);
  assert.deepEqual(alpha.recentChats.map((chat) => chat.chatId), [
    "recent-5",
    "recent-4",
    "recent-3",
    "recent-2",
    "recent-1"
  ]);

  assert.ok(beta);
  assert.equal(beta.chatCount, 7);
  assert.equal(beta.recentChats[0].chatId, "related-1");
  assert.equal(beta.recentChats[0].chatName, "Related title");
  assert.equal(beta.latestPreview, "Related preview");
});

test("assistant navigation snapshot resolves and validates workspace directories", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-nav-workspace-"));
  try {
    const missingWorkspace = path.join(workspaceRoot, "missing");
    const items = buildAssistantNavigationAgentsFromPlatformAgents([
      {
        key: "runtime-config",
        name: "Runtime Config",
        runtimeConfig: { workspaceRoot },
        stats: { totalCount: 0, unreadCount: 0 }
      },
      {
        key: "chat-agent",
        name: "Chat Agent",
        workspaceDir: "@chat",
        stats: { totalCount: 0, unreadCount: 0 }
      },
      {
        key: "missing-agent",
        name: "Missing Agent",
        workspaceRoot: missingWorkspace,
        stats: { totalCount: 0, unreadCount: 0 }
      }
    ]);

    const byKey = new Map(items.map((item) => [item.agentKey, item]));
    assert.equal(byKey.get("runtime-config")?.workspaceDir, workspaceRoot);
    assert.equal(byKey.get("runtime-config")?.workspaceDirExists, true);
    assert.equal(byKey.get("chat-agent")?.workspaceDir, "@chat");
    assert.equal(byKey.get("chat-agent")?.workspaceDirExists, false);
    assert.equal(byKey.get("missing-agent")?.workspaceDir, missingWorkspace);
    assert.equal(byKey.get("missing-agent")?.workspaceDirExists, false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("assistant navigation push reducer handles read, unread and read_all", () => {
  const baseItems = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "codeAssistant",
      name: "代码助手",
      stats: { totalCount: 2, unreadCount: 1 },
      chats: [
        { chatId: "chat-1", agentKey: "codeAssistant", updatedAt: 1000, isRead: false },
        { chatId: "chat-2", agentKey: "codeAssistant", updatedAt: 900, isRead: true }
      ]
    }
  ]);

  const readResult = applyAssistantNavigationPush(baseItems, {
    frame: "push",
    type: "chat.read",
    chatId: "chat-1",
    agentKey: "codeAssistant"
  });
  assert.equal(readResult.changed, true);
  assert.equal(readResult.items[0].unreadCount, 0);
  assert.equal(readResult.items[0].recentChats[0].isRead, true);

  const unreadResult = applyAssistantNavigationPush(readResult.items, {
    frame: "push",
    type: "chat.unread",
    chatId: "chat-2",
    agentKey: "codeAssistant",
    unreadCount: 4
  });
  assert.equal(unreadResult.items[0].unreadCount, 4);
  assert.equal(unreadResult.items[0].recentChats.find((chat) => chat.chatId === "chat-2").isRead, false);

  const readAllResult = applyAssistantNavigationPush(unreadResult.items, {
    frame: "push",
    type: "chat.read_all",
    agentKey: "codeAssistant"
  });
  assert.equal(readAllResult.items[0].unreadCount, 0);
  assert.deepEqual(readAllResult.items[0].recentChats.map((chat) => chat.isRead), [true, true]);
});

test("assistant navigation push reducer handles awaiting, run lifecycle and archive refreshes", () => {
  const baseItems = buildAssistantNavigationAgentsFromPlatformAgents([
    {
      key: "codeAssistant",
      name: "代码助手",
      stats: { totalCount: 1, unreadCount: 0 },
      chats: [
        {
          chatId: "chat-1",
          agentKey: "codeAssistant",
          chatName: "编码任务",
          updatedAt: 1000,
          lastRunContent: "ready",
          isRead: true
        }
      ]
    }
  ]);

  const started = applyAssistantNavigationPush(baseItems, {
    frame: "push",
    type: "run.started",
    chatId: "chat-1",
    agentKey: "codeAssistant",
    runId: "run-1",
    timestamp: 2000
  });
  assert.equal(started.changed, true);
  assert.equal(started.items[0].recentChats[0].lastRunId, "run-1");
  assert.equal(started.items[0].recentChats[0].hasPendingAwaiting, false);

  const awaiting = applyAssistantNavigationPush(started.items, {
    frame: "push",
    type: "awaiting.ask",
    chatId: "chat-1",
    agentKey: "codeAssistant",
    timestamp: 3000
  });
  assert.equal(awaiting.items[0].hasPendingAwaiting, true);
  assert.equal(awaiting.items[0].recentChats[0].hasPendingAwaiting, true);

  const finished = applyAssistantNavigationPush(awaiting.items, {
    frame: "push",
    type: "run.finished",
    chatId: "chat-1",
    agentKey: "codeAssistant",
    runId: "run-1",
    lastRunContent: "done",
    timestamp: 4000
  });
  assert.equal(finished.items[0].latestPreview, "done");
  assert.equal(finished.items[0].hasPendingAwaiting, false);

  const archived = applyAssistantNavigationPush(finished.items, {
    frame: "push",
    type: "chat.archived",
    chatId: "chat-1",
    agentKey: "codeAssistant"
  });
  assert.equal(archived.changed, true);
  assert.equal(archived.shouldRefresh, true);
  assert.equal(archived.items[0].chatCount, 0);
  assert.deepEqual(archived.items[0].recentChats, []);
});

test("assistant navigation push ignores heartbeat and refreshes unknown notifications", () => {
  const baseItems = buildAssistantNavigationAgentsFromPlatformAgents([
    { key: "codeAssistant", name: "代码助手", chats: [] }
  ]);

  assert.deepEqual(applyAssistantNavigationPush(baseItems, {
    frame: "push",
    type: "heartbeat"
  }), {
    items: baseItems,
    changed: false,
    shouldRefresh: false
  });

  const unknownAgent = applyAssistantNavigationPush(baseItems, {
    frame: "push",
    type: "chat.created",
    chatId: "chat-new",
    agentKey: "newAgent"
  });
  assert.equal(unknownAgent.changed, false);
  assert.equal(unknownAgent.shouldRefresh, true);

  assert.equal(__testInternals.toPushEvent({
    frame: "push",
    type: "run.finished",
    payload: { chatId: "chat-1" }
  }).type, "run.complete");
});

test("assistant navigation status client forwards normalized run push events", () => {
  const pushEvents = [];
  const client = new AssistantNavigationStatusClient({
    app: {},
    getServiceState: async () => ({ status: "stopped" }),
    issueAccessToken: async () => ({ ok: false, message: "unused" }),
    onSnapshot: () => undefined,
    onPushEvent: (event) => pushEvents.push(event)
  });

  try {
    client.handleWebSocketMessage(JSON.stringify({
      frame: "push",
      type: "run.finished",
      chatId: "chat-1",
      runId: "run-2",
      status: "idle"
    }));

    assert.deepEqual(pushEvents, [
      {
        type: "run.complete",
        chatId: "chat-1",
        runId: "run-2",
        status: "idle"
      }
    ]);
  } finally {
    client.stop();
  }
});
