import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  session,
  Tray,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type SaveDialogOptions
} from "electron";
import { issueAgentAccessToken } from "./agent-auth";
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
  restoreRunningServices,
  restartService,
  startService,
  stopService,
  stopRunningServices,
  writeServiceConfig
} from "./service-manager";
import { installPluginFromArchive, loadInstalledPlugins } from "./plugin-loader";
import { handlePluginUninstall } from "./plugin-uninstall";
import {
  detectPortConflict,
  isPortConflictError,
  killProcessByPid,
  showPortConflictDialog
} from "./port-conflict";
import {
  addCustomSidebarItem,
  exportCustomSidebarItems,
  importCustomSidebarItems,
  listCustomSidebarItems,
  removeCustomSidebarItem
} from "./custom-sidebar-store";
import { getService } from "./service-registry";
import type {
  AssistantWorkerOpenRequest,
  ServiceId,
  ServiceLogReadOptions,
  ServiceLogTarget,
  StartupRestoreServiceState,
  StartupRestoreState
} from "../shared/contracts";
import {
  ensureDataRoot,
  getDataRoot,
} from "./user-paths";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isHandlingQuit = false;
let serviceMutationQueue = Promise.resolve();
const ASSISTANT_TARGET_PATH = "/plugin/agent-webclient";
const STARTUP_RESTORE_SERVICE_ORDER = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
let startupRestoreState = createStartupRestoreState();

// Keep dev Electron runs on the same data root as packaged builds.
app.setName("ZenMind");
app.setPath("userData", path.join(app.getPath("appData"), "zenmind-desktop"));

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRendererEntry() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    return devServerUrl;
  }
  return path.join(__dirname, "..", "..", "dist-renderer", "index.html");
}

function parseHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed;
    }
  } catch {
    // Ignore invalid URLs and let the fallback path handle them.
  }
  return null;
}

function shouldOpenPopupInCurrentWebview(currentUrl: string, targetUrl: string) {
  const target = parseHttpUrl(targetUrl);
  if (!target) {
    return false;
  }

  const current = parseHttpUrl(currentUrl);
  if (!current) {
    return true;
  }

  return current.origin === target.origin;
}

