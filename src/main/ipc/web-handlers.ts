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
  listWebappItems,
  removeWebappItem,
  updateWebappItem
} from "../webs/webapps/actions";
import { applyWebOrder } from "../webs/order-store";
import { readWebItems } from "../webs/store";
import { webappRuntime } from "../webs/webapps/runtime";
import {
  readWebappRuntimeSettings,
  writeWebappRuntimeSettings
} from "../webs/webapps/runtime-settings";
import { resetWebappRuntimeProbeCaches } from "../webs/webapps/launchers";
import { getWebappPublishInfo, publishWebapp, unpublishWebapp } from "../webs/webapps/publisher";
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
  ipcMain.handle("webs.webapps.list", async () => listWebappItems(app));
  ipcMain.handle("webs.webapps.import", async () => {
    const result = await showFileDialog({
      title: t("dialog.importWebapp.title"),
      properties: ["openFile"],
      filters: [{ name: "WebApp Archive", extensions: ["zip", "tgz", "tar.gz"] }]
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
  ipcMain.handle("webs.webapps.update", async (_event: any, id: string, input: any) => {
    const result = updateWebappItem(app, id, input);
    if (result.ok) {
      options.emitWebappChanged?.("updated", id);
    }
    return result;
  });
  ipcMain.handle("webs.webapps.remove", async (_event: any, id: string) => {
    const result = await removeWebappItem(app, id);
    if (result.ok) {
      options.emitWebappChanged?.("removed", id, null);
    }
    return result;
  });
  ipcMain.handle("webs.webapps.stop", async (_event: any, id: string) =>
    webappRuntime.stop(app, id)
  );
  ipcMain.handle("webs.webapps.restart", async (_event: any, id: string) =>
    webappRuntime.restart(app, id)
  );
  ipcMain.handle("webs.webapps.getStatus", async (_event: any, id: string) => {
    const state = webappRuntime.getStatus(app, id);
    return {
      ok: Boolean(state),
      state,
      message: state ? t("webapp.stateRead") : t("webapp.notFound")
    };
  });
  ipcMain.handle("webs.webapps.checkPrerequisites", async (_event: any, id: string) =>
    webappRuntime.checkPrerequisites(app, id)
  );
  ipcMain.handle("webs.webapps.getRuntimeSettings", async () => ({
    ok: true,
    settings: readWebappRuntimeSettings(app),
    message: "WebApp runtime settings loaded."
  }));
  ipcMain.handle("webs.webapps.saveRuntimeSettings", async (_event: any, input: any) => {
    const settings = writeWebappRuntimeSettings(app, input && typeof input === "object" ? input : {});
    resetWebappRuntimeProbeCaches();
    return {
      ok: true,
      settings,
      message: "WebApp runtime settings saved."
    };
  });
  ipcMain.handle("webs.webapps.getPublishInfo", async (_event: any, id: string) =>
    getWebappPublishInfo(app, id)
  );
  ipcMain.handle("webs.webapps.publish", async (_event: any, id: string) => {
    const command = await webappRuntime.start(app, id);
    const result = await publishWebapp(app, id, command.state);
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
