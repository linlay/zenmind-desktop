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
  assert.match(appShell, /<div className="app-window-controls-layer">\s*\{mainChatWorkPanelToggle\}\s*<\/div>/u);
  assert.match(appShell, /hasPanelToggle=\{activeChatWorkPanelVisible && showMainChatWorkPanelToggle\}/u);
  assert.doesNotMatch(appShell, /LayoutOutlined/u);
  assert.match(appShell, /disabled=\{!activeChatWorkPanelChatId\}/u);
  assert.match(appShell, /createAgentWebclientOverviewPath\(\{ chatId \}\)/u);
  assert.match(appShell, /shouldEnsureOverview/u);
  assert.match(appShell, /pinned: true/u);
  assert.match(appShell, /closable: false/u);
  assert.match(appShell, /type: "hideWorkspace"/u);
  assert.match(appShell, /type: "showWorkspace"/u);
  assert.match(appShell, /activeChatId=\{activeChatWorkPanelVisible \? activeChatWorkPanelChatId : null\}/u);
  assert.match(host, /state\.workspaces\.map/u);
  assert.match(host, /workspace\.items\.map/u);
  assert.match(host, /item\.descriptor\.kind === "webclient"/u);
  assert.match(host, /profile: tabContextMenuProfile\(item\)/u);
  assert.match(host, /<ServiceWebviewSurface/u);
  assert.match(host, /item\.descriptor\.kind === "webclient"[\s\S]*?<ServiceWebviewSurface[\s\S]*?skipContextRegistration[\s\S]*?\/>/u);
  assert.match(host, /<ExternalWebviewPage/u);
  assert.match(host, /case "skill":[\s\S]*?<SafetyCertificateOutlined/u);
  assert.match(
    read("src/renderer/service-webview/ServiceWebviewSurface.tsx"),
    /AGENT_WEBCLIENT_WORK_PANEL_ROLES[\s\S]*?"skill"/u,
  );
  assert.match(host, /hidden=\{!visible\}/u);
  assert.match(host, /visible && hasPanelToggle \? " has-panel-toggle" : ""/u);
  assert.match(reducer, /stableKey:\s*`web:\$\{url\}`/u);
  assert.match(
    read("src/renderer/service-webview/ServiceWebviewSurface.tsx"),
    /AGENT_WEBCLIENT_WORK_PANEL_ROLES[\s\S]*?"overview"/u,
  );
  assert.doesNotMatch(read("src/renderer/service-webview/ServiceWebviewSurface.tsx"), /\/summary\/iu/u);
  assert.match(css, /\.app-shell\.has-chat-work-panel \.work-panel-host\s*\{[^}]*var\(--chat-work-panel-width/su);
  assert.doesNotMatch(css, /\.work-panel-host\s*\{[^}]*display:\s*contents/su);
  assert.match(css, /\.app-shell\.is-mac-platform \.main-chat-work-panel-toggle/u);
  assert.match(css, /\.app-shell\.is-windows-platform \.main-chat-work-panel-toggle/u);
  assert.match(css, /\.app-shell\.is-mac-platform\.has-main-chat-work-panel-toggle\s*\{[^}]*--app-window-drag-right:\s*48px;/su);
  assert.match(css, /\.app-window-controls-layer\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*z-index:\s*1001;[^}]*pointer-events:\s*none;/su);
  assert.match(css, /\.app-window-controls-layer \.main-chat-work-panel-toggle\s*\{[^}]*pointer-events:\s*auto;/su);
  assert.match(css, /\.main-chat-work-panel-toggle:focus-visible/u);
  assert.match(css, /\.main-chat-work-panel-toggle\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border-radius:\s*6px/su);
  assert.match(css, /\.main-chat-work-panel-toggle-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*transform:\s*scaleX\(-1\)/su);
  assert.match(css, /\.chat-work-panel\.has-panel-toggle \.chat-work-panel-tabs\s*\{[^}]*padding-right:\s*46px/su);
  assert.match(css, /\.app-shell webview\s*\{[^}]*-webkit-user-select:\s*none;[^}]*user-select:\s*none;/su);
});

