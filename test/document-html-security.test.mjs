import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHtmlTestSession } from "./helpers/document-html-session.mjs";
import { DocumentHtmlPreviewSessions } from "../dist-electron/main/modules/work-panel/document-html-preview.js";
import { WorkPanelDocumentHtmlRegistry } from "../dist-electron/main/modules/work-panel/document-html.js";
import { performHtmlFileAction } from "../dist-electron/main/modules/work-panel/document-html-file-actions.js";
import { prepareWebviewAttachPreferences } from "../dist-electron/main/modules/shell/window-manager.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "document-html-boundary-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const semanticPath = "artifacts/report/目录 空格%# 页面.html";
  const filePath = path.join(root, semanticPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "<!doctype html><h1>Safe fixture</h1><script>window.inlineWorks=true</script>");
  return { handleId: "abc123", rendererWebContentsId: 72, source: { kind: "artifact", resourceId: "opaque-id-not-the-directory", chatId: "chat1", agentKey: "agent1", relativePath: semanticPath },
    fileName: path.basename(filePath), filePath, semanticPath, authorityRoot: root, temporary: false, localOriginal: true };
}

test("HTML protocol serves unchanged source and bounds every asset request to this artifact", async (t) => {
  const document = fixture(t);
  const fake = createHtmlTestSession();
  const sessions = new DocumentHtmlPreviewSessions(() => fake.session);
  t.after(() => sessions.release(document.handleId));
  const preview = sessions.open(document);
  assert.equal(await (await fake.request(preview.url)).text(), fs.readFileSync(document.filePath, "utf8"));
  assert.equal((await fake.request(preview.url)).headers.has("Content-Security-Policy"), false);
  assert.equal((await fake.request(preview.url, "POST")).status, 403);
  for (const relative of ["../other/file.html", "../../private.json", "%2e%2e%2fsecret", "%5csecret", "%00.js"]) {
    assert.equal((await fake.request(new URL(relative, preview.url).href)).status, 403, relative);
  }
  const outside = path.join(document.authorityRoot, "private.json");
  fs.writeFileSync(outside, "secret");
  fs.symlinkSync(outside, path.join(path.dirname(document.filePath), "escape.json"));
  assert.equal((await fake.request(new URL("escape.json", preview.url).href)).status, 404);
  assert.equal((await fake.request(preview.url.replace("abc123", "forged"))).status, 403);
  let allowed;
  for (const url of ["https://cdn.example/echarts.js", "https://api.example/data", "wss://api.example/live"]) {
    fake.state.beforeRequest({ url, resourceType: "script" }, (result) => { allowed = !result.cancel; });
    assert.equal(allowed, true);
  }
  for (const url of ["file:///etc/passwd", "zenmind-local-file://other/a", "cutej://action"]) {
    fake.state.beforeRequest({ url, resourceType: "script" }, (result) => { allowed = !result.cancel; });
    assert.equal(allowed, false);
  }
  fake.state.beforeRequest({ url: "https://example.com", resourceType: "mainFrame" }, (result) => { allowed = !result.cancel; });
  assert.equal(allowed, false);
  assert.equal(fake.state.permissionCheck(), false);
  assert.equal(fake.state.devicePermission(), false);
  fake.state.permissionRequest(null, "camera", (result) => assert.equal(result, false));
  assert.equal(sessions.canAttach(preview.url, preview.partition, 72), true);
  assert.equal(sessions.canAttach(preview.url, preview.partition, 73), false);
  assert.equal(sessions.canAttach(preview.url, "persist:desktop-sso", 72), false);
  sessions.release(document.handleId);
  assert.equal(fake.state.cleared && fake.state.closed && fake.state.unhandled, true);
  assert.equal(sessions.canAttach(preview.url, preview.partition, 72), false);
  assert.equal((await fake.request(preview.url)).status, 403);
});

test("remote assets use the same resource boundary and fail after release", async (t) => {
  const document = { ...fixture(t), temporary: true, localOriginal: false, authorityRoot: "" };
  const fake = createHtmlTestSession();
  const sessions = new DocumentHtmlPreviewSessions(() => fake.session);
  const calls = [];
  const preview = sessions.open(document, async (request) => { calls.push(request); return { bytes: Buffer.from("export default 42"), mimeType: "text/javascript" }; });
  assert.equal((await fake.request(new URL("module.mjs", preview.url).href)).status, 200);
  assert.deepEqual(calls, [{ chatId: "chat1", relativePath: "artifacts/report/module.mjs" }]);
  assert.equal((await fake.request(new URL("../other/module.mjs", preview.url).href)).status, 403);
  assert.equal(calls.length, 1);
  sessions.release(document.handleId);
});

