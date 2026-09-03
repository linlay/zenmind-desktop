import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readSourceFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("assistant chat navigation never writes read state and keeps explicit mark-all", () => {
  const contracts = readSourceFile("src", "shared", "contracts", "desktop-api.ts");
  const preload = readSourceFile("src", "preload", "index.ts");
  const assistantHandlers = readSourceFile("src", "main", "ipc", "assistant-handlers.ts");
  const bridge = readSourceFile("src", "main", "assistant", "core", "agent-platform-bridge.ts");
  const sidebar = readSourceFile("src", "renderer", "app-shell", "navigation", "AppSidebar.tsx");

  assert.doesNotMatch(contracts, /markChatRead/);
  assert.doesNotMatch(preload, /markChatRead|assistant\.markChatRead/);
  assert.doesNotMatch(assistantHandlers, /assistant\.markChatRead|\.markChatRead\(/);
  assert.doesNotMatch(bridge, /async markChatRead\(/);
  assert.match(contracts, /markAgentChatsRead: \(agentKey: string\) => Promise<AssistantNavActionResult>/);
  assert.match(preload, /markAgentChatsRead: \(agentKey: string\) => ipcRenderer\.invoke\("assistant\.markAgentChatsRead", agentKey\)/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.markAgentChatsRead"/);

  const openChatStart = sidebar.indexOf("async function handleAssistantOpenChat");
  assert.notEqual(openChatStart, -1);
  const openChatEnd = sidebar.indexOf("function handleAssistantOpenChatMenu", openChatStart);
  assert.notEqual(openChatEnd, -1);
  const openChatBlock = sidebar.slice(openChatStart, openChatEnd);
  assert.doesNotMatch(openChatBlock, /markChatRead|markAgentChatsRead|\/api\/read/);
  assert.match(openChatBlock, /requestNavigate\(createAgentChatRoute\(chat\.agentKey, chat\.chatId\), \{/);
});
