import path from "node:path";
import type { App } from "electron";
import type {
  DesktopMobileWebappItem,
  DesktopWebappChangedReason,
  WebappLogReadOptions,
  WebappLogTarget
} from "../../shared/contracts";
import {
  addWebsiteItem,
  exportWebsiteItems,
  importWebsiteItems,
  listWebsiteItems,
  removeWebsiteItem,
  updateWebsiteItem
} from "../webs/websites/actions";
import { cacheWebsiteFavicon } from "../webs/websites/favicon-cache";
import {
  exportWebappArchive,
  listWebappItems,
  removeWebappItem,
  updateWebappItem
} from "../webs/webapps/actions";
import { applyWebOrder } from "../webs/order-store";
import { readWebItems } from "../webs/store";
import { webappRuntime } from "../webs/webapps/runtime";
import { webappWindowManager } from "../webs/webapps/window-manager";
import {
  readWebappRuntimeSettings,
  writeWebappRuntimeSettings
} from "../webs/webapps/runtime-settings";
import { resetWebappRuntimeProbeCaches } from "../webs/webapps/launchers";
import { getWebappPublishStatus, publishWebapp, unpublishWebapp } from "../webs/webapps/publisher";
import { installWebsiteAppArchiveFromPath } from "../marketplace/website-app-market";
import { t } from "../i18n/main-i18n";

export interface WebIpcHandlerOptions {
  app: App;
  showFileDialog: (opts: any, owner?: any) => Promise<any>;
  showSaveDialog: (opts: any, owner?: any) => Promise<any>;
  getDataRoot: (app: App) => string;
  fsReadFile?: (filePath: string, encoding: string) => Promise<string>;
  fsWriteFile?: (filePath: string, content: string, encoding: string) => Promise<void>;
  emitWebappChanged?: (
    reason: DesktopWebappChangedReason,
    webappId: string,
    item?: DesktopMobileWebappItem | null
  ) => void;
  openWebappWindow?: (
    app: App,
    id: string,
    sender?: any
  ) => ReturnType<typeof webappWindowManager.open>;
}

function normalizeLogTarget(value: unknown): WebappLogTarget {
  return value === "error" ? "error" : "main";
}

export function listWebEntries(app: App) {
  return {
    ok: true,
    items: applyWebOrder(app, readWebItems(app)),
    message: t("website.configRead")
  };
}

