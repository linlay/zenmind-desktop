import type { App } from "electron";
import type { WebsiteLogReadOptions, WebsiteLogTarget } from "../../shared/contracts";
import { applyWebsiteOrder } from "../websites/website-order-store";
import { readWebsiteItems } from "../websites/website-store";
import { websiteAppRuntime } from "../websites/website-app-runtime";

export interface WebsiteIpcHandlerOptions {
  app: App;
}

function normalizeLogTarget(value: unknown): WebsiteLogTarget {
  return value === "error" ? "error" : "main";
}

export function listWebsiteEntries(app: App) {
  return {
    ok: true,
    items: applyWebsiteOrder(app, readWebsiteItems(app)),
    message: "已读取网站 / 应用。"
  };
}

export function registerWebsiteIpcHandlers(ipcMain: any, options: WebsiteIpcHandlerOptions) {
  const { app } = options;

  ipcMain.handle("websites.list", async () => listWebsiteEntries(app));
  ipcMain.handle("websites.start", async (_event: any, id: string) =>
    websiteAppRuntime.start(app, id)
  );
  ipcMain.handle("websites.stop", async (_event: any, id: string) =>
    websiteAppRuntime.stop(app, id)
  );
  ipcMain.handle("websites.restart", async (_event: any, id: string) =>
    websiteAppRuntime.restart(app, id)
  );
  ipcMain.handle("websites.getStatus", async (_event: any, id: string) => {
    const state = websiteAppRuntime.getStatus(app, id);
    return {
      ok: Boolean(state),
      state,
      message: state ? "已读取网站小应用状态。" : "未找到这个本地网站小应用。"
    };
  });
  ipcMain.handle("websites.readLog", async (_event: any, id: string, target: unknown, options?: WebsiteLogReadOptions) =>
    websiteAppRuntime.readLog(app, id, normalizeLogTarget(target), options)
  );
}
