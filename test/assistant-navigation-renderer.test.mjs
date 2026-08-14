import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = process.cwd();
const EPOCH_MILLIS_MIN = 0;
const EPOCH_MILLIS_MAX = 8_640_000_000_000_000;
const TEST_EPOCH_MILLIS = 1_700_000_000_000;

function epoch(offset = 0) {
  return TEST_EPOCH_MILLIS + offset;
}

function readEpochMillis(value) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= EPOCH_MILLIS_MIN &&
    value <= EPOCH_MILLIS_MAX
    ? value
    : undefined;
}

function requireAgentPlatformEpochMillis(value, field) {
  const epochMillis = readEpochMillis(value);
  if (epochMillis === undefined || (epochMillis !== 0 && epochMillis < 1_000_000_000_000)) {
    throw new TypeError(`invalid agent-platform epoch milliseconds: ${field}`);
  }
  return epochMillis;
}

function parseOptionalNullableAgentPlatformEpochMillis(value, field) {
  if (value === undefined || value === null) {
    return value;
  }
  return requireAgentPlatformEpochMillis(value, field);
}

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
  fn(mod.exports, (specifier) => {
    if (specifier === "../shared/time-contract") {
      return {
        readEpochMillis,
        requireAgentPlatformEpochMillis,
        parseOptionalNullableAgentPlatformEpochMillis,
      };
    }
    return require(specifier);
  }, mod, sourcePath, path.dirname(sourcePath));
  return mod.exports;
}

const {
  getAssistantAwaitingStatusKey,
  getAssistantNavAgentAttentionChat,
  getAssistantNavAgentPreviewChats,
  getAssistantNavRecentChatsOverview,
  isAssistantNavChatAgent,
  isAssistantNavProjectAgent,
  normalizeAssistantNavAgents,
  normalizeAssistantNavAgentItemsResult,
  resolveAssistantNavChatRuntimeAgent,
} = loadAssistantNavigationModule();

test("assistant nav maps awaiting modes to the shared chat status labels", () => {
  assert.equal(getAssistantAwaitingStatusKey("question"), "sidebar.assistants.awaitingStatus.question");
  assert.equal(getAssistantAwaitingStatusKey("planning"), "sidebar.assistants.awaitingStatus.planning");
  assert.equal(getAssistantAwaitingStatusKey("form"), "sidebar.assistants.awaitingStatus.form");
  assert.equal(getAssistantAwaitingStatusKey("approval"), "sidebar.assistants.awaitingStatus.approval");
  assert.equal(getAssistantAwaitingStatusKey(), "kanban.run.awaitingApproval");
});

test("assistant nav normalizes missing Chats overflow metadata to false", () => {
  const baseResult = {
    ok: true,
    items: [],
    chatItems: [],
    message: "ok",
    updatedAt: TEST_EPOCH_MILLIS,
  };

  assert.equal(
    normalizeAssistantNavAgentItemsResult(baseResult).chatItemsHasMore,
    false,
  );
  assert.equal(
    normalizeAssistantNavAgentItemsResult({
      ...baseResult,
      chatItemsHasMore: true,
    }).chatItemsHasMore,
    true,
  );
});

