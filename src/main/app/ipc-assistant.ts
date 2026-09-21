import { getAgentPlatformMinimaxSettingsPublic } from "../modules/agent-platform";
import { getAssistantSettings, readAssistantSettings, saveAssistantSettings, toPublicAssistantSettings } from "../modules/assistant";
import {
  cancelAssistantAttachmentTask,
  createAssistantAttachmentFromPastedImage,
  createAssistantAttachmentsFromFiles,
  resolveAssistantAttachmentPath
} from "../modules/assistant";
import { callAgentPlatform, handleDesktopActionRequest } from "../modules/desktop-actions";
import { DESKTOP_ACTION_DEFINITIONS } from "../../shared/desktop-actions";
import { registerAssistantIpcHandlers } from "../modules/assistant";
import { registerEmbeddedCdpIpcHandlers } from "../modules/web-surfaces";
import { MainIpcRegistrationOptions } from "./ipc-registration-contracts";

export function registerAssistantRuntimeIpc(options: MainIpcRegistrationOptions) {
  const {
    app,
    ipcMain,
    assistantBridgeRuntime,
  } = options;
  const { assistantBridge, desktopActionOptions } = assistantBridgeRuntime;
  registerAssistantIpcHandlers(ipcMain, {
    assistantBridge,
    conversationShare: options.conversationShareFacade,
    assistantNavigationStatusClient: assistantBridgeRuntime.getNavigationStatusClient(),
    desktopActionRendererRequests: assistantBridgeRuntime.desktopActionRendererRequests,
    desktopActionConfirmationRequests: assistantBridgeRuntime.desktopActionConfirmationRequests,
    desktopActionOptions,
    app,
    mainWindow: options.getMainWindow(),
    shell: options.shell,
    platform: options.platform,
    getCurrentPageSnapshot: options.getCurrentPageSnapshot,
    setCurrentPageSnapshot: options.setCurrentPageSnapshot,
    getCopilotDevToolsTarget: options.getCopilotDevToolsTarget,
    setCopilotDevToolsTarget: options.setCopilotDevToolsTarget,
    getWebContentsById: options.getWebContentsById,
    reportRendererDiagnostic: options.reportRendererDiagnostic,
    showFileDialog: options.showFileDialog,
    callAgentPlatform: (targetApp, targetPath, requestOptions) => callAgentPlatform(targetApp, targetPath, {
      ...requestOptions,
      issueAgentAccessToken: options.issueAgentAccessToken
    }),
    handleDesktopActionRequest,
    DESKTOP_ACTION_DEFINITIONS,
    emitAssistantAttachmentProgress: options.emitAssistantAttachmentProgress,
    getAssistantSettings,
    saveAssistantSettings,
    getAgentPlatformMinimaxSettingsPublic: (targetApp) =>
      getAgentPlatformMinimaxSettingsPublic(targetApp, { readAssistantSettings, toPublicAssistantSettings }),
    resolveAssistantAttachmentPath,
    createAssistantAttachmentFromPastedImage,
    cancelAssistantAttachmentTask,
    createAssistantAttachmentsFromFiles,
    captureAssistantScreenshot: options.captureAssistantScreenshot as any,
    openDesktopActionWorkbenchWindow: options.openDesktopActionWorkbenchWindow,
    closeDesktopActionWorkbenchWindow: options.closeDesktopActionWorkbenchWindow,
    consumeFirstInstallBootstrapNavigation: options.consumeFirstInstallBootstrapNavigation
  });

  registerEmbeddedCdpIpcHandlers(ipcMain, options.browserSurfaces, {
    isMainWindow: (senderWebContentsId) => {
      const mainWindow = options.getMainWindow();
      return Boolean(mainWindow && !mainWindow.isDestroyed() &&
        !mainWindow.webContents.isDestroyed() && mainWindow.webContents.id === senderWebContentsId);
    },
  });

}
