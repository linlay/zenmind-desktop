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

test("Windows 标题栏只占右侧内容区并让侧边栏保持顶格", () => {
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform\s*\{[^}]*--windows-titlebar-content-inset:\s*var\(--windows-titlebar-overlay-height\);[^}]*--app-window-drag-height:\s*var\(--windows-titlebar-overlay-height\);[^}]*--app-window-drag-left:\s*var\(--app-sidebar-width, 160px\);[^}]*--app-window-drag-right:\s*var\(--windows-titlebar-control-width\);/su,
  );
  assert.doesNotMatch(
    appShellCss,
    /\.app-shell\.is-windows-platform\s*\{[^}]*padding-top:/su,
  );
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform \.app-content\s*\{[^}]*margin-top:\s*var\(--windows-titlebar-content-inset\);[^}]*height:\s*calc\(100% - var\(--windows-titlebar-content-inset\)\);/su,
  );
  assert.match(
    appShellCss,
    /\.app-shell\.is-windows-platform \.app-window-drag-layer::before\s*\{[^}]*inset:\s*0 calc\(-1 \* var\(--app-window-drag-right\)\) 0 0;[^}]*background:\s*var\(--windows-titlebar-background\);/su,
  );
  assert.doesNotMatch(
    appShellCss,
    /\.app-shell\.has-browser-chrome-surface\.is-windows-platform\s*\{[^}]*--app-window-drag-height:\s*0px;/su,
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

test("Windows 深色标题栏与右侧页面使用同一背景色", () => {
  assert.match(
    appShellCss,
    /--windows-titlebar-background:\s*var\(--bg-base\);/u,
  );
  assert.match(
    windowManagerSource,
    /const WINDOWS_TITLEBAR_DARK = \{\s*color:\s*"#181818",\s*symbolColor:\s*"#F2F2F2"\s*\};/su,
  );
  assert.match(
    windowManagerSource,
    /const WINDOWS_BACKGROUND_DARK = "#181818";/u,
  );
});
