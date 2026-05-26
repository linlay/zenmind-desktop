import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("webview guest contents expose platform-specific DevTools shortcut", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const attachBlock = source.match(/mainWindow\.webContents\.on\("did-attach-webview"[\s\S]*?contents\.on\("did-fail-load"/u)?.[0] ?? "";

  assert.match(attachBlock, /contents\.on\("before-input-event"/u);
  assert.match(attachBlock, /process\.platform === "darwin"[\s\S]*input\.meta[\s\S]*input\.alt/u);
  assert.match(attachBlock, /process\.platform !== "darwin"[\s\S]*input\.control[\s\S]*input\.shift/u);
  assert.match(attachBlock, /event\.preventDefault\(\);[\s\S]*contents\.openDevTools\(\{\s*mode: "detach"\s*\}\)/u);
});

test("webview guest contents download generated artifacts instead of opening blank tabs", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const attachBlock = source.match(/mainWindow\.webContents\.on\("did-attach-webview"[\s\S]*?mainWindow\.loadURL/u)?.[0] ?? "";

  assert.match(attachBlock, /const downloadFromWebview = \(url: string\) => \{/u);
  assert.match(attachBlock, /contents\.downloadURL\(url\)/u);
  assert.match(attachBlock, /contents\.on\("will-navigate"[\s\S]*?shouldDownloadUrlFromWebview\(url\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?downloadFromWebview\(url\);/u);
  assert.match(attachBlock, /if \(disposition === "download"\) \{[\s\S]*?downloadFromWebview\(url\);[\s\S]*?return \{ action: "deny" \};/u);
});

test("external webview toolbar opens DevTools for the active tab", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "external-webview", "ExternalWebviewPage.tsx"),
    "utf8"
  );

  assert.match(source, /const handleOpenDevTools = \(\) => \{[\s\S]*webviewRefs\.current\.get\(activeTab\.id\)[\s\S]*activeWebview\.openDevTools\(\);/u);
  assert.match(source, /className="external-webview-devtools-toggle"/u);
  assert.match(source, /onClick=\{handleOpenDevTools\}/u);
  assert.match(source, /aria-label="打开当前网页 DevTools"/u);
});
