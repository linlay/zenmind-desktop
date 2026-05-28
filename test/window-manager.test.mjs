import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const {
  buildMainWindowOptions,
  configureAttachedWebview,
  configureMediaPermissions,
  configureMainWindowLifecycleEvents,
  configureMainWindowWebContents,
  createMainWindowActivationController,
  loadMainWindowRenderer,
  prepareWebviewAttachPreferences,
  createMainWindowLifecycleController
} = await import("../dist-electron/main/window-manager.js");

class FakeWindow extends EventEmitter {
  destroyed = false;
  hidden = false;
  fullscreen = false;
  restored = false;
  vibrancy = undefined;
  backgroundColor = "";
  minimized = false;
  shown = false;
  focused = false;
  webContents = new FakeMainWebContents();
  loadedUrls = [];
  loadedFiles = [];
  showCount = 0;
  focusCount = 0;

  constructor({ fullscreen = false } = {}) {
    super();
    this.fullscreen = fullscreen;
  }

  isDestroyed() {
    return this.destroyed;
  }

  isFullScreen() {
    return this.fullscreen;
  }

  setFullScreen(value) {
    this.fullscreen = value;
  }

  hide() {
    this.hidden = true;
  }

  destroy() {
    this.destroyed = true;
  }

  restore() {
    this.restored = true;
    this.minimized = false;
  }

  isMinimized() {
    return this.minimized;
  }

  show() {
    this.shown = true;
    this.showCount += 1;
  }

  focus() {
    this.focused = true;
    this.focusCount += 1;
  }

  setVibrancy(value) {
    this.vibrancy = value;
  }

  setBackgroundColor(value) {
    this.backgroundColor = value;
  }

  async loadURL(url) {
    this.loadedUrls.push(url);
  }

  async loadFile(filePath, options) {
    this.loadedFiles.push({ filePath, options });
  }
}

class FakeMainWebContents extends EventEmitter {
  id = 11;
  sentMessages = [];
  loadingMainFrame = false;
  toggleDevToolsCount = 0;

  isLoadingMainFrame() {
    return this.loadingMainFrame;
  }

  send(channel, payload) {
    this.sentMessages.push({ channel, payload });
  }

  toggleDevTools() {
    this.toggleDevToolsCount += 1;
  }
}

class FakePermissionSession {
  handler = null;

  setPermissionRequestHandler(handler) {
    this.handler = handler;
  }

  request(contents, permission, details = {}) {
    return new Promise((resolve) => {
      this.handler(contents, permission, resolve, details);
    });
  }
}

class FakeWebContents extends EventEmitter {
  downloadedUrls = [];
  devtoolsOpenOptions = null;
  windowOpenHandler = null;

  constructor(id = 7) {
    super();
    this.id = id;
  }

  downloadURL(url) {
    this.downloadedUrls.push(url);
  }

