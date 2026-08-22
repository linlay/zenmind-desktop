import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const readSource = (...segments) => fs.readFileSync(
  path.join(projectRoot, ...segments),
  "utf8",
);

test("Chats and Projects open one native history dialog without route mutation", () => {
  const sidebar = readSource("src", "renderer", "app-shell", "navigation", "AppSidebar.tsx");
  const appShell = readSource("src", "renderer", "app-shell", "AppShell.tsx");
  const dialog = readSource("src", "renderer", "app-shell", "history", "ChatHistoryDialog.tsx");

  assert.match(sidebar, /function handleChatsOpenHistory[\s\S]*?onOpenChatHistory\?\.\(\)/u);
  assert.match(sidebar, /onOpenChatHistory\?\.\(agent\.agentKey\)/u);
  assert.doesNotMatch(sidebar, /historyRequested|createAgentHistoryRoute|openChatHistory/u);
  assert.match(appShell, /onOpenChatHistory=\{openChatHistoryDialog\}/u);
  assert.match(appShell, /key=\{chatHistoryDialog\.id\}/u);
  assert.match(dialog, /if \(!normalizedAgentKey\) return "\/history";/u);
  assert.match(dialog, /new URLSearchParams\(\{ agentKey: normalizedAgentKey \}\)/u);
  assert.match(dialog, /surfaceIdentity=\{HISTORY_SURFACE_IDENTITY\}/u);
  assert.match(dialog, /surfaceOwnershipActive=\{false\}/u);
  assert.match(dialog, /role="dialog"[\s\S]*?aria-modal="true"/u);
});

test("history WebView requests are limited to the trusted history surface", () => {
  const contracts = readSource("src", "shared", "service-webview-bridge.ts");
  const host = readSource("src", "renderer", "services", "serviceWebviewBridgeHost.ts");
  const surface = readSource("src", "renderer", "service-webview", "ServiceWebviewSurface.tsx");
  const appShell = readSource("src", "renderer", "app-shell", "AppShell.tsx");
  const preload = readSource("src", "preload", "service-webview.ts");

  assert.match(contracts, /desktop:agent-webclient:history-open-chat/u);
  assert.match(host, /context\.serviceId === "agent-webclient"[\s\S]*?context\.openAgentWebclientHistoryChat/u);
  assert.match(surface, /surfaceIdentity\.surfaceRole === "history"[\s\S]*?onAgentWebclientHistoryOpenChat/u);
  assert.match(appShell, /setChatHistoryDialog\(null\);[\s\S]*?requestNavigationWithAgentChatFocus\(createAgentWebclientRoute\(request\)\)/u);
  assert.doesNotMatch(preload, /openChatHistory/u);
});
