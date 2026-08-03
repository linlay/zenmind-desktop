import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = process.cwd();

function loadGlobalSearchRowsModule() {
  const sourcePath = path.join(projectRoot, "src", "renderer", "app-shell", "search", "globalSearchRows.ts");
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
  const sourceRequire = createRequire(sourcePath);
  fn(mod.exports, (specifier) => {
    if (specifier === "../../../shared/time-contract") {
      return {
        readEpochMillis(value) {
          return typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= 0 &&
            value <= 8_640_000_000_000_000
            ? value
            : undefined;
        },
      };
    }
    if (specifier === "../../../shared/route-path") {
      return require("../dist-electron/shared/route-path.js");
    }
    return sourceRequire(specifier);
  }, mod, sourcePath, path.dirname(sourcePath));
  return mod.exports;
}

const {
  buildDesktopGlobalSearchSections,
  resolveDesktopGlobalSearchAgentKey,
} = loadGlobalSearchRowsModule();

const messages = {
  "assistant.newChat": "New chat",
  "desktop.globalSearch.group.awaiting": "Awaiting",
  "desktop.globalSearch.group.unread": "Unread chats",
  "desktop.globalSearch.group.actions": "Actions",
  "desktop.globalSearch.group.agents": "Agents",
  "desktop.globalSearch.group.chats": "Chats",
  "desktop.globalSearch.action.newChat": "New chat",
  "desktop.globalSearch.action.newChat.description": "Start current agent chat",
  "desktop.globalSearch.action.agents": "Open agents",
  "desktop.globalSearch.action.agents.description": "Browse agents",
  "desktop.globalSearch.action.controlCenter": "Open control center",
  "desktop.globalSearch.action.controlCenter.description": "Manage runtime",
  "desktop.globalSearch.action.settings": "Open settings",
  "desktop.globalSearch.action.settings.description": "Adjust preferences",
};
const EPOCH_MS = 1_710_000_000_000;

function t(key) {
  return messages[key] ?? key;
}

function chat(overrides) {
  return {
    chatId: "chat-1",
    chatName: "Deploy plan",
    agentKey: "coder",
    updatedAt: EPOCH_MS,
    lastRunId: "run-1",
    lastRunContent: "local deploy snippet",
    isRead: true,
    hasActiveRun: false,
    hasPendingAwaiting: false,
    ...overrides,
  };
}

function agent(overrides) {
  return {
    agentKey: "coder",
    displayName: "Coder",
    role: "Build agent",
    unreadCount: 0,
    unreadChatCount: 0,
    chatCount: 1,
    hasPendingAwaiting: false,
    latestChatId: "chat-1",
    latestPreview: "local deploy snippet",
    updatedAt: EPOCH_MS,
    recentChats: [chat({})],
    ...overrides,
  };
}

function rowsOfKind(sections, kind) {
  return sections.flatMap((section) => section.rows).filter((row) => row.kind === kind);
}

test("desktop global search resolves the current agent and default sections", () => {
  assert.equal(resolveDesktopGlobalSearchAgentKey("/agent/coder?chatId=chat-1"), "coder");
  assert.equal(resolveDesktopGlobalSearchAgentKey("/agents/team%20agent"), "team agent");
  assert.equal(
    resolveDesktopGlobalSearchAgentKey("/copilot/AI%E5%BB%BA%E8%AE%BE%E6%96%87%E6%A1%A3"),
    "AI建设文档",
  );
  assert.equal(resolveDesktopGlobalSearchAgentKey("/agent/%E5%A"), "");

  const sections = buildDesktopGlobalSearchSections({
    agents: [agent({})],
    query: "",
    currentAgentKey: "coder",
    t,
  });

  assert.deepEqual(sections.map((section) => section.id), ["actions", "agents", "chats"]);
  assert.equal(rowsOfKind(sections, "action").some((row) => row.actionId === "newChat"), true);
  assert.equal(rowsOfKind(sections, "agent")[0].agentKey, "coder");
  assert.equal(rowsOfKind(sections, "chat")[0].chatId, "chat-1");
});

test("desktop global search prioritizes awaiting and unread chats in the empty state", () => {
  const sections = buildDesktopGlobalSearchSections({
    agents: [
      agent({
        recentChats: [
          chat({
            chatId: "chat-awaiting",
            chatName: "Needs input",
            isRead: false,
            hasPendingAwaiting: true,
            updatedAt: EPOCH_MS + 1_000,
          }),
          chat({
            chatId: "chat-unread",
            chatName: "Unread design notes",
            isRead: false,
            updatedAt: EPOCH_MS + 2_000,
          }),
          chat({
            chatId: "chat-recent",
            chatName: "Recent sync",
            lastRunContent: "recent local snippet",
            updatedAt: EPOCH_MS + 3_000,
          }),
        ],
      }),
    ],
    query: "",
    currentAgentKey: "coder",
    t,
  });

  assert.deepEqual(sections.map((section) => section.id), ["awaiting", "unread", "actions", "agents", "chats"]);

  const awaitingRows = sections.find((section) => section.id === "awaiting").rows;
  const unreadRows = sections.find((section) => section.id === "unread").rows;
  const recentRows = sections.find((section) => section.id === "chats").rows;

  assert.deepEqual(awaitingRows.map((row) => row.chatId), ["chat-awaiting"]);
  assert.deepEqual(unreadRows.map((row) => row.chatId), ["chat-unread"]);
  assert.equal(recentRows.some((row) => row.chatId === "chat-awaiting" || row.chatId === "chat-unread"), false);
  assert.deepEqual(recentRows.map((row) => row.chatId), ["chat-recent"]);
});

