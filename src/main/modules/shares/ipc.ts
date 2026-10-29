import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { ShareFacade } from "./facade";

/** Only the current top-level Desktop renderer owns share management. */
export function registerSharesIpc(ipc: Pick<IpcMain, "handle">, shares: Pick<ShareFacade, "list" | "revoke">, getWindow: () => BrowserWindow | null) {
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed() &&
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  };
  const handle = (channel: string, run: (id: string) => Promise<unknown>) => ipc.handle(channel, async (event, id: string) => {
    if (!trusted(event)) throw new Error("Share IPC sender rejected");
    const frame = event.senderFrame;
    const result = await run(id);
    if (!trusted(event) || event.senderFrame !== frame) throw new Error("Share IPC sender changed");
    return result;
  });
  handle("shares.list", () => shares.list());
  handle("shares.revoke", (id) => shares.revoke(id));
}