  openDevTools(options) {
    this.devtoolsOpenOptions = options;
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

test("main window lifecycle hides Windows fullscreen windows without destroying them", () => {
  const target = new FakeWindow({ fullscreen: true });
  const controller = createMainWindowLifecycleController({
    platform: "win32",
    getWindow: () => target,
    createWindow: () => target,
    clearWindow: () => {}
  });

  controller.hideForClose(target);

  assert.equal(target.fullscreen, false);
  assert.equal(target.hidden, true);
  assert.equal(target.destroyed, false);
});

test("main window lifecycle recreates macOS windows while fullscreen close is pending", () => {
  const oldWindow = new FakeWindow({ fullscreen: true });
  const newWindow = new FakeWindow();
  let currentWindow = oldWindow;
  const controller = createMainWindowLifecycleController({
    platform: "darwin",
    getWindow: () => currentWindow,
    createWindow: () => {
      currentWindow = newWindow;
      return newWindow;
    },
    clearWindow: (target) => {
      if (currentWindow === target) {
        currentWindow = null;
      }
    }
  });

  controller.hideForClose(oldWindow);
  const activated = controller.getWindowForActivation();

  assert.equal(oldWindow.fullscreen, false);
  assert.equal(oldWindow.destroyed, true);
  assert.equal(activated, newWindow);
});

test("main window lifecycle applies macOS translucency only outside fullscreen", () => {
  const target = new FakeWindow();
  const controller = createMainWindowLifecycleController({
    platform: "darwin",
    getWindow: () => target,
    createWindow: () => target,
    clearWindow: () => {},
    isSidebarTranslucencyEnabled: () => true
  });

  controller.applyAppearance(target);
  assert.equal(target.vibrancy, "under-window");
  assert.equal(target.backgroundColor, "#00000000");

  target.fullscreen = true;
  controller.applyAppearance(target);
  assert.equal(target.vibrancy, null);
  assert.equal(target.backgroundColor, "#FFFFFF");
});

test("main window activation restores, shows and focuses the window before navigating", () => {
  const target = new FakeWindow();
  target.minimized = true;
  const normalized = [];
  const controller = createMainWindowActivationController({
    lifecycle: {
      getWindowForActivation: () => target,
      normalizeBeforeShow: (window) => normalized.push(window)
    },
    ensureDockIdentity: () => {}
  });

  controller.showMainWindow("/settings");

  assert.deepEqual(normalized, [target]);
  assert.equal(target.restored, true);
  assert.equal(target.shown, true);
  assert.equal(target.focused, true);
  assert.deepEqual(target.webContents.sentMessages, [{
    channel: "app.navigate",
    payload: "/settings"
  }]);
});

test("main window activation waits for the renderer before navigating while loading", () => {
  const target = new FakeWindow();
  target.webContents.loadingMainFrame = true;
  const controller = createMainWindowActivationController({
    lifecycle: {
      getWindowForActivation: () => target,
      normalizeBeforeShow: () => {}
    },
    ensureDockIdentity: () => {}
  });

  controller.navigateMainWindow("/control-center");

  assert.deepEqual(target.webContents.sentMessages, []);
  target.webContents.emit("did-finish-load");
  assert.deepEqual(target.webContents.sentMessages, [{
    channel: "app.navigate",
    payload: "/control-center"
  }]);
});

test("window manager builds platform-specific main window options", () => {
  const macOptions = buildMainWindowOptions({
    platform: "darwin",
    preloadPath: "C:/app/preload/index.js"
  });
  const winOptions = buildMainWindowOptions({
    platform: "win32",
    preloadPath: "C:/app/preload/index.js"
  });

  assert.equal(macOptions.width, 1440);
  assert.equal(macOptions.show, false);
  assert.equal(macOptions.titleBarStyle, "hidden");
  assert.equal(macOptions.transparent, true);
  assert.equal(macOptions.vibrancy, "under-window");
  assert.equal(macOptions.webPreferences.preload, "C:/app/preload/index.js");
  assert.equal(macOptions.webPreferences.contextIsolation, true);
  assert.equal(macOptions.webPreferences.webviewTag, true);
  assert.equal(Object.hasOwn(winOptions, "titleBarStyle"), false);
  assert.equal(winOptions.backgroundColor, "#FFFFFF");
});

test("window manager loads the main renderer from dev URL or production file", async () => {
  const devWindow = new FakeWindow();
  const prodWindow = new FakeWindow();

  await loadMainWindowRenderer(devWindow, {
    mode: "dev",
    rendererEntry: "http://127.0.0.1:5173",
    quit: () => {},
    report: () => {}
  });
  await loadMainWindowRenderer(prodWindow, {
    mode: "file",
    rendererEntry: "C:/app/dist-renderer/index.html",
    quit: () => {},
    report: () => {}
  });

  assert.deepEqual(devWindow.loadedUrls, ["http://127.0.0.1:5173"]);
  assert.deepEqual(devWindow.loadedFiles, []);
  assert.deepEqual(prodWindow.loadedUrls, []);
  assert.deepEqual(prodWindow.loadedFiles, [{
    filePath: "C:/app/dist-renderer/index.html",
    options: undefined
  }]);
});

test("window manager reports renderer load failures and quits the app", async () => {
  const errors = [];
  let quitCount = 0;
  const target = new FakeWindow();
  target.loadFile = async () => {
    throw new Error("missing renderer");
  };

  await loadMainWindowRenderer(target, {
    mode: "file",
    rendererEntry: "C:/app/dist-renderer/index.html",
    quit: () => {
      quitCount += 1;
    },
    report: (message, error) => {
      errors.push({ message, error: error.message });
    }
  });

  assert.deepEqual(errors, [{
    message: "failed to load renderer file",
    error: "missing renderer"
  }]);
  assert.equal(quitCount, 1);
});

test("window manager wires main window readiness, focus and fullscreen lifecycle events", () => {
  const target = new FakeWindow();
  const appearances = [];
  let hiddenOutsideFocus = 0;

  configureMainWindowLifecycleEvents(target, {
    platform: "win32",
    lifecycle: {
      applyAppearance: (window) => appearances.push(window),
      hideForClose: () => {},
      cancelPendingClose: () => {}
    },
    isDevToolsShortcut: () => false,
    isHandlingQuit: () => false,
    clearWindow: () => {},
    isNativeDialogOpen: () => false,
    hideQuickAssistantAfterOutsideFocus: () => {
      hiddenOutsideFocus += 1;
    }
  });

  target.emit("ready-to-show");
  target.emit("focus");
  target.emit("enter-full-screen");
  target.emit("leave-full-screen");

  assert.equal(target.showCount, 1);
  assert.equal(target.focusCount, 1);
  assert.equal(hiddenOutsideFocus, 1);
  assert.deepEqual(appearances, [target, target]);
});

test("window manager wires DevTools shortcuts and close lifecycle events", () => {
  const target = new FakeWindow();
  const events = [];
  const prevented = { shortcut: false, close: false };

  configureMainWindowLifecycleEvents(target, {
    platform: "win32",
    lifecycle: {
      applyAppearance: () => {},
      hideForClose: (window) => events.push({ type: "hide", window }),
      cancelPendingClose: () => events.push({ type: "cancel" })
    },
    isDevToolsShortcut: (_platform, input) => input.key === "i",
    isHandlingQuit: () => false,
    clearWindow: (window) => events.push({ type: "clear", window }),
    isNativeDialogOpen: () => false,
    hideQuickAssistantAfterOutsideFocus: () => {}
  });

  target.webContents.emit("before-input-event", {
    preventDefault: () => {
      prevented.shortcut = true;
    }
  }, { key: "i" });
  target.emit("close", {
    preventDefault: () => {
      prevented.close = true;
    }
  });
  target.emit("closed");

  assert.equal(prevented.shortcut, true);
  assert.equal(target.webContents.toggleDevToolsCount, 1);
  assert.equal(prevented.close, true);
  assert.deepEqual(events, [
    { type: "hide", window: target },
    { type: "cancel" },
    { type: "clear", window: target }
  ]);
});

test("window manager reports main renderer webContents failures", () => {
  const target = new FakeWindow();
  const reports = [];

  configureMainWindowWebContents(target, {
    platform: "win32",
    getMainWindow: () => target,
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => true,
    isDevToolsShortcut: () => false,
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "external",
    collectLoadDiagnostics: async () => ({}),
    report: (source, details) => reports.push({ source, details }),
    openExternal: async () => {},
    schedule: (callback) => callback()
  });

  target.webContents.emit("did-fail-load", {}, -2, "ERR_FAILED", "https://example.test/");
  target.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  target.webContents.emit("preload-error", {}, "C:/app/preload/index.js", new Error("boom"));

  assert.equal(reports[0].source, "renderer failed to load");
  assert.deepEqual(reports[0].details, {
    errorCode: -2,
    errorDescription: "ERR_FAILED",
    validatedUrl: "https://example.test/"
  });
  assert.deepEqual(reports[1], {
    source: "renderer process exited unexpectedly",
    details: { reason: "crashed" }
  });
  assert.equal(reports[2].source, "preload failed");
  assert.equal(reports[2].details.preloadPath, "C:/app/preload/index.js");
  assert.match(reports[2].details.error, /boom/u);
});

test("window manager wires webview preload validation and guest webview behavior", () => {
  const target = new FakeWindow();
  const guest = new FakeWebContents(64);
  const reports = [];
  const prevented = { attach: false };

  configureMainWindowWebContents(target, {
    platform: "win32",
    getMainWindow: () => target,
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: (url) => url.startsWith("http://127.0.0.1"),
    isDevToolsShortcut: (_platform, input) => input.key === "i",
    shouldDownloadUrl: (url) => url.endsWith(".zip"),
    resolveOpenDisposition: () => "external",
    collectLoadDiagnostics: async () => ({}),
    report: (source, details) => reports.push({ source, details }),
    openExternal: async () => {},
    schedule: (callback) => callback()
  });

  target.webContents.emit("will-attach-webview", {
    preventDefault: () => {
      prevented.attach = true;
    }
  }, { preload: "C:/unexpected.js" }, { src: "https://example.test/" });
  target.webContents.emit("did-attach-webview", {}, guest);
  guest.emit("before-input-event", {
    preventDefault: () => {}
  }, { key: "i" });

  assert.equal(prevented.attach, true);
  assert.deepEqual(reports[0], {
    source: "blocked unexpected webview preload",
    details: {
      preload: "C:/unexpected.js",
      src: "https://example.test/"
    }
  });
  assert.deepEqual(guest.devtoolsOpenOptions, { mode: "detach" });
});

test("window manager grants media permissions only to the main or quick assistant window", async () => {
  const permissionSession = new FakePermissionSession();
  const mainWindow = new FakeWindow();
  const quickWindow = new FakeWindow();
  mainWindow.webContents.id = 101;
  quickWindow.webContents.id = 202;
  let nativePromptCount = 0;

  configureMediaPermissions({
    platform: "win32",
    permissionSession,
    getMainWindow: () => mainWindow,
    getQuickAssistantWindow: () => quickWindow,
    isMediaPermissionAllowed: ({ permission, contentsId, mainContentsId, quickContentsId, mediaTypes }) =>
      permission === "media" &&
      (contentsId === mainContentsId || contentsId === quickContentsId) &&
      mediaTypes.includes("audio"),
    askForMicrophoneAccess: async () => {
      nativePromptCount += 1;
      return false;
    }
  });

  assert.equal(await permissionSession.request({ id: 101 }, "media", { mediaTypes: ["audio"] }), true);
  assert.equal(await permissionSession.request({ id: 202 }, "media", { mediaTypes: ["audio"] }), true);
  assert.equal(await permissionSession.request({ id: 303 }, "media", { mediaTypes: ["audio"] }), false);
  assert.equal(await permissionSession.request({ id: 101 }, "media", { mediaTypes: ["video"] }), false);
  assert.equal(nativePromptCount, 0);
});

test("window manager uses macOS native microphone access for allowed media requests", async () => {
  const permissionSession = new FakePermissionSession();
  const mainWindow = new FakeWindow();
  mainWindow.webContents.id = 101;
  const prompts = [];

  configureMediaPermissions({
    platform: "darwin",
    permissionSession,
    getMainWindow: () => mainWindow,
    getQuickAssistantWindow: () => null,
    isMediaPermissionAllowed: () => true,
    askForMicrophoneAccess: async () => {
      prompts.push("microphone");
      return true;
    }
  });

  assert.equal(await permissionSession.request({ id: 101 }, "media", { mediaTypes: ["audio"] }), true);
  assert.deepEqual(prompts, ["microphone"]);

  configureMediaPermissions({
    platform: "darwin",
    permissionSession,
    getMainWindow: () => mainWindow,
    getQuickAssistantWindow: () => null,
    isMediaPermissionAllowed: () => true,
    askForMicrophoneAccess: async () => {
      throw new Error("denied");
    }
  });

  assert.equal(await permissionSession.request({ id: 101 }, "media", { mediaTypes: ["audio"] }), false);
});

test("window manager allows only service webview preload for loopback service URLs", () => {
  const webPreferences = {
    preload: "file:///app/preload/service-webview.js",
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: true
  };
  const allowed = prepareWebviewAttachPreferences({
    webPreferences,
    params: {
      preload: "",
      src: "http://127.0.0.1:3000/"
    },
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => true
  });

  assert.equal(allowed.ok, true);
  assert.equal(webPreferences.preload, "C:/app/preload/service-webview.js");
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, false);

  const blocked = prepareWebviewAttachPreferences({
    webPreferences: { preload: "C:/other/preload.js" },
    params: {
      preload: "",
      src: "http://127.0.0.1:3000/"
    },
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => true
  });
  assert.deepEqual(blocked, {
    ok: false,
    reason: "unexpected-preload",
    preload: "C:/other/preload.js",
    src: "http://127.0.0.1:3000/"
  });
});

test("window manager configures attached webviews for downloads, DevTools and popup routing", () => {
  const contents = new FakeWebContents(42);
  const sentTabs = [];
  const externalUrls = [];
  const diagnostics = [];
  const prevented = { devtools: false, navigate: false };

  configureAttachedWebview(contents, {
    platform: "win32",
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sentTabs.push({ channel, payload })
      }
    }),
    isDevToolsShortcut: (_platform, input) => input.key === "i",
    shouldDownloadUrl: (url) => url.endsWith(".zip"),
    resolveOpenDisposition: (url) => url.includes("inside") ? "tab" : "external",
    collectLoadDiagnostics: async () => ({ guestId: 42 }),
    report: (source, details) => diagnostics.push({ source, details }),
    openExternal: async (url) => {
      externalUrls.push(url);
    },
    schedule: (callback) => callback()
  });

  contents.emit("before-input-event", {
    preventDefault: () => {
      prevented.devtools = true;
    }
  }, { key: "i" });
  assert.equal(prevented.devtools, true);
  assert.deepEqual(contents.devtoolsOpenOptions, { mode: "detach" });

  contents.emit("will-navigate", {
    preventDefault: () => {
      prevented.navigate = true;
    }
  }, "https://example.test/file.zip");
  assert.equal(prevented.navigate, true);
  assert.deepEqual(contents.downloadedUrls, ["https://example.test/file.zip"]);

  assert.deepEqual(contents.windowOpenHandler({ url: "https://example.test/inside" }), { action: "deny" });
  assert.deepEqual(sentTabs, [{
    channel: "webview.openTab",
    payload: {
      sourceGuestId: 42,
      url: "https://example.test/inside"
    }
  }]);

  assert.deepEqual(contents.windowOpenHandler({ url: "https://example.test/outside" }), { action: "deny" });
  assert.deepEqual(externalUrls, ["https://example.test/outside"]);
});