function chat(overrides) {
  return {
    chatId: "chat",
    chatName: "",
    agentKey: "zenmi",
    createdAt: TEST_EPOCH_MILLIS,
    updatedAt: TEST_EPOCH_MILLIS,
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
      chat({ chatId: "normal-2319-a", updatedAt: 1782700663959, isRead: true }),
      chat({ chatId: "normal-2320", updatedAt: 1782700667378, isRead: true }),
      chat({ chatId: "normal-2319-b", updatedAt: 1782700663000, isRead: true }),
      chat({ chatId: "await-older", updatedAt: 1782700660000, hasPendingAwaiting: true }),
      chat({ chatId: "await-newer", updatedAt: 1782700668000, hasPendingAwaiting: true }),
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

test("assistant nav preserves a missing optional agent updatedAt instead of deriving it from chats", () => {
  const [agent] = normalizeAssistantNavAgents([{
    agentKey: "coder",
    displayName: "Coder",
    role: "",
    unreadCount: 0,
    unreadChatCount: 0,
    chatCount: 1,
    hasPendingAwaiting: false,
    latestChatId: "chat-1",
    latestPreview: "",
    recentChats: [chat({ chatId: "chat-1", updatedAt: epoch(50) })],
  }]);

  assert.equal(agent?.updatedAt, undefined);
  assert.equal(agent?.recentChats[0]?.updatedAt, epoch(50));
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
        chat({ chatId: "alpha-older", agentKey: "", updatedAt: epoch(100) }),
        chat({ chatId: "shared", agentKey: "", updatedAt: epoch(300), lastRunContent: "latest" }),
      ],
    },
    {
      agentKey: "beta",
      displayName: "Beta",
      recentChats: [
        chat({ chatId: "beta-newest", agentKey: "beta", updatedAt: epoch(400) }),
        chat({ chatId: "shared", agentKey: "beta", updatedAt: epoch(200) }),
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
          updatedAt: epoch(index + 1),
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

test("assistant nav project predicate only accepts CODER and KBASE modes", () => {
  assert.equal(isAssistantNavProjectAgent({ mode: "CODER" }), true);
  assert.equal(isAssistantNavProjectAgent({ mode: "kbase" }), true);
  assert.equal(isAssistantNavProjectAgent({ mode: "CHAT" }), false);
  assert.equal(isAssistantNavProjectAgent({}), false);
});

test("assistant nav Chats exclude projects and internal agents", () => {
  assert.equal(isAssistantNavChatAgent({ agentKey: "zenmi", mode: "CHAT" }), true);
  assert.equal(isAssistantNavChatAgent({ agentKey: "legacy" }), true);
  assert.equal(isAssistantNavChatAgent({ agentKey: "coder", mode: "CODER" }), false);
  assert.equal(isAssistantNavChatAgent({ agentKey: "desktopAssistant", mode: "CHAT" }), false);
  assert.equal(isAssistantNavChatAgent({ agentKey: "webOperator", mode: "CHAT" }), false);
});

test("assistant nav runtime Chat agent follows the strict OWNER bootstrap modes", () => {
  const bootstrap = { agentKey: "bootstrap", displayName: "Bootstrap", recentChats: [] };
  const zenmi = { agentKey: "zenmi", displayName: "小宅", recentChats: [] };

  assert.deepEqual(
    resolveAssistantNavChatRuntimeAgent([bootstrap, zenmi], {
      defaultChatAgentKey: "zenmi",
      bootstrapAgentKey: "bootstrap",
      bootstrapPending: true,
    }),
    {
      agent: bootstrap,
      agentKey: "bootstrap",
      defaultAgentAvailable: true,
      bootstrapAgentAvailable: true,
      bootstrapActive: true,
    },
  );
  assert.deepEqual(
    resolveAssistantNavChatRuntimeAgent([bootstrap, zenmi], {
      defaultChatAgentKey: "zenmi",
      bootstrapAgentKey: "bootstrap",
      bootstrapPending: false,
    }),
    {
      agent: zenmi,
      agentKey: "zenmi",
      defaultAgentAvailable: true,
      bootstrapAgentAvailable: true,
      bootstrapActive: false,
    },
  );
  assert.deepEqual(
    resolveAssistantNavChatRuntimeAgent([zenmi], {
      defaultChatAgentKey: "zenmi",
      bootstrapAgentKey: "bootstrap",
      bootstrapPending: true,
    }),
    {
      agent: null,
      agentKey: "bootstrap",
      defaultAgentAvailable: true,
      bootstrapAgentAvailable: false,
      bootstrapActive: false,
    },
  );
  assert.deepEqual(
    resolveAssistantNavChatRuntimeAgent([bootstrap], {
      defaultChatAgentKey: "zenmi",
      bootstrapAgentKey: "bootstrap",
      bootstrapPending: false,
    }),
    {
      agent: null,
      agentKey: "zenmi",
      defaultAgentAvailable: false,
      bootstrapAgentAvailable: true,
      bootstrapActive: false,
    },
  );
});

test("assistant nav runtime Chat agent keeps ordinary default behavior without bootstrap config", () => {
  const zenmi = { agentKey: "zenmi", displayName: "小宅", recentChats: [] };

  assert.deepEqual(
    resolveAssistantNavChatRuntimeAgent([zenmi], {
      defaultChatAgentKey: "zenmi",
    }),
    {
      agent: zenmi,
      agentKey: "zenmi",
      defaultAgentAvailable: true,
      bootstrapAgentAvailable: false,
      bootstrapActive: false,
    },
  );
});

test("assistant nav attention matches webclient worker selection", () => {
  assert.equal(
    getAssistantNavAgentAttentionChat({
      recentChats: [
        chat({ chatId: "latest-unread", updatedAt: epoch(300), isRead: false }),
        chat({ chatId: "older-running", updatedAt: epoch(100), hasActiveRun: true }),
      ],
    })?.chatId,
    "older-running",
  );

  assert.equal(
    getAssistantNavAgentAttentionChat({
      recentChats: [
        chat({ chatId: "latest-unread", updatedAt: epoch(300), isRead: false }),
        chat({ chatId: "older-awaiting", updatedAt: epoch(100), hasPendingAwaiting: true }),
      ],
    })?.chatId,
    "latest-unread",
  );
});

test("assistant nav attention only opens unread when the latest row is unread", () => {
  const agent = {
    recentChats: [
      chat({ chatId: "older-unread", updatedAt: epoch(100), isRead: false }),
      chat({ chatId: "newest-read", updatedAt: epoch(300), isRead: true }),
      chat({ chatId: "newer-unread", updatedAt: epoch(200), isRead: false }),
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
        chat({ chatId: "latest-unread", updatedAt: epoch(300), isRead: false }),
        chat({ chatId: "older-read", updatedAt: epoch(200), isRead: true }),
      ],
    })?.chatId,
    "latest-unread",
  );
});

test("assistant nav preview does not move older awaiting or unread rows ahead of newer rows", () => {
  const agent = {
    recentChats: [
      chat({ chatId: "read-700", updatedAt: epoch(700), isRead: true }),
      chat({ chatId: "await-650", updatedAt: epoch(650), isRead: true, hasPendingAwaiting: true }),
      chat({ chatId: "read-600", updatedAt: epoch(600), isRead: true }),
      chat({ chatId: "read-500", updatedAt: epoch(500), isRead: true }),
      chat({ chatId: "read-400", updatedAt: epoch(400), isRead: true }),
      chat({ chatId: "read-300", updatedAt: epoch(300), isRead: true }),
      chat({ chatId: "unread-350", updatedAt: epoch(350), isRead: false }),
      chat({ chatId: "unread-250", updatedAt: epoch(250), isRead: false }),
      chat({ chatId: "unread-200", updatedAt: epoch(200), isRead: false }),
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
        { chatId: "read-100", createdAt: epoch(100), updatedAt: epoch(100), isRead: true },
        { chatId: "unread-300", createdAt: epoch(300), updatedAt: epoch(300), read: { isRead: false } },
        { chatId: "read-200", createdAt: epoch(200), updatedAt: epoch(200), isRead: true },
      ],
    },
  ]);

  assert.equal(agent.recentChats[1].updatedAt, epoch(300));
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

test("assistant nav sorts epoch-ms updatedAt values by actual time", () => {
  const agent = {
    recentChats: [
      chat({
        chatId: "iso-newer",
        updatedAt: epoch(300),
        isRead: true,
      }),
      chat({
        chatId: "iso-older",
        updatedAt: epoch(100),
        isRead: true,
      }),
      chat({
        chatId: "iso-middle",
        updatedAt: epoch(200),
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
          createdAt: epoch(100),
          updatedAt: epoch(100),
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
        { chatId: "read-newer", createdAt: epoch(300), updatedAt: epoch(300), read: { isRead: true } },
        { chatId: "unread-middle", createdAt: epoch(200), updatedAt: epoch(200), read: { isRead: false } },
        { chatId: "read-older", createdAt: epoch(100), updatedAt: epoch(100), read: { isRead: true } },
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
        { chatId: "read-newer", createdAt: epoch(300), updatedAt: epoch(300), read: { isRead: true } },
        { chatId: "unread-middle", createdAt: epoch(200), updatedAt: epoch(200), read: { isRead: false } },
        { chatId: "read-older", createdAt: epoch(100), updatedAt: epoch(100), read: { isRead: true } },
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
        createdAt: epoch(1000),
        updatedAt: epoch(2000),
      }],
    },
  ]);
  const [overview] = getAssistantNavRecentChatsOverview([agent]);

  assert.equal(overview.chat.createdAt, epoch(1000));
  assert.equal(overview.agent.workspaceDir, "/Users/demo/Project/zenmind-desktop");
  assert.equal(overview.agent.workspaceDirExists, true);
  assert.equal(overview.agent.gitBranch, "feature/chat-card");
});
