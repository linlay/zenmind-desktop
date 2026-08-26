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
