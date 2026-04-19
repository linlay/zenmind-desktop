import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  type MenuItemConstructorOptions,
  type OpenDialogOptions
} from "electron";
import { issueAgentAccessToken } from "./agent-auth";
import {
  ensureCodeAssistantReady,
  ensureManagedClaudeCodeRelayPlugin,
  syncManagedCodeAssistantAgentDefinition,
  setCodeAssistantEnabled,
  setCodeAssistantFullAccessGranted,
  getCodeAssistantIntegrationStatus,
  restartCodeAssistantRuntime,
  getCodeAssistantRepoContext,
  updateCodeAssistantRepoPath,
  setCodeAssistantBranch
} from "./code-assistant";
import { getPanAuthStatus, importPanPrivateKey } from "./pan-auth";
import { loadBuiltinServices } from "./builtin-loader";
import {
  getServiceLogsMeta,
  readServiceLog,
  getServiceState,
  initializeService,
  importServiceFile,
  installBuiltinService,
  listServices,
  readServiceConfig,
  restartService,
  startService,
  stopService,
  stopRunningServices,
  stopStartedServices,
  writeServiceConfig
} from "./service-manager";
import { installPluginFromArchive, loadInstalledPlugins } from "./plugin-loader";
import { handlePluginUninstall } from "./plugin-uninstall";
import type { ServiceId, ServiceLogReadOptions, ServiceLogTarget } from "../shared/contracts";
import {
  getDataRoot,
  loadUserPaths,
  migrateDataRoot,
  saveDataRoot
} from "./user-paths";
import { getAllServices } from "./service-registry";

let mainWindow: BrowserWindow | null = null;
let isHandlingQuit = false;
const DESKTOP_OPTIONAL_AUTO_START_SERVICE_IDS = new Set(["agent-container-hub"]);

// Keep dev Electron runs on the same data root as packaged builds.
app.setName("国泰君安期货");
app.setPath("userData", path.join(app.getPath("appData"), "zenmind-desktop"));

function getRendererEntry() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    return devServerUrl;
  }
  return path.join(__dirname, "..", "..", "dist-renderer", "index.html");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#F7F8FA",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    console.error("renderer failed to load", {
      errorCode,
      errorDescription,
      validatedUrl
    });
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("renderer process exited unexpectedly", details);
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("preload failed", {
      preloadPath,
      error: error?.stack || String(error)
    });
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(getRendererEntry()).catch((error) => {
      console.error("failed to load dev renderer", error);
      app.quit();
    });
  } else {
    mainWindow.loadFile(getRendererEntry()).catch((error) => {
      console.error("failed to load renderer file", error);
      app.quit();
    });
  }

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat || input.key.toLowerCase() !== "i") {
      return;
    }

    const isMacDevToolsShortcut =
      process.platform === "darwin" && input.meta && input.alt && !input.control && !input.shift;
    const isDesktopDevToolsShortcut =
      process.platform !== "darwin" && input.control && input.shift && !input.meta && !input.alt;

    if (!isMacDevToolsShortcut && !isDesktopDevToolsShortcut) {
      return;
    }

    event.preventDefault();
    mainWindow?.webContents.toggleDevTools();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function getOrCreateMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  return createWindow();
}

function navigateMainWindow(targetPath: string) {
  const targetWindow = getOrCreateMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  targetWindow.focus();

  const sendNavigate = () => {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send("app.navigate", targetPath);
    }
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", sendNavigate);
    return;
  }

  sendNavigate();
}

function showDirectoryDialog(title: string, defaultPath: string, ownerWindow: BrowserWindow | null = mainWindow) {
  const options: OpenDialogOptions = {
    title,
    defaultPath,
    buttonLabel: "选择目录",
    properties: ["openDirectory", "createDirectory"]
  };
  if (ownerWindow) {
    return dialog.showOpenDialog(ownerWindow, options);
  }
  return dialog.showOpenDialog(options);
}

