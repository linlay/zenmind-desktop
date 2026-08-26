import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appShellCss = fs.readFileSync(
  path.join(projectRoot, "src", "renderer", "styles", "app-shell.css"),
  "utf8",
);
const externalWebviewCss = fs.readFileSync(
  path.join(projectRoot, "src", "renderer", "styles", "external-webview.css"),
  "utf8",
);
const sidebarCopilotCss = fs.readFileSync(
  path.join(projectRoot, "src", "renderer", "styles", "sidebar-copilot.css"),
  "utf8",
);
const windowManagerSource = fs.readFileSync(
  path.join(projectRoot, "src", "main", "window-manager.ts"),
  "utf8",
);
const appShellSource = fs.readFileSync(
  path.join(projectRoot, "src", "renderer", "app-shell", "AppShell.tsx"),
  "utf8",
);
const appSidebarSource = fs.readFileSync(
  path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
  "utf8",
);

test("Windows 薄系统栏独立横跨主窗口并下移侧边栏与内容", () => {
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform\s*\{[^}]*--windows-titlebar-content-inset:\s*var\(--windows-titlebar-overlay-height\);[^}]*--app-window-drag-height:\s*0px;[^}]*--app-window-drag-left:\s*0px;[^}]*--app-window-drag-right:\s*0px;/su,
  );
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform \.app-system-bar\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0 0 auto;[^}]*height:\s*var\(--windows-titlebar-overlay-height\);/su,
  );
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform \.app-content\s*\{[^}]*margin-top:\s*var\(--windows-titlebar-content-inset\);[^}]*height:\s*calc\(100% - var\(--windows-titlebar-content-inset\)\);/su,
  );
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform \.app-sidebar-shell\s*\{[^}]*height:\s*calc\(100% - var\(--windows-titlebar-content-inset\)\);[^}]*margin-top:\s*var\(--windows-titlebar-content-inset\);/su,
  );
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform \.app-window-drag-layer\s*\{[^}]*display:\s*none;/su,
  );
  assert.match(
    sidebarCopilotCss,
    /\.app-shell\.is-windows-platform \.agent-webclient-copilot-dock\s*\{[^}]*top:\s*var\(--windows-titlebar-content-inset\);/su,
  );
});

test("Windows 业务表面不再重复增加标题栏高度", () => {
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform:not\(\.has-browser-chrome-surface\):not\(\.has-kanban-controls\):not\(\.has-market-controls\) \.app-main\s*\{[^}]*padding-top:\s*12px;/su,
  );
  assert.match(
    externalWebviewCss,
    /\.app-shell\.is-windows-platform \.external-webview-page\.is-app-surface\s*\{[^}]*inset:\s*0;/su,
  );
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform \.chat-work-panel\s*\{[^}]*--chat-work-panel-top-inset:\s*0px;/su,
  );
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform\.is-work-panel-fullscreen \.app-content\s*\{[^}]*margin-top:\s*0;[^}]*inset:\s*var\(--windows-titlebar-content-inset\) 0 0;[^}]*height:\s*auto;/su,
  );
});

test("Windows 系统栏与页面使用同一主题背景色", () => {
  assert.match(
    appShellCss,
    /--windows-titlebar-background:\s*var\(--bg-base\);/u,
  );
  assert.match(
    windowManagerSource,
    /const WINDOWS_BACKGROUND_DARK = "#181818";/u,
  );
  assert.doesNotMatch(windowManagerSource, /titleBarOverlay/u);
});

test("Windows 主导航动作紧跟品牌并从侧栏顶部移除", () => {
  const brandIndex = appShellSource.indexOf('className="app-system-bar-brand-mark"');
  const actionsIndex = appShellSource.indexOf('className="app-system-bar-primary-actions"');
  const windowControlsIndex = appShellSource.indexOf('className="app-system-bar-window-controls"');

  assert.ok(brandIndex >= 0);
  assert.ok(actionsIndex > brandIndex);
  assert.ok(windowControlsIndex > actionsIndex);
  assert.match(
    appShellSource,
    /sidebarMode === "primary"[\s\S]{0,2200}desktop\.globalSearch\.title[\s\S]{0,1000}nav\.sidebar\.expand[\s\S]{0,1000}sidebar\.navigation\.back[\s\S]{0,800}sidebar\.navigation\.forward[\s\S]{0,1400}toggleSystemBarAssistantDock/u,
  );
  assert.match(
    appShellSource,
    /const dragRegion = target\?\.closest\("\.app-window-drag-region"\);\s*if \(dragRegion && !target\?\.closest\(WINDOW_DRAG_BLOCK_SELECTOR\)\)/u,
  );
  assert.match(
    appShellSource,
    /BRAND_ID !== "cutej" \? \(\s*<span className="app-system-bar-product-name">\{PRODUCT_NAME\}<\/span>/u,
  );
  assert.match(
    appSidebarSource,
    /!isWindows \? \([\s\S]{0,220}className="sidebar-chrome"/u,
  );
  assert.match(
    appShellCss,
    /\.app-system-bar-primary-actions\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*2px;[^}]*height:\s*24px;[^}]*margin-left:\s*4px;/su,
  );
  assert.match(
    appShellCss,
    /\.app-system-bar-action\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border-radius:\s*6px;/su,
  );
});