test("WorkPanel actions derive ownership from trusted source and expose the canonical namespace", () => {
  const actions = read("src/shared/desktop-actions.ts");
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const bridge = read("src/main/desktop-action-bridge.ts");

  for (const name of ["getState", "openTab", "openWeb", "refreshWeb", "activateTab", "closeTab", "closeWorkpanel"]) {
    assert.match(actions, new RegExp(`desktop\\.workpanel\\.${name}`, "u"));
  }
  assert.match(host, /request\.source\?\.chatId/u);
  assert.match(host, /case "desktop\.workpanel\.openWeb"[\s\S]*?descriptor: \{ kind: "web", url \}/u);
  assert.match(host, /case "desktop\.workpanel\.refreshWeb"[\s\S]*?candidate\.descriptor\.url === url[\s\S]*?webview\.reload\(\)[\s\S]*?type: "activateItem"/u);
  assert.match(host, /descriptor:\s*\{ kind: "web", url/u);
  assert.match(bridge, /request\.source\?\.chatId/u);
  assert.doesNotMatch(host, /new Map<string, ChatWorkPanelWorkspace>/u);
  assert.match(read("src/renderer/app-shell/navigation/AppSidebar.tsx"), /onCloseChatWorkPanel\?\.\(chat\.chatId, true\)/u);
});

test("WorkPanel enforces one ephemeral Web guest per item and explicit platform focus branches", () => {
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const externalWebview = read("src/renderer/pages/external-webview/ExternalWebviewPage.tsx");
  const reducer = read("src/shared/work-panel.ts");

  assert.match(host, /itemPartition\(workspace\.workspaceId, item\.itemId\)/u);
  assert.match(host, /clearSession\?\.\(\{ partition \}\)/u);
  assert.match(host, /allowUserTabCreation=\{false\}/u);
  assert.match(host, /target !== "work-panel"/u);
  assert.match(host, /type: "openItem"[\s\S]*?descriptor: \{ kind: "web", url: normalizedUrl \}/u);
  assert.match(host, /showLoadingProgress/u);
  assert.match(host, /chat-work-panel-tab-loading-spinner/u);
  assert.match(host, /onLoadingChange/u);
  assert.match(externalWebview, /allowpopups: "true"/u);
  assert.match(externalWebview, /target !== "desktop-browser"/u);
  assert.doesNotMatch(externalWebview, /openPopupsInCurrentTab/u);
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
  assert.match(host, /result\.actionId === "copy-title"/u);
  assert.match(host, /result\.actionId === "download-resource"/u);
  assert.match(host, /result\.actionId === "open-resource-default-app"/u);
  assert.match(host, /AGENT_WEBCLIENT_WORKPANEL_RESOURCE_DOWNLOAD_ACTION/u);
  assert.match(host, /resolveChatWorkPanelLocalResourcePath/u);
  assert.match(host, /openLocalResource/u);
  assert.doesNotMatch(host, /resourceOpenIntentsRef/u);
  assert.doesNotMatch(host, /consumeDesktopDownloadDisposition/u);
  assert.match(host, /result\.actionId === "close-other-tabs"/u);
  assert.match(host, /type: "closeOtherItems"/u);
  assert.match(host, /result\.actionId === "toggle-fullscreen"/u);
  assert.match(host, /findItemWebview\(ownerChatId, item\.itemId\)\?\.reload\(\)/u);
  assert.match(host, /normalizeWorkPanelWebUrl\(findItemWebview\(ownerChatId, item\.itemId\)\?\.getURL\(\)\)/u);
  assert.match(host, /work-panel-host\$\{fullscreenOwnerChatId === activeChatId \? " is-fullscreen" : ""\}/u);
  assert.match(host, /const closable = item\.closable && !item\.pinned/u);
  assert.match(host, /onWorkPanelCloseShortcut/u);
  assert.match(host, /guestId === null/u);
  assert.match(host, /setWorkPanelKeyboardFocusActive/u);
  assert.match(host, /const closableItems = workspace\.items\.filter/u);
  assert.match(host, /type: "closeWorkspace"[\s\S]*?force: true/u);
  assert.match(host, /data-work-panel-active/u);
  assert.match(css, /\.chat-work-panel-tab:hover \.chat-work-panel-tab-close/u);
  assert.match(css, /\.chat-work-panel-tab:focus-within \.chat-work-panel-tab-close/u);
  assert.match(css, /\.chat-work-panel-tab\.is-overview\s*\{[^}]*flex:\s*0 0 auto;[^}]*width:\s*max-content;[^}]*min-width:\s*max-content;[^}]*max-width:\s*none/su);
  assert.match(css, /\.chat-work-panel-tab\s*\{[^}]*flex:\s*0 1 auto;[^}]*width:\s*fit-content;[^}]*min-width:\s*140px;[^}]*max-width:\s*240px/su);
  assert.match(css, /\.chat-work-panel-tab-trigger\s*\{[^}]*padding:\s*0 10px;/su);
  assert.match(css, /\.chat-work-panel-tab-close\s*\{[^}]*position:\s*absolute;[^}]*right:\s*0;[^}]*width:\s*34px/su);
  assert.match(css, /\.chat-work-panel-tab-loading-spinner/u);
  assert.match(css, /\.chat-work-panel-tab\.has-close:hover \.chat-work-panel-tab-title[^}]*mask-image:\s*linear-gradient/su);
  assert.match(css, /\.app-shell\.has-chat-work-panel \.work-panel-host\.is-fullscreen\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*100%/su);
  assert.match(css, /\.chat-work-panel \.external-webview-browser-chrome\s*\{\s*display:\s*none;/su);
  assert.match(appShell, /WORK_PANEL_WIDTH_STORAGE_KEY/u);
  assert.match(appShell, /role="separator"[\s\S]*chat-work-panel-resizer/u);
  assert.match(appShell, /setPointerCapture\(event\.pointerId\)/u);
  assert.match(appShell, /window\.addEventListener\("pointermove", handlePointerMove, true\)/u);
});

