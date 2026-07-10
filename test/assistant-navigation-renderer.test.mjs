import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = process.cwd();

function loadAssistantNavigationModule() {
  const sourcePath = path.join(projectRoot, "src", "renderer", "assistantNavigation.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });
  const mod = { exports: {} };
  const fn = new Function("exports", "require", "module", "__filename", "__dirname", outputText);
  fn(mod.exports, require, mod, sourcePath, path.dirname(sourcePath));
  return mod.exports;
}

const {
  getAssistantNavAgentAttentionChat,
  getAssistantNavAgentPreviewChats,
  getAssistantNavRecentChatsOverview,
  normalizeAssistantNavAgents,
} = loadAssistantNavigationModule();

function chat(overrides) {
  return {
    chatId: "chat",
    chatName: "",
    agentKey: "zenmi",
    createdAt: "",
    updatedAt: "",
    lastRunId: "",
    lastRunContent: "",
    isRead: true,
    hasActiveRun: false,
    hasPendingAwaiting: false,
    ...overrides,
  };
}

test("assistant nav preview matches webclient updatedAt ordering", () => {
  const agent = {
    recentChats: [
      chat({ chatId: "normal-2319-a", updatedAt: "1782700663959", isRead: true }),
      chat({ chatId: "normal-2320", updatedAt: "1782700667378", isRead: true }),
      chat({ chatId: "normal-2319-b", updatedAt: "1782700663000", isRead: true }),
      chat({ chatId: "await-older", updatedAt: "1782700660000", hasPendingAwaiting: true }),
      chat({ chatId: "await-newer", updatedAt: "1782700668000", hasPendingAwaiting: true }),
    ],
  };

  assert.deepEqual(
    getAssistantNavAgentPreviewChats(agent).map((item) => item.chatId),
    [
      "await-newer",
      "normal-2320",
      "normal-2319-a",
      "normal-2319-b",
      "await-older",
    ],
  );
});

test("assistant nav preview caps visible awaiting rows at five", () => {
  const agent = {
    recentChats: Array.from({ length: 6 }, (_item, index) =>
      chat({ chatId: `await-${index + 1}`, hasPendingAwaiting: true }),
    ),
  };

  assert.deepEqual(
    getAssistantNavAgentPreviewChats(agent).map((item) => item.chatId),
    ["await-1", "await-2", "await-3", "await-4", "await-5"],
  );
});

test("assistant nav Chats overview merges agents, preserves ownership, and caps recent rows", () => {
  const overview = getAssistantNavRecentChatsOverview([
    {
      agentKey: "alpha",
      displayName: "Alpha",
      recentChats: [
        chat({ chatId: "alpha-older", agentKey: "", updatedAt: "100" }),
        chat({ chatId: "shared", agentKey: "", updatedAt: "300", lastRunContent: "latest" }),
      ],
    },
    {
      agentKey: "beta",
      displayName: "Beta",
      recentChats: [
        chat({ chatId: "beta-newest", agentKey: "beta", updatedAt: "400" }),
        chat({ chatId: "shared", agentKey: "beta", updatedAt: "200" }),
      ],
    },
  ], 2);

  assert.deepEqual(
    overview.map((item) => [item.chat.chatId, item.agent.displayName, item.chat.agentKey]),
    [
      ["beta-newest", "Beta", "beta"],
      ["shared", "Alpha", "alpha"],
    ],
  );
});

test("assistant nav Chats overview shows ten most recent chats by default", () => {
  const overview = getAssistantNavRecentChatsOverview([
    {
      agentKey: "alpha",
      displayName: "Alpha",
      recentChats: Array.from({ length: 12 }, (_item, index) =>
        chat({
          chatId: `alpha-${index + 1}`,
          updatedAt: String(index + 1),
        }),
      ),
    },
  ]);

  assert.equal(overview.length, 10);
  assert.deepEqual(
    overview.map((item) => item.chat.chatId),
    [
      "alpha-12",
      "alpha-11",
      "alpha-10",
      "alpha-9",
      "alpha-8",
      "alpha-7",
      "alpha-6",
      "alpha-5",
      "alpha-4",
      "alpha-3",
    ],
  );
});

test("assistant nav attention matches webclient worker selection", () => {
  assert.equal(
    getAssistantNavAgentAttentionChat({
      recentChats: [
        chat({ chatId: "latest-unread", updatedAt: "300", isRead: false }),
        chat({ chatId: "older-running", updatedAt: "100", hasActiveRun: true }),
      ],
    })?.chatId,
    "older-running",
  );

  assert.equal(
    getAssistantNavAgentAttentionChat({
      recentChats: [
        chat({ chatId: "latest-unread", updatedAt: "300", isRead: false }),
        chat({ chatId: "older-awaiting", updatedAt: "100", hasPendingAwaiting: true }),
      ],
    })?.chatId,
    "latest-unread",
  );
});

test("assistant nav attention only opens unread when the latest row is unread", () => {
  const agent = {
    recentChats: [
      chat({ chatId: "older-unread", updatedAt: "100", isRead: false }),
      chat({ chatId: "newest-read", updatedAt: "300", isRead: true }),
      chat({ chatId: "newer-unread", updatedAt: "200", isRead: false }),
    ],
  };

  assert.deepEqual(
    getAssistantNavAgentPreviewChats(agent, 3).map((item) => item.chatId),
    ["newest-read", "newer-unread", "older-unread"],
  );
  assert.equal(getAssistantNavAgentAttentionChat(agent), null);

  assert.equal(
    getAssistantNavAgentAttentionChat({
      recentChats: [
        chat({ chatId: "latest-unread", updatedAt: "300", isRead: false }),
        chat({ chatId: "older-read", updatedAt: "200", isRead: true }),
      ],
    })?.chatId,
    "latest-unread",
  );
});

test("assistant nav preview does not move older awaiting or unread rows ahead of newer rows", () => {
  const agent = {
    recentChats: [
      chat({ chatId: "read-700", updatedAt: "700", isRead: true }),
      chat({ chatId: "await-650", updatedAt: "650", isRead: true, hasPendingAwaiting: true }),
      chat({ chatId: "read-600", updatedAt: "600", isRead: true }),
      chat({ chatId: "read-500", updatedAt: "500", isRead: true }),
      chat({ chatId: "read-400", updatedAt: "400", isRead: true }),
      chat({ chatId: "read-300", updatedAt: "300", isRead: true }),
      chat({ chatId: "unread-350", updatedAt: "350", isRead: false }),
      chat({ chatId: "unread-250", updatedAt: "250", isRead: false }),
      chat({ chatId: "unread-200", updatedAt: "200", isRead: false }),
    ],
  };

  assert.deepEqual(
    getAssistantNavAgentPreviewChats(agent).map((item) => [
      item.chatId,
      item.isRead,
    ]),
    [
      ["read-700", true],
      ["await-650", true],
      ["read-600", true],
      ["read-500", true],
      ["read-400", true],
    ],
  );
  assert.equal(getAssistantNavAgentAttentionChat(agent), null);
});

test("assistant nav keeps numeric updatedAt values sortable and visible", () => {
  const [agent] = normalizeAssistantNavAgents([
    {
      agentKey: "zenmi",
      displayName: "Zenmi",
      recentChats: [
        { chatId: "read-100", updatedAt: 100, isRead: true },
        { chatId: "unread-300", updatedAt: 300, read: { isRead: false } },
        { chatId: "read-200", updatedAt: 200, isRead: true },
      ],
    },
  ]);

  assert.equal(agent.recentChats[1].updatedAt, "300");
  assert.deepEqual(
    getAssistantNavAgentPreviewChats(agent, 3).map((item) => [
      item.chatId,
      item.isRead,
    ]),
    [
      ["unread-300", false],
      ["read-200", true],
      ["read-100", true],
    ],
  );
  assert.equal(getAssistantNavAgentAttentionChat(agent)?.chatId, "unread-300");
});

test("assistant nav sorts ISO updatedAt values by actual time", () => {
  const agent = {
    recentChats: [
      chat({
        chatId: "iso-newer",
        updatedAt: "2026-06-29T07:50:00.000Z",
        isRead: true,
      }),
      chat({
        chatId: "iso-older",
        updatedAt: "2026-06-29T07:29:00.000Z",
        isRead: true,
      }),
      chat({
        chatId: "iso-middle",
        updatedAt: "2026-06-29T07:45:00.000Z",
        isRead: true,
      }),
    ],
  };

  assert.deepEqual(
    getAssistantNavAgentPreviewChats(agent, 3).map((item) => item.chatId),
    ["iso-newer", "iso-middle", "iso-older"],
  );
});

test("assistant nav normalization preserves nested read state", () => {
  const [agent] = normalizeAssistantNavAgents([
    {
      agentKey: "zenmi",
      displayName: "Zenmi",
      recentChats: [
        {
          chatId: "read-object-unread",
          read: { isRead: false },
        },
      ],
    },
  ]);

  assert.equal(agent.recentChats[0].isRead, false);
  assert.equal(agent.unreadCount, 1);
  assert.equal(agent.unreadChatCount, 1);
});

test("assistant nav normalization trusts stats unread counts like webclient", () => {
  const [agent] = normalizeAssistantNavAgents([
    {
      agentKey: "zenmi",
      displayName: "Zenmi",
      chatCount: 3,
      unreadCount: 3,
      unreadChatCount: 3,
      recentChats: [
        { chatId: "read-newer", updatedAt: 300, read: { isRead: true } },
        { chatId: "unread-middle", updatedAt: 200, read: { isRead: false } },
        { chatId: "read-older", updatedAt: 100, read: { isRead: true } },
      ],
    },
  ]);

  assert.equal(agent.unreadCount, 3);
  assert.equal(agent.unreadChatCount, 3);
});

test("assistant nav normalization falls back to row read states when stats are absent", () => {
  const [agent] = normalizeAssistantNavAgents([
    {
      agentKey: "zenmi",
      displayName: "Zenmi",
      recentChats: [
        { chatId: "read-newer", updatedAt: 300, read: { isRead: true } },
        { chatId: "unread-middle", updatedAt: 200, read: { isRead: false } },
        { chatId: "read-older", updatedAt: 100, read: { isRead: true } },
      ],
    },
  ]);

  assert.equal(agent.unreadCount, 1);
  assert.equal(agent.unreadChatCount, 1);
});

test("assistant nav keeps chat hover metadata when building the Chats overview", () => {
  const [agent] = normalizeAssistantNavAgents([
    {
      agentKey: "coder",
      displayName: "Coder",
      mode: "CODER",
      workspaceDir: "/Users/demo/Project/zenmind-desktop",
      workspaceDirExists: true,
      gitBranch: "feature/chat-card",
      recentChats: [{
        chatId: "chat-card",
        chatName: "Design the chat card",
        createdAt: "2026-07-10T01:02:03.000Z",
        updatedAt: "2026-07-10T02:03:04.000Z",
      }],
    },
  ]);
  const [overview] = getAssistantNavRecentChatsOverview([agent]);

  assert.equal(overview.chat.createdAt, "2026-07-10T01:02:03.000Z");
  assert.equal(overview.agent.workspaceDir, "/Users/demo/Project/zenmind-desktop");
  assert.equal(overview.agent.workspaceDirExists, true);
  assert.equal(overview.agent.gitBranch, "feature/chat-card");
});
