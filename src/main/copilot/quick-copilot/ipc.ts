import type { IpcMain } from "electron";
import type { QuickCopilotWindowController } from "./window";

export function registerQuickCopilotIpcHandlers(ipcMain: IpcMain, controller: QuickCopilotWindowController) {
  ipcMain.handle("quickAssistant.hide", async () => controller.hide());
  ipcMain.handle("quickAssistant.openControlCenter", async () => controller.openControlCenter());
}
