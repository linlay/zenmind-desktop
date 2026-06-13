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
    message: "已读取网站 / 应用。"
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
      title: "导入内嵌网站配置",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        items: listWebsiteItems(app).items,
        path: "",
        message: "已取消导入内嵌网站配置。"
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
      title: "导出内嵌网站配置",
      defaultPath: path.join(getDataRoot(app), "websites.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        items: listWebsiteItems(app).items,
        path: "",
        message: "已取消导出内嵌网站配置。"
      };
    }

    const filePath = saveResult.filePath;
    await fsWriteFile(filePath, `${exportWebsiteItems(app)}\n`, "utf8");
    return {
      ok: true,
      items: listWebsiteItems(app).items,
      path: filePath,
      message: "已导出内嵌网站配置。"
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
      message: state ? "已读取网站小应用状态。" : "未找到这个本地网站小应用。"
    };
  });
  ipcMain.handle("webs.webapps.readLog", async (_event: any, id: string, target: unknown, options?: WebappLogReadOptions) =>
    webappRuntime.readLog(app, id, normalizeLogTarget(target), options)
  );
}
