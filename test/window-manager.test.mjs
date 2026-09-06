import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const {
  applyWindowsDevelopmentAppDetails,
  buildMainWindowOptions,
  configureAttachedWebview,
  configureMediaPermissions,
  configureMainWindowLifecycleEvents,
  configureMainWindowWebContents,
  createMainWindowActivationController,
  loadMainWindowRenderer,
  prepareWebviewAttachPreferences,
  createMainWindowLifecycleController
} = await import("../dist-electron/main/modules/shell/window-manager.js");
const { PRODUCT_NAME } = await import("../dist-electron/shared/brand.js");
const { DESKTOP_HELP_WEBVIEW_PARTITION } = await import("../dist-electron/shared/help.js");
const { DESKTOP_SSO_WEBVIEW_PARTITION } = await import("../dist-electron/shared/sso.js");
const {
  isWorkPanelCloseShortcut,
  resolveGlobalSearchCommandShortcut,
} = await import("../dist-electron/main/infrastructure/electron/platform-adapter.js");
const { resolveWebviewOpenDisposition } = await import("../dist-electron/main/modules/web-surfaces/open-tab.js");

class FakeWindow extends EventEmitter {
  destroyed = false;
  hidden = false;
  fullscreen = false;
  maximized = false;
  restored = false;
  vibrancy = undefined;
  backgroundColor = "";
  minimized = false;
  shown = false;
  focused = false;
  webContents = new FakeMainWebContents();
  loadedUrls = [];
  loadedFiles = [];
  appDetails = [];
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

