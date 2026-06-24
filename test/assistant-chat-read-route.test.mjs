import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readSourceFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("assistant chat row selection exposes and invokes single-chat read marking", () => {
  const contracts = readSourceFile("src", "shared", "contracts", "desktop-api.ts");
  const preload = readSourceFile("src", "preload", "index.ts");
  const assistantHandlers = readSourceFile("src", "main", "ipc", "assistant-handlers.ts");
  const bridge = readSourceFile("src", "main", "assistant", "core", "agent-platform-bridge.ts");
  const sidebar = readSourceFile("src", "renderer", "app-shell", "navigation", "AppSidebar.tsx");

  assert.match(contracts, /markChatRead: \(chatId: string, runId\?: string\) => Promise<AssistantNavActionResult>/);
  assert.match(preload, /markChatRead: \(chatId: string, runId\?: string\) =>\s*ipcRenderer\.invoke\("assistant\.markChatRead", chatId, runId\)/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.markChatRead", async \(_event: any, chatId: string, runId\?: string\)/);
  assert.match(assistantHandlers, /assistantBridge\?\.markChatRead\(chatId, runId\)/);
  assert.match(bridge, /async markChatRead\(chatId: string, runId\?: string\)/);
  assert.match(bridge, /body: JSON\.stringify\(\{\s*chatId: trimmedChatId,\s*\.\.\.\(trimmedRunId \? \{ runId: trimmedRunId \} : \{\}\),\s*\}\)/);

  const openChatStart = sidebar.indexOf("async function handleAssistantOpenChat");
  assert.notEqual(openChatStart, -1);
  const openChatEnd = sidebar.indexOf("function handleAssistantOpenChatMenu", openChatStart);
  assert.notEqual(openChatEnd, -1);
  const openChatBlock = sidebar.slice(openChatStart, openChatEnd);
  assert.match(openChatBlock, /if \(!chat\.isRead\)/);
  assert.match(openChatBlock, /const markChatRead = assistantApi\.markChatRead/);
  assert.match(openChatBlock, /markChatRead\(\s*chat\.chatId,\s*chat\.lastRunId \|\| undefined,?\s*\)/);
  assert.match(openChatBlock, /window\.electronAPI\.assistant\.markAgentChatsRead\(chat\.agentKey \|\| currentAgentKey\)/);
  assert.match(openChatBlock, /requestNavigate\(\s*createAgentChatRoute\(chat\.agentKey \|\| currentAgentKey, chat\.chatId\),?\s*\)/);
});
