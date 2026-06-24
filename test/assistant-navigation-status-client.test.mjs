import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  applyAssistantNavigationPush,
  readAssistantNavigationActivityAgentsFromPlatform,
  readAssistantCopilotAgentsFromPlatform,
} = require("../dist-electron/main/assistant/core/assistant-navigation-status-client.js");

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
    updatedAt: "2026-06-20T00:00:00.000Z",
    recentChats: [],
    ...overrides,
  };
}

function findChat(items, chatId) {
  return items.flatMap((agent) => agent.recentChats).find((chat) => chat.chatId === chatId);
}

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
            updatedAt: "2026-06-24T12:00:00.000Z",
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
    { scope: "nav", includeChats: "5" },
    { scope: "copilot", includeChats: "5" },
  ]);
  const copilotAgent = items.find((item) => item.agentKey === "net-yu");
  assert.equal(copilotAgent?.displayName, "网驭智能体");
  assert.equal(copilotAgent?.unreadCount, 1);
  assert.equal(copilotAgent?.recentChats[0]?.chatId, "copilot-chat-1");
  assert.equal(copilotAgent?.recentChats[0]?.lastRunContent, "已完成网络诊断");
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

test("assistant navigation run.started without content does not synthesize a preview", () => {
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

  const chat = findChat(result.items, chatId);
  assert.equal(result.changed, true);
  assert.equal(chat?.hasActiveRun, true);
  assert.equal(chat?.lastRunId, "run-1");
  assert.equal(chat?.lastRunContent, "");
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
        updatedAt: "2026-06-20T01:00:00.000Z",
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
    },
  });

  const updatedChat = findChat(updated.items, chatId);
  const completedChat = findChat(completed.items, chatId);
  assert.equal(updatedChat?.lastRunContent, "Updated elsewhere");
  assert.equal(completedChat?.lastRunContent, "Final answer");
  assert.equal(completedChat?.hasActiveRun, false);
});