function showFileDialog(options: OpenDialogOptions, ownerWindow: BrowserWindow | null = mainWindow) {
  if (ownerWindow) {
    return dialog.showOpenDialog(ownerWindow, options);
  }
  return dialog.showOpenDialog(options);
}

function showArchiveDialog(title: string) {
  const isWindows = process.platform === "win32";
  return showFileDialog({
    title,
    properties: ["openFile"],
    filters: [{ name: "Archive", extensions: isWindows ? ["zip"] : ["gz", "tgz"] }]
  });
}

function buildApplicationMenu() {
  const isMac = process.platform === "darwin";
  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? "设置..." : "设置",
    accelerator: "CmdOrCtrl+,",
    click: () => navigateMainWindow("/settings")
  };

  const template: MenuItemConstructorOptions[] = [
    isMac
      ? {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            settingsItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" }
          ]
        }
      : {
          label: "File",
          submenu: [settingsItem, { type: "separator" }, { role: "quit" }]
        },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function initializeDataRoot() {
  const current = loadUserPaths(app);
  if (process.platform !== "win32" || current.configured) {
    return;
  }

  const defaultRoot = app.getPath("userData");
  const result = await showDirectoryDialog("选择 国泰君安期货 数据目录", defaultRoot, null);
  const selectedRoot =
    result.canceled || result.filePaths.length === 0 ? defaultRoot : result.filePaths[0];
  try {
    saveDataRoot(app, selectedRoot);
  } catch (error) {
    console.error("failed to initialize custom data root", error);
    saveDataRoot(app, defaultRoot);
  }
}

