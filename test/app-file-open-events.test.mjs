import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { registerMainAppEvents } = await import("../dist-electron/main/app/app-events.js");
const { findDesktopDocumentPaths, isSupportedDesktopDocumentPath } = await import("../dist-electron/main/app/open-file.js");
const { DESKTOP_OPEN_DEEP_LINK } = await import("../dist-electron/main/app/deep-link.js");

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

function createOptions(platform, initialCommandLine = ["desktop"]) {
  const app = new EventEmitter();
  app.whenReady = async () => undefined;
  app.quit = () => undefined;
  const opened = [];
  const shown = [];
  const shutdownRequests = [];
  return {
    opened,
    shown,
    shutdownRequests,
    options: {
      app,
      platform,
      state: { shutdownCleanupComplete: false, isHandlingQuit: false },
      gotSingleInstanceLock: true,
      installerShutdownArgs: new Set(["--installer-shutdown"]),
      globalShortcut: { unregister() {} },
      focusedWebviewDevToolsShortcut: "CommandOrControl+Shift+I",
      initialCommandLine,
      initialWorkingDirectory: platform === "win32" ? "C:\\Users\\test" : "/Users/test",
      async onReady() {},
      openLocalDocument(filePath) { opened.push(filePath); },
      showMainWindow(targetPath) { shown.push(targetPath); },
      beginAppQuitWithoutConfirmation() {},
      beginInstallerShutdown(commandLine) { shutdownRequests.push(commandLine); },
      isNativeDialogOpen: () => false,
      emitPluginBeforeQuit() {},
      beginRealtimeShutdown() {},
      prepareQuitUi() {},
      async runShutdownCleanup() { return { mode: "system", survivors: [] }; },
      async flushDesktopLogs() {},
      writeInstallerShutdownAcks() {},
      releaseAssistantRunWakeLock() {},
      clearDesktopPetIdleResetTimer() {},
      stopAssistantBridgeRuntime() {},
      stopTunnelHubRuntime() {},
      disposeRealtimeBroker() {},
      unregisterPluginGlobalShortcuts() {},
      stopResourceDirectoryWatcher() {},
      stopPluginBridgeRuntime() {},
      stopEnterpriseChatRuntime() {},
    },
  };
}

function emitMacFile(app, filePath) {
  let prevented = false;
  app.emit("open-file", { preventDefault() { prevented = true; } }, filePath);
  return prevented;
}

async function flushReadyHandlers() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("document paths accept Markdown and HTML extensions with mixed case", () => {
  for (const filePath of ["/资料/说明 文档.md", "/notes.MARKDOWN", "C:\\资料\\项目.Md", "C:\\preview.HTML", "/preview.HtM"]) {
    assert.equal(isSupportedDesktopDocumentPath(filePath), true, filePath);
  }
  for (const filePath of ["", "/notes.md.txt", "/README", "/document.pdf", "/notes.md\0"]) {
    assert.equal(isSupportedDesktopDocumentPath(filePath), false, filePath);
  }
});

test("Windows argument parsing skips the executable, flags and URLs and uses Windows path rules", () => {
  assert.deepEqual(findDesktopDocumentPaths([
    "C:\\do-not-open.md",
    "--inspect=notes.md",
    "--user-data-dir=C:\\profile.html",
    "https://example.test/page.html",
    "file:///C:/notes.md",
    "cutej://open?file=notes.md",
    "C:\\资料\\说明 文档.MD",
    '"C:\\资料\\有 空格.HTML"',
    ".\\预览\\index.htm",
    "..\\notes.markdown",
    "\\\\server\\share\\shared.md",
    "C:\\other.exe",
  ], "win32", "D:\\项目\\workspace"), [
    "C:\\资料\\说明 文档.MD",
    "C:\\资料\\有 空格.HTML",
    "D:\\项目\\workspace\\预览\\index.htm",
    "D:\\项目\\notes.markdown",
    "\\\\server\\share\\shared.md",
  ]);
});

test("macOS and other platforms never infer document requests from argv", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(findDesktopDocumentPaths(["desktop", "/notes.md"], platform, "/Users/test"), []);
  }
});

test("macOS registers open-file before Electron ready and retains every file until onReady finishes", async () => {
  const fixture = createOptions("darwin", ["desktop", "/ignored-argv.md"]);
  const electronReady = deferred();
  const readyStarted = deferred();
  const appReady = deferred();
  fixture.options.app.whenReady = () => electronReady.promise;
  fixture.options.onReady = async () => {
    readyStarted.resolve();
    await appReady.promise;
  };
  registerMainAppEvents(fixture.options);

  assert.equal(emitMacFile(fixture.options.app, "/资料/说明 文档.MD"), true);
  assert.equal(emitMacFile(fixture.options.app, "/preview.html"), true);
  assert.deepEqual(fixture.opened, []);

  electronReady.resolve();
  await readyStarted.promise;
  assert.equal(emitMacFile(fixture.options.app, "/later.markdown"), true);
  assert.deepEqual(fixture.opened, []);

  appReady.resolve();
  await flushReadyHandlers();
  assert.deepEqual(fixture.opened, ["/资料/说明 文档.MD", "/preview.html", "/later.markdown"]);
  assert.deepEqual(fixture.shown, []);
});

