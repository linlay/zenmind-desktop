const { app, protocol, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.LOCAL_DOCUMENT_TEST_ROOT;
const startup = phase => fs.appendFileSync(path.join(root, "startup.log"), `${phase}\n`);
startup("fixture entry");
const { registerMainAppEvents } = require("../../src/main/app/app-events.ts");
const { createWorkspaceHost } = require("./local-document-workspace-host.cjs");
const { registerChatWorkPanelLocalFileProtocolScheme } = require("../../src/main/modules/work-panel/local-files.ts");
fs.mkdirSync(path.join(root, "profile"), { recursive: true });
fs.mkdirSync(path.join(root, "session"), { recursive: true });
app.setPath("userData", path.join(root, "profile"));
app.setPath("sessionData", path.join(root, "session"));
const gotSingleInstanceLock = app.requestSingleInstanceLock();
startup(`single instance lock: ${gotSingleInstanceLock}`);
if (!gotSingleInstanceLock) {
  fs.writeFileSync(path.join(root, "error.txt"), "Isolated fixture failed to obtain its single-instance lock");
  app.exit(1);
}
registerChatWorkPanelLocalFileProtocolScheme(protocol);
let host;
const events = [];
let receiptQueue = Promise.resolve();
registerMainAppEvents({
  app, platform: process.platform, gotSingleInstanceLock,
  state: { shutdownCleanupComplete: true, isHandlingQuit: false },
  installerShutdownArgs: new Set(["--installer-shutdown"]),
  globalShortcut: { unregister() {} }, focusedWebviewDevToolsShortcut: "CommandOrControl+Shift+I",
  initialCommandLine: process.argv, initialWorkingDirectory: process.cwd(),
  async onReady() {
    host = await createWorkspaceHost(root);
    fs.writeFileSync(path.join(root, "ready"), "ready");
  },
  showMainWindow() {},
  openLocalDocument(filePath) {
    // Visit each selected document while collecting its receipt. Actual concurrent
    // document creation is covered by the separate Electron fixture.
    receiptQueue = receiptQueue.then(async () => {
      try {
        const document = await host.openFile(filePath);
        const guest = await host.activateDocument(document.documentId);
        const state = await host.snapshot();
        if (document.ownerChatId !== "") throw Error("A preview-only OS open created a server Chat identity");
        if (JSON.stringify(document).includes(fs.realpathSync(filePath))) throw Error("The preview DTO exposed an absolute path");
        events.push({
          fileName: path.basename(filePath), windows: BrowserWindow.getAllWindows().length,
          mainWindowId: host.window.id, tabs: state.documents.length, guests: state.guests.length,
          guestId: guest.id, activeDocumentId: state.activeDocumentId,
          documentId: document.documentId, ownerChatId: document.ownerChatId, partition: document.partition,
          ownerKey: host.ownerKeyFor(document), newChat: document.newChat,
          sourcePath: host.sourcePathFor(document), draftGroups: host.draftTargets.length, promotedChats: host.promotedChats.length,
          retainedDocumentIds: state.documents.map(item => item.documentId),
          route: host.routes.at(-1),
          heading: await guest.executeJavaScript("document.querySelector('h1')?.textContent"),
        });
        fs.writeFileSync(path.join(root, "events.json"), JSON.stringify(events));
      } catch (error) {
        fs.writeFileSync(path.join(root, "error.txt"), error.stack || String(error));
      }
    });
    return receiptQueue;
  },
  isNativeDialogOpen: () => false, beginAppQuitWithoutConfirmation() { app.exit(0); },
  beginInstallerShutdown() {}, emitPluginBeforeQuit() {}, beginRealtimeShutdown() {},
  prepareQuitUi() {}, async runShutdownCleanup() { return { mode: "system", survivors: [] }; },
  async flushDesktopLogs() {}, writeInstallerShutdownAcks() {}, releaseAssistantRunWakeLock() {},
  clearDesktopPetIdleResetTimer() {}, stopAssistantBridgeRuntime() {}, stopTunnelHubRuntime() {},
  disposeRealtimeBroker() {}, unregisterPluginGlobalShortcuts() {}, stopResourceDirectoryWatcher() {},
  stopPluginBridgeRuntime() {}, stopEnterpriseChatRuntime() {},
});
startup("app events registered");
const timeout = setTimeout(() => { host?.dispose(); app.exit(2); }, 45000);
setInterval(() => {
  if (fs.existsSync(path.join(root, "quit"))) {
    clearTimeout(timeout); host?.dispose(); app.exit(0);
  }
}, 100);