export function registerWebIpcHandlers(ipcMain: any, options: WebIpcHandlerOptions) {
  const {
    app,
    showFileDialog,
    showSaveDialog,
    getDataRoot
  } = options;
  const fsReadFile = options.fsReadFile ?? (async (filePath: string, encoding: string) => {
    const fs = await import("node:fs");
    return fs.promises.readFile(filePath, encoding as any) as unknown as string;
  });
  const fsWriteFile = options.fsWriteFile ?? (async (filePath: string, content: string, encoding: string) => {
    const fs = await import("node:fs");
    await fs.promises.writeFile(filePath, content, encoding as any);
  });

  ipcMain.handle("webs.list", async () => listWebEntries(app));

  ipcMain.handle("webs.websites.list", async () => listWebsiteItems(app));
  ipcMain.handle("webs.websites.add", async (_event: any, input: any) =>
    addWebsiteItem(app, input)
  );
  ipcMain.handle("webs.websites.update", async (_event: any, id: string, input: any) =>
    updateWebsiteItem(app, id, input)
  );
  ipcMain.handle("webs.websites.remove", async (_event: any, id: string) =>
    removeWebsiteItem(app, id)
  );
  ipcMain.handle("webs.websites.cacheFavicon", async (_event: any, input: any) =>
    cacheWebsiteFavicon(app, input)
  );
  ipcMain.handle("webs.websites.import", async () => {
    const result = await showFileDialog({
      title: t("dialog.importEmbeddedWebsites.title"),
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        items: listWebsiteItems(app).items,
        path: "",
        message: t("website.importCancelled")
      };
    }

    const importPath = result.filePaths[0];
    const fileContent = await fsReadFile(importPath, "utf8");
    const importResult = importWebsiteItems(app, fileContent);
    return {
      ...importResult,
      path: importPath
    };
  });
  ipcMain.handle("webs.websites.export", async () => {
    const saveResult = await showSaveDialog({
      title: t("dialog.exportEmbeddedWebsites.title"),
      defaultPath: path.join(getDataRoot(app), "websites.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        items: listWebsiteItems(app).items,
        path: "",
        message: t("website.exportCancelled")
      };
    }

    const filePath = saveResult.filePath;
    await fsWriteFile(filePath, `${exportWebsiteItems(app)}\n`, "utf8");
    return {
      ok: true,
      items: listWebsiteItems(app).items,
      path: filePath,
      message: t("website.exported")
    };
  });

  ipcMain.handle("webs.webapps.start", async (_event: any, id: string) =>
    webappRuntime.start(app, id)
  );
  ipcMain.handle("webs.webapps.openWindow", async (event: any, id: string) =>
    (options.openWebappWindow ?? ((targetApp, webappId, sender) =>
      webappWindowManager.open(targetApp, webappId, sender)))(app, id, event?.sender)
  );
  ipcMain.handle("webs.webapps.list", async () => listWebappItems(app));
  ipcMain.handle("webs.webapps.import", async () => {
    const result = await showFileDialog({
      title: t("dialog.importWebapp.title"),
      properties: ["openFile"],
      filters: [{ name: t("webapp.archiveFilter"), extensions: ["zip", "tgz", "tar.gz"] }]
    });

    const currentItems = listWebEntries(app).items;
    const previousWebappIds = new Set(
      currentItems.filter((item) => item.kind === "webapp").map((item) => item.id)
    );
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        item: null,
        items: currentItems,
        path: "",
        message: t("webapp.importCancelled")
      };
    }

    const importPath = result.filePaths[0];
    try {
      const installResult = await installWebsiteAppArchiveFromPath(app, importPath, {
        source: "local"
      });
      const nextItems = listWebEntries(app).items;
      const item = nextItems.find((candidate) =>
        candidate.kind === "webapp" && candidate.id === installResult.itemId
      ) ?? null;
      if (installResult.ok && item?.kind === "webapp") {
        options.emitWebappChanged?.(previousWebappIds.has(item.id) ? "updated" : "installed", item.id);
      }
      return {
        ok: installResult.ok,
        item,
        items: nextItems,
        path: importPath,
        message: installResult.message,
        ...(installResult.installPath ? { installPath: installResult.installPath } : {})
      };
    } catch (error) {
      return {
        ok: false,
        item: null,
        items: listWebEntries(app).items,
        path: importPath,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });
  ipcMain.handle("webs.webapps.export", async (_event: any, id: string) => {
    const item = listWebappItems(app).items.find((candidate) => candidate.id === id) ?? null;
    if (!item) {
      return {
        ok: false,
        item: null,
        path: "",
        message: t("webapp.notFound")
      };
    }

    const saveResult = await showSaveDialog({
      title: t("dialog.exportWebapp.title"),
      defaultPath: path.join(app.getPath("desktop"), `${item.id}-${item.version}.zip`),
      filters: [{ name: t("webapp.archiveFilter"), extensions: ["zip"] }]
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        item,
        path: "",
        message: t("webapp.exportCancelled")
      };
    }
    return exportWebappArchive(app, item.id, saveResult.filePath);
  });
  ipcMain.handle("webs.webapps.update", async (_event: any, id: string, input: any) => {
    const result = updateWebappItem(app, id, input);
    if (result.ok) {
      if (input?.openMode === "workspace") {
        webappWindowManager.close(id);
      }
      options.emitWebappChanged?.("updated", id);
    }
    return result;
  });
  ipcMain.handle("webs.webapps.uninstall", async (_event: any, id: string) => {
    const result = await removeWebappItem(app, id);
    if (result.ok) {
      webappWindowManager.close(id);
    }
    return result;
  });
  ipcMain.handle("webs.webapps.stop", async (_event: any, id: string) => {
    webappWindowManager.close(id);
    return webappRuntime.stop(app, id);
  });
  ipcMain.handle("webs.webapps.restart", async (_event: any, id: string) => {
    const result = await webappRuntime.restart(app, id);
    if (result.ok && result.state?.webUrl) {
      await webappWindowManager.reload(id, result.state);
    } else {
      webappWindowManager.close(id);
    }
    return result;
  });
  ipcMain.handle("webs.webapps.getStatus", async (_event: any, id: string) => {
    const state = webappRuntime.getStatus(app, id);
    return {
      ok: Boolean(state),
      state,
      message: state ? t("webapp.stateRead") : t("webapp.notFound")
    };
  });
  ipcMain.handle("webs.webapps.checkRuntime", async (_event: any, id: string) =>
    webappRuntime.checkRuntime(app, id)
  );
  ipcMain.handle("webs.webapps.getRuntimeSettings", async () => ({
    ok: true,
    settings: readWebappRuntimeSettings(app),
    message: t("webapp.runtimeSettingsLoaded")
  }));
  ipcMain.handle("webs.webapps.saveRuntimeSettings", async (_event: any, input: any) => {
    const settings = writeWebappRuntimeSettings(app, input && typeof input === "object" ? input : {});
    resetWebappRuntimeProbeCaches();
    return {
      ok: true,
      settings,
      message: t("webapp.runtimeSettingsSaved")
    };
  });
  ipcMain.handle("webs.webapps.getPublishStatus", async (_event: any, id: string) =>
    getWebappPublishStatus(app, id)
  );
  ipcMain.handle("webs.webapps.publish", async (_event: any, id: string) => {
    const result = await publishWebapp(app, id, webappRuntime.getStatus(app, id));
    options.emitWebappChanged?.(result.ok ? "published" : "publish-failed", id);
    return result;
  });
  ipcMain.handle("webs.webapps.unpublish", async (_event: any, id: string) => {
    const result = await unpublishWebapp(app, id);
    options.emitWebappChanged?.(result.ok ? "unpublished" : "publish-failed", id);
    return result;
  });
  ipcMain.handle("webs.webapps.readLog", async (_event: any, id: string, target: unknown, options?: WebappLogReadOptions) =>
    webappRuntime.readLog(app, id, normalizeLogTarget(target), options)
  );
}