function registerIpcHandlers() {
  ipcMain.handle("services.list", async () => listServices(app));
  ipcMain.handle("services.installBuiltinFromBundle", async (_event, serviceId: ServiceId) => {
    const current = await getServiceState(app, serviceId);
    if (current.kind !== "builtin") {
      throw new Error(`service ${serviceId} is not a builtin service`);
    }
    if (current.status === "running") {
      return {
        ok: false,
        message: "服务正在运行中，请先停止后再安装。",
        service: current
      };
    }

    await installBuiltinService(app, serviceId);
    await session.defaultSession.clearCache();
    return {
      ok: true,
      message: "内置服务已安装。",
      service: await getServiceState(app, serviceId)
    };
  });
  ipcMain.handle("services.installBuiltin", async (_event, serviceId: ServiceId) => {
    const current = await getServiceState(app, serviceId);
    if (current.kind !== "builtin") {
      throw new Error(`service ${serviceId} is not a builtin service`);
    }
    if (current.status === "running") {
      return {
        ok: false,
        message: "服务正在运行中，请先停止后再安装。",
        service: current
      };
    }

    const result = await showArchiveDialog(
      process.platform === "win32" ? "选择内置服务安装包 (.zip)" : "选择内置服务安装包 (.tar.gz)"
    );
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        message: "已取消安装。",
        service: await getServiceState(app, serviceId)
      };
    }

    await installBuiltinService(app, serviceId, {
      force: true,
      archivePath: result.filePaths[0]
    });
    await session.defaultSession.clearCache();
    return {
      ok: true,
      message: "内置服务已安装。",
      service: await getServiceState(app, serviceId)
    };
  });
  ipcMain.handle("services.initialize", async (_event, serviceId: ServiceId) => {
    return initializeService(app, serviceId);
  });
  ipcMain.handle("services.getStatus", async (_event, serviceId: ServiceId) => getServiceState(app, serviceId));
  ipcMain.handle("services.start", async (_event, serviceId: ServiceId) => startService(app, serviceId));
  ipcMain.handle("services.stop", async (_event, serviceId: ServiceId) => stopService(app, serviceId));
  ipcMain.handle("services.restart", async (_event, serviceId: ServiceId) => restartService(app, serviceId));
  ipcMain.handle("services.readConfig", async (_event, serviceId: ServiceId, key: string) => {
    return readServiceConfig(app, serviceId, key);
  });
  ipcMain.handle("services.writeConfig", async (_event, serviceId: ServiceId, key: string, content: string) => {
    return writeServiceConfig(app, serviceId, key, content);
  });
  ipcMain.handle("services.importFile", async (_event, serviceId: ServiceId, targetKey: string) => {
    const result = await showFileDialog({
      title: "选择要导入的文件",
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        message: "已取消导入。",
        targetPath: "",
        service: await getServiceState(app, serviceId)
      };
    }
    return importServiceFile(app, serviceId, targetKey, result.filePaths[0]);
  });
  ipcMain.handle("services.getLogsMeta", async (_event, serviceId: ServiceId) => {
    return getServiceLogsMeta(app, serviceId);
  });
  ipcMain.handle(
    "services.readLog",
    async (_event, serviceId: ServiceId, target: ServiceLogTarget, options?: ServiceLogReadOptions) => {
      return readServiceLog(app, serviceId, target, options);
    }
  );
  ipcMain.handle("plugins.install", async () => {
    const result = await showArchiveDialog(
      process.platform === "win32" ? "选择插件包 (.zip)" : "选择插件包 (.tar.gz)"
    );
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: "已取消导入。" };
    }
    const installResult = await installPluginFromArchive(app, result.filePaths[0]);
    if (installResult.ok) {
      await session.defaultSession.clearCache();
    }
    return installResult;
  });
  ipcMain.handle("plugins.uninstall", async (_event, serviceId: ServiceId) => {
    return handlePluginUninstall(app, serviceId, mainWindow);
  });
  ipcMain.handle("panAuth.importPrivateKey", async () => {
    const result = await showFileDialog({
      title: "选择要导入的 App 私钥",
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      const status = getPanAuthStatus(app);
      return {
        ok: false,
        message: "已取消导入 Desktop App 私钥。",
        status
      };
    }

    const status = importPanPrivateKey(app, result.filePaths[0]);
    return {
      ok: true,
      message: status.message,
      status
    };
  });
  ipcMain.handle("panAuth.getStatus", async () => getPanAuthStatus(app));
  ipcMain.handle("agentAuth.issueAccessToken", async (_event, reason: "missing" | "unauthorized") => {
    return issueAgentAccessToken(app, reason);
  });
  ipcMain.handle("codeAssistant.getStatus", async () => {
    try {
      const service = await getServiceState(app, "claude-code-relay");
      return getCodeAssistantIntegrationStatus(app, service);
    } catch (error) {
      return {
        enabled: false,
        fullAccessGranted: false,
        running: false,
        configured: false,
        repoSelected: false,
        repoPath: "",
        cliConnected: false,
        recovering: false,
        ready: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  ipcMain.handle("codeAssistant.ensureReady", async () => {
    return ensureCodeAssistantReady(app, mainWindow, {
      getServiceState,
      initializeService,
      startService,
      stopService,
      showMessageBox: async (ownerWindow, options) =>
        ownerWindow ? dialog.showMessageBox(ownerWindow, options) : dialog.showMessageBox(options)
    });
  });
  ipcMain.handle("codeAssistant.restartRuntime", async () => {
    return restartCodeAssistantRuntime(app, {
      getServiceState,
      initializeService,
      startService,
      stopService,
      showMessageBox: async (ownerWindow, options) =>
        ownerWindow ? dialog.showMessageBox(ownerWindow, options) : dialog.showMessageBox(options)
    });
  });
  ipcMain.handle("codeAssistant.setEnabled", async (_event, enabled: boolean) => {
    return setCodeAssistantEnabled(app, enabled, mainWindow, {
      getServiceState,
      initializeService,
      startService,
      stopService,
      showMessageBox: async (ownerWindow, options) =>
        ownerWindow ? dialog.showMessageBox(ownerWindow, options) : dialog.showMessageBox(options)
    });
  });
  ipcMain.handle("codeAssistant.setFullAccessGranted", async (_event, granted: boolean) => {
    return setCodeAssistantFullAccessGranted(app, granted, mainWindow, {
      getServiceState,
      initializeService,
      startService,
      stopService,
      showMessageBox: async (ownerWindow, options) =>
        ownerWindow ? dialog.showMessageBox(ownerWindow, options) : dialog.showMessageBox(options)
    });
  });
  ipcMain.handle("codeAssistant.getRepoContext", async () => {
    return getCodeAssistantRepoContext(app);
  });
  ipcMain.handle("codeAssistant.selectRepoPath", async () => {
    const context = getCodeAssistantRepoContext(app);
    const defaultPath = context.repoExists ? context.repoPath : app.getPath("home");
    const result = await showDirectoryDialog("选择代码助手工作目录", defaultPath);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: "已取消选择。", context };
    }
    return updateCodeAssistantRepoPath(app, result.filePaths[0], {
      getServiceState,
      startService,
      stopService
    });
  });
  ipcMain.handle("codeAssistant.setBranch", async (_event, branch: string) => {
    return setCodeAssistantBranch(app, branch, {
      getServiceState,
      startService,
      stopService
    });
  });
  ipcMain.handle("settings.getDataRoot", async () => getDataRoot(app));
  ipcMain.handle("settings.changeDataRoot", async () => {
    if (process.platform !== "win32") {
      return {
        ok: false,
        message: "仅 Windows 支持修改数据目录。",
        dataRoot: getDataRoot(app)
      };
    }

    const currentRoot = getDataRoot(app);
    const result = await showDirectoryDialog("选择新的 国泰君安期货 数据目录", currentRoot);
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        message: "已取消修改数据目录。",
        dataRoot: currentRoot
      };
    }

    const nextRoot = result.filePaths[0];
    if (path.resolve(nextRoot) === path.resolve(currentRoot)) {
      return {
        ok: true,
        message: "数据目录未发生变化。",
        dataRoot: currentRoot
      };
    }

    try {
      await stopRunningServices(app);
      await migrateDataRoot(app, currentRoot, nextRoot);
      ensureManagedClaudeCodeRelayPlugin(app);
      loadInstalledPlugins(app);
      await initializeManagedCodeAssistantPlugin();

      return {
        ok: true,
        message: `数据目录已迁移到 ${getDataRoot(app)}。运行中的服务已停止，请按需重新启动。`,
        dataRoot: getDataRoot(app)
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        dataRoot: currentRoot
      };
    }
  });
}

