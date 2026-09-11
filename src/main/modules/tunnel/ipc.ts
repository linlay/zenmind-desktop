import type { ServiceLogReadOptions } from "../../../shared/contracts";
import {
  getTunnelHubRuntimeStatus,
  readTunnelHubRuntimeLog,
  restartTunnelHubRuntime,
  startTunnelHubRuntime,
  stopTunnelHubRuntime
} from "./runtime";

export function registerTunnelHubIpcHandlers(ipcMain: any) {
  ipcMain.handle("tunnelHub.getStatus", async () => getTunnelHubRuntimeStatus());
  ipcMain.handle("tunnelHub.start", async () => startTunnelHubRuntime());
  ipcMain.handle("tunnelHub.stop", async () => stopTunnelHubRuntime());
  ipcMain.handle("tunnelHub.restart", async () => restartTunnelHubRuntime());
  ipcMain.handle("tunnelHub.readLog", async (_event: any, options?: ServiceLogReadOptions) =>
    readTunnelHubRuntimeLog(options)
  );
}
