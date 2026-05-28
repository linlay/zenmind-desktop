import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readSourceFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
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
    readSourceFile("src", "shared", "contracts", "desktop-api.ts")
  ].join("\n");
}

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
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );

  assert.doesNotMatch(sidebarSource, /browserNavItem/);
  assert.doesNotMatch(sidebarSource, /BUILTIN_BROWSER_ROUTE/);
});

test("main agent webclient surface direct-loads active embed path", () => {
  const surfaceHosts = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx"
  );

  assert.match(surfaceHosts, /embedPath=\{pluginId === "agent-webclient" \? activeAgentWebclientRoute\?\.embedPath : undefined\}/);
  assert.match(surfaceHosts, /loadInitialEmbeddedUrlDirectly=\{pluginId === "agent-webclient" && Boolean\(activeAgentWebclientRoute\?\.embedPath\)\}/);
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
  const serviceHelpFunctionBody = controlCenter.match(
    /function openServiceHelp\(\n(?<signature>[\s\S]*?)\n\s*\) \{(?<body>[\s\S]*?)\n\s*\}\n\n\s*function openServiceDetail/
  )?.groups?.body;
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
  assert.match(appShell, /if \(!chatId\) \{[\s\S]{0,120}return `\$\{AGENT_WEBCLIENT_COPILOT_PATH\}\/\$\{encodeURIComponent\(agentKey\)\}`/);
  assert.match(appShell, /params\.set\("chatId", chatId\)/);
  assert.match(appShell, /return `\$\{AGENT_WEBCLIENT_COPILOT_PATH\}\/\$\{encodeURIComponent\(agentKey\)\}\?\$\{params\.toString\(\)\}`/);
  assert.doesNotMatch(appShell, /return `\/agent\/\$\{encodeURIComponent\(agentKey\)\}/);
  assert.match(appShell, /buildAgentWebclientCopilotPath\(openRequest, resolvedAgentKey\)/);
  assert.match(appShell, /embedPath=\{targetEmbedPath\}/);
  assert.match(sidebarSource, /sidebar-top-actions/);
  assert.match(sidebarSource, /sidebar-assistant-top-button/);
  assert.match(sidebarSource, /"打开 ZenMind 助手"/);
  assert.match(sidebarSource, /"关闭 ZenMind 助手"/);
  assert.match(sidebarSource, /"当前页面不可开启 ZenMind 助手"/);
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
  const collapsedMacTopActionButtonRule = globalStyles.match(
    /^\.app-shell\.is-mac-platform \.app-sidebar\.is-collapsed \.sidebar-top-actions \.app-sidebar-collapse-button\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body;
  const collapsedAssistantTopButtonRule = globalStyles.match(
    /^\.app-sidebar\.is-collapsed \.sidebar-top-actions \.sidebar-assistant-top-button\s*\{(?<body>[\s\S]*?)^\}/m
  )?.groups?.body;

  assert.match(appShell, /onToggleCollapsed=\{toggleSidebarCollapsed\}/);
  assert.match(appShell, /isMac=\{isMac\}/);
  assert.match(appShell, /isWindows=\{isWindows\}/);
  assert.match(appShell, /const renderedSidebarWidth = resolveRenderedSidebarWidth\(sidebarState\);/);
  assert.match(appShell, /const appShellStyle = \{[\s\S]*?"--app-sidebar-width": `\$\{renderedSidebarWidth\}px`[\s\S]*?\} as CSSProperties;/);
  assert.doesNotMatch(appShell, /className="app-sidebar-collapse-button"/);
  assert.doesNotMatch(appShell, /app-sidebar-drag-region/);
  assert.doesNotMatch(appShell, /is-sidebar-expanded/);
  assert.match(appShell, /className="app-sidebar-shell"/);
  assert.match(appShell, /className=\{\[[\s\S]*?"app-sidebar-resizer"/);
  assert.match(appShell, /role="separator"/);
  assert.match(appShell, /aria-orientation="vertical"/);
  assert.match(appShell, /aria-label="调整侧边栏宽度"/);
  assert.match(appShell, /onPointerDown=\{handleSidebarResizerPointerDown\}/);
  assert.match(appShell, /sidebarCollapsed \? "is-sidebar-collapsed" : ""/);
  assert.match(appShell, /isSidebarResizing \? "is-sidebar-resizing" : ""/);
  assert.match(sidebarSource, /onToggleCollapsed\?:\s*\(\)\s*=>\s*void;/);
  assert.match(sidebarSource, /type SidebarCollapseToggleVariant = "compact" \| "nav";/);
  assert.match(sidebarSource, /className=\{\[\s*"app-sidebar-collapse-button",[\s\S]*?"is-compact" : "is-nav"/);
  assert.match(sidebarSource, /aria-expanded=\{!isCollapsed\}/);
  assert.match(sidebarSource, /app-sidebar-collapse-button-icon-panel/);
  assert.match(sidebarSource, /app-sidebar-collapse-button-icon-chevron/);
  assert.match(sidebarSource, /<SidebarCollapseToggleIcon isCollapsed=\{isCollapsed\} \/>/);
  assert.match(sidebarSource, /<div className="sidebar-chrome">/);
  assert.match(sidebarSource, /<div className="sidebar-chrome-drag-region" aria-hidden="true" \/>/);
  assert.match(sidebarSource, /className=\{chromeToolbarClassName\}/);
  assert.match(sidebarSource, /<div className="sidebar-top-actions">/);
  assert.doesNotMatch(sidebarSource, /sidebar-collapsed-toggle-slot/);
  assert.doesNotMatch(sidebarSource, /sidebar-collapse-control/);
  assert.ok(appSidebarRule, "missing .app-sidebar rule");
  assert.match(appSidebarRule, /app-region:\s*drag;/);
  assert.match(appSidebarRule, /-webkit-app-region:\s*drag;/);
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
  assert.match(globalStyles, /\.app-shell\.is-mac-platform\.is-sidebar-collapsed \.app-sidebar-resizer\s*\{[\s\S]*?flex:\s*0 0 0;/);
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
  assert.match(globalStyles, /\.app-sidebar-collapse-button-icon-panel\s*\{[\s\S]*?width:\s*16px;/);
  assert.match(globalStyles, /\.app-sidebar a,\s*[\s\S]*?\.app-sidebar button\s*\{[\s\S]*?app-region:\s*no-drag;/);
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
    /<Popover[\s\S]{0,160}placement="top-start"[\s\S]{0,160}content=\{renderToolMenu\(\)\}[\s\S]{0,160}open=\{toolMenuOpen\}[\s\S]{0,160}onOpenChange=\{setToolMenuOpen\}/
  );
  assert.doesNotMatch(sidebarSource, /toolMenuPosition/);
  assert.doesNotMatch(sidebarSource, /toolMenuPanelRef/);
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
  assert.match(sidebarSource, /websitesGroupNavItemBase[\s\S]*?orderKey:\s*"group:websites"[\s\S]*?entryType:\s*"websites"/);
  assert.match(sidebarSource, /label:\s*t\("nav\.taskBoard"\)/);
  assert.match(sidebarSource, /label:\s*t\("nav\.assistants"\)/);
  assert.match(sidebarSource, /label:\s*t\("nav\.embeddedWebsites"\)/);
  assert.match(sidebarSource, /SIDEBAR_GROUP_STATE_STORAGE_KEY/);
  assert.doesNotMatch(sidebarSource, /assistantHomeNavItem/);
  assert.doesNotMatch(sidebarSource, /智能助理首页|智能助手首页/);
  assert.match(sidebarSource, /createAgentRoute\(agent\.agentKey\)/);
  assert.match(sidebarSource, /createAgentChatRoute\(chat\.agentKey/);
  assert.match(sidebarSource, /createAgentNewChatRoute\(agent\.agentKey\)/);
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
  assert.match(sidebarSource, /currentPathname\.startsWith\("\/agent\/"\)/);
  assert.match(sidebarSource, /pendingPath\?\.startsWith\("\/agent\/"\)/);
  assert.doesNotMatch(sidebarSource, /newChat=1/);
  assert.doesNotMatch(sidebarSource, /nonce=/);
  assert.doesNotMatch(sidebarSource, /AssistantHistoryState/);
  assert.doesNotMatch(sidebarSource, /assistantHistory/);
  assert.doesNotMatch(sidebarSource, /renderAssistantHistory/);
  assert.match(sidebarSource, /const recentChats = getAssistantNavAgentRecentChats\(agent\)\.slice\(0, 5\);/);
  assert.match(sidebarSource, /const chatCount = Math\.max\(0, getAssistantNavAgentNonNegativeInteger\(agent\.chatCount\), recentChats\.length\);/);
  assert.match(sidebarSource, /recentChats\.length > 0 \? \(/);
  assert.match(sidebarSource, /\) : chatCount === 0 \? \(\s*<div className="status-line">暂无会话<\/div>/);
  assert.match(sidebarSource, /chatCount > recentChats\.length \? \(/);
  assert.match(sidebarSource, /requestNavigate\(createAgentHistoryRoute\(agent\.agentKey\)\)/);
  assert.match(sidebarSource, /<div className="status-line">暂无会话<\/div>/);
  assert.doesNotMatch(sidebarSource, /暂无相关会话/);
  assert.doesNotMatch(sidebarSource, /Math\.max\(agent\.chatCount, recentChats\.length\) > 5/);
  assert.match(sidebarSource, /renderStatusBadges/);
  assert.match(sidebarSource, /summarizeAgentStatus\(assistantNavAgents\)/);
  assert.match(sidebarSource, /assistant-worker-collapse worker-collapse/);
  assert.match(sidebarSource, /className="assistant-worker-collapse-item"/);
  assert.match(sidebarSource, /className="assistant-worker-header-text"/);
  assert.match(sidebarSource, /<AgentIcon[\s\S]*?icon=\{agent\.icon\}[\s\S]*?className="worker-panel-icon"[\s\S]*?size=\{32\}[\s\S]*?type="agent"[\s\S]*?\/>/);
  assert.doesNotMatch(sidebarSource, /renderAssistantAgentIcon/);
  assert.doesNotMatch(sidebarSource, /SidebarIllustration kind="agent"/);
  assert.match(sidebarSource, /worker-panel-header-body/);
  assert.match(sidebarSource, /worker-panel-role/);
  assert.match(sidebarSource, /worker-panel-preview/);
  assert.match(sidebarSource, /worker-chat-item-head/);
  assert.match(sidebarSource, /worker-chat-name/);
  assert.match(sidebarSource, /worker-panel-time-label/);
  assert.match(sidebarSource, /<Tooltip content="全部已读">/);
  assert.match(sidebarSource, /<Tooltip content="新建对话">/);
  assert.match(sidebarSource, /查看更多（共/);
  assert.match(sidebarSource, /等待审批/);
  assert.match(sidebarSource, /exportChat/);
  assert.match(sidebarSource, /renameChat/);
  assert.match(sidebarSource, /archiveChat/);
  assert.match(sidebarSource, /deleteChat/);
  assert.match(sidebarSource, /<span>删除<\/span>/);
  assert.match(sidebarSource, /fixedToolRowsBase[\s\S]*?to:\s*"\/agents"[\s\S]*?labelKey:\s*"nav\.agents"[\s\S]*?to:\s*"\/schedules"[\s\S]*?labelKey:\s*"nav\.schedules"[\s\S]*?to:\s*"\/memory"[\s\S]*?labelKey:\s*"nav\.memory"/);
  assert.match(sidebarSource, /fixedToolRowsBase[\s\S]*?to:\s*"\/control-center"[\s\S]*?labelKey:\s*"nav\.controlCenter"[\s\S]*?to:\s*"\/market"[\s\S]*?labelKey:\s*"nav\.market"[\s\S]*?to:\s*"\/settings"[\s\S]*?labelKey:\s*"nav\.settings"[\s\S]*?to:\s*"\/help"[\s\S]*?labelKey:\s*"nav\.help"/);
  assert.match(sidebarSource, /sidebar-footer-divider/);
  assert.match(sidebarSource, /aria-label=\{t\("nav\.sidebar\.fixedTools"\)\}/);
  assert.match(sidebarSource, /aria-label=\{t\("nav\.sidebar\.openSettings"\)\}/);
  assert.match(sidebarSource, /title=\{t\("nav\.settings"\)\}/);
  assert.match(sidebarSource, /<span className="sidebar-link-label">\{t\("nav\.settings"\)\}<\/span>/);
  assert.match(sidebarSource, /getCollapsedSidebarLabel\(t\("nav\.settings"\)\)/);
  assert.match(sidebarSource, /createPortal/);
  assert.match(sidebarSource, /sidebar-tool-menu-trigger/);
  assert.match(sidebarSource, /sidebar-tool-menu-item/);
  assert.match(sidebarSource, /sidebar-assistant-top-button/);
  assert.match(sidebarSource, /sidebar-group-heading/);
  assert.doesNotMatch(sidebarSource, /sidebar-tool-grid/);
  assert.doesNotMatch(sidebarSource, /sidebar-assistant-launcher/);
  assert.doesNotMatch(sidebarSource, /sortSidebarNavItems\(/);
  assert.match(sidebarSource, /label:\s*t\("nav\.taskBoard"\)[\s\S]*?label:\s*t\("nav\.assistants"\)[\s\S]*?label:\s*t\("nav\.embeddedWebsites"\)/);
  assert.match(globalStyles, /\.sidebar-tool-menu\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(globalStyles, /\.sidebar-group-heading\s*\{/);
  assert.match(globalStyles, /\.sidebar-group-divider\s*\{/);
  assert.match(globalStyles, /\.sidebar-group-children\s*\{[\s\S]*?gap:\s*2px;[\s\S]*?padding:\s*0;[\s\S]*?border-left:\s*0;/);
  assert.match(globalStyles, /\.worker-panel-role\s*\{[\s\S]*?font-size:\s*12px;/);
  assert.match(globalStyles, /\.worker-panel-preview\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?height:\s*20px;/);
  assert.match(globalStyles, /\.worker-chat-name\s*\{[\s\S]*?font-size:\s*12px;/);
  assert.match(globalStyles, /\.assistant-worker-header\s*\{[\s\S]*?padding:\s*6px 10px;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-expanded\s*\{[\s\S]*?background:\s*var\(--surface\);/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.is-expanded \.worker-panel-icon\s*\{[\s\S]*?transform:\s*scale\(0\.8\);/);
  assert.match(globalStyles, /\.worker-chat-preview-list \.status-line\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?color:\s*var\(--ink-muted\);/);
  assert.match(agentIconSource, /BUILTIN_ICON_CONFIGS/);
  assert.match(agentIconSource, /ledger/);
  assert.match(agentIconSource, /isImageIcon/);
  assert.match(agentIconSource, /useState\(false\)/);
  assert.match(agentIconSource, /onError:\s*\(\)\s*=>\s*setImageFailed\(true\)/);

  assert.match(appShell, /AGENT_WEBCLIENT_ROUTE_ITEMS/);
  assert.match(appShell, /<Route path="\/kanban" element=\{<TaskBoardPage hostTheme=\{themeMode\} \/>/);
  assert.doesNotMatch(appShell, /KanbanPlaceholderPage/);
  assert.match(sidebarSource, /label:\s*t\("nav\.taskBoard"\)/);
  assert.match(appShell, /assistantNavAgents/);
  assert.match(appShell, /listNavigationAgents/);
  assert.match(appShell, /routePath:\s*"\/agents"[\s\S]*?embedPath:\s*"\/agents"[\s\S]*?labelKey:\s*"nav\.agents"/);
  assert.match(appShell, /routePath:\s*"\/schedules"[\s\S]*?embedPath:\s*"\/schedules"[\s\S]*?labelKey:\s*"nav\.schedules"/);
  assert.match(appShell, /routePath:\s*"\/memory"[\s\S]*?embedPath:\s*"\/memory"[\s\S]*?labelKey:\s*"nav\.memory"/);
  assert.match(appShell, /routePath:\s*"\/copilot"[\s\S]*?embedPath:\s*"\/copilot"[\s\S]*?labelKey:\s*"nav\.assistants"/);
  assert.match(appShell, /const rawActiveAgentWebclientRoute = resolveAgentWebclientRoute\(location\.pathname,\s*location\.search,\s*copilotAgentOptions\)/);
  assert.match(appShell, /const activeAgentWebclientRoute = rawActiveAgentWebclientRoute[\s\S]*?label:\s*"labelKey" in rawActiveAgentWebclientRoute[\s\S]*?t\(rawActiveAgentWebclientRoute\.labelKey\)/);
  assert.match(appShell, /<Route path="\/copilot" element=\{null\} \/>/);
  assert.match(appShell, /<Route path="\/copilot\/:agentKey" element=\{null\} \/>/);
  assert.match(appShell, /function readAgentWebclientRouteEmbedPath\(search: string\)/);
  assert.match(appShell, /new URLSearchParams\(search\)\.get\("embedPath"\)/);
  assert.match(appShell, /function resolveCopilotAgentWebclientRoute\(/);
  assert.match(appShell, /const firstAgentKey = getFirstCopilotAgentKey\(copilotAgentOptions\)/);
  assert.match(appShell, /matchPath\("\/copilot\/:agentKey", pathname\)/);
  assert.match(appShell, /const matchedAgentKey = requestedAgentKey && copilotAgentOptions\.some\(\(agent\) => agent\.agentKey === requestedAgentKey\)/);
  assert.match(appShell, /const targetAgentKey = matchedAgentKey \|\| firstAgentKey \|\| requestedAgentKey/);
  assert.match(appShell, /targetAgentKey[\s\S]{0,120}`\/copilot\/\$\{encodeURIComponent\(targetAgentKey\)\}`[\s\S]{0,80}"\/copilot"/);
  assert.match(appShell, /function resolveSingleAgentWebclientRoute\(pathname: string, search: string\)/);
  assert.match(appShell, /matchPath\("\/agent\/:agentKey", pathname\)/);
  assert.match(appShell, /for \(const key of \["chatId", "history", "historyRequest"\]\)/);
  assert.match(appShell, /embedPath:\s*`\/agent\/\$\{encodeURIComponent\(agentKey\)\}/);
  assert.match(appShell, /labelKey:\s*embedPath\.startsWith\("\/agent\/"\) \? "nav\.assistants" : "nav\.agents"/);
  assert.match(appShell, /activeAgentWebclientRoute[\s\S]*?\? "agent-webclient"[\s\S]*?: resolvePluginRouteId\(location\.pathname\)/);
  assert.match(appShell, /embedPath=\{pluginId === "agent-webclient" \? activeAgentWebclientRoute\?\.embedPath : undefined\}/);
  assert.match(appShell, /if \(currentRoute !== pendingSidebarNavigationPath\)/);
  assert.match(appShell, /function requestSidebarNavigation\(targetPath: string\)[\s\S]*?navigate\(targetPath\);[\s\S]*?return true;/);
  assert.match(appShell, /const usesEmbeddedSurface =[\s\S]*?Boolean\(activeAgentWebclientRoute\)/);
  assert.match(appShell, /const usesPluginSurface =[\s\S]*?Boolean\(activeAgentWebclientRoute\)[\s\S]*?location\.pathname\.startsWith\("\/service\/"\)[\s\S]*?location\.pathname\.startsWith\("\/plugin\/"\)/);
  assert.match(appShell, /<Route path="\/agents" element=\{null\} \/>/);
  assert.match(appShell, /<Route path="\/schedules" element=\{null\} \/>/);
  assert.match(appShell, /<Route path="\/memory" element=\{null\} \/>/);
  assert.match(appShell, /<Route path="\/agent\/:agentKey" element=\{null\} \/>/);
  assert.doesNotMatch(appShell, /path="\/agents"[\s\S]{0,180}<PlaceholderPage/);

  assert.match(pluginPage, /embedPath\?: string;/);
  assert.match(pluginPage, /surfaceLabel\?: string;/);
  assert.match(pluginPage, /routeEmbedPath/);
  assert.match(pluginPage, /effectiveEmbedPath/);
  assert.match(pluginPage, /get\("embedPath"\)/);
  assert.match(pluginPage, /embedPath: effectiveEmbedPath/);
  assert.doesNotMatch(pluginPage, /webview\.loadURL\(embeddedUrl\)/);
  assert.match(pluginPage, /buildAgentWebclientAccessTokenInjectionScript/);
  assert.doesNotMatch(pluginPage, /buildAgentWebclientSelectWorkerScript/);
  assert.doesNotMatch(pluginPage, /agentWebclientRouteAgentKey/);
  assert.doesNotMatch(pluginPage, /agentWebclientRouteNewChat/);
  assert.doesNotMatch(pluginPage, /agent:select-worker/);
  assert.doesNotMatch(pluginPage, /agent:load-chat/);
  assert.doesNotMatch(pluginPage, /agent:start-new-conversation/);
});

