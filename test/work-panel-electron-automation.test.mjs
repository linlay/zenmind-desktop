import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadBrandConfig, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const root = path.resolve(import.meta.dirname, "..");
function electronExecutable() {
  const suffix = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
  return [root, path.resolve(root, "../zenmind-desktop")].map(base => path.join(base, "node_modules/electron/dist", suffix))
    .find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}
const electron = electronExecutable();

// Runs inside Electron main: a real guest, the real gateway and the real observation script.
const fixtureMain = String.raw`
const { app, BrowserWindow, webContents, ipcMain, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => a.slice(2).split(/=(.*)/s)));
const profile = path.join(path.dirname(args.report), "profile");
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("sessionData", profile);
if (process.platform === "darwin") app.setActivationPolicy("accessory");
const { EmbeddedCdpGateway, createEmbeddedWebSurfaceId, authorizeDesktopHostCdpCommand } = require(args.source + "/dist-electron/main/modules/web-surfaces/cdp/gateway.js");
const { acquireWorkPanelControlScope } = require(args.source + "/dist-electron/main/modules/web-surfaces/cdp/site-scope.js");
const { ensureWorkPanelPageDialogIpc } = require(args.source + "/dist-electron/main/modules/web-surfaces/cdp/page-dialogs.js");
ensureWorkPanelPageDialogIpc(ipcMain);
let nativeMessageBoxes = 0;
// Test spy prevents unexpected OS windows while still proving that agent actions never enter this API.
dialog.showMessageBox = async () => { nativeMessageBoxes++; return { response: 1, checkboxChecked: false }; };
const page = '<!doctype html><title>start</title>'
  + '<button id="confirm" onclick="document.title=\'r:\'+confirm(\'Proceed?\')">Ask</button>'
  + '<button id="alert" onclick="window.alertCount=(window.alertCount||0)+1;alert(\'Notice\');document.title=\'alert:done\'">Alert</button>'
  + '<button id="prompt" onclick="document.title=\'p:\'+prompt(\'Name?\',\'Default\')">Prompt</button>'
  + '<button id="chain" onclick="alert(\'First\');document.title=\'chain:\'+confirm(\'Second?\')">Chain</button>'
  + '<input type="file" id="visible" aria-label="Attachment">'
  + '<input type="file" id="confirmed-file" aria-label="Confirmed Attachment" onchange="document.title=\'upload:\'+confirm(\'Use file?\')">'
  + '<input type="file" id="hidden" style="display:none" multiple onchange="document.title=\'chooser:\'+confirm(\'Use files?\')"><button id="choose" onclick="document.getElementById(\'hidden\').click()">Choose files</button>'
  + '<a id="download" href="/report.csv">Report</a>'
  + '<input id="name" aria-label="Name" onkeydown="if(event.key===\'Enter\')document.title=\'enter:\'+this.value">'
  + '<label><input type="checkbox" id="agree">Agree</label>';
const report = {};
report.preload = [];
app.on("web-contents-created", (_event, contents) => contents.on("preload-error", (_event, _path, error) => report.preload.push({ error: error.message })));
ipcMain.on("fixture-preload-diagnostics", (_event, value) => report.preload.push(value));
ipcMain.on("workPanel.pageDialog", (event, value) => { if (value?.op === "ready") report.preload.push({ ready: true, mainFrame: event.senderFrame === event.sender.mainFrame, protocol: event.sender.mainFrame.url.split(":")[0] }); });
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/report.csv") { res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=report.csv", "content-length": "8" }); res.end("a,b\n1,2\n"); return; }
    res.writeHead(200, { "content-type": "text/html" }); res.end(page);
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = "http://127.0.0.1:" + server.address().port + "/";
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false } });
  win.webContents.on("will-attach-webview", (_event, preferences) => Object.assign(preferences, {
    contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
  }));
  let guest = win.webContents;
  if (args.webview === "true") {
    await win.loadURL("data:text/html,<html><body><input id=host-input></body></html>");
    const id = await win.webContents.executeJavaScript("new Promise(resolve => { const view = document.createElement('webview'); view.style='width:850px;height:650px'; view.preload=" + JSON.stringify(args.preload) + "; view.src=" + JSON.stringify(url) + "; view.addEventListener('did-finish-load', () => resolve(view.getWebContentsId()), {once:true}); document.body.append(view); })");
    guest = webContents.fromId(id);
  } else await win.loadURL(url);
  const content = guest;
  const tab = { tabId: "tab", currentUrl: url, title: "start", webContentsId: content.id, canGoBack: false, canGoForward: false, isLoading: false };
  const surface = { id: "web:fixture", targetGeneration: "g1", label: "Work Panel", url, surfaceKind: "chat-work-panel", surfaceRole: "workpanel-web",
    ownerChatId: "chat-x", open: true, active: true, tabs: [tab], activeTabId: "tab" };
  const phases = [], focusCommands = [];
  let issuedScopes = 0, modalOpen = false, restorationFailures = 0;
  const dialogEvents = [], lifecycle = [];
  const debuggerSend = content.debugger.sendCommand.bind(content.debugger);
  content.debugger.sendCommand = (method, params, sessionId) => {
    if (method === "Emulation.setFocusEmulationEnabled") {
      focusCommands.push({ enabled: params.enabled, modalOpen });
      if (args.failRestore === "true" && !params.enabled && restorationFailures === 0) {
        restorationFailures++; return Promise.reject(new Error("synthetic cleanup failure"));
      }
    }
    return debuggerSend(method, params, sessionId);
  };
  content.debugger.on("message", (_event, method, params) => {
    if (method === "Page.javascriptDialogOpening" || method === "Page.javascriptDialogClosed") dialogEvents.push({ method, at: Date.now(), params });
    if (method === "Page.javascriptDialogOpening") modalOpen = true;
    if (method === "Page.javascriptDialogClosed") modalOpen = false;
  });
  const registration = { ...surface, surfaceId: surface.id, registrationId: "g1", ownerWebContentsId: win.webContents.id };
  const registry = {
    listWorkPanelContainers: () => [surface],
    resolveWebviewSurfaceTarget: id => id === content.id ? registration : undefined,
    getRegisteredSurfaceSnapshot: (container, generation, owner) => container === surface.id && generation === "g1" && owner === win.webContents.id
      ? { registered: registration, tabs: [tab] } : undefined,
    findWebContentsById: id => id === content.id ? content : undefined,
    subscribeLifecycle: () => () => {},
  };
  const options = { getSurfaces: () => [surface], resolveWebContents: () => content,
    dialogIpc: ipcMain,
    logger: { debug: (event, data) => { if (event.includes("dialog-") || event.includes("page-automation-detached")) lifecycle.push({ event, at: Date.now(), ...data }); }, warn: () => {} },
    ...(args.scoped === "true" ? {
      commandTimeoutMs: 500,
      acquireWorkPanelScope: (container, chat) => { issuedScopes++; return acquireWorkPanelControlScope(registry, container, chat); },
      controlSiteFocus: async (_surface, _tab, _scope, phase) => {
        phases.push(phase);
        if (args.webview === "true" && phase === "input") {
          await win.webContents.executeJavaScript("document.querySelector('webview').focus()"); content.focus();
        }
        if (args.webview === "true" && phase === "restore") {
          win.webContents.focus(); await win.webContents.executeJavaScript("document.querySelector('input').focus()");
        }
      },
    } : {}),
  };
  let gateway = new EmbeddedCdpGateway(options);
  let heartbeats = 0; const heartbeat = setInterval(() => { heartbeats++; }, 10);
  const surfaceId = createEmbeddedWebSurfaceId(surface, tab);
  const run = async (method, params) => {
    const request = { method, params, surfaceId, source: { chatId: "chat-x" } };
    // This fixture is the trusted Main caller; public/forged acknowledgements are tested separately.
    return (await gateway.executeCommand(method === "Surface.releaseDownload" ? authorizeDesktopHostCdpCommand(request) : request)).result;
  };
  const ref = (observation, name) => observation.elements.find(element => element.name === name)?.ref;
  const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    let observation = await run("Surface.observe", {});
    const asked = await run("Surface.click", { observationId: observation.observationId, ref: ref(observation, "Ask"), timeoutMs: 3000 });
    report.dialog = { status: asked.status, error: asked.error, dialogs: asked.observation?.dialogs?.length ?? 0 };
    if (args.webview === "true") await settle(8000);
    report.nativePendingBeforeAnswer = gateway.pageAutomation.modalState(content)?.dialogs?.length;
    const handled = await run("Surface.handleDialog", { observationId: asked.observation.observationId, dialogId: asked.observation.dialogs[0].dialogId, action: args.webview === "true" ? "dismiss" : "accept" });
    await settle(100);
    report.dialog.handled = handled.status; report.dialog.title = content.getTitle();

    if (args.webview === "true") {
      observation = await run("Surface.observe", {});
      const next = await run("Surface.click", { observationId: observation.observationId, ref: ref(observation, "Ask") });
      await run("Surface.handleDialog", { observationId: next.observation.observationId, dialogId: next.observation.dialogs[0].dialogId, action: "accept" });
      await settle(100);
      report.acceptedConfirmTitle = content.getTitle();
    }

    observation = await run("Surface.observe", {});
    const prompted = await run("Surface.click", { observationId: observation.observationId, ref: ref(observation, "Prompt") });
    await run("Surface.handleDialog", { observationId: prompted.observation.observationId, dialogId: prompted.observation.dialogs[0].dialogId, action: "accept", promptText: "Ada" });
    await settle(50); report.promptTitle = content.getTitle();

    observation = await run("Surface.observe", {});
    const chained = await run("Surface.click", { observationId: observation.observationId, ref: ref(observation, "Chain") });
    const chainedFirst = await run("Surface.handleDialog", { observationId: chained.observation.observationId, dialogId: chained.observation.dialogs[0].dialogId, action: "accept" });
    let chainedObservation = chainedFirst.observation;
    for (let i=0; i<20 && !chainedObservation?.dialogs?.length; i++) { await settle(10); chainedObservation = await run("Surface.observe", {}); }
    await run("Surface.handleDialog", { observationId: chainedObservation.observationId, dialogId: chainedObservation.dialogs[0].dialogId, action: "dismiss" });
    await settle(50); report.chainTitle = content.getTitle();

    report.modalKinds = [];
    for (const kind of ["alert"]) {
      observation = await run("Surface.observe", {});
      const started = Date.now();
      const opened = await run("Surface.click", { observationId: observation.observationId,
        ref: ref(observation, "Alert"), timeoutMs: 3000 });
      const current = await run("Surface.observe", {});
      if (!current.dialogs?.length) throw new Error(JSON.stringify({ kind, opened, currentTitle: current.title, currentElements: current.elements?.map(e => ({ name:e.name, ref:e.ref })) }));
      const entry = current.dialogs[0];
      const answered = await run("Surface.handleDialog", { observationId: current.observationId, dialogId: entry.dialogId,
        action: "accept" });
      report.modalKinds.push({ kind, outcome: opened.action.outcome, error: opened.error, observed: entry.type,
        handled: answered.status, title: content.getTitle(), elapsedMs: Date.now() - started,
        count: await content.executeJavaScript("window." + kind + "Count") });
    }
    observation = await run("Surface.observe", {});
    const files = [{ name: "notes.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") }];
    const uploaded = await run("Surface.uploadFiles", { observationId: observation.observationId, ref: ref(observation, "Attachment"), files });
    report.refUpload = { status: uploaded.status, names: await content.executeJavaScript("[...document.getElementById('visible').files].map(f => f.name + ':' + f.size)") };

    observation = uploaded.observation;
    const uploadDialog = await run("Surface.uploadFiles", { observationId: observation.observationId, ref: ref(observation, "Confirmed Attachment"), files });
    await run("Surface.handleDialog", { observationId: uploadDialog.observation.observationId, dialogId: uploadDialog.observation.dialogs[0].dialogId, action: "accept" });
    await settle(50);
    report.uploadDialog = { status: uploadDialog.status, outcome: uploadDialog.outcome, error: uploadDialog.error, title: content.getTitle(), count: await content.executeJavaScript("document.getElementById('confirmed-file').files.length") };
    observation = await run("Surface.observe", {});
    const chose = await run("Surface.click", { observationId: observation.observationId, ref: ref(observation, "Choose files") });
    const chooser = chose.observation?.fileChoosers?.[0];
    report.chooser = { opened: !!chooser, multiple: chooser?.multiple };
    const viaChooser = await run("Surface.uploadFiles", { observationId: chose.observation.observationId, chooserId: chooser.chooserId,
      files: [...files, { name: "more.txt", mimeType: "text/plain", data: Buffer.from("more!").toString("base64") }] });
    report.chooser.status = viaChooser.status;
    const answeredChooser = await run("Surface.handleDialog", { observationId: viaChooser.observation.observationId, dialogId: viaChooser.observation.dialogs[0].dialogId, action: "accept" });
    report.chooser.pending = answeredChooser.observation.fileChoosers?.length ?? 0;
    report.chooser.title = content.getTitle();
    report.chooser.names = await content.executeJavaScript("[...document.getElementById('hidden').files].map(f => f.name)");

    observation = answeredChooser.observation;
    await run("Surface.click", { observationId: observation.observationId, ref: ref(observation, "Report"), captureDownload: true });
    let downloads = [];
    for (let attempt = 0; attempt < 50 && !downloads.some(d => d.status === "complete"); attempt += 1) {
      await settle(100); downloads = (await run("Surface.getDownloads", {})).downloads;
    }
    const read = await run("Surface.readDownload", { downloadId: downloads[0]?.downloadId });
    report.download = { status: downloads[0]?.status, fileName: read.fileName, text: Buffer.from(read.data, "base64").toString() };
    const acknowledgement = await run("Surface.releaseDownload", { downloadId: read.downloadId, sha256: read.sha256 });
    report.downloadAck = { ...acknowledgement, remaining: (await run("Surface.getDownloads", {})).downloads.length };

    observation = await run("Surface.observe", {});
    const typed = await run("Surface.interact", { observationId: observation.observationId, ref: ref(observation, "Name"), action: "type", value: "Ada" });
    const pressed = await run("Surface.interact", { action: "press", key: "Enter" });
    await settle(50);
    observation = pressed.observation;
    const checked = await run("Surface.interact", { observationId: observation.observationId, ref: ref(observation, "Agree"), action: "check" });
    report.scope = { issued: issuedScopes, phases, focusCommands, restorationFailures };
    report.keyboard = { typed: typed.status, title: content.getTitle(), checked: await content.executeJavaScript("document.getElementById('agree').checked"),
      checkChanged: checked.changed };

    // The exact document keeps its ready handshake across gateway replacement, without a reload.
    await gateway.stop(); gateway = new EmbeddedCdpGateway(options);
    observation = await run("Surface.observe", {});
    const restarted = await run("Surface.click", { observationId: observation.observationId, ref: ref(observation, "Ask") });
    await run("Surface.handleDialog", { observationId: restarted.observation.observationId, dialogId: restarted.observation.dialogs[0].dialogId, action: "dismiss" });
    await settle(50); report.restartTitle = content.getTitle();

    // A Run abort after click already returned must release the synchronous waiter, including its continuation.
    observation = await run("Surface.observe", {});
    const abort = new AbortController();
    const cancelled = (await gateway.executeCommand({ method: "Surface.click", params: { observationId: observation.observationId, ref: ref(observation, "Chain") }, surfaceId, source: { chatId: "chat-x" } }, undefined, abort.signal)).result;
    abort.abort(); await settle(100);
    report.cancelled = { opened: cancelled.observation.dialogs.length, title: content.getTitle(), pending: gateway.pageAutomation.modalState(content).dialogs.length };
    report.nativeMessageBoxes = nativeMessageBoxes;
    await gateway.stop();
    report.manualNativeResult = await content.executeJavaScript("confirm('Manual native sentinel')");
    report.manualNativeBoxes = nativeMessageBoxes - report.nativeMessageBoxes;
  } catch (error) {
    report.error = { message: error.message, code: error.code, stack: error.stack };
  }
  report.nativeMessageBoxes ??= nativeMessageBoxes; report.heartbeats = heartbeats; clearInterval(heartbeat);
  report.dialogEvents = dialogEvents;
  report.lifecycle = lifecycle;
  fs.writeFileSync(args.report, JSON.stringify(report));
  app.exit(0);
});
`;

