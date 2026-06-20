import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  applyAssistantNavigationPush,
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
