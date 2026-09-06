import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  summarizeAssistantNavigationAttention,
} = require("../dist-electron/shared/assistant-navigation-attention.js");
const {
  createDesktopPetState,
} = require("../dist-electron/main/modules/pet/desktop-pet.js");

function createAgent(agentKey, mode, unreadCount, hasPendingAwaiting = false) {
  return {
    agentKey,
    displayName: agentKey,
    role: "",
    unreadCount,
    unreadChatCount: unreadCount,
    chatCount: 0,
    hasPendingAwaiting,
    latestChatId: null,
    latestPreview: "",
    recentChats: [],
    mode,
  };
}

function createChat(chatId, isRead, hasPendingAwaiting = false) {
  return {
    chatId,
    chatName: chatId,
    agentKey: "chat-agent",
    createdAt: 1,
    updatedAt: 1,
    lastRunId: "",
    lastRunContent: "",
    isRead,
    readRunId: "",
    hasActiveRun: false,
    hasPendingAwaiting,
  };
}

test("navigation attention aggregates Chats and visible Projects with one contract", () => {
  const summary = summarizeAssistantNavigationAttention({
    items: [
      createAgent("coder", "CODER", 4, true),
      createAgent("knowledge", "KBASE", 2),
      createAgent("chat-agent", "GENERAL", 100, true),
      createAgent("desktopAssistant", "CODER", 9, true),
    ],
    chatItems: [
      createChat("chat-1", false, true),
      createChat("chat-2", false),
      createChat("chat-3", true, true),
    ],
  });

  assert.deepEqual(summary, {
    chats: { unreadCount: 2, pendingCount: 2 },
    projects: { unreadCount: 6, pendingCount: 1 },
    total: { unreadCount: 8, pendingCount: 3 },
  });
});

test("desktop pet unread state is authoritative from navigation attention", () => {
  const navigationAttention = {
    chats: { unreadCount: 2, pendingCount: 1 },
    projects: { unreadCount: 4, pendingCount: 2 },
    total: { unreadCount: 6, pendingCount: 3 },
  };
  const state = createDesktopPetState({
    enabled: true,
    unreadCount: 99,
    boundAgentKey: "coder",
    appearanceId: "classic",
  }, {
    navigationAttention,
    agentStatus: {
      agentKey: "coder",
      displayName: "Coder",
      role: "",
      presence: "available",
      unreadCount: 88,
      latestPreview: "",
      chatId: null,
      hasPendingAwaiting: false,
      stale: false,
    },
  });

  assert.equal(state.unreadCount, 6);
  assert.deepEqual(state.navigationAttention, navigationAttention);
});

test("navigation attention uses the same activity projection rendered by Projects", () => {
  const summary = summarizeAssistantNavigationAttention({
    items: [createAgent("coder", "CODER", 1)],
    activityItems: [createAgent("coder", "CODER", 5, true)],
    chatItems: [],
  });

  assert.deepEqual(summary.projects, {
    unreadCount: 5,
    pendingCount: 1,
  });
});
