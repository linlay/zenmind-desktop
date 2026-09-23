import type { IpcMain } from "electron";
import {
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_CLOSE_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_OPEN_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL,
  AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL,
} from "../../../shared/contracts";
import { registerConnectorAuthBrowser } from "./connector-auth-browser";
import { createSessionController } from "./frame-port/session-controller";
import { authorizeSurface } from "./frame-port/surface-authorization";
import type { FramePortOptions } from "./ipc.shared";

export function registerAgentWebclientBridgeIpcHandlers(ipcMain: IpcMain, options: FramePortOptions) {
  const controller = createSessionController(options);
  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_OPEN_CHANNEL, (event, input) => { void controller.handleOpen(event, input); });
  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL, (event, input) => { void controller.handleSend(event, input); });
  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_CLOSE_CHANNEL, controller.handleClose);
  ipcMain.handle(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL, controller.handleWorkPanelInvoke);
  registerConnectorAuthBrowser(ipcMain, {
    availability: controller.availability,
    getMainWebContents: options.getMainWebContents,
    subscribeLifecycle: listener => options.browserSurfaces.subscribeLifecycle(listener),
    authorize(sender) {
      const result = authorizeSurface(sender, options.browserSurfaces, options.isTrustedAgentWebclientSession);
      if (!("target" in result)) throw new Error("Untrusted authorization surface");
      return result;
    },
  });
  return { cleanupSender: controller.cleanupSender, getDiagnostics: controller.getDiagnostics };
}

export { readNormalizedStreamEvent, updateBindingFromFrame } from "./frame-port/query-binding";
export * from "./frame-port/surface-authorization";
export { normalizeDocumentWorkspacePath } from "./frame-port/workpanel-invoke";
export * from "./ipc.shared";
