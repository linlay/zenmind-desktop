import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

test("renderer entry uses HashRouter for Electron routing", () => {
  const rendererEntry = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "main.tsx"),
    "utf8"
  );

  assert.match(rendererEntry, /HashRouter/);
  assert.doesNotMatch(rendererEntry, /BrowserRouter/);
});

test("sidebar does not expose the built-in Chrome surface", () => {
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AppSidebar.tsx"),
    "utf8"
  );

  assert.doesNotMatch(sidebarSource, /browserNavItem/);
  assert.doesNotMatch(sidebarSource, /BUILTIN_BROWSER_ROUTE/);
});

test("assistant launcher sits beside settings in the sidebar footer", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AppSidebar.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const nativeAssistantDockPath = path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx");

  assert.equal(fs.existsSync(nativeAssistantDockPath), false);
  assert.match(appShell, /function AgentWebclientCopilotDock/);
  assert.match(appShell, /onOpenAssistantDock=\{\(\) => openAssistantDock\(\)\}/);
  assert.match(appShell, /embedPath=\{AGENT_WEBCLIENT_COPILOT_PATH\}/);
  assert.match(sidebarSource, /sidebar-footer-actions/);
  assert.match(sidebarSource, /sidebar-assistant-launcher/);
  assert.match(sidebarSource, /"打开 ZenMind 助手"/);
  assert.match(sidebarSource, /"当前页面不可开启 ZenMind 助手"/);
  assert.match(globalStyles, /--assistant-dock-embedded-width:\s*360px;/);
  assert.match(globalStyles, /\.agent-webclient-copilot-dock\s*\{/);
  assert.doesNotMatch(globalStyles, /\.assistant-dock-/);
  assert.match(globalStyles, /\.sidebar-footer-actions\s*\{[\s\S]*?display:\s*flex;/);
});

test("agent webclient desktop sections are exposed as top-level sidebar tabs", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AppSidebar.tsx"),
    "utf8"
  );
  const pluginPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginPage.tsx"),
    "utf8"
  );

  assert.match(sidebarSource, /agentWebclientNavItems/);
  assert.match(sidebarSource, /to:\s*"\/agents"[\s\S]*?label:\s*"智能体"/);
  assert.match(sidebarSource, /to:\s*"\/schedules"[\s\S]*?label:\s*"自动化"/);
  assert.match(sidebarSource, /to:\s*"\/memory"[\s\S]*?label:\s*"记忆管理"/);
  assert.match(
    sidebarSource,
    /const navItems = \[[\s\S]*?assistantNavItem,[\s\S]*?\.\.\.agentWebclientNavItems,[\s\S]*?staticNavItems\[0\]/
  );

  assert.match(appShell, /AGENT_WEBCLIENT_ROUTE_ITEMS/);
  assert.match(appShell, /routePath:\s*"\/agents"[\s\S]*?embedPath:\s*"\/agents"[\s\S]*?label:\s*"智能体"/);
  assert.match(appShell, /routePath:\s*"\/schedules"[\s\S]*?embedPath:\s*"\/schedules"[\s\S]*?label:\s*"自动化"/);
  assert.match(appShell, /routePath:\s*"\/memory"[\s\S]*?embedPath:\s*"\/memory"[\s\S]*?label:\s*"记忆管理"/);
  assert.match(appShell, /const activeAgentWebclientRoute = resolveAgentWebclientRoute\(location\.pathname\)/);
  assert.match(appShell, /activeAgentWebclientRoute[\s\S]*?\? "agent-webclient"[\s\S]*?: resolvePluginRouteId\(location\.pathname\)/);
  assert.match(appShell, /const usesEmbeddedSurface =[\s\S]*?Boolean\(activeAgentWebclientRoute\)/);
  assert.match(appShell, /const usesPluginSurface = Boolean\(activeAgentWebclientRoute\) \|\| location\.pathname\.startsWith\("\/plugin\/"\)/);
  assert.match(appShell, /<Route path="\/agents" element=\{null\} \/>/);
  assert.match(appShell, /<Route path="\/schedules" element=\{null\} \/>/);
  assert.match(appShell, /<Route path="\/memory" element=\{null\} \/>/);
  assert.doesNotMatch(appShell, /path="\/agents"[\s\S]{0,180}<PlaceholderPage/);

  assert.match(pluginPage, /embedPath\?: string;/);
  assert.match(pluginPage, /surfaceLabel\?: string;/);
  assert.match(pluginPage, /embedPath: service\?\.id === "agent-webclient" \? embedPath : undefined/);
});

test("settings page configures desktop helper default agent separately from desktop pet", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );
  const sharedSettings = fs.readFileSync(
    path.join(projectRoot, "src", "shared", "assistant-settings.ts"),
    "utf8"
  );
  const settingsStore = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "settings-store.ts"),
    "utf8"
  );

  assert.match(sharedSettings, /DEFAULT_DESKTOP_HELPER_AGENT_KEY\s*=\s*"desktopAssistant"/);
  assert.match(sharedSettings, /DEFAULT_QUICK_ASSISTANT_ENABLED\s*=\s*true/);
  assert.match(sharedSettings, /DEFAULT_QUICK_ASSISTANT_AGENT_KEY\s*=\s*DEFAULT_DESKTOP_HELPER_AGENT_KEY/);
  assert.match(sharedSettings, /DESKTOP_COPILOT_PAGE_KEYS/);
  assert.match(sharedSettings, /controlCenter/);
  assert.match(sharedSettings, /schedules/);
  assert.match(settingsStore, /desktopHelperAgentKey:\s*settings\.desktopHelperAgentKey/);
  assert.match(settingsStore, /quickAssistantEnabled:\s*settings\.quickAssistantEnabled/);
  assert.match(settingsStore, /quickAssistantAgentKey:\s*settings\.quickAssistantAgentKey/);
  assert.match(settingsStore, /desktopCopilotPages:\s*settings\.desktopCopilotPages/);
  assert.match(settingsPage, /DESKTOP ASSISTANT/);
  assert.match(settingsPage, /快捷助手/);
  assert.match(settingsPage, /quickAssistantEnabled/);
  assert.match(settingsPage, /quickAssistantAgentKey/);
  assert.match(settingsPage, /handleToggleQuickAssistantEnabled/);
  assert.match(settingsPage, /handleSelectQuickAssistantAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*quickAssistantAgentKey: normalizedAgentKey\s*\}\)/);
  assert.match(settingsPage, /页面 Copilot/);
  assert.match(settingsPage, /DESKTOP_COPILOT_PAGE_KEYS\.map/);
  assert.match(settingsPage, /handleToggleCopilotPage/);
  assert.match(settingsPage, /handleSelectCopilotAgent/);
  assert.match(settingsPage, /handleSelectDesktopHelperAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*desktopHelperAgentKey: normalizedAgentKey\s*\}\)/);
  assert.match(settingsPage, /desktopCopilotPages: nextPages/);
  assert.match(settingsPage, /这个设置不影响桌面宠物绑定/);
});