for (const { scoped, failRestore, webview } of [{ scoped: true, failRestore: false, webview: true }, { scoped: true, failRestore: true, webview: true }]) test("Electron WorkPanel guest: dialogs, uploads, downloads and typed keyboard actions " + (scoped ? "with a real WorkPanel scope" + (webview ? " in a webview" : "") + (failRestore ? " and a cleanup failure" : "") : "without a scope"), { skip: !electron, timeout: 60_000 }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "workpanel-automation-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "workpanel-automation-fixture", main: "main.js" }));
  fs.writeFileSync(path.join(fixture, "main.js"), fixtureMain);
  const reportFile = path.join(fixture, "report.json");
  const preload = path.join(fixture, "preload.cjs");
  await build({ entryPoints: [path.join(root, "src/preload/work-panel-preview.ts")], outfile: preload, platform: "node", format: "cjs", bundle: true, external: ["electron"],
    define: { __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(root, "cutej"))) },
    banner: { js: "require('electron').ipcRenderer.send('fixture-preload-diagnostics',{mainFrame:process.isMainFrame,protocol:location.protocol,topFrame:window.top===window});" } });
  const child = spawn(electron, [fixture, `--report=${reportFile}`, `--source=${root}`, `--scoped=${scoped}`, `--failRestore=${failRestore}`, `--webview=${webview}`, `--preload=${pathToFileURL(preload).href}`], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  await once(child, "exit");
  assert.ok(fs.existsSync(reportFile), stderr.slice(-2000));
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  if (report.error) t.diagnostic(stderr.slice(-3500));
  if (webview) t.diagnostic(JSON.stringify({ lifecycle: report.lifecycle, preload: report.preload, pending: report.nativePendingBeforeAnswer, error: report.error?.message?.slice(0, 500) }));
  assert.equal(report.error, undefined, JSON.stringify(report));
  assert.equal(report.nativePendingBeforeAnswer, 1);
  assert.deepEqual(report.dialog, { status: "failed", error: "dialog_pending", dialogs: 1, handled: "handled", title: webview ? "r:false" : "r:true" });
  if (webview) {
    assert.equal(report.acceptedConfirmTitle, "r:true");
    const closed = report.lifecycle.filter(entry => entry.event === "[desktop-cdp] dialog-closed");
    assert.deepEqual(closed.map(entry => entry.result), [false, true, true, true, false, true, true, true, false, false]);
    assert.equal(report.promptTitle,"p:Ada");
    assert.equal(report.chainTitle,"chain:false");
    assert.equal(report.nativeMessageBoxes,0,"agent dialogs must never create an Electron native message box");
    assert.ok(report.heartbeats>100,"Main must keep processing while the page synchronously waits");
    assert.equal(closed.slice(0,-1).every(entry => entry.handledByAgent), true);
    assert.equal(closed.at(-1).handledByAgent,false);
    assert.equal(report.lifecycle.some(entry => entry.event.includes("detached")), false);
  }
  for (const modal of report.modalKinds) {
    assert.equal(modal.outcome, 'unknown');
    assert.equal(modal.error, 'dialog_pending');
    assert.equal(modal.observed, modal.kind);
    assert.equal(modal.handled, 'handled');
    assert.equal(modal.title, 'alert:done');
    assert.equal(modal.count, 1, 'an opened dialog must not replay its triggering input');
    assert.ok(modal.elapsedMs < 3000, 'observe and handle a pending dialog without focus deadlines');
  }
  assert.deepEqual(report.refUpload, { status: "uploaded", names: ["notes.txt:5"] });
  assert.deepEqual(report.uploadDialog, { status: "failed", outcome: "unknown", error: "dialog_pending", title: "upload:true", count: 1 });
  assert.deepEqual(report.chooser, { opened: true, multiple: true, status: "failed", pending: 0, title: "chooser:true", names: ["notes.txt", "more.txt"] });
  assert.deepEqual(report.download, { status: "complete", fileName: "report.csv", text: "a,b\n1,2\n" });
  assert.deepEqual(report.downloadAck, { released: true, remaining: 0 });
  if (scoped) {
    assert.equal(report.scope.restorationFailures, failRestore ? 1 : 0);
    assert.ok(report.scope.issued > 0, 'the fixture must exercise a host-issued SiteControlScope');
    assert.ok(report.scope.phases.includes('input'));
    assert.ok(report.scope.focusCommands.some(command => command.enabled));
    assert.equal(report.scope.focusCommands.some(command => command.modalOpen), false, 'no focus emulation request may block behind a native dialog');
    assert.equal(report.scope.focusCommands.at(-1).enabled, false, 'focus emulation must be restored');
  }
  assert.deepEqual(report.keyboard, { typed: "done", title: "enter:Ada", checked: true, checkChanged: true });
  assert.equal(report.restartTitle,"r:false");
  assert.deepEqual(report.cancelled,{opened:1,title:"chain:false",pending:0});
  assert.equal(report.manualNativeResult,false);
  assert.equal(report.manualNativeBoxes,1,"manual dialogs must still reach the original native implementation");
});
