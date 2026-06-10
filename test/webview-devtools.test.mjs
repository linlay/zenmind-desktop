import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("webview guest contents expose platform-specific DevTools shortcut", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const windowManagerSource = fs.readFileSync(path.join(projectRoot, "src", "main", "window-manager.ts"), "utf8");
  const attachBlock = source.match(/configureMainWindowWebContents\(targetWindow,[\s\S]*?\n  \}\);/u)?.[0] ?? "";

  assert.match(windowManagerSource, /contents\.on\("before-input-event"/u);
  assert.match(source, /import \{[\s\S]*isDevToolsShortcut[\s\S]*\} from "\.\/platform-adapter"/u);
  assert.match(windowManagerSource, /configureAttachedWebview\(contents,/u);
  assert.match(attachBlock, /isDevToolsShortcut,/u);
  assert.match(windowManagerSource, /event\.preventDefault\(\);[\s\S]*contents\.openDevTools\(\{\s*mode: "detach"\s*\}\)/u);
});

test("focused webview shortcut reads the focused webContents instead of opening the legacy event viewer", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(source, /const FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT = getFocusedWebviewDevToolsShortcut\(mainProcessContext\.platform\)/u);
  assert.match(source, /function registerFocusedWebviewDevToolsShortcut\(\)/u);
  assert.match(source, /globalShortcut\.register\(FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT/u);
  assert.match(source, /openFocusedWebviewDevTools\(webContents\.getFocusedWebContents\(\)\)/u);
  assert.doesNotMatch(source, /const DEBUG_VIEWER_SHORTCUT/u);
  assert.doesNotMatch(source, /registerDebugViewerShortcut/u);
});

test("developer event viewer source and routes are removed", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts", "desktop-api.ts"), "utf8");
  const app = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const indexedStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles", "index.css"), "utf8");

  assert.doesNotMatch(mainProcess, /DebugViewerWindowController|WebviewDebugManager|createDebugEventStore|registerDebugIpcHandlers/u);
  assert.doesNotMatch(preload, /debug:\s*\{|debug\.event|debug\.open/u);
  assert.doesNotMatch(contracts, /debug:\s*\{|DebugEvent|DebugWebviewSurface/u);
  assert.doesNotMatch(app, /DebugViewerPage|\/debug-viewer/u);
  assert.doesNotMatch(styles, /debug-viewer/u);
  assert.doesNotMatch(indexedStyles, /debug-viewer/u);
});

test("webview guest contents download generated artifacts instead of opening blank tabs", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const windowManagerSource = fs.readFileSync(path.join(projectRoot, "src", "main", "window-manager.ts"), "utf8");
  const attachBlock = source.match(/configureMainWindowWebContents\(targetWindow,[\s\S]*?\n  \}\);/u)?.[0] ?? "";

  assert.match(attachBlock, /shouldDownloadUrl: shouldDownloadUrlFromWebview/u);
  assert.match(windowManagerSource, /const downloadFromWebview = \(url: string\) => \{/u);
  assert.match(windowManagerSource, /contents\.downloadURL\(url\)/u);
  assert.match(windowManagerSource, /contents\.on\("will-navigate"[\s\S]*?options\.shouldDownloadUrl\(url\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?downloadFromWebview\(url\);/u);
  assert.match(windowManagerSource, /if \(disposition === "download"\) \{[\s\S]*?downloadFromWebview\(url\);[\s\S]*?return \{ action: "deny" \};/u);
});

test("external webview toolbar opens DevTools for the active tab", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx"),
    "utf8"
  );

  assert.match(source, /const handleOpenDevTools = \(\) => \{[\s\S]*webviewRefs\.current\.get\(activeTab\.id\)[\s\S]*window\.electronAPI\.webview\.openDevTools\(webContentsId\);/u);
  assert.doesNotMatch(source, /activeWebview\.openDevTools\(\);/u);
  assert.match(source, /className="external-webview-devtools-toggle"/u);
  assert.match(source, /onClick=\{handleOpenDevTools\}/u);
  assert.match(source, /aria-label="打开当前网页 DevTools"/u);
});
