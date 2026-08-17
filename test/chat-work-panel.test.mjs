import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("WorkPanel is AppShell-owned and keeps heterogeneous items mounted", () => {
  const embeddedHosts = read("src/renderer/app-shell/embedded-surfaces/EmbeddedSurfaceHosts.tsx");
  const appShell = read("src/renderer/app-shell/AppShell.tsx");
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const reducer = read("src/shared/work-panel.ts");
  const css = read("src/renderer/styles/app-shell.css");

  assert.match(embeddedHosts, /AGENT_WEBCLIENT_CHAT_SURFACE_ID = MAIN_CHAT_SURFACE_ID/u);
  assert.match(appShell, /useState<WorkPanelState>\(EMPTY_WORK_PANEL_STATE\)/u);
  assert.match(appShell, /reduceWorkPanelCommand\(currentState, normalizedCommand\)/u);
  assert.match(appShell, /<WorkPanelHost/u);
  assert.match(appShell, /className=\{`main-chat-work-panel-toggle/u);
  assert.match(appShell, /kind="sidebar_left"/u);
  assert.match(appShell, /className="main-chat-work-panel-toggle-icon"/u);
  assert.doesNotMatch(appShell, /LayoutOutlined/u);
  assert.match(appShell, /disabled=\{!activeChatWorkPanelChatId\}/u);
  assert.match(appShell, /createAgentWebclientOverviewPath\(\{ chatId, agentKey \}\)/u);
  assert.match(appShell, /shouldEnsureOverview/u);
  assert.match(appShell, /pinned: true/u);
  assert.match(appShell, /closable: false/u);
  assert.match(appShell, /type: "hideWorkspace"/u);
  assert.match(appShell, /type: "showWorkspace"/u);
  assert.match(appShell, /activeChatId=\{activeChatWorkPanelVisible \? activeChatWorkPanelChatId : null\}/u);
  assert.match(host, /state\.workspaces\.map/u);
  assert.match(host, /workspace\.items\.map/u);
  assert.match(host, /item\.descriptor\.kind === "webclient"/u);
  assert.match(host, /canCopyUrl: item\.descriptor\.kind === "web"/u);
  assert.match(host, /<ServiceWebviewSurface/u);
  assert.match(host, /<ExternalWebviewPage/u);
  assert.match(host, /hidden=\{!visible\}/u);
  assert.match(reducer, /stableKey:\s*`web:\$\{url\}`/u);
  assert.match(read("src/renderer/service-webview/ServiceWebviewSurface.tsx"), /\/overview\/iu/u);
  assert.doesNotMatch(read("src/renderer/service-webview/ServiceWebviewSurface.tsx"), /\/summary\/iu/u);
  assert.match(css, /\.app-shell\.has-chat-work-panel \.work-panel-host\s*\{[^}]*var\(--chat-work-panel-width/su);
  assert.doesNotMatch(css, /\.work-panel-host\s*\{[^}]*display:\s*contents/su);
  assert.match(css, /\.app-shell\.is-mac-platform \.main-chat-work-panel-toggle/u);
  assert.match(css, /\.app-shell\.is-windows-platform \.main-chat-work-panel-toggle/u);
  assert.match(css, /\.main-chat-work-panel-toggle:focus-visible/u);
  assert.match(css, /\.main-chat-work-panel-toggle\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border-radius:\s*6px/su);
  assert.match(css, /\.main-chat-work-panel-toggle-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*transform:\s*scaleX\(-1\)/su);
});

test("WorkPanel actions derive ownership from trusted source and preserve a stateless legacy adapter", () => {
  const actions = read("src/shared/desktop-actions.ts");
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const reducer = read("src/shared/work-panel.ts");
  const bridge = read("src/main/desktop-action-bridge.ts");

  for (const name of ["getState", "openItem", "activateItem", "closeItem", "closeWorkspace"]) {
    assert.match(actions, new RegExp(`desktop\\.workpanel\\.${name}`, "u"));
  }
  for (const name of ["getState", "open", "close", "openTab", "activateTab", "closeTab"]) {
    assert.match(actions, new RegExp(`desktop\\.chatWorkPanel\\.${name}`, "u"));
  }
  assert.match(host, /request\.source\?\.chatId/u);
  assert.match(host, /desktop\.chatWorkPanel\.openTab/u);
  assert.match(host, /descriptor:\s*\{ kind: "web", url/u);
  assert.match(reducer, /legacyActionCount/u);
  assert.match(bridge, /request\.source\?\.chatId/u);
  assert.doesNotMatch(host, /new Map<string, ChatWorkPanelWorkspace>/u);
  assert.match(read("src/renderer/app-shell/navigation/AppSidebar.tsx"), /onCloseChatWorkPanel\?\.\(chat\.chatId, true\)/u);
});

test("WorkPanel enforces one ephemeral Web guest per item and explicit platform focus branches", () => {
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const reducer = read("src/shared/work-panel.ts");

  assert.match(host, /itemPartition\(workspace\.workspaceId, item\.itemId\)/u);
  assert.match(host, /clearSession\?\.\(\{ partition \}\)/u);
  assert.match(host, /allowUserTabCreation=\{false\}/u);
  assert.match(host, /openPopupsInCurrentTab/u);
  assert.match(host, /if \(isMac\)/u);
  assert.match(host, /else if \(isWindows\)/u);
  assert.match(host, /dataset\.workPanelDomReady === "true"/u);
  assert.match(reducer, /unsupported_native_surface/u);
  assert.match(reducer, /item\.pinned \|\| !item\.closable/u);
});

test("WorkPanel renders Chrome-style outer tabs with mapped icons and focus-aware close controls", () => {
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const appShell = read("src/renderer/app-shell/AppShell.tsx");
  const css = read("src/renderer/styles/app-shell.css");

  for (const icon of [
    "GlobalOutlined",
    "DashboardOutlined",
    "BugOutlined",
    "ProjectOutlined",
    "DiffOutlined",
    "FileTextOutlined",
    "DeploymentUnitOutlined",
    "RobotOutlined",
    "CloseOutlined",
  ]) {
    assert.match(host, new RegExp(icon, "u"));
  }
  assert.match(host, /className="chat-work-panel-tab-trigger"/u);
  assert.match(host, /className="chat-work-panel-tab-close"/u);
  assert.match(host, /closable \? " has-close" : ""/u);
  assert.match(host, /item\.descriptor\.module === "overview"/u);
  assert.match(host, /result\.actionId === "reload"/u);
  assert.match(host, /result\.actionId === "copy-url"/u);
  assert.match(host, /result\.actionId === "toggle-fullscreen"/u);
  assert.match(host, /findItemWebview\(ownerChatId, item\.itemId\)\?\.reload\(\)/u);
  assert.match(host, /normalizeWorkPanelWebUrl\(findItemWebview\(ownerChatId, item\.itemId\)\?\.getURL\(\)\)/u);
  assert.match(host, /work-panel-host\$\{fullscreenOwnerChatId === activeChatId \? " is-fullscreen" : ""\}/u);
  assert.match(host, /const closable = item\.closable && !item\.pinned/u);
  assert.match(host, /onWorkPanelCloseShortcut/u);
  assert.match(host, /data-work-panel-active/u);
  assert.match(css, /\.chat-work-panel-tab:hover \.chat-work-panel-tab-close/u);
  assert.match(css, /\.chat-work-panel-tab:focus-within \.chat-work-panel-tab-close/u);
  assert.match(css, /\.chat-work-panel-tab\.is-overview\s*\{[^}]*flex:\s*0 0 auto;[^}]*width:\s*max-content;[^}]*min-width:\s*max-content;[^}]*max-width:\s*none/su);
  assert.match(css, /\.chat-work-panel-tab-close\s*\{[^}]*position:\s*absolute;[^}]*right:\s*0;[^}]*width:\s*34px/su);
  assert.match(css, /\.chat-work-panel-tab\.has-close:hover \.chat-work-panel-tab-title[^}]*mask-image:\s*linear-gradient/su);
  assert.match(css, /\.app-shell\.has-chat-work-panel \.work-panel-host\.is-fullscreen\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*100%/su);
  assert.match(css, /\.chat-work-panel \.external-webview-browser-chrome\s*\{\s*display:\s*none;/su);
  assert.match(appShell, /WORK_PANEL_WIDTH_STORAGE_KEY/u);
  assert.match(appShell, /role="separator"[\s\S]*chat-work-panel-resizer/u);
  assert.match(appShell, /setPointerCapture\(event\.pointerId\)/u);
  assert.match(appShell, /window\.addEventListener\("pointermove", handlePointerMove, true\)/u);
});
