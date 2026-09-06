import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const readSource = (...segments) => {
  const sourcePath = path.join(projectRoot, ...segments);
  const source = fs.readFileSync(sourcePath, "utf8");
  if (!sourcePath.includes(`${path.sep}src${path.sep}main${path.sep}`) || path.extname(sourcePath) !== ".ts") {
    return source;
  }
  const sourceDirectory = path.dirname(sourcePath);
  const sourceStem = path.basename(sourcePath, ".ts");
  const splitSources = fs.readdirSync(sourceDirectory)
    .filter((name) => name.startsWith(`${sourceStem}.`) && name.endsWith(".ts"))
    .sort()
    .map((name) => fs.readFileSync(path.join(sourceDirectory, name), "utf8"));
  return [source, ...splitSources].join("\n");
};

test("Chats and Projects open one native history dialog without route mutation", () => {
  const sidebar = readSource("src", "renderer", "app-shell", "navigation", "AppSidebar.tsx");
  const appShell = readSource("src", "renderer", "app-shell", "AppShell.tsx");
  const dialog = readSource("src", "renderer", "app-shell", "history", "ChatHistoryDialog.tsx");

  assert.match(sidebar, /function handleChatsOpenHistory[\s\S]*?onOpenChatHistory\?\.\(\)/u);
  assert.match(sidebar, /onOpenChatHistory\?\.\(agent\.agentKey\)/u);
  assert.match(appShell, /onOpenChatHistory=\{openChatHistoryDialog\}/u);
  assert.match(appShell, /key=\{chatHistoryDialog\.id\}/u);
  assert.match(appShell, /handleHistoryChatRemoved[\s\S]*?closeChatWorkPanelWorkspace\(chat\.chatId, true\)[\s\S]*?activeChatRouteInfo\.chatId === chat\.chatId[\s\S]*?refreshAssistantNavAgents\(\{ force: true \}\)/u);
  assert.match(dialog, /window\.electronAPI\.assistant\.listHistoryChats\(\)/u);
  assert.match(dialog, /useState\(normalizedAgentKey \|\| ALL_OWNERS\)/u);
  assert.match(dialog, /function resetFilters[\s\S]*?setOwnerKey\(ALL_OWNERS\)/u);
  assert.match(dialog, /role="dialog"[\s\S]*?aria-modal="true"/u);
  assert.doesNotMatch(dialog, /ServiceWebviewSurface|\/history\?agentKey|surfaceIdentity/u);
  assert.doesNotMatch(appShell, /history=1/u);
});

test("native history uses a restricted assistant bridge and supports dense row actions", () => {
  const contracts = readSource("src", "shared", "contracts", "desktop-api.ts");
  const preload = readSource("src", "preload", "index.ts");
  const handlers = readSource("src", "main", "modules", "assistant", "ipc.ts");
  const bridge = readSource("src", "main", "modules", "agent-platform", "bridge.ts");
  const dialog = readSource("src", "renderer", "app-shell", "history", "ChatHistoryDialog.tsx");
  const webviewBridge = readSource("src", "shared", "service-webview-bridge.ts");

  assert.match(contracts, /listHistoryChats: \(\) => Promise<AssistantHistoryChatsResult>/u);
  assert.match(preload, /listHistoryChats: \(\) => ipcRenderer\.invoke\("assistant\.listHistoryChats"\)/u);
  assert.match(handlers, /ipcMain\.handle\("assistant\.listHistoryChats"[\s\S]*?assistantBridge\?\.listHistoryChats\(\)/u);
  assert.match(bridge, /async listHistoryChats\(\): Promise<AssistantHistoryChatsResult>[\s\S]*?"\/api\/chats"/u);
  assert.doesNotMatch(contracts, /agentPlatform\s*:\s*\{[\s\S]*?request/u);
  assert.doesNotMatch(webviewBridge, /history-open-chat/u);

  assert.match(dialog, /assistant\.exportChat\(chat\.chatId\)/u);
  assert.match(dialog, /assistant\.archiveChat\(chat\.chatId\)/u);
  assert.match(dialog, /assistant\.deleteChat\(chat\.chatId\)/u);
  assert.match(dialog, /role="alertdialog"/u);
  assert.match(dialog, /className="chat-history-dialog-row-title-line"[\s\S]*?className="chat-history-dialog-row-preview"/u);
  assert.match(dialog, /if \(pendingByChatId\[chat\.chatId\]\) return/u);
  assert.match(dialog, /onNavigationAgentsChanged[\s\S]*?loadHistory\(true\)/u);
});

test("history dialog uses the compact Cmd+K panel footprint and accessible hover actions", () => {
  const dialog = readSource("src", "renderer", "app-shell", "history", "ChatHistoryDialog.tsx");
  const styles = readSource("src", "renderer", "styles", "chat-history-dialog.css");

  assert.doesNotMatch(dialog, /chat-history-dialog-header|<header/u);
  assert.match(dialog, /className="chat-history-dialog-commandbar"/u);
  assert.match(dialog, /className="chat-history-dialog-filter-menu"[\s\S]*?history\.dialog\.owner[\s\S]*?type="date"/u);
  assert.match(dialog, /chat-history-dialog-filter-result-count[\s\S]*?history\.dialog\.count/u);
  assert.match(styles, /\.chat-history-dialog-layer[\s\S]*?background: var\(--modal-mask-bg\)/u);
  assert.match(styles, /\.chat-history-dialog[\s\S]*?width: min\(720px, 100%\)/u);
  assert.match(styles, /\.chat-history-dialog[\s\S]*?height: min\(640px, calc\(100vh - 32px\)\)/u);
  assert.match(styles, /\.chat-history-dialog-row[\s\S]*?min-height: 52px/u);
  assert.match(styles, /\.chat-history-dialog-row-title-line strong[\s\S]*?font-size: 14px/u);
  assert.match(styles, /\.chat-history-dialog-row-preview[\s\S]*?font-size: 12px/u);
  assert.match(styles, /\.chat-history-dialog-row-actions[\s\S]*?position: absolute/u);
  assert.match(styles, /\.chat-history-dialog-row:hover \.chat-history-dialog-row-actions[\s\S]*?\.chat-history-dialog-row:focus-within \.chat-history-dialog-row-actions/u);
  assert.doesNotMatch(styles, /padding:\s*6px 112px 6px 9px/u);
  assert.doesNotMatch(styles, /1120px|780px/u);
});