test("macOS warm open-file immediately dispatches supported files and allows reopening the same file", async () => {
  const fixture = createOptions("darwin");
  registerMainAppEvents(fixture.options);
  await flushReadyHandlers();

  assert.equal(emitMacFile(fixture.options.app, "/preview.HTM"), true);
  assert.equal(emitMacFile(fixture.options.app, "/preview.HTM"), true);
  assert.equal(emitMacFile(fixture.options.app, "/unsupported.txt"), false);
  assert.deepEqual(fixture.opened, ["/preview.HTM", "/preview.HTM"]);
  assert.deepEqual(fixture.shown, []);
});

test("one failed or pending preview does not block other queued documents", async (context) => {
  const fixture = createOptions("darwin");
  const pendingPreview = deferred();
  const errors = [];
  context.mock.method(console, "error", (...args) => { errors.push(args); });
  fixture.options.openLocalDocument = (filePath) => {
    fixture.opened.push(filePath);
    if (filePath === "/sync-failure.md") throw new Error("sync failure");
    if (filePath === "/async-failure.html") return Promise.reject(new Error("async failure"));
    if (filePath === "/slow.md") return pendingPreview.promise;
  };
  registerMainAppEvents(fixture.options);
  const filePaths = ["/sync-failure.md", "/async-failure.html", "/slow.md", "/good.html"];
  for (const filePath of filePaths) emitMacFile(fixture.options.app, filePath);
  await flushReadyHandlers();

  assert.deepEqual(fixture.opened, filePaths);
  assert.equal(errors.length, 2);
  pendingPreview.resolve();
});

test("Windows initial documents use the launching working directory and wait for onReady", async () => {
  const fixture = createOptions("win32", ["desktop.exe", "..\\说明.MARKDOWN", "C:\\预览\\index.html"]);
  const readyStarted = deferred();
  const appReady = deferred();
  fixture.options.onReady = async () => {
    readyStarted.resolve();
    await appReady.promise;
  };
  registerMainAppEvents(fixture.options);
  await readyStarted.promise;
  assert.deepEqual(fixture.opened, []);

  appReady.resolve();
  await flushReadyHandlers();
  assert.deepEqual(fixture.opened, ["C:\\Users\\说明.MARKDOWN", "C:\\预览\\index.html"]);
  assert.deepEqual(fixture.shown, []);
});

test("Windows second-instance documents retain that instance's working directory while startup is pending", async () => {
  const fixture = createOptions("win32", ["desktop.exe", "first.md"]);
  const appReady = deferred();
  fixture.options.onReady = () => appReady.promise;
  registerMainAppEvents(fixture.options);
  fixture.options.app.emit("second-instance", {}, ["desktop.exe", ".\\第二个 文件.md", "..\\preview.HTM"], "D:\\另一个项目");
  assert.deepEqual(fixture.opened, []);

  appReady.resolve();
  await flushReadyHandlers();
  assert.deepEqual(fixture.opened, ["C:\\Users\\test\\first.md", "D:\\另一个项目\\第二个 文件.md", "D:\\preview.HTM"]);
  assert.deepEqual(fixture.shown, []);
});

test("Windows warm second-instance opens all documents without replacing the main route", async () => {
  const fixture = createOptions("win32");
  registerMainAppEvents(fixture.options);
  await flushReadyHandlers();
  fixture.options.app.emit("second-instance", {}, ["desktop.exe", "one.md", "two.html"], "D:\\docs");
  assert.deepEqual(fixture.opened, ["D:\\docs\\one.md", "D:\\docs\\two.html"]);
  assert.deepEqual(fixture.shown, []);
});

test("Windows file requests and the existing Desktop home deep link retain distinct handlers", async () => {
  const fixture = createOptions("win32");
  registerMainAppEvents(fixture.options);
  await flushReadyHandlers();
  fixture.options.app.emit("second-instance", {}, ["desktop.exe", DESKTOP_OPEN_DEEP_LINK, "one.md"], "D:\\docs");
  assert.deepEqual(fixture.opened, ["D:\\docs\\one.md"]);
  assert.deepEqual(fixture.shown, ["/"]);
});

test("installer shutdown takes precedence over second-instance documents and deep links", async () => {
  const fixture = createOptions("win32");
  registerMainAppEvents(fixture.options);
  await flushReadyHandlers();
  const commandLine = ["desktop.exe", "one.md", DESKTOP_OPEN_DEEP_LINK, "--installer-shutdown"];
  fixture.options.app.emit("second-instance", {}, commandLine, "D:\\docs");
  assert.deepEqual(fixture.shutdownRequests, [commandLine]);
  assert.deepEqual(fixture.opened, []);
  assert.deepEqual(fixture.shown, []);
});

test("initial installer shutdown arguments never enqueue files or a Desktop home deep link", async () => {
  const fixture = createOptions("win32", ["desktop.exe", "one.md", DESKTOP_OPEN_DEEP_LINK, "--installer-shutdown"]);
  registerMainAppEvents(fixture.options);
  await flushReadyHandlers();
  assert.deepEqual(fixture.opened, []);
  assert.deepEqual(fixture.shown, []);
});

test("a process without the single-instance lock does not register file handlers", async () => {
  const fixture = createOptions("darwin");
  fixture.options.gotSingleInstanceLock = false;
  registerMainAppEvents(fixture.options);
  assert.equal(fixture.options.app.listenerCount("open-file"), 0);
  assert.equal(fixture.options.app.listenerCount("second-instance"), 0);
  await flushReadyHandlers();
  assert.deepEqual(fixture.opened, []);
});
