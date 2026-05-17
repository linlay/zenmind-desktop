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

test("control center keeps service operations in the prototype dashboard layout", () => {
  const controlCenter = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "ControlCenterPage.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(controlCenter, /control-center-dashboard-metrics/);
  assert.match(controlCenter, /service-catalog/);
  assert.match(controlCenter, /control-center-service-hero/);
  assert.match(controlCenter, /service-detail-metadata/);
  assert.match(controlCenter, /config-status-dot/);
  assert.match(controlCenter, /function ConfigTerminalIcon\(\)/);
  assert.match(controlCenter, /<ConfigTerminalIcon \/>/);
  assert.doesNotMatch(controlCenter, /config-terminal-icon" aria-hidden="true">&gt;_/);
  assert.match(controlCenter, /管理并监控您的基础设施服务集群。/);
  assert.match(controlCenter, /已注册服务/);
  assert.match(controlCenter, /运行中实例/);
  assert.match(controlCenter, /handleQuickStart/);
  assert.match(controlCenter, /handleInstallPlugin/);
  assert.match(controlCenter, /installBuiltinFromBundle/);
  assert.match(controlCenter, /initialize\(activeDetailService\.id\)/);
  assert.match(controlCenter, /installBuiltin\(activeDetailService\.id\)/);
  assert.match(controlCenter, /uninstallPlugin\(activeDetailService\.id\)/);
  assert.match(controlCenter, /openLogViewer/);
  assert.match(controlCenter, /writeConfig/);
  assert.match(globalStyles, /\.control-center-dashboard-metrics\s*\{/);
  assert.match(globalStyles, /\.service-catalog\s*\{/);
  assert.match(globalStyles, /\.control-center-service-hero\s*\{/);
  assert.match(globalStyles, /\.service-detail-metadata\s*\{/);
  assert.match(globalStyles, /\.config-status-dot\s*\{/);
  assert.match(globalStyles, /\.config-terminal-icon svg\s*\{/);
  assert.match(globalStyles, /\.service-action-button,[\s\S]*?\.service-title-text-button\.service-action-button\s*\{[\s\S]*?border:\s*0;/);
  assert.match(globalStyles, /\.control-center-link-action\.icon-link-action\s*\{[\s\S]*?border:\s*0;/);
  assert.match(globalStyles, /\.config-save-button\s*\{[\s\S]*?border:\s*0;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.service-action-button,[\s\S]*?:root\[data-theme="dark"\] \.service-title-text-button\.service-action-button\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.service-hero-icon\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.control-center-page \.config-file-select\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.control-center-page \.config-editor\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.service-status-message\.danger\s*\{/);
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
  assert.match(sidebarSource, /"关闭 ZenMind 助手"/);
  assert.match(sidebarSource, /"当前页面不可开启 ZenMind 助手"/);
  assert.match(globalStyles, /--assistant-dock-embedded-width:\s*360px;/);
  assert.match(globalStyles, /\.agent-webclient-copilot-dock\s*\{/);
  assert.doesNotMatch(globalStyles, /\.assistant-dock-/);
  assert.match(globalStyles, /\.sidebar-footer-actions\s*\{[\s\S]*?display:\s*flex;/);
});

test("embedded surfaces use theme-backed host colors instead of hard-coded light fallbacks", () => {
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(globalStyles, /--embedded-surface-shell-bg:\s*#fff;/);
  assert.match(globalStyles, /--embedded-surface-dock-bg:\s*#fff;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\][\s\S]*?--embedded-surface-shell-bg:\s*#1f2329;/);
  assert.match(globalStyles, /\.app-shell\.has-embedded-surface\s*\{[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/);
  assert.match(globalStyles, /\.app-shell\.has-embedded-surface \.app-content,\s*[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/);
  assert.match(globalStyles, /\.agent-webclient-copilot-dock\s*\{[\s\S]*?background:\s*var\(--embedded-surface-dock-bg\);/);
  assert.match(globalStyles, /\.pan-frame\s*\{[\s\S]*?background:\s*var\(--embedded-surface-frame-bg\);/);
  assert.match(globalStyles, /\.embedded-plugin-error\s*\{[\s\S]*?background:\s*var\(--embedded-surface-loading-bg\);/);
  assert.match(globalStyles, /--browser-frame-bg:\s*#ffffff;/);
  assert.match(globalStyles, /\.external-webview-panel\s*\{[\s\S]*?background:\s*var\(--browser-frame-bg\);/);
  assert.match(globalStyles, /\.external-webview-frame\s*\{[\s\S]*?background:\s*var\(--browser-frame-bg\);/);
});

test("sidebar collapse toggle moves into the top chrome with expanded and collapsed variants", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AppSidebar.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const collapseButtonRule = globalStyles.match(/^\.app-sidebar-collapse-button\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body;

  assert.match(appShell, /onToggleCollapsed=\{toggleSidebarCollapsed\}/);
  assert.match(appShell, /isMac=\{isMac\}/);
  assert.match(appShell, /isWindows=\{isWindows\}/);
  assert.doesNotMatch(appShell, /className="app-sidebar-collapse-button"/);
  assert.doesNotMatch(appShell, /app-sidebar-drag-region/);
  assert.match(sidebarSource, /onToggleCollapsed\?:\s*\(\)\s*=>\s*void;/);
  assert.match(sidebarSource, /type SidebarCollapseToggleVariant = "compact" \| "nav";/);
  assert.match(sidebarSource, /className=\{\[\s*"app-sidebar-collapse-button",[\s\S]*?"is-compact" : "is-nav"/);
  assert.match(sidebarSource, /aria-expanded=\{!isCollapsed\}/);
  assert.match(sidebarSource, /<div className="sidebar-chrome">/);
  assert.match(sidebarSource, /<div className="sidebar-chrome-drag-region" aria-hidden="true" \/>/);
  assert.match(sidebarSource, /className=\{chromeToolbarClassName\}/);
  assert.match(sidebarSource, /<div className="sidebar-collapsed-toggle-slot">/);
  assert.doesNotMatch(sidebarSource, /sidebar-collapse-control/);
  assert.ok(collapseButtonRule, "missing .app-sidebar-collapse-button rule");
  assert.match(collapseButtonRule, /appearance:\s*none;/);
  assert.match(globalStyles, /\.sidebar-chrome-toolbar\.is-mac\s*\{[\s\S]*?padding-left:\s*var\(--mac-traffic-light-safe-area\);/);
  assert.match(globalStyles, /\.sidebar-chrome-toolbar\.is-windows,[\s\S]*?justify-content:\s*center;/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button\.is-compact\s*\{[\s\S]*?width:\s*24px;/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button\.is-nav\s*\{[\s\S]*?width:\s*var\(--sidebar-collapse-toggle-nav-width, 48px\);/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button\.is-expanded-state \.app-sidebar-collapse-button-icon\s*\{[\s\S]*?rotate\(180deg\)/);
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
  assert.match(sidebarSource, /sortSidebarNavItems\(\s*\[/);
  assert.match(sidebarSource, /assistantNavItem,[\s\S]*?\.\.\.agentWebclientNavItems,[\s\S]*?\.\.\.staticNavItems/);
  assert.match(sidebarSource, /controlCenterUtilityItem/);
  assert.match(sidebarSource, /to:\s*"\/control-center"[\s\S]*?label:\s*"控制中心"/);

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

test("settings route switches the sidebar into section mode with shared iconized definitions", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AppSidebar.tsx"),
    "utf8"
  );
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );
  const settingsSections = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "settingsSections.ts"),
    "utf8"
  );
  const brandMark = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "BrandMark.tsx"),
    "utf8"
  );

  assert.match(appShell, /<Route\s+path="\/settings"/);
  assert.match(appShell, /const lastNonSettingsRouteRef = useRef\("\/control-center"\)/);
  assert.match(appShell, /createSettingsSectionDefinitions/);
  assert.match(appShell, /buildSettingsSectionPath/);
  assert.match(appShell, /navigate\(normalizedSettingsPath, \{ replace: true \}\)/);
  assert.match(appShell, /onSelectSettingsSection=\{handleSelectSettingsSection\}/);

  assert.match(settingsSections, /type SettingsSectionId/);
  assert.match(settingsSections, /id:\s*"appearance"[\s\S]*?label:\s*"外观"[\s\S]*?icon:\s*"appearance"/);
  assert.match(settingsSections, /id:\s*"navigation"[\s\S]*?label:\s*"导航栏"[\s\S]*?icon:\s*"navigation"/);
  assert.match(settingsSections, /id:\s*"quickAssistant"[\s\S]*?label:\s*"快捷助手"[\s\S]*?icon:\s*"assistant"/);
  assert.match(settingsSections, /id:\s*"sideAssistant"[\s\S]*?label:\s*"侧边助手"[\s\S]*?icon:\s*"sidebar-assistant-closed"/);
  assert.match(settingsSections, /id:\s*"desktopPet"[\s\S]*?label:\s*"宠物助手"[\s\S]*?icon:\s*"pet"/);
  assert.match(settingsSections, /id:\s*"embeddedWebsites"[\s\S]*?label:\s*"内嵌网站"[\s\S]*?icon:\s*"website"/);
  assert.match(settingsSections, /id:\s*"dataRoot"[\s\S]*?label:\s*"数据目录"[\s\S]*?icon:\s*"folder"/);
  assert.match(settingsSections, /id:\s*"memory"[\s\S]*?label:\s*"助手记忆"[\s\S]*?icon:\s*"memory"/);

  assert.match(sidebarSource, /isSettingsMode\?: boolean;/);
  assert.match(sidebarSource, /settingsSections\?: SettingsSectionDefinition\[\];/);
  assert.match(sidebarSource, /pendingSettingsSectionId\?: SettingsSectionId \| null;/);
  assert.match(sidebarSource, /sidebar-settings-nav/);
  assert.match(sidebarSource, /data-settings-section=\{section\.id\}/);
  assert.doesNotMatch(sidebarSource, /settings-mode-close-button/);
  assert.match(sidebarSource, /to="\/settings"/);
  assert.match(sidebarSource, /controlCenterUtilityItem/);
  assert.match(sidebarSource, /sidebar-assistant-launcher/);
  assert.match(sidebarSource, /app-sidebar-collapse-button/);

  assert.match(settingsPage, /className="settings-mode-close-button"/);
  assert.match(settingsPage, /aria-label="退出设置模式"/);
  assert.match(settingsPage, /switch \(activeSection\)/);
  assert.match(settingsPage, /case "appearance"/);
  assert.match(settingsPage, /case "memory"/);
  assert.doesNotMatch(settingsPage, /还原到侧边栏关闭按钮/);

  assert.match(brandMark, /appearanceIcon/);
  assert.match(brandMark, /folderIcon/);
  assert.match(brandMark, /navigationIcon/);
  assert.match(brandMark, /petIcon/);
  assert.match(brandMark, /"appearance"/);
  assert.match(brandMark, /"navigation"/);
  assert.match(brandMark, /"pet"/);
  assert.match(brandMark, /"folder"/);
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
  assert.match(settingsPage, /NAVIGATION/);
  assert.match(settingsPage, /导航栏/);
  assert.doesNotMatch(settingsPage, /半透明度/);
  assert.doesNotMatch(settingsPage, /导航栏半透明效果/);
  assert.doesNotMatch(settingsPage, /type="range"/);
  assert.match(settingsPage, /导航页签排序/);
  assert.match(settingsPage, /内嵌网站/);
  assert.match(settingsPage, /智能体增强/);
  assert.match(settingsPage, /handleUpdateCustomSidebarAgent/);
  assert.match(settingsPage, /window\.electronAPI\.customSidebar\.update/);
  assert.doesNotMatch(settingsPage, /自定义侧边栏/);
  assert.doesNotMatch(settingsPage, /添加到侧边栏/);
  assert.doesNotMatch(settingsPage, /已添加的入口/);
  assert.doesNotMatch(settingsPage, /自定义入口/);
  assert.match(settingsPage, /DESKTOP ASSISTANT/);
  assert.match(settingsPage, /快捷助手/);
  assert.match(settingsPage, /SIDE ASSISTANT/);
  assert.match(settingsPage, /侧边助手/);
  assert.match(settingsPage, /宠物助手/);
  assert.match(settingsPage, /quickAssistantEnabled/);
  assert.match(settingsPage, /quickAssistantAgentKey/);
  assert.match(settingsPage, /handleToggleQuickAssistantEnabled/);
  assert.match(settingsPage, /handleSelectQuickAssistantAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*quickAssistantAgentKey: normalizedAgentKey\s*\}\)/);
  assert.doesNotMatch(settingsPage, /页面 Copilot/);
  assert.doesNotMatch(settingsPage, />选择宠物</);
  assert.doesNotMatch(settingsPage, /半透明侧边栏/);
  assert.match(settingsPage, /DESKTOP_COPILOT_PAGE_KEYS\.map/);
  assert.match(settingsPage, /handleToggleCopilotPage/);
  assert.match(settingsPage, /handleSelectCopilotAgent/);
  assert.match(settingsPage, /handleSelectDesktopHelperAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*desktopHelperAgentKey: normalizedAgentKey\s*\}\)/);
  assert.match(settingsPage, /desktopCopilotPages: nextPages/);
  assert.match(settingsPage, /这个设置不影响宠物助手绑定/);
  assert.match(settingsPage, /aria-label="快捷助手配置"/);
  assert.match(settingsPage, /aria-label="侧边助手配置"/);
});

test("sidebar translucency is fixed and not user configurable", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");

  assert.match(appShell, /"has-translucent-sidebar"/);
  assert.match(appShell, /isMac \? "is-mac-translucent-sidebar" : ""/);
  assert.match(appShell, /sidebarTranslucencyEnabled:\s*true/);
  assert.match(appShell, /window\.electronAPI\.settings\.setNativeThemeSource\(themeMode\)/);
  assert.doesNotMatch(appShell, /SIDEBAR_TRANSLUCENCY_STORAGE_KEY/);
  assert.doesNotMatch(appShell, /SIDEBAR_TRANSLUCENCY_OPACITY_STORAGE_KEY/);
  assert.doesNotMatch(appShell, /setSidebarTranslucency/);
  assert.doesNotMatch(appShell, /setSidebarTranslucencyEnabled/);
  assert.doesNotMatch(appShell, /setSidebarTranslucencyOpacity/);

  assert.doesNotMatch(settingsPage, /sidebarTranslucencyEnabled/);
  assert.doesNotMatch(settingsPage, /sidebarTranslucencyOpacity/);
  assert.doesNotMatch(settingsPage, /navigation-translucency-row/);
  assert.doesNotMatch(settingsPage, /navigation-opacity-control/);

  const findBackgroundRule = (pattern) =>
    Array.from(globalStyles.matchAll(pattern))
      .map((match) => match.groups?.body ?? "")
      .find((body) => /background:/.test(body)) ?? "";
  const lightSidebarRule = globalStyles.match(/^\.app-shell\.has-translucent-sidebar \.app-sidebar\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body ?? "";
  const darkSidebarRule = globalStyles.match(/^:root\[data-theme="dark"\] \.app-shell\.has-translucent-sidebar \.app-sidebar\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body ?? "";
  const macSidebarRule = findBackgroundRule(/^\.app-shell\.is-mac-translucent-sidebar \.app-sidebar\s*\{(?<body>[\s\S]*?)^\}/gm);
  const macDarkSidebarRule = globalStyles.match(/^:root\[data-theme="dark"\] \.app-shell\.is-mac-translucent-sidebar \.app-sidebar\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body ?? "";

  assert.doesNotMatch(globalStyles, /--sidebar-translucency-opacity/);
  assert.match(globalStyles, /\.app-shell\.is-mac-translucent-sidebar::before\s*\{[\s\S]*?left:\s*var\(--app-sidebar-width,\s*160px\);/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar-shell::before\s*\{[\s\S]*?(?:radial-gradient|linear-gradient)/);
  assert.match(lightSidebarRule, /background:\s*rgba\(232,\s*244,\s*255,\s*0\.26\);/);
  assert.match(darkSidebarRule, /background:\s*rgba\(0,\s*0,\s*0,\s*0\.62\);/);
  assert.match(macSidebarRule, /background:\s*rgba\(232,\s*244,\s*255,\s*0\.26\);/);
  assert.match(macDarkSidebarRule, /background:\s*rgba\(0,\s*0,\s*0,\s*0\.62\);/);
  assert.match(macDarkSidebarRule, /brightness\(0\.52\)/);
  assert.doesNotMatch(lightSidebarRule, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(darkSidebarRule, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(macSidebarRule, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(macDarkSidebarRule, /linear-gradient|radial-gradient/);

  assert.doesNotMatch(preload, /setSidebarTranslucency/);
  assert.match(preload, /setNativeThemeSource:\s*\(themeMode\) => ipcRenderer\.invoke\("settings\.setNativeThemeSource", themeMode\)/);
  assert.match(contracts, /setNativeThemeSource:\s*\(themeMode:\s*"light" \| "dark"\)/);
  assert.match(mainProcess, /nativeTheme/);
  assert.match(mainProcess, /nativeTheme\.themeSource = themeMode === "dark" \? "dark" : "light"/);
  assert.match(mainProcess, /ipcMain\.handle\("settings\.setNativeThemeSource"/);
  assert.doesNotMatch(contracts, /setSidebarTranslucency/);
  assert.doesNotMatch(mainProcess, /settings\.setSidebarTranslucency/);
});

test("sidebar navigation order helper normalizes and sorts available items", () => {
  const orderHelper = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "sidebarNavOrder.ts"),
    "utf8"
  );
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AppSidebar.tsx"),
    "utf8"
  );

  assert.match(orderHelper, /export type SidebarNavOrderItemKey/);
  assert.match(orderHelper, /STATIC_SIDEBAR_NAV_ORDER_ITEMS/);
  assert.match(orderHelper, /createDefaultSidebarNavOrderItems/);
  assert.match(orderHelper, /normalizeSidebarNavOrder/);
  assert.match(orderHelper, /!availableKeys\.has/);
  assert.match(orderHelper, /normalized\.includes/);
  assert.match(orderHelper, /sortSidebarNavItems/);
  assert.match(appShell, /SIDEBAR_NAV_ORDER_STORAGE_KEY/);
  assert.match(appShell, /availableSidebarNavOrderItems/);
  assert.match(appShell, /normalizeSidebarNavOrder\(sidebarNavOrder, availableSidebarNavOrderItems\)/);
  assert.match(sidebarSource, /sidebarNavOrder:\s*SidebarNavOrderItemKey\[\]/);
  assert.match(sidebarSource, /sortSidebarNavItems\(/);
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
  assert.match(appShell, /customSidebarAgentKey = activeCustomSidebarItemId/);
  assert.match(appShell, /resolvedCopilotAgentKey = customSidebarAgentKey \|\| currentCopilotPreference\?\.agentKey \|\| ""/);
  assert.match(appShell, /resolvedAgentKey=\{resolvedCopilotAgentKey\}/);
  assert.match(appShell, /data-open-agent-key=\{openRequest\?\.agentKey \?\? openRequest\?\.workerKey \?\? resolvedAgentKey\}/);
  assert.match(sidebarSource, /assistantLauncherVisible/);
  assert.match(sidebarSource, /assistantLauncherDisabled/);
  assert.match(sidebarSource, /assistantLauncherVisible \? \(/);
  assert.match(
    sidebarSource,
    /assistantDockOpen[\s\S]*?\? "sidebar-assistant-open"[\s\S]*?: "sidebar-assistant-closed"/
  );
  assert.match(sidebarSource, /if \(assistantDockOpen\) \{\s*onCloseAssistantDock\?\.\(\);\s*\} else \{\s*onOpenAssistantDock\?\.\(\);/);
  assert.doesNotMatch(sidebarSource, /assistantDockOpen \? "sidebar-link-active" : ""/);
  assert.doesNotMatch(sidebarSource, /!assistantDockOpen && \(isActive \|\| pendingPath === "\/settings"\)/);
  assert.match(sidebarSource, /assistantDockOpen \? "is-assistant-open" : ""/);
  assert.match(sidebarSource, />侧边助手</);
  assert.doesNotMatch(sidebarSource, /sidebar-link-label-collapsed" aria-hidden="true">助手/);
  assert.doesNotMatch(sidebarSource, /assistantDockOpen \? "is-open" : ""/);
  assert.doesNotMatch(sidebarSource, /sidebar-assistant-switch/);
  assert.match(sidebarSource, /disabled=\{assistantLauncherDisabled\}/);
  assert.doesNotMatch(globalStyles, /\.sidebar-assistant-launcher\.is-open/);
  assert.match(globalStyles, /\.sidebar-assistant-launcher\.is-assistant-open \.sidebar-link-icon/);
  assert.match(globalStyles, /\.sidebar-assistant-launcher\.is-disabled/);
  assert.doesNotMatch(globalStyles, /\.sidebar-assistant-switch/);
});

test("custom sidebar agent association is exposed across desktop api layers", () => {
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");
  const store = fs.readFileSync(path.join(projectRoot, "src", "main", "custom-sidebar-store.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");

  assert.match(contracts, /agentKey\?: string/);
  assert.match(contracts, /interface CustomSidebarUpdateInput/);
  assert.match(contracts, /update: \(id: string, input: CustomSidebarUpdateInput\) => Promise<CustomSidebarItemResult>/);
  assert.match(store, /export function updateCustomSidebarItem/);
  assert.match(store, /delete updated\.agentKey/);
  assert.match(mainProcess, /ipcMain\.handle\("customSidebar\.update"/);
  assert.match(preload, /update: \(id, input\) => ipcRenderer\.invoke\("customSidebar\.update", id, input\)/);
  assert.match(appShell, /resolvedCopilotAgentKey/);
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

test("window drag uses css-only app-region approach", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AppSidebar.tsx"),
    "utf8"
  );
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");

  assert.match(
    globalStyles,
    /\.app-window-drag-region\s*\{[\s\S]*?left:\s*var\(--app-sidebar-width,\s*160px\);[\s\S]*?app-region:\s*drag;[\s\S]*?-webkit-app-region:\s*drag;/
  );
  assert.match(
    globalStyles,
    /\.sidebar-chrome-drag-region\s*\{[\s\S]*?app-region:\s*drag;[\s\S]*?-webkit-app-region:\s*drag;/
  );
  assert.match(
    globalStyles,
    /\.app-shell\.is-mac-platform\s+\.sidebar-chrome-drag-region\s*\{[\s\S]*?left:\s*var\(--mac-traffic-light-safe-area\);/
  );
  assert.match(globalStyles, /\.app-main-drag-region\s*\{\s*height:\s*20px;\s*\}/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar-drag-region/);
  assert.match(sidebarSource, /sidebar-chrome-drag-region/);
  assert.doesNotMatch(appShell, /app-sidebar-drag-region/);
  assert.doesNotMatch(appShell, /WINDOW_DRAG_EXCLUDED_SELECTOR/);
  assert.doesNotMatch(appShell, /onPointerDownCapture=\{handleDesktopWindowPointerDown\}/);
  assert.doesNotMatch(appShell, /window\.electronAPI\.windowDrag\.begin/);
  assert.doesNotMatch(contracts, /windowDrag:\s*\{/);
  assert.doesNotMatch(preload, /windowDrag:\s*\{/);
  assert.doesNotMatch(mainProcess, /ipcMain\.handle\("windowDrag\.begin"/);
});

test("mac fullscreen forces the main window to an opaque background", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(mainProcess, /let mainWindowSidebarTranslucencyEnabled = true;/);
  assert.match(mainProcess, /vibrancy:\s*"sidebar"\s+as const/);
  assert.match(mainProcess, /visualEffectState:\s*"active"\s+as const/);
  assert.match(mainProcess, /function applyMainWindowAppearance\(targetWindow: BrowserWindow \| null\)/);
  assert.match(
    mainProcess,
    /if \(process\.platform === "darwin"\)\s*\{[\s\S]*?mainWindowSidebarTranslucencyEnabled && !targetWindow\.isFullScreen\(\);[\s\S]*?targetWindow\.setVibrancy\("sidebar"\);[\s\S]*?targetWindow\.setVibrancy\(null\);[\s\S]*?targetWindow\.setBackgroundColor\(useSidebarTranslucency \? "#00000000" : "#FFFFFF"\);/
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

test("assistant capability identity and active-chat event recovery stay intact", () => {
  const assistantCapabilities = fs.readFileSync(
    path.join(projectRoot, "src", "shared", "assistant-capabilities.ts"),
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

  assert.match(assistantCapabilities, /ZENMIND_ASSISTANT_AGENT_KEY = "zenmind"/);
  assert.match(assistantCapabilities, /ZENMIND_ASSISTANT_NAME = "ZenMind"/);
  assert.match(assistantCapabilities, /侧边栏和快速助手中作为同一个本地单智能体/);
  assert.doesNotMatch(assistantCapabilities, /Zman|小宅|desktop-xiaozhai/);

  assert.match(assistantEventState, /function getLatestPendingAwaitingPayload/);
  assert.match(assistantEventState, /function attachRunningAssistantPlaceholder/);
  assert.match(assistantEventState, /function mergeOptimisticRunMessages/);
  assert.match(assistantEventState, /function getVisibleAssistantMessages/);
  assert.match(assistantEventState, /function shouldEnsureAssistantMessageForEvent/);
  assert.match(assistantEventState, /ASSISTANT_RUN_EVENT_TYPES/);
  assert.match(assistantEventState, /function reduceAssistantTimelineEvent/);
  assert.doesNotMatch(assistantEventState, /tool\.verify|tool\.route|voice\.transcribed|voice\.corrected|voice\.needs_review|intent\.classified/);
  assert.match(assistantArtifacts, /function getArtifactAttachmentsFromEvent/);
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
  assert.match(pluginPage, /registerDesktopActionProviderForScope\("embeddedWeb"/);
  assert.match(pluginPage, /skipContextRegistration\?: boolean/);
  assert.match(pluginPage, /service\?\.status !== "running" \|\| skipContextRegistration/);
  assert.match(pluginPage, /!embeddedUrl \|\| skipContextRegistration/);
  assert.match(pluginPage, /tryReadPluginIframePageContext/);
  assert.match(pluginPage, /buildPluginIframeFallbackContext/);
  assert.match(pluginPage, /window\.electronAPI\.embeddedWeb\.executeInFrame/);
  assert.match(pluginPage, /kind:\s*"iframe"/);
  assert.match(pluginPage, /frameMatchUrl/);
  assert.match(pluginPage, /READ_PAGE_DATA_SCRIPT/);
  assert.match(pluginPage, /EXTRACT_STRUCTURED_SCRIPT/);
  assert.match(pluginPage, /buildInteractElementScript/);
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

test("service log viewer lets users pause tail following and jump back to the latest log", () => {
  const logViewerPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "LogViewerPage.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(logViewerPage, /取消自动滚动/);
  assert.match(logViewerPage, /开启自动滚动/);
  assert.match(logViewerPage, /滚动到顶部/);
  assert.match(logViewerPage, /滚动到底部/);
  assert.match(logViewerPage, /handleScrollToTop/);
  assert.match(logViewerPage, /handleScrollToBottom/);
  assert.match(logViewerPage, /scrollJumpTarget/);
  assert.match(logViewerPage, /setTailFollowEnabled\(false\)/);
  assert.match(globalStyles, /\.log-viewer-scroll-top\s*\{/);
  assert.match(globalStyles, /\.log-viewer-scroll-bottom\s*\{/);
});

test("service log viewer keeps find controls inside the log area", () => {
  const logViewerPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "LogViewerPage.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(logViewerPage, /aria-label="查找日志"/);
  assert.match(logViewerPage, /handleOpenSearch/);
  assert.match(logViewerPage, /handleCloseSearch/);
  assert.match(logViewerPage, /aria-label="关闭日志查找"/);
  assert.match(logViewerPage, /selectRelativeMatch\(-1\)/);
  assert.match(logViewerPage, /selectRelativeMatch\(1\)/);
  assert.match(logViewerPage, /renderLogContent\(\s*joinedContent,\s*matches,\s*activeMatchIndex,\s*\)/);
  assert.doesNotMatch(logViewerPage, /className="log-viewer-toolbar"/);
  assert.match(globalStyles, /\.log-viewer-body-shell\s*\{/);
  assert.match(globalStyles, /\.log-viewer-find-panel\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*20px;[\s\S]*?top:\s*12px;[\s\S]*?width:\s*min\(520px,\s*calc\(50%\s*-\s*20px\)\);/);
  assert.match(globalStyles, /\.log-viewer-find-close\s*\{/);
  assert.match(globalStyles, /\.log-match\.is-active\s*\{/);
});

test("assistant dock opens the agent webclient copilot in right-side embedded mode", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const dockComponent = appShell.slice(
    appShell.indexOf("function AgentWebclientCopilotDock"),
    appShell.indexOf("function readStoredThemeMode")
  );

  assert.match(appShell, /const AGENT_WEBCLIENT_COPILOT_PATH = "\/copilot"/);
  assert.match(appShell, /assistantCopilotOpen \? "has-assistant-dock-full" : ""/);
  assert.match(appShell, /window\.electronAPI\.onOpenAssistantWorker[\s\S]{0,180}openAssistantDock\(\)/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.match(dockComponent, /skipContextRegistration/);
  assert.doesNotMatch(appShell, /<AssistantDock/);
  assert.doesNotMatch(appShell, /openAssistantDock\("compact"\)/);
  assert.doesNotMatch(appShell, /onOpenAssistantWorker[\s\S]{0,180}openAssistantDock\("compact"\)/);
});

test("option-space quick assistant route opens the agent webclient copilot surface", () => {
  const nativeQuickAssistantPath = path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx");
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const quickAssistantWindow = fs.readFileSync(path.join(projectRoot, "src", "main", "quick-assistant.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");
  const quickWebCopilotStyles = globalStyles.slice(
    globalStyles.indexOf(".quick-web-copilot,"),
    globalStyles.indexOf(".quick-web-copilot .pan-page")
  );
  const preloadQuickAssistantApi = preload.slice(
    preload.indexOf("quickAssistant: {"),
    preload.indexOf("customSidebar:", preload.indexOf("quickAssistant: {"))
  );
  const contractQuickAssistantApi = contracts.slice(
    contracts.indexOf("quickAssistant: {"),
    contracts.indexOf("customSidebar:", contracts.indexOf("quickAssistant: {"))
  );

  assert.equal(fs.existsSync(nativeQuickAssistantPath), false);
  assert.match(appShell, /function QuickAssistantWebCopilot/);
  assert.match(appShell, /location\.pathname === "\/quick-assistant"[\s\S]{0,180}<QuickAssistantWebCopilot \/>/);
  assert.match(appShell, /embedPath=\{AGENT_WEBCLIENT_COPILOT_PATH\}/);
  assert.match(appShell, /pluginId="agent-webclient"/);
  assert.match(appShell, /quickAssistantAgentKey/);
  assert.match(appShell, /data-open-agent-key=\{quickAssistantAgentKey\}/);
  assert.match(appShell, /quickAssistant\.openControlCenter/);
  assert.match(globalStyles, /\.quick-web-copilot\s*,/);
  assert.match(globalStyles, /\.quick-web-copilot-status/);
  assert.match(quickWebCopilotStyles, /border-radius:\s*10px;/);
  assert.doesNotMatch(quickWebCopilotStyles, /border-radius:\s*24px;/);
  assert.match(mainProcess, /getQuickAssistantWebCopilotBounds/);
  assert.match(mainProcess, /readAssistantSettings\(app\)/);
  assert.match(mainProcess, /!quickSettings\.quickAssistantEnabled/);
  assert.match(mainProcess, /ensureAssistantTargetServicesRunning\("quick-assistant"\)/);
  assert.match(mainProcess, /agentKey:\s*quickSettings\.quickAssistantAgentKey/);
  assert.match(mainProcess, /for \(const targetWindow of \[mainWindow, quickAssistantWindow\]\)/);
  assert.doesNotMatch(mainProcess, /createQuickAssistantWindowState|getQuickAssistantBounds|QUICK_ASSISTANT_COMPACT_REQUEST_CHANNEL|QuickAssistantDisplayMode|requestQuickAssistantCompactMode|applyQuickAssistantBounds/);
  assert.doesNotMatch(mainProcess, /quickAssistant\.(setExpanded|setDisplayMode|setInteractionState|pickAttachments|captureScreenshot|cancelAttachmentTask|openMainAssistant|openSettings)/);
  assert.match(quickAssistantWindow, /QUICK_ASSISTANT_WEB_COPILOT_SIZE/);
  assert.doesNotMatch(quickAssistantWindow, /QUICK_ASSISTANT_COMPACT|QuickAssistantDisplayMode|createQuickAssistantWindowState|getQuickAssistantBounds/);
  assert.match(preloadQuickAssistantApi, /hide/);
  assert.match(preloadQuickAssistantApi, /openControlCenter/);
  assert.doesNotMatch(preloadQuickAssistantApi, /setExpanded|setDisplayMode|setInteractionState|onCompactModeRequested|pickAttachments|captureScreenshot|cancelAttachmentTask|openMainAssistant|openSettings/);
  assert.match(contractQuickAssistantApi, /hide/);
  assert.match(contractQuickAssistantApi, /openControlCenter/);
  assert.doesNotMatch(contractQuickAssistantApi, /setExpanded|setDisplayMode|setInteractionState|onCompactModeRequested|pickAttachments|captureScreenshot|cancelAttachmentTask|openMainAssistant|openSettings/);
  assert.doesNotMatch(globalStyles, /\.quick-(?!(?:web|assistant-settings))|quick-message|quick-artifact|quick-composer|quick-attachment|attachment-action-menu/u);
});

test("desktop pet appearance picker confirms persistence before success feedback", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );

  assert.match(settingsPage, /const desktopPetSupported = isMac \|\| isWindows;/);
  assert.match(settingsPage, /if \(!desktopPetSupported\) \{[\s\S]{0,120}return;/);
  assert.match(settingsPage, /case "desktopPet":/);
  assert.match(settingsPage, /return desktopPetSupported \? \(/);
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
