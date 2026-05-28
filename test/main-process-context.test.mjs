import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

const {
  createMainAppState
} = await import("../dist-electron/main/app-state.js");
const {
  createAssistantIpcHandlerOptions,
  createDesktopPetIpcHandlerOptions,
  createDesktopActionOptions,
  createMainProcessContext,
  createMarketplaceIpcHandlerOptions,
  createShellIpcHandlerOptions,
  createSettingsIpcHandlerOptions,
  createServicesIpcHandlerOptions,
  createSsoIpcHandlerOptions,
  createTaskBoardIpcHandlerOptions
} = await import("../dist-electron/main/main-process-context.js");

test("main process context groups app state with electron runtime dependencies", () => {
  const state = createMainAppState();
  const ipcMain = {};
  const context = createMainProcessContext({
    state,
    app: { name: "ZenMind" },
    ipcMain,
    platform: "win32",
    shell: {},
    session: {},
    nativeTheme: {}
  });

  assert.equal(context.state, state);
  assert.equal(context.ipcMain, ipcMain);
  assert.equal(context.platform, "win32");
});

test("main process registers ipc handlers through a context object", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(mainProcess, /const mainProcessContext = createMainProcessContext\(\{/);
  assert.match(mainProcess, /function registerIpcHandlers\(context: MainProcessContext\)/);
  assert.match(mainProcess, /const state = context\.state;/);
  assert.match(mainProcess, /registerIpcHandlers\(mainProcessContext\)/);
});

test("desktop action options read window and page context from main process state", async () => {
  const state = createMainAppState();
  const mainWindow = { id: 7 };
  const snapshot = { pageKind: "native", route: "/settings" };
  state.mainWindow = mainWindow;
  state.currentPageSnapshot = snapshot;
  const executed = [];
  const context = createMainProcessContext({
    state,
    app: { name: "ZenMind" },
    ipcMain: {},
    platform: "win32",
    shell: {},
    session: {},
    nativeTheme: {}
  });
  const desktopActionOptions = createDesktopActionOptions(context, {
    assistantBridge: { id: "bridge" },
    navigate: () => "navigated",
    openLogViewer: () => "logs",
    callRendererAction: () => "renderer",
    cdpIntegration: {
      start: () => ({
        executeCommand: async (request) => {
          executed.push(request);
          return { ok: true };
        }
      })
    }
  });

  assert.equal(desktopActionOptions.app.name, "ZenMind");
  assert.equal(desktopActionOptions.getMainWindow(), mainWindow);
  assert.equal(desktopActionOptions.getCurrentPageSnapshot(), snapshot);
  assert.deepEqual(await desktopActionOptions.executeCdpCommand({ method: "Runtime.evaluate" }), { ok: true });
  assert.deepEqual(executed, [{ method: "Runtime.evaluate" }]);
});

test("assistant ipc options read mutable process state through the context", () => {
  const state = createMainAppState();
  const mainWindow = { id: 11 };
  const currentSnapshot = { pageKind: "native", route: "/tasks" };
  const nextSnapshot = { pageKind: "web", route: "https://example.test" };
  state.mainWindow = mainWindow;
  state.currentPageSnapshot = currentSnapshot;
  state.assistantNavigationStatusClient = { started: true };
  const context = createMainProcessContext({
    state,
    app: { name: "ZenMind" },
    ipcMain: {},
    platform: "win32",
    shell: { openExternal: () => undefined },
    session: {},
    nativeTheme: {}
  });
  const dependencies = {
    assistantBridge: { id: "bridge" },
    desktopActionOptions: { id: "desktop-actions" },
    showFileDialog: () => "file",
    callAgentPlatform: () => "agent",
    handleDesktopActionRequest: () => "action",
    DESKTOP_ACTION_DEFINITIONS: [{ id: "open" }],
    emitAssistantAttachmentProgress: () => undefined,
    getAssistantSettings: () => ({}),
    saveAssistantSettings: () => undefined,
    getAgentPlatformMinimaxSettingsPublic: () => ({}),
    resolveAssistantAttachmentPath: () => "path",
    createAssistantAttachmentFromPastedImage: () => ({}),
    cancelAssistantAttachmentTask: () => undefined,
    createAssistantAttachmentsFromFiles: () => [],
    captureAssistantScreenshot: () => ({})
  };

  const options = createAssistantIpcHandlerOptions(context, dependencies);

  assert.equal(options.app.name, "ZenMind");
  assert.equal(options.shell, context.shell);
  assert.equal(options.platform, "win32");
  assert.equal(options.mainWindow, mainWindow);
  assert.equal(options.assistantNavigationStatusClient, state.assistantNavigationStatusClient);
  assert.equal(options.desktopActionRendererRequests, state.desktopActionRendererRequests);
  assert.equal(options.desktopActionOptions, dependencies.desktopActionOptions);
  assert.equal(options.getCurrentPageSnapshot(), currentSnapshot);
  options.setCurrentPageSnapshot(nextSnapshot);
  assert.equal(state.currentPageSnapshot, nextSnapshot);
});

test("services ipc options use process context for shared subscriptions and cache clearing", async () => {
  const state = createMainAppState();
  let cacheCleared = false;
  const context = createMainProcessContext({
    state,
    app: { name: "ZenMind" },
    ipcMain: {},
    platform: "win32",
    shell: { openPath: () => undefined },
    session: {
      defaultSession: {
        clearCache: async () => {
          cacheCleared = true;
        }
      }
    },
    nativeTheme: {}
  });
  const dependencies = {
    listServices: () => [],
    getServiceState: () => ({}),
    installBuiltinService: () => undefined,
    initializeService: () => undefined,
    startService: () => undefined,
    stopService: () => undefined,
    restartService: () => undefined,
    readServiceConfig: () => ({}),
    writeServiceConfig: () => undefined,
    importServiceFile: () => undefined,
    getServiceLogsMeta: () => ({}),
    watchServiceLog: () => undefined,
    readServiceLog: () => "",
    runServiceMutation: () => undefined,
    handleServiceStart: () => undefined,
    showFileDialog: () => undefined,
    showArchiveDialog: () => undefined,
    openLogViewerWindow: () => undefined,
    closeLogViewerWindow: () => undefined,
    minimizeLogViewerWindow: () => undefined,
    maximizeLogViewerWindow: () => undefined,
    revealPathInFileManager: () => undefined,
    getServiceWebviewPreloadPath: () => "preload.js",
    getServiceWebviewPreloadUrl: () => "file://preload.js",
    startupRestoreController: { getState: () => ({}) }
  };

  const options = createServicesIpcHandlerOptions(context, dependencies);

  assert.equal(options.app.name, "ZenMind");
  assert.equal(options.shell, context.shell);
  assert.equal(options.platform, "win32");
  assert.equal(options.logStreamSubscriptions, state.logStreamSubscriptions);
  assert.equal(options.getServiceWebviewPreloadPath(), "preload.js");
  await options.clearSessionCache();
  assert.equal(cacheCleared, true);
});

test("marketplace ipc options use process context for window and cache dependencies", async () => {
  const state = createMainAppState();
  const mainWindow = { id: 23 };
  state.mainWindow = mainWindow;
  let cacheCleared = false;
  const context = createMainProcessContext({
    state,
    app: { name: "ZenMind" },
    ipcMain: {},
    platform: "win32",
    shell: {},
    session: {
      defaultSession: {
        clearCache: async () => {
          cacheCleared = true;
        }
      }
    },
    nativeTheme: {}
  });
  const dependencies = {
    t: (key) => key,
    runServiceMutation: () => undefined,
    showArchiveDialog: () => undefined,
    showFileDialog: () => undefined,
    showSaveDialog: () => undefined,
    installPluginFromArchive: () => undefined,
    handlePluginUninstall: () => undefined,
    getMarketSettings: () => ({}),
    saveMarketSettings: () => undefined,
    listMarketItems: () => [],
    refreshMarketCatalog: () => undefined,
    installMarketItem: () => undefined,
    updateMarketItem: () => undefined,
    uninstallMarketItem: () => undefined,
    buildSandboxImage: () => undefined,
    deleteSandboxImage: () => undefined,
    exportSandboxImageToPath: () => undefined,
    importSandboxImageFromPath: () => undefined,
    importSkillFromPath: () => undefined,
    importSkillFromCommand: () => undefined,
    getPanAuthStatus: () => ({}),
    importPanPrivateKey: () => undefined
  };

  const options = createMarketplaceIpcHandlerOptions(context, dependencies);

  assert.equal(options.app.name, "ZenMind");
  assert.equal(options.platform, "win32");
  assert.equal(options.mainWindow, mainWindow);
  assert.equal(options.t("market.title"), "market.title");
  await options.clearSessionCache();
  assert.equal(cacheCleared, true);
});

test("shell ipc options read app window and platform from the process context", () => {
  const state = createMainAppState();
  const mainWindow = { id: 31 };
  state.mainWindow = mainWindow;
  const context = createMainProcessContext({
    state,
    app: { name: "ZenMind" },
    ipcMain: {},
    platform: "darwin",
    shell: {},
    session: {},
    nativeTheme: {}
  });
  const dependencies = {
    showFileDialog: () => "file",
    revealPathInFileManager: () => "revealed"
  };

  const options = createShellIpcHandlerOptions(context, dependencies);

  assert.equal(options.app.name, "ZenMind");
  assert.equal(options.platform, "darwin");
  assert.equal(options.mainWindow, mainWindow);
  assert.equal(options.showFileDialog(), "file");
  assert.equal(options.revealPathInFileManager(), "revealed");
});

test("sso ipc options use the process context app and injected sso actions", () => {
  const state = createMainAppState();
  const context = createMainProcessContext({
    state,
    app: { name: "ZenMind" },
    ipcMain: {},
    platform: "win32",
    shell: {},
    session: {},
    nativeTheme: {}
  });
  const dependencies = {
    desktopSsoController: { id: "sso" },
    getDesktopSsoStatus: () => "status",
    startDesktopSsoLogin: () => "login",
    logoutDesktopSso: () => "logout",
    failDesktopSsoFlow: () => "fail",
    issueAgentAccessToken: () => "token"
  };

  const options = createSsoIpcHandlerOptions(context, dependencies);

  assert.equal(options.app.name, "ZenMind");
  assert.equal(options.desktopSsoController, dependencies.desktopSsoController);
  assert.equal(options.getDesktopSsoStatus(), "status");
  assert.equal(options.startDesktopSsoLogin(), "login");
  assert.equal(options.logoutDesktopSso(), "logout");
  assert.equal(options.failDesktopSsoFlow(), "fail");
  assert.equal(options.issueAgentAccessToken(), "token");
});

test("task board ipc options use context app and preserve sidebar item app binding", () => {
  const state = createMainAppState();
  const app = { name: "ZenMind" };
  const context = createMainProcessContext({
    state,
    app,
    ipcMain: {},
    platform: "win32",
    shell: {},
    session: {},
    nativeTheme: {}
  });
  const dependencies = {
    listTaskBoardIssues: () => [],
    createTaskBoardIssue: () => "create",
    updateTaskBoardIssue: () => "update",
    deleteTaskBoardIssueWithAutomation: () => "delete",
    moveTaskBoardIssue: () => "move",
    syncTaskBoardIssueAutomation: () => "sync",
    callAgentPlatform: () => "agent",
    listCustomSidebarItems: (targetApp) => targetApp.name,
    addCustomSidebarItem: () => "add",
    updateCustomSidebarItem: () => "update-sidebar",
    removeCustomSidebarItem: () => "remove",
    importCustomSidebarItems: () => "import",
    exportCustomSidebarItems: () => "export",
    showFileDialog: () => "file",
    showSaveDialog: () => "save",
    getDataRoot: () => "data-root"
  };

  const options = createTaskBoardIpcHandlerOptions(context, dependencies);

  assert.equal(options.app, app);
  assert.equal(options.createTaskBoardIssue(), "create");
  assert.equal(options.listCustomSidebarItems(), "ZenMind");
  assert.equal(options.showSaveDialog(), "save");
  assert.equal(options.getDataRoot(), "data-root");
});

test("desktop pet ipc options read and update desktop pet state through the context", () => {
  const state = createMainAppState();
  const settings = { enabled: true };
  const nextSettings = { enabled: false };
  const window = { id: 41 };
  state.desktopPetSettings = settings;
  state.desktopPetWindow = window;
  const context = createMainProcessContext({
    state,
    app: { name: "ZenMind" },
    ipcMain: {},
    platform: "win32",
    shell: {},
    session: {},
    nativeTheme: {}
  });
  const dependencies = {
    clearActiveRuns: () => "cleared",
    showWindow: () => "shown",
    hideWindow: () => "hidden",
    openAssistant: () => "assistant",
    moveWindowBy: () => "moved",
    beginDrag: () => "begin",
    endDrag: () => "end",
    setPreviewExpanded: () => "expanded",
    dismissPreview: () => "dismiss",
    setMouseInteractive: () => "mouse",
    scheduleStatusRefresh: () => "scheduled",
    refreshState: () => "refreshed"
  };

  const options = createDesktopPetIpcHandlerOptions(context, dependencies);

  assert.equal(options.app.name, "ZenMind");
  assert.equal(options.platform, "win32");
  assert.equal(options.getSettings(), settings);
  options.saveSettingsInState(nextSettings);
  assert.equal(state.desktopPetSettings, nextSettings);
  options.setAgentStatus({ presence: "busy" });
  assert.deepEqual(state.desktopPetAgentStatus, { presence: "busy" });
  assert.equal(options.getWindow(), window);
  assert.equal(options.openAssistant(), "assistant");
});

test("settings ipc options use context runtime dependencies and injected refresh actions", () => {
  const state = createMainAppState();
  const nativeTheme = { themeSource: "system" };
  const context = createMainProcessContext({
    state,
    app: { name: "ZenMind" },
    ipcMain: {},
    platform: "darwin",
    shell: {},
    session: {},
    nativeTheme
  });
  const dependencies = {
    getDataRoot: () => "data-root",
    initializeMainI18n: () => "i18n",
    isSupportedLocale: () => true,
    setMainLocale: () => "locale",
    buildApplicationMenu: () => "menu",
    refreshTrayContextMenu: () => "tray",
    emitLocaleChanged: () => "emit"
  };

  const options = createSettingsIpcHandlerOptions(context, dependencies);

  assert.equal(options.app.name, "ZenMind");
  assert.equal(options.platform, "darwin");
  assert.equal(options.nativeTheme, nativeTheme);
  assert.equal(options.getDataRoot(), "data-root");
  assert.equal(options.refreshTrayContextMenu(), "tray");
  assert.equal(options.emitLocaleChanged(), "emit");
});
