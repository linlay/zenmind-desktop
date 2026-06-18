import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readSourceFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

function readJsonFile(...segments) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, ...segments), "utf8"));
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function readCssWithImports(filePath, visited = new Set()) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (visited.has(absolutePath)) {
    return "";
  }
  visited.add(absolutePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  return content.replace(/@import\s+["']([^"']+)["'];/g, (_match, importPath) =>
    readCssWithImports(path.resolve(path.dirname(absolutePath), importPath), visited)
  );
}

function readRendererStyles() {
  return readCssWithImports(path.join(projectRoot, "src", "renderer", "styles.css"));
}

function readAppShellSource() {
  return [
    readSourceFile("src", "shared", "agent-webclient-routes.ts"),
    readSourceFile("src", "renderer", "App.tsx"),
    readSourceFile("src", "renderer", "app-shell", "AppShell.tsx"),
    readSourceFile("src", "renderer", "app-shell", "startup", "StartupGate.tsx"),
    readSourceFile("src", "renderer", "app-shell", "embedded-surfaces", "EmbeddedSurfaceHosts.tsx"),
    readSourceFile("src", "renderer", "copilot", "sidebar-copilot", "AgentWebclientCopilotDock.tsx")
  ].join("\n");
}

function readSharedContractsSource() {
  return [
    readSourceFile("src", "shared", "contracts.ts"),
    readSourceFile("src", "shared", "contracts", "services.ts"),
    readSourceFile("src", "shared", "contracts", "manifest.ts"),
    readSourceFile("src", "shared", "contracts", "startup.ts"),
    readSourceFile("src", "shared", "contracts", "navigation.ts"),
    readSourceFile("src", "shared", "contracts", "pet-copilot.ts"),
    readSourceFile("src", "shared", "contracts", "copilot.ts"),
    readSourceFile("src", "shared", "contracts", "attachments.ts"),
    readSourceFile("src", "shared", "contracts", "marketplace.ts"),
    readSourceFile("src", "shared", "contracts", "task-board.ts"),
    readSourceFile("src", "shared", "contracts", "webs.ts"),
    readSourceFile("src", "shared", "contracts", "desktop-api.ts")
  ].join("\n");
}

function collectTextFiles(root, files = []) {
  for (const child of fs.readdirSync(root, { withFileTypes: true })) {
    const childPath = path.join(root, child.name);
    if (child.isDirectory()) {
      collectTextFiles(childPath, files);
      continue;
    }
    if (/\.(?:ts|tsx|js|mjs|json|md)$/u.test(child.name)) {
      files.push(childPath);
    }
  }
  return files;
}

function textFromCodes(...codes) {
  return String.fromCharCode(...codes);
}

function indexOfRequired(content, value) {
  const index = content.indexOf(value);
  assert.notEqual(index, -1, `expected to find ${value}`);
  return index;
}

test("source and tests do not contain internal endpoint or legacy icon literals", () => {
  const internalHostSuffix = textFromCodes(46, 110, 101, 116);
  const internalLoginHostPrefix = textFromCodes(101, 105, 97, 109, 46);
  const internalVendorHost = textFromCodes(113, 105, 117, 101, 114);
  const internalBrokerHost = textFromCodes(103, 116, 106, 97, 113, 104);
  const forbiddenValues = [
    "47.100.131." + "144:9001",
    internalVendorHost,
    internalBrokerHost,
    internalLoginHostPrefix + internalVendorHost + internalHostSuffix,
    internalLoginHostPrefix + internalBrokerHost + internalHostSuffix,
    "jira.example" + ".com",
    "zeni" + "th"
  ];
  const files = [
    ...collectTextFiles(path.join(projectRoot, "src")),
    ...collectTextFiles(path.join(projectRoot, "test"))
  ];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    for (const forbiddenValue of forbiddenValues) {
      assert.equal(
        content.includes(forbiddenValue),
        false,
        `${path.relative(projectRoot, filePath)} contains a forbidden literal`
      );
    }
  }
});

test("renderer entry uses HashRouter for Electron routing", () => {
  const rendererEntry = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "main.tsx"),
    "utf8"
  );

  assert.match(rendererEntry, /HashRouter/);
  assert.match(rendererEntry, /import \{ PRODUCT_NAME, STORAGE_NAMESPACE \}/);
  assert.match(rendererEntry, /document\.title = PRODUCT_NAME;/);
  assert.doesNotMatch(rendererEntry, /BrowserRouter/);
});

test("brand i18n owns built-in desktop pet appearance copy", () => {
  const zhDictionary = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enDictionary = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");
  const cutejZh = readJsonFile("brands", "cutej", "i18n", "zh-CN.json");
  const cutejEn = readJsonFile("brands", "cutej", "i18n", "en-US.json");
  const zenmindZh = readJsonFile("brands", "zenmind", "i18n", "zh-CN.json");
  const zenmindEn = readJsonFile("brands", "zenmind", "i18n", "en-US.json");

  for (const dictionary of [zhDictionary, enDictionary]) {
    assert.doesNotMatch(dictionary, /isCuteJBrand/);
    assert.match(
      dictionary,
      /brandMessages\["desktopPet\.appearance\.classic\.name"\]\s*\?\?\s*APP_BRAND\.desktopPet\.displayName/
    );
    assert.match(
      dictionary,
      /brandMessages\["desktopPet\.appearance\.classic\.description"\]\s*\?\?\s*APP_BRAND\.desktopPet\.description/
    );
  }

  assert.equal(cutejZh["desktopPet.appearance.classic.name"], "小君");
  assert.equal(cutejEn["desktopPet.appearance.classic.name"], "CuteJ");
  assert.equal(zenmindZh["desktopPet.appearance.classic.name"], "小禅");
  assert.equal(zenmindEn["desktopPet.appearance.classic.name"], "Zenmi");
});

test("desktop renderer API no longer exposes native agent-platform request bridge", () => {
  const preloadSource = readSourceFile("src", "preload", "index.ts");
  const desktopApi = readSourceFile("src", "shared", "contracts", "desktop-api.ts");
  const mainProcess = readSourceFile("src", "main", "index.ts");

  assert.match(preloadSource, /agentAuth:\s*\{[\s\S]*?issueAccessToken/);
  assert.doesNotMatch(preloadSource, /agentPlatform\.request/);
  assert.doesNotMatch(preloadSource, /agentPlatform:\s*\{/);
  assert.doesNotMatch(desktopApi, /AgentPlatformRequestInput/);
  assert.doesNotMatch(desktopApi, /agentPlatform:\s*\{/);
  assert.doesNotMatch(mainProcess, /registerAgentPlatformIpcHandlers/);
});

test("sidebar does not expose the built-in Chrome surface", () => {
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );

  assert.doesNotMatch(sidebarSource, /browserNavItem/);
  assert.doesNotMatch(sidebarSource, /BUILTIN_BROWSER_ROUTE/);
});

test("main agent webclient keeps chat and copilot webviews separate from management", () => {
  const surfaceHosts = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx"
  );

  assert.match(surfaceHosts, /const AGENT_WEBCLIENT_CHAT_SURFACE_ID = "agent-webclient-chat"/);
  assert.match(surfaceHosts, /const AGENT_WEBCLIENT_COPILOT_SURFACE_ID = "agent-webclient-copilot"/);
  assert.match(surfaceHosts, /lastAgentChatRouteRef/);
  assert.match(surfaceHosts, /lastCopilotRouteRef/);
  assert.match(surfaceHosts, /activeAgentWebclientRouteKind === "chat"/);
  assert.match(surfaceHosts, /activeAgentWebclientRouteKind === "copilot"/);
  assert.match(surfaceHosts, /surfaceId=\{AGENT_WEBCLIENT_CHAT_SURFACE_ID\}/);
  assert.match(surfaceHosts, /surfaceId=\{AGENT_WEBCLIENT_COPILOT_SURFACE_ID\}/);
  assert.match(surfaceHosts, /surfaceId=\{AGENT_WEBCLIENT_PLUGIN_ID\}/);
  assert.match(surfaceHosts, /pluginId=\{AGENT_WEBCLIENT_PLUGIN_ID\}/);
  assert.match(surfaceHosts, /activeAgentWebclientRouteKind === "management" \? activeAgentWebclientRoute\?\.embedPath : undefined/);
});

test("agent webclient management routes render embedded webclient pages", () => {
  const routeDefinitions = readSourceFile("src", "shared", "agent-webclient-routes.ts");
  const appShellCss = readSourceFile("src", "renderer", "styles", "app-shell.css");
  const globalStyles = readSourceFile("src", "renderer", "styles.css");
  const appShell = readSourceFile("src", "renderer", "app-shell", "AppShell.tsx");
  const manifestContracts = readSourceFile("src", "shared", "contracts", "manifest.ts");
  const pluginPage = readSourceFile("src", "renderer", "pages", "plugin", "PluginPage.tsx");
  const surfaceHosts = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx"
  );

  assert.match(routeDefinitions, /routePath:\s*"\/agents"[\s\S]*?mode:\s*"embedded"/);
  assert.match(routeDefinitions, /routePath:\s*"\/automations"[\s\S]*?mode:\s*"embedded"/);
  assert.match(routeDefinitions, /routePath:\s*"\/memory"[\s\S]*?mode:\s*"embedded"/);
  assert.match(routeDefinitions, /routePath:\s*"\/registries"[\s\S]*?embedPath:\s*"\/registries"[\s\S]*?mode:\s*"embedded"/);
  assert.match(routeDefinitions, /routePath:\s*"\/copilot"[\s\S]*?mode:\s*"embedded"/);
  assert.match(routeDefinitions, /"\/agents\/:agentKey"/);
  assert.match(appShell, /path=\{routeDefinition\.routePath\}[\s\S]*?element=\{null\}/);
  assert.match(appShell, /path=\{routePattern\}[\s\S]*?element=\{null\}/);
  assert.match(appShell, /function resolveAgentManagementWebclientRoute\(pathname: string, search: string\)[\s\S]*?mode:\s*"embedded"/);
  assert.match(surfaceHosts, /activeAgentWebclientRouteKind === "management" \? activeAgentWebclientRoute\?\.embedPath : undefined/);
  assert.match(surfaceHosts, /surfaceId=\{AGENT_WEBCLIENT_PLUGIN_ID\}/);
  assert.match(manifestContracts, /spaRoutes:\s*\[[\s\S]*?"\/registries"[\s\S]*?\]/);
  assert.match(pluginPage, /normalizedEmbedPath === "\/registries"/);
  assert.doesNotMatch(appShell, /AgentWebclientNativeRouteOutlet/);
  assert.doesNotMatch(appShell, /usesAgentNativeSurface/);
  assert.doesNotMatch(appShellCss, /has-agent-native-surface/);
  assert.doesNotMatch(appShellCss, /agent-native-surface-body/);
  assert.doesNotMatch(globalStyles, /agent-webclient-native\.css/);
});

test("control center keeps service operations in the prototype dashboard layout", () => {
  const controlCenter = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "control-center", "ControlCenterPage.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();

  assert.match(controlCenter, /control-center-dashboard-metrics/);
  assert.match(controlCenter, /service-catalog/);
  assert.match(controlCenter, /control-center-service-hero/);
  assert.match(controlCenter, /service-detail-metadata/);
  assert.match(controlCenter, /config-status-dot/);
  assert.doesNotMatch(controlCenter, /<h2>服务目录<\/h2>/);
  assert.match(controlCenter, /group\.key === "core"[\s\S]*?className="service-catalog-quick-start"/);
  assert.match(controlCenter, /group\.key === "market"[\s\S]*?className="service-catalog-import"/);
  assert.doesNotMatch(controlCenter, /service-catalog-foot/);
  assert.match(controlCenter, /useState<ServiceGroupKey \| null>\(\s*"market",?\s*\)/);
  assert.match(controlCenter, /function ConfigTerminalIcon\(\)/);
  assert.match(controlCenter, /<ConfigTerminalIcon \/>/);
  assert.match(controlCenter, /function SelectChevronIcon\(\)/);
  assert.match(controlCenter, /<SelectChevronIcon \/>/);
  assert.match(controlCenter, /const \[configFileSelectOpen, setConfigFileSelectOpen\] = useState\(false\);/);
  assert.match(controlCenter, /function ServiceHelpIcon\(\)/);
  assert.match(controlCenter, /<ServiceHelpIcon \/>/);
  assert.match(controlCenter, /function ServiceInfoIcon\(\)/);
  assert.match(controlCenter, /function LogArticleIcon\(\)/);
  assert.match(controlCenter, /function LogFolderIcon\(\)/);
  assert.doesNotMatch(controlCenter, /config-terminal-icon" aria-hidden="true">&gt;_/);
  assert.doesNotMatch(controlCenter, /<span>进程 ID \(PID\)<\/span>/);
  assert.doesNotMatch(controlCenter, /<span>主日志路径<\/span>/);
  assert.doesNotMatch(controlCenter, /<span>错误日志路径<\/span>/);
  assert.match(controlCenter, /label:\s*t\("controlCenter\.meta\.description"\)/);
  assert.match(controlCenter, /label:\s*t\("controlCenter\.meta\.installDir"\)/);
  assert.match(controlCenter, /label:\s*t\("controlCenter\.meta\.mainLogPath"\)/);
  assert.match(controlCenter, /label:\s*t\("controlCenter\.meta\.errorLogPath"\)/);
  assert.match(controlCenter, /label:\s*t\("controlCenter\.meta\.pid"\)/);
  assert.match(controlCenter, /service-detail-metadata-item is-endpoint/);
  assert.match(controlCenter, /service-detail-metadata-item is-log-actions/);
  assert.match(controlCenter, /t\("controlCenter\.logs"\)/);
  assert.match(controlCenter, /className="service-detail-log-action"[\s\S]*?aria-label=\{t\("controlCenter\.viewLog"\)\}[\s\S]*?<LogArticleIcon \/>/);
  assert.match(controlCenter, /className="service-detail-log-action"[\s\S]*?aria-label=\{t\("controlCenter\.openLogLocation"\)\}[\s\S]*?<LogFolderIcon \/>/);
  assert.match(controlCenter, /icon:\s*"article"/);
  assert.match(controlCenter, /icon:\s*"folder"/);
  assert.match(controlCenter, /action\.icon ===[\s\S]*?"article"[\s\S]*?<LogArticleIcon \/>[\s\S]*?<LogFolderIcon \/>/);
  assert.match(controlCenter, /aria-label=\{t\("controlCenter\.config\.showFileLocation"\)\}[\s\S]*?<LogFolderIcon \/>/);
  assert.match(controlCenter, /openLogViewer\([\s\S]*?activeDetailService,[\s\S]*?"main"/);
  assert.match(controlCenter, /revealServicePath\(\s*activeDetailService\s*\.healthMeta\.logFilePath,\s*"file",?\s*\)/);
  assert.match(controlCenter, /config-title-main[\s\S]*?config-title-label[\s\S]*?config-terminal-icon[\s\S]*?<ConfigTerminalIcon \/>[\s\S]*?<h3>\{t\("controlCenter\.config"\)\}<\/h3>[\s\S]*?config-file-select config-title-file-select[\s\S]*?data-config-file-select-root[\s\S]*?config-file-select-trigger[\s\S]*?aria-haspopup="listbox"[\s\S]*?config-file-select-panel[\s\S]*?role="listbox"[\s\S]*?config-select-wrap/);
  assert.match(controlCenter, /function selectConfigFile\(configKey: string\)/);
  assert.match(controlCenter, /service-nav-card is-compact-service/);
  assert.match(controlCenter, /service-nav-help-button/);
  assert.match(controlCenter, /type HelpTipState/);
  assert.match(controlCenter, /const pageRef = useRef<HTMLElement \| null>\(null\);/);
  assert.match(controlCenter, /<section ref=\{pageRef\} className="control-center-page workspace-wide">/);
  assert.match(controlCenter, /service-nav-help-tip/);
  assert.match(controlCenter, /service-nav-help-tip-portal/);
  assert.match(controlCenter, /role="tooltip"/);
  assert.match(controlCenter, /openServiceHelp\(\s*cardId,\s*cardName,\s*helpDescription,\s*event\.currentTarget,?\s*\)/);
  assert.match(controlCenter, /getBoundingClientRect\(\)/);
  assert.match(controlCenter, /const pageRect = pageRef\.current\?\.getBoundingClientRect\(\);/);
  assert.match(controlCenter, /top:\s*anchorRect\.top\s*-\s*\(pageRect\?\.top \?\? 0\)\s*\+\s*anchorRect\.height \/ 2/);
  assert.match(controlCenter, /left:\s*anchorRect\.right - \(pageRect\?\.left \?\? 0\) \+ 10/);
  assert.match(controlCenter, /style=\{\{\s*top:\s*`\$\{helpTip\.top\}px`,\s*left:\s*`\$\{helpTip\.left\}px`,?\s*\}\}/);
  assert.doesNotMatch(controlCenter, /<span className="service-nav-help-tip" role="tooltip">/);
  const serviceHelpFunctionBody = controlCenter.slice(
    controlCenter.indexOf("function openServiceHelp("),
    controlCenter.indexOf("function openServiceDetail(")
  );
  assert.ok(serviceHelpFunctionBody);
  assert.doesNotMatch(serviceHelpFunctionBody, /setDetailDialogOpen\(true\)/);
  assert.doesNotMatch(controlCenter, /function ServiceDetailIcon/);
  assert.doesNotMatch(controlCenter, /<ServiceDetailIcon \/>/);
  assert.match(controlCenter, /className="service-title-actions service-primary-actions"/);
  assert.match(controlCenter, /openServiceDetail\(\s*activeDetailService\.id,?\s*\)/);
  assert.match(controlCenter, /aria-label=\{t\("controlCenter\.actions\.details"\)\}[\s\S]*?<ServiceInfoIcon \/>/);
  assert.match(controlCenter, /activeDetailService\.status !== "running"/);
  assert.match(controlCenter, /role="button"[\s\S]*?handleServiceCardKeyDown\(\s*event,\s*cardId,?\s*\)/);
  assert.doesNotMatch(controlCenter, /<p className="service-nav-description">/);
  assert.match(controlCenter, /service-nav-version-inline/);
  assert.match(controlCenter, /t\("controlCenter\.copy"\)/);
  assert.match(controlCenter, /t\("controlCenter\.metrics\.registeredServices"\)/);
  assert.match(controlCenter, /t\("controlCenter\.metrics\.runningInstances"\)/);
  assert.match(controlCenter, /handleQuickStart/);
  assert.match(controlCenter, /handleInstallPlugin/);
  assert.match(controlCenter, /installBuiltinFromBundle/);
  assert.match(controlCenter, /initialize\(\s*activeDetailService\.id,?\s*\)/);
  assert.match(controlCenter, /installBuiltin\(\s*activeDetailService\.id,?\s*\)/);
  assert.match(controlCenter, /uninstallPlugin\(\s*activeDetailService\.id,?\s*\)/);
  assert.match(controlCenter, /service-action-icon-start/);
  assert.match(controlCenter, /service-action-icon-stop/);
  assert.match(controlCenter, /openLogViewer/);
  assert.match(controlCenter, /writeConfig/);
  assert.match(controlCenter, /PageFeedbackStack/);
  assert.match(controlCenter, /\{feedback \|\| error \? \(\s*<PageFeedbackStack/);
  assert.doesNotMatch(controlCenter, /control-center-feedback-anchor/);
  assert.match(globalStyles, /\.control-center-dashboard-metrics\s*\{/);
  assert.match(globalStyles, /:root\s*\{[\s\S]*?--desktop-ui-bg:\s*#ffffff;[\s\S]*?--desktop-ui-card:\s*#ffffff;[\s\S]*?--desktop-ui-primary:\s*#0052d9;[\s\S]*?--desktop-ui-code-bg:\s*#0d1117;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\]\s*\{[\s\S]*?--desktop-ui-bg:\s*#181818;[\s\S]*?--desktop-ui-card:\s*#181818;[\s\S]*?--desktop-ui-primary:\s*#5790ff;[\s\S]*?--desktop-ui-code-bg:\s*#090c11;/);
  assert.match(globalStyles, /\.control-center-page\s*\{[\s\S]*?position:\s*relative;/);
  assert.match(globalStyles, /\.control-center-page\s*\{[\s\S]*?--control-center-bg:\s*var\(--desktop-ui-bg\);[\s\S]*?--control-center-blue:\s*var\(--desktop-ui-primary\);[\s\S]*?--control-center-code:\s*var\(--desktop-ui-code-bg\);/);
  assert.match(globalStyles, /\.control-center-page\s*\{[\s\S]*?--control-center-card-radius:\s*8px;[\s\S]*?--control-center-control-radius:\s*6px;/);
  assert.match(globalStyles, /\.control-center-metric-card\s*\{[\s\S]*?border-radius:\s*var\(--control-center-card-radius\);/);
  assert.match(globalStyles, /\.service-sider\.service-catalog\s*\{[\s\S]*?border-radius:\s*var\(--control-center-card-radius\);/);
  assert.match(globalStyles, /\.control-center-service-hero\s*\{[\s\S]*?border-radius:\s*var\(--control-center-card-radius\);/);
  assert.match(globalStyles, /\.config-panel\s*\{[\s\S]*?border-radius:\s*var\(--control-center-card-radius\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.control-center-metric-card\s*\{[\s\S]*?background:\s*var\(--control-center-card\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.service-sider\.service-catalog\s*\{[\s\S]*?background:\s*var\(--control-center-card\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.control-center-service-hero\s*\{[\s\S]*?background:\s*var\(--control-center-card\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.config-panel\s*\{[\s\S]*?background:\s*var\(--control-center-card\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.config-head\s*\{[\s\S]*?background:\s*var\(--control-center-card\);/);
  assert.match(globalStyles, /\.config-file-select-trigger\s*\{[\s\S]*?padding:\s*0 40px 0 12px;/);
  assert.match(globalStyles, /\.config-file-select-trigger svg\s*\{[\s\S]*?right:\s*14px;/);
  assert.match(globalStyles, /\.config-file-select-panel\s*\{[\s\S]*?top:\s*calc\(100% \+ 6px\);/);
  assert.match(globalStyles, /\.config-file-select-trigger\s*\{[\s\S]*?background:\s*var\(--control-center-bg\);/);
  assert.match(globalStyles, /\.config-file-select-panel\s*\{[\s\S]*?background:\s*var\(--control-center-bg\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.control-center-page \.config-file-select-trigger\s*\{[\s\S]*?background:\s*var\(--control-center-bg\);/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.control-center-metric-card\s*\{[\s\S]*?linear-gradient\(180deg,\s*#202631/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.service-sider\.service-catalog\s*\{[\s\S]*?linear-gradient\(180deg,\s*#1f2530/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.control-center-service-hero\s*\{[\s\S]*?linear-gradient\(180deg,\s*#202731/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.config-panel\s*\{[\s\S]*?linear-gradient\(180deg,\s*#1f2530/);
  assert.match(globalStyles, /\.service-catalog\s*\{/);
  assert.match(globalStyles, /\.page-feedback-anchor\s*\{/);
  assert.match(globalStyles, /\.page-feedback-layer\s*\{/);
  assert.match(globalStyles, /\.page-feedback-toast\s*\{/);
  assert.match(globalStyles, /\.page-feedback-dismiss\s*\{/);
  assert.doesNotMatch(globalStyles, /\.control-center-feedback-anchor\s*\{/);
  assert.doesNotMatch(globalStyles, /\.control-center-feedback-layer\s*\{/);
  assert.doesNotMatch(globalStyles, /\.control-center-feedback-toast\s*\{/);
  assert.match(globalStyles, /\.service-sider\.service-catalog\s*\{[\s\S]*?overflow:\s*visible;/);
  assert.doesNotMatch(globalStyles, /\.service-catalog-head\s*\{/);
  assert.doesNotMatch(globalStyles, /\.service-catalog-foot\s*\{/);
  assert.match(globalStyles, /\.service-group-head\s*\{[\s\S]*?justify-content:\s*space-between;/);
  assert.match(globalStyles, /\.service-catalog-import\s*\{[\s\S]*?min-height:\s*32px;/);
  assert.match(globalStyles, /\.service-group-copy h2\s*\{[\s\S]*?font-size:\s*15px;[\s\S]*?font-weight:\s*900;/);
  assert.match(globalStyles, /\.service-nav-card\.is-compact-service h3\s*\{[\s\S]*?font-size:\s*14px;[\s\S]*?font-weight:\s*800;/);
  assert.match(globalStyles, /\.control-center-service-hero\s*\{/);
  assert.match(globalStyles, /\.service-detail-metadata\s*\{[\s\S]*?grid-template-columns:\s*minmax\(88px,\s*0\.55fr\) minmax\(112px,\s*0\.65fr\) minmax\(92px,\s*0\.55fr\) minmax\(220px,\s*1\.6fr\)\s*;/);
  assert.match(globalStyles, /\.service-detail-log-actions\s*\{/);
  assert.match(globalStyles, /\.service-detail-log-action\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?border:\s*0;/);
  assert.match(globalStyles, /\.service-detail-log-action svg\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/);
  assert.match(globalStyles, /\.config-status-dot\s*\{/);
  assert.match(globalStyles, /\.config-title-label\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?gap:\s*6px;/);
  assert.match(globalStyles, /\.config-terminal-icon\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;[\s\S]*?color:\s*#64748b;/);
  const configTerminalIconRule = globalStyles.match(/\.config-terminal-icon\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body;
  assert.ok(configTerminalIconRule);
  assert.doesNotMatch(configTerminalIconRule, /background:/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.config-terminal-icon\s*\{[\s\S]*?color:\s*#9aa8bd;/);
  assert.match(globalStyles, /\.config-terminal-icon svg\s*\{/);
  assert.match(globalStyles, /\.config-title-file-select\s*\{[\s\S]*?width:\s*clamp\(150px,\s*16vw,\s*320px\);/);
  assert.match(globalStyles, /\.config-editor\s*\{[\s\S]*?padding:\s*22px 24px;/);
  assert.doesNotMatch(globalStyles, /linear-gradient\(90deg,\s*var\(--control-center-code-line\)/);
  assert.match(globalStyles, /\.service-nav-card\.is-compact-service\s*\{[\s\S]*?min-height:\s*58px;/);
  assert.match(globalStyles, /\.service-nav-card\s*\{[\s\S]*?position:\s*relative;/);
  assert.doesNotMatch(globalStyles, /\.service-nav-card\.is-help-open\s*\{/);
  assert.match(globalStyles, /\.service-nav-help-button\s*\{/);
  assert.match(globalStyles, /\.service-nav-help-button svg\s*\{/);
  assert.match(globalStyles, /\.service-nav-help-wrap\s*\{[\s\S]*?z-index:\s*25;/);
  assert.match(globalStyles, /\.service-nav-help-tip\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?z-index:\s*120;[\s\S]*?max-width:\s*260px;[\s\S]*?border:\s*1px solid var\(--control-center-border\);[\s\S]*?background:\s*var\(--control-center-card\);[\s\S]*?font-size:\s*12px;/);
  assert.match(globalStyles, /\.service-nav-help-tip\s*\{[\s\S]*?transform:\s*translateY\(-50%\);/);
  assert.match(globalStyles, /\.service-nav-help-tip::before\s*\{[\s\S]*?top:\s*50%;[\s\S]*?left:\s*-5px;[\s\S]*?transform:\s*translateY\(-50%\) rotate\(45deg\);/);
  const serviceNavHelpTipRule = globalStyles.match(/\.service-nav-help-tip\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body;
  const darkServiceNavHelpTipRule = globalStyles.match(/:root\[data-theme="dark"\] \.service-nav-help-tip\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body;
  assert.ok(serviceNavHelpTipRule);
  assert.ok(darkServiceNavHelpTipRule);
  assert.doesNotMatch(serviceNavHelpTipRule, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.98\);/);
  assert.doesNotMatch(darkServiceNavHelpTipRule, /background:\s*#20242b;/);
  assert.match(controlCenter, /data-tooltip=\{t\("controlCenter\.help\.viewDescription"\)\}/);
  assert.match(controlCenter, /data-tooltip=\{t\("controlCenter\.actions\.openFrontend"\)\}/);
  assert.match(controlCenter, /activeDetailService\.serviceMode === "service" \|\|[\s\S]*?activeDetailService\.serviceMode === "resource" \? \(/);
  assert.match(
    controlCenter,
    /data-tooltip=\{\s*activeDetailService\.status ===\s*"initialization-required"\s*\?\s*t\("controlCenter\.actions\.initialize"\)\s*:\s*t\("controlCenter\.actions\.reinitialize"\)\s*\}/
  );
  assert.doesNotMatch(
    controlCenter,
    /title="(?:查看说明|重新安装|启动服务|停止|重启|打开前端|安装|卸载插件)"/
  );
  assert.doesNotMatch(controlCenter, /title=\{activeDetailService\.status === "initialization-required"/);
  assert.match(globalStyles, /\.service-nav-version-inline\s*\{/);
  assert.match(globalStyles, /\.service-action-button,[\s\S]*?\.service-title-text-button\.service-action-button\s*\{[\s\S]*?border:\s*0;/);
  assert.match(globalStyles, /\.service-action-button,[\s\S]*?\.service-title-text-button\.service-action-button\s*\{[\s\S]*?flex:\s*0 0 36px;[\s\S]*?height:\s*36px;[\s\S]*?max-width:\s*36px;/);
  assert.match(globalStyles, /\.service-action-button \.service-action-icon\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/);
  assert.match(controlCenter, /<circle cx="12" cy="6\.75" r="2\.15" \/>/);
  assert.match(controlCenter, /<path d="M10\.55 10\.05h2\.9v9\.2h-2\.9z" \/>/);
  assert.match(globalStyles, /\.service-action-button \.service-action-icon-info\s*\{[\s\S]*?fill:\s*currentColor;[\s\S]*?stroke:\s*none;[\s\S]*?transform:\s*translateY\(0\.5px\);/);
  assert.match(globalStyles, /\.service-action-button\[data-tooltip\]::after\s*\{[\s\S]*?opacity:\s*0;/);
  assert.match(
    globalStyles,
    /\.service-action-button\[data-tooltip\]:hover:not\(:disabled\)::after,[\s\S]*?transition-delay:\s*0\.12s;/
  );
  const unifiedServiceActionToneRule = globalStyles.match(
    /\.service-action-button\.is-primary,[\s\S]*?\.service-title-text-button\.service-action-button\.is-warning\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body;
  assert.ok(unifiedServiceActionToneRule);
  assert.match(unifiedServiceActionToneRule, /background:\s*#f8fafc;/);
  assert.match(unifiedServiceActionToneRule, /color:\s*var\(--control-center-muted\);/);
  assert.doesNotMatch(unifiedServiceActionToneRule, /var\(--control-center-blue\)|var\(--danger\)|#d88911|#ffad4f/);
  assert.match(globalStyles, /\.control-center-link-action\.icon-link-action\s*\{[\s\S]*?border:\s*0;/);
  assert.match(globalStyles, /\.config-save-button\s*\{[\s\S]*?border:\s*0;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.service-action-button,[\s\S]*?:root\[data-theme="dark"\] \.service-title-text-button\.service-action-button\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.service-hero-icon\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.control-center-page \.config-file-select-panel\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.control-center-page \.config-editor\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.service-status-message\.danger\s*\{/);
});

test("control center internal endpoint opens service frontend entrypoints", () => {
  const controlCenter = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "control-center", "ControlCenterPage.tsx"),
    "utf8"
  );

  assert.match(controlCenter, /function shouldOpenControlCenterEndpointInternally\(/);
  assert.match(controlCenter, /service\.frontendMode !== "none" \|\| service\.id === "agent-platform"/);
  assert.match(controlCenter, /function resolveControlCenterEndpoint\(/);
  assert.match(controlCenter, /service\.id === "identity-center"[\s\S]*?return appendEndpointPath\(baseUrl, "\/admin\/"\)/);
  assert.match(controlCenter, /service\.id === "agent-platform"[\s\S]*?return appendEndpointPath\(baseUrl, "\/monitor"\)/);
  assert.match(controlCenter, /const detailEndpoint = activeDetailService\s*\?\s*resolveControlCenterEndpoint\(activeDetailService\)\s*:\s*"";/);
  assert.match(controlCenter, /if \(\s*!shouldOpenControlCenterEndpointInternally\(activeDetailService\)\s*\)/);
  assert.doesNotMatch(controlCenter, /const detailEndpoint = activeDetailService\?\.healthMeta\.webUrl \?\? "";/);
});

test("embedded service previews load auth and platform entrypoints directly", () => {
  const embeddedSurfaceHosts = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx"
  );
  const pluginPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "plugin", "PluginPage.tsx"),
    "utf8"
  );

  assert.match(embeddedSurfaceHosts, /function shouldLoadInitialServiceUrlDirectly\(/);
  assert.match(embeddedSurfaceHosts, /pluginId === "identity-center" \|\| pluginId === "agent-platform"/);
  assert.match(embeddedSurfaceHosts, /loadInitialEmbeddedUrlDirectly=\{shouldLoadInitialServiceUrlDirectly\(pluginId\)\}/);
  assert.match(pluginPage, /service\.id !== "agent-platform"/);
  assert.match(pluginPage, /agentPlatformMonitorAccessToken/);
});

test("startup loading screen uses localized copy", () => {
  const startupGate = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "startup",
    "StartupGate.tsx"
  );

  assert.match(startupGate, /useI18n\(\)/);
  assert.match(startupGate, /t\("startup\.title\.starting"\)/);
  assert.match(startupGate, /t\("startup\.phase\.installing"\)/);
  assert.match(startupGate, /t\("startup\.service\.authentication"\)/);
  assert.match(startupGate, /t\("startup\.action\.openControlCenter"\)/);
  assert.doesNotMatch(startupGate, /getServiceDisplayName/);
  assert.doesNotMatch(
    startupGate,
    /"(?:正在启动|服务未就绪|启动较慢|已就绪|安装中\.\.\.|初始化中\.\.\.|启动中\.\.\.|等待前序服务|等待启动|重新检查|进入控制中心|认证服务|智能体平台)"/
  );
});

test("desktop custom theme tokens are shared by control center and log viewer", () => {
  const globalStyles = readRendererStyles();

  assert.match(globalStyles, /:root\s*\{[\s\S]*?--desktop-ui-bg:\s*#ffffff;[\s\S]*?--desktop-ui-card:\s*#ffffff;[\s\S]*?--desktop-ui-primary:\s*#0052d9;[\s\S]*?--desktop-ui-code-bg:\s*#0d1117;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\]\s*\{[\s\S]*?--desktop-ui-bg:\s*#181818;[\s\S]*?--desktop-ui-card:\s*#181818;[\s\S]*?--desktop-ui-primary:\s*#5790ff;[\s\S]*?--desktop-ui-code-bg:\s*#090c11;/);
  assert.match(globalStyles, /\.control-center-page\s*\{[\s\S]*?--control-center-bg:\s*var\(--desktop-ui-bg\);[\s\S]*?--control-center-blue:\s*var\(--desktop-ui-primary\);[\s\S]*?--control-center-code:\s*var\(--desktop-ui-code-bg\);/);
  assert.match(globalStyles, /\.log-viewer-page\s*\{[\s\S]*?background:\s*var\(--desktop-ui-bg\);[\s\S]*?color:\s*var\(--desktop-ui-text\);/);
  assert.match(globalStyles, /\.log-viewer-body\s*\{[\s\S]*?background:\s*var\(--desktop-ui-code-bg\);/);
  assert.match(globalStyles, /\.log-viewer-content\s*\{[\s\S]*?color:\s*var\(--desktop-ui-code-text\);/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.control-center-page\s*\{[\s\S]*?--control-center-bg:/);
});

test("assistant launcher sits beside the sidebar collapse button", () => {
  const appShell = readAppShellSource();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const sidebarAssistantClosedIcon = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "assets", "sidebar-icons", "sidebar-assistant-closed.svg"),
    "utf8"
  );
  const sidebarAssistantOpenIcon = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "assets", "sidebar-icons", "sidebar-assistant-open.svg"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const nativeAssistantDockPath = path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx");

  assert.equal(fs.existsSync(nativeAssistantDockPath), false);
  assert.match(appShell, /function AgentWebclientCopilotDock/);
  assert.match(appShell, /onOpenAssistantDock=\{\(\) => openAssistantDock\(\)\}/);
  assert.match(appShell, /function buildAgentWebclientCopilotPath/);
  assert.match(appShell, /fallbackAgentKey = ""/);
  assert.match(appShell, /function resolveTargetAgentKey/);
  assert.match(appShell, /normalizeAgentKey\(openRequest\?\.agentKey \?\? openRequest\?\.workerKey \?\? fallbackAgentKey\)/);
  assert.match(appShell, /if \(!agentKey\) \{[\s\S]{0,160}return AGENT_WEBCLIENT_COPILOT_PATH/);
  assert.match(appShell, /if \(!chatId\) \{[\s\S]{0,120}return [\s\S]{0,80}AGENT_WEBCLIENT_COPILOT_PATH[\s\S]{0,80}encodeURIComponent\(agentKey\)/);
  assert.match(appShell, /params\.set\("chatId", chatId\)/);
  assert.match(appShell, /return [\s\S]{0,80}AGENT_WEBCLIENT_COPILOT_PATH[\s\S]{0,80}encodeURIComponent\(agentKey\)[\s\S]{0,80}params\.toString\(\)/);
  assert.match(appShell, /buildAgentWebclientCopilotPath\(openRequest, resolvedAgentKey\)/);
  assert.match(appShell, /embedPath=\{targetEmbedPath\}/);
  assert.match(sidebarSource, /sidebar-top-actions/);
  assert.match(sidebarSource, /sidebar-assistant-top-button/);
  assert.match(sidebarSource, /import \{ PRODUCT_NAME, STORAGE_NAMESPACE \}/);
  assert.match(sidebarSource, /`打开 \$\{PRODUCT_NAME\} 助手`/);
  assert.match(sidebarSource, /`关闭 \$\{PRODUCT_NAME\} 助手`/);
  assert.match(sidebarSource, /`当前页面不可开启 \$\{PRODUCT_NAME\} 助手`/);
  assert.doesNotMatch(sidebarAssistantClosedIcon, /<text\b/);
  assert.doesNotMatch(sidebarAssistantOpenIcon, /<text\b/);
  assert.match(sidebarAssistantClosedIcon, /viewBox="0 0 24 24"/);
  assert.match(sidebarAssistantOpenIcon, /viewBox="0 0 24 24"/);
  assert.match(globalStyles, /--assistant-dock-embedded-width:\s*360px;/);
  assert.match(globalStyles, /\.agent-webclient-copilot-dock\s*\{/);
  assert.doesNotMatch(globalStyles, /\.assistant-dock-/);
  assert.match(globalStyles, /\.sidebar-top-actions\s*\{[\s\S]*?display:\s*inline-flex;/);
});

test("embedded surfaces use theme-backed host colors instead of hard-coded light fallbacks", () => {
  const globalStyles = readRendererStyles();

  assert.match(globalStyles, /--embedded-surface-shell-bg:\s*#fff;/);
  assert.match(globalStyles, /--embedded-surface-dock-bg:\s*#fff;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\][\s\S]*?--embedded-surface-shell-bg:\s*#1f2329;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] body\.embedded-surface-body,\s*[\s\S]*?body\.embedded-surface-body\.mac-translucent-sidebar-body\s*\{[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/);
  assert.match(globalStyles, /\.app-shell\.has-embedded-surface\s*\{[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.app-shell\.is-mac-translucent-sidebar\.has-embedded-surface\s*\{[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.app-shell\.is-mac-translucent-sidebar\.has-embedded-surface::before\s*\{[\s\S]*?display:\s*none;/);
  assert.match(globalStyles, /\.app-shell\.has-embedded-surface \.app-content,\s*[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/);
  assert.match(globalStyles, /\.agent-webclient-copilot-dock\s*\{[\s\S]*?background:\s*var\(--embedded-surface-dock-bg\);/);
  assert.match(globalStyles, /\.pan-frame\s*\{[\s\S]*?background:\s*var\(--embedded-surface-frame-bg\);/);
  assert.match(globalStyles, /\.embedded-plugin-error\s*\{[\s\S]*?background:\s*var\(--embedded-surface-loading-bg\);/);
  assert.match(globalStyles, /--browser-frame-bg:\s*#ffffff;/);
  assert.match(globalStyles, /\.external-webview-panel\s*\{[\s\S]*?background:\s*var\(--browser-frame-bg\);/);
  assert.match(globalStyles, /\.external-webview-frame\s*\{[\s\S]*?background:\s*var\(--browser-frame-bg\);/);
});

test("sidebar collapse toggle moves into the top chrome with expanded and collapsed variants", () => {
  const appShell = readAppShellSource();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const appSidebarRule = globalStyles.match(/^\.app-sidebar\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body;
  const collapseButtonRule = globalStyles.match(/^\.app-sidebar-collapse-button\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body;
  const collapsedMacTopActionsRule = globalStyles.match(
    /^\.app-shell\.is-mac-platform \.app-sidebar\.is-collapsed \.sidebar-top-actions\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body;
  const collapsedMacChromeToolbarRule = globalStyles.match(
    /^\.app-shell\.is-mac-platform \.app-sidebar\.is-collapsed \.sidebar-chrome-toolbar\.is-mac\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body;
  const collapsedMacTopActionButtonRule = globalStyles.match(
    /^\.app-shell\.is-mac-platform \.app-sidebar\.is-collapsed \.sidebar-top-actions \.app-sidebar-collapse-button\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body;
  const collapsedAssistantTopButtonRule = globalStyles.match(
    /^\.app-sidebar\.is-collapsed \.sidebar-top-actions \.sidebar-assistant-top-button\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body;
  const collapseToggleIconSource =
    sidebarSource.match(/function SidebarCollapseToggleIcon[\s\S]*?function SidebarCollapseToggle/u)?.[0] ?? "";

  assert.match(appShell, /onToggleCollapsed=\{toggleSidebarCollapsed\}/);
  assert.match(appShell, /isMac=\{isMac\}/);
  assert.match(appShell, /isWindows=\{isWindows\}/);
  assert.match(appShell, /const renderedSidebarWidth = resolveRenderedSidebarWidth\(sidebarState\);/);
  assert.match(appShell, /const appShellStyle = \{[\s\S]*?"--app-sidebar-width": `\$\{effectiveSidebarWidth\}px`[\s\S]*?\} as CSSProperties;/);
  assert.doesNotMatch(appShell, /className="app-sidebar-collapse-button"/);
  assert.doesNotMatch(appShell, /app-sidebar-drag-region/);
  assert.doesNotMatch(appShell, /is-sidebar-expanded/);
  assert.match(appShell, /className="app-sidebar-shell"/);
  assert.match(appShell, /className=\{\[[\s\S]*?"app-sidebar-resizer"/);
  assert.match(appShell, /role="separator"/);
  assert.match(appShell, /aria-orientation="vertical"/);
  assert.match(appShell, /aria-label="调整侧边栏宽度"/);
  assert.match(appShell, /onPointerDown=\{isSettingsRoute \? undefined : handleSidebarResizerPointerDown\}/);
  assert.match(appShell, /isSettingsRoute \? "is-disabled" : ""/);
  assert.match(globalStyles, /\.app-shell\.is-settings-mode \.app-sidebar-resizer/);
  assert.match(appShell, /effectiveSidebarCollapsed \? "is-sidebar-collapsed" : ""/);
  assert.match(appShell, /isSidebarResizing \? "is-sidebar-resizing" : ""/);
  assert.match(sidebarSource, /onToggleCollapsed\?:\s*\(\)\s*=>\s*void;/);
  assert.match(sidebarSource, /type SidebarCollapseToggleVariant = "compact" \| "nav";/);
  assert.match(sidebarSource, /className=\{\[\s*"app-sidebar-collapse-button",[\s\S]*?"is-compact" : "is-nav"/);
  assert.match(sidebarSource, /aria-expanded=\{!isCollapsed\}/);
  assert.match(sidebarSource, /app-sidebar-collapse-button-icon-panel/);
  assert.match(sidebarSource, /app-sidebar-collapse-button-icon-chevron/);
  assert.match(collapseToggleIconSource, /viewBox="0 0 24 24"/);
  assert.match(collapseToggleIconSource, /fill="none"/);
  assert.match(collapseToggleIconSource, /stroke="currentColor"/);
  assert.match(collapseToggleIconSource, /<rect[^>]*fill="none"/);
  assert.match(collapseToggleIconSource, /<path[^>]*fill="none"/);
  assert.doesNotMatch(collapseToggleIconSource, /viewBox="0 -960 960 960"/);
  assert.doesNotMatch(collapseToggleIconSource, /fill="currentColor"/);
  assert.match(sidebarSource, /<SidebarCollapseToggleIcon isCollapsed=\{isCollapsed\} \/>/);
  assert.match(sidebarSource, /<div className="sidebar-chrome">/);
  assert.match(sidebarSource, /<div className="sidebar-chrome-drag-region" aria-hidden="true" \/>/);
  assert.match(sidebarSource, /className=\{chromeToolbarClassName\}/);
  assert.match(sidebarSource, /<div className="sidebar-top-actions">/);
  assert.doesNotMatch(sidebarSource, /sidebar-collapsed-toggle-slot/);
  assert.doesNotMatch(sidebarSource, /sidebar-collapse-control/);
  assert.ok(appSidebarRule, "missing .app-sidebar rule");
  assert.doesNotMatch(appSidebarRule, /app-region:\s*drag;/);
  assert.doesNotMatch(appSidebarRule, /-webkit-app-region:\s*drag;/);
  assert.ok(collapseButtonRule, "missing .app-sidebar-collapse-button rule");
  assert.match(collapseButtonRule, /appearance:\s*none;/);
  assert.doesNotMatch(globalStyles, /\.app-shell\.is-sidebar-expanded\s*\{/);
  assert.doesNotMatch(globalStyles, /\.app-shell\.is-sidebar-collapsed\s*\{/);
  assert.match(globalStyles, /\.app-shell\.is-sidebar-resizing\s*\{[\s\S]*?user-select:\s*none;/);
  assert.match(globalStyles, /\.app-shell\.is-sidebar-resizing \.app-sidebar-shell\s*\{[\s\S]*?transition:\s*none;/);
  assert.match(globalStyles, /\.sidebar-chrome-toolbar\.is-mac\s*\{[\s\S]*?padding-left:\s*var\(--mac-traffic-light-safe-area\);/);
  assert.match(globalStyles, /\.sidebar-chrome-toolbar\.is-windows,[\s\S]*?justify-content:\s*center;/);
  assert.match(globalStyles, /\.app-sidebar-resizer\s*\{[\s\S]*?cursor:\s*col-resize;/);
  assert.match(globalStyles, /\.app-sidebar-resizer-line\s*\{/);
  assert.match(globalStyles, /\.app-sidebar-resizer:hover \.app-sidebar-resizer-line,[\s\S]*?\.app-sidebar-resizer\.is-active \.app-sidebar-resizer-line\s*\{/);
  assert.doesNotMatch(globalStyles, /\.app-shell\.is-mac-platform\.is-sidebar-collapsed \.app-sidebar-resizer\s*\{[\s\S]*?flex:\s*0 0 0;/);
  assert.doesNotMatch(globalStyles, /\.app-shell\.is-mac-platform\.is-sidebar-collapsed \.app-sidebar-resizer\s*\{[\s\S]*?pointer-events:\s*none;/);
  assert.ok(collapsedMacChromeToolbarRule, "missing mac collapsed chrome toolbar rule");
  assert.match(collapsedMacChromeToolbarRule, /padding:\s*0;/);
  assert.match(collapsedMacChromeToolbarRule, /justify-content:\s*center;/);
  assert.ok(collapsedMacTopActionsRule, "missing mac collapsed top actions rule");
  assert.match(collapsedMacTopActionsRule, /left:\s*0;/);
  assert.match(collapsedMacTopActionsRule, /right:\s*0;/);
  assert.match(collapsedMacTopActionsRule, /width:\s*100%;/);
  assert.match(collapsedMacTopActionsRule, /grid-template-columns:\s*1fr;/);
  assert.match(collapsedMacTopActionsRule, /place-items:\s*center;/);
  assert.doesNotMatch(collapsedMacTopActionsRule, /translateX\(-50%\)/);
  assert.ok(collapsedMacTopActionButtonRule, "missing mac collapsed top action button rule");
  assert.match(collapsedMacTopActionButtonRule, /width:\s*100%;/);
  assert.match(collapsedMacTopActionButtonRule, /justify-self:\s*stretch;/);
  assert.match(collapsedMacTopActionButtonRule, /border-radius:\s*8px;/);
  assert.match(collapsedMacTopActionButtonRule, /background:\s*transparent;/);
  assert.ok(collapsedAssistantTopButtonRule, "missing collapsed assistant top button rule");
  assert.match(collapsedAssistantTopButtonRule, /display:\s*none;/);
  assert.match(collapsedAssistantTopButtonRule, /pointer-events:\s*none;/);
  assert.match(globalStyles, /\.app-sidebar-resize-overlay\s*\{/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button\.is-compact\s*\{[\s\S]*?width:\s*24px;/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button\.is-nav\s*\{[\s\S]*?width:\s*var\(--sidebar-collapse-toggle-nav-width, 48px\);/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button-icon-chevron::before/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button-icon-panel\s*\{[\s\S]*?fill:\s*none;[\s\S]*?stroke:\s*currentColor;/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button-icon-chevron\s*\{[\s\S]*?fill:\s*none;[\s\S]*?stroke:\s*currentColor;/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button-icon-panel rect,[\s\S]*?\.app-sidebar-collapse-button-icon-chevron path\s*\{[\s\S]*?fill:\s*none;[\s\S]*?stroke:\s*currentColor;/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button-icon-panel\s*\{[\s\S]*?width:\s*16px;/);
  assert.match(globalStyles, /\.app-sidebar a,\s*[\s\S]*?\.app-sidebar button[\s\S]*?\{[\s\S]*?app-region:\s*no-drag;/);
});

test("body-level popovers stay clickable above Electron drag regions", () => {
  const popoverStyles = readSourceFile(
    "src",
    "renderer",
    "components",
    "Popover",
    "index.module.css"
  );
  const popoverRule = popoverStyles.match(/^\.Popover\s*\{(?<body>[\s\S]*?)^\}/m)
    ?.groups?.body;

  assert.ok(popoverRule, "missing .Popover rule");
  assert.match(popoverRule, /app-region:\s*no-drag;/);
  assert.match(popoverRule, /-webkit-app-region:\s*no-drag;/);
  assert.match(popoverRule, /pointer-events:\s*auto;/);
});

test("fixed sidebar tool menu uses controlled popover state", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );

  assert.match(
    sidebarSource,
    /<Popover[\s\S]{0,160}placement="top-start"[\s\S]{0,160}content=\{renderToolMenu\(\)\}[\s\S]{0,160}open=\{toolMenuOpen\}[\s\S]{0,160}onOpenChange=\{handleToolMenuOpenChange\}/
  );
  assert.doesNotMatch(sidebarSource, /toolMenuPosition/);
  assert.doesNotMatch(sidebarSource, /toolMenuPanelRef/);
});

test("fixed sidebar settings trigger labels the active fixed tool without changing action semantics", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );

  assert.match(
    sidebarSource,
    /function isFixedToolRouteActive\(targetPath: string\) \{[\s\S]*?targetPathname === "\/agents"[\s\S]*?currentPathname\.startsWith\(`\$\{targetPathname\}\/`\)[\s\S]*?pendingPathname\.startsWith\(`\$\{targetPathname\}\/`\)[\s\S]*?return currentPathname === targetPathname \|\| pendingPathname === targetPathname;/
  );
  assert.match(
    sidebarSource,
    /const activeFixedToolItem = fixedToolItems\.find\(\(item\) =>\s*isFixedToolRouteActive\(item\.to\),\s*\);[\s\S]{0,120}const settingsToolTriggerLabel = activeFixedToolItem\?\.label \?\? t\("nav\.settings"\);/
  );
  assert.match(
    sidebarSource,
    /function renderToolLink\(item: SidebarToolItem\)[\s\S]*?isFixedToolRouteActive\(item\.to\) \? "sidebar-link-active" : ""/
  );
  assert.match(
    sidebarSource,
    /activeFixedToolItem[\s\S]{0,80}\? "sidebar-link-active"\s*:\s*""/
  );
  assert.match(
    sidebarSource,
    /aria-label=\{t\("nav\.sidebar\.openSettings"\)\}[\s\S]{0,220}title=\{t\("nav\.settings"\)\}[\s\S]{0,220}<span className="sidebar-link-label">\{settingsToolTriggerLabel\}<\/span>/
  );
  assert.match(
    sidebarSource,
    /sidebar-link-label-collapsed"[\s\S]{0,80}\{getCollapsedSidebarLabel\(t\("nav\.settings"\)\)\}/
  );
});

test("sidebar renders task board and section groups above the fixed tool menu", () => {
  const appShell = readAppShellSource();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const pluginPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "plugin", "PluginPage.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const agentIconSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AgentIcon.tsx"),
    "utf8"
  );

  assert.match(sidebarSource, /taskBoardNavItemBase[\s\S]*?orderKey:\s*"kanban"[\s\S]*?to:\s*"\/kanban"/);
  assert.match(sidebarSource, /assistantGroupNavItemBase[\s\S]*?orderKey:\s*"group:assistants"[\s\S]*?entryType:\s*"assistants"/);
  assert.match(sidebarSource, /websGroupNavItemBase[\s\S]*?orderKey:\s*"group:webs"[\s\S]*?entryType:\s*"webs"/);
  assert.match(sidebarSource, /label:\s*t\("nav\.taskBoard"\)/);
  assert.match(sidebarSource, /label:\s*t\("nav\.assistants"\)/);
  assert.match(sidebarSource, /label:\s*t\("nav\.embeddedWebs"\)/);
  assert.match(sidebarSource, /SIDEBAR_GROUP_STATE_STORAGE_KEY/);
  assert.match(sidebarSource, /SIDEBAR_ASSISTANT_SORT_STORAGE_KEY/);
  assert.match(sidebarSource, /type AssistantNavSortMode = "byName" \| "byTime"/);
  assert.match(sidebarSource, /sortAssistantNavAgentsForMode\(assistantNavAgents, assistantNavSortMode\)/);
  assert.match(sidebarSource, /sidebar\.assistants\.sortByName/);
  assert.match(sidebarSource, /sidebar\.assistants\.sortByTime/);
  assert.doesNotMatch(sidebarSource, /assistantHomeNavItem/);
  assert.doesNotMatch(sidebarSource, /智能助理首页|智能助手首页/);
  assert.match(sidebarSource, /createAgentRoute\(agent\.agentKey\)/);
  assert.match(sidebarSource, /createAgentChatRoute\(chat\.agentKey/);
  assert.match(sidebarSource, /createAgentNewChatRoute\(agent\.agentKey\)/);
  assert.match(sidebarSource, /type AgentSelectionOptions = \{\s*preferNewChat\?: boolean;\s*\};/);
  assert.match(sidebarSource, /function createAgentSelectionRoute\(\s*agent: AssistantNavAgentItem,\s*options: AgentSelectionOptions = \{\},\s*\)/);
  assert.match(sidebarSource, /function getAssistantAttentionChat\(agent: AssistantNavAgentItem\)/);
  assert.match(sidebarSource, /getAssistantNavAgentRecentChats\(agent\)\.slice\(0, 5\)/);
  assert.match(sidebarSource, /recentChats\.find\(\(chat\) => chat\.hasPendingAwaiting === true\)/);
  assert.match(sidebarSource, /recentChats\.find\(\(chat\) => chat\.hasActiveRun === true\)/);
  assert.match(sidebarSource, /recentChats\.find\(\(chat\) => chat\.isRead === false\)/);
  assert.match(sidebarSource, /const attentionChat = getAssistantAttentionChat\(agent\);/);
  assert.match(sidebarSource, /if \(attentionChatId\) \{\s*return createAgentChatRoute\(agent\.agentKey, attentionChatId\);/);
  assert.match(sidebarSource, /if \(!options\.preferNewChat\) \{\s*return createAgentDefaultRoute\(agent\);/);
  assert.match(sidebarSource, /return createAgentNewChatRoute\(agent\.agentKey\);/);
  assert.match(sidebarSource, /function createAgentHistoryRoute\(agentKey: string\)/);
  assert.match(sidebarSource, /params\.set\("history", "1"\)/);
  assert.match(sidebarSource, /params\.set\("historyRequest", String\(Date\.now\(\)\)\)/);
  assert.doesNotMatch(sidebarSource, /createAgentEmbedPath/);
  assert.doesNotMatch(sidebarSource, /createAgentWebclientRoute/);
  assert.match(sidebarSource, /\/agent\/\$\{encodeURIComponent\(agentKey\)\}/);
  assert.match(sidebarSource, /params\.set\("chatId", chatId\.trim\(\)\)/);
  assert.doesNotMatch(sidebarSource, /if \(chatId\.trim\(\)\)/);
  assert.doesNotMatch(sidebarSource, /\/service\/agent-webclient\?embedPath=/);
  assert.match(sidebarSource, /function handleItemClick[\s\S]*?if \(onRequestNavigate\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?if \(!onRequestNavigate\(targetPath\)\)/);
  assert.match(sidebarSource, /function dispatchAgentRouteActionToActiveWebview\(targetPath: string\)/);
  assert.match(sidebarSource, /"agent:start-new-conversation"/);
  assert.match(sidebarSource, /"agent:load-chat"/);
  assert.match(sidebarSource, /webview\.executeJavaScript\(script, true\)/);
  assert.match(sidebarSource, /function handleAssistantAgentExpand\(\s*agent: AssistantNavAgentItem,\s*expanded: boolean,\s*\) \{[\s\S]*?if \(!expanded\) \{[\s\S]*?return;[\s\S]*?createAgentSelectionRoute\(agent, \{ preferNewChat: !isCollapsed \}\)[\s\S]*?retriggerAgentRoute: true/);
  assert.match(sidebarSource, /onExpand=\{\(val\) => handleAssistantAgentExpand\(agent, val\)\}/);
  assert.doesNotMatch(sidebarSource, /handleAssistantAgentHeaderClick/);
  assert.match(sidebarSource, /currentPathname\.startsWith\("\/agent\/"\)/);
  assert.match(sidebarSource, /pendingPath\?\.startsWith\("\/agent\/"\)/);
  assert.doesNotMatch(sidebarSource, /newChat=1/);
  assert.doesNotMatch(sidebarSource, /nonce=/);
  assert.doesNotMatch(sidebarSource, /AssistantHistoryState/);
  assert.doesNotMatch(sidebarSource, /assistantHistory/);
  assert.doesNotMatch(sidebarSource, /renderAssistantHistory/);
  assert.match(sidebarSource, /const recentChats = getAssistantNavAgentRecentChats\(agent\)\.slice\(0, 5\);/);
  assert.match(sidebarSource, /const chatCount = Math\.max\(\s*0,\s*getAssistantNavAgentNonNegativeInteger\(agent\.chatCount\),\s*recentChats\.length,?\s*\);/);
  assert.match(sidebarSource, /recentChats\.length > 0 \? \(/);
  assert.match(sidebarSource, /\) : chatCount === 0 \? \(\s*<div className="status-line">暂无会话<\/div>/);
  assert.match(sidebarSource, /chatCount > recentChats\.length \? \(/);
  assert.match(sidebarSource, /historyRequested: url\.searchParams\.get\("history"\)\?\.trim\(\) === "1"/);
  assert.match(sidebarSource, /SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL/);
  assert.match(sidebarSource, /webview\.send\(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL,\s*\{\s*action:\s*"openChatHistory"/);
  assert.match(sidebarSource, /workerKey: `agent:\$\{agentKey\}`/);
  assert.match(sidebarSource, /lastRouteAgentInfoRef = useRef\(readAgentRouteInfo\(currentRoute\)\)/);
  assert.match(sidebarSource, /previousRouteAgentInfo\.historyRequested/);
  assert.match(sidebarSource, /setExpandedAssistantAgentKey\(""\)/);
  assert.match(sidebarSource, /requestNavigate\(\s*createAgentHistoryRoute\(agent\.agentKey\),\s*\{\s*retriggerAgentRoute:\s*true,?\s*\}\s*\)/);
  assert.match(sidebarSource, /<div className="status-line">暂无会话<\/div>/);
  assert.doesNotMatch(sidebarSource, /暂无相关会话/);
  assert.doesNotMatch(sidebarSource, /Math\.max\(agent\.chatCount, recentChats\.length\) > 5/);
  assert.match(sidebarSource, /renderStatusBadges/);
  assert.match(sidebarSource, /summarizeAgentStatus\(assistantNavAgents\)/);
  assert.match(sidebarSource, /assistant-worker-collapse worker-collapse/);
  const newChatHandlerStart = sidebarSource.indexOf("function handleAssistantNewChat");
  const markAllReadHandlerStart = sidebarSource.indexOf("async function handleAssistantMarkAllRead");
  assert.ok(newChatHandlerStart >= 0);
  assert.ok(markAllReadHandlerStart > newChatHandlerStart);
  const newChatHandler = sidebarSource.slice(newChatHandlerStart, markAllReadHandlerStart);
  assert.doesNotMatch(newChatHandler, /preferNewChat|createAgentSelectionRoute/);
  assert.match(newChatHandler, /requestNavigate\(\s*createAgentNewChatRoute\(agent\.agentKey\),\s*\{\s*retriggerAgentRoute:\s*true,?\s*\}\s*\)/);
  assert.match(sidebarSource, /className="assistant-worker-collapse-item"/);
  assert.match(sidebarSource, /className="assistant-worker-header-text"/);
  assert.match(sidebarSource, /<AgentIcon[\s\S]*?icon=\{agent\.icon\}[\s\S]*?className="worker-panel-icon"[\s\S]*?size=\{selected \? 20 : 32\}[\s\S]*?type="agent"[\s\S]*?\/>/);
  assert.doesNotMatch(sidebarSource, /renderAssistantAgentIcon/);
  assert.doesNotMatch(sidebarSource, /SidebarIllustration kind="agent"/);
  assert.match(sidebarSource, /worker-panel-header-body/);
  assert.match(sidebarSource, /worker-panel-role/);
  assert.match(sidebarSource, /mode !== "CODER"[\s\S]{0,200}worker-panel-role/);
  assert.match(sidebarSource, /worker-panel-preview/);
  assert.match(sidebarSource, /worker-chat-item-head/);
  assert.match(sidebarSource, /worker-chat-name/);
  assert.match(sidebarSource, /worker-panel-time-label/);
  assert.match(sidebarSource, /<Tooltip content="全部已读">/);
  assert.match(sidebarSource, /<Tooltip content="新建对话">/);
  assert.match(sidebarSource, /查看更多（共/);
  assert.match(sidebarSource, /getAssistantAwaitingStatusKey/);
  assert.match(sidebarSource, /sidebar\.assistants\.awaitingStatus\.approval/);
  assert.match(sidebarSource, /sidebar\.assistants\.awaitingStatus\.form/);
  assert.match(sidebarSource, /sidebar\.assistants\.awaitingStatus\.question/);
  assert.match(sidebarSource, /sidebar\.assistants\.awaitingStatus\.plan/);
  assert.match(sidebarSource, /exportChat/);
  assert.match(sidebarSource, /renameChat/);
  assert.match(sidebarSource, /archiveChat/);
  assert.match(sidebarSource, /deleteChat/);
  const exportChatHandler =
    sidebarSource.match(/async function handleAssistantExportChat[\s\S]*?function handleAssistantRenameChat/u)?.[0] ?? "";
  const renameChatHandler =
    sidebarSource.match(/function handleAssistantRenameChat[\s\S]*?async function handleConfirmRenameChat/u)?.[0] ?? "";
  assert.match(exportChatHandler, /const result = await window\.electronAPI\.assistant\.exportChat\(chat\.chatId\)/u);
  assert.match(exportChatHandler, /if \(!result\.ok\)/u);
  assert.match(exportChatHandler, /window\.alert/u);
  assert.match(renameChatHandler, /setAssistantChatRenameDialog\(\{/u);
  assert.doesNotMatch(sidebarSource, /window\.prompt/u);
  const confirmRenameChatHandler =
    sidebarSource.match(/async function handleConfirmRenameChat[\s\S]*?async function handleAssistantArchiveChat/u)?.[0] ?? "";
  assert.match(sidebarSource, /type AssistantChatRenameDialogState = \{/u);
  assert.match(sidebarSource, /function renderAssistantChatRenameDialog\(\)/u);
  assert.match(confirmRenameChatHandler, /const result = await window\.electronAPI\.assistant\.renameChat\(/u);
  assert.match(confirmRenameChatHandler, /assistantChatRenameDialog\.chat\.chatId/u);
  assert.match(confirmRenameChatHandler, /if \(!result\.ok\)/u);
  assert.match(confirmRenameChatHandler, /setAssistantChatRenameDialog\(null\)/u);
  assert.match(confirmRenameChatHandler, /await onRefreshAssistantNavAgents\?\.\(\)/u);
  assert.match(sidebarSource, /<span>删除<\/span>/);
  assert.match(sidebarSource, /schedulesNavItemBase[\s\S]*?to:\s*"\/automations"[\s\S]*?icon:\s*"schedule"/);
  assert.match(sidebarSource, /fixedToolRowsBase[\s\S]*?to:\s*"\/agents"[\s\S]*?labelKey:\s*"nav\.agents"[\s\S]*?to:\s*"\/registries"[\s\S]*?labelKey:\s*"nav\.registries"[\s\S]*?to:\s*"\/market"[\s\S]*?labelKey:\s*"nav\.market"/);
  assert.doesNotMatch(sidebarSource, /fixedToolRowsBase[\s\S]*?to:\s*"\/memory"[\s\S]*?labelKey:\s*"nav\.memory"/);
  assert.match(sidebarSource, /fixedToolRowsBase[\s\S]*?to:\s*"\/control-center"[\s\S]*?labelKey:\s*"nav\.controlCenter"[\s\S]*?to:\s*"\/settings"[\s\S]*?labelKey:\s*"nav\.settings"[\s\S]*?to:\s*"\/help"[\s\S]*?labelKey:\s*"nav\.help"/);
  assert.doesNotMatch(sidebarSource, /fixedToolRowsBase[\s\S]*?to:\s*"\/automations"/);
  assert.match(sidebarSource, /sidebar-footer-divider/);
  assert.match(sidebarSource, /aria-label=\{t\("nav\.sidebar\.fixedTools"\)\}/);
  assert.match(sidebarSource, /aria-label=\{t\("nav\.sidebar\.openSettings"\)\}/);
  assert.match(sidebarSource, /title=\{t\("nav\.settings"\)\}/);
  assert.match(sidebarSource, /<span className="sidebar-link-label">\{settingsToolTriggerLabel\}<\/span>/);
  assert.match(sidebarSource, /getCollapsedSidebarLabel\(t\("nav\.settings"\)\)/);
  assert.match(sidebarSource, /createPortal/);
  assert.match(sidebarSource, /sidebar-tool-menu-trigger/);
  assert.match(sidebarSource, /sidebar-tool-menu-item/);
  assert.match(sidebarSource, /sidebar-assistant-top-button/);
  assert.match(sidebarSource, /sidebar-group-heading/);
  assert.doesNotMatch(sidebarSource, /sidebar-tool-grid/);
  assert.doesNotMatch(sidebarSource, /sidebar-assistant-launcher/);
  assert.match(sidebarSource, /sortSidebarNavItems\(/);
  assert.match(sidebarSource, /label:\s*t\("nav\.taskBoard"\)[\s\S]*?label:\s*t\("nav\.schedules"\)[\s\S]*?label:\s*t\("nav\.assistants"\)[\s\S]*?label:\s*t\("nav\.embeddedWebs"\)/);
  assert.match(globalStyles, /\.sidebar-tool-menu\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(globalStyles, /\.sidebar-group-heading\s*\{/);
  assert.match(globalStyles, /\.sidebar-group-divider\s*\{/);
  assert.match(globalStyles, /\.sidebar-group-children\s*\{[\s\S]*?gap:\s*2px;[\s\S]*?padding:\s*0;[\s\S]*?border-left:\s*0;/);
  assert.match(globalStyles, /\.sidebar-link-active\s*\{[\s\S]*?color:\s*#1677ff;[\s\S]*?background:\s*rgba\(22,\s*119,\s*255,\s*0\.13\);/);
  assert.match(globalStyles, /\.sidebar-link:not\(\.sidebar-link-active\) \.sidebar-link-icon svg,[\s\S]*?filter:\s*grayscale\(1\) saturate\(0\);/);
  assert.match(globalStyles, /\.sidebar-link-active \.sidebar-link-icon svg,[\s\S]*?filter:\s*none;/);
  assert.match(globalStyles, /\.sidebar-custom-child-link\s*\{[\s\S]*?padding-left:\s*4px !important;/);
  assert.doesNotMatch(globalStyles, /--sidebar-group-child-indent/);
  assert.doesNotMatch(globalStyles, /--sidebar-group-child-pill-padding/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar:not\(\.is-collapsed\) \.sidebar-group-children \.sidebar-child-link/);
  assert.match(globalStyles, /\.assistant-worker-name\s*\{[\s\S]*?font-weight:\s*500;/);
  assert.match(globalStyles, /\.worker-panel-role\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?font-weight:\s*400;/);
  assert.match(globalStyles, /\.worker-panel-preview\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?height:\s*20px;/);
  assert.match(globalStyles, /\.worker-chat-name\s*\{[\s\S]*?font-size:\s*12px;/);
  assert.match(globalStyles, /\.assistant-worker-header\s*\{[\s\S]*?padding:\s*6px 10px;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-expanded\s*\{[\s\S]*?background:\s*var\(--surface\);/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-expanded \.worker-panel-icon\s*\{[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;/);
  assert.match(globalStyles, /\.worker-chat-preview-list \.status-line\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?color:\s*var\(--ink-muted\);/);
  assert.match(agentIconSource, /defaultIcon from "\.\.\/\.\.\/assets\/agent-icons\/default\.svg"/);
  assert.match(agentIconSource, /const IconMap/);
  assert.match(agentIconSource, /AGENT_ICON_NAMES[\s\S]*"folder"[\s\S]*"coder"[\s\S]*"terminal"/);
  assert.doesNotMatch(agentIconSource, /BUILTIN_ICON_CONFIGS/);
  assert.doesNotMatch(agentIconSource, /ledger/);
  assert.match(agentIconSource, /isImageIcon/);
  assert.match(agentIconSource, /useState\(false\)/);
  assert.match(agentIconSource, /\(\)\s*=>\s*setImageFailed\(true\)/);
  assert.match(agentIconSource, /readIconColor\(icon\) \|\| "#94a3b8"/);
  assert.doesNotMatch(agentIconSource, /readIconColor\(icon\) \|\| "var\(--accent\)"/);

  assert.match(appShell, /AGENT_WEBCLIENT_ROUTE_DEFINITIONS/);
  assert.match(appShell, /type AgentWebclientRouteDefinition = \{/);
  assert.match(appShell, /key: AgentWebclientRouteKey;/);
  assert.match(appShell, /kind: AgentWebclientRouteKind;/);
  assert.match(appShell, /mode: AgentWebclientRouteMode;/);
  assert.match(appShell, /kanbanEnabled=\{kanbanEnabled\}/);
  assert.doesNotMatch(appShell, /kanbanEnabled=\{true\}/);
  assert.match(appShell, /path="\/kanban"[\s\S]*?!kanbanSettingsLoaded[\s\S]*?!kanbanEnabled[\s\S]*?<Navigate to="\/control-center" replace \/>[\s\S]*?<RouteSuspense><TaskBoardPage hostTheme=\{resolvedTheme\} \/><\/RouteSuspense>/);
  assert.doesNotMatch(appShell, /KanbanPlaceholderPage/);
  assert.match(sidebarSource, /label:\s*t\("nav\.taskBoard"\)/);
  assert.match(appShell, /assistantNavAgents/);
  assert.match(appShell, /listNavigationAgents/);
  assert.match(appShell, /key:\s*"agents"[\s\S]*?routePath:\s*"\/agents"[\s\S]*?embedPath:\s*"\/agents"[\s\S]*?labelKey:\s*"nav\.agents"[\s\S]*?kind:\s*"management"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"schedules"[\s\S]*?routePath:\s*"\/automations"[\s\S]*?embedPath:\s*"\/automations"[\s\S]*?labelKey:\s*"nav\.schedules"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"memory"[\s\S]*?routePath:\s*"\/memory"[\s\S]*?embedPath:\s*"\/memory"[\s\S]*?labelKey:\s*"nav\.memory"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"registries"[\s\S]*?routePath:\s*"\/registries"[\s\S]*?embedPath:\s*"\/registries"[\s\S]*?labelKey:\s*"nav\.registries"[\s\S]*?kind:\s*"management"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"copilot"[\s\S]*?routePath:\s*"\/copilot"[\s\S]*?embedPath:\s*"\/copilot"[\s\S]*?labelKey:\s*"nav\.assistants"[\s\S]*?kind:\s*"copilot"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /AGENT_WEBCLIENT_DYNAMIC_ROUTE_PATTERNS[\s\S]*?"\/agents\/:agentKey"[\s\S]*?"\/copilot\/:agentKey"[\s\S]*?"\/agent\/:agentKey"/);
  assert.match(appShell, /const rawActiveAgentWebclientRoute = resolveAgentWebclientRoute\(location\.pathname,\s*location\.search/);
  assert.match(appShell, /const activeAgentWebclientRoute = rawActiveAgentWebclientRoute[\s\S]*?label:\s*rawActiveAgentWebclientRoute\.labelKey[\s\S]*?t\(rawActiveAgentWebclientRoute\.labelKey\)/);
  assert.match(appShell, /const activeEmbeddedAgentWebclientRoute = isEmbeddedAgentWebclientRoute\(activeAgentWebclientRoute\)/);
  assert.doesNotMatch(appShell, /usesAgentNativeSurface/);
  assert.doesNotMatch(appShell, /agent-native-surface-body/);
  assert.doesNotMatch(appShell, /has-agent-native-surface/);
  assert.match(appShell, /function readAgentWebclientRouteEmbedPath\(search: string\)/);
  assert.match(appShell, /new URLSearchParams\(search\)\.get\("embedPath"\)/);
  assert.match(appShell, /if \(pathname !== LEGACY_AGENT_WEBCLIENT_SERVICE_PATH\) \{/);
  assert.match(appShell, /routePath:\s*`\$\{LEGACY_AGENT_WEBCLIENT_SERVICE_PATH\}\$\{search\}`/);
  assert.match(appShell, /export const AGENT_WEBCLIENT_TARGET_PATH = "\/agents";/);
  assert.match(appShell, /const LEGACY_AGENT_WEBCLIENT_SERVICE_PATH = "\/service\/agent-webclient";/);
  assert.match(appShell, /function isBareAgentWebclientServiceRoute\(pathname: string, search: string\)/);
  assert.match(appShell, /const bareAgentWebclientServiceRoute = isBareAgentWebclientServiceRoute\(location\.pathname,\s*location\.search\)/);
  assert.match(appShell, /const activePluginId = activeEmbeddedAgentWebclientRoute[\s\S]*?: bareAgentWebclientServiceRoute[\s\S]*?\? null[\s\S]*?: resolvePluginRouteId\(location\.pathname\)/);
  assert.match(appShell, /Boolean\(activeEmbeddedAgentWebclientRoute\) \|\|[\s\S]*?!bareAgentWebclientServiceRoute && location\.pathname\.startsWith\("\/service\/"\)/);
  assert.match(appShell, /function LegacyAgentWebclientServiceRouteRedirect\(\)/);
  assert.match(appShell, /const embedPath = readAgentWebclientRouteEmbedPath\(location\.search\)/);
  assert.match(appShell, /return embedPath \? null : <Navigate to=\{ASSISTANT_TARGET_PATH\} replace \/>;/);
  assert.match(appShell, /path=\{LEGACY_AGENT_WEBCLIENT_SERVICE_PATH\}[\s\S]*?<LegacyAgentWebclientServiceRouteRedirect \/>/);
  assert.match(appShell, /function resolveSingleAgentWebclientRoute\(pathname: string, search: string\)/);
  assert.match(appShell, /matchPath\("\/agent\/:agentKey", pathname\)/);
  assert.match(appShell, /function resolveAgentManagementWebclientRoute\(pathname: string, search: string\)/);
  assert.match(appShell, /matchPath\("\/agents\/:agentKey", pathname\)/);
  assert.match(appShell, /embedPath:\s*`\$\{pathname\}\$\{search\}`/);
  assert.match(appShell, /key:\s*"agents"[\s\S]*?routePath:\s*"\/agents"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"schedules"[\s\S]*?routePath:\s*"\/automations"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"registries"[\s\S]*?routePath:\s*"\/registries"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /function resolveAgentManagementWebclientRoute\(pathname: string, search: string\)[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /for \(const key of \["chatId", "history", "historyRequest"\]\)/);
  assert.match(appShell, /embedPath:\s*`\/agent\/\$\{encodeURIComponent\(agentKey\)\}/);
  assert.match(appShell, /labelKey:\s*embedPath\.startsWith\("\/agent\/"\) \? "nav\.assistants" : "nav\.agents"/);
  assert.match(appShell, /activeEmbeddedAgentWebclientRoute[\s\S]*?\? AGENT_WEBCLIENT_SERVICE_ID[\s\S]*?: resolvePluginRouteId\(location\.pathname\)/);
  assert.match(appShell, /findAgentWebclientRouteDefinition\(pathname\)/);
  assert.doesNotMatch(appShell, /AgentWebclientNativeRouteOutlet/);
  assert.match(appShell, /surfaceId=\{AGENT_WEBCLIENT_CHAT_SURFACE_ID\}/);
  assert.match(appShell, /surfaceId=\{AGENT_WEBCLIENT_COPILOT_SURFACE_ID\}/);
  assert.match(appShell, /if \(currentRoute !== pendingSidebarNavigationPath\)/);
  assert.match(appShell, /function requestSidebarNavigation\(targetPath: string\)[\s\S]*?navigate\(targetPath\);[\s\S]*?return true;/);
  assert.match(appShell, /const usesEmbeddedSurface =[\s\S]*?Boolean\(activeEmbeddedAgentWebclientRoute\)/);
  assert.match(appShell, /const usesPluginSurface =[\s\S]*?Boolean\(activeEmbeddedAgentWebclientRoute\)[\s\S]*?location\.pathname\.startsWith\("\/service\/"\)[\s\S]*?location\.pathname\.startsWith\("\/plugin\/"\)/);
  assert.match(appShell, /AGENT_WEBCLIENT_ROUTE_DEFINITIONS\.map\(\(routeDefinition\) =>/);
  assert.match(appShell, /path=\{routeDefinition\.routePath\}[\s\S]*?element=\{null\}/);
  assert.match(appShell, /AGENT_WEBCLIENT_DYNAMIC_ROUTE_PATTERNS\.map\(\(routePattern\) =>/);
  assert.match(appShell, /path=\{routePattern\}[\s\S]*?element=\{null\}/);
  assert.doesNotMatch(appShell, /path="\/agents"[\s\S]{0,180}<PlaceholderPage/);

  assert.match(pluginPage, /embedPath\?: string;/);
  assert.match(pluginPage, /surfaceLabel\?: string;/);
  assert.match(pluginPage, /routeEmbedPath/);
  assert.match(pluginPage, /effectiveEmbedPath/);
  assert.match(pluginPage, /get\("embedPath"\)/);
  assert.match(pluginPage, /embedPath: effectiveEmbedPath/);
  assert.match(pluginPage, /function requestDirectWebviewRouteLoad\(\)/);
  assert.match(pluginPage, /targetWebview\.loadURL\(embeddedUrl\)/);
  assert.match(pluginPage, /buildAgentWebclientAccessTokenInjectionScript/);
  assert.doesNotMatch(pluginPage, /buildAgentWebclientSelectWorkerScript/);
  assert.doesNotMatch(pluginPage, /agentWebclientRouteAgentKey/);
  assert.doesNotMatch(pluginPage, /agentWebclientRouteNewChat/);
  assert.doesNotMatch(pluginPage, /agent:select-worker/);
  assert.doesNotMatch(pluginPage, /agent:load-chat/);
  assert.doesNotMatch(pluginPage, /agent:start-new-conversation/);
});

test("sidebar top navigation exposes scoped back and forward history controls", () => {
  const appShell = readAppShellSource();
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );
  const settingsPage = readSourceFile("src", "renderer", "pages", "settings", "SettingsPage.tsx");
  const globalStyles = readRendererStyles();

  assert.match(appShell, /type SidebarNavigationHistory = \{\s*back: string\[\];\s*forward: string\[\];\s*\};/);
  assert.match(appShell, /const \[sidebarNavigationHistory,\s*setSidebarNavigationHistory\] = useState<SidebarNavigationHistory>/);
  assert.match(appShell, /function navigateWithSidebarHistory\(targetPath: string, direction: "back" \| "forward"\)/);
  assert.match(appShell, /function handleSidebarBackNavigation\(\)[\s\S]*?navigateWithSidebarHistory\(targetPath,\s*"back"\)/);
  assert.match(appShell, /function handleSidebarForwardNavigation\(\)[\s\S]*?navigateWithSidebarHistory\(targetPath,\s*"forward"\)/);
  assert.match(appShell, /function requestSidebarNavigation\(targetPath: string\)[\s\S]*?back:\s*\[\.\.\.current\.back,\s*currentRoute\]/);
  assert.match(appShell, /function requestSidebarNavigation\(targetPath: string\)[\s\S]*?forward:\s*\[\]/);
  assert.match(appShell, /sidebarNavigationCanGoBack=\{sidebarNavigationHistory\.back\.length > 0\}/);
  assert.match(appShell, /sidebarNavigationCanGoForward=\{sidebarNavigationHistory\.forward\.length > 0\}/);
  assert.match(appShell, /onSidebarNavigateBack=\{handleSidebarBackNavigation\}/);
  assert.match(appShell, /onSidebarNavigateForward=\{handleSidebarForwardNavigation\}/);

  assert.match(sidebarSource, /sidebarNavigationCanGoBack\?: boolean;/);
  assert.match(sidebarSource, /sidebarNavigationCanGoForward\?: boolean;/);
  assert.match(sidebarSource, /onSidebarNavigateBack\?: \(\) => void;/);
  assert.match(sidebarSource, /onSidebarNavigateForward\?: \(\) => void;/);
  assert.match(sidebarSource, /className="sidebar-history-controls"/);
  assert.match(sidebarSource, /aria-label="后退"/);
  assert.match(sidebarSource, /aria-label="前进"/);
  assert.match(sidebarSource, /disabled=\{!sidebarNavigationCanGoBack\}/);
  assert.match(sidebarSource, /disabled=\{!sidebarNavigationCanGoForward\}/);
  assert.match(sidebarSource, /onClick=\{onSidebarNavigateBack\}/);
  assert.match(sidebarSource, /onClick=\{onSidebarNavigateForward\}/);
  assert.match(sidebarSource, /requestNavigate\(\s*createAgentHistoryRoute\(agent\.agentKey\),\s*\{\s*retriggerAgentRoute:\s*true,?\s*\}\s*\)/);
  assert.match(sidebarSource, /action:\s*"openChatHistory"/);

  assert.match(globalStyles, /\.sidebar-history-controls\s*\{/);
  assert.match(globalStyles, /\.sidebar-history-button:disabled\s*\{/);
  assert.doesNotMatch(settingsPage, /sidebarNavigationCanGoBack/);
  assert.doesNotMatch(settingsPage, /onSidebarNavigateBack/);
});

test("assistant sidebar chat history selection follows pending navigation", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );

  assert.match(sidebarSource, /const pendingChatId = pendingRouteAgentInfo\.chatId;/);
  assert.match(sidebarSource, /const activeSidebarAgentKey = pendingPath \? pendingAgentKey : currentAgentKey;/);
  assert.match(sidebarSource, /function getActiveSidebarAgentKey\(\)/);
  assert.match(sidebarSource, /function getActiveSidebarChatId\(agentKey: string\)/);
  assert.match(sidebarSource, /agent\.agentKey === activeSidebarAgentKey/);
  assert.match(sidebarSource, /const activeAgentChanged =\s*lastAutoExpandedAssistantAgentKeyRef\.current !== matched\.agentKey;/);
  assert.match(sidebarSource, /if \(activeAgentChanged\) \{[\s\S]{0,220}setExpandedAssistantAgentKey\(matched\.agentKey\);/);
  assert.match(sidebarSource, /\}, \[assistantNavAgents, activeSidebarAgentKey, expandedAssistantAgentKey\]\);/);
  assert.match(sidebarSource, /const routeChatId = pendingPath \? pendingChatId : currentChatId;/);
  assert.match(sidebarSource, /if \(routeChatId\) \{[\s\S]{0,80}return routeChatId;/);
  assert.match(sidebarSource, /const selected =\s*getActiveSidebarAgentKey\(\) === agent\.agentKey;/);
  assert.match(sidebarSource, /const activeChatId = getActiveSidebarChatId\(agent\.agentKey\);/);
  assert.doesNotMatch(sidebarSource, /const activeChatId = currentChatId \|\| "";/);
});

test("assistant sidebar awaiting chats use a right-side loading status", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );
  const globalStyles = readRendererStyles();

  assert.match(sidebarSource, /const action = chat\.hasPendingAwaiting\s*\?\s*"awaiting"/);
  assert.match(sidebarSource, /chat\.hasPendingAwaiting \? "has-awaiting" : ""/);
  assert.match(sidebarSource, /getAssistantAwaitingStatusKey\(chat\.awaitingMode\)/);
  assert.match(sidebarSource, /className="worker-chat-loading assistant-material-icon is-loading"/);
  assert.doesNotMatch(sidebarSource, /assistant-worker-awaiting-ring/);
  assert.doesNotMatch(globalStyles, /assistant-worker-awaiting-ring/);
  assert.match(globalStyles, /\.assistant-worker-chat-item\.has-awaiting \.chat-awaiting-status\s*\{[\s\S]{0,80}margin-left: auto;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\],\s*\.assistant-worker-chat-action\[data-action="loading"\]\s*\{[\s\S]{0,100}width: 18px;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-panel-time-label,\s*\.assistant-worker-chat-action\[data-action="loading"\] \.worker-panel-time-label\s*\{[\s\S]{0,80}display: none;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-chat-loading,\s*\.assistant-worker-chat-action\[data-action="loading"\] \.worker-chat-loading\s*\{[\s\S]{0,120}display: inline-flex;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-chat-loading,[\s\S]{0,220}color: var\(--ink-muted\);/);
});

test("assistant sidebar active chats use loading status instead of thinking text", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );
  const globalStyles = readRendererStyles();

  assert.match(sidebarSource, /function isAssistantRunningPreview\(value: string\)/);
  assert.match(sidebarSource, /normalized === "思考中"/);
  assert.match(sidebarSource, /const action = chat\.hasPendingAwaiting\s*\?\s*"awaiting"\s*:\s*chat\.hasActiveRun\s*\?\s*"loading"/);
  assert.match(sidebarSource, /chat\.hasActiveRun && isAssistantRunningPreview\(chat\.lastRunContent\)/);
  assert.match(sidebarSource, /className="worker-chat-loading assistant-material-icon is-loading"/);
  assert.match(sidebarSource, /previewStatus \? \(\s*<span[\s\S]{0,220}sidebar-assistant-preview-loading/);
  assert.match(sidebarSource, /!\s*previewStatus && previewChat \? \(\s*<span className="worker-panel-time-label">/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\],\s*\.assistant-worker-chat-action\[data-action="loading"\]\s*\{[\s\S]{0,100}width: 18px;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-panel-time-label,\s*\.assistant-worker-chat-action\[data-action="loading"\] \.worker-panel-time-label\s*\{[\s\S]{0,80}display: none;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-chat-loading,\s*\.assistant-worker-chat-action\[data-action="loading"\] \.worker-chat-loading\s*\{[\s\S]{0,120}display: inline-flex;/);
  assert.match(globalStyles, /\.sidebar-assistant-preview-loading\s*\{[\s\S]{0,120}color: var\(--ink-muted\);/);
  assert.match(globalStyles, /\.assistant-worker-chat-item:hover \.assistant-worker-chat-action:not\(\[data-action="loading"\]\):not\(\[data-action="awaiting"\]\)/);
  assert.match(globalStyles, /\.assistant-worker-chat-item:hover \.assistant-worker-chat-action:not\(\[data-action="loading"\]\):not\(\[data-action="awaiting"\]\) ~ \.assistant-worker-chat-menu-button/);
  assert.match(globalStyles, /@keyframes assistant-worker-chat-spin\s*\{[\s\S]*?translateY\(-50%\) rotate\(360deg\)/);
});

test("assistant sidebar empty state is localized", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(sidebarSource, /<div className="status-line">\s*\{t\("sidebar\.assistants\.empty"\)\}\s*<\/div>/);
  assert.doesNotMatch(sidebarSource, /暂无智能体/);
  assert.match(zhCN, /"sidebar\.assistants\.empty": "暂无智能体"/);
  assert.match(zhCN, /"sidebar\.assistants\.awaitingStatus\.approval": "等待批准"/);
  assert.match(zhCN, /"sidebar\.assistants\.awaitingStatus\.form": "等待提交"/);
  assert.match(zhCN, /"sidebar\.assistants\.awaitingStatus\.question": "等待回答"/);
  assert.match(zhCN, /"sidebar\.assistants\.awaitingStatus\.plan": "等待实施"/);
  assert.match(zhCN, /"sidebar\.assistants\.sortByName": "按名称"/);
  assert.match(zhCN, /"sidebar\.assistants\.sortByTime": "按时间"/);
  assert.match(enUS, /"sidebar\.assistants\.empty": "No assistants"/);
  assert.match(enUS, /"sidebar\.assistants\.awaitingStatus\.approval": "Await Appr"/);
  assert.match(enUS, /"sidebar\.assistants\.awaitingStatus\.form": "Await Submit"/);
  assert.match(enUS, /"sidebar\.assistants\.awaitingStatus\.question": "Await Question"/);
  assert.match(enUS, /"sidebar\.assistants\.awaitingStatus\.plan": "Await Impl"/);
  assert.match(enUS, /"sidebar\.assistants\.sortByName": "By name"/);
  assert.match(enUS, /"sidebar\.assistants\.sortByTime": "By time"/);
});

test("assistant sidebar empty state waits for navigation load", () => {
  const appShell = readAppShellSource();
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );

  assert.match(appShell, /const \[assistantNavAgentsLoaded, setAssistantNavAgentsLoaded\] = useState\(false\);/);
  assert.match(appShell, /setAssistantNavAgentsLoaded\(true\);/);
  assert.match(appShell, /assistantNavAgentsLoaded=\{assistantNavAgentsLoaded\}/);
  assert.match(sidebarSource, /assistantNavAgentsLoaded\?: boolean;/);
  assert.match(sidebarSource, /assistantNavAgentsLoaded = true,/);
  assert.match(sidebarSource, /assistantNavAgentsLoaded \? \(\s*<div className="status-line">\s*\{t\("sidebar\.assistants\.empty"\)\}\s*<\/div>\s*\) : null/);
});

test("settings route moves section navigation into the app sidebar and uses section subroutes", () => {
  const appShell = readAppShellSource();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.tsx"),
    "utf8"
  );
  const settingsSections = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "settingsPageSections.ts"),
    "utf8"
  );
  const settingsStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.css"),
    "utf8"
  );
  const themeStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "styles", "theme.css"),
    "utf8"
  );
  const controlCenterStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "styles", "control-center.css"),
    "utf8"
  );
  const brandMarkSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "BrandMark.tsx"),
    "utf8"
  );
  const enUS = fs.readFileSync(
    path.join(projectRoot, "src", "shared", "i18n", "dictionaries", "enUS.ts"),
    "utf8"
  );
  const zhCN = fs.readFileSync(
    path.join(projectRoot, "src", "shared", "i18n", "dictionaries", "zhCN.ts"),
    "utf8"
  );

  assert.match(appShell, /<Route\s+path="\/settings"/);
  assert.match(appShell, /path="\/settings\/:sectionId"/);
  assert.match(appShell, /lastNonSettingsRouteRef/);
  assert.match(appShell, /buildSettingsSectionPath/);
  assert.match(appShell, /navigate\(normalizedSettingsPath, \{ replace: true \}\)/);
  assert.match(appShell, /onSelectSettingsSection=\{handleSelectSettingsSection\}/);
  assert.match(appShell, /is-settings-mode/);
  assert.match(appShell, /aboutSettingsClickCountRef/);
  assert.match(appShell, /debugSettingsUnlocked/);
  assert.match(appShell, /debugVisible:\s*debugSettingsUnlocked/);
  assert.match(appShell, /debugVisible=\{debugSettingsUnlocked\}/);

  assert.match(settingsSections, /buildLocalizedSettingsSections/);
  assert.match(settingsSections, /debugVisible = false/);
  assert.match(settingsSections, /debugVisible\?:\s*boolean;/);
  assert.doesNotMatch(settingsSections, /kanbanEnabled\?:\s*boolean/);
  assert.match(settingsSections, /group:\s*"personal"/);
  assert.match(settingsSections, /group:\s*"integrations"/);
  assert.match(settingsSections, /group:\s*"system"/);
  assert.match(settingsSections, /return \[[\s\S]*?id:\s*"general"[\s\S]*?group:\s*"personal"[\s\S]*?id:\s*"appearance"[\s\S]*?group:\s*"personal"[\s\S]*?id:\s*"assistant"[\s\S]*?group:\s*"personal"[\s\S]*?id:\s*"navigation"[\s\S]*?group:\s*"personal"[\s\S]*?id:\s*"kanban"[\s\S]*?group:\s*"integrations"/);
  assert.match(settingsSections, /id:\s*"kanban"[\s\S]*?visible:\s*true/);
  assert.match(settingsSections, /id:\s*"assistant"[\s\S]*?label:\s*"assistant"[\s\S]*?layout:\s*"measure"[\s\S]*?visible:\s*true/);
  assert.match(settingsSections, /id:\s*"market"[\s\S]*?label:\s*"market"[\s\S]*?layout:\s*"measure"/);
  assert.match(settingsSections, /id:\s*"navigation"[\s\S]*?label:\s*"navigation"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsSections, /id:\s*"assistant"[\s\S]*?label:\s*"assistant"[\s\S]*?layout:\s*"measure"/);
  assert.doesNotMatch(settingsSections, /id:\s*"sideAssistant"/);
  assert.match(settingsSections, /id:\s*"embeddedWebs"[\s\S]*?label:\s*"embeddedWebs"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsSections, /id:\s*"dataRoot"[\s\S]*?label:\s*"dataRoot"/);
  assert.match(settingsSections, /id:\s*"memory"[\s\S]*?label:\s*"memory"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsSections, /id:\s*"about"[\s\S]*?visible:\s*true[\s\S]*?id:\s*"debug"[\s\S]*?visible:\s*debugVisible/);
  assert.match(settingsSections, /debug:\s*\{\s*label:\s*"settings\.debug\.label",\s*description:\s*"settings\.debug\.description"\s*\}/);
  assert.doesNotMatch(settingsSections, /id:\s*"runtimeReset"/);
  assert.match(settingsSections, /id:\s*"about"[\s\S]*?label:\s*"about"[\s\S]*?layout:\s*"measure"[\s\S]*?visible:\s*true/);

  assert.match(sidebarSource, /isSettingsMode\?: boolean;/);
  assert.match(sidebarSource, /\{!isSettingsMode \? \([\s\S]*?sidebar-collapsed-toggle-button/);
  assert.match(sidebarSource, /settingsSections\?: SettingsSidebarSection\[\];/);
  assert.match(sidebarSource, /sidebar-settings-nav/);
  assert.match(sidebarSource, /SETTINGS_SECTION_GROUPS/);
  assert.match(sidebarSource, /settingsSearchQuery/);
  assert.match(sidebarSource, /settings\.searchPlaceholder/);
  assert.match(sidebarSource, /settings\.searchAriaLabel/);
  assert.match(sidebarSource, /settings\.searchNoResults/);
  assert.match(sidebarSource, /settings-section-group-heading/);
  assert.match(sidebarSource, /section\.description/);
  assert.match(sidebarSource, /settings\.backToApp/);
  assert.match(sidebarSource, /onExitSettingsMode/);
  assert.match(sidebarSource, /case "general"[\s\S]*?return "settings"/);
  assert.match(sidebarSource, /case "appearance"[\s\S]*?return "appearance"/);
  assert.match(sidebarSource, /case "kanban"[\s\S]*?return "futures"/);
  assert.match(sidebarSource, /case "assistant"[\s\S]*?return "assistant"/);
  assert.match(sidebarSource, /case "market"[\s\S]*?return "market"/);
  assert.match(sidebarSource, /case "tunnelHub"[\s\S]*?return "service"/);
  assert.doesNotMatch(sidebarSource, /case "runtimeReset"/);
  assert.match(sidebarSource, /case "about"[\s\S]*?return "about"/);
  assert.match(sidebarSource, /case "debug"[\s\S]*?return "settings"/);
  assert.match(brandMarkSource, /about:\s*aboutIcon/);
  assert.match(brandMarkSource, /appearance:\s*appearanceIcon/);

  assert.match(settingsPage, /useParams\(\)/);
  assert.match(settingsPage, /resolveSettingsSectionId/);
  assert.doesNotMatch(settingsPage, /kanbanEnabled:\s*boolean/);
  assert.match(settingsPage, /buildLocalizedSettingsSections\(\{ isWindows, desktopPetSupported, debugVisible, t \}\)/);
  assert.match(settingsPage, /switch \(activeSection\)/);
  assert.match(settingsPage, /case "appearance"/);
  assert.match(settingsPage, /settings-appearance-panel/);
  assert.match(settingsPage, /settings-appearance-row/);
  assert.match(settingsPage, /settings-theme-segment/);
  assert.match(settingsPage, /<Select<SupportedLocale>[\s\S]*?aria-label=\{t\("settings\.language\.label"\)\}/);
  assert.match(settingsStyles, /\.settings-language-select\s*\{[\s\S]*?border-radius:\s*8px;/);
  assert.match(themeStyles, /--accent-border:\s*rgba\(var\(--accent-rgb\), 0\.46\)/);
  assert.match(themeStyles, /--control-focus-ring:\s*0 0 0 3px var\(--accent-glow\)/);
  assert.match(themeStyles, /--control-switch-height:\s*22px;/);
  assert.doesNotMatch(settingsStyles, /rgba\(38, 99, 235/);
  assert.match(settingsStyles, /\.desktop-pet-appearance-select\.is-selected\s*\{[\s\S]*?color: var\(--accent-on\)/);
  assert.match(controlCenterStyles, /\.settings-switch\s*\{[\s\S]*?height: var\(--control-switch-height\)/);
  assert.match(controlCenterStyles, /\.settings-switch\.is-on\s*\{[\s\S]*?background: var\(--accent\)/);
  assert.doesNotMatch(controlCenterStyles, /#2F95FF/);
  assert.doesNotMatch(controlCenterStyles, /\.assistant-memory-switch-row \.settings-switch\s*\{[\s\S]*?width: 54px;/);
  assert.match(settingsPage, /onThemeModeChange/);
  assert.doesNotMatch(settingsPage, /settings-theme-preview/);
  assert.doesNotMatch(settingsPage, /onToggleTheme/);
  assert.match(settingsPage, /settings-pet-card/);
  assert.match(settingsPage, /settings-item-card/);
  assert.match(settingsStyles, /\.settings-item-card,[\s\S]*?border-radius:\s*8px;/);
  assert.doesNotMatch(settingsStyles, /\.settings-page \.navigation-settings-card,[\s\S]*?border:\s*none;/);
  assert.match(settingsPage, /settings-pet-appearance-panel/);
  assert.match(settingsPage, /settings-appearance-pet-card/);
  assert.doesNotMatch(settingsPage, /settings\.desktopPet\.currentStatus/);
  assert.doesNotMatch(settingsPage, /settings\.desktopPet\.currentBinding/);
  assert.match(settingsStyles, /\.settings-appearance-panel/);
  assert.match(settingsStyles, /\.settings-theme-segment/);
  assert.match(settingsPage, /case "assistant"/);
  assert.match(settingsPage, /case "memory"/);
  assert.doesNotMatch(settingsPage, /case "runtimeReset"/);
  assert.match(settingsPage, /case "debug"[\s\S]*?<LocalWsServerDebugCard \/>/);
  assert.match(settingsPage, /function LocalWsServerDebugCard/);
  assert.match(settingsPage, /settings\.debug\.desktopWs\.title/u);
  assert.doesNotMatch(settingsPage, /window\.electronAPI\.debug/u);
  assert.match(settingsPage, /window\.electronAPI\.settings\.resetRuntimeEnv\(\)/);
  assert.match(settingsPage, /settings-reset-card/);
  assert.match(settingsPage, /settings\.reset\.backupPath/);
  assert.match(settingsPage, /showSectionNotice\("about", result\.message \|\| t\("settings\.reset\.failed"\), "error"\)/);
  assert.match(settingsPage, /case "about"/);
  assert.match(settingsPage, /<AboutAppCard[\s\S]*?runtimeResetPending=\{runtimeResetPending\}[\s\S]*?runtimeResetResult=\{runtimeResetResult\}[\s\S]*?onResetRuntimeEnv=\{handleResetRuntimeEnv\}/);
  assert.match(settingsPage, /settings-item-card settings-about-card/);
  assert.match(settingsPage, /settings-desktop-ws-card/);
  assert.match(settingsPage, /window\.electronAPI\.settings[\s\S]*?\.getDesktopWsServerState\(\)/);
  assert.match(settingsPage, /window\.electronAPI\.settings[\s\S]*?\.setDesktopWsServerEnabled/);
  assert.match(settingsPage, /settings\.debug\.desktopWs\.openAction/);
  assert.match(settingsPage, /settings\.debug\.desktopWs\.closeAction/);
  assert.doesNotMatch(settingsPage, /settings\.about\.desktopWs/);
  assert.doesNotMatch(settingsPage, /settings-debug-card/);
  assert.match(settingsPage, /settings-about-version/);
  assert.match(settingsPage, /settings\.about\.versionDescription/);
  assert.doesNotMatch(settingsPage, /settings-about-meta/);
  assert.match(settingsStyles, /\.settings-about-version\s*\{[\s\S]*?border-radius:\s*8px;/);
  assert.match(settingsStyles, /\.settings-desktop-ws-status/);
  assert.match(settingsStyles, /\.settings-page \.settings-reset-card/);
  assert.match(settingsPage, /settings-page-single/);
  assert.match(settingsPage, /settings-content-panel/);
  assert.doesNotMatch(settingsPage, /settings-directory-nav/);
  assert.match(settingsPage, /contentRef\.current\?\.scrollTo/);
  assert.match(settingsStyles, /\.settings-content-panel/);
  assert.match(sidebarSource, /settings\.group\.personal/);
  assert.match(sidebarSource, /settings\.group\.integrations/);
  assert.match(sidebarSource, /settings\.group\.system/);
  assert.match(enUS, /"settings\.debug\.label":\s*"Debug"/);
  assert.match(enUS, /"settings\.debug\.desktopWs\.title":\s*"Local WS Server Debugging"/);
  assert.match(zhCN, /"settings\.debug\.label":\s*"调试"/);
  assert.match(zhCN, /"settings\.debug\.desktopWs\.title":\s*"本地 WebSocket 服务调试"/);
});

test("startup env import overlay uses packaged-relative brand icon", () => {
  const envImportOverlay = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "startup",
    "EnvImportOverlay.tsx"
  );
  const brandMark = readSourceFile("src", "renderer", "components", "BrandMark.tsx");

  assert.match(envImportOverlay, /import \{ BrandMark \} from "\.\.\/\.\.\/components\/BrandMark";/);
  assert.match(envImportOverlay, /<BrandMark className="brand-logo-image"/);
  assert.doesNotMatch(envImportOverlay, /src=["']\/brand-icon\.png["']/);
  assert.match(brandMark, /src=\{`\.\//);
  assert.match(brandMark, /APP_ICON_ASSET_FILENAMES\.brandMark/);
  assert.doesNotMatch(brandMark, /APP_ICON_ASSET_FILENAMES\.brandIcon/);
});

test("settings page scopes notices to the active section and keeps load failures in-section", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.tsx"),
    "utf8"
  );
  const settingsPageCss = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.css"),
    "utf8"
  );
  const feedbackStack = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "PageFeedbackStack.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();

  assert.match(feedbackStack, /export function PageFeedbackStack/);
  assert.match(feedbackStack, /page-feedback-anchor/);
  assert.match(feedbackStack, /page-feedback-dismiss/);

  assert.match(settingsPage, /type NoticeTone = "success" \| "error";/);
  assert.match(settingsPage, /type SettingsNotice = \{/);
  assert.match(settingsPage, /sectionId: SettingsSectionId;/);
  assert.doesNotMatch(settingsPage, /const \[feedback, setFeedback\] = useState/);
  assert.match(settingsPage, /const \[notice, setNotice\] = useState<SettingsNotice \| null>\(null\)/);
  assert.match(settingsPage, /const \[sectionReadErrors, setSectionReadErrors\] = useState<SectionReadErrorMap>\(\{\}\)/);
  assert.match(settingsPage, /function showSectionNotice\(sectionId: SettingsSectionId, message: string, tone: NoticeTone\)/);
  assert.match(settingsPage, /if \(tone === "success"\) \{\s*return;\s*\}/);
  assert.match(settingsPage, /const activeSectionNotice = notice && notice\.sectionId === activeSection && notice\.tone === "error" \? notice : null;/);
  assert.doesNotMatch(settingsPage, /SETTINGS_NOTICE_AUTO_CLOSE_MS/);
  assert.match(settingsPage, /const activeSectionReadError = activeSection \? sectionReadErrors\[activeSection\] \?\? "" : "";/);
  assert.match(settingsPage, /settings-section-feedback/);
  assert.match(settingsPage, /<PageFeedbackStack/);
  assert.match(settingsPage, /showSectionNotice\("assistant", nextState\.enabled \? t\("settings\.desktopPet\.noticeEnabled"\) : t\("settings\.desktopPet\.noticeDisabled"\), "success"\)/);
  assert.doesNotMatch(settingsPage, /导航页签排序已更新/);
  assert.match(settingsPage, /showSectionNotice\("assistant", reason instanceof Error \? reason\.message : String\(reason\), "error"\)/);
  assert.match(settingsPage, /feedback-banner warning-banner settings-section-read-error/);
  assert.doesNotMatch(settingsPage, /\{feedback \? <div className="feedback-banner">\{feedback\}<\/div> : null\}/);

  assert.match(settingsPageCss, /\.settings-pet-appearance-panel[\s\S]*?border: none;/);
  assert.match(settingsPageCss, /\.settings-pet-appearance-panel[\s\S]*?border-top: 1px solid var\(--line\)/);
  assert.match(settingsPageCss, /\.settings-appearance-pet-card \+ \.desktop-helper-settings-card\s*\{[\s\S]*?margin-top: 12px;/);
  assert.match(settingsPageCss, /\.settings-pet-appearance-row \.desktop-pet-appearance-copy small[\s\S]*?color: var\(--ink-muted\)/);
  assert.match(settingsPageCss, /\.desktop-pet-appearance-select\.is-selected\s*\{[\s\S]*?background: var\(--accent\)/);
  assert.match(settingsPageCss, /\.desktop-pet-appearance-select\.is-selected\s*\{[\s\S]*?cursor: not-allowed/);
  assert.match(settingsPageCss, /\.desktop-pet-appearance-select:disabled:not\(\.is-selected\)/);
  assert.doesNotMatch(settingsPageCss, /rgba\(38, 99, 235/);
  assert.match(settingsPageCss, /\.settings-section-feedback\s*\{/);
  assert.match(settingsPageCss, /\.settings-section-read-error\s*\{/);
  assert.match(globalStyles, /\.page-feedback-anchor\s*\{/);
  assert.match(globalStyles, /\.page-feedback-layer\s*\{/);
  assert.match(globalStyles, /\.page-feedback-toast\s*\{/);
  assert.match(globalStyles, /\.page-feedback-dismiss\s*\{/);
});

test("settings page configures desktop helper default agent separately from desktop pet", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.tsx"),
    "utf8"
  );
  const settingsPageSections = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "settingsPageSections.ts"),
    "utf8"
  );
  const settingsStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.css"),
    "utf8"
  );
  const sharedSettings = fs.readFileSync(
    path.join(projectRoot, "src", "shared", "assistant-settings.ts"),
    "utf8"
  );
  const settingsStore = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "core", "settings-store.ts"),
    "utf8"
  );
  const globalStyles = readRendererStyles();

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
  assert.doesNotMatch(settingsPage, /<p className="eyebrow">NAVIGATION<\/p>/);
  assert.match(settingsPageSections, /settings\.navigation\.label/);
  assert.doesNotMatch(settingsPage, /半透明度/);
  assert.doesNotMatch(settingsPage, /导航栏半透明效果/);
  assert.doesNotMatch(settingsPage, /type="range"/);
  assert.match(settingsPage, /settings\.navigation\.fixedMain/);
  assert.match(settingsPage, /settings\.navigation\.fixedTools/);
  assert.doesNotMatch(settingsPage, /settings\.navigation\.kanbanToggle/);
  assert.doesNotMatch(settingsPage, /settings\.navigation\.kanbanVisible/);
  assert.doesNotMatch(settingsPage, /settings\.navigation\.kanbanHidden/);
  assert.match(settingsPageSections, /settings\.kanban\.label/);
  assert.match(settingsPageSections, /settings\.assistant\.label/);
  assert.match(settingsPageSections, /settings\.market\.label/);
  assert.match(settingsPage, /case "kanban"/);
  assert.doesNotMatch(settingsPage, /settings\.kanban\.enabled/);
  assert.match(settingsPage, /window\.electronAPI\.taskBoard\.getSettings/);
  assert.match(settingsPage, /window\.electronAPI\.taskBoard\.saveSettings/);
  assert.match(settingsPage, /import \{ Button, Card, Checkbox, Form, Input, InputNumber, QRCode, Segmented, Select, Space, Switch, Typography \} from "antd"/);
  assert.match(settingsPage, /<Card[\s\S]*className="settings-item-card settings-control-card settings-kanban-ant-card"/);
  assert.match(settingsPage, /<Switch[\s\S]*handleToggleControlRemoteControl/);
  assert.match(settingsPage, /<Form[\s\S]*className="settings-control-form settings-kanban-ant-form"[\s\S]*onFinish=\{\(\) => void saveControlCloudConfig\(controlCloudConfig\)\}/);
  assert.match(settingsPage, /<Input[\s\S]*taskBoard\.cloud\.deviceAliasPlaceholder/);
  assert.doesNotMatch(settingsPage, /<Input\.Password[\s\S]*taskBoard\.cloud\.tokenPlaceholder/);
  assert.match(settingsPage, /<Select[\s\S]*options=\{controlProjectSelectOptions\}/);
  assert.match(settingsPage, /<Button[\s\S]*htmlType="submit"[\s\S]*settings\.kanban\.save/);
  assert.match(settingsPage, /case "assistant"/);
  assert.match(settingsPage, /activeSection === "assistant"/);
  assert.match(settingsPage, /case "market"/);
  assert.match(settingsPage, /settings\.market\.apiBaseUrl/);
  assert.match(settingsPage, /window\.electronAPI\.market\.saveSettings/);
  assert.doesNotMatch(settingsPage, /handleToggleKanbanVisibility/);
  assert.doesNotMatch(settingsPage, /handleSaveControlCloudConfig/);
  assert.doesNotMatch(settingsPage, /saveNavigationPreferences\(\{\s*kanban/);
  assert.match(settingsPage, /settings-item-card navigation-settings-card/);
  assert.match(settingsPage, /settings-item-list navigation-order-list/);
  assert.doesNotMatch(settingsPage, /navigation-order-grid-head/);
  assert.doesNotMatch(settingsPage, /settings\.navigation\.currentDefault/);
  assert.match(settingsPage, /settings\.navigation\.noSideAssistant/);
  assert.match(settingsPage, /getCopilotPageKeyForSidebarNavOrderItem/);
  assert.match(settingsPage, /handleSelectNavigationCopilotAgent/);
  assert.match(settingsPage, /settings\.navigation\.fixedMainOrder/);
  assert.match(settingsPage, /data-sidebar-nav-order-key/);
  assert.doesNotMatch(settingsPage, /handleSidebarNavPointerDown/);
  assert.doesNotMatch(settingsPage, /document\.addEventListener\("pointermove"/);
  assert.doesNotMatch(settingsPage, /navigation-order-drag-handle/);
  assert.match(settingsPageSections, /settings\.embeddedWebs\.label/);
  assert.match(settingsPage, /settings\.embeddedWebs\.linkedAgentFor/);
  assert.match(settingsPage, /handleUpdateWebsiteAgent/);
  assert.match(settingsPage, /editingWebsiteId/);
  assert.match(settingsPage, /handleStartEditWebsiteItem/);
  assert.match(settingsPage, /handleUpdateWebsiteItem/);
  assert.match(settingsPage, /label:\s*websiteLabel/);
  assert.match(settingsPage, /url:\s*websiteUrl/);
  assert.match(settingsPage, /settings\.embeddedWebs\.edit/);
  assert.match(settingsPage, /settings\.embeddedWebs\.save/);
  assert.match(settingsPage, /settings\.embeddedWebs\.cancel/);
  assert.match(settingsPage, /window\.electronAPI\.webs\.websites\.update/);
  assert.doesNotMatch(settingsPage, /自定义侧边栏/);
  assert.doesNotMatch(settingsPage, /添加到侧边栏/);
  assert.doesNotMatch(settingsPage, /已添加的入口/);
  assert.doesNotMatch(settingsPage, /自定义入口/);
  assert.doesNotMatch(settingsPage, /DESKTOP ASSISTANT/);
  assert.doesNotMatch(settingsPage, /DESKTOP PET/);
  assert.doesNotMatch(settingsPage, /单独配置 Option\+Space 唤起的快捷助手，和侧边助手、宠物助手相互独立/);
  assert.doesNotMatch(settingsPage, /宠物只服务侧边助手，会在等待回答、完成或出错时做轻提醒。右键宠物可直接关闭/);
  assert.doesNotMatch(settingsPage, /将常用网页作为内嵌网站固定至导航栏便捷访问。内嵌网站仅保存在本地，支持导入导出，系统入口不可修改/);
  assert.doesNotMatch(settingsPage, /按模块管理桌面工作台、助手能力和本地数据行为/);
  assert.doesNotMatch(settingsPage, /className="website-copy"/);
  assert.match(settingsPageSections, /settings\.assistant\.label/);
  assert.doesNotMatch(settingsPage, /case "sideAssistant"/);
  assert.doesNotMatch(settingsPage, /SIDE ASSISTANT/);
  assert.match(settingsPage, /settings\.navigation\.defaultAssistant/);
  assert.match(settingsPage, /desktopPetSupported/);
  assert.match(settingsPage, /handleToggleDesktopPet/);
  assert.match(settingsPage, /quickAssistantEnabled/);
  assert.match(settingsPage, /quickAssistantAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.listCopilotAgents\(\),[\s\S]*?window\.electronAPI\.assistant\.listAgents\(\)/);
  assert.match(settingsPage, /readAssistantAgentOptions\(agentsResult, fallbackAgents\)/);
  assert.match(settingsPage, /handleToggleQuickAssistantEnabled/);
  assert.match(settingsPage, /handleSelectQuickAssistantAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*quickAssistantAgentKey: normalizedAgentKey\s*\}\)/);
  assert.doesNotMatch(settingsPage, /页面 Copilot/);
  assert.doesNotMatch(settingsPage, />选择宠物</);
  assert.doesNotMatch(settingsPage, /半透明侧边栏/);
  assert.match(settingsPage, /function isMarketVisible\(settings: MarketSettings\) \{\s*return settings\.enabled === true;\s*\}/);
  assert.match(settingsPage, /function renderSectionHeaderAction\(\)[\s\S]*case "assistant"[\s\S]*handleToggleDesktopPet[\s\S]*case "market"[\s\S]*handleToggleMarketEnabled[\s\S]*case "tunnelHub"[\s\S]*handleToggleTunnelHubEnabled/);
  assert.match(settingsPage, /className="settings-page-head"[\s\S]*settings-page-head-copy[\s\S]*settings-page-head-action[\s\S]*renderSectionHeaderAction\(\)/);
  assert.match(settingsStyles, /\.settings-page-head\s*\{[\s\S]*display:\s*flex;[\s\S]*justify-content:\s*space-between;/);
  assert.match(settingsStyles, /\.settings-page-head-action\s*\{[\s\S]*justify-content:\s*flex-end;/);
  assert.doesNotMatch(settingsPage, /TUNNEL_HUB_AGENT_SERVICE_ID/);
  assert.doesNotMatch(settingsPage, /window\.electronAPI\.services\.start\([^)]*tunnel/i);
  assert.doesNotMatch(settingsPage, /window\.electronAPI\.services\.stop\([^)]*tunnel/i);
  assert.doesNotMatch(settingsPage, /onClick=\{\(\) => setMarketSettings/);
  assert.match(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.agents"[\s\S]*?labelKey:\s*"nav\.market"[\s\S]*?labelKey:\s*"nav\.controlCenter"[\s\S]*?labelKey:\s*"nav\.settings"[\s\S]*?labelKey:\s*"nav\.help"/);
  assert.doesNotMatch(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.memory"/);
  assert.doesNotMatch(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.schedules"/);
  assert.match(settingsPage, /visibleFixedNavigationTools = fixedNavigationTools\.filter\(\(tool\) => tool\.id !== "market" \|\| marketEnabled\)/);
  assert.match(settingsPage, /copilotPageKey:\s*"controlCenter"/);
  assert.match(settingsPage, /copilotPageKey:\s*"market"/);
  assert.match(settingsPage, /navigation-order-fixed-label/);
  assert.doesNotMatch(settingsPage, /navigation-order-fixed-dot/);
  assert.match(settingsPage, /navigationSettingsOrder\.map/);
  assert.match(settingsPage, /\{visibleFixedNavigationTools\.map\(\(tool\) => renderFixedNavigationToolRow\(tool\)\)\}/);
  assert.match(settingsPage, /handleSelectDesktopHelperAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*desktopHelperAgentKey: normalizedAgentKey\s*\}\)/);
  assert.match(settingsPage, /desktopCopilotPages: nextPages/);
  assert.match(settingsPage, /settings-item-section-head website-list-head navigation-assistant-default-head/);
  assert.match(settingsPage, /settings-item-form navigation-assistant-default/);
  assert.match(settingsPage, /settings\.navigation\.defaultAssistantDescription/);
  assert.match(settingsPage, /settings\.navigation\.fixedMainDescription/);
  assert.match(settingsPage, /settings\.navigation\.fixedToolsDescription/);
  assert.match(settingsPage, /settings\.assistant\.panelAria/);
  assert.match(settingsPage, /settings\.navigation\.defaultAssistant/);
  assert.match(globalStyles, /grid-template-columns:\s*minmax\(140px,\s*1fr\)\s*minmax\(220px,\s*300px\)\s*124px/);
  assert.doesNotMatch(settingsPage, /onClick=\{resetSidebarNavOrder\}/);
  assert.doesNotMatch(settingsPage, /moveSidebarNavOrderItem/);
});

test("settings page memory section routes visible text through i18n", () => {
  const settingsPage = readSourceFile(
    "src",
    "renderer",
    "pages",
    "settings",
    "SettingsPage.tsx"
  );

  assert.match(settingsPage, /t\("settings\.memory\.sectionDescription"\)/);
  assert.match(settingsPage, /t\("settings\.memory\.recall"\)/);
  assert.match(settingsPage, /t\("settings\.memory\.storage"\)/);
  assert.doesNotMatch(
    settingsPage,
    /助手记忆|记忆召回|自动学习|最近记忆|本地存储|最近记录|暂无操作|已暂停引用|仅保留现有记忆/
  );
});

test("settings page exposes cloud board control as a global section", () => {
  const settingsPage = readSourceFile("src", "renderer", "pages", "settings", "SettingsPage.tsx");
  const settingsSections = readSourceFile("src", "renderer", "settingsPageSections.ts");
  const sharedSettingsSections = readSourceFile("src", "shared", "settings-sections.ts");
  const taskBoardContracts = readSourceFile("src", "shared", "contracts", "task-board.ts");
  const taskBoardRuntime = readSourceFile("src", "main", "task-board-runtime.ts");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(sharedSettingsSections, /"kanban"/);
  assert.match(settingsSections, /id:\s*"kanban"[\s\S]*?settings\.kanban\.label/);
  assert.match(settingsPage, /case "kanban"/);
  assert.match(settingsPage, /settings\.control\.remoteControlEnabled/);
  assert.match(settingsPage, /settings\.control\.remoteControlDescription/);
  assert.match(settingsPage, /window\.electronAPI\.taskBoard\.getSettings/);
  assert.match(settingsPage, /window\.electronAPI\.taskBoard\.saveSettings/);
  assert.match(settingsPage, /window\.electronAPI\.taskBoard\.listOnlineDevices/);
  assert.match(taskBoardContracts, /interface TaskBoardSettings[\s\S]*?enabled:\s*boolean;[\s\S]*?cloud:\s*TaskBoardCloudConfig;/);
  assert.match(taskBoardContracts, /interface TaskBoardSettingsInput[\s\S]*?enabled\?:\s*boolean;[\s\S]*?cloud\?:\s*Partial<TaskBoardCloudConfig>;/);
  assert.match(taskBoardContracts, /remoteControlEnabled:\s*boolean/);
  assert.match(taskBoardRuntime, /remoteControlEnabled/);
  assert.match(taskBoardRuntime, /config\.remoteControlEnabled/);
  assert.match(taskBoardRuntime, /KANBAN_CONFIG_FILE = "kanban\.json"/);
  assert.match(zhCN, /"settings\.control\.label":\s*"控制"/);
  assert.match(zhCN, /"settings\.kanban\.label":\s*"看板"/);
  assert.match(zhCN, /"settings\.control\.remoteControlEnabled":\s*"允许云看板控制此桌面端"/);
  assert.match(enUS, /"settings\.control\.label":\s*"Control"/);
  assert.match(enUS, /"settings\.kanban\.label":\s*"Kanban"/);
  assert.match(settingsSections, /id:\s*"kanban"[\s\S]*?visible:\s*true/);
  assert.match(settingsPage, /buildLocalizedSettingsSections\(\{ isWindows, desktopPetSupported, debugVisible, t \}\)/);
});

test("Tunnel Hub settings expose enabled state and Desktop runtime wiring", () => {
  const settingsPage = readSourceFile("src", "renderer", "pages", "settings", "SettingsPage.tsx");
  const servicesContract = readSourceFile("src", "shared", "contracts", "services.ts");
  const tunnelSettings = readSourceFile("src", "main", "tunnel-hub-agent-settings.ts");
  const tunnelRuntime = readSourceFile("src", "main", "tunnel-hub-runtime.ts");

  assert.match(servicesContract, /interface TunnelHubAgentSettings[\s\S]*?enabled:\s*boolean;/);
  assert.match(servicesContract, /interface TunnelHubAgentSettingsInput[\s\S]*?enabled\?:\s*boolean;/);
  assert.match(servicesContract, /interface TunnelHubRuntimeStatus[\s\S]*?phase:\s*TunnelHubRuntimePhase;/);
  assert.match(tunnelSettings, /readTunnelHubAgentSettings[\s\S]*?enabled/);
  assert.match(tunnelSettings, /requestedEnabled && issues\.length === 0/);
  assert.match(tunnelRuntime, /startTunnelHubRuntimeIfEnabled/);
  assert.doesNotMatch(tunnelRuntime, /startService|restartService|TUNNEL_HUB_AGENT_SERVICE_ID/);
  assert.match(settingsPage, /case "tunnelHub"[\s\S]*handleToggleTunnelHubEnabled/);
});

test("settings page hides assistant memory while the module is disabled", () => {
  const settingsSections = readSourceFile(
    "src",
    "renderer",
    "settingsPageSections.ts"
  );

  assert.match(settingsSections, /id:\s*"memory"[\s\S]*?visible:\s*false/);
});

test("settings page renderer text is routed through i18n", () => {
  const settingsFiles = [
    ["src", "renderer", "pages", "settings", "SettingsPage.tsx"],
    ["src", "renderer", "settingsPageSections.ts"]
  ];

  for (const segments of settingsFiles) {
    const source = readSourceFile(...segments);
    assert.doesNotMatch(source, /[\p{Script=Han}]/u, `${segments.join("/")} contains hardcoded Chinese text`);
  }
});

test("sidebar translucency is fixed and not user configurable", () => {
  const appShell = readAppShellSource();
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const appMetadata = fs.readFileSync(path.join(projectRoot, "src", "main", "app-metadata.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const settingsHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "settings-handlers.ts"), "utf8");
  const contracts = readSharedContractsSource();

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
  assert.match(lightSidebarRule, /rgba\(255,\s*255,\s*255,\s*0\.08\)\s*0%/);
  assert.match(lightSidebarRule, /rgba\(255,\s*255,\s*255,\s*0\.05\)\s*46%/);
  assert.match(lightSidebarRule, /rgba\(255,\s*255,\s*255,\s*0\.03\)\s*100%/);
  assert.match(darkSidebarRule, /background:\s*#202020;/);
  assert.doesNotMatch(darkSidebarRule, /rgba\(57,\s*58,\s*62,\s*0\.5\)/);
  assert.doesNotMatch(darkSidebarRule, /rgba\(46,\s*48,\s*52,\s*0\.44\)/);
  assert.doesNotMatch(darkSidebarRule, /rgba\(37,\s*39,\s*43,\s*0\.38\)/);
  assert.match(macSidebarRule, /rgba\(255,\s*255,\s*255,\s*0\.08\)\s*0%/);
  assert.match(macSidebarRule, /rgba\(255,\s*255,\s*255,\s*0\.05\)\s*46%/);
  assert.match(macSidebarRule, /rgba\(255,\s*255,\s*255,\s*0\.03\)\s*100%/);
  assert.match(macSidebarRule, /blur\(12px\)\s*saturate\(112%\)\s*brightness\(1\.01\)/);
  assert.match(macDarkSidebarRule, /background:\s*#202020;/);
  assert.match(macDarkSidebarRule, /backdrop-filter:\s*none;/);
  assert.match(macDarkSidebarRule, /-webkit-backdrop-filter:\s*none;/);
  assert.doesNotMatch(macDarkSidebarRule, /rgba\(57,\s*58,\s*62,\s*0\.5\)/);
  assert.doesNotMatch(macDarkSidebarRule, /rgba\(46,\s*48,\s*52,\s*0\.44\)/);
  assert.doesNotMatch(macDarkSidebarRule, /rgba\(37,\s*39,\s*43,\s*0\.38\)/);
  assert.doesNotMatch(macDarkSidebarRule, /brightness\(0\.76\)/);

  assert.doesNotMatch(preload, /setSidebarTranslucency/);
  assert.match(preload, /getAppInfo:\s*\(\) => ipcRenderer\.invoke\("settings\.getAppInfo"\)/);
  assert.match(preload, /resetRuntimeEnv:\s*\(\) => ipcRenderer\.invoke\("settings\.resetRuntimeEnv"\)/);
  assert.match(preload, /setNativeThemeSource:\s*\(themeMode\) => ipcRenderer\.invoke\("settings\.setNativeThemeSource", themeMode\)/);
  assert.match(preload, /getLocale:\s*\(\) => ipcRenderer\.invoke\("settings\.getLocale"\)/);
  assert.match(preload, /setLocale:\s*\(locale\) => ipcRenderer\.invoke\("settings\.setLocale", locale\)/);
  assert.match(preload, /ipcRenderer\.on\("settings\.localeChanged"/);
  assert.match(preload, /ipcRenderer\.on\("settings\.desktopConfigChanged"/);
  assert.match(contracts, /interface DesktopAppInfo/);
  assert.match(contracts, /productName:\s*string/);
  assert.match(contracts, /buildTime:\s*string/);
  assert.match(contracts, /interface DesktopRuntimeEnvResetResult/);
  assert.match(contracts, /interface MarketSettings[\s\S]*?enabled:\s*boolean;[\s\S]*?apiBaseUrl:\s*string;/);
  assert.match(contracts, /interface MarketSettingsInput[\s\S]*?enabled\?:\s*boolean;[\s\S]*?apiBaseUrl\?:\s*string;/);
  assert.match(contracts, /getAppInfo: \(\) => Promise<DesktopAppInfo>/);
  assert.match(contracts, /resetRuntimeEnv: \(\) => Promise<DesktopRuntimeEnvResetResult>/);
  assert.match(contracts, /setNativeThemeSource:\s*\(themeMode:\s*"light" \| "dark" \| "system"\)/);
  assert.match(contracts, /getNavigationPreferences: \(\) => Promise<\{ mainOrder: string\[\]; webOrder: string\[\]; desktopCopilotPages: DesktopCopilotPagePreferences \}>/);
  assert.match(contracts, /saveNavigationPreferences: \(input: \{ mainOrder\?: string\[\]; webOrder\?: string\[\] \}\)/);
  assert.match(contracts, /getLocale: \(\) => Promise<LocaleSettings>/);
  assert.match(contracts, /setLocale: \(locale: SupportedLocale\) => Promise<LocaleSettings>/);
  assert.match(contracts, /onLocaleChanged: \(listener: LocaleChangedListener\) => \(\) => void/);
  assert.match(contracts, /type DesktopConfigChangedEvent = \{/);
  assert.match(contracts, /onDesktopConfigChanged: \(listener: DesktopConfigChangedListener\) => \(\) => void/);
  assert.match(settingsHandlers, /nativeTheme/);
  assert.match(settingsHandlers, /nativeTheme\.themeSource = themeMode === "dark" \? "dark" : themeMode === "system" \? "system" : "light"/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.getAppInfo"[\s\S]*?getAppInfo\?\.\(\)/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.getDesktopWsServerState"/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.setDesktopWsServerEnabled"/);
  assert.match(settingsPage, /settings\.about\.buildTime/);
  assert.match(settingsPage, /settings-about-build-time/);
  assert.match(mainProcess, /const desktopAppInfo = resolveDesktopAppInfo\(app\);/);
  assert.match(mainProcess, /configureNativeAboutPanel\(mainProcessContext\.platform, app, desktopAppInfo\);/);
  assert.match(mainProcess, /getAppInfo:\s*\(\) => desktopAppInfo/);
  assert.match(appMetadata, /resolveDesktopBuildTime/);
  assert.match(appMetadata, /if \(platform === "darwin"\)[\s\S]*?app\.setAboutPanelOptions\(\{[\s\S]*?applicationName: appInfo\.productName[\s\S]*?applicationVersion: appInfo\.version[\s\S]*?version: appInfo\.buildTime/);
  assert.match(appMetadata, /if \(platform === "win32"\)[\s\S]*?app\.setAboutPanelOptions/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.resetRuntimeEnv"/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.setNativeThemeSource"/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.getLocale", async \(\) => initializeMainI18n\(app\)\)/);
  assert.match(mainProcess, /registerSettingsIpcHandlers\(/);
  assert.match(mainProcess, /general\.desktopWsServerEnabled/);
  assert.match(mainProcess, /startDesktopWsServerForSettings/);
  assert.doesNotMatch(mainProcess, /void startDesktopWsServer\(\{\s*app,/);
  assert.match(mainProcess, /const isFirstDesktopInstall = !desktopDataRootExists\(app\);/);
  assert.match(mainProcess, /initializeMainI18n\(app, \{ isFirstInstall: isFirstDesktopInstall \}\)/);
  assert.match(mainProcess, /function refreshDesktopRuntimeConfigFromCanonicalFiles\(reason: string\)/);
  assert.match(mainProcess, /targetWindow\.webContents\.send\("settings\.desktopConfigChanged", event\)/);
  assert.match(appShell, /onDesktopConfigChanged\(\(\) => \{[\s\S]*?refreshDesktopShellConfigFromCanonical\(\);[\s\S]*?\}\)/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.setLocale", async \(_event: any, locale: unknown\) => \{/);
  assert.doesNotMatch(settingsHandlers, /normalizeKanbanNavigationInput/);
  assert.doesNotMatch(settingsHandlers, /current\.navigation\.kanban/);
  assert.match(settingsHandlers, /buildApplicationMenu\(\);[\s\S]{0,120}refreshTrayContextMenu\(\);[\s\S]{0,120}emitLocaleChanged\(settings\);/);
  assert.doesNotMatch(contracts, /setSidebarTranslucency/);
  assert.doesNotMatch(mainProcess, /settings\.setSidebarTranslucency/);
  assert.doesNotMatch(settingsHandlers, /settings\.setSidebarTranslucency/);
});

test("sidebar navigation order helper normalizes and sorts available items", () => {
  const orderHelper = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "sidebarNavOrder.ts"),
    "utf8"
  );
  const appShell = readAppShellSource();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const settingsPage = readSourceFile("src", "renderer", "pages", "settings", "SettingsPage.tsx");

  assert.match(orderHelper, /export type SidebarNavOrderItemKey/);
  assert.match(orderHelper, /"kanban"/);
  assert.match(orderHelper, /"schedules"/);
  assert.match(orderHelper, /"group:assistants"/);
  assert.match(orderHelper, /"group:webs"/);
  assert.match(orderHelper, /STATIC_SIDEBAR_NAV_ORDER_ITEMS/);
  assert.match(orderHelper, /createDefaultSidebarNavOrderItems/);
  assert.match(orderHelper, /kanbanEnabled\?:\s*boolean/);
  assert.match(orderHelper, /staticItems\.get\("kanban"\)/);
  assert.match(orderHelper, /\.\.\.\(kanbanEnabled \? \[staticItems\.get\("kanban"\)!\] : \[\]\)/);
  assert.match(orderHelper, /staticItems\.get\("schedules"\)/);
  assert.doesNotMatch(orderHelper, /staticItems\.get\("market"\)/);
  assert.doesNotMatch(orderHelper, /staticItems\.get\("agents"\)/);
  assert.doesNotMatch(orderHelper, /staticItems\.get\("help"\)/);
  assert.doesNotMatch(orderHelper, /\.\.\.customItems/);
  assert.doesNotMatch(orderHelper, /\.\.\.serviceItems/);
  assert.doesNotMatch(orderHelper, /\.\.\.experimentalItems/);
  assert.match(orderHelper, /normalizeSidebarNavOrder/);
  assert.match(orderHelper, /const availableKeys = new Set\(availableItems\.map\(\(item\) => item\.key\)\)/);
  assert.match(orderHelper, /availableKeys\.has\(key as SidebarNavOrderItemKey\)/);
  assert.match(orderHelper, /orderedKeys\.push\(item\.key\)/);
  assert.match(orderHelper, /return \["kanban", \.\.\.orderedKeys\.filter\(\(key\) => key !== "kanban"\)\]/);
  assert.doesNotMatch(orderHelper, /return availableItems\.map\(\(item\) => item\.key\)/);
  assert.match(orderHelper, /sortSidebarNavItems/);
  assert.match(appShell, /SIDEBAR_NAV_ORDER_STORAGE_KEY/);
  assert.match(appShell, /WEB_GROUP_ORDER_STORAGE_KEY/);
  assert.match(appShell, /readInitialWebGroupOrder/);
  assert.match(appShell, /key\.startsWith\("custom:"\) \? `website:\$\{key\.slice\("custom:"\.length\)\}`/);
  assert.match(appShell, /normalizeWebGroupOrder/);
  assert.match(appShell, /availableSidebarNavOrderItems/);
  assert.match(appShell, /createDefaultSidebarNavOrderItems\(\{\s*kanbanEnabled,/);
  assert.match(appShell, /const \[kanbanEnabled, setKanbanEnabled\] = useState\(true\)/);
  assert.match(appShell, /const \[kanbanSettingsLoaded, setKanbanSettingsLoaded\] = useState\(false\)/);
  assert.match(appShell, /const \[marketEnabled, setMarketEnabled\] = useState\(false\)/);
  assert.match(appShell, /const marketSettingsRefreshIdRef = useRef\(0\)/);
  assert.match(appShell, /function isMarketSettingsVisible\(settings:[\s\S]*?return settings\?\.enabled === true;/);
  assert.match(appShell, /window\.electronAPI\.taskBoard\.getSettings\(\)/);
  assert.match(appShell, /setKanbanEnabled\(result\.settings\.enabled\)/);
  assert.match(appShell, /async function refreshMarketSettingsVisibility\(\)[\s\S]*?const requestId = marketSettingsRefreshIdRef\.current \+ 1;[\s\S]*?window\.electronAPI\.market\.getSettings\(\)[\s\S]*?setMarketEnabled\(isMarketSettingsVisible\(settings\)\)[\s\S]*?setMarketSettingsLoaded\(true\)/);
  assert.match(appShell, /useEffect\(\(\) => \{\s*void refreshMarketSettingsVisibility\(\);\s*return \(\) => \{\s*marketSettingsRefreshIdRef\.current \+= 1;\s*\};\s*\}, \[\]\);/);
  assert.match(appShell, /window\.electronAPI\.onServicesChanged\(\(\) => \{[\s\S]*?void refreshMarketSettingsVisibility\(\);[\s\S]*?refreshWebItems\(\)\.catch\(\(\) => undefined\);[\s\S]*?void refreshAssistantNavAgents\(\);/);
  assert.match(appShell, /<Navigate to="\/control-center" replace \/>/);
  assert.doesNotMatch(appShell, /item\.key !== "kanban" \|\| kanbanEnabled/);
  assert.match(appShell, /const navigationStateLoaded = navigationPreferencesLoaded && kanbanSettingsLoaded/);
  assert.match(appShell, /if \(!navigationPreferencesLoaded \|\| !kanbanSettingsLoaded\) \{\s*return;\s*\}/);
  assert.doesNotMatch(appShell, /preferences\?\.kanban/);
  assert.doesNotMatch(appShell, /onKanbanEnabledChange/);
  assert.match(settingsPage, /window\.electronAPI\.taskBoard\.saveSettings\(\{\s*enabled:\s*true,/);
  assert.match(appShell, /onMarketEnabledChange=\{setMarketEnabled\}/);
  assert.match(appShell, /marketEnabled=\{marketEnabled\}/);
  assert.match(appShell, /kanbanEnabled=\{kanbanEnabled\}/);
  assert.match(appShell, /normalizeSidebarNavOrder\(sidebarNavOrder, availableSidebarNavOrderItems\)/);
  assert.match(appShell, /websiteNavOrder=\{normalizedWebGroupOrder\}/);
  assert.match(appShell, /webItems=\{webItems\}/);
  assert.match(sidebarSource, /sidebarNavOrder:\s*SidebarNavOrderItemKey\[\]/);
  assert.match(sidebarSource, /marketEnabled\?:\s*boolean/);
  assert.match(sidebarSource, /\.filter\(\(item\) => item\.orderKey !== "market" \|\| marketEnabled\)/);
  assert.match(sidebarSource, /\.filter\(\(item\) => sidebarNavOrder\.includes\(item\.orderKey\)\)/);
  assert.match(sidebarSource, /webItems:\s*WebEntry\[\]/);
  assert.doesNotMatch(sidebarSource, /websiteItems/);
  assert.match(sidebarSource, /sortSidebarNavItems\(/);
});

test("page-level copilot controls sidebar visibility and assistant agent following", () => {
  const appShell = readAppShellSource();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const resolver = fs.readFileSync(path.join(projectRoot, "src", "shared", "page-copilot.ts"), "utf8");

  assert.match(resolver, /resolveDesktopCopilotPageKey/);
  assert.match(resolver, /"\/control-center"[\s\S]*?"controlCenter"/);
  assert.match(resolver, /"\/memory"[\s\S]*?"memory"/);
  assert.match(appShell, /resolveDesktopCopilotPreference/);
  assert.match(appShell, /assistantLauncherVisible = currentCopilotPreference\?\.enabled !== false/);
  assert.match(appShell, /\[assistantDockOpenPath, setAssistantDockOpenPath\] = useState<string \| null>\(null\)/);
  assert.match(appShell, /assistantDockOpen = assistantDockOpenPath !== null/);
  assert.match(appShell, /currentCopilotPreference\?\.enabled === false && assistantDockOpenPath === location\.pathname && !assistantRunningRunId/);
  assert.match(appShell, /isAgentWebclientMainRoute =[\s\S]*?location\.pathname === ASSISTANT_TARGET_PATH \|\|[\s\S]*?isSingleAgentWebclientRoute\(location\.pathname\)/);
  assert.match(appShell, /assistantCopilotOpen = assistantDockOpen && assistantDockOpenPath === location\.pathname && !isAgentWebclientMainRoute/);
  assert.match(appShell, /assistantDockOpenPath !== location\.pathname[\s\S]{0,180}setAssistantDockOpenPath\(null\)/);
  assert.doesNotMatch(appShell, /isAgentWebclientMainRoute && assistantDockOpen[\s\S]{0,180}setAssistantDockOpenPath\(null\)/);
  assert.match(appShell, /assistantLauncherDisabled=\{isAgentWebclientMainRoute\}/);
  assert.match(appShell, /open=\{assistantCopilotOpen\}/);
  assert.match(appShell, /assistantLauncherVisible=\{assistantLauncherVisible\}/);
  assert.match(appShell, /onRunningRunIdChange=\{setAssistantRunningRunId\}/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.match(appShell, /websiteAgentKey = activeWebEntryKey/);
  assert.match(appShell, /resolvedCopilotAgentKey = websiteAgentKey \|\| currentCopilotPreference\?\.agentKey \|\| DEFAULT_DESKTOP_HELPER_AGENT_KEY/);
  assert.match(appShell, /resolvedAgentKey=\{resolvedCopilotAgentKey\}/);
  assert.match(appShell, /assistantDockOpenRequestPathRef = useRef<string \| null>\(null\)/);
  assert.match(appShell, /assistantDockOpenRequestPathRef\.current !== location\.pathname[\s\S]*?setAssistantDockOpenRequest\(null\)/);
  assert.match(appShell, /assistantDockOpenRequestPathRef\.current = location\.pathname[\s\S]*?setAssistantDockOpenRequest\(request\)/);
  assert.match(appShell, /setAssistantDockOpenPath\(location\.pathname\)/);
  assert.match(appShell, /const targetAgentKey = resolveTargetAgentKey\(openRequest, resolvedAgentKey\)/);
  assert.match(appShell, /const targetEmbedPath = buildAgentWebclientCopilotPath\(openRequest, resolvedAgentKey\)/);
  assert.match(appShell, /data-open-agent-key=\{targetAgentKey\}/);
  assert.match(appShell, /key=\{AGENT_WEBCLIENT_COPILOT_DOCK_SURFACE_ID\}/);
  assert.match(appShell, /surfaceId=\{AGENT_WEBCLIENT_COPILOT_DOCK_SURFACE_ID\}/);
  assert.doesNotMatch(appShell, /key=\{`agent-webclient-copilot:\$\{targetEmbedPath\}`\}/);
  assert.match(appShell, /function isSingleAgentWebclientRoute\(pathname: string\)[\s\S]*?matchPath\("\/agent\/:agentKey", pathname\)/);
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
  assert.match(sidebarSource, /title="侧边助手"/);
  assert.doesNotMatch(sidebarSource, /sidebar-link-label-collapsed" aria-hidden="true">助手/);
  assert.doesNotMatch(sidebarSource, /assistantDockOpen \? "is-open" : ""/);
  assert.doesNotMatch(sidebarSource, /sidebar-assistant-switch/);
  assert.match(sidebarSource, /disabled=\{assistantLauncherDisabled\}/);
  assert.doesNotMatch(globalStyles, /\.sidebar-assistant-launcher\.is-open/);
  assert.match(globalStyles, /\.sidebar-assistant-top-button:not\(\.is-assistant-open\)/);
  assert.match(globalStyles, /\.sidebar-assistant-top-button\.is-disabled/);
  assert.doesNotMatch(globalStyles, /\.sidebar-assistant-switch/);
});

test("task board cards show three-line status metadata and light actions", () => {
  const contracts = readSourceFile("src", "shared", "contracts", "task-board.ts");
  const taskBoardPage = readSourceFile("src", "renderer", "pages", "task-board", "TaskBoardPage.tsx");
  const taskBoardStyles = readSourceFile("src", "renderer", "styles", "task-board.css");

  assert.match(contracts, /TASK_BOARD_RUN_STATES/);
  assert.match(contracts, /"cancelled"/);
  assert.match(contracts, /runState: TaskBoardRunState \| null/);
  assert.match(taskBoardPage, /function formatIssueUpdatedTime\(updatedAt: string\)/);
  assert.match(taskBoardPage, /function getIssueCardStatusPresentation\(\s*issue: TaskBoardIssue,\s*options:/);
  assert.match(taskBoardPage, /issue\.status === "backlog"[\s\S]{0,220}label:\s*formatIssueUpdatedTime\(issue\.updatedAt\)/);
  assert.match(taskBoardPage, /issue\.status === "todo"[\s\S]{0,280}label:\s*automationCountdown \|\| formatTaskBoardSortNumber\(options\.sortIndex, issue\.position\)/);
  assert.doesNotMatch(taskBoardPage, /taskBoard\.card\.(updatedAt|sortOrder)/);
  assert.match(taskBoardPage, /options\.awaitingConfirmation && issue\.status === "in_progress"[\s\S]{0,260}taskBoard\.run\.awaitingApproval/);
  assert.match(taskBoardPage, /issue\.runState === "cancelled"[\s\S]{0,220}taskBoard\.run\.cancelled[\s\S]{0,220}tone: "cancelled"/);
  assert.match(taskBoardPage, /issue\.runState === "failed"[\s\S]{0,220}taskBoard\.run\.failed[\s\S]{0,220}tone: "failed"/);
  assert.match(taskBoardPage, /issue\.runState === "running" \|\| \(issue\.status === "in_progress" && Boolean\(issue\.runId\)\)[\s\S]{0,220}taskBoard\.run\.running[\s\S]{0,220}tone: "running"/);
  assert.match(taskBoardPage, /issue\.status === "completed"[\s\S]{0,220}taskBoard\.run\.succeeded[\s\S]{0,220}tone: "succeeded"/);
  assert.match(taskBoardPage, /label: t\(STATUS_META\[issue\.status\]\.labelKey\)[\s\S]{0,120}tone: issue\.status/);
  assert.match(taskBoardPage, /const cardStatus = getIssueCardStatusPresentation\(issue, \{[\s\S]{0,120}awaitingConfirmation[\s\S]{0,120}sortIndex/);
  assert.match(taskBoardPage, /<span className=\{`task-board-status-dot is-\$\{meta\.tone\}`\} aria-hidden="true" \/>/);
  assert.doesNotMatch(taskBoardPage, /status !== "backlog" \? <span className=\{`task-board-status-dot/);
  assert.match(taskBoardPage, /className=\{`task-board-card-status is-\$\{cardStatus\.tone\}`\}/);
  assert.match(taskBoardPage, /\{cardStatus\.tone !== "backlog" && cardStatus\.tone !== "todo" \? <span className="task-board-run-dot" aria-hidden="true" \/> : null\}/);
  assert.match(taskBoardPage, /<span className="task-board-card-status-label">\{cardStatus\.label\}<\/span>/);
  assert.match(taskBoardPage, /<span className="task-board-card-status-time">\{cardStatus\.updatedTime\}<\/span>/);
  assert.match(taskBoardPage, /title=\{automationLabel\}/);
  assert.match(taskBoardPage, /className="task-board-automation-label">\{automationLabel\}<\/span>/);
  assert.match(taskBoardPage, /runState: nextTaskStatus\.runState/);
  assert.match(taskBoardPage, /runState: "running"/);
  assert.match(taskBoardStyles, /\.task-board-card-line-top\s*\{[\s\S]{0,120}height:\s*20px;/);
  assert.match(taskBoardStyles, /\.task-board-card-status\s*\{[\s\S]{0,180}max-width:[\s\S]{0,180}height:\s*20px;/);
  assert.match(taskBoardStyles, /\.task-board-card-status\.is-succeeded[\s\S]{0,160}#15803d/);
  assert.match(taskBoardStyles, /\.task-board-card-status\.is-failed[\s\S]{0,160}#b91c1c/);
  assert.match(taskBoardStyles, /\.task-board-card-status\.is-cancelled[\s\S]{0,160}#475569/);
  assert.match(taskBoardStyles, /\.task-board-card-status\.is-awaiting[\s\S]{0,160}#b45309/);
  assert.match(taskBoardStyles, /\.task-board-card-status\.is-running[\s\S]{0,160}#b45309/);
  const taskBoardStatusRules = taskBoardStyles.match(/[^{}]*\.task-board-card-status\.is-[^{}]*\{[^{}]*\}/g) ?? [];
  assert.notEqual(taskBoardStatusRules.length, 0);
  for (const rule of taskBoardStatusRules.filter(
    (rule) => !rule.includes(".task-board-run-dot") && !rule.includes(".task-board-card-status.is-succeeded")
  )) {
    assert.doesNotMatch(rule, /background:/);
  }
  assert.match(taskBoardStyles, /\.task-board-card-status\.is-completed,[\s\S]{0,120}\.task-board-card-status\.is-succeeded\s*\{[\s\S]{0,120}background:\s*rgba\(22, 163, 74, 0\.1\);/);
  assert.match(taskBoardStyles, /\.task-board-automation-label\s*\{/);
  assert.doesNotMatch(taskBoardStyles, /\.task-board-card::before/);
  assert.doesNotMatch(taskBoardStyles, /\.task-board-card\.is-[^{]+::before/);
  assert.match(taskBoardStyles, /\.task-board-chat-action\s*\{[\s\S]{0,240}border-color:\s*rgba\(148, 163, 184, 0\.3\);[\s\S]{0,240}background:\s*rgba\(248, 250, 252, 0\.92\);[\s\S]{0,240}color:\s*#64748b;/);
  assert.match(taskBoardStyles, /\.task-board-attachment-badge\s*\{[\s\S]{0,180}width:\s*28px;[\s\S]{0,180}height:\s*28px;[\s\S]{0,220}border:\s*1px solid rgba\(148, 163, 184, 0\.3\);[\s\S]{0,220}background:\s*rgba\(248, 250, 252, 0\.92\);[\s\S]{0,220}color:\s*#64748b;/);
  assert.match(taskBoardStyles, /\.task-board-attachment-badge:hover,[\s\S]{0,120}\.task-board-chat-action:hover:not\(:disabled\)\s*\{[\s\S]{0,180}background:\s*rgba\(15, 23, 42, 0\.05\);/);
  assert.match(taskBoardStyles, /\.task-board-card-foot-actions\s*\{[\s\S]{0,160}height:\s*28px;/);
  assert.match(taskBoardStyles, /\.task-board-chat-action\s*\{[\s\S]{0,180}width:\s*28px;[\s\S]{0,180}height:\s*28px;/);
  assert.match(taskBoardStyles, /\.task-board-attachment-badge \.task-board-icon\s*\{[\s\S]{0,120}width:\s*22px;[\s\S]{0,120}height:\s*22px;/);
  assert.match(taskBoardStyles, /\.task-board-chat-action \.task-board-icon\s*\{[\s\S]{0,120}width:\s*22px;[\s\S]{0,120}height:\s*22px;/);
});

test("task board todo column can filter scheduled tasks", () => {
  const taskBoardPage = readSourceFile("src", "renderer", "pages", "task-board", "TaskBoardPage.tsx");
  const taskBoardStyles = readSourceFile("src", "renderer", "styles", "task-board.css");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(taskBoardPage, /type TaskBoardTodoAutomationFilter = "all" \| "scheduled"/);
  assert.match(taskBoardPage, /const TASK_BOARD_TODO_AUTOMATION_FILTERS = \[/);
  assert.match(taskBoardPage, /function shouldShowIssueForTodoAutomationFilter\(\s*issue: Pick<TaskBoardIssue, "status" \| "automationEnabled" \| "automationCron">,\s*filter: TaskBoardTodoAutomationFilter/);
  assert.match(taskBoardPage, /issue\.status !== "todo" \|\| filter === "all"/);
  assert.match(taskBoardPage, /return hasIssueAutomation\(issue\)/);
  assert.match(taskBoardPage, /const \[todoAutomationFilter,\s*setTodoAutomationFilter\] = useState<TaskBoardTodoAutomationFilter>\("all"\)/);
  assert.match(taskBoardPage, /shouldShowIssueForTodoAutomationFilter\(issue, todoAutomationFilter\)/);
  assert.match(taskBoardPage, /className="task-board-column-filter"/);
  assert.match(taskBoardPage, /TASK_BOARD_TODO_AUTOMATION_FILTERS\.map/);
  assert.match(taskBoardPage, /aria-label=\{t\("taskBoard\.filter\.todoAutomation"\)\}/);
  assert.match(taskBoardPage, /todoAutomationFilter === option\.value \? "is-active" : ""/);
  assert.match(taskBoardStyles, /\.task-board-column-filter\s*\{[\s\S]{0,220}display:\s*grid;[\s\S]{0,220}grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(taskBoardStyles, /\.task-board-column-filter button\.is-active\s*\{[\s\S]{0,180}background:\s*var\(--task-board-accent\);/);
  assert.match(zhCN, /"taskBoard\.filter\.todoAutomation": "待办定时筛选"/);
  assert.match(zhCN, /"taskBoard\.filter\.scheduledOnly": "定时"/);
  assert.match(enUS, /"taskBoard\.filter\.todoAutomation": "Todo schedule filter"/);
  assert.match(enUS, /"taskBoard\.filter\.scheduledOnly": "Scheduled"/);
});

test("task board scheduled tasks wait for automation time before assistant run", () => {
  const taskBoardPage = readSourceFile("src", "renderer", "pages", "task-board", "TaskBoardPage.tsx");

  assert.match(taskBoardPage, /const shouldRunAfterSave = form\.status === "in_progress" && !form\.automationEnabled && !modal\?\.issue\?\.runId;/);
  assert.match(taskBoardPage, /const shouldRunTodoAssigneeAfterDelay = form\.status === "todo" && !form\.automationEnabled && Boolean\(form\.assigneeAgentKey\) && !modal\?\.issue\?\.runId;/);
  assert.doesNotMatch(taskBoardPage, /form\.status === "todo" && Boolean\(form\.assigneeAgentKey\) && !modal\?\.issue\?\.runId/);
});

test("task board scheduled todo cards show execution countdown instead of sort number", () => {
  const taskBoardPage = readSourceFile("src", "renderer", "pages", "task-board", "TaskBoardPage.tsx");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(taskBoardPage, /function getNextTaskBoardAutomationTime\(issue: Pick<TaskBoardIssue, "automationEnabled" \| "automationCron">, now: Date\)/);
  assert.match(taskBoardPage, /function formatTaskBoardAutomationCountdown\(issue: Pick<TaskBoardIssue, "automationEnabled" \| "automationCron">, now: Date, t: TranslateFunction\)/);
  assert.match(taskBoardPage, /const automationCountdown = hasIssueAutomation\(issue\)[\s\S]{0,160}formatTaskBoardAutomationCountdown\(issue, options\.now, t\) \|\| getAutomationDisplayLabel\(issue, t\)/);
  assert.match(taskBoardPage, /label: automationCountdown \|\| formatTaskBoardSortNumber\(options\.sortIndex, issue\.position\)/);
  assert.match(taskBoardPage, /const \[taskBoardCountdownNow,\s*setTaskBoardCountdownNow\] = useState\(\(\) => Date\.now\(\)\)/);
  assert.match(taskBoardPage, /TASK_BOARD_COUNTDOWN_REFRESH_MS/);
  assert.match(taskBoardPage, /now=\{new Date\(taskBoardCountdownNow\)\}/);
  assert.match(zhCN, /"taskBoard\.countdown\.minutes": "\{minutes\}分钟"/);
  assert.match(enUS, /"taskBoard\.countdown\.minutes": "\{minutes\}m"/);
});

test("task board route exposes native desktop api and page styles", () => {
  const contracts = readSharedContractsSource();
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const taskBoardHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "task-board-handlers.ts"), "utf8");
  const taskBoardSync = fs.readFileSync(path.join(projectRoot, "src", "main", "task-board-sync.ts"), "utf8");
  const taskBoardRuntime = fs.readFileSync(path.join(projectRoot, "src", "main", "task-board-runtime.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();
  const taskBoardStore = fs.readFileSync(path.join(projectRoot, "src", "main", "task-board-store.ts"), "utf8");
  const assistantNavigationStatusClient = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "core", "assistant-navigation-status-client.ts"),
    "utf8"
  );
  const taskBoardPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "task-board", "TaskBoardPage.tsx"),
    "utf8"
  );

  assert.match(contracts, /interface TaskBoardIssue/);
  assert.match(contracts, /taskBoard:\s*\{/);
  assert.match(contracts, /createIssue: \(input: TaskBoardIssueInput\) => Promise<TaskBoardIssueResult>/);
  assert.match(preload, /taskBoard:\s*\{/);
  assert.match(preload, /ipcRenderer\.invoke\("taskBoard\.listIssues"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("taskBoard\.moveIssue", input\)/);
  assert.match(preload, /ipcRenderer\.invoke\("taskBoard\.syncIssueAutomation", issueId\)/);
  assert.match(mainProcess, /registerTaskBoardIpcHandlers\(ipcMain,/);
  assert.match(taskBoardHandlers, /ipcMain\.handle\("taskBoard\.listIssues"/);
  assert.match(taskBoardHandlers, /ipcMain\.handle\("taskBoard\.moveIssue"/);
  assert.match(taskBoardHandlers, /ipcMain\.handle\("taskBoard\.syncIssueAutomation"/);
  assert.match(taskBoardSync, /syncTaskBoardIssueAutomation/);
  assert.match(taskBoardSync, /\/api\/admin\/automations\/create/);
  assert.match(taskBoardSync, /\/api\/admin\/automations\/update/);
  assert.match(taskBoardSync, /\/api\/admin\/automations\/delete/);
  assert.doesNotMatch(taskBoardSync, /\/api\/schedule(?:\/|-)(?:create|update|delete)/);
  assert.match(mainProcess, /createTaskBoardRuntime/);
  assert.match(mainProcess, /state\.taskBoardRuntime\?\.sendAssistantEvent\(event\)/);
  assert.match(taskBoardSync, /type === "done"[\s\S]{0,220}type === "run\.complete"[\s\S]{0,520}return "completed"/);
  assert.match(taskBoardSync, /typeValue === "run\.error"/);
  assert.match(taskBoardSync, /statusValue === "timeout"[\s\S]{0,220}return "failed"/);
  assert.match(taskBoardSync, /updateTaskBoardIssueByRunId\(app, event\.runId/);
  assert.match(taskBoardSync, /updateTaskBoardIssueByChatId/);
  assert.match(taskBoardSync, /updateTaskBoardIssueByChatId\(app,\s*event\.chatId/);
  assert.match(taskBoardRuntime, /function toCloudIssueInput/);
  assert.match(taskBoardRuntime, /"chatId"[\s\S]{0,80}"runId"[\s\S]{0,80}"runState"/);
  assert.match(mainProcess, /onPushEvent:\s*\(event\) => state\.taskBoardRuntime\?\.sendAssistantEvent\(event\)/);
  assert.match(taskBoardStore, /export function updateTaskBoardIssueByChatId/);
  assert.match(assistantNavigationStatusClient, /onPushEvent\?:/);
  assert.match(assistantNavigationStatusClient, /this\.options\.onPushEvent\?\./);
  assert.match(appShell, /import\("\.\.\/pages\/task-board\/TaskBoardPage"\)/);
  assert.match(taskBoardPage, /function readTaskBoardApi/);
  assert.match(taskBoardPage, /taskBoardApi\.listIssues\(\)/);
  assert.match(taskBoardPage, /taskBoardApi\.createIssue/);
  assert.match(taskBoardPage, /function canCreateIssueFromColumnDoubleClick\(status: TaskBoardStatus\)/);
  assert.match(taskBoardPage, /return status === "backlog" \|\| status === "todo";/);
  assert.match(taskBoardPage, /function shouldCreateIssueFromColumnDoubleClick/);
  assert.match(taskBoardPage, /target\.closest\("\.task-board-card"\)/);
  assert.match(taskBoardPage, /onDoubleClick=\{\(event\) => \{[\s\S]{0,220}shouldCreateIssueFromColumnDoubleClick\(event, status\)[\s\S]{0,120}onAdd\(\)/);
  assert.match(taskBoardPage, /TASK_BOARD_FEEDBACK_AUTO_CLOSE_MS = 3000/);
  assert.match(taskBoardPage, /if \(!feedback \|\| feedback\.tone !== "success"\) \{/);
  assert.match(taskBoardPage, /window\.setTimeout\(\(\) => \{[\s\S]{0,140}setFeedback\(\(current\) => \(current === feedback \? null : current\)\)/);
  assert.match(taskBoardPage, /window\.electronAPI\.assistant\.startRun/);
  assert.match(taskBoardPage, /const \{ t \} = useI18n\(\)/);
  assert.match(taskBoardPage, /t\("taskBoard\.prompt\.rule"\)/);
  assert.doesNotMatch(taskBoardPage, /不要直接修改任务看板文件或任务状态/);
  assert.match(taskBoardPage, /window\.electronAPI\.assistant\.onAssistantEvent/);
  assert.match(taskBoardPage, /window\.electronAPI\.assistant\.onNavigationAgentsChanged/);
  assert.match(taskBoardPage, /window\.electronAPI\.assistant\.listAgents\(\)/);
  assert.match(appShell, /<RouteSuspense><TaskBoardPage hostTheme=\{resolvedTheme\} \/><\/RouteSuspense>/);
  assert.doesNotMatch(appShell, /<TaskBoardPage onOpenAssistantChat=/);
  assert.match(appShell, /const isTaskBoardRoute = location\.pathname === "\/kanban"/);
  assert.match(appShell, /isTaskBoardRoute \? "has-task-board-controls" : ""/);
  assert.match(taskBoardPage, /type TaskBoardPageProps/);
  assert.match(taskBoardPage, /hostTheme:\s*ThemeMode/);
  assert.match(taskBoardPage, /import \{ PluginPage \} from "\.\.\/plugin\/PluginPage"/);
  assert.match(taskBoardPage, /const \[chatModalRequest,\s*setChatModalRequest\]/);
  assert.match(taskBoardPage, /function buildTaskBoardChatEmbedPath/);
  assert.match(taskBoardPage, /chatId\?:\s*string/);
  assert.match(taskBoardPage, /const agentKey = request\.agentKey\.trim\(\)/);
  assert.match(taskBoardPage, /const chatId = request\.chatId\?\.trim\(\) \?\? ""/);
  assert.match(taskBoardPage, /if \(!agentKey\) \{[\s\S]{0,160}return "\/copilot"/);
  assert.match(taskBoardPage, /if \(!chatId\) \{[\s\S]{0,100}return `\/agent\/\$\{encodeURIComponent\(agentKey\)\}`/);
  assert.match(taskBoardPage, /params\.set\("chatId", chatId\)/);
  assert.match(taskBoardPage, /return `\/agent\/\$\{encodeURIComponent\(agentKey\)\}\?\$\{params\.toString\(\)\}`/);
  assert.match(taskBoardPage, /function getIssueChatActionLabel/);
  assert.match(taskBoardPage, /function issueHasPendingAwaiting/);
  assert.match(taskBoardPage, /const matchingChat = getAssistantNavAgentRecentChats\(agent\)\.find\(\(chat\) => chat\.chatId === chatId\)/);
  assert.match(taskBoardPage, /return matchingChat\?\.hasPendingAwaiting === true/);
  assert.doesNotMatch(taskBoardPage, /agent\.latestChatId === chatId && agent\.hasPendingAwaiting/);
  assert.match(taskBoardPage, /t\("taskBoard\.chat\.viewOrConfirm"\)/);
  assert.match(taskBoardPage, /t\("taskBoard\.chat\.view"\)/);
  assert.match(taskBoardPage, /t\("taskBoard\.chat\.awaitingConfirmation"\)/);
  assert.match(taskBoardPage, /const visibleChatActionLabel = awaitingConfirmation \? t\("taskBoard\.chat\.awaitingConfirmation"\) : chatActionLabel/);
  assert.doesNotMatch(taskBoardPage, /task-board-human-loop-hint/);
  assert.match(taskBoardPage, /is-awaiting-confirmation/);
  assert.match(taskBoardPage, /function openAssistantIssueChat/);
  assert.match(taskBoardPage, /setChatModalRequest\(\{[\s\S]{0,180}agentKey[\s\S]{0,180}chatId/);
  assert.match(taskBoardPage, /<PluginPage[\s\S]{0,260}pluginId="agent-webclient"[\s\S]{0,260}embedPath=\{buildTaskBoardChatEmbedPath\(chatModalRequest\)\}/);
  assert.match(taskBoardPage, /task-board-chat-modal-layer/);
  assert.match(taskBoardPage, /task-board-chat-modal/);
  assert.doesNotMatch(taskBoardPage, /void openAssistantIssueChat\(updateResult\.issue/);
  assert.match(taskBoardPage, /task-board-chat-action/);
  assert.doesNotMatch(taskBoardPage, /setAgentPickerIssue/);
  assert.doesNotMatch(taskBoardPage, /requestAssignIssueToAssistant/);
  assert.match(taskBoardPage, /<DragOverlay[\s\S]*?dropAnimation=\{null\}/);
  assert.match(taskBoardPage, /taskBoardApi\.updateIssue\(issue\.id,[\s\S]*?status:\s*"in_progress"/);
  assert.match(taskBoardPage, /function openInProgressAssignmentModal\(issue: TaskBoardIssue\)/);
  assert.match(taskBoardPage, /setForm\(\{[\s\S]{0,160}\.\.\.createFormFromIssue\(issue\),[\s\S]{0,120}status:\s*"in_progress"/);
  assert.match(taskBoardPage, /targetStatus === "in_progress" && activeIssue\.status !== "in_progress"/);
  assert.match(taskBoardPage, /activeIssue\.assigneeAgentKey\?\.trim\(\)[\s\S]{0,180}assignIssueToAssistant\(activeIssue, activeIssue\.assigneeAgentKey\)/);
  assert.match(taskBoardPage, /openInProgressAssignmentModal\(activeIssue\)/);
  assert.match(taskBoardPage, /targetStatus === "todo" && activeIssue\.status !== "todo"[\s\S]{0,220}activeIssue\.assigneeAgentKey\?\.trim\(\)/);
  assert.match(taskBoardPage, /window\.setTimeout\(\(\) => \{[\s\S]{0,180}assignIssueToAssistant\(savedIssue, todoAssigneeAgentKey\)/);
  assert.match(taskBoardPage, /form\.status === "in_progress" && !form\.automationEnabled && !modal\?\.issue\?\.runId/);
  assert.match(taskBoardPage, /shouldRunAfterSave && !form\.assigneeAgentKey/);
  assert.match(taskBoardPage, /t\("taskBoard\.feedback\.assigneeRequiredForProgress"\)/);
  assert.match(taskBoardPage, /function mergeTaskBoardIssueAttachmentDraft/);
  assert.match(taskBoardPage, /mergeTaskBoardIssueAttachmentDraft\(\s*result\.issue[\s\S]{0,160}form\.attachmentChatId[\s\S]{0,160}form\.attachments/);
  assert.match(taskBoardPage, /mergeTaskBoardIssuesAttachmentDraft\(\s*result\.issues[\s\S]{0,160}savedIssue/);
  assert.match(taskBoardPage, /assignIssueToAssistant\(savedIssue, form\.assigneeAgentKey\)/);
  assert.match(taskBoardPage, /const \[formCompact,\s*setFormCompact\] = useState\(true\)/);
  assert.match(taskBoardPage, /setFormCompact\(true\)/);
  assert.match(taskBoardPage, /function buildCompactTaskTitle/);
  assert.match(taskBoardPage, /formCompact && modal\?\.mode === "create"/);
  assert.match(taskBoardPage, /t\("taskBoard\.feedback\.descriptionRequired"\)/);
  assert.match(taskBoardPage, /formCompact \? t\("taskBoard\.modal\.advancedMode"\) : t\("taskBoard\.modal\.compactMode"\)/);
  assert.match(taskBoardPage, /!formCompact \? \(/);
  assert.match(taskBoardPage, /automationEnabled/);
  assert.match(taskBoardPage, /TASK_BOARD_AUTOMATION_PLANS/);
  assert.match(taskBoardPage, /TASK_BOARD_AUTOMATION_TIME_OPTIONS/);
  assert.match(taskBoardPage, /automationTime/);
  assert.match(taskBoardPage, /function hasIssueAutomation\(issue: Pick<TaskBoardIssue, "automationEnabled" \| "automationCron">\)/);
  assert.match(taskBoardPage, /function openEditModal\(issue: TaskBoardIssue\)[\s\S]{0,220}setFormCompact\(!hasIssueAutomation\(issue\)\);/);
  assert.match(taskBoardPage, /function buildAutomationCron/);
  assert.match(taskBoardPage, /const \[automationMenuOpen,\s*setAutomationMenuOpen\] = useState<AutomationMenuKind \| null>\(null\)/);
  assert.match(taskBoardPage, /selectedAutomationTimeRef\.current\?\.scrollIntoView/);
  assert.match(taskBoardPage, /className="task-board-automation-menu-trigger"/);
  assert.match(taskBoardPage, /task-board-automation-menu-list is-time-list/);
  assert.doesNotMatch(taskBoardPage, /className="task-board-automation-time-select"/);
  assert.match(taskBoardPage, /minute < 60; minute \+= 15/);
  assert.match(taskBoardPage, /labelKey: "taskBoard\.automation\.daily"/);
  assert.match(taskBoardPage, /labelKey: "taskBoard\.automation\.weekdays"/);
  assert.match(taskBoardPage, /labelKey: "taskBoard\.automation\.weekly"/);
  assert.match(taskBoardPage, /taskBoardApi\.syncIssueAutomation/);
  assert.match(taskBoardPage, /task-board-automation-badge/);
  assert.match(taskBoardPage, /resolveAssistantTaskStatus/);
  assert.match(taskBoardPage, /status:\s*"completed"[\s\S]*?runId:\s*null/);
  assert.match(taskBoardPage, /runState:\s*"failed"[\s\S]*?t\("taskBoard\.feedback\.agentIncomplete"\)/);
  assert.doesNotMatch(taskBoardPage, /附件：\$\{/);
  assert.match(taskBoardPage, /task-board-attachment-badge/);
  assert.doesNotMatch(taskBoardPage, /<header className="task-board-breadcrumb">\s*<strong>Issues<\/strong>\s*<\/header>/);
  assert.doesNotMatch(taskBoardPage, /task-board-workspace-mark/);
  assert.doesNotMatch(taskBoardPage, /task-board-breadcrumb-separator/);
  assert.match(taskBoardPage, /function isIssueDragLocked\(issue: TaskBoardIssue \| null \| undefined\)/);
  assert.match(taskBoardPage, /return Boolean\(issue\?\.runId\);/);
  assert.match(taskBoardPage, /useSortable\(\{\s*id:\s*issue\.id,[\s\S]*?disabled:\s*dragLocked/);
  assert.match(taskBoardPage, /is-drag-locked/);
  assert.match(taskBoardPage, /data-drag-locked=\{dragLocked \? "true" : undefined\}/);
  assert.match(taskBoardPage, /\{\.\.\.sortable\.attributes\}\s*aria-disabled=\{undefined\}/);
  assert.doesNotMatch(taskBoardPage, /aria-disabled=\{dragLocked\}/);
  assert.match(taskBoardPage, /function getVisibleAssigneeName\(issue: TaskBoardIssue, agents: AssistantNavAgentItem\[\]\)/);
  assert.match(taskBoardPage, /function truncateTaskBoardAssigneeName\(name: string\)[\s\S]{0,120}Array\.from\(name\.trim\(\)\)\.slice\(0, 4\)\.join\(""\)/);
  assert.match(taskBoardPage, /const visibleAssigneeName = getVisibleAssigneeName\(issue, agents\)/);
  assert.match(taskBoardPage, /return truncateTaskBoardAssigneeName\(visibleAssigneeName\);/);
  assert.match(taskBoardPage, /function getAssigneeAgent\(issue: TaskBoardIssue, agents: AssistantNavAgentItem\[\]\)/);
  assert.match(taskBoardPage, /function mergeTaskBoardAgentIcons\(currentAgents: AssistantNavAgentItem\[\], nextAgents: AssistantNavAgentItem\[\]\)/);
  assert.match(taskBoardPage, /function createNavigationAgentFromOption\(agent: DesktopPetAgentOption\): AssistantNavAgentItem[\s\S]{0,260}icon: agent\.icon/);
  assert.match(taskBoardPage, /async function hydrateTaskBoardAgentIcons\(items: AssistantNavAgentItem\[\]\)/);
  assert.match(taskBoardPage, /function hasTaskBoardAgentIcon\(icon: AssistantNavAgentItem\["icon"\] \| null \| undefined\)/);
  assert.match(taskBoardPage, /icon\.name\?\.trim\(\) \|\| icon\.color\?\.trim\(\)/);
  assert.match(taskBoardPage, /items\.some\(\(agent\) => !hasTaskBoardAgentIcon\(agent\.icon\)\)/);
  assert.match(taskBoardPage, /const fallbackItems = agentOptions\.map\(createNavigationAgentFromOption\)/);
  assert.match(taskBoardPage, /return mergeTaskBoardAgentIcons\(fallbackItems, items\)/);
  assert.match(taskBoardPage, /const navigationItems = normalizeAssistantNavAgents\(navigationResult\.items\)/);
  assert.match(taskBoardPage, /return await hydrateTaskBoardAgentIcons\(navigationItems\)/);
  assert.match(taskBoardPage, /const previousIcons = new Map/);
  assert.match(taskBoardPage, /previousIcon \? \{ \.\.\.agent, icon: previousIcon \} : agent/);
  assert.match(taskBoardPage, /setAgents\(\(currentAgents\) => mergeTaskBoardAgentIcons\(currentAgents, normalizeAssistantNavAgents\(result\.items\)\)\)/);
  assert.match(taskBoardPage, /setAgents\(\(currentAgents\) => mergeTaskBoardAgentIcons\(currentAgents, items\)\)/);
  assert.match(taskBoardPage, /const assigneeAgent = getAssigneeAgent\(issue, agents\)/);
  assert.match(taskBoardPage, /const assigneeIcon = hasTaskBoardAgentIcon\(assigneeAgent\?\.icon\) \? assigneeAgent\?\.icon : undefined/);
  assert.match(taskBoardPage, /function getIssueCardAssigneeAvatarLabel\(name: string\)/);
  assert.doesNotMatch(taskBoardPage, /function TaskBoardAssigneeIcon/);
  assert.match(taskBoardPage, /className=\{`task-board-card-assignee-avatar\$\{assigneeIcon \? " has-icon" : ""\}`\}/);
  assert.match(taskBoardPage, /assigneeIcon \? \([\s\S]{0,180}<AgentIcon[\s\S]{0,180}icon=\{assigneeIcon\}[\s\S]{0,180}className="task-board-card-assignee-icon"[\s\S]{0,180}size=\{18\}/);
  assert.match(taskBoardPage, /\) : \([\s\S]{0,120}className="task-board-card-assignee-avatar-label"[\s\S]{0,120}getIssueCardAssigneeAvatarLabel\(visibleAssigneeName\)/);
  assert.doesNotMatch(taskBoardPage, /task-board-card-assignee-avatar-label[\s\S]{0,220}assigneeIcon \? \(/);
  assert.match(taskBoardPage, /className="task-board-card-assignee-avatar-label"/);
  assert.match(taskBoardPage, /getIssueCardAssigneeAvatarLabel\(visibleAssigneeName\)/);
  assert.doesNotMatch(taskBoardPage, /task-board-card-assignee-icon-frame/);
  assert.doesNotMatch(taskBoardPage, /<span className="task-board-card-assignee-icon" aria-hidden="true" \/>/);
  assert.doesNotMatch(globalStyles, /\.task-board-card-assignee-icon-frame\s*\{/);
  assert.match(globalStyles, /\.task-board-card-assignee-icon\s*\{[\s\S]{0,180}width:\s*18px;[\s\S]{0,180}height:\s*18px;/);
  assert.doesNotMatch(globalStyles, /\.task-board-card-assignee-icon::before/);
  assert.doesNotMatch(globalStyles, /\.task-board-card-assignee-icon::after/);
  assert.doesNotMatch(globalStyles, /#fde047 0%, #facc15 48%, #d69e13/);
  assert.match(globalStyles, /\.task-board-card-assignee-avatar\s*\{/);
  assert.match(globalStyles, /\.task-board-card-assignee-avatar-label\s*\{/);
  assert.doesNotMatch(globalStyles, /\.task-board-card-assignee-avatar\.has-icon \.task-board-card-assignee-avatar-label/);
  assert.doesNotMatch(taskBoardPage, /issue\.assigneeName\.slice\(0, 1\)/);
  assert.doesNotMatch(taskBoardPage, /task-board-run-badge/);
  assert.match(taskBoardPage, /<footer className="task-board-card-foot">/);
  assert.match(taskBoardPage, /className="task-board-column-summary"/);
  assert.match(taskBoardPage, /className="task-board-empty-illustration"/);
  assert.doesNotMatch(taskBoardPage, /className="task-board-card-action"/);
  assert.doesNotMatch(taskBoardPage, />\s*\{busy \? "提交中" : "交给智能体"\}\s*<\/button>/);
  assert.doesNotMatch(taskBoardPage, /busy \? "提交中" : issue\.runId \? "运行中" : "交给智能体"/);
  assert.doesNotMatch(taskBoardPage, /aria-label=\{`\$\{meta\.label\} 更多`\}/);
  assert.match(globalStyles, /\.task-board-page\s*\{/);
  assert.match(globalStyles, /\.task-board-toolbar,[\s\S]{0,120}\.task-board-toolbar input\s*\{[\s\S]{0,220}-webkit-app-region:\s*no-drag;/);
  assert.match(globalStyles, /\.task-board-toolbar,[\s\S]{0,120}\.task-board-toolbar input\s*\{[\s\S]{0,260}pointer-events:\s*auto;/);
  assert.match(globalStyles, /--task-board-column-fit-width:\s*calc\(\(100% - 48px\) \/ 4\);/);
  assert.match(globalStyles, /--task-board-column-width:\s*max\(\s*calc\(\(100% - 64px\) \/ 5\),\s*min\(var\(--task-board-column-min-width\), var\(--task-board-column-fit-width\)\)\s*\);/);
  assert.match(globalStyles, /--task-board-columns-total-width:\s*calc\(\s*var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+\s*var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\)\s*\);/);
  assert.match(globalStyles, /--task-board-column-fold-offset:\s*max\(0px,\s*calc\(var\(--task-board-columns-total-width\) - 100%\)\);/);
  assert.match(globalStyles, /\.task-board-columns\s*\{[\s\S]{0,220}overflow-x:\s*hidden;/);
  assert.match(globalStyles, /\.task-board-column\s*\{/);
  assert.match(globalStyles, /\.task-board-column\.is-todo\s*\{[\s\S]{0,260}margin-left:\s*calc\(var\(--task-board-column-fold-offset\) \* -1\);/);
  assert.doesNotMatch(globalStyles, /\.task-board-column\.is-in_progress\s*\{[^}]*margin-left:/);
  assert.doesNotMatch(globalStyles, /\.task-board-column\.is-in_review\s*\{[^}]*margin-left:/);
  assert.doesNotMatch(globalStyles, /\.task-board-column\.is-completed\s*\{[^}]*margin-left:/);
  assert.match(taskBoardPage, /const \[backlogExpanded,\s*setBacklogExpanded\] = useState\(false\)/);
  assert.match(taskBoardPage, /className=\{`task-board-columns \$\{backlogExpanded \? "is-backlog-expanded" : ""\}`\}/);
  assert.match(taskBoardPage, /onClick=\{\(\) => setBacklogExpanded\(false\)\}/);
  assert.match(taskBoardPage, /onSelectColumn=\{\(\) => setBacklogExpanded\(status === "backlog"\)\}/);
  assert.match(globalStyles, /\.task-board-columns\.is-backlog-expanded \.task-board-column\.is-todo\s*\{[\s\S]{0,120}margin-left:\s*0;/);
  assert.match(globalStyles, /\.task-board-card\s*\{/);
  assert.match(globalStyles, /\.task-board-card\s*\{[\s\S]{0,180}position:\s*relative;/);
  assert.doesNotMatch(globalStyles, /\.task-board-card::before/);
  assert.match(globalStyles, /\.task-board-column-summary\s*\{/);
  assert.match(globalStyles, /\.task-board-column-summary\s*\{[\s\S]{0,220}flex-direction:\s*row;[\s\S]{0,220}align-items:\s*center;/);
  assert.match(globalStyles, /\.task-board-column-summary-text\s*\{/);
  assert.match(globalStyles, /\.task-board-empty-illustration\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.task-board-page\s*\{[\s\S]{0,260}--task-board-bg:\s*#111418;[\s\S]{0,260}background:/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.task-board-column\.is-backlog\s*\{[\s\S]{0,180}--task-board-column-tint:\s*#121c2d;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.task-board-empty-column\s*\{[\s\S]{0,220}background:\s*color-mix\(in srgb, var\(--task-board-column-tint\) 34%, rgba\(15, 18, 24, 0\.84\)\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.task-board-column-summary\s*\{[\s\S]{0,120}color:\s*#e2e8f0;/);
  assert.match(globalStyles, /\.task-board-card\.is-drag-locked\s*\{/);
  assert.match(globalStyles, /\.task-board-card\.is-drag-locked \.task-board-card-main\s*\{[\s\S]{0,120}padding-right:/);
  assert.match(globalStyles, /\.task-board-card\.is-awaiting-confirmation\s*\{/);
  assert.match(globalStyles, /\.task-board-card-status\s*\{[\s\S]{0,220}height:\s*20px;[\s\S]{0,220}overflow:\s*hidden;/);
  assert.match(globalStyles, /\.task-board-run-dot\s*\{[\s\S]{0,160}background:\s*currentColor;/);
  assert.match(globalStyles, /\.task-board-chat-action\s*\{/);
  assert.match(globalStyles, /\.task-board-chat-action\.is-awaiting\s*\{/);
  assert.match(globalStyles, /\.task-board-automation-panel\s*\{/);
  assert.match(globalStyles, /\.task-board-automation-badge\s*\{/);
  assert.match(globalStyles, /\.task-board-chat-action\.is-human-loop\s*\{[\s\S]{0,220}background:\s*rgba\(245, 158, 11, 0\.14\);[\s\S]{0,220}box-shadow:\s*none;/);
  assert.match(globalStyles, /\.task-board-modal-head-actions/);
  assert.match(globalStyles, /\.task-board-modal-mode-button[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(globalStyles, /\.task-board-modal\.is-compact/);
  assert.match(globalStyles, /\.task-board-automation-popover/);
  assert.match(globalStyles, /\.task-board-automation-menu-trigger/);
  assert.match(globalStyles, /\.task-board-automation-menu-list\s*\{[\s\S]*?top:\s*calc\(100% \+ 4px\);[\s\S]*?max-height:\s*164px;/);
  assert.match(globalStyles, /\.task-board-automation-menu-list\.is-time-list\s*\{[\s\S]*?max-height:\s*184px;/);
  assert.doesNotMatch(globalStyles, /\.task-board-automation-time-select/);
  assert.match(globalStyles, /\.app-shell\.has-task-board-controls\s+\.app-window-drag-region,\s*\.app-shell\.has-task-board-controls\s+\.app-main-drag-region\s*\{[\s\S]*?display:\s*none;/);
  assert.match(globalStyles, /\.task-board-modal-actions \.task-board-secondary-button/);
  assert.doesNotMatch(globalStyles, /\.task-board-human-loop-hint\s*\{/);
  assert.doesNotMatch(globalStyles, /\.task-board-card-action\s*\{/);
  assert.doesNotMatch(globalStyles, /\.task-board-agent-picker\s*\{/);
  assert.match(globalStyles, /\.task-board-chat-modal-layer\s*\{/);
  assert.match(globalStyles, /\.task-board-chat-modal\s*\{/);
  assert.match(globalStyles, /\.task-board-chat-modal \.pan-page\s*\{/);
});

test("task board status order places completed after in progress", () => {
  const contracts = readSourceFile("src", "shared", "contracts", "task-board.ts");
  const taskBoardDb = readSourceFile("src", "main", "task-board-db.ts");

  assert.match(
    contracts,
    /TASK_BOARD_STATUSES\s*=\s*\[[\s\S]*?"backlog",[\s\S]*?"todo",[\s\S]*?"in_progress",[\s\S]*?"in_review",[\s\S]*?"completed"[\s\S]*?\]/,
  );
  assert.match(
    taskBoardDb,
    /WHEN 'in_progress' THEN 2[\s\S]*?WHEN 'in_review' THEN 3[\s\S]*?WHEN 'completed' THEN 4/,
  );
});

test("website agent association is exposed across webs desktop api layers", () => {
  const contracts = readSharedContractsSource();
  const store = fs.readFileSync(path.join(projectRoot, "src", "main", "webs", "website-actions.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const webHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "web-handlers.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const appShell = readAppShellSource();
  const appSidebar = fs.readFileSync(path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"), "utf8");

  assert.match(contracts, /agentKey\?: string/);
  assert.match(contracts, /interface WebsiteUpdateInput/);
  assert.match(contracts, /update: \(id: string, input: WebsiteUpdateInput\) => Promise<WebsiteResult>/);
  assert.match(contracts, /add: \(input: WebsiteInput\) => Promise<WebsiteResult>/);
  assert.match(store, /export function updateWebsiteItem/);
  assert.match(store, /delete updated\.agentKey/);
  assert.match(store, /export function addWebsiteItem/);
  assert.match(mainProcess, /registerWebIpcHandlers\(ipcMain,/);
  assert.match(webHandlers, /ipcMain\.handle\("webs\.websites\.update"/);
  assert.match(preload, /update: \(id, input\) => ipcRenderer\.invoke\("webs\.websites\.update", id, input\)/);
  assert.match(preload, /add: \(input\) => ipcRenderer\.invoke\("webs\.websites\.add", input\)/);
  assert.match(appShell, /resolvedCopilotAgentKey/);
  assert.match(appShell, /function createWebsiteItem\(input: WebsiteInput\): Promise<WebsiteResult>[\s\S]*?window\.electronAPI\.webs\.websites\.add\(input\)/);
  assert.match(appShell, /onCreateWebsiteItem=\{createWebsiteItem\}/);
  assert.match(appSidebar, /args\.groupId === "webs"/);
  assert.match(appSidebar, /className="assistant-worker-icon-button sidebar-website-add-button"/);
  assert.match(appSidebar, /function renderWebsiteDialog\(\)/);
  assert.match(appSidebar, /网站名[\s\S]*?网页地址[\s\S]*?侧边智能助手/);
  assert.match(appSidebar, /onCreateWebsiteItem\(\{[\s\S]*?label: websiteLabel,[\s\S]*?url: websiteUrl,[\s\S]*?agentKey: websiteAgentKey[\s\S]*?\}\)/);
  assert.match(appSidebar, /requestNavigate\(`\/webs\/\$\{result\.item\.entryKey\}`\)/);
});

test("webapps expose desktop api and start from webs sidebar route", () => {
  const contracts = readSharedContractsSource();
  const webContracts = readSourceFile("src", "shared", "contracts", "webs.ts");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const webHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "web-handlers.ts"), "utf8");
  const desktopActions = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-actions.ts"), "utf8");
  const desktopActionBridge = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");
  const appShell = readAppShellSource();
  const webappStartEffectStart = appShell.indexOf(
    "const item = webItems.find((candidate) => candidate.entryKey === activeWebEntryKey);"
  );
  const webappStartEffect = appShell.slice(
    webappStartEffectStart,
    appShell.indexOf(
      "}, [activeWebEntryKey, webItems, webappRuntimeById]",
      webappStartEffectStart
    )
  );
  const embeddedSurfaceHosts = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "embedded-surfaces", "EmbeddedSurfaceHosts.tsx"),
    "utf8"
  );
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx"),
    "utf8"
  );

  assert.match(webContracts, /export interface WebappEntry/);
  assert.match(contracts, /webs:\s*\{[\s\S]*list: \(\) => Promise<WebListResult>/);
  assert.match(contracts, /webapps:\s*\{[\s\S]*start: \(id: string\) => Promise<WebappCommandResult>/);
  assert.match(preload, /webs:\s*\{[\s\S]*list: \(\) => ipcRenderer\.invoke\("webs\.list"\)/);
  assert.match(preload, /start: \(id: string\) => ipcRenderer\.invoke\("webs\.webapps\.start", id\)/);
  assert.match(webHandlers, /ipcMain\.handle\("webs\.webapps\.start"[\s\S]*webappRuntime\.start\(app, id\)/);
  assert.match(appShell, /window\.electronAPI\.webs\.list\(\)/);
  assert.match(appShell, /item\.kind !== "webapp"/);
  assert.match(appShell, /chrome:\s*"app"/);
  assert.notEqual(webappStartEffectStart, -1);
  assert.match(appShell, /webappStartInFlightRef = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(webappStartEffect, /webappStartInFlightRef\.current\.has\(item\.id\)/);
  assert.match(webappStartEffect, /webappStartInFlightRef\.current\.add\(item\.id\)/);
  assert.match(webappStartEffect, /window\.electronAPI\.webs\.webapps\.start\(item\.id\)/);
  assert.match(webappStartEffect, /\.finally\(\(\) => \{[\s\S]*?webappStartInFlightRef\.current\.delete\(item\.id\)/);
  assert.doesNotMatch(webappStartEffect, /let cancelled = false/);
  assert.match(externalWebviewPage, /chrome\?: "browser" \| "app"/);
  assert.match(externalWebviewPage, /chrome = "browser"/);
  assert.match(externalWebviewPage, /const appChrome = chrome === "app"/);
  assert.match(externalWebviewPage, /\{appChrome \? null : \([\s\S]*?external-webview-browser-chrome/);
  assert.match(externalWebviewPage, /appChrome \? null : debugSidebarNode/);
  assert.doesNotMatch(externalWebviewPage, /bookmarkMenuNode/);
  assert.match(externalWebviewPage, /onWebviewOpenTab[\s\S]*?if \(appChrome\) \{[\s\S]*?return;[\s\S]*?\}/);
  assert.match(embeddedSurfaceHosts, /runtimeStatus/);
  assert.match(embeddedSurfaceHosts, /chrome=\{item\.chrome\}/);
  assert.match(embeddedSurfaceHosts, /正在启动/);
  assert.match(mainProcess, /installBundledWebappTemplates\(app\)/);
  const initializeUserDataIndex = mainProcess.indexOf("function initializeUserDataRootsAndSettings()");
  const initializeUserDataEndIndex = mainProcess.indexOf("const desktopPetPreviewProjector", initializeUserDataIndex);
  const initializeUserDataBlock = mainProcess.slice(initializeUserDataIndex, initializeUserDataEndIndex);
  const ensureDataRootIndex = mainProcess.indexOf("ensureDataRoot(app);", initializeUserDataIndex);
  const installDemoIndex = mainProcess.indexOf("installBundledWebappTemplates(app)", initializeUserDataIndex);
  const applyDesktopInitIndex = mainProcess.indexOf("applyDesktopInitBootstrap(app", initializeUserDataIndex);
  const initializeMainI18nIndex = mainProcess.indexOf("initializeMainI18n(app", initializeUserDataIndex);
  const prepareStartupRuntimeIndex = mainProcess.indexOf("await prepareStartupRuntimeEnvironment()");
  const initializeUserDataCallIndex = mainProcess.indexOf("initializeUserDataRootsAndSettings();", prepareStartupRuntimeIndex);
  const createWindowCallIndex = mainProcess.indexOf("createWindow();", initializeUserDataCallIndex);
  assert.notEqual(initializeUserDataIndex, -1);
  assert.notEqual(initializeUserDataEndIndex, -1);
  assert.notEqual(ensureDataRootIndex, -1);
  assert.notEqual(installDemoIndex, -1);
  assert.notEqual(applyDesktopInitIndex, -1);
  assert.notEqual(initializeMainI18nIndex, -1);
  assert.notEqual(prepareStartupRuntimeIndex, -1);
  assert.notEqual(initializeUserDataCallIndex, -1);
  assert.notEqual(createWindowCallIndex, -1);
  assert.equal(ensureDataRootIndex < applyDesktopInitIndex, true);
  assert.equal(applyDesktopInitIndex < installDemoIndex, true);
  assert.equal(applyDesktopInitIndex < initializeMainI18nIndex, true);
  assert.equal(prepareStartupRuntimeIndex < initializeUserDataCallIndex, true);
  assert.equal(initializeUserDataCallIndex < createWindowCallIndex, true);
  assert.doesNotMatch(initializeUserDataBlock, /importBundledEnvZipToRuntime/);
  assert.doesNotMatch(initializeUserDataBlock, /applyDesktopInitSsoDefaults/);
  assert.match(mainProcess, /const DEFAULT_ENV_IMPORT_REQUIRED_MESSAGE = "首次安装需要导入 env\.zip";/);
  assert.match(mainProcess, /let startupEnvImportFailureMessage: string \| null = null;/);
  assert.match(mainProcess, /if \(startupEnvImportFailureMessage !== null\)/);
  assert.doesNotMatch(mainProcess, /if \(startupEnvImportFailureMessage\)/);
  assert.match(mainProcess, /message: DEFAULT_ENV_IMPORT_REQUIRED_MESSAGE/);
  assert.match(mainProcess, /stopAllWebapps\(app\)/);
  assert.match(desktopActions, /"desktop\.webs\.webapps\.start"/);
  assert.match(desktopActionBridge, /case "desktop\.webs\.webapps\.restart"/);
  assert.match(desktopActionBridge, /readWebappId\(args\)/);
});

test("assistant navigation agents are exposed through dedicated ipc without changing pet agents", () => {
  const contracts = readSharedContractsSource();
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const assistantHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "assistant-handlers.ts"), "utf8");
  const desktopActions = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-actions.ts"), "utf8");
  const desktopActionBridge = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(projectRoot, "src", "main", "copilot", "core", "agent-platform-bridge.ts"), "utf8");
  const assistantNavigationStatusClient = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "core", "assistant-navigation-status-client.ts"),
    "utf8"
  );
  const appShell = readAppShellSource();
  const appSidebar = fs.readFileSync(path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"), "utf8");
  const globalStyles = readRendererStyles();

  assert.match(contracts, /interface AssistantNavAgentItem/);
  assert.match(contracts, /icon\?: AssistantNavAgentIcon/);
  assert.match(contracts, /recentChats: AssistantNavChatItem\[\]/);
  assert.match(contracts, /hasActiveRun:\s*boolean/);
  assert.match(contracts, /hasPendingAwaiting:\s*boolean/);
  assert.match(contracts, /awaitingMode\?: AssistantAwaitingMode/);
  assert.match(contracts, /export type AssistantAwaitingMode = "approval" \| "question" \| "form" \| "plan"/);
  assert.match(contracts, /"awaiting\.asking"/);
  assert.match(contracts, /"awaiting\.answered"/);
  assert.doesNotMatch(assistantNavigationStatusClient, /awaiting\.ask"/);
  assert.doesNotMatch(assistantNavigationStatusClient, /awaiting\.answer"/);
  assert.doesNotMatch(bridge, /awaiting\.ask"/);
  assert.doesNotMatch(bridge, /awaiting\.answer"/);
  assert.match(contracts, /agentType\?: string/);
  assert.match(contracts, /workspaceDirExists\?: boolean/);
  assert.match(contracts, /interface AssistantNavAgentItemsResult/);
  assert.match(contracts, /interface AssistantCreateCoderProjectRequest/);
  assert.match(contracts, /interface AssistantCreateCoderProjectResult/);
  assert.match(contracts, /AssistantNavigationAgentsChangedListener/);
  assert.match(contracts, /listAgents: \(\) => Promise<DesktopPetAgentOption\[\]>/);
  assert.match(contracts, /listNavigationAgents: \(\) => Promise<AssistantNavAgentItemsResult>/);
  assert.match(contracts, /createCoderProject:\s*\(input: AssistantCreateCoderProjectRequest\) => Promise<AssistantCreateCoderProjectResult>/);
  assert.match(contracts, /markAgentChatsRead: \(agentKey: string\) => Promise<AssistantNavActionResult>/);
  assert.match(preload, /listAgents: \(\) => ipcRenderer\.invoke\("assistant\.listAgents"\)/);
  assert.match(preload, /listNavigationAgents: \(\) => ipcRenderer\.invoke\("assistant\.listNavigationAgents"\)/);
  assert.match(preload, /listCopilotAgents: \(\) => ipcRenderer\.invoke\("assistant\.listCopilotAgents"\)/);
  assert.match(preload, /createCoderProject:\s*\(input: AssistantCreateCoderProjectRequest\) =>[\s\S]{0,120}ipcRenderer\.invoke\("assistant\.createCoderProject", input\)/);
  assert.match(preload, /onNavigationAgentsChanged/);
  assert.match(mainProcess, /registerAssistantIpcHandlers\(ipcMain,/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.listAgents"/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.listNavigationAgents"/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.listCopilotAgents"/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.createCoderProject"/);
  assert.match(assistantHandlers, /callAgentPlatform\?\.?\(app, "\/api\/admin\/agents\/create"/);
  assert.match(assistantHandlers, /assistantNavigationStatusClient\?\.scheduleRefresh\(0\)/);
  assert.match(mainProcess, /AssistantNavigationStatusClient/);
  assert.match(mainProcess, /assistant\.navigationAgentsChanged/);
  assert.match(assistantHandlers, /ok:\s*false,[\s\S]*?items:\s*\[\]/);
  assert.match(bridge, /async listAgents\(\): Promise<DesktopPetAgentOption\[\]>/);
  assert.match(bridge, /async listNavigationAgents\(\): Promise<AssistantNavAgentItemsResult>/);
  assert.match(bridge, /async listCopilotAgents\(\): Promise<AssistantNavAgentItemsResult>/);
  assert.match(bridge, /readAssistantNavigationAgentsFromPlatform/);
  assert.match(bridge, /readAssistantCopilotAgentsFromPlatform/);
  assert.match(bridge, /chatHasPendingAwaiting/);
  assert.match(bridge, /createNavigationAgentItem/);
  assert.match(appShell, /onNavigationAgentsChanged/);
  assert.match(appShell, /setAssistantNavAgents\(nextItems\)/);
  assert.match(appShell, /onRefreshAssistantNavAgents=\{refreshAssistantNavAgents\}/);
  assert.match(appSidebar, /handleCreateCoderProject/);
  assert.match(appSidebar, /window\.electronAPI\.desktopDialog\.selectDirectory\(\)[\s\S]*?window\.electronAPI\.assistant\.createCoderProject/);
  assert.match(appSidebar, /window\.electronAPI\.services\.list\(\)/);
  assert.match(appSidebar, /proxy-acp-claudecode[\s\S]*?acpProxyId:\s*"claude"/);
  assert.match(appSidebar, /proxy-acp-codex[\s\S]*?acpProxyId:\s*"codex"/);
  assert.match(appSidebar, /value="builtin"[\s\S]*?内置编程/);
  assert.match(appSidebar, /value="acp"[\s\S]*?ACP 代理编程/);
  assert.match(appSidebar, /if \(selectedAcpProxy\) \{[\s\S]*?createInput\.acpProxyId = selectedAcpProxy\.acpProxyId/);
  assert.match(appSidebar, /window\.electronAPI\.assistant\.createCoderProject\(createInput\)/);
  assert.doesNotMatch(appSidebar, /没有检测到正在运行的 ACP 工具/);
  assert.doesNotMatch(appSidebar, /使用本机 Claude Code 运行 CODER 助理/);
  assert.doesNotMatch(appSidebar, /使用本机 Codex CLI 运行 CODER 助理/);
  assert.match(appSidebar, /className="assistant-worker-icon-button sidebar-assistant-project-button"/);
  assert.match(appSidebar, /function getOpenWorkspaceDisabledReason\(agent: AssistantNavAgentItem\)/);
  assert.match(appSidebar, /agent\.workspaceDirExists === false/);
  assert.match(appSidebar, /disabled=\{Boolean\(openWorkspaceDisabledReason\)\}/);
  assert.match(appSidebar, /openWorkspaceDirectory\(agent\.workspaceDir, agent\.agentKey\)/);
  assert.match(appSidebar, /const title = isRename \? "修改名称" : "删除智能体"/);
  assert.match(appSidebar, /role="dialog"/);
  const agentDialogInputRule = globalStyles.match(
    /^\.sidebar-agent-dialog-field input\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body ?? "";
  const agentDialogInputFocusRule = globalStyles.match(
    /^\.sidebar-agent-dialog-field input:focus\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body ?? "";
  assert.match(agentDialogInputRule, /border:\s*1px solid var\(--desktop-ui-border\);/);
  assert.doesNotMatch(agentDialogInputRule, /var\(--border\)/);
  assert.match(agentDialogInputFocusRule, /border-color:\s*var\(--desktop-ui-primary\);/);
  assert.match(agentDialogInputFocusRule, /box-shadow:\s*0 0 0 2px rgba\(var\(--desktop-ui-primary-rgb\),\s*0\.14\);/);
  assert.match(appSidebar, /desktop\.agents\.getAgentDetail/);
  assert.match(appSidebar, /buildAgentDefinitionForRename/);
  assert.doesNotMatch(appSidebar, /definition:\s*\{\s*name:\s*nextName/);
  assert.match(appSidebar, /function createAgentEditRoute\(agent: AssistantNavAgentItem\)/);
  assert.match(appSidebar, /return `\/agents\/\$\{encodeURIComponent\(agent\.agentKey\)\}`;/);
  assert.match(appSidebar, /requestNavigate\(createAgentEditRoute\(agent\)\)/);
  assert.doesNotMatch(appSidebar, /window\.open\(createAgentEditWindowUrl\(agent\), "_blank"\)/);
  assert.match(appSidebar, /agent\.agentType === "coder"/);
  assert.match(appSidebar, /desktop\.agents\.deleteAgent/);
  assert.match(appSidebar, /className="is-danger"/);
  assert.match(desktopActions, /desktop\.agents\.deleteAgent/);
  assert.match(desktopActionBridge, /case "desktop\.agents\.deleteAgent"/);
  assert.match(desktopActionBridge, /"\/api\/admin\/agents\/delete"[\s\S]*?body:\s*\{\s*key: readAgentKey\(args\)\s*\}/);
  assert.doesNotMatch(appShell, /setInterval\([\s\S]*?listNavigationAgents/);
});

test("assistant navigation agents stay empty before platform data is ready", () => {
  const appShell = readAppShellSource();

  assert.doesNotMatch(appShell, /ASSISTANT_NAV_AGENTS_CACHE_KEY/);
  assert.doesNotMatch(appShell, /DEFAULT_ASSISTANT_NAV_AGENT/);
  assert.doesNotMatch(appShell, /createDefaultAssistantNavAgents/);
  assert.doesNotMatch(appShell, /readInitialAssistantNavAgents/);
  assert.doesNotMatch(appShell, /localStorage\.getItem\("zenmind-desktop\.assistant-nav-agents-cache"\)/);
  assert.doesNotMatch(appShell, /displayName:\s*"小宅"/);
  assert.doesNotMatch(appShell, /role:\s*"平台总管"/);
  assert.match(appShell, /useState<AssistantNavAgentItem\[\]>\(\[\]\)/);
  assert.doesNotMatch(appShell, /writeAssistantNavAgentsCache/);
  assert.doesNotMatch(appShell, /clearAssistantNavAgentsCache/);
  assert.doesNotMatch(appShell, /setAssistantNavAgents\(result\.ok \? result\.items : \[\]\)/);
  assert.doesNotMatch(appShell, /catch\s*\{[\s\S]{0,220}?setAssistantNavAgents\(\[\]\)/);
});

test("assistant navigation agents refresh immediately after startup services become ready", () => {
  const appShell = readAppShellSource();

  assert.match(appShell, /function refreshAssistantNavAgents\(\)/);
  assert.match(
    appShell,
    /function refreshAssistantNavAgentsAfterStartupReady\(nextState: StartupRestoreState\)[\s\S]*?nextState\.phase === "succeeded"[\s\S]*?refreshAssistantNavAgents\(\)/
  );
  assert.match(
    appShell,
    /onStartupRestoreState\(\(nextState\) =>[\s\S]*?refreshAssistantNavAgentsAfterStartupReady\(nextState\)/
  );
  assert.match(appShell, /const agentPlatformRunning =[\s\S]*?service\.id === "agent-platform"[\s\S]*?service\.status === "running"/);
  assert.match(appShell, /if \(agentPlatformRunning\) \{[\s\S]*?refreshAssistantNavAgents\(\)/);
});

test("bootstrap success opens the first available navigation agent", () => {
  const appShell = readAppShellSource();
  const startupAutoOpenBlock = appShell.match(
    /useEffect\(\(\) => \{[\s\S]*?shouldAutoOpenAssistant\(startupRestoreState, startupAllReady, location\.pathname\)[\s\S]*?\}, \[kanbanEnabled, location\.pathname, navigate, navigationStateLoaded, startupAllReady, startupRestoreState\]\);/u
  )?.[0] ?? "";

  assert.match(startupAutoOpenBlock, /!navigationStateLoaded/);
  assert.match(startupAutoOpenBlock, /getKanbanAwareFallbackPath\(kanbanEnabled\)/);
  assert.match(startupAutoOpenBlock, /assistant\.listNavigationAgents\(\)/);
  assert.match(startupAutoOpenBlock, /normalizeAssistantNavAgents\(result\.items\)/);
  assert.match(startupAutoOpenBlock, /setAssistantNavAgents\(nextItems\)/);
  assert.match(startupAutoOpenBlock, /createStartupAgentRoute\(firstAgentKey\)/);
  assert.doesNotMatch(startupAutoOpenBlock, /navigate\("\/kanban",\s*\{\s*replace:\s*true\s*\}\)/);
  assert.match(
    appShell,
    /function createStartupAgentRoute\(agentKey: string\)[\s\S]*?`\/agent\/\$\{encodeURIComponent\(agentKey\)\}`/
  );
});

test("desktop action bridge exposes localhost api and renderer action providers", () => {
  const actionCatalog = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-actions.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const assistantHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "assistant-handlers.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = readSharedContractsSource();
  const registry = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "services", "desktopActionRegistry.ts"),
    "utf8"
  );
  const appShell = readAppShellSource();
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.tsx"),
    "utf8"
  );
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx"),
    "utf8"
  );
  const marketPage = [
    readSourceFile("src", "renderer", "pages", "functional-market", "index.tsx"),
    readSourceFile("src", "renderer", "pages", "functional-market", "SkillMarket.tsx"),
    readSourceFile("src", "renderer", "pages", "functional-market", "marketPageApi.ts")
  ].join("\n");

  assert.match(actionCatalog, /DESKTOP_ACTION_BRIDGE_HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(actionCatalog, /DESKTOP_ACTION_BRIDGE_PORT\s*=\s*11788/);
  assert.match(actionCatalog, /page_control/);
  assert.match(actionCatalog, /desktop\.controlCenter\.listServices/);
  assert.match(actionCatalog, /desktop\.settings\.applyPatch/);
  assert.doesNotMatch(actionCatalog, /desktop\.page\./);
  assert.match(actionCatalog, /desktop\.embeddedWeb\.listSurfaces/);
  assert.match(actionCatalog, /desktop\.embeddedWeb\.navigate/);
  assert.match(actionCatalog, /desktop\.embeddedWeb\.interactElement/);
  assert.match(actionCatalog, /desktop\.market\.applySettingsPatch/);
  assert.match(actionCatalog, /desktop\.automations\.listAutomations/);
  assert.doesNotMatch(actionCatalog, /desktop\.memory\./);
  assert.match(bridge, /GET" && url\.pathname === "\/health"/);
  assert.match(bridge, /GET" && url\.pathname === "\/actions"/);
  assert.match(bridge, /POST" && url\.pathname === "\/actions\/call"/);
  assert.match(bridge, /POST" && url\.pathname === "\/cdp\/call"/);
  assert.match(bridge, /Content-Type must be application\/json/);
  assert.match(bridge, /isLocalhostRequest/);
  assert.match(bridge, /confirmMutatingAction/);
  assert.match(bridge, /PageControlGrantStore/);
  assert.match(bridge, /允许本次页面操作/);
  assert.doesNotMatch(bridge, /小宅助理/);
  assert.match(mainProcess, /startDesktopActionBridge\(\{/);
  assert.match(assistantHandlers, /desktopActions\.respond/);
  assert.match(assistantHandlers, /desktopActions\.call/);
  assert.match(preload, /desktopActions:\s*\{/);
  assert.match(preload, /getDesktopWsServerState: \(\) => ipcRenderer\.invoke\("settings\.getDesktopWsServerState"\)/);
  assert.match(preload, /setDesktopWsServerEnabled: \(enabled\) => ipcRenderer\.invoke\("settings\.setDesktopWsServerEnabled", enabled\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktopActions\.respond"/);
  assert.match(preload, /ipcRenderer\.on\("desktopActions\.call"/);
  assert.match(contracts, /export interface DesktopWsServerState/);
  assert.match(contracts, /getDesktopWsServerState: \(\) => Promise<DesktopWsServerState>/);
  assert.match(contracts, /setDesktopWsServerEnabled: \(enabled: boolean\) => Promise<DesktopWsServerState>/);
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
  assert.match(marketPage, /skillDownloadCommand/);
});

test("built index uses relative asset paths", (t) => {
  const builtIndexPath = path.join(projectRoot, "dist-renderer", "index.html");
  if (!fs.existsSync(builtIndexPath)) {
    t.skip("dist-renderer output is not built");
    return;
  }
  const builtIndex = fs.readFileSync(builtIndexPath, "utf8");
  const brand = readJsonFile("build", "generated", "brand.json");
  const petProtocol = `${brand.id}-pet:`;
  const exactPetProtocolPattern = new RegExp(`img-src[^"]*${escapeRegExp(petProtocol)}`, "u");

  assert.doesNotMatch(builtIndex, /src="\/assets\//);
  assert.doesNotMatch(builtIndex, /href="\/assets\//);
  assert.match(builtIndex, /(src|href)="\.?\/?assets\//);
  assert.match(builtIndex, exactPetProtocolPattern);
  assert.match(builtIndex, new RegExp(`<title>${escapeRegExp(brand.productName)}</title>`, "u"));

  for (const entry of fs.readdirSync(path.join(projectRoot, "brands"), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === brand.id) {
      continue;
    }
    assert.doesNotMatch(builtIndex, new RegExp(`${escapeRegExp(entry.name)}-pet:`, "u"));
  }
});

test("plugin market guards stale preload market api before skill import", () => {
  const marketPage = [
    readSourceFile("src", "renderer", "pages", "functional-market", "SkillMarket.tsx"),
    readSourceFile("src", "renderer", "pages", "functional-market", "marketPageApi.ts")
  ].join("\n");
  const marketStyles = [
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    readSourceFile("src", "renderer", "pages", "functional-market", "SkillMarket.css")
  ].join("\n");

  assert.match(marketPage, /function getMarketApi\(/);
  assert.match(marketPage, /function getPluginApi\(/);
  assert.match(marketPage, /t\("market\.error\.marketApiUnavailable"/);
  assert.match(marketPage, /t\("market\.error\.pluginApiUnavailable"/);
  assert.match(marketPage, /getMarketMethod\("importSkillFromCommand"\)/);
  assert.match(marketPage, /market-command-input/);
  assert.match(marketPage, /t\("market\.skill\.cloudDownload\.run"\)/);
  assert.match(marketPage, /const skillMarketOffline = Boolean\(next\.skillOffline\)/);
  assert.match(marketPage, /setMarketFeedback\(skillMarketOffline \? next\.skillMessage \?\? "" : ""\)/);
  assert.match(marketPage, /marketOffline=\{Boolean\(marketResult\.skillOffline\)\}/);
  assert.match(marketPage, /console\.warn\("\[skill-market\] failed to load market data"/);
  assert.doesNotMatch(marketPage, /window\.electronAPI\.market\.importSkill\(\)/);
  assert.doesNotMatch(marketPage, /installPlugin\(\)/);
  assert.doesNotMatch(marketPage, /market-feedback/);
  assert.doesNotMatch(marketStyles, /\.market-feedback/);
  assert.match(marketStyles, /\.market-command-input/);
  assert.match(marketStyles, /\.market-status/);
});

test("functional market renderer text is routed through i18n", () => {
  const marketFiles = [
    "MarketPageFrame.tsx",
    "PluginMarket.tsx",
    "SkillMarket.tsx",
    "SandboxImageMarket.tsx",
    "StorefrontMarket.tsx",
    "marketDisplay.tsx",
    "marketPageApi.ts",
    "marketPageModel.ts"
  ];

  for (const filename of marketFiles) {
    const source = readSourceFile("src", "renderer", "pages", "functional-market", filename);
    assert.doesNotMatch(source, /[\p{Script=Han}]/u, `${filename} contains hardcoded Chinese text`);
  }
});

test("main marketplace user-facing text is routed through i18n", () => {
  const marketplaceFiles = [
    "catalog-only-market.ts",
    "common.ts",
    "plugin-market.ts",
    "skill-market.ts",
    "sandbox-image-market.ts"
  ];

  for (const filename of marketplaceFiles) {
    const source = readSourceFile("src", "main", "marketplace", filename);
    assert.doesNotMatch(source, /[\p{Script=Han}]/u, `${filename} contains hardcoded Chinese text`);
  }
});

test("storefront market uses compact responsive component item cards", () => {
  const storefront = readSourceFile("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");
  const storefrontStyles = readSourceFile("src", "renderer", "pages", "functional-market", "StorefrontMarket.css");
  const serviceDisplay = readSourceFile("src", "renderer", "service-display.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");

  assert.match(storefront, /function marketItemDepsCount\(item: MarketItem\)/);
  assert.match(storefront, /"depsCount",\s*"dependencyCount",\s*"missingDepsCount",\s*"requiredDepsCount"/);
  assert.match(storefront, /t\("market\.action\.installDeps",\s*\{\s*count:\s*depsCount\s*\}\)/);
  assert.match(storefront, /market-store-title-line/);
  assert.match(storefront, /market-store-version/);
  assert.match(storefront, /market-store-description/);
  assert.match(storefront, /market-store-tags/);
  assert.match(storefront, /market-store-card-footer/);
  assert.match(storefront, /t\("market\.action\.details"\)/);
  assert.match(storefront, /market-store-detail-link/);
  assert.doesNotMatch(storefront, /ArrowRightOutlined/);
  assert.doesNotMatch(storefront, /platformChip/);
  assert.doesNotMatch(storefront, /market-store-platform-chip/);
  assert.match(storefront, /market-store-detail-modal/);
  assert.match(storefront, /storefrontDetailRows/);
  assert.match(storefront, /setSelectedDetailItem\(item\)/);
  assert.match(storefront, /ReloadOutlined/);
  assert.match(storefront, /handleToolbarImport/);
  assert.match(storefront, /getPluginMethod\("install"\)/);
  assert.match(storefront, /market-store-toolbar-actions/);
  assert.match(storefront, /market\.toolbar\.refreshMarket/);
  assert.match(storefront, /market\.sandbox\.import/);
  assert.doesNotMatch(storefront, /market-store-category-pill/);
  assert.doesNotMatch(storefront, /market-store-readiness/);
  assert.doesNotMatch(storefront, /storefrontReadinessLabel/);
  assert.doesNotMatch(storefront, /market-store-overview/);
  assert.doesNotMatch(storefront, /market-store-metric/);
  assert.doesNotMatch(storefront, /market-store-compatibility/);
  assert.match(storefrontStyles, /\.market-store-scroll\s*\{[\s\S]*?container-type:\s*inline-size;/);
  assert.match(storefrontStyles, /\.market-store-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(300px,\s*1fr\)\);/);
  assert.match(storefrontStyles, /@container\s*\(max-width:\s*640px\)\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.doesNotMatch(storefrontStyles, /620px/);
  assert.match(storefrontStyles, /\.market-store-card\s*\{[\s\S]*?border-radius:\s*16px;/);
  assert.match(storefrontStyles, /\.market-store-card-head\s*\{[\s\S]*?grid-template-columns:\s*40px minmax\(0,\s*1fr\);/);
  assert.match(storefrontStyles, /\.market-store-item-icon\s*\{[\s\S]*?width:\s*40px;[\s\S]*?height:\s*40px;[\s\S]*?background:\s*var\(--glyph-bg/);
  assert.match(storefrontStyles, /\.market-store-item-icon svg\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/);
  assert.doesNotMatch(storefrontStyles, /--glyph-grad/);
  assert.doesNotMatch(storefrontStyles, /\.market-store-item-icon::after/);
  assert.doesNotMatch(storefrontStyles, /market-store-platform-chip/);
  assert.match(storefrontStyles, /\.market-store-title-line\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(storefrontStyles, /\.market-store-description\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.match(storefrontStyles, /\.market-store-card-footer\s*\{[\s\S]*?border-top:\s*1px solid var\(--market-store-line\);/);
  assert.match(storefrontStyles, /\.market-store-toolbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(260px,\s*1fr\)\s*160px\s*160px\s*auto;/);
  assert.match(storefrontStyles, /\.market-store-toolbar-actions\s*\{[\s\S]*?justify-content:\s*flex-end;/);
  assert.match(storefrontStyles, /\.market-store-toolbar-button\s*\{[\s\S]*?border-radius:\s*11px;/);
  assert.match(storefrontStyles, /\.market-store-action\.is-primary\s*\{[\s\S]*?background:\s*var\(--market-store-purple-grad\);/);
  assert.match(storefront, /width=\{680\}/);
  assert.match(storefrontStyles, /\.market-store-detail-category-pill/);
  assert.doesNotMatch(storefrontStyles, /\.market-store-category-pill/);
  assert.doesNotMatch(storefrontStyles, /\.market-store-readiness/);
  assert.doesNotMatch(storefrontStyles, /\.market-store-overview/);
  assert.doesNotMatch(storefrontStyles, /\.market-store-compatibility/);
  assert.match(enUS, /"market\.action\.installDeps":\s*"Install \{count\} deps"/);
  assert.match(enUS, /"market\.storefront\.detailsDemo":\s*"Details & demo"/);
  assert.match(enUS, /"market\.tab\.sandboxImages\.label":\s*"Sandboxes"/);
  assert.match(enUS, /"controlCenter\.service\.authentication\.name":\s*"Identity Center"/);
  assert.match(enUS, /"startup\.service\.authentication":\s*"Identity Center"/);
  assert.match(enUS, /"startup\.service\.agentWebclient":\s*"Agent Webclient"/);
  assert.match(enUS, /"service\.agentWebclientDisplayName":\s*"Agent Webclient"/);
  assert.match(enUS, /"service\.display\.identityCenter":\s*"Identity Center"/);
  assert.match(enUS, /"service\.display\.agentWebclient":\s*"Agent Webclient"/);
  assert.doesNotMatch(enUS, /"market\.tab\.sandboxImages\.meta"/);
  assert.match(zhCN, /"market\.action\.installDeps":\s*"安装 \{count\} 个依赖"/);
  assert.match(zhCN, /"market\.storefront\.detailsDemo":\s*"详情与演示"/);
  assert.match(zhCN, /"market\.tab\.sandboxImages\.label":\s*"沙箱"/);
  assert.match(zhCN, /"controlCenter\.service\.authentication\.name":\s*"Identity Center"/);
  assert.match(zhCN, /"startup\.service\.authentication":\s*"Identity Center"/);
  assert.match(zhCN, /"startup\.service\.agentWebclient":\s*"Agent Webclient"/);
  assert.match(zhCN, /"service\.agentWebclientDisplayName":\s*"Agent Webclient"/);
  assert.match(zhCN, /"service\.display\.identityCenter":\s*"Identity Center"/);
  assert.match(zhCN, /"service\.display\.agentWebclient":\s*"Agent Webclient"/);
  assert.doesNotMatch(zhCN, /"market\.tab\.sandboxImages\.meta"/);
  assert.match(serviceDisplay, /serviceId === "identity-center"[\s\S]*?t\("service\.display\.identityCenter"\)/);
});

test("sandbox image market is a local image management surface", () => {
  const sandboxMarket = readSourceFile(
    "src",
    "renderer",
    "pages",
    "functional-market",
    "SandboxImageMarket.tsx"
  );
  const marketModel = readSourceFile("src", "renderer", "pages", "functional-market", "marketPageModel.ts");
  const marketFrame = readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.tsx");
  const marketStyles = readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css");

  assert.match(marketModel, /market\.tab\.sandboxImages\.subtitle/);
  assert.doesNotMatch(marketModel, /market\.tab\.[^.]+\.meta/);
  assert.match(marketFrame, /function marketTabIcon\(tab: MarketTab\)/);
  assert.match(marketFrame, /AppstoreOutlined/);
  assert.match(marketFrame, /SafetyCertificateOutlined/);
  assert.match(marketFrame, /RobotOutlined/);
  assert.match(marketFrame, /ApiOutlined/);
  assert.match(marketFrame, /SmileOutlined/);
  assert.match(marketFrame, /CodeOutlined/);
  assert.match(marketFrame, /GlobalOutlined/);
  assert.match(marketFrame, /market-tab-icon/);
  assert.match(marketFrame, /market-tab-text/);
  assert.doesNotMatch(marketFrame, /market-tab-meta/);
  assert.match(sandboxMarket, /PageFeedbackStack/);
  assert.match(sandboxMarket, /sandboxImageDescription/);
  assert.match(sandboxMarket, /description === t\("market\.sandbox\.localDescription"\) \? "" : description/);
  assert.match(sandboxMarket, /getMarketMethod\("importSandboxImage"\)/);
  assert.match(sandboxMarket, /SandboxImageImportProgressEvent/);
  assert.match(sandboxMarket, /importProgressEvents/);
  assert.match(sandboxMarket, /getMarketMethod\("onSandboxImageImportProgress"\)/);
  assert.match(sandboxMarket, /onDismissImportProgress/);
  assert.match(sandboxMarket, /market-import-progress-backdrop/);
  assert.match(sandboxMarket, /market-import-progress-panel/);
  assert.match(sandboxMarket, /role="dialog"/);
  assert.match(sandboxMarket, /aria-modal="true"/);
  assert.match(sandboxMarket, /market-import-progress-close/);
  assert.match(sandboxMarket, /market-import-progress-log/);
  assert.match(sandboxMarket, /latest\.stage !== "done"/);
  assert.match(sandboxMarket, /getMarketMethod\("exportSandboxImage"\)/);
  assert.match(sandboxMarket, /getMarketMethod\("deleteSandboxImage"\)/);
  assert.match(sandboxMarket, /market-image-detail-dialog/);
  assert.match(sandboxMarket, /market-image-action-button/);
  assert.match(sandboxMarket, /sandbox-image-panel/);
  assert.doesNotMatch(sandboxMarket, /market-provider-dot/);
  assert.match(sandboxMarket, /t\("market\.sandbox\.confirmDelete"/);
  assert.match(sandboxMarket, /Docker \/ Podman/);
  assert.match(readSourceFile("src", "renderer", "pages", "functional-market", "marketDisplay.tsx"), /market-sandbox-image-symbol/);
  assert.match(
    marketStyles,
    /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(320px,\s*1fr\)\)/
  );
  assert.match(
    marketStyles,
    /\.sandbox-image-panel\s*\{[\s\S]*?align-items:\s*start;/
  );
  assert.match(
    marketStyles,
    /\.market-skill-card\.sandbox-image-card\s*\{[\s\S]*?min-height:\s*100px;[\s\S]*?padding:\s*10px 12px;/
  );
  assert.match(
    marketStyles,
    /\.sandbox-image-card\s+\.market-plugin-meta\s*\{[\s\S]*?margin-top:\s*4px;[\s\S]*?padding-top:\s*7px;/
  );
  assert.match(
    marketStyles,
    /\.sandbox-image-card\s*\{[\s\S]*?background:\s*var\(--market-control-card\);[\s\S]*?box-shadow:\s*0 2px 6px rgba\(15,\s*23,\s*42,\s*0\.08\);/
  );
  assert.match(
    marketStyles,
    /:root\[data-theme="dark"\]\s+\.sandbox-image-card\s*\{[\s\S]*?background:\s*var\(--market-control-card\);[\s\S]*?box-shadow:\s*none;/
  );
  assert.match(
    marketStyles,
    /\.sandbox-image-card\s+\.market-card-icon,[\s\S]*?\.market-image-detail-title\s+\.market-card-icon\s*\{[\s\S]*?background:\s*#e9eefc;[\s\S]*?color:\s*var\(--market-control-blue\);/
  );
  assert.match(
    marketStyles,
    /:root\[data-theme="dark"\]\s+\.sandbox-image-card\s+\.market-card-icon,[\s\S]*?:root\[data-theme="dark"\]\s+\.market-image-detail-title\s+\.market-card-icon\s*\{[\s\S]*?background:\s*rgba\(87,\s*144,\s*255,\s*0\.15\);[\s\S]*?color:\s*#7facff;/
  );
  assert.match(
    marketStyles,
    /\.market-topbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/
  );
  assert.match(
    marketStyles,
    /\.market-topbar\.has-toolbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/
  );
  assert.match(
    marketStyles,
    /\.market-tabs\s*\{[\s\S]*?grid-column:\s*1[\s\S]*?width:\s*100%/
  );
  assert.match(
    marketStyles,
    /\.market-tabs \.market-tab-label\s*\{[\s\S]*?min-height:\s*38px/
  );
  assert.match(
    marketStyles,
    /\.market-tab-icon\s*\{[\s\S]*?font-size:\s*15px;/
  );
  assert.match(
    marketStyles,
    /\.market-tab-text\s*\{[\s\S]*?text-overflow:\s*ellipsis;/
  );
  assert.doesNotMatch(
    marketStyles,
    /\.market-tab-meta/
  );
  assert.match(
    marketStyles,
    /:root\[data-theme="dark"\]\s+\.market-tabs\s*\{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.045\)[\s\S]*?box-shadow:\s*inset 0 1px 0 rgba\(255,\s*255,\s*255,\s*0\.04\)/
  );
  assert.doesNotMatch(marketStyles, /\.market-tab\.is-active/);
  assert.match(
    marketStyles,
    /\.market-empty-state\s*\{[\s\S]*?align-self:\s*center;/
  );
  assert.match(
    marketStyles,
    /\.market-import-progress-backdrop\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*90;[\s\S]*?backdrop-filter:\s*blur\(8px\);/
  );
  assert.match(
    marketStyles,
    /\.market-import-progress-panel\s*\{[\s\S]*?width:\s*min\(520px,\s*100%\);[\s\S]*?max-height:\s*min\(520px,\s*calc\(100vh - 48px\)\);/
  );
  assert.match(
    marketStyles,
    /\.market-import-progress-panel\s*\{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.98\);[\s\S]*?box-shadow:\s*0 24px 70px rgba\(15,\s*23,\s*42,\s*0\.24\);/
  );
  assert.match(
    marketStyles,
    /\.market-import-progress-close\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/
  );
  assert.match(
    marketStyles,
    /\.market-import-progress-log\s*\{[\s\S]*?font-family:\s*ui-monospace/
  );
  assert.match(sandboxMarket, /t\("market\.sandbox\.action\.view"/);
  assert.match(sandboxMarket, /t\("market\.sandbox\.action\.export"/);
  assert.match(sandboxMarket, /t\("market\.sandbox\.action\.delete"/);
  assert.doesNotMatch(sandboxMarket, /getMarketMethod\("buildSandboxImage"\)/);
  assert.doesNotMatch(sandboxMarket, /onBuildSandboxImage/);
});

test("sandbox image import progress is exposed across desktop api layers", () => {
  const desktopApi = readSourceFile("src", "shared", "contracts", "desktop-api.ts");
  const marketContracts = readSourceFile("src", "shared", "contracts", "marketplace.ts");
  const preload = readSourceFile("src", "preload", "index.ts");
  const marketplaceHandlers = readSourceFile("src", "main", "ipc", "marketplace-handlers.ts");

  assert.match(marketContracts, /export interface SandboxImageImportProgressEvent/);
  assert.match(desktopApi, /SandboxImageImportProgressListener/);
  assert.match(desktopApi, /onSandboxImageImportProgress:\s*\(listener:\s*SandboxImageImportProgressListener\)\s*=>\s*\(\)\s*=>\s*void/);
  assert.match(preload, /onSandboxImageImportProgress:\s*\(listener:\s*SandboxImageImportProgressListener\)\s*=>/);
  assert.match(preload, /ipcRenderer\.on\("market\.sandboxImageImportProgress"/);
  assert.match(preload, /ipcRenderer\.off\("market\.sandboxImageImportProgress"/);
  assert.match(marketplaceHandlers, /event\.sender\.send\("market\.sandboxImageImportProgress"/);
  assert.match(marketplaceHandlers, /const taskId\s*=\s*`sandbox-import-/);
  assert.match(marketplaceHandlers, /event\.sender\.send\("market\.sandboxImageImportProgress",\s*\{[\s\S]*?taskId,[\s\S]*?\.\.\.progress/);
});

test("market route disables the global drag overlay above toolbar controls", () => {
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();
  const marketStyles = readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css");

  assert.match(appShell, /has-market-controls/);
  assert.match(globalStyles, /\.app-shell\.has-market-controls\s+\.app-window-drag-region/);
  assert.match(marketStyles, /-webkit-app-region:\s*no-drag;/);
});

test("embedded H5 routes keep a thin global window drag lane", () => {
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();

  assert.match(appShell, /usesEmbeddedSurface/);
  assert.match(appShell, /has-embedded-surface/);
  assert.match(appShell, /usesPluginSurface/);
  assert.match(appShell, /has-plugin-surface/);
  assert.match(globalStyles, /\.app-shell\.has-embedded-surface\s+\.app-window-drag-region\s*\{[^}]*height:\s*8px;/);
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.has-embedded-surface\s+\.app-window-drag-region\s*\{[^}]*display:\s*none;/
  );
  assert.match(globalStyles, /\.app-window-drag-region\s*\{[^}]*z-index:\s*1000;/);
  assert.match(
    globalStyles,
    /\.pan-page-embedded\s+\.pan-drag-region\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*left:\s*0;[^}]*right:\s*0;[^}]*height:\s*8px;[^}]*z-index:\s*1000;[^}]*app-region:\s*drag;[^}]*pointer-events:\s*auto;/
  );
  assert.match(globalStyles, /\.pan-drag-region\s*\{[^}]*cursor:\s*grab;/);
  assert.match(globalStyles, /\.pan-drag-region:active\s*\{[^}]*cursor:\s*grabbing;/);
  assert.doesNotMatch(
    globalStyles,
    /\.pan-page-embedded\s+\.pan-drag-region\s*\{[^}]*display:\s*none;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.pan-page-embedded\s+\.pan-drag-region\s*\{[^}]*flex:\s*0\s+0\s+8px;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.pan-page-embedded\s+\.pan-drag-region\s*\{[^}]*min-height:\s*8px;/
  );
  assert.match(
    globalStyles,
    /\.external-webview-page\s+\.pan-drag-region\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*left:\s*0;[^}]*right:\s*0;[^}]*height:\s*8px;[^}]*z-index:\s*1000;[^}]*pointer-events:\s*auto;/
  );
  assert.match(globalStyles, /\.external-webview-page\s+\.pan-drag-region\s*\{[^}]*cursor:\s*grab;/);
  assert.match(globalStyles, /\.external-webview-page\s+\.pan-drag-region:active\s*\{[^}]*cursor:\s*grabbing;/);
  assert.doesNotMatch(
    globalStyles,
    /\.external-webview-page\s+\.pan-drag-region\s*\{[^}]*height:\s*0;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.external-webview-page\s+\.pan-drag-region\s*\{[^}]*pointer-events:\s*none;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.external-webview-page\s+\.pan-drag-region\s*\{[^}]*flex:\s*0\s+0\s+8px;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.external-webview-page\s+\.pan-drag-region\s*\{[^}]*min-height:\s*8px;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.pan-page-embedded\s+\.pan-frame-shell\s*\{[^}]*(?:padding-top|margin-top|top):\s*8px;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.external-webview-frame-shell\s*\{[^}]*(?:padding-top|margin-top|top):\s*8px;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.is-windows-platform\s+\.pan-page-embedded\.pan-page-agent-webclient\s*\{[^}]*padding-top:\s*44px;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.is-windows-platform\s+\.pan-page-embedded\.pan-page-agent-webclient::before\s*\{[^}]*height:\s*44px;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.is-mac-platform\.has-plugin-surface\s+\.app-window-drag-region\s*\{/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.is-mac-platform\.has-plugin-surface\.has-assistant-dock-full\s+\.app-window-drag-region\s*\{/
  );
});

test("window drag uses app-region plus desktopShell drag fallback", () => {
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const shellHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "shell-handlers.ts"), "utf8");
  const contracts = readSharedContractsSource();

  assert.match(
    globalStyles,
    /\.app-window-drag-region\s*\{[\s\S]*?left:\s*var\(--app-sidebar-width,\s*160px\);[\s\S]*?app-region:\s*drag;[\s\S]*?-webkit-app-region:\s*drag;/
  );
  assert.match(globalStyles, /\.app-window-drag-region\s*\{[^}]*height:\s*24px;/);
  assert.match(globalStyles, /\.app-window-drag-region\s*\{[^}]*cursor:\s*grab;/);
  assert.match(globalStyles, /\.app-window-drag-region:active\s*\{[^}]*cursor:\s*grabbing;/);
  assert.match(
    globalStyles,
    /\.sidebar-chrome-drag-region\s*\{[\s\S]*?app-region:\s*drag;[\s\S]*?-webkit-app-region:\s*drag;/
  );
  assert.match(globalStyles, /\.sidebar-chrome-drag-region\s*\{[^}]*cursor:\s*grab;/);
  assert.match(globalStyles, /\.sidebar-chrome-drag-region:active\s*\{[^}]*cursor:\s*grabbing;/);
  assert.match(
    globalStyles,
    /\.app-shell\.is-mac-platform\s+\.sidebar-chrome-drag-region\s*\{[\s\S]*?left:\s*var\(--mac-traffic-light-safe-area\);/
  );
  assert.match(globalStyles, /\.app-main-drag-region\s*\{\s*height:\s*20px;\s*\}/);
  assert.match(globalStyles, /\.app-main-drag-region\s*\{[^}]*cursor:\s*grab;/);
  assert.match(globalStyles, /\.app-main-drag-region:active\s*\{[^}]*cursor:\s*grabbing;/);
  assert.match(globalStyles, /\.app-header\s*\{[^}]*cursor:\s*grab;/);
  assert.match(globalStyles, /\.app-header:active\s*\{[^}]*cursor:\s*grabbing;/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar-drag-region/);
  assert.match(sidebarSource, /sidebar-chrome-drag-region/);
  assert.doesNotMatch(appShell, /app-sidebar-drag-region/);
  assert.doesNotMatch(appShell, /SIDEBAR_WINDOW_DRAG_START_THRESHOLD_PX/);
  assert.doesNotMatch(appShell, /handleSidebarWindowPointerDownCapture/);
  assert.doesNotMatch(appShell, /onPointerDownCapture=\{handleSidebarWindowPointerDownCapture\}/);
  assert.match(appShell, /onPointerDownCapture=\{handleWindowDragPointerDownCapture\}/);
  assert.match(appShell, /target\?\.closest\("\.app-window-drag-region, \.pan-drag-region"\)/);
  assert.match(appShell, /event\.button !== 0/);
  assert.match(appShell, /desktopShell\.beginWindowDrag\(\{ x: event\.screenX, y: event\.screenY \}\)/);
  assert.match(appShell, /desktopShell\.endWindowDrag\(\)/);
  assert.match(appShell, /window\.addEventListener\("pointerup", finishDrag, true\)/);
  assert.match(appShell, /window\.addEventListener\("pointercancel", finishDrag, true\)/);
  assert.match(appShell, /window\.addEventListener\("blur", finishDrag, true\)/);
  assert.match(appShell, /dragRegion\.setPointerCapture\(pointerId\)/);
  assert.match(preload, /beginWindowDrag:\s*\(point: \{ x: number; y: number \}\) => ipcRenderer\.invoke\("desktopShell\.beginWindowDrag", point\)/);
  assert.match(preload, /endWindowDrag:\s*\(\) => ipcRenderer\.invoke\("desktopShell\.endWindowDrag"\)/);
  assert.match(contracts, /beginWindowDrag:\s*\(point: \{ x: number; y: number \}\) => Promise<\{ ok: boolean; message\?: string \}>/);
  assert.match(contracts, /endWindowDrag:\s*\(\) => Promise<\{ ok: boolean; message\?: string \}>/);
  assert.match(shellHandlers, /ipcMain\.handle\("desktopShell\.beginWindowDrag"/);
  assert.match(shellHandlers, /ipcMain\.handle\("desktopShell\.endWindowDrag"/);
  assert.match(shellHandlers, /screen\.getCursorScreenPoint\(\)/);
  assert.match(shellHandlers, /runSetInterval\(tickWindowDrag,\s*16\)/);
  assert.doesNotMatch(appShell, /window\.electronAPI\.windowDrag\.begin/);
  assert.doesNotMatch(contracts, /windowDrag:\s*\{/);
  assert.doesNotMatch(preload, /windowDrag:\s*\{/);
  assert.doesNotMatch(mainProcess, /ipcMain\.handle\("windowDrag\.begin"/);
});

test("mac fullscreen forces the main window to an opaque background", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const appState = readSourceFile("src", "main", "app-state.ts");
  const windowManager = readSourceFile("src", "main", "window-manager.ts");

  assert.match(appState, /mainWindowSidebarTranslucencyEnabled:\s*initialState\.mainWindowSidebarTranslucencyEnabled \?\? true/);
  assert.match(mainProcess, /isSidebarTranslucencyEnabled:\s*\(\) => appState\.mainWindowSidebarTranslucencyEnabled/);
  assert.match(windowManager, /vibrancy:\s*"under-window"\s+as const/);
  assert.match(windowManager, /visualEffectState:\s*"active"\s+as const/);
  assert.match(windowManager, /applyAppearance\(targetWindow: TWindow \| null\)/);
  assert.match(
    windowManager,
    /if \(options\.platform === "darwin"\)\s*\{[\s\S]*?isSidebarTranslucencyEnabled\?\.\(\) \?\? true\) && !targetWindow\.isFullScreen\(\);[\s\S]*?targetWindow\.setVibrancy\(useSidebarTranslucency \? "under-window" : null\);[\s\S]*?targetWindow\.setBackgroundColor\(useSidebarTranslucency \? "#00000000" : "#FFFFFF"\);/
  );
  assert.match(windowManager, /targetWindow\.setBackgroundColor\("#FFFFFF"\);/);
  assert.match(windowManager, /targetWindow\.on\("enter-full-screen", \(\) => \{[\s\S]*?options\.lifecycle\.applyAppearance\(targetWindow\);[\s\S]*?\}\);/);
  assert.match(windowManager, /targetWindow\.on\("leave-full-screen", \(\) => \{[\s\S]*?options\.lifecycle\.applyAppearance\(targetWindow\);[\s\S]*?\}\);/);
});

test("main process keeps app identity visible in platform program bars", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const platformAdapter = readSourceFile("src", "main", "platform-adapter.ts");

  assert.match(mainProcess, /APP_ID,[\s\S]*?PRODUCT_NAME[\s\S]*?from "\.\.\/shared\/generated\/brand"/);
  assert.doesNotMatch(mainProcess, /ZENMIND_APP_ID|ZENMIND_PRODUCT_NAME/);
  assert.match(mainProcess, /app\.setName\(PRODUCT_NAME\);/);
  assert.match(mainProcess, /applyPlatformAppInit\((?:process|mainProcessContext)\.platform, app, APP_ID\);/);
  assert.match(
    platformAdapter,
    /if \(platform === "win32"\)\s*\{[\s\S]*?app\.setAppUserModelId\(appId\);[\s\S]*?\}/
  );
  assert.match(mainProcess, /function ensureDarwinDockIdentity\(\)/);
  assert.match(
    mainProcess,
    /if \((?:process|mainProcessContext)\.platform !== "darwin"\)\s*\{[\s\S]*?return;[\s\S]*?\}/
  );
  assert.match(mainProcess, /function getDarwinDockIconCandidatePaths\(\)/);
  assert.match(mainProcess, /APP_ICON_ASSET_FILENAMES\.brandIcon/);
  assert.match(mainProcess, /APP_ICON_ASSET_FILENAMES\.macDockIcon/);
  assert.match(mainProcess, /nativeImage\.createFromPath\(iconPath\)/);
  assert.match(mainProcess, /dock\.setIcon\(icon\);/);
  assert.match(mainProcess, /app\.setActivationPolicy\("regular"\);/);
  assert.match(mainProcess, /dock\.show\(\)/);
  assert.match(mainProcess, /then\(\(\) => \{[\s\S]*?applyDarwinDockIcon\(dock\);[\s\S]*?\}\)/);
  assert.match(mainProcess, /ensureDockIdentity:\s*ensureDarwinDockIdentity/);
  assert.match(mainProcess, /showMainWindow\(\);/);
  assert.match(readSourceFile("src", "main", "window-manager.ts"), /options\.ensureDockIdentity\(\);[\s\S]*?const targetWindow = activateMainWindow\(\);/);
});

test("mac dev app uses a content-addressed icon filename to avoid stale Dock cache", () => {
  const darwinDev = readSourceFile("scripts", "platform", "dev-darwin.mjs");

  assert.match(darwinDev, /createHash\("sha256"\)/);
  assert.match(darwinDev, /const targetIconFileName = `icon-\$\{fileHashPrefix\(sourceIconPath\)\}\.icns`;/);
  assert.match(darwinDev, /setPlistString\(plist,\s*"CFBundleIconFile",\s*targetIconFileName\)/);
  assert.doesNotMatch(darwinDev, /const targetIconFileName = "icon\.icns";/);
});

test("external webview tabs use repeatable pointer reordering", () => {
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx"),
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

test("external webview browser chrome omits bookmarks and DevTools button entry", () => {
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx"),
    "utf8"
  );
  const externalWebviewStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "styles", "external-webview.css"),
    "utf8"
  );
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts", "desktop-api.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.doesNotMatch(externalWebviewPage, /external-webview-bookmarks-bar/);
  assert.doesNotMatch(externalWebviewPage, /external-webview-bookmark-toggle/);
  assert.doesNotMatch(externalWebviewPage, /external-webview-devtools-toggle/);
  assert.doesNotMatch(externalWebviewPage, /bookmarkMenuNode/);
  assert.doesNotMatch(externalWebviewPage, /window\.electronAPI\.webview\.openDevTools/);
  assert.doesNotMatch(externalWebviewPage, /external-webview-bookmarks/);
  assert.doesNotMatch(externalWebviewStyles, /external-webview-bookmark/);
  assert.doesNotMatch(externalWebviewStyles, /external-webview-devtools-toggle/);
  assert.doesNotMatch(preload, /webview\.openDevTools/);
  assert.doesNotMatch(contracts, /openDevTools: \(webContentsId: number\)/);
  assert.doesNotMatch(mainProcess, /registerWebviewDevToolsIpcHandlers/);
});

test("web copilot dock yields to native dialogs while quick assistant keeps outside-dismiss handling", () => {
  const appShell = readAppShellSource();
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const nativeDialogs = fs.readFileSync(
    path.join(projectRoot, "src", "main", "app-shell", "native-dialogs.ts"),
    "utf8"
  );
  const quickCopilotWindowController = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "quick-copilot", "window.ts"),
    "utf8"
  );
  const quickCopilotDismissLayer = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "quick-copilot", "dismiss-layer.ts"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const quickAssistantBlurHandler = quickCopilotWindowController.slice(
    quickCopilotWindowController.indexOf('this.quickWindow.on("blur"'),
    quickCopilotWindowController.indexOf('this.quickWindow.on("closed"')
  );

  assert.match(nativeDialogs, /app\.nativeDialogVisibility/);
  assert.match(nativeDialogs, /platform === "darwin"/);
  assert.match(mainProcess, /hideQuickAssistantForNativeDialog/);
  assert.match(mainProcess, /restoreQuickAssistantAfterNativeDialog/);
  assert.match(mainProcess, /quickCopilotWindowController\.hideAfterOutsideFocus\(\)/);
  assert.match(mainProcess, /app\.on\("activate"[\s\S]{0,120}nativeDialogController\.isOpen\(\)[\s\S]{0,80}return;/);
  assert.match(quickCopilotWindowController, /dismissWindow/);
  assert.match(quickCopilotDismissLayer, /QUICK_COPILOT_DISMISS_URL/);
  assert.match(mainProcess, /showQuickAssistantDismissWindow/);
  assert.doesNotMatch(quickAssistantBlurHandler, /mouseInside/);
  assert.match(preload, /onNativeDialogVisibility/);
  assert.match(appShell, /nativeDialogVisible/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.match(appShell, /nativeDialogVisible=\{nativeDialogVisible\}/);
  assert.match(globalStyles, /\.agent-webclient-copilot-dock\.is-native-dialog-open/);
});

test("plugin page provides webview-backed assistant context instead of guessing embedded content", () => {
  const pluginPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "plugin", "PluginPage.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const serviceWebviewPreload = fs.readFileSync(
    path.join(projectRoot, "src", "preload", "service-webview.ts"),
    "utf8"
  );
  const serviceWebviewMainWorld = readSourceFile("src", "preload", "service-webview-main-world.ts");
  const serviceWebviewBridgeHost = readSourceFile("src", "renderer", "services", "serviceWebviewBridgeHost.ts");
  const serviceWebviewBridgeReserved = readSourceFile(
    "src",
    "renderer",
    "services",
    "serviceWebviewBridgeReservedCapabilities.ts"
  );
  const serviceWebviewBridgeContracts = readSourceFile("src", "shared", "service-webview-bridge.ts");
  const mainProcess = readSourceFile("src", "main", "index.ts");
  const servicesHandlers = readSourceFile("src", "main", "ipc", "services-handlers.ts");
  const shellHandlers = readSourceFile("src", "main", "ipc", "shell-handlers.ts");
  const windowManager = readSourceFile("src", "main", "window-manager.ts");
  const preload = readSourceFile("src", "preload", "index.ts");
  const contracts = readSharedContractsSource();
  const sendBridgeMessageBlock = pluginPage.slice(
    pluginPage.indexOf("function sendBridgeMessageToWebview"),
    pluginPage.indexOf("function dispatchPluginRouteEventToWebview")
  );
  const sendPluginRouteBlock = pluginPage.slice(
    pluginPage.indexOf("function dispatchPluginRouteEventToWebview"),
    pluginPage.indexOf("function requestDirectWebviewRouteLoad")
  );
  const directRouteLoadBlock = pluginPage.slice(
    pluginPage.indexOf("function requestDirectWebviewRouteLoad"),
    pluginPage.indexOf("async function injectAgentWebclientAccessToken")
  );

  assert.match(pluginPage, /registerAssistantPageContextProvider/);
  assert.doesNotMatch(pluginPage, /<<<<<<<|=======|>>>>>>>/);
  assert.match(pluginPage, /registerDesktopActionProviderForScope\(\s*"embeddedWeb"/);
  assert.match(pluginPage, /surfaceId\?: string/);
  assert.match(pluginPage, /skipContextRegistration\?: boolean/);
  assert.match(pluginPage, /loadInitialEmbeddedUrlDirectly\?: boolean/);
  assert.match(pluginPage, /suppressInitialLoadingCopy\?: boolean/);
  assert.match(pluginPage, /const surfaceId = surfaceIdProp\?\.trim\(\) \|\| pluginId/);
  assert.match(pluginPage, /resolveAgentWebclientWsSource/);
  assert.match(pluginPage, /wsSource/);
  assert.match(pluginPage, /registerPluginSurfaceWebviewRef\(surfaceId, webviewRef\)/);
  assert.match(pluginPage, /const webviewOriginSrcUrl = useMemo\([\s\S]{0,120}buildPluginWebviewSrcUrl\(embeddedUrl\)/);
  assert.match(pluginPage, /const webviewDirectLoadScope = \[[\s\S]{0,160}webviewOriginSrcUrl/);
  assert.match(pluginPage, /initialWebviewSrcRef\.current\?\.scope !== webviewDirectLoadScope/);
  assert.match(pluginPage, /loadInitialEmbeddedUrlDirectly[\s\S]{0,120}\?\s*\(initialWebviewSrcRef\.current\?\.url \?\? embeddedUrl\)[\s\S]{0,80}:\s*webviewOriginSrcUrl/);
  const taskBoardPage = readSourceFile("src", "renderer", "pages", "task-board", "TaskBoardPage.tsx");
  assert.match(taskBoardPage, /loadInitialEmbeddedUrlDirectly/);
  assert.match(taskBoardPage, /suppressInitialLoadingCopy/);
  assert.match(taskBoardPage, /surfaceId="agent-webclient-task-board-chat"/);
  assert.match(pluginPage, /service\?\.status !== "running"[\s\S]{0,80}\|\|\s*skipContextRegistration/);
  assert.match(pluginPage, /!embeddedUrl[\s\S]{0,80}\|\|\s*skipContextRegistration/);
  assert.match(pluginPage, /tryReadPluginWebviewPageContext/);
  assert.match(pluginPage, /buildPluginWebviewFallbackContext/);
  assert.match(pluginPage, /webview\.executeJavaScript/);
  assert.match(pluginPage, /kind:\s*"webview"/);
  assert.match(pluginPage, /webContentsId/);
  assert.doesNotMatch(pluginPage, /window\.electronAPI\.embeddedWeb\.executeInFrame/);
  assert.doesNotMatch(pluginPage, /frameMatchUrl/);
  assert.match(pluginPage, /READ_PAGE_DATA_SCRIPT/);
  assert.match(pluginPage, /EXTRACT_STRUCTURED_SCRIPT/);
  assert.match(pluginPage, /buildInteractElementScript/);
  assert.match(pluginPage, /const webviewRenderKey = useMemo/);
  assert.doesNotMatch(pluginPage, /iframe/);
  assert.doesNotMatch(pluginPage, /正在等待页面样式与资源加载完成/);
  assert.match(pluginPage, /webviewLoadedChromeErrorPage/);
  assert.match(pluginPage, /chrome-error:\/\//);
  assert.match(pluginPage, /setWebviewRetryNonce/);
  assert.match(pluginPage, /refreshServices/);
  assert.match(pluginPage, /embedded-plugin-error/);
  assert.match(pluginPage, /buildAgentWebclientDesktopContext\(\s*getCurrentPageContextSnapshot\(\),?\s*\)/);
  assert.match(pluginPage, /seedAgentWebclientAccessToken/);
  assert.match(pluginPage, /buildAgentWebclientAccessTokenInjectionScript/);
  assert.match(pluginPage, /getServiceWebviewPreloadUrl\(\)/);
  assert.match(pluginPage, /if \(!bridgeReady \|\| !serviceWebviewPreloadUrl\) \{[\s\S]{0,80}return undefined;/);
  assert.match(pluginPage, /bridgeReady,[\s\S]{0,120}serviceWebviewPreloadUrl,[\s\S]{0,120}webviewRenderKey/);
  assert.match(pluginPage, /if \(active === false \|\| !bridgeReady \|\| !serviceWebviewPreloadUrl\) \{[\s\S]{0,80}return;[\s\S]{0,120}seedAgentWebclientAccessToken\(\)/);
  assert.match(pluginPage, /\[\s*active,\s*bridgeReady,\s*embeddedUrl,\s*service\?\.id,\s*serviceWebviewPreloadUrl,\s*webviewRenderKey,\s*\]/);
  assert.match(pluginPage, /function requestDirectWebviewRouteLoad\(\)/);
  assert.match(pluginPage, /!loadInitialEmbeddedUrlDirectly \|\| !embeddedUrl/);
  assert.match(pluginPage, /normalizedCurrentUrl === embeddedUrl/);
  assert.match(pluginPage, /buildClientSideRouteNavigationScript/);
  assert.match(directRouteLoadBlock, /currentParsed\.origin === targetParsed\.origin/);
  assert.match(directRouteLoadBlock, /targetWebview\.executeJavaScript\(/);
  assert.match(pluginPage, /window\.history\.pushState/);
  assert.match(pluginPage, /PopStateEvent\("popstate"/);
  assert.match(pluginPage, /targetWebview\.loadURL\(embeddedUrl\)/);
  assert.match(pluginPage, /\[\s*active,\s*bridgeReady,\s*embeddedUrl,\s*loadInitialEmbeddedUrlDirectly,\s*serviceWebviewPreloadUrl,\s*webviewRenderKey,\s*webviewSrcUrl,\s*\]/);
  assert.match(pluginPage, /suppressInitialLoadingCopy\s*\?\s*\(/);
  assert.match(pluginPage, /aria-label=\{`\$\{serviceDisplayName\} 正在加载`\}/);
  assert.match(pluginPage, /webviewRef\.current = node/);
  assert.doesNotMatch(pluginPage, /!webviewRef\.current && \(webviewRef\.current = node\)/);
  assert.match(sendBridgeMessageBlock, /webviewRef\.current\?\.send\(SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL,\s*payload\)/);
  assert.doesNotMatch(sendBridgeMessageBlock, /executeJavaScript/);
  assert.match(sendPluginRouteBlock, /webviewRef\.current\?\.send\(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL,\s*payload\)/);
  assert.doesNotMatch(sendPluginRouteBlock, /executeJavaScript/);
  assert.match(pluginPage, /buildAgentWebclientAccessTokenInjectionScript/);
  assert.doesNotMatch(pluginPage, /agentWebclientTokenReloadTimerRef/);
  assert.doesNotMatch(pluginPage, /webviewRef\.current\?\.reload\(\)/);
  assert.match(pluginPage, /issueAccessToken\("missing"\)/);
  assert.match(pluginPage, /agent_webclient_seed_/);
  assert.match(pluginPage, /handleServiceWebviewBridgeMessage/);
  assert.match(serviceWebviewBridgeHost, /SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE/);
  assert.match(serviceWebviewBridgeHost, /AGENT_APP_CLIPBOARD_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeHost, /DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeHost, /DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeHost, /DESKTOP_DOWNLOAD_FILE_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeHost, /DESKTOP_SCREENSHOT_CAPTURE_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeHost, /DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeReserved, /media\.microphone/);
  assert.match(serviceWebviewBridgeReserved, /media\.camera/);
  assert.doesNotMatch(serviceWebviewBridgeReserved, /screen\.capture/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_SCREENSHOT_CAPTURE_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE/);
  assert.match(serviceWebviewPreload, /sendToHost/);
  assert.doesNotMatch(serviceWebviewPreload, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(serviceWebviewPreload, /sendToMain/);
  assert.match(serviceWebviewPreload, /ipcRenderer\.on\(SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL/);
  assert.match(serviceWebviewPreload, /ipcRenderer\.on\(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL/);
  assert.match(serviceWebviewPreload, /ipcRenderer\.on\(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL/);
  assert.match(serviceWebviewPreload, /SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL/);
  assert.match(serviceWebviewPreload, /DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE/);
  assert.match(serviceWebviewPreload, /ipcRenderer\.on\(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL/);
  assert.match(serviceWebviewPreload, /payload\.type !== DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE/);
  assert.match(serviceWebviewPreload, /window\.dispatchEvent\(new CustomEvent\(PRELOAD_TO_PAGE_EVENT/);
  assert.match(serviceWebviewPreload, /window\.dispatchEvent\(new CustomEvent\(PRELOAD_TO_PAGE_ACTION_EVENT/);
  assert.match(serviceWebviewMainWorld, /MessageEvent\("message"/);
  assert.match(serviceWebviewMainWorld, /__ZENMIND_DESKTOP_WEBVIEW_BRIDGE__/);
  assert.match(serviceWebviewMainWorld, /agent-webclient\.appAccessToken/);
  assert.match(serviceWebviewMainWorld, /agent-webclient\.appAuthContext/);
  assert.match(serviceWebviewMainWorld, /window\.__AGENT_APP_ACCESS_TOKEN/);
  assert.match(serviceWebviewMainWorld, /resolveServiceWebviewWsMonitorUrl/);
  assert.match(serviceWebviewMainWorld, /window\.WebSocket = ZenmindServiceWebviewWebSocket/);
  assert.match(serviceWebviewMainWorld, /initialWsSource/);
  assert.match(serviceWebviewPreload, /sendBridgeDebug/);
  assert.match(serviceWebviewPreload, /preload-installed/);
  assert.match(serviceWebviewPreload, /auth-response-seeded/);
  assert.match(serviceWebviewPreload, /SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES/);
  assert.match(serviceWebviewPreload, /recentForwardedBridgeRequestKeys/);
  assert.match(serviceWebviewPreload, /function forwardDesktopBridgeRequest\(/);
  assert.match(serviceWebviewPreload, /const requestKey = `\$\{value\.type\}:\$\{value\.requestId\}`/);
  assert.match(serviceWebviewPreload, /DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE/);
  assert.match(mainProcess, /getServiceWebviewPreloadUrl\(\)[\s\S]{0,120}pathToFileURL\(getServiceWebviewPreloadPath\(\)\)\.toString\(\)/);
  assert.match(shellHandlers, /ipcMain\.handle\("desktopDialog\.selectDirectory"/);
  assert.match(shellHandlers, /ipcMain\.handle\("desktopShell\.openPath"/);
  assert.match(shellHandlers, /ipcMain\.handle\("desktopDownloads\.saveFile"/);
  assert.match(shellHandlers, /ipcMain\.handle\("desktopScreenshot\.capture"/);
  assert.match(windowManager, /webPreferences\.preload = input\.servicePreloadPath/);
  assert.match(servicesHandlers, /ipcMain\.handle\("plugins\.getServiceWebviewPreloadUrl", async \(\) => getServiceWebviewPreloadUrl\(\)\)/);
  assert.match(preload, /getServiceWebviewPreloadUrl:\s*\(\) => ipcRenderer\.invoke\("plugins\.getServiceWebviewPreloadUrl"\)/);
  assert.match(preload, /desktopDialog:[\s\S]{0,120}selectDirectory:\s*\(\) => ipcRenderer\.invoke\("desktopDialog\.selectDirectory"\)/);
  assert.match(preload, /desktopScreenshot:[\s\S]{0,120}capture:\s*\(\) => ipcRenderer\.invoke\("desktopScreenshot\.capture"\)/);
  assert.match(preload, /desktopShell:[\s\S]{0,140}openPath:\s*\(targetPath: string\) => ipcRenderer\.invoke\("desktopShell\.openPath", targetPath\)/);
  assert.match(preload, /desktopDownloads:[\s\S]{0,140}saveFile:\s*\(input\) => ipcRenderer\.invoke\("desktopDownloads\.saveFile", input\)/);
  assert.match(contracts, /getServiceWebviewPreloadUrl:\s*\(\) => Promise<string>/);
  assert.match(contracts, /desktopDialog:[\s\S]{0,120}selectDirectory:\s*\(\) => Promise<\{ ok: boolean; path\?: string; message\?: string \}>/);
  assert.match(contracts, /desktopShell:[\s\S]{0,120}openPath:\s*\(targetPath: string\) => Promise<\{ ok: boolean; path\?: string; message\?: string \}>/);
  assert.match(contracts, /desktopShell:[\s\S]{0,220}moveWindowBy:\s*\(delta: \{ x: number; y: number \}\) => Promise<\{ ok: boolean; message\?: string \}>/);
  assert.match(contracts, /desktopDownloads:[\s\S]{0,220}saveFile:\s*\(input: \{[\s\S]{0,160}dataBase64\?: string;[\s\S]{0,120}\}\) => Promise<\{ ok: boolean; path\?: string; message\?: string \}>/);
  assert.match(globalStyles, /\.embedded-plugin-error\s*\{/);
});

test("embedded cdp exposes service frontends as webview surfaces", () => {
  const cdpIntegration = readSourceFile("src", "main", "cdp-integration.ts");

  assert.match(cdpIntegration, /createEmbeddedCdpServiceSurface/);
  assert.match(cdpIntegration, /kind:\s*"webview"/);
  assert.match(cdpIntegration, /webContentsId:\s*input\.contents\?\.id/);
  assert.match(cdpIntegration, /active:\s*snapshotMatchesService/);
  assert.match(cdpIntegration, /currentPageSnapshot\.surfaceId === input\.service\.id/);
  assert.doesNotMatch(cdpIntegration, /failed to list iframe targets/);
});

test("assistant chat export writes directly to the download location", () => {
  const assistantHandlers = readSourceFile("src", "main", "ipc", "assistant-handlers.ts");
  const downloadPaths = readSourceFile("src", "main", "download-paths.ts");
  const exportPathBlock =
    downloadPaths.match(/export function getAssistantExportDefaultPath[\s\S]*?export function getDesktopDownloadDefaultPath/u)?.[0] ?? "";
  const saveExportBlock =
    assistantHandlers.match(/async function saveAssistantChatExport[\s\S]*?\/\/ ---------------------------------------------------------------------------/u)?.[0] ?? "";

  assert.match(exportPathBlock, /platform === "win32" \|\| platform === "darwin"[\s\S]*?app\.getPath\("downloads"\)/u);
  assert.match(downloadPaths, /export async function getAvailableFilePath/u);
  assert.match(saveExportBlock, /const exportPath = await getAvailableFilePath\(getAssistantExportDefaultPath\(app, result\.filename, platform\), \{/u);
  assert.match(saveExportBlock, /fs\.promises\.writeFile\(exportPath, result\.bytes\)/u);
  assert.match(readSourceFile("src", "main", "copilot", "core", "agent-platform-bridge.ts"), /\/api\/chat\/export\?chatId=/u);
  assert.doesNotMatch(readSourceFile("src", "main", "copilot", "core", "agent-platform-bridge.ts"), /\/api\/chat-export/u);
  assert.doesNotMatch(saveExportBlock, /showSaveDialog/u);
});

test("assistant entrypoints restore core services before opening embedded webclient", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const quickRouting = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "quick-copilot", "routing.ts"),
    "utf8"
  );
  const trayController = fs.readFileSync(
    path.join(projectRoot, "src", "main", "app-shell", "tray.ts"),
    "utf8"
  );

  assert.match(mainProcess, /async function ensureAssistantTargetServicesRunning/);
  assert.match(mainProcess, /for \(const serviceId of STARTUP_RESTORE_SERVICE_ORDER\)/);
  assert.match(mainProcess, /await runServiceMutation\(\(\) => ensureAssistantTargetServicesRunning\(source\)\)/);
  assert.match(mainProcess, /async function showAssistantTargetWindow/);
  assert.match(
    mainProcess,
    /async function showAssistantTargetWindow[\s\S]*?showMainWindow\(targetPath\);[\s\S]*?await runServiceMutation\(\(\) => ensureAssistantTargetServicesRunning\(source\)\)/
  );
  assert.match(mainProcess, /const ASSISTANT_TARGET_PATH = AGENT_WEBCLIENT_TARGET_PATH;/);
  assert.doesNotMatch(mainProcess, /const ASSISTANT_TARGET_PATH = "\/service\/agent-webclient";/);
  assert.match(quickRouting, /function createAgentWebclientRoute/);
  assert.match(quickRouting, /return AGENT_WEBCLIENT_TARGET_PATH;/);
  assert.doesNotMatch(quickRouting, /return "\/service\/agent-webclient";/);
  assert.match(quickRouting, /\/agent\/\$\{encodeURIComponent\(agentKey\)\}/);
  assert.doesNotMatch(quickRouting, /embedPath=\$\{encodeURIComponent\(embedPath\)\}/);
  assert.match(mainProcess, /openAgent: scheduleQuickAgentOpenRequest/);
  assert.match(mainProcess, /async function openAssistantFromDesktopPet/);
  assert.match(mainProcess, /async function openAssistantFromDesktopPet\(\) \{[\s\S]{0,120}showMainWindow\(\);/);
  assert.doesNotMatch(mainProcess, /showAssistantTargetWindow\(\s*"desktop-pet"/);
  assert.match(mainProcess, /targetWindow\.webContents\.send\("app\.openAssistantWorker"/);
  assert.match(mainProcess, /async function openAssistantWorker/);
  assert.match(mainProcess, /showAssistantTargetWindow\(\s*"assistant-worker",[\s\S]*?createAgentWebclientRoute/);
  assert.doesNotMatch(mainProcess, /AGENT_WEBCLIENT_APP_PATHNAMES/);
  assert.doesNotMatch(mainProcess, /scheduleAgentWebclientOpenRequest/);
  assert.doesNotMatch(mainProcess, /agent:load-chat/);
  assert.match(trayController, /openAssistantTarget\("tray-click"\)/);
  assert.doesNotMatch(trayController, /tray\.on\("click", \(\) => showMainWindow\(ASSISTANT_TARGET_PATH\)\)/);
});

test("tray icon lookup prefers active brand assets in dev and packaged resources in builds", () => {
  const mainProcess = readSourceFile("src", "main", "index.ts");
  const trayController = readSourceFile("src", "main", "app-shell", "tray.ts");
  const helper = trayController.match(/export function getAppTrayIconCandidatePaths[\s\S]*?\n\}\n\nexport class/u)?.[0] ?? "";
  const packagedBranch = helper.match(/^  if \(options\.isPackaged\) \{[\s\S]*?^  \}/mu)?.[0] ?? "";
  const packagedDarwinBranch = packagedBranch.match(/if \(options\.platform === "darwin"\) \{[\s\S]*?^    \}/mu)?.[0] ?? "";
  const macDevBranch = helper.match(/^  if \(options\.platform === "darwin"\) \{[\s\S]*?^  \}/mu)?.[0] ?? "";
  const windowsDevBranch = helper.match(/^  if \(options\.platform === "win32"\) \{[\s\S]*?^  \}/mu)?.[0] ?? "";
  const createIconMethod = trayController.match(/private createIcon\(\) \{[\s\S]*?^  \}/mu)?.[0] ?? "";

  assert.match(mainProcess, /new AppTrayController\(\{[\s\S]*?isPackaged:\s*app\.isPackaged/u);
  assert.match(trayController, /export function getAppTrayIconCandidatePaths/);
  assert.match(trayController, /function platformFallbackIconPath/);
  assert.match(trayController, /APP_ICON_ASSET_DIRECTORIES\.brandAssets/);
  assert.doesNotMatch(trayController, /APP_ICON_ASSET_DIRECTORIES\.public/);
  assert.doesNotMatch(trayController, /APP_ICON_ASSET_FILENAMES\.brandMark/);
  assert.match(trayController, /if \(options\.platform === "darwin"\)/);
  assert.match(trayController, /if \(options\.platform === "win32"\)/);
  assert.match(createIconMethod, /if \(this\.options\.platform === "darwin"\)\s*\{[\s\S]*?resizedIcon\.setTemplateImage\(true\);[\s\S]*?\}/);

  assert(
    indexOfRequired(packagedDarwinBranch, "packagedResourcePath(options, APP_ICON_ASSET_FILENAMES.trayIcon)") <
      indexOfRequired(packagedDarwinBranch, "rendererTrayIconPath"),
    "macOS packaged tray lookup should prefer the packaged tray template before renderer assets"
  );
  assert(
    indexOfRequired(packagedDarwinBranch, "rendererTrayIconPath") <
      indexOfRequired(packagedDarwinBranch, "generatedTrayIconPath"),
    "macOS packaged tray lookup should keep generated tray template before app tile fallback"
  );
  assert(
    indexOfRequired(packagedDarwinBranch, "generatedTrayIconPath") <
      indexOfRequired(packagedDarwinBranch, "packagedResourcePath(options, APP_ICON_ASSET_FILENAMES.brandIcon)"),
    "macOS packaged tray lookup should keep template tray art before the app tile"
  );
  assert(
    indexOfRequired(packagedBranch, "packagedResourcePath(options, APP_ICON_ASSET_FILENAMES.trayIcon)") <
      indexOfRequired(packagedBranch, "rendererTrayIconPath"),
    "non-mac packaged tray lookup should prefer packaged tray resources before renderer assets"
  );

  assert(
    indexOfRequired(macDevBranch, "generatedTrayIconPath") <
      indexOfRequired(macDevBranch, "fallbackIconPath"),
    "macOS dev tray lookup should prefer the active generated tray template"
  );
  assert(
    indexOfRequired(macDevBranch, "fallbackIconPath") <
      indexOfRequired(macDevBranch, "generatedBrandIconPath"),
    "macOS dev tray lookup should use the app tile only after tray fallbacks"
  );
  assert.doesNotMatch(macDevBranch, /generatedBrandMarkPath/);
  assert.doesNotMatch(macDevBranch, /rendererTrayIconPath/);
  assert.doesNotMatch(windowsDevBranch, /setTemplateImage/);

  assert(
    indexOfRequired(windowsDevBranch, "fallbackIconPath") <
      indexOfRequired(windowsDevBranch, "generatedTrayIconPath"),
    "Windows dev tray lookup should prefer the active build ico before generated tray fallback"
  );
  assert.doesNotMatch(windowsDevBranch, /rendererTrayIconPath/);
});

test("native assistant page context captures shell sidebar, left region, and modal content separately", () => {
  const pageContextService = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "page-context", "assistantPageContext.ts"),
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

test("control center renderer text is routed through i18n", () => {
  const controlCenter = readSourceFile(
    "src",
    "renderer",
    "pages",
    "control-center",
    "ControlCenterPage.tsx"
  );

  assert.match(controlCenter, /useI18n/);
  assert.doesNotMatch(controlCenter, /[\p{Script=Han}]/u);
  assert.doesNotMatch(controlCenter, /getServiceDisplayName/);
});

test("service logs open in a separate floating log viewer window", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const servicesHandlers = readSourceFile("src", "main", "ipc", "services-handlers.ts");
  const logViewerWindow = fs.readFileSync(
    path.join(projectRoot, "src", "main", "app-shell", "log-viewer-window.ts"),
    "utf8"
  );
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = readSharedContractsSource();
  const appShell = readAppShellSource();
  const controlCenter = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "control-center", "ControlCenterPage.tsx"),
    "utf8"
  );
  const logViewerPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "LogViewerPage.tsx"),
    "utf8"
  );

  assert.match(mainProcess, /LogViewerWindowController/);
  assert.match(mainProcess, /openLogViewerWindow\(request: ServiceOpenLogViewerRequest\)/);
  assert.match(logViewerWindow, /private window: BrowserWindow \| null = null/);
  assert.match(logViewerWindow, /private createWindow\(\)/);
  assert.match(servicesHandlers, /services\.openLogViewer/);
  assert.match(logViewerWindow, /loadRendererRoute\(targetWindow, routePath\)/);
  assert.match(logViewerWindow, /width:\s*1240,[\s\S]*?height:\s*860,[\s\S]*?minWidth:\s*760,[\s\S]*?minHeight:\s*520,/);
  assert.match(logViewerWindow, /ownerWindow \? \{ parent: ownerWindow, modal: false \} : \{\}/);
  assert.doesNotMatch(logViewerWindow, /setAlwaysOnTop/);
  assert.doesNotMatch(logViewerWindow, /setVisibleOnAllWorkspaces/);
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
  const globalStyles = readRendererStyles();

  assert.doesNotMatch(logViewerPage, /function AutoScrollIcon/);
  assert.doesNotMatch(logViewerPage, /function WbAutoIcon/);
  assert.match(logViewerPage, /function RotateAutoIcon/);
  assert.match(logViewerPage, /viewBox="0 -960 960 960"/);
  assert.match(logViewerPage, /M312-320h64l32-92h146l32 92h62L512-680h-64L312-320/);
  assert.match(logViewerPage, /<RotateAutoIcon \/>/);
  assert.match(logViewerPage, /function ArrowUpwardIcon/);
  assert.match(logViewerPage, /function ArrowDownwardIcon/);
  assert.match(logViewerPage, /const followToggleLabel = tailFollowEnabled[\s\S]{0,120}t\("logViewer\.follow\.disable"\)[\s\S]{0,120}t\("logViewer\.follow\.enable"\)/);
  assert.match(logViewerPage, /aria-label=\{followToggleLabel\}/);
  assert.match(logViewerPage, /className="log-viewer-live-dot"/);
  assert.match(logViewerPage, /aria-hidden="true"/);
  assert.match(logViewerPage, /aria-label=\{t\("logViewer\.scrollTop"\)\}/);
  assert.match(logViewerPage, /aria-label=\{t\("logViewer\.scrollBottom"\)\}/);
  assert.match(logViewerPage, /handleScrollToTop/);
  assert.match(logViewerPage, /handleScrollToBottom/);
  assert.match(logViewerPage, /scrollJumpTarget/);
  assert.match(logViewerPage, /setTailFollowEnabled\(false\)/);
  assert.doesNotMatch(logViewerPage, /log-viewer-drag-region/);
  assert.match(logViewerPage, /log-viewer-window-drag-zone/);
  assert.match(globalStyles, /\.log-viewer-window-drag-zone\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*0;[\s\S]*?app-region:\s*drag;/);
  assert.doesNotMatch(globalStyles, /\.log-viewer-drag-region\s*\{/);
  assert.match(globalStyles, /\.log-viewer-head\s*\{[\s\S]*?app-region:\s*no-drag;/);
  assert.match(globalStyles, /\.log-viewer-page\s*\{[\s\S]*?background:\s*var\(--desktop-ui-bg\);[\s\S]*?color:\s*var\(--desktop-ui-text\);/);
  assert.match(globalStyles, /\.log-viewer-head\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--desktop-ui-border\);[\s\S]*?background:\s*var\(--desktop-ui-card\);/);
  assert.match(globalStyles, /\.log-viewer-tip-row\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--desktop-ui-border-soft\);[\s\S]*?background:\s*var\(--desktop-ui-card\);/);
  assert.match(globalStyles, /\.log-viewer-live-dot\s*\{[\s\S]*?animation:\s*log-viewer-live-dot-breathe\s*1\.6s\s*ease-in-out\s*infinite;/);
  assert.match(globalStyles, /@keyframes\s+log-viewer-live-dot-breathe\s*\{/);
  assert.match(globalStyles, /\.log-viewer-follow-toggle\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*30px;/);
  assert.match(globalStyles, /\.log-viewer-follow-toggle svg\s*\{[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;/);
  assert.match(globalStyles, /\.log-viewer-follow-toggle\.is-active\s*\{[\s\S]*?border-color:\s*rgba\(var\(--desktop-ui-success-rgb\),\s*0\.36\);[\s\S]*?background:\s*rgba\(var\(--desktop-ui-success-rgb\),\s*0\.12\);[\s\S]*?color:\s*var\(--desktop-ui-success\);/);
  assert.match(globalStyles, /\.log-viewer-scroll-top\s*\{/);
  assert.match(globalStyles, /\.log-viewer-scroll-bottom\s*\{/);
  assert.match(globalStyles, /\.log-viewer-body\s*\{[\s\S]*?padding:\s*8px\s*8px\s*12px;/);
  assert.match(globalStyles, /\.log-viewer-body\s*\{[\s\S]*?background:\s*var\(--desktop-ui-code-bg\);/);
  assert.match(globalStyles, /\.log-viewer-content\s*\{[\s\S]*?padding:\s*8px\s*10px;/);
  assert.match(globalStyles, /\.log-viewer-content\s*\{[\s\S]*?color:\s*var\(--desktop-ui-code-text\);/);
  assert.match(globalStyles, /\.log-viewer-content\s*\{[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?overflow-wrap:\s*anywhere;/);
});

test("service log viewer keeps find controls inside the log area", () => {
  const logViewerPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "LogViewerPage.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();

  assert.match(logViewerPage, /aria-label=\{t\("logViewer\.find\.aria"\)\}/);
  assert.match(logViewerPage, /handleOpenSearch/);
  assert.match(logViewerPage, /handleCloseSearch/);
  assert.match(logViewerPage, /aria-label=\{t\("logViewer\.find\.close"\)\}/);
  assert.match(logViewerPage, /selectRelativeMatch\(-1\)/);
  assert.match(logViewerPage, /selectRelativeMatch\(1\)/);
  assert.match(logViewerPage, /renderLogContent\(\s*joinedContent,\s*matches,\s*activeMatchIndex,\s*\)/);
  assert.doesNotMatch(logViewerPage, /className="log-viewer-toolbar"/);
  assert.match(globalStyles, /\.log-viewer-body-shell\s*\{/);
  assert.match(globalStyles, /\.log-viewer-find-panel\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*20px;[\s\S]*?top:\s*12px;[\s\S]*?width:\s*min\(520px,\s*calc\(50%\s*-\s*20px\)\);/);
  assert.match(globalStyles, /\.log-viewer-find-close\s*\{/);
  assert.match(globalStyles, /\.log-match\.is-active\s*\{/);
});

test("service log viewer renderer text is routed through i18n", () => {
  const logViewerPage = readSourceFile(
    "src",
    "renderer",
    "pages",
    "LogViewerPage.tsx"
  );

  assert.match(logViewerPage, /useI18n/);
  assert.doesNotMatch(logViewerPage, /[\p{Script=Han}]/u);
});

test("agent-platform monitor opens inside the service preview surface", () => {
  const authBridge = readSourceFile("src", "shared", "auth-bridge.ts");
  const app = readSourceFile("src", "renderer", "App.tsx");
  const controlCenter = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "control-center", "ControlCenterPage.tsx"),
    "utf8"
  );
  const embeddedSurfaceHosts = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx"
  );
  const pluginPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "plugin", "PluginPage.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const monitorPagePath = path.join(projectRoot, "src", "renderer", "pages", "AgentPlatformMonitorPage.tsx");
  const monitorStylesPath = path.join(projectRoot, "src", "renderer", "styles", "agent-platform-monitor.css");

  assert.match(authBridge, /serviceId === "agent-platform"[\s\S]{0,180}url\.pathname = "\/monitor"/);
  assert.match(authBridge, /accessToken[\s\S]{0,180}searchParams\.set\("access_token"/);
  assert.match(embeddedSurfaceHosts, /pluginId === "identity-center" \|\| pluginId === "agent-platform"/);
  assert.match(pluginPage, /service\.id !== "agent-platform"/);
  assert.match(pluginPage, /issueAccessToken\("missing"\)/);
  assert.doesNotMatch(app, /location\.pathname === "\/agent-platform-monitor"/);
  assert.match(controlCenter, /activeDetailService\.id === "agent-platform"/);
  assert.match(controlCenter, /navigate\(\s*`\/service\/\$\{activeDetailService\.id\}`/);
  assert.doesNotMatch(controlCenter, /window\.electronAPI\.services\.openAgentPlatformMonitor/);
  assert.match(controlCenter, /activeDetailService\.status !== "running"/);
  assert.equal(fs.existsSync(monitorPagePath), false);
  assert.equal(fs.existsSync(monitorStylesPath), false);
  assert.doesNotMatch(globalStyles, /\.agent-monitor-page/);
});

test("assistant dock opens the agent webclient copilot in right-side embedded mode", () => {
  const appShell = readAppShellSource();
  const dockComponent = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "sidebar-copilot", "AgentWebclientCopilotDock.tsx"),
    "utf8"
  );

  assert.match(appShell, /const AGENT_WEBCLIENT_COPILOT_PATH = "\/copilot"/);
  assert.match(appShell, /assistantCopilotOpen \? "has-assistant-dock-full" : ""/);
  assert.match(appShell, /window\.electronAPI\.onOpenAssistantWorker[\s\S]{0,180}openAssistantDock\(request\)/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.match(dockComponent, /skipContextRegistration/);
  assert.match(dockComponent, /loadInitialEmbeddedUrlDirectly/);
  assert.doesNotMatch(appShell, /<AssistantDock/);
  assert.doesNotMatch(appShell, /openAssistantDock\("compact"\)/);
  assert.doesNotMatch(appShell, /onOpenAssistantWorker[\s\S]{0,180}openAssistantDock\("compact"\)/);
});

test("option-space quick assistant route opens the agent webclient copilot surface", () => {
  const nativeQuickAssistantPath = path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx");
  const appShell = readAppShellSource();
  const quickCopilotRoute = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "quick-copilot", "QuickCopilotRoute.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const quickCopilotWindowController = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "quick-copilot", "window.ts"),
    "utf8"
  );
  const quickAssistantWindow = fs.readFileSync(path.join(projectRoot, "src", "main", "copilot", "quick-copilot", "quick-copilot.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = readSharedContractsSource();
  const quickWebCopilotStyles = globalStyles.slice(
    globalStyles.indexOf(".quick-web-copilot,"),
    globalStyles.indexOf(".quick-web-copilot .pan-page")
  );
  const quickAssistantWindowCreation = quickCopilotWindowController.slice(
    quickCopilotWindowController.indexOf("private createWindow()"),
    quickCopilotWindowController.indexOf("hideForNativeDialog()")
  );
  const preloadQuickAssistantApi = preload.slice(
    preload.indexOf("quickAssistant: {"),
    preload.indexOf("webs:", preload.indexOf("quickAssistant: {"))
  );
  const contractQuickAssistantApi = contracts.slice(
    contracts.indexOf("quickAssistant: {"),
    contracts.indexOf("webs:", contracts.indexOf("quickAssistant: {"))
  );

  assert.equal(fs.existsSync(nativeQuickAssistantPath), false);
  assert.match(quickCopilotRoute, /function QuickCopilotRoute/);
  assert.match(appShell, /location\.pathname === "\/quick-assistant"[\s\S]{0,180}<QuickCopilotRoute \/>/);
  assert.match(quickCopilotRoute, /embedPath=\{AGENT_WEBCLIENT_COPILOT_PATH\}/);
  assert.match(quickCopilotRoute, /pluginId="agent-webclient"/);
  assert.match(quickCopilotRoute, /quickAssistantAgentKey/);
  assert.match(quickCopilotRoute, /data-open-agent-key=\{quickAssistantAgentKey\}/);
  assert.match(quickCopilotRoute, /quickAssistant\.openControlCenter/);
  assert.match(globalStyles, /\.quick-web-copilot\s*,/);
  assert.match(globalStyles, /\.quick-web-copilot-status/);
  assert.match(quickWebCopilotStyles, /border-radius:\s*10px;/);
  assert.doesNotMatch(quickWebCopilotStyles, /border-radius:\s*24px;/);
  assert.match(quickCopilotWindowController, /getQuickAssistantWebCopilotBounds/);
  assert.match(quickCopilotWindowController, /readAssistantSettings\(this\.options\.app\)/);
  assert.match(quickCopilotWindowController, /!quickSettings\.quickAssistantEnabled/);
  assert.match(mainProcess, /ensureAssistantTargetServicesRunning\("quick-assistant"\)/);
  assert.match(quickCopilotWindowController, /agentKey:\s*quickSettings\.quickAssistantAgentKey/);
  assert.match(mainProcess, /quickCopilotWindowController\.getWindow\(\)/);
  assert.match(quickAssistantWindowCreation, /webviewTag:\s*true/);
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
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.tsx"),
    "utf8"
  );
  const settingsPageCss = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.css"),
    "utf8"
  );

  assert.match(settingsPage, /const desktopPetSupported = isMac \|\| isWindows;/);
  assert.match(settingsPage, /if \(!desktopPetSupported\) \{[\s\S]{0,120}return;/);
  assert.match(settingsPage, /settings-pet-card/);
  assert.match(settingsPage, /settings-pet-appearance-panel/);
  assert.match(settingsPage, /settings-appearance-pet-card/);
  assert.doesNotMatch(settingsPage, /settings\.desktopPet\.currentStatus/);
  assert.match(settingsPage, /case "assistant"[\s\S]*?desktopPetSupported \? \(/);
  assert.match(settingsPage, /const shouldReadDesktopPetState = desktopPetSupported && activeSection === "assistant";/);
  assert.match(settingsPage, /nextState\.appearanceId === appearanceId/);
  assert.match(settingsPage, /settings\.desktopPet\.noticeAppearanceFailed/);
  assert.match(settingsPage, /desktop-pet-appearance-list/);
  assert.match(settingsPage, /aria-disabled=\{!desktopPetEnabled\}/);
  assert.match(settingsPage, /disabled=\{!desktopPetEnabled \|\| selected \|\| Boolean\(desktopPetAppearancePending\)\}/);
  assert.match(settingsPage, /let actionLabel = t\("settings\.desktopPet\.select"\)/);
  assert.match(settingsPage, /actionLabel = desktopPetEnabled \? t\("settings\.desktopPet\.selected"\) : t\("settings\.desktopPet\.saved"\)/);
  assert.match(settingsPage, /const idlePreviewAsset = appearance\.states\.idle;/);
  assert.match(settingsPage, /const idlePreviewFrameCount = Math\.max\(1,\s*Math\.round\(Number\(idlePreviewAsset\?\.frameCount\) \|\| 1\)\);/);
  assert.match(settingsPage, /idlePreviewAsset\?\.path === appearance\.preview && idlePreviewFrameCount > 1/);
  assert.match(settingsPage, /className="desktop-pet-appearance-sprite"/);
  assert.match(settingsPage, /backgroundImage:\s*`url\("\$\{appearance\.previewUrl\}"\)`/);
  assert.match(settingsPageCss, /\.desktop-pet-appearance-sprite\s*\{[\s\S]{0,120}width:\s*40px;[\s\S]{0,80}height:\s*43px;/);
  assert.match(settingsPageCss, /background-size:\s*calc\(40px \* var\(--desktop-pet-appearance-preview-frames,\s*1\)\) 43px;/);
  assert.match(settingsPageCss, /background-position:\s*0 0;/);
  assert.doesNotMatch(settingsPage, /disabled=\{Boolean\(desktopPetAppearancePending\) && !selected\}/);
  assert.doesNotMatch(settingsPage, /\?\?\s*"小宅"/);
});

test("desktop pet legacy agent aliases avoid inline display-name literals", () => {
  const petStatusClient = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "pet-copilot", "pet-status-client.ts"),
    "utf8"
  );

  assert.match(petStatusClient, /LEGACY_DESKTOP_PET_BOUND_AGENT_REQUEST_KEYS/);
  assert.doesNotMatch(petStatusClient, /requestedKey === "小宅"/);
});

test("desktop pet drag ends on lost pointer signals", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );
  const desktopPetController = readSourceFile("src", "main", "desktop-pet-controller.ts");

  assert.match(desktopPet, /lostpointercapture/);
  assert.match(desktopPet, /window\.addEventListener\("pointerup"/);
  assert.match(desktopPet, /window\.addEventListener\("mouseup"/);
  assert.match(desktopPet, /window\.addEventListener\("blur"/);
  assert.match(desktopPet, /window\.addEventListener\("contextmenu"/);
  assert.match(desktopPet, /document\.addEventListener\("visibilitychange"/);
  assert.match(desktopPetController, /clearTimer\(\);/);
  assert.match(desktopPetController, /webContents\.on\("context-menu"[\s\S]{0,120}options\.endDrag\(\)/);
});

test("desktop pet click opens the branded app without assistant sidebar copy", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );

  assert.match(desktopPet, /desktopPet\.openAssistant/);
  assert.match(desktopPet, /aria-label=\{`打开 \$\{PRODUCT_NAME\}`\}/);
  assert.doesNotMatch(desktopPet, /打开侧边栏助手/);
});

test("desktop pet base mode stays sprite-sized while bubble and preview modes expand separately", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const desktopPetController = readSourceFile("src", "main", "desktop-pet-controller.ts");
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );
  const petGeometry = fs.readFileSync(path.join(projectRoot, "src", "main", "copilot", "pet-copilot", "desktop-pet.ts"), "utf8");
  const globalStyles = readRendererStyles();

  assert.match(desktopPetController, /return shouldShowBubble \? "bubble" : "base";/);
  assert.doesNotMatch(mainProcess, /shouldHideDesktopPetForMainWindow/);
  assert.doesNotMatch(mainProcess, /syncDesktopPetWindowVisibility/);
  assert.match(petGeometry, /width:\s*176,/);
  assert.match(petGeometry, /height:\s*198/);
  assert.match(petGeometry, /bubble:\s*\{\s*width:\s*224,\s*height:\s*228/s);
  assert.match(petGeometry, /DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS:[\s\S]{0,80}Record<DesktopPetWindowMode/);
  assert.match(petGeometry, /"preview-expanded":\s*\{\s*x:\s*162,\s*y:\s*294,/s);
  assert.match(petGeometry, /"task-list-compact":\s*\{\s*x:\s*116,\s*y:\s*156,/s);
  assert.match(petGeometry, /"task-list":\s*\{\s*x:\s*148,\s*y:\s*236,/s);
  assert.match(petGeometry, /baseBounds\.x \+ DESKTOP_PET_VISIBLE_FOOTPRINT\.x - footprint\.x/);
  assert.match(petGeometry, /"task-list-compact":\s*\{\s*width:\s*340,\s*height:\s*282/s);
  assert.match(petGeometry, /"task-list":\s*\{\s*width:\s*392,\s*height:\s*360/s);
  assert.match(desktopPetController, /activeTasks\.length > 0[\s\S]{0,120}return activeTasks\.length <= 2 \? "task-list-compact" : "task-list";/);
  assert.match(desktopPet, /showPreviewPanel && previewPanel\?\.expanded \? "has-preview-expanded" : ""/);
  assert.match(desktopPet, /showPreviewPanel && !previewPanel\?\.expanded \? "has-preview-collapsed" : ""/);
  assert.match(globalStyles, /\.desktop-pet-hitbox\s*\{[\s\S]{0,160}position:\s*absolute;[\s\S]{0,80}inset:\s*0;/);
  assert.match(globalStyles, /\.desktop-pet-button\s*\{[\s\S]{0,160}position:\s*absolute;[\s\S]{0,120}left:\s*var\(--desktop-pet-button-left\);/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-tasks\s*\{[\s\S]{0,220}--desktop-pet-button-left:\s*130px;[\s\S]{0,80}--desktop-pet-button-top:\s*220px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-compact-tasks\s*\{[\s\S]{0,180}--desktop-pet-button-left:\s*98px;[\s\S]{0,80}--desktop-pet-button-top:\s*140px;/);
  assert.match(globalStyles, /\.desktop-pet-speech\s*\{[\s\S]{0,120}position:\s*absolute;[\s\S]{0,80}width:\s*216px;/);
  assert.match(globalStyles, /\.desktop-pet-task-panel\s*\{[\s\S]{0,160}position:\s*absolute;[\s\S]{0,180}width:\s*var\(--desktop-pet-task-panel-width,\s*320px\);/);
  assert.match(globalStyles, /\.desktop-pet-preview\s*\{[\s\S]{0,120}position:\s*absolute;[\s\S]{0,120}width:\s*336px;/);
  assert.match(globalStyles, /\.desktop-pet-speech\s*\{[\s\S]{0,700}box-shadow:\s*[\s\S]{0,120}0 14px 30px rgba\(30,\s*54,\s*105,\s*0\.16\)/);
  assert.match(globalStyles, /\.desktop-pet-image\s*\{[\s\S]{0,120}width:\s*96px;/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root:not\(\.has-bubble\):not\(\.has-preview\)\s+\.desktop-pet-image[\s\S]{0,120}width:\s*100%/);
});

test("desktop pet active task panel lists all agent tasks and opens chat rows", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );
  const desktopPetController = readSourceFile("src", "main", "desktop-pet-controller.ts");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const desktopPetHandlers = readSourceFile("src", "main", "ipc", "desktop-pet-handlers.ts");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = readSharedContractsSource();
  const globalStyles = readRendererStyles();

  assert.match(contracts, /interface DesktopPetTaskItem/);
  assert.match(contracts, /activeTasks:\s*DesktopPetTaskItem\[\]/);
  assert.match(contracts, /openTaskChat:\s*\(input:\s*\{ agentKey: string; chatId: string \}\)/);
  assert.match(desktopPetController, /createDesktopPetActiveTasksFromNavigationSnapshot/);
  assert.match(desktopPetController, /chat\.hasPendingAwaiting \? "awaiting" : "running"/);
  assert.match(desktopPetController, /DESKTOP_PET_TASK_TITLE_FALLBACK = "未命名任务"/);
  assert.match(desktopPetController, /left\.status === "awaiting" \? -1 : 1/);
  assert.match(mainProcess, /appState\.assistantNavigationStatusClient\?\.getSnapshot\(\)/);
  assert.match(mainProcess, /function emitAssistantNavigationAgentsChanged[\s\S]*?refreshDesktopPetState\(\);/);
  assert.match(mainProcess, /openDesktopPetTaskChat/);
  assert.match(desktopPetHandlers, /desktopPet\.openTaskChat/);
  assert.match(preload, /openTaskChat: \(input\) => ipcRenderer\.invoke\("desktopPet\.openTaskChat", input\)/);
  assert.match(desktopPet, /DESKTOP_PET_TASK_VISIBLE_LIMIT = 3/);
  assert.match(desktopPet, /const showTaskPanel = !isDragging && activeTasks\.length > 0/);
  assert.match(desktopPet, /const showPreviewPanel = !isDragging && !showTaskPanel && Boolean\(previewPanel\)/);
  assert.match(desktopPet, /desktop-pet-task-panel/);
  assert.match(desktopPet, /desktopPet\.openTaskChat\(\{/);
  assert.match(globalStyles, /\.desktop-pet-task-panel/);
  assert.match(globalStyles, /\.desktop-pet-task-row/);
  assert.match(globalStyles, /\.desktop-pet-task-more/);
});

test("desktop pet moving-left state uses the smooth high-frame strip", () => {
  const globalStyles = readRendererStyles();
  const desktopPetSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );

  assert.match(desktopPetSource, /getDesktopPetStateAsset/);
  assert.match(desktopPetSource, /desktop-pet-state-sprite/);
  assert.match(globalStyles, /\.desktop-pet-state-sprite\s*\{[\s\S]{0,160}background-size:\s*calc\(96px \* var\(--desktop-pet-state-frames,\s*1\)\) 104px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-state-animation\s+\.desktop-pet-state-sprite\s*\{[\s\S]{0,220}animation:\s*desktop-pet-state-frames var\(--desktop-pet-state-duration,\s*900ms\) steps\(var\(--desktop-pet-state-frames,\s*1\),\s*end\) var\(--desktop-pet-state-loop-count,\s*infinite\);/);
  assert.match(globalStyles, /@keyframes desktop-pet-state-frames\s*\{[\s\S]{0,120}background-position:\s*calc\(-96px \* var\(--desktop-pet-state-frames,\s*1\)\) 0;/);
  assert.doesNotMatch(globalStyles, /background-position:\s*0\s+-200%;/);
  assert.doesNotMatch(globalStyles, /background-position:\s*-800%\s+-200%;/);
  assert.doesNotMatch(globalStyles, /background-position:\s*-768px\s+-216px;/);
});

test("desktop pet preview rows reserve room for two-line item content", () => {
  const globalStyles = readRendererStyles();

  assert.match(globalStyles, /\.desktop-pet-preview-item\s*\{[\s\S]{0,260}min-height:\s*52px;/);
  assert.match(globalStyles, /\.desktop-pet-preview-item\s*\{[\s\S]{0,260}align-items:\s*center;/);
  assert.match(globalStyles, /\.desktop-pet-preview-item-copy\s*\{[\s\S]{0,160}display:\s*flex;/);
  assert.match(globalStyles, /\.desktop-pet-preview-item-copy\s*\{[\s\S]{0,220}flex-direction:\s*column;/);
  assert.match(globalStyles, /\.desktop-pet-preview-item-copy\s*\{[\s\S]{0,260}justify-content:\s*center;/);
  assert.match(globalStyles, /\.desktop-pet-preview.is-expanded\s+\.desktop-pet-preview-item\s*\{[\s\S]{0,80}align-items:\s*center;/);
  assert.match(globalStyles, /\.desktop-pet-preview-item\s+small\s*\{[\s\S]{0,160}align-self:\s*center;/);
  assert.match(globalStyles, /\.desktop-pet-preview-item-dot\s*\{[\s\S]{0,160}align-self:\s*center;/);
});

test("desktop pet button suppresses native focus rings in the transparent window", () => {
  const globalStyles = readRendererStyles();

  assert.match(globalStyles, /\.desktop-pet-button\s*\{[\s\S]{0,420}appearance:\s*none;/);
  assert.match(globalStyles, /\.desktop-pet-button\s*\{[\s\S]{0,520}-webkit-tap-highlight-color:\s*transparent;/);
  assert.match(globalStyles, /\.desktop-pet-button:focus,\s*\.desktop-pet-button:focus-visible\s*\{[\s\S]{0,120}outline:\s*none;/);
});

test("control center config editor suppresses native focus rings", () => {
  const globalStyles = readRendererStyles();

  assert.match(globalStyles, /\.config-editor:focus,\s*\.config-editor:focus-visible\s*\{[\s\S]{0,120}outline:\s*none;/);
  assert.match(globalStyles, /\.config-editor:focus,\s*\.config-editor:focus-visible\s*\{[\s\S]{0,160}border-color:\s*var\(--line\);/);
  assert.match(globalStyles, /\.config-editor:focus,\s*\.config-editor:focus-visible\s*\{[\s\S]{0,180}box-shadow:\s*none;/);
});

test("desktop pet visual states stay local to renderer priority", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );
  const sharedDesktopPet = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-pet.ts"), "utf8");
  const desktopPetVisual = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-pet-visual.ts"), "utf8");
  const globalStyles = readRendererStyles();
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const desktopPetWindow = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "pet-copilot", "window.ts"),
    "utf8"
  );
  const desktopPetHandlers = readSourceFile("src", "main", "ipc", "desktop-pet-handlers.ts");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = readSharedContractsSource();
  const viteConfig = readSourceFile("vite.config.ts");

  assert.match(desktopPetVisual, /"moving-left"/);
  assert.match(desktopPetVisual, /"jumping"/);
  assert.match(desktopPetVisual, /"failed"/);
  assert.match(desktopPetVisual, /"review"/);
  assert.match(desktopPet, /DESKTOP_PET_DRAG_DIRECTION_THRESHOLD_PX = 3/);
  assert.match(desktopPet, /const \[isHovering, setIsHovering\] = useState\(false\)/);
  assert.match(desktopPet, /const \[isKeyboardFocused, setIsKeyboardFocused\] = useState\(false\)/);
  assert.match(desktopPet, /const \[activeSignature, setActiveSignature\] = useState<ActiveDesktopPetSignature \| null>\(null\)/);
  assert.match(desktopPet, /pointIntersectsVisiblePetArea/);
  assert.match(desktopPet, /pointIntersectsElement\("\.desktop-pet-image"/);
  assert.match(desktopPet, /window\.addEventListener\("mousemove", handleWindowMouseMove\)/);
  assert.match(desktopPet, /desktopPet\.setMouseInteractive\(interactive\)/);
  assert.match(desktopPet, /typeof window\.electronAPI\.desktopPet\.onSignatureRequested === "function"/);
  assert.match(desktopPet, /desktopPet\.onSignatureRequested\(\(signatureId\) => \{[\s\S]{0,120}startSignature\(signatureId,\s*"manual"\);/);
  assert.match(desktopPetVisual, /if \(input\.isDragging\)[\s\S]{0,80}return input\.dragDirection \? "moving-left" : "dragging"/);
  assert.match(desktopPet, /window\.addEventListener\("pointermove", handleWindowPointerMove\)/);
  assert.match(desktopPet, /shouldShowSignatureSpriteAnimation[\s\S]{0,220}activeSignature\.assetPath/);
  assert.match(sharedDesktopPet, /export function resolveDesktopPetSignatureActions/);
  assert.match(desktopPet, /resolveDesktopPetSignatureActions\(\s*appearanceIdRef\.current/);
  assert.match(desktopPet, /getDesktopPetSpriteAssetBasePath\(appearanceId\)/);
  assert.match(desktopPet, /deriveDesktopPetVisualStatus\(\{/);
  assert.match(desktopPetVisual, /input\.displayStatus === "awaiting"[\s\S]{0,80}return "awaiting"/);
  assert.match(desktopPetVisual, /input\.displayStatus === "running" && input\.isReviewing[\s\S]{0,80}return "review"/);
  assert.match(desktopPetVisual, /input\.displayStatus === "running"[\s\S]{0,80}return "running"/);
  assert.match(desktopPetVisual, /input\.displayStatus === "error"[\s\S]{0,80}return "failed"/);
  assert.match(desktopPetVisual, /input\.activeStandardAction === "jumping"[\s\S]{0,80}return "jumping"/);
  assert.doesNotMatch(desktopPetVisual, /return "thinking"/);
  assert.doesNotMatch(desktopPetVisual, /return "message"/);
  assert.doesNotMatch(desktopPetVisual, /hasMessageReaction/);
  assert.match(desktopPetVisual, /input\.hasActiveSignature[\s\S]{0,80}return "signature"/);
  assert.match(desktopPet, /displayStatus === "idle" && !isDragging && !hasMessageReaction/);
  assert.match(desktopPetVisual, /input\.isHovering \|\| input\.isKeyboardFocused/);
  assert.match(desktopPet, /function resolveDesktopPetVisualAsset/);
  assert.match(desktopPet, /getDesktopPetStateAsset\(customAppearance\?\.states, status\)/);
  assert.doesNotMatch(desktopPet, /getDesktopPetLegacyStatusAssetName/);
  assert.doesNotMatch(desktopPet, /task-run-left\.webp/);
  assert.match(desktopPet, /const visualAsset = useMemo\(\s*\(\) => resolveDesktopPetVisualAsset\(petState, appearanceId, visualStatus\)/);
  assert.match(desktopPet, /DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH = 30/);
  assert.match(desktopPet, /formatInlinePetPreview\(bubbleText\)/);
  assert.match(desktopPet, /const statusBubbleText = displayStatus === "idle"[\s\S]{0,120}: petState\.hint\.trim\(\) \|\| formatPetHint\(displayStatus\);/);
  assert.match(desktopPet, /const previewSummary = previewPanel && previewPanel\.expanded/);
  assert.match(desktopPet, /const showItemDetail = shouldShowSecondaryPreview\(itemTitle, itemDetailPreview\);/);
  assert.match(desktopPet, /handlePreviewClick[\s\S]{0,180}previewPanel\.status === "done"[\s\S]{0,120}desktopPet\.dismissPreview/);
  assert.match(desktopPet, /handlePreviewClick[\s\S]{0,360}desktopPet\.setPreviewExpanded\(!previewPanel\.expanded\)/);
  assert.match(desktopPet, /messagePreview \|\| "有新消息"/);
  assert.match(desktopPet, /const previewPanel = petState\.previewPanel\?\.visible \? petState\.previewPanel : null/);
  assert.match(desktopPet, /const showPreviewPanel = !isDragging && !showTaskPanel && Boolean\(previewPanel\)/);
  assert.match(desktopPet, /const showBubble = !isDragging && !showTaskPanel && !showPreviewPanel && bubbleText\.length > 0/);
  assert.match(desktopPet, /desktop-pet-preview-toggle/);
  assert.match(desktopPet, /desktopPet\.setPreviewExpanded/);
  assert.match(desktopPet, /onPointerEnter=\{handlePointerEnter\}/);
  assert.match(desktopPet, /onPointerLeave=\{handlePointerLeave\}/);
  assert.match(desktopPet, /onFocus=\{handleButtonFocus\}/);
  assert.match(desktopPet, /onBlur=\{handleButtonBlur\}/);
  assert.match(desktopPet, /matches\(":focus-visible"\)/);
  assert.doesNotMatch(sharedDesktopPet, /id:\s*"dario"/);
  assert.doesNotMatch(sharedDesktopPet, /id:\s*"sama"/);
  assert.doesNotMatch(sharedDesktopPet, /id:\s*"pony"/);
  assert.doesNotMatch(sharedDesktopPet, /assetBasePath:\s*"\.\/desktop-pet\/dario"/);
  assert.doesNotMatch(sharedDesktopPet, /assetBasePath:\s*"\.\/desktop-pet\/sama"/);
  assert.match(sharedDesktopPet, /DESKTOP_PET_REQUIRED_STATE_KEYS = \[[\s\S]*?"idle"[\s\S]*?"jumping"[\s\S]*?"moving-left"[\s\S]*?"dragging"[\s\S]*?"done"[\s\S]*?"failed"[\s\S]*?"running"[\s\S]*?"awaiting"[\s\S]*?"review"[\s\S]*?\]/);
  assert.match(sharedDesktopPet, /DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES = 4/);
  assert.match(sharedDesktopPet, /DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES = 8/);
  assert.match(sharedDesktopPet, /const BRAND_DESKTOP_PET = APP_BRAND\.desktopPet/);
  assert.match(sharedDesktopPet, /DEFAULT_DESKTOP_PET_STATES = BRAND_DESKTOP_PET\.states/);
  assert.match(sharedDesktopPet, /DEFAULT_DESKTOP_PET_SIGNATURE_ACTIONS[\s\S]*?BRAND_DESKTOP_PET[\s\S]*?signature/);
  assert.match(sharedDesktopPet, /preview:\s*BRAND_DESKTOP_PET\.preview/);
  assert.match(sharedDesktopPet, /previewUrl:\s*`\.\/desktop-pet\/\$\{BRAND_DESKTOP_PET\.preview\}`/);
  assert.doesNotMatch(sharedDesktopPet, /\n\s*message:\s*\{\s*path:/);
  assert.doesNotMatch(sharedDesktopPet, /\n\s*thinking:\s*\{\s*path:/);
  assert.doesNotMatch(sharedDesktopPet, /\n\s*unread:\s*\{\s*path:/);
  assert.doesNotMatch(sharedDesktopPet, /"dragging-moving":\s*\{\s*path:/);
  assert.doesNotMatch(sharedDesktopPet, /"idle-alts"/);
  assert.doesNotMatch(sharedDesktopPet, /pet-[a-z-]+\.png/);
  assert.doesNotMatch(sharedDesktopPet, /dancing:/);
  assert.match(sharedDesktopPet, /getDesktopPetSignatureActions/);
  assert.match(sharedDesktopPet, /DESKTOP_PET_SIGNATURE_ACTIONS_BY_APPEARANCE_ID[\s\S]*?DEFAULT_DESKTOP_PET_SIGNATURE_ACTIONS/);
  assert.doesNotMatch(sharedDesktopPet, /id:\s*"chant"/);
  assert.doesNotMatch(sharedDesktopPet, /path:\s*"signature\/chant\.webp"/);
  assert.doesNotMatch(sharedDesktopPet, /"pony"/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-hover\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-signature\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-signature-sprite\s*\{[\s\S]{0,260}background-size:\s*calc\(96px \* var\(--desktop-pet-signature-frames,\s*30\)\) 104px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-signature-animation\s+\.desktop-pet-signature-sprite\s*\{[\s\S]{0,220}animation:\s*desktop-pet-signature-frames var\(--desktop-pet-signature-duration,\s*5200ms\) steps\(var\(--desktop-pet-signature-frames,\s*30\),\s*end\) 1 both;/);
  assert.match(globalStyles, /@keyframes desktop-pet-signature-frames\s*\{[\s\S]*?background-position:\s*calc\(-96px \* var\(--desktop-pet-signature-frames,\s*30\)\) 0;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-awaiting\s+\.desktop-pet-image[\s\S]{0,120}desktop-pet-awaiting/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-dragging\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-jumping\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-running\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-review\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-moving-left\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-failed\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-state-animation\s+\.desktop-pet-state-sprite/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.is-thinking\s+\.desktop-pet-image/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.is-message\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-preview/);
  assert.match(globalStyles, /\.desktop-pet-preview-toggle/);
  assert.match(globalStyles, /@keyframes desktop-pet-hover-reaction/);
  assert.match(globalStyles, /@keyframes desktop-pet-signature-bounce/);
  assert.doesNotMatch(globalStyles, /@keyframes desktop-pet-dance/);
  assert.match(globalStyles, /@keyframes desktop-pet-dragging/);
  assert.match(globalStyles, /@keyframes desktop-pet-jumping/);
  assert.match(globalStyles, /@keyframes desktop-pet-running/);
  assert.match(globalStyles, /@keyframes desktop-pet-review/);
  assert.match(globalStyles, /@keyframes desktop-pet-state-frames/);
  assert.match(globalStyles, /@keyframes desktop-pet-awaiting/);
  assert.doesNotMatch(globalStyles, /@keyframes desktop-pet-thinking/);
  assert.doesNotMatch(globalStyles, /@keyframes desktop-pet-message-nudge/);
  assert.match(mainProcess, /getDesktopPetContextMenuItems\(\s*appState\.desktopPetState\.appearanceId,\s*appState\.desktopPetState\.signature \?\? \[\]\s*\)/);
  assert.match(mainProcess, /desktopPet\.signatureRequested", signatureId/);
  assert.match(mainProcess, /function setDesktopPetWindowMouseInteractive\(interactive: boolean\)/);
  assert.match(mainProcess, /setIgnoreMouseEvents\(!interactive, \{ forward: true \}\)/);
  assert.match(mainProcess, /(?:process|mainProcessContext)\.platform === "win32"[\s\S]{0,220}setIgnoreMouseEvents\(false\)/);
  assert.match(desktopPetWindow, /const isWindows = options\.platform === "win32";/);
  assert.match(desktopPetWindow, /\.\.\.\(isWindows \? \{ thickFrame: false \} : \{\}\)/);
  assert.match(desktopPetWindow, /if \(isMac\) \{[\s\S]{0,180}setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true \}\);[\s\S]{0,80}\} else if \(isWindows\) \{[\s\S]{0,80}setAlwaysOnTop\(true\);/);
  assert.match(desktopPetHandlers, /desktopPet\.setMouseInteractive/);
  assert.match(desktopPetHandlers, /desktopPet\.dismissPreview/);
  assert.doesNotMatch(mainProcess, /desktopPet\.danceRequested/);
  assert.match(mainProcess, /desktopPet\.signatureRequested/);
  assert.match(preload, /dismissPreview: \(\) => ipcRenderer\.invoke\("desktopPet\.dismissPreview"\)/);
  assert.match(preload, /setMouseInteractive: \(interactive\) => ipcRenderer\.invoke\("desktopPet\.setMouseInteractive", interactive\)/);
  assert.match(preload, /onSignatureRequested/);
  assert.match(preload, /desktopPet\.signatureRequested/);
  assert.doesNotMatch(preload, /onDanceRequested/);
  assert.doesNotMatch(preload, /desktopPet\.danceRequested/);
  assert.match(contracts, /DesktopPetSignatureRequestedListener/);
  assert.doesNotMatch(contracts, /DesktopPetDanceRequestedListener/);
  assert.match(contracts, /setMouseInteractive: \(interactive: boolean\) => Promise<\{ ok: boolean \}>/);
  assert.match(contracts, /onSignatureRequested: \(listener: DesktopPetSignatureRequestedListener\) => \(\) => void/);
  assert.doesNotMatch(sharedDesktopPet, /displayName:\s*"小凌"/);
  assert.match(viteConfig, /name:\s*"brand-renderer-index"/);
  assert.match(viteConfig, /transformIndexHtml\(html\)/);
  assert.match(viteConfig, /renderRendererIndexHtml\(html,\s*brand\)/);
  assert.match(viteConfig, /name:\s*"brand-runtime-icon-assets"/);
  assert.match(viteConfig, /BRAND_RUNTIME_ASSET_URL_PATHS/);
  assert.match(viteConfig, /server\.middlewares\.use\(serveBrandRuntimeIconAsset\)/);
  assert.match(viteConfig, /copyBrandRuntimeIconAssets\(\{[\s\S]{0,180}dist-renderer"/);
  assert.match(viteConfig, /name:\s*"brand-desktop-pet-assets"/);
  assert.match(viteConfig, /BRAND_DESKTOP_PET_URL_PREFIX = "\/desktop-pet\/"/);
  assert.match(viteConfig, /server\.middlewares\.use\(serveBrandDesktopPetAsset\)/);
  assert.match(viteConfig, /copyBrandDesktopPetAssets\(\{[\s\S]{0,220}dist-renderer"[\s\S]{0,120}"desktop-pet"/);
  assert.match(viteConfig, /brand\.source\.desktopPetRoot/);
  assert.doesNotMatch(viteConfig, /public["'],\s*["']brand-icon/);
  assert.doesNotMatch(viteConfig, /public["'],\s*["']tray-icon/);
  assert.doesNotMatch(viteConfig, /public["'],\s*["']desktop-pet/);
});

test("desktop sso waits for a user click and keeps pending login recoverable", () => {
  const appShell = readAppShellSource();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const contracts = readSharedContractsSource();
  const mainProcess = readSourceFile("src", "main", "index.ts");
  const oidcSso = readSourceFile("src", "main", "oidc-sso.ts");
  const ssoController = readSourceFile("src", "main", "sso-controller.ts");
  const globalStyles = readRendererStyles();
  const accountMenuRule = globalStyles.match(/\.sidebar-tool-menu\.sidebar-account-menu\s*\{(?<body>[\s\S]*?)^\}/m);
  const ssoWebviewCompletionHandler = mainProcess.slice(
    indexOfRequired(mainProcess, "async function handleDesktopSsoWebviewNavigation"),
    indexOfRequired(mainProcess, "function clearDesktopPetIdleResetTimer")
  );

  assert.match(contracts, /browserOrigin\?: string;/);
  assert.match(contracts, /browserUrl\?: string;/);
  assert.match(contracts, /avatarUrl\?: string;/);
  assert.match(contracts, /DesktopSsoEmbeddedLoginRequest/);
  assert.match(contracts, /cancelLogin: \(\) => Promise<DesktopSsoCancelResult>;/);
  assert.match(contracts, /onEmbeddedLoginOpen: \(listener: DesktopSsoEmbeddedLoginListener\) => \(\) => void;/);
  assert.match(oidcSso, /DESKTOP_SSO_AVATAR_CLAIM_KEYS = \["avatarUrl",\s*"picture",\s*"avatar_url",\s*"avatar"\] as const;/);
  assert.match(oidcSso, /function normalizeDesktopSsoAvatarUrlClaim\(payload: Record<string, unknown>\)/);
  assert.match(oidcSso, /\.\.\.\(avatarUrl \? \{ avatarUrl \} : \{\}\)/);
  assert.doesNotMatch(oidcSso, new RegExp(textFromCodes(113, 105, 117, 101, 114), "u"));
  assert.doesNotMatch(oidcSso, /DEFAULT_AI_COOKIE_ACCESS_TOKEN_EXCHANGE/u);
  assert.match(ssoController, /function getRecordAvatarUrl\(value: unknown\)/);
  assert.match(ssoController, /\.\.\.\(avatarUrl \? \{ avatarUrl \} : \{\}\)/);
  assert.match(ssoController, /openEmbeddedLoginDialog/);
  assert.match(ssoController, /sso\.embeddedLogin\.open/);
  assert.match(ssoWebviewCompletionHandler, /getDesktopSsoCookieAccessTokenExchangeUrl\(app\)/);
  assert.match(ssoWebviewCompletionHandler, /cookieAccessTokenExchange 未返回 access_token/);
  assert.doesNotMatch(ssoWebviewCompletionHandler, /completeDesktopSsoBrowserLogin/);
  assert.doesNotMatch(appShell, /desktopSsoAutoLogin/);
  assert.doesNotMatch(appShell, /void handleDesktopSsoLogin\(\);/);
  assert.match(appShell, /desktopSsoStatus=\{desktopSsoStatus\}/);
  assert.match(appShell, /desktopSsoBusy=\{desktopSsoBusy\}/);
  assert.match(appShell, /onEmbeddedLoginOpen/);
  assert.match(appShell, /desktop-sso-login-modal/);
  assert.match(appShell, /role="dialog"/);
  assert.match(appShell, /partition: desktopSsoLoginDialog\.partition/);
  assert.match(appShell, /useragent: desktopSsoLoginDialog\.userAgent/);
  assert.doesNotMatch(appShell, /desktop-sso-login-webview[\s\S]{0,220}allowpopups/);
  assert.match(appShell, /onDesktopSsoLogin=\{handleDesktopSsoLogin\}/);
  assert.match(appShell, /onDesktopSsoLogout=\{handleDesktopSsoLogout\}/);
  assert.match(appShell, /async function refreshDesktopSsoStatus\(\)[\s\S]{0,240}ssoApi\.getStatus\(\)[\s\S]{0,120}setDesktopSsoStatus\(status\);/);
  assert.match(appShell, /onRefreshDesktopSsoStatus=\{refreshDesktopSsoStatus\}/);
  assert.doesNotMatch(appShell, /const \[desktopSsoDismissed, setDesktopSsoDismissed\]/);
  assert.doesNotMatch(appShell, /className=\{desktopSsoClassName\}/);
  assert.doesNotMatch(appShell, /has-desktop-sso-status/);

  assert.match(sidebarSource, /desktopSsoStatus\?:\s*DesktopSsoStatus \| null;/);
  assert.match(sidebarSource, /onRefreshDesktopSsoStatus\?:\s*\(\) => Promise<void> \| void;/);
  assert.match(sidebarSource, /function handleToolMenuOpenChange\(open: boolean\)[\s\S]{0,360}onRefreshDesktopSsoStatus\?\.\(\)[\s\S]{0,360}setToolMenuOpen\(true\);/);
  assert.match(sidebarSource, /toolMenuOpenRequestIdRef\.current === requestId/);
  assert.match(sidebarSource, /const shouldRenderDesktopSsoAccount = desktopSsoStatus\?\.configured === true;/);
  assert.doesNotMatch(sidebarSource, /visibleToolItems/);
  assert.doesNotMatch(sidebarSource, /function renderDesktopSsoEntry\(\)/);
  assert.match(sidebarSource, /function AccountMenuAvatar\(\{ avatarUrl = "", label \}: AccountMenuAvatarProps\)/);
  assert.match(sidebarSource, /sidebar-account-menu-avatar-image/);
  assert.match(sidebarSource, /sidebar-account-menu-avatar-fallback/);
  assert.match(sidebarSource, /function getDesktopSsoUserLabel\(\)/);
  assert.match(sidebarSource, /if \(!desktopSsoStatus\) \{[\s\S]{0,80}return t\("sidebar\.sso\.signIn"\);/);
  assert.match(sidebarSource, /desktopSsoStatus\.user\?\.name\?\.trim\(\)\s*\|\|[\s\S]{0,120}desktopSsoStatus\.user\?\.email\?\.trim\(\)/);
  assert.doesNotMatch(sidebarSource, /function renderDesktopSsoAccountMenuSection\(\)/);
  assert.match(sidebarSource, /function renderAccountMenuUserItem\(\)/);
  assert.match(sidebarSource, /function handleDesktopSsoMenuActionClick\(\)/);
  assert.match(sidebarSource, /function handleDesktopSsoLogoutClick/);
  assert.match(sidebarSource, /sidebar-account-menu/);
  assert.doesNotMatch(sidebarSource, /sidebar\.account\.personal/);
  assert.doesNotMatch(sidebarSource, /is-personal/);
  assert.doesNotMatch(sidebarSource, /sidebar\.account\.remainingUsage/);
  assert.doesNotMatch(sidebarSource, /className="sidebar-tool-status-label"/);
  assert.match(sidebarSource, /const topToolItems = fixedToolItems\.filter\(\(item\) =>[\s\S]*?item\.to === "\/agents" \|\| item\.to === "\/registries" \|\| item\.to === "\/market"/);
  assert.match(sidebarSource, /const middleToolItems = fixedToolItems\.filter\(\(item\) =>[\s\S]*?item\.to === "\/control-center" \|\| item\.to === "\/help"/);
  assert.match(sidebarSource, /const settingsToolItems = fixedToolItems\.filter\(\(item\) => item\.to === "\/settings"\);/);
  assert.match(sidebarSource, /shouldRenderDesktopSsoAccount \? \([\s\S]*?\{renderAccountMenuUserItem\(\)\}[\s\S]*?sidebar-account-menu-divider[\s\S]*?\) : null/);
  assert.match(sidebarSource, /\{renderAccountMenuUserItem\(\)\}[\s\S]*?sidebar-account-menu-divider[\s\S]*?topToolItems\.map\(\(item\) => renderToolLink\(item\)\)[\s\S]*?sidebar-account-menu-divider[\s\S]*?middleToolItems\.map\(\(item\) => renderToolLink\(item\)\)[\s\S]*?sidebar-account-menu-divider[\s\S]*?settingsToolItems\.map\(\(item\) => renderToolLink\(item\)\)/);
  assert.match(sidebarSource, /className="sidebar-tool-menu-popover"/);
  assert.match(sidebarSource, /aria-label=\{desktopSsoActionLabel\}/);
  assert.match(sidebarSource, /aria-label=\{desktopSsoLogoutLabel\}/);
  assert.match(sidebarSource, /avatarUrl=\{desktopSsoStatus\.user\?\.avatarUrl\}/);
  assert.match(sidebarSource, /className="sidebar-account-menu-logout"/);
  assert.match(sidebarSource, /className="sidebar-account-menu-logout-label"/);
  assert.match(sidebarSource, /window\.confirm\(t\("sidebar\.sso\.confirmSignOut"\)\)/);
  assert.match(sidebarSource, /onDesktopSsoLogout\?\.\(\)/);
  assert.match(sidebarSource, /onDesktopSsoLogin\?\.\(\);/);
  assert.doesNotMatch(sidebarSource, /desktopSsoStatus\.authenticated[\s\S]{0,140}\? onDesktopSsoLogout\?\.\(\)[\s\S]{0,140}: onDesktopSsoLogin\?\.\(\)/);
  assert.doesNotMatch(sidebarSource, /"sidebar-account-menu-action",[\s\S]{0,80}"sidebar-account-menu-user",[\s\S]{0,260}onClick=\{handleDesktopSsoLogoutClick\}/);
  assert.match(sidebarSource, /disabled=\{desktopSsoBusy\}/);
  assert.match(sidebarSource, /t\("sidebar\.sso\.signedIn"\)/);
  assert.doesNotMatch(sidebarSource, /desktopSsoStatus\.user\?\.name\s*\|\|\s*desktopSsoStatus\.user\?\.email\s*\|\|\s*desktopSsoStatus\.user\?\.sub/);
  assert.doesNotMatch(sidebarSource, /desktopSsoMessage/);
  assert.doesNotMatch(sidebarSource, /sidebar-sso-message/);
  assert.match(sidebarSource, /desktopSsoStatus\.pending[\s\S]{0,120}\? t\("sidebar\.sso\.signingIn"\)/);
  assert.match(sidebarSource, /desktopSsoStatus\?\.pending[\s\S]{0,120}\? t\("sidebar\.sso\.reopen"\)/);
  assert.match(sidebarSource, /: t\("sidebar\.sso\.signIn"\);/);
  assert.doesNotMatch(sidebarSource, /"登录中"|"重新打开"/);
  assert.doesNotMatch(sidebarSource, /\{renderDesktopSsoEntry\(\)\}/);
  assert.match(sidebarSource, /<SidebarIllustration kind="settings" \/>/);
  assert.match(sidebarSource, /activeFixedToolItem[\s\S]{0,80}\? "sidebar-link-active"/);

  assert.doesNotMatch(globalStyles, /\.sidebar-sso-entry\s*\{/);
  assert.ok(accountMenuRule?.groups?.body, "missing .sidebar-tool-menu.sidebar-account-menu rule");
  assert.match(globalStyles, /\.sidebar-tool-menu-popover\s*\{[\s\S]*?overflow:\s*visible;/);
  assert.match(globalStyles, /\.sidebar-tool-menu-popover\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(globalStyles, /\.sidebar-tool-menu\.sidebar-account-menu\s*\{[\s\S]*?min-width:\s*240px;/);
  assert.match(globalStyles, /\.sidebar-tool-menu\.sidebar-account-menu\s*\{[\s\S]*?border:\s*1px solid var\(--line-strong\);/);
  assert.match(globalStyles, /\.sidebar-tool-menu\.sidebar-account-menu\s*\{[\s\S]*?border-radius:\s*16px;/);
  assert.match(globalStyles, /\.sidebar-tool-menu\.sidebar-account-menu\s*\{[\s\S]*?background:\s*var\(--surface-strong\);/);
  assert.match(globalStyles, /\.sidebar-tool-menu\.sidebar-account-menu\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(globalStyles, /\.sidebar-account-menu \.sidebar-tool-menu-item,[\s\S]*?\.sidebar-account-menu-item\s*\{[\s\S]*?color:\s*var\(--ink-soft\);[\s\S]*?font-size:\s*14px;[\s\S]*?font-weight:\s*500;/);
  assert.match(globalStyles, /\.sidebar-account-menu \.sidebar-link-icon,[\s\S]*?\.sidebar-account-menu-icon\s*\{[\s\S]*?color:\s*var\(--ink-muted\);/);
  assert.match(globalStyles, /\.sidebar-account-menu-item\.is-disabled\s*\{[\s\S]*?color:\s*var\(--ink-muted\);/);
  assert.match(globalStyles, /\.sidebar-link:hover:not\(\.sidebar-link-active\)\s*\{[\s\S]*?background:\s*rgba\(136,\s*151,\s*172,\s*0\.1\);/);
  assert.match(globalStyles, /\.sidebar-link-active\s*\{[\s\S]*?color:\s*#1677ff;[\s\S]*?background:\s*rgba\(22,\s*119,\s*255,\s*0\.13\);/);
  assert.match(
    globalStyles,
    /\.sidebar-account-menu \.sidebar-tool-menu-item:hover,[\s\S]*?\.sidebar-account-menu \.sidebar-tool-menu-item\.sidebar-link-active,[\s\S]*?background:\s*rgba\(136,\s*151,\s*172,\s*0\.1\);/
  );
  assert.doesNotMatch(globalStyles, /\.sidebar-account-menu \.sidebar-tool-menu-item:hover \.sidebar-link-icon,[\s\S]*?color:\s*var\(--accent\);/);
  assert.doesNotMatch(globalStyles, /\.sidebar-account-menu-action:hover \.sidebar-account-menu-icon[\s\S]*?color:\s*var\(--accent\);/);
  assert.doesNotMatch(globalStyles, /\.sidebar-account-menu-action:focus-visible \.sidebar-account-menu-icon[\s\S]*?color:\s*var\(--accent\);/);
  assert.match(globalStyles, /\.sidebar-account-menu-user\s*\{[\s\S]*?font-size:\s*14px;[\s\S]*?font-weight:\s*500;/);
  assert.match(globalStyles, /\.sidebar-account-menu-user-with-action\s*\{[\s\S]*?cursor:\s*default;/);
  assert.match(globalStyles, /\.sidebar-account-menu-avatar\s*\{[\s\S]*?flex:\s*0 0 24px;[\s\S]*?border-radius:\s*999px;/);
  assert.match(globalStyles, /\.sidebar-account-menu-avatar-image\s*\{[\s\S]*?object-fit:\s*cover;/);
  assert.match(globalStyles, /\.sidebar-account-menu-avatar-fallback\s*\{/);
  assert.match(globalStyles, /\.sidebar-account-menu-logout\s*\{[\s\S]*?min-width:\s*58px;[\s\S]*?font-size:\s*12px;/);
  assert.match(globalStyles, /\.sidebar-account-menu-logout-label\s*\{[\s\S]*?white-space:\s*nowrap;/);
  assert.doesNotMatch(globalStyles, /\.sidebar-tool-status-label\s*\{/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar\.is-collapsed \.sidebar-tool-status-label/);
  assert.match(globalStyles, /\.sidebar-account-menu-label\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(globalStyles, /\.sidebar-account-menu-item\.is-disabled\s*\{[\s\S]*?cursor:\s*default;/);
  assert.match(globalStyles, /\.sidebar-tool-menu\.sidebar-account-menu\s*\{[\s\S]*?gap:\s*2px;/);
  assert.match(globalStyles, /\.sidebar-tool-menu\.sidebar-account-menu\s*\{[\s\S]*?padding:\s*6px;/);
  assert.match(globalStyles, /\.sidebar-account-menu \.sidebar-tool-menu-item,[\s\S]*?\.sidebar-account-menu-item\s*\{[\s\S]*?min-height:\s*28px;[\s\S]*?padding:\s*2px 8px;/);
  assert.match(globalStyles, /\.sidebar-account-menu-divider\s*\{[\s\S]*?margin:\s*2px 8px;/);
  assert.doesNotMatch(globalStyles, /\.sidebar-account-menu-icon\.is-personal/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.sidebar-tool-menu\.sidebar-account-menu\s*\{/);
  assert.doesNotMatch(accountMenuRule.groups.body, /rgba\(255,\s*255,\s*255,\s*0\.96\)/);
  assert.doesNotMatch(globalStyles, /\.sidebar-sso-message/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar\.is-collapsed \.sidebar-sso-entry/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar\.is-collapsed \.sidebar-sso-copy/);
  assert.doesNotMatch(globalStyles, /\.app-sso-status/);
});

test("embedded browser accepts host-opened tabs after multiple tabs exist", () => {
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx"),
    "utf8"
  );
  const copilotContracts = fs.readFileSync(
    path.join(projectRoot, "src", "shared", "contracts", "copilot.ts"),
    "utf8"
  );
  const pluginPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "plugin", "PluginPage.tsx"),
    "utf8"
  );
  const mainProcess = readSourceFile("src", "main", "index.ts");
  const windowManager = readSourceFile("src", "main", "window-manager.ts");
  const ssoHandlers = readSourceFile("src", "main", "ipc", "sso-handlers.ts");
  const ssoController = readSourceFile("src", "main", "sso-controller.ts");
  const oidcSso = readSourceFile("src", "main", "oidc-sso.ts");
  const ssoStartLoginHandler = ssoHandlers.slice(
    indexOfRequired(ssoHandlers, 'ipcMain.handle("sso.startLogin"'),
    indexOfRequired(ssoHandlers, 'ipcMain.handle("sso.cancelLogin"')
  );

  assert.match(copilotContracts, /partition\?: string;/);
  assert.match(copilotContracts, /userAgent\?: string;/);
  assert.match(externalWebviewPage, /partition\?: string;/);
  assert.match(externalWebviewPage, /userAgent\?: string;/);
  assert.match(externalWebviewPage, /partition: tab\.partition,/);
  assert.doesNotMatch(externalWebviewPage, /getRendererEmbeddedBrowserUserAgent/u);
  assert.doesNotMatch(pluginPage, /embedded-browser-user-agent/u);
  assert.match(oidcSso, /provider: "google"/u);
  assert.match(oidcSso, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/u);
  assert.match(oidcSso, /https:\/\/oauth2\.googleapis\.com\/token/u);
  assert.match(oidcSso, /GOOGLE_LOOPBACK_HOST = "127\.0\.0\.1"/u);
  assert.match(oidcSso, /port: 0,[\s\S]{0,120}closeAfterCallback: true/u);
  assert.match(oidcSso, /code_challenge/u);
  assert.match(oidcSso, /function isPublicPkceOidcConfig/u);
  assert.match(oidcSso, /bodyParams\.set\("code_verifier", options\.codeVerifier\)/u);
  assert.match(oidcSso, /"Content-Type": "application\/x-www-form-urlencoded"/u);
  assert.match(oidcSso, /post_logout_redirect_uri/u);
  assert.match(oidcSso, /openMode: "system" as const/u);
  assert.match(ssoController, /async openSystemBrowserUrl/u);
  assert.match(ssoController, /options\.openExternal\(targetUrl\)/u);
  assert.match(ssoStartLoginHandler, /result\.openMode === "system"[\s\S]{0,120}openSystemBrowserUrl/u);
  assert.match(ssoHandlers, /openEmbeddedLoginDialog/u);
  assert.match(ssoStartLoginHandler, /openEmbeddedLoginDialog/u);
  assert.doesNotMatch(ssoStartLoginHandler, /openBrowserUrl/u);
  assert.doesNotMatch(mainProcess, /openInternalAuthBrowserWindow/u);
  assert.doesNotMatch(mainProcess, /shouldOpenAuthUrlInInternalBrowser/u);
  assert.doesNotMatch(windowManager, /openInternalAuthFromWebview/u);
  assert.match(externalWebviewPage, /function shouldRefreshWebviewAfterDesktopSso\(value: string\)/u);
  assert.match(externalWebviewPage, /window\.electronAPI\.sso\.onStatusChanged/u);
  assert.match(externalWebviewPage, /if \(!status\.authenticated\) \{/u);
  assert.match(externalWebviewPage, /shouldRefreshWebviewAfterDesktopSso\(currentUrl\)/u);
  assert.match(externalWebviewPage, /webview\.reload\(\)/u);
  assert.match(externalWebviewPage, /const isHostOpenRequest = sourceGuestId < 0;/);
  assert.match(externalWebviewPage, /if \(isHostOpenRequest\) \{[\s\S]{0,220}if \(!activeRef\.current\) \{[\s\S]{0,80}return;[\s\S]{0,180}openTab\(nextUrl, "", \{[\s\S]{0,160}partition,[\s\S]{0,80}userAgent/);
});

test("embedded browser plus button opens a blank tab for manual address entry", () => {
  const externalWebviewPage = readSourceFile(
    "src",
    "renderer",
    "pages",
    "external-webview",
    "ExternalWebviewPage.tsx"
  );

  assert.match(externalWebviewPage, /const BLANK_EXTERNAL_WEBVIEW_URL\s*=\s*"about:blank"/u);
  assert.match(externalWebviewPage, /function getEditableAddressInputValue\(value: string\)/u);
  assert.match(externalWebviewPage, /value === BLANK_EXTERNAL_WEBVIEW_URL \? "" : value/u);
  assert.match(externalWebviewPage, /onClick=\{\(\) => openTab\(BLANK_EXTERNAL_WEBVIEW_URL,\s*""\)\}/u);
  assert.doesNotMatch(externalWebviewPage, /onClick=\{\(\) => openTab\(url,\s*title\)\}/u);
});

test("help page uses settings-aligned layout shell", () => {
  const helpPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "HelpPage.tsx"),
    "utf8"
  );
  const helpPageCss = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "HelpPage.css"),
    "utf8"
  );
  const themeStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "styles", "theme.css"),
    "utf8"
  );

  assert.match(helpPage, /help-page help-page-single/);
  assert.match(helpPage, /help-content-panel/);
  assert.match(helpPage, /help-page-head/);
  assert.match(helpPage, /help-item-card/);
  assert.match(helpPage, /help-item-section-head/);
  assert.match(helpPage, /className="help-sidebar help-category-card"/);
  assert.doesNotMatch(helpPage, /split-workspace/);
  assert.doesNotMatch(helpPage, /theme-help/);
  assert.match(helpPageCss, /\.help-item-card[\s\S]*?border-radius:\s*8px;/u);
  assert.match(helpPageCss, /\.help-page-head h1[\s\S]*?font-size:\s*18px;/u);
  assert.match(helpPageCss, /\.help-item-section-head strong[\s\S]*?font-size:\s*13px;/u);
  assert.match(themeStyles, /--help-content-max:\s*960px;/);
});

test("embedded websites use compact rows and inline edit", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.tsx"),
    "utf8"
  );
  const settingsPageCss = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.css"),
    "utf8"
  );

  assert.match(settingsPage, /settings\.embeddedWebs\.addTitle/);
  assert.match(settingsPage, /settings\.embeddedWebs\.addDescription/);
  assert.match(settingsPage, /settings\.embeddedWebs\.addedDescription/);
  assert.match(settingsPage, /website-add-head/);
  assert.match(settingsPage, /website-row-edit-form/);
  assert.match(settingsPage, /!editingWebsiteId \?/);
  assert.match(settingsPage, /itemEditing \? \([\s\S]*?website-row-edit-form/);
  assert.doesNotMatch(settingsPage, /website-editing-note/);
  assert.doesNotMatch(settingsPage, /settings\.embeddedWebs\.agentEnhancement/);
  assert.match(settingsPage, /settings\.embeddedWebs\.linkedAgentFor/);
  assert.match(settingsPageCss, /\.settings-page \.website-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(140px,\s*1fr\)\s+minmax\(180px,\s*240px\)\s+auto;/u);
  assert.match(settingsPageCss, /\.settings-page \.website-form input,[\s\S]*?\.settings-page \.website-row-edit-form input\s*\{[\s\S]*?border-radius:\s*8px;/u);
  assert.match(settingsPageCss, /\.settings-page \.website-row-edit-form input:focus\s*\{[\s\S]*?box-shadow:\s*var\(--control-focus-ring\);/u);
  assert.match(settingsPageCss, /\.settings-page \.website-add-form\s*\{[\s\S]*?padding:\s*10px 16px 14px;/u);
  assert.match(settingsPageCss, /\.settings-page \.website-row-actions\s*\{[\s\S]*?flex-direction:\s*row;/u);
  assert.match(settingsPage, /desktop-pet-agent-select-wrap/);
});

test("built-in browser surface remains mounted after leaving the chrome route", () => {
  const appShellFile = readSourceFile("src", "renderer", "app-shell", "AppShell.tsx");
  const embeddedSurfaceHosts = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx"
  );

  assert.match(embeddedSurfaceHosts, /export function BuiltinBrowserSurfaceHost/u);
  assert.match(embeddedSurfaceHosts, /<ExternalWebviewPage[\s\S]*?surfaceId=\{BUILTIN_BROWSER_SURFACE_ID\}[\s\S]*?active=\{active\}/u);
  assert.match(appShellFile, /const \[builtinBrowserSurfaceMounted, setBuiltinBrowserSurfaceMounted\] = useState/u);
  assert.match(appShellFile, /const shouldMountBuiltinBrowserSurface = builtinBrowserSurfaceMounted \|\| usesBuiltinBrowserSurface;/u);
  assert.match(appShellFile, /<BuiltinBrowserSurfaceHost[\s\S]*?active=\{usesBuiltinBrowserSurface\}[\s\S]*?mounted=\{shouldMountBuiltinBrowserSurface\}/u);
  assert.match(appShellFile, /<Route path=\{BUILTIN_BROWSER_ROUTE\} element=\{null\} \/>/u);
  assert.doesNotMatch(appShellFile, /<Route\s+path=\{BUILTIN_BROWSER_ROUTE\}[\s\S]{0,260}<ExternalWebviewPage/u);
});

test("persistent external webview surfaces hide without detaching the webview layout", () => {
  const externalWebviewPage = readSourceFile(
    "src",
    "renderer",
    "pages",
    "external-webview",
    "ExternalWebviewPage.tsx"
  );
  const externalWebviewStyles = readSourceFile("src", "renderer", "styles", "external-webview.css");

  assert.match(externalWebviewPage, /const surfaceClassName = \[/u);
  assert.match(externalWebviewPage, /active === false \? "is-inactive-surface" : ""/u);
  assert.match(externalWebviewPage, /"aria-hidden": active === false/u);
  assert.doesNotMatch(externalWebviewPage, /hidden: !active/u);
  assert.match(externalWebviewStyles, /\.external-webview-page\.is-inactive-surface\s*\{/u);
  assert.match(externalWebviewStyles, /\.external-webview-page\.is-inactive-surface\s*\{[\s\S]*?position:\s*absolute;/u);
  assert.match(externalWebviewStyles, /\.external-webview-page\.is-inactive-surface\s*\{[\s\S]*?opacity:\s*0;/u);
  assert.match(externalWebviewStyles, /\.external-webview-page\.is-inactive-surface\s*\{[\s\S]*?pointer-events:\s*none;/u);
});
