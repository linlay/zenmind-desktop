import path from "node:path";
import type { App, BrowserWindow, IpcMainInvokeEvent } from "electron";
import { ipcMain, powerMonitor } from "electron";
import { APP_BRAND } from "../../../shared/brand";
import { getDataRoot, getDesktopStateRoot } from "../../infrastructure/filesystem/user-paths";
import { readUpdateConfig } from "./config";
import { createUpdateRuntime } from "./runtime";
import { installMacUpdate, launchWindowsUpdate, verifyMacUpdateHost } from "./installer";

export function registerDesktopUpdates(options: {
  app: App;
  getMainWindow(): BrowserWindow | null;
  currentVersion: string;
  prepareInstall(): Promise<boolean>;
  quit(): void;
}) {
  const runtime = createUpdateRuntime({
    currentVersion: options.currentVersion, productId: APP_BRAND.id,
    platform: process.platform, arch: process.arch, packaged: options.app.isPackaged,
    cacheRoot: path.join(getDataRoot(options.app), "cache", "updates"),
    preferencesPath: path.join(getDesktopStateRoot(options.app), "update-preferences.json"),
    readConfig: () => readUpdateConfig(options.app),
    emit: (state) => { const window = options.getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send("updates.changed", state); },
    verifyPublisher: async () => {
      // Windows trust is enforced by signed metadata + SHA-256 in the runtime.
      if (process.platform === "win32") return;
      if (process.platform === "darwin" && options.app.isPackaged) await verifyMacUpdateHost(process.execPath);
      // macOS signature verification is owned by Squirrel.Mac when staging at install time.
    },
    prepareInstall: options.prepareInstall,
    install: async (file, version) => {
      if (process.platform === "darwin") await installMacUpdate(file, version);
      else if (process.platform === "win32") { await launchWindowsUpdate(file); options.quit(); }
      else throw new Error("Unsupported update platform");
    }
  });
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted update caller");
  };
  const handlers = {
    "updates.getState": () => runtime.getState(),
    "updates.check": () => runtime.check(),
    "updates.loadTest": (input: import("../../../shared/desktop-updates").DesktopTestUpdateInput) => runtime.loadTest(input),
    "updates.clearTest": () => runtime.clearTest(),
    "updates.download": () => runtime.download(),
    "updates.install": () => runtime.install(),
    "updates.setAutoDownload": (enabled: boolean) => runtime.setAutoDownload(enabled)
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, value) => { trusted(event); return (handler as (input: unknown) => unknown)(value); });
  }
  const resume = () => runtime.resume();
  powerMonitor.on("resume", resume);
  runtime.start();
  options.app.once("will-quit", () => {
    runtime.dispose(); powerMonitor.off("resume", resume);
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
  });
  return runtime;
}
