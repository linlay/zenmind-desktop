import { registerArtifactActionIpc } from "../modules/artifacts";
import { callAgentPlatform } from "../modules/desktop-actions";
import { getTunnelHubRuntimeStatus } from "../modules/tunnel";
import { registerShellIpcHandlers } from "../modules/shell";
import { registerSidebarContextMenuIpcHandlers } from "../modules/web-surfaces";
import { registerChatWorkPanelTabContextMenuIpcHandlers } from "../modules/work-panel";
import { registerChatWorkPanelLocalFileIpcHandlers } from "../modules/work-panel";
import { registerChatWorkPanelDocumentHtmlIpcHandlers } from "../modules/work-panel";
import { registerChatWorkPanelResourceImageIpcHandlers } from "../modules/work-panel";
import { MainIpcRegistrationOptions, PLATFORM_DOCUMENT_REVISION_HEADER } from "./ipc-registration-contracts";

export function registerShellWorkPanelIpc(options: MainIpcRegistrationOptions) {
  const {
    app,
    ipcMain,
    assistantBridgeRuntime,
    logsRuntime,
  } = options;
  const services = options.servicesFacade;
  const { assistantBridge } = assistantBridgeRuntime;
  registerShellIpcHandlers(ipcMain, {
    platform: options.platform,
    app: app as any,
    mainWindow: options.getMainWindow(),
    getMainWindow: options.getMainWindow,
    showFileDialog: options.showFileDialog,
    revealPathInFileManager: options.revealPathInFileManager,
    captureDesktopScreenshot: options.captureDesktopScreenshotForWebview,
    reportRendererDiagnostic: options.reportRendererDiagnostic,
    openLogViewerWindow: options.openLogViewerWindow,
    issueAgentPlatformAccessToken: options.issueAgentAccessToken,
    desktopLogStreamSubscriptions: logsRuntime.getDesktopLogSubscriptions(),
    setGlobalSearchOverlayVisible: options.setGlobalSearchOverlayVisible,
    setWebviewModalOverlayVisible: options.setWebviewModalOverlayVisible,
    getTunnelHubRuntimeStatus,
    setWorkPanelFullscreenActive: options.setWorkPanelFullscreenActive
  });

  registerSidebarContextMenuIpcHandlers(ipcMain, {
    getMainWindow: options.getMainWindow
  });

  registerChatWorkPanelTabContextMenuIpcHandlers(ipcMain, {
    getMainWindow: options.getMainWindow,
    browserSurfaces: options.browserSurfaces,
    app,
    platform: options.platform,
  });

  registerChatWorkPanelLocalFileIpcHandlers(ipcMain, {
    getMainWindow: options.getMainWindow,
    getReviewPreloadUrl: () => options.getServiceWebviewPreloadUrl()
      .replace(/service-webview\.js$/u, "work-panel-preview.js"),
    showFileDialog: options.showFileDialog as any,
  });

  const fetchDocumentResource = async ({ chatId, relativePath }: { chatId: string; relativePath: string }) => {
    try {
      const state = await services.getServiceState(app, "agent-platform");
      const baseUrl = state.status === "running"
        ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
        : "";
      if (!baseUrl) return null;
      const tokenResult = await options.issueAgentAccessToken(app, "missing");
      if (!tokenResult.ok || !tokenResult.token.trim()) return null;
      const url = new URL("/api/resource", baseUrl);
      url.searchParams.set("file", `${chatId}/${relativePath}`);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${tokenResult.token.trim()}` } });
      if (!response.ok) return null;
      const declaredSize = Number(response.headers.get("content-length") || "0");
      if (declaredSize > 100 * 1024 * 1024) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 100 * 1024 * 1024) return null;
      return {
        bytes,
        mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "",
        revision: response.headers.get(PLATFORM_DOCUMENT_REVISION_HEADER)?.trim() || "",
      };
    } catch {
      return null;
    }
  };

  registerArtifactActionIpc(ipcMain, {
    getMainWindow: options.getMainWindow,
    getChatInfo: (chatId) => assistantBridge.getChatInfo(chatId),
    fetchResource: ({ chatId, relativePath }) => fetchDocumentResource({
      chatId, relativePath: relativePath.split("/").map(encodeURIComponent).join("/"),
    }),
    showSaveDialog: options.showSaveDialog,
  });

  registerChatWorkPanelDocumentHtmlIpcHandlers(ipcMain, {
    app,
    showSaveDialog: options.showSaveDialog,
    getMainWindow: options.getMainWindow,
    fetchRemoteResource: fetchDocumentResource,
    commitDocument: (payload) => callAgentPlatform(app, "/api/document/commit", {
      issueAgentAccessToken: options.issueAgentAccessToken,
      method: "POST",
      body: payload,
    }),
  });

  registerChatWorkPanelResourceImageIpcHandlers(ipcMain, {
    app,
    assistantBridge,
    getMainWindow: options.getMainWindow,
    showFileDialog: options.showFileDialog as any,
    showSaveDialog: options.showSaveDialog as any,
    fetchRemoteResource: fetchDocumentResource,
    commitResource: (payload) => callAgentPlatform(app, "/api/document/commit", {
      issueAgentAccessToken: options.issueAgentAccessToken,
      method: "POST",
      body: {
        operation: "document.commit",
        source: payload.profile === "workspace-file"
          ? { kind: "workspace-file", agentKey: payload.agentKey, path: payload.relativePath }
          : {
              kind: payload.profile,
              agentKey: payload.agentKey,
              chatId: payload.chatId,
              resourceId: payload.resourceId,
              relativePath: payload.relativePath,
            },
        mode: payload.mode,
        expectedRevision: payload.expectedRevision,
        payload: {
          kind: "document-image",
          mimeType: payload.mimeType,
          dataBase64: payload.dataBase64,
        },
      },
    }),
  });

}
