import type { App } from "electron";
import { readHelpSettings } from "./help-settings";

export function registerHelpIpcHandlers(ipcMain: any, app: App) {
  ipcMain.handle("help.getSettings", async () => readHelpSettings(app));
}
