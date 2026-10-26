import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  collectAssistantNavigationUnreadChats,
  collectAssistantNavigationPendingChats,
  collectAssistantNavigationOverviewChats,
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
    chatCount: hasPendingAwaiting ? 1 : 0,
    hasPendingAwaiting,
    latestChatId: null,
    latestPreview: "",
    recentChats: hasPendingAwaiting ? [{
      ...createChat(`${agentKey}-awaiting`, true, true), agentKey,
    }] : [],
    mode,
    workspaceDir: ["CODER", "KBASE"].includes(mode) ? "/projects/demo" : undefined,
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
    chats: { unreadCount: 2, pendingCount: 3 },
    projects: { unreadCount: 6, pendingCount: 1 },
    total: { unreadCount: 8, pendingCount: 4 },
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


test("navigation attention includes ordinary pins without double-counting project pins", () => {
  const visible = createChat("visible", false, true);
  const summary = summarizeAssistantNavigationAttention({
    items: [createAgent("coder", "CODER", 2, true)],
    chatItems: [visible],
    pinnedChatItems: [
      { ...createChat("ordinary-pin", false, true), pinned: true },
      { ...createChat("project-pin", false, true), agentKey: "coder", pinned: true },
      visible,
    ],
  });
  assert.deepEqual(summary, {
    chats: { unreadCount: 1, pendingCount: 2 },
    projects: { unreadCount: 2, pendingCount: 2 },
    total: { unreadCount: 4, pendingCount: 4 },
  });
});

test("project attention follows workspace presence rather than mode", () => {
  const result = summarizeAssistantNavigationAttention({ items: [
    { ...createAgent("workspace-react", "REACT", 4, true), workspaceDir: "C:\\projects\\demo", workspaceDirExists: false },
    { ...createAgent("no-workspace-coder", "CODER", 9, true), workspaceDir: "  " },
    { ...createAgent("desktopAssistant", "REACT", 9, true), workspaceDir: "/hidden" },
  ] });
  assert.deepEqual(result.projects, { unreadCount: 4, pendingCount: 1 });
});

test("navigation unread identities match Chats, complete Projects and pins without adding ordinary activity", () => {
  const projectChats = Array.from({ length: 65 }, (_, index) => ({
    ...createChat(`project-${index}`, false),
    agentKey: "coder",
    pinned: index === 0,
  }));
  const readAwaiting = { ...createChat("project-read-awaiting", true, true), agentKey: "coder" };
  const visibleChat = createChat("visible", false);
  const ordinaryPin = { ...createChat("ordinary-pin", false), pinned: true };
  const project = {
    ...createAgent("coder", "CODER", projectChats.length, true),
    recentChats: projectChats.slice(0, 50),
    attentionChats: [...projectChats, readAwaiting],
  };
  const ordinaryActivity = {
    ...createAgent("chat-agent", "GENERAL", 1),
    recentChats: [createChat("activity-outside-Chats", false)],
  };
  const hiddenProject = {
    ...createAgent("desktopAssistant", "CODER", 1),
    attentionChats: [{ ...createChat("hidden-project", false), agentKey: "desktopAssistant" }],
  };
  const snapshot = {
    items: [project, ordinaryActivity, hiddenProject],
    activityItems: [project, ordinaryActivity, hiddenProject],
    chatItems: [visibleChat, createChat("visible-read-awaiting", true, true)],
    pinnedChatItems: [projectChats[0], ordinaryPin, visibleChat],
  };

  const unread = collectAssistantNavigationUnreadChats(snapshot);
  const expectedIds = [visibleChat.chatId, ...projectChats.map((chat) => chat.chatId), ordinaryPin.chatId];
  assert.deepEqual(unread.map((chat) => chat.chatId).sort(), expectedIds.sort());
  assert.equal(new Set(unread.map((chat) => chat.chatId)).size, unread.length);
  assert.equal(unread.length, summarizeAssistantNavigationAttention(snapshot).total.unreadCount);
  assert.equal(unread.length, 67);
  assert.equal(unread.some((chat) => chat.isRead), false);
});

test("navigation unread identities retain the project recent-chat fallback when complete history is absent", () => {
  const projectChat = { ...createChat("project-unread", false), agentKey: "coder" };
  const snapshot = {
    items: [{ ...createAgent("coder", "CODER", 1), recentChats: [projectChat] }],
    chatItems: [],
    pinnedChatItems: [projectChat],
  };

  assert.deepEqual(collectAssistantNavigationUnreadChats(snapshot).map((chat) => chat.chatId), ["project-unread"]);
  assert.equal(collectAssistantNavigationUnreadChats(snapshot).length, summarizeAssistantNavigationAttention(snapshot).total.unreadCount);
});