async function initializeManagedCodeAssistantPlugin() {
  try {
    const state = await getServiceState(app, "claude-code-relay");
    if (state.status === "initialization-required") {
      await initializeService(app, "claude-code-relay");
    }
    syncManagedCodeAssistantAgentDefinition(app);
  } catch (error) {
    console.error("failed to initialize managed code assistant plugin", error);
  }
}

async function autoStartDesktopServices() {
  for (const service of getAllServices()) {
    if (!service.desktop.autoStart) {
      continue;
    }
    if (DESKTOP_OPTIONAL_AUTO_START_SERVICE_IDS.has(service.id)) {
      continue;
    }
    try {
      const result = await startService(app, service.id);
      if (!result.ok) {
        console.warn(`auto-start skipped for ${service.id}: ${result.message}`);
      }
    } catch (error) {
      console.error(`failed to auto-start ${service.id}`, error);
    }
  }
}

app.whenReady().then(async () => {
  await initializeDataRoot();
  loadBuiltinServices(app);
  ensureManagedClaudeCodeRelayPlugin(app);
  loadInstalledPlugins(app);
  await initializeManagedCodeAssistantPlugin();
  registerIpcHandlers();
  createWindow();
  buildApplicationMenu();
  void autoStartDesktopServices();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", (event) => {
  if (isHandlingQuit) {
    return;
  }
  event.preventDefault();
  isHandlingQuit = true;
  stopStartedServices(app)
    .catch((error) => {
      console.error("failed while shutting down desktop services", error);
    })
    .finally(() => {
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