test("page-level copilot controls sidebar visibility and assistant agent following", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AppSidebar.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const resolver = fs.readFileSync(path.join(projectRoot, "src", "shared", "page-copilot.ts"), "utf8");

  assert.match(resolver, /resolveDesktopCopilotPageKey/);
  assert.match(resolver, /"\/control-center"[\s\S]*?"controlCenter"/);
  assert.match(resolver, /"\/memory"[\s\S]*?"memory"/);
  assert.match(appShell, /resolveDesktopCopilotPreference/);
  assert.match(appShell, /assistantLauncherVisible = currentCopilotPreference\?\.enabled !== false/);
  assert.match(appShell, /currentCopilotPreference\?\.enabled === false && assistantDockOpen && !assistantRunningRunId/);
  assert.match(appShell, /isAgentWebclientMainRoute = location\.pathname === ASSISTANT_TARGET_PATH/);
  assert.match(appShell, /assistantCopilotOpen = assistantDockOpen && !isAgentWebclientMainRoute/);
  assert.match(appShell, /isAgentWebclientMainRoute && assistantDockOpen/);
  assert.match(appShell, /assistantLauncherDisabled=\{isAgentWebclientMainRoute\}/);
  assert.match(appShell, /open=\{assistantCopilotOpen\}/);
  assert.match(appShell, /assistantLauncherVisible=\{assistantLauncherVisible\}/);
  assert.match(appShell, /onRunningRunIdChange=\{setAssistantRunningRunId\}/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.match(appShell, /data-open-agent-key=\{openRequest\?\.agentKey \?\? openRequest\?\.workerKey \?\? ""\}/);
  assert.match(sidebarSource, /assistantLauncherVisible/);
  assert.match(sidebarSource, /assistantLauncherDisabled/);
  assert.match(sidebarSource, /assistantLauncherVisible \? \(/);
  assert.match(sidebarSource, /sidebar-assistant-switch/);
  assert.match(sidebarSource, /assistantDockOpen \? "is-switch-on" : ""/);
  assert.doesNotMatch(sidebarSource, /assistantDockOpen \? "sidebar-link-active" : ""/);
  assert.match(sidebarSource, /disabled=\{assistantLauncherDisabled\}/);
  assert.match(globalStyles, /\.sidebar-assistant-switch\s*\{/);
  assert.match(globalStyles, /\.sidebar-assistant-launcher\.is-disabled/);
  assert.match(globalStyles, /\.app-sidebar\.is-collapsed \.sidebar-assistant-switch/);
});

test("desktop action bridge exposes localhost api and renderer action providers", () => {
  const actionCatalog = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-actions.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");
  const registry = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "services", "desktopActionRegistry.ts"),
    "utf8"
  );
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "ExternalWebviewPage.tsx"),
    "utf8"
  );
  const marketPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginMarketPage.tsx"),
    "utf8"
  );

  assert.match(actionCatalog, /DESKTOP_ACTION_BRIDGE_HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(actionCatalog, /DESKTOP_ACTION_BRIDGE_PORT\s*=\s*11788/);
  assert.match(actionCatalog, /desktop\.controlCenter\.listServices/);
  assert.match(actionCatalog, /desktop\.settings\.applyPatch/);
  assert.match(actionCatalog, /desktop\.embeddedWeb\.getActiveSurface/);
  assert.match(actionCatalog, /desktop\.embeddedWeb\.openTab/);
  assert.match(actionCatalog, /desktop\.market\.applySettingsPatch/);
  assert.match(actionCatalog, /desktop\.automations\.listSchedules/);
  assert.doesNotMatch(actionCatalog, /desktop\.memory\./);
  assert.match(bridge, /GET" && url\.pathname === "\/health"/);
  assert.match(bridge, /GET" && url\.pathname === "\/actions"/);
  assert.match(bridge, /POST" && url\.pathname === "\/actions\/call"/);
  assert.match(bridge, /Content-Type must be application\/json/);
  assert.match(bridge, /isLocalhostRequest/);
  assert.match(bridge, /confirmMutatingAction/);
  assert.match(mainProcess, /startDesktopActionBridge\(\{/);
  assert.match(mainProcess, /desktopActions\.respond/);
  assert.match(mainProcess, /desktopActions\.call/);
  assert.match(preload, /desktopActions:\s*\{/);
  assert.match(preload, /ipcRenderer\.invoke\("desktopActions\.respond"/);
  assert.match(preload, /ipcRenderer\.on\("desktopActions\.call"/);
  assert.match(contracts, /DesktopActionRendererRequest/);
  assert.match(contracts, /DesktopActionCallListener/);
  assert.match(registry, /DesktopActionProviderScope = "global" \| "page" \| "embeddedWeb"/);
  assert.match(registry, /registerDesktopActionProviderForScope/);
  assert.match(registry, /embedded_web_action_unavailable/);
  assert.match(registry, /registerDesktopActionProvider/);
  assert.match(registry, /page_action_unavailable/);
  assert.match(appShell, /startDesktopActionRendererBridge\(\)/);
  assert.match(appShell, /registerDesktopActionProviderForScope\("global"/);
  assert.match(appShell, /desktop\.settings\.getState/);
  assert.match(appShell, /desktop\.embeddedWeb\.listSurfaces/);
  assert.match(settingsPage, /registerDesktopActionProvider/);
  assert.match(settingsPage, /desktopHelperAgentKey/);
  assert.match(externalWebviewPage, /registerDesktopActionProviderForScope\("embeddedWeb"/);
  assert.match(externalWebviewPage, /desktop\.embeddedWeb\.getPageContext/);
  assert.match(externalWebviewPage, /desktop\.embeddedWeb\.navigate/);
  assert.match(externalWebviewPage, /desktop\.embeddedWeb\.closeTab/);
  assert.doesNotMatch(externalWebviewPage, /querySelector\(request/);
  assert.match(marketPage, /registerDesktopActionProvider/);
  assert.match(marketPage, /skillsApiBaseUrl/);
});

test("built index uses relative asset paths", () => {
  const builtIndex = fs.readFileSync(path.join(projectRoot, "dist-renderer", "index.html"), "utf8");

  assert.doesNotMatch(builtIndex, /src="\/assets\//);
  assert.doesNotMatch(builtIndex, /href="\/assets\//);
  assert.match(builtIndex, /(src|href)="\.?\/?assets\//);
});

test("plugin market guards stale preload market api before skill import", () => {
  const marketPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginMarketPage.tsx"),
    "utf8"
  );
  const marketStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginMarketPage.css"),
    "utf8"
  );

  assert.match(marketPage, /function getMarketApi\(/);
  assert.match(marketPage, /function getPluginApi\(/);
  assert.match(marketPage, /MARKET_API_UNAVAILABLE_MESSAGE/);
  assert.match(marketPage, /PLUGIN_API_UNAVAILABLE_MESSAGE/);
  assert.match(marketPage, /getMarketMethod\("getSettings"\)/);
  assert.match(marketPage, /getMarketMethod\("saveSettings"\)/);
  assert.match(marketPage, /market-api-config/);
  assert.match(marketPage, /保存地址/);
  assert.match(marketPage, /console\.warn\("\[market-page\] failed to load market data"/);
  assert.doesNotMatch(marketPage, /window\.electronAPI\.market\.importSkill\(\)/);
  assert.doesNotMatch(marketPage, /installPlugin\(\)/);
  assert.doesNotMatch(marketPage, /market-feedback/);
  assert.doesNotMatch(marketStyles, /\.market-feedback/);
  assert.match(marketStyles, /\.market-api-config/);
  assert.match(marketStyles, /\.market-status/);
});

test("market route disables the global drag overlay above toolbar controls", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const marketStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginMarketPage.css"),
    "utf8"
  );

  assert.match(appShell, /has-market-controls/);
  assert.match(globalStyles, /\.app-shell\.has-market-controls\s+\.app-window-drag-region/);
  assert.match(marketStyles, /-webkit-app-region:\s*no-drag;/);
});

test("plugin embedded route keeps a mac window drag lane clear of iframe controls", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(appShell, /usesPluginSurface/);
  assert.match(appShell, /has-plugin-surface/);
  assert.match(
    globalStyles,
    /\.app-shell\.is-mac-platform\.has-plugin-surface\s+\.app-window-drag-region\s*\{[\s\S]*?display:\s*block;[\s\S]*?left:\s*calc\(var\(--app-sidebar-width,\s*160px\)\s*\+\s*280px\);[\s\S]*?right:\s*184px;[\s\S]*?height:\s*34px;/
  );
  assert.match(
    globalStyles,
    /\.app-shell\.is-mac-platform\.has-plugin-surface\.has-assistant-dock-full\s+\.app-window-drag-region\s*\{[\s\S]*?right:\s*calc\(var\(--assistant-dock-embedded-width\)\s*\+\s*184px\);/
  );
});

test("desktop shell starts window drag from non-interactive mac regions", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");

  assert.match(appShell, /WINDOW_DRAG_EXCLUDED_SELECTOR/);
  assert.match(appShell, /"iframe"/);
  assert.match(appShell, /"webview"/);
  assert.match(appShell, /"\.app-sidebar-collapse-button"/);
  assert.match(appShell, /onPointerDownCapture=\{handleDesktopWindowPointerDown\}/);
  assert.match(appShell, /window\.electronAPI\.windowDrag\.begin/);
  assert.match(preload, /windowDrag:\s*\{[\s\S]*?ipcRenderer\.invoke\("windowDrag\.begin"/);
  assert.match(contracts, /windowDrag:\s*\{[\s\S]*?begin:\s*\(point:\s*\{\s*x:\s*number;\s*y:\s*number\s*\}/);
  assert.match(mainProcess, /MAIN_WINDOW_DRAG_FORCE_END_MS/);
  assert.match(mainProcess, /process\.platform !== "darwin"[\s\S]*?return \{ ok: false \};/);
  assert.match(mainProcess, /ipcMain\.handle\("windowDrag\.begin"/);
});

test("mac fullscreen forces the main window to an opaque background", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(mainProcess, /let mainWindowSidebarTranslucencyEnabled = false;/);
  assert.match(mainProcess, /function applyMainWindowAppearance\(targetWindow: BrowserWindow \| null\)/);
  assert.match(
    mainProcess,
    /if \(process\.platform === "darwin"\)\s*\{[\s\S]*?mainWindowSidebarTranslucencyEnabled && !targetWindow\.isFullScreen\(\);[\s\S]*?targetWindow\.setVibrancy\(useSidebarTranslucency \? "under-window" : null\);[\s\S]*?targetWindow\.setBackgroundColor\(useSidebarTranslucency \? "#00000000" : "#FFFFFF"\);/
  );
  assert.match(mainProcess, /if \(process\.platform === "win32"\)\s*\{[\s\S]*?targetWindow\.setBackgroundColor\("#FFFFFF"\);[\s\S]*?return;[\s\S]*?\}/);
  assert.match(mainProcess, /mainWindow\.on\("enter-full-screen", \(\) => \{[\s\S]*?applyMainWindowAppearance\(mainWindow\);[\s\S]*?\}\);/);
  assert.match(mainProcess, /mainWindow\.on\("leave-full-screen", \(\) => \{[\s\S]*?applyMainWindowAppearance\(mainWindow\);[\s\S]*?\}\);/);
});

test("main process keeps app identity visible in platform program bars", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(mainProcess, /const ZENMIND_APP_ID = "cc\.zenmind\.desktop";/);
  assert.match(mainProcess, /const ZENMIND_PRODUCT_NAME = "ZenMind";/);
  assert.match(mainProcess, /app\.setName\(ZENMIND_PRODUCT_NAME\);/);
  assert.match(
    mainProcess,
    /if \(process\.platform === "win32"\)\s*\{[\s\S]*?app\.setAppUserModelId\(ZENMIND_APP_ID\);[\s\S]*?\}/
  );
  assert.match(mainProcess, /function ensureDarwinDockIdentity\(\)/);
  assert.match(
    mainProcess,
    /if \(process\.platform !== "darwin"\)\s*\{[\s\S]*?return;[\s\S]*?\}/
  );
  assert.match(mainProcess, /app\.setActivationPolicy\("regular"\);/);
  assert.match(mainProcess, /dock\.show\(\)\.catch/);
  assert.match(mainProcess, /ensureDarwinDockIdentity\(\);[\s\S]*?const targetWindow = getMainWindowForActivation\(\);/);
});

test("external webview tabs use repeatable pointer reordering", () => {
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "ExternalWebviewPage.tsx"),
    "utf8"
  );

  assert.match(externalWebviewPage, /tabPointerDragRef/);
  assert.match(externalWebviewPage, /tabPointerCleanupRef/);
  assert.match(externalWebviewPage, /handleTabPointerMove/);
  assert.match(externalWebviewPage, /document\.addEventListener\("pointermove"/);
  assert.match(externalWebviewPage, /setTabDragOffsetX/);
  assert.match(externalWebviewPage, /moveItemByIdToIndex\(\s*currentState\.tabs/);
  assert.match(externalWebviewPage, /onPointerMove=\{handleTabPointerMove\}/);
  assert.match(externalWebviewPage, /onPointerDown=\{\(event\) => handleTabPointerDown\(event, tab\.id\)\}/);
  assert.doesNotMatch(externalWebviewPage, /onDragStart=\{\(event\) => handleTabDragStart\(event, tab\.id\)\}/);
});

test("external webview bookmarks use document-level pointer reordering", () => {
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "ExternalWebviewPage.tsx"),
    "utf8"
  );

  assert.match(externalWebviewPage, /bookmarkPointerCleanupRef/);
  assert.match(externalWebviewPage, /updateBookmarkPointerDrag/);
  assert.match(externalWebviewPage, /document\.addEventListener\("pointermove", handleDocumentPointerMove/);
  assert.match(externalWebviewPage, /moveItemByIdToIndex\(\s*currentBookmarks/);
  assert.match(externalWebviewPage, /onPointerDown=\{\(event\) => handleBookmarkPointerDown\(event, bookmark\.id\)\}/);
});

test("assistant artifact outputs render in a ZenMind-style dock above the composer", () => {
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(quickAssistant, /quick-artifact-dock/);
  assert.doesNotMatch(quickAssistant, /quick-message-artifact-card/);
  assert.match(globalStyles, /\.quick-artifact-dock/);
});

test("sidebar and quick assistant share ZenMind identity and active-chat event recovery", () => {
  const assistantCapabilities = fs.readFileSync(
    path.join(projectRoot, "src", "shared", "assistant-capabilities.ts"),
    "utf8"
  );
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  const assistantEventState = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "services", "assistantEventState.ts"),
    "utf8"
  );
  const assistantArtifacts = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "services", "assistantArtifacts.ts"),
    "utf8"
  );
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(assistantCapabilities, /ZENMIND_ASSISTANT_AGENT_KEY = "zenmind"/);
  assert.match(assistantCapabilities, /ZENMIND_ASSISTANT_NAME = "ZenMind"/);
  assert.match(assistantCapabilities, /侧边栏和快速助手中作为同一个本地单智能体/);
  assert.match(quickAssistant, /function ZenMindMarkIcon/);
  assert.match(quickAssistant, /placeholder="问问 ZenMind"/);
  assert.match(quickAssistant, /你可以直接问 ZenMind/);
  assert.match(mainProcess, /displayName:\s*"ZenMind"/);
  assert.doesNotMatch(assistantCapabilities, /Zman|小宅|desktop-xiaozhai/);
  assert.doesNotMatch(quickAssistant, /Zman|ZmanMarkIcon|desktop-xiaozhai|ZenMind助手/);

  assert.match(assistantEventState, /function getLatestPendingAwaitingPayload/);
  assert.match(assistantEventState, /function attachRunningAssistantPlaceholder/);
  assert.match(assistantEventState, /function mergeOptimisticRunMessages/);
  assert.match(assistantEventState, /function getVisibleAssistantMessages/);
  assert.match(assistantEventState, /function shouldEnsureAssistantMessageForEvent/);
  assert.match(assistantEventState, /ASSISTANT_RUN_EVENT_TYPES/);
  assert.match(assistantEventState, /function reduceAssistantTimelineEvent/);
  assert.doesNotMatch(assistantEventState, /tool\.verify|tool\.route|voice\.transcribed|voice\.corrected|voice\.needs_review|intent\.classified/);
  assert.match(assistantArtifacts, /function getArtifactAttachmentsFromEvent/);
  assert.match(quickAssistant, /isStructuredAssistantEvent/);
  assert.match(quickAssistant, /mergeOptimisticRunMessages/);
  assert.match(quickAssistant, /getVisibleAssistantMessages/);
  assert.match(quickAssistant, /quickAssistant\.openMainAssistant\(event\.chatId\)/);
});

test("web copilot dock yields to native dialogs while quick assistant keeps outside-dismiss handling", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const quickAssistantBlurHandler = mainProcess.slice(
    mainProcess.indexOf('quickAssistantWindow.on("blur"'),
    mainProcess.indexOf('quickAssistantWindow.on("closed"')
  );

  assert.match(mainProcess, /app\.nativeDialogVisibility/);
  assert.match(mainProcess, /process\.platform === "darwin"/);
  assert.match(mainProcess, /hideQuickAssistantForNativeDialog/);
  assert.match(mainProcess, /restoreQuickAssistantAfterNativeDialog/);
  assert.match(mainProcess, /hideQuickAssistantAfterOutsideFocus/);
  assert.match(mainProcess, /app\.on\("activate"[\s\S]{0,120}nativeDialogVisibilityDepth > 0[\s\S]{0,80}return;/);
  assert.match(mainProcess, /quickAssistantDismissWindow/);
  assert.match(mainProcess, /QUICK_ASSISTANT_DISMISS_URL/);
  assert.match(mainProcess, /showQuickAssistantDismissWindow/);
  assert.doesNotMatch(quickAssistantBlurHandler, /mouseInside/);
  assert.match(preload, /onNativeDialogVisibility/);
  assert.match(appShell, /nativeDialogVisible/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.match(appShell, /nativeDialogVisible=\{nativeDialogVisible\}/);
  assert.match(globalStyles, /\.agent-webclient-copilot-dock\.is-native-dialog-open/);
});

test("plugin page provides iframe-aware assistant context instead of guessing embedded content", () => {
  const pluginPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginPage.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(pluginPage, /registerAssistantPageContextProvider/);
  assert.match(pluginPage, /tryReadPluginIframePageContext/);
  assert.match(pluginPage, /buildPluginIframeFallbackContext/);
  assert.match(pluginPage, /无法直接读取这个 iframe 内部的列表、卡片或正文文本/);
  assert.match(pluginPage, /不要猜测网站、应用名称或列表项/);
  assert.match(pluginPage, /const iframeRenderKey = useMemo/);
  assert.doesNotMatch(pluginPage, /iframeInstanceKey/);
  assert.doesNotMatch(pluginPage, /iframeLoaded/);
  assert.doesNotMatch(pluginPage, /正在等待页面样式与资源加载完成/);
  assert.match(pluginPage, /frameLoadedChromeErrorPage/);
  assert.match(pluginPage, /chrome-error:\/\//);
  assert.match(pluginPage, /setIframeRetryNonce/);
  assert.match(pluginPage, /refreshServices/);
  assert.match(pluginPage, /embedded-plugin-error/);
  assert.match(globalStyles, /\.embedded-plugin-error\s*\{/);
});

test("assistant entrypoints restore core services before opening embedded webclient", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(mainProcess, /async function ensureAssistantTargetServicesRunning/);
  assert.match(mainProcess, /for \(const serviceId of STARTUP_RESTORE_SERVICE_ORDER\)/);
  assert.match(mainProcess, /await runServiceMutation\(\(\) => ensureAssistantTargetServicesRunning\(source\)\)/);
  assert.match(mainProcess, /async function showAssistantTargetWindow/);
  assert.match(mainProcess, /AGENT_WEBCLIENT_APP_PATHNAMES = new Set\(\["\/", "\/copilot"\]\)/);
  assert.match(mainProcess, /async function openAssistantFromDesktopPet/);
  assert.match(mainProcess, /await showAssistantTargetWindow\("desktop-pet"\)/);
  assert.match(mainProcess, /targetWindow\.webContents\.send\("app\.openAssistantWorker"/);
  assert.match(mainProcess, /async function openAssistantWorker/);
  assert.match(mainProcess, /await showAssistantTargetWindow\("assistant-worker"\)/);
  assert.match(mainProcess, /scheduleAgentWebclientOpenRequest\(targetWindow/);
  assert.match(mainProcess, /void showAssistantTargetWindow\("tray-click"\)/);
  assert.doesNotMatch(mainProcess, /tray\.on\("click", \(\) => showMainWindow\(ASSISTANT_TARGET_PATH\)\)/);
});

test("native assistant page context captures shell sidebar, left region, and modal content separately", () => {
  const pageContextService = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "services", "assistantPageContext.ts"),
    "utf8"
  );

  assert.match(pageContextService, /shellSidebarText/);
  assert.match(pageContextService, /leftRegionText/);
  assert.match(pageContextService, /modalText/);
  assert.match(pageContextService, /\.service-sider/);
  assert.match(pageContextService, /\.help-sidebar/);
  assert.doesNotMatch(pageContextService, /\.log-viewer-modal/);
  assert.doesNotMatch(pageContextService, /\.log-viewer-backdrop/);
  assert.match(pageContextService, /\[hidden\]/);
  assert.match(pageContextService, /\[aria-hidden="true"\]/);
  assert.match(pageContextService, /iframe/);
  assert.match(pageContextService, /webview/);
});

test("service logs open in a separate floating log viewer window", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const controlCenter = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "ControlCenterPage.tsx"),
    "utf8"
  );
  const logViewerPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "LogViewerPage.tsx"),
    "utf8"
  );

  assert.match(mainProcess, /let logViewerWindow: BrowserWindow \| null = null/);
  assert.match(mainProcess, /function createLogViewerWindow\(\)/);
  assert.match(mainProcess, /services\.openLogViewer/);
  assert.match(mainProcess, /loadRendererRoute\(targetWindow, routePath\)/);
  assert.match(mainProcess, /process\.platform === "darwin"[\s\S]{0,500}setAlwaysOnTop\(true, "floating"\)/);
  assert.match(mainProcess, /process\.platform === "win32"[\s\S]{0,500}setAlwaysOnTop\(true, "pop-up-menu"\)/);
  assert.match(preload, /openLogViewer/);
  assert.match(preload, /closeLogViewer/);
  assert.match(contracts, /ServiceOpenLogViewerRequest/);
  assert.match(appShell, /location\.pathname === "\/log-viewer"/);
  assert.match(controlCenter, /window\.electronAPI\.services\.openLogViewer/);
  assert.doesNotMatch(controlCenter, /LogViewerModal/);
  assert.doesNotMatch(controlCenter, /log-viewer-backdrop/);
  assert.match(logViewerPage, /isMacFindShortcut/);
  assert.match(logViewerPage, /isWindowsFindShortcut/);
  assert.match(logViewerPage, /setSearchVisible\(true\)/);
  assert.match(logViewerPage, /closeLogViewer/);
  assert.doesNotMatch(logViewerPage, /event\.key === "Escape"/);
});

test("assistant dock opens the agent webclient copilot in right-side embedded mode", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");

  assert.match(appShell, /const AGENT_WEBCLIENT_COPILOT_PATH = "\/copilot"/);
  assert.match(appShell, /assistantCopilotOpen \? "has-assistant-dock-full" : ""/);
  assert.match(appShell, /window\.electronAPI\.onOpenAssistantWorker[\s\S]{0,180}openAssistantDock\(\)/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.doesNotMatch(appShell, /<AssistantDock/);
  assert.doesNotMatch(appShell, /openAssistantDock\("compact"\)/);
  assert.doesNotMatch(appShell, /onOpenAssistantWorker[\s\S]{0,180}openAssistantDock\("compact"\)/);
});

test("option-space quick assistant route opens the agent webclient copilot surface", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const quickAssistantWindow = fs.readFileSync(path.join(projectRoot, "src", "main", "quick-assistant.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");

  assert.match(appShell, /function QuickAssistantWebCopilot/);
  assert.match(appShell, /location\.pathname === "\/quick-assistant"[\s\S]{0,180}<QuickAssistantWebCopilot \/>/);
  assert.match(appShell, /embedPath=\{AGENT_WEBCLIENT_COPILOT_PATH\}/);
  assert.match(appShell, /pluginId="agent-webclient"/);
  assert.match(appShell, /quickAssistantAgentKey/);
  assert.match(appShell, /data-open-agent-key=\{quickAssistantAgentKey\}/);
  assert.match(appShell, /quickAssistant\.openControlCenter/);
  assert.match(globalStyles, /\.quick-web-copilot\s*,/);
  assert.match(globalStyles, /\.quick-web-copilot-status/);
  assert.match(mainProcess, /getQuickAssistantWebCopilotBounds/);
  assert.match(mainProcess, /readAssistantSettings\(app\)/);
  assert.match(mainProcess, /!quickSettings\.quickAssistantEnabled/);
  assert.match(mainProcess, /ensureAssistantTargetServicesRunning\("quick-assistant"\)/);
  assert.match(mainProcess, /agentKey:\s*quickSettings\.quickAssistantAgentKey/);
  assert.match(mainProcess, /for \(const targetWindow of \[mainWindow, quickAssistantWindow\]\)/);
  assert.doesNotMatch(mainProcess, /function showQuickAssistantWindow\(\)[\s\S]{0,500}requestQuickAssistantCompactMode/);
  assert.match(quickAssistantWindow, /QUICK_ASSISTANT_WEB_COPILOT_SIZE/);
  assert.match(preload, /openControlCenter/);
  assert.match(contracts, /openControlCenter/);
});

test("quick assistant popup keeps ask and voice recovery controls visible", () => {
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const quickAssistantWindow = fs.readFileSync(path.join(projectRoot, "src", "main", "quick-assistant.ts"), "utf8");

  assert.match(quickAssistant, /function handleStopRun/);
  assert.match(quickAssistant, /voiceOperationIdRef/);
  assert.match(quickAssistant, /withVoiceTimeout/);
  assert.match(quickAssistant, /const hasDraft = draft\.trim\(\)\.length > 0/);
  assert.match(quickAssistant, /const singleLineComposer = !voiceExpandedComposer && !currentComposerHasStatus/);
  assert.match(quickAssistant, /const maxHeight = hasDraft && \(isExpanded \|\| voiceExpandedComposer\) \? 160 : singleLineComposer \? 42 : 46/);
  assert.ok(
    quickAssistant.indexOf("const attachmentMenuDisabled =") <
      quickAssistant.indexOf("}, [attachmentMenuDisabled]);")
  );
  assert.match(quickAssistant, /aria-live="polite"/);
  assert.match(quickAssistant, /<StopIcon \/>/);
  assert.doesNotMatch(quickAssistant, /voiceState === "transcribing"[\s\S]{0,260}new MediaRecorder/);
  assert.match(globalStyles, /\.quick-composer-status/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\s+\.quick-send-button/);
  assert.match(quickAssistantWindow, /QUICK_ASSISTANT_COMPACT_MENU_SIZE/);
  assert.match(quickAssistantWindow, /QUICK_ASSISTANT_MENU_SIZE/);
  assert.match(quickAssistantWindow, /QuickAssistantDisplayMode = "compact" \| "attachment" \| "compactMenu" \| "menu" \| "expanded"/);
  assert.match(preload, /"compact" \| "attachment" \| "compactMenu" \| "menu" \| "expanded"/);
  assert.match(mainProcess, /devTools:\s*false/);
});

test("assistant voice UI no longer exposes a correction toggle and temporarily skips correction requests", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  assert.doesNotMatch(settingsPage, /语音模型纠错/);
  assert.doesNotMatch(settingsPage, /handleToggleVoiceCorrection/);
  assert.doesNotMatch(quickAssistant, /isVoiceCorrectionEnabled/);
  assert.doesNotMatch(quickAssistant, /!isVoiceCorrectionEnabled\(latestSettings\)/);
  assert.match(quickAssistant, /applyVoiceTextToDraft/);
  assert.doesNotMatch(quickAssistant, /correctVoiceText/);
  assert.match(quickAssistant, /Voice correction is temporarily paused/);
  assert.match(quickAssistant, /getSpeechRecognitionConstructor\(\)/);
  assert.match(quickAssistant, /当前环境无法访问前端语音识别/);
  assert.match(quickAssistant, /voiceBaseDraftRef/);
  assert.match(quickAssistant, /canUseVoiceRecorder\(\) \|\| Boolean\(getSpeechRecognitionConstructor\(\)\)/);
  assert.match(quickAssistant, /voiceRecognitionFallbackToRecorderRef\.current = shouldFallbackToRecorder/);
  const toggleVoiceIndex = quickAssistant.indexOf("async function toggleVoice()");
  const formatAttachmentSizeIndex = quickAssistant.indexOf("function formatAttachmentSize", toggleVoiceIndex);
  const toggleVoice = quickAssistant.slice(toggleVoiceIndex, formatAttachmentSizeIndex);
  assert.match(toggleVoice, /canUseVoiceRecorder\(\)[\s\S]{0,120}await startVoiceRecorderInput\(\)/);
});

test("desktop pet appearance picker confirms persistence before success feedback", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );

  assert.match(settingsPage, /const desktopPetSupported = isMac \|\| isWindows;/);
  assert.match(settingsPage, /if \(!desktopPetSupported\) \{[\s\S]{0,120}return;/);
  assert.match(settingsPage, /\{desktopPetSupported \? \(/);
  assert.match(settingsPage, /nextState\.appearanceId === appearanceId/);
  assert.match(settingsPage, /桌面宠物形象切换未生效/);
  assert.match(settingsPage, /disabled=\{Boolean\(desktopPetAppearancePending\) && !selected\}/);
  assert.doesNotMatch(settingsPage, /disabled=\{Boolean\(desktopPetAppearancePending\) \|\| selected\}/);
});

test("desktop pet drag ends on lost pointer signals", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "DesktopPet.tsx"),
    "utf8"
  );
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(desktopPet, /lostpointercapture/);
  assert.match(desktopPet, /window\.addEventListener\("pointerup"/);
  assert.match(desktopPet, /window\.addEventListener\("mouseup"/);
  assert.match(desktopPet, /window\.addEventListener\("blur"/);
  assert.match(desktopPet, /window\.addEventListener\("contextmenu"/);
  assert.match(desktopPet, /document\.addEventListener\("visibilitychange"/);
  assert.match(mainProcess, /DESKTOP_PET_DRAG_FORCE_END_MS/);
  assert.match(mainProcess, /webContents\.on\("context-menu"[\s\S]{0,120}endDesktopPetWindowDrag\(\)/);
});

test("desktop pet base mode stays sprite-sized while bubble and preview modes expand separately", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const petGeometry = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-pet.ts"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(mainProcess, /return shouldShowBubble \? "bubble" : "base";/);
  assert.doesNotMatch(mainProcess, /shouldHideDesktopPetForMainWindow/);
  assert.doesNotMatch(mainProcess, /syncDesktopPetWindowVisibility/);
  assert.match(petGeometry, /width:\s*176,/);
  assert.match(petGeometry, /height:\s*198/);
  assert.match(petGeometry, /bubble:\s*\{\s*width:\s*224,\s*height:\s*228/s);
  assert.match(globalStyles, /\.desktop-pet-hitbox\s*\{[\s\S]{0,220}width:\s*174px;[\s\S]{0,120}min-height:\s*134px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-bubble\s+\.desktop-pet-hitbox\s*\{[\s\S]{0,80}width:\s*220px;/);
  assert.match(globalStyles, /\.desktop-pet-speech\s*\{[\s\S]{0,80}width:\s*min\(216px,\s*calc\(100% - 4px\)\);/);
  assert.match(globalStyles, /\.desktop-pet-speech\s*\{[\s\S]{0,520}box-shadow:\s*none;/);
  assert.match(globalStyles, /\.desktop-pet-image\s*\{[\s\S]{0,120}width:\s*96px;/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root:not\(\.has-bubble\):not\(\.has-preview\)\s+\.desktop-pet-image[\s\S]{0,120}width:\s*100%/);
});

test("desktop pet button suppresses native focus rings in the transparent window", () => {
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(globalStyles, /\.desktop-pet-button\s*\{[\s\S]{0,420}appearance:\s*none;/);
  assert.match(globalStyles, /\.desktop-pet-button\s*\{[\s\S]{0,520}-webkit-tap-highlight-color:\s*transparent;/);
  assert.match(globalStyles, /\.desktop-pet-button:focus,\s*\.desktop-pet-button:focus-visible\s*\{[\s\S]{0,120}outline:\s*none;/);
});

test("control center config editor suppresses native focus rings", () => {
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(globalStyles, /\.config-editor:focus,\s*\.config-editor:focus-visible\s*\{[\s\S]{0,120}outline:\s*none;/);
  assert.match(globalStyles, /\.config-editor:focus,\s*\.config-editor:focus-visible\s*\{[\s\S]{0,160}border-color:\s*var\(--line\);/);
  assert.match(globalStyles, /\.config-editor:focus,\s*\.config-editor:focus-visible\s*\{[\s\S]{0,180}box-shadow:\s*none;/);
});

test("desktop pet visual states stay local to renderer priority", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "DesktopPet.tsx"),
    "utf8"
  );
  const sharedDesktopPet = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-pet.ts"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");
  const petAssetScript = fs.readFileSync(
    path.join(projectRoot, "scripts", "generate-desktop-pet-assets.mjs"),
    "utf8"
  );

  assert.match(desktopPet, /type DesktopPetVisualStatus = DesktopPetStatus \| "dragging" \| "hover" \| "message" \| "thinking" \| "dancing"/);
  assert.match(desktopPet, /const \[isHovering, setIsHovering\] = useState\(false\)/);
  assert.match(desktopPet, /const \[isKeyboardFocused, setIsKeyboardFocused\] = useState\(false\)/);
  assert.match(desktopPet, /const \[isDancing, setIsDancing\] = useState\(false\)/);
  assert.match(desktopPet, /pointIntersectsVisiblePetArea/);
  assert.match(desktopPet, /pointIntersectsElement\("\.desktop-pet-image"/);
  assert.match(desktopPet, /window\.addEventListener\("mousemove", handleWindowMouseMove\)/);
  assert.match(desktopPet, /desktopPet\.setMouseInteractive\(interactive\)/);
  assert.match(desktopPet, /typeof window\.electronAPI\.desktopPet\.onDanceRequested === "function"/);
  assert.match(desktopPet, /desktopPet\.onDanceRequested\(startDance\)/);
  assert.match(desktopPet, /isDragging[\s\S]{0,120}\? "dragging"/);
  assert.match(desktopPet, /isDancing && appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID[\s\S]{0,80}\? "dancing"/);
  assert.match(desktopPet, /displayStatus === "running" \|\| displayStatus === "awaiting"/);
  assert.match(desktopPet, /hasMessageReaction[\s\S]{0,80}\? "message"/);
  assert.match(desktopPet, /displayStatus === "idle" && !isDragging && !hasMessageReaction/);
  assert.match(desktopPet, /isHovering \|\| isKeyboardFocused/);
  assert.match(desktopPet, /getDesktopPetStatusAssetPath\(appearanceId, visualStatus\)/);
  assert.match(desktopPet, /DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH = 30/);
  assert.match(desktopPet, /formatInlinePetPreview\(bubbleText\)/);
  assert.match(desktopPet, /const statusBubbleText = petState\.hint\.trim\(\) \|\| formatPetHint\(displayStatus\);/);
  assert.match(desktopPet, /const previewSummary = previewPanel && previewPanel\.expanded/);
  assert.match(desktopPet, /const showItemDetail = shouldShowSecondaryPreview\(itemTitle, itemDetailPreview\);/);
  assert.match(desktopPet, /handlePreviewClick[\s\S]{0,180}previewPanel\.status === "done"[\s\S]{0,120}desktopPet\.dismissPreview/);
  assert.match(desktopPet, /handlePreviewClick[\s\S]{0,360}desktopPet\.setPreviewExpanded\(!previewPanel\.expanded\)/);
  assert.match(desktopPet, /messagePreview \|\| "有新消息"/);
  assert.match(desktopPet, /const previewPanel = petState\.previewPanel\?\.visible \? petState\.previewPanel : null/);
  assert.match(desktopPet, /const showPreviewPanel = !isDragging && Boolean\(previewPanel\)/);
  assert.match(desktopPet, /const showBubble = !isDragging && !showPreviewPanel && bubbleText\.length > 0/);
  assert.match(desktopPet, /desktop-pet-preview-toggle/);
  assert.match(desktopPet, /desktopPet\.setPreviewExpanded/);
  assert.match(desktopPet, /onPointerEnter=\{handlePointerEnter\}/);
  assert.match(desktopPet, /onPointerLeave=\{handlePointerLeave\}/);
  assert.match(desktopPet, /onFocus=\{handleButtonFocus\}/);
  assert.match(desktopPet, /onBlur=\{handleButtonBlur\}/);
  assert.match(desktopPet, /matches\(":focus-visible"\)/);
  assert.match(sharedDesktopPet, /id:\s*"dario"/);
  assert.match(sharedDesktopPet, /id:\s*"mini-sama"/);
  assert.match(sharedDesktopPet, /assetBasePath:\s*"\.\/desktop-pet\/dario"/);
  assert.match(sharedDesktopPet, /assetBasePath:\s*"\.\/desktop-pet\/mini-sama"/);
  assert.match(sharedDesktopPet, /dragging:\s*"pet-dragging\.png"/);
  assert.match(sharedDesktopPet, /hover:\s*"pet-hover\.png"/);
  assert.match(sharedDesktopPet, /message:\s*"pet-message\.png"/);
  assert.match(sharedDesktopPet, /thinking:\s*"pet-thinking\.png"/);
  assert.match(sharedDesktopPet, /dancing:\s*"pet-idle\.png"/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-hover\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-dancing\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-dragging\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-thinking\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-message\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-preview/);
  assert.match(globalStyles, /\.desktop-pet-preview-toggle/);
  assert.match(globalStyles, /@keyframes desktop-pet-hover-reaction/);
  assert.match(globalStyles, /@keyframes desktop-pet-dance/);
  assert.match(globalStyles, /@keyframes desktop-pet-dragging/);
  assert.match(globalStyles, /@keyframes desktop-pet-thinking/);
  assert.match(globalStyles, /@keyframes desktop-pet-message-nudge/);
  assert.match(mainProcess, /getDesktopPetContextMenuItems\(desktopPetSettings\.appearanceId\)/);
  assert.match(mainProcess, /function setDesktopPetWindowMouseInteractive\(interactive: boolean\)/);
  assert.match(mainProcess, /setIgnoreMouseEvents\(!interactive, \{ forward: true \}\)/);
  assert.match(mainProcess, /process\.platform === "win32"[\s\S]{0,220}setIgnoreMouseEvents\(false\)/);
  assert.match(mainProcess, /const isWindows = process\.platform === "win32";/);
  assert.match(mainProcess, /\.\.\.\(isWindows \? \{ thickFrame: false \} : \{\}\)/);
  assert.match(mainProcess, /if \(isMac\) \{[\s\S]{0,180}setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true \}\);[\s\S]{0,80}\} else if \(isWindows\) \{[\s\S]{0,80}setAlwaysOnTop\(true\);/);
  assert.match(mainProcess, /desktopPet\.setMouseInteractive/);
  assert.match(mainProcess, /desktopPet\.dismissPreview/);
  assert.match(mainProcess, /desktopPet\.danceRequested/);
  assert.match(preload, /dismissPreview: \(\) => ipcRenderer\.invoke\("desktopPet\.dismissPreview"\)/);
  assert.match(preload, /setMouseInteractive: \(interactive\) => ipcRenderer\.invoke\("desktopPet\.setMouseInteractive", interactive\)/);
  assert.match(preload, /onDanceRequested/);
  assert.match(preload, /desktopPet\.danceRequested/);
  assert.match(contracts, /DesktopPetDanceRequestedListener/);
  assert.match(contracts, /setMouseInteractive: \(interactive: boolean\) => Promise<\{ ok: boolean \}>/);
  assert.match(contracts, /onDanceRequested: \(listener: DesktopPetDanceRequestedListener\) => \(\) => void/);
  assert.match(petAssetScript, /classicVisualVariants = \["idle", "hover", "dragging", "thinking", "message", "done", "error"\]/);
  assert.match(petAssetScript, /dario-a7bdc389/);
  assert.match(petAssetScript, /mini-sama-3ee267a2/);
  assert.match(petAssetScript, /awaiting:\s*"thinking"/);
  assert.match(petAssetScript, /running:\s*"thinking"/);
  assert.match(petAssetScript, /function drawHoverArm/);
});

test("quick assistant attachment entry stays compact and independent from the main assistant", () => {
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  const attachmentImagePreview = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AttachmentImagePreview.tsx"),
    "utf8"
  );
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const appendAttachmentResult = quickAssistant.slice(
    quickAssistant.indexOf("async function appendAttachmentResult"),
    quickAssistant.indexOf("async function chooseAttachmentFiles")
  );

  assert.match(quickAssistant, /quickAssistantDisplayMode/);
  assert.match(quickAssistant, /attachmentMenuOpen \? "is-menu-open" : ""/);
  assert.match(quickAssistant, /quickAssistant\.setDisplayMode/);
  assert.match(quickAssistant, /quickAssistant\.pickAttachments/);
  assert.match(quickAssistant, /quickAssistant\.captureScreenshot/);
  assert.match(quickAssistant, /onAttachmentProgress/);
  assert.match(quickAssistant, /quickAssistant\.cancelAttachmentTask/);
  assert.match(mainProcess, /assistant\.attachmentProgress/);
  assert.match(mainProcess, /cancelAssistantAttachmentTask/);
  assert.match(quickAssistant, /hiddenArtifactIds/);
  assert.match(quickAssistant, /visibleAttachments/);
  assert.match(quickAssistant, /quick-attachment-preview-card/);
  assert.match(quickAssistant, /function removeAttachment/);
  assert.match(quickAssistant, /quick-attachment-remove/);
  assert.match(quickAssistant, /quick-artifact-remove/);
  assert.doesNotMatch(quickAssistant, /quick-mode-pill/);
  assert.match(quickAssistant, /chooseAttachmentFiles/);
  assert.match(quickAssistant, /const showSendAction = hasDraft \|\| attachments\.some/);
  assert.match(quickAssistant, /quick-primary-action/);
  assert.match(quickAssistant, /quick-expand-button/);
  assert.match(quickAssistant, /const composerStatus = isExpanded \?/);
  assert.match(quickAssistant, /const isSmallTrayMode = !isExpanded && visibleAttachments\.length === 0 && !voiceExpandedComposer/);
  assert.match(quickAssistant, /const showScreenshotMenuItem = !isSmallTrayMode/);
  assert.match(quickAssistant, /attachmentMenuOpen[\s\S]{0,80}\? isSmallTrayMode[\s\S]{0,80}\? "compactMenu"/);
  assert.match(quickAssistant, /attachmentMenuOpen/);
  assert.match(quickAssistant, /attachmentMenuCloseTimerRef/);
  assert.match(quickAssistant, /attachmentMenuOpenTimerRef/);
  assert.match(quickAssistant, /setAttachmentMenuOpen\(true\);[\s\S]{0,40}, 420\);/);
  assert.match(quickAssistant, /setAttachmentMenuPinned\(true\)/);
  assert.doesNotMatch(quickAssistant, /function toggleAttachmentMenu\(\)[\s\S]{0,180}handleChooseAttachmentFromMenu/);
  assert.match(quickAssistant, /attachment-action-menu/);
  assert.doesNotMatch(quickAssistant, /window\.electronAPI\.assistant\.pickAttachments\(activeChatId\)/);
  assert.match(quickAssistant, /captureScreenshotQuestion/);
  assert.match(quickAssistant, /\{showScreenshotMenuItem \? \(/);
  assert.match(quickAssistant, /quick-attachment-preview-image-button/);
  assert.match(quickAssistant, /openMainAssistant\(activeChatId\)/);
  assert.doesNotMatch(quickAssistant, /AttachmentImagePreview/);
  assert.doesNotMatch(quickAssistant, /setPreviewImageAttachment/);
  assert.doesNotMatch(quickAssistant, /quick-screenshot-button/);
  assert.match(mainProcess, /captureWindowSelectionFallback/);
  assert.match(mainProcess, /const cropped = await captureScreenshotImage\(display, selection, source\)/);
  assert.match(mainProcess, /id=\\"shade\\"/);
  assert.match(attachmentImagePreview, /createPortal/);
  assert.match(attachmentImagePreview, /attachment-image-preview-toolbar/);
  assert.match(attachmentImagePreview, /attachment-image-preview-filmstrip/);
  assert.doesNotMatch(appendAttachmentResult, /setIsExpanded\(true\)/);
  assert.match(globalStyles, /grid-template-columns:\s*42px minmax\(0, 1fr\) 42px 46px/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\.has-attachments/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\.is-menu-open/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\.has-attachments\.is-menu-open/);
  assert.match(globalStyles, /\.quick-attachment-preview-card/);
  assert.match(globalStyles, /\.quick-attachment-remove/);
  assert.match(globalStyles, /\.attachment-action-menu/);
  assert.match(globalStyles, /\.attachment-action-menu-root::before/);
  assert.match(globalStyles, /bottom:\s*calc\(100% \+ 4px\)/);
  assert.match(globalStyles, /\.quick-artifact-remove/);
  assert.match(globalStyles, /\.attachment-image-preview-backdrop/);
  assert.match(globalStyles, /z-index:\s*2147483000/);
  assert.match(globalStyles, /\.attachment-image-preview-toolbar/);
  assert.match(globalStyles, /\.attachment-image-preview-filmstrip/);
  assert.doesNotMatch(globalStyles, /\.quick-mode-pill/);
  assert.match(globalStyles, /font-size:\s*18px/);
  assert.doesNotMatch(globalStyles, /\.quick-screenshot-entry/);
  assert.match(globalStyles, /\.quick-composer\.has-status/);
});