function setSidebarTranslucency(enabled: boolean) {
  const effective = process.platform === "darwin";
  if (!effective) {
    return {
      ok: true,
      enabled: false,
      effective: false,
      message: "半透明侧边栏仅在 macOS 生效。"
    };
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setVibrancy(enabled ? "under-window" : null);
    mainWindow.setBackgroundColor(enabled ? "#00000000" : "#FFFFFF");
  }

  return {
    ok: true,
    enabled,
    effective: true,
    message: enabled ? "已开启半透明侧边栏。" : "已关闭半透明侧边栏。"
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#FFFFFF",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          transparent: true
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.show();
    mainWindow.focus();
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

  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    contents.on("did-fail-load", (_guestEvent, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (errorCode === -3) {
        return;
      }
      console.error("webview failed to load", {
        guestId: contents.id,
        errorCode,
        errorDescription,
        validatedUrl,
        isMainFrame
      });
    });

    contents.on("render-process-gone", (_guestEvent, details) => {
      console.error("webview render process exited unexpectedly", {
        guestId: contents.id,
        details
      });
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (shouldOpenPopupInCurrentWebview(contents.getURL(), url)) {
        setImmediate(() => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            void shell.openExternal(url).catch((error) => {
              console.error("failed to recover webview popup externally", { url, error });
            });
            return;
          }

          mainWindow.webContents.send("webview.popupNavigate", {
            guestId: contents.id,
            url
          });
        });
        return { action: "deny" };
      }

      void shell.openExternal(url).catch((error) => {
        console.error("failed to open external popup url", { url, error });
      });
      return { action: "deny" };
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

  mainWindow.on("close", (event) => {
    if (isHandlingQuit) {
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
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

function showMainWindow(targetPath?: string) {
  const targetWindow = getOrCreateMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  targetWindow.show();
  targetWindow.focus();

  if (targetPath) {
    navigateMainWindow(targetPath);
  }
}

function notifyServicesChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("services.changed");
}

function createStartupRestoreState(phase: StartupRestoreState["phase"] = "idle"): StartupRestoreState {
  return {
    phase,
    serviceOrder: [...STARTUP_RESTORE_SERVICE_ORDER],
    currentServiceId: null,
    failedServiceId: null,
    message: "",
    updatedAt: new Date().toISOString(),
    services: STARTUP_RESTORE_SERVICE_ORDER.map<StartupRestoreServiceState>((serviceId) => ({
      serviceId,
      phase: "pending"
    }))
  };
}

function cloneStartupRestoreState(state: StartupRestoreState) {
  return {
    ...state,
    serviceOrder: [...state.serviceOrder],
    services: state.services.map((service) => ({ ...service }))
  } satisfies StartupRestoreState;
}

function commitStartupRestoreState(nextState: StartupRestoreState) {
  startupRestoreState = {
    ...cloneStartupRestoreState(nextState),
    updatedAt: new Date().toISOString()
  };
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("services.startupRestoreState", cloneStartupRestoreState(startupRestoreState));
}

function beginStartupRestoreSession() {
  commitStartupRestoreState(createStartupRestoreState("running"));
}

function updateStartupRestoreService(serviceId: ServiceId, phase: StartupRestoreServiceState["phase"], message = "") {
  const currentState = cloneStartupRestoreState(startupRestoreState);
  const nextServices = currentState.services.map((service) =>
    service.serviceId === serviceId
      ? {
          ...service,
          phase,
          message
        }
      : service
  );

  if (phase === "starting") {
    commitStartupRestoreState({
      ...currentState,
      phase: "running",
      currentServiceId: serviceId,
      failedServiceId: null,
      message,
      services: nextServices
    });
    return;
  }

  if (phase === "failed") {
    commitStartupRestoreState({
      ...currentState,
      phase: "failed",
      currentServiceId: null,
      failedServiceId: serviceId,
      message,
      services: nextServices
    });
    return;
  }

  const allSucceeded = nextServices.every((service) => service.phase === "succeeded");
  commitStartupRestoreState({
    ...currentState,
    phase: allSucceeded ? "succeeded" : "running",
    currentServiceId: null,
    failedServiceId: null,
    message: allSucceeded ? "核心服务已全部就绪。" : message,
    services: nextServices
  });
}

async function runServiceMutation<T>(task: () => Promise<T>) {
  const previousTask = serviceMutationQueue;
  let releaseQueue = () => {};
  serviceMutationQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previousTask;
  try {
    return await task();
  } finally {
    releaseQueue();
    notifyServicesChanged();
  }
}

function navigateMainWindow(targetPath: string) {
  const targetWindow = getOrCreateMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  targetWindow.show();
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

function openAssistantWorker(request: AssistantWorkerOpenRequest) {
  showMainWindow(ASSISTANT_TARGET_PATH);

  const targetWindow = mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const sendOpenAssistantWorker = () => {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send("app.openAssistantWorker", request);
    }
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", sendOpenAssistantWorker);
    return;
  }

  setTimeout(sendOpenAssistantWorker, 100);
}

function createTrayIcon() {
  const platformIconPath =
    process.platform === "win32"
      ? path.join(__dirname, "..", "..", "build", "icons", "icon.ico")
      : path.join(__dirname, "..", "..", "build", "icons", "icon-16.png");
  const iconPaths = [
    path.join(__dirname, "..", "..", "dist-renderer", "tray-icon.png"),
    path.join(__dirname, "..", "..", "public", "tray-icon.png"),
    platformIconPath,
    path.join(__dirname, "..", "..", "public", "brand-icon.png")
  ];
  const icon =
    iconPaths
      .map((iconPath) => nativeImage.createFromPath(iconPath))
      .find((candidate) => !candidate.isEmpty()) ?? nativeImage.createEmpty();
  const resizedIcon = icon.resize({ width: 20, height: 20 });
  if (process.platform === "darwin") {
    resizedIcon.setTemplateImage(true);
  }
  return resizedIcon;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "和小宅聊天",
      click: () =>
        openAssistantWorker({
          displayName: "小宅",
          role: "确认对话示例",
          focusComposerOnComplete: true
        })
    },
    {
      label: "打开 ZenMind",
      click: () => showMainWindow(ASSISTANT_TARGET_PATH)
    },
    {
      label: "设置",
      click: () => showMainWindow("/settings")
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => app.quit()
    }
  ]);
}

function createAppTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  const trayMenu = buildTrayMenu();
  tray.setToolTip("ZenMind");
  if (process.platform !== "darwin") {
    tray.setContextMenu(trayMenu);
  }
  tray.on("click", () => showMainWindow(ASSISTANT_TARGET_PATH));
  tray.on("right-click", () => tray?.popUpContextMenu(trayMenu));

  return tray;
}

