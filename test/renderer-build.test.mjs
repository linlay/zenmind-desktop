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

function newestGeneratedBrandPath() {
  const brandsRoot = path.join(projectRoot, "build", "brands");
  if (!fs.existsSync(brandsRoot) || !fs.statSync(brandsRoot).isDirectory()) {
    return "";
  }
  return fs
    .readdirSync(brandsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(brandsRoot, entry.name, "generated", "brand.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] ?? "";
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function removedSymbolPattern(...parts) {
  return new RegExp(parts.map(escapeRegExp).join("_"));
}

function removedProtocolPattern(...parts) {
  return new RegExp(parts.map(escapeRegExp).join(":"));
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
    readSourceFile("src", "shared", "contracts", "kanban.ts"),
    readSourceFile("src", "shared", "contracts", "webs.ts"),
    readSourceFile("src", "shared", "contracts", "desktop-api.ts")
  ].join("\n");
}

function readMainProcessRuntimeSource() {
  return [
    readSourceFile("src", "main", "main-process-runtime.ts"),
    readSourceFile("src", "main", "app", "runtime.ts"),
    readSourceFile("src", "main", "app", "app-events.ts"),
    readSourceFile("src", "main", "app", "startup-environment.ts"),
    readSourceFile("src", "main", "app", "system-identity.ts"),
    readSourceFile("src", "main", "app-shell", "runtime.ts"),
    readSourceFile("src", "main", "services", "runtime.ts"),
    readSourceFile("src", "main", "settings", "runtime.ts"),
    readSourceFile("src", "main", "webs", "surface-runtime.ts"),
    readSourceFile("src", "main", "logs", "runtime.ts")
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

function indexOfRequiredAfter(content, value, startIndex) {
  const index = content.indexOf(value, startIndex);
  assert.notEqual(index, -1, `expected to find ${value} after ${startIndex}`);
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

test("public source keeps ZenMind literals out of shared paths except brand-specific defaults", () => {
  const files = collectTextFiles(path.join(projectRoot, "src"))
    .filter((filePath) => !path.relative(projectRoot, filePath).startsWith(path.join("src", "shared", "generated")));
  const allowedCompatibilityFiles = new Set([
    path.join("src", "main", "env-bootstrap.ts"),
    path.join("src", "main", "services", "manager", "program-layout.ts"),
    path.join("src", "main", "skill-installer.ts")
  ]);
  const allowedDomainPattern = /(?:^|[./])zenmind\.cc\b/u;
  const violations = [];

  for (const filePath of files) {
    const relativePath = path.relative(projectRoot, filePath);
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!/zenmi(?:nd)?/iu.test(line)) {
        return;
      }
      const isAllowed =
        /LEGACY|legacy/u.test(line) ||
        allowedDomainPattern.test(line) ||
        allowedCompatibilityFiles.has(relativePath);
      if (!isAllowed) {
        violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
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
  const mainProcess = readMainProcessRuntimeSource();

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
  assert.match(routeDefinitions, /routePath:\s*"\/archives"[\s\S]*?embedPath:\s*"\/archives"[\s\S]*?labelKey:\s*"nav\.archives"[\s\S]*?mode:\s*"embedded"/);
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
  assert.match(manifestContracts, /spaRoutes:\s*\[[\s\S]*?"\/archives"[\s\S]*?"\/registries"[\s\S]*?\]/);
  assert.match(pluginPage, /normalizedEmbedPath === "\/archives"[\s\S]*?normalizedEmbedPath === "\/registries"/);
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
  const settingsPageSections = readSourceFile("src", "renderer", "settingsPageSections.ts");
  const globalStyles = readRendererStyles();

  assert.match(controlCenter, /export function ControlCenterPage\(\)[\s\S]*?<ServiceWorkspacePage kind="control" \/>/);
  assert.match(controlCenter, /export function PluginsPage\(\)[\s\S]*?<ServiceWorkspacePage kind="plugins" \/>/);
  assert.match(controlCenter, /control-center-dashboard-metrics/);
  assert.match(controlCenter, /service-catalog/);
  assert.match(controlCenter, /control-center-service-hero/);
  assert.match(controlCenter, /service-detail-metadata/);
  assert.match(controlCenter, /config-status-dot/);
  assert.doesNotMatch(controlCenter, /<h2>服务目录<\/h2>/);
  assert.match(controlCenter, /group\.key === "core"[\s\S]*?className="service-catalog-quick-start"/);
  assert.match(controlCenter, /group\.key === "plugins"[\s\S]*?className="service-catalog-import"/);
  assert.match(controlCenter, /services\.filter\(\(service\) => service\.kind === "plugin"\)/);
  assert.doesNotMatch(controlCenter, /controlCenter\.group\.market/);
  assert.match(settingsPageSections, /id:\s*"tunnelHub"[\s\S]*?id:\s*"plugins"[\s\S]*?id:\s*"websites"[\s\S]*?id:\s*"webapps"/);
  assert.doesNotMatch(controlCenter, /service-catalog-foot/);
  assert.doesNotMatch(controlCenter, /useState<ServiceGroupKey \| null>\(\s*"market",?\s*\)/);
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
  assert.match(controlCenter, /className=\{`control-center-page workspace-wide service-workspace-page is-\$\{kind\}`\}/);
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
  assert.match(controlCenter, /className="control-center-feedback-slot"[\s\S]*?\{feedback \|\| error \? \(\s*<PageFeedbackStack/);
  assert.doesNotMatch(controlCenter, /control-center-feedback-anchor/);
  assert.match(globalStyles, /\.control-center-dashboard-metrics\s*\{/);
  assert.match(globalStyles, /:root\s*\{[\s\S]*?--desktop-ui-bg:\s*#ffffff;[\s\S]*?--desktop-ui-card:\s*#ffffff;[\s\S]*?--desktop-ui-primary:\s*#0052d9;[\s\S]*?--desktop-ui-code-bg:\s*#0d1117;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\]\s*\{[\s\S]*?--desktop-ui-bg:\s*#181818;[\s\S]*?--desktop-ui-card:\s*#181818;[\s\S]*?--desktop-ui-primary:\s*#5790ff;[\s\S]*?--desktop-ui-code-bg:\s*#090c11;/);
  assert.match(globalStyles, /\.control-center-page\.workspace-wide,\s*\.control-center-page\s*\{[\s\S]*?--control-center-card:\s*var\(--surface-soft\);[\s\S]*?--control-center-card-muted:\s*var\(--control-select-bg\);[\s\S]*?--control-center-border:\s*var\(--line\);/);
  assert.match(globalStyles, /\.control-center-page\.workspace-wide,\s*\.control-center-page\s*\{[\s\S]*?--control-center-radius:\s*8px;/);
  assert.match(globalStyles, /\.control-center-shell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(240px,\s*304px\) minmax\(0,\s*1fr\);/);
  const controlCenterViewportMedia = globalStyles.match(/@media \(max-width: 1320px\)\s*\{(?<body>[\s\S]*?)^@media \(max-width: 1080px\)/m)?.groups?.body;
  assert.ok(controlCenterViewportMedia);
  assert.doesNotMatch(controlCenterViewportMedia, /\.control-center-shell\s*\{/);
  assert.match(globalStyles, /@container control-center-page \(max-width: 920px\)\s*\{[\s\S]*?\.control-center-shell\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(globalStyles, /\.control-center-metric-card\s*\{[\s\S]*?border-radius:\s*var\(--control-center-radius\);/);
  assert.match(globalStyles, /\.service-sider\.service-catalog\s*\{[\s\S]*?border-radius:\s*var\(--control-center-radius\);/);
  assert.match(globalStyles, /\.control-center-service-hero,\s*\.config-panel,[\s\S]*?\.control-center-empty\s*\{[\s\S]*?border-radius:\s*var\(--control-center-radius\);/);
  assert.match(globalStyles, /\.control-center-metric-card\s*\{[\s\S]*?background:\s*var\(--control-center-card\);/);
  assert.match(globalStyles, /\.service-sider\.service-catalog\s*\{[\s\S]*?background:\s*var\(--control-center-card\);/);
  assert.match(globalStyles, /\.config-file-select-trigger\s*\{[\s\S]*?padding:\s*0 34px 0 10px;/);
  assert.match(globalStyles, /\.config-file-select-trigger svg\s*\{[\s\S]*?right:\s*10px;/);
  assert.match(globalStyles, /\.config-file-select-panel\s*\{[\s\S]*?top:\s*calc\(100% \+ 6px\);/);
  assert.match(globalStyles, /\.config-file-select-trigger\s*\{[\s\S]*?background:\s*var\(--control-center-card-muted\);/);
  assert.match(globalStyles, /\.config-file-select-panel\s*\{[\s\S]*?background:\s*var\(--surface-strong\);/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.control-center-metric-card\s*\{[\s\S]*?linear-gradient\(180deg,\s*#202631/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.service-sider\.service-catalog\s*\{[\s\S]*?linear-gradient\(180deg,\s*#1f2530/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.control-center-service-hero\s*\{[\s\S]*?linear-gradient\(180deg,\s*#202731/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.config-panel\s*\{[\s\S]*?linear-gradient\(180deg,\s*#1f2530/);
  assert.match(globalStyles, /\.service-catalog\s*\{/);
  assert.match(globalStyles, /\.page-feedback-anchor\s*\{/);
  assert.match(globalStyles, /\.page-feedback-layer\s*\{/);
  assert.match(globalStyles, /\.page-feedback-toast\s*\{/);
  assert.match(globalStyles, /\.page-feedback-dismiss\s*\{/);
  assert.match(globalStyles, /\.page-feedback-anchor\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?height:\s*0;/);
  assert.match(globalStyles, /\.page-feedback-layer\s*\{[\s\S]*?transform:\s*none;/);
  assert.match(globalStyles, /\.control-center-feedback-slot\s*\{[\s\S]*?min-height:\s*46px;/);
  assert.match(globalStyles, /\.control-center-feedback-slot \.page-feedback-anchor\s*\{[\s\S]*?position:\s*static;/);
  assert.match(globalStyles, /\.control-center-feedback-slot \.page-feedback-layer\s*\{[\s\S]*?position:\s*static;/);
  assert.doesNotMatch(globalStyles, /\.control-center-feedback-anchor\s*\{/);
  assert.doesNotMatch(globalStyles, /\.control-center-feedback-layer\s*\{/);
  assert.doesNotMatch(globalStyles, /\.control-center-feedback-toast\s*\{/);
  assert.match(globalStyles, /\.service-sider\.service-catalog\s*\{[\s\S]*?max-height:\s*none;/);
  assert.match(globalStyles, /\.service-sider\.service-catalog\s*\{[\s\S]*?overflow:\s*visible;/);
  assert.doesNotMatch(globalStyles, /\.service-catalog-head\s*\{/);
  assert.doesNotMatch(globalStyles, /\.service-catalog-foot\s*\{/);
  assert.match(globalStyles, /\.service-group-head\s*\{[\s\S]*?justify-content:\s*space-between;/);
  assert.match(globalStyles, /\.service-catalog-import\s*\{[\s\S]*?min-height:\s*32px;/);
  assert.match(globalStyles, /\.service-group-copy h2\s*\{[\s\S]*?font-size:\s*13px;[\s\S]*?font-weight:\s*600;/);
  assert.match(globalStyles, /\.service-nav-card h3\s*\{[\s\S]*?font-size:\s*13px;[\s\S]*?font-weight:\s*600;/);
  assert.match(globalStyles, /\.control-center-service-hero,\s*\.config-panel,/);
  assert.match(globalStyles, /\.service-detail-metadata\s*\{[\s\S]*?grid-template-columns:\s*minmax\(88px,\s*0\.55fr\) minmax\(112px,\s*0\.65fr\) minmax\(92px,\s*0\.55fr\) minmax\(220px,\s*1\.6fr\)\s*;/);
  assert.match(globalStyles, /\.service-detail-log-actions\s*\{/);
  assert.match(globalStyles, /\.service-detail-log-action,[\s\S]*?\.control-center-link-action\.icon-link-action\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?border:\s*1px solid var\(--control-center-border\);/);
  assert.match(globalStyles, /\.service-action-button svg,[\s\S]*?\.service-detail-log-action svg,[\s\S]*?\.config-terminal-icon svg\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(globalStyles, /\.config-status-dot\s*\{/);
  assert.match(globalStyles, /\.config-title-label\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?gap:\s*8px;/);
  assert.match(globalStyles, /\.config-terminal-icon\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;[\s\S]*?color:\s*var\(--control-center-subtle\);/);
  const configTerminalIconRule = globalStyles.match(/\.config-terminal-icon\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body;
  assert.ok(configTerminalIconRule);
  assert.doesNotMatch(configTerminalIconRule, /background:/);
  assert.match(globalStyles, /\.config-terminal-icon svg\s*\{/);
  assert.match(globalStyles, /\.config-title-file-select\s*\{[\s\S]*?width:\s*clamp\(160px,\s*20vw,\s*320px\);/);
  assert.match(globalStyles, /\.config-editor\s*\{[\s\S]*?padding:\s*14px 16px;/);
  const configEditorRules = [...globalStyles.matchAll(/\.config-editor\s*\{(?<body>[\s\S]*?)^\}/gm)];
  const controlCenterConfigEditorRule = configEditorRules.find((rule) =>
    /padding:\s*14px 16px;/.test(rule.groups?.body ?? "")
  )?.groups?.body;
  assert.ok(controlCenterConfigEditorRule);
  assert.match(controlCenterConfigEditorRule, /min-height:\s*360px;/);
  assert.doesNotMatch(globalStyles, /linear-gradient\(90deg,\s*var\(--control-center-code-line\)/);
  assert.match(globalStyles, /\.service-nav-card\.is-compact-service\s*\{[\s\S]*?min-height:\s*40px;/);
  assert.match(globalStyles, /\.service-nav-help-wrap\s*\{[\s\S]*?position:\s*relative;/);
  assert.doesNotMatch(globalStyles, /\.service-nav-card\.is-help-open\s*\{/);
  assert.match(globalStyles, /\.service-nav-help-button\s*\{/);
  assert.match(globalStyles, /\.service-nav-help-button svg\s*\{/);
  assert.match(globalStyles, /\.service-nav-help-tip\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?z-index:\s*120;[\s\S]*?max-width:\s*260px;[\s\S]*?border:\s*1px solid var\(--control-center-border\);[\s\S]*?background:\s*var\(--surface-strong\);[\s\S]*?font-size:\s*12px;/);
  assert.match(globalStyles, /\.service-nav-help-tip\s*\{[\s\S]*?transform:\s*translateY\(-50%\);/);
  assert.match(globalStyles, /\.service-nav-help-tip::before\s*\{[\s\S]*?top:\s*50%;[\s\S]*?left:\s*-5px;[\s\S]*?transform:\s*translateY\(-50%\) rotate\(45deg\);/);
  const serviceNavHelpTipRule = globalStyles.match(/\.service-nav-help-tip\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body;
  assert.ok(serviceNavHelpTipRule);
  assert.doesNotMatch(serviceNavHelpTipRule, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.98\);/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.service-nav-help-tip\s*\{[\s\S]*?background:\s*#20242b;/);
  assert.match(controlCenter, /aria-label=\{t\("controlCenter\.help\.viewServiceDescription"/);
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
  assert.match(globalStyles, /\.service-nav-status-label,\s*\.service-nav-version-inline,/);
  assert.match(globalStyles, /\.service-action-button,[\s\S]*?\.service-title-text-button\.service-action-button\s*\{[\s\S]*?border:\s*0;/);
  assert.match(globalStyles, /\.service-action-button,[\s\S]*?\.service-title-text-button\.service-action-button\s*\{[\s\S]*?flex:\s*0 0 32px;[\s\S]*?height:\s*32px;[\s\S]*?max-width:\s*32px;/);
  assert.match(globalStyles, /\.service-action-button svg,[\s\S]*?\.service-action-button \.service-action-icon,[\s\S]*?\.config-terminal-icon svg\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(controlCenter, /<circle cx="12" cy="6\.75" r="2\.15" \/>/);
  assert.match(controlCenter, /<path d="M10\.55 10\.05h2\.9v9\.2h-2\.9z" \/>/);
  assert.match(globalStyles, /\.service-action-button \.service-action-icon-restart,\s*\.service-action-button \.service-action-icon-info\s*\{[\s\S]*?fill:\s*currentColor;[\s\S]*?stroke:\s*none;/);
  assert.match(globalStyles, /\.service-action-button\[data-tooltip\]::after\s*\{[\s\S]*?opacity:\s*0;/);
  assert.match(
    globalStyles,
    /\.service-action-button\[data-tooltip\]:hover:not\(:disabled\)::after,[\s\S]*?transition-delay:\s*0\.12s;/
  );
  const unifiedServiceActionToneRule = globalStyles.match(
    /\.service-action-button\.is-primary,[\s\S]*?\.service-title-text-button\.service-action-button\.is-danger\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body;
  assert.ok(unifiedServiceActionToneRule);
  assert.match(unifiedServiceActionToneRule, /background:\s*var\(--control-center-card-muted\);/);
  assert.match(unifiedServiceActionToneRule, /color:\s*var\(--control-center-subtle\);/);
  assert.doesNotMatch(unifiedServiceActionToneRule, /var\(--control-center-blue\)|var\(--danger\)|#d88911|#ffad4f/);
  assert.match(globalStyles, /\.service-detail-log-action,[\s\S]*?\.control-center-link-action\.icon-link-action\s*\{[\s\S]*?border:\s*1px solid var\(--control-center-border\);/);
  assert.match(globalStyles, /\.config-save-button\s*\{[\s\S]*?min-height:\s*32px;/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.service-action-button,[\s\S]*?:root\[data-theme="dark"\] \.service-title-text-button\.service-action-button\s*\{/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.service-hero-icon\s*\{/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.control-center-page \.config-file-select-panel\s*\{/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.control-center-page \.config-editor\s*\{/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.service-status-message\.danger\s*\{/);
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
    /"(?:正在启动|服务未就绪|启动较慢|已就绪|安装中\.\.\.|初始化中\.\.\.|启动中\.\.\.|等待前序服务|等待启动|重新检查|进入控制中心|认证服务|智能体平台|智能体客户端)"/
  );
});

test("desktop custom theme tokens are shared by control center and log viewer", () => {
  const globalStyles = readRendererStyles();

  assert.match(globalStyles, /:root\s*\{[\s\S]*?--desktop-ui-bg:\s*#ffffff;[\s\S]*?--desktop-ui-card:\s*#ffffff;[\s\S]*?--desktop-ui-primary:\s*#0052d9;[\s\S]*?--desktop-ui-code-bg:\s*#0d1117;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\]\s*\{[\s\S]*?--desktop-ui-bg:\s*#181818;[\s\S]*?--desktop-ui-card:\s*#181818;[\s\S]*?--desktop-ui-primary:\s*#5790ff;[\s\S]*?--desktop-ui-code-bg:\s*#090c11;/);
  assert.match(globalStyles, /\.control-center-page\.workspace-wide,\s*\.control-center-page\s*\{[\s\S]*?--control-center-card:\s*var\(--surface-soft\);[\s\S]*?--control-center-card-muted:\s*var\(--control-select-bg\);[\s\S]*?--control-center-border:\s*var\(--line\);/);
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
  assert.match(sidebarSource, /t\("sidebar\.copilot\.open", \{ appName: PRODUCT_NAME \}\)/);
  assert.match(sidebarSource, /t\("sidebar\.copilot\.close", \{ appName: PRODUCT_NAME \}\)/);
  assert.match(sidebarSource, /t\("sidebar\.copilot\.unavailableForPage", \{ appName: PRODUCT_NAME \}\)/);
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
  const macPluginEmbeddedSelector = ".app-shell.is-mac-platform.is-mac-translucent-sidebar.has-embedded-surface.has-plugin-surface";
  const macPluginEmbeddedRule = globalStyles.match(
    new RegExp(`^${escapeRegExp(macPluginEmbeddedSelector)}\\s*\\{(?<body>[\\s\\S]*?)^\\}`, "m")
  )?.groups?.body ?? "";
  const darkMacPluginEmbeddedRule = globalStyles.match(
    new RegExp(`^:root\\[data-theme="dark"\\] ${escapeRegExp(macPluginEmbeddedSelector)}\\s*\\{(?<body>[\\s\\S]*?)^\\}`, "m")
  )?.groups?.body ?? "";
  const appShellBeforeRule = globalStyles.match(
    /^\.app-shell::before\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body ?? "";
  const darkAppShellBeforeRule = globalStyles.match(
    /^:root\[data-theme="dark"\] \.app-shell::before\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body ?? "";
  const macPluginEmbeddedBeforeRule = globalStyles.match(
    new RegExp(`^${escapeRegExp(`${macPluginEmbeddedSelector}::before`)}\\s*\\{(?<body>[\\s\\S]*?)^\\}`, "m")
  )?.groups?.body ?? "";

  assert.match(globalStyles, /--embedded-surface-shell-bg:\s*#fff;/);
  assert.match(globalStyles, /--embedded-surface-dock-bg:\s*#fff;/);
  assert.match(globalStyles, /:root\s*\{[\s\S]*?--bg-canvas:\s*transparent;/);
  assert.doesNotMatch(globalStyles, /radial-gradient\(circle at 8% 0%,\s*rgba\(122,\s*201,\s*255,\s*0\.48\)/);
  assert.doesNotMatch(globalStyles, /radial-gradient\(circle at 8% 6%,\s*rgba\(255,\s*255,\s*255,\s*0\.42\)/);
  assert.doesNotMatch(globalStyles, /rgba\(196,\s*225,\s*252,\s*0\.(?:28|78)\)/);
  assert.doesNotMatch(globalStyles, /#4A9EDB|#6CB1E4|#A9D0F2|#B6D8F4/);
  assert.match(globalStyles, /:root\[data-theme="dark"\][\s\S]*?--embedded-surface-shell-bg:\s*#1f2329;/);
  assert.match(globalStyles, /body\.embedded-surface-body\s*\{[\s\S]*?padding:\s*0;/);
  assert.match(globalStyles, /\.app-shell\.has-embedded-surface\s*\{[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/);
  assert.match(globalStyles, /\.app-shell\.is-mac-platform\.is-mac-translucent-sidebar\.has-embedded-surface\.has-plugin-surface \.app-content,[\s\S]*?background:\s*transparent;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.app-shell\.is-mac-platform\.is-mac-translucent-sidebar\.has-embedded-surface\.has-plugin-surface \.app-content,[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/);
  assert.match(appShellBeforeRule, /background:\s*transparent;/);
  assert.match(darkAppShellBeforeRule, /background:\s*transparent;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.app-shell\.is-mac-translucent-sidebar\.has-embedded-surface::before\s*\{[\s\S]*?display:\s*none;/);
  assert.match(macPluginEmbeddedBeforeRule, /display:\s*none;/);
  assert.match(globalStyles, /\.app-shell\.has-embedded-surface \.app-content,\s*[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/);
  assert.match(
    globalStyles,
    /\.app-shell\.is-mac-platform\.is-mac-translucent-sidebar\.has-embedded-surface\.has-plugin-surface \.app-content,\s*[\s\S]*?\.app-shell\.is-mac-platform\.is-mac-translucent-sidebar\.has-embedded-surface\.has-plugin-surface \.embedded-surface-frame-shell\s*\{[\s\S]*?background:\s*transparent;/
  );
  assert.match(
    globalStyles,
    /:root\[data-theme="dark"\] \.app-shell\.is-mac-platform\.is-mac-translucent-sidebar\.has-embedded-surface\.has-plugin-surface \.app-content,\s*[\s\S]*?background:\s*var\(--embedded-surface-shell-bg\);/
  );
  assert.match(
    globalStyles,
    /:root\[data-theme="dark"\] \.app-shell\.is-mac-platform\.is-mac-translucent-sidebar\.has-embedded-surface\.has-plugin-surface \.embedded-surface-page,\s*[\s\S]*?background:\s*var\(--embedded-surface-page-bg\);/
  );
  assert.doesNotMatch(globalStyles, /^\.app-shell\.is-windows-platform[^{]*\{[^}]*background:\s*var\(--bg-canvas\);/m);
  assert.match(globalStyles, /\.agent-webclient-copilot-dock\s*\{[\s\S]*?background:\s*var\(--embedded-surface-dock-bg\);/);
  assert.match(globalStyles, /\.embedded-surface-frame\s*\{[\s\S]*?background:\s*var\(--embedded-surface-frame-bg\);/);
  assert.match(globalStyles, /\.embedded-plugin-error\s*\{[\s\S]*?background:\s*var\(--embedded-surface-loading-bg\);/);
  assert.match(globalStyles, /--browser-frame-bg:\s*#ffffff;/);
  assert.match(globalStyles, /\.external-webview-panel\s*\{[\s\S]*?background:\s*var\(--browser-frame-bg\);/);
  assert.match(globalStyles, /\.external-webview-frame\s*\{[\s\S]*?background:\s*var\(--browser-frame-bg\);/);
});

test("sidebar collapse toggle moves into the top chrome with the outline sidebar icon", () => {
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
  assert.match(appShell, /aria-label=\{t\("nav\.sidebar\.resize"\)\}/);
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
  assert.doesNotMatch(sidebarSource, /app-sidebar-collapse-button-icon-chevron/);
  assert.match(collapseToggleIconSource, /<SidebarActionIcon[\s\S]*?kind="sidebar_left"[\s\S]*?className="app-sidebar-collapse-button-icon-panel"/);
  assert.doesNotMatch(collapseToggleIconSource, /viewBox="0 -960 960 960"/);
  assert.match(sidebarSource, /<SidebarCollapseToggleIcon \/>/);
  assert.match(sidebarSource, /<div className="sidebar-chrome">/);
  assert.doesNotMatch(sidebarSource, /sidebar-chrome-drag-region/);
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
  assert.match(globalStyles, /\.app-sidebar-collapse-button-icon-panel\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar-collapse-button-icon-chevron/);
  assert.match(globalStyles, /\.app-sidebar a,\s*[\s\S]*?\.app-sidebar button[\s\S]*?\{[\s\S]*?app-region:\s*no-drag;/);
});

test("body-level popovers stay clickable above Electron drag regions", () => {
  const popoverSource = readSourceFile(
    "src",
    "renderer",
    "components",
    "Popover",
    "index.tsx"
  );
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
  assert.match(popoverSource, /Style\.PopoverDismissLayer/);
  assert.match(popoverSource, /closeOnOutsideClick && isOpen/);
  assert.match(popoverStyles, /\.PopoverDismissLayer\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(popoverStyles, /\.PopoverDismissLayer\s*\{[\s\S]*?z-index:\s*9999;/);
  assert.match(popoverStyles, /\.PopoverDismissLayer\s*\{[\s\S]*?app-region:\s*no-drag;/);
  assert.match(popoverStyles, /\.PopoverDismissLayer\s*\{[\s\S]*?pointer-events:\s*auto;/);
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

test("fixed sidebar settings trigger keeps Settings label and exposes Help affordance", () => {
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
    /const activeFixedToolItem = fixedToolItems\.find\(\(item\) =>\s*isFixedToolRouteActive\(item\.to\),\s*\);[\s\S]{0,120}const settingsToolTriggerLabel = t\("nav\.settings"\);/
  );
  assert.match(
    sidebarSource,
    /function renderToolLink\([\s\S]*?item: SidebarToolItem[\s\S]*?isFixedToolRouteActive\(item\.to\) \? "sidebar-link-active" : ""/
  );
  assert.match(
    sidebarSource,
    /const helpToolItem: SidebarToolItem = \{[\s\S]*?orderKey: "help"[\s\S]*?to: "\/help"[\s\S]*?label: t\("nav\.help"\)[\s\S]*?icon: "help"/
  );
  assert.match(
    sidebarSource,
    /renderToolLink\(helpToolItem,\s*\{[\s\S]*?anchorRef: bootstrapGuideToolHelpAnchorRef/
  );
  assert.doesNotMatch(sidebarSource, /function renderSettingsHelpLink\(/);
  assert.doesNotMatch(sidebarSource, /sidebar-settings-help-link/);
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

test("sidebar primary navigation uses roving tabindex", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );

  assert.match(sidebarSource, /const \[sidebarNavFocusId,\s*setSidebarNavFocusId\] = useState\(""\);/);
  assert.match(sidebarSource, /const resolvedSidebarNavFocusId =\s*sidebarNavFocusId \|\| defaultSidebarNavFocusId;/);
  assert.match(sidebarSource, /function getSidebarRovingItemProps\(id: string, enabled = true\)/);
  assert.match(sidebarSource, /tabIndex:\s*resolvedSidebarNavFocusId === id \? 0 : -1/);
  assert.match(sidebarSource, /data-sidebar-roving-container=\{!isSettingsMode \? "true" : undefined\}/);
  assert.match(sidebarSource, /onKeyDown=\{handleSidebarNavKeyDown\}/);
  assert.match(sidebarSource, /event\.key === "ArrowDown"[\s\S]*?moveSidebarRovingFocus\(currentElement, "next"\)/);
  assert.match(sidebarSource, /event\.key === "ArrowUp"[\s\S]*?moveSidebarRovingFocus\(currentElement, "previous"\)/);
  assert.match(sidebarSource, /event\.key === "Home"[\s\S]*?moveSidebarRovingFocus\(currentElement, "first"\)/);
  assert.match(sidebarSource, /event\.key === "End"[\s\S]*?moveSidebarRovingFocus\(currentElement, "last"\)/);
  assert.match(sidebarSource, /event\.key === "ArrowRight"[\s\S]*?handleSidebarRovingArrowRight\(currentElement\)/);
  assert.match(sidebarSource, /event\.key === "ArrowLeft"[\s\S]*?handleSidebarRovingArrowLeft\(currentElement\)/);
  assert.match(sidebarSource, /event\.key === "ContextMenu" \|\| \(event\.shiftKey && event\.key === "F10"\)/);
});

test("sidebar collapse headers separate trigger and actions", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );
  const collapseSource = readSourceFile(
    "src",
    "renderer",
    "components",
    "Collapse",
    "index.tsx"
  );
  const collapseStyles = readSourceFile(
    "src",
    "renderer",
    "components",
    "Collapse",
    "index.css"
  );

  assert.match(collapseSource, /headerActions\?: React\.ReactNode;/);
  assert.match(collapseSource, /headerButtonProps\?: CollapseHeaderButtonProps;/);
  assert.match(collapseSource, /<div className="Collapse-header">[\s\S]*?<button[\s\S]*?className=\{\["Collapse-trigger"/);
  assert.match(collapseSource, /<div className="Collapse-headerActions">\{headerActions\}<\/div>/);
  assert.doesNotMatch(collapseSource, /className="Collapse-header"[\s\S]{0,160}onClick=\{handleToggle\}/);
  assert.match(collapseStyles, /\.Collapse-trigger\s*\{/);
  assert.match(collapseStyles, /\.Collapse-headerActions\s*\{/);
  assert.match(sidebarSource, /headerButtonProps=\{\{[\s\S]*?className: "assistant-worker-header"[\s\S]*?headerActions=\{/);
  assert.match(sidebarSource, /headerButtonProps=\{\{[\s\S]*?className: groupTriggerClassName[\s\S]*?headerActions=\{/);
  assert.doesNotMatch(sidebarSource, /header=\{\s*<button/);
});

test("sidebar row action buttons stay out of default tab order", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );

  assert.match(sidebarSource, /className="assistant-worker-chat-menu-button"[\s\S]{0,220}tabIndex=\{-1\}/);
  assert.match(sidebarSource, /className="assistant-worker-icon-button sidebar-website-child-action"[\s\S]{0,220}tabIndex=\{-1\}/);
  assert.match(sidebarSource, /className="assistant-worker-icon-button sidebar-assistant-project-button"[\s\S]{0,240}tabIndex=\{-1\}/);
  assert.match(sidebarSource, /className="assistant-worker-icon-button sidebar-website-manage-button"[\s\S]{0,240}tabIndex=\{-1\}/);
  assert.match(sidebarSource, /className="assistant-worker-icon-button sidebar-website-add-button"[\s\S]{0,240}tabIndex=\{-1\}/);
  assert.match(sidebarSource, /function openSidebarRovingContextMenu\(element: HTMLElement\)/);
  assert.match(sidebarSource, /function renderWebItemMenu\(\)/);
  assert.match(sidebarSource, /function renderGroupActionMenu\(\)/);
});

test("sidebar renders Kanban and section groups above the fixed tool menu", () => {
  const appShell = readAppShellSource();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const assistantNavigationSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "assistantNavigation.ts"),
    "utf8"
  );
  const pluginPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "plugin", "PluginPage.tsx"),
    "utf8"
  );
  const brandMarkSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "BrandMark.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const agentIconSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AgentIcon.tsx"),
    "utf8"
  );
  const fixedToolRowsBaseSource =
    sidebarSource.match(/const fixedToolRowsBase[\s\S]*?\n\];/)?.[0] ?? "";

  assert.match(sidebarSource, /kanbanNavItemBase[\s\S]*?orderKey:\s*"kanban"[\s\S]*?to:\s*"\/kanban"/);
  assert.match(sidebarSource, /assistantGroupNavItemBase[\s\S]*?orderKey:\s*"group:assistants"[\s\S]*?entryType:\s*"assistants"/);
  assert.match(sidebarSource, /websGroupNavItemBase[\s\S]*?orderKey:\s*"group:webs"[\s\S]*?entryType:\s*"webs"/);
  assert.match(sidebarSource, /label:\s*t\("nav\.kanban"\)/);
  assert.match(sidebarSource, /label:\s*t\("nav\.assistants"\)/);
  assert.match(sidebarSource, /label:\s*t\("nav\.websites"\)/);
  assert.match(sidebarSource, /SIDEBAR_GROUP_STATE_STORAGE_KEY/);
  assert.match(sidebarSource, /const defaultSidebarGroupState: SidebarGroupState = \{\s*assistants: true,\s*webs: true,/);
  assert.match(sidebarSource, /"data-sidebar-group-id": args\.groupId/);
  assert.match(sidebarSource, /SIDEBAR_ASSISTANT_SORT_STORAGE_KEY/);
  assert.match(sidebarSource, /type AssistantNavSortMode = "byName" \| "byTime"/);
  assert.match(sidebarSource, /const PRIMARY_NAV_HIDDEN_ASSISTANT_AGENT_KEYS = new Set<string>\(\[\s*"desktopAssistant",\s*"webOperator",\s*\]\);/);
  assert.match(sidebarSource, /function shouldShowAssistantInPrimaryNavigation\(agent: AssistantNavAgentItem\)[\s\S]*?PRIMARY_NAV_HIDDEN_ASSISTANT_AGENT_KEYS\.has\(agent\.agentKey\.trim\(\)\)/);
  assert.match(sidebarSource, /const primaryAssistantNavAgents = useMemo\(\s*\(\) => assistantNavAgents\.filter\(shouldShowAssistantInPrimaryNavigation\),\s*\[assistantNavAgents\],\s*\);/);
  assert.match(sidebarSource, /sortAssistantNavAgentsForMode\(primaryAssistantNavAgents, assistantNavSortMode\)/);
  assert.match(sidebarSource, /sidebar\.assistants\.sortByName/);
  assert.match(sidebarSource, /sidebar\.assistants\.sortByTime/);
  assert.match(brandMarkSource, /export type SidebarActionIconKind[\s\S]*\| "sidebar_left"[\s\S]*\| "sidebar_right"[\s\S]*\| "back"[\s\S]*\| "forward"[\s\S]*\| "sort"[\s\S]*\| "new_project"[\s\S]*\| "new_chat"[\s\S]*\| "more_actions"[\s\S]*\| "double_check"[\s\S]*\| "close"[\s\S]*\| "website_open"[\s\S]*\| "website_closed"/);
  assert.match(brandMarkSource, /export function SidebarActionIcon/);
  assert.match(brandMarkSource, /statusColor = kind === "website_open" \? "#10B981" : "#EF4444"/);
  assert.match(sidebarSource, /<SidebarActionIcon[\s\S]*?kind="sidebar_left"[\s\S]*?className="app-sidebar-collapse-button-icon-panel"/);
  assert.match(sidebarSource, /<SidebarActionIcon kind="sort" \/>/);
  assert.doesNotMatch(sidebarSource, /SortAscendingOutlined/);
  assert.match(brandMarkSource, /<path d="M6 5v14" \/>[\s\S]*?<path d="M3\.5 15\.5 6 18l2\.5-2\.5" \/>[\s\S]*?<path d="M12 7h8" \/>[\s\S]*?<path d="M12 12h6" \/>[\s\S]*?<path d="M12 17h4" \/>/);
  assert.doesNotMatch(brandMarkSource, /M13 8\.5h3|L14\.5 5|l-3 4\.5/);
  assert.match(sidebarSource, /<SidebarActionIcon kind="new_project" \/>/);
  assert.match(sidebarSource, /<SidebarActionIcon kind="new_chat" \/>/);
  assert.match(sidebarSource, /<SidebarActionIcon kind="double_check" \/>/);
  assert.match(sidebarSource, /<SidebarActionIcon kind="more_actions" \/>/);
  assert.match(sidebarSource, /const webIconKind = isOpen \? "website_open" : "website_closed"/);
  assert.match(sidebarSource, /<SidebarActionIcon kind=\{webIconKind\} \/>/);
  assert.doesNotMatch(sidebarSource, /EditSquareIcon|AddIcon/);
  assert.doesNotMatch(sidebarSource, /assistant-material-icon is-(?:more|done-all|add)/);
  assert.doesNotMatch(sidebarSource, /assistantHomeNavItem/);
  assert.doesNotMatch(sidebarSource, /智能助理首页|智能助手首页/);
  assert.match(sidebarSource, /createAgentRoute\(agent\.agentKey\)/);
  assert.match(sidebarSource, /createAgentChatRoute\(chat\.agentKey/);
  assert.match(sidebarSource, /createAgentNewChatRoute\(agent\.agentKey\)/);
  assert.match(sidebarSource, /type AgentSelectionOptions = \{\s*preferNewChat\?: boolean;\s*\};/);
  assert.match(sidebarSource, /function createAgentSelectionRoute\(\s*agent: AssistantNavAgentItem,\s*options: AgentSelectionOptions = \{\},\s*\)/);
  assert.match(assistantNavigationSource, /function readAssistantNavChatIsRead\(record: Record<string, unknown>\)/);
  assert.match(assistantNavigationSource, /isObjectRecord\(record\.read\) && typeof record\.read\.isRead === "boolean"/);
  assert.match(assistantNavigationSource, /export function getAssistantNavAgentPreviewChats/);
  assert.match(assistantNavigationSource, /export function getAssistantNavAgentSortedChats/);
  assert.match(assistantNavigationSource, /return getAssistantNavAgentSortedChats\(agent\)\.slice\(0, normalizedLimit\);/);
  assert.match(assistantNavigationSource, /export function getAssistantNavAgentAttentionChat/);
  assert.match(assistantNavigationSource, /const runningChat = chats\.find\(\(chat\) => chat\.hasActiveRun === true\);/);
  assert.match(assistantNavigationSource, /latestChat\.hasPendingAwaiting === true/);
  assert.match(assistantNavigationSource, /latestChat\.isRead === false/);
  assert.match(sidebarSource, /getAssistantNavAgentPreviewChats\(agent\)/);
  assert.match(sidebarSource, /getAssistantNavAgentSortedChats\(agent\)/);
  assert.match(sidebarSource, /const attentionChat = getAssistantNavAgentAttentionChat\(agent\);/);
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
  assert.doesNotMatch(sidebarSource, /function dispatchAgentRouteActionToActiveWebview\(targetPath: string\)/);
  assert.doesNotMatch(sidebarSource, /"agent:start-new-conversation"/);
  assert.doesNotMatch(sidebarSource, /"agent:load-chat"/);
  assert.match(sidebarSource, /params\.set\("newChat", "1"\)/);
  assert.match(sidebarSource, /params\.set\("newChatRequest", String\(Date\.now\(\)\)\)/);
  assert.match(sidebarSource, /setExpandedAssistantAgentKey\(result\.agentKey\);\s*requestNavigate\(createAgentNewChatRoute\(result\.agentKey\)\);/);
  assert.match(sidebarSource, /newChatRequested: url\.searchParams\.get\("newChat"\)\?\.trim\(\) === "1"/);
  assert.match(sidebarSource, /requestNavigate\(\s*createAgentChatRoute\(chat\.agentKey \|\| currentAgentKey, chat\.chatId\),\s*\{\s*retriggerAgentRoute:\s*true,?\s*\},?\s*\)/);
  assert.doesNotMatch(sidebarSource, /targetAgentInfo\.newChatRequested/);
  assert.match(sidebarSource, /function handleAssistantAgentExpand\(\s*agent: AssistantNavAgentItem,\s*expanded: boolean,\s*\) \{[\s\S]*?if \(!expanded\) \{[\s\S]*?return;[\s\S]*?createAgentSelectionRoute\(agent, \{ preferNewChat: !isCollapsed \}\)[\s\S]*?retriggerAgentRoute: true/);
  assert.match(sidebarSource, /onExpand=\{\(val\) => handleAssistantAgentExpand\(agent, val\)\}/);
  assert.doesNotMatch(sidebarSource, /handleAssistantAgentHeaderClick/);
  assert.match(sidebarSource, /displayCurrentPathname\.startsWith\("\/agent\/"\)/);
  assert.match(sidebarSource, /pendingPath\?\.startsWith\("\/agent\/"\)/);
  assert.doesNotMatch(sidebarSource, /nonce=/);
  assert.doesNotMatch(sidebarSource, /AssistantHistoryState/);
  assert.doesNotMatch(sidebarSource, /assistantHistory/);
  assert.doesNotMatch(sidebarSource, /renderAssistantHistory/);
  assert.match(sidebarSource, /const recentChats = getAssistantNavAgentPreviewChats\(agent\);/);
  assert.match(sidebarSource, /const chatCount = Math\.max\(\s*0,\s*getAssistantNavAgentNonNegativeInteger\(agent\.chatCount\),\s*allRecentChats\.length,?\s*\);/);
  assert.match(sidebarSource, /const rowUnreadCount = allRecentChats\.filter\(\(chat\) => !chat\.isRead\)\.length;/);
  assert.match(sidebarSource, /recentChats\.length > 0 \? \(/);
  assert.match(sidebarSource, /agent\.latestPreview \|\| \(chatCount > 0 \? "" : t\("sidebar\.agent\.noChats"\)\)/);
  assert.match(sidebarSource, /\) : chatCount === 0 \? \(\s*<div className="status-line">\{t\("sidebar\.agent\.noChats"\)\}<\/div>/);
  assert.match(sidebarSource, /chatCount > recentChats\.length \? \(/);
  assert.match(sidebarSource, /historyRequested: url\.searchParams\.get\("history"\)\?\.trim\(\) === "1"/);
  assert.doesNotMatch(sidebarSource, /SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL/);
  assert.doesNotMatch(sidebarSource, /webview\.send\(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL,\s*\{\s*action:\s*"openChatHistory"/);
  assert.doesNotMatch(sidebarSource, /workerKey: `agent:\$\{agentKey\}`/);
  assert.match(sidebarSource, /lastRouteAgentInfoRef = useRef\(readAgentRouteInfo\(currentRoute\)\)/);
  assert.match(sidebarSource, /previousRouteAgentInfo\.historyRequested/);
  assert.match(sidebarSource, /setExpandedAssistantAgentKey\(""\)/);
  assert.match(sidebarSource, /requestNavigate\(\s*createAgentHistoryRoute\(agent\.agentKey\),\s*\{\s*retriggerAgentRoute:\s*true,?\s*\}\s*\)/);
  assert.match(sidebarSource, /unread:\s*rowUnreadCount > 0 \? t\("sidebar\.chat\.unreadSuffix", \{ count: rowUnreadCount \}\) : ""/);
  assert.match(sidebarSource, /<div className="status-line">\{t\("sidebar\.agent\.noChats"\)\}<\/div>/);
  assert.doesNotMatch(sidebarSource, /暂无相关会话/);
  assert.doesNotMatch(sidebarSource, /Math\.max\(agent\.chatCount, recentChats\.length\) > 5/);
  assert.match(sidebarSource, /renderStatusBadges/);
  assert.match(sidebarSource, /function renderSidebarGroupStatusBadges\(\s*groupId: SidebarGroupId,\s*status\?: SidebarStatusSummary,\s*\)/);
  assert.match(sidebarSource, /groupId === "assistants"[\s\S]{0,180}pendingCount:\s*0/);
  assert.doesNotMatch(sidebarSource, /renderStatusBadges\(args\.status,\s*"sidebar-group-status"\)/);
  assert.match(sidebarSource, /summarizeAgentStatus\(primaryAssistantNavAgents\)/);
  assert.match(sidebarSource, /assistant-worker-collapse worker-collapse/);
  const newChatHandlerStart = sidebarSource.indexOf("function handleAssistantNewChat");
  const markAllReadHandlerStart = sidebarSource.indexOf("async function handleAssistantMarkAllRead");
  assert.ok(newChatHandlerStart >= 0);
  assert.ok(markAllReadHandlerStart > newChatHandlerStart);
  const newChatHandler = sidebarSource.slice(newChatHandlerStart, markAllReadHandlerStart);
  assert.doesNotMatch(newChatHandler, /preferNewChat|createAgentSelectionRoute/);
  assert.match(newChatHandler, /requestNavigate\(\s*createAgentNewChatRoute\(agent\.agentKey\),\s*\{\s*retriggerAgentRoute:\s*true,?\s*\}\s*\)/);
  const activeChatIdStart = sidebarSource.indexOf("function getActiveSidebarChatId");
  const routeActiveStart = sidebarSource.indexOf("function isRouteActive", activeChatIdStart);
  assert.ok(activeChatIdStart >= 0);
  assert.ok(routeActiveStart > activeChatIdStart);
  const activeChatIdBlock = sidebarSource.slice(activeChatIdStart, routeActiveStart);
  assert.match(activeChatIdBlock, /chats: AssistantNavChatItem\[\] = \[\]/);
  assert.match(activeChatIdBlock, /currentChatId \|\| \(pendingPath && pendingChatId \? pendingChatId : ""\)/);
  assert.match(activeChatIdBlock, /routeChatId && chats\.some\(\(chat\) => chat\.chatId === routeChatId\)/);
  assert.match(activeChatIdBlock, /if \(routeChatId\) \{\s*return routeChatId;\s*\}\s*return "";/);
  assert.match(sidebarSource, /"assistant-worker-collapse-item"/);
  assert.match(sidebarSource, /className="assistant-worker-header-text"/);
  assert.match(sidebarSource, /<AgentIcon[\s\S]*?icon=\{agent\.icon\}[\s\S]*?className="worker-panel-icon"[\s\S]*?type="agent"[\s\S]*?\/>/);
  assert.doesNotMatch(sidebarSource, /renderAssistantAgentIcon/);
  assert.doesNotMatch(sidebarSource, /SidebarIllustration kind="agent"/);
  assert.match(sidebarSource, /worker-panel-header-body/);
  assert.match(sidebarSource, /worker-panel-role/);
  assert.match(sidebarSource, /HIDDEN_ASSISTANT_ROLE_MODES[\s\S]*?"CODER"[\s\S]*?"KBASE"/);
  assert.match(sidebarSource, /function getAssistantAgentRoleLabel\(agent: AssistantNavAgentItem\)/);
  assert.match(sidebarSource, /HIDDEN_ASSISTANT_ROLE_AGENT_TYPES\.has\(agentType\)[\s\S]*?HIDDEN_ASSISTANT_ROLE_MODES\.has\(mode\)[\s\S]*?return "";/);
  assert.match(sidebarSource, /if \(!role \|\| role === "--"\) \{\s*return "";\s*\}/);
  assert.match(sidebarSource, /const agentRole = getAssistantAgentRoleLabel\(agent\);/);
  assert.match(sidebarSource, /agentRole \? \([\s\S]{0,200}worker-panel-role/);
  assert.doesNotMatch(sidebarSource, /agent\.role \|\| "--"/);
  assert.match(sidebarSource, /worker-panel-preview/);
  assert.match(sidebarSource, /worker-chat-item-head/);
  assert.match(sidebarSource, /worker-chat-name/);
  assert.match(sidebarSource, /worker-panel-time-label/);
  assert.match(sidebarSource, /<Tooltip content=\{t\("sidebar\.agent\.markAllRead"\)\}>/);
  assert.match(sidebarSource, /<Tooltip content=\{t\("sidebar\.agent\.newChat"\)\}>/);
  assert.match(sidebarSource, /t\("sidebar\.chat\.viewMore", \{/);
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
  assert.match(sidebarSource, /type AssistantChatDeleteDialogState = \{/u);
  assert.match(sidebarSource, /function renderAssistantChatDeleteDialog\(\)/u);
  assert.doesNotMatch(sidebarSource, /window\.confirm\(t\("sidebar\.chat\.deleteConfirm"/u);
  assert.match(sidebarSource, /t\("sidebar\.chat\.deleteConfirm", \{ name: chatLabel \}\)/u);
  assert.match(sidebarSource, /t\("common\.cancel"\)/u);
  assert.match(sidebarSource, /t\("common\.confirm"\)/u);
  assert.match(confirmRenameChatHandler, /const result = await window\.electronAPI\.assistant\.renameChat\(/u);
  assert.match(confirmRenameChatHandler, /assistantChatRenameDialog\.chat\.chatId/u);
  assert.match(confirmRenameChatHandler, /if \(!result\.ok\)/u);
  assert.match(confirmRenameChatHandler, /setAssistantChatRenameDialog\(null\)/u);
  assert.match(confirmRenameChatHandler, /await onRefreshAssistantNavAgents\?\.\(\)/u);
  assert.doesNotMatch(sidebarSource, /sidebar\.agent\.delete/);
  assert.match(sidebarSource, /schedulesNavItemBase[\s\S]*?to:\s*"\/automations"[\s\S]*?icon:\s*"schedule"/);
  assert.match(fixedToolRowsBaseSource, /to:\s*"\/agents"[\s\S]*?labelKey:\s*"nav\.agents"[\s\S]*?to:\s*"\/archives"[\s\S]*?labelKey:\s*"nav\.archives"[\s\S]*?icon:\s*"archive"[\s\S]*?to:\s*"\/registries"[\s\S]*?labelKey:\s*"nav\.registries"[\s\S]*?to:\s*"\/market"[\s\S]*?labelKey:\s*"nav\.market"/);
  assert.doesNotMatch(fixedToolRowsBaseSource, /to:\s*"\/memory"[\s\S]*?labelKey:\s*"nav\.memory"/);
  assert.match(fixedToolRowsBaseSource, /to:\s*"\/settings"[\s\S]*?labelKey:\s*"nav\.settings"/);
  assert.doesNotMatch(fixedToolRowsBaseSource, /to:\s*"\/control-center"/);
  assert.doesNotMatch(fixedToolRowsBaseSource, /to:\s*"\/help"/);
  assert.match(sidebarSource, /const helpToolItem: SidebarToolItem = \{[\s\S]*?to:\s*"\/help"/);
  assert.match(sidebarSource, /renderToolLink\(helpToolItem,\s*\{[\s\S]*?anchorRef: bootstrapGuideToolHelpAnchorRef/);
  assert.match(sidebarSource, /settingsToolItem \? renderToolLink\(settingsToolItem\) : null/);
  assert.match(sidebarSource, /AGENT_WEBCLIENT_MANAGEMENT_ROUTE_PATHS[\s\S]*?routeDefinition\.kind === "management"[\s\S]*?function isAgentWebclientManagementRoute\(route: string\)/);
  assert.match(sidebarSource, /forcedActiveManagementRoute[\s\S]*?displayCurrentPathname[\s\S]*?activeSidebarAgentKey/);
  assert.match(sidebarSource, /function handleItemClick\([\s\S]*?targetPath === currentRoute[\s\S]*?targetPathname === currentPathname[\s\S]*?setForcedActiveManagementRoute\(targetPath\)[\s\S]*?dispatchAgentWebclientManagementRouteToActiveWebview\(targetPath\)/);
  assert.match(sidebarSource, /function isFixedToolRouteActive\(targetPath: string\)[\s\S]*?displayCurrentPathname === targetPathname/);
  assert.match(sidebarSource, /function dispatchAgentWebclientManagementRouteToActiveWebview\(targetPath: string\)[\s\S]*?window\.history\.pushState[\s\S]*?PopStateEvent\("popstate"/);
  assert.doesNotMatch(sidebarSource, /"settings-help"/);
  assert.doesNotMatch(sidebarSource, /"sidebar-settings-help-link"/);
  assert.doesNotMatch(fixedToolRowsBaseSource, /to:\s*"\/automations"/);
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
  assert.match(sidebarSource, /label:\s*t\("nav\.kanban"\)[\s\S]*?label:\s*t\("nav\.schedules"\)[\s\S]*?label:\s*t\("nav\.assistants"\)[\s\S]*?label:\s*t\("nav\.websites"\)/);
  assert.match(globalStyles, /\.sidebar-tool-menu\s*\{[\s\S]*?flex-direction:\s*column;/);
  assert.doesNotMatch(globalStyles, /\.sidebar-settings-help-link/);
  assert.match(globalStyles, /\.sidebar-group-heading\s*\{/);
  assert.match(globalStyles, /\.sidebar-group-heading:hover\s*\{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--ink-muted\)\s*10%,\s*transparent\);[\s\S]*?\}/);
  assert.match(globalStyles, /\.sidebar-group-heading\[data-sidebar-group-id="webs"\]:hover,[\s\S]*?\.sidebar-group-heading\[data-sidebar-group-id="webs"\]\.is-active,[\s\S]*?\.sidebar-group-heading\[data-sidebar-group-id="assistants"\]:hover,[\s\S]*?\.sidebar-group-heading\[data-sidebar-group-id="assistants"\]\.is-active\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border-color:\s*transparent;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.sidebar-group-heading\[data-sidebar-group-id="webs"\]:hover,[\s\S]*?:root\[data-theme="dark"\] \.sidebar-group-heading\[data-sidebar-group-id="webs"\]\.is-active,[\s\S]*?:root\[data-theme="dark"\] \.sidebar-group-heading\[data-sidebar-group-id="assistants"\]:hover,[\s\S]*?:root\[data-theme="dark"\] \.sidebar-group-heading\[data-sidebar-group-id="assistants"\]\.is-active\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border-color:\s*transparent;/);
  assert.match(globalStyles, /\.sidebar-group-divider\s*\{/);
  assert.match(globalStyles, /\.sidebar-group-children\s*\{[\s\S]*?gap:\s*2px;[\s\S]*?padding:\s*0;[\s\S]*?border-left:\s*0;/);
  assert.match(globalStyles, /\.sidebar-link\.sidebar-tool-menu-trigger,[\s\S]*?\.sidebar-link\.sidebar-tool-menu-trigger\.sidebar-link-active,[\s\S]*?\.app-sidebar\.is-collapsed \.sidebar-link\.sidebar-tool-menu-trigger,[\s\S]*?:root\[data-theme="dark"\] \.sidebar-link\.sidebar-tool-menu-trigger\.sidebar-link-active\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/);
  assert.match(globalStyles, /\.sidebar-link-active\s*\{[\s\S]*?color:\s*#1677ff;[\s\S]*?background:\s*rgba\(22,\s*119,\s*255,\s*0\.13\);/);
  assert.match(globalStyles, /\.app-shell\.is-mac-platform \.sidebar-top-actions\s*\{[\s\S]*?top:\s*12px;/);
  assert.match(globalStyles, /\.app-shell\.is-mac-platform \.app-sidebar\.is-collapsed \.sidebar-top-actions\s*\{[\s\S]*?top:\s*38px;/);
  assert.match(globalStyles, /\.sidebar-link-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;[\s\S]*?color:\s*#94a3b8;/);
  assert.match(globalStyles, /\.sidebar-action-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(globalStyles, /\.sidebar-link-icon\s*\{[\s\S]*?--sidebar-special-icon-active-frame:\s*#475569;/);
  assert.match(globalStyles, /\.sidebar-link-active \.sidebar-link-icon,[\s\S]*?\.sidebar-group-heading\.is-active \.sidebar-link-icon\s*\{[\s\S]*?color:\s*#1e293b;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.sidebar-link-icon\s*\{[\s\S]*?--sidebar-special-icon-active-frame:\s*#e2e8f0;/);
  assert.match(globalStyles, /\.sidebar-link-active \.sidebar-illustration-kanban \.sidebar-illustration-kanban-frame,[\s\S]*?\.sidebar-link-active \.sidebar-illustration-automation \.sidebar-illustration-automation-ring\s*\{[\s\S]*?stroke:\s*var\(--sidebar-special-icon-active-frame\);/);
  assert.match(globalStyles, /\.sidebar-link-active \.sidebar-illustration-kanban \.sidebar-illustration-kanban-lane-blue\s*\{[\s\S]*?stroke:\s*#3b82f6;/);
  assert.match(globalStyles, /\.sidebar-link-active \.sidebar-illustration-automation \.sidebar-illustration-automation-hand\s*\{[\s\S]*?stroke:\s*#3b82f6;/);
  assert.match(globalStyles, /\.sidebar-group-heading \.sidebar-link-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(globalStyles, /\.sidebar-child-link \.sidebar-link-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(globalStyles, /\.sidebar-tool-menu \.sidebar-tool-menu-item \.sidebar-link-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(globalStyles, /\.sidebar-account-menu \.sidebar-link-icon,[\s\S]*?\.sidebar-account-menu-icon\s*\{[\s\S]*?flex:\s*0 0 16px;[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(globalStyles, /\.app-sidebar\.is-collapsed \.sidebar-link-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(globalStyles, /\.app-sidebar\.is-collapsed \.sidebar-group-trigger \.sidebar-link-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.match(globalStyles, /\.app-sidebar\.is-collapsed \.sidebar-tool-menu-trigger \.sidebar-link-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  assert.doesNotMatch(globalStyles, /\.sidebar-link(?:[\s\S]{0,120})\.sidebar-link-icon(?:[\s\S]{0,120})filter:\s*grayscale/);
  assert.match(globalStyles, /\.sidebar-custom-child-link\s*\{[\s\S]*?padding-left:\s*4px !important;/);
  assert.doesNotMatch(globalStyles, /--sidebar-group-child-indent/);
  assert.doesNotMatch(globalStyles, /--sidebar-group-child-pill-padding/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar:not\(\.is-collapsed\) \.sidebar-group-children \.sidebar-child-link/);
  assert.match(globalStyles, /\.assistant-worker-name\s*\{[\s\S]*?font-weight:\s*500;/);
  assert.match(globalStyles, /\.worker-panel-role\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?font-weight:\s*400;/);
  assert.match(globalStyles, /\.worker-panel-preview\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?height:\s*20px;/);
  assert.match(globalStyles, /\.worker-chat-name\s*\{[\s\S]*?font-size:\s*13px;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item>\.Collapse-header\s*\{[\s\S]*?align-items:\s*stretch;[\s\S]*?min-height:\s*36px;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item>\.Collapse-header \.Collapse-headerActions\s*\{[\s\S]*?align-self:\s*stretch;[\s\S]*?justify-content:\s*flex-end;[\s\S]*?gap:\s*4px;[\s\S]*?min-height:\s*36px;/);
  assert.match(globalStyles, /\.assistant-worker-header\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?min-height:\s*36px;[\s\S]*?padding:\s*6px 8px;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-expanded \.assistant-worker-header\s*\{[\s\S]*?padding:\s*2px 8px;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\s*\{[\s\S]*?transition:[\s\S]*?transform 0\.2s ease-in-out;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-expanded\s*\{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.15\);[\s\S]*?box-shadow:\s*var\(--panel-shadow\);[\s\S]*?transform:\s*none;/);
  assert.match(globalStyles, /\.worker-panel-header\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;/);
  assert.match(globalStyles, /\.worker-panel-icon\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;[\s\S]*?transition:\s*transform 0\.2s ease-in-out;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-expanded \.worker-panel-icon\s*\{[\s\S]*?transform:\s*scale\(0\.8\);/);
  assert.match(globalStyles, /\.assistant-worker-actions\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*flex-end;[\s\S]*?gap:\s*4px;[\s\S]*?height:\s*28px;/);
  assert.match(globalStyles, /\.assistant-worker-icon-button\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?border-radius:\s*6px;/);
  assert.match(globalStyles, /\.worker-chat-preview-list \.status-line\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?color:\s*var\(--ink-muted\);/);
  assert.match(agentIconSource, /defaultIcon from "\.\.\/\.\.\/assets\/agent-icons\/default\.svg"/);
  assert.match(agentIconSource, /kbaseIcon from "\.\.\/\.\.\/assets\/agent-icons\/kbase\.svg"/);
  assert.match(agentIconSource, /const IconMap/);
  assert.match(agentIconSource, /AGENT_ICON_NAMES[\s\S]*"folder"[\s\S]*"coder"[\s\S]*"kbase"[\s\S]*"terminal"/);
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
  assert.doesNotMatch(appShell, /kanbanEnabled=\{true\}/);
  assert.match(appShell, /path="\/kanban"[\s\S]*?!kanbanSettingsLoaded[\s\S]*?!kanbanEnabled[\s\S]*?<Navigate to="\/control-center" replace \/>[\s\S]*?<RouteSuspense><KanbanPage hostTheme=\{resolvedTheme\} \/><\/RouteSuspense>/);
  assert.doesNotMatch(appShell, /KanbanPlaceholderPage/);
  assert.match(sidebarSource, /label:\s*t\("nav\.kanban"\)/);
  assert.match(appShell, /assistantNavAgents/);
  assert.match(appShell, /listNavigationAgents/);
  assert.match(appShell, /key:\s*"agents"[\s\S]*?routePath:\s*"\/agents"[\s\S]*?embedPath:\s*"\/agents"[\s\S]*?labelKey:\s*"nav\.agents"[\s\S]*?kind:\s*"management"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"archives"[\s\S]*?routePath:\s*"\/archives"[\s\S]*?embedPath:\s*"\/archives"[\s\S]*?labelKey:\s*"nav\.archives"[\s\S]*?kind:\s*"management"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"schedules"[\s\S]*?routePath:\s*"\/automations"[\s\S]*?embedPath:\s*"\/automations"[\s\S]*?labelKey:\s*"nav\.schedules"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"registries"[\s\S]*?routePath:\s*"\/registries"[\s\S]*?embedPath:\s*"\/registries"[\s\S]*?labelKey:\s*"nav\.registries"[\s\S]*?kind:\s*"management"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"copilot"[\s\S]*?routePath:\s*"\/copilot"[\s\S]*?embedPath:\s*"\/copilot"[\s\S]*?labelKey:\s*"nav\.assistants"[\s\S]*?kind:\s*"copilot"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /AGENT_WEBCLIENT_DYNAMIC_ROUTE_PATTERNS[\s\S]*?"\/agents\/:agentKey"[\s\S]*?"\/copilot\/:agentKey"[\s\S]*?"\/agent\/:agentKey"/);
  assert.match(appShell, /const rawActiveAgentWebclientRoute = resolveAgentWebclientRoute\(location\.pathname,\s*location\.search/);
  assert.match(appShell, /const rawActiveAgentWebclientRouteLabelKey = rawActiveAgentWebclientRoute\?\.labelKey/);
  assert.match(appShell, /I18N_KEYS\.includes\(rawActiveAgentWebclientRouteLabelKey as TranslationKey\)[\s\S]{0,120}t\(rawActiveAgentWebclientRouteLabelKey as TranslationKey\)[\s\S]{0,120}rawActiveAgentWebclientRoute\.label \?\? rawActiveAgentWebclientRouteLabelKey/);
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
  assert.match(appShell, /if \(!isSingleAgentWebclientRoute\(location\.pathname\)\) \{[\s\S]*?return;[\s\S]*?new URLSearchParams\(location\.search\)\.get\("chatId"\)\?\.trim\(\)[\s\S]*?void refreshAssistantNavAgents\(\);[\s\S]*?\}, \[currentRoute\]\);/);
  assert.match(appShell, /function resolveAgentManagementWebclientRoute\(pathname: string, search: string\)/);
  assert.match(appShell, /matchPath\("\/agents\/:agentKey", pathname\)/);
  assert.match(appShell, /embedPath:\s*`\$\{pathname\}\$\{search\}`/);
  assert.match(appShell, /key:\s*"agents"[\s\S]*?routePath:\s*"\/agents"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"archives"[\s\S]*?routePath:\s*"\/archives"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"schedules"[\s\S]*?routePath:\s*"\/automations"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /key:\s*"registries"[\s\S]*?routePath:\s*"\/registries"[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /function resolveAgentManagementWebclientRoute\(pathname: string, search: string\)[\s\S]*?mode:\s*"embedded"/);
  assert.match(appShell, /for \(const key of \["chatId", "history", "historyRequest", "newChat", "newChatRequest"\]\)/);
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
  assert.match(sidebarSource, /aria-label=\{t\("sidebar\.navigation\.back"\)\}/);
  assert.match(sidebarSource, /aria-label=\{t\("sidebar\.navigation\.forward"\)\}/);
  assert.match(sidebarSource, /disabled=\{!sidebarNavigationCanGoBack\}/);
  assert.match(sidebarSource, /disabled=\{!sidebarNavigationCanGoForward\}/);
  assert.match(sidebarSource, /onClick=\{onSidebarNavigateBack\}/);
  assert.match(sidebarSource, /onClick=\{onSidebarNavigateForward\}/);
  assert.match(sidebarSource, /requestNavigate\(\s*createAgentHistoryRoute\(agent\.agentKey\),\s*\{\s*retriggerAgentRoute:\s*true,?\s*\}\s*\)/);
  assert.doesNotMatch(sidebarSource, /action:\s*"openChatHistory"/);

  assert.match(globalStyles, /\.sidebar-history-controls\s*\{/);
  assert.match(globalStyles, /\.sidebar-history-button:disabled\s*\{/);
  assert.doesNotMatch(settingsPage, /sidebarNavigationCanGoBack/);
  assert.doesNotMatch(settingsPage, /onSidebarNavigateBack/);
});

test("assistant sidebar chat history selection follows the current chat route", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );
  const globalStyles = readRendererStyles();

  assert.match(sidebarSource, /const pendingChatId = pendingRouteAgentInfo\.chatId;/);
  assert.match(sidebarSource, /const activeSidebarAgentKey =\s*currentAgentKey \|\|[\s\S]{0,120}pendingAgentKey : ""/);
  assert.match(sidebarSource, /function getActiveSidebarAgentKey\(\)/);
  assert.match(sidebarSource, /function getActiveSidebarChatId\(\s*agentKey: string,\s*chats: AssistantNavChatItem\[\] = \[\],\s*\)/);
  assert.match(sidebarSource, /agent\.agentKey === activeSidebarAgentKey/);
  assert.match(sidebarSource, /const activeAgentChanged =\s*lastAutoExpandedAssistantAgentKeyRef\.current !== matched\.agentKey;/);
  assert.match(sidebarSource, /if \(activeAgentChanged\) \{[\s\S]{0,220}setExpandedAssistantAgentKey\(matched\.agentKey\);/);
  assert.match(sidebarSource, /\}, \[assistantNavAgents, activeSidebarAgentKey, expandedAssistantAgentKey\]\);/);
  assert.match(sidebarSource, /const routeChatId =\s*currentChatId \|\| \(pendingPath && pendingChatId \? pendingChatId : ""\);/);
  assert.match(sidebarSource, /if \(routeChatId\) \{[\s\S]{0,80}return routeChatId;/);
  assert.match(sidebarSource, /const activeChatId = getActiveSidebarChatId\(agent\.agentKey, allRecentChats\);/);
  assert.match(sidebarSource, /const selected = getActiveSidebarAgentKey\(\) === agent\.agentKey \|\| Boolean\(activeChatId\);/);
  assert.doesNotMatch(sidebarSource, /const activeChatId = currentChatId \|\| "";/);
  assert.match(sidebarSource, /selected \? "is-selected" : ""/);
  assert.match(sidebarSource, /selected \? "is-active" : ""/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-selected>\.Collapse-header/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item>\.Collapse-header \.Collapse-trigger\s*\{[\s\S]{0,120}flex:\s*1 1 0;/);
  assert.match(globalStyles, /\.assistant-worker-header-text\s*\{[\s\S]{0,160}width:\s*100%;/);
  assert.match(globalStyles, /\.worker-panel-header\s*\{[\s\S]{0,180}width:\s*100%;/);
  assert.match(globalStyles, /\.worker-panel-preview\s*\{[\s\S]{0,180}width:\s*100%;/);
  assert.match(globalStyles, /\.worker-panel-preview>\.chat-awaiting-status\s*\{[\s\S]{0,80}margin-left:\s*auto;/);
  assert.match(globalStyles, /\.assistant-worker-badge\s*\{[\s\S]{0,120}margin-left:\s*auto;/);
  assert.match(globalStyles, /\.assistant-worker-header\.is-active/);
  assert.match(globalStyles, /\.assistant-worker-chat-item\.is-active\s*\{[\s\S]{0,120}background:\s*transparent;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-selected\s*\{[\s\S]{0,120}background:\s*rgba\(var\(--accent-rgb\),\s*0\.08\);/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-selected\.is-expanded\s*\{[\s\S]{0,160}border-color:\s*rgba\(var\(--accent-rgb\),\s*0\.18\);/);
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
  assert.match(sidebarSource, /action === "awaiting" \|\| action === "loading" \? "has-status-action" : ""/);
  assert.match(sidebarSource, /chat\.hasPendingAwaiting \? "has-awaiting" : ""/);
  assert.match(sidebarSource, /getAssistantAwaitingStatusKey\(chat\.awaitingMode\)/);
  assert.match(sidebarSource, /className="worker-chat-loading assistant-material-icon is-loading"/);
  assert.doesNotMatch(sidebarSource, /assistant-worker-awaiting-ring/);
  assert.doesNotMatch(globalStyles, /assistant-worker-awaiting-ring/);
  assert.match(globalStyles, /\.chat-awaiting-status\s*\{[\s\S]{0,160}color:\s*#b45309;[\s\S]{0,160}background:\s*rgba\(245, 158, 11, 0\.12\);/);
  assert.doesNotMatch(globalStyles, /\.chat-awaiting-status\s*\{[\s\S]{0,180}var\(--success\)/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.chat-awaiting-status\s*\{[\s\S]{0,140}color:\s*#facc15;[\s\S]{0,140}background:\s*rgba\(180, 83, 9, 0\.24\);/);
  assert.match(globalStyles, /\.assistant-worker-chat-item\.has-awaiting \.chat-awaiting-status\s*\{[\s\S]{0,80}margin-left: auto;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\],\s*\.assistant-worker-chat-action\[data-action="loading"\]\s*\{[\s\S]{0,100}width: 18px;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\]\s*\{[\s\S]{0,80}color:\s*#b45309;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="loading"\]\s*\{[\s\S]{0,80}color:\s*var\(--ink-muted\);/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-panel-time-label,\s*\.assistant-worker-chat-action\[data-action="loading"\] \.worker-panel-time-label\s*\{[\s\S]{0,80}display: none;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-chat-loading,\s*\.assistant-worker-chat-action\[data-action="loading"\] \.worker-chat-loading\s*\{[\s\S]{0,120}display: inline-flex;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-chat-loading\s*\{[\s\S]{0,80}color:\s*#b45309;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="loading"\] \.worker-chat-loading\s*\{[\s\S]{0,80}color:\s*var\(--ink-muted\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.chat-awaiting-status \+ \.sidebar-assistant-preview-loading,\s*:root\[data-theme="dark"\] \.assistant-worker-chat-action\[data-action="awaiting"\],\s*:root\[data-theme="dark"\] \.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-chat-loading\s*\{[\s\S]{0,80}color:\s*#facc15;/);
  assert.match(globalStyles, /\.assistant-worker-chat-row\.has-status-action:hover \.assistant-worker-chat-menu-button,\s*\.assistant-worker-chat-row\.has-status-action:focus-within \.assistant-worker-chat-menu-button\s*\{[\s\S]{0,60}display:\s*none;/);
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
  assert.match(sidebarSource, /"\\u601d\\u8003\\u4e2d"/);
  assert.match(sidebarSource, /"\\u601d\\u8003\\u4e2d\.\.\."/);
  assert.match(sidebarSource, /"thinking"/);
  assert.match(sidebarSource, /"thinking\.\.\."/);
  assert.match(sidebarSource, /const action = chat\.hasPendingAwaiting\s*\?\s*"awaiting"\s*:\s*chat\.hasActiveRun\s*\?\s*"loading"/);
  assert.match(sidebarSource, /chat\.hasActiveRun && isAssistantRunningPreview\(chat\.lastRunContent\)/);
  assert.match(sidebarSource, /className="worker-chat-loading assistant-material-icon is-loading"/);
  assert.match(sidebarSource, /previewStatus \? \(\s*<span[\s\S]{0,220}sidebar-assistant-preview-loading/);
  assert.match(sidebarSource, /!\s*previewStatus && previewChat \? \(\s*<span className="worker-panel-time-label">/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\],\s*\.assistant-worker-chat-action\[data-action="loading"\]\s*\{[\s\S]{0,100}width: 18px;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-panel-time-label,\s*\.assistant-worker-chat-action\[data-action="loading"\] \.worker-panel-time-label\s*\{[\s\S]{0,80}display: none;/);
  assert.match(globalStyles, /\.assistant-worker-chat-action\[data-action="awaiting"\] \.worker-chat-loading,\s*\.assistant-worker-chat-action\[data-action="loading"\] \.worker-chat-loading\s*\{[\s\S]{0,120}display: inline-flex;/);
  assert.match(globalStyles, /\.sidebar-assistant-preview-loading\s*\{[\s\S]{0,120}color: var\(--ink-muted\);/);
  assert.match(globalStyles, /\.assistant-worker-chat-row:hover \.assistant-worker-chat-action:not\(\[data-action="loading"\]\):not\(\[data-action="awaiting"\]\),\s*\.assistant-worker-chat-row:focus-within \.assistant-worker-chat-action:not\(\[data-action="loading"\]\):not\(\[data-action="awaiting"\]\)/);
  assert.match(globalStyles, /\.assistant-worker-chat-row:hover \.assistant-worker-chat-menu-button,\s*\.assistant-worker-chat-row:focus-within \.assistant-worker-chat-menu-button/);
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
  assert.match(zhCN, /"nav\.archives": "已归档对话"/);
  assert.match(enUS, /"sidebar\.assistants\.empty": "No assistants"/);
  assert.match(enUS, /"sidebar\.assistants\.awaitingStatus\.approval": "Await Appr"/);
  assert.match(enUS, /"sidebar\.assistants\.awaitingStatus\.form": "Await Submit"/);
  assert.match(enUS, /"sidebar\.assistants\.awaitingStatus\.question": "Await Ques"/);
  assert.match(enUS, /"sidebar\.assistants\.awaitingStatus\.plan": "Await Impl"/);
  assert.match(enUS, /"sidebar\.assistants\.sortByName": "By name"/);
  assert.match(enUS, /"nav\.archives": "Archived Chats"/);
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

test("assistant sidebar hides desktop helper agents from primary navigation only", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );

  assert.match(sidebarSource, /const PRIMARY_NAV_HIDDEN_ASSISTANT_AGENT_KEYS = new Set<string>\(\[\s*"desktopAssistant",\s*"webOperator",\s*\]\);/);
  assert.match(sidebarSource, /function shouldShowAssistantInPrimaryNavigation\(agent: AssistantNavAgentItem\)[\s\S]*?PRIMARY_NAV_HIDDEN_ASSISTANT_AGENT_KEYS\.has\(agent\.agentKey\.trim\(\)\)/);
  assert.match(sidebarSource, /const primaryAssistantNavAgents = useMemo\(\s*\(\) => assistantNavAgents\.filter\(shouldShowAssistantInPrimaryNavigation\),\s*\[assistantNavAgents\],\s*\);/);
  assert.match(sidebarSource, /summarizeAgentStatus\(primaryAssistantNavAgents\)/);
  assert.match(sidebarSource, /sortAssistantNavAgentsForMode\(primaryAssistantNavAgents, assistantNavSortMode\)/);
  assert.doesNotMatch(sidebarSource, /copilotAgentOptions\.filter\(shouldShowAssistantInPrimaryNavigation\)/);
});

test("assistant sidebar uses merged activity agents when available", () => {
  const appShell = readAppShellSource();

  assert.match(appShell, /function resolveAssistantNavDisplayItems\(result: AssistantNavAgentItemsResult\)/);
  assert.match(appShell, /const activityItems = Array\.isArray\(result\.activityItems\)\s*\?\s*result\.activityItems\s*:\s*\[\];/);
  assert.match(appShell, /return activityItems\.length > 0 \? activityItems : result\.items;/);
  assert.match(appShell, /const nextItems = normalizeAssistantNavAgents\(resolveAssistantNavDisplayItems\(result\)\);/);
  assert.match(appShell, /setAssistantNavAgents\(normalizeAssistantNavAgents\(resolveAssistantNavDisplayItems\(nextResult\)\)\);/);
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
  const settingsSidebarIconSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "SettingsSidebarIcon.tsx"),
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
  assert.match(appShell, /path="\/control-center" element=\{<Navigate to=\{buildSettingsSectionPath\("control"\)\} replace \/>/);
  assert.match(appShell, /lastNonSettingsRouteRef/);
  assert.match(appShell, /function isSettingsRedirectRoute\(targetPath: string\)/);
  assert.match(appShell, /function getSettingsExitFallbackPath\(kanbanEnabled: boolean\)[\s\S]*?return kanbanEnabled \? "\/kanban" : ASSISTANT_TARGET_PATH;/);
  assert.match(appShell, /function resolveSettingsExitTargetPath\(targetPath: string, kanbanEnabled: boolean\)[\s\S]*?isSettingsRedirectRoute\(targetPath\)[\s\S]*?getSettingsExitFallbackPath\(kanbanEnabled\)/);
  assert.match(appShell, /function removeSettingsRoutesFromHistory\(history: string\[\]\)[\s\S]*?matchSettingsRoute\(item\.split\("\?"\)\[0\] \|\| "\/"\)/);
  assert.match(appShell, /function handleExitSettingsMode\(\)[\s\S]*?const targetPath = resolveSettingsExitTargetPath\(/);
  assert.match(appShell, /function handleExitSettingsMode\(\)[\s\S]*?back:\s*removeSettingsRoutesFromHistory\(current\.back\)[\s\S]*?forward:\s*\[\]/);
  assert.match(appShell, /function handleExitSettingsMode\(\)[\s\S]*?navigate\(targetPath,\s*\{\s*replace:\s*true\s*\}\)/);
  assert.match(appShell, /lastNonSettingsRouteRef\.current = resolveSettingsExitTargetPath\(currentRoute, kanbanEnabled\)/);
  assert.match(appShell, /buildSettingsSectionPath/);
  assert.match(appShell, /navigate\(normalizedSettingsPath, \{ replace: true \}\)/);
  assert.match(appShell, /onSelectSettingsSection=\{handleSelectSettingsSection\}/);
  assert.match(appShell, /is-settings-mode/);
  assert.match(appShell, /aboutSettingsClickCountRef/);
  assert.match(appShell, /debugSettingsUnlocked/);
  assert.match(appShell, /debugVisible:\s*debugSettingsUnlocked/);
  assert.match(appShell, /debugVisible=\{debugSettingsUnlocked\}/);
  assert.doesNotMatch(brandMarkSource, /assets\/sidebar-icons/);
  assert.match(brandMarkSource, /function createSidebarIconProps/);
  assert.match(brandMarkSource, /SidebarIllustrationKind[\s\S]*\| "archive"/);
  assert.match(brandMarkSource, /case "archive":[\s\S]*?<rect x="3" y="4" width="18" height="5" rx="1\.5" \/>/);

  assert.match(settingsSections, /buildLocalizedSettingsSections/);
  assert.match(settingsSections, /debugVisible = false/);
  assert.match(settingsSections, /debugVisible\?:\s*boolean;/);
  assert.doesNotMatch(settingsSections, /kanbanEnabled\?:\s*boolean/);
  assert.match(settingsSections, /group:\s*"personal"/);
  assert.match(settingsSections, /group:\s*"integrations"/);
  assert.match(settingsSections, /group:\s*"system"/);
  assert.match(settingsSections, /return \[[\s\S]*?id:\s*"general"[\s\S]*?group:\s*"personal"[\s\S]*?id:\s*"appearance"[\s\S]*?group:\s*"personal"[\s\S]*?id:\s*"usage"[\s\S]*?group:\s*"personal"[\s\S]*?id:\s*"assistant"[\s\S]*?group:\s*"personal"[\s\S]*?id:\s*"navigation"[\s\S]*?group:\s*"personal"[\s\S]*?id:\s*"control"[\s\S]*?group:\s*"integrations"[\s\S]*?id:\s*"kanban"[\s\S]*?group:\s*"integrations"[\s\S]*?id:\s*"market"[\s\S]*?group:\s*"integrations"[\s\S]*?id:\s*"tunnelHub"[\s\S]*?group:\s*"integrations"[\s\S]*?id:\s*"plugins"[\s\S]*?group:\s*"integrations"[\s\S]*?id:\s*"websites"[\s\S]*?group:\s*"integrations"[\s\S]*?id:\s*"webapps"[\s\S]*?group:\s*"integrations"/);
  assert.match(settingsSections, /id:\s*"usage"[\s\S]*?label:\s*"usage"[\s\S]*?layout:\s*"measure"[\s\S]*?visible:\s*true/);
  assert.match(settingsSections, /id:\s*"control"[\s\S]*?label:\s*"control"[\s\S]*?layout:\s*"wide"[\s\S]*?visible:\s*true/);
  assert.match(settingsSections, /id:\s*"kanban"[\s\S]*?visible:\s*true/);
  assert.match(settingsSections, /id:\s*"tunnelHub"[\s\S]*?visible:\s*true/);
  assert.match(settingsSections, /id:\s*"assistant"[\s\S]*?label:\s*"assistant"[\s\S]*?layout:\s*"measure"[\s\S]*?visible:\s*true/);
  assert.match(settingsSections, /id:\s*"market"[\s\S]*?label:\s*"market"[\s\S]*?layout:\s*"measure"/);
  assert.match(settingsSections, /id:\s*"navigation"[\s\S]*?label:\s*"navigation"[\s\S]*?layout:\s*"measure"/);
  assert.match(settingsSections, /id:\s*"assistant"[\s\S]*?label:\s*"assistant"[\s\S]*?layout:\s*"measure"/);
  assert.doesNotMatch(settingsSections, /id:\s*"sideAssistant"/);
  assert.match(settingsSections, /id:\s*"websites"[\s\S]*?label:\s*"websites"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsSections, /id:\s*"webapps"[\s\S]*?label:\s*"webapps"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsPage, /case "about"[\s\S]*?isWindows=\{isWindows\}/);
  assert.match(settingsPage, /AboutAppCard[\s\S]*?isWindows && <WindowsDataRootCard/);
  assert.match(settingsSections, /id:\s*"about"[\s\S]*?visible:\s*true[\s\S]*?id:\s*"debug"[\s\S]*?visible:\s*debugVisible/);
  assert.match(settingsSections, /usage:\s*\{\s*label:\s*"settings\.usage\.label",\s*description:\s*"settings\.usage\.description"\s*\}/);
  assert.match(settingsSections, /appearance:\s*\{\s*label:\s*"settings\.appearance\.label"\s*\}/);
  assert.match(settingsSections, /debug:\s*\{\s*label:\s*"settings\.debug\.label",\s*description:\s*"settings\.debug\.description"\s*\}/);
  assert.doesNotMatch(settingsSections, /settings\.appearance\.description/);
  assert.doesNotMatch(settingsSections, /id:\s*"runtimeReset"/);
  assert.match(settingsSections, /id:\s*"about"[\s\S]*?label:\s*"about"[\s\S]*?layout:\s*"measure"[\s\S]*?visible:\s*true/);
  assert.match(settingsPage, /settingsContentStyle = activeSectionDefinition\?\.layout === "wide"[\s\S]*?"--settings-content-max": "var\(--workspace-wide-max\)"/);
  assert.match(settingsStyles, /\.settings-page \.settings-control-center-embed/);
  assert.match(settingsStyles, /\.settings-page \.settings-control-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(140px, 1fr\) minmax\(280px, 420px\)/);
  assert.match(settingsStyles, /@media \(max-width: 860px\)[\s\S]*?\.settings-page \.settings-control-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);

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
  assert.match(sidebarSource, /import \{ SettingsSidebarIcon \} from "\.\/SettingsSidebarIcon";/);
  assert.match(sidebarSource, /<SettingsSidebarIcon kind="back" \/>/);
  assert.match(sidebarSource, /<SettingsSidebarIcon kind="search" \/>/);
  assert.match(sidebarSource, /<SettingsSidebarIcon kind=\{section\.id\} \/>/);
  assert.doesNotMatch(sidebarSource, /function getSettingsSectionIcon/);
  assert.doesNotMatch(sidebarSource, /SearchOutlined/);
  assert.match(settingsSidebarIconSource, /export type SettingsSidebarIconKind = SettingsSectionId \| "back" \| "search"/);
  assert.match(settingsSidebarIconSource, /case "navigation":[\s\S]*?<rect x="3" y="3" width="18" height="18" rx="2" \/>[\s\S]*?<path d="M9 3v18M13 8h4M13 12h4M13 16h2" \/>/);
  assert.match(settingsSidebarIconSource, /case "tunnelHub":[\s\S]*?<circle cx="12" cy="12" r="9" \/>[\s\S]*?<circle cx="12" cy="12" r="5" \/>/);
  assert.match(settingsSidebarIconSource, /case "debug":[\s\S]*?case "general":[\s\S]*?<circle cx="12" cy="12" r="3" \/>/);
  assert.match(settingsSidebarIconSource, /case "usage":[\s\S]*?<path d="M21 12a9 9 0 1 0-18 0" \/>/);
  assert.match(settingsSidebarIconSource, /case "webapps":[\s\S]*?<rect x="3" y="3" width="18" height="18" rx="2" \/>/);
  assert.doesNotMatch(sidebarSource, /case "runtimeReset"/);
  assert.match(brandMarkSource, /case "about":[\s\S]*?<circle cx="12" cy="12" r="10" \/>/);
  assert.match(brandMarkSource, /case "appearance":[\s\S]*?<circle cx="12" cy="12" r="9" \/>/);

  assert.match(settingsPage, /useParams\(\)/);
  assert.match(settingsPage, /resolveSettingsSectionId/);
  assert.doesNotMatch(settingsPage, /kanbanEnabled:\s*boolean/);
  assert.match(settingsPage, /buildLocalizedSettingsSections\(\{ isWindows, desktopPetSupported, debugVisible, t \}\)/);
  assert.match(settingsPage, /switch \(activeSection\)/);
  assert.match(settingsPage, /case "usage"[\s\S]*?<UsageSettingsPanel/);
  assert.match(settingsPage, /window\.electronAPI\.settings\.getUsageProfile\(\)/);
  assert.match(settingsPage, /window\.electronAPI\.sso\.getStatus\(\)/);
  assert.match(settingsPage, /case "appearance"/);
  assert.match(settingsPage, /settings-appearance-panel/);
  assert.match(settingsPage, /settings-appearance-row/);
  assert.match(settingsPage, /settings-theme-segment/);
  assert.match(settingsPage, /<Select<SupportedLocale>[\s\S]*?aria-label=\{t\("settings\.language\.label"\)\}/);
  assert.match(settingsPage, /activeSectionDescription[\s\S]*?activeSectionDefinition\.description\.trim\(\)/);
  assert.match(settingsPage, /activeSectionDescription \? <p className="page-copy">\{activeSectionDescription\}<\/p> : null/);
  assert.match(settingsPage, /settings\.appearance\.interfaceFont[\s\S]*?<Select<string>[\s\S]*?disabled[\s\S]*?settings\.appearance\.interfaceFontSize[\s\S]*?<InputNumber[\s\S]*?disabled[\s\S]*?settings\.appearance\.codeFont[\s\S]*?<Select<string>[\s\S]*?disabled[\s\S]*?settings\.appearance\.codeFontSize[\s\S]*?<InputNumber[\s\S]*?disabled/);
  assert.doesNotMatch(settingsPage, /settings\.appearance\.themeDescription|settings\.language\.uiDescription/);
  assert.doesNotMatch(enUS, /Switch theme mode and adjust the desktop workspace style|Use light, dark, or match your system setting|App UI language|settings\.appearance\.description|settings\.appearance\.themeDescription|settings\.language\.uiDescription/);
  assert.doesNotMatch(zhCN, /切换主题模式并调整桌面工作台的界面风格|使用浅色、深色，或匹配系统设置|应用界面语言|settings\.appearance\.description|settings\.appearance\.themeDescription|settings\.language\.uiDescription/);
  assert.match(enUS, /"settings\.appearance\.interfaceFont":\s*"Interface font"/);
  assert.match(zhCN, /"settings\.appearance\.interfaceFont":\s*"界面字体"/);
  assert.match(settingsStyles, /\.settings-language-select\s*\{[\s\S]*?border-radius:\s*8px;/);
  assert.match(settingsStyles, /\.settings-page \.settings-appearance-control\s*\{[\s\S]*?width:\s*180px;/);
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
  assert.doesNotMatch(settingsPage, /case "runtimeReset"/);
  assert.match(settingsPage, /case "debug"[\s\S]*?<DebugSettingsPanel \/>/);
  assert.match(settingsPage, /const DEBUG_CATEGORY_IDS:\s*DebugCategoryId\[\]\s*=\s*\["device", "logs", "wsServer", "authTokens", "other"\]/);
  assert.match(settingsPage, /function DebugSettingsPanel/);
  assert.match(settingsPage, /case "device"[\s\S]*?return <DeviceIdentityDebugCard \/>/);
  assert.match(settingsPage, /case "logs"[\s\S]*?return <DesktopLogsDebugCard \/>/);
  assert.match(settingsPage, /case "wsServer"[\s\S]*?return <LocalWsServerDebugCard \/>/);
  assert.match(settingsPage, /case "authTokens"[\s\S]*?return <IdentityTokenDebugCard \/>/);
  assert.match(settingsPage, /case "other"[\s\S]*?<DesktopActionDebugCard \/>[\s\S]*?<TunnelDebugCard \/>/);
  assert.match(settingsPage, /function DeviceIdentityDebugCard/);
  assert.match(settingsPage, /function DesktopActionDebugDialog/);
  assert.match(settingsPage, /function WsServerDebugDialog/);
  assert.match(settingsPage, /window\.electronAPI\.desktopActions\.list\(\)/);
  assert.match(settingsPage, /window\.electronAPI\.desktopActions\.call\(request\)/);
  assert.match(settingsPage, /window\.electronAPI\.agentAuth\.issueAccessToken\("missing"\)/);
  assert.match(settingsPage, /new WebSocket\(wsUrl\.toString\(\)\)/);
  assert.match(settingsPage, /settings\.debug\.desktopActions\.openDialog/);
  assert.match(settingsPage, /settings\.debug\.desktopWs\.consoleAction/);
  assert.match(settingsPage, /settings\.debug\.wsConsole\.command/);
  assert.match(settingsPage, /window\.electronAPI\.settings\.getDeviceIdentity\(\)/);
  assert.match(settingsPage, /settings\.debug\.device\.identityPath/);
  assert.match(settingsPage, /settings\.debug\.device\.copyDeviceId/);
  assert.match(settingsPage, /settings-debug-layout/);
  assert.match(settingsPage, /settings-debug-nav/);
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
  assert.match(settingsPage, /settings\.about\.deviceId/);
  assert.match(settingsPage, /settings-about-device-id/);
  assert.doesNotMatch(settingsPage, /settings-about-meta/);
  assert.match(settingsStyles, /\.settings-about-version\s*\{[\s\S]*?border-radius:\s*8px;/);
  assert.match(settingsStyles, /\.settings-about-device-id/);
  assert.match(settingsStyles, /\.settings-desktop-ws-status/);
  assert.match(settingsStyles, /\.settings-debug-layout\s*\{[\s\S]*?grid-template-columns:\s*148px minmax\(0, 1fr\);/);
  assert.match(settingsStyles, /\.settings-debug-nav-item\.is-selected\s*\{[\s\S]*?background:\s*var\(--accent-soft\)/);
  assert.match(settingsStyles, /\.settings-debug-dialog-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(settingsStyles, /\.settings-debug-log-entry\.is-out\s*\{[\s\S]*?border-color:\s*var\(--accent-border-subtle\)/);
  assert.match(settingsStyles, /@media \(max-width: 720px\)[\s\S]*?\.settings-debug-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(settingsStyles, /\.settings-page \.settings-reset-card/);
  assert.match(settingsPage, /settings-page-single/);
  assert.match(settingsPage, /settings-content-panel/);
  assert.doesNotMatch(settingsPage, /settings-directory-nav/);
  assert.match(settingsPage, /contentRef\.current\?\.scrollTo/);
  assert.match(settingsStyles, /\.settings-content-panel/);
  assert.match(settingsStyles, /\.settings-page-single\[data-settings-section="control"\],[\s\S]*?\.settings-page-single\[data-settings-section="plugins"\],[\s\S]*?\.settings-page-single\[data-settings-section="websites"\],[\s\S]*?\.settings-page-single\[data-settings-section="webapps"\]\s*\{[\s\S]*?padding-top:\s*0;/);
  assert.match(settingsStyles, /\.settings-page \.usage-summary-strip\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\);/);
  assert.match(settingsStyles, /\.settings-page \.usage-heatmap-grid\s*\{[\s\S]*?grid-template-rows:\s*repeat\(7, 10px\);/);
  assert.match(sidebarSource, /settings\.group\.personal/);
  assert.match(sidebarSource, /settings\.group\.integrations/);
  assert.match(sidebarSource, /settings\.group\.system/);
  assert.match(enUS, /"settings\.usage\.label":\s*"Usage"/);
  assert.match(enUS, /"settings\.debug\.label":\s*"Debug"/);
  assert.match(enUS, /"settings\.about\.deviceId":\s*"Device ID"/);
  assert.match(enUS, /"settings\.debug\.categories\.device":\s*"Device"/);
  assert.match(enUS, /"settings\.debug\.categories\.authTokens":\s*"Auth Tokens"/);
  assert.match(enUS, /"settings\.debug\.device\.title":\s*"Device identity"/);
  assert.match(enUS, /"settings\.debug\.desktopActions\.title":\s*"Desktop Actions"/);
  assert.match(enUS, /"settings\.debug\.desktopWs\.consoleAction":\s*"Open WS console"/);
  assert.match(enUS, /"settings\.debug\.wsConsole\.title":\s*"WS Server Console"/);
  assert.match(enUS, /"settings\.debug\.desktopWs\.title":\s*"Local WS Server Debugging"/);
  assert.match(zhCN, /"settings\.usage\.label":\s*"使用情况"/);
  assert.match(zhCN, /"settings\.debug\.label":\s*"调试"/);
  assert.match(zhCN, /"settings\.about\.deviceId":\s*"设备 ID"/);
  assert.match(zhCN, /"settings\.debug\.categories\.device":\s*"设备"/);
  assert.match(zhCN, /"settings\.debug\.categories\.authTokens":\s*"鉴权令牌"/);
  assert.match(zhCN, /"settings\.debug\.device\.title":\s*"设备身份"/);
  assert.match(zhCN, /"settings\.debug\.desktopActions\.title":\s*"桌面动作"/);
  assert.match(zhCN, /"settings\.debug\.desktopWs\.consoleAction":\s*"打开 WS 控制台"/);
  assert.match(zhCN, /"settings\.debug\.wsConsole\.title":\s*"WS 服务控制台"/);
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

test("settings dark mode themes Ant Design controls inside settings cards", () => {
  const settingsPage = readSourceFile("src", "renderer", "pages", "settings", "SettingsPage.tsx");
  const settingsStyles = readSourceFile("src", "renderer", "pages", "settings", "SettingsPage.css");

  assert.match(settingsPage, /case "general"[\s\S]*?settings-appearance-panel/);
  assert.match(settingsPage, /case "appearance"[\s\S]*?<Segmented<ThemePreference>/);
  assert.match(settingsPage, /case "assistant"[\s\S]*?desktop-pet-agent-select-wrap/);
  assert.match(settingsPage, /case "kanban"[\s\S]*?settings-control-readonly-row/);
  assert.match(settingsPage, /case "navigation"[\s\S]*?navigation-order-assistant-field/);
  assert.doesNotMatch(settingsPage, /settings-kanban-ant-card|settings-kanban-ant-form/);
  assert.match(
    settingsStyles,
    /:root\[data-theme="dark"\] :is\(\.settings-page, \.settings-debug-modal\) \.ant-input,[\s\S]*?\.ant-select:not\(\.ant-select-customize-input\) \.ant-select-selector/
  );
  assert.match(
    settingsStyles,
    /:root\[data-theme="dark"\] :is\(\.settings-page, \.settings-debug-modal\) \.ant-select-disabled \.ant-select-selector,[\s\S]*?background:\s*rgba\(255, 255, 255, 0\.04\)\s*!important;/
  );
  assert.match(
    settingsStyles,
    /:root\[data-theme="dark"\] :is\(\.settings-page, \.settings-debug-modal\) \.ant-input::placeholder,[\s\S]*?:root\[data-theme="dark"\] :is\(\.settings-page, \.settings-debug-modal\) textarea::placeholder/
  );
  assert.match(
    settingsStyles,
    /:root\[data-theme="dark"\] :is\(\.settings-page, \.settings-debug-modal\) \.ant-select-arrow,[\s\S]*?color:\s*var\(--ink-soft\)\s*!important;/
  );
  assert.match(settingsStyles, /:root\[data-theme="dark"\] \.settings-select-popup\s*\{[\s\S]*?background:\s*var\(--surface-strong\);/);
  assert.match(settingsStyles, /:root\[data-theme="dark"\] \.settings-select-popup \.ant-select-item-option-selected:not\(\.ant-select-item-option-disabled\)\s*\{[\s\S]*?background:\s*var\(--accent-soft\);/);
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
    path.join(projectRoot, "src", "main", "assistant", "core", "settings-store.ts"),
    "utf8"
  );
  const contracts = readSharedContractsSource();
  const globalStyles = readRendererStyles();
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");

  assert.match(sharedSettings, /DEFAULT_DESKTOP_HELPER_AGENT_KEY\s*=\s*"desktopAssistant"/);
  assert.match(sharedSettings, /DEFAULT_QUICK_ASSISTANT_ENABLED\s*=\s*true/);
  assert.match(sharedSettings, /DEFAULT_QUICK_ASSISTANT_AGENT_KEY\s*=\s*DEFAULT_DESKTOP_HELPER_AGENT_KEY/);
  assert.match(sharedSettings, /DEFAULT_QUICK_ASSISTANT_SHORTCUT\s*=\s*"Alt\+Space"/);
  assert.match(sharedSettings, /normalizeQuickAssistantShortcut/);
  assert.match(sharedSettings, /DESKTOP_COPILOT_PAGE_KEYS/);
  assert.match(sharedSettings, /controlCenter/);
  assert.match(sharedSettings, /schedules/);
  assert.match(contracts, /bootstrapAgentKey:\s*string/);
  assert.match(contracts, /quickAssistantShortcut:\s*string/);
  assert.match(contracts, /quickAssistantShortcut\?:\s*string/);
  assert.match(settingsStore, /const DESKTOP_INIT_ASSISTANT_FILE = "assistant\.json"/);
  assert.match(settingsStore, /function readBootstrapAgentKeyFromRoot\(rootDir: string\)/);
  assert.match(settingsStore, /bootstrapAgentKey:\s*readBootstrapAgentKeyFromRoot\(rootDir\)/);
  assert.match(settingsStore, /bootstrapAgentKey:\s*settings\.bootstrapAgentKey/);
  assert.match(settingsStore, /bootstrapAgentKey:\s*current\.bootstrapAgentKey/);
  assert.match(settingsStore, /desktopHelperAgentKey:\s*settings\.desktopHelperAgentKey/);
  assert.match(settingsStore, /quickAssistantEnabled:\s*settings\.quickAssistantEnabled/);
  assert.match(settingsStore, /quickAssistantAgentKey:\s*settings\.quickAssistantAgentKey/);
  assert.match(settingsStore, /quickAssistantShortcut:\s*settings\.quickAssistantShortcut/);
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
  assert.match(settingsPage, /window\.electronAPI\.kanban\.getSettings/);
  assert.match(settingsPage, /window\.electronAPI\.kanban\.saveSettings/);
  assert.doesNotMatch(settingsPage, /import \{[^}]*\bForm\b[^}]*\} from "antd"/);
  assert.match(settingsPage, /import \{[^}]*\bSwitch\b[^}]*\bTooltip\b[^}]*\} from "antd"/);
  assert.doesNotMatch(settingsPage, /settings-kanban-ant-card|settings-kanban-ant-form/);
  assert.match(settingsPage, /renderHeaderSwitch[\s\S]*?handleToggleControlRemoteControl/);
  assert.match(settingsPage, /<form className="settings-control-form" onSubmit=\{\(event\) => void handleSaveControlCloudConfig\(event\)\}/);
  assert.match(settingsPage, /settings-appearance-row settings-kanban-server-url-row[\s\S]*settings-appearance-row-copy[\s\S]*kanban\.cloud\.serverUrl[\s\S]*settings-appearance-control settings-control-row-control settings-kanban-server-url-input/);
  assert.match(settingsStyles, /\.settings-page \.settings-kanban-server-url-input\.ant-input\s*\{[\s\S]*?flex:\s*0 1 420px;/);
  assert.match(settingsPage, /settings-control-readonly-row/);
  assert.doesNotMatch(settingsPage, /kanban\.cloud\.deviceAliasPlaceholder/);
  assert.doesNotMatch(settingsPage, /settings\.general\.desktopInfoTitle/);
  assert.match(settingsPage, /settings\.general\.desktopDeviceName/);
  assert.match(settingsPage, /window\.electronAPI\.settings\.getDesktopDeviceInfo\(\)/);
  assert.match(settingsPage, /settings-control-row-readonly/);
  assert.match(settingsPage, /CopyOutlined/);
  assert.match(settingsPage, /CheckOutlined/);
  assert.match(settingsPage, /handleCopyGeneralDeviceId/);
  assert.match(settingsPage, /window\.electronAPI\.clipboard\.writeText\(deviceId\)/);
  assert.match(settingsPage, /settings\.general\.copyDeviceId/);
  assert.match(settingsPage, /settings-device-copy-button/);
  assert.match(settingsStyles, /\.settings-page \.settings-device-form\s*\{[\s\S]*?border-top:\s*none;/);
  assert.match(settingsStyles, /\.settings-page \.settings-control-row-readonly\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(enUS, /"settings\.general\.description":\s*"App behavior and system settings\."/);
  assert.match(enUS, /"settings\.general\.preventSleepWhileRunning":\s*"Prevent sleep while running"/);
  assert.match(enUS, /"settings\.general\.desktopActionConfirmationDescription":\s*"Ask before local bridge actions make changes\."/);
  assert.match(zhCN, /"settings\.general\.description":\s*"应用行为与系统设置。"/);
  assert.match(zhCN, /"settings\.general\.preventSleepWhileRunning":\s*"运行时防止休眠"/);
  assert.match(zhCN, /"settings\.general\.preventSleepWhileRunningDescription":\s*"在 Codex 运行聊天时，保持电脑唤醒。"/);
  assert.doesNotMatch(settingsPage, /<Input\.Password[\s\S]*kanban\.cloud\.tokenPlaceholder/);
  assert.doesNotMatch(settingsPage, /controlProjectSelectOptions|controlProjectOptions|kanban\.cloud\.projectId|kanban\.cloud\.projectSelectHelp|kanban\.cloud\.projectFallbackHelp|selectedProjectId/);
  assert.doesNotMatch(enUS, /kanban\.cloud\.projectId|kanban\.cloud\.projectSelectHelp|kanban\.cloud\.projectFallbackHelp/);
  assert.doesNotMatch(zhCN, /kanban\.cloud\.projectId|kanban\.cloud\.projectSelectHelp|kanban\.cloud\.projectFallbackHelp/);
  assert.match(settingsPage, /<Button[\s\S]*htmlType="submit"[\s\S]*t\("common\.save"\)/);
  assert.match(settingsPage, /case "assistant"/);
  assert.match(settingsPage, /activeSection === "assistant"/);
  assert.match(settingsPage, /case "market"/);
  assert.match(settingsPage, /settings\.market\.apiBaseUrl/);
  assert.match(settingsPage, /window\.electronAPI\.market\.saveSettings/);
  assert.match(enUS, /"settings\.market\.apiBaseUrl":\s*"API Address"/);
  assert.match(zhCN, /"settings\.market\.apiBaseUrl":\s*"API 地址"/);
  assert.doesNotMatch(settingsPage, /handleToggleKanbanVisibility/);
  assert.match(settingsPage, /handleSaveControlCloudConfig/);
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
  assert.match(settingsPageSections, /settings\.websites\.label/);
  assert.match(settingsPageSections, /settings\.webapps\.label/);
  assert.match(settingsPage, /case "websites"[\s\S]*web-settings-shell[\s\S]*service-catalog web-settings-catalog[\s\S]*web-detail-form/);
  assert.match(settingsPage, /case "webapps"[\s\S]*web-settings-shell[\s\S]*service-catalog web-settings-catalog[\s\S]*web-detail-form/);
  assert.match(settingsPage, /const websiteItems = useMemo\([\s\S]*?webItems\.filter\(isWebsiteEntry\)/);
  assert.match(settingsPage, /const webappItems = useMemo\([\s\S]*?webItems\.filter\(isWebappEntry\)/);
  assert.match(settingsPage, /handleSaveWebsiteItem/);
  assert.match(settingsPage, /handleSaveWebappItem/);
  assert.match(settingsPage, /label:\s*websiteLabel/);
  assert.match(settingsPage, /url:\s*websiteUrl/);
  assert.match(settingsPage, /settings\.websites\.agentEnhancement/);
  assert.match(settingsPage, /settings\.websites\.save/);
  assert.match(settingsPage, /window\.electronAPI\.webs\.websites\.update/);
  assert.match(settingsPage, /window\.electronAPI\.webs\.webapps\.update/);
  assert.match(settingsPage, /window\.electronAPI\.webs\.webapps\.remove/);
  assert.match(settingsPage, /settings\.webapps\.runtimeTitle/);
  assert.match(settingsPage, /settings\.webapps\.manifestTitle/);
  assert.match(settingsPage, /settings\.webapps\.logsTitle/);
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
  assert.match(settingsPage, /quickAssistantShortcut/);
  assert.match(settingsPage, /function shortcutAcceleratorFromKeyboardEvent\(event: ReactKeyboardEvent<HTMLInputElement>\)/);
  assert.match(settingsPage, /event\.ctrlKey \? "Control" : ""/);
  assert.match(settingsPage, /key === " " \|\| key === "Spacebar" \|\| key === "Space"[\s\S]*?return "Space";/);
  assert.match(settingsPage, /function handleQuickAssistantShortcutKeyDown\(event: ReactKeyboardEvent<HTMLInputElement>\)/);
  assert.match(settingsPage, /setQuickAssistantShortcutDraft\(accelerator\)/);
  assert.match(settingsPage, /onChange=\{\(event\) => setQuickAssistantShortcutDraft\(event\.target\.value\)\}/);
  assert.match(settingsPage, /onKeyDown=\{handleQuickAssistantShortcutKeyDown\}/);
  assert.doesNotMatch(settingsPage, /readOnly[\s\S]{0,240}onKeyDown=\{handleQuickAssistantShortcutKeyDown\}/);
  assert.match(settingsPage, /handleSaveQuickAssistantShortcut/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*quickAssistantAgentKey: normalizedAgentKey\s*\}\)/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*quickAssistantShortcut: normalizedShortcut\s*\}\)/);
  assert.match(settingsPage, /settings\.quickAssistant\.shortcut/);
  assert.match(enUS, /"settings\.quickAssistant\.shortcut":\s*"Shortcut"/);
  assert.match(zhCN, /"settings\.quickAssistant\.shortcut":\s*"快捷键"/);
  assert.doesNotMatch(settingsPage, /页面 Copilot/);
  assert.doesNotMatch(settingsPage, />选择宠物</);
  assert.doesNotMatch(settingsPage, /半透明侧边栏/);
  assert.match(settingsPage, /function isMarketVisible\(settings: MarketSettings\) \{\s*return settings\.enabled === true;\s*\}/);
  assert.match(settingsPage, /function renderSectionHeaderAction\(\)[\s\S]*case "assistant"[\s\S]*handleToggleDesktopPet[\s\S]*case "kanban"[\s\S]*handleToggleControlRemoteControl[\s\S]*case "market"[\s\S]*handleToggleMarketEnabled[\s\S]*case "tunnelHub"[\s\S]*handleToggleTunnelHubEnabled/);
  const sectionHeaderActionBody = settingsPage.match(
    /function renderSectionHeaderAction\(\) \{(?<body>[\s\S]*?)\n  \}\n\n  function renderActiveSection/
  )?.groups?.body ?? "";
  assert.match(sectionHeaderActionBody, /case "kanban"[\s\S]*case "tunnelHub"/);
  assert.match(settingsPage, /const shouldShowSettingsPageHead =[\s\S]*?activeSection !== "control" &&[\s\S]*?activeSection !== "plugins" &&[\s\S]*?activeSection !== "websites" &&[\s\S]*?activeSection !== "webapps";/);
  assert.match(settingsPage, /\{shouldShowSettingsPageHead \? \(\s*<div className="settings-page-head">/);
  assert.match(settingsPage, /className="settings-page-head"[\s\S]*settings-page-head-copy[\s\S]*settings-page-head-action[\s\S]*renderSectionHeaderAction\(\)/);
  assert.match(settingsStyles, /\.settings-page-head\s*\{[\s\S]*display:\s*flex;[\s\S]*justify-content:\s*space-between;/);
  assert.match(settingsStyles, /\.settings-page-head-action\s*\{[\s\S]*justify-content:\s*flex-end;/);
  assert.doesNotMatch(settingsPage, /TUNNEL_HUB_AGENT_SERVICE_ID/);
  assert.doesNotMatch(settingsPage, /window\.electronAPI\.services\.start\([^)]*tunnel/i);
  assert.doesNotMatch(settingsPage, /window\.electronAPI\.services\.stop\([^)]*tunnel/i);
  assert.doesNotMatch(settingsPage, /onClick=\{\(\) => setMarketSettings/);
  assert.match(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.agents"[\s\S]*?labelKey:\s*"nav\.market"[\s\S]*?labelKey:\s*"nav\.settings"/);
  assert.doesNotMatch(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.controlCenter"/);
  assert.doesNotMatch(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.help"/);
  assert.doesNotMatch(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.memory"/);
  assert.doesNotMatch(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.schedules"/);
  assert.match(settingsPage, /visibleFixedNavigationTools = fixedNavigationTools\.filter\(\(tool\) => tool\.id !== "market" \|\| marketEnabled\)/);
  assert.match(sharedSettings, /controlCenter/);
  assert.match(settingsPage, /copilotPageKey:\s*"market"/);
  assert.doesNotMatch(settingsPage, /navigation-order-fixed-label|navigation-order-actions|settings\.navigation\.itemIndex|settings\.navigation\.fixed"\)/);
  assert.doesNotMatch(settingsPage, /navigation-order-fixed-dot/);
  assert.match(settingsPage, /navigationSettingsOrder\.map/);
  assert.match(settingsPage, /\{visibleFixedNavigationTools\.map\(\(tool\) => renderFixedNavigationToolRow\(tool\)\)\}/);
  assert.match(settingsPage, /handleSelectDesktopHelperAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*desktopHelperAgentKey: normalizedAgentKey\s*\}\)/);
  assert.match(settingsPage, /desktopCopilotPages: nextPages/);
  assert.match(settingsPage, /settings-control-row navigation-assistant-default/);
  assert.match(settingsPage, /settings-control-row-select desktop-pet-agent-select-wrap navigation-assistant-default-select/);
  assert.match(settingsStyles, /\.settings-page \.navigation-order-row,[\s\S]*?\.settings-page \.navigation-order-title-cell,[\s\S]*?\.settings-page \.navigation-order-assistant-field,[\s\S]*?\.settings-page \.desktop-pet-agent-select-wrap\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(settingsStyles, /\.settings-page \.desktop-pet-agent-select-wrap\s*\{[\s\S]*?width:\s*100%;/);
  assert.doesNotMatch(settingsPage, /settings\.navigation\.defaultAssistantDescription|settings\.navigation\.fixedMainDescription|settings\.navigation\.fixedToolsDescription/);
  assert.match(settingsPage, /settings\.assistant\.panelAria/);
  assert.match(settingsPage, /settings\.navigation\.defaultAssistant/);
  assert.match(globalStyles, /grid-template-columns:\s*minmax\(140px,\s*1fr\)\s*minmax\(220px,\s*300px\)\s*124px/);
  assert.doesNotMatch(settingsPage, /onClick=\{resetSidebarNavOrder\}/);
  assert.doesNotMatch(settingsPage, /moveSidebarNavOrderItem/);
});

test("settings page keeps Kanban, Control, and Tunnel Hub separate", () => {
  const settingsPage = readSourceFile("src", "renderer", "pages", "settings", "SettingsPage.tsx");
  const settingsSections = readSourceFile("src", "renderer", "settingsPageSections.ts");
  const settingsRoutes = readSourceFile("src", "shared", "settings-routes.ts");
  const sharedSettingsSections = readSourceFile("src", "shared", "settings-sections.ts");
  const kanbanContracts = readSourceFile("src", "shared", "contracts", "kanban.ts");
  const kanbanRuntime = readSourceFile("src", "main", "kanban-runtime.ts");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(sharedSettingsSections, /"kanban"/);
  assert.match(settingsSections, /id:\s*"kanban"[\s\S]*?settings\.kanban\.label/);
  assert.match(sharedSettingsSections, /"tunnelHub"/);
  assert.match(settingsSections, /id:\s*"kanban"[\s\S]*?visible:\s*true/);
  assert.match(settingsSections, /id:\s*"control"[\s\S]*id:\s*"kanban"[\s\S]*id:\s*"market"[\s\S]*id:\s*"tunnelHub"[\s\S]*id:\s*"plugins"[\s\S]*id:\s*"websites"[\s\S]*id:\s*"webapps"/);
  assert.match(settingsSections, /id:\s*"tunnelHub"[\s\S]*?visible:\s*true/);
  assert.doesNotMatch(settingsRoutes, /kanban:\s*"control"/);
  assert.doesNotMatch(settingsRoutes, /tunnelHub:\s*"control"/);
  assert.match(settingsPage, /case "kanban"[\s\S]*settings\.kanban\.panelAria[\s\S]*handleSaveControlCloudConfig[\s\S]*settings\.control\.statusTitle/);
  const controlCaseBody = settingsPage.match(
    /case "control":[\s\S]*?(?=case "tunnelHub")/
  )?.[0] ?? "";
  const tunnelHubCaseBody = settingsPage.match(
    /case "tunnelHub": \{[\s\S]*?(?=case "navigation")/
  )?.[0] ?? "";
  assert.match(tunnelHubCaseBody, /settings\.tunnelHub\.panelAria[\s\S]*handleSaveTunnelHubSettings[\s\S]*settings\.tunnelHub\.relayUrl[\s\S]*t\("common\.save"\)/);
  assert.match(tunnelHubCaseBody, /<label className="settings-control-row">[\s\S]*settings-control-row-label[\s\S]*settings\.tunnelHub\.relayUrl[\s\S]*className="settings-control-row-control"/);
  assert.doesNotMatch(tunnelHubCaseBody, /settings\.tunnelHub\.loginRequired|tunnelHubSsoStatus/);
  assert.match(tunnelHubCaseBody, /settings\.mobilePairing\.title[\s\S]*handleCreateAppPairingPayload[\s\S]*settings\.mobilePairing\.qrCode[\s\S]*handleCopyAppPairingPayload/);
  assert.doesNotMatch(tunnelHubCaseBody, /settings\.mobilePairing\.targetMode|APP_PAIRING_TARGET_MODES|appPairingTargetMode/);
  assert.doesNotMatch(settingsPage, /settings\.control\.cloudPanelAria/);
  assert.match(settingsPage, /import \{[^}]*\bControlCenterPage\b[^}]*\} from "\.\.\/control-center\/ControlCenterPage";/);
  assert.match(controlCaseBody, /<ControlCenterPage \/>/);
  assert.doesNotMatch(controlCaseBody, /settings\.mobilePairing\.title/);
  assert.doesNotMatch(controlCaseBody, /settings\.control\.tunnelTitle|settings\.tunnelHub\.panelAria/);
  assert.doesNotMatch(settingsPage, /settings\.tunnelHub\.deviceId/);
  assert.doesNotMatch(settingsPage, /settings\.tunnelHub\.publicUrl|settings\.tunnelHub\.webSocketUrl/);
  assert.doesNotMatch(settingsPage, /rotateRelayToken|settings\.tunnelHub\.rotateRelayToken/);
  assert.doesNotMatch(settingsPage, /tlsInsecureSkipVerify:\s*tunnelHubSettings\.tlsInsecureSkipVerify/);
  assert.doesNotMatch(settingsPage, /checked=\{tunnelHubSettings\.tlsInsecureSkipVerify\}/);
  assert.doesNotMatch(settingsPage, /settings\.tunnelHub\.tlsInsecure/);
  assert.doesNotMatch(settingsPage, /reconnectSeconds:\s*tunnelHubSettings\.reconnectSeconds/);
  assert.doesNotMatch(settingsPage, /settings\.tunnelHub\.reconnectSeconds|settings\.tunnelHub\.reconnectUnit/);
  assert.doesNotMatch(enUS, /Skip relay TLS verification|settings\.tunnelHub\.tlsInsecure/);
  assert.doesNotMatch(zhCN, /跳过中继 TLS 校验|settings\.tunnelHub\.tlsInsecure/);
  assert.doesNotMatch(enUS, /Reconnect interval|settings\.tunnelHub\.reconnect/);
  assert.doesNotMatch(zhCN, /重连间隔|settings\.tunnelHub\.reconnect/);
  assert.doesNotMatch(enUS, /Sign in to .* before enabling Tunnel|settings\.tunnelHub\.loginRequired/);
  assert.doesNotMatch(zhCN, /请先登录 .*再开启隧道|settings\.tunnelHub\.loginRequired/);
  assert.match(settingsPage, /settings\.createAppPairingPayload/);
  assert.match(settingsPage, /handleCreateAppPairingPayload[\s\S]*showSectionNotice\("tunnelHub"[\s\S]*setReadErrorSections\(\["tunnelHub"\]/);
  assert.match(settingsPage, /handleCopyAppPairingPayload[\s\S]*showSectionNotice\("tunnelHub"/);
  assert.match(settingsPage, /window\.electronAPI\.agentAuth\.issueAccessToken\("missing"\)/);
  assert.match(settingsPage, /shouldReadControlData = activeSection === "kanban"/);
  assert.match(settingsPage, /shouldReadTunnelHubData = activeSection === "tunnelHub"/);
  assert.match(settingsPage, /settings\.control\.remoteControlEnabled/);
  assert.doesNotMatch(settingsPage, /settings\.control\.remoteControlDescription/);
  assert.match(settingsPage, /handleToggleTunnelHubEnabled/);
  assert.match(settingsPage, /setReadErrorSections\(\["tunnelHub"\]/);
  assert.match(settingsPage, /showSectionNotice\("tunnelHub"/);
  assert.doesNotMatch(settingsPage, /settings\.control\.tunnelDescription/);
  assert.match(settingsPage, /window\.electronAPI\.kanban\.getSettings/);
  assert.match(settingsPage, /window\.electronAPI\.kanban\.saveSettings/);
  assert.doesNotMatch(settingsPage, /window\.electronAPI\.kanban\.listOnlineDevices/);
  assert.match(kanbanContracts, /interface KanbanSettings[\s\S]*?enabled:\s*boolean;[\s\S]*?cloud:\s*KanbanCloudConfig;/);
  assert.match(kanbanContracts, /interface KanbanSettingsInput[\s\S]*?enabled\?:\s*boolean;[\s\S]*?cloud\?:\s*Partial<KanbanCloudConfig>;/);
  assert.doesNotMatch(kanbanContracts, /selectedProjectId:\s*string/);
  assert.match(kanbanContracts, /remoteControlEnabled:\s*boolean/);
  assert.match(kanbanRuntime, /remoteControlEnabled/);
  assert.match(kanbanRuntime, /config\.remoteControlEnabled/);
  assert.match(kanbanRuntime, /KANBAN_CONFIG_FILE = "kanban\.json"/);
  assert.match(zhCN, /"settings\.control\.label":\s*"控制中心"/);
  assert.match(zhCN, /"settings\.kanban\.label":\s*"看板"/);
  assert.match(zhCN, /"settings\.control\.description":\s*"管理服务和桌面端配对。"/);
  assert.match(zhCN, /"settings\.kanban\.description":\s*"云看板连接。"/);
  assert.match(zhCN, /"settings\.control\.remoteControlEnabled":\s*"允许云看板控制此桌面端"/);
  assert.match(enUS, /"settings\.control\.label":\s*"Control Center"/);
  assert.match(enUS, /"settings\.kanban\.label":\s*"Kanban"/);
  assert.match(enUS, /"settings\.control\.description":\s*"Manage services and Desktop pairing\."/);
  assert.match(enUS, /"settings\.kanban\.description":\s*"Cloud board connection\."/);
  assert.match(settingsPage, /buildLocalizedSettingsSections\(\{ isWindows, desktopPetSupported, debugVisible, t \}\)/);
});

test("Tunnel Hub settings expose enabled state and Desktop runtime wiring", () => {
  const settingsPage = readSourceFile("src", "renderer", "pages", "settings", "SettingsPage.tsx");
  const servicesContract = readSourceFile("src", "shared", "contracts", "services.ts");
  const tunnelSettings = readSourceFile("src", "main", "tunnel-hub-settings.ts");
  const tunnelRuntime = readSourceFile("src", "main", "tunnel-hub-runtime.ts");
  const removedTunnelHubServiceId = ["tunnel", "hub", "agent"].join("-");
  const removedDefaultRelayConstant = ["DEFAULT", "TUNNEL", "HUB", "AGENT"].join("_");
  const removedRelayHost = ["tunnel-hub", "zenmind", "cc"].join("\\.");
  const removedTunnelHubPatterns = new RegExp(`${removedDefaultRelayConstant}|${removedTunnelHubServiceId}|${removedRelayHost}`);

  assert.match(servicesContract, /interface TunnelHubSettings[\s\S]*?enabled:\s*boolean;/);
  assert.match(servicesContract, /interface TunnelHubSettingsInput[\s\S]*?enabled\?:\s*boolean;/);
  assert.match(servicesContract, /interface TunnelHubRuntimeStatus[\s\S]*?phase:\s*TunnelHubRuntimePhase;/);
  assert.match(tunnelSettings, /readTunnelHubSettings[\s\S]*?enabled/);
  assert.match(tunnelSettings, /requestedEnabled && issues\.length === 0/);
  assert.match(tunnelSettings, /function normalizeRelayUrl\(value: unknown\)[\s\S]*?value\.trim\(\)/);
  assert.doesNotMatch(servicesContract, /registrationToken|clearRegistrationToken|hasRegistrationToken|registrationTokenPreview/);
  assert.doesNotMatch(settingsPage, /registrationToken|clearRegistrationToken|hasRegistrationToken|registrationTokenPreview|Input\.Password/);
  assert.doesNotMatch(tunnelSettings, /readTunnelHubRegistrationToken|Registration token is required/);
  assert.doesNotMatch(tunnelSettings, removedTunnelHubPatterns);
  assert.match(tunnelRuntime, /startTunnelHubRuntimeIfEnabled/);
  assert.doesNotMatch(tunnelRuntime, new RegExp(`startService|restartService|${removedTunnelHubPatterns.source}`));
  assert.match(settingsPage, /case "tunnelHub"[\s\S]*handleToggleTunnelHubEnabled/);
  assert.match(settingsPage, /settings\.tunnelHub\.panelAria/);
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
  const mainProcess = readMainProcessRuntimeSource();
  const mainIpcRegister = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "register.ts"), "utf8");
  const assistantRuntime = fs.readFileSync(path.join(projectRoot, "src", "main", "bridge", "assistant-runtime.ts"), "utf8");
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
  assert.match(lightSidebarRule, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.05\);/);
  assert.match(darkSidebarRule, /background:\s*rgba\(0,\s*0,\s*0,\s*0\.15\);/);
  assert.doesNotMatch(darkSidebarRule, /rgba\(57,\s*58,\s*62,\s*0\.5\)/);
  assert.doesNotMatch(darkSidebarRule, /rgba\(46,\s*48,\s*52,\s*0\.44\)/);
  assert.doesNotMatch(darkSidebarRule, /rgba\(37,\s*39,\s*43,\s*0\.38\)/);
  assert.match(macSidebarRule, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.05\);/);
  assert.match(macSidebarRule, /box-shadow:[\s\S]*?10px 0 28px rgba\(60,\s*60,\s*67,\s*0\.08\);/);
  assert.match(macDarkSidebarRule, /background:\s*rgba\(0,\s*0,\s*0,\s*0\.15\);/);
  assert.match(macDarkSidebarRule, /backdrop-filter:\s*none;/);
  assert.match(macDarkSidebarRule, /-webkit-backdrop-filter:\s*none;/);
  assert.doesNotMatch(macDarkSidebarRule, /rgba\(57,\s*58,\s*62,\s*0\.5\)/);
  assert.doesNotMatch(macDarkSidebarRule, /rgba\(46,\s*48,\s*52,\s*0\.44\)/);
  assert.doesNotMatch(macDarkSidebarRule, /rgba\(37,\s*39,\s*43,\s*0\.38\)/);
  assert.doesNotMatch(macDarkSidebarRule, /brightness\(0\.76\)/);

  assert.doesNotMatch(preload, /setSidebarTranslucency/);
  assert.match(preload, /getAppInfo:\s*\(\) => ipcRenderer\.invoke\("settings\.getAppInfo"\)/);
  assert.match(preload, /getDeviceIdentity:\s*\(\) => ipcRenderer\.invoke\("settings\.getDeviceIdentity"\)/);
  assert.match(preload, /getUsageProfile:\s*\(\) => ipcRenderer\.invoke\("settings\.getUsageProfile"\)/);
  assert.match(preload, /getDesktopDeviceInfo:\s*\(\) => ipcRenderer\.invoke\("settings\.getDesktopDeviceInfo"\)/);
  assert.match(preload, /resetRuntimeEnv:\s*\(\) => ipcRenderer\.invoke\("settings\.resetRuntimeEnv"\)/);
  assert.match(preload, /setNativeThemeSource:\s*\(themeMode\) => ipcRenderer\.invoke\("settings\.setNativeThemeSource", themeMode\)/);
  assert.match(preload, /getLocale:\s*\(\) => ipcRenderer\.invoke\("settings\.getLocale"\)/);
  assert.match(preload, /setLocale:\s*\(locale\) => ipcRenderer\.invoke\("settings\.setLocale", locale\)/);
  assert.match(preload, /ipcRenderer\.on\("settings\.localeChanged"/);
  assert.match(preload, /ipcRenderer\.on\("settings\.desktopConfigChanged"/);
  assert.match(contracts, /interface DesktopAppInfo/);
  assert.match(contracts, /productName:\s*string/);
  assert.match(contracts, /buildTime:\s*string/);
  assert.match(contracts, /interface DesktopDeviceIdentityInfo/);
  assert.match(contracts, /identityPath:\s*string/);
  assert.match(contracts, /machineSource:\s*DesktopDeviceIdentityMachineSource/);
  assert.match(contracts, /interface DesktopDeviceInfo/);
  assert.match(contracts, /deviceName:\s*string/);
  assert.match(contracts, /configuredDeviceName:\s*string/);
  assert.match(contracts, /interface DesktopGeneralSettings[\s\S]*?desktopActionConfirmationEnabled:\s*boolean;/);
  assert.match(contracts, /interface DesktopGeneralSettingsInput[\s\S]*?desktopActionConfirmationEnabled\?:\s*boolean;/);
  assert.match(contracts, /type DesktopUsageProfileResult/);
  assert.match(contracts, /currentKey:\s*DesktopUsageProfileAPIKey/);
  assert.match(contracts, /getUsageProfile: \(\) => Promise<DesktopUsageProfileResult>/);
  assert.match(contracts, /interface DesktopRuntimeEnvResetResult/);
  assert.match(contracts, /interface MarketSettings[\s\S]*?enabled:\s*boolean;[\s\S]*?apiBaseUrl:\s*string;/);
  assert.match(contracts, /interface MarketSettingsInput[\s\S]*?enabled\?:\s*boolean;[\s\S]*?apiBaseUrl\?:\s*string;/);
  assert.match(contracts, /getAppInfo: \(\) => Promise<DesktopAppInfo>/);
  assert.match(contracts, /getDeviceIdentity: \(\) => Promise<DesktopDeviceIdentityInfo>/);
  assert.match(contracts, /getUsageProfile: \(\) => Promise<DesktopUsageProfileResult>/);
  assert.match(contracts, /getDesktopDeviceInfo: \(\) => Promise<DesktopDeviceInfo>/);
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
  assert.match(settingsHandlers, /getDesktopDeviceIdentityInfo/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.getDeviceIdentity", async \(\) => getDesktopDeviceIdentityInfo\(app\)\)/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.getUsageProfile"[\s\S]*?getDesktopUsageProfile\(app\)/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.getDesktopDeviceInfo", async \(\) => getDesktopDeviceInfo\(app\)\)/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.getDesktopWsServerState"/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.setDesktopWsServerEnabled"/);
  assert.match(settingsHandlers, /desktopActionConfirmationEnabled:\s*current\.general\.desktopActionConfirmationEnabled/);
  assert.match(settingsHandlers, /desktopActionConfirmationEnabled:\s*typeof input\?\.desktopActionConfirmationEnabled === "boolean"/);
  assert.match(settingsPage, /settings\.about\.buildTime/);
  assert.match(settingsPage, /settings-about-build-time/);
  assert.match(settingsPage, /settings\.about\.deviceId/);
  assert.match(settingsPage, /settings-about-device-id/);
  assert.match(mainProcess, /const desktopAppInfo = systemIdentityRuntime\.desktopAppInfo;/);
  assert.match(mainProcess, /configureNativeAboutPanel\(options\.platform, options\.app, desktopAppInfo\);/);
  assert.match(mainIpcRegister, /getAppInfo:\s*\(\) => options\.desktopAppInfo/);
  assert.match(appMetadata, /resolveDesktopBuildTime/);
  assert.match(appMetadata, /if \(platform === "darwin"\)[\s\S]*?app\.setAboutPanelOptions\(\{[\s\S]*?applicationName: appInfo\.productName[\s\S]*?applicationVersion: appInfo\.version[\s\S]*?version: appInfo\.buildTime/);
  assert.match(appMetadata, /if \(platform === "win32"\)[\s\S]*?app\.setAboutPanelOptions/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.resetRuntimeEnv"/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.setNativeThemeSource"/);
  assert.match(settingsHandlers, /ipcMain\.handle\("settings\.getLocale", async \(\) => initializeMainI18n\(app\)\)/);
  assert.match(mainIpcRegister, /registerSettingsIpcHandlers\(/);
  assert.match(mainProcess, /general\.desktopWsServerEnabled/);
  assert.match(settingsPage, /desktopActionConfirmationEnabled:\s*true/);
  assert.match(settingsPage, /handleToggleDesktopActionConfirmation/);
  assert.match(settingsPage, /settings\.general\.desktopActionConfirmation/);
  assert.match(assistantRuntime, /startDesktopWsServerForSettings/);
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
  assert.match(appShell, /window\.electronAPI\.kanban\.getSettings\(\)/);
  assert.match(appShell, /setKanbanEnabled\(result\.settings\.enabled\)/);
  assert.match(appShell, /async function refreshMarketSettingsVisibility\(\)[\s\S]*?const requestId = marketSettingsRefreshIdRef\.current \+ 1;[\s\S]*?window\.electronAPI\.market\.getSettings\(\)[\s\S]*?setMarketEnabled\(isMarketSettingsVisible\(settings\)\)[\s\S]*?setMarketSettingsLoaded\(true\)/);
  assert.match(appShell, /useEffect\(\(\) => \{\s*void refreshMarketSettingsVisibility\(\);\s*return \(\) => \{\s*marketSettingsRefreshIdRef\.current \+= 1;\s*\};\s*\}, \[\]\);/);
  assert.match(appShell, /window\.electronAPI\.onServicesChanged\(\(\) => \{[\s\S]*?void refreshMarketSettingsVisibility\(\);[\s\S]*?refreshWebItems\(\)\.catch\(\(\) => undefined\);[\s\S]*?void refreshAssistantNavAgents\(\);/);
  assert.match(appShell, /<Navigate to="\/control-center" replace \/>/);
  assert.doesNotMatch(appShell, /item\.key !== "kanban" \|\| kanbanEnabled/);
  assert.doesNotMatch(appShell, /showStartupPetGreeting/);
  assert.match(appShell, /path="\/"[\s\S]*?element=\{<StartupRoutePlaceholder \/>\}/);
  assert.doesNotMatch(appShell, /const navigationStateLoaded = navigationPreferencesLoaded && kanbanSettingsLoaded/);
  assert.match(appShell, /if \(!navigationPreferencesLoaded \|\| !kanbanSettingsLoaded\) \{\s*return;\s*\}/);
  assert.doesNotMatch(appShell, /preferences\?\.kanban/);
  assert.doesNotMatch(appShell, /onKanbanEnabledChange/);
  assert.match(settingsPage, /window\.electronAPI\.kanban\.saveSettings\(\{\s*enabled:\s*true,/);
  assert.match(appShell, /onMarketEnabledChange=\{setMarketEnabled\}/);
  assert.match(appShell, /marketEnabled=\{marketEnabled\}/);
  assert.match(appShell, /resolveKanbanAwareNavigationPath\([\s\S]*?kanbanEnabled/);
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
  const embeddedSurfaceHosts = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx"
  );
  const pluginPage = readSourceFile("src", "renderer", "pages", "plugin", "PluginPage.tsx");
  const dockComponent = readSourceFile(
    "src",
    "renderer",
    "copilot",
    "sidebar-copilot",
    "AgentWebclientCopilotDock.tsx"
  );
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const resolver = fs.readFileSync(path.join(projectRoot, "src", "shared", "page-copilot.ts"), "utf8");

  assert.match(resolver, /resolveDesktopCopilotPageKey/);
  assert.match(resolver, /"\/control-center"[\s\S]*?"controlCenter"/);
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
  assert.match(appShell, /function closeAssistantDock\(\)[\s\S]*?setAssistantDockOpenPath\(null\)[\s\S]*?setAssistantDockOpenRequest\(null\)[\s\S]*?assistantDockOpenRequestPathRef\.current = null/);
  assert.match(appShell, /<BuiltinBrowserSurfaceHost[\s\S]*?assistantDockOpen=\{assistantCopilotOpen\}[\s\S]*?onOpenAssistantDock=\{\(\) => openAssistantDock\(\)\}[\s\S]*?onCloseAssistantDock=\{closeAssistantDock\}/);
  assert.match(appShell, /<WebSurfaceHost[\s\S]*?assistantDockOpen=\{assistantCopilotOpen\}[\s\S]*?onOpenAssistantDock=\{\(\) => openAssistantDock\(\)\}[\s\S]*?onCloseAssistantDock=\{closeAssistantDock\}/);
  assert.match(appShell, /<ExternalItemRoute[\s\S]*?assistantDockOpen=\{assistantCopilotOpen\}[\s\S]*?onOpenAssistantDock=\{\(\) => openAssistantDock\(\)\}[\s\S]*?onCloseAssistantDock=\{closeAssistantDock\}/);
  assert.match(embeddedSurfaceHosts, /assistantDockOpen\?: boolean;/);
  assert.match(embeddedSurfaceHosts, /onOpenAssistantDock\?: \(\) => void;/);
  assert.match(embeddedSurfaceHosts, /onCloseAssistantDock\?: \(\) => void;/);
  assert.match(embeddedSurfaceHosts, /<ExternalWebviewPage[\s\S]*?assistantDockOpen=\{assistantDockOpen\}[\s\S]*?onOpenAssistantDock=\{onOpenAssistantDock\}[\s\S]*?onCloseAssistantDock=\{onCloseAssistantDock\}/);
  assert.match(appShell, /onRunningRunIdChange=\{setAssistantRunningRunId\}/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.match(appShell, /websiteAgentKey = activeWebEntry\?\.agentKey \|\| ""/);
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
  assert.match(appShell, /function mergeWebsiteItems\(currentItems: WebEntry\[\], nextWebsiteItems: WebsiteEntry\[\]\)/);
  assert.match(appShell, /websiteAgentSyncRequestRef = useRef\(""\)/);
  assert.match(appShell, /function handleCopilotSelectedAgentKeyChange\(agentKey: string\)[\s\S]*?activeWebEntry\?\.kind !== "website"/);
  assert.match(appShell, /normalizedAgentKey === resolvedCopilotAgentKey/);
  assert.match(appShell, /copilotAgentOptions\.some\(\(agent\) => agent\.agentKey\.trim\(\) === normalizedAgentKey\)/);
  assert.match(appShell, /window\.electronAPI\.webs\.websites[\s\S]*?\.update\(websiteId, \{ agentKey: normalizedAgentKey \}\)/);
  assert.match(appShell, /updateWebItems\(mergeWebsiteItems\(webItems, result\.items\)\)/);
  assert.match(appShell, /onSelectedAgentKeyChange=\{handleCopilotSelectedAgentKeyChange\}/);
  assert.match(pluginPage, /onCurrentUrlChange\?: \(url: string\) => void/);
  assert.match(pluginPage, /const onCurrentUrlChangeRef = useRef\(onCurrentUrlChange\)/);
  assert.match(pluginPage, /function updateWebviewCurrentUrl\(nextUrl: string\)[\s\S]*?onCurrentUrlChangeRef\.current\?\.\(nextUrl\)/);
  assert.match(pluginPage, /const syncNavigationRoute = \(event: Event\) => \{[\s\S]*?updateWebviewCurrentUrl\(resolvedUrl\)/);
  assert.match(dockComponent, /function readCopilotAgentKeyFromUrl\(value: string\)/);
  assert.match(dockComponent, /readCopilotAgentKeyFromPathname\(new URL\(trimmed, "http:\/\/agent-webclient\.local"\)\.pathname\)/);
  assert.match(dockComponent, /onSelectedAgentKeyChange\?: \(agentKey: string\) => void/);
  assert.match(dockComponent, /onSelectedAgentKeyChange\?\.\(selectedAgentKey\)/);
  assert.match(dockComponent, /onCurrentUrlChange=\{handleCurrentUrlChange\}/);
  assert.doesNotMatch(dockComponent, /agent-webclient-copilot-close/);
  assert.doesNotMatch(globalStyles, /\.agent-webclient-copilot-close/);
  assert.doesNotMatch(appShell, /key=\{`agent-webclient-copilot:\$\{targetEmbedPath\}`\}/);
  assert.match(appShell, /function isSingleAgentWebclientRoute\(pathname: string\)[\s\S]*?matchPath\("\/agent\/:agentKey", pathname\)/);
  assert.match(sidebarSource, /assistantLauncherVisible/);
  assert.match(sidebarSource, /assistantLauncherDisabled/);
  assert.match(sidebarSource, /assistantLauncherVisible \? \(/);
  assert.match(sidebarSource, /<SidebarActionIcon kind="sidebar_right" \/>/);
  assert.doesNotMatch(sidebarSource, /sidebar-assistant-open[\s\S]*sidebar-assistant-closed/);
  assert.match(sidebarSource, /if \(assistantDockOpen\) \{\s*onCloseAssistantDock\?\.\(\);\s*\} else \{\s*onOpenAssistantDock\?\.\(\);/);
  assert.doesNotMatch(sidebarSource, /assistantDockOpen \? "sidebar-link-active" : ""/);
  assert.doesNotMatch(sidebarSource, /!assistantDockOpen && \(isActive \|\| pendingPath === "\/settings"\)/);
  assert.match(sidebarSource, /assistantDockOpen \? "is-assistant-open" : ""/);
  assert.match(sidebarSource, /title=\{t\("sidebar\.copilot\.title"\)\}/);
  assert.doesNotMatch(sidebarSource, /sidebar-link-label-collapsed" aria-hidden="true">助手/);
  assert.doesNotMatch(sidebarSource, /assistantDockOpen \? "is-open" : ""/);
  assert.doesNotMatch(sidebarSource, /sidebar-assistant-switch/);
  assert.match(sidebarSource, /disabled=\{assistantLauncherDisabled\}/);
  assert.doesNotMatch(globalStyles, /\.sidebar-assistant-launcher\.is-open/);
  assert.match(globalStyles, /\.sidebar-assistant-top-button-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;[\s\S]*?color:\s*#94a3b8;/);
  assert.match(globalStyles, /\.sidebar-assistant-top-button\.is-assistant-open \.sidebar-assistant-top-button-icon\s*\{[\s\S]*?color:\s*#1e293b;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.sidebar-assistant-top-button\.is-assistant-open \.sidebar-assistant-top-button-icon\s*\{[\s\S]*?color:\s*#e2e8f0;/);
  assert.doesNotMatch(globalStyles, /\.sidebar-assistant-top-button:not\(\.is-assistant-open\)[\s\S]*?filter:\s*grayscale/);
  assert.match(globalStyles, /\.sidebar-assistant-top-button\.is-disabled/);
  assert.doesNotMatch(globalStyles, /\.sidebar-assistant-switch/);
});

test("Kanban cards align issue meta, title, and hover actions with website", () => {
  const contracts = readSourceFile("src", "shared", "contracts", "kanban.ts");
  const kanbanPage = readSourceFile("src", "renderer", "pages", "kanban", "KanbanPage.tsx");
  const kanbanStyles = readSourceFile("src", "renderer", "styles", "kanban.css");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(contracts, /KANBAN_RUN_STATES/);
  assert.match(contracts, /"cancelled"/);
  assert.match(contracts, /runState: KanbanRunState \| null/);
  assert.match(contracts, /stageName\?: string/);
  assert.match(contracts, /statusName\?: string/);
  assert.match(contracts, /statusKey\?: string/);
  assert.match(kanbanPage, /function formatIssueUpdatedTime\(updatedAt: string\)/);
  assert.match(kanbanPage, /const date = `\$\{padAutomationNumber\(updatedDate\.getMonth\(\) \+ 1\)\}\/\$\{padAutomationNumber\(updatedDate\.getDate\(\)\)\}`/);
  assert.match(kanbanPage, /return `\$\{updatedDate\.getFullYear\(\)\}\/\$\{date\}`/);
  assert.doesNotMatch(kanbanPage, /return `\$\{padAutomationNumber\(updatedDate\.getMonth\(\) \+ 1\)\}\/\$\{padAutomationNumber\(updatedDate\.getDate\(\)\)\} \$\{time\}`/);
  assert.match(kanbanPage, /function getIssueCardStatusPresentation\(\s*issue: KanbanIssue,\s*options:/);
  assert.match(kanbanPage, /issue\.status === "backlog"[\s\S]{0,220}label:\s*formatIssueUpdatedTime\(issue\.updatedAt\)/);
  assert.match(kanbanPage, /issue\.status === "todo"[\s\S]{0,280}label:\s*automationCountdown \|\| formatKanbanSortNumber\(options\.sortIndex, issue\.position\)/);
  assert.doesNotMatch(kanbanPage, /kanban\.card\.(updatedAt|sortOrder)/);
  assert.match(kanbanPage, /options\.awaitingConfirmation && issue\.status === "in_progress"[\s\S]{0,260}kanban\.run\.awaitingApproval/);
  assert.match(kanbanPage, /issue\.runState === "cancelled"[\s\S]{0,220}kanban\.run\.cancelled[\s\S]{0,220}tone: "cancelled"/);
  assert.match(kanbanPage, /issue\.runState === "failed"[\s\S]{0,220}kanban\.run\.failed[\s\S]{0,220}tone: "failed"/);
  assert.match(kanbanPage, /issue\.runState === "running" \|\| \(issue\.status === "in_progress" && Boolean\(issue\.runId\)\)[\s\S]{0,220}kanban\.run\.running[\s\S]{0,220}tone: "running"/);
  assert.match(kanbanPage, /issue\.status === "completed"[\s\S]{0,220}kanban\.run\.succeeded[\s\S]{0,220}tone: "succeeded"/);
  assert.match(kanbanPage, /label: t\(STATUS_META\[issue\.status\]\.labelKey\)[\s\S]{0,120}tone: issue\.status/);
  assert.match(kanbanPage, /const cardStatus = getIssueCardStatusPresentation\(issue, \{[\s\S]{0,120}awaitingConfirmation[\s\S]{0,120}sortIndex/);
  assert.match(kanbanPage, /<span className=\{`kanban-status-dot is-\$\{meta\.tone\}`\} aria-hidden="true" \/>/);
  assert.doesNotMatch(kanbanPage, /status !== "backlog" \? <span className=\{`kanban-status-dot/);
  assert.match(kanbanPage, /function canEditKanbanIssueBody\(issue: KanbanIssue \| null \| undefined\)/);
  assert.match(kanbanPage, /return issue\?\.syncMode !== "cloud"/);
  assert.match(kanbanPage, /function getIssueStageLabel\(issue: KanbanIssue\)/);
  assert.match(kanbanPage, /return issue\.stageName\?\.trim\(\) \|\| ""/);
  assert.doesNotMatch(kanbanPage, /function getIssueStageLabel[\s\S]{0,180}statusName/);
  assert.doesNotMatch(kanbanPage, /function getIssueStageLabel[\s\S]{0,180}STATUS_META/);
  assert.match(kanbanPage, /type KanbanIssueOriginPresentation/);
  assert.match(kanbanPage, /function getKanbanIssueOriginPresentation\(\s*issue: KanbanIssue,\s*projectsById: Map<string, KanbanProject>,\s*t: TranslateFunction/);
  assert.match(kanbanPage, /const project = projectsById\.get\(projectId\)/);
  assert.match(kanbanPage, /const kanbanProjectsById = useMemo\(\(\) => new Map\(cloudProjects\.map\(\(project\) => \[project\.id, project\]\)\), \[cloudProjects\]\)/);
  assert.match(kanbanPage, /const issueOrigin = getKanbanIssueOriginPresentation\(issue, projectsById, t\)/);
  assert.doesNotMatch(kanbanPage, /getKanbanIssueDisplayId/);
  assert.doesNotMatch(kanbanPage, /displayIssueId/);
  assert.match(kanbanPage, /shortLabelKey: "kanban\.priority\.highShort"/);
  assert.match(kanbanPage, /shortLabelKey: "kanban\.severity\.criticalShort"/);
  assert.match(kanbanPage, /const shortLabel = t\(meta\.shortLabelKey\)/);
  assert.match(kanbanPage, /<span className="issue-card-project"[\s\S]{0,120}title=\{issueOrigin\.title\}[\s\S]{0,120}\{issueOrigin\.projectLabel\}/);
  assert.match(kanbanPage, /<IssueCardFooterPriorityBadge priority=\{issue\.priority\} t=\{t\} \/>/);
  assert.match(kanbanPage, /<IssueCardFooterSeverityBadge severity=\{severity\} t=\{t\} \/>/);
  assert.match(kanbanPage, /function IssueCardFooterPriorityBadge/);
  assert.match(kanbanPage, /function getPersonInitials\(label: string\)/);
  assert.match(kanbanPage, /\{stageLabel \? \([\s\S]{0,220}<span className="issue-card-header-dot"[\s\S]{0,220}<span className="issue-card-stage-name"[\s\S]{0,180}\{stageLabel\}/);
  assert.match(kanbanPage, /<div className="issue-card-title-block" title=\{issue\.title\}>/);
  assert.doesNotMatch(kanbanPage, /<strong title=\{description \|\| issue\.title\}>/);
  assert.doesNotMatch(kanbanPage, /kanban-sync-badge/);
  assert.doesNotMatch(kanbanPage, /kanban-chat-action/);
  assert.doesNotMatch(kanbanPage, /KanbanIcon kind="message"/);
  assert.match(kanbanPage, /className="issue-card-status"/);
  assert.doesNotMatch(kanbanPage, /className=\{`issue-card-status is-\$\{cardStatus\.tone\}`\}/);
  assert.doesNotMatch(kanbanPage, /\{cardStatus\.updatedTime \? <span className="issue-card-status-time">\{cardStatus\.updatedTime\}<\/span> : null\}/);
  assert.doesNotMatch(kanbanPage, /kanban-run-dot/);
  assert.match(kanbanPage, /<span className="issue-card-status-dot" aria-hidden="true" \/>/);
  assert.match(kanbanPage, /<span className="issue-card-status-label">\{cardStatus\.label\}<\/span>/);
  assert.match(kanbanPage, /className="issue-card-meta-line"/);
  assert.match(kanbanPage, /className="issue-card-footer-badges"/);
  assert.match(kanbanPage, /className="issue-card-footer-end"/);
  assert.match(kanbanPage, /className="issue-card-assignee"/);
  assert.match(kanbanPage, /function getIssueCardShellClassName\(/);
  assert.match(kanbanPage, /function getIssueCardPeoplePresentation\(/);
  assert.match(kanbanPage, /function formatKanbanPersonLabel\(/);
  assert.match(kanbanPage, /`is-priority-\$\{issue\.priority\}`/);
  assert.match(kanbanPage, /issue\.assigneeAgentKey\?\.trim\(\) \? "has-agent" : ""/);
  assert.match(kanbanPage, /title=\{automationLabel\}/);
  assert.match(kanbanPage, /className="issue-card-meta-line" title=\{automationLabel\}/);
  assert.match(kanbanPage, /const canOpenIssueDetails = interactive/);
  assert.match(kanbanPage, /const canDeleteIssue = interactive && canEditKanbanIssueBody\(issue\)/);
  assert.match(kanbanPage, /const canOpenIssueChat = interactive && Boolean\(issue\.chatId\?\.trim\(\)\)/);
  assert.match(kanbanPage, /const issuesByStatus = useMemo\(\(\) => \{/);
  assert.match(kanbanPage, /const columnIssues = issuesByStatus\[status\] \?\? \[\]/);
  assert.match(kanbanPage, /if \(activeDragIssueIdRef\.current\) \{\s*return;\s*\}/);
  assert.match(kanbanPage, /const openEditModal = useCallback\(\(issue: KanbanIssue\) => \{/);
  assert.match(kanbanPage, /const deleteIssue = useCallback\(async \(issue: KanbanIssue\) => \{/);
  assert.match(kanbanPage, /const openIssueContextMenu = useCallback\(\(issue: KanbanIssue, event: MouseEvent<HTMLElement>\) => \{/);
  assert.match(kanbanPage, /const openAssistantIssueChat = useCallback\(async \(issue: KanbanIssue\) => \{/);
  assert.match(kanbanPage, /const KanbanColumn = memo\(function KanbanColumn\(/);
  assert.match(kanbanPage, /const IssueCard = memo\(function IssueCard\(/);
  assert.match(kanbanPage, /const IssueCardContent = memo\(function IssueCardContent\(/);
  assert.match(kanbanPage, /className="issue-card-actions"/);
  assert.match(kanbanPage, /<EyeOutlined \/>/);
  assert.match(kanbanPage, /<MessageOutlined \/>/);
  assert.match(kanbanPage, /<DeleteOutlined \/>/);
  assert.match(kanbanPage, /aria-label=\{t\("kanban\.card\.viewDetails"\)\}/);
  assert.match(kanbanPage, /aria-label=\{t\("kanban\.chat\.view"\)\}/);
  assert.match(kanbanPage, /modalReadOnly[\s\S]{0,80}\? t\("kanban\.modal\.detailTitle"\)/);
  assert.match(kanbanPage, /const modalReadOnly = modal\?\.mode === "edit" && !canEditKanbanIssueBody\(modal\.issue\)/);
  assert.match(kanbanPage, /modal\.mode === "edit" && modal\.issue && !modalReadOnly/);
  assert.match(kanbanPage, /runState: nextRunStatus\.runState/);
  assert.match(kanbanPage, /runState: "running"/);
  assert.match(kanbanStyles, /--kanban-column-min-width:\s*220px;/);
  assert.match(kanbanStyles, /\.issue-card-header\s*\{[\s\S]{0,220}display:\s*grid;[\s\S]{0,220}grid-template-columns:\s*minmax\(0, 1fr\) max-content;/);
  assert.match(kanbanStyles, /\.issue-card-header-meta\s*\{[\s\S]{0,180}gap:\s*8px;[\s\S]{0,120}overflow:\s*hidden;/);
  assert.match(kanbanStyles, /\.issue-card-footer-badge\s*\{/);
  assert.match(kanbanStyles, /\.issue-card-title-block\s*\{[\s\S]{0,400}-webkit-line-clamp:\s*2;/);
  assert.match(kanbanStyles, /\.issue-card-title-block\s*\{[\s\S]{0,400}font-weight:\s*400;/);
  assert.match(kanbanStyles, /\.issue-card-description\s*\{[\s\S]{0,220}-webkit-line-clamp:\s*2;/);
  assert.match(kanbanStyles, /\.issue-card-status\s*\{[\s\S]{0,220}height:\s*auto;/);
  assert.match(kanbanStyles, /\.issue-card-status-dot\s*\{/);
  assert.match(kanbanStyles, /\.issue-card\.is-in_progress \.issue-card-status-dot\s*\{[\s\S]{0,120}--kanban-status-progress/);
  assert.match(kanbanStyles, /\.issue-card-meta-line\s*\{/);
  assert.match(kanbanStyles, /\.issue-card-assignee-avatar\s*\{/);
  assert.match(kanbanStyles, /\.issue-card-footer-end\s*\{[\s\S]{0,180}position:\s*relative;/);
  assert.doesNotMatch(kanbanStyles, /\.issue-card\.has-agent::before\s*\{/);
  assert.match(kanbanStyles, /\.issue-card-actions\s*\{[\s\S]{0,220}position:\s*absolute;/);
  assert.match(kanbanStyles, /\.issue-card-actions\s*\{[\s\S]{0,500}opacity:\s*0;[\s\S]{0,120}pointer-events:\s*none;/);
  assert.match(kanbanStyles, /\.issue-card:hover \.issue-card-actions,[\s\S]{0,80}\.issue-card:focus-within \.issue-card-actions\s*\{[\s\S]{0,100}opacity:\s*1;[\s\S]{0,80}pointer-events:\s*auto;/);
  assert.match(kanbanStyles, /\.issue-card:hover \.issue-card-assignee,[\s\S]{0,80}\.issue-card:focus-within \.issue-card-assignee\s*\{[\s\S]{0,100}opacity:\s*0;/);
  assert.match(kanbanStyles, /\.issue-card-action\s*\{[\s\S]{0,180}width:\s*22px;[\s\S]{0,180}height:\s*22px;/);
  assert.match(kanbanStyles, /\.issue-card-project\s*\{/);
  assert.match(kanbanStyles, /\.kanban-modal\.is-readonly/);
  assert.doesNotMatch(kanbanStyles, /\.kanban-chat-action/);
  assert.doesNotMatch(kanbanStyles, /\.issue-card-main strong/);
  assert.match(zhCN, /"kanban\.severity\.critical": "严重"/);
  assert.match(zhCN, /"kanban\.severity\.criticalShort": "极"/);
  assert.match(zhCN, /"kanban\.priority\.highShort": "高"/);
  assert.match(zhCN, /"kanban\.card\.stage": "当前阶段：\{value\}"/);
  assert.match(zhCN, /"kanban\.card\.viewDetails": "查看详情"/);
  assert.match(zhCN, /"kanban\.card\.project": "项目：\{value\}"/);
  assert.match(enUS, /"kanban\.severity\.critical": "Critical"/);
  assert.match(enUS, /"kanban\.severity\.criticalShort": "X"/);
  assert.match(enUS, /"kanban\.priority\.highShort": "H"/);
  assert.match(enUS, /"kanban\.card\.stage": "Current stage: \{value\}"/);
  assert.match(enUS, /"kanban\.card\.viewDetails": "View details"/);
  assert.match(enUS, /"kanban\.card\.project": "Project: \{value\}"/);
});

test("Kanban toolbar can filter issues by automation", () => {
  const kanbanPage = readSourceFile("src", "renderer", "pages", "kanban", "KanbanPage.tsx");
  const kanbanStyles = readSourceFile("src", "renderer", "styles", "kanban.css");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(kanbanPage, /type KanbanAutomationFilter = "all" \| "scheduled" \| "manual"/);
  assert.match(kanbanPage, /const KANBAN_AUTOMATION_FILTER_OPTIONS = \[/);
  assert.match(kanbanPage, /function shouldShowIssueForAutomationFilter\(\s*issue: Pick<KanbanIssue, "automationEnabled" \| "automationCron">,\s*filter: KanbanAutomationFilter/);
  assert.match(kanbanPage, /if \(filter === "all"\) \{[\s\S]{0,80}return true;/);
  assert.match(kanbanPage, /const hasAutomation = hasIssueAutomation\(issue\)/);
  assert.match(kanbanPage, /const \[automationFilter,\s*setAutomationFilter\] = useState<KanbanAutomationFilter>\("all"\)/);
  assert.match(kanbanPage, /shouldShowIssueForAutomationFilter\(issue, automationFilter\)/);
  assert.match(kanbanPage, /className=\{`kanban-search-filter-button \$\{openMenu === "automation" \? "is-open" : ""\} \$\{hasAutomationFilter \? "is-active" : ""\}`\}/);
  assert.match(kanbanPage, /KANBAN_AUTOMATION_FILTER_OPTIONS\.map/);
  assert.match(kanbanPage, /aria-label=\{t\("kanban\.searchFilter\.automation"\)\}/);
  assert.match(kanbanPage, /checked=\{automationFilter === option\.value\}/);
  assert.match(kanbanStyles, /\.kanban-search-filter-button\.is-active\s*\{/);
  assert.match(kanbanStyles, /\.kanban-search-filter-menu\s*\{/);
  assert.match(zhCN, /"kanban\.searchFilter\.hasAutomation": "定时议题"/);
  assert.match(zhCN, /"kanban\.searchFilter\.noAutomation": "手动议题"/);
  assert.match(enUS, /"kanban\.searchFilter\.hasAutomation": "Has automation"/);
  assert.match(enUS, /"kanban\.searchFilter\.noAutomation": "No automation"/);
});

test("Kanban cloud popover resyncs and toolbar filters by project tree", () => {
  const contracts = readSourceFile("src", "shared", "contracts", "desktop-api.ts");
  const preload = readSourceFile("src", "preload", "index.ts");
  const kanbanHandlers = readSourceFile("src", "main", "ipc", "kanban-handlers.ts");
  const kanbanRuntime = readSourceFile("src", "main", "kanban-runtime.ts");
  const wsClient = readSourceFile("src", "main", "kanban-desktop-ws-client.ts");
  const kanbanPage = readSourceFile("src", "renderer", "pages", "kanban", "KanbanPage.tsx");
  const kanbanStyles = readSourceFile("src", "renderer", "styles", "kanban.css");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(contracts, /resyncCloudBoard: \(\) => Promise<KanbanListResult>/);
  assert.match(preload, /ipcRenderer\.invoke\("kanban\.resyncCloudBoard"\)/);
  assert.match(kanbanHandlers, /ipcMain\.handle\("kanban\.resyncCloudBoard"/);
  assert.match(kanbanRuntime, /async resyncCloudBoard\(\): Promise<KanbanListResult>/);
  assert.match(wsClient, /async resyncFromCloud\(\)/);
  assert.match(wsClient, /async resyncFromCloud\(\)[\s\S]*"snapshot\.get"/);
  assert.match(wsClient, /async resyncFromCloud\(\)[\s\S]*pullDeliveries/);
  assert.match(kanbanPage, /async function resyncCloudBoard\(\)/);
  assert.match(kanbanPage, /kanbanApi\.resyncCloudBoard\(\)/);
  assert.match(kanbanPage, /cloudResyncing \? t\("kanban\.cloud\.resyncing"\) : t\("kanban\.cloud\.resync"\)/);
  assert.doesNotMatch(kanbanPage, /listOnlineDevices/);
  assert.doesNotMatch(kanbanPage, /kanban\.cloud\.onlineDevices/);
  assert.doesNotMatch(kanbanPage, /kanban\.cloud\.onlineSessions/);
  assert.doesNotMatch(kanbanPage, /kanban\.cloud\.onlineAgents/);
  assert.doesNotMatch(kanbanPage, /kanban\.cloud\.serverUrl/);
  assert.doesNotMatch(kanbanPage, /kanban\.cloud\.token/);
  assert.doesNotMatch(kanbanPage, /kanban\.cloud\.projectId/);
  assert.doesNotMatch(kanbanPage, /kanban\.cloud\.save"/);
  assert.doesNotMatch(kanbanPage, /settings\.control\.remoteControlEnabled/);
  assert.match(kanbanPage, /from "\.\/kanbanProjectTree"/);
  assert.match(kanbanPage, /flattenKanbanProjectTree\(projects\)/);
  assert.doesNotMatch(kanbanPage, /function flattenKanbanProjectTree\(projects: KanbanProject\[\]\)/);
  assert.match(kanbanPage, /function collectKanbanProjectAndDescendantIds\(projectId: string/);
  assert.match(kanbanPage, /function getKanbanProjectFilterIds\(projects: KanbanProject\[\], selectedProjectIds: string\[\]\)/);
  assert.match(kanbanPage, /collectKanbanProjectAndDescendantIds\(projectId, childrenByParentId, filterIds\)/);
  assert.match(kanbanPage, /projectFilterIds && !projectFilterIds\.has\(issue\.projectId \?\? ""\)/);
  assert.match(kanbanPage, /<KanbanProjectFilter[\s\S]{0,260}selectedProjectIds=\{selectedProjectIds\}/);
  assert.match(kanbanPage, /role="tree"/);
  assert.match(kanbanPage, /role="treeitem"/);
  assert.match(kanbanStyles, /\.kanban-project-filter-trigger\s*\{/);
  assert.match(kanbanStyles, /\.kanban-project-filter-menu\s*\{/);
  assert.match(kanbanStyles, /\.kanban-project-filter-row\s*\{/);
  assert.match(zhCN, /"kanban\.cloud\.resync": "重新同步"/);
  assert.match(zhCN, /"kanban\.projectFilter\.all": "全部项目"/);
  assert.match(enUS, /"kanban\.cloud\.resync": "Resync"/);
  assert.match(enUS, /"kanban\.projectFilter\.all": "All Projects"/);
});

test("Kanban scheduled tasks wait for automation time before assistant run", () => {
  const kanbanPage = readSourceFile("src", "renderer", "pages", "kanban", "KanbanPage.tsx");

  assert.match(kanbanPage, /const shouldRunAfterSave = form\.status === "in_progress" && !form\.automationEnabled && !modal\?\.issue\?\.runId;/);
  assert.match(kanbanPage, /const shouldRunTodoAssigneeAfterDelay = form\.status === "todo" && !form\.automationEnabled && Boolean\(form\.assigneeAgentKey\) && !modal\?\.issue\?\.runId;/);
  assert.doesNotMatch(kanbanPage, /form\.status === "todo" && Boolean\(form\.assigneeAgentKey\) && !modal\?\.issue\?\.runId/);
});

test("Kanban scheduled todo cards show execution countdown instead of sort number", () => {
  const kanbanPage = readSourceFile("src", "renderer", "pages", "kanban", "KanbanPage.tsx");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(kanbanPage, /function getNextKanbanAutomationTime\(issue: Pick<KanbanIssue, "automationEnabled" \| "automationCron">, now: Date\)/);
  assert.match(kanbanPage, /function formatKanbanAutomationCountdown\(issue: Pick<KanbanIssue, "automationEnabled" \| "automationCron">, now: Date, t: TranslateFunction\)/);
  assert.match(kanbanPage, /const automationCountdown = hasIssueAutomation\(issue\)[\s\S]{0,160}formatKanbanAutomationCountdown\(issue, options\.now, t\) \|\| getAutomationDisplayLabel\(issue, t\)/);
  assert.match(kanbanPage, /label: automationCountdown \|\| formatKanbanSortNumber\(options\.sortIndex, issue\.position\)/);
  assert.match(kanbanPage, /const \[kanbanCountdownNow,\s*setKanbanCountdownNow\] = useState\(\(\) => Date\.now\(\)\)/);
  assert.match(kanbanPage, /KANBAN_COUNTDOWN_REFRESH_MS/);
  assert.match(kanbanPage, /now=\{new Date\(kanbanCountdownNow\)\}/);
  assert.match(zhCN, /"kanban\.countdown\.minutes": "\{minutes\}分钟"/);
  assert.match(enUS, /"kanban\.countdown\.minutes": "\{minutes\}m"/);
});

test("Kanban route exposes native desktop api and page styles", () => {
  const contracts = readSharedContractsSource();
  const mainProcess = readMainProcessRuntimeSource();
  const mainIpcRegister = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "register.ts"), "utf8");
  const assistantRuntime = fs.readFileSync(path.join(projectRoot, "src", "main", "bridge", "assistant-runtime.ts"), "utf8");
  const kanbanHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "kanban-handlers.ts"), "utf8");
  const kanbanSync = fs.readFileSync(path.join(projectRoot, "src", "main", "kanban-sync.ts"), "utf8");
  const kanbanRuntime = fs.readFileSync(path.join(projectRoot, "src", "main", "kanban-runtime.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();
  const kanbanStyles = readSourceFile("src", "renderer", "styles", "kanban.css");
  const kanbanStore = fs.readFileSync(path.join(projectRoot, "src", "main", "kanban-store.ts"), "utf8");
  const assistantNavigationStatusClient = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "core", "assistant-navigation-status-client.ts"),
    "utf8"
  );
  const kanbanPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "kanban", "KanbanPage.tsx"),
    "utf8"
  );

  assert.match(contracts, /interface KanbanIssue/);
  assert.match(contracts, /kanban:\s*\{/);
  assert.match(contracts, /createIssue: \(input: KanbanIssueInput\) => Promise<KanbanIssueResult>/);
  assert.match(preload, /kanban:\s*\{/);
  assert.match(preload, /ipcRenderer\.invoke\("kanban\.listIssues"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("kanban\.moveIssue", input\)/);
  assert.match(preload, /ipcRenderer\.invoke\("kanban\.syncIssueAutomation", issueId\)/);
  assert.match(mainIpcRegister, /registerKanbanIpcHandlers\(ipcMain,/);
  assert.match(kanbanHandlers, /ipcMain\.handle\("kanban\.listIssues"/);
  assert.match(kanbanHandlers, /ipcMain\.handle\("kanban\.moveIssue"/);
  assert.match(kanbanHandlers, /ipcMain\.handle\("kanban\.syncIssueAutomation"/);
  assert.match(kanbanSync, /syncKanbanIssueAutomation/);
  assert.match(kanbanSync, /\/api\/automation\/create/);
  assert.match(kanbanSync, /\/api\/automation\/update/);
  assert.match(kanbanSync, /\/api\/automation\/delete/);
  assert.doesNotMatch(kanbanSync, /\/api\/schedule(?:\/|-)(?:create|update|delete)/);
  assert.match(assistantRuntime, /createKanbanRuntime/);
  assert.match(assistantRuntime, /state\.kanbanRuntime\?\.sendAssistantEvent\(event\)/);
  assert.match(kanbanSync, /type === "done"[\s\S]{0,220}type === "run\.complete"[\s\S]{0,520}return "completed"/);
  assert.match(kanbanSync, /typeValue === "run\.error"/);
  assert.match(kanbanSync, /statusValue === "timeout"[\s\S]{0,220}return "failed"/);
  assert.match(kanbanSync, /updateKanbanIssueByRunId\(app, event\.runId/);
  assert.match(kanbanSync, /updateKanbanIssueByChatId/);
  assert.match(kanbanSync, /updateKanbanIssueByChatId\(app,\s*event\.chatId/);
  assert.match(kanbanRuntime, /private async applyIssueEvent\(event: KanbanDesktopIssueEvent\)/);
  assert.match(kanbanRuntime, /private async applyDelivery\(delivery: KanbanDesktopDelivery\)/);
  assert.match(kanbanRuntime, /seq <= cursor\.lastAppliedRevision/);
  assert.match(kanbanRuntime, /tombstoneDesktopKanbanCloudIssue\(this\.options\.app, currentUser, issueEventIssueId\(event\), seq\)/);
  assert.match(kanbanRuntime, /"run\.event\.append"/);
  assert.match(kanbanRuntime, /clientEventId: stableClientEventId\(deviceId, input\.clientEventParts\)/);
  assert.match(kanbanRuntime, /t\("kanban\.runtime\.cloudReadOnly"\)/);
  assert.doesNotMatch(kanbanRuntime, /desktop\.issue\.sync/);
  assert.match(kanbanRuntime, /chatId: runResult\.chatId[\s\S]{0,80}runId: runResult\.runId[\s\S]{0,80}runState: "running"/);
  assert.match(assistantRuntime, /onPushEvent:\s*\(event\) => state\.kanbanRuntime\?\.sendAssistantEvent\(event\)/);
  assert.match(kanbanStore, /export function updateKanbanIssueByChatId/);
  assert.match(assistantNavigationStatusClient, /onPushEvent\?:/);
  assert.match(assistantNavigationStatusClient, /this\.options\.onPushEvent\?\./);
  assert.match(appShell, /import\("\.\.\/pages\/kanban\/KanbanPage"\)/);
  assert.match(kanbanPage, /function readKanbanApi/);
  assert.match(kanbanPage, /kanbanApi\.listIssues\(\)/);
  assert.match(kanbanPage, /kanbanApi\.createIssue/);
  assert.match(kanbanPage, /function canCreateIssueFromColumnDoubleClick\(status: KanbanStatus\)/);
  assert.match(kanbanPage, /return status === "backlog" \|\| status === "todo";/);
  assert.match(kanbanPage, /function shouldCreateIssueFromColumnDoubleClick/);
  assert.match(kanbanPage, /target\.closest\("\.issue-card"\)/);
  assert.match(kanbanPage, /onDoubleClick=\{\(event\) => \{[\s\S]{0,220}shouldCreateIssueFromColumnDoubleClick\(event, status\)[\s\S]{0,120}onAdd\(\)/);
  assert.match(kanbanPage, /KANBAN_FEEDBACK_AUTO_CLOSE_MS = 3000/);
  assert.match(kanbanPage, /if \(!feedback \|\| feedback\.tone !== "success"\) \{/);
  assert.match(kanbanPage, /window\.setTimeout\(\(\) => \{[\s\S]{0,140}setFeedback\(\(current\) => \(current === feedback \? null : current\)\)/);
  assert.match(kanbanPage, /window\.electronAPI\.assistant\.startRun/);
  assert.match(kanbanPage, /const \{ t \} = useI18n\(\)/);
  assert.match(kanbanPage, /t\("kanban\.prompt\.rule"\)/);
  assert.match(kanbanPage, /window\.electronAPI\.assistant\.onAssistantEvent/);
  assert.match(kanbanPage, /window\.electronAPI\.assistant\.onNavigationAgentsChanged/);
  assert.match(kanbanPage, /window\.electronAPI\.assistant\.listAgents\(\)/);
  assert.match(appShell, /<RouteSuspense><KanbanPage hostTheme=\{resolvedTheme\} \/><\/RouteSuspense>/);
  assert.doesNotMatch(appShell, /<KanbanPage onOpenAssistantChat=/);
  assert.match(appShell, /const isKanbanRoute = location\.pathname === "\/kanban"/);
  assert.match(appShell, /isKanbanRoute \? "has-kanban-controls" : ""/);
  assert.match(kanbanPage, /type KanbanPageProps/);
  assert.match(kanbanPage, /hostTheme:\s*ThemeMode/);
  assert.match(kanbanPage, /import \{ PluginPage \} from "\.\.\/plugin\/PluginPage"/);
  assert.match(kanbanPage, /const \[chatModalRequest,\s*setChatModalRequest\]/);
  assert.match(kanbanPage, /function buildKanbanChatEmbedPath/);
  assert.match(kanbanPage, /chatId\?:\s*string/);
  assert.match(kanbanPage, /const agentKey = request\.agentKey\.trim\(\)/);
  assert.match(kanbanPage, /const chatId = request\.chatId\?\.trim\(\) \?\? ""/);
  assert.match(kanbanPage, /if \(!agentKey\) \{[\s\S]{0,160}return "\/copilot"/);
  assert.match(kanbanPage, /if \(!chatId\) \{[\s\S]{0,100}return `\/agent\/\$\{encodeURIComponent\(agentKey\)\}`/);
  assert.match(kanbanPage, /params\.set\("chatId", chatId\)/);
  assert.match(kanbanPage, /return `\/agent\/\$\{encodeURIComponent\(agentKey\)\}\?\$\{params\.toString\(\)\}`/);
  assert.match(kanbanPage, /function issueHasPendingAwaiting/);
  assert.match(kanbanPage, /const matchingChat = getAssistantNavAgentRecentChats\(agent\)\.find\(\(chat\) => chat\.chatId === chatId\)/);
  assert.match(kanbanPage, /return matchingChat\?\.hasPendingAwaiting === true/);
  assert.doesNotMatch(kanbanPage, /agent\.latestChatId === chatId && agent\.hasPendingAwaiting/);
  assert.doesNotMatch(kanbanPage, /kanban-human-loop-hint/);
  assert.match(kanbanPage, /is-awaiting-confirmation/);
  assert.match(kanbanPage, /const openAssistantIssueChat = useCallback\(async \(issue: KanbanIssue\) => \{/);
  assert.match(kanbanPage, /setChatModalRequest\(\{[\s\S]{0,180}agentKey[\s\S]{0,180}chatId/);
  assert.match(kanbanPage, /<PluginPage[\s\S]{0,260}pluginId="agent-webclient"[\s\S]{0,260}embedPath=\{buildKanbanChatEmbedPath\(chatModalRequest\)\}/);
  assert.match(kanbanPage, /kanban-chat-modal-layer/);
  assert.match(kanbanPage, /kanban-chat-modal/);
  assert.doesNotMatch(kanbanPage, /void openAssistantIssueChat\(updateResult\.issue/);
  assert.doesNotMatch(kanbanPage, /kanban-chat-action/);
  assert.doesNotMatch(kanbanPage, /setAgentPickerIssue/);
  assert.doesNotMatch(kanbanPage, /requestAssignIssueToAssistant/);
  assert.match(kanbanPage, /<DragOverlay[\s\S]*?dropAnimation=\{null\}/);
  assert.match(kanbanPage, /kanbanApi\.updateIssue\(issue\.id,[\s\S]*?status:\s*"in_progress"/);
  assert.match(kanbanPage, /function openInProgressAssignmentModal\(issue: KanbanIssue\)/);
  assert.match(kanbanPage, /setForm\(\{[\s\S]{0,160}\.\.\.createFormFromIssue\(issue\),[\s\S]{0,120}status:\s*"in_progress"/);
  assert.match(kanbanPage, /targetStatus === "in_progress" && activeIssue\.status !== "in_progress"/);
  assert.match(kanbanPage, /activeIssue\.assigneeAgentKey\?\.trim\(\)[\s\S]{0,180}assignIssueToAssistant\(activeIssue, activeIssue\.assigneeAgentKey\)/);
  assert.match(kanbanPage, /openInProgressAssignmentModal\(activeIssue\)/);
  assert.match(kanbanPage, /targetStatus === "todo" && activeIssue\.status !== "todo"[\s\S]{0,220}activeIssue\.assigneeAgentKey\?\.trim\(\)/);
  assert.match(kanbanPage, /window\.setTimeout\(\(\) => \{[\s\S]{0,180}assignIssueToAssistant\(savedIssue, todoAssigneeAgentKey\)/);
  assert.match(kanbanPage, /form\.status === "in_progress" && !form\.automationEnabled && !modal\?\.issue\?\.runId/);
  assert.match(kanbanPage, /shouldRunAfterSave && !form\.assigneeAgentKey/);
  assert.match(kanbanPage, /t\("kanban\.feedback\.assigneeRequiredForProgress"\)/);
  assert.match(kanbanPage, /function mergeKanbanIssueAttachmentDraft/);
  assert.match(kanbanPage, /mergeKanbanIssueAttachmentDraft\(\s*result\.issue[\s\S]{0,160}form\.attachmentChatId[\s\S]{0,160}form\.attachments/);
  assert.match(kanbanPage, /mergeKanbanIssuesAttachmentDraft\(\s*result\.issues[\s\S]{0,160}savedIssue/);
  assert.match(kanbanPage, /assignIssueToAssistant\(savedIssue, form\.assigneeAgentKey\)/);
  assert.match(kanbanPage, /const \[formCompact,\s*setFormCompact\] = useState\(true\)/);
  assert.match(kanbanPage, /setFormCompact\(true\)/);
  assert.match(kanbanPage, /function buildCompactIssueTitle/);
  assert.match(kanbanPage, /formCompact && modal\?\.mode === "create"/);
  assert.match(kanbanPage, /t\("kanban\.feedback\.descriptionRequired"\)/);
  assert.match(kanbanPage, /formCompact \? t\("kanban\.modal\.advancedMode"\) : t\("kanban\.modal\.compactMode"\)/);
  assert.match(kanbanPage, /!formCompact \? \(/);
  assert.match(kanbanPage, /automationEnabled/);
  assert.match(kanbanPage, /KANBAN_AUTOMATION_PLANS/);
  assert.match(kanbanPage, /KANBAN_AUTOMATION_TIME_OPTIONS/);
  assert.match(kanbanPage, /automationTime/);
  assert.match(kanbanPage, /function hasIssueAutomation\(issue: Pick<KanbanIssue, "automationEnabled" \| "automationCron">\)/);
  assert.match(kanbanPage, /const openEditModal = useCallback\(\(issue: KanbanIssue\) => \{[\s\S]{0,260}setFormCompact\(canEditKanbanIssueBody\(issue\) \? !hasIssueAutomation\(issue\) : false\);/);
  assert.match(kanbanPage, /function buildAutomationCron/);
  assert.match(kanbanPage, /const \[automationMenuOpen,\s*setAutomationMenuOpen\] = useState<AutomationMenuKind \| null>\(null\)/);
  assert.match(kanbanPage, /selectedAutomationTimeRef\.current\?\.scrollIntoView/);
  assert.match(kanbanPage, /className="kanban-automation-menu-trigger"/);
  assert.match(kanbanPage, /kanban-automation-menu-list is-time-list/);
  assert.doesNotMatch(kanbanPage, /className="kanban-automation-time-select"/);
  assert.match(kanbanPage, /minute < 60; minute \+= 15/);
  assert.match(kanbanPage, /labelKey: "kanban\.automation\.daily"/);
  assert.match(kanbanPage, /labelKey: "kanban\.automation\.weekdays"/);
  assert.match(kanbanPage, /labelKey: "kanban\.automation\.weekly"/);
  assert.match(kanbanPage, /kanbanApi\.syncIssueAutomation/);
  assert.match(kanbanPage, /issue-card-meta-line/);
  assert.match(kanbanPage, /resolveAssistantRunStatus/);
  assert.match(kanbanPage, /status:\s*"completed"[\s\S]*?runId:\s*null/);
  assert.match(kanbanPage, /runState:\s*"failed"[\s\S]*?t\("kanban\.feedback\.agentIncomplete"\)/);
  assert.doesNotMatch(kanbanPage, /附件：\$\{/);
  assert.doesNotMatch(kanbanPage, /kanban-attachment-badge/);
  assert.doesNotMatch(kanbanPage, /<header className="kanban-breadcrumb">\s*<strong>Issues<\/strong>\s*<\/header>/);
  assert.doesNotMatch(kanbanPage, /kanban-workspace-mark/);
  assert.doesNotMatch(kanbanPage, /kanban-breadcrumb-separator/);
  assert.match(kanbanPage, /function isIssueDragLocked\(issue: KanbanIssue \| null \| undefined\)/);
  assert.match(kanbanPage, /return Boolean\(issue\?\.runId\);/);
  assert.match(kanbanPage, /useSortable\(\{\s*id:\s*issue\.id,[\s\S]*?disabled:\s*dragLocked/);
  assert.match(kanbanPage, /is-drag-locked/);
  assert.match(kanbanPage, /data-drag-locked=\{dragLocked \? "true" : undefined\}/);
  assert.match(kanbanPage, /\{\.\.\.sortable\.attributes\}\s*aria-disabled=\{undefined\}/);
  assert.doesNotMatch(kanbanPage, /aria-disabled=\{dragLocked\}/);
  assert.match(kanbanPage, /function getVisibleAssigneeName\(issue: KanbanIssue, agents: AssistantNavAgentItem\[\]\)/);
  assert.match(kanbanPage, /function formatKanbanPersonLabel\(/);
  assert.match(kanbanPage, /const peopleLine = getIssueCardPeoplePresentation\(issue, agents, t\)/);
  assert.match(kanbanPage, /function getAssigneeAgent\(issue: KanbanIssue, agents: AssistantNavAgentItem\[\]\)/);
  assert.match(kanbanPage, /function mergeKanbanAgentIcons\(currentAgents: AssistantNavAgentItem\[\], nextAgents: AssistantNavAgentItem\[\]\)/);
  assert.match(kanbanPage, /function createNavigationAgentFromOption\(agent: DesktopPetAgentOption\): AssistantNavAgentItem[\s\S]{0,260}icon: agent\.icon/);
  assert.match(kanbanPage, /async function hydrateKanbanAgentIcons\(items: AssistantNavAgentItem\[\]\)/);
  assert.match(kanbanPage, /function hasKanbanAgentIcon\(icon: AssistantNavAgentItem\["icon"\] \| null \| undefined\)/);
  assert.match(kanbanPage, /icon\.name\?\.trim\(\) \|\| icon\.color\?\.trim\(\)/);
  assert.match(kanbanPage, /items\.some\(\(agent\) => !hasKanbanAgentIcon\(agent\.icon\)\)/);
  assert.match(kanbanPage, /const fallbackItems = agentOptions\.map\(createNavigationAgentFromOption\)/);
  assert.match(kanbanPage, /return mergeKanbanAgentIcons\(fallbackItems, items\)/);
  assert.match(kanbanPage, /const navigationItems = normalizeAssistantNavAgents\(navigationResult\.items\)/);
  assert.match(kanbanPage, /return await hydrateKanbanAgentIcons\(navigationItems\)/);
  assert.match(kanbanPage, /const previousIcons = new Map/);
  assert.match(kanbanPage, /previousIcon \? \{ \.\.\.agent, icon: previousIcon \} : agent/);
  assert.match(kanbanPage, /setAgents\(\(currentAgents\) => mergeKanbanAgentIcons\(currentAgents, normalizeAssistantNavAgents\(result\.items\)\)\)/);
  assert.match(kanbanPage, /setAgents\(\(currentAgents\) => mergeKanbanAgentIcons\(currentAgents, items\)\)/);
  assert.match(kanbanPage, /function getAssigneeAgent\(issue: KanbanIssue, agents: AssistantNavAgentItem\[\]\)/);
  assert.doesNotMatch(kanbanPage, /function KanbanAssigneeIcon/);
  assert.match(kanbanPage, /issue-card-assignee-avatar/);
  assert.match(kanbanPage, /getPersonInitials\(peopleLine\.assigneeLabel\)/);
  assert.doesNotMatch(kanbanPage, /getIssueCardAssigneeAvatarLabel/);
  assert.doesNotMatch(kanbanPage, /issue-card-assignee-icon-frame/);
  assert.doesNotMatch(kanbanPage, /<span className="issue-card-assignee-icon" aria-hidden="true" \/>/);
  assert.doesNotMatch(kanbanStyles, /\.issue-card-assignee-icon-frame\s*\{/);
  assert.doesNotMatch(kanbanStyles, /\.issue-card-assignee-icon\s*\{/);
  assert.match(kanbanStyles, /\.issue-card-assignee-avatar\s*\{/);
  assert.doesNotMatch(kanbanStyles, /\.issue-card-assignee-avatar-label\s*\{/);
  assert.doesNotMatch(globalStyles, /#fde047 0%, #facc15 48%, #d69e13/);
  assert.doesNotMatch(kanbanPage, /issue\.assigneeName\.slice\(0, 1\)/);
  assert.doesNotMatch(kanbanPage, /kanban-run-badge/);
  assert.match(kanbanPage, /<footer className="issue-card-foot">/);
  assert.doesNotMatch(kanbanPage, /className="kanban-column-summary"/);
  assert.doesNotMatch(kanbanPage, /className="kanban-empty-illustration"/);
  assert.match(kanbanPage, /className="issue-card-action"/);
  assert.doesNotMatch(kanbanPage, />\s*\{busy \? "提交中" : "交给智能体"\}\s*<\/button>/);
  assert.doesNotMatch(kanbanPage, /busy \? "提交中" : issue\.runId \? "运行中" : "交给智能体"/);
  assert.doesNotMatch(kanbanPage, /aria-label=\{`\$\{meta\.label\} 更多`\}/);
  assert.match(globalStyles, /\.kanban-page\s*\{[\s\S]*?padding:\s*4px;[\s\S]*?\}/);
  assert.match(globalStyles, /\.kanban-toolbar\s*\{[\s\S]{0,180}min-height:\s*50px;[\s\S]{0,180}padding:\s*12px 28px 7px;/);
  assert.match(globalStyles, /\.kanban-tool\s*\{[\s\S]{0,180}min-width:\s*32px;[\s\S]{0,180}height:\s*32px;/);
  assert.match(globalStyles, /\.kanban-search\s*\{[\s\S]{0,180}height:\s*32px;/);
  assert.doesNotMatch(globalStyles, /\.kanban-tool\s*\{[\s\S]{0,180}height:\s*36px;/);
  assert.doesNotMatch(globalStyles, /\.kanban-search\s*\{[\s\S]{0,180}height:\s*36px;/);
  assert.match(globalStyles, /\.kanban-toolbar,[\s\S]{0,120}\.kanban-toolbar input\s*\{[\s\S]{0,220}-webkit-app-region:\s*no-drag;/);
  assert.match(globalStyles, /\.kanban-toolbar,[\s\S]{0,120}\.kanban-toolbar input\s*\{[\s\S]{0,260}pointer-events:\s*auto;/);
  assert.match(globalStyles, /--kanban-column-gap:\s*0px;/);
  assert.match(globalStyles, /--kanban-column-min-width:\s*220px;/);
  assert.doesNotMatch(globalStyles, /--kanban-column-fit-width/);
  assert.match(globalStyles, /--kanban-column-width:\s*max\(\s*calc\(100% \/ 5\),\s*var\(--kanban-column-min-width\)\s*\);/);
  assert.match(globalStyles, /\.kanban-columns\s*\{[\s\S]{0,220}overflow-x:\s*auto;/);
  assert.match(globalStyles, /\.kanban-column\s*\{/);
  assert.match(globalStyles, /\.kanban-column\s*\{[\s\S]{0,260}border:\s*0;[\s\S]{0,260}border-radius:\s*0;[\s\S]{0,260}box-shadow:\s*none;/);
  assert.match(globalStyles, /\.kanban-column \+ \.kanban-column\s*\{[\s\S]{0,120}border-left:\s*1px solid var\(--kanban-column-border\);/);
  assert.doesNotMatch(globalStyles, /\.kanban-column\.is-todo\s*\{[^}]*margin-left:/);
  assert.doesNotMatch(globalStyles, /\.kanban-column\.is-in_progress\s*\{[^}]*margin-left:/);
  assert.doesNotMatch(globalStyles, /\.kanban-column\.is-in_review\s*\{[^}]*margin-left:/);
  assert.doesNotMatch(globalStyles, /\.kanban-column\.is-completed\s*\{[^}]*margin-left:/);
  assert.doesNotMatch(kanbanPage, /backlogExpanded/);
  assert.match(kanbanPage, /className="kanban-columns"/);
  assert.doesNotMatch(kanbanPage, /onSelectColumn/);
  assert.doesNotMatch(globalStyles, /--kanban-columns-total-width/);
  assert.doesNotMatch(globalStyles, /--kanban-column-fold-offset/);
  assert.doesNotMatch(globalStyles, /is-backlog-expanded/);
  assert.match(kanbanStyles, /--issue-card-border:\s*rgba\(15, 23, 42, 0\.1\);/);
  assert.match(kanbanStyles, /\.issue-card\s*\{/);
  assert.match(kanbanStyles, /\.issue-card\s*\{[\s\S]{0,180}position:\s*relative;/);
  assert.match(kanbanStyles, /\.issue-card\s*\{[\s\S]{0,360}min-height:\s*96px;[\s\S]{0,360}height:\s*auto;/);
  assert.match(kanbanStyles, /\.issue-card\s*\{[\s\S]{0,360}border:\s*1px solid var\(--issue-card-border\);/);
  assert.doesNotMatch(kanbanStyles, /\.issue-card\.is-(?:backlog|todo|in_progress|in_review|completed):not\(\.is-awaiting-confirmation\)/);
  assert.match(kanbanStyles, /\.issue-card:hover\s*\{[\s\S]{0,220}transform:\s*scale\(1\.005\);/);
  assert.match(kanbanStyles, /\.issue-card-title-block\s*\{[\s\S]{0,260}-webkit-line-clamp:\s*2;/);
  assert.match(kanbanStyles, /\.issue-card-title-block\s*\{[\s\S]{0,320}font-weight:\s*400;/);
  assert.match(kanbanStyles, /\.issue-card\s*\{[\s\S]{0,360}border-radius:\s*12px;/);
  assert.match(kanbanStyles, /\.issue-card\s*\{[\s\S]{0,360}padding:\s*12px;/);
  assert.match(kanbanStyles, /\.issue-card-foot\s*\{[\s\S]{0,220}border-top:\s*1px solid var\(--kanban-border\);/);
  assert.doesNotMatch(kanbanStyles, /\.issue-card\.has-agent::before\s*\{/);
  assert.doesNotMatch(kanbanStyles, /\.kanban-column-summary\s*\{/);
  assert.doesNotMatch(kanbanStyles, /\.kanban-empty-illustration\s*\{/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.kanban-page\s*\{[\s\S]{0,260}--kanban-bg:\s*#111418;[\s\S]{0,260}background:/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.kanban-column\.is-backlog\s*\{[\s\S]{0,180}--kanban-column-tint:\s*#121c2d;/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.kanban-empty-column\s*\{[\s\S]{0,220}background:\s*color-mix\(in srgb, var\(--kanban-accent\) 8%, transparent\);/);
  assert.doesNotMatch(globalStyles, /:root\[data-theme="dark"\] \.kanban-column-summary/);
  assert.match(globalStyles, /\.issue-card\.is-drag-locked\s*\{/);
  assert.match(globalStyles, /\.issue-card\.is-drag-locked \.issue-card-main\s*\{[\s\S]{0,120}padding-right:/);
  assert.match(globalStyles, /\.issue-card\.is-awaiting-confirmation\s*\{/);
  assert.match(globalStyles, /\.issue-card\.is-awaiting-confirmation\s*\{[\s\S]{0,160}background:\s*var\(--issue-card\);/);
  assert.match(globalStyles, /:root\[data-theme="dark"\] \.issue-card\.is-awaiting-confirmation\s*\{[\s\S]{0,160}background:\s*var\(--issue-card\);/);
  assert.match(globalStyles, /\.issue-card-status\s*\{[\s\S]{0,220}height:\s*auto;[\s\S]{0,220}overflow:\s*hidden;/);
  assert.match(globalStyles, /\.kanban-run-dot\s*\{[\s\S]{0,160}background:\s*currentColor;/);
  assert.match(globalStyles, /\.kanban-automation-panel\s*\{/);
  assert.match(globalStyles, /\.kanban-automation-badge\s*\{/);
  assert.match(globalStyles, /\.issue-card-actions\s*\{[\s\S]{0,320}opacity:\s*0;[\s\S]{0,120}pointer-events:\s*none;/);
  assert.match(globalStyles, /\.issue-card:hover \.issue-card-actions,[\s\S]{0,80}\.issue-card:focus-within \.issue-card-actions\s*\{[\s\S]{0,120}opacity:\s*1;/);
  assert.doesNotMatch(globalStyles, /\.kanban-chat-action/);
  assert.match(globalStyles, /\.kanban-modal-head-actions/);
  assert.match(globalStyles, /\.kanban-modal-mode-button[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(globalStyles, /\.kanban-modal\.is-compact/);
  assert.match(globalStyles, /\.kanban-automation-popover/);
  assert.match(globalStyles, /\.kanban-automation-menu-trigger/);
  assert.match(globalStyles, /\.kanban-automation-menu-list\s*\{[\s\S]*?top:\s*calc\(100% \+ 4px\);[\s\S]*?max-height:\s*164px;/);
  assert.match(globalStyles, /\.kanban-automation-menu-list\.is-time-list\s*\{[\s\S]*?max-height:\s*184px;/);
  assert.doesNotMatch(globalStyles, /\.kanban-automation-time-select/);
  assert.doesNotMatch(globalStyles, /\.app-shell\.has-kanban-controls\s+\.app-window-drag-region\s*\{[\s\S]*?display:\s*none;/);
  assert.doesNotMatch(globalStyles, /\.app-shell\.is-mac-platform\.has-kanban-controls \.kanban-page\s*\{[^}]*padding-top:\s*(?:12|18|24)px;/);
  assert.doesNotMatch(globalStyles, /\.app-shell\.is-windows-platform\.has-kanban-controls \.kanban-page\s*\{[^}]*padding-top:\s*(?:12|18|24)px;/);
  assert.doesNotMatch(globalStyles, /\.kanban-page::before\s*\{[\s\S]*?app-region:\s*drag;/);
  assert.doesNotMatch(globalStyles, /\.kanban-breadcrumb\s*\{[\s\S]*?-webkit-app-region:\s*drag;/);
  assert.match(globalStyles, /\.kanban-modal-actions \.kanban-secondary-button/);
  assert.doesNotMatch(globalStyles, /\.kanban-human-loop-hint\s*\{/);
  assert.match(globalStyles, /\.issue-card-action\s*\{/);
  assert.doesNotMatch(globalStyles, /\.kanban-agent-picker\s*\{/);
  assert.match(globalStyles, /\.kanban-chat-modal-layer\s*\{/);
  assert.match(globalStyles, /\.kanban-chat-modal\s*\{/);
  assert.match(globalStyles, /\.kanban-chat-modal \.embedded-surface-page\s*\{/);
});

test("Kanban status order places completed after in progress", () => {
  const contracts = readSourceFile("src", "shared", "contracts", "kanban.ts");
  const kanbanDb = readSourceFile("src", "main", "kanban-db.ts");

  assert.match(
    contracts,
    /KANBAN_STATUSES\s*=\s*\[[\s\S]*?"backlog",[\s\S]*?"todo",[\s\S]*?"in_progress",[\s\S]*?"in_review",[\s\S]*?"completed"[\s\S]*?\]/,
  );
  assert.match(
    kanbanDb,
    /WHEN 'in_progress' THEN 2[\s\S]*?WHEN 'in_review' THEN 3[\s\S]*?WHEN 'completed' THEN 4/,
  );
});

test("website agent association is exposed across webs desktop api layers", () => {
  const contracts = readSharedContractsSource();
  const store = fs.readFileSync(path.join(projectRoot, "src", "main", "webs", "websites", "actions.ts"), "utf8");
  const mainProcess = readMainProcessRuntimeSource();
  const mainIpcRegister = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "register.ts"), "utf8");
  const webHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "web-handlers.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const appShell = readAppShellSource();
  const appSidebar = fs.readFileSync(path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"), "utf8");
  const navigationCss = readSourceFile("src", "renderer", "styles", "navigation.css");
  const closeWebEntryStart = appShell.indexOf("async function handleCloseWebEntry(item: WebEntry)");
  const closeWebEntry = appShell.slice(
    closeWebEntryStart,
    appShell.indexOf("  function handleCopilotSelectedAgentKeyChange", closeWebEntryStart)
  );

  assert.match(contracts, /agentKey\?: string/);
  assert.match(contracts, /interface WebsiteUpdateInput/);
  assert.match(contracts, /update: \(id: string, input: WebsiteUpdateInput\) => Promise<WebsiteResult>/);
  assert.match(contracts, /add: \(input: WebsiteInput\) => Promise<WebsiteResult>/);
  assert.match(contracts, /remove: \(id: string\) => Promise<WebsiteDeleteResult>/);
  assert.match(store, /export function updateWebsiteItem/);
  assert.match(store, /delete updated\.agentKey/);
  assert.match(store, /export function addWebsiteItem/);
  assert.match(mainIpcRegister, /registerWebIpcHandlers\(ipcMain,/);
  assert.match(webHandlers, /ipcMain\.handle\("webs\.websites\.update"/);
  assert.match(preload, /update: \(id, input\) => ipcRenderer\.invoke\("webs\.websites\.update", id, input\)/);
  assert.match(preload, /add: \(input\) => ipcRenderer\.invoke\("webs\.websites\.add", input\)/);
  assert.match(preload, /remove: \(id(?:: string)?\) => ipcRenderer\.invoke\("webs\.websites\.remove", id\)/);
  assert.match(appShell, /resolvedCopilotAgentKey/);
  assert.match(appShell, /function createWebsiteItem\(input: WebsiteInput\): Promise<WebsiteResult>[\s\S]*?window\.electronAPI\.webs\.websites\.add\(input\)/);
  assert.notEqual(closeWebEntryStart, -1);
  assert.match(appShell, /const webOpenEntryKeys = useMemo\(\(\) => \{/);
  assert.match(appShell, /openKeys\.add\(activeWebEntryKey\)/);
  assert.match(appShell, /mountedWebEntryKeys/);
  assert.match(appShell, /const EMPTY_WEB_SURFACE_ROUTE = "\/webs";/);
  assert.match(closeWebEntry, /requestSidebarNavigation\(EMPTY_WEB_SURFACE_ROUTE\)/);
  assert.doesNotMatch(closeWebEntry, /requestSidebarNavigation\(BUILTIN_BROWSER_ROUTE\)/);
  assert.match(appShell, /location\.pathname === EMPTY_WEB_SURFACE_ROUTE \|\|[\s\S]{0,120}location\.pathname\.startsWith\("\/webs\/"\)/);
  assert.match(appShell, /<Route path=\{EMPTY_WEB_SURFACE_ROUTE\} element=\{<EmptyWebSurfaceRoute \/>\} \/>/);
  assert.match(appShell, /location\.pathname === EMPTY_WEB_SURFACE_ROUTE[\s\S]{0,80}\? false[\s\S]{0,80}: builtinBrowserSurfaceMounted \|\| usesBuiltinBrowserSurface/);
  assert.match(closeWebEntry, /setMountedWebEntryKeys\(\(current\) =>[\s\S]*?current\.filter\(\(entryKey\) => entryKey !== item\.entryKey\)/);
  assert.match(closeWebEntry, /window\.electronAPI\.webs\.webapps\.stop\(item\.id\)/);
  assert.doesNotMatch(closeWebEntry, /webs\.websites\.remove/);
  assert.match(appShell, /onCreateWebsiteItem=\{createWebsiteItem\}/);
  assert.match(appShell, /webOpenEntryKeys=\{webOpenEntryKeys\}/);
  assert.match(appShell, /onCloseWebItem=\{handleCloseWebEntry\}/);
  assert.match(appSidebar, /args\.groupId === "webs"/);
  assert.match(appSidebar, /className="assistant-worker-icon-button sidebar-website-manage-button"/);
  assert.match(appSidebar, /className="assistant-worker-icon-button sidebar-website-add-button"/);
  assert.match(appSidebar, /className="sidebar-website-child-actions"/);
  assert.match(appSidebar, /requestNavigate\(buildSettingsSectionPath\("websites"\)\)/);
  assert.match(appSidebar, /webOpenEntryKeys\.includes\(webItem\.entryKey\)/);
  assert.match(appSidebar, /const webIconKind = isOpen \? "website_open" : "website_closed"/);
  assert.match(appSidebar, /<SidebarActionIcon kind=\{webIconKind\} \/>/);
  assert.match(appSidebar, /<SidebarActionIcon kind="close" \/>/);
  assert.match(appSidebar, /isOpen \? "is-open" : ""/);
  assert.match(appSidebar, /t\("sidebar\.website\.manage"\)/);
  assert.match(appSidebar, /t\("sidebar\.website\.close"\)/);
  assert.doesNotMatch(appSidebar, /t\("sidebar\.website\.delete"\)/);
  assert.match(appSidebar, /function renderWebsiteDialog\(\)/);
  assert.match(appSidebar, /t\("sidebar\.website\.name"\)[\s\S]*?t\("sidebar\.website\.url"\)[\s\S]*?t\("sidebar\.website\.sideAssistant"\)/);
  assert.match(appSidebar, /onCreateWebsiteItem\(\{[\s\S]*?label: websiteLabel,[\s\S]*?url: websiteUrl,[\s\S]*?agentKey: websiteAgentKey[\s\S]*?\}\)/);
  assert.match(appSidebar, /onCloseWebItem\(item\)/);
  assert.match(appSidebar, /requestNavigate\(`\/webs\/\$\{result\.item\.entryKey\}`\)/);
  assert.match(navigationCss, /\.sidebar-website-child-row\.is-open \.sidebar-child-link \.sidebar-link-label\s*\{[\s\S]*?color:\s*var\(--ink\);/u);
  assert.match(navigationCss, /\.sidebar-website-manage-button \+ \.sidebar-website-add-button\s*\{[\s\S]*?margin-left:\s*0;/u);
});

test("webapps expose desktop api and start from webs sidebar route", () => {
  const contracts = readSharedContractsSource();
  const webContracts = readSourceFile("src", "shared", "contracts", "webs.ts");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = readMainProcessRuntimeSource();
  const startupPipeline = readSourceFile("src", "main", "lifecycle", "startup.ts");
  const startupPhases = readSourceFile("src", "main", "lifecycle", "startup-phases.ts");
  const appState = readSourceFile("src", "main", "app-state.ts");
  const shutdownRunner = readSourceFile("src", "main", "lifecycle", "shutdown.ts");
  const webHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "web-handlers.ts"), "utf8");
  const desktopActions = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-actions.ts"), "utf8");
  const desktopActionBridge = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");
  const appShell = readAppShellSource();
  const appSidebar = fs.readFileSync(path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"), "utf8");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");
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
  assert.match(webContracts, /export type WebappSourceKind = "market" \| "local" \| "plugin" \| "bundled"/);
  assert.match(webContracts, /sourceKind\?: WebappSourceKind/);
  assert.match(webContracts, /removable\?: boolean/);
  assert.match(webContracts, /export interface WebappUpdateInput/);
  assert.match(contracts, /webs:\s*\{[\s\S]*list: \(\) => Promise<WebListResult>/);
  assert.match(contracts, /webapps:\s*\{[\s\S]*list: \(\) => Promise<WebappItemsResult>/);
  assert.match(contracts, /webapps:\s*\{[\s\S]*update: \(id: string, input: WebappUpdateInput\) => Promise<WebappResult>/);
  assert.match(contracts, /webapps:\s*\{[\s\S]*remove: \(id: string\) => Promise<WebappDeleteResult>/);
  assert.match(contracts, /webapps:\s*\{[\s\S]*start: \(id: string\) => Promise<WebappCommandResult>/);
  assert.match(contracts, /webapps:\s*\{[\s\S]*stop: \(id: string\) => Promise<WebappCommandResult>/);
  assert.match(preload, /webs:\s*\{[\s\S]*list: \(\) => ipcRenderer\.invoke\("webs\.list"\)/);
  assert.match(preload, /list: \(\) => ipcRenderer\.invoke\("webs\.webapps\.list"\)/);
  assert.match(preload, /update: \(id: string, input\) => ipcRenderer\.invoke\("webs\.webapps\.update", id, input\)/);
  assert.match(preload, /remove: \(id: string\) => ipcRenderer\.invoke\("webs\.webapps\.remove", id\)/);
  assert.match(preload, /start: \(id: string\) => ipcRenderer\.invoke\("webs\.webapps\.start", id\)/);
  assert.match(preload, /stop: \(id: string\) => ipcRenderer\.invoke\("webs\.webapps\.stop", id\)/);
  assert.match(webHandlers, /ipcMain\.handle\("webs\.webapps\.list"[\s\S]*listWebappItems\(app\)/);
  assert.match(webHandlers, /ipcMain\.handle\("webs\.webapps\.update"[\s\S]*updateWebappItem\(app, id, input\)/);
  assert.match(webHandlers, /ipcMain\.handle\("webs\.webapps\.remove"[\s\S]*removeWebappItem\(app, id\)/);
  assert.match(webHandlers, /ipcMain\.handle\("webs\.webapps\.start"[\s\S]*webappRuntime\.start\(app, id\)/);
  assert.match(webHandlers, /ipcMain\.handle\("webs\.webapps\.stop"[\s\S]*webappRuntime\.stop\(app, id\)/);
  assert.match(appShell, /window\.electronAPI\.webs\.list\(\)/);
  assert.match(appShell, /item\.kind !== "webapp"/);
  assert.match(appShell, /chrome:\s*"app"/);
  assert.notEqual(webappStartEffectStart, -1);
  assert.match(appShell, /webappStartInFlightRef = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(appShell, /webappStopInFlightRef = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(webappStartEffect, /webappStartInFlightRef\.current\.has\(item\.id\)/);
  assert.match(webappStartEffect, /webappStopInFlightRef\.current\.has\(item\.id\)/);
  assert.match(webappStartEffect, /webappStartInFlightRef\.current\.add\(item\.id\)/);
  assert.match(webappStartEffect, /window\.electronAPI\.webs\.webapps\.start\(item\.id\)/);
  assert.match(appShell, /async function handleCloseWebEntry\(item: WebEntry\)[\s\S]*?window\.electronAPI\.webs\.webapps\.stop\(item\.id\)/);
  assert.match(appShell, /async function removeWebappItem\(item: WebEntry\): Promise<WebappDeleteResult>[\s\S]*?window\.electronAPI\.webs\.webapps\.remove\(item\.id\)/);
  assert.match(appShell, /onRemoveWebappItem=\{removeWebappItem\}/);
  assert.match(appSidebar, /onRemoveWebappItem\?: \(item: WebEntry\) => Promise<WebappDeleteResult>/);
  assert.match(appSidebar, /webItem\.kind === "webapp"[\s\S]*?<SidebarActionIcon kind="more_actions" \/>/);
  assert.match(appSidebar, /t\("sidebar\.webapp\.remove"\)/);
  assert.match(appSidebar, /void removeWebappItem\(item\)/);
  assert.doesNotMatch(appSidebar, /if \(!webOpenEntryKeys\.includes\(item\.entryKey\)\)[\s\S]{0,80}return;/);
  assert.match(zhCN, /"sidebar\.webapp\.remove": "卸载 WebApp"/);
  assert.match(enUS, /"sidebar\.webapp\.remove": "Uninstall WebApp"/);
  assert.match(webappStartEffect, /\.finally\(\(\) => \{[\s\S]*?webappStartInFlightRef\.current\.delete\(item\.id\)/);
  assert.doesNotMatch(webappStartEffect, /let cancelled = false/);
  assert.match(externalWebviewPage, /chrome\?: "browser" \| "app"/);
  assert.match(externalWebviewPage, /chrome = "browser"/);
  assert.match(externalWebviewPage, /const appChrome = chrome === "app"/);
  assert.match(externalWebviewPage, /\{appChrome \? null : \([\s\S]*?external-webview-browser-chrome/);
  assert.doesNotMatch(externalWebviewPage, /debugSidebarNode/);
  assert.doesNotMatch(externalWebviewPage, /bookmarkMenuNode/);
  assert.match(externalWebviewPage, /onWebviewOpenTab[\s\S]*?if \(appChrome\) \{[\s\S]*?return;[\s\S]*?\}/);
  assert.match(embeddedSurfaceHosts, /runtimeStatus/);
  assert.match(embeddedSurfaceHosts, /chrome=\{item\.chrome\}/);
  assert.match(embeddedSurfaceHosts, /t\("webapp\.starting"\)/);
  assert.match(mainProcess, /installBundledWebappTemplates\(app\)/);
  const initializeUserDataIndex = mainProcess.indexOf("function initializeUserDataRootsAndSettings()");
  const initializeUserDataEndIndex = mainProcess.indexOf("const gotSingleInstanceLock", initializeUserDataIndex);
  const initializeUserDataBlock = mainProcess.slice(initializeUserDataIndex, initializeUserDataEndIndex);
  const ensureDataRootIndex = mainProcess.indexOf("ensureDataRoot(app);", initializeUserDataIndex);
  const installDemoIndex = mainProcess.indexOf("installBundledWebappTemplates(app)", initializeUserDataIndex);
  const applyDesktopInitIndex = mainProcess.indexOf("applyDesktopInitBootstrap(app", initializeUserDataIndex);
  const initializeMainI18nIndex = mainProcess.indexOf("initializeMainI18n(app", initializeUserDataIndex);
  const prepareStartupRuntimeIndex = mainProcess.indexOf("await startupEnvironmentRuntime.prepareStartupRuntimeEnvironment()");
  const initializeUserDataCallIndex = mainProcess.indexOf("initializeUserDataRootsAndSettings();", prepareStartupRuntimeIndex);
  const createWindowCallIndex = mainProcess.indexOf("createWindow();", initializeUserDataCallIndex);
  const handleReadyIndex = indexOfRequired(mainProcess, "async function handleAppReady()");
  const handleReadyEndIndex = indexOfRequiredAfter(mainProcess, "function start()", handleReadyIndex);
  const handleReadyBlock = mainProcess.slice(handleReadyIndex, handleReadyEndIndex);
  const nonCoreStartupIndex = indexOfRequired(mainProcess, "function startNonCoreDesktopRuntime()");
  const nonCoreStartupEndIndex = indexOfRequiredAfter(mainProcess, "async function showFileDialog", nonCoreStartupIndex);
  const nonCoreStartupBlock = mainProcess.slice(nonCoreStartupIndex, nonCoreStartupEndIndex);
  const notifyCoreIndex = indexOfRequired(mainProcess, "function notifyCoreServicesChanged()");
  const notifyCoreEndIndex = indexOfRequiredAfter(mainProcess, "function notifyDesktopDecorationsChanged()", notifyCoreIndex);
  const notifyCoreBlock = mainProcess.slice(notifyCoreIndex, notifyCoreEndIndex);
  const notifyDecorationsEndIndex = indexOfRequiredAfter(mainProcess, "function emitKanbanChanged()", notifyCoreEndIndex);
  const notifyDecorationsBlock = mainProcess.slice(notifyCoreEndIndex, notifyDecorationsEndIndex);
  const phasePlatformPreflightIndex = indexOfRequired(handleReadyBlock, 'setStartupPhase("platform-preflight")');
  const phaseRuntimeEnvIndex = indexOfRequired(handleReadyBlock, 'setStartupPhase("runtime-env")');
  const phaseRuntimeEnvReadyIndex = indexOfRequired(handleReadyBlock, 'setStartupPhase("runtime-env-ready")');
  const phaseDesktopStateReadyIndex = indexOfRequired(handleReadyBlock, 'setStartupPhase("desktop-state-ready")');
  const phaseShellReadyIndex = indexOfRequired(handleReadyBlock, 'setStartupPhase("shell-ready")');
  const startupPipelineRunIndex = indexOfRequired(handleReadyBlock, "startupPipeline.run()");
  const focusedWebviewDevToolsShortcutIndex = indexOfRequired(
    handleReadyBlock,
    "registerFocusedWebviewDevToolsShortcut();"
  );
  const currentWebviewDevToolsIndex = indexOfRequired(
    mainProcess,
    "openCurrentWebviewDevTools({"
  );
  const handleReadyCreateWindowCallIndex = indexOfRequired(handleReadyBlock, "createWindow();");
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
  assert.equal(phasePlatformPreflightIndex < phaseRuntimeEnvIndex, true);
  assert.equal(phaseRuntimeEnvIndex < phaseRuntimeEnvReadyIndex, true);
  assert.equal(phaseRuntimeEnvReadyIndex < phaseDesktopStateReadyIndex, true);
  assert.equal(phaseDesktopStateReadyIndex < phaseShellReadyIndex, true);
  assert.equal(phaseShellReadyIndex < startupPipelineRunIndex, true);
  assert.equal(focusedWebviewDevToolsShortcutIndex < handleReadyCreateWindowCallIndex, true);
  assert.notEqual(currentWebviewDevToolsIndex, -1);
  assert.match(mainProcess, /currentPageSnapshot:\s*appState\.currentPageSnapshot/);
  assert.doesNotMatch(handleReadyBlock, /createAppTray\(\);/);
  assert.doesNotMatch(handleReadyBlock, /showDesktopPetWindow\(\);/);
  assert.doesNotMatch(handleReadyBlock, /startDesktopWsServerIfEnabled/);
  assert.match(startupPhases, /"platform-preflight"[\s\S]*"runtime-env"[\s\S]*"runtime-env-ready"[\s\S]*"desktop-state-ready"[\s\S]*"shell-ready"[\s\S]*"core-services-starting"[\s\S]*"core-ready"[\s\S]*"non-core-ready"[\s\S]*"degraded"/);
  assert.match(appState, /startupPhase: StartupPhase;/);
  assert.match(appState, /startupPhase: initialState\.startupPhase \?\? "booting"/);
  assert.match(nonCoreStartupBlock, /appState\.desktopPetSettings\?\.enabled === true/);
  assert.match(nonCoreStartupBlock, /createAppTray\(\)/);
  assert.match(nonCoreStartupBlock, /registerQuickAssistantShortcut\(\)/);
  assert.doesNotMatch(nonCoreStartupBlock, /registerFocusedWebviewDevToolsShortcut/);
  assert.match(nonCoreStartupBlock, /pluginBridgeRuntime\.setDesktopReady\(\)/);
  assert.match(nonCoreStartupBlock, /startDesktopWsServerIfEnabled/);
  assert.match(nonCoreStartupBlock, /startTunnelHubRuntimeIfEnabled\(\)/);
  assert.match(nonCoreStartupBlock, /setStartupPhase\("non-core-ready"\)/);
  assert.match(notifyCoreBlock, /isStartupPhaseAtLeast\(appState\.startupPhase, "shell-ready"\)/);
  assert.doesNotMatch(notifyCoreBlock, /scheduleAgentPlatformPetStatusRefresh/);
  assert.match(notifyDecorationsBlock, /appState\.startupPhase !== "non-core-ready"/);
  assert.match(notifyDecorationsBlock, /scheduleAgentPlatformPetStatusRefresh\(1000\)/);
  assert.doesNotMatch(initializeUserDataBlock, /importBundledEnvZipToRuntime/);
  assert.doesNotMatch(initializeUserDataBlock, /applyDesktopInitSsoDefaults/);
  assert.doesNotMatch(
    readSourceFile("src", "main", "app", "startup-environment.ts"),
    /notifyServicesChanged/
  );
  assert.match(mainProcess, /function getDefaultEnvImportRequiredMessage\(\) \{\s*return options\.t\("startup\.envImport\.requiredTitle"\);/);
  assert.match(mainProcess, /let startupEnvImportFailureMessage: string \| null = null;/);
  assert.match(startupPipeline, /if \(startupEnvImportFailureMessage !== null\)/);
  assert.doesNotMatch(startupPipeline, /if \(startupEnvImportFailureMessage\)/);
  assert.match(mainProcess, /message: getDefaultEnvImportRequiredMessage\(\)/);
  assert.match(shutdownRunner, /stopAllWebapps\(options\.app\)/);
  assert.match(startupPipeline, /notifyCoreServicesChanged/);
  assert.doesNotMatch(startupPipeline, /notifyServicesChanged/);
  assert.doesNotMatch(startupPipeline, /startTunnelHubRuntimeIfEnabled/);
  assert.match(startupPipeline, /if \(startupEnvImportFailureMessage !== null\)[\s\S]*?options\.setStartupPhase\("degraded"\);[\s\S]*?return;/);
  assert.doesNotMatch(
    startupPipeline.slice(
      startupPipeline.indexOf("if (startupEnvImportFailureMessage !== null)"),
      startupPipeline.indexOf('options.setStartupPhase("core-services-starting")')
    ),
    /notifyCoreServicesChanged|notifyServicesChanged/
  );
  assert.match(startupPipeline, /options\.setStartupPhase\("core-services-starting"\);[\s\S]*?options\.loadBuiltinServices\(options\.app\);[\s\S]*?options\.loadInstalledPlugins\(options\.app\);[\s\S]*?options\.notifyCoreServicesChanged\(\);/);
  assert.match(startupPipeline, /options\.setStartupPhase\("core-ready"\);\s*options\.startNonCoreRuntime\(\);/);
  assert.match(desktopActions, /"desktop\.web\.webapp\.start"/);
  assert.match(desktopActions, /"desktop\.web\.webapp\.stop"/);
  assert.match(desktopActionBridge, /case "desktop\.web\.webapp\.restart"/);
  assert.match(desktopActionBridge, /case "desktop\.web\.webapp\.stop"/);
  assert.match(desktopActionBridge, /readWebappId\(args\)/);
});

test("assistant navigation agents are exposed through dedicated ipc without changing pet agents", () => {
  const contracts = readSharedContractsSource();
  const mainProcess = readMainProcessRuntimeSource();
  const mainIpcRegister = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "register.ts"), "utf8");
  const assistantRuntime = fs.readFileSync(path.join(projectRoot, "src", "main", "bridge", "assistant-runtime.ts"), "utf8");
  const assistantHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "assistant-handlers.ts"), "utf8");
  const desktopActions = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-actions.ts"), "utf8");
  const desktopActionBridge = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(projectRoot, "src", "main", "assistant", "core", "agent-platform-bridge.ts"), "utf8");
  const assistantNavigationStatusClient = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "core", "assistant-navigation-status-client.ts"),
    "utf8"
  );
  const appShell = readAppShellSource();
  const appSidebar = fs.readFileSync(path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"), "utf8");
  const globalStyles = readRendererStyles();
  const i18nEn = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");
  const i18nZh = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");

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
  assert.match(contracts, /interface AssistantCreateProjectRequest/);
  assert.match(contracts, /type AssistantCreateProjectType = "coder" \| "kbase"/);
  assert.match(contracts, /interface AssistantCreateProjectResult/);
  assert.match(contracts, /interface AssistantCreateCoderProjectRequest/);
  assert.match(contracts, /type AssistantCreateCoderProjectResult = AssistantCreateProjectResult/);
  assert.match(contracts, /AssistantNavigationAgentsChangedListener/);
  assert.match(contracts, /listAgents: \(\) => Promise<DesktopPetAgentOption\[\]>/);
  assert.match(contracts, /listNavigationAgents: \(\) => Promise<AssistantNavAgentItemsResult>/);
  assert.match(contracts, /createProject:\s*\(input: AssistantCreateProjectRequest\) => Promise<AssistantCreateProjectResult>/);
  assert.match(contracts, /createCoderProject:\s*\(input: AssistantCreateCoderProjectRequest\) => Promise<AssistantCreateCoderProjectResult>/);
  assert.match(contracts, /markAgentChatsRead: \(agentKey: string\) => Promise<AssistantNavActionResult>/);
  assert.match(preload, /listAgents: \(\) => ipcRenderer\.invoke\("assistant\.listAgents"\)/);
  assert.match(preload, /listNavigationAgents: \(\) => ipcRenderer\.invoke\("assistant\.listNavigationAgents"\)/);
  assert.match(preload, /listCopilotAgents: \(\) => ipcRenderer\.invoke\("assistant\.listCopilotAgents"\)/);
  assert.match(preload, /createProject:\s*\(input: AssistantCreateProjectRequest\) =>[\s\S]{0,120}ipcRenderer\.invoke\("assistant\.createProject", input\)/);
  assert.match(preload, /createCoderProject:\s*\(input: AssistantCreateCoderProjectRequest\) =>[\s\S]{0,120}ipcRenderer\.invoke\("assistant\.createCoderProject", input\)/);
  assert.match(preload, /onNavigationAgentsChanged/);
  assert.match(mainIpcRegister, /registerAssistantIpcHandlers\(ipcMain,/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.listAgents"/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.listNavigationAgents"/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.listCopilotAgents"/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.createProject"/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.createCoderProject"/);
  assert.match(assistantHandlers, /callAgentPlatform\?\.?\(app, "\/api\/admin\/agents\/create"/);
  assert.match(assistantHandlers, /assistantNavigationStatusClient\?\.scheduleRefresh\(0\)/);
  assert.match(assistantRuntime, /AssistantNavigationStatusClient/);
  assert.match(mainProcess, /function emitAssistantNavigationAgentsChanged[\s\S]*?assistant\.navigationAgentsChanged/);
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
  assert.match(appSidebar, /handleCreateProject/);
  assert.match(appSidebar, /window\.electronAPI\.desktopDialog\.selectDirectory\(\)[\s\S]*?window\.electronAPI\.assistant\.createProject/);
  assert.match(appSidebar, /window\.electronAPI\.services\.list\(\)/);
  assert.match(appSidebar, /proxy-acp-claudecode[\s\S]*?acpProxyId:\s*"claude"/);
  assert.match(appSidebar, /proxy-acp-codex[\s\S]*?acpProxyId:\s*"codex"/);
  assert.match(appSidebar, /value="coder"[\s\S]*?t\("sidebar\.project\.coder"\)/);
  assert.match(appSidebar, /value="kbase"[\s\S]*?t\("sidebar\.project\.kbase"\)/);
  assert.match(i18nZh, /"sidebar\.project\.coder": "代码助手"/);
  assert.match(i18nZh, /"sidebar\.project\.kbase": "知识库"/);
  assert.doesNotMatch(i18nZh, /"sidebar\.project\.coder": "CODER"/);
  assert.doesNotMatch(i18nZh, /"sidebar\.project\.kbase": "KBASE"/);
  assert.match(i18nEn, /"sidebar\.project\.coder": "Coder"/);
  assert.match(i18nEn, /"sidebar\.project\.kbase": "Knowledge Base"/);
  assert.match(i18nZh, /"sidebar\.project\.useAcp": "使用 ACP"/);
  assert.match(i18nZh, /"sidebar\.project\.acpProxy": "ACP 代理"/);
  assert.match(i18nEn, /"sidebar\.project\.useAcp": "Use ACP"/);
  assert.match(i18nEn, /"sidebar\.project\.acpProxy": "ACP proxy"/);
  assert.doesNotMatch(appSidebar, /createProjectDialog\.name/);
  assert.doesNotMatch(appSidebar, /t\("sidebar\.project\.name"\)/);
  assert.match(appSidebar, /className="sidebar-website-dialog-readonly-input"[\s\S]*?readOnly[\s\S]*?disabled/);
  assert.match(globalStyles, /\.sidebar-website-dialog-readonly-input\s*\{/);
  assert.match(globalStyles, /\.sidebar-project-checkbox-row input\s*\{/);
  assert.match(appSidebar, /t\("sidebar\.project\.useAcp"\)/);
  assert.match(appSidebar, /createProjectDialog\.projectType === "coder" && createProjectDialog\.useAcp[\s\S]*?t\("sidebar\.project\.acpProxy"\)/);
  assert.doesNotMatch(appSidebar, /kbaseVectorStore/);
  assert.doesNotMatch(appSidebar, /sidebar\.project\.localVectorStore/);
  assert.doesNotMatch(appSidebar, /sidebar\.project\.remoteVectorStore/);
  assert.doesNotMatch(appSidebar, /sidebar\.project\.kbaseNotImplemented/);
  assert.doesNotMatch(appSidebar, /if \(dialog\.projectType === "kbase"\)/);
  assert.match(appSidebar, /projectType:\s*dialog\.projectType/);
  assert.match(appSidebar, /if \(selectedAcpProxy\) \{[\s\S]*?createInput\.acpProxyId = selectedAcpProxy\.acpProxyId/);
  assert.match(appSidebar, /window\.electronAPI\.assistant\.createProject\(createInput\)/);
  assert.doesNotMatch(assistantHandlers, /\/api\/admin\/agents\/update/);
  assert.doesNotMatch(assistantHandlers, /definition:\s*updateDefinition/);
  assert.doesNotMatch(appSidebar, /没有检测到正在运行的 ACP 工具/);
  assert.doesNotMatch(appSidebar, /使用本机 Claude Code 运行 CODER 助理/);
  assert.doesNotMatch(appSidebar, /使用本机 Codex CLI 运行 CODER 助理/);
  assert.match(appSidebar, /className="assistant-worker-icon-button sidebar-assistant-project-button"/);
  assert.match(appSidebar, /function getOpenWorkspaceDisabledReason\(agent: AssistantNavAgentItem\)/);
  assert.match(appSidebar, /agent\.workspaceDirExists === false/);
  assert.match(appSidebar, /disabled=\{Boolean\(openWorkspaceDisabledReason\)\}/);
  assert.match(appSidebar, /openWorkspaceDirectory\(agent\.workspaceDir, agent\.agentKey\)/);
  assert.doesNotMatch(appSidebar, /const title = isRename \? t\("sidebar\.agent\.rename"\) : t\("sidebar\.agent\.delete"\)/);
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
  assert.match(appSidebar, /function createAgentEditRoute\(agent: AssistantNavAgentItem\)/);
  assert.match(appSidebar, /return `\/agents\/\$\{encodeURIComponent\(agent\.agentKey\)\}`;/);
  assert.match(appSidebar, /requestNavigate\(createAgentEditRoute\(agent\)\)/);
  assert.doesNotMatch(appSidebar, /window\.open\(createAgentEditWindowUrl\(agent\), "_blank"\)/);
  assert.match(appSidebar, /agent\.agentType === "coder"/);
  assert.doesNotMatch(appSidebar, /desktop\.agents\./);
  assert.doesNotMatch(appSidebar, /buildAgentDefinitionForRename/);
  assert.doesNotMatch(appSidebar, /sidebar\.agent\.delete/);
  assert.doesNotMatch(appSidebar, /sidebar\.agent\.rename/);
  assert.doesNotMatch(desktopActions, /desktop\.agents\./);
  assert.doesNotMatch(desktopActionBridge, /case "desktop\.agents\./);
  assert.doesNotMatch(appShell, /setInterval\([\s\S]*?listNavigationAgents/);
});

test("desktop global search contract is wired across main preload renderer and help", () => {
  const contracts = readSharedContractsSource();
  const preload = readSourceFile("src", "preload", "index.ts");
  const assistantHandlers = readSourceFile("src", "main", "ipc", "assistant-handlers.ts");
  const bridge = readSourceFile("src", "main", "assistant", "core", "agent-platform-bridge.ts");
  const platformAdapter = readSourceFile("src", "main", "platform-adapter.ts");
  const windowManager = readSourceFile("src", "main", "window-manager.ts");
  const appRuntime = readSourceFile("src", "main", "app", "runtime.ts");
  const appShellRuntime = readSourceFile("src", "main", "app-shell", "runtime.ts");
  const appShell = readSourceFile("src", "renderer", "app-shell", "AppShell.tsx");
  const overlay = readSourceFile("src", "renderer", "app-shell", "search", "DesktopGlobalSearchOverlay.tsx");
  const rows = readSourceFile("src", "renderer", "app-shell", "search", "globalSearchRows.ts");
  const i18nEn = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");
  const i18nZh = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const helpEn = readSourceFile("help-content", "en-US", "shortcuts", "global-shortcuts.md");
  const helpZh = readSourceFile("help-content", "zh-CN", "shortcuts", "global-shortcuts.md");

  assert.match(contracts, /interface AssistantChatSearchRequest/);
  assert.match(contracts, /interface AssistantChatSearchResponse/);
  assert.match(contracts, /searchChats: \(request: AssistantChatSearchRequest\) => Promise<AssistantChatSearchResponse>/);
  assert.match(contracts, /onOpenGlobalSearch: \(listener: \(\) => void\) => \(\) => void/);
  assert.match(preload, /searchChats: \(request: AssistantChatSearchRequest\) => ipcRenderer\.invoke\("assistant\.searchChats", request\)/);
  assert.match(preload, /ipcRenderer\.on\("app\.openGlobalSearch"/);
  assert.match(assistantHandlers, /ipcMain\.handle\("assistant\.searchChats"/);
  assert.match(bridge, /async searchChats\(request: AssistantChatSearchRequest\): Promise<AssistantChatSearchResponse>/);
  assert.match(bridge, /"\/api\/chats\/search"/);
  assert.match(platformAdapter, /export function isGlobalSearchShortcut/);
  assert.match(platformAdapter, /platform === "darwin"[\s\S]*?input\.meta/);
  assert.match(platformAdapter, /platform === "win32"[\s\S]*?input\.control/);
  assert.match(windowManager, /app\.openGlobalSearch/);
  assert.match(appRuntime, /isGlobalSearchShortcut/);
  assert.match(appShellRuntime, /isGlobalSearchShortcut/);
  assert.match(appShell, /onOpenGlobalSearch/);
  assert.match(appShell, /<DesktopGlobalSearchOverlay/);
  assert.match(overlay, /searchChats\(\{ query: trimmedQuery, limit: 30 \}\)/);
  assert.match(overlay, /params\.set\("newChat", "1"\)/);
  assert.match(overlay, /params\.set\("newChatRequest", String\(Date\.now\(\)\)\)/);
  assert.match(overlay, /row\.kind !== "action" \?/);
  assert.match(overlay, /renderChatStatus/);
  assert.match(overlay, /desktop\.globalSearch\.status\.unread/);
  assert.match(rows, /DesktopGlobalSearchSectionId = "awaiting" \| "unread" \| "actions" \| "agents" \| "chats"/);
  assert.match(rows, /mergeQueryChatRows/);
  assert.match(rows, /if \(!chatId \|\| !agentKey\) \{/);
  assert.match(rows, /snippet: result\.snippet \|\| localRow\?\.snippet/);
  assert.match(rows, /getQueryChatPriority/);
  assert.match(rows, /row\.hasPendingAwaiting/);
  assert.match(rows, /row\.isUnread/);
  assert.match(i18nEn, /"desktop\.globalSearch\.group\.awaiting": "Awaiting"/);
  assert.match(i18nEn, /"desktop\.globalSearch\.group\.unread": "Unread chats"/);
  assert.match(i18nZh, /"desktop\.globalSearch\.group\.awaiting": "等待中"/);
  assert.match(i18nZh, /"desktop\.globalSearch\.group\.unread": "未读聊天"/);
  assert.match(helpEn, /Cmd` \+ `K` \/ `Ctrl` \+ `K`/);
  assert.match(helpZh, /Cmd` \+ `K` \/ `Ctrl` \+ `K`/);
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

test("main process automation callers use current platform automation routes", () => {
  const sourceFiles = [
    path.join(projectRoot, "src", "main", "plugin-resources.ts"),
    path.join(projectRoot, "src", "main", "kanban-sync.ts"),
    path.join(projectRoot, "src", "main", "kanban-runtime.ts")
  ];
  const combined = sourceFiles.map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");

  assert.doesNotMatch(combined, /\/api\/admin\/automations\//);
  assert.match(combined, /\/api\/automation\/create/);
  assert.match(combined, /\/api\/automation\/update/);
  assert.match(combined, /\/api\/automation\/delete/);
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

test("bootstrap startup completion opens configured bootstrap agent", () => {
  const appShell = readAppShellSource();
  const appSidebar = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );
  const startupGate = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "startup",
    "StartupGate.tsx"
  );
  const startupGateHelper = readSourceFile("src", "shared", "startup-gate.ts");
  const globalStyles = readRendererStyles();
  const zhDictionary = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enDictionary = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");
  const bootstrapAutoOpenGuardIndex = appShell.indexOf(
    "startupBootstrapNavigationDoneRef.current ||\n      !shouldAutoOpenBootstrapAgent(startupRestoreState, startupAllReady, location.pathname)"
  );
  assert.notEqual(bootstrapAutoOpenGuardIndex, -1);
  const bootstrapAutoOpenBlockStart = appShell.lastIndexOf("useEffect(() => {", bootstrapAutoOpenGuardIndex);
  const bootstrapAutoOpenBlockEnd = appShell.indexOf("  useEffect(() => {\n    if (startupRestoreState?.mode", bootstrapAutoOpenGuardIndex);
  assert.notEqual(bootstrapAutoOpenBlockStart, -1);
  assert.notEqual(bootstrapAutoOpenBlockEnd, -1);
  const bootstrapAutoOpenBlock = appShell.slice(bootstrapAutoOpenBlockStart, bootstrapAutoOpenBlockEnd);
  const bootstrapSettingsCatchBlock = bootstrapAutoOpenBlock.match(/catch \{(?<body>[\s\S]*?)\n        \}/)?.groups?.body ?? "";
  const bootstrapEmptyKeyBlock = bootstrapAutoOpenBlock.match(/if \(!bootstrapAgentKey\) \{(?<body>[\s\S]*?)\n      \}\n      navigate/)?.groups?.body ?? "";

  assert.match(startupGate, /function StartupRoutePlaceholder\(\) \{[\s\S]*?className="startup-route-placeholder"[\s\S]*?aria-hidden="true"/);
  assert.doesNotMatch(startupGate, /StartupRoutePlaceholderProps|showPetGreeting|StartupPetGreeting/);
  assert.doesNotMatch(startupGate, /desktop-pet|DEFAULT_DESKTOP_PET|STARTUP_PET|PRODUCT_NAME|placeholderPetGreeting/);
  assert.doesNotMatch(startupGate, /from "\.\.\/\.\.\/copilot\/pet-copilot\/DesktopPet"|<DesktopPet\b/);
  assert.doesNotMatch(startupGate, /useEffect|setInterval|window\.electronAPI\.desktopPet|onStateChanged/);
  assert.doesNotMatch(globalStyles, /has-pet-greeting|startup-pet-greeting|startup-route-pet-walk|can-mirror|--startup-pet|desktop-pet-state-frames var\(--startup-pet/);
  assert.doesNotMatch(startupGate, /<Navigate\b/);
  assert.doesNotMatch(startupGate, /resolveStartupRootPath/);
  assert.doesNotMatch(appShell, /showStartupPetGreeting/);
  assert.match(appShell, /path="\/"[\s\S]*?element=\{<StartupRoutePlaceholder \/>\}/);
  assert.doesNotMatch(appShell, /shouldAutoOpenAssistant/);
  assert.doesNotMatch(appShell, /shouldRedirectStartupFailureToControlCenter/);
  assert.doesNotMatch(appShell, /startupNavigationDoneRef/);
  assert.doesNotMatch(appShell, /createStartupAgentRoute/);
  assert.match(startupGateHelper, /function shouldAutoOpenBootstrapAgent\(/);
  assert.match(startupGateHelper, /_startupAllReady: boolean/);
  assert.match(startupGateHelper, /startupRestoreState\?\.mode === "bootstrap"[\s\S]*?startupRestoreState\.phase === "succeeded"[\s\S]*?isBootstrapOwnedRoute\(currentPathname\)/);
  assert.doesNotMatch(startupGateHelper.match(/function shouldAutoOpenBootstrapAgent\([\s\S]*?\n\}/)?.[0] ?? "", /startupAllReady &&/);
  assert.match(startupGateHelper, /currentPathname === "\/"/);
  assert.match(appShell, /const \[bootstrapNavigationRetryTick, setBootstrapNavigationRetryTick\] = useState\(0\)/);
  assert.match(appShell, /const BOOTSTRAP_NAVIGATION_RETRY_MS = 1500;/);
  assert.match(bootstrapAutoOpenBlock, /startupBootstrapNavigationDoneRef\.current/);
  assert.match(bootstrapAutoOpenBlock, /let retryTimer: number \| null = null;/);
  assert.match(bootstrapAutoOpenBlock, /const scheduleBootstrapNavigationRetry = \(\) => \{/);
  assert.match(bootstrapAutoOpenBlock, /window\.setTimeout\(\(\) => \{[\s\S]*?setBootstrapNavigationRetryTick\(\(tick\) => tick \+ 1\)/);
  assert.match(bootstrapAutoOpenBlock, /window\.electronAPI\.assistant\.getSettings\(\)/);
  assert.match(bootstrapAutoOpenBlock, /nextAssistantSettings\.bootstrapAgentKey\.trim\(\)/);
  assert.match(bootstrapAutoOpenBlock, /navigate\(createBootstrapAgentRoute\(bootstrapAgentKey\), \{ replace: true \}\)/);
  assert.match(bootstrapAutoOpenBlock, /navigate\(createBootstrapAgentRoute\(bootstrapAgentKey\), \{ replace: true \}\);[\s\S]*?startupBootstrapNavigationDoneRef\.current = true;/);
  assert.match(bootstrapSettingsCatchBlock, /scheduleBootstrapNavigationRetry\(\);/);
  assert.doesNotMatch(bootstrapSettingsCatchBlock, /startupBootstrapNavigationDoneRef\.current = true/);
  assert.match(bootstrapEmptyKeyBlock, /scheduleBootstrapNavigationRetry\(\);/);
  assert.doesNotMatch(bootstrapEmptyKeyBlock, /startupBootstrapNavigationDoneRef\.current = true/);
  assert.match(appShell, /startupRestoreState\?\.mode !== "bootstrap"[\s\S]*?startupBootstrapNavigationDoneRef\.current = false;[\s\S]*?setBootstrapNavigationRetryTick\(0\)/);
  assert.match(appShell, /startupRestoreState\.phase === "idle"[\s\S]*?startupRestoreState\.phase === "running"[\s\S]*?startupBootstrapNavigationDoneRef\.current = false;[\s\S]*?setBootstrapNavigationRetryTick\(0\)/);
  assert.doesNotMatch(bootstrapAutoOpenBlock, /listNavigationAgents/);
  assert.doesNotMatch(bootstrapAutoOpenBlock, /getKanbanAwareFallbackPath/);
  assert.doesNotMatch(bootstrapAutoOpenBlock, /navigate\("\/control-center"/);
  assert.match(appShell, /function createBootstrapAgentRoute\(agentKey: string\)[\s\S]*?encodeURIComponent\(agentKey\)/);
  assert.match(appShell, /const normalizedBootstrapAgentKey = assistantSettings\?\.bootstrapAgentKey\.trim\(\) \?\? "";/);
  assert.match(appShell, /const bootstrapGuideAgentVisible = Boolean\([\s\S]*?normalizedBootstrapAgentKey[\s\S]*?!assistantNavAgentsLoaded \|\|[\s\S]*?assistantNavAgents\.some\(\(agent\) => agent\.agentKey === normalizedBootstrapAgentKey\)[\s\S]*?\);/);
  assert.match(appShell, /const bootstrapGuideActive =[\s\S]*?startupRestoreState\?\.mode === "bootstrap"[\s\S]*?startupRestoreState\.phase === "succeeded"[\s\S]*?bootstrapGuideAgentVisible/);
  assert.match(appShell, /bootstrapGuideActive=\{bootstrapGuideActive\}/);
  assert.match(appShell, /bootstrapAgentKey=\{normalizedBootstrapAgentKey\}/);
  assert.match(appSidebar, /const \[bootstrapGuideCardDismissed, setBootstrapGuideCardDismissed\] = useState\(false\)/);
  assert.match(appSidebar, /setBootstrapGuideCardDismissed\(false\)/);
  assert.match(appSidebar, /function renderBootstrapGuideCard\(\)/);
  assert.match(appSidebar, /sidebar-bootstrap-guide-card/);
  assert.match(appSidebar, /sidebar\.bootstrapGuide\.title/);
  assert.match(appSidebar, /sidebar\.bootstrapGuide\.stepAgent/);
  assert.match(appSidebar, /sidebar\.bootstrapGuide\.stepProfile/);
  assert.match(appSidebar, /sidebar\.bootstrapGuide\.stepHelp/);
  assert.match(appSidebar, /sidebar\.bootstrapGuide\.actionAgent/);
  assert.match(appSidebar, /sidebar\.bootstrapGuide\.actionHelp/);
  assert.match(appSidebar, /sidebar\.bootstrapGuide\.dismiss/);
  assert.doesNotMatch(appSidebar, /BOOTSTRAP_GUIDE_CARD_STORAGE|bootstrapGuideCardDismissed[^;]*localStorage|localStorage[^;]*bootstrapGuideCardDismissed/);
  [
    "sidebar.bootstrapGuide.title",
    "sidebar.bootstrapGuide.stepAgent",
    "sidebar.bootstrapGuide.stepProfile",
    "sidebar.bootstrapGuide.stepHelp",
    "sidebar.bootstrapGuide.actionAgent",
    "sidebar.bootstrapGuide.actionHelp",
    "sidebar.bootstrapGuide.dismiss"
  ].forEach((key) => {
    assert.match(zhDictionary, new RegExp(`${escapeRegExp(JSON.stringify(key))}:`));
    assert.match(enDictionary, new RegExp(`${escapeRegExp(JSON.stringify(key))}:`));
  });
  assert.doesNotMatch(startupGateHelper, /shouldAutoOpenAssistant/);
  assert.doesNotMatch(startupGateHelper, /shouldRedirectStartupFailureToControlCenter/);
  assert.doesNotMatch(startupGateHelper, /resolveStartupRootPath/);
  assert.match(appShell, /onOpenControlCenter=\{\(\) => \{[\s\S]*?navigate\("\/control-center", \{/);
});

test("desktop action bridge exposes localhost api and renderer action providers", () => {
  const actionCatalog = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-actions.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");
  const bridgeSettings = fs.readFileSync(
    path.join(projectRoot, "src", "main", "desktop-action-bridge-settings.ts"),
    "utf8"
  );
  const mainProcess = readMainProcessRuntimeSource();
  const assistantRuntime = fs.readFileSync(path.join(projectRoot, "src", "main", "bridge", "assistant-runtime.ts"), "utf8");
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
    readSourceFile("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx"),
    readSourceFile("src", "renderer", "pages", "functional-market", "marketPageApi.ts")
  ].join("\n");
  const petActionBlock = bridge.match(/async function executePetAction[\s\S]*?\n}\n\nasync function executeAction/)?.[0] ?? "";

  assert.match(actionCatalog, /DESKTOP_ACTION_BRIDGE_HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(actionCatalog, /DESKTOP_ACTION_BRIDGE_PORT\s*=\s*11788/);
  assert.match(bridgeSettings, /DESKTOP_ACTION_BRIDGE_SETTINGS_FILE\s*=\s*"desktop-action-bridge\.json"/);
  assert.match(bridgeSettings, /getConfiguredDesktopActionBridgePort/);
  assert.match(bridge, /getConfiguredDesktopActionBridgePort\(options\.app\)/);
  assert.match(bridge, /server\.listen\(bridgePort, DESKTOP_ACTION_BRIDGE_HOST/);
  assert.doesNotMatch(bridge, /server\.listen\(DESKTOP_ACTION_BRIDGE_PORT/);
  assert.match(actionCatalog, /page_control/);
  assert.match(actionCatalog, /desktop\.controlCenter\.listServices/);
  assert.match(actionCatalog, /desktop\.setting\.applyPatch/);
  assert.doesNotMatch(actionCatalog, /desktop\.settings\./);
  assert.doesNotMatch(actionCatalog, /desktop\.page\./);
  assert.match(actionCatalog, /desktop\.web\.listSurfaces/);
  assert.match(actionCatalog, /desktop\.web\.navigate/);
  assert.match(actionCatalog, /desktop\.web\.interactElement/);
  assert.match(actionCatalog, /desktop\.web\.webapps\.installAndOpen/);
  assert.match(actionCatalog, /desktop\.pet\.state/);
  assert.match(actionCatalog, /desktop\.pet\.list/);
  assert.match(actionCatalog, /desktop\.pet\.set/);
  assert.doesNotMatch(actionCatalog, /desktop\.pet\.getState/);
  assert.doesNotMatch(actionCatalog, /desktop\.pet\.getSettings/);
  assert.doesNotMatch(actionCatalog, /desktop\.pet\.setEnabled/);
  assert.doesNotMatch(actionCatalog, /desktop\.pet\.listAppearances/);
  assert.doesNotMatch(actionCatalog, /desktop\.pet\.setAppearance/);
  assert.match(actionCatalog, /desktop\.kanban\.listIssues/);
  assert.match(actionCatalog, /desktop\.kanban\.moveIssue/);
  assert.match(actionCatalog, /desktop\.help\.openTopic/);
  assert.doesNotMatch(actionCatalog, /desktop\.embeddedWeb\./);
  assert.doesNotMatch(actionCatalog, /desktop\.webs\./);
  assert.doesNotMatch(actionCatalog, /desktop\.tunnelHub\./);
  assert.doesNotMatch(actionCatalog, /desktop\.staticServer\./);
  assert.doesNotMatch(actionCatalog, /desktop\.agents\./);
  assert.doesNotMatch(actionCatalog, /desktop\.automations\./);
  assert.doesNotMatch(actionCatalog, /desktop\.help\.(?:getCurrentTopic|searchTopics|explainCurrentPage|suggestNextAction|navigateToRelatedPage)/);
  assert.match(actionCatalog, /desktop\.market\.applySettingsPatch/);
  assert.doesNotMatch(actionCatalog, /desktop\.memory\./);
  assert.match(bridge, /GET" && url\.pathname === "\/health"/);
  assert.match(bridge, /GET" && url\.pathname === "\/actions"/);
  assert.match(bridge, /POST" && url\.pathname === "\/actions\/call"/);
  assert.match(bridge, /POST" && url\.pathname === "\/cdp\/call"/);
  assert.match(bridge, /function resolveHelpOpenRoute/);
  assert.match(petActionBlock, /desktop\.pet\.state/);
  assert.match(petActionBlock, /desktop\.pet\.list/);
  assert.match(petActionBlock, /desktop\.pet\.set/);
  assert.doesNotMatch(petActionBlock, /desktop\.pet\.getState/);
  assert.doesNotMatch(petActionBlock, /desktop\.pet\.getSettings/);
  assert.doesNotMatch(petActionBlock, /desktop\.pet\.setEnabled/);
  assert.doesNotMatch(petActionBlock, /desktop\.pet\.listAppearances/);
  assert.doesNotMatch(petActionBlock, /desktop\.pet\.setAppearance/);
  assert.doesNotMatch(petActionBlock, /listMarketItems|refreshMarketCatalog|installMarketItem|desktop\.market/);
  assert.match(bridge, /case "desktop\.kanban\.moveIssue"/);
  assert.match(bridge, /kanban_unavailable/);
  assert.doesNotMatch(bridge, /case "desktop\.tunnelHub\./);
  assert.doesNotMatch(bridge, /case "desktop\.staticServer\./);
  assert.doesNotMatch(bridge, /case "desktop\.agents\./);
  assert.doesNotMatch(bridge, /case "desktop\.automations\./);
  assert.doesNotMatch(bridge, /case "desktop\.help\.(?:getCurrentTopic|searchTopics|explainCurrentPage|suggestNextAction|navigateToRelatedPage)/);
  assert.match(bridge, /Content-Type must be application\/json/);
  assert.match(bridge, /isLocalhostRequest/);
  assert.match(bridge, /confirmMutatingAction/);
  assert.match(bridge, /buildDesktopActionConfirmationDetail/);
  assert.match(bridge, /buildMutatingActionConfirmationRequest/);
  assert.match(bridge, /buildPageControlActionConfirmationRequest/);
  assert.match(bridge, /confirmRendererAction/);
  assert.match(bridge, /summarizeConfirmationArgs/);
  assert.match(bridge, /confirmDetailRedacted/);
  assert.match(bridge, /confirmationSummary"\)/);
  assert.match(bridge, /readDesktopProfileFromRoot\(getDesktopConfigRoot\(options\.app\)\)\.general\.desktopActionConfirmationEnabled/);
  assert.match(bridge, /PageControlGrantStore/);
  assert.match(bridge, /t\("desktopAction\.pageControlGrant"\)/);
  const directCdpHandler = bridge.match(/export async function handleDesktopCdpRequest[\s\S]*?function isLocalhostRequest/)?.[0] ?? "";
  assert.doesNotMatch(directCdpHandler, /confirmDesktopActionIfNeeded|confirmMutatingAction|desktopActionConfirmationEnabled/);
  assert.doesNotMatch(bridge, /小宅助理/);
  assert.match(assistantRuntime, /startDesktopActionBridge\(\{/);
  assert.match(assistantRuntime, /refreshDesktopActionBridge/);
  assert.match(assistantRuntime, /callDesktopActionConfirmation/);
  assert.match(assistantHandlers, /desktopActions\.respond/);
  assert.match(assistantHandlers, /desktopActions\.respondConfirmation/);
  assert.match(assistantHandlers, /desktopActions\.call/);
  assert.match(preload, /desktopActions:\s*\{/);
  assert.match(preload, /respondConfirmation:\s*\(response: DesktopActionConfirmationResponse\)/);
  assert.match(preload, /ipcRenderer\.on\("desktopActions\.confirm"/);
  assert.match(preload, /getDesktopWsServerState: \(\) => ipcRenderer\.invoke\("settings\.getDesktopWsServerState"\)/);
  assert.match(preload, /setDesktopWsServerEnabled: \(enabled\) => ipcRenderer\.invoke\("settings\.setDesktopWsServerEnabled", enabled\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktopActions\.respond"/);
  assert.match(preload, /ipcRenderer\.on\("desktopActions\.call"/);
  assert.match(contracts, /export interface DesktopWsServerState/);
  assert.match(contracts, /getDesktopWsServerState: \(\) => Promise<DesktopWsServerState>/);
  assert.match(contracts, /setDesktopWsServerEnabled: \(enabled: boolean\) => Promise<DesktopWsServerState>/);
  assert.match(contracts, /DesktopActionRendererRequest/);
  assert.match(contracts, /DesktopActionCallListener/);
  assert.match(contracts, /DesktopActionConfirmationRequest/);
  assert.match(contracts, /DesktopActionConfirmationResponse/);
  assert.match(contracts, /DesktopActionConfirmationListener/);
  assert.match(registry, /DesktopActionProviderScope = "global" \| "page" \| "web"/);
  assert.match(registry, /registerDesktopActionProviderForScope/);
  assert.match(registry, /web_action_unavailable/);
  assert.match(registry, /registerDesktopActionProvider/);
  assert.match(registry, /page_action_unavailable/);
  assert.match(appShell, /startDesktopActionRendererBridge\(\)/);
  assert.match(appShell, /DesktopActionConfirmationDialog/);
  assert.match(appShell, /desktopActions\.onConfirm/);
  assert.match(appShell, /desktopActions\.respondConfirmation/);
  assert.match(appShell, /registerDesktopActionProviderForScope\("global"/);
  assert.match(appShell, /desktop\.setting\.getState/);
  assert.match(appShell, /settingSectionIds = \[/);
  assert.match(appShell, /"quick"/);
  assert.match(appShell, /"copilot"/);
  assert.match(appShell, /"pet"/);
  assert.match(appShell, /"general\.desktopActionConfirmationEnabled"/);
  assert.match(appShell, /"kanban\.remoteControlEnabled"/);
  assert.match(appShell, /"market\.apiBaseUrl"/);
  assert.match(appShell, /quickAssistantEnabled: quickPatch\.enabled/);
  assert.match(appShell, /quickAssistantAgentKey: quickPatch\.agentKey\.trim\(\) \|\| DEFAULT_QUICK_ASSISTANT_AGENT_KEY/);
  assert.match(appShell, /desktop\.web\.listSurfaces/);
  assert.match(settingsPage, /registerDesktopActionProvider/);
  assert.match(settingsPage, /desktopHelperAgentKey/);
  assert.match(externalWebviewPage, /registerDesktopActionProviderForScope\("web"/);
  assert.match(externalWebviewPage, /desktop\.web\.getPageContext/);
  assert.match(externalWebviewPage, /desktop\.web\.navigate/);
  assert.match(externalWebviewPage, /desktop\.web\.closeTab/);
  assert.doesNotMatch(externalWebviewPage, /querySelector\(request/);
  assert.match(marketPage, /registerDesktopActionProvider/);
  assert.match(marketPage, /getMarketMethod\("importSkill"\)/);
  assert.match(marketPage, /getMarketMethod\("importSandboxImage"\)/);
});

test("desktop action confirmation detail keeps debug context and redaction keys", () => {
  const bridge = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");
  const zhCN = fs.readFileSync(path.join(projectRoot, "src", "shared", "i18n", "dictionaries", "zhCN.ts"), "utf8");
  const enUS = fs.readFileSync(path.join(projectRoot, "src", "shared", "i18n", "dictionaries", "enUS.ts"), "utf8");

  assert.match(bridge, /function buildDesktopActionConfirmationDetail/);
  assert.match(bridge, /function buildMutatingActionConfirmationRequest/);
  assert.match(bridge, /function buildPageControlActionConfirmationRequest/);
  assert.match(bridge, /function summarizeConfirmationArgs/);
  assert.match(bridge, /function sanitizeConfirmationUrl/);
  assert.match(bridge, /entryKey\) => entryKey !== "confirmationSummary"/);
  assert.match(bridge, /confirmMutatingAction\(\s*options,\s*request,\s*args,\s*snapshot/);
  assert.match(bridge, /confirmPageControlAction\(\s*options,\s*scope,\s*request,\s*args/);
  assert.match(bridge, /buildDesktopActionConfirmationDetail\(request, args/);
  assert.match(bridge, /buildNativeConfirmationDetail/);
  assert.match(bridge, /desktopAction\.confirmDetailRedacted/);
  assert.match(bridge, /desktopAction\.confirmDetailMore/);
  assert.match(bridge, /__testInternals[\s\S]*buildDesktopActionConfirmationDetail/);
  assert.match(bridge, /__testInternals[\s\S]*buildMutatingActionConfirmationRequest/);

  for (const dictionary of [zhCN, enUS]) {
    assert.match(dictionary, /desktopAction\.confirmFieldAction/);
    assert.match(dictionary, /desktopAction\.confirmFieldTarget/);
    assert.match(dictionary, /desktopAction\.confirmFieldPermission/);
    assert.match(dictionary, /desktopAction\.confirmFieldArgs/);
    assert.match(dictionary, /desktopAction\.confirmShowDetails/);
    assert.match(dictionary, /desktopAction\.confirmHideDetails/);
    assert.match(dictionary, /desktopAction\.confirmDetailIntro/);
    assert.match(dictionary, /desktopAction\.confirmDetailAction/);
    assert.match(dictionary, /desktopAction\.confirmDetailRequest/);
    assert.match(dictionary, /desktopAction\.confirmDetailSource/);
    assert.match(dictionary, /desktopAction\.confirmDetailTarget/);
    assert.match(dictionary, /desktopAction\.confirmDetailArgs/);
    assert.match(dictionary, /desktopAction\.confirmDetailArgsEmpty/);
    assert.match(dictionary, /desktopAction\.confirmDetailRedacted/);
    assert.match(dictionary, /desktopAction\.confirmDetailMore/);
    assert.match(dictionary, /desktopAction\.confirmDetailFooter/);
    assert.match(dictionary, /desktopAction\.pageControlCompactDescription/);
  }
});

test("built index uses relative asset paths", (t) => {
  const generatedBrandPath = newestGeneratedBrandPath();
  if (!generatedBrandPath) {
    t.skip("brand output is not generated");
    return;
  }
  const brand = JSON.parse(fs.readFileSync(generatedBrandPath, "utf8"));
  const builtIndexPath = path.join(projectRoot, "build", "brands", brand.id, "renderer", "index.html");
  if (!fs.existsSync(builtIndexPath)) {
    t.skip("brand renderer output is not built");
    return;
  }
  const builtIndex = fs.readFileSync(builtIndexPath, "utf8");
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
    readSourceFile("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx"),
    readSourceFile("src", "renderer", "pages", "functional-market", "marketPageApi.ts")
  ].join("\n");
  const marketStyles = [
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    readSourceFile("src", "renderer", "pages", "functional-market", "StorefrontMarket.css")
  ].join("\n");

  assert.match(marketPage, /function getMarketApi\(/);
  assert.match(marketPage, /function getPluginApi\(/);
  assert.match(marketPage, /t\("market\.error\.marketApiUnavailable"/);
  assert.match(marketPage, /t\("market\.error\.pluginApiUnavailable"/);
  assert.match(marketPage, /getMarketMethod\("importSkill"\)/);
  assert.match(marketPage, /getPluginMethod\("install"\)/);
  assert.match(marketPage, /getMarketMethod\("importSandboxImage"\)/);
  assert.match(marketPage, /function marketMessageForTab/);
  assert.match(marketPage, /function marketOfflineForTab/);
  assert.match(marketPage, /marketOfflineForTab\(marketResult,\s*activeTab\)/);
  assert.match(marketPage, /console\.warn\("\[market-storefront\] failed to load market data"/);
  assert.doesNotMatch(marketPage, /window\.electronAPI\.market\.importSkill\(\)/);
  assert.doesNotMatch(marketPage, /installPlugin\(\)/);
  assert.doesNotMatch(marketPage, /market-feedback/);
  assert.doesNotMatch(marketStyles, /\.market-feedback/);
  assert.match(marketStyles, /\.market-store-toolbar-button/);
  assert.match(marketStyles, /\.market-status/);
});

test("functional market renderer text is routed through i18n", () => {
  const marketFiles = [
    "MarketPageFrame.tsx",
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
  assert.match(storefrontStyles, /--market-card-min:\s*320px;/);
  assert.match(storefrontStyles, /\.market-store-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*var\(--market-card-min\)\),\s*1fr\)\);/);
  assert.doesNotMatch(storefrontStyles, /620px/);
  assert.match(storefrontStyles, /\.market-store-card\.ant-card\s*\{[\s\S]*?border-radius:\s*8px;/);
  assert.match(storefrontStyles, /\.market-store-card-head\s*\{[\s\S]*?grid-template-columns:\s*30px minmax\(0,\s*1fr\);/);
  assert.match(storefrontStyles, /\.market-store-item-icon\s*\{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;[\s\S]*?background:\s*var\(--glyph-bg/);
  assert.match(storefrontStyles, /\.market-store-item-icon svg\s*\{[\s\S]*?width:\s*15px;[\s\S]*?height:\s*15px;/);
  assert.doesNotMatch(storefrontStyles, /--glyph-grad/);
  assert.doesNotMatch(storefrontStyles, /\.market-store-item-icon::after/);
  assert.doesNotMatch(storefrontStyles, /market-store-platform-chip/);
  assert.match(storefrontStyles, /\.market-store-title-line\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(storefrontStyles, /\.market-store-description\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.match(storefrontStyles, /\.market-store-card-footer\s*\{[\s\S]*?border-top:\s*1px solid var\(--market-store-line\);/);
  assert.match(storefrontStyles, /\.market-store-toolbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(280px,\s*520px\)\s*auto;/);
  assert.match(storefrontStyles, /\.market-store-toolbar-actions\s*\{[\s\S]*?justify-content:\s*flex-end;/);
  assert.match(storefrontStyles, /\.market-store-toolbar-button\.ant-btn\s*\{[\s\S]*?border-radius:\s*8px;/);
  assert.match(storefrontStyles, /\.market-store-action\.is-primary\.ant-btn\s*\{[\s\S]*?background:\s*var\(--market-store-accent\);/);
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
  assert.match(zhCN, /"controlCenter\.service\.authentication\.name":\s*"认证服务"/);
  assert.match(zhCN, /"startup\.service\.authentication":\s*"认证服务"/);
  assert.match(zhCN, /"startup\.service\.agentWebclient":\s*"智能体客户端"/);
  assert.match(zhCN, /"service\.agentWebclientDisplayName":\s*"智能体客户端"/);
  assert.match(zhCN, /"service\.display\.identityCenter":\s*"认证服务"/);
  assert.match(zhCN, /"service\.display\.agentWebclient":\s*"智能体客户端"/);
  assert.doesNotMatch(zhCN, /"market\.tab\.sandboxImages\.meta"/);
  assert.match(serviceDisplay, /serviceId === "identity-center"[\s\S]*?t\("service\.display\.identityCenter"\)/);
});

test("storefront market keeps sandbox image tab wired to local image import", () => {
  const storefront = readSourceFile("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");
  const storefrontStyles = readSourceFile("src", "renderer", "pages", "functional-market", "StorefrontMarket.css");
  const marketModel = readSourceFile("src", "renderer", "pages", "functional-market", "marketPageModel.ts");
  const marketFrame = readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.tsx");
  const marketStyles = readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css");
  const marketDisplay = readSourceFile("src", "renderer", "pages", "functional-market", "marketDisplay.tsx");

  assert.match(marketModel, /market\.tab\.sandboxImages\.subtitle/);
  assert.match(marketModel, /sandboxImages:\s*"sandbox-image"/);
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
  assert.match(storefront, /case "sandbox-image":\s*return t\("market\.type\.sandboxImage"\)/);
  assert.match(storefront, /case "sandbox-image":\s*return <ApiOutlined \/>/);
  assert.match(storefront, /activeTab === "sandboxImages"[\s\S]*?t\("market\.sandbox\.import"\)/);
  assert.match(storefront, /getMarketMethod\("importSandboxImage"\)/);
  assert.match(storefront, /className=\{`market-store-card is-\$\{item\.type\}`\}/);
  assert.match(storefront, /className=\{`market-store-item-icon is-\$\{item\.type\}`\}/);
  assert.match(storefront, /market-store-toolbar-button is-primary/);
  assert.doesNotMatch(storefront, /getMarketMethod\("buildSandboxImage"\)/);
  assert.doesNotMatch(storefront, /onBuildSandboxImage/);
  assert.match(marketDisplay, /market-sandbox-image-symbol/);
  assert.match(storefrontStyles, /\.market-store-card\.is-sandbox-image/);
  assert.match(storefrontStyles, /\.market-store-item-icon\.is-sandbox-image/);
  assert.match(storefrontStyles, /:root\[data-theme="dark"\]\s+\.market-store-item-icon\.is-sandbox-image/);
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
    /\.market-tabs \.market-tab-label\s*\{[\s\S]*?min-height:\s*30px/
  );
  assert.match(
    marketStyles,
    /\.market-tab-icon\s*\{[\s\S]*?font-size:\s*13px;/
  );
  assert.match(
    marketStyles,
    /\.market-tab-text\s*\{[\s\S]*?text-overflow:\s*ellipsis;/
  );
  assert.doesNotMatch(marketStyles, /\.market-tab-meta/);
  assert.match(
    marketStyles,
    /:root\[data-theme="dark"\]\s+\.market-tabs\s*\{[\s\S]*?background:\s*#121821;[\s\S]*?box-shadow:\s*inset 0 1px 0 rgba\(255,\s*255,\s*255,\s*0\.035\)/
  );
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

test("market route keeps the unified native drag overlay", () => {
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();
  const marketStyles = readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css");

  assert.match(appShell, /has-market-controls/);
  assert.match(appShell, /className="app-window-drag-layer"[\s\S]*className="app-window-drag-region"/);
  assert.doesNotMatch(globalStyles, /\.app-shell\.has-market-controls\s+\.app-window-drag-region\s*\{[\s\S]*?display:\s*none;/);
  assert.match(globalStyles, /\.app-shell\s*\{[^}]*--app-window-drag-height:\s*12px;/);
  assert.match(globalStyles, /\.app-window-drag-region\s*\{[^}]*flex:\s*0 0 var\(--app-window-drag-height,\s*12px\);/);
  assert.match(marketStyles, /-webkit-app-region:\s*no-drag;/);
});

test("embedded H5 routes keep a thin global window drag lane", () => {
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();
  const pluginPage = readSourceFile("src", "renderer", "pages", "plugin", "PluginPage.tsx");
  const pluginSettingsPage = readSourceFile("src", "renderer", "pages", "plugin", "PluginSettingsPage.tsx");
  const externalWebviewPage = readSourceFile("src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx");
  const obsoleteEmbeddedSurfaceClassPattern = /\b(?:pan-page(?:-embedded|-agent-webclient)?|pan-frame(?:-shell)?|pan-session-box)\b/;
  const externalBrowserChromeRule = globalStyles.match(
    /(?:^|\n)\.external-webview-browser-chrome\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body ?? "";

  assert.match(appShell, /usesEmbeddedSurface/);
  assert.match(appShell, /has-embedded-surface/);
  assert.match(appShell, /usesPluginSurface/);
  assert.match(appShell, /has-plugin-surface/);
  assert.match(appShell, /location\.pathname\.startsWith\("\/plugin-settings\/"\)/);
  assert.doesNotMatch(appShell, /shouldRenderAppMainDragRegion/);
  assert.doesNotMatch(appShell, /app-main-drag-region/);
  assert.match(
    globalStyles,
    /\.embedded-surface-page\.embedded-surface-page-embedded\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*height:\s*100%;[^}]*margin:\s*0;[^}]*overflow:\s*hidden;/
  );
  assert.match(globalStyles, /\.app-shell\.has-embedded-surface\s*\{[^}]*--app-window-drag-height:\s*8px;/);
  assert.doesNotMatch(globalStyles, /--mac-embedded-titlebar-height:/);
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.is-mac-platform\.has-plugin-surface \.embedded-surface-page\.embedded-surface-page-embedded\s*\{[^}]*padding-top:/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.is-mac-platform\.has-plugin-surface \.embedded-surface-page\.embedded-surface-page-embedded::before\s*\{/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.has-embedded-surface\s+\.app-window-drag-region\s*\{[^}]*display:\s*none;/
  );
  assert.match(globalStyles, /\.app-window-drag-layer\s*\{[^}]*z-index:\s*1000;/);
  assert.doesNotMatch(pluginPage, /className="pan-drag-region"/);
  assert.doesNotMatch(pluginSettingsPage, /className="pan-drag-region"/);
  assert.doesNotMatch(externalWebviewPage, /className="pan-drag-region"/);
  assert.doesNotMatch(pluginPage, obsoleteEmbeddedSurfaceClassPattern);
  assert.doesNotMatch(pluginSettingsPage, obsoleteEmbeddedSurfaceClassPattern);
  assert.doesNotMatch(externalWebviewPage, obsoleteEmbeddedSurfaceClassPattern);
  assert.doesNotMatch(globalStyles, obsoleteEmbeddedSurfaceClassPattern);
  assert.doesNotMatch(globalStyles, /\.pan-drag-region\s*\{/);
  assert.doesNotMatch(globalStyles, /\.pan-drag-region:active\s*\{/);
  assert.doesNotMatch(
    globalStyles,
    /\.embedded-surface-page-embedded\s+\.pan-drag-region/
  );
  assert.ok(externalBrowserChromeRule, "missing .external-webview-browser-chrome rule");
  assert.match(externalBrowserChromeRule, /app-region:\s*drag;/);
  assert.match(externalBrowserChromeRule, /-webkit-app-region:\s*drag;/);
  assert.match(
    globalStyles,
    /\.external-webview-page\.is-app-surface\s*\{[^}]*margin:\s*-28px -24px -28px;[^}]*background:\s*transparent;[^}]*overflow:\s*hidden;/
  );
  assert.match(
    globalStyles,
    /\.external-webview-page\.is-app-surface\s+\.external-webview-frame-shell,\s*\.external-webview-page\.is-app-surface\s+\.external-webview-panel,\s*\.external-webview-page\.is-app-surface\s+\.external-webview-frame\s*\{[^}]*background:\s*transparent;/
  );
  assert.doesNotMatch(globalStyles, /\.app-main-drag-region\s*\{/);
  assert.doesNotMatch(globalStyles, /\.sidebar-chrome-drag-region\s*\{/);
  assert.doesNotMatch(
    globalStyles,
    /\.embedded-surface-page-embedded\s+\.embedded-surface-frame-shell\s*\{[^}]*(?:padding-top|margin-top|top):\s*(?:8|12|18|24)px;/
  );
  assert.match(
    globalStyles,
    /\.embedded-surface-page\.embedded-surface-page-embedded\s+\.embedded-surface-frame-shell,\s*\.embedded-surface-page\.embedded-surface-page-embedded\s+\.embedded-surface-frame\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.external-webview-frame-shell\s*\{[^}]*(?:padding-top|margin-top|top):\s*(?:8|12|18|24)px;/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.embedded-surface-page-agent-webclient/
  );
  assert.doesNotMatch(pluginPage, /embedded-surface-page-agent-webclient/);
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
  const mainProcess = readMainProcessRuntimeSource();
  const shellHandlers = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "shell-handlers.ts"), "utf8");
  const contracts = readSharedContractsSource();
  const appShellRule = globalStyles.match(/(?:^|\n)\.app-shell\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body ?? "";
  const sidebarShellRule = globalStyles.match(/(?:^|\n)\.app-sidebar-shell\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body ?? "";
  const dragLayerRule = globalStyles.match(/(?:^|\n)\.app-window-drag-layer\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body ?? "";
  const dragRegionRule = globalStyles.match(/(?:^|\n)\.app-window-drag-region\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body ?? "";

  assert.match(appShell, /<div className="app-window-drag-layer" aria-hidden="true">\s*<div className="app-window-drag-region" \/>/);
  assert.ok(appShellRule, "missing .app-shell rule");
  assert.ok(sidebarShellRule, "missing .app-sidebar-shell rule");
  assert.match(appShellRule, /--app-window-drag-height:\s*12px;/);
  assert.match(appShellRule, /--app-window-drag-left:\s*var\(--app-sidebar-width,\s*160px\);/);
  assert.match(appShellRule, /--app-window-drag-right:\s*0px;/);
  assert.ok(dragLayerRule, "missing .app-window-drag-layer rule");
  assert.match(dragLayerRule, /position:\s*absolute;/);
  assert.match(dragLayerRule, /inset:\s*0;/);
  assert.match(dragLayerRule, /z-index:\s*1000;/);
  assert.match(dragLayerRule, /display:\s*flex;/);
  assert.match(dragLayerRule, /flex-direction:\s*column;/);
  assert.match(dragLayerRule, /pointer-events:\s*none;/);
  assert.ok(dragRegionRule, "missing .app-window-drag-region rule");
  assert.match(dragRegionRule, /flex:\s*0 0 var\(--app-window-drag-height,\s*12px\);/);
  assert.match(dragRegionRule, /height:\s*var\(--app-window-drag-height,\s*12px\);/);
  assert.match(dragRegionRule, /margin-left:\s*var\(--app-window-drag-left,\s*var\(--app-sidebar-width,\s*160px\)\);/);
  assert.match(dragRegionRule, /margin-right:\s*var\(--app-window-drag-right,\s*0px\);/);
  assert.match(dragRegionRule, /app-region:\s*drag;/);
  assert.match(dragRegionRule, /-webkit-app-region:\s*drag;/);
  assert.match(dragRegionRule, /pointer-events:\s*auto;/);
  assert.match(dragRegionRule, /cursor:\s*grab;/);
  assert.doesNotMatch(dragRegionRule, /(?:^|\n)\s*(?:left|right):/);
  assert.match(sidebarShellRule, /app-region:\s*drag;/);
  assert.match(sidebarShellRule, /-webkit-app-region:\s*drag;/);
  assert.match(sidebarShellRule, /cursor:\s*grab;/);
  assert.match(globalStyles, /\.app-shell\.is-mac-overlay-sidebar\s*\{[^}]*--app-window-drag-left:\s*220px;/);
  assert.match(globalStyles, /\.app-shell\.is-mac-overlay-sidebar\.has-right-corner-toggle\s*\{[^}]*--app-window-drag-left:\s*0px;[^}]*--app-window-drag-right:\s*72px;/);
  assert.doesNotMatch(globalStyles, /\.app-shell\.is-mac-overlay-sidebar\s+\.app-window-drag-region\s*\{/);
  assert.match(globalStyles, /\.app-window-drag-region:active\s*\{[^}]*cursor:\s*grabbing;/);
  assert.doesNotMatch(globalStyles, /\.sidebar-chrome-drag-region/);
  const appMainRule = globalStyles.match(/(?:^|\n)\.app-main\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body ?? "";
  assert.match(appMainRule, /padding:\s*28px 24px 28px;/);
  assert.match(appMainRule, /-webkit-user-select:\s*text;/);
  assert.match(appMainRule, /user-select:\s*text;/);
  assert.match(appMainRule, /app-region:\s*no-drag;/);
  assert.match(appMainRule, /-webkit-app-region:\s*no-drag;/);
  assert.doesNotMatch(globalStyles, /\.app-main-drag-region/);
  assert.doesNotMatch(globalStyles, /\.app-header\s*\{[^}]*app-region:\s*drag;/);
  assert.doesNotMatch(globalStyles, /\.app-header\s*\{[^}]*-webkit-app-region:\s*drag;/);
  assert.doesNotMatch(globalStyles, /\.app-sidebar-drag-region/);
  assert.match(globalStyles, /\.app-sidebar a,\s*[\s\S]*?\.app-sidebar \[role="menuitem"\]\s*\{[\s\S]*?app-region:\s*no-drag;[\s\S]*?-webkit-app-region:\s*no-drag;/);
  assert.doesNotMatch(sidebarSource, /sidebar-chrome-drag-region/);
  assert.doesNotMatch(appShell, /app-sidebar-drag-region/);
  assert.doesNotMatch(appShell, /app-main-drag-region/);
  assert.doesNotMatch(appShell, /SIDEBAR_WINDOW_DRAG_START_THRESHOLD_PX/);
  assert.doesNotMatch(appShell, /handleSidebarWindowPointerDownCapture/);
  assert.doesNotMatch(appShell, /onPointerDownCapture=\{handleSidebarWindowPointerDownCapture\}/);
  assert.match(appShell, /onPointerDownCapture=\{handleWindowDragPointerDownCapture\}/);
  assert.match(appShell, /target\?\.closest\("\.app-window-drag-region"\)/);
  assert.match(appShell, /target\?\.closest\("\.app-sidebar-shell"\)/);
  assert.match(appShell, /target\?\.closest\("\.external-webview-browser-chrome"\)/);
  assert.match(appShell, /browserChrome\.closest\("\.external-webview-page\.is-inactive-surface"\)/);
  assert.match(appShell, /SIDEBAR_DRAG_BLOCK_SELECTOR/);
  assert.doesNotMatch(appShell, /target\?\.closest\("\.app-window-drag-region, \.pan-drag-region"\)/);
  assert.match(appShell, /event\.button !== 0/);
  assert.match(appShell, /desktopShell\.beginWindowDrag\(\{ x: event\.screenX, y: event\.screenY \}\)/);
  assert.match(appShell, /desktopShell\.endWindowDrag\(\)/);
  assert.match(appShell, /window\.addEventListener\("pointerup", finishDrag, true\)/);
  assert.match(appShell, /window\.addEventListener\("pointercancel", finishDrag, true\)/);
  assert.match(appShell, /window\.addEventListener\("blur", finishDrag, true\)/);
  assert.match(appShell, /dragTarget\.setPointerCapture\(pointerId\)/);
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
  const mainProcess = readMainProcessRuntimeSource();
  const appState = readSourceFile("src", "main", "app-state.ts");
  const windowManager = readSourceFile("src", "main", "window-manager.ts");
  const appRuntime = readSourceFile("src", "main", "app", "runtime.ts");
  const appShellRuntime = readSourceFile("src", "main", "app-shell", "runtime.ts");
  const appShell = readAppShellSource();
  const contracts = readSharedContractsSource();
  const preload = readSourceFile("src", "preload", "index.ts");
  const globalStyles = readRendererStyles();
  const macFullscreenRule = globalStyles.match(
    /^\.app-shell\.is-mac-platform\.is-window-fullscreen\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body ?? "";

  assert.match(appState, /mainWindowSidebarTranslucencyEnabled:\s*initialState\.mainWindowSidebarTranslucencyEnabled \?\? true/);
  assert.match(mainProcess, /isSidebarTranslucencyEnabled:\s*\(\) => options\.state\.mainWindowSidebarTranslucencyEnabled/);
  assert.match(windowManager, /vibrancy:\s*"under-window"\s+as const/);
  assert.match(windowManager, /visualEffectState:\s*"active"\s+as const/);
  assert.match(windowManager, /applyAppearance\(targetWindow: TWindow \| null\)/);
  assert.match(windowManager, /restoreFloatingWindowsForFullscreen\?: \(\) => void;/);
  assert.match(
    windowManager,
    /if \(options\.platform === "darwin"\)\s*\{[\s\S]*?isSidebarTranslucencyEnabled\?\.\(\) \?\? true\) && !targetWindow\.isFullScreen\(\);[\s\S]*?targetWindow\.setVibrancy\(useSidebarTranslucency \? "under-window" : null\);[\s\S]*?targetWindow\.setBackgroundColor\(useSidebarTranslucency \? "#00000000" : "#FFFFFF"\);/
  );
  assert.match(windowManager, /targetWindow\.setBackgroundColor\("#FFFFFF"\);/);
  assert.match(windowManager, /targetWindow\.on\("enter-full-screen", \(\) => \{[\s\S]*?options\.lifecycle\.applyAppearance\(targetWindow\);[\s\S]*?options\.restoreFloatingWindowsForFullscreen\?\.\(\);[\s\S]*?\}\);/);
  assert.match(windowManager, /targetWindow\.on\("leave-full-screen", \(\) => \{[\s\S]*?options\.lifecycle\.applyAppearance\(targetWindow\);[\s\S]*?options\.restoreFloatingWindowsForFullscreen\?\.\(\);[\s\S]*?\}\);/);
  assert.match(appShellRuntime, /restoreDesktopPetWindowLayering: \(\) => void;/);
  assert.match(appShellRuntime, /restoreFloatingWindowsForFullscreen: \(\) => options\.restoreDesktopPetWindowLayering\(\)/);
  assert.match(appRuntime, /restoreDesktopPetWindowLayering\s*\n\s*\}\);/);
  assert.match(appRuntime, /function restoreDesktopPetWindowLayering\(\)[\s\S]{0,120}petRuntime\.restoreWindowLayering\(\)/);
  assert.match(contracts, /export type DesktopWindowState = \{[\s\S]*?isFullScreen:\s*boolean;/);
  assert.match(contracts, /getWindowState:\s*\(\) => Promise<\{ ok:\s*boolean; isFullScreen:\s*boolean; message\?:\s*string \}>;/);
  assert.match(contracts, /onWindowStateChanged:\s*\(listener:\s*DesktopWindowStateListener\) => \(\(\) => void\);/);
  assert.match(preload, /ipcRenderer\.invoke\("desktopShell\.getWindowState"\)/);
  assert.match(preload, /ipcRenderer\.on\("desktopShell\.windowStateChanged"/);
  assert.match(windowManager, /targetWindow\.webContents\.send\("desktopShell\.windowStateChanged",\s*\{ isFullScreen:\s*targetWindow\.isFullScreen\(\) \}\);/);
  assert.match(appShell, /const desktopShell = window\.electronAPI\.desktopShell;[\s\S]*?!desktopShell\.getWindowState \|\| !desktopShell\.onWindowStateChanged/);
  assert.match(appShell, /desktopShell\.getWindowState\(\)/);
  assert.match(appShell, /desktopShell\.onWindowStateChanged/);
  assert.match(appShell, /windowFullScreen \? "is-window-fullscreen" : ""/);
  assert.match(macFullscreenRule, /--app-window-drag-height:\s*0px;/);
  assert.doesNotMatch(macFullscreenRule, /padding-top:/);
  assert.doesNotMatch(globalStyles, /--mac-fullscreen-top-safe-area/u);
  assert.match(globalStyles, /--windows-titlebar-overlay-height:\s*44px;/);
  assert.match(globalStyles, /\.app-shell\.is-windows-platform:not\(\.has-browser-chrome-surface\):not\(\.has-kanban-controls\):not\(\.has-market-controls\) \.app-main\s*\{[\s\S]*?padding-top:\s*calc\(var\(--windows-titlebar-overlay-height\) \+ 12px\);/);
});

test("main process keeps app identity visible in platform program bars", () => {
  const mainProcess = readMainProcessRuntimeSource();
  const platformAdapter = readSourceFile("src", "main", "platform-adapter.ts");

  assert.match(mainProcess, /APP_ID,[\s\S]*?PRODUCT_NAME[\s\S]*?from "\.\.\/\.\.\/shared\/brand"/);
  assert.match(mainProcess, /productName:\s*PRODUCT_NAME/);
  assert.match(mainProcess, /options\.app\.setName\(options\.productName\);/);
  assert.match(mainProcess, /applyPlatformAppInit\(options\.platform, options\.app, options\.appId\);/);
  assert.match(
    platformAdapter,
    /if \(platform === "win32"\)\s*\{[\s\S]*?app\.setAppUserModelId\(appId\);[\s\S]*?\}/
  );
  assert.match(mainProcess, /function ensureDockIdentity\(\)/);
  assert.match(
    mainProcess,
    /if \(options\.platform === "win32"\)\s*\{[\s\S]*?return;[\s\S]*?\}[\s\S]*?if \(options\.platform !== "darwin"\)\s*\{[\s\S]*?return;[\s\S]*?\}/
  );
  assert.match(mainProcess, /function getDarwinDockIconCandidatePaths\(\)/);
  assert.match(mainProcess, /APP_ICON_ASSET_FILENAMES\.brandIcon/);
  assert.match(mainProcess, /APP_ICON_ASSET_FILENAMES\.macDockIcon/);
  assert.match(mainProcess, /const bundledMacDockIconPath = pathApi\.join\([\s\S]*?options\.resourcesPath,[\s\S]*?APP_ICON_ASSET_FILENAMES\.macDockIcon[\s\S]*?\);/);
  assert.match(mainProcess, /return \[[\s\S]*?bundledMacDockIconPath,[\s\S]*?buildAppIconPath,[\s\S]*?generatedBrandIconPath,[\s\S]*?rendererBrandIconPath[\s\S]*?\];/);
  assert.match(mainProcess, /options\.nativeImage\.createFromPath\(iconPath\)/);
  assert.match(mainProcess, /dock\.setIcon\(icon\);/);
  assert.match(mainProcess, /options\.app\.setActivationPolicy\("regular"\);/);
  assert.match(mainProcess, /dock\.show\(\)/);
  assert.match(mainProcess, /then\(\(\) => \{[\s\S]*?applyDarwinDockIcon\(dock\);[\s\S]*?\}\)/);
  assert.match(mainProcess, /ensureDockIdentity:\s*\(\) => systemIdentityRuntime\.ensureDockIdentity\(\)/);
  assert.match(mainProcess, /showMainWindow\(\);/);
  assert.match(readSourceFile("src", "main", "window-manager.ts"), /options\.ensureDockIdentity\(\);[\s\S]*?const targetWindow = activateMainWindow\(\);/);
});

test("mac dev app uses a content-addressed icon filename to avoid stale Dock cache", () => {
  const darwinDev = readSourceFile("scripts", "platform", "dev-darwin.mjs");

  assert.match(darwinDev, /createHash\("sha256"\)/);
  assert.match(darwinDev, /const targetIconFileName = `icon-\$\{fileHashPrefix\(sourceIconPath\)\}\.icns`;/);
  assert.match(darwinDev, /const iconRoot = brandIconDir\(projectRoot,\s*brand\);/);
  assert.match(darwinDev, /const sourceDockIconPath = path\.join\(iconRoot, "icon\.png"\);/);
  assert.match(darwinDev, /fs\.copyFileSync\(sourceDockIconPath, path\.join\(targetResourcesDir, "icon\.png"\)\);/);
  assert.match(darwinDev, /setPlistString\(plist,\s*"CFBundleIconFile",\s*targetIconFileName\)/);
  assert.match(darwinDev, /function setPlistEnvironment\(plist,\s*env\)/);
  assert.match(darwinDev, /VITE_DEV_SERVER_URL:\s*"http:\/\/127\.0\.0\.1:5173"/);
  assert.match(darwinDev, /DESKTOP_BUILTIN_ASSETS_ROOT:\s*serviceAssetsRoot/);
  assert.match(darwinDev, /BRAND:\s*brand\.id/);
  assert.match(darwinDev, /spawn\("open",\s*\["-n",\s*"-W",\s*preparedApp\.appRoot,\s*"--args",\s*projectRoot\]/);
  assert.doesNotMatch(darwinDev, /const targetIconFileName = "icon\.icns";/);
  assert.doesNotMatch(darwinDev, /spawn\(prepareDarwinDevElectronBinary\(electronBinary,\s*projectRoot,\s*brand\),\s*\["\."\]/);
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

test("external webview browser chrome omits bookmarks and debug entry while exposing copilot", () => {
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
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "app-shell", "AppShell.tsx"), "utf8");
  const mainProcess = readMainProcessRuntimeSource();

  assert.doesNotMatch(externalWebviewPage, /external-webview-bookmarks-bar/);
  assert.doesNotMatch(externalWebviewPage, /external-webview-bookmark-toggle/);
  assert.doesNotMatch(externalWebviewPage, /external-webview-devtools-toggle/);
  assert.doesNotMatch(externalWebviewPage, /external-webview-debug-toggle/);
  assert.doesNotMatch(externalWebviewPage, /external-webview-debug-sidebar/);
  assert.doesNotMatch(externalWebviewPage, /manual_debug/);
  assert.match(externalWebviewPage, /external-webview-copilot-button/);
  assert.match(externalWebviewPage, /const handleAssistantDockToggle = \(\) => \{[\s\S]*?if \(assistantDockOpen\) \{[\s\S]*?onCloseAssistantDock\?\.\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?onOpenAssistantDock\?\.\(\);/);
  assert.match(externalWebviewPage, /onClick=\{handleAssistantDockToggle\}/);
  assert.match(externalWebviewPage, /canGoForward:\s*boolean/);
  assert.match(externalWebviewPage, /nextPatch\.canGoForward = webview\.canGoForward\(\)/);
  assert.match(externalWebviewPage, /const handleGoForward = \(\) => \{[\s\S]*?activeWebview\.goForward\(\)/);
  assert.match(externalWebviewPage, /disabled=\{!activeTab\?\.canGoForward\}[\s\S]*?<SidebarActionIcon kind="forward" \/>/);
  assert.match(externalWebviewPage, /<SidebarActionIcon[\s\S]*?kind="sidebar_right"[\s\S]*?className="external-webview-copilot-button-icon"/);
  assert.doesNotMatch(externalWebviewPage, /SidebarIllustration[\s\S]*?sidebar-assistant-open[\s\S]*?sidebar-assistant-closed/);
  assert.doesNotMatch(externalWebviewStyles, /filter:\s*grayscale/);
  assert.match(externalWebviewPage, /t\("sidebar\.copilot\.close", \{ appName: PRODUCT_NAME \}\)/);
  assert.match(externalWebviewPage, /t\("sidebar\.copilot\.open", \{ appName: PRODUCT_NAME \}\)/);
  assert.doesNotMatch(externalWebviewPage, /bookmarkMenuNode/);
  assert.doesNotMatch(externalWebviewPage, /window\.electronAPI\.webview\.openDevTools/);
  assert.doesNotMatch(externalWebviewPage, /external-webview-bookmarks/);
  assert.doesNotMatch(externalWebviewStyles, /external-webview-bookmark/);
  assert.doesNotMatch(externalWebviewStyles, /external-webview-devtools-toggle/);
  assert.doesNotMatch(externalWebviewStyles, /external-webview-debug/);
  assert.match(externalWebviewStyles, /\.external-webview-copilot-button\s*\{/);
  assert.match(externalWebviewStyles, /\.external-webview-copilot-button\.is-active\s*\{/);
  assert.doesNotMatch(appShell, /external-webview-debug-sidebar/);
  assert.doesNotMatch(preload, /webview\.openDevTools/);
  assert.doesNotMatch(contracts, /openDevTools: \(webContentsId: number\)/);
  assert.doesNotMatch(mainProcess, /registerWebviewDevToolsIpcHandlers/);
});

test("web copilot dock yields to native dialogs while quick assistant keeps outside-dismiss handling", () => {
  const appShell = readAppShellSource();
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = readMainProcessRuntimeSource();
  const nativeDialogs = fs.readFileSync(
    path.join(projectRoot, "src", "main", "app-shell", "native-dialogs.ts"),
    "utf8"
  );
  const quickCopilotWindowController = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "quick", "window.ts"),
    "utf8"
  );
  const quickCopilotDismissLayer = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "quick", "dismiss-layer.ts"),
    "utf8"
  );
  const globalStyles = readRendererStyles();
  const quickAssistantBlurHandler = quickCopilotWindowController.slice(
    quickCopilotWindowController.indexOf('this.quickWindow.on("blur"'),
    quickCopilotWindowController.indexOf('this.quickWindow.on("closed"')
  );

  assert.match(nativeDialogs, /app\.nativeDialogVisibility/);
  assert.match(nativeDialogs, /platform === "darwin"/);
  assert.match(mainProcess, /hideQuickCopilot:\s*\(\) => options\.quickCopilotWindowController\.hideForNativeDialog\(\)/);
  assert.match(mainProcess, /restoreQuickCopilot:\s*\(\) => options\.quickCopilotWindowController\.restoreAfterNativeDialog\(\)/);
  assert.match(mainProcess, /options\.quickCopilotWindowController\.hideAfterOutsideFocus\(\)/);
  assert.match(mainProcess, /options\.app\.on\("activate"[\s\S]{0,160}options\.isNativeDialogOpen\(\)[\s\S]{0,80}return;/);
  assert.match(quickCopilotWindowController, /dismissWindow/);
  assert.match(quickCopilotDismissLayer, /QUICK_COPILOT_DISMISS_URL/);
  assert.match(mainProcess, /showQuickAssistantDismissWindow/);
  assert.doesNotMatch(quickAssistantBlurHandler, /mouseInside/);
  assert.match(preload, /onNativeDialogVisibility/);
  assert.match(appShell, /nativeDialogVisible/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.match(appShell, /nativeDialogVisible=\{nativeDialogVisible \|\| Boolean\(desktopActionConfirmation\)\}/);
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
  const serviceWebviewBridgeContracts = readSourceFile("src", "shared", "service-webview-bridge.ts");
  const mainProcess = readMainProcessRuntimeSource();
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
  assert.match(pluginPage, /registerDesktopActionProviderForScope\(\s*"web"/);
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
  const kanbanPage = readSourceFile("src", "renderer", "pages", "kanban", "KanbanPage.tsx");
  assert.match(kanbanPage, /loadInitialEmbeddedUrlDirectly/);
  assert.match(kanbanPage, /suppressInitialLoadingCopy/);
  assert.match(kanbanPage, /surfaceId="agent-webclient-kanban-chat"/);
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
  assert.match(pluginPage, /function resolveAgentWebclientChatRouteFromUrl\(value: string, webviewSrcUrl: string\)/);
  assert.match(pluginPage, /parsed\.searchParams\.get\("chatId"\)\?\.trim\(\)/);
  assert.match(pluginPage, /service\?\.id === "agent-webclient"[\s\S]*?surfaceId === AGENT_WEBCLIENT_SOURCE_CHAT[\s\S]*?navigate\(nextChatRoute, \{ replace: true \}\)/);
  assert.match(pluginPage, /AGENT_WEBCLIENT_CHAT_ROUTE_REQUEST_TYPE/);
  assert.match(pluginPage, /function handleAgentWebclientChatRouteMessage\([\s\S]*?payload\.type !== AGENT_WEBCLIENT_CHAT_ROUTE_REQUEST_TYPE/);
  assert.match(pluginPage, /readAgentWebclientRouteAgentKey\(currentRoute\)[\s\S]*?readAgentWebclientUrlAgentKey\(readCurrentWebviewUrl\(\), webviewSrcUrl\)/);
  assert.match(pluginPage, /const nextChatRoute = createAgentWebclientChatRoute\(agentKey, chatId\);[\s\S]{0,120}navigate\(nextChatRoute, \{ replace: true \}\)/);
  assert.match(pluginPage, /buildClientSideRouteNavigationScript/);
  assert.match(directRouteLoadBlock, /currentParsed\.origin === targetParsed\.origin/);
  assert.match(directRouteLoadBlock, /targetWebview\.executeJavaScript\(/);
  assert.match(pluginPage, /window\.history\.pushState/);
  assert.match(pluginPage, /PopStateEvent\("popstate"/);
  assert.match(pluginPage, /targetWebview\.loadURL\(embeddedUrl\)/);
  assert.match(pluginPage, /\[\s*active,\s*bridgeReady,\s*embeddedUrl,\s*loadInitialEmbeddedUrlDirectly,\s*serviceWebviewPreloadUrl,\s*webviewRenderKey,\s*webviewSrcUrl,\s*\]/);
  assert.match(pluginPage, /suppressInitialLoadingCopy\s*\?\s*\(/);
  assert.match(pluginPage, /aria-label=\{t\("pluginPage\.loading", \{ name: serviceDisplayName \}\)\}/);
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
  assert.match(serviceWebviewBridgeHost, /resolvePluginAuthBridgeResponseType\(bridgeProtocol\)/);
  assert.match(serviceWebviewBridgeHost, /SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE/);
  assert.match(serviceWebviewBridgeHost, /AGENT_APP_CLIPBOARD_REQUEST_TYPE/);
  assert.doesNotMatch(serviceWebviewBridgeHost, removedSymbolPattern("LEGACY", "AGENT", "APP", "CLIPBOARD", "REQUEST", "TYPE"));
  assert.match(serviceWebviewBridgeHost, /DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeHost, /DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeHost, /DESKTOP_DOWNLOAD_FILE_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeHost, /DESKTOP_SCREENSHOT_CAPTURE_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeHost, /DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE/);
  assert.doesNotMatch(serviceWebviewBridgeHost, removedSymbolPattern("LEGACY", "DESKTOP", "SCREENSHOT", "CAPTURE", "REQUEST", "TYPE"));
  assert.doesNotMatch(serviceWebviewBridgeHost, removedSymbolPattern("LEGACY", "DESKTOP", "SCREENSHOT", "CAPTURE", "RESPONSE", "TYPE"));
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /ServiceWebviewBridgeReservedCapability/);
  assert.match(serviceWebviewBridgeContracts, /media\.microphone/);
  assert.match(serviceWebviewBridgeContracts, /media\.camera/);
  assert.match(serviceWebviewBridgeContracts, /screen\.capture/);
  assert.doesNotMatch(serviceWebviewBridgeContracts, removedSymbolPattern("LEGACY", "AGENT", "APP", "CLIPBOARD", "REQUEST", "TYPE"));
  assert.doesNotMatch(serviceWebviewBridgeContracts, removedSymbolPattern("LEGACY", "AGENT", "APP", "CLIPBOARD", "RESPONSE", "TYPE"));
  assert.doesNotMatch(serviceWebviewBridgeContracts, removedSymbolPattern("LEGACY", "SERVICE", "WEBVIEW", "BRIDGE", "ACTION", "CHANNEL"));
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_SCREENSHOT_CAPTURE_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /AGENT_WEBCLIENT_CHAT_ROUTE_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /AGENT_WEBCLIENT_CHAT_ROUTE_REQUEST_TYPE,[\s\S]*?PLUGIN_SETTINGS_READ_REQUEST_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /chatId\?: string;/);
  assert.doesNotMatch(serviceWebviewBridgeContracts, removedSymbolPattern("LEGACY", "DESKTOP", "SCREENSHOT", "CAPTURE", "REQUEST", "TYPE"));
  assert.doesNotMatch(serviceWebviewBridgeContracts, removedSymbolPattern("LEGACY", "DESKTOP", "SCREENSHOT", "CAPTURE", "RESPONSE", "TYPE"));
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
  assert.doesNotMatch(serviceWebviewMainWorld, removedSymbolPattern("LEGACY", "SERVICE", "WEBVIEW", "BRIDGE", "ACTION", "CHANNEL"));
  assert.match(serviceWebviewMainWorld, /emitFromMain\(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL,\s*payload\)/);
  assert.doesNotMatch(serviceWebviewMainWorld, new RegExp(`emitFromMain\\(${removedSymbolPattern("LEGACY", "SERVICE", "WEBVIEW", "BRIDGE", "ACTION", "CHANNEL").source},\\s*payload\\)`));
  assert.match(serviceWebviewMainWorld, /__DESKTOP_WEBVIEW_BRIDGE__/);
  assert.match(serviceWebviewMainWorld, /agent-webclient\.appAccessToken/);
  assert.match(serviceWebviewMainWorld, /agent-webclient\.appAuthContext/);
  assert.doesNotMatch(serviceWebviewMainWorld, /AGENT_WEBCLIENT_CHAT_ROUTE_REQUEST_TYPE/);
  assert.doesNotMatch(serviceWebviewMainWorld, /window\.addEventListener\("agent:load-chat"/);
  assert.doesNotMatch(serviceWebviewMainWorld, /window\.addEventListener\("agent:start-new-conversation"/);
  assert.doesNotMatch(serviceWebviewMainWorld, /window\.addEventListener\("agent:attach-run"/);
  assert.doesNotMatch(serviceWebviewMainWorld, /window\.addEventListener\("agent:run-started-push"/);
  assert.doesNotMatch(serviceWebviewMainWorld, /socket\.addEventListener\("message", forwardPendingAgentRunStartRoute\)/);
  assert.doesNotMatch(serviceWebviewMainWorld, /requestId:\s*\\`agent_webclient_chat_route_/);
  assert.match(serviceWebviewMainWorld, /window\.__AGENT_APP_ACCESS_TOKEN/);
  assert.match(serviceWebviewMainWorld, /resolveServiceWebviewWsMonitorUrl/);
  assert.match(serviceWebviewMainWorld, /window\.WebSocket = DesktopServiceWebviewWebSocket/);
  assert.match(serviceWebviewMainWorld, /initialWsSource/);
  assert.match(serviceWebviewPreload, /sendBridgeDebug/);
  assert.match(serviceWebviewPreload, /preload-installed/);
  assert.match(serviceWebviewPreload, /auth-response-seeded/);
  assert.match(serviceWebviewPreload, /isServiceWebviewBridgeRequestType/);
  assert.match(serviceWebviewPreload, /recentForwardedBridgeRequestKeys/);
  assert.match(serviceWebviewPreload, /function forwardDesktopBridgeRequest\(/);
  assert.match(serviceWebviewPreload, /const requestKey = `\$\{value\.type\}:\$\{value\.requestId\}`/);
  assert.match(serviceWebviewPreload, /DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE/);
  assert.match(mainProcess, /getMainPreloadPath\(MAIN_PROCESS_DIR, mainProcessContext\.platform\)/);
  assert.match(mainProcess, /getMainPreloadPath\(options\.mainProcessDir, options\.platform\)/);
  assert.match(mainProcess, /resolveServiceWebviewPreloadPath\(options\.mainProcessDir, options\.platform\)/);
  assert.doesNotMatch(mainProcess, /path\.join\([^)]*"\.\."[^)]*"preload"/);
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
  assert.match(readSourceFile("src", "main", "assistant", "core", "agent-platform-bridge.ts"), /\/api\/chat\/export\?chatId=/u);
  assert.doesNotMatch(readSourceFile("src", "main", "assistant", "core", "agent-platform-bridge.ts"), /\/api\/chat-export/u);
  assert.doesNotMatch(saveExportBlock, /showSaveDialog/u);
});

test("assistant entrypoints restore core services before opening embedded webclient", () => {
  const mainProcess = readMainProcessRuntimeSource();
  const petRuntime = readSourceFile("src", "main", "assistant", "pet", "runtime.ts");
  const quickRouting = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "quick", "routing.ts"),
    "utf8"
  );
  const trayController = fs.readFileSync(
    path.join(projectRoot, "src", "main", "app-shell", "tray.ts"),
    "utf8"
  );

  assert.match(mainProcess, /async function ensureAssistantTargetServicesRunning/);
  assert.match(mainProcess, /for \(const serviceId of STARTUP_RESTORE_SERVICE_ORDER\)/);
  assert.match(mainProcess, /await servicesRuntime\.runServiceMutation\(\(\) =>[\s\S]{0,120}servicesRuntime\.ensureAssistantTargetServicesRunning\(source\)/);
  assert.match(mainProcess, /async function showAssistantTargetWindow/);
  assert.match(
    mainProcess,
    /async function showAssistantTargetWindow[\s\S]*?showMainWindow\(targetPath\);[\s\S]*?await servicesRuntime\.runServiceMutation\(\(\) =>[\s\S]*?servicesRuntime\.ensureAssistantTargetServicesRunning\(source\)/
  );
  assert.match(mainProcess, /const ASSISTANT_TARGET_PATH = AGENT_WEBCLIENT_TARGET_PATH;/);
  assert.doesNotMatch(mainProcess, /const ASSISTANT_TARGET_PATH = "\/service\/agent-webclient";/);
  assert.match(quickRouting, /function createAgentWebclientRoute/);
  assert.match(quickRouting, /return AGENT_WEBCLIENT_TARGET_PATH;/);
  assert.doesNotMatch(quickRouting, /return "\/service\/agent-webclient";/);
  assert.match(quickRouting, /\/agent\/\$\{encodeURIComponent\(agentKey\)\}/);
  assert.match(quickRouting, /pathname === "\/copilot" \|\| pathname\.startsWith\("\/copilot\/"\)/);
  assert.match(quickRouting, /getAllWebContents\(\)/);
  assert.match(quickRouting, /contents\.getType\(\) !== "webview"/);
  assert.match(quickRouting, /hostWebContents\.id !== targetWindow\.webContents\.id/);
  assert.match(quickRouting, /workerKey:\s*`agent:\$\{agentKey\}`/);
  assert.match(quickRouting, /const QUICK_AGENT_OPEN_RETRY_COUNT = 80;/);
  assert.doesNotMatch(quickRouting, /embedPath=\$\{encodeURIComponent\(embedPath\)\}/);
  assert.match(mainProcess, /openAgent: scheduleQuickAgentOpenRequest/);
  assert.match(mainProcess, /async function openAssistantFromDesktopPet/);
  assert.match(mainProcess, /async function openAssistantFromDesktopPet\(\) \{[\s\S]{0,120}petRuntime\.openAssistant\(\)/);
  assert.match(petRuntime, /async function openAssistant\(\)[\s\S]{0,120}options\.showMainWindow\(\);/);
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

test("quit menu entries skip confirmation except keyboard accelerator", () => {
  const appEvents = readSourceFile("src", "main", "app", "app-events.ts");
  const runtime = readSourceFile("src", "main", "app-shell", "runtime.ts");
  const appMenu = readSourceFile("src", "main", "app-shell", "app-menu.ts");
  const trayController = readSourceFile("src", "main", "app-shell", "tray.ts");
  const quitConfirmation = readSourceFile("src", "main", "app-shell", "quit-confirmation.ts");
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");
  const beforeQuitHandler = appEvents.match(/options\.app\.on\("before-quit", \(event\) => \{[\s\S]*?\n  \}\);/u)?.[0] ?? "";
  const trayOptions = trayController.match(/export type AppTrayControllerOptions = \{[\s\S]*?\n\};/u)?.[0] ?? "";
  const trayQuitMenuItem = trayController.match(/label: t\("tray\.quit"\),[\s\S]*?\n      \}/u)?.[0] ?? "";
  const trayRuntimeOptions = runtime.match(/new AppTrayController\(\{[\s\S]*?\n  \}\);/u)?.[0] ?? "";
  const appMenuRuntimeOptions = runtime.match(/installApplicationMenu\(\{[\s\S]*?\n    \}\);/u)?.[0] ?? "";
  const quitConfirmationRuntimeOptions = runtime.match(/createQuitConfirmationController\(\{[\s\S]*?\n  \}\);/u)?.[0] ?? "";
  const quitConfirmationOptions = quitConfirmation.match(/export type QuitConfirmationControllerOptions = \{[\s\S]*?\n\};/u)?.[0] ?? "";
  const quitDialogBuilder = quitConfirmation.match(/export function buildQuitConfirmationDialogOptions[\s\S]*?export function createQuitConfirmationController/u)?.[0] ?? "";
  const zhQuitConfirmCopy = zhCN.match(/"quitConfirm\.(?:title|detail)": .*$/gmu)?.join("\n") ?? "";
  const enQuitConfirmCopy = enUS.match(/"quitConfirm\.(?:title|detail)": .*$/gmu)?.join("\n") ?? "";
  const macQuitMenuItem = appMenu.match(/label: options\.t\("menu\.quit", \{ appName: options\.appName \}\),[\s\S]*?\n            \}/u)?.[0] ?? "";
  const macWindowMenuItem = appMenu.match(/const windowMenuItem: MenuItemConstructorOptions = isMac[\s\S]*?\n    : \{ role: "windowMenu" \};/u)?.[0] ?? "";

  assert.match(zhCN, /"quitConfirm\.title": "确认退出？"/);
  assert.match(zhCN, /"quitConfirm\.detail": "退出后，本机正在运行的任务和服务将中断；已启用的自动化在应用关闭期间不会运行。"/);
  assert.match(enUS, /"quitConfirm\.title": "Quit now\?"/);
  assert.match(enUS, /"quitConfirm\.detail": "Quitting will interrupt active local tasks and services\. Enabled automations will not run while the app is closed\."/);
  assert.doesNotMatch(zhQuitConfirmCopy, /\{appName\}/);
  assert.doesNotMatch(enQuitConfirmCopy, /\{appName\}/);
  assert.match(quitDialogBuilder, /const title = options\.t\("quitConfirm\.title"\);/);
  assert.match(quitDialogBuilder, /detail:\s*options\.t\("quitConfirm\.detail"\)/);
  assert.doesNotMatch(quitDialogBuilder, /quitConfirm\.(?:title|detail)"\s*,\s*\{ appName:/);
  assert.doesNotMatch(quitConfirmationOptions, /appName:\s*string;/);
  assert.doesNotMatch(quitConfirmationRuntimeOptions, /appName:\s*options\.productName/);

  assert.match(trayOptions, /quitWithoutConfirmation:\s*\(\) => void;/);
  assert.match(trayQuitMenuItem, /click:\s*\(\) => this\.options\.quitWithoutConfirmation\(\)/);
  assert.doesNotMatch(trayController, /this\.options\.quit\(\)/);
  assert.match(trayRuntimeOptions, /quitWithoutConfirmation:\s*options\.beginAppQuitWithoutConfirmation/);
  assert.doesNotMatch(trayRuntimeOptions, /quit:\s*options\.requestAppQuit/);

  assert.match(appMenu, /quitWithoutConfirmation:\s*\(\) => void;/);
  assert.match(macWindowMenuItem, /label:\s*options\.t\("menu\.window"\)/);
  assert.match(macWindowMenuItem, /role:\s*"close"/);
  assert.match(macWindowMenuItem, /accelerator:\s*"Command\+W"/);
  assert.match(macQuitMenuItem, /accelerator:\s*"Command\+Q"/);
  assert.match(macQuitMenuItem, /if \(event\.triggeredByAccelerator\)/);
  assert.match(macQuitMenuItem, /options\.requestQuit\(\);/);
  assert.match(macQuitMenuItem, /options\.quitWithoutConfirmation\(\);/);
  assert(
    indexOfRequired(macQuitMenuItem, "options.requestQuit();") <
      indexOfRequired(macQuitMenuItem, "options.quitWithoutConfirmation();"),
    "Command+Q should keep the confirmation path before menu clicks quit without confirmation"
  );
  assert.match(appMenuRuntimeOptions, /requestQuit:\s*options\.requestAppQuit/);
  assert.match(appMenuRuntimeOptions, /quitWithoutConfirmation:\s*options\.beginAppQuitWithoutConfirmation/);

  assert.doesNotMatch(appEvents, /requestAppQuit:\s*\(\) => void;/);
  assert.doesNotMatch(appEvents, /options\.requestAppQuit\(\)/);
  assert.doesNotMatch(beforeQuitHandler, /platform === "darwin"[\s\S]*?requestAppQuit/);
  assert.match(beforeQuitHandler, /event\.preventDefault\(\);/);
  assert.match(beforeQuitHandler, /options\.state\.isHandlingQuit = true;/);
  assert.match(beforeQuitHandler, /void options\.runShutdownCleanup\(\)\.finally\(\(\) => \{/);
  assert.match(beforeQuitHandler, /options\.beginAppQuitWithoutConfirmation\(\);/);
});

test("tray icon lookup prefers active brand assets in dev and packaged resources in builds", () => {
  const mainProcess = readMainProcessRuntimeSource();
  const trayController = readSourceFile("src", "main", "app-shell", "tray.ts");
  const helper = trayController.match(/export function getAppTrayIconCandidatePaths[\s\S]*?\n\}\n\nexport class/u)?.[0] ?? "";
  const packagedBranch = helper.match(/^  if \(options\.isPackaged\) \{[\s\S]*?^  \}/mu)?.[0] ?? "";
  const packagedDarwinBranch = packagedBranch.match(/if \(options\.platform === "darwin"\) \{[\s\S]*?^    \}/mu)?.[0] ?? "";
  const macDevBranch = helper.match(/^  if \(options\.platform === "darwin"\) \{[\s\S]*?^  \}/mu)?.[0] ?? "";
  const windowsDevBranch = helper.match(/^  if \(options\.platform === "win32"\) \{[\s\S]*?^  \}/mu)?.[0] ?? "";
  const createIconMethod = trayController.match(/private createIcon\(\) \{[\s\S]*?^  \}/mu)?.[0] ?? "";

  assert.match(mainProcess, /new AppTrayController\(\{[\s\S]*?isPackaged:\s*options\.app\.isPackaged/u);
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
  const mainProcess = readMainProcessRuntimeSource();
  const logsRuntime = readSourceFile("src", "main", "logs", "runtime.ts");
  const servicesHandlers = readSourceFile("src", "main", "ipc", "services-handlers.ts");
  const logViewerWindow = fs.readFileSync(
    path.join(projectRoot, "src", "main", "logs", "viewer-window.ts"),
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

  assert.match(logsRuntime, /LogViewerWindowController/);
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
  const logViewerHeadRule = globalStyles.match(
    /(?:^|\n)\.log-viewer-head\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body ?? "";

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
  assert.match(globalStyles, /\.log-viewer-window-drag-zone\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*0;[\s\S]*?height:\s*24px;[\s\S]*?app-region:\s*drag;/);
  assert.doesNotMatch(globalStyles, /\.log-viewer-drag-region\s*\{/);
  assert.ok(logViewerHeadRule, "missing .log-viewer-head rule");
  assert.match(logViewerHeadRule, /min-height:\s*44px;/);
  assert.doesNotMatch(logViewerHeadRule, /app-region:\s*drag;/);
  assert.doesNotMatch(logViewerHeadRule, /-webkit-app-region:\s*drag;/);
  assert.match(globalStyles, /\.log-viewer-head-actions\s*\{[\s\S]*?app-region:\s*no-drag;/);
  assert.match(globalStyles, /\.log-viewer-page\s*\{[\s\S]*?background:\s*var\(--desktop-ui-bg\);[\s\S]*?color:\s*var\(--desktop-ui-text\);/);
  assert.match(globalStyles, /\.log-viewer-head\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--desktop-ui-border\);[\s\S]*?background:\s*var\(--desktop-ui-card\);/);
  assert.doesNotMatch(logViewerPage, /log-viewer-tip-row/);
  assert.doesNotMatch(globalStyles, /\.log-viewer-tip-row\s*\{/);
  assert.match(globalStyles, /\.log-viewer-live-dot\s*\{[\s\S]*?animation:\s*log-viewer-live-dot-breathe\s*1\.6s\s*ease-in-out\s*infinite;/);
  assert.match(globalStyles, /@keyframes\s+log-viewer-live-dot-breathe\s*\{/);
  assert.match(globalStyles, /\.log-viewer-find-trigger,[\s\S]*?\.log-viewer-follow-toggle\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*28px;/);
  assert.match(globalStyles, /\.log-viewer-follow-toggle svg\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/);
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
  assert.match(logViewerPage, /import \{ SearchOutlined \} from "@ant-design\/icons";/);
  assert.match(logViewerPage, /className=\{`log-viewer-find-trigger\$\{searchVisible \? " is-active" : ""\}`\}/);
  assert.match(logViewerPage, /onClick=\{handleOpenSearch\}[\s\S]*?<SearchOutlined aria-hidden="true" \/>/);
  assert.match(logViewerPage, /handleOpenSearch/);
  assert.match(logViewerPage, /handleCloseSearch/);
  assert.match(logViewerPage, /aria-label=\{t\("logViewer\.find\.close"\)\}/);
  assert.match(logViewerPage, /selectRelativeMatch\(-1\)/);
  assert.match(logViewerPage, /selectRelativeMatch\(1\)/);
  assert.match(logViewerPage, /renderLogContent\(\s*joinedContent,\s*matches,\s*activeMatchIndex,\s*\)/);
  assert.doesNotMatch(logViewerPage, /className="log-viewer-toolbar"/);
  assert.match(globalStyles, /\.log-viewer-body-shell\s*\{/);
  assert.match(globalStyles, /\.log-viewer-find-panel\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*12px;[\s\S]*?top:\s*8px;[\s\S]*?width:\s*min\(520px,\s*calc\(100%\s*-\s*24px\)\);/);
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
  assert.match(authBridge, /desktop:agent-auth:request/);
  assert.doesNotMatch(authBridge, removedProtocolPattern("desktop", "agent-app-auth", "request"));
  assert.doesNotMatch(authBridge, removedProtocolPattern("zenmind", "agent-app-auth", "request"));
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
  assert.match(dockComponent, /devToolsTarget="copilot"/);
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
  const mainProcess = readMainProcessRuntimeSource();
  const quickCopilotWindowController = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "quick", "window.ts"),
    "utf8"
  );
  const quickAssistantWindow = fs.readFileSync(path.join(projectRoot, "src", "main", "assistant", "quick", "quick-copilot.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = readSharedContractsSource();
  const quickWebCopilotStyles = globalStyles.slice(
    globalStyles.indexOf(".quick-web-copilot,"),
    globalStyles.indexOf(".quick-web-copilot .embedded-surface-page")
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
  assert.match(quickCopilotRoute, /function buildAgentWebclientCopilotPath\(agentKey: string\)/);
  assert.match(quickCopilotRoute, /encodeURIComponent\(normalizedAgentKey\)/);
  assert.match(quickCopilotRoute, /const quickAssistantEmbedPath = buildAgentWebclientCopilotPath\(quickAssistantAgentKey\);/);
  assert.match(quickCopilotRoute, /embedPath=\{quickAssistantEmbedPath\}/);
  assert.match(quickCopilotRoute, /pluginId="agent-webclient"/);
  assert.match(quickCopilotRoute, /devToolsTarget="copilot"/);
  assert.match(quickCopilotRoute, /loadInitialEmbeddedUrlDirectly/);
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

test("copilot webview DevTools target bridge stays scoped to Copilot surfaces", () => {
  const pluginPage = readSourceFile("src", "renderer", "pages", "plugin", "PluginPage.tsx");
  const preload = readSourceFile("src", "preload", "index.ts");
  const contracts = readSharedContractsSource();
  const assistantHandlers = readSourceFile("src", "main", "ipc", "assistant-handlers.ts");
  const mainProcess = readMainProcessRuntimeSource();

  assert.match(pluginPage, /devToolsTarget\?: "copilot"/);
  assert.match(pluginPage, /window\.electronAPI\.copilot\.publishDevToolsTarget/);
  assert.match(pluginPage, /document\.visibilityState !== "hidden"/);
  assert.match(preload, /copilot:\s*\{[\s\S]{0,140}publishDevToolsTarget:\s*\(target\) => ipcRenderer\.invoke\("copilot\.publishDevToolsTarget", target\)/);
  assert.match(contracts, /interface CopilotDevToolsTargetInput/);
  assert.match(contracts, /copilot:\s*\{[\s\S]{0,180}publishDevToolsTarget:\s*\(target: CopilotDevToolsTargetInput\)/);
  assert.match(assistantHandlers, /COPILOT_DEVTOOLS_SURFACE_IDS[\s\S]{0,120}"agent-webclient-copilot-dock"[\s\S]{0,120}"agent-webclient-quick-copilot"/);
  assert.match(assistantHandlers, /ipcMain\.handle\("copilot\.publishDevToolsTarget"/);
  assert.match(assistantHandlers, /contents\.getType\(\) === "webview"/);
  assert.match(mainProcess, /preferredWebviewDevToolsTarget:\s*appState\.copilotDevToolsTarget/);
  assert.doesNotMatch(preload, /webview\.openDevTools/);
  assert.doesNotMatch(contracts, /openDevTools: \(webContentsId: number\)/);
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
    path.join(projectRoot, "src", "main", "assistant", "pet", "pet-status-client.ts"),
    "utf8"
  );

  assert.match(petStatusClient, /LEGACY_DESKTOP_PET_BOUND_AGENT_REQUEST_KEYS/);
  assert.doesNotMatch(petStatusClient, /requestedKey === "小宅"/);
});

test("desktop pet drag ignores transient capture loss while the pointer is still down", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );
  const desktopPetController = readSourceFile("src", "main", "desktop-pet-controller.ts");

  assert.match(desktopPet, /const handleLostPointerCapture = \(pointerEvent: globalThis\.PointerEvent\) => \{[\s\S]{0,120}pointerEvent\.buttons !== 0[\s\S]{0,80}return;/);
  assert.match(desktopPet, /window\.addEventListener\("pointerup"/);
  assert.match(desktopPet, /window\.addEventListener\("mouseup"/);
  assert.match(desktopPet, /window\.addEventListener\("blur"/);
  assert.match(desktopPet, /window\.addEventListener\("contextmenu"/);
  assert.match(desktopPet, /document\.addEventListener\("visibilitychange"/);
  assert.match(desktopPetController, /clearTimer\(\);/);
  assert.match(desktopPetController, /forceEndMs = typeof options\.forceEndMs === "number" \? options\.forceEndMs : 30000;/);
  assert.match(desktopPetController, /webContents\.on\("context-menu"[\s\S]{0,120}options\.endDrag\(\)/);
});

test("desktop pet click opens the branded app without assistant sidebar copy", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );

  assert.match(desktopPet, /desktopPet\.openAssistant/);
  assert.match(desktopPet, /aria-label=\{t\("desktopPet\.openApp", \{ appName: PRODUCT_NAME \}\)\}/);
  assert.doesNotMatch(desktopPet, /打开侧边栏助手/);
});

test("desktop pet base mode stays sprite-sized while bubble and preview modes expand separately", () => {
  const mainProcess = readMainProcessRuntimeSource();
  const desktopPetController = readSourceFile("src", "main", "desktop-pet-controller.ts");
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );
  const petGeometry = fs.readFileSync(path.join(projectRoot, "src", "main", "assistant", "pet", "desktop-pet.ts"), "utf8");
  const globalStyles = readRendererStyles();

  assert.match(desktopPetController, /return shouldShowBubble \? "bubble" : "base";/);
  assert.doesNotMatch(mainProcess, /shouldHideDesktopPetForMainWindow/);
  assert.doesNotMatch(mainProcess, /syncDesktopPetWindowVisibility/);
  assert.match(petGeometry, /width:\s*176,/);
  assert.match(petGeometry, /height:\s*198/);
  assert.match(petGeometry, /bubble:\s*\{\s*width:\s*376,\s*height:\s*442/s);
  assert.match(petGeometry, /DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS:[\s\S]{0,80}Record<DesktopPetWindowMode/);
  assert.match(petGeometry, /"preview-expanded":\s*\{\s*x:\s*162,\s*y:\s*294,/s);
  assert.match(petGeometry, /"task-list-compact":\s*\{\s*x:\s*132,\s*y:\s*228,/s);
  assert.match(petGeometry, /"task-list":\s*\{\s*x:\s*162,\s*y:\s*308,/s);
  assert.match(petGeometry, /baseBounds\.x \+ DESKTOP_PET_VISIBLE_FOOTPRINT\.x - footprint\.x/);
  assert.match(petGeometry, /"task-list-compact":\s*\{\s*width:\s*376,\s*height:\s*352/s);
  assert.match(petGeometry, /"task-list":\s*\{\s*width:\s*424,\s*height:\s*432/s);
  assert.match(desktopPetController, /activeTasks\.length > 0[\s\S]{0,120}return activeTasks\.length <= 2 \? "task-list-compact" : "task-list";/);
  assert.match(desktopPetController, /panel\.status === "done" \? "bubble" : panel\.expanded \? "preview-expanded" : "base"/);
  assert.match(desktopPetController, /const hasHistoryMessages = Array\.isArray\(input\.state\.messages\) && input\.state\.messages\.length > 0;/);
  assert.match(desktopPetController, /const hasMessageReaction = input\.state\.status === "idle"[\s\S]{0,180}unreadCount > 0/);
  assert.match(desktopPetController, /if \(hasHistoryMessages\) \{[\s\S]{0,80}return "bubble";/);
  assert.match(desktopPetController, /const shouldShowBubble = hasHistoryMessages \|\| input\.state\.status !== "idle"/);
  assert.match(desktopPet, /const isDonePreviewPanel = previewPanel\?\.status === "done";/);
  assert.match(desktopPet, /const hasCollapsedPreviewPanel = Boolean\(previewPanel && !previewPanel\.expanded && !isDonePreviewPanel && !hasHistoryMessages\);/);
  assert.match(desktopPet, /const shouldShowPreviewPanel = !isDragging && isWidgetExpanded && !hasHistoryMessages && !shouldShowTaskPanel && Boolean\(previewPanel && previewPanel\.expanded && !isDonePreviewPanel\);/);
  assert.match(desktopPet, /hasPreviewExpandedAnchor \? "has-preview-expanded" : ""/);
  assert.doesNotMatch(desktopPet, /has-preview-done/);
  assert.doesNotMatch(desktopPet, /has-preview-collapsed/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.has-preview-done/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.has-preview-collapsed/);
  assert.match(globalStyles, /\.desktop-pet-hitbox\s*\{[\s\S]{0,160}position:\s*absolute;[\s\S]{0,80}inset:\s*0;/);
  assert.match(globalStyles, /\.desktop-pet-button\s*\{[\s\S]{0,160}position:\s*absolute;[\s\S]{0,120}left:\s*var\(--desktop-pet-button-left\);/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-tasks\s*\{[\s\S]{0,260}--desktop-pet-button-left:\s*144px;[\s\S]{0,100}--desktop-pet-button-top:\s*292px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-compact-tasks\s*\{[\s\S]{0,240}--desktop-pet-button-left:\s*114px;[\s\S]{0,100}--desktop-pet-button-top:\s*212px;/);
  assert.match(globalStyles, /\.desktop-pet-speech\s*\{[\s\S]{0,120}position:\s*absolute;[\s\S]{0,80}width:\s*216px;/);
  assert.match(globalStyles, /\.desktop-pet-task-panel\s*\{[\s\S]{0,160}position:\s*absolute;[\s\S]{0,180}width:\s*var\(--desktop-pet-task-panel-width,\s*320px\);/);
  assert.match(globalStyles, /\.desktop-pet-task-panel\s*\{[\s\S]{0,160}top:\s*var\(--desktop-pet-task-panel-top,\s*auto\);/);
  assert.match(globalStyles, /\.desktop-pet-task-panel\s*\{[\s\S]*?backdrop-filter:\s*blur\(24px\) saturate\(145%\);/);
  assert.match(globalStyles, /\.desktop-pet-task-panel\s*\{[\s\S]*?rgba\(226,\s*246,\s*244,\s*0\.54\)/);
  assert.match(globalStyles, /\.desktop-pet-preview\s*\{[\s\S]{0,120}position:\s*absolute;[\s\S]{0,120}width:\s*336px;/);
  assert.match(globalStyles, /\.desktop-pet-speech\s*\{[\s\S]{0,700}box-shadow:\s*[\s\S]{0,120}0 14px 30px rgba\(30,\s*54,\s*105,\s*0\.16\)/);
  assert.match(globalStyles, /\.desktop-pet-image\s*\{[\s\S]{0,120}width:\s*96px;/);
  assert.match(globalStyles, /\.desktop-pet-image\s*\{[\s\S]{0,160}filter:\s*none;/);
  assert.doesNotMatch(globalStyles, /\n\.desktop-pet-image\s*\{[^}]*drop-shadow/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-signature \.desktop-pet-image\s*\{[\s\S]{0,220}drop-shadow/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root:not\(\.has-bubble\):not\(\.has-preview\)\s+\.desktop-pet-image[\s\S]{0,120}width:\s*100%/);
});

test("desktop pet message reaction collapses to an unread badge without an expand button", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );
  const desktopPetVisual = readSourceFile("src", "shared", "desktop-pet-visual.ts");
  const globalStyles = readRendererStyles();

  assert.match(desktopPet, /const showMessageBadgeOnly = hasMessageReaction && !hasHistoryMessages && !shouldShowTaskPanel && !shouldShowPreviewPanel && !isDonePreviewPanel;/);
  assert.match(desktopPet, /const canShowStatusPanel =[\s\S]{0,220}\(hasHistoryMessages \|\| displayStatus !== "idle"\);/);
  assert.match(desktopPet, /const shouldShowStatusPanel = canShowStatusPanel && isWidgetExpanded;/);
  assert.match(desktopPet, /const showStatusPanel = isPanelWindow && shouldShowStatusPanel;/);
  assert.match(desktopPet, /const desiredWindowMode: DesktopPetWindowMode = isDragging[\s\S]{0,360}shouldShowStatusPanel[\s\S]{0,80}"bubble"[\s\S]{0,80}"base";/);
  assert.match(desktopPet, /desktopPet\.setWindowMode\(desiredWindowMode\)/);
  assert.match(desktopPet, /hasBubbleAnchor \? "has-bubble" : ""/);
  assert.match(desktopPet, /const unreadBadgeCounts = resolveDesktopPetUnreadBadgeCounts\(\{[\s\S]{0,180}visibleMessages,[\s\S]{0,80}activeTasks[\s\S]{0,40}\}\);/);
  assert.match(desktopPet, /unreadBadgeCounts\.awaitingCount > 0/);
  assert.match(desktopPet, /unreadBadgeCounts\.completedCount > 0/);
  assert.match(desktopPet, /const showUnreadBadges = unreadBadgeItems\.length > 0 && !shouldShowTaskPanel && !shouldShowPreviewPanel && !shouldShowStatusPanel;/);
  assert.doesNotMatch(desktopPet, /latestVisibleMessageSummary/);
  assert.doesNotMatch(desktopPet, /statusPanelSummary/);
  assert.match(desktopPet, /resolveDesktopPetUnreadBadgeCounts/);
  assert.match(desktopPet, /className=\{`desktop-pet-unread-badges \$\{unreadBadgeItems\.length > 1 \? "has-multiple" : "has-single"\}`\}/);
  assert.match(desktopPet, /unreadBadgeItems\.map\(\(badge\) =>/);
  assert.doesNotMatch(desktopPet, /hasAwaitingHumanLoop/);
  assert.match(desktopPetVisual, /export function resolveDesktopPetUnreadBadgeTone/);
  assert.match(desktopPetVisual, /export function resolveDesktopPetUnreadBadgeCounts/);
  assert.match(desktopPetVisual, /const awaitingCountsByKey = new Map<string, number>\(\);/);
  assert.match(desktopPetVisual, /setAwaitingBadgeCount\(/);
  assert.match(desktopPetVisual, /\[\.\.\.awaitingCountsByKey\.values\(\)\]\.reduce/);
  assert.match(desktopPetVisual, /completedCount:\s*completedMessageCount/);
  assert.match(desktopPet, /function handleUnreadBadgeClick[\s\S]{0,220}setIsWidgetExpanded\(true\);/);
  assert.match(desktopPet, /className=\{`desktop-pet-unread-badge is-\$\{badge\.tone\} is-\$\{badge\.key\}`\}/);
  assert.match(desktopPet, /onPointerDown=\{handleUnreadBadgePointerDown\}/);
  assert.match(desktopPet, /onClick=\{handleUnreadBadgeClick\}/);
  assert.match(desktopPet, /const \[messageCache, setMessageCache\] = useState<readonly DesktopPetMessageItem\[\]>\(\[\]\);/);
  assert.match(desktopPet, /const visibleMessages = getVisibleDesktopPetMessages\(\{/);
  assert.doesNotMatch(desktopPet, /DESKTOP_PET_MESSAGE_VISIBLE_LIMIT/);
  assert.doesNotMatch(desktopPet, /desktop-pet-message-latest/);
  assert.doesNotMatch(desktopPet, /展开全部/);
  assert.doesNotMatch(desktopPet, /desktop-pet-task-expand/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-task-expand/);
  assert.match(desktopPet, /className="desktop-pet-stage"/);
  assert.doesNotMatch(desktopPet, /desktop-pet-status-fab/);
  assert.match(globalStyles, /\.desktop-pet-unread-badges\s*\{[\s\S]{0,220}display:\s*inline-flex;[\s\S]{0,120}gap:\s*4px;/);
  assert.match(globalStyles, /\.desktop-pet-unread-badges\.has-multiple\s*\{[\s\S]{0,160}left:\s*calc\(var\(--desktop-pet-button-left\) \+ 78px\);/);
  assert.match(globalStyles, /\.desktop-pet-unread-badge\.is-message\s*\{[\s\S]{0,220}#09a84f[\s\S]{0,220}rgba\(9,\s*168,\s*79,\s*0\.34\)/);
  assert.match(globalStyles, /\.desktop-pet-unread-badge\.is-awaiting\s*\{[\s\S]{0,220}#f59e0b[\s\S]{0,220}rgba\(245,\s*158,\s*11,\s*0\.34\)/);
  assert.match(globalStyles, /\.desktop-pet-unread-badge\s*\{[\s\S]*?pointer-events:\s*auto;/);
  assert.match(globalStyles, /\.desktop-pet-task-status-badge\.is-awaiting\s*\{[\s\S]{0,120}#fff2c2[\s\S]{0,120}#b45309/);
  assert.match(globalStyles, /\.desktop-pet-task-head-copy strong\s*\{[\s\S]{0,120}font-size:\s*13px;/);
  assert.match(globalStyles, /\.desktop-pet-task-head-copy span\s*\{[\s\S]{0,160}font-size:\s*11px;/);
  assert.match(globalStyles, /\.desktop-pet-task-copy strong\s*\{[\s\S]{0,120}font-size:\s*12px;/);
  assert.match(globalStyles, /\.desktop-pet-task-copy span\s*\{[\s\S]{0,160}font-size:\s*11px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-bubble\s*\{[\s\S]{0,180}--desktop-pet-task-panel-bottom:\s*138px;[\s\S]{0,100}--desktop-pet-task-list-max:\s*155px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-panel-window\.has-bubble\s*\{[\s\S]{0,120}--desktop-pet-task-panel-top:\s*auto;[\s\S]{0,80}--desktop-pet-task-panel-bottom:\s*10px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-panel-window\.is-edge-dock-top\.has-bubble\s*\{[\s\S]{0,120}--desktop-pet-task-panel-top:\s*10px;[\s\S]{0,80}--desktop-pet-task-panel-bottom:\s*auto;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-panel-window\.is-edge-dock-bottom\.has-bubble\s*\{[\s\S]{0,120}--desktop-pet-task-panel-top:\s*auto;[\s\S]{0,80}--desktop-pet-task-panel-bottom:\s*10px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-edge-dock-top\.has-bubble,[\s\S]{0,160}--desktop-pet-task-panel-top:\s*168px;[\s\S]{0,120}--desktop-pet-task-panel-bottom:\s*auto;/);
  assert.doesNotMatch(globalStyles, /0 18px 40px rgba\(30,\s*32,\s*38,\s*0\.12\)/);
  assert.match(globalStyles, /\.desktop-pet-message-card\s*\{[\s\S]*?box-shadow:\s*none;/);
  assert.match(globalStyles, /\.desktop-pet-message-card\s*\{[\s\S]*?backdrop-filter:\s*blur\(18px\) saturate\(135%\);/);
  assert.match(globalStyles, /\.desktop-pet-message-card \.desktop-pet-task-copy span\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.match(globalStyles, /\.desktop-pet-message-main \.desktop-pet-task-status-badge\.is-awaiting::before\s*\{[\s\S]{0,140}left:\s*5px;[\s\S]{0,80}top:\s*5px;[\s\S]{0,80}width:\s*8px;/);
  assert.match(globalStyles, /\.desktop-pet-message-main \.desktop-pet-task-status-badge\.is-awaiting::after\s*\{[\s\S]{0,140}left:\s*10px;[\s\S]{0,80}top:\s*7px;[\s\S]{0,80}height:\s*5px;/);
  assert.match(globalStyles, /\.desktop-pet-message-main \.desktop-pet-task-status-badge\.is-running::after\s*\{[\s\S]{0,100}inset:\s*6px;[\s\S]{0,80}border-width:\s*2px;/);
  assert.match(globalStyles, /\.desktop-pet-message-card:hover \.desktop-pet-message-reply[\s\S]*?opacity:\s*1;/);
  assert.match(globalStyles, /\.desktop-pet-message-card:hover \.desktop-pet-message-main \.desktop-pet-task-status-badge[\s\S]*?opacity:\s*0;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-panel-window\.has-bubble \.desktop-pet-status-panel\s*\{[\s\S]{0,160}min-height:\s*auto;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-panel-window\.has-bubble \.desktop-pet-status-panel\s*\{[\s\S]{0,220}max-height:\s*calc\(100% - 20px\);/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-panel-window\.has-bubble \.desktop-pet-status-panel\s*\{[\s\S]{0,260}box-shadow:[\s\S]{0,120}0 8px 20px rgba\(47,\s*88,\s*96,\s*0\.06\)/);
  assert.match(globalStyles, /\.desktop-pet-status-panel\s*\{[\s\S]{0,120}gap:\s*6px;[\s\S]{0,80}padding-top:\s*7px;[\s\S]{0,80}padding-bottom:\s*9px;/);
  assert.match(globalStyles, /\.desktop-pet-status-panel \.desktop-pet-task-head\s*\{[\s\S]{0,120}grid-template-columns:\s*minmax\(0,\s*1fr\) 32px;[\s\S]{0,80}min-height:\s*24px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-pet-window\.is-edge-dock-right\.is-edge-dock-bottom \.desktop-pet-unread-badges\s*\{[\s\S]{0,160}left:\s*calc\(var\(--desktop-pet-button-left\) \+ 76px\);/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-pet-window\.is-edge-dock-right\.is-edge-dock-bottom \.desktop-pet-unread-badges\s*\{[\s\S]{0,220}top:\s*calc\(var\(--desktop-pet-button-top\) - 8px\);/);
  assert.match(desktopPet, /className=\{`desktop-pet-message-stack\$\{replyingChatId \? " is-replying" : ""\}`\}/);
  assert.match(desktopPet, /const isReplying = replyingChatId === message\.chatId;/);
  assert.match(desktopPet, /className=\{`desktop-pet-message-card is-\$\{cardStatus\}\$\{message\.unread \? " is-unread" : ""\}\$\{isReplying \? " is-replying" : ""\}`\}/);
  assert.match(globalStyles, /\.desktop-pet-message-stack\.is-replying\s*\{[\s\S]{0,180}max-height:\s*176px;/);
  assert.match(globalStyles, /\.desktop-pet-message-card\.is-replying\s*\{[\s\S]{0,180}min-height:\s*92px;/);
  assert.match(globalStyles, /\.desktop-pet-message-card\.is-replying\s*\{[\s\S]{0,180}padding:\s*10px 12px 8px 14px;/);
  assert.match(globalStyles, /\.desktop-pet-message-reply-box\s*\{[\s\S]{0,180}margin-top:\s*4px;/);
  assert.match(globalStyles, /\.desktop-pet-message-reply-input\s*\{[\s\S]{0,100}grid-column:\s*1;/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-message-reply-box\s*\{[\s\S]{0,180}margin-right:\s*-/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-message-latest/);
  assert.match(globalStyles, /--desktop-pet-stage-shadow:\s*none;/);
  assert.doesNotMatch(globalStyles, /--desktop-pet-stage-shadow:\s*radial-gradient/);
  assert.match(globalStyles, /\.desktop-pet-stage\s*\{[\s\S]{0,120}display:\s*none;/);
  assert.match(globalStyles, /\.desktop-pet-stage::before,\s*\.desktop-pet-stage::after\s*\{[\s\S]{0,80}content:\s*none;/);
  assert.doesNotMatch(globalStyles, /desktop-pet-stage-glow/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-status-fab/);
  assert.doesNotMatch(desktopPet, /desktop-pet-status-pill/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-status-pill/);
  assert.doesNotMatch(globalStyles, /--desktop-pet-status-pill-/);
  assert.match(globalStyles, /\.desktop-pet-message-stack\s*\{[\s\S]{0,180}display:\s*flex;[\s\S]{0,120}flex-direction:\s*column;/);
});

test("desktop pet panels do not render the header avatar icon in any state", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );
  const globalStyles = readRendererStyles();

  assert.doesNotMatch(desktopPet, /desktop-pet-task-avatar/);
  assert.doesNotMatch(desktopPet, /desktop-pet-task-avatar-mark/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-task-avatar/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-task-avatar-mark/);
  assert.match(globalStyles, /\.desktop-pet-task-head\s*\{[\s\S]{0,160}grid-template-columns:\s*minmax\(0,\s*1fr\) 32px;/);
  assert.match(globalStyles, /\.desktop-pet-status-panel \.desktop-pet-task-head\s*\{[\s\S]{0,120}grid-template-columns:\s*minmax\(0,\s*1fr\) 32px;/);
});

test("desktop pet keeps the press-time window anchor while dragging", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );

  assert.match(desktopPet, /type DesktopPetDragAnchorMode =/);
  assert.match(desktopPet, /const \[dragAnchorMode, setDragAnchorMode\] = useState<DesktopPetDragAnchorMode>\(null\)/);
  assert.match(desktopPet, /function resolveCurrentDragAnchorMode\(\)[\s\S]{0,360}return "bubble";/);
  assert.match(desktopPet, /setDragAnchorMode\(resolveCurrentDragAnchorMode\(\)\)/);
  assert.match(desktopPet, /const activeDragAnchorMode = isDragging \? dragAnchorMode : null;/);
  assert.match(desktopPet, /showTaskPanel \|\|[\s\S]{0,80}activeDragAnchorMode === "task-list" \|\|[\s\S]{0,80}activeDragAnchorMode === "task-list-compact"/);
  assert.match(desktopPet, /showStatusPanel \|\| activeDragAnchorMode === "bubble"/);
}
);

test("desktop pet active task panel lists all agent tasks and opens chat rows", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );
  const desktopPetController = readSourceFile("src", "main", "desktop-pet-controller.ts");
  const mainProcess = readMainProcessRuntimeSource();
  const petRuntime = readSourceFile("src", "main", "assistant", "pet", "runtime.ts");
  const desktopPetHandlers = readSourceFile("src", "main", "ipc", "desktop-pet-handlers.ts");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = readSharedContractsSource();
  const globalStyles = readRendererStyles();

  assert.match(contracts, /interface DesktopPetTaskItem/);
  assert.match(contracts, /activeTasks:\s*DesktopPetTaskItem\[\]/);
  assert.match(contracts, /openTaskChat:\s*\(input:\s*\{ agentKey: string; chatId: string \}\)/);
  assert.match(desktopPetController, /createDesktopPetActiveTasksFromNavigationSnapshot/);
  assert.match(desktopPetController, /chat\.hasPendingAwaiting \? "awaiting" : "running"/);
  assert.match(desktopPetController, /t\("desktopPet\.task\.untitled"\)/);
  assert.match(desktopPetController, /left\.status === "awaiting" \? -1 : 1/);
  assert.match(petRuntime, /state\.assistantNavigationStatusClient\?\.getSnapshot\(\)/);
  assert.match(mainProcess, /function emitAssistantNavigationAgentsChanged[\s\S]*?refreshDesktopPetState\(\);/);
  assert.match(mainProcess, /openDesktopPetTaskChat/);
  assert.match(desktopPetHandlers, /desktopPet\.openTaskChat/);
  assert.match(preload, /openTaskChat: \(input\) => ipcRenderer\.invoke\("desktopPet\.openTaskChat", input\)/);
  assert.match(desktopPet, /DESKTOP_PET_TASK_VISIBLE_LIMIT = 2/);
  assert.match(desktopPet, /const hasTaskPanelContent = activeTasks\.length > 0 && !hasHistoryMessages;/);
  assert.match(desktopPet, /const shouldShowTaskPanel = !isDragging && isWidgetExpanded && hasTaskPanelContent;/);
  assert.match(desktopPet, /const showTaskPanel = isPanelWindow && shouldShowTaskPanel;/);
  assert.match(desktopPet, /const shouldShowPreviewPanel = !isDragging && isWidgetExpanded && !hasHistoryMessages && !shouldShowTaskPanel && Boolean\(previewPanel && previewPanel\.expanded && !isDonePreviewPanel\);/);
  assert.match(desktopPet, /const canShowStatusPanel =[\s\S]{0,220}\(hasHistoryMessages \|\| displayStatus !== "idle"\);/);
  assert.match(desktopPet, /if \(!isWidgetExpanded && \(hasTaskPanelContent \|\| canShowStatusPanel \|\| hasHistoryMessages\)\) \{[\s\S]{0,80}setIsWidgetExpanded\(true\);/);
  assert.match(desktopPet, /aria-label=\{t\("desktopPet\.message\.collapse"\)\}/);
  assert.match(desktopPet, /desktop-pet-task-panel/);
  assert.match(desktopPet, /desktopPet\.openTaskChat\(\{/);
  assert.match(globalStyles, /\.desktop-pet-task-panel/);
  assert.match(globalStyles, /\.desktop-pet-issue-card/);
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
  assert.match(globalStyles, /\.desktop-pet-root\.has-state-animation\.is-drag-mirror \.desktop-pet-state-sprite\s*\{[\s\S]{0,120}transform:\s*scaleX\(-1\);/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-moving-left\.is-drag-mirror:not\(\.has-state-animation\) \.desktop-pet-image\s*\{[\s\S]{0,120}animation-name:\s*desktop-pet-dragging-mirror;/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.is-moving-left\.is-drag-mirror \.desktop-pet-image\s*\{[\s\S]{0,120}animation-name:\s*desktop-pet-dragging-mirror;/);
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
  const cutejPetManifest = readSourceFile("brands", "cutej", "desktop-pet", "pet.json");
  const globalStyles = readRendererStyles();
  const mainProcess = readMainProcessRuntimeSource();
  const petRuntime = readSourceFile("src", "main", "assistant", "pet", "runtime.ts");
  const desktopPetWindow = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "pet", "window.ts"),
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
  assert.doesNotMatch(desktopPet, /const \[isHovering, setIsHovering\] = useState\(false\)/);
  assert.doesNotMatch(desktopPet, /const \[isKeyboardFocused, setIsKeyboardFocused\] = useState\(false\)/);
  assert.match(desktopPet, /const \[activeSignature, setActiveSignature\] = useState<ActiveDesktopPetSignature \| null>\(null\)/);
  assert.match(desktopPet, /pointIntersectsVisiblePetArea/);
  assert.match(desktopPet, /pointIntersectsElement\("\.desktop-pet-image"/);
  assert.match(desktopPet, /window\.addEventListener\("mousemove", handleWindowMouseMove\)/);
  assert.match(desktopPet, /desktopPet\.setMouseInteractive\(interactive\)/);
  assert.match(desktopPet, /typeof window\.electronAPI\.desktopPet\.onSignatureRequested === "function"/);
  assert.match(desktopPet, /desktopPet\.onSignatureRequested\(\(signatureId\) => \{[\s\S]{0,120}startSignature\(signatureId,\s*"manual"\);/);
  assert.match(desktopPet, /if \(trigger !== "manual" && currentStatus !== "idle"\) \{[\s\S]{0,80}return;/);
  assert.match(desktopPet, /function shouldInterruptSignature\(nextState: DesktopPetState\)[\s\S]{0,360}currentSignature\?\.trigger === "manual"[\s\S]{0,80}return false;/);
  assert.match(desktopPetVisual, /if \(input\.isDragging\)[\s\S]{0,120}return input\.dragDirection \|\| input\.hasDragMovement \? "moving-left" : "dragging"/);
  assert.match(contracts, /dragMoved\?:\s*boolean;/);
  assert.match(desktopPet, /const hasDragMovement = isDragging && \(Boolean\(petState\.dragMoved\) \|\| Boolean\(effectiveDragDirection\)\);/);
  assert.match(desktopPet, /hasDragMovement,/);
  assert.match(petRuntime, /dragMoved:\s*desktopPetDragController\.hasDragMovement\(\)/);
  assert.match(desktopPet, /window\.addEventListener\("pointermove", handleWindowPointerMove\)/);
  assert.match(desktopPet, /shouldShowSignatureSpriteAnimation[\s\S]{0,220}activeSignature\.assetPath/);
  assert.match(sharedDesktopPet, /export function resolveDesktopPetSignatureActions/);
  assert.match(desktopPet, /resolveDesktopPetSignatureActions\(\s*appearanceIdRef\.current/);
  assert.match(desktopPet, /getDesktopPetSpriteAssetBasePath\(appearanceId\)/);
  assert.match(desktopPet, /deriveDesktopPetVisualStatus\(\{/);
  assert.match(desktopPetVisual, /input\.displayStatus === "awaiting"[\s\S]{0,80}return "awaiting"/);
  assert.match(desktopPetVisual, /input\.hasActiveSignature && input\.activeSignatureTrigger === "manual"[\s\S]{0,80}return "signature"/);
  assert.match(desktopPetVisual, /input\.displayStatus === "running" && input\.isReviewing[\s\S]{0,80}return "review"/);
  assert.match(desktopPetVisual, /input\.displayStatus === "running"[\s\S]{0,80}return "running"/);
  assert.match(desktopPetVisual, /input\.displayStatus === "error"[\s\S]{0,80}return "failed"/);
  assert.match(desktopPetVisual, /input\.activeStandardAction === "jumping"[\s\S]{0,80}return "jumping"/);
  assert.doesNotMatch(desktopPetVisual, /isHovering/);
  assert.doesNotMatch(desktopPetVisual, /isKeyboardFocused/);
  assert.doesNotMatch(desktopPetVisual, /return "hover"/);
  assert.doesNotMatch(desktopPetVisual, /return "thinking"/);
  assert.doesNotMatch(desktopPetVisual, /return "message"/);
  assert.doesNotMatch(desktopPetVisual, /hasMessageReaction/);
  assert.match(desktopPetVisual, /input\.hasActiveSignature[\s\S]{0,80}return "signature"/);
  assert.doesNotMatch(desktopPet, /canShowHoverReaction/);
  assert.match(desktopPet, /hasMessageReaction \|\|[\s\S]{0,80}hasHistoryMessages[\s\S]{0,80}shouldShowTaskPanel/);
  assert.match(desktopPet, /function formatMessageCardPreview\(\s*message: DesktopPetMessageItem,[\s\S]{0,120}isThinking: boolean,[\s\S]{0,120}draftText: string,[\s\S]{0,120}t: DesktopPetTranslate/);
  assert.match(desktopPet, /t\("desktopPet\.replyPreview", \{ text: draftPreview \}\)/);
  assert.match(desktopPet, /t\("desktopPet\.status\.thinking"\)/);
  assert.match(desktopPet, /function resolveDesktopPetVisualAsset/);
  assert.match(desktopPet, /getDesktopPetStateAsset\(customAppearance\?\.states, status\)/);
  assert.doesNotMatch(desktopPet, /getDesktopPetLegacyStatusAssetName/);
  assert.doesNotMatch(desktopPet, /task-run-left\.webp/);
  assert.match(desktopPet, /const visualAsset = useMemo\(\s*\(\) => resolveDesktopPetVisualAsset\(petState, appearanceId, visualStatus\)/);
  assert.match(desktopPet, /DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH = 30/);
  assert.match(desktopPet, /formatStatusPanelPreview\(displayStatus,\s*hasMessageReaction,\s*bubbleText/);
  assert.match(desktopPet, /const statusBubbleText = displayStatus === "idle"[\s\S]{0,140}: petState\.hint\.trim\(\) \|\| formatPetHint\(displayStatus,\s*t\);/);
  assert.match(desktopPet, /const shouldShowPreviewPanel = !isDragging && isWidgetExpanded && !hasHistoryMessages && !shouldShowTaskPanel && Boolean\(previewPanel && previewPanel\.expanded && !isDonePreviewPanel\);/);
  assert.match(desktopPet, /const statusPanelTitle = hasHistoryMessages[\s\S]{0,80}\? t\("desktopPet\.panel\.overview"\)/);
  assert.match(desktopPet, /preview:\s*formatPreviewPanelSummary\(previewPanel,\s*t\)/);
  assert.doesNotMatch(desktopPet, /<strong>\{previewTitle \|\| "运行中"\}<\/strong>/);
  assert.doesNotMatch(desktopPet, /<span>\{showPreviewSummary \? previewSummary : "运行预览"\}<\/span>/);
  assert.match(desktopPet, /const showItemDetail = shouldShowSecondaryPreview\(itemTitle, itemDetailPreview\);/);
  assert.match(desktopPet, /handlePreviewClick[\s\S]{0,180}previewPanel\.status === "done"[\s\S]{0,80}return;/);
  assert.match(desktopPet, /function handleDismissMessage\(message: DesktopPetMessageItem\)[\s\S]{0,960}desktopPet\.dismissPreview\(\)/);
  assert.match(desktopPet, /handlePreviewClick[\s\S]{0,360}desktopPet\.setPreviewExpanded\(!previewPanel\.expanded\)/);
  assert.match(desktopPet, /aria-label=\{previewPanel\.expanded \? t\("desktopPet\.collapsePreview"\) : t\("desktopPet\.expandPreview"\)\}/);
  assert.match(desktopPet, /messagePreview \|\| t\("desktopPet\.newMessage"\)/);
  assert.match(desktopPet, /const previewPanel = petState\.previewPanel\?\.visible \? petState\.previewPanel : null/);
  assert.match(desktopPet, /const previewHistoryMessage: DesktopPetMessageItem \| null =/);
  assert.match(desktopPet, /function getVisibleDesktopPetMessages\(input: \{/);
  assert.match(desktopPet, /messages: petMessages,[\s\S]{0,80}cachedMessages: messageCache,[\s\S]{0,80}previewHistoryMessage/);
  assert.match(desktopPet, /const hasHistoryMessages = visibleMessages\.length > 0;/);
  assert.match(desktopPet, /setMessageCache\(\(current\) => mergeDesktopPetMessageLists\(\[previewHistoryMessage\], current\)\)/);
  assert.match(desktopPet, /const hasCollapsedPreviewPanel = Boolean\(previewPanel && !previewPanel\.expanded && !isDonePreviewPanel && !hasHistoryMessages\);/);
  assert.match(desktopPet, /const shouldShowPreviewPanel = !isDragging && isWidgetExpanded && !hasHistoryMessages && !shouldShowTaskPanel && Boolean\(previewPanel && previewPanel\.expanded && !isDonePreviewPanel\);/);
  assert.match(desktopPet, /const showMessageBadgeOnly = hasMessageReaction && !hasHistoryMessages && !shouldShowTaskPanel && !shouldShowPreviewPanel && !isDonePreviewPanel;/);
  assert.match(desktopPet, /const canShowStatusPanel =[\s\S]{0,220}\(hasHistoryMessages \|\| displayStatus !== "idle"\);/);
  assert.match(desktopPet, /const shouldShowStatusPanel = canShowStatusPanel && isWidgetExpanded;/);
  assert.match(desktopPet, /function handleReplySubmit\(message: DesktopPetMessageItem\)/);
  assert.match(desktopPet, /desktopPet\s*\.\s*replyMessage\(\{\s*chatId:\s*message\.chatId,\s*agentKey:\s*message\.agentKey,\s*message:\s*text\s*\}\)/);
  assert.match(desktopPet, /function handleReplySubmitClick\(event: ReactMouseEvent<HTMLButtonElement>, message: DesktopPetMessageItem\)/);
  assert.match(desktopPet, /function handleOpenMessageClick\(event: ReactMouseEvent<HTMLButtonElement>, message: DesktopPetMessageItem\)/);
  assert.match(desktopPet, /formatMessageCardPreview\(message, isThinking, replyDraftPreview, t\)/);
  assert.match(desktopPet, /visibleMessages\.map\(\(message\) =>/);
  assert.match(desktopPet, /className="desktop-pet-message-meta"/);
  assert.doesNotMatch(desktopPet, /className="desktop-pet-message-latest">最新<\/span>/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-message-latest\s*\{/);
  assert.match(globalStyles, /\.desktop-pet-message-meta\s*\{[\s\S]{0,120}position:\s*absolute;/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-message-dismiss\s*\{[\s\S]{0,120}top:\s*-/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-message-dismiss\s*\{[\s\S]{0,160}left:\s*-/);
  assert.match(desktopPet, /handleDismissMessage\(message\)/);
  assert.match(desktopPet, /handleReplyToggleClick\(event, message\.chatId\)/);
  assert.doesNotMatch(desktopPet, /handlePreviewReplySubmit/);
  assert.doesNotMatch(desktopPet, /desktop-pet-preview-reply-row/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.has-preview-done/);
  assert.doesNotMatch(globalStyles, /desktop-pet-preview-reply-row/);
  assert.match(desktopPet, /desktop-pet-task-head-action/);
  assert.doesNotMatch(desktopPet, /onPointerEnter=\{handlePointerEnter\}/);
  assert.doesNotMatch(desktopPet, /onPointerLeave=\{handlePointerLeave\}/);
  assert.doesNotMatch(desktopPet, /onFocus=\{handleButtonFocus\}/);
  assert.doesNotMatch(desktopPet, /onBlur=\{handleButtonBlur\}/);
  assert.doesNotMatch(desktopPet, /matches\(":focus-visible"\)/);
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
  assert.match(cutejPetManifest, /"id":\s*"work-hard"/);
  assert.match(cutejPetManifest, /"label":\s*"努力工作"/);
  assert.match(cutejPetManifest, /"path":\s*"signature\/work-hard-v3\.webp"/);
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
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.is-hover\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-signature\s+\.desktop-pet-image/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.is-signature\s+\.desktop-pet-button::before/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.is-signature\s+\.desktop-pet-button::after/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-signature\.has-signature-aura\s+\.desktop-pet-button::before/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-signature\.has-signature-aura\s+\.desktop-pet-button::after/);
  assert.match(desktopPet, /import \{ BRAND_ID, PRODUCT_NAME \} from "..\/..\/..\/shared\/brand";/);
  assert.match(desktopPet, /const hasSignatureAura = BRAND_ID === "cutej";/);
  assert.match(desktopPet, /hasSignatureAura && visualStatus === "signature" \? "has-signature-aura" : ""/);
  assert.match(globalStyles, /\.desktop-pet-signature-sprite\s*\{[\s\S]{0,260}background-size:\s*calc\(96px \* var\(--desktop-pet-signature-frames,\s*30\)\) 104px;/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-signature-animation\s+\.desktop-pet-signature-sprite\s*\{[\s\S]{0,220}animation:\s*desktop-pet-signature-frames var\(--desktop-pet-signature-duration,\s*5200ms\) steps\(var\(--desktop-pet-signature-frames,\s*30\),\s*end\) 1 both;/);
  assert.match(globalStyles, /@keyframes desktop-pet-signature-frames\s*\{[\s\S]*?background-position:\s*calc\(-96px \* var\(--desktop-pet-signature-frames,\s*30\)\) 0;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-awaiting\s+\.desktop-pet-image[\s\S]{0,120}desktop-pet-awaiting/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-dragging\s+\.desktop-pet-image\s*\{[\s\S]{0,120}animation:\s*none;/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root\.is-dragging\.has-state-animation\s+\.desktop-pet-state-sprite\s*\{[\s\S]{0,160}animation:\s*none;/);
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
  assert.doesNotMatch(globalStyles, /@keyframes desktop-pet-hover-reaction/);
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
  assert.match(petRuntime, /getDesktopPetContextMenuItems\(\s*state\.desktopPetState\.appearanceId,\s*state\.desktopPetState\.signature \?\? \[\]\s*\)/);
  assert.match(petRuntime, /desktopPet\.signatureRequested", signatureId/);
  assert.match(mainProcess, /function setDesktopPetWindowMouseInteractive\(interactive: boolean\)/);
  assert.match(petRuntime, /setIgnoreMouseEvents\(!interactive, \{ forward: true \}\)/);
  assert.match(petRuntime, /options\.platform === "win32"[\s\S]{0,220}setIgnoreMouseEvents\(false\)/);
  assert.match(desktopPetWindow, /const isWindows = options\.platform === "win32";/);
  assert.match(desktopPetWindow, /\.\.\.\(isWindows \? \{ thickFrame: false \} : \{\}\)/);
  assert.match(
    desktopPetWindow,
    /export function applyDesktopPetBrowserWindowLayering\([\s\S]*?platform === "darwin"[\s\S]{0,180}setAlwaysOnTop\(true, "screen-saver"\);[\s\S]{0,220}setVisibleOnAllWorkspaces\(true,\s*\{[\s\S]{0,160}visibleOnFullScreen:\s*true,[\s\S]{0,180}skipTransformProcessType:\s*true[\s\S]*?\}\);[\s\S]{0,120}platform === "win32"[\s\S]{0,120}setAlwaysOnTop\(true\);/
  );
  assert.match(desktopPetWindow, /applyDesktopPetBrowserWindowLayering\(win, options\.platform\);/);
  assert.match(petRuntime, /import \{ applyDesktopPetBrowserWindowLayering, createDesktopPetBrowserWindow \} from "\.\/window";/);
  assert.match(
    petRuntime,
    /function restoreWindowLayering\(\)[\s\S]{0,320}\[state\.desktopPetWindow, state\.desktopPetPanelWindow\][\s\S]{0,260}applyDesktopPetBrowserWindowLayering\(targetWindow, options\.platform,[\s\S]{0,160}preserveProcessType:\s*true,[\s\S]{0,80}moveTop:\s*true/
  );
  assert.match(petRuntime, /function showWindow\(\)[\s\S]{0,160}applyPanelWindowBounds\(\);[\s\S]{0,80}restoreWindowLayering\(\);/);
  assert.match(petRuntime, /restoreWindowLayering,/);
  assert.match(desktopPetHandlers, /desktopPet\.setMouseInteractive/);
  assert.match(desktopPetHandlers, /desktopPet\.dismissPreview/);
  assert.doesNotMatch(mainProcess, /desktopPet\.danceRequested/);
  assert.match(petRuntime, /desktopPet\.signatureRequested/);
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
  assert.match(viteConfig, /copyBrandRuntimeIconAssets\(\{[\s\S]{0,220}rendererOutputRoot/);
  assert.match(viteConfig, /name:\s*"brand-desktop-pet-assets"/);
  assert.match(viteConfig, /BRAND_DESKTOP_PET_URL_PREFIX = "\/desktop-pet\/"/);
  assert.match(viteConfig, /server\.middlewares\.use\(serveBrandDesktopPetAsset\)/);
  assert.match(viteConfig, /copyBrandDesktopPetAssets\(\{[\s\S]{0,260}rendererOutputRoot[\s\S]{0,120}"desktop-pet"/);
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
  const mainProcess = readMainProcessRuntimeSource();
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
  assert.match(ssoWebviewCompletionHandler, /t\("main\.ssoCookieExchangeNoAccessToken"\)/);
  assert.match(ssoWebviewCompletionHandler, /completeDesktopSsoCookieLogin\(app, accessToken\);[\s\S]{0,120}openConfiguredDesktopSsoSiteTokenBridge\(\)/);
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
  assert.match(sidebarSource, /const topToolItems = fixedToolItems\.filter\(\(item\) =>[\s\S]*?item\.to === "\/agents" \|\| item\.to === "\/archives" \|\| item\.to === "\/registries" \|\| item\.to === "\/market"/);
  assert.doesNotMatch(sidebarSource, /const middleToolItems = fixedToolItems\.filter/);
  assert.doesNotMatch(sidebarSource, /const settingsToolItems = fixedToolItems\.filter/);
  assert.match(sidebarSource, /const settingsToolItem = fixedToolItems\.find\(\(item\) => item\.to === "\/settings"\);/);
  assert.match(sidebarSource, /shouldRenderDesktopSsoAccount \? \([\s\S]*?\{renderAccountMenuUserItem\(\)\}[\s\S]*?sidebar-account-menu-divider[\s\S]*?\) : null/);
  assert.match(sidebarSource, /\{renderAccountMenuUserItem\(\)\}[\s\S]*?sidebar-account-menu-divider[\s\S]*?topToolItems\.map\(\(item\) => renderToolLink\(item\)\)[\s\S]*?sidebar-account-menu-divider[\s\S]*?renderToolLink\(helpToolItem,[\s\S]*?settingsToolItem \? renderToolLink\(settingsToolItem\) : null/);
  assert.match(sidebarSource, /className="sidebar-tool-menu-popover"/);
  assert.match(sidebarSource, /aria-label=\{desktopSsoActionLabel\}/);
  assert.match(sidebarSource, /aria-label=\{desktopSsoLogoutLabel\}/);
  assert.match(sidebarSource, /avatarUrl=\{desktopSsoStatus\.user\?\.avatarUrl\}/);
  assert.match(sidebarSource, /renderAccountMenuIcon\(desktopSsoStatus\?\.authenticated \? "login" : "logout"\)/);
  assert.match(sidebarSource, /<SidebarIllustration kind=\{kind\} \/>/);
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
  assert.match(globalStyles, /\.sidebar-account-menu \.sidebar-tool-menu-item:hover \.sidebar-link-icon,[\s\S]*?color:\s*#64748b;/);
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
  const embeddedSurfaceHosts = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx"
  );
  const sharedSso = readSourceFile("src", "shared", "sso.ts");
  const mainProcess = readMainProcessRuntimeSource();
  const windowManager = readSourceFile("src", "main", "window-manager.ts");
  const ssoHandlers = readSourceFile("src", "main", "ipc", "sso-handlers.ts");
  const ssoController = readSourceFile("src", "main", "sso-controller.ts");
  const oidcSso = readSourceFile("src", "main", "oidc-sso.ts");
  const ssoStartLoginHandler = ssoHandlers.slice(
    indexOfRequired(ssoHandlers, 'ipcMain.handle("sso.startLogin"'),
    indexOfRequired(ssoHandlers, 'ipcMain.handle("sso.cancelLogin"')
  );

  assert.match(sharedSso, /export const DESKTOP_SSO_WEBVIEW_PARTITION = `persist:\$\{STORAGE_NAMESPACE\}-sso`;/);
  assert.match(ssoController, /from "\.\.\/shared\/sso"/);
  assert.match(embeddedSurfaceHosts, /from "\.\.\/\.\.\/\.\.\/shared\/sso"/);
  assert.match(embeddedSurfaceHosts, /function resolveWebsiteSsoPartition\(item: EmbeddedSidebarItem\)[\s\S]{0,140}item\.kind === "website" \? DESKTOP_SSO_WEBVIEW_PARTITION : undefined/);
  assert.match(embeddedSurfaceHosts, /partition=\{resolveWebsiteSsoPartition\(item\)\}/);
  assert.match(copilotContracts, /partition\?: string;/);
  assert.match(copilotContracts, /userAgent\?: string;/);
  assert.match(externalWebviewPage, /partition\?: string;/);
  assert.match(externalWebviewPage, /userAgent\?: string;/);
  assert.match(externalWebviewPage, /partition: tab\.partition,/);
  assert.match(externalWebviewPage, /partition: options\.partition \?\? partition/);
  assert.match(externalWebviewPage, /const nextSurfaceKey = `\$\{title\}\\u0000\$\{url\}\\u0000\$\{partition \|\| ""\}`;/);
  assert.doesNotMatch(externalWebviewPage, /getRendererEmbeddedBrowserUserAgent/u);
  assert.doesNotMatch(pluginPage, /embedded-browser-user-agent/u);
  assert.match(pluginPage, /partition: `persist:\$\{STORAGE_NAMESPACE\}-service-\$\{pluginId \|\| "plugin"\}`/);
  assert.doesNotMatch(pluginPage, /DESKTOP_SSO_WEBVIEW_PARTITION/u);
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
  assert.match(externalWebviewPage, /partition: activeTab\?\.partition,[\s\S]{0,80}userAgent: activeTab\?\.userAgent/);
  assert.match(externalWebviewPage, /afterTabId: sourceTab\.id,[\s\S]{0,120}partition: sourceTab\.partition,[\s\S]{0,80}userAgent: sourceTab\.userAgent/);
});

test("embedded browser address entry remains editable while preserving edits", () => {
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
  assert.match(externalWebviewPage, /const \[addressInputUnlocked, setAddressInputUnlocked\] = useState\(false\)/u);
  assert.match(externalWebviewPage, /useEffect\(\(\) => \{[\s\S]{0,80}setAddressInputUnlocked\(false\);[\s\S]{0,80}\}, \[activeTab\?\.id\]\);/u);
  assert.match(externalWebviewPage, /if \(addressInputUnlocked\) \{[\s\S]{0,80}return;[\s\S]{0,80}\}[\s\S]{0,120}setAddressInputValue\(getEditableAddressInputValue\(activeTab\?\.currentUrl \?\? url\)\);/u);
  assert.match(externalWebviewPage, /const handleAddressInputFocus = \(event: ReactFocusEvent<HTMLInputElement>\) => \{[\s\S]{0,160}setAddressInputUnlocked\(true\);[\s\S]{0,80}event\.currentTarget\.select\(\);/u);
  assert.match(externalWebviewPage, /onChange=\{\(event\) => \{[\s\S]{0,80}setAddressInputValue\(event\.target\.value\);[\s\S]{0,40}\}\}/u);
  assert.match(externalWebviewPage, /if \(event\.key !== "Enter"\) \{/u);
  assert.match(externalWebviewPage, /onFocus=\{handleAddressInputFocus\}/u);
  assert.match(externalWebviewPage, /onBlur=\{\(\) => \{[\s\S]{0,80}setAddressInputUnlocked\(false\);[\s\S]{0,160}setAddressInputValue\(getEditableAddressInputValue\(activeTab\?\.currentUrl \?\? url\)\);/u);
  assert.doesNotMatch(externalWebviewPage, /readOnly=\{!addressInputUnlocked\}/u);
  assert.doesNotMatch(externalWebviewPage, /if \(!addressInputUnlocked\) \{[\s\S]{0,80}return;/u);
  assert.doesNotMatch(externalWebviewPage, /if \(!addressInputUnlocked \|\| event\.key !== "Enter"\) \{/u);
  assert.doesNotMatch(externalWebviewPage, /event\.detail < 3/u);
  assert.match(externalWebviewPage, /onClick=\{\(\) => openTab\(BLANK_EXTERNAL_WEBVIEW_URL,\s*""\)\}/u);
  assert.doesNotMatch(externalWebviewPage, /onClick=\{\(\) => openTab\(url,\s*title\)\}/u);
});

test("embedded browser closing the final tab leaves a blank page", () => {
  const externalWebviewPage = readSourceFile(
    "src",
    "renderer",
    "pages",
    "external-webview",
    "ExternalWebviewPage.tsx"
  );

  assert.match(externalWebviewPage, /function createBlankTab\(\)/u);
  assert.match(externalWebviewPage, /createTab\(BLANK_EXTERNAL_WEBVIEW_URL,\s*""\)/u);
  assert.match(externalWebviewPage, /if \(currentState\.tabs\.length <= 1\) \{[\s\S]{0,220}tabs: \[blankTab\],[\s\S]{0,80}activeTabId: blankTab\.id/u);
  assert.match(externalWebviewPage, /const canClose = true;/u);
  assert.doesNotMatch(externalWebviewPage, /embeddedError\("last_tab"/u);
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

test("websites and webapps settings use split workspace detail panes", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.tsx"),
    "utf8"
  );
  const settingsPageCss = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "settings", "SettingsPage.css"),
    "utf8"
  );

  assert.match(settingsPage, /settings\.websites\.addTitle/);
  assert.match(settingsPage, /settings\.websites\.addDescription/);
  assert.match(settingsPage, /WEBSITE_NEW_ID/);
  assert.match(settingsPage, /beginAddWebsiteItem/);
  assert.match(settingsPage, /creatingWebsite \? t\("settings\.websites\.addTitle"\) : selectedWebsite\?\.label/);
  assert.match(settingsPage, /case "websites"[\s\S]*className="control-center-shell web-settings-shell"[\s\S]*className="control-center-detail web-settings-detail"/);
  assert.match(settingsPage, /window\.electronAPI\.webs\.websites\.add/);
  assert.match(settingsPage, /window\.electronAPI\.webs\.websites\.update/);
  assert.match(settingsPage, /window\.electronAPI\.webs\.websites\.remove/);
  assert.match(settingsPage, /settings\.websites\.agentEnhancement/);
  assert.match(settingsPage, /settings\.webapps\.runtimeTitle/);
  assert.match(settingsPage, /settings\.webapps\.manifestTitle/);
  assert.match(settingsPage, /settings\.webapps\.logsTitle/);
  assert.match(settingsPage, /case "webapps"[\s\S]*handleWebappRuntimeAction\("start", selectedWebapp\)/);
  assert.match(settingsPage, /case "webapps"[\s\S]*handleWebappRuntimeAction\("stop", selectedWebapp\)/);
  assert.match(settingsPage, /case "webapps"[\s\S]*handleWebappRuntimeAction\("restart", selectedWebapp\)/);
  assert.match(settingsPage, /case "webapps"[\s\S]*handleReadWebappLog\(selectedWebapp, "main"\)/);
  assert.match(settingsPage, /selectedWebapp\.removable !== false/);
  assert.doesNotMatch(settingsPage, /editingWebsiteId/);
  assert.doesNotMatch(settingsPage, /handleUpdateWebsiteAgent/);
  assert.match(settingsPageCss, /\.settings-page \.web-settings-page\s*\{/u);
  assert.match(settingsPageCss, /\.settings-page \.web-settings-shell\s*\{/u);
  assert.match(settingsPageCss, /\.settings-page \.web-settings-catalog\s*\{/u);
  assert.match(settingsPageCss, /\.settings-page \.web-detail-form \.settings-control-row\s*\{/u);
  assert.match(settingsPageCss, /\.settings-page \.web-detail-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u);
  assert.match(settingsPageCss, /\.settings-page \.web-log-preview\s*\{/u);
  assert.match(settingsPage, /desktop-pet-agent-select-wrap/);
});

test("built-in browser surface remains mounted after leaving the chrome route except empty web surface", () => {
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
  assert.match(appShellFile, /const shouldMountBuiltinBrowserSurface =[\s\S]*?location\.pathname === EMPTY_WEB_SURFACE_ROUTE[\s\S]*?\? false[\s\S]*?: builtinBrowserSurfaceMounted \|\| usesBuiltinBrowserSurface;/u);
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
  assert.match(externalWebviewStyles, /\.external-webview-page\.is-inactive-surface\s*\{[\s\S]*?visibility:\s*hidden;/u);
  assert.match(externalWebviewStyles, /\.external-webview-page\.is-inactive-surface\s*\{[\s\S]*?pointer-events:\s*none;/u);
  assert.match(externalWebviewStyles, /\.external-webview-page\.is-inactive-surface\s*\{[\s\S]*?app-region:\s*no-drag;/u);
  assert.match(externalWebviewStyles, /\.external-webview-page\.is-inactive-surface\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;/u);
  assert.match(
    externalWebviewStyles,
    /\.external-webview-page\.is-inactive-surface \.external-webview-browser-chrome\s*\{[\s\S]*?app-region:\s*no-drag;[\s\S]*?-webkit-app-region:\s*no-drag;/u
  );
});
