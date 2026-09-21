import type { MainIpcRegistrationOptions } from "./ipc-registration-contracts";
import { registerHelpIpcHandlers } from "../modules/settings";
import { registerShellWorkPanelIpc } from "./ipc-shell-workpanel";
import { registerAssistantRuntimeIpc } from "./ipc-assistant";
import { registerPlatformFrameIpc } from "./ipc-platform-frame";
import { registerServiceMarketIpc } from "./ipc-services-market";
import { registerConnectedRuntimeIpc } from "./ipc-connected-runtimes";

export function registerMainIpcHandlers(options: MainIpcRegistrationOptions) {
  registerShellWorkPanelIpc(options);
  registerAssistantRuntimeIpc(options);
  registerPlatformFrameIpc(options);
  registerHelpIpcHandlers(options.ipcMain, options.app);
  registerServiceMarketIpc(options);
  registerConnectedRuntimeIpc(options);
}