test("pending and overview count waiting Chats across complete baselines including pins and old ordinary history", () => {
  const projectChats = [
    { ...createChat("project-read-waiting", true, true), agentKey: "coder", awaitingCount: 7 },
    { ...createChat("project-unread-waiting", false, true), agentKey: "coder" },
    { ...createChat("project-pin-waiting", true, true), agentKey: "coder", pinned: true },
  ];
  const ordinaryChats = Array.from({ length: 65 }, (_, index) => ({
    ...createChat(`ordinary-${index}`, index !== 64, index === 64),
    awaitingCount: index === 64 ? 5 : 0,
  }));
  const ordinaryPin = { ...createChat("ordinary-pin-waiting", true, true), pinned: true };
  const visible = createChat("visible-unread", false);
  const snapshot = {
    items: [],
    activityItems: [
      { ...createAgent("coder", "CODER", 1), attentionChats: projectChats, recentChats: [] },
      { ...createAgent("chat-agent", "GENERAL", 2), attentionChats: [...ordinaryChats, ordinaryPin, visible], recentChats: ordinaryChats.slice(0, 50) },
    ],
    chatItems: [visible, ordinaryChats[0]],
    pinnedChatItems: [projectChats[2], ordinaryPin, ordinaryPin],
  };

  const pending = collectAssistantNavigationPendingChats(snapshot);
  assert.deepEqual(pending.map((chat) => chat.chatId).sort(), [
    "ordinary-64", "ordinary-pin-waiting", "project-pin-waiting", "project-read-waiting", "project-unread-waiting",
  ]);
  const summary = summarizeAssistantNavigationAttention(snapshot);
  assert.deepEqual(summary.projects, { unreadCount: 1, pendingCount: 3 });
  assert.deepEqual(summary.chats, { unreadCount: 1, pendingCount: 2 });
  assert.deepEqual(summary.total, { unreadCount: 2, pendingCount: 5 });

  const overview = collectAssistantNavigationOverviewChats(snapshot);
  assert.equal(overview.length, 6);
  assert.equal(new Set(overview.map((chat) => chat.chatId)).size, overview.length);
  assert.deepEqual(overview.filter((chat) => !chat.isRead).map((chat) => chat.chatId).sort(),
    collectAssistantNavigationUnreadChats(snapshot).map((chat) => chat.chatId).sort());
  assert.equal(overview.find((chat) => chat.chatId === "ordinary-64").isRead, true,
    "ordinary waiting outside the unread window belongs to pending without adding a blue unread dot");
  assert.equal(ordinaryChats[64].isRead, false, "overview projection must not mutate the authoritative baseline");
});

test("the complete waiting baseline overrides stale sidebar and pin copies of an answered Chat", () => {
  const answered = createChat("answered", true);
  const staleWaiting = { ...answered, hasPendingAwaiting: true, awaitingCount: 3 };
  const snapshot = {
    activityItems: [{ ...createAgent("chat-agent", "GENERAL", 0), attentionChats: [answered], recentChats: [staleWaiting] }],
    chatItems: [staleWaiting], pinnedChatItems: [{ ...staleWaiting, pinned: true }],
  };

  assert.deepEqual(collectAssistantNavigationPendingChats(snapshot), []);
  assert.deepEqual(collectAssistantNavigationOverviewChats(snapshot), []);
  assert.equal(summarizeAssistantNavigationAttention(snapshot).total.pendingCount, 0);
});

test("an answered complete Chat stays ordinary unread when its sidebar summary still says awaiting", () => {
  const answered = { ...createChat("answered-unread", true), chatName: "Resolved conversation" };
  const staleUnreadWaiting = { ...answered, chatName: "Old waiting title", isRead: false, hasPendingAwaiting: true, awaitingCount: 1 };
  const snapshot = {
    activityItems: [{ ...createAgent("chat-agent", "GENERAL", 0), attentionChats: [answered], recentChats: [staleUnreadWaiting] }],
    chatItems: [staleUnreadWaiting], pinnedChatItems: [],
  };

  const summary = summarizeAssistantNavigationAttention(snapshot);
  const overview = collectAssistantNavigationOverviewChats(snapshot);
  assert.deepEqual(summary.total, { unreadCount: 1, pendingCount: 0 });
  assert.equal(overview.length, 1);
  assert.equal(overview[0].isRead, false, "the existing unread scope still owns the blue dot");
  assert.equal(overview[0].hasPendingAwaiting, false, "stale unread metadata must not restore the waiting card");
  assert.equal(overview[0].chatName, "Resolved conversation");
  assert.equal(overview.filter((chat) => chat.hasPendingAwaiting).length, summary.total.pendingCount);
});
