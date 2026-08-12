import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("Chat Work Panel keeps the main chat surface single while mounting chat workspaces separately", () => {
  const embeddedHosts = read("src/renderer/app-shell/embedded-surfaces/EmbeddedSurfaceHosts.tsx");
  const appShell = read("src/renderer/app-shell/AppShell.tsx");
  const workPanelHost = read("src/renderer/chat-work-panel/ChatWorkPanelHost.tsx");
  const workPanelSurface = read("src/renderer/chat-work-panel/ChatWorkPanelSurface.tsx");
  const appShellCss = read("src/renderer/styles/app-shell.css");

  assert.match(embeddedHosts, /AGENT_WEBCLIENT_CHAT_SURFACE_ID = "agent-webclient-chat"/u);
  assert.match(embeddedHosts, /key=\{AGENT_WEBCLIENT_CHAT_SURFACE_ID\}/u);
  assert.match(appShell, /useRef\(new Map<string, ChatWorkPanelWorkspace>\(\)\)/u);
  assert.match(appShell, /chatWorkPanelWorkspaces\.map/u);
  assert.match(appShell, /<ChatWorkPanelHost/u);
  assert.match(workPanelHost, /workspaces\.map/u);
  assert.match(workPanelSurface, /allowUserTabCreation/u);
  assert.match(workPanelSurface, /allowTabUrlCopy/u);
  assert.match(workPanelSurface, /showToolbar=\{false\}/u);
  assert.match(workPanelSurface, /registerPublicWebSurface=\{false\}/u);
  assert.match(workPanelSurface, /partition=\{workspace\.partition\}/u);
  assert.match(appShellCss, /\.app-content\s*\{[^}]*display:\s*flex;/su);
  assert.match(appShellCss, /\.chat-work-panel\s*\{[^}]*position:\s*relative;[^}]*flex:\s*0 0 var\(--chat-work-panel-width/su);
});

test("Chat Work Panel actions derive ownership from trusted source and expose target state", () => {
  const actions = read("src/shared/desktop-actions.ts");
  const host = read("src/renderer/chat-work-panel/ChatWorkPanelHost.tsx");
  const webview = read("src/renderer/pages/external-webview/ExternalWebviewPage.tsx");
  const gateway = read("src/main/embedded-cdp-gateway.ts");
  const bridge = read("src/main/desktop-action-bridge.ts");

  for (const name of ["getState", "open", "close", "openTab", "activateTab", "closeTab"]) {
    assert.match(actions, new RegExp(`desktop\\.chatWorkPanel\\.${name}`, "u"));
  }
  assert.match(host, /request\.source\?\.chatId/u);
  assert.match(host, /\["chatId", "surfaceId", "agentKey"\]/u);
  assert.match(webview, /getSurfaceTargetState/u);
  assert.match(gateway, /target_not_owned_by_chat/u);
  assert.match(gateway, /matchingTarget\.surface\.ownerChatId === requestedChatId/u);
  assert.match(bridge, /request\.source\?\.chatId/u);
});

test("Chat Work Panel UI has dynamic panel actions and a toolbar-free user tab strip", () => {
  const sidebarContract = read("src/shared/sidebar-context-menu.ts");
  const sidebar = read("src/renderer/app-shell/navigation/AppSidebar.tsx");
  const workPanelHost = read("src/renderer/chat-work-panel/ChatWorkPanelHost.tsx");
  const workPanelSurface = read("src/renderer/chat-work-panel/ChatWorkPanelSurface.tsx");
  const appShellCss = read("src/renderer/styles/app-shell.css");

  assert.match(sidebarContract, /"chat\.workPanel\.open"/u);
  assert.match(sidebarContract, /"chat\.workPanel\.close"/u);
  assert.doesNotMatch(sidebar, /assistant-worker-chat-work-panel-button/u);
  assert.match(sidebar, /actionId === "chat\.workPanel\.open"/u);
  assert.match(sidebar, /actionId === "chat\.workPanel\.close"/u);
  assert.match(sidebar, /onCloseChatWorkPanel\?\.\(chat\.chatId\)/u);
  assert.doesNotMatch(workPanelSurface, /chat-work-panel-header/u);
  assert.match(workPanelSurface, /allowUserTabCreation/u);
  assert.match(workPanelSurface, /allowTabUrlCopy/u);
  assert.match(workPanelSurface, /showToolbar=\{false\}/u);
  assert.match(workPanelSurface, /showSurfaceCloseButton/u);
  assert.match(workPanelSurface, /surfaceCloseLabel=\{t\("chatWorkPanel\.close"\)\}/u);
  assert.match(appShellCss, /\.chat-work-panel \.external-webview-surface-close svg\s*\{[^}]*stroke:\s*currentColor;/su);
});
