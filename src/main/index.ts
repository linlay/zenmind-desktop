import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { issueAgentAccessToken } from "./agent-auth";
import { ensurePanSession, getPanAuthStatus, importPanPrivateKey } from "./pan-auth";
import { loadBuiltinServices } from "./builtin-loader";
import {
  getServiceLogsMeta,
  getServiceState,
  importServiceFile,
  installBuiltinService,
  listServices,
  readServiceConfig,
  restartService,
  startService,
  stopService,
  stopStartedServices,
  writeServiceConfig
} from "./service-manager";
import { installPluginFromArchive, loadInstalledPlugins, uninstallPlugin } from "./plugin-loader";
import type { ServiceId } from "../shared/contracts";

let mainWindow: BrowserWindow | null = null;
let isHandlingQuit = false;

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
    backgroundColor: "#efe6d8",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle("services.list", async () => listServices(app));
  ipcMain.handle("services.installBuiltin", async (_event, serviceId: ServiceId) => {
    await installBuiltinService(app, serviceId);
    return {
      ok: true,
      message: "内置服务已安装。",
      service: await getServiceState(app, serviceId)
    };
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
    const result = await dialog.showOpenDialog({
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
  ipcMain.handle("plugins.install", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择插件包 (.tar.gz)",
      properties: ["openFile"],
      filters: [{ name: "Plugin Archive", extensions: ["gz", "tgz"] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: "已取消安装。" };
    }
    return installPluginFromArchive(app, result.filePaths[0]);
  });
  ipcMain.handle("plugins.uninstall", async (_event, serviceId: ServiceId) => {
    return uninstallPlugin(app, serviceId);
  });
  ipcMain.handle("panAuth.importPrivateKey", async () => {
    const result = await dialog.showOpenDialog({
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
  ipcMain.handle("panAuth.ensureSession", async (_event, webUrl: string) => {
    return ensurePanSession(app, mainWindow?.webContents.session.cookies ?? session.defaultSession.cookies, webUrl);
  });
  ipcMain.handle("agentAuth.issueAccessToken", async (_event, reason: "missing" | "unauthorized") => {
    return issueAgentAccessToken(app, reason);
  });
}

app.whenReady().then(async () => {
  loadBuiltinServices(app);
  loadInstalledPlugins(app);
  registerIpcHandlers();
  createWindow();
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