  isMaximized() {
    return this.maximized;
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

  setAppDetails(value) {
    this.appDetails.push(value);
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
  devToolsOpened = false;
  openedDevToolsOptions = [];
  closeDevToolsCount = 0;

  isLoadingMainFrame() {
    return this.loadingMainFrame;
  }

  send(channel, payload) {
    this.sentMessages.push({ channel, payload });
  }

  isDevToolsOpened() {
    return this.devToolsOpened;
  }

  openDevTools(options) {
    this.devToolsOpened = true;
    this.openedDevToolsOptions.push(options);
  }

  closeDevTools() {
    this.devToolsOpened = false;
    this.closeDevToolsCount += 1;
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
  loadedUrls = [];
  devtoolsOpenOptions = null;
  windowOpenHandler = null;
  editCommands = [];

  constructor(id = 7, partition = "", currentUrl = "https://example.test/home") {
    super();
    this.id = id;
    this.partition = partition;
    this.currentUrl = currentUrl;
    this.session = {
      partition
    };
  }

  getURL() {
    return this.currentUrl;
  }

  downloadURL(url) {
    this.downloadedUrls.push(url);
  }

  async loadURL(url) {
    this.loadedUrls.push(url);
  }

  openDevTools(options) {
    this.devtoolsOpenOptions = options;
  }

  copy() {
    this.editCommands.push("copy");
  }

  cut() {
    this.editCommands.push("cut");
  }

  paste() {
    this.editCommands.push("paste");
  }

  selectAll() {
    this.editCommands.push("selectAll");
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

test("main window lifecycle sends Windows close requests through quit confirmation", () => {
  const target = new FakeWindow();
  const controller = createMainWindowLifecycleController({
    platform: "win32",
    getWindow: () => target,
    createWindow: () => target,
    clearWindow: () => {}
  });
  let prevented = false;
  let quitRequests = 0;

  configureMainWindowLifecycleEvents(target, {
    platform: "win32",
    lifecycle: controller,
    isDevToolsShortcut: () => false,
    isHandlingQuit: () => false,
    requestAppQuit: () => {
      quitRequests += 1;
    },
    clearWindow: () => {}
  });

  target.emit("close", {
    preventDefault: () => {
      prevented = true;
    }
  });

  assert.equal(prevented, true);
  assert.equal(quitRequests, 1);
  assert.equal(target.hidden, false);
  assert.equal(target.destroyed, false);
});

test("main window lifecycle allows Windows windows to close while quit is in progress", () => {
  const target = new FakeWindow();
  let prevented = false;
  let quitRequests = 0;

  configureMainWindowLifecycleEvents(target, {
    platform: "win32",
    lifecycle: {
      applyAppearance: () => {},
      hideForClose: () => {},
      cancelPendingClose: () => {}
    },
    isDevToolsShortcut: () => false,
    isHandlingQuit: () => true,
    requestAppQuit: () => {
      quitRequests += 1;
    },
    clearWindow: () => {}
  });

  target.emit("close", {
    preventDefault: () => {
      prevented = true;
    }
  });

  assert.equal(prevented, false);
  assert.equal(quitRequests, 0);
});

test("main window lifecycle hides macOS close requests without destroying the window", () => {
  const target = new FakeWindow();
  const controller = createMainWindowLifecycleController({
    platform: "darwin",
    getWindow: () => target,
    createWindow: () => target,
    clearWindow: () => {}
  });
  let prevented = false;
  let quitStateChecks = 0;

  configureMainWindowLifecycleEvents(target, {
    platform: "darwin",
    lifecycle: controller,
    isDevToolsShortcut: () => false,
    isHandlingQuit: () => {
      quitStateChecks += 1;
      return false;
    },
    clearWindow: () => {}
  });

  target.emit("close", {
    preventDefault: () => {
      prevented = true;
    }
  });

  assert.equal(quitStateChecks, 1);
  assert.equal(prevented, true);
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

test("main window lifecycle preserves active macOS fullscreen windows for activation", () => {
  const target = new FakeWindow({ fullscreen: true });
  const controller = createMainWindowLifecycleController({
    platform: "darwin",
    getWindow: () => target,
    createWindow: () => {
      throw new Error("fullscreen activation should reuse the existing window");
    },
    clearWindow: () => {}
  });

  const activated = controller.getWindowForActivation();

  assert.equal(activated, target);
  assert.equal(target.fullscreen, true);
  assert.equal(target.destroyed, false);
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

test("main window lifecycle publishes renderer-owned Windows control masking", () => {
  const target = new FakeWindow();
  const nativeTheme = { shouldUseDarkColors: false };
  const controller = createMainWindowLifecycleController({
    platform: "win32",
    getWindow: () => target,
    createWindow: () => target,
    clearWindow: () => {},
    nativeTheme
  });

  controller.setGlobalSearchOverlayVisible(true);
  assert.equal(controller.isGlobalSearchOverlayVisible(), true);
  assert.equal(controller.isWindowControlsMasked(), true);
  assert.deepEqual(target.webContents.sentMessages.at(-1), {
    channel: "desktopShell.windowStateChanged",
    payload: { isFullScreen: false, isMaximized: false, windowControlsMasked: true }
  });

  nativeTheme.shouldUseDarkColors = true;
  controller.applyAppearance(target);
  assert.equal(target.backgroundColor, "#181818");

  controller.setGlobalSearchOverlayVisible(false);
  assert.equal(controller.isGlobalSearchOverlayVisible(), false);
  assert.equal(controller.isWindowControlsMasked(), false);
  assert.deepEqual(target.webContents.sentMessages.at(-1), {
    channel: "desktopShell.windowStateChanged",
    payload: { isFullScreen: false, isMaximized: false, windowControlsMasked: false }
  });
});

test("main window lifecycle keeps renderer controls masked until every webview modal closes", () => {
  const target = new FakeWindow();
  const controller = createMainWindowLifecycleController({
    platform: "win32",
    getWindow: () => target,
    createWindow: () => target,
    clearWindow: () => {},
    nativeTheme: { shouldUseDarkColors: false }
  });

  controller.setWebviewModalOverlayVisible("service-webview:chat", true);
  controller.setWebviewModalOverlayVisible("service-webview:management", true);
  controller.setWebviewModalOverlayVisible("service-webview:chat", false);
  assert.equal(controller.isWindowControlsMasked(), true);

  controller.setGlobalSearchOverlayVisible(true);
  controller.setWebviewModalOverlayVisible("service-webview:management", false);
  assert.equal(controller.isWindowControlsMasked(), true);

  controller.setGlobalSearchOverlayVisible(false);
  assert.equal(controller.isWindowControlsMasked(), false);
  assert.deepEqual(target.webContents.sentMessages.at(-1), {
    channel: "desktopShell.windowStateChanged",
    payload: { isFullScreen: false, isMaximized: false, windowControlsMasked: false }
  });
});

test("main window activation restores, shows and focuses the window before navigating", () => {
  const target = new FakeWindow();
  target.minimized = true;
  const normalized = [];
  const controller = createMainWindowActivationController({
    platform: "win32",
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

test("main window activation preserves macOS fullscreen when Dock icon is clicked", () => {
  const target = new FakeWindow({ fullscreen: true });
  const normalized = [];
  const appFocusCalls = [];
  const controller = createMainWindowActivationController({
    platform: "darwin",
    lifecycle: {
      getWindowForActivation: () => target,
      normalizeBeforeShow: (window) => normalized.push(window)
    },
    ensureDockIdentity: () => {},
    focusApp: (options) => appFocusCalls.push(options)
  });

  controller.showMainWindow();

  assert.deepEqual(normalized, [target]);
  assert.deepEqual(appFocusCalls, [{ steal: true }]);
  assert.equal(target.fullscreen, true);
  assert.equal(target.shown, false);
  assert.equal(target.focused, true);
});

test("main window activation waits for the renderer before navigating while loading", () => {
  const target = new FakeWindow();
  target.webContents.loadingMainFrame = true;
  const controller = createMainWindowActivationController({
    platform: "win32",
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
    preloadPath: "C:/app/preload/index.js",
    iconPath: "C:/app/build/brands/zenmind/icons/icon.ico"
  });

  assert.equal(macOptions.width, 1440);
  assert.equal(macOptions.title, PRODUCT_NAME);
  assert.equal(macOptions.show, false);
  assert.equal(macOptions.titleBarStyle, "hidden");
  assert.deepEqual(macOptions.trafficLightPosition, { x: 10, y: 13 });
  assert.equal(macOptions.acceptFirstMouse, true);
  assert.equal(macOptions.transparent, true);
  assert.equal(macOptions.vibrancy, "under-window");
  assert.equal(macOptions.backgroundColor, "#00000000");
  assert.equal(macOptions.webPreferences.preload, "C:/app/preload/index.js");
  assert.equal(macOptions.webPreferences.contextIsolation, true);
  assert.equal(macOptions.webPreferences.webviewTag, true);
  assert.equal(winOptions.titleBarStyle, "hidden");
  assert.equal(winOptions.titleBarOverlay, undefined);
  assert.equal(winOptions.acceptFirstMouse, undefined);
  assert.equal(winOptions.backgroundColor, "#FFFFFF");
  assert.equal(winOptions.icon, "C:/app/build/brands/zenmind/icons/icon.ico");
  assert.equal(macOptions.icon, undefined);
});

test("window manager applies current brand app details only to Windows development windows", () => {
  const windowsWindow = new FakeWindow();
  const macWindow = new FakeWindow();

  applyWindowsDevelopmentAppDetails(windowsWindow, {
    platform: "win32",
    appId: "cc.zenmind.desktop.dev",
    iconPath: "C:/app/build/brands/zenmind/icons/icon.ico"
  });
  applyWindowsDevelopmentAppDetails(macWindow, {
    platform: "darwin",
    appId: "cc.zenmind.desktop.dev",
    iconPath: "/app/build/brands/zenmind/icons/icon.ico"
  });
  applyWindowsDevelopmentAppDetails(windowsWindow, {
    platform: "win32",
    appId: "cc.zenmind.desktop"
  });

  assert.deepEqual(windowsWindow.appDetails, [{
    appId: "cc.zenmind.desktop.dev",
    appIconPath: "C:/app/build/brands/zenmind/icons/icon.ico",
    appIconIndex: 0
  }]);
  assert.deepEqual(macWindow.appDetails, []);
});

test("window manager includes initial locale arguments for renderer bootstrap", () => {
  const options = buildMainWindowOptions({
    platform: "win32",
    preloadPath: "C:/app/preload/index.js",
    initialLocaleSettings: { locale: "en-US", source: "stored" }
  });

  assert.deepEqual(options.webPreferences.additionalArguments, [
    "--desktop-initial-locale=en-US",
    "--desktop-initial-locale-source=stored"
  ]);
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
  let restoredFloatingWindows = 0;

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
    restoreFloatingWindowsForFullscreen: () => {
      restoredFloatingWindows += 1;
    }
  });

  target.emit("ready-to-show");
  target.emit("focus");
  target.maximized = true;
  target.emit("maximize");
  target.maximized = false;
  target.emit("unmaximize");
  target.fullscreen = true;
  target.emit("enter-full-screen");
  target.fullscreen = false;
  target.emit("leave-full-screen");

  assert.equal(target.showCount, 1);
  assert.equal(target.focusCount, 1);
  assert.equal(restoredFloatingWindows, 2);
  assert.deepEqual(appearances, [target, target]);
  assert.deepEqual(target.webContents.sentMessages, [
    { channel: "desktopShell.windowStateChanged", payload: { isFullScreen: false, isMaximized: false, windowControlsMasked: false } },
    { channel: "desktopShell.windowStateChanged", payload: { isFullScreen: false, isMaximized: true, windowControlsMasked: false } },
    { channel: "desktopShell.windowStateChanged", payload: { isFullScreen: false, isMaximized: false, windowControlsMasked: false } },
    { channel: "desktopShell.windowStateChanged", payload: { isFullScreen: true, isMaximized: false, windowControlsMasked: false } },
    { channel: "desktopShell.windowStateChanged", payload: { isFullScreen: false, isMaximized: false, windowControlsMasked: false } }
  ]);
});

test("window manager toggles main renderer DevTools and wires close lifecycle events", () => {
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
    requestAppQuit: () => events.push({ type: "quit" }),
    clearWindow: (window) => events.push({ type: "clear", window })
  });

  target.webContents.emit("before-input-event", {
    preventDefault: () => {
      prevented.shortcut = true;
    }
  }, { key: "i" });
  target.webContents.emit("before-input-event", {
    preventDefault: () => {}
  }, { key: "i" });
  target.emit("close", {
    preventDefault: () => {
      prevented.close = true;
    }
  });
  target.emit("closed");

  assert.equal(prevented.shortcut, true);
  assert.deepEqual(target.webContents.openedDevToolsOptions, [{ mode: "bottom" }]);
  assert.equal(target.webContents.closeDevToolsCount, 1);
  assert.equal(prevented.close, true);
  assert.deepEqual(events, [
    { type: "quit" },
    { type: "cancel" },
    { type: "clear", window: target }
  ]);
});

test("window manager opens Desktop global search from the main window shortcut", () => {
  const target = new FakeWindow();
  let prevented = false;

  configureMainWindowLifecycleEvents(target, {
    platform: "darwin",
    lifecycle: {
      applyAppearance: () => {},
      hideForClose: () => {},
      cancelPendingClose: () => {}
    },
    isDevToolsShortcut: () => false,
    isGlobalSearchShortcut: (_platform, input) => input.key === "k",
    isHandlingQuit: () => false,
    clearWindow: () => {}
  });

  target.webContents.emit("before-input-event", {
    preventDefault: () => {
      prevented = true;
    }
  }, { type: "keyDown", key: "k", meta: true });

  assert.equal(prevented, true);
  assert.deepEqual(target.webContents.sentMessages, [
    { channel: "app.openGlobalSearch", payload: { source: "main" } }
  ]);
  assert.deepEqual(target.webContents.openedDevToolsOptions, []);
});

test("main window forwards close shortcuts for renderer-owned composite workspaces", () => {
  const cases = [
    {
      platform: "darwin",
      input: { type: "keyDown", key: "w", meta: true, control: false, alt: false, shift: false, isAutoRepeat: false },
    },
    {
      platform: "win32",
      input: { type: "keyDown", key: "w", meta: false, control: true, alt: false, shift: false, isAutoRepeat: false },
    },
  ];

  for (const testCase of cases) {
    const target = new FakeWindow();
    let prevented = false;
    configureMainWindowLifecycleEvents(target, {
      platform: testCase.platform,
      lifecycle: {
        applyAppearance: () => {},
        hideForClose: () => {},
        cancelPendingClose: () => {},
      },
      isDevToolsShortcut: () => false,
      isWorkPanelCloseShortcut,
      isHandlingQuit: () => false,
      clearWindow: () => {},
    });

    target.webContents.emit("before-input-event", {
      preventDefault: () => {
        prevented = true;
      },
    }, testCase.input);

    assert.equal(prevented, true, testCase.platform);
    assert.deepEqual(target.webContents.sentMessages, [{
      channel: "app.workPanelCloseShortcut",
      payload: { guestId: null, fallbackToWindowClose: true },
    }]);
  }
});

test("main window forwards global search commands only while the overlay is visible", () => {
  const target = new FakeWindow();
  let visible = true;
  let prevented = false;

  configureMainWindowLifecycleEvents(target, {
    platform: "darwin",
    lifecycle: {
      applyAppearance: () => {},
      hideForClose: () => {},
      cancelPendingClose: () => {},
      isGlobalSearchOverlayVisible: () => visible,
    },
    isDevToolsShortcut: () => false,
    isGlobalSearchShortcut: () => false,
    resolveGlobalSearchCommandShortcut: (_platform, input) =>
      input.key === "m" ? { kind: "action", actionId: "mcpConnectors" } : null,
    isHandlingQuit: () => false,
    clearWindow: () => {},
  });

  target.webContents.emit("before-input-event", {
    preventDefault: () => {
      prevented = true;
    },
  }, { type: "keyDown", key: "m", meta: true });

  assert.equal(prevented, true);
  assert.deepEqual(target.webContents.sentMessages, [{
    channel: "app.globalSearchShortcut",
    payload: { kind: "action", actionId: "mcpConnectors" },
  }]);

  visible = false;
  prevented = false;
  target.webContents.emit("before-input-event", {
    preventDefault: () => {
      prevented = true;
    },
  }, { type: "keyDown", key: "m", meta: true });
  assert.equal(prevented, false);
  assert.equal(target.webContents.sentMessages.length, 1);
});

test("main window intercepts macOS Option digit symbols while global search is visible", () => {
  const target = new FakeWindow();
  let prevented = false;

  configureMainWindowLifecycleEvents(target, {
    platform: "darwin",
    lifecycle: {
      applyAppearance: () => {},
      hideForClose: () => {},
      cancelPendingClose: () => {},
      isGlobalSearchOverlayVisible: () => true,
    },
    isDevToolsShortcut: () => false,
    isGlobalSearchShortcut: () => false,
    resolveGlobalSearchCommandShortcut,
    isHandlingQuit: () => false,
    clearWindow: () => {},
  });

  target.webContents.emit("before-input-event", {
    preventDefault: () => {
      prevented = true;
    },
  }, { type: "keyDown", key: "™", code: "Digit2", alt: true });

  assert.equal(prevented, true);
  assert.deepEqual(target.webContents.sentMessages, [{
    channel: "app.globalSearchShortcut",
    payload: { kind: "agent", slot: 2 },
  }]);
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
  const focusChanges = [];
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
    onWebviewFocusChanged: (webContentsId, focused) => {
      focusChanges.push({ webContentsId, focused });
    },
    onMainRendererFocused: () => {
      focusChanges.push({ webContentsId: null, focused: true });
    },
    openExternal: async () => {},
    schedule: (callback) => callback()
  });

  target.webContents.emit("will-attach-webview", {
    preventDefault: () => {
      prevented.attach = true;
    }
  }, { preload: "C:/unexpected.js" }, { src: "https://example.test/" });
  target.webContents.emit("did-attach-webview", {}, guest);
  guest.emit("focus");
  guest.emit("blur");
  guest.emit("focus");
  target.webContents.emit("focus");
  guest.emit("destroyed");
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
  assert.equal(guest.devtoolsOpenOptions, null);
  assert.deepEqual(target.webContents.openedDevToolsOptions, [{ mode: "bottom" }]);
  assert.deepEqual(focusChanges, [
    { webContentsId: 64, focused: true },
    { webContentsId: 64, focused: false },
    { webContentsId: 64, focused: true },
    { webContentsId: null, focused: true },
    { webContentsId: 64, focused: false }
  ]);
});

test("window manager blocks an unexpected initial URL in the Help partition", () => {
  const target = new FakeWindow();
  const reports = [];
  let prevented = false;

  configureMainWindowWebContents(target, {
    platform: "darwin",
    getMainWindow: () => target,
    servicePreloadPath: "/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => true,
    isDevToolsShortcut: () => false,
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "external",
    collectLoadDiagnostics: async () => ({}),
    report: (source, details) => reports.push({ source, details }),
    getHelpUrl: () => "https://www.zenmind.cc/help/",
    openExternal: async () => {},
    schedule: (callback) => callback()
  });

  target.webContents.emit("will-attach-webview", {
    preventDefault: () => {
      prevented = true;
    }
  }, {}, {
    partition: DESKTOP_HELP_WEBVIEW_PARTITION,
    src: "https://example.test/phishing"
  });

  assert.equal(prevented, true);
  assert.deepEqual(reports, [{
    source: "blocked Help webview with unexpected url",
    details: {
      src: "https://example.test/phishing"
    }
  }]);
});

test("attached Help webviews isolate cross-origin navigation and open popups externally", async () => {
  const guest = new FakeWebContents(81, DESKTOP_HELP_WEBVIEW_PARTITION);
  const openedUrls = [];
  const reports = [];
  let prevented = false;

  configureAttachedWebview(guest, {
    platform: "darwin",
    getMainWindow: () => null,
    isDevToolsShortcut: () => false,
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "tab",
    collectLoadDiagnostics: async () => ({}),
    report: (source, details) => reports.push({ source, details }),
    getHelpUrl: () => "https://www.zenmind.cc/help/",
    isHelpWebview: (contents) => contents.session.partition === DESKTOP_HELP_WEBVIEW_PARTITION,
    openExternal: async (url) => {
      openedUrls.push(url);
    },
    schedule: (callback) => callback()
  });

  guest.emit("will-navigate", {
    preventDefault: () => {
      prevented = true;
    }
  }, "https://example.test/outside");
  await Promise.resolve();

  assert.equal(prevented, true);
  assert.deepEqual(openedUrls, ["https://example.test/outside"]);
  assert.equal(reports[0].source, "blocked cross-origin Help navigation");

  let redirectPrevented = false;
  guest.emit("will-redirect", {
    preventDefault: () => {
      redirectPrevented = true;
    }
  }, "https://redirect.example.test/help");
  await Promise.resolve();
  assert.equal(redirectPrevented, true);

  const popupResult = guest.windowOpenHandler({
    url: "https://www.zenmind.cc/help/topic"
  });
  await Promise.resolve();

  assert.deepEqual(popupResult, { action: "deny" });
  assert.deepEqual(openedUrls, [
    "https://example.test/outside",
    "https://redirect.example.test/help",
    "https://www.zenmind.cc/help/topic"
  ]);
});

test("attached webviews forward native edit shortcuts to the focused guest", () => {
  const macGuest = new FakeWebContents(71);
  const windowsGuest = new FakeWebContents(72);
  const prevented = {
    macCopy: false,
    windowsSelectAll: false,
    unrelated: false
  };
  const baseOptions = {
    getMainWindow: () => null,
    isDevToolsShortcut: () => false,
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "external",
    collectLoadDiagnostics: async () => ({}),
    report: () => {},
    openExternal: async () => {},
    schedule: (callback) => callback()
  };

  configureAttachedWebview(macGuest, {
    ...baseOptions,
    platform: "darwin"
  });
  configureAttachedWebview(windowsGuest, {
    ...baseOptions,
    platform: "win32"
  });

  macGuest.emit("before-input-event", {
    preventDefault: () => {
      prevented.macCopy = true;
    }
  }, { type: "keyDown", key: "c", meta: true, control: false });
  windowsGuest.emit("before-input-event", {
    preventDefault: () => {
      prevented.windowsSelectAll = true;
    }
  }, { type: "keyDown", key: "a", control: true, meta: false });
  windowsGuest.emit("before-input-event", {
    preventDefault: () => {
      prevented.unrelated = true;
    }
  }, { type: "keyDown", key: "c", control: false, meta: false });

  assert.equal(prevented.macCopy, true);
  assert.equal(prevented.windowsSelectAll, true);
  assert.equal(prevented.unrelated, false);
  assert.deepEqual(macGuest.editCommands, ["copy"]);
  assert.deepEqual(windowsGuest.editCommands, ["selectAll"]);
});

test("attached webviews open Desktop global search without opening DevTools", () => {
  const target = new FakeWindow();
  const guest = new FakeWebContents(81);
  let prevented = false;

  configureAttachedWebview(guest, {
    platform: "win32",
    getMainWindow: () => target,
    isDevToolsShortcut: () => false,
    isGlobalSearchShortcut: (_platform, input) => input.key === "k",
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "external",
    collectLoadDiagnostics: async () => ({}),
    report: () => {},
    openExternal: async () => {},
    schedule: (callback) => callback()
  });

  guest.emit("before-input-event", {
    preventDefault: () => {
      prevented = true;
    }
  }, { type: "keyDown", key: "k", control: true });

  assert.equal(prevented, true);
  assert.deepEqual(target.webContents.sentMessages, [
    { channel: "app.openGlobalSearch", payload: { source: "webview", guestId: 81 } }
  ]);
  assert.equal(guest.devtoolsOpenOptions, null);
});

test("attached webviews prioritize visible global search commands over edit shortcuts", () => {
  const target = new FakeWindow();
  const guest = new FakeWebContents(82);
  let prevented = false;

  configureAttachedWebview(guest, {
    platform: "win32",
    getMainWindow: () => target,
    isDevToolsShortcut: () => false,
    isGlobalSearchShortcut: () => false,
    resolveGlobalSearchCommandShortcut: (_platform, input) =>
      input.key === "a" ? { kind: "action", actionId: "agents" } : null,
    isGlobalSearchOverlayVisible: () => true,
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "external",
    collectLoadDiagnostics: async () => ({}),
    report: () => {},
    openExternal: async () => {},
    schedule: (callback) => callback(),
  });

  guest.emit("before-input-event", {
    preventDefault: () => {
      prevented = true;
    },
  }, { type: "keyDown", key: "a", control: true, meta: false });

  assert.equal(prevented, true);
  assert.deepEqual(guest.editCommands, []);
  assert.deepEqual(target.webContents.sentMessages, [{
    channel: "app.globalSearchShortcut",
    payload: { kind: "action", actionId: "agents" },
  }]);
});

test("attached webviews forward close only for trusted Main Chat and current WorkPanel guests", () => {
  const target = new FakeWindow();
  const macGuest = new FakeWebContents(91);
  const windowsGuest = new FakeWebContents(92);
  const ordinaryGuest = new FakeWebContents(93);
  const mainChatMacGuest = new FakeWebContents(96);
  const mainChatWindowsGuest = new FakeWebContents(97);
  const prevented = {
    mac: false,
    windows: false,
    mainChatMac: false,
    mainChatWindows: false,
    repeated: false,
    ordinary: false,
  };
  const baseOptions = {
    getMainWindow: () => target,
    isDevToolsShortcut: () => false,
    isWorkPanelCloseShortcut,
    isWorkPanelWebview: (contents) => contents.id === macGuest.id || contents.id === windowsGuest.id,
    isMainChatWebview: (contents) => contents.id === mainChatMacGuest.id || contents.id === mainChatWindowsGuest.id,
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "external",
    collectLoadDiagnostics: async () => ({}),
    report: () => {},
    openExternal: async () => {},
    schedule: (callback) => callback(),
  };

  configureAttachedWebview(macGuest, { ...baseOptions, platform: "darwin" });
  configureAttachedWebview(windowsGuest, { ...baseOptions, platform: "win32" });
  configureAttachedWebview(mainChatMacGuest, { ...baseOptions, platform: "darwin" });
  configureAttachedWebview(mainChatWindowsGuest, { ...baseOptions, platform: "win32" });
  configureAttachedWebview(ordinaryGuest, { ...baseOptions, platform: "win32" });

  macGuest.emit("before-input-event", { preventDefault: () => { prevented.mac = true; } }, {
    type: "keyDown", key: "w", meta: true, control: false, alt: false, shift: false, isAutoRepeat: false,
  });
  windowsGuest.emit("before-input-event", { preventDefault: () => { prevented.windows = true; } }, {
    type: "keyDown", key: "w", meta: false, control: true, alt: false, shift: false, isAutoRepeat: false,
  });
  mainChatMacGuest.emit("before-input-event", { preventDefault: () => { prevented.mainChatMac = true; } }, {
    type: "keyDown", key: "w", meta: true, control: false, alt: false, shift: false, isAutoRepeat: false,
  });
  mainChatWindowsGuest.emit("before-input-event", { preventDefault: () => { prevented.mainChatWindows = true; } }, {
    type: "keyDown", key: "w", meta: false, control: true, alt: false, shift: false, isAutoRepeat: false,
  });
  windowsGuest.emit("before-input-event", { preventDefault: () => { prevented.repeated = true; } }, {
    type: "keyDown", key: "w", meta: false, control: true, alt: false, shift: false, isAutoRepeat: true,
  });
  ordinaryGuest.emit("before-input-event", { preventDefault: () => { prevented.ordinary = true; } }, {
    type: "keyDown", key: "w", meta: false, control: true, alt: false, shift: false, isAutoRepeat: false,
  });

  assert.deepEqual(prevented, {
    mac: true,
    windows: true,
    mainChatMac: true,
    mainChatWindows: true,
    repeated: false,
    ordinary: false,
  });
  assert.deepEqual(target.webContents.sentMessages, [
    { channel: "app.workPanelCloseShortcut", payload: { guestId: 91 } },
    { channel: "app.workPanelCloseShortcut", payload: { guestId: 92 } },
    { channel: "app.workPanelCloseShortcut", payload: { guestId: null, fallbackToWindowClose: true } },
    { channel: "app.workPanelCloseShortcut", payload: { guestId: null, fallbackToWindowClose: true } },
  ]);
});

test("attached WorkPanel webviews forward Escape only while panel fullscreen is active", () => {
  const target = new FakeWindow();
  const workPanelGuest = new FakeWebContents(94);
  const ordinaryGuest = new FakeWebContents(95);
  let fullscreenActive = false;
  const prevented = { inactive: false, active: false, repeated: false, ordinary: false };
  const baseOptions = {
    platform: "win32",
    getMainWindow: () => target,
    isDevToolsShortcut: () => false,
    isWorkPanelWebview: (contents) => contents.id === workPanelGuest.id,
    isWorkPanelFullscreenActive: () => fullscreenActive,
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "external",
    collectLoadDiagnostics: async () => ({}),
    report: () => {},
    openExternal: async () => {},
    schedule: (callback) => callback(),
  };

  configureAttachedWebview(workPanelGuest, baseOptions);
  configureAttachedWebview(ordinaryGuest, baseOptions);

  workPanelGuest.emit("before-input-event", {
    preventDefault: () => { prevented.inactive = true; }
  }, {
    type: "keyDown", key: "Escape", isAutoRepeat: false,
  });
  fullscreenActive = true;
  workPanelGuest.emit("before-input-event", {
    preventDefault: () => { prevented.active = true; }
  }, {
    type: "keyDown", key: "Escape", isAutoRepeat: false,
  });
  workPanelGuest.emit("before-input-event", {
    preventDefault: () => { prevented.repeated = true; }
  }, {
    type: "keyDown", key: "Escape", isAutoRepeat: true,
  });
  ordinaryGuest.emit("before-input-event", {
    preventDefault: () => { prevented.ordinary = true; }
  }, {
    type: "keyDown", key: "Escape", isAutoRepeat: false,
  });

  assert.deepEqual(prevented, { inactive: false, active: true, repeated: false, ordinary: false });
  assert.deepEqual(target.webContents.sentMessages, [{
    channel: "app.workPanelFullscreenExitShortcut",
    payload: { guestId: 94 },
  }]);
});

test("window manager grants media permissions only to the main window", async () => {
  const permissionSession = new FakePermissionSession();
  const mainWindow = new FakeWindow();
  mainWindow.webContents.id = 101;
  let nativePromptCount = 0;

  configureMediaPermissions({
    platform: "win32",
    permissionSession,
    getMainWindow: () => mainWindow,
    askForMicrophoneAccess: async () => {
      nativePromptCount += 1;
      return false;
    }
  });

  assert.equal(await permissionSession.request({ id: 101 }, "media", { mediaTypes: ["audio"] }), true);
  assert.equal(await permissionSession.request({ id: 202 }, "media", { mediaTypes: ["audio"] }), false);
  assert.equal(await permissionSession.request({ id: 303 }, "media", { mediaTypes: ["audio"] }), false);
  assert.equal(await permissionSession.request({ id: 101 }, "media", { mediaTypes: ["video"] }), false);
  assert.equal(await permissionSession.request({ id: 101 }, "media", { mediaTypes: ["audio", "video"] }), true);
  assert.equal(nativePromptCount, 0);
});

test("window manager grants audio-only media permission to an authorized WebApp guest", async () => {
  const permissionSession = new FakePermissionSession();
  const mainWindow = new FakeWindow();
  mainWindow.webContents.id = 101;
  const requests = [];

  configureMediaPermissions({
    platform: "win32",
    permissionSession,
    getMainWindow: () => mainWindow,
    askForMicrophoneAccess: async () => true,
    isAllowedWebappMicrophoneRequest: (contents, details) => {
      requests.push({ contents, details });
      return contents.id === 202 && details.requestingUrl === "http://127.0.0.1:43123/";
    }
  });

  assert.equal(await permissionSession.request(
    { id: 202 },
    "media",
    { mediaTypes: ["audio"], requestingUrl: "http://127.0.0.1:43123/" }
  ), true);
  assert.equal(await permissionSession.request(
    { id: 202 },
    "media",
    { mediaTypes: ["video"], requestingUrl: "http://127.0.0.1:43123/" }
  ), false);
  assert.equal(await permissionSession.request(
    { id: 202 },
    "media",
    { mediaTypes: ["audio", "video"], requestingUrl: "http://127.0.0.1:43123/" }
  ), false);
  assert.equal(await permissionSession.request(
    { id: 303 },
    "media",
    { mediaTypes: ["audio"], requestingUrl: "http://127.0.0.1:43123/" }
  ), false);
  assert.equal(await permissionSession.request(
    { id: 202 },
    "media",
    { requestingUrl: "http://127.0.0.1:43123/" }
  ), false);
  assert.equal(requests.length, 2);
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
    askForMicrophoneAccess: async () => {
      throw new Error("denied");
    }
  });

  assert.equal(await permissionSession.request({ id: 101 }, "media", { mediaTypes: ["audio"] }), false);
});

test("window manager confines service and review preloads to their trusted webview surfaces", () => {
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

  const localFilePreferences = {
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
  };
  const localFile = prepareWebviewAttachPreferences({
    webPreferences: localFilePreferences,
    params: {
      src: "zenmind-local-file://opaque-handle/index.html",
      partition: "work-panel-local-file-test",
    },
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => false,
    isReviewableLocalFileUrl: () => true,
  });
  assert.equal(localFile.ok, true);
  assert.equal(localFilePreferences.nodeIntegration, false);
  assert.equal(localFilePreferences.contextIsolation, true);
  assert.equal(localFilePreferences.sandbox, true);

  const reviewPreferences = {
    preload: "file:///app/preload/work-panel-preview.js",
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
  };
  const reviewLocalFile = prepareWebviewAttachPreferences({
    webPreferences: reviewPreferences,
    params: {
      preload: "file:///app/preload/work-panel-preview.js",
      src: "zenmind-local-file://opaque-handle/image.png",
      partition: "work-panel-local-file-test",
    },
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => false,
    isReviewableLocalFileUrl: () => true,
  });
  assert.equal(reviewLocalFile.ok, true);
  assert.equal(reviewPreferences.preload, "C:/app/preload/work-panel-preview.js");
  assert.equal(reviewPreferences.nodeIntegration, false);
  assert.equal(reviewPreferences.contextIsolation, true);
  assert.equal(reviewPreferences.sandbox, true);

  const untrustedReview = prepareWebviewAttachPreferences({
    webPreferences: { preload: "file:///app/preload/work-panel-preview.js" },
    params: {
      preload: "file:///app/preload/work-panel-preview.js",
      src: "zenmind-local-file://user-selected/image.png",
    },
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => false,
    isReviewableLocalFileUrl: () => false,
  });
  assert.deepEqual(untrustedReview, {
    ok: false,
    reason: "unsafe-review-url",
    src: "zenmind-local-file://user-selected/image.png",
  });

  const webReviewPreferences = {
    preload: "file:///app/preload/work-panel-preview.js",
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
  };
  const webReview = prepareWebviewAttachPreferences({
    webPreferences: webReviewPreferences,
    params: {
      preload: "file:///app/preload/work-panel-preview.js",
      src: "https://example.test/page",
      partition: DESKTOP_SSO_WEBVIEW_PARTITION,
    },
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => false,
  });
  assert.equal(webReview.ok, true);
  assert.equal(webReviewPreferences.preload, "C:/app/preload/work-panel-preview.js");
  assert.equal(webReviewPreferences.nodeIntegration, false);
  assert.equal(webReviewPreferences.contextIsolation, true);
  assert.equal(webReviewPreferences.sandbox, true);

  const isolatedWorkPanelReview = prepareWebviewAttachPreferences({
    webPreferences: { preload: "file:///app/preload/work-panel-preview.js" },
    params: {
      preload: "file:///app/preload/work-panel-preview.js",
      src: "https://example.test/page",
      partition: "work-panel-abc123-def456",
    },
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => false,
  });
  assert.deepEqual(isolatedWorkPanelReview, {
    ok: false,
    reason: "unsafe-review-url",
    src: "https://example.test/page",
  });

  const unsafeReview = prepareWebviewAttachPreferences({
    webPreferences: { preload: "file:///app/preload/work-panel-preview.js" },
    params: {
      preload: "file:///app/preload/work-panel-preview.js",
      src: "https://example.test/page",
      partition: "desktop-browser",
    },
    servicePreloadPath: "C:/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => false,
  });
  assert.deepEqual(unsafeReview, {
    ok: false,
    reason: "unsafe-review-url",
    src: "https://example.test/page",
  });

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

test("window manager routes attached webview DevTools shortcuts to the main renderer", () => {
  const mainWindow = new FakeWindow();
  const contents = new FakeWebContents(42);
  const externalUrls = [];
  const navigatedUrls = [];
  const diagnostics = [];
  const prevented = { devtools: false, navigate: false };

  configureAttachedWebview(contents, {
    platform: "win32",
    getMainWindow: () => mainWindow,
    isDevToolsShortcut: (_platform, input) => input.key === "i",
    shouldDownloadUrl: (url) => url.endsWith(".zip"),
    resolveOpenDisposition: (url) => url.includes("inside") ? "tab" : "external",
    collectLoadDiagnostics: async () => ({ guestId: 42 }),
    report: (source, details) => diagnostics.push({ source, details }),
    onWebviewNavigation: (url, details) => {
      navigatedUrls.push({ url, details });
    },
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
  assert.equal(contents.devtoolsOpenOptions, null);
  assert.deepEqual(mainWindow.webContents.openedDevToolsOptions, [{ mode: "bottom" }]);

  contents.emit("will-navigate", {
    preventDefault: () => {
      prevented.navigate = true;
    }
  }, "https://example.test/file.zip");
  assert.equal(prevented.navigate, true);
  assert.deepEqual(contents.downloadedUrls, ["https://example.test/file.zip"]);

  assert.deepEqual(contents.windowOpenHandler({ url: "https://example.test/inside" }), { action: "deny" });
  assert.deepEqual(mainWindow.webContents.sentMessages, [{
    channel: "webview.openTab",
    payload: {
      target: "desktop-browser",
      navigationKind: "network",
      sourceGuestId: 42,
      url: "https://example.test/inside"
    }
  }]);

  assert.deepEqual(contents.windowOpenHandler({ url: "https://example.test/outside" }), { action: "deny" });
  assert.deepEqual(externalUrls, ["https://example.test/outside"]);

  contents.emit("did-navigate", {}, "https://example.test/home");
  contents.emit("did-navigate-in-page", {}, "https://example.test/home#ready", true);
  contents.emit("did-navigate-in-page", {}, "https://example.test/sidebar", false);
  assert.deepEqual(navigatedUrls, [
    {
      url: "https://example.test/home",
      details: {
        guestId: 42,
        isInPage: false,
        isMainFrame: true
      }
    },
    {
      url: "https://example.test/home#ready",
      details: {
        guestId: 42,
        isInPage: true,
        isMainFrame: true
      }
    }
  ]);
});

test("Website Blob popups stay bound to the source surface and never open externally", () => {
  const contents = new FakeWebContents(44, "persist:desktop-sso", "https://example.test/attachments");
  const sentTabs = [];
  const externalUrls = [];

  configureAttachedWebview(contents, {
    platform: "darwin",
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sentTabs.push({ channel, payload })
      }
    }),
    isDevToolsShortcut: () => false,
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: resolveWebviewOpenDisposition,
    resolveBlobPopupTarget: () => "desktop-browser",
    collectLoadDiagnostics: async () => ({}),
    report: () => {},
    openExternal: async (url) => {
      externalUrls.push(url);
    },
    schedule: (callback) => callback()
  });

  const blobUrl = "blob:https://example.test/5ee09c6c-8350-43ec-a60a-c24bd0db57ed";
  assert.deepEqual(contents.windowOpenHandler({
    url: blobUrl,
    referrer: { url: "https://example.test/attachments" }
  }), { action: "deny" });
  assert.deepEqual(contents.windowOpenHandler({
    url: "blob:https://other.test/5ee09c6c-8350-43ec-a60a-c24bd0db57ed",
    referrer: { url: "https://example.test/attachments" }
  }), { action: "deny" });
  assert.deepEqual(contents.windowOpenHandler({ url: "blob:null/opaque" }), { action: "deny" });

  assert.deepEqual(sentTabs, [{
    channel: "webview.openTab",
    payload: {
      target: "desktop-browser",
      navigationKind: "blob",
      sourceGuestId: 44,
      url: blobUrl
    }
  }]);
  assert.deepEqual(contents.downloadedUrls, []);
  assert.deepEqual(externalUrls, []);
});

test("Chat Work Panel popups create an outer WorkPanel tab without navigating Desktop", async () => {
  const contents = new FakeWebContents(43);
  const sentTabs = [];
  const externalUrls = [];

  configureAttachedWebview(contents, {
    platform: "darwin",
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sentTabs.push({ channel, payload })
      }
    }),
    isDevToolsShortcut: () => false,
    shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "tab",
    collectLoadDiagnostics: async () => ({}),
    report: () => {},
    shouldOpenPopupInWorkPanelTab: () => true,
    resolveBlobPopupTarget: () => "work-panel",
    openExternal: async (url) => {
      externalUrls.push(url);
    },
    schedule: (callback) => callback()
  });

  assert.deepEqual(contents.windowOpenHandler({ url: "https://example.test/popup" }), { action: "deny" });
  const blobUrl = "blob:https://example.test/3f63f853-42f4-45aa-8960-0d537fde7e61";
  assert.deepEqual(contents.windowOpenHandler({
    url: blobUrl,
    referrer: { url: "https://example.test/popup" }
  }), { action: "deny" });
  assert.deepEqual(contents.windowOpenHandler({ url: "javascript:alert(1)" }), { action: "deny" });
  await Promise.resolve();

  assert.deepEqual(contents.loadedUrls, []);
  assert.deepEqual(sentTabs, [
    {
      channel: "webview.openTab",
      payload: {
        target: "work-panel",
        navigationKind: "network",
        sourceGuestId: 43,
        url: "https://example.test/popup"
      }
    },
    {
      channel: "webview.openTab",
      payload: {
        target: "work-panel",
        navigationKind: "blob",
        sourceGuestId: 43,
        url: blobUrl
      }
    }
  ]);
  assert.deepEqual(externalUrls, []);
});