test("only a registry-authorized document session can attach the isolated review preload", () => {
  const createInput = () => ({
    servicePreloadPath: "/app/service-webview.js", servicePreloadUrl: "file:///app/service-webview.js",
    params: { src: "zenmind-document-html://abc123/site/index.html", partition: "work-panel-document-html:abc123" },
    webPreferences: { preload: "/app/document-html-review.js", nodeIntegration: true, sandbox: false, webSecurity: false },
    isSafeServiceUrl: () => true,
  });
  const input = createInput();
  assert.equal(prepareWebviewAttachPreferences(input).ok, false);
  input.isDocumentHtmlPreview = (url, partition) => url === input.params.src && partition === input.params.partition;
  assert.equal(prepareWebviewAttachPreferences(input).ok, true);
  assert.equal(input.webPreferences.sandbox, true);
  assert.equal(input.webPreferences.webSecurity, true);
  assert.equal(input.webPreferences.nodeIntegration, false);
  assert.equal(input.webPreferences.webviewTag, false);
  const noPreload = createInput();
  delete noPreload.webPreferences.preload;
  assert.equal(prepareWebviewAttachPreferences(noPreload).ok, false);
});

for (const platform of ["darwin", "win32"]) test(`HTML file actions distinguish default application from browser on ${platform}`, async (t) => {
  const document = fixture(t);
  const calls = [];
  const runtime = {
    platform, getMainWindow: () => null,
    app: { getPath: () => document.authorityRoot, getApplicationInfoForProtocol: async (url) => {
      assert.equal(url, "https://example.com"); return { path: platform === "darwin" ? "/Applications/Google Chrome.app" : "C:\\Program Files\\Browser\\browser.exe" };
    } },
    fileShell: { showItemInFolder: (file) => calls.push(["reveal", file]), openPath: async (file) => { calls.push(["default-editor", file]); return ""; } },
    launchBrowser: async (command, args) => calls.push([command, args]),
    showSaveDialog: async () => ({ canceled: true }),
  };
  for (const action of ["reveal", "open-default", "open-browser"]) {
    assert.equal((await performHtmlFileAction(document, action, runtime, () => true)).ok, true);
  }
  assert.deepEqual(calls[0], ["reveal", document.filePath]);
  assert.deepEqual(calls[1], ["default-editor", document.filePath]);
  if (platform === "darwin") assert.deepEqual(calls[2], ["/usr/bin/open", ["-a", "/Applications/Google Chrome.app", document.filePath]]);
  else { assert.equal(calls[2][0], "C:\\Program Files\\Browser\\browser.exe"); assert.match(calls[2][1][0], /^file:.*%25%23/u); }
  assert.equal((await performHtmlFileAction(document, "open-browser", runtime, () => false)).ok, false);
  const remote = { ...document, localOriginal: false, temporary: true };
  assert.equal((await performHtmlFileAction(remote, "reveal", runtime, () => true)).ok, false);
  assert.equal((await performHtmlFileAction(remote, "open-browser", runtime, () => true)).ok, true);
  assert.equal(calls.length, 3, "canceling Save As must not open anything");
  runtime.app.getApplicationInfoForProtocol = async () => { throw Error("browser unavailable"); };
  assert.equal((await performHtmlFileAction(document, "open-browser", runtime, () => true)).ok, false);
  assert.equal(calls.length, 3, "browser failure must not fall back to the file association");
  fs.unlinkSync(document.filePath);
  assert.equal((await performHtmlFileAction(document, "open-default", runtime, () => true)).ok, false);
});

test("native HTML actions reject forged identities, released handles and renderer destruction", async (t) => {
  const document = fixture(t);
  const fake = createHtmlTestSession();
  const registry = new WorkPanelDocumentHtmlRegistry(() => fake.session);
  t.after(() => registry.dispose());
  const sender = Object.assign(new EventEmitter(), { id: 72, isDestroyed: () => false });
  const operations = [];
  registry.configure({ app: { getPath: () => document.authorityRoot, once() {} }, getMainWindow: () => null,
    platform: "darwin", fileShell: { openPath: async (target) => { operations.push(target); return ""; } } });
  const prepared = await registry.prepareClaim({ ownerChatId: "chat1", rendererWebContentsId: 72,
    source: { kind: "workspace-file", agentKey: "agent1", path: document.semanticPath }, workspaceFilePath: document.filePath });
  const claimed = await registry.claim({ claimId: prepared.claimId, ownerChatId: "chat1", rendererGeneration: "gen1" }, sender);
  const request = { handleId: claimed.document.handleId, ownerChatId: "chat1", rendererGeneration: "gen1", action: "open-default" };
  for (const forged of [{ ...request, handleId: "forged" }, { ...request, ownerChatId: "chat2" }, { ...request, rendererGeneration: "old" }]) {
    assert.equal((await registry.fileAction(forged, sender)).ok, false);
    assert.equal((await registry.preview(forged, sender)).ok, false);
  }
  assert.equal((await registry.fileAction(request, { ...sender, id: 73 })).ok, false);
  assert.equal((await registry.fileAction(request, sender)).ok, true);
  sender.emit("destroyed");
  assert.equal((await registry.fileAction(request, sender)).ok, false);
  assert.equal(operations.length, 1);
});
