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
  assert.match(controlCenter, /label:\s*"描述"/);
  assert.match(controlCenter, /label:\s*"安装目录"/);
  assert.match(controlCenter, /label:\s*"主日志路径"/);
  assert.match(controlCenter, /label:\s*"错误日志路径"/);
  assert.match(controlCenter, /label:\s*"进程 ID \(PID\)"/);
  assert.match(controlCenter, /service-detail-metadata-item is-endpoint/);
  assert.match(controlCenter, /service-detail-metadata-item is-log-actions/);
  assert.match(controlCenter, />\s*日志\s*</);
  assert.match(controlCenter, /className="service-detail-log-action"[\s\S]*?aria-label="查看日志"[\s\S]*?<LogArticleIcon \/>/);
  assert.match(controlCenter, /className="service-detail-log-action"[\s\S]*?aria-label="打开日志位置"[\s\S]*?<LogFolderIcon \/>/);
  assert.match(controlCenter, /icon:\s*"article"/);
  assert.match(controlCenter, /icon:\s*"folder"/);
  assert.match(controlCenter, /action\.icon ===[\s\S]*?"article"[\s\S]*?<LogArticleIcon \/>[\s\S]*?<LogFolderIcon \/>/);
  assert.match(controlCenter, /aria-label="显示配置文件位置"[\s\S]*?<LogFolderIcon \/>/);
  assert.match(controlCenter, /openLogViewer\([\s\S]*?activeDetailService,[\s\S]*?"main"/);
  assert.match(controlCenter, /revealServicePath\(\s*activeDetailService\s*\.healthMeta\.logFilePath,\s*"file",?\s*\)/);
  assert.match(controlCenter, /config-title-main[\s\S]*?config-title-label[\s\S]*?config-terminal-icon[\s\S]*?<ConfigTerminalIcon \/>[\s\S]*?<h3>配置<\/h3>[\s\S]*?config-file-select config-title-file-select[\s\S]*?data-config-file-select-root[\s\S]*?config-file-select-trigger[\s\S]*?aria-haspopup="listbox"[\s\S]*?config-file-select-panel[\s\S]*?role="listbox"[\s\S]*?config-select-wrap/);
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
  assert.match(controlCenter, /aria-label="详情"[\s\S]*?<ServiceInfoIcon \/>/);
  assert.match(controlCenter, /activeDetailService\.status !== "running"/);
  assert.match(controlCenter, /role="button"[\s\S]*?handleServiceCardKeyDown\(\s*event,\s*cardId,?\s*\)/);
  assert.doesNotMatch(controlCenter, /<p className="service-nav-description">/);
  assert.match(controlCenter, /service-nav-version-inline/);
  assert.match(controlCenter, /管理并监控您的基础设施服务集群。/);
  assert.match(controlCenter, /已注册服务/);
  assert.match(controlCenter, /运行中实例/);
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
  assert.match(controlCenter, /data-tooltip="查看说明"/);
  assert.match(controlCenter, /data-tooltip="打开前端"/);
  assert.match(
    controlCenter,
    /data-tooltip=\{\s*activeDetailService\.status ===\s*"initialization-required"\s*\?\s*"初始化"\s*:\s*"重新初始化"\s*\}/
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
  const globalStyles = readRendererStyles();
  const nativeAssistantDockPath = path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx");

  assert.equal(fs.existsSync(nativeAssistantDockPath), false);
  assert.match(appShell, /function AgentWebclientCopilotDock/);
  assert.match(appShell, /onOpenAssistantDock=\{\(\) => openAssistantDock\(\)\}/);
  assert.match(appShell, /embedPath=\{AGENT_WEBCLIENT_COPILOT_PATH\}/);
  assert.match(sidebarSource, /sidebar-top-actions/);
  assert.match(sidebarSource, /sidebar-assistant-top-button/);
  assert.match(sidebarSource, /"打开 ZenMind 助手"/);
  assert.match(sidebarSource, /"关闭 ZenMind 助手"/);
  assert.match(sidebarSource, /"当前页面不可开启 ZenMind 助手"/);
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
  const collapseButtonRule = globalStyles.match(/^\.app-sidebar-collapse-button\s*\{(?<body>[\s\S]*?)^\}/m)?.groups?.body;

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
  assert.match(globalStyles, /\.app-sidebar-resize-overlay\s*\{/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button\.is-compact\s*\{[\s\S]*?width:\s*24px;/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button\.is-nav\s*\{[\s\S]*?width:\s*var\(--sidebar-collapse-toggle-nav-width, 48px\);/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button-icon-chevron::before/);
  assert.match(globalStyles, /\.app-sidebar-collapse-button-icon-panel\s*\{[\s\S]*?width:\s*16px;/);
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

  assert.match(sidebarSource, /taskBoardNavItem[\s\S]*?orderKey:\s*"kanban"[\s\S]*?to:\s*"\/kanban"[\s\S]*?label:\s*"任务看板"/);
  assert.match(sidebarSource, /assistantGroupNavItem[\s\S]*?orderKey:\s*"group:assistants"[\s\S]*?label:\s*"智能助理"/);
  assert.match(sidebarSource, /websitesGroupNavItem[\s\S]*?orderKey:\s*"group:websites"[\s\S]*?label:\s*"内嵌网站"/);
  assert.match(sidebarSource, /SIDEBAR_GROUP_STATE_STORAGE_KEY/);
  assert.doesNotMatch(sidebarSource, /assistantHomeNavItem/);
  assert.doesNotMatch(sidebarSource, /智能助理首页|智能助手首页/);
  assert.match(sidebarSource, /createAgentRoute\(agent\.agentKey\)/);
  assert.match(sidebarSource, /createAgentChatRoute\(chat\.agentKey/);
  assert.match(sidebarSource, /createAgentNewChatRoute\(agent\.agentKey\)/);
  assert.match(sidebarSource, /createAgentEmbedPath/);
  assert.match(sidebarSource, /\/agent\/\$\{encodeURIComponent\(agentKey\)\}/);
  assert.match(sidebarSource, /embedPath=\$\{encodeURIComponent\(embedPath\)\}/);
  assert.match(sidebarSource, /params\.set\("chatId"/);
  assert.doesNotMatch(sidebarSource, /newChat=1/);
  assert.doesNotMatch(sidebarSource, /nonce=/);
  assert.doesNotMatch(sidebarSource, /AssistantHistoryState/);
  assert.doesNotMatch(sidebarSource, /assistantHistory/);
  assert.doesNotMatch(sidebarSource, /renderAssistantHistory/);
  assert.match(sidebarSource, /renderStatusBadges/);
  assert.match(sidebarSource, /summarizeAgentStatus\(assistantNavAgents\)/);
  assert.match(sidebarSource, /assistant-worker-collapse worker-collapse/);
  assert.match(sidebarSource, /ant-collapse-item/);
  assert.match(sidebarSource, /ant-collapse-header-text/);
  assert.match(sidebarSource, /<AgentIcon icon=\{agent\.icon\} className="worker-panel-icon" size=\{32\} type="agent" \/>/);
  assert.doesNotMatch(sidebarSource, /renderAssistantAgentIcon/);
  assert.doesNotMatch(sidebarSource, /SidebarIllustration kind="agent"/);
  assert.match(sidebarSource, /worker-panel-header-body/);
  assert.match(sidebarSource, /worker-panel-role/);
  assert.match(sidebarSource, /worker-panel-preview/);
  assert.match(sidebarSource, /worker-chat-item-head/);
  assert.match(sidebarSource, /worker-chat-name/);
  assert.match(sidebarSource, /worker-panel-time-label/);
  assert.match(sidebarSource, /title="全部已读"/);
  assert.match(sidebarSource, /title="新建对话"/);
  assert.match(sidebarSource, /查看更多（共/);
  assert.match(sidebarSource, /等待审批/);
  assert.match(sidebarSource, /exportChat/);
  assert.match(sidebarSource, /renameChat/);
  assert.match(sidebarSource, /archiveChat/);
  assert.match(sidebarSource, /fixedToolRows[\s\S]*?to:\s*"\/agents"[\s\S]*?label:\s*"智能体"[\s\S]*?to:\s*"\/schedules"[\s\S]*?label:\s*"自动化"[\s\S]*?to:\s*"\/memory"[\s\S]*?label:\s*"记忆管理"/);
  assert.match(sidebarSource, /fixedToolRows[\s\S]*?to:\s*"\/control-center"[\s\S]*?label:\s*"控制中心"[\s\S]*?to:\s*"\/market"[\s\S]*?label:\s*"功能市场"[\s\S]*?to:\s*"\/settings"[\s\S]*?label:\s*"设置"[\s\S]*?to:\s*"\/help"[\s\S]*?label:\s*"帮助"/);
  assert.match(sidebarSource, /sidebar-footer-divider/);
  assert.match(sidebarSource, /createPortal/);
  assert.match(sidebarSource, /sidebar-tool-menu-trigger/);
  assert.match(sidebarSource, /sidebar-tool-menu-item/);
  assert.match(sidebarSource, /sidebar-assistant-top-button/);
  assert.match(sidebarSource, /sidebar-group-heading/);
  assert.doesNotMatch(sidebarSource, /sidebar-tool-grid/);
  assert.doesNotMatch(sidebarSource, /sidebar-assistant-launcher/);
  assert.doesNotMatch(sidebarSource, /sortSidebarNavItems\(/);
  assert.match(sidebarSource, /taskBoardNavItem,[\s\S]*?assistantGroupNavItem,[\s\S]*?websitesGroupNavItem/);
  assert.match(globalStyles, /\.sidebar-tool-menu\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(globalStyles, /\.sidebar-group-heading\s*\{/);
  assert.match(globalStyles, /\.sidebar-group-divider\s*\{/);
  assert.match(globalStyles, /\.sidebar-group-children\s*\{[\s\S]*?margin:\s*0 4px 4px;[\s\S]*?border-left:\s*0;/);
  assert.match(globalStyles, /\.worker-panel-role\s*\{[\s\S]*?font-size:\s*11px;/);
  assert.match(globalStyles, /\.worker-panel-preview\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?height:\s*20px;/);
  assert.match(globalStyles, /\.worker-chat-name\s*\{[\s\S]*?font-size:\s*12px;/);
  assert.match(globalStyles, /\.assistant-worker-header\s*\{[\s\S]*?padding:\s*6px 2px;/);
  assert.match(globalStyles, /\.assistant-worker-collapse-item\.ant-collapse-item-active \.assistant-worker-header\s*\{[\s\S]*?padding:\s*6px 10px;/);
  assert.match(globalStyles, /\.ant-collapse-item-active \.worker-panel-icon\s*\{[\s\S]*?transform:\s*scale\(0\.8\);/);
  assert.match(agentIconSource, /BUILTIN_ICON_CONFIGS/);
  assert.match(agentIconSource, /ledger/);
  assert.match(agentIconSource, /isImageIcon/);

  assert.match(appShell, /AGENT_WEBCLIENT_ROUTE_ITEMS/);
  assert.match(appShell, /<Route path="\/kanban" element=\{<KanbanPlaceholderPage \/>/);
  assert.match(appShell, /function KanbanPlaceholderPage\(\)/);
  assert.match(appShell, />任务看板</);
  assert.match(appShell, /assistantNavAgents/);
  assert.match(appShell, /listNavigationAgents/);
  assert.match(appShell, /routePath:\s*"\/agents"[\s\S]*?embedPath:\s*"\/agents"[\s\S]*?label:\s*"智能体"/);
  assert.match(appShell, /routePath:\s*"\/schedules"[\s\S]*?embedPath:\s*"\/schedules"[\s\S]*?label:\s*"自动化"/);
  assert.match(appShell, /routePath:\s*"\/memory"[\s\S]*?embedPath:\s*"\/memory"[\s\S]*?label:\s*"记忆管理"/);
  assert.match(appShell, /const activeAgentWebclientRoute = resolveAgentWebclientRoute\(location\.pathname,\s*location\.search\)/);
  assert.match(appShell, /function readAgentWebclientRouteEmbedPath\(search: string\)/);
  assert.match(appShell, /new URLSearchParams\(search\)\.get\("embedPath"\)/);
  assert.match(appShell, /embedPath\.startsWith\("\/agent\/"\) \? "智能助理" : "智能体"/);
  assert.match(appShell, /activeAgentWebclientRoute[\s\S]*?\? "agent-webclient"[\s\S]*?: resolvePluginRouteId\(location\.pathname\)/);
  assert.match(appShell, /embedPath=\{pluginId === "agent-webclient" \? activeAgentWebclientRoute\?\.embedPath : undefined\}/);
  assert.match(appShell, /if \(currentRoute !== pendingSidebarNavigationPath\)/);
  assert.match(appShell, /const usesEmbeddedSurface =[\s\S]*?Boolean\(activeAgentWebclientRoute\)/);
  assert.match(appShell, /const usesPluginSurface =[\s\S]*?Boolean\(activeAgentWebclientRoute\)[\s\S]*?location\.pathname\.startsWith\("\/service\/"\)[\s\S]*?location\.pathname\.startsWith\("\/plugin\/"\)/);
  assert.match(appShell, /<Route path="\/agents" element=\{null\} \/>/);
  assert.match(appShell, /<Route path="\/schedules" element=\{null\} \/>/);
  assert.match(appShell, /<Route path="\/memory" element=\{null\} \/>/);
  assert.doesNotMatch(appShell, /path="\/agents"[\s\S]{0,180}<PlaceholderPage/);

  assert.match(pluginPage, /embedPath\?: string;/);
  assert.match(pluginPage, /surfaceLabel\?: string;/);
  assert.match(pluginPage, /routeEmbedPath/);
  assert.match(pluginPage, /effectiveEmbedPath/);
  assert.match(pluginPage, /get\("embedPath"\)/);
  assert.match(pluginPage, /embedPath: effectiveEmbedPath/);
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
  assert.match(settingsSections, /id:\s*"appearance"[\s\S]*?label:\s*"外观"[\s\S]*?layout:\s*"measure"/);
  assert.match(settingsSections, /id:\s*"navigation"[\s\S]*?label:\s*"导航栏"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsSections, /id:\s*"quickAssistant"[\s\S]*?label:\s*"快捷助手"[\s\S]*?layout:\s*"measure"/);
  assert.doesNotMatch(settingsSections, /id:\s*"sideAssistant"/);
  assert.match(settingsSections, /id:\s*"desktopPet"[\s\S]*?label:\s*"宠物助手"/);
  assert.match(settingsSections, /id:\s*"embeddedWebsites"[\s\S]*?label:\s*"内嵌网站"[\s\S]*?layout:\s*"wide"/);
  assert.match(settingsSections, /id:\s*"dataRoot"[\s\S]*?label:\s*"数据目录"/);
  assert.match(settingsSections, /id:\s*"memory"[\s\S]*?label:\s*"助手记忆"[\s\S]*?layout:\s*"wide"/);
  assert.doesNotMatch(settingsSections, /icon:/);

  assert.doesNotMatch(sidebarSource, /isSettingsMode\?: boolean;/);
  assert.doesNotMatch(sidebarSource, /settingsSections\?: SettingsSectionDefinition\[\];/);
  assert.doesNotMatch(sidebarSource, /pendingSettingsSectionId\?: SettingsSectionId \| null;/);
  assert.doesNotMatch(sidebarSource, /sidebar-settings-nav/);
  assert.doesNotMatch(sidebarSource, /sidebar-link-settings/);
  assert.match(sidebarSource, /to:\s*"\/settings"[\s\S]*?label:\s*"设置"/);
  assert.match(sidebarSource, /fixedToolRows/);
  assert.match(sidebarSource, /sidebar-assistant-top-button/);
  assert.match(sidebarSource, /app-sidebar-collapse-button/);

  assert.match(settingsPage, /createSettingsSectionDefinitions/);
  assert.match(settingsPage, /switch \(activeSection\)/);
  assert.match(settingsPage, /case "appearance"/);
  assert.match(settingsPage, /case "memory"/);
  assert.match(settingsPage, /split-workspace-layout/);
  assert.match(settingsPage, /settings-directory-nav/);
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
  assert.match(settingsPage, /showSectionNotice\("desktopPet", nextState\.enabled \? "桌面宠物已开启。" : "桌面宠物已关闭。", "success"\)/);
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
  assert.match(settingsPage, /导航栏/);
  assert.doesNotMatch(settingsPage, /半透明度/);
  assert.doesNotMatch(settingsPage, /导航栏半透明效果/);
  assert.doesNotMatch(settingsPage, /type="range"/);
  assert.match(settingsPage, /固定主导航/);
  assert.match(settingsPage, /固定工具区/);
  assert.match(settingsPage, /带侧边助手/);
  assert.match(settingsPage, /不带侧边助手/);
  assert.match(settingsPage, /getCopilotPageKeyForSidebarNavOrderItem/);
  assert.match(settingsPage, /handleSelectNavigationCopilotAgent/);
  assert.match(settingsPage, /aria-label="固定主导航顺序"/);
  assert.match(settingsPage, /data-sidebar-nav-order-key/);
  assert.doesNotMatch(settingsPage, /handleSidebarNavPointerDown/);
  assert.doesNotMatch(settingsPage, /document\.addEventListener\("pointermove"/);
  assert.doesNotMatch(settingsPage, /navigation-order-drag-handle/);
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
  assert.doesNotMatch(settingsPage, /case "sideAssistant"/);
  assert.doesNotMatch(settingsPage, /SIDE ASSISTANT/);
  assert.match(settingsPage, /侧边助手默认智能体/);
  assert.match(settingsPage, /宠物助手/);
  assert.match(settingsPage, /quickAssistantEnabled/);
  assert.match(settingsPage, /quickAssistantAgentKey/);
  assert.match(settingsPage, /handleToggleQuickAssistantEnabled/);
  assert.match(settingsPage, /handleSelectQuickAssistantAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*quickAssistantAgentKey: normalizedAgentKey\s*\}\)/);
  assert.doesNotMatch(settingsPage, /页面 Copilot/);
  assert.doesNotMatch(settingsPage, />选择宠物</);
  assert.doesNotMatch(settingsPage, /半透明侧边栏/);
  assert.match(settingsPage, /fixedNavigationToolRows[\s\S]*?label:\s*"智能体"[\s\S]*?label:\s*"自动化"[\s\S]*?label:\s*"记忆管理"/);
  assert.match(settingsPage, /fixedNavigationToolRows[\s\S]*?label:\s*"控制中心"[\s\S]*?label:\s*"功能市场"[\s\S]*?label:\s*"设置"[\s\S]*?label:\s*"帮助"/);
  assert.match(settingsPage, /copilotPageKey:\s*"controlCenter"/);
  assert.match(settingsPage, /copilotPageKey:\s*"market"/);
  assert.match(settingsPage, /navigation-order-fixed-label/);
  assert.match(settingsPage, /\{sidebarNavOrder\.map/);
  assert.match(settingsPage, /\{fixedNavigationTools\.map\(\(tool\) => renderFixedNavigationToolRow\(tool\)\)\}/);
  assert.match(settingsPage, /handleSelectDesktopHelperAgentKey/);
  assert.match(settingsPage, /window\.electronAPI\.assistant\.saveSettings\(\{\s*desktopHelperAgentKey: normalizedAgentKey\s*\}\)/);
  assert.match(settingsPage, /desktopCopilotPages: nextPages/);
  assert.match(settingsPage, /下方每个固定工具入口可单独选择是否显示侧边助手/);
  assert.match(settingsPage, /顺序固定为任务看板、智能助理、内嵌网站/);
  assert.match(settingsPage, /固定为弹出菜单，不参与排序/);
  assert.match(settingsPage, /aria-label="快捷助手配置"/);
  assert.match(settingsPage, /aria-label="侧边助手默认智能体"/);
  assert.match(globalStyles, /grid-template-columns:\s*minmax\(140px,\s*1fr\)\s*minmax\(220px,\s*300px\)\s*124px/);
  assert.doesNotMatch(settingsPage, /onClick=\{resetSidebarNavOrder\}/);
  assert.doesNotMatch(settingsPage, /moveSidebarNavOrderItem/);
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
  assert.match(appShell, /assistantDockOpenRequestPathRef = useRef<string \| null>\(null\)/);
  assert.match(appShell, /assistantDockOpenRequestPathRef\.current !== location\.pathname[\s\S]*?setAssistantDockOpenRequest\(null\)/);
  assert.match(appShell, /assistantDockOpenRequestPathRef\.current = location\.pathname[\s\S]*?setAssistantDockOpenRequest\(request\)/);
  assert.match(appShell, /const targetAgentKey = openRequest\?\.agentKey \?\? openRequest\?\.workerKey \?\? resolvedAgentKey/);
  assert.match(appShell, /data-open-agent-key=\{targetAgentKey\}/);
  assert.match(appShell, /key=\{`agent-webclient-copilot:\$\{targetAgentKey\}`\}/);
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

test("custom sidebar agent association is exposed across desktop api layers", () => {
  const contracts = readSharedContractsSource();
  const store = fs.readFileSync(path.join(projectRoot, "src", "main", "navigation", "custom-sidebar-store.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const appShell = readAppShellSource();

  assert.match(contracts, /agentKey\?: string/);
  assert.match(contracts, /interface CustomSidebarUpdateInput/);
  assert.match(contracts, /update: \(id: string, input: CustomSidebarUpdateInput\) => Promise<CustomSidebarItemResult>/);
  assert.match(store, /export function updateCustomSidebarItem/);
  assert.match(store, /delete updated\.agentKey/);
  assert.match(mainProcess, /ipcMain\.handle\("customSidebar\.update"/);
  assert.match(preload, /update: \(id, input\) => ipcRenderer\.invoke\("customSidebar\.update", id, input\)/);
  assert.match(appShell, /resolvedCopilotAgentKey/);
});

test("assistant navigation agents are exposed through dedicated ipc without changing pet agents", () => {
  const contracts = readSharedContractsSource();
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(projectRoot, "src", "main", "copilot", "core", "agent-platform-bridge.ts"), "utf8");
  const appShell = readAppShellSource();

  assert.match(contracts, /interface AssistantNavAgentItem/);
  assert.match(contracts, /icon\?: AssistantNavAgentIcon/);
  assert.match(contracts, /recentChats: AssistantNavChatItem\[\]/);
  assert.match(contracts, /hasPendingAwaiting:\s*boolean/);
  assert.match(contracts, /interface AssistantNavAgentItemsResult/);
  assert.match(contracts, /AssistantNavigationAgentsChangedListener/);
  assert.match(contracts, /listAgents: \(\) => Promise<DesktopPetAgentOption\[\]>/);
  assert.match(contracts, /listNavigationAgents: \(\) => Promise<AssistantNavAgentItemsResult>/);
  assert.match(contracts, /markAgentChatsRead: \(agentKey: string\) => Promise<AssistantNavActionResult>/);
  assert.match(preload, /listAgents: \(\) => ipcRenderer\.invoke\("assistant\.listAgents"\)/);
  assert.match(preload, /listNavigationAgents: \(\) => ipcRenderer\.invoke\("assistant\.listNavigationAgents"\)/);
  assert.match(preload, /onNavigationAgentsChanged/);
  assert.match(mainProcess, /ipcMain\.handle\("assistant\.listAgents"/);
  assert.match(mainProcess, /ipcMain\.handle\("assistant\.listNavigationAgents"/);
  assert.match(mainProcess, /AssistantNavigationStatusClient/);
  assert.match(mainProcess, /assistant\.navigationAgentsChanged/);
  assert.match(mainProcess, /ok:\s*false,[\s\S]*?items:\s*\[\]/);
  assert.match(bridge, /async listAgents\(\): Promise<DesktopPetAgentOption\[\]>/);
  assert.match(bridge, /async listNavigationAgents\(\): Promise<AssistantNavAgentItemsResult>/);
  assert.match(bridge, /readAssistantNavigationAgentsFromPlatform/);
  assert.match(appShell, /setAssistantNavAgents\(result\.ok \? result\.items : \[\]\)/);
  assert.match(appShell, /onNavigationAgentsChanged/);
  assert.doesNotMatch(appShell, /setInterval\([\s\S]*?listNavigationAgents/);
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
  const marketPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginMarketPage.tsx"),
    "utf8"
  );

  assert.match(actionCatalog, /DESKTOP_ACTION_BRIDGE_HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(actionCatalog, /DESKTOP_ACTION_BRIDGE_PORT\s*=\s*11788/);
  assert.match(actionCatalog, /page_control/);
  assert.match(actionCatalog, /desktop\.controlCenter\.listServices/);
  assert.match(actionCatalog, /desktop\.settings\.applyPatch/);
  assert.doesNotMatch(actionCatalog, /desktop\.page\./);
  assert.doesNotMatch(actionCatalog, /desktop\.embeddedWeb\./);
  assert.match(actionCatalog, /desktop\.market\.applySettingsPatch/);
  assert.match(actionCatalog, /desktop\.automations\.listSchedules/);
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
  const appShell = readAppShellSource();
  const globalStyles = readRendererStyles();
  const marketStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginMarketPage.css"),
    "utf8"
  );

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

  assert.match(pluginPage, /registerAssistantPageContextProvider/);
  assert.doesNotMatch(pluginPage, /<<<<<<<|=======|>>>>>>>/);
  assert.match(pluginPage, /registerDesktopActionProviderForScope\("embeddedWeb"/);
  assert.match(pluginPage, /skipContextRegistration\?: boolean/);
  assert.match(pluginPage, /service\?\.status !== "running" \|\| skipContextRegistration/);
  assert.match(pluginPage, /!embeddedUrl \|\| skipContextRegistration/);
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
  assert.match(pluginPage, /buildAgentWebclientDesktopContext\(getCurrentPageContextSnapshot\(\)\)/);
  assert.match(pluginPage, /seedAgentWebclientAccessToken/);
  assert.match(pluginPage, /buildAgentWebclientAccessTokenInjectionScript/);
  assert.match(pluginPage, /if \(!bridgeReady \|\| !serviceWebviewPreloadPath\) \{[\s\S]{0,80}return undefined;/);
  assert.match(pluginPage, /bridgeReady,[\s\S]{0,120}serviceWebviewPreloadPath,[\s\S]{0,120}webviewRenderKey/);
  assert.match(pluginPage, /if \(active === false \|\| !bridgeReady \|\| !serviceWebviewPreloadPath\) \{[\s\S]{0,80}return;[\s\S]{0,120}seedAgentWebclientAccessToken\(\)/);
  assert.match(pluginPage, /\[active, bridgeReady, embeddedUrl, service\?\.id, serviceWebviewPreloadPath, webviewRenderKey\]/);
  assert.match(pluginPage, /__ZENMIND_AGENT_WEBCLIENT_AUTH_FALLBACK__/);
  assert.match(pluginPage, /agentWebclientTokenReloadTimerRef/);
  assert.match(pluginPage, /webviewRef\.current\?\.reload\(\)/);
  assert.match(pluginPage, /issueAccessToken\("missing"\)/);
  assert.match(pluginPage, /agent_webclient_seed_/);
  assert.match(pluginPage, /SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE/);
  assert.match(serviceWebviewPreload, /sendToHost/);
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
  assert.match(serviceWebviewPreload, /AGENT_APP_CLIPBOARD_REQUEST_TYPE/);
  assert.match(serviceWebviewPreload, /DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE/);
  assert.match(globalStyles, /\.embedded-plugin-error\s*\{/);
});

test("embedded cdp exposes service frontends as webview surfaces", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(mainProcess, /createEmbeddedCdpServiceSurface/);
  assert.match(mainProcess, /kind:\s*"webview"/);
  assert.match(mainProcess, /webContentsId:\s*contents\?\.id/);
  assert.match(mainProcess, /resolveEmbeddedCdpWebContents\(surface\)/);
  assert.doesNotMatch(mainProcess, /failed to list iframe targets/);
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
  assert.match(mainProcess, /embedPath=\$\{encodeURIComponent\(embedPath\)\}/);
  assert.match(mainProcess, /openAgent: scheduleQuickAgentOpenRequest/);
  assert.match(mainProcess, /async function openAssistantFromDesktopPet/);
  assert.match(mainProcess, /showAssistantTargetWindow\(\s*"desktop-pet",[\s\S]*?createAgentWebclientRoute/);
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
  assert.match(logViewerPage, /aria-label=\{tailFollowEnabled \? "取消自动滚动" : "开启自动滚动"\}/);
  assert.match(logViewerPage, /className="log-viewer-live-dot"/);
  assert.match(logViewerPage, /aria-hidden="true"/);
  assert.match(logViewerPage, /aria-label="滚动到顶部"/);
  assert.match(logViewerPage, /aria-label="滚动到底部"/);
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
  const appShell = readAppShellSource();
  const dockComponent = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "copilot", "sidebar-copilot", "AgentWebclientCopilotDock.tsx"),
    "utf8"
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
  assert.match(settingsPage, /桌面宠物形象切换未生效/);
  assert.match(settingsPage, /disabled=\{Boolean\(desktopPetAppearancePending\) && !selected\}/);
  assert.doesNotMatch(settingsPage, /disabled=\{Boolean\(desktopPetAppearancePending\) \|\| selected\}/);
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