test("WorkPanel fullscreen owns native window state and exclusively covers the Desktop shell", () => {
  const appShell = read("src/renderer/app-shell/AppShell.tsx");
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const css = read("src/renderer/styles/app-shell.css");
  const contracts = read("src/shared/contracts/desktop-api.ts");
  const preload = read("src/preload/index.ts");
  const shellHandlers = read("src/main/ipc/shell-handlers.ts");
  const zhCN = read("src/shared/i18n/dictionaries/zhCN.ts");
  const enUS = read("src/shared/i18n/dictionaries/enUS.ts");

  assert.match(contracts, /setWindowFullScreen:\s*\([\s\S]*?enabled: boolean[\s\S]*?isFullScreen: boolean/u);
  assert.match(contracts, /setWorkPanelFullscreenActive: \(active: boolean\) => void/u);
  assert.match(contracts, /onWorkPanelFullscreenExitShortcut: \(listener: \(\) => void\) => \(\) => void/u);
  assert.match(preload, /setWindowFullScreen:\s*\(enabled: boolean\)\s*=>\s*ipcRenderer\.invoke\("desktopShell\.setWindowFullScreen", enabled\)/u);
  assert.match(preload, /ipcRenderer\.send\("desktopShell\.setWorkPanelFullscreenActive", active\)/u);
  assert.match(preload, /ipcRenderer\.on\("app\.workPanelFullscreenExitShortcut", listener\)/u);
  assert.match(shellHandlers, /ipcMain\.handle\("desktopShell\.setWindowFullScreen"/u);
  assert.match(shellHandlers, /ownerWindow !== mainWindow/u);
  assert.match(shellHandlers, /typeof enabled !== "boolean"/u);
  assert.match(shellHandlers, /WINDOW_FULLSCREEN_TRANSITION_TIMEOUT_MS = 3000/u);
  assert.match(shellHandlers, /platform !== "darwin"/u);
  assert.match(shellHandlers, /targetWindow\.once\("enter-full-screen"/u);
  assert.match(shellHandlers, /targetWindow\.once\("leave-full-screen"/u);

  assert.match(appShell, /workPanelEnteredNativeFullscreenRef/u);
  assert.match(appShell, /desktopShell\.getWindowState\(\)/u);
  assert.match(appShell, /desktopShell\.setWindowFullScreen\(true\)/u);
  assert.match(appShell, /desktopShell\.setWindowFullScreen\(false\)/u);
  assert.match(appShell, /desktopShell\.setWorkPanelFullscreenActive/u);
  assert.match(appShell, /!state\.isFullScreen && workPanelFullscreenOwnerChatIdRef\.current/u);
  assert.match(appShell, /workPanelFullscreenOwnerChatId \? "is-work-panel-fullscreen" : ""/u);
  assert.match(appShell, /fullscreenOwnerChatId=\{workPanelFullscreenOwnerChatId\}/u);
  assert.match(appShell, /onFullscreenChange=\{changeWorkPanelFullscreen\}/u);
  assert.match(host, /await onFullscreenChange\(ownerChatId\)/u);
  assert.match(host, /void onFullscreenChange\(null\)/u);
  assert.match(host, /onWorkPanelFullscreenExitShortcut/u);

  assert.match(css, /\.app-shell\.is-work-panel-fullscreen \.app-content\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*z-index:\s*2000;[^}]*margin-right:\s*0;/su);
  assert.match(css, /\.app-shell\.is-work-panel-fullscreen \.app-content > \.app-main,[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/u);
  assert.match(css, /:not\(\.app-content\):not\(\.desktop-action-confirmation-layer\):not\(\.desktop-global-search-layer\):not\(\.desktop-shutdown-overlay\)/u);

  assert.match(zhCN, /"webviewContextMenu\.page\.copy-url": "复制当前地址"/u);
  assert.match(zhCN, /"chatWorkPanel\.tabContextMenu\.enterFullscreen": "全屏显示"/u);
  assert.match(enUS, /"webviewContextMenu\.page\.copy-url": "Copy Current Address"/u);
  assert.match(enUS, /"chatWorkPanel\.tabContextMenu\.enterFullscreen": "Full Screen"/u);
});

test("WorkPanel close shortcut focus ownership is wired across renderer preload and main", () => {
  const contracts = read("src/shared/contracts/desktop-api.ts");
  const preload = read("src/preload/index.ts");
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const shellHandlers = read("src/main/ipc/shell-handlers.ts");
  const mainContext = read("src/main/main-process-context.ts");
  const windowManager = read("src/main/window-manager.ts");
  const runtime = read("src/main/app-shell/runtime.ts");

  assert.match(contracts, /DesktopWorkPanelCloseShortcutRequest = \{[\s\S]*?guestId: number \| null;[\s\S]*?fallbackToWindowClose\?: boolean;[\s\S]*?workPanelFocused\?: boolean;/u);
  assert.match(contracts, /setWorkPanelKeyboardFocusActive: \(active: boolean\) => void/u);
  assert.match(contracts, /requestWindowClose: \(\) => void/u);
  assert.match(preload, /desktopShell\.setWorkPanelKeyboardFocusActive/u);
  assert.match(preload, /desktopShell\.requestWindowClose/u);
  assert.match(host, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/u);
  assert.match(host, /root\.addEventListener\("focusin", handleFocusIn, true\)/u);
  assert.match(host, /publishFocusState\(false\)/u);
  assert.match(shellHandlers, /getMainWindow\?\.\(\) \?\? options\.mainWindow/u);
  assert.match(shellHandlers, /ownerWindow !== mainWindow/u);
  assert.match(shellHandlers, /ipcMain\.on\("desktopShell\.requestWindowClose"/u);
  assert.match(mainContext, /getMainWindow: \(\) => context\.state\.mainWindow/u);
  assert.match(windowManager, /isWorkPanelKeyboardFocusActive\?\.\(\) === true/u);
  assert.match(windowManager, /app\.workPanelCloseShortcut"[\s\S]*?guestId: null,[\s\S]*?workPanelFocused: true/u);
  assert.match(runtime, /isWorkPanelKeyboardFocusActive: \(\) => options\.state\.workPanelKeyboardFocusActive/u);
  assert.match(runtime, /fallbackToWindowClose: true/u);
  assert.match(runtime, /workPanelFocused: options\.state\.workPanelKeyboardFocusActive/u);
  assert.match(host, /workPanelFocused && activeChatId/u);
  assert.match(host, /else if \(fallbackToWindowClose\)/u);
});
