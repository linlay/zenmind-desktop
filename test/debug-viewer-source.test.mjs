import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

function readSourceFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("debug viewer IPC and webRequest listeners are wired in the main process", () => {
  const mainProcess = readSourceFile("src", "main", "index.ts");
  const debugHandlers = readSourceFile("src", "main", "ipc", "debug-handlers.ts");
  const debugWindow = readSourceFile("src", "main", "app-shell", "debug-viewer-window.ts");

  assert.match(mainProcess, /WebviewDebugManager/);
  assert.match(mainProcess, /DebugViewerWindowController/);
  assert.match(mainProcess, /session\.defaultSession/);
  assert.match(mainProcess, /registerDebugIpcHandlers/);
  assert.match(debugHandlers, /debug\.openViewer/);
  assert.match(debugHandlers, /debug\.registerWebviewSurface/);
  assert.match(debugHandlers, /debug\.openWebviewDevTools/);
  assert.match(debugHandlers, /webContents\.fromId\(webContentsId\)/);
  assert.match(debugWindow, /DEBUG_VIEWER_ROUTE/);
  assert.match(debugWindow, /loadRendererRoute\(targetWindow, DEBUG_VIEWER_ROUTE\)/);
});

test("debug API is exposed through shared contracts and preload", () => {
  const contracts = readSourceFile("src", "shared", "contracts", "desktop-api.ts");
  const preload = readSourceFile("src", "preload", "index.ts");

  assert.match(contracts, /debug:\s*\{/);
  assert.match(contracts, /openViewer:\s*\(\) => Promise<\{ ok: boolean \}>/);
  assert.match(contracts, /listEvents:\s*\(\) => Promise<DebugEvent\[\]>/);
  assert.match(contracts, /registerWebviewSurface/);
  assert.match(contracts, /openWebviewDevTools/);
  assert.match(preload, /debug:\s*\{/);
  assert.match(preload, /ipcRenderer\.invoke\("debug\.openViewer"\)/);
  assert.match(preload, /ipcRenderer\.on\("debug\.event"/);
});

test("renderer registers embedded webview surfaces and exposes the debug route", () => {
  const app = readSourceFile("src", "renderer", "App.tsx");
  const externalWebview = readSourceFile("src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx");
  const pluginPage = readSourceFile("src", "renderer", "pages", "plugin", "PluginPage.tsx");
  const settingsSections = readSourceFile("src", "renderer", "settingsPageSections.ts");
  const settingsPage = readSourceFile("src", "renderer", "pages", "settings", "SettingsPage.tsx");

  assert.match(app, /DebugViewerPage/);
  assert.match(app, /location\.pathname === "\/debug-viewer"/);
  assert.match(externalWebview, /registerWebviewSurface/);
  assert.match(externalWebview, /unregisterWebviewSurface/);
  assert.match(pluginPage, /registerWebviewSurface/);
  assert.match(pluginPage, /unregisterWebviewSurface/);
  assert.match(settingsSections, /"debug"/);
  assert.match(settingsPage, /settings\.debug\.openViewer/);
  assert.match(settingsPage, /window\.electronAPI\.debug\.openViewer/);
});