test("settings route keeps the global sidebar and renders page-internal split sections", () => {
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
  const brandMark = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "BrandMark.tsx"),
    "utf8"
  );

  assert.match(appShell, /<Route\s+path="\/settings"/);
  assert.doesNotMatch(appShell, /lastNonSettingsRouteRef/);
  assert.doesNotMatch(appShell, /buildSettingsSectionPath/);
  assert.doesNotMatch(appShell, /navigate\(normalizedSettingsPath, \{ replace: true \}\)/);
  assert.doesNotMatch(appShell, /onSelectSettingsSection=\{handleSelectSettingsSection\}/);

  assert.match(settingsSections, /type SettingsSectionId/);
  assert.match(settingsSections, /id:\s*"appearance"[\s\S]*?label:\s*"appearance"[\s\S]*?layout:\s*"measure"/);
  assert.match(settingsSections, /id:\s*"navigation"[\s\S]*?label:\s*"navigation"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsSections, /id:\s*"quickAssistant"[\s\S]*?label:\s*"quickAssistant"[\s\S]*?layout:\s*"measure"/);
  assert.doesNotMatch(settingsSections, /id:\s*"sideAssistant"/);
  assert.match(settingsSections, /id:\s*"desktopPet"[\s\S]*?label:\s*"desktopPet"/);
  assert.match(settingsSections, /id:\s*"embeddedWebsites"[\s\S]*?label:\s*"embeddedWebsites"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsSections, /id:\s*"dataRoot"[\s\S]*?label:\s*"dataRoot"/);
  assert.match(settingsSections, /id:\s*"memory"[\s\S]*?label:\s*"memory"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsSections, /id:\s*"about"[\s\S]*?label:\s*"about"[\s\S]*?layout:\s*"measure"[\s\S]*?visible:\s*true/);
  assert.doesNotMatch(settingsSections, /icon:/);

  assert.doesNotMatch(sidebarSource, /isSettingsMode\?: boolean;/);
  assert.doesNotMatch(sidebarSource, /settingsSections\?: SettingsSectionDefinition\[\];/);
  assert.doesNotMatch(sidebarSource, /pendingSettingsSectionId\?: SettingsSectionId \| null;/);
  assert.doesNotMatch(sidebarSource, /sidebar-settings-nav/);
  assert.doesNotMatch(sidebarSource, /sidebar-link-settings/);
  assert.match(sidebarSource, /to:\s*"\/settings"[\s\S]*?labelKey:\s*"nav\.settings"/);
  assert.match(sidebarSource, /fixedToolRows/);
  assert.match(sidebarSource, /sidebar-assistant-top-button/);
  assert.match(sidebarSource, /app-sidebar-collapse-button/);

  assert.match(settingsPage, /createSettingsSectionDefinitions/);
  assert.match(settingsPage, /switch \(activeSection\)/);
  assert.match(settingsPage, /case "appearance"/);
  assert.match(settingsPage, /case "memory"/);
  assert.match(settingsPage, /case "about"/);
  assert.match(settingsPage, /<AboutAppCard \/>/);
  assert.match(settingsPage, /split-workspace-layout/);
  assert.match(settingsPage, /settings-directory-nav/);
  assert.doesNotMatch(settingsPage, /settings-directory-btn-desc/);
  assert.doesNotMatch(settingsStyles, /settings-directory-btn-desc/);
  assert.match(settingsPage, /contentRef\.current\?\.scrollTo/);
  assert.doesNotMatch(settingsPage, /settings-mode-close-button/);
  assert.doesNotMatch(settingsPage, /onExitSettingsMode/);

  assert.doesNotMatch(brandMark, /appearanceIcon/);
  assert.doesNotMatch(brandMark, /folderIcon/);
  assert.doesNotMatch(brandMark, /navigationIcon/);
  assert.doesNotMatch(brandMark, /petIcon/);
  assert.doesNotMatch(brandMark, /"appearance"/);
  assert.doesNotMatch(brandMark, /"navigation"/);
  assert.doesNotMatch(brandMark, /"pet"/);
  assert.doesNotMatch(brandMark, /"folder"/);
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
  assert.match(settingsPage, /SETTINGS_NOTICE_AUTO_CLOSE_MS = 3200/);
  assert.match(settingsPage, /setNotice\(\(current\) => \(current\?\.tone === "success" \? null : current\)\)/);
  assert.match(settingsPage, /setNotice\(\(current\) => \(current\?\.id === notice\.id \? null : current\)\)/);
  assert.match(settingsPage, /const activeSectionNotice = notice && notice\.sectionId === activeSection \? notice : null;/);
  assert.match(settingsPage, /const activeSectionReadError = activeSection \? sectionReadErrors\[activeSection\] \?\? "" : "";/);
  assert.match(settingsPage, /settings-section-feedback/);
  assert.match(settingsPage, /<PageFeedbackStack/);
  assert.match(settingsPage, /showSectionNotice\("desktopPet", nextState\.enabled \? t\("settings\.desktopPet\.noticeEnabled"\) : t\("settings\.desktopPet\.noticeDisabled"\), "success"\)/);
  assert.doesNotMatch(settingsPage, /导航页签排序已更新/);
  assert.match(settingsPage, /showSectionNotice\("quickAssistant", reason instanceof Error \? reason\.message : String\(reason\), "error"\)/);
  assert.match(settingsPage, /feedback-banner warning-banner settings-section-read-error/);
  assert.doesNotMatch(settingsPage, /\{feedback \? <div className="feedback-banner">\{feedback\}<\/div> : null\}/);

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
  assert.match(settingsPage, /settings\.navigation\.label/);
  assert.doesNotMatch(settingsPage, /半透明度/);
  assert.doesNotMatch(settingsPage, /导航栏半透明效果/);
  assert.doesNotMatch(settingsPage, /type="range"/);
  assert.match(settingsPage, /settings\.navigation\.fixedMain/);
  assert.match(settingsPage, /settings\.navigation\.fixedTools/);
  assert.match(settingsPage, /settings\.navigation\.sideAssistantColumn/);
  assert.match(settingsPage, /settings\.navigation\.noSideAssistant/);
  assert.match(settingsPage, /getCopilotPageKeyForSidebarNavOrderItem/);
  assert.match(settingsPage, /handleSelectNavigationCopilotAgent/);
  assert.match(settingsPage, /settings\.navigation\.fixedMainOrder/);
  assert.match(settingsPage, /data-sidebar-nav-order-key/);
  assert.doesNotMatch(settingsPage, /handleSidebarNavPointerDown/);
  assert.doesNotMatch(settingsPage, /document\.addEventListener\("pointermove"/);
  assert.doesNotMatch(settingsPage, /navigation-order-drag-handle/);
  assert.match(settingsPage, /settings\.embeddedWebsites\.label/);
  assert.match(settingsPage, /settings\.embeddedWebsites\.agentEnhancement/);
  assert.match(settingsPage, /handleUpdateCustomSidebarAgent/);
  assert.match(settingsPage, /window\.electronAPI\.customSidebar\.update/);
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
  assert.doesNotMatch(settingsPage, /className="custom-sidebar-copy"/);
  assert.match(settingsPage, /settings\.quickAssistant\.label/);
  assert.doesNotMatch(settingsPage, /case "sideAssistant"/);
  assert.doesNotMatch(settingsPage, /SIDE ASSISTANT/);
  assert.match(settingsPage, /settings\.navigation\.defaultAssistant/);
  assert.match(settingsPage, /desktopPetSupported/);
  assert.match(settingsPage, /handleToggleDesktopPet/);
  assert.match(settingsPage, /quickAssistantEnabled/);
  assert.match(settingsPage, /quickAssistantAgentKey/);
  assert.match(settingsPage, /handleToggleQuickAssistantEnabled/);
  assert.match(settingsPage, /handleSelectQuickAssistantAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*quickAssistantAgentKey: normalizedAgentKey\s*\}\)/);
  assert.doesNotMatch(settingsPage, /页面 Copilot/);
  assert.doesNotMatch(settingsPage, />选择宠物</);
  assert.doesNotMatch(settingsPage, /半透明侧边栏/);
  assert.match(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.agents"[\s\S]*?labelKey:\s*"nav\.schedules"[\s\S]*?labelKey:\s*"nav\.memory"/);
  assert.match(settingsPage, /fixedNavigationToolRows[\s\S]*?labelKey:\s*"nav\.controlCenter"[\s\S]*?labelKey:\s*"nav\.market"[\s\S]*?labelKey:\s*"nav\.settings"[\s\S]*?labelKey:\s*"nav\.help"/);
  assert.match(settingsPage, /copilotPageKey:\s*"controlCenter"/);
  assert.match(settingsPage, /copilotPageKey:\s*"market"/);
  assert.match(settingsPage, /navigation-order-fixed-label/);
  assert.match(settingsPage, /\{sidebarNavOrder\.map/);
  assert.match(settingsPage, /\{fixedNavigationTools\.map\(\(tool\) => renderFixedNavigationToolRow\(tool\)\)\}/);
  assert.match(settingsPage, /handleSelectDesktopHelperAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*desktopHelperAgentKey: normalizedAgentKey\s*\}\)/);
  assert.match(settingsPage, /desktopCopilotPages: nextPages/);
  assert.match(settingsPage, /settings\.navigation\.defaultAssistantDescription/);
  assert.match(settingsPage, /settings\.navigation\.fixedMainDescription/);
  assert.match(settingsPage, /settings\.navigation\.fixedToolsDescription/);
  assert.match(settingsPage, /settings\.quickAssistant\.panelAria/);
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

  assert.match(settingsPage, /<h2 className="settings-sidebar-title">\{t\("settings\.title"\)\}<\/h2>/);
  assert.match(settingsPage, /aria-label=\{t\("settings\.directory"\)\}/);
  assert.match(settingsPage, /t\("settings\.memory\.sectionDescription"\)/);
  assert.match(settingsPage, /t\("settings\.memory\.recall"\)/);
  assert.match(settingsPage, /t\("settings\.memory\.storage"\)/);
  assert.doesNotMatch(
    settingsPage,
    /助手记忆|记忆召回|自动学习|最近记忆|本地存储|最近记录|暂无操作|已暂停引用|仅保留现有记忆|设置目录/
  );
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
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
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
  assert.match(darkSidebarRule, /rgba\(57,\s*58,\s*62,\s*0\.5\)\s*0%/);
  assert.match(darkSidebarRule, /rgba\(46,\s*48,\s*52,\s*0\.44\)\s*40%/);
  assert.match(darkSidebarRule, /rgba\(37,\s*39,\s*43,\s*0\.38\)\s*100%/);
  assert.match(macSidebarRule, /rgba\(255,\s*255,\s*255,\s*0\.08\)\s*0%/);
  assert.match(macSidebarRule, /rgba\(255,\s*255,\s*255,\s*0\.05\)\s*46%/);
  assert.match(macSidebarRule, /rgba\(255,\s*255,\s*255,\s*0\.03\)\s*100%/);
  assert.match(macSidebarRule, /blur\(12px\)\s*saturate\(112%\)\s*brightness\(1\.01\)/);
  assert.match(macDarkSidebarRule, /rgba\(57,\s*58,\s*62,\s*0\.5\)\s*0%/);
  assert.match(macDarkSidebarRule, /rgba\(46,\s*48,\s*52,\s*0\.44\)\s*40%/);
  assert.match(macDarkSidebarRule, /rgba\(37,\s*39,\s*43,\s*0\.38\)\s*100%/);
  assert.match(macDarkSidebarRule, /brightness\(0\.76\)/);

  assert.doesNotMatch(preload, /setSidebarTranslucency/);
  assert.match(preload, /getAppInfo:\s*\(\) => ipcRenderer\.invoke\("settings\.getAppInfo"\)/);
  assert.match(preload, /setNativeThemeSource:\s*\(themeMode\) => ipcRenderer\.invoke\("settings\.setNativeThemeSource", themeMode\)/);
  assert.match(preload, /getLocale:\s*\(\) => ipcRenderer\.invoke\("settings\.getLocale"\)/);
  assert.match(preload, /setLocale:\s*\(locale\) => ipcRenderer\.invoke\("settings\.setLocale", locale\)/);
  assert.match(preload, /ipcRenderer\.on\("settings\.localeChanged"/);
  assert.match(contracts, /interface DesktopAppInfo/);
  assert.match(contracts, /getAppInfo: \(\) => Promise<DesktopAppInfo>/);
  assert.match(contracts, /setNativeThemeSource:\s*\(themeMode:\s*"light" \| "dark"\)/);
  assert.match(contracts, /getLocale: \(\) => Promise<LocaleSettings>/);
  assert.match(contracts, /setLocale: \(locale: SupportedLocale\) => Promise<LocaleSettings>/);
  assert.match(contracts, /onLocaleChanged: \(listener: LocaleChangedListener\) => \(\) => void/);
  assert.match(mainProcess, /nativeTheme/);
  assert.match(mainProcess, /nativeTheme\.themeSource = themeMode === "dark" \? "dark" : "light"/);
  assert.match(mainProcess, /ipcMain\.handle\("settings\.getAppInfo"[\s\S]*?app\.getVersion\(\)/);
  assert.match(mainProcess, /ipcMain\.handle\("settings\.setNativeThemeSource"/);
  assert.match(mainProcess, /ipcMain\.handle\("settings\.getLocale", async \(\) => initializeMainI18n\(app\)\)/);
  assert.match(mainProcess, /const isFirstDesktopInstall = !desktopDataRootExists\(app\);/);
  assert.match(mainProcess, /initializeMainI18n\(app, \{ isFirstInstall: isFirstDesktopInstall \}\)/);
  assert.match(mainProcess, /ipcMain\.handle\("settings\.setLocale", async \(_event, locale: unknown\) => \{/);
  assert.match(mainProcess, /buildApplicationMenu\(\);[\s\S]{0,120}appTrayController\.refreshContextMenu\(\);[\s\S]{0,120}emitLocaleChanged\(settings\);/);
  assert.doesNotMatch(contracts, /setSidebarTranslucency/);
  assert.doesNotMatch(mainProcess, /settings\.setSidebarTranslucency/);
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

  assert.match(orderHelper, /export type SidebarNavOrderItemKey/);
  assert.match(orderHelper, /"kanban"/);
  assert.match(orderHelper, /"group:assistants"/);
  assert.match(orderHelper, /"group:websites"/);
  assert.match(orderHelper, /STATIC_SIDEBAR_NAV_ORDER_ITEMS/);
  assert.match(orderHelper, /createDefaultSidebarNavOrderItems/);
  assert.match(orderHelper, /staticItems\.get\("kanban"\)/);
  assert.doesNotMatch(orderHelper, /staticItems\.get\("market"\)/);
  assert.doesNotMatch(orderHelper, /staticItems\.get\("agents"\)/);
  assert.doesNotMatch(orderHelper, /staticItems\.get\("help"\)/);
  assert.doesNotMatch(orderHelper, /\.\.\.customItems/);
  assert.doesNotMatch(orderHelper, /\.\.\.serviceItems/);
  assert.doesNotMatch(orderHelper, /\.\.\.experimentalItems/);
  assert.match(orderHelper, /normalizeSidebarNavOrder/);
  assert.match(orderHelper, /return availableItems\.map\(\(item\) => item\.key\)/);
  assert.match(orderHelper, /sortSidebarNavItems/);
  assert.match(appShell, /SIDEBAR_NAV_ORDER_STORAGE_KEY/);
  assert.match(appShell, /CUSTOM_SIDEBAR_GROUP_ORDER_STORAGE_KEY/);
  assert.match(appShell, /readInitialCustomSidebarGroupOrder/);
  assert.match(appShell, /readStoredSidebarNavOrder\(SIDEBAR_NAV_ORDER_STORAGE_KEY\)\.filter\(\(key\) => key\.startsWith\("custom:"\)\)/);
  assert.match(appShell, /normalizeCustomSidebarGroupOrder/);
  assert.match(appShell, /availableSidebarNavOrderItems/);
  assert.match(appShell, /normalizeSidebarNavOrder\(sidebarNavOrder, availableSidebarNavOrderItems\)/);
  assert.match(appShell, /customSidebarNavOrder=\{normalizedCustomSidebarGroupOrder\}/);
  assert.match(sidebarSource, /sidebarNavOrder:\s*SidebarNavOrderItemKey\[\]/);
  assert.doesNotMatch(sidebarSource, /sortSidebarNavItems\(/);
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
  assert.match(appShell, /isAgentWebclientMainRoute =[\s\S]{0,160}location\.pathname === ASSISTANT_TARGET_PATH[\s\S]{0,160}isSingleAgentWebclientRoute\(location\.pathname\)[\s\S]{0,160}isCopilotAgentWebclientRoute\(location\.pathname\)/);
  assert.match(appShell, /assistantCopilotOpen = assistantDockOpen && assistantDockOpenPath === location\.pathname && !isAgentWebclientMainRoute/);
  assert.match(appShell, /assistantDockOpenPath !== location\.pathname[\s\S]{0,180}setAssistantDockOpenPath\(null\)/);
  assert.doesNotMatch(appShell, /isAgentWebclientMainRoute && assistantDockOpen[\s\S]{0,180}setAssistantDockOpenPath\(null\)/);
  assert.match(appShell, /assistantLauncherDisabled=\{isAgentWebclientMainRoute\}/);
  assert.match(appShell, /open=\{assistantCopilotOpen\}/);
  assert.match(appShell, /assistantLauncherVisible=\{assistantLauncherVisible\}/);
  assert.match(appShell, /onRunningRunIdChange=\{setAssistantRunningRunId\}/);
  assert.match(appShell, /<AgentWebclientCopilotDock/);
  assert.match(appShell, /customSidebarAgentKey = activeCustomSidebarItemId/);
  assert.match(appShell, /resolvedCopilotAgentKey = customSidebarAgentKey \|\| currentCopilotPreference\?\.agentKey \|\| DEFAULT_DESKTOP_HELPER_AGENT_KEY/);
  assert.match(appShell, /resolvedAgentKey=\{resolvedCopilotAgentKey\}/);
  assert.match(appShell, /assistantDockOpenRequestPathRef = useRef<string \| null>\(null\)/);
  assert.match(appShell, /assistantDockOpenRequestPathRef\.current !== location\.pathname[\s\S]*?setAssistantDockOpenRequest\(null\)/);
  assert.match(appShell, /assistantDockOpenRequestPathRef\.current = location\.pathname[\s\S]*?setAssistantDockOpenRequest\(request\)/);
  assert.match(appShell, /setAssistantDockOpenPath\(location\.pathname\)/);
  assert.match(appShell, /const targetAgentKey = resolveTargetAgentKey\(openRequest, resolvedAgentKey\)/);
  assert.match(appShell, /const targetEmbedPath = buildAgentWebclientCopilotPath\(openRequest, resolvedAgentKey\)/);
  assert.match(appShell, /data-open-agent-key=\{targetAgentKey\}/);
  assert.match(appShell, /key=\{`agent-webclient-copilot:\$\{targetEmbedPath\}`\}/);
  assert.match(appShell, /function isSingleAgentWebclientRoute\(pathname: string\)[\s\S]*?matchPath\("\/agent\/:agentKey", pathname\)/);
  assert.match(appShell, /function isCopilotAgentWebclientRoute\(pathname: string\)[\s\S]*?matchPath\("\/copilot\/:agentKey", pathname\)/);
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

  assert.match(taskBoardPage, /type TaskBoardTodoAutomationFilter = "all" \| "scheduled" \| "manual"/);
  assert.match(taskBoardPage, /const TASK_BOARD_TODO_AUTOMATION_FILTERS = \[/);
  assert.match(taskBoardPage, /function shouldShowIssueForTodoAutomationFilter\(\s*issue: Pick<TaskBoardIssue, "status" \| "automationEnabled" \| "automationCron">,\s*filter: TaskBoardTodoAutomationFilter/);
  assert.match(taskBoardPage, /issue\.status !== "todo" \|\| filter === "all"/);
  assert.match(taskBoardPage, /return filter === "scheduled" \? automated : !automated/);
  assert.match(taskBoardPage, /const \[todoAutomationFilter,\s*setTodoAutomationFilter\] = useState<TaskBoardTodoAutomationFilter>\("all"\)/);
  assert.match(taskBoardPage, /shouldShowIssueForTodoAutomationFilter\(issue, todoAutomationFilter\)/);
  assert.match(taskBoardPage, /className="task-board-column-filter"/);
  assert.match(taskBoardPage, /TASK_BOARD_TODO_AUTOMATION_FILTERS\.map/);
  assert.match(taskBoardPage, /aria-label=\{t\("taskBoard\.filter\.todoAutomation"\)\}/);
  assert.match(taskBoardPage, /todoAutomationFilter === option\.value \? "is-active" : ""/);
  assert.match(taskBoardStyles, /\.task-board-column-filter\s*\{[\s\S]{0,220}display:\s*grid;[\s\S]{0,220}grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(taskBoardStyles, /\.task-board-column-filter button\.is-active\s*\{[\s\S]{0,180}background:\s*var\(--task-board-accent\);/);
  assert.match(zhCN, /"taskBoard\.filter\.todoAutomation": "待办定时筛选"/);
  assert.match(zhCN, /"taskBoard\.filter\.scheduledOnly": "定时"/);
  assert.match(zhCN, /"taskBoard\.filter\.manualOnly": "普通"/);
  assert.match(enUS, /"taskBoard\.filter\.todoAutomation": "Todo schedule filter"/);
  assert.match(enUS, /"taskBoard\.filter\.scheduledOnly": "Scheduled"/);
  assert.match(enUS, /"taskBoard\.filter\.manualOnly": "Manual"/);
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
  assert.match(mainProcess, /ipcMain\.handle\("taskBoard\.listIssues"/);
  assert.match(mainProcess, /ipcMain\.handle\("taskBoard\.moveIssue"/);
  assert.match(mainProcess, /ipcMain\.handle\("taskBoard\.syncIssueAutomation"/);
  assert.match(mainProcess, /syncTaskBoardIssueAutomation/);
  assert.match(mainProcess, /\/api\/automation\/create/);
  assert.match(mainProcess, /\/api\/automation\/update/);
  assert.match(mainProcess, /\/api\/automation\/delete/);
  assert.doesNotMatch(mainProcess, /\/api\/schedule(?:\/|-)(?:create|update|delete)/);
  assert.match(mainProcess, /syncTaskBoardIssueFromAssistantEvent/);
  assert.match(mainProcess, /event\.type === "done" \|\| event\.type === "run\.complete"[\s\S]{0,120}return "completed"/);
  assert.match(mainProcess, /event\.type === "run\.error"/);
  assert.match(mainProcess, /event\.status === "timeout"[\s\S]{0,220}return "failed"/);
  assert.match(mainProcess, /updateTaskBoardIssueByRunId\(app, event\.runId/);
  assert.match(mainProcess, /updateTaskBoardIssueByChatId/);
  assert.match(mainProcess, /updateTaskBoardIssueByChatId\(app,\s*event\.chatId/);
  assert.match(mainProcess, /onPushEvent:\s*syncTaskBoardIssueFromAssistantEvent/);
  assert.match(taskBoardStore, /export function updateTaskBoardIssueByChatId/);
  assert.match(assistantNavigationStatusClient, /onPushEvent\?:/);
  assert.match(assistantNavigationStatusClient, /this\.options\.onPushEvent\?\./);
  assert.match(appShell, /import \{ TaskBoardPage \} from "\.\.\/pages\/task-board\/TaskBoardPage"/);
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
  assert.match(appShell, /<TaskBoardPage hostTheme=\{themeMode\} \/>/);
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
  assert.match(globalStyles, /--task-board-column-fit-width:\s*calc\(\(100% - 32px\) \/ 3\);/);
  assert.match(globalStyles, /--task-board-column-width:\s*max\(\s*calc\(\(100% - 48px\) \/ 4\),\s*min\(var\(--task-board-column-min-width\), var\(--task-board-column-fit-width\)\)\s*\);/);
  assert.match(globalStyles, /--task-board-columns-total-width:\s*calc\(\s*var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+\s*var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\)\s*\);/);
  assert.match(globalStyles, /--task-board-column-fold-offset:\s*max\(0px,\s*calc\(var\(--task-board-columns-total-width\) - 100%\)\);/);
  assert.match(globalStyles, /\.task-board-columns\s*\{[\s\S]{0,220}overflow-x:\s*hidden;/);
  assert.match(globalStyles, /\.task-board-column\s*\{/);
  assert.match(globalStyles, /\.task-board-column\.is-todo\s*\{[\s\S]{0,260}margin-left:\s*calc\(var\(--task-board-column-fold-offset\) \* -1\);/);
  assert.doesNotMatch(globalStyles, /\.task-board-column\.is-in_progress\s*\{[^}]*margin-left:/);
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
    /TASK_BOARD_STATUSES\s*=\s*\[[\s\S]*?"backlog",[\s\S]*?"todo",[\s\S]*?"in_progress",[\s\S]*?"completed"[\s\S]*?\]/,
  );
  assert.match(
    taskBoardDb,
    /WHEN 'in_progress' THEN 2[\s\S]*?WHEN 'completed' THEN 3/,
  );
});

test("custom sidebar agent association is exposed across desktop api layers", () => {
  const contracts = readSharedContractsSource();
  const store = fs.readFileSync(path.join(projectRoot, "src", "main", "navigation", "custom-sidebar-store.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const appShell = readAppShellSource();
  const appSidebar = fs.readFileSync(path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"), "utf8");

  assert.match(contracts, /agentKey\?: string/);
  assert.match(contracts, /interface CustomSidebarUpdateInput/);
  assert.match(contracts, /update: \(id: string, input: CustomSidebarUpdateInput\) => Promise<CustomSidebarItemResult>/);
  assert.match(contracts, /add: \(input: CustomSidebarItemInput\) => Promise<CustomSidebarItemResult>/);
  assert.match(store, /export function updateCustomSidebarItem/);
  assert.match(store, /delete updated\.agentKey/);
  assert.match(store, /export function addCustomSidebarItem/);
  assert.match(mainProcess, /ipcMain\.handle\("customSidebar\.update"/);
  assert.match(preload, /update: \(id, input\) => ipcRenderer\.invoke\("customSidebar\.update", id, input\)/);
  assert.match(preload, /add: \(input\) => ipcRenderer\.invoke\("customSidebar\.add", input\)/);
  assert.match(appShell, /resolvedCopilotAgentKey/);
  assert.match(appShell, /function createCustomSidebarItem\(input: CustomSidebarItemInput\): Promise<CustomSidebarItemResult>[\s\S]*?window\.electronAPI\.customSidebar\.add\(input\)/);
  assert.match(appShell, /onCreateCustomSidebarItem=\{createCustomSidebarItem\}/);
  assert.match(appSidebar, /args\.groupId === "websites" && !isCollapsed/);
  assert.match(appSidebar, /className="assistant-worker-icon-button sidebar-website-add-button"/);
  assert.match(appSidebar, /function renderWebsiteDialog\(\)/);
  assert.match(appSidebar, /网页地址[\s\S]*?显示名称[\s\S]*?侧边智能助手/);
  assert.match(appShell, /copilotAgentOptions/);
  assert.match(appShell, /listCopilotAgents/);
  assert.match(appSidebar, /copilotAgentOptions\.map/);
  assert.match(appSidebar, /onCreateCustomSidebarItem\(\{[\s\S]*?label: websiteLabel,[\s\S]*?url: websiteUrl,[\s\S]*?agentKey: websiteAgentKey[\s\S]*?\}\)/);
  assert.match(appSidebar, /requestNavigate\(`\/custom-sidebar\/\$\{result\.item\.id\}`\)/);
});

test("assistant navigation agents are exposed through dedicated ipc without changing pet agents", () => {
  const contracts = readSharedContractsSource();
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(projectRoot, "src", "main", "copilot", "core", "agent-platform-bridge.ts"), "utf8");
  const appShell = readAppShellSource();
  const appSidebar = fs.readFileSync(path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"), "utf8");

  assert.match(contracts, /interface AssistantNavAgentItem/);
  assert.match(contracts, /icon\?: AssistantNavAgentIcon/);
  assert.match(contracts, /recentChats: AssistantNavChatItem\[\]/);
  assert.match(contracts, /hasPendingAwaiting:\s*boolean/);
  assert.match(contracts, /interface AssistantNavAgentItemsResult/);
  assert.match(contracts, /interface AssistantCreateCoderProjectRequest/);
  assert.match(contracts, /interface AssistantCreateCoderProjectResult/);
  assert.match(contracts, /AssistantNavigationAgentsChangedListener/);
  assert.match(contracts, /listAgents: \(\) => Promise<DesktopPetAgentOption\[\]>/);
  assert.match(contracts, /listNavigationAgents: \(\) => Promise<AssistantNavAgentItemsResult>/);
  assert.match(contracts, /listCopilotAgents: \(\) => Promise<AssistantNavAgentItemsResult>/);
  assert.match(contracts, /createCoderProject:\s*\(input: AssistantCreateCoderProjectRequest\) => Promise<AssistantCreateCoderProjectResult>/);
  assert.match(contracts, /markAgentChatsRead: \(agentKey: string\) => Promise<AssistantNavActionResult>/);
  assert.match(preload, /listAgents: \(\) => ipcRenderer\.invoke\("assistant\.listAgents"\)/);
  assert.match(preload, /listNavigationAgents: \(\) => ipcRenderer\.invoke\("assistant\.listNavigationAgents"\)/);
  assert.match(preload, /listCopilotAgents: \(\) => ipcRenderer\.invoke\("assistant\.listCopilotAgents"\)/);
  assert.match(preload, /createCoderProject:\s*\(input: AssistantCreateCoderProjectRequest\) =>[\s\S]{0,120}ipcRenderer\.invoke\("assistant\.createCoderProject", input\)/);
  assert.match(preload, /onNavigationAgentsChanged/);
  assert.match(mainProcess, /ipcMain\.handle\("assistant\.listAgents"/);
  assert.match(mainProcess, /ipcMain\.handle\("assistant\.listNavigationAgents"/);
  assert.match(mainProcess, /ipcMain\.handle\("assistant\.listCopilotAgents"/);
  assert.match(mainProcess, /ipcMain\.handle\("assistant\.createCoderProject"/);
  assert.match(mainProcess, /callAgentPlatform<\{ key\?: string \}>\(app, "\/api\/agent\/create"/);
  assert.match(mainProcess, /assistantNavigationStatusClient\?\.scheduleRefresh\(0\)/);
  assert.match(mainProcess, /AssistantNavigationStatusClient/);
  assert.match(mainProcess, /assistant\.navigationAgentsChanged/);
  assert.match(mainProcess, /ok:\s*false,[\s\S]*?items:\s*\[\]/);
  assert.match(bridge, /async listAgents\(\): Promise<DesktopPetAgentOption\[\]>/);
  assert.match(bridge, /async listNavigationAgents\(\): Promise<AssistantNavAgentItemsResult>/);
  assert.match(bridge, /async listCopilotAgents\(\): Promise<AssistantNavAgentItemsResult>/);
  assert.match(bridge, /readAssistantNavigationAgentsFromPlatform/);
  assert.match(bridge, /readAssistantCopilotAgentsFromPlatform/);
  assert.match(bridge, /chatHasPendingAwaiting/);
  assert.match(bridge, /createNavigationAgentItem/);
  assert.match(appShell, /onNavigationAgentsChanged/);
  assert.match(appShell, /setAssistantNavAgents\(nextItems\)/);
  assert.match(appShell, /setCopilotAgentOptions\(normalizeAssistantNavAgents\(result\.items\)\)/);
  assert.match(appShell, /onRefreshAssistantNavAgents=\{refreshAssistantNavAgents\}/);
  assert.match(appSidebar, /handleCreateCoderProject/);
  assert.match(appSidebar, /window\.electronAPI\.desktopDialog\.selectDirectory\(\)[\s\S]*?window\.electronAPI\.assistant\.createCoderProject/);
  assert.match(appSidebar, /className="assistant-worker-icon-button sidebar-assistant-project-button"/);
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

test("desktop action bridge exposes localhost api and renderer action providers", () => {
  const actionCatalog = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-actions.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
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
  assert.doesNotMatch(actionCatalog, /desktop\.embeddedWeb\./);
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
  assert.match(marketPage, /skillDownloadCommand/);
});

test("built index uses relative asset paths", () => {
  const builtIndex = fs.readFileSync(path.join(projectRoot, "dist-renderer", "index.html"), "utf8");

  assert.doesNotMatch(builtIndex, /src="\/assets\//);
  assert.doesNotMatch(builtIndex, /href="\/assets\//);
  assert.match(builtIndex, /(src|href)="\.?\/?assets\//);
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

test("sandbox image market is a local image management surface", () => {
  const sandboxMarket = readSourceFile(
    "src",
    "renderer",
    "pages",
    "functional-market",
    "SandboxImageMarket.tsx"
  );
  const marketModel = readSourceFile("src", "renderer", "pages", "functional-market", "marketPageModel.ts");

  assert.match(marketModel, /market\.tab\.sandboxImages\.subtitle/);
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
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(320px,\s*1fr\)\)/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.sandbox-image-panel\s*\{[\s\S]*?align-items:\s*start;/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.market-skill-card\.sandbox-image-card\s*\{[\s\S]*?min-height:\s*100px;[\s\S]*?padding:\s*10px 12px;/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.sandbox-image-card\s+\.market-plugin-meta\s*\{[\s\S]*?margin-top:\s*4px;[\s\S]*?padding-top:\s*7px;/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.sandbox-image-card\s*\{[\s\S]*?background:\s*var\(--market-control-card\);[\s\S]*?box-shadow:\s*0 2px 6px rgba\(15,\s*23,\s*42,\s*0\.08\);/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /:root\[data-theme="dark"\]\s+\.sandbox-image-card\s*\{[\s\S]*?background:\s*var\(--market-control-card\);[\s\S]*?box-shadow:\s*none;/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.sandbox-image-card\s+\.market-card-icon,[\s\S]*?\.market-image-detail-title\s+\.market-card-icon\s*\{[\s\S]*?background:\s*#e9eefc;[\s\S]*?color:\s*var\(--market-control-blue\);/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /:root\[data-theme="dark"\]\s+\.sandbox-image-card\s+\.market-card-icon,[\s\S]*?:root\[data-theme="dark"\]\s+\.market-image-detail-title\s+\.market-card-icon\s*\{[\s\S]*?background:\s*rgba\(87,\s*144,\s*255,\s*0\.15\);[\s\S]*?color:\s*#7facff;/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.market-topbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.market-tabs\s*\{[\s\S]*?grid-column:\s*2[\s\S]*?justify-self:\s*center[\s\S]*?width:\s*min\(520px,\s*100%\)/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.market-tab\s*\{[\s\S]*?min-height:\s*42px[\s\S]*?font-size:\s*14px[\s\S]*?font-weight:\s*800/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /:root\[data-theme="dark"\]\s+\.market-tabs\s*\{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.045\)[\s\S]*?box-shadow:\s*inset 0 1px 0 rgba\(255,\s*255,\s*255,\s*0\.04\)/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /:root\[data-theme="dark"\]\s+\.market-tab\.is-active\s*\{[\s\S]*?background:\s*rgba\(87,\s*144,\s*255,\s*0\.18\)[\s\S]*?inset 0 0 0 1px rgba\(158,\s*197,\s*255,\s*0\.24\)/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.market-empty-state\s*\{[\s\S]*?align-self:\s*center;/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.market-import-progress-backdrop\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*90;[\s\S]*?backdrop-filter:\s*blur\(8px\);/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.market-import-progress-panel\s*\{[\s\S]*?width:\s*min\(520px,\s*100%\);[\s\S]*?max-height:\s*min\(520px,\s*calc\(100vh - 48px\)\);/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.market-import-progress-panel\s*\{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.98\);[\s\S]*?box-shadow:\s*0 24px 70px rgba\(15,\s*23,\s*42,\s*0\.24\);/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
    /\.market-import-progress-close\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/
  );
  assert.match(
    readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css"),
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
  const main = readSourceFile("src", "main", "index.ts");

  assert.match(marketContracts, /export interface SandboxImageImportProgressEvent/);
  assert.match(desktopApi, /SandboxImageImportProgressListener/);
  assert.match(desktopApi, /onSandboxImageImportProgress:\s*\(listener:\s*SandboxImageImportProgressListener\)\s*=>\s*\(\)\s*=>\s*void/);
  assert.match(preload, /onSandboxImageImportProgress:\s*\(listener:\s*SandboxImageImportProgressListener\)\s*=>/);
  assert.match(preload, /ipcRenderer\.on\("market\.sandboxImageImportProgress"/);
  assert.match(preload, /ipcRenderer\.off\("market\.sandboxImageImportProgress"/);
  assert.match(main, /event\.sender\.send\("market\.sandboxImageImportProgress"/);
  assert.match(main, /const taskId\s*=\s*`sandbox-import-/);
  assert.match(main, /event\.sender\.send\("market\.sandboxImageImportProgress",\s*\{[\s\S]*?taskId,[\s\S]*?\.\.\.progress/);
});

test("market route disables the global drag overlay above toolbar controls", () => {
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();
  const marketStyles = readSourceFile("src", "renderer", "pages", "functional-market", "MarketPageFrame.css");

  assert.match(appShell, /has-market-controls/);
  assert.match(globalStyles, /\.app-shell\.has-market-controls\s+\.app-window-drag-region/);
  assert.match(marketStyles, /-webkit-app-region:\s*no-drag;/);
});

test("embedded H5 routes do not restore a mac window drag lane over page controls", () => {
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();

  assert.match(appShell, /usesPluginSurface/);
  assert.match(appShell, /has-plugin-surface/);
  assert.match(globalStyles, /\.app-shell\.has-embedded-surface\s+\.app-window-drag-region\s*\{[\s\S]*?display:\s*none;/);
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.is-mac-platform\.has-plugin-surface\s+\.app-window-drag-region\s*\{/
  );
  assert.doesNotMatch(
    globalStyles,
    /\.app-shell\.is-mac-platform\.has-plugin-surface\.has-assistant-dock-full\s+\.app-window-drag-region\s*\{/
  );
});

test("window drag uses css-only app-region approach", () => {
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const contracts = readSharedContractsSource();

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
  assert.match(mainProcess, /vibrancy:\s*"under-window"\s+as const/);
  assert.match(mainProcess, /visualEffectState:\s*"active"\s+as const/);
  assert.match(mainProcess, /function applyMainWindowAppearance\(targetWindow: BrowserWindow \| null\)/);
  assert.match(
    mainProcess,
    /if \(process\.platform === "darwin"\)\s*\{[\s\S]*?mainWindowSidebarTranslucencyEnabled && !targetWindow\.isFullScreen\(\);[\s\S]*?targetWindow\.setVibrancy\("under-window"\);[\s\S]*?targetWindow\.setVibrancy\(null\);[\s\S]*?targetWindow\.setBackgroundColor\(useSidebarTranslucency \? "#00000000" : "#FFFFFF"\);/
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

test("external webview bookmarks use document-level pointer reordering", () => {
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx"),
    "utf8"
  );

  assert.match(externalWebviewPage, /bookmarkPointerCleanupRef/);
  assert.match(externalWebviewPage, /updateBookmarkPointerDrag/);
  assert.match(externalWebviewPage, /document\.addEventListener\("pointermove", handleDocumentPointerMove/);
  assert.match(externalWebviewPage, /moveItemByIdToIndex\(\s*currentBookmarks/);
  assert.match(externalWebviewPage, /onPointerDown=\{\(event\) => handleBookmarkPointerDown\(event, bookmark\.id\)\}/);
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
  const serviceWebviewBridgeHost = readSourceFile("src", "renderer", "services", "serviceWebviewBridgeHost.ts");
  const serviceWebviewBridgeReserved = readSourceFile(
    "src",
    "renderer",
    "services",
    "serviceWebviewBridgeReservedCapabilities.ts"
  );
  const serviceWebviewBridgeContracts = readSourceFile("src", "shared", "service-webview-bridge.ts");
  const mainProcess = readSourceFile("src", "main", "index.ts");
  const preload = readSourceFile("src", "preload", "index.ts");
  const contracts = readSharedContractsSource();
  const sendBridgeMessageBlock = pluginPage.slice(
    pluginPage.indexOf("function sendBridgeMessageToWebview"),
    pluginPage.indexOf("function dispatchPluginRouteEventToWebview")
  );
  const sendPluginRouteBlock = pluginPage.slice(
    pluginPage.indexOf("function dispatchPluginRouteEventToWebview"),
    pluginPage.indexOf("async function injectAgentWebclientAccessToken")
  );

  assert.match(pluginPage, /registerAssistantPageContextProvider/);
  assert.doesNotMatch(pluginPage, /<<<<<<<|=======|>>>>>>>/);
  assert.match(pluginPage, /registerDesktopActionProviderForScope\(\s*"embeddedWeb"/);
  assert.match(pluginPage, /skipContextRegistration\?: boolean/);
  assert.match(pluginPage, /loadInitialEmbeddedUrlDirectly\?: boolean/);
  assert.match(pluginPage, /suppressInitialLoadingCopy\?: boolean/);
  assert.match(pluginPage, /loadInitialEmbeddedUrlDirectly[\s\S]{0,180}\?\s*embeddedUrl\s*:\s*buildPluginWebviewSrcUrl\(embeddedUrl\)/);
  const taskBoardPage = readSourceFile("src", "renderer", "pages", "task-board", "TaskBoardPage.tsx");
  assert.match(taskBoardPage, /loadInitialEmbeddedUrlDirectly/);
  assert.match(taskBoardPage, /suppressInitialLoadingCopy/);
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
  assert.match(pluginPage, /suppressInitialLoadingCopy\s*\?\s*\(/);
  assert.match(pluginPage, /aria-label=\{`\$\{serviceDisplayName\} 正在加载`\}/);
  assert.match(pluginPage, /webviewRef\.current = node/);
  assert.doesNotMatch(pluginPage, /!webviewRef\.current && \(webviewRef\.current = node\)/);
  assert.match(sendBridgeMessageBlock, /webviewRef\.current\?\.send\(SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL,\s*payload\)/);
  assert.doesNotMatch(sendBridgeMessageBlock, /executeJavaScript/);
  assert.match(sendPluginRouteBlock, /webviewRef\.current\?\.send\(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL,\s*payload\)/);
  assert.doesNotMatch(sendPluginRouteBlock, /executeJavaScript/);
  assert.match(pluginPage, /__ZENMIND_AGENT_WEBCLIENT_AUTH_FALLBACK__/);
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
  assert.match(serviceWebviewBridgeReserved, /media\.microphone/);
  assert.match(serviceWebviewBridgeReserved, /media\.camera/);
  assert.match(serviceWebviewBridgeReserved, /screen\.capture/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE/);
  assert.match(serviceWebviewBridgeContracts, /DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE/);
  assert.match(serviceWebviewPreload, /sendToHost/);
  assert.match(serviceWebviewPreload, /SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL/);
  assert.match(serviceWebviewPreload, /DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE/);
  assert.match(serviceWebviewPreload, /ipcRenderer\.on\(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL/);
  assert.match(serviceWebviewPreload, /payload\.type !== DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE/);
  assert.match(serviceWebviewPreload, /window\.postMessage/);
  assert.match(serviceWebviewPreload, /window\.parent\.postMessage/);
  assert.match(serviceWebviewPreload, /MessageEvent\("message"/);
  assert.match(serviceWebviewPreload, /__ZENMIND_DESKTOP_WEBVIEW_BRIDGE__/);
  assert.match(serviceWebviewPreload, /agent-webclient\.appAccessToken/);
  assert.match(serviceWebviewPreload, /agent-webclient\.appAuthContext/);
  assert.match(serviceWebviewPreload, /window\.__AGENT_APP_ACCESS_TOKEN/);
  assert.match(serviceWebviewPreload, /sendBridgeDebug/);
  assert.match(serviceWebviewPreload, /preload-installed/);
  assert.match(serviceWebviewPreload, /auth-response-seeded/);
  assert.match(serviceWebviewPreload, /SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES/);
  assert.match(serviceWebviewPreload, /DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE/);
  assert.match(mainProcess, /getServiceWebviewPreloadUrl\(\)[\s\S]{0,120}pathToFileURL\(getServiceWebviewPreloadPath\(\)\)\.toString\(\)/);
  assert.match(mainProcess, /ipcMain\.handle\("desktopDialog\.selectDirectory"/);
  assert.match(mainProcess, /ipcMain\.handle\("desktopShell\.openPath"/);
  assert.match(mainProcess, /ipcMain\.handle\("desktopDownloads\.saveFile"/);
  assert.match(mainProcess, /webPreferences\.preload = servicePreloadPath/);
  assert.match(mainProcess, /ipcMain\.handle\("plugins\.getServiceWebviewPreloadUrl", async \(\) => getServiceWebviewPreloadUrl\(\)\)/);
  assert.match(preload, /getServiceWebviewPreloadUrl:\s*\(\) => ipcRenderer\.invoke\("plugins\.getServiceWebviewPreloadUrl"\)/);
  assert.match(preload, /desktopDialog:[\s\S]{0,120}selectDirectory:\s*\(\) => ipcRenderer\.invoke\("desktopDialog\.selectDirectory"\)/);
  assert.match(preload, /desktopShell:[\s\S]{0,140}openPath:\s*\(targetPath: string\) => ipcRenderer\.invoke\("desktopShell\.openPath", targetPath\)/);
  assert.match(preload, /desktopDownloads:[\s\S]{0,140}saveFile:\s*\(input\) => ipcRenderer\.invoke\("desktopDownloads\.saveFile", input\)/);
  assert.match(contracts, /getServiceWebviewPreloadUrl:\s*\(\) => Promise<string>/);
  assert.match(contracts, /desktopDialog:[\s\S]{0,120}selectDirectory:\s*\(\) => Promise<\{ ok: boolean; path\?: string; message\?: string \}>/);
  assert.match(contracts, /desktopShell:[\s\S]{0,120}openPath:\s*\(targetPath: string\) => Promise<\{ ok: boolean; path\?: string; message\?: string \}>/);
  assert.match(contracts, /desktopDownloads:[\s\S]{0,220}saveFile:\s*\(input: \{[\s\S]{0,160}dataBase64\?: string;[\s\S]{0,120}\}\) => Promise<\{ ok: boolean; path\?: string; message\?: string \}>/);
  assert.match(globalStyles, /\.embedded-plugin-error\s*\{/);
});

test("embedded cdp exposes service frontends as webview surfaces", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(mainProcess, /createEmbeddedCdpServiceSurface/);
  assert.match(mainProcess, /kind:\s*"webview"/);
  assert.match(mainProcess, /webContentsId:\s*contents\?\.id/);
  assert.match(mainProcess, /active:\s*snapshotMatchesService/);
  assert.match(mainProcess, /currentPageSnapshotMatchesSurface/);
  assert.doesNotMatch(mainProcess, /failed to list iframe targets/);
});

test("assistant chat export writes directly to the download location", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const exportPathBlock =
    mainProcess.match(/function getAssistantExportDefaultPath[\s\S]*?function getSandboxImageExportDefaultPath/u)?.[0] ?? "";
  const saveExportBlock =
    mainProcess.match(/async function saveAssistantChatExport[\s\S]*?function createStartupRestoreState/u)?.[0] ?? "";

  assert.match(exportPathBlock, /process\.platform === "win32"[\s\S]*?app\.getPath\("downloads"\)/u);
  assert.match(exportPathBlock, /process\.platform === "darwin"[\s\S]*?app\.getPath\("downloads"\)/u);
  assert.match(exportPathBlock, /getAvailableFilePath/u);
  assert.match(saveExportBlock, /const exportPath = await getAvailableFilePath\(getAssistantExportDefaultPath\(result\.filename\)\)/u);
  assert.match(saveExportBlock, /fs\.promises\.writeFile\(exportPath, result\.bytes\)/u);
  assert.doesNotMatch(saveExportBlock, /showSaveDialog/u);
});

test("assistant entrypoints restore core services before opening embedded webclient", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const trayController = fs.readFileSync(
    path.join(projectRoot, "src", "main", "app-shell", "tray.ts"),
    "utf8"
  );

  assert.match(mainProcess, /async function ensureAssistantTargetServicesRunning/);
  assert.match(mainProcess, /for \(const serviceId of STARTUP_RESTORE_SERVICE_ORDER\)/);
  assert.match(mainProcess, /await runServiceMutation\(\(\) => ensureAssistantTargetServicesRunning\(source\)\)/);
  assert.match(mainProcess, /async function showAssistantTargetWindow/);
  assert.match(mainProcess, /function createAgentWebclientRoute/);
  assert.match(mainProcess, /\/agent\/\$\{encodeURIComponent\(agentKey\)\}/);
  assert.doesNotMatch(mainProcess, /embedPath=\$\{encodeURIComponent\(embedPath\)\}/);
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
  assert.match(mainProcess, /services\.openLogViewer/);
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
    preload.indexOf("customSidebar:", preload.indexOf("quickAssistant: {"))
  );
  const contractQuickAssistantApi = contracts.slice(
    contracts.indexOf("quickAssistant: {"),
    contracts.indexOf("customSidebar:", contracts.indexOf("quickAssistant: {"))
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

  assert.match(settingsPage, /const desktopPetSupported = isMac \|\| isWindows;/);
  assert.match(settingsPage, /if \(!desktopPetSupported\) \{[\s\S]{0,120}return;/);
  assert.match(settingsPage, /case "desktopPet":/);
  assert.match(settingsPage, /return desktopPetSupported \? \(/);
  assert.match(settingsPage, /nextState\.appearanceId === appearanceId/);
  assert.match(settingsPage, /settings\.desktopPet\.noticeAppearanceFailed/);
  assert.match(settingsPage, /disabled=\{Boolean\(desktopPetAppearancePending\) && !selected\}/);
  assert.doesNotMatch(settingsPage, /\?\?\s*"小宅"/);
  assert.doesNotMatch(settingsPage, /disabled=\{Boolean\(desktopPetAppearancePending\) \|\| selected\}/);
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

test("desktop pet click opens ZenMind without assistant sidebar copy", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );

  assert.match(desktopPet, /desktopPet\.openAssistant/);
  assert.match(desktopPet, /aria-label="打开 ZenMind"/);
  assert.doesNotMatch(desktopPet, /打开侧边栏助手/);
});

test("desktop pet base mode stays sprite-sized while bubble and preview modes expand separately", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const petGeometry = fs.readFileSync(path.join(projectRoot, "src", "main", "copilot", "pet-copilot", "desktop-pet.ts"), "utf8");
  const globalStyles = readRendererStyles();

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

test("task running sprite uses the smooth high-frame strip", () => {
  const globalStyles = readRendererStyles();
  const desktopPetSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "pet-copilot", "DesktopPet.tsx"),
    "utf8"
  );

  assert.match(desktopPetSource, /task-run-left\.webp/);
  assert.match(desktopPetSource, /getDesktopPetTaskRunSpritePath\(appearanceId\)/);
  assert.match(globalStyles, /\.desktop-pet-task-run-sprite\s*\{[\s\S]{0,180}height:\s*104px;/);
  assert.match(globalStyles, /\.desktop-pet-task-run-sprite\s*\{[\s\S]{0,220}background-size:\s*1440px\s+104px;/);
  assert.match(globalStyles, /\.desktop-pet-task-run-sprite\s*\{[\s\S]{0,260}background-position:\s*0\s+0;/);
  assert.match(globalStyles, /\.desktop-pet-root\.has-task-run-animation\s+\.desktop-pet-task-run-sprite\s*\{[\s\S]{0,180}animation:\s*desktop-pet-idol-pony-run-frames var\(--desktop-pet-task-run-animation-duration,\s*1500ms\) steps\(15,\s*end\) infinite;/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-appearance-xiao\.has-task-run-animation\s+\.desktop-pet-image/);
  assert.match(globalStyles, /@keyframes desktop-pet-idol-pony-run-frames\s*\{[\s\S]{0,120}to\s*\{\s*background-position:\s*-1440px\s+0;/);
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
  const globalStyles = readRendererStyles();
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = readSharedContractsSource();
  const petAssetScript = fs.readFileSync(
    path.join(projectRoot, "scripts", "generate-desktop-pet-assets.mjs"),
    "utf8"
  );

  assert.match(desktopPet, /"dragging-left"/);
  assert.match(desktopPet, /"dragging-right"/);
  assert.match(desktopPet, /DESKTOP_PET_DRAG_DIRECTION_THRESHOLD_PX = 3/);
  assert.match(desktopPet, /const \[isHovering, setIsHovering\] = useState\(false\)/);
  assert.match(desktopPet, /const \[isKeyboardFocused, setIsKeyboardFocused\] = useState\(false\)/);
  assert.match(desktopPet, /const \[isDancing, setIsDancing\] = useState\(false\)/);
  assert.match(desktopPet, /pointIntersectsVisiblePetArea/);
  assert.match(desktopPet, /pointIntersectsElement\("\.desktop-pet-image"/);
  assert.match(desktopPet, /window\.addEventListener\("mousemove", handleWindowMouseMove\)/);
  assert.match(desktopPet, /desktopPet\.setMouseInteractive\(interactive\)/);
  assert.match(desktopPet, /typeof window\.electronAPI\.desktopPet\.onDanceRequested === "function"/);
  assert.match(desktopPet, /desktopPet\.onDanceRequested\(startDance\)/);
  assert.match(desktopPet, /isDragging[\s\S]{0,180}\? dragDirection === "left"/);
  assert.match(desktopPet, /window\.addEventListener\("pointermove", handleWindowPointerMove\)/);
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
  assert.match(sharedDesktopPet, /id:\s*"idol-pony"/);
  assert.match(sharedDesktopPet, /assetBasePath:\s*"\.\/desktop-pet\/dario"/);
  assert.match(sharedDesktopPet, /assetBasePath:\s*"\.\/desktop-pet\/mini-sama"/);
  assert.match(sharedDesktopPet, /dragging:\s*"pet-dragging\.png"/);
  assert.match(sharedDesktopPet, /"dragging-left":\s*"pet-dragging-left\.png"/);
  assert.match(sharedDesktopPet, /"dragging-right":\s*"pet-dragging-right\.png"/);
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
  assert.match(petAssetScript, /"dragging-left"/);
  assert.match(petAssetScript, /"dragging-right"/);
  assert.match(petAssetScript, /"idol-pony"/);
  assert.match(petAssetScript, /id:\s*"xiao"/);
  assert.match(petAssetScript, /spritesheet-source\.png/);
  assert.match(petAssetScript, /task-run-left-source\.png/);
  assert.match(sharedDesktopPet, /displayName:\s*"小凌"/);
  assert.match(petAssetScript, /displayName:\s*"小凌"/);
  assert.match(petAssetScript, /"dragging-left":\s*\{\s*row:\s*1,\s*column:\s*2\s*\}/);
  assert.match(petAssetScript, /"dragging-right":\s*\{\s*row:\s*1,\s*column:\s*2,\s*mirrorX:\s*true\s*\}/);
  assert.match(petAssetScript, /"dragging-left":\s*\{\s*row:\s*7,\s*column:\s*2\s*\}/);
  assert.match(petAssetScript, /"dragging-right":\s*\{\s*row:\s*7,\s*column:\s*2,\s*mirrorX:\s*true\s*\}/);
  assert.match(petAssetScript, /ctx\.scale\(-1,\s*1\)/);
  assert.match(petAssetScript, /dario-a7bdc389/);
  assert.match(petAssetScript, /mini-sama-3ee267a2/);
  assert.match(petAssetScript, /task-run-left\.webp/);
  assert.match(petAssetScript, /function renderXiaoTaskRunSprite/);
  assert.match(petAssetScript, /function renderXiaoSpritesheet/);
  assert.match(petAssetScript, /awaiting:\s*"thinking"/);
  assert.match(petAssetScript, /running:\s*"thinking"/);
  assert.match(petAssetScript, /function drawHoverArm/);
});

test("desktop sso waits for a user click and keeps pending login recoverable", () => {
  const appShell = readAppShellSource();
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const contracts = readSharedContractsSource();
  const globalStyles = readRendererStyles();

  assert.match(contracts, /browserOrigin\?: string;/);
  assert.match(contracts, /browserUrl\?: string;/);
  assert.doesNotMatch(appShell, /desktopSsoAutoLogin/);
  assert.doesNotMatch(appShell, /void handleDesktopSsoLogin\(\);/);
  assert.match(appShell, /desktopSsoStatus=\{desktopSsoStatus\}/);
  assert.match(appShell, /desktopSsoBusy=\{desktopSsoBusy\}/);
  assert.match(appShell, /onDesktopSsoLogin=\{handleDesktopSsoLogin\}/);
  assert.match(appShell, /onDesktopSsoLogout=\{handleDesktopSsoLogout\}/);
  assert.doesNotMatch(appShell, /const \[desktopSsoDismissed, setDesktopSsoDismissed\]/);
  assert.doesNotMatch(appShell, /className=\{desktopSsoClassName\}/);
  assert.doesNotMatch(appShell, /has-desktop-sso-status/);

  assert.match(sidebarSource, /desktopSsoStatus\?:\s*DesktopSsoStatus \| null;/);
  assert.match(sidebarSource, /const shouldRenderDesktopSso = desktopSsoStatus\?\.configured === true;/);
  assert.match(sidebarSource, /function renderDesktopSsoEntry\(\)/);
  assert.match(sidebarSource, /function handleDesktopSsoEntryClick\(\)/);
  assert.match(sidebarSource, /className=\{desktopSsoClassName\}/);
  assert.match(sidebarSource, /aria-label=\{desktopSsoActionLabel\}/);
  assert.match(sidebarSource, /if \(desktopSsoStatus\.authenticated\) \{[\s\S]{0,220}window\.confirm\(t\("sidebar\.sso\.confirmSignOut"\)\)[\s\S]{0,220}if \(!confirmed\) \{[\s\S]{0,80}return;[\s\S]{0,220}onDesktopSsoLogout\?\.\(\);[\s\S]{0,80}return;/);
  assert.match(sidebarSource, /onDesktopSsoLogin\?\.\(\);/);
  assert.doesNotMatch(sidebarSource, /desktopSsoStatus\.authenticated[\s\S]{0,140}\? onDesktopSsoLogout\?\.\(\)[\s\S]{0,140}: onDesktopSsoLogin\?\.\(\)/);
  assert.match(sidebarSource, /disabled=\{desktopSsoBusy\}/);
  assert.match(sidebarSource, /desktopSsoStatus\.user\?\.name \|\| desktopSsoStatus\.user\?\.email \|\| desktopSsoStatus\.user\?\.sub \|\| t\("sidebar\.sso\.signedIn"\)/);
  assert.doesNotMatch(sidebarSource, /desktopSsoMessage/);
  assert.doesNotMatch(sidebarSource, /sidebar-sso-message/);
  assert.match(sidebarSource, /desktopSsoStatus\.pending[\s\S]{0,120}\? t\("sidebar\.sso\.signingIn"\)/);
  assert.match(sidebarSource, /desktopSsoStatus\.pending[\s\S]{0,120}\? t\("sidebar\.sso\.reopen"\)/);
  assert.match(sidebarSource, /: t\("sidebar\.sso\.signIn"\);/);
  assert.doesNotMatch(sidebarSource, /"登录中"|"重新打开"/);
  assert.match(sidebarSource, /\{renderDesktopSsoEntry\(\)\}/);

  assert.match(globalStyles, /\.sidebar-sso-entry\s*\{/);
  assert.match(globalStyles, /\.sidebar-sso-entry\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(globalStyles, /\.sidebar-sso-entry\.is-authenticated \.sidebar-sso-dot\s*\{[\s\S]*?background:\s*#10b981;/);
  assert.match(globalStyles, /\.sidebar-sso-entry\.is-pending \.sidebar-sso-dot\s*\{[\s\S]*?background:\s*#f59e0b;/);
  assert.doesNotMatch(globalStyles, /\.sidebar-sso-message/);
  assert.match(globalStyles, /\.app-sidebar\.is-collapsed \.sidebar-sso-entry\s*\{[\s\S]*?width:\s*48px;/);
  assert.match(globalStyles, /\.app-sidebar\.is-collapsed \.sidebar-sso-copy\s*\{[\s\S]*?display:\s*none;/);
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

  assert.match(copilotContracts, /partition\?: string;/);
  assert.match(copilotContracts, /userAgent\?: string;/);
  assert.match(externalWebviewPage, /partition\?: string;/);
  assert.match(externalWebviewPage, /userAgent\?: string;/);
  assert.match(externalWebviewPage, /partition: tab\.partition,/);
  assert.match(externalWebviewPage, /useragent: tab\.userAgent,/);
  assert.match(externalWebviewPage, /function shouldRefreshWebviewAfterDesktopSso\(value: string\)/u);
  assert.match(externalWebviewPage, /window\.electronAPI\.sso\.onStatusChanged/u);
  assert.match(externalWebviewPage, /if \(!status\.authenticated\) \{/u);
  assert.match(externalWebviewPage, /shouldRefreshWebviewAfterDesktopSso\(currentUrl\)/u);
  assert.match(externalWebviewPage, /webview\.reload\(\)/u);
  assert.match(externalWebviewPage, /const isHostOpenRequest = sourceGuestId < 0;/);
  assert.match(externalWebviewPage, /if \(isHostOpenRequest\) \{[\s\S]{0,220}if \(!activeRef\.current\) \{[\s\S]{0,80}return;[\s\S]{0,180}openTab\(nextUrl, "", \{[\s\S]{0,160}partition,[\s\S]{0,80}userAgent/);
});