function showFileDialog(options: OpenDialogOptions, ownerWindow: BrowserWindow | null = mainWindow) {
  if (ownerWindow) {
    return dialog.showOpenDialog(ownerWindow, options);
  }
  return dialog.showOpenDialog(options);
}

function showSaveDialog(
  options: SaveDialogOptions,
  ownerWindow: BrowserWindow | null = mainWindow
) {
  if (ownerWindow) {
    return dialog.showSaveDialog(ownerWindow, options);
  }
  return dialog.showSaveDialog(options);
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

async function handleServiceStart(serviceId: ServiceId) {
  try {
    return await startService(app, serviceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isPortConflictError(message)) {
      throw error;
    }

    const service = getService(serviceId);
    const currentState = await getServiceState(app, serviceId).catch(() => null);
    const conflict = await detectPortConflict(message, service, {
      fallbackPort: currentState?.healthMeta.port ?? null
    });
    if (!conflict?.processInfo) {
      throw error;
    }

    const confirmed = await showPortConflictDialog(mainWindow, conflict.port, conflict.processInfo);
    if (!confirmed) {
      throw error;
    }

    const killed = await killProcessByPid(conflict.processInfo.pid);
    if (!killed) {
      throw new Error(
        `无法终止占用端口 ${conflict.port} 的进程 ${conflict.processInfo.name} (PID ${conflict.processInfo.pid})。`
      );
    }

    await delay(500);
    return startService(app, serviceId);
  }
}

function registerIpcHandlers() {
  ipcMain.handle("services.list", async () => listServices(app));
  ipcMain.handle("services.getStartupRestoreState", async () => cloneStartupRestoreState(startupRestoreState));
  ipcMain.handle("services.installBuiltinFromBundle", async (_event, serviceId: ServiceId) => runServiceMutation(async () => {
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
  }));
  ipcMain.handle("services.installBuiltin", async (_event, serviceId: ServiceId) => runServiceMutation(async () => {
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
  }));
  ipcMain.handle("services.initialize", async (_event, serviceId: ServiceId) => {
    return runServiceMutation(() => initializeService(app, serviceId));
  });
  ipcMain.handle("services.getStatus", async (_event, serviceId: ServiceId) => getServiceState(app, serviceId));
  ipcMain.handle("services.start", async (_event, serviceId: ServiceId) =>
    runServiceMutation(() => handleServiceStart(serviceId)));
  ipcMain.handle("services.stop", async (_event, serviceId: ServiceId) =>
    runServiceMutation(() => stopService(app, serviceId)));
  ipcMain.handle("services.restart", async (_event, serviceId: ServiceId) =>
    runServiceMutation(() => restartService(app, serviceId)));
  ipcMain.handle("services.readConfig", async (_event, serviceId: ServiceId, key: string) => {
    return readServiceConfig(app, serviceId, key);
  });
  ipcMain.handle("services.writeConfig", async (_event, serviceId: ServiceId, key: string, content: string) => {
    return runServiceMutation(() => writeServiceConfig(app, serviceId, key, content));
  });
  ipcMain.handle("services.importFile", async (_event, serviceId: ServiceId, targetKey: string) => {
    return runServiceMutation(async () => {
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
  ipcMain.handle("plugins.install", async () => runServiceMutation(async () => {
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
  }));
  ipcMain.handle("plugins.uninstall", async (_event, serviceId: ServiceId) => {
    return runServiceMutation(() => handlePluginUninstall(app, serviceId, mainWindow));
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
  ipcMain.handle("customSidebar.list", async () => listCustomSidebarItems(app));
  ipcMain.handle("customSidebar.add", async (_event, input: { label?: string; url: string }) => {
    return addCustomSidebarItem(app, input);
  });
  ipcMain.handle("customSidebar.remove", async (_event, id: string) => {
    return removeCustomSidebarItem(app, id);
  });
  ipcMain.handle("customSidebar.import", async () => {
    const result = await showFileDialog({
      title: "导入侧边栏配置",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        items: listCustomSidebarItems(app).items,
        path: "",
        message: "已取消导入侧边栏配置。"
      };
    }

    const importPath = result.filePaths[0];
    const fileContent = await fs.promises.readFile(importPath, "utf8");
    const importResult = importCustomSidebarItems(app, fileContent);
    return {
      ...importResult,
      path: importPath
    };
  });
  ipcMain.handle("customSidebar.export", async () => {
    const saveResult = await showSaveDialog({
      title: "导出侧边栏配置",
      defaultPath: path.join(getDataRoot(app), "custom-sidebar-items.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        items: listCustomSidebarItems(app).items,
        path: "",
        message: "已取消导出侧边栏配置。"
      };
    }

    const filePath = saveResult.filePath;
    await fs.promises.writeFile(filePath, `${exportCustomSidebarItems(app)}\n`, "utf8");
    return {
      ok: true,
      items: listCustomSidebarItems(app).items,
      path: filePath,
      message: "已导出侧边栏配置。"
    };
  });
  ipcMain.handle("settings.getDataRoot", async () => getDataRoot(app));
  ipcMain.handle("settings.getPlatform", async () => process.platform);
  ipcMain.handle("settings.setSidebarTranslucency", async (_event, enabled: boolean) =>
    setSidebarTranslucency(enabled)
  );
}

app.whenReady().then(async () => {
  ensureDataRoot(app);
  loadBuiltinServices(app);
  loadInstalledPlugins(app);
  registerIpcHandlers();
  createWindow();
  createAppTray();
  buildApplicationMenu();
  beginStartupRestoreSession();
  void runServiceMutation(() =>
    restoreRunningServices(app, {
      onStarting: (serviceId) => {
        updateStartupRestoreService(serviceId, "starting", "启动中...");
      },
      onProgress: (serviceId, phase, message) => {
        updateStartupRestoreService(serviceId, phase, message);
        notifyServicesChanged();
      }
    })
  )
    .then((result) => {
      if (result.failures.length === 0 && startupRestoreState.phase === "running") {
        commitStartupRestoreState({
          ...startupRestoreState,
          phase: "succeeded",
          currentServiceId: null,
          failedServiceId: null,
          message: "核心服务已全部就绪。"
        });
      }
      notifyServicesChanged();
      if (result.failures.length > 0) {
        console.error("failed to restore running services from last session", result.failures);
      }
    })
    .catch((error) => {
      if (startupRestoreState.phase === "running") {
        commitStartupRestoreState({
          ...startupRestoreState,
          phase: "failed",
          currentServiceId: null,
          failedServiceId: startupRestoreState.currentServiceId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      console.error("failed to restore running services from last session", error);
    });
  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("before-quit", (event) => {
  if (isHandlingQuit) {
    return;
  }
  event.preventDefault();
  isHandlingQuit = true;
  stopRunningServices(app)
    .catch((error) => {
      console.error("failed while shutting down desktop services", error);
    })
    .finally(() => {
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isHandlingQuit) {
    app.quit();
  }
});
