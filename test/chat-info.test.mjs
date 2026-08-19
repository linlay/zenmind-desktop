import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const {
  buildChatInfoCopyAllText,
  buildChatInfoRows,
} = await import("../dist-electron/shared/chat-info.js");

const labels = {
  "sidebar.chat.infoField.chatId": "Chat ID",
  "sidebar.chat.infoField.chatName": "Name",
  "sidebar.chat.infoField.agentKey": "AgentKey",
  "sidebar.chat.infoField.firstAgentKey": "First agent ID",
  "sidebar.chat.infoField.firstAgentName": "First agent name",
  "sidebar.chat.infoField.teamId": "Team ID",
  "sidebar.chat.infoField.source": "Source",
  "sidebar.chat.infoField.createdAt": "Created at",
  "sidebar.chat.infoField.updatedAt": "Updated at",
  "sidebar.chat.infoField.lastRunId": "Latest run ID",
  "sidebar.chat.infoField.lastRunContent": "Latest response",
};
const t = (key) => labels[key] ?? key;

test("chat information rows expose the sidebar summary before details load", () => {
  const rows = buildChatInfoRows({
    summary: {
      chatId: "chat-1",
      chatName: "Summary name",
      agentKey: "agent-a",
    },
    detail: null,
    t,
  });

  assert.deepEqual(rows.map((row) => row.key), ["chatId", "chatName", "agentKey"]);
  assert.equal(buildChatInfoCopyAllText(rows), [
    "Chat ID: chat-1",
    "Name: Summary name",
    "AgentKey: agent-a",
  ].join("\n"));
});

test("chat information rows map full detail and preserve epoch values for copying", () => {
  const rows = buildChatInfoRows({
    summary: { chatId: "fallback", chatName: "Fallback", agentKey: "fallback-agent" },
    detail: {
      chatId: "chat-2",
      chatName: "Planning",
      agentKey: "agent-b",
      firstAgentKey: "agent-a",
      firstAgentName: "Agent A",
      teamId: "team-a",
      source: "desktop",
      createdAt: 1713781200000,
      updatedAt: 1713784800000,
      lastRunId: "run-9",
      lastRunContent: "Done",
      rawJson: "{}",
    },
    t,
  });

  assert.deepEqual(rows.map((row) => row.key), [
    "chatId",
    "chatName",
    "agentKey",
    "firstAgentKey",
    "firstAgentName",
    "teamId",
    "source",
    "createdAt",
    "updatedAt",
    "lastRunId",
    "lastRunContent",
  ]);
  assert.deepEqual(rows.find((row) => row.key === "createdAt"), {
    key: "createdAt",
    label: "Created at",
    displayValue: "2024-04-22T10:20:00.000Z",
    copyValue: "1713781200000",
  });
});

test("chat information dialog keeps WebClient behavior behind Desktop UI", () => {
  const dialogSource = fs.readFileSync(
    path.join(projectRoot, "src/renderer/app-shell/navigation/ChatInfoDialog.tsx"),
    "utf8",
  );
  const hookSource = fs.readFileSync(
    path.join(projectRoot, "src/renderer/app-shell/navigation/useChatInfoDialog.ts"),
    "utf8",
  );
  const ipcSource = fs.readFileSync(
    path.join(projectRoot, "src/main/ipc/assistant-handlers.ts"),
    "utf8",
  );
  const preloadSource = fs.readFileSync(
    path.join(projectRoot, "src/preload/index.ts"),
    "utf8",
  );
  assert.match(dialogSource, /window\.electronAPI\.clipboard\.writeText\(value\)/u);
  assert.match(dialogSource, /disabled=\{!state\.detail\?\.rawJson\}/u);
  assert.match(dialogSource, /buildChatInfoCopyAllText\(rows\)/u);
  assert.match(dialogSource, /event\.key !== "Escape"/u);
  assert.match(hookSource, /assistant\.getChatInfo\(summary\.chatId\)/u);
  assert.match(hookSource, /requestIdRef\.current !== requestId/u);
  assert.match(hookSource, /requestIdRef\.current \+= 1/u);
  assert.match(
    fs.readFileSync(path.join(projectRoot, "src/renderer/app-shell/navigation/AppSidebar.tsx"), "utf8"),
    /actionId === "chat\.info"\) \{\s*chatInfoDialog\.open\(chat\)/u,
  );
  assert.match(ipcSource, /ipcMain\.handle\("assistant\.getChatInfo"/u);
  assert.match(preloadSource, /getChatInfo: \(chatId: string\) => ipcRenderer\.invoke\("assistant\.getChatInfo", chatId\)/u);
});
