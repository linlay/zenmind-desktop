import path from "node:path";
import type { App } from "electron";
import type { WebappLogReadOptions, WebappLogTarget } from "../../shared/contracts";
import {
  addWebsiteItem,
  exportWebsiteItems,
  importWebsiteItems,
  listWebsiteItems,
  removeWebsiteItem,
  updateWebsiteItem
} from "../webs/website-actions";
import { applyWebOrder } from "../webs/web-order-store";
import { readWebItems } from "../webs/web-store";
import { webappRuntime } from "../webs/webapp-runtime";
import { t } from "../i18n/main-i18n";

export interface WebIpcHandlerOptions {
  app: App;
  showFileDialog: (opts: any, owner?: any) => Promise<any>;
  showSaveDialog: (opts: any, owner?: any) => Promise<any>;
  getDataRoot: (app: App) => string;
  fsReadFile?: (filePath: string, encoding: string) => Promise<string>;
  fsWriteFile?: (filePath: string, content: string, encoding: string) => Promise<void>;
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
  ipcMain.handle("webs.webapps.readLog", async (_event: any, id: string, target: unknown, options?: WebappLogReadOptions) =>
    webappRuntime.readLog(app, id, normalizeLogTarget(target), options)
  );
}
