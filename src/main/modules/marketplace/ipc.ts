import { getSandboxImageExportDefaultPath } from "../../infrastructure/filesystem/download-paths";
import { readMarketSkillContent } from "./skill-detail";
import { readMarketSkillPins, saveMarketSkillPins } from "./skill-market";

export interface MarketplaceIpcHandlerOptions {
  app: any;
  platform?: string;
  mainWindow: any;
  getMainWindow?: () => any;
  t: (key: any, params?: any) => string;
  runServiceMutation: <T>(task: () => Promise<T>) => Promise<T>;
  showArchiveDialog: (title: string, extensions?: string[]) => Promise<any>;
  showFileDialog: (options: any, owner?: any) => Promise<any>;
  showSaveDialog: (options: any, owner?: any) => Promise<any>;
  clearSessionCache: () => Promise<void>;
  installPluginFromArchive: (app: any, archivePath: string) => Promise<any>;
  handlePluginUninstall: (app: any, serviceId: any, mainWindow: any, options: { t: MarketplaceIpcHandlerOptions["t"] }) => Promise<any>;
  getMarketSettings: (app: any) => any;
  saveMarketSettings: (app: any, input: any) => any;
  listMarketItems: (app: any, options?: any) => any;
  refreshMarketCatalog: (app: any, options?: any) => Promise<any>;
  toggleMarketFavorite: (app: any, input: any) => Promise<any>;
  installMarketItem: (app: any, itemId: string) => Promise<any>;
  updateMarketItem: (app: any, itemId: string) => Promise<any>;
  uninstallMarketItem: (app: any, itemId: string) => Promise<any>;
  buildSandboxImage: (app: any, itemId: string) => Promise<any>;
  deleteSandboxImage: (app: any, itemId: string) => Promise<any>;
  exportSandboxImageToPath: (app: any, imageRef: string, exportPath: string) => Promise<any>;
  importSandboxImageFromPath: (app: any, archivePath: string, options: any) => Promise<any>;
  importSkillFromPath: (app: any, sourcePath: string) => Promise<any>;
  importSkillFromCommand: (app: any, commandText: string) => Promise<any>;
  onMarketCommandResult?: (result: any) => void;
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
    toggleMarketFavorite,
    installMarketItem,
    updateMarketItem,
    uninstallMarketItem,
    buildSandboxImage,
    deleteSandboxImage,
    exportSandboxImageToPath,
    importSandboxImageFromPath,
    importSkillFromPath,
    importSkillFromCommand,
    onMarketCommandResult,
    now = Date.now,
    random = Math.random
  } = options;

  ipcMain.handle("plugins.install", async () => runServiceMutation(async () => {
    const result = await showArchiveDialog(
      t("dialog.installPlugin.title"),
      ["zip"]
    );
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: t("market.importCancelled") };
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
  const assertPinSender = (event: any) => {
    const owner = options.getMainWindow ? options.getMainWindow() : mainWindow;
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()
      || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) {
      throw new Error("market_skill_pins_forbidden");
    }
  };
  ipcMain.handle("market.getSkillPins", async (event: any) => { assertPinSender(event); return readMarketSkillPins(); });
  ipcMain.handle("market.saveSkillPins", async (event: any, input: unknown) => { assertPinSender(event); return saveMarketSkillPins(input); });
  ipcMain.handle("market.readSkillContent", async (event: any, id: unknown) => {
    const owner = options.getMainWindow ? options.getMainWindow() : mainWindow;
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()
      || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) {
      throw new Error("market_skill_content_forbidden");
    }
    return readMarketSkillContent(app, id);
  });
  ipcMain.handle("market.saveSettings", async (_event: any, input: any) => saveMarketSettings(app, input));
  ipcMain.handle("market.list", async (_event: any, listOptions: any) => listMarketItems(app, listOptions));
  ipcMain.handle("market.refresh", async (_event: any, listOptions: any) => refreshMarketCatalog(app, listOptions));
  ipcMain.handle("market.toggleFavorite", async (_event: any, input: any) => toggleMarketFavorite(app, input));

  ipcMain.handle("market.install", async (_event: any, itemId: string) => runServiceMutation(async () => {
    const result = await installMarketItem(app, itemId);
    if (result.ok) {
      await clearSessionCache();
      onMarketCommandResult?.(result);
    }
    return result;
  }));

  ipcMain.handle("market.update", async (_event: any, itemId: string) => runServiceMutation(async () => {
    const result = await updateMarketItem(app, itemId);
    if (result.ok) {
      await clearSessionCache();
      onMarketCommandResult?.(result);
    }
    return result;
  }));

  ipcMain.handle("market.uninstall", async (_event: any, itemId: string) =>
    runServiceMutation(async () => {
      const result = await uninstallMarketItem(app, itemId);
      if (result.ok) {
        onMarketCommandResult?.(result);
      }
      return result;
    }));
  ipcMain.handle("market.buildSandboxImage", async (_event: any, itemId: string) =>
    runServiceMutation(() => buildSandboxImage(app, itemId)));
  ipcMain.handle("market.deleteSandboxImage", async (_event: any, itemId: string) =>
    runServiceMutation(() => deleteSandboxImage(app, itemId)));

  ipcMain.handle("market.exportSandboxImage", async (_event: any, itemId: string) => runServiceMutation(async () => {
    const imageRef = String(itemId ?? "").trim();
    const saveResult = await showSaveDialog({
      title: t("dialog.exportSandboxImage.title"),
      defaultPath: getSandboxImageExportDefaultPath(app, platform, imageRef),
      filters: [{ name: t("dialog.exportSandboxImage.filter"), extensions: ["tar"] }]
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        itemId: imageRef,
        type: "sandbox-image",
        state: "failed",
        message: t("market.exportCancelled"),
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
      title: t("dialog.importSandboxImage.title"),
      properties: ["openFile"],
      filters: [
        {
          name: t("dialog.importSandboxImage.filter"),
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
        message: t("market.importCancelled")
      };
    }
    return importSandboxImageFromPath(app, result.filePaths[0], {
      taskId,
      onProgress: emitImportProgress
    });
  }));

  ipcMain.handle("market.importSkill", async () => runServiceMutation(async () => {
    const result = await showFileDialog({
      title: t("dialog.importSkill.title"),
      properties: ["openFile"],
      filters: [
        {
          name: "Skill",
          extensions: ["zip", "md"]
        }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        itemId: "",
        type: "skill",
        state: "failed",
        message: t("market.importCancelled")
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
}
