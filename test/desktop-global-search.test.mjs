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
  fn(mod.exports, require, mod, sourcePath, path.dirname(sourcePath));
  return mod.exports;
}

const {
  buildDesktopGlobalSearchSections,
  resolveDesktopGlobalSearchAgentKey,
} = loadGlobalSearchRowsModule();

const messages = {
  "assistant.newChat": "New chat",
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

function t(key) {
  return messages[key] ?? key;
}

function chat(overrides) {
  return {
    chatId: "chat-1",
    chatName: "Deploy plan",
    agentKey: "coder",
    updatedAt: "1710000000000",
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
    updatedAt: "1710000000000",
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

test("desktop global search filters rows and prefers remote chat snippets", () => {
  const sections = buildDesktopGlobalSearchSections({
    agents: [
      agent({
        recentChats: [
          chat({ chatId: "chat-1", chatName: "Deploy plan", lastRunContent: "local deploy snippet" }),
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
        score: 99,
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

  assert.equal(chatRows.length, 1);
  assert.equal(chatRows[0].chatId, "chat-1");
  assert.equal(chatRows[0].label, "Remote deploy plan");
  assert.equal(chatRows[0].snippet, "remote deploy snippet");
  assert.equal(chatRows[0].source, "remote");
  assert.equal(chatRows.some((row) => row.chatId === "chat-missing-agent"), false);
});
