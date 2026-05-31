import { getSandboxImageExportDefaultPath } from "../download-paths";

export interface MarketplaceIpcHandlerOptions {
  app: any;
  platform?: string;
  mainWindow: any;
  t: (key: any, params?: any) => string;
  runServiceMutation: <T>(task: () => Promise<T>) => Promise<T>;
  showArchiveDialog: (title: string) => Promise<any>;
  showFileDialog: (options: any, owner?: any) => Promise<any>;
  showSaveDialog: (options: any, owner?: any) => Promise<any>;
  clearSessionCache: () => Promise<void>;
  installPluginFromArchive: (app: any, archivePath: string) => Promise<any>;
  handlePluginUninstall: (app: any, serviceId: any, mainWindow: any, options: { t: MarketplaceIpcHandlerOptions["t"] }) => Promise<any>;
  getMarketSettings: (app: any) => any;
  saveMarketSettings: (app: any, input: any) => any;
  listMarketItems: (app: any) => any;
  refreshMarketCatalog: (app: any) => Promise<any>;
  installMarketItem: (app: any, itemId: string) => Promise<any>;
  updateMarketItem: (app: any, itemId: string) => Promise<any>;
  uninstallMarketItem: (app: any, itemId: string) => Promise<any>;
  buildSandboxImage: (app: any, itemId: string) => Promise<any>;
  deleteSandboxImage: (app: any, itemId: string) => Promise<any>;
  exportSandboxImageToPath: (app: any, imageRef: string, exportPath: string) => Promise<any>;
  importSandboxImageFromPath: (app: any, archivePath: string, options: any) => Promise<any>;
  importSkillFromPath: (app: any, sourcePath: string) => Promise<any>;
  importSkillFromCommand: (app: any, commandText: string) => Promise<any>;
  getPanAuthStatus: (app: any) => any;
  importPanPrivateKey: (app: any, keyPath: string) => any;
  now?: () => number;
  random?: () => number;
}

export function registerMarketplaceIpcHandlers(ipcMain: any, options: MarketplaceIpcHandlerOptions) {
  const {
    app,
    platform = process.platform,
    mainWindow,
    t,
    runServiceMutation,
    showArchiveDialog,
    showFileDialog,
    showSaveDialog,
    clearSessionCache,
    installPluginFromArchive,
    handlePluginUninstall,
    getMarketSettings,
    saveMarketSettings,
    listMarketItems,
    refreshMarketCatalog,
    installMarketItem,
    updateMarketItem,
    uninstallMarketItem,
    buildSandboxImage,
    deleteSandboxImage,
    exportSandboxImageToPath,
    importSandboxImageFromPath,
    importSkillFromPath,
    importSkillFromCommand,
    getPanAuthStatus,
    importPanPrivateKey,
    now = Date.now,
    random = Math.random
  } = options;

  ipcMain.handle("plugins.install", async () => runServiceMutation(async () => {
    const result = await showArchiveDialog(
      platform === "win32" ? "选择插件包 (.zip)" : "选择插件包 (.tar.gz)"
    );
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: "已取消导入。" };
    }
    const installResult = await installPluginFromArchive(app, result.filePaths[0]);
    if (installResult.ok) {
      await clearSessionCache();
    }
    return installResult;
  }));

  ipcMain.handle("plugins.uninstall", async (_event: any, serviceId: any) => {
    return runServiceMutation(() => handlePluginUninstall(app, serviceId, mainWindow, { t }));
  });

  ipcMain.handle("market.getSettings", async () => getMarketSettings(app));
  ipcMain.handle("market.saveSettings", async (_event: any, input: any) => saveMarketSettings(app, input));
  ipcMain.handle("market.list", async () => listMarketItems(app));
  ipcMain.handle("market.refresh", async () => refreshMarketCatalog(app));

  ipcMain.handle("market.install", async (_event: any, itemId: string) => runServiceMutation(async () => {
    const result = await installMarketItem(app, itemId);
    if (result.ok) {
      await clearSessionCache();
    }
    return result;
  }));

  ipcMain.handle("market.update", async (_event: any, itemId: string) => runServiceMutation(async () => {
    const result = await updateMarketItem(app, itemId);
    if (result.ok) {
      await clearSessionCache();
    }
    return result;
  }));

  ipcMain.handle("market.uninstall", async (_event: any, itemId: string) =>
    runServiceMutation(() => uninstallMarketItem(app, itemId)));
  ipcMain.handle("market.buildSandboxImage", async (_event: any, itemId: string) =>
    runServiceMutation(() => buildSandboxImage(app, itemId)));
  ipcMain.handle("market.deleteSandboxImage", async (_event: any, itemId: string) =>
    runServiceMutation(() => deleteSandboxImage(app, itemId)));

  ipcMain.handle("market.exportSandboxImage", async (_event: any, itemId: string) => runServiceMutation(async () => {
    const imageRef = String(itemId ?? "").trim();
    const saveResult = await showSaveDialog({
      title: "导出沙箱镜像",
      defaultPath: getSandboxImageExportDefaultPath(app, platform, imageRef),
      filters: [{ name: "Docker / Podman 镜像归档", extensions: ["tar"] }]
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        itemId: imageRef,
        type: "sandbox-image",
        state: "failed",
        message: "已取消导出。",
        imageRef
      };
    }
    return exportSandboxImageToPath(app, imageRef, saveResult.filePath);
  }));

  ipcMain.handle("market.importSandboxImage", async (event: any) => runServiceMutation(async () => {
    const taskId = `sandbox-import-${now()}-${random().toString(36).slice(2)}`;
    const emitImportProgress = (progress: any) => {
      event.sender.send("market.sandboxImageImportProgress", {
        taskId,
        ...progress
      });
    };
    const result = await showFileDialog({
      title: "选择沙箱镜像压缩包",
      properties: ["openFile"],
      filters: [
        {
          name: "镜像压缩包",
          extensions: platform === "win32" ? ["tar", "gz", "tgz", "zip"] : ["tar", "gz", "tgz"]
        }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        itemId: "",
        type: "sandbox-image",
        state: "failed",
        message: "已取消导入。"
      };
    }
    return importSandboxImageFromPath(app, result.filePaths[0], {
      taskId,
      onProgress: emitImportProgress
    });
  }));

  ipcMain.handle("market.importSkill", async () => runServiceMutation(async () => {
    const result = await showFileDialog({
      title: "选择 Skill 包或 SKILL.md",
      properties: ["openFile"],
      filters: [
        {
          name: "Skill",
          extensions: platform === "win32" ? ["zip", "skill", "md"] : ["gz", "tgz", "skill", "md"]
        }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        itemId: "",
        type: "skill",
        state: "failed",
        message: "已取消导入。"
      };
    }
    return importSkillFromPath(app, result.filePaths[0]);
  }));

  ipcMain.handle("market.importSkillFromCommand", async (_event: any, commandText: string) => runServiceMutation(async () => {
    const result = await importSkillFromCommand(app, commandText);
    if (result.ok) {
      await clearSessionCache();
    }
    return result;
  }));

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
}