test("desktop global search keeps agents with absent or null updatedAt after timestamped agents", () => {
  const sections = buildDesktopGlobalSearchSections({
    agents: [
      agent({ agentKey: "without-time", displayName: "Without time", updatedAt: undefined, recentChats: [] }),
      agent({ agentKey: "null-time", displayName: "Null time", updatedAt: null, recentChats: [] }),
      agent({ agentKey: "older", displayName: "Older", updatedAt: EPOCH_MS + 1_000, recentChats: [] }),
      agent({ agentKey: "newer", displayName: "Newer", updatedAt: EPOCH_MS + 2_000, recentChats: [] }),
    ],
    query: "",
    currentAgentKey: "coder",
    t,
  });

  assert.deepEqual(
    rowsOfKind(sections, "agent").map((row) => row.agentKey),
    ["newer", "older", "null-time", "without-time"],
  );
});

test("desktop global search uses project agent icons without secondary role text", () => {
  const sections = buildDesktopGlobalSearchSections({
    agents: [
      agent({
        agentKey: "coder-project",
        displayName: "Coder project",
        mode: "CODER",
        role: "This role must not appear",
        latestPreview: "This preview must not appear",
        recentChats: [],
      }),
      agent({
        agentKey: "kbase-project",
        displayName: "KBase project",
        mode: "kbase",
        role: "This role must not appear",
        latestPreview: "This preview must not appear",
        recentChats: [],
      }),
      agent({
        agentKey: "regular-agent",
        displayName: "Regular agent",
        role: "Visible role",
        recentChats: [],
      }),
    ],
    query: "",
    currentAgentKey: "coder-project",
    t,
  });

  const agentRows = rowsOfKind(sections, "agent");
  assert.deepEqual(
    agentRows.map((row) => [row.agentKey, row.projectKind, row.description]),
    [
      ["coder-project", "coder", undefined],
      ["kbase-project", "kbase", undefined],
      ["regular-agent", undefined, "Visible role"],
    ],
  );
});

test("desktop global search filters rows, boosts local attention state, and prefers remote chat snippets", () => {
  const sections = buildDesktopGlobalSearchSections({
    agents: [
      agent({
        recentChats: [
          chat({
            chatId: "chat-1",
            chatName: "Deploy plan",
            lastRunContent: "local deploy snippet",
            isRead: false,
            hasPendingAwaiting: true,
            awaitingMode: "question",
          }),
          chat({ chatId: "chat-2", chatName: "Meeting notes", lastRunContent: "unrelated" }),
        ],
      }),
    ],
    query: "deploy",
    currentAgentKey: "coder",
    remoteResults: [
      {
        chatId: "chat-1",
        chatName: "Remote deploy plan",
        agentKey: "coder",
        runId: "run-remote",
        kind: "message",
        role: "assistant",
        timestamp: 1710000005000,
        snippet: "remote deploy snippet",
        score: 1,
      },
      {
        chatId: "chat-remote",
        chatName: "Remote-only deploy plan",
        agentKey: "coder",
        runId: "run-remote-only",
        kind: "message",
        role: "assistant",
        timestamp: 1710000008000,
        snippet: "higher scoring remote deploy snippet",
        score: 100,
      },
      {
        chatId: "chat-missing-agent",
        chatName: "Missing agent",
        kind: "message",
        timestamp: 1710000007000,
        snippet: "should not render",
        score: 100,
      },
    ],
    t,
  });

  const chatRows = rowsOfKind(sections, "chat");

  assert.equal(chatRows.length, 2);
  assert.equal(chatRows[0].chatId, "chat-1");
  assert.equal(chatRows[0].label, "Remote deploy plan");
  assert.equal(chatRows[0].snippet, "remote deploy snippet");
  assert.equal(chatRows[0].source, "remote");
  assert.equal(chatRows[0].hasPendingAwaiting, true);
  assert.equal(chatRows[0].awaitingMode, "question");
  assert.equal(chatRows[0].isUnread, true);
  assert.equal(chatRows[1].chatId, "chat-remote");
  assert.equal(chatRows.some((row) => row.chatId === "chat-missing-agent"), false);
});
