import type { App, WebContents } from "electron";
import path from "node:path";
import type { MarketListResult } from "../../shared/contracts";
import { createAppPairingPayload } from "../app-pairing";
import { issueAgentAccessToken } from "../agent-auth";
import {
  cancelDesktopSsoLogin,
  failDesktopSsoFlow,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  logoutDesktopSso,
  startDesktopSsoLogin
} from "../oidc-sso";
import { loadBuiltinServices } from "../builtin-loader";
import {
  getServiceLogsMeta,
  readServiceLog,
  watchServiceLog,
  getServiceState,
  getResponsiveServiceState,
  initializeService,
  importEnvZipIntoExistingRuntime,
  importServiceFile,
  installBuiltinService,
  listServices,
  readServiceConfig,
  restartService,
  runStartupPreparation,
  startService,
  stopService,
  writeServiceConfig
} from "../services/manager";
import { loadInstalledPlugins, installPluginFromArchive } from "../plugin-loader";
import { handlePluginUninstall } from "../plugin-uninstall";
import {
  buildSandboxImage,
  deleteSandboxImage,
  exportSandboxImageToPath,
  getMarketSettings,
  importSandboxImageFromPath,
  importSkillFromCommand,
  importSkillFromPath,
  installMarketItem,
  listMarketItems,
  mergeMcpRuntimeStatuses,
  refreshMarketCatalog,
  saveMarketSettings,
  toggleMarketFavorite,
  uninstallMarketItem,
  updateMarketItem
} from "../marketplace";
import { getAgentPlatformMinimaxSettingsPublic } from "../assistant/core/agent-platform-config";
import {
  getAssistantSettings,
  saveAssistantSettings
} from "../assistant/core/settings-store";
import {
  cancelAssistantAttachmentTask,
  createAssistantAttachmentFromPastedImage,
  createAssistantAttachmentsFromFiles,
  resolveAssistantAttachmentPath
} from "../assistant/attachments/attachment-store";
import {
  callAgentPlatform,
  handleAgentWebclientWorkPanelActionRequest,
  handleDesktopActionRequest
} from "../desktop-action-bridge";
import { applyDesktopInitBootstrap } from "../desktop-init-bootstrap";
import {
  generateBackupDirName,
  importEnvZipToRuntime,
  migrateOldRootToBackup,
  resetBundledRuntimeEnv,
  runtimeEnvExists,
  shouldPromptEnvRootConflict
} from "../env-bootstrap";
import { getDataRoot } from "../user-paths";
import {
  openPluginSettingsPage,
  readPluginSettingsSnapshot,
  writePluginSettingsValues
} from "../plugin-settings";
import { t, initializeMainI18n, setMainLocale } from "../i18n/main-i18n";
import { isSupportedLocale } from "../../shared/i18n";
import { DESKTOP_ACTION_DEFINITIONS } from "../../shared/desktop-actions";
import { applyTunnelHubSettings, getTunnelHubRuntimeStatus, stopTunnelHubRuntime } from "../tunnel-hub-runtime";
import {
  createAssistantIpcHandlerOptions,
  createDesktopPetIpcHandlerOptions,
  createMarketplaceIpcHandlerOptions,
  createServicesIpcHandlerOptions,
  createSettingsIpcHandlerOptions,
  createShellIpcHandlerOptions,
  createSsoIpcHandlerOptions,
  createKanbanIpcHandlerOptions,
  type MainProcessContext
} from "../main-process-context";
import type { AssistantBridgeRuntime } from "../bridge/assistant-runtime";
import type { AssistantRunWakeLock } from "../bridge/assistant-wake-lock";
import type { DesktopPetRuntime } from "../assistant/pet/runtime";
import type { LogsRuntime } from "../logs/runtime";
import { registerAssistantIpcHandlers } from "./assistant-handlers";
import { registerDesktopPetIpcHandlers } from "./desktop-pet-handlers";
import { registerMarketplaceIpcHandlers } from "./marketplace-handlers";
import { registerServicesIpcHandlers } from "./services-handlers";
import { registerSettingsIpcHandlers } from "./settings-handlers";
import { registerShellIpcHandlers } from "./shell-handlers";
import { registerSsoIpcHandlers } from "./sso-handlers";
import { registerKanbanIpcHandlers } from "./kanban-handlers";
import { registerTunnelHubIpcHandlers } from "./tunnel-hub-handlers";
import { registerWebIpcHandlers } from "./web-handlers";
import { registerEmbeddedCdpIpcHandlers } from "./embedded-cdp-handlers";
import { registerAgentWebclientBridgeIpcHandlers } from "./agent-webclient-bridge-handlers";
import { registerCanonicalChatSyncIpc } from "./canonical-chat-sync";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";
import type { EnterpriseChatRuntime } from "../enterprise-chat-runtime";
import { registerEnterpriseChatIpcHandlers } from "./enterprise-chat-handlers";
import { registerHelpIpcHandlers } from "./help-handlers";
import { registerSidebarContextMenuIpcHandlers } from "./sidebar-context-menu-handlers";
import { registerChatWorkPanelTabContextMenuIpcHandlers } from "./chat-work-panel-tab-context-menu-handlers";
import {
  registerChatWorkPanelLocalFileIpcHandlers,
  resolveWorkPanelLocalFileFromWorkspace,
} from "../chat-work-panel-local-files";
import {
  registerChatWorkPanelDocumentHtmlIpcHandlers,
  workPanelDocumentHtmlRegistry,
} from "../chat-work-panel-document-html";
import {
  registerChatWorkPanelResourceImageIpcHandlers,
  workPanelResourceImageRegistry,
} from "../chat-work-panel-resource-images";
import { requireEpochMillis } from "../../shared/time-contract";
import type { AgentRealtimeDebugTarget } from "../../shared/contracts";

export type MainIpcRegistrationOptions = {
  app: App;
  ipcMain: any;
  context: MainProcessContext;
  assistantBridgeRuntime: AssistantBridgeRuntime;
  assistantRunWakeLock: AssistantRunWakeLock;
  logsRuntime: LogsRuntime;
  petRuntime: DesktopPetRuntime;
  browserSurfaces: BrowserSurfaceRegistry;
  isTrustedAgentWebclientSession: (sender: WebContents) => boolean;
  enterpriseChatRuntime: EnterpriseChatRuntime;
  desktopSsoController: any;
  startupRestoreController: any;
  desktopAppInfo: any;
  oldRootDecisionRef: { current: "migrate" | "keep" | "cancel" | undefined };
  isFirstDesktopInstall: boolean;
  bundledEnvZipExistsAtStartup: boolean;
  runtimeRootExistedAtStartup: boolean;
  runtimeRootAtProcessStart: string;
  showFileDialog: (...args: any[]) => unknown;
  showSaveDialog: (...args: any[]) => unknown;
  showMessageBox: (...args: any[]) => unknown;
  showArchiveDialog: (...args: any[]) => unknown;
  openLogViewerWindow: (...args: any[]) => unknown;
  closeLogViewerWindow: (...args: any[]) => unknown;
  minimizeLogViewerWindow: (...args: any[]) => unknown;
  maximizeLogViewerWindow: (...args: any[]) => unknown;
  openAgentPlatformMonitorWindow: (...args: any[]) => unknown;
  openAgentRealtimeInspectorWindow: (...args: any[]) => unknown;
  openDesktopActionWorkbenchWindow: (...args: any[]) => unknown;
  closeDesktopActionWorkbenchWindow: (...args: any[]) => unknown;
  revealPathInFileManager: (...args: any[]) => unknown;
  getServiceWebviewPreloadPath: () => string;
  getServiceWebviewPreloadUrl: () => string;
  runServiceMutation: <T>(task: () => Promise<T>) => Promise<T>;
  handleServiceStart: (serviceId: any) => Promise<any>;
  refreshPluginDesktopGlobalShortcuts: () => unknown;
  notifyServicesChanged: () => void;
  onStartupPreparationSucceeded: () => void;
  onStartupPreparationBlocked: () => void;
  refreshDesktopRuntimeConfigFromCanonicalFiles: (reason: string) => void;
  buildApplicationMenu: () => void;
  refreshTrayContextMenu: () => void;
  refreshMainWindowAppearance: () => void;
  setGlobalSearchOverlayVisible: (visible: boolean) => void;
  setWebviewModalOverlayVisible: (sourceId: string, visible: boolean) => void;
  emitLocaleChanged: (...args: any[]) => unknown;
  captureDesktopScreenshotForWebview: () => unknown;
  reportRendererDiagnostic: (...args: any[]) => unknown;
  emitAssistantAttachmentProgress: (...args: any[]) => unknown;
  captureAssistantScreenshot: (...args: any[]) => unknown;
  consumeFirstInstallBootstrapNavigation: () => { shouldOpen: boolean };
};

function sanitizeRealtimeDiagnosticUrl(value: string) {
  const normalized = value.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "file:") return "file:///(redacted)";
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return `${parsed.protocol}(redacted)`;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().slice(0, 512);
  } catch {
    return normalized.split(/[?#]/u, 1)[0].slice(0, 512);
  }
}

function createAgentRealtimeRuntimeDiagnostics(
  app: App,
  browserSurfaces: BrowserSurfaceRegistry,
) {
  const webContentsSnapshots = browserSurfaces.listWebContentsDiagnostics();
  const webContentsById = new Map(webContentsSnapshots.map((contents) => [contents.webContentsId, contents]));
  const claimedWebContentsIds = new Set<number>();
  const surfaces = browserSurfaces.listDiagnosticSurfaces();
  const targets: AgentRealtimeDebugTarget[] = surfaces.flatMap((surface): AgentRealtimeDebugTarget[] => {
    if (surface.tabs.length === 0) {
      return [{
        targetId: `surface:${surface.registrationId}`,
        surfaceId: surface.surfaceId,
        registrationId: surface.registrationId,
        label: surface.label,
        surfaceKind: surface.surfaceKind,
        surfaceType: surface.surfaceType,
        surfaceRole: surface.surfaceRole,
        surfaceLevel: surface.surfaceLevel,
        ...(surface.parentSurfaceId ? { parentSurfaceId: surface.parentSurfaceId } : {}),
        interaction: surface.interaction,
        ...(surface.ownerChatId ? { ownerChatId: surface.ownerChatId } : {}),
        ownerWebContentsId: surface.ownerWebContentsId,
        url: sanitizeRealtimeDiagnosticUrl(surface.pageRoute || surface.url),
        title: surface.label,
        active: surface.active,
        loading: false,
        crashed: false,
        devToolsOpened: false,
        backgroundThrottling: true,
        orphaned: false,
      }];
    }
    return surface.tabs.map((tab) => {
      claimedWebContentsIds.add(tab.webContentsId);
      const contents = webContentsById.get(tab.webContentsId);
      return {
        targetId: `surface:${surface.registrationId}:${tab.tabId}`,
        surfaceId: surface.surfaceId,
        registrationId: surface.registrationId,
        label: surface.tabs.length > 1 ? tab.title || surface.label : surface.label,
        surfaceKind: surface.surfaceKind,
        surfaceType: surface.surfaceType,
        surfaceRole: surface.surfaceRole,
        surfaceLevel: surface.surfaceLevel,
        ...(surface.parentSurfaceId ? { parentSurfaceId: surface.parentSurfaceId } : {}),
        interaction: surface.interaction,
        ...(surface.ownerChatId ? { ownerChatId: surface.ownerChatId } : {}),
        ownerWebContentsId: surface.ownerWebContentsId,
        webContentsId: tab.webContentsId,
        ...(contents ? { webContentsType: contents.type, pid: contents.osProcessId } : {}),
        url: sanitizeRealtimeDiagnosticUrl(tab.currentUrl || surface.pageRoute || surface.url),
        title: tab.title || surface.label,
        active: surface.active && surface.activeTabId === tab.tabId,
        loading: contents?.loading ?? tab.isLoading,
        crashed: contents?.crashed ?? false,
        devToolsOpened: contents?.devToolsOpened ?? false,
        backgroundThrottling: contents?.backgroundThrottling ?? true,
        orphaned: false,
      };
    });
  });
  for (const contents of webContentsSnapshots) {
    if (claimedWebContentsIds.has(contents.webContentsId)) continue;
    const orphaned = contents.type === "webview";
    targets.push({
      targetId: `webcontents:${contents.webContentsId}`,
      label: contents.title || `${contents.type} ${contents.webContentsId}`,
      webContentsId: contents.webContentsId,
      webContentsType: contents.type,
      pid: contents.osProcessId,
      url: sanitizeRealtimeDiagnosticUrl(contents.url),
      title: contents.title,
      active: false,
      loading: contents.loading,
      crashed: contents.crashed,
      devToolsOpened: contents.devToolsOpened,
      backgroundThrottling: contents.backgroundThrottling,
      orphaned,
    });
  }
  const targetCountByPid = new Map<number, number>();
  for (const target of targets) {
    if (typeof target.pid !== "number" || target.pid <= 0) continue;
    targetCountByPid.set(target.pid, (targetCountByPid.get(target.pid) || 0) + 1);
  }
  const processes = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    ...(metric.name ? { name: metric.name } : {}),
    ...(metric.serviceName ? { serviceName: metric.serviceName } : {}),
    cpuPercent: metric.cpu.percentCPUUsage,
    creationTime: metric.creationTime,
    ...(typeof metric.sandboxed === "boolean" ? { sandboxed: metric.sandboxed } : {}),
    workingSetBytes: metric.memory.workingSetSize * 1024,
    peakWorkingSetBytes: metric.memory.peakWorkingSetSize * 1024,
    ...(typeof metric.memory.privateBytes === "number"
      ? { privateBytes: metric.memory.privateBytes * 1024 }
      : {}),
    targetCount: targetCountByPid.get(metric.pid) || 0,
  }));
  return {
    surfaceCount: new Set(surfaces.map((surface) => surface.surfaceId)).size,
    webviewCount: webContentsSnapshots.filter((contents) => contents.type === "webview").length,
    orphanWebviewCount: targets.filter((target) => target.orphaned).length,
    totalWorkingSetBytes: processes.reduce((total, item) => total + item.workingSetBytes, 0),
    processes,
    targets,
  };
}

export function registerMainIpcHandlers(options: MainIpcRegistrationOptions) {
  const {
    app,
    ipcMain,
    context,
    assistantBridgeRuntime,
    assistantRunWakeLock,
    logsRuntime,
    petRuntime
  } = options;
  const state = context.state;
  const { assistantBridge, desktopActionOptions } = assistantBridgeRuntime;
  async function mergeMarketMcpStatuses(result: MarketListResult): Promise<MarketListResult> {
    if (!result.items.some((item) => item.type === "mcp" && item.installPath)) {
      return result;
    }
    try {
      return {
        ...result,
        items: mergeMcpRuntimeStatuses(result.items, await assistantBridge.listMcpRuntimeStatuses())
      };
    } catch {
      return {
        ...result,
        items: result.items.map((item) => item.type === "mcp" && item.installPath
          ? {
            ...item,
            mcpRuntimeStatus: "unavailable" as const,
            mcpRuntimeMessage: t("market.main.platformMcpStatusUnavailable")
          }
          : item)
      };
    }
  }

  registerShellIpcHandlers(ipcMain, createShellIpcHandlerOptions(context, {
    showFileDialog: options.showFileDialog,
    revealPathInFileManager: options.revealPathInFileManager,
    captureDesktopScreenshot: options.captureDesktopScreenshotForWebview,
    reportRendererDiagnostic: options.reportRendererDiagnostic,
    openLogViewerWindow: options.openLogViewerWindow,
    issueAgentPlatformAccessToken: issueAgentAccessToken,
    desktopLogStreamSubscriptions: logsRuntime.getDesktopLogSubscriptions(),
    setGlobalSearchOverlayVisible: options.setGlobalSearchOverlayVisible,
    setWebviewModalOverlayVisible: options.setWebviewModalOverlayVisible,
    setWorkPanelKeyboardFocusActive: (active) => {
      context.state.workPanelKeyboardFocusActive = active;
    },
    setWorkPanelFullscreenActive: (active) => {
      context.state.workPanelFullscreenActive = active;
    }
  }));
  registerSidebarContextMenuIpcHandlers(ipcMain, {
    getMainWindow: () => context.state.mainWindow
  });
  registerChatWorkPanelTabContextMenuIpcHandlers(ipcMain, {
    getMainWindow: () => context.state.mainWindow,
    app,
    platform: context.platform,
  });
  registerChatWorkPanelLocalFileIpcHandlers(ipcMain, {
    getMainWindow: () => context.state.mainWindow,
    getReviewPreloadUrl: () => options.getServiceWebviewPreloadUrl()
      .replace(/service-webview\.js$/u, "work-panel-preview.js"),
    showFileDialog: options.showFileDialog as any,
  });
  const fetchDocumentResource = async ({ chatId, relativePath }: { chatId: string; relativePath: string }) => {
    try {
      const state = await getServiceState(app, "agent-platform");
      const baseUrl = state.status === "running"
        ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
        : "";
      if (!baseUrl) return null;
      const tokenResult = await issueAgentAccessToken(app, "missing");
      if (!tokenResult.ok || !tokenResult.token.trim()) return null;
      const url = new URL("/api/resource", baseUrl);
      url.searchParams.set("file", `${chatId}/${relativePath}`);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${tokenResult.token.trim()}` } });
      if (!response.ok) return null;
      const declaredSize = Number(response.headers.get("content-length") || "0");
      if (declaredSize > 100 * 1024 * 1024) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 100 * 1024 * 1024) return null;
      return {
        bytes,
        mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "",
        revision: response.headers.get("x-zenmind-resource-revision")?.trim() || "",
      };
    } catch {
      return null;
    }
  };
  registerChatWorkPanelDocumentHtmlIpcHandlers(ipcMain, {
    app,
    getMainWindow: () => context.state.mainWindow,
    fetchRemoteResource: fetchDocumentResource,
    commitDocument: (payload) => callAgentPlatform(app, "/api/document/commit", {
      method: "POST",
      body: payload,
    }),
  });
  registerChatWorkPanelResourceImageIpcHandlers(ipcMain, {
    app,
    assistantBridge,
    getMainWindow: () => context.state.mainWindow,
    showFileDialog: options.showFileDialog as any,
    showSaveDialog: options.showSaveDialog as any,
    fetchRemoteResource: fetchDocumentResource,
    commitResource: (payload) => callAgentPlatform(app, "/api/document/commit", {
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

  registerAssistantIpcHandlers(ipcMain, createAssistantIpcHandlerOptions(context, {
    assistantBridge,
    desktopActionOptions,
    reportRendererDiagnostic: options.reportRendererDiagnostic,
    showFileDialog: options.showFileDialog,
    callAgentPlatform,
    handleDesktopActionRequest,
    DESKTOP_ACTION_DEFINITIONS,
    emitAssistantAttachmentProgress: options.emitAssistantAttachmentProgress,
    getAssistantSettings,
    saveAssistantSettings,
    getAgentPlatformMinimaxSettingsPublic,
    resolveAssistantAttachmentPath,
    createAssistantAttachmentFromPastedImage,
    cancelAssistantAttachmentTask,
    createAssistantAttachmentsFromFiles,
    captureAssistantScreenshot: options.captureAssistantScreenshot as any,
    openDesktopActionWorkbenchWindow: options.openDesktopActionWorkbenchWindow,
    closeDesktopActionWorkbenchWindow: options.closeDesktopActionWorkbenchWindow,
    consumeFirstInstallBootstrapNavigation: options.consumeFirstInstallBootstrapNavigation
  }));

  registerEmbeddedCdpIpcHandlers(ipcMain, options.browserSurfaces);
  const canonicalChatSync = registerCanonicalChatSyncIpc(ipcMain, {
    resolveRenderer: (ownerWebContentsId) => {
      const mainWindow = context.state.mainWindow;
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        mainWindow.webContents.isDestroyed() ||
        mainWindow.webContents.id !== ownerWebContentsId
      ) {
        return null;
      }
      return mainWindow.webContents;
    },
  });
  const agentWebclientBridgeRuntime = registerAgentWebclientBridgeIpcHandlers(ipcMain, {
    app,
    browserSurfaces: options.browserSurfaces,
    isTrustedAgentWebclientSession: options.isTrustedAgentWebclientSession,
    realtimeBroker: assistantBridgeRuntime.realtimeBroker,
    getServiceState,
    issueAccessToken: issueAgentAccessToken,
    syncCanonicalChat: (ownerWebContentsId, input) =>
      canonicalChatSync.request(ownerWebContentsId, input),
    dispatchWorkPanel: async ({ action, ownerChatId, args }) => {
      const response = await handleAgentWebclientWorkPanelActionRequest(desktopActionOptions, {
        requestId: `workpanel-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        action,
        ownerChatId,
        args,
      });
      if (response.ok) {
        return response.result as any;
      }
      return {
        ok: false,
        error: {
          code: (response.error?.code || "target_unavailable") as any,
          message: response.error?.message || "WorkPanel renderer is unavailable"
        }
      };
    },
    openResource: async ({ ownerChatId, resource }) => {
      const mainWindow = context.state.mainWindow;
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return { ok: false, error: { code: "target_unavailable", message: "WorkPanel renderer is unavailable" } };
      }
      const prepared = await workPanelResourceImageRegistry.prepareClaim({
        ownerChatId,
        rendererWebContentsId: mainWindow.webContents.id,
        ...resource,
      });
      if (!prepared.ok) {
        return { ok: false, error: { code: prepared.code, message: prepared.message } };
      }
      try {
        const response = await desktopActionOptions.callRendererAction({
          requestId: `workpanel-native-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          action: "desktop.workpanel.openResourceImage",
          args: {
            claimId: prepared.claimId,
            ...(resource.title ? { title: resource.title } : {}),
          },
          source: { chatId: ownerChatId, agentKey: resource.agentKey },
        });
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: (response.error?.code || "target_unavailable") as any,
              message: response.error?.message || "WorkPanel renderer is unavailable",
            },
          };
        }
        const result = response.result as { workspaceId?: unknown; item?: { itemId?: unknown } } | undefined;
        const workspaceId = typeof result?.workspaceId === "string" ? result.workspaceId : "";
        const itemId = typeof result?.item?.itemId === "string" ? result.item.itemId : "";
        return workspaceId && itemId
          ? { ok: true, workspaceId, itemId, renderer: "native-image" as const }
          : { ok: false, error: { code: "protocol_error", message: "Native image host returned an invalid result" } };
      } finally {
        workPanelResourceImageRegistry.discardPreparedClaim(prepared.claimId);
      }
    },
    openDocument: async ({ ownerChatId, document }) => {
      const mainWindow = context.state.mainWindow;
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return { ok: false, error: { code: "target_unavailable", message: "WorkPanel renderer is unavailable" } };
      }
      const source = document.source;
      let workspaceFilePath: string | undefined;
      let workspaceRelativePath: string | undefined;
      if (source.kind === "workspace-file") {
        try {
          const navigation = await assistantBridge.listNavigationAgents();
          const agent = navigation.ok
            ? navigation.items.find((candidate) => candidate.agentKey === source.agentKey)
            : null;
          const workspaceDir = agent?.workspaceDir?.trim() || "";
          const resolved = workspaceDir && workspaceDir !== "@chat" && agent?.workspaceDirExists !== false
            ? resolveWorkPanelLocalFileFromWorkspace(workspaceDir, source.path, context.platform)
            : null;
          if (!resolved?.ok) {
            return { ok: false, error: { code: "target_unavailable", message: resolved?.message || "Agent workspace is unavailable" } };
          }
          workspaceFilePath = resolved.filePath;
          workspaceRelativePath = resolved.relativePath;
        } catch {
          return { ok: false, error: { code: "target_unavailable", message: "Agent workspace is unavailable" } };
        }
      }
      const imagePrepared = await workPanelResourceImageRegistry.prepareClaim({
          ownerChatId,
          rendererWebContentsId: mainWindow.webContents.id,
          profile: source.kind,
          agentKey: source.agentKey,
          chatId: source.kind === "workspace-file" ? ownerChatId : source.chatId,
          resourceId: source.kind === "workspace-file" ? workspaceRelativePath! : source.resourceId,
          relativePath: source.kind === "workspace-file" ? workspaceRelativePath! : source.relativePath,
          title: document.title,
          ...(workspaceFilePath ? { workspaceFilePath } : {}),
        });
      if (imagePrepared.ok) {
        try {
          const response = await desktopActionOptions.callRendererAction({
            requestId: `workpanel-document-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            action: "desktop.workpanel.openResourceImage",
            args: {
              claimId: imagePrepared.claimId,
              surfaceKey: "document-image",
              ...(document.title ? { title: document.title } : {}),
            },
            source: { chatId: ownerChatId, agentKey: source.agentKey },
          });
          if (!response.ok) return { ok: false, error: { code: (response.error?.code || "target_unavailable") as any, message: response.error?.message || "WorkPanel renderer is unavailable" } };
          const result = response.result as { workspaceId?: unknown; item?: { itemId?: unknown } } | undefined;
          const workspaceId = typeof result?.workspaceId === "string" ? result.workspaceId : "";
          const itemId = typeof result?.item?.itemId === "string" ? result.item.itemId : "";
          return workspaceId && itemId
            ? { ok: true, workspaceId, itemId, renderer: "native-image" as const }
            : { ok: false, error: { code: "protocol_error", message: "Native image host returned an invalid result" } };
        } finally {
          workPanelResourceImageRegistry.discardPreparedClaim(imagePrepared.claimId);
        }
      }
      if (imagePrepared.code !== "unsupported_native_type") {
        return { ok: false, error: { code: imagePrepared.code, message: imagePrepared.message } };
      }
      const prepared = await workPanelDocumentHtmlRegistry.prepareClaim({
        ownerChatId,
        rendererWebContentsId: mainWindow.webContents.id,
        source: source.kind === "workspace-file"
          ? { ...source, path: workspaceRelativePath! }
          : source,
        title: document.title,
        ...(workspaceFilePath ? { workspaceFilePath } : {}),
      });
      if (!prepared.ok) return { ok: false, error: { code: prepared.code, message: prepared.message } };
      try {
        const response = await desktopActionOptions.callRendererAction({
          requestId: `workpanel-document-html-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          action: "desktop.workpanel.openDocumentHtml",
          args: { claimId: prepared.claimId, ...(document.title ? { title: document.title } : {}) },
          source: { chatId: ownerChatId, agentKey: source.agentKey },
        });
        if (!response.ok) return { ok: false, error: { code: (response.error?.code || "target_unavailable") as any, message: response.error?.message || "WorkPanel renderer is unavailable" } };
        const result = response.result as { workspaceId?: unknown; item?: { itemId?: unknown } } | undefined;
        const workspaceId = typeof result?.workspaceId === "string" ? result.workspaceId : "";
        const itemId = typeof result?.item?.itemId === "string" ? result.item.itemId : "";
        return workspaceId && itemId
          ? { ok: true, workspaceId, itemId, renderer: "native-html" as const }
          : { ok: false, error: { code: "protocol_error", message: "Native HTML host returned an invalid result" } };
      } finally {
        workPanelDocumentHtmlRegistry.discardPreparedClaim(prepared.claimId);
      }
    },
  });
  const readAgentRealtimeDebugSnapshot = (afterSequence?: unknown) => {
    const brokerDiagnostics = assistantBridgeRuntime.realtimeBroker.getDiagnostics();
    const bridgeDiagnostics = agentWebclientBridgeRuntime.getDiagnostics();
    const trace = assistantBridgeRuntime.realtimeBroker.getDebugTraceEntries();
    const normalizedAfterSequence = typeof afterSequence === "number" &&
      Number.isSafeInteger(afterSequence) && afterSequence >= 0
      ? afterSequence
      : null;
    const replayEventCount = brokerDiagnostics.replay.reduce((total, item) =>
      total + item.eventCount,
    0);
    const replayBytes = brokerDiagnostics.replay.reduce((total, item) =>
      total + item.bytes,
    0);
    const mapConnection = (
      source: "desktop-main" | "desktop-btw",
      connection: typeof brokerDiagnostics.connections.primary,
      lane: "primary" | "btw",
    ) => ({
      source,
      phase: connection.phase,
      generation: connection.generation,
      physicalConnectionCount: connection.physicalConnectionCount,
      reconnectCount: connection.reconnectCount,
      endpoint: connection.key?.endpoint || "",
      ...(connection.physicalSessionId ? { physicalSessionId: connection.physicalSessionId } : {}),
      ...(connection.lastInboundAt
        ? { lastInboundAt: requireEpochMillis(connection.lastInboundAt, `agentRealtimeDebugSnapshot.connections.${lane}.lastInboundAt`) }
        : {}),
      ...(connection.lastHeartbeatAt
        ? { lastHeartbeatAt: requireEpochMillis(connection.lastHeartbeatAt, `agentRealtimeDebugSnapshot.connections.${lane}.lastHeartbeatAt`) }
        : {}),
      ...(connection.closeReason ? { closeReason: connection.closeReason } : {}),
      ...(connection.lastError ? { lastError: connection.lastError } : {}),
    });
    return {
      capturedAt: requireEpochMillis(Date.now(), "agentRealtimeDebugSnapshot.capturedAt"),
      runtime: createAgentRealtimeRuntimeDiagnostics(app, options.browserSurfaces),
      connections: {
        primary: mapConnection("desktop-main", brokerDiagnostics.connections.primary, "primary"),
        btw: mapConnection("desktop-btw", brokerDiagnostics.connections.btw, "btw"),
      },
      broker: {
        pendingRequestCount: brokerDiagnostics.pendingRequestCount,
        pendingQueryCount: brokerDiagnostics.pendingQueryCount,
        activeStreamCount: brokerDiagnostics.activeStreamCount,
        runCount: brokerDiagnostics.runCount,
        localRunSubscriberCount: brokerDiagnostics.localRunSubscriberCount,
        pushSubscriberCount: brokerDiagnostics.pushSubscriberCount,
        connectionSubscriberCount: brokerDiagnostics.connectionSubscriberCount,
        overviewLease: brokerDiagnostics.overviewLease,
        pendingCloneCount: brokerDiagnostics.pendingClones.length,
        pendingClones: brokerDiagnostics.pendingClones.map((pending) => ({
          parentGeneration: pending.parentGeneration,
          runId: pending.runId,
          chatId: pending.chatId,
          waitReason: pending.waitReason,
        })),
        ...(brokerDiagnostics.lastCloneCancellationReason
          ? { lastCloneCancellationReason: brokerDiagnostics.lastCloneCancellationReason }
          : {}),
        replayEventCount,
        replayBytes,
        unknownFrameCount: brokerDiagnostics.unknownFrameCount,
        unknownRequestIdCount: brokerDiagnostics.unknownRequestIdCount,
        seqGapCount: brokerDiagnostics.seqGapCount,
        staleFrameCount: brokerDiagnostics.staleFrameCount,
        seqRegressionCount: brokerDiagnostics.seqRegressionCount,
        duplicateTerminalCount: brokerDiagnostics.duplicateTerminalCount,
        replayEvictionCount: brokerDiagnostics.replayEvictionCount,
        observerReleaseCount: brokerDiagnostics.observerReleaseCount,
        seqExpiredCount: brokerDiagnostics.seqExpiredCount,
        upstreamAttachCount: brokerDiagnostics.upstreamAttachCount,
        upstreamDetachCount: brokerDiagnostics.upstreamDetachCount,
        cloneCreatedCount: brokerDiagnostics.cloneCreatedCount,
        cloneRevokedCount: brokerDiagnostics.cloneRevokedCount,
        laneRotationCount: brokerDiagnostics.laneRotationCount,
      },
      bridge: {
        registeredSenderCount: bridgeDiagnostics.registeredSenderCount,
        logicalSessionCount: bridgeDiagnostics.logicalSessionCount,
        pendingRequestCount: bridgeDiagnostics.pendingRequestCount,
        activeStreamCount: bridgeDiagnostics.activeStreamCount,
        rootObserver: bridgeDiagnostics.activeRootObserver
          ? {
              ...bridgeDiagnostics.activeRootObserver,
              runIds: [...bridgeDiagnostics.activeRootObserver.runIds],
            }
          : null,
      },
      surfaces: bridgeDiagnostics.surfaces,
      logicalSessions: bridgeDiagnostics.logicalSessions.map((session) => ({
        ...session,
        openedAt: requireEpochMillis(session.openedAt, "agentRealtimeDebugSnapshot.logicalSession.openedAt"),
        ...("closedAt" in session && typeof session.closedAt === "number"
          ? { closedAt: requireEpochMillis(session.closedAt, "agentRealtimeDebugSnapshot.logicalSession.closedAt") }
          : {}),
      })),
      runRecovery: brokerDiagnostics.replay.map((run) => ({
        lane: run.lane,
        runId: run.runId,
        chatId: run.chatId,
        lastSeq: run.lastSeq,
        ...(run.lastEventType ? { lastEventType: run.lastEventType } : {}),
        ...(run.lastEventSeq === undefined ? {} : { lastEventSeq: run.lastEventSeq }),
        ...(run.lastPlanTaskEventType
          ? { lastPlanTaskEventType: run.lastPlanTaskEventType }
          : {}),
        ...(run.lastPlanTaskEventSeq === undefined
          ? {}
          : { lastPlanTaskEventSeq: run.lastPlanTaskEventSeq }),
        state: run.state,
        ...(run.terminalReason ? { terminalReason: run.terminalReason } : {}),
        ...(run.terminalSource ? { terminalSource: run.terminalSource } : {}),
        rootObserverCount: run.rootObserverCount,
        cloneCount: run.cloneCount,
        upstreamState: run.upstreamState,
        restoreCount: run.restoreCount,
        lastRestoreResult: run.lastRestoreResult,
      })),
      trace: normalizedAfterSequence === null
        ? trace
        : trace.filter((entry) => entry.sequence > normalizedAfterSequence),
    };
  };
  ipcMain.handle("diagnostics.getAgentRealtimeDebugSnapshot", async (_event: any, input?: unknown) =>
    readAgentRealtimeDebugSnapshot(
      input && typeof input === "object" ? (input as { afterSequence?: unknown }).afterSequence : undefined,
    ),
  );
  ipcMain.handle("diagnostics.openAgentRealtimeInspector", async () =>
    options.openAgentRealtimeInspectorWindow(),
  );
  ipcMain.handle("diagnostics.openAgentRealtimeTargetDevTools", async (_event: any, input?: unknown) => {
    const webContentsId = input && typeof input === "object"
      ? Number((input as { webContentsId?: unknown }).webContentsId)
      : 0;
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
      return { ok: false, message: "A valid WebContents ID is required" };
    }
    const diagnostic = options.browserSurfaces.listWebContentsDiagnostics()
      .find((contents) => contents.webContentsId === webContentsId && contents.type === "webview");
    const contents = diagnostic ? options.browserSurfaces.findWebContentsById(webContentsId) : null;
    if (!contents || contents.isDestroyed()) {
      return { ok: false, message: "The WebView is no longer available" };
    }
    contents.openDevTools({ mode: "detach" });
    return { ok: true };
  });
  ipcMain.handle("diagnostics.clearAgentRealtimeDebugTrace", async () => {
    assistantBridgeRuntime.realtimeBroker.clearDebugTrace();
    return readAgentRealtimeDebugSnapshot();
  });
  registerHelpIpcHandlers(ipcMain, app);

  registerServicesIpcHandlers(ipcMain, createServicesIpcHandlerOptions(context, {
    listServices,
    getServiceState,
    getResponsiveServiceState,
    installBuiltinService,
    initializeService,
    startService,
    stopService,
    restartService,
    readPluginSettings: readPluginSettingsSnapshot,
    writePluginSettings: writePluginSettingsValues,
    openPluginSettingsPage,
    refreshPluginGlobalShortcuts: options.refreshPluginDesktopGlobalShortcuts,
    readServiceConfig,
    writeServiceConfig,
    importServiceFile,
    getServiceLogsMeta,
    watchServiceLog,
    readServiceLog,
    runServiceMutation: options.runServiceMutation,
    handleServiceStart: options.handleServiceStart,
    showFileDialog: options.showFileDialog,
    showMessageBox: options.showMessageBox,
    showArchiveDialog: options.showArchiveDialog,
    openLogViewerWindow: options.openLogViewerWindow,
    closeLogViewerWindow: options.closeLogViewerWindow,
    minimizeLogViewerWindow: options.minimizeLogViewerWindow,
    maximizeLogViewerWindow: options.maximizeLogViewerWindow,
    openAgentPlatformMonitorWindow: options.openAgentPlatformMonitorWindow,
    issueAgentPlatformAccessToken: issueAgentAccessToken,
    revealPathInFileManager: options.revealPathInFileManager,
    getServiceWebviewPreloadPath: options.getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl: options.getServiceWebviewPreloadUrl,
    startupRestoreController: options.startupRestoreController,
    importEnvZipToRuntime,
    importEnvZipIntoExistingRuntime,
    runtimeEnvExists,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyServicesChanged: options.notifyServicesChanged,
    onStartupPreparationSucceeded: options.onStartupPreparationSucceeded,
    onStartupPreparationBlocked: options.onStartupPreparationBlocked,
    runStartupPreparation,
    desktopVersion: options.desktopAppInfo.version,
    logStreamSubscriptions: logsRuntime.getServiceLogSubscriptions(),
    applyDesktopInitBootstrap,
    refreshDesktopRuntimeConfigFromCanonicalFiles: options.refreshDesktopRuntimeConfigFromCanonicalFiles,
    oldRootDecisionRef: options.oldRootDecisionRef,
    generateBackupDirName,
    migrateOldRootToBackup,
    shouldPromptEnvRootConflict,
    isFirstDesktopInstall: options.isFirstDesktopInstall,
    bundledEnvZipExistsAtStartup: options.bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup: options.runtimeRootExistedAtStartup,
    runtimeRootAtProcessStart: options.runtimeRootAtProcessStart
  }));

  registerMarketplaceIpcHandlers(ipcMain, createMarketplaceIpcHandlerOptions(context, {
    t,
    runServiceMutation: options.runServiceMutation,
    showArchiveDialog: options.showArchiveDialog,
    showFileDialog: options.showFileDialog,
    showSaveDialog: options.showSaveDialog,
    installPluginFromArchive,
    handlePluginUninstall,
    getMarketSettings,
    saveMarketSettings,
    listMarketItems: async (marketApp, listOptions) => {
      const result = await listMarketItems(marketApp, listOptions);
      return mergeMarketMcpStatuses(result);
    },
    refreshMarketCatalog: async (marketApp, listOptions) => {
      const result = await refreshMarketCatalog(marketApp, listOptions);
      return mergeMarketMcpStatuses(result);
    },
    toggleMarketFavorite: (marketApp, input) => toggleMarketFavorite(marketApp, input, {
      issueAgentAccessToken: async (_app, reason) => {
        let token = isDesktopSsoCredentialRuntimeReady()
          ? getDesktopSsoAccessToken() || ""
          : "";
        if (reason === "unauthorized" || !token) {
          token = await options.desktopSsoController.refreshBrowserCookieAccessTokenIfNeeded?.(true) || "";
        }
        return {
          ok: Boolean(token),
          token,
          message: token ? "Desktop SSO access token ready." : "Sign in before using Market favorites."
        };
      }
    }),
    installMarketItem,
    updateMarketItem,
    uninstallMarketItem,
    buildSandboxImage,
    deleteSandboxImage,
    exportSandboxImageToPath,
    importSandboxImageFromPath,
    importSkillFromPath,
    importSkillFromCommand,
    onMarketCommandResult: (result) => {
      if (result?.type === "pet") {
        petRuntime.refreshState();
      }
      if (result?.type === "website-app") {
        options.notifyServicesChanged();
      }
    }
  }));

  registerSsoIpcHandlers(ipcMain, createSsoIpcHandlerOptions(context, {
    desktopSsoController: options.desktopSsoController,
    getDesktopSsoStatus,
    startDesktopSsoLogin,
    logoutDesktopSso,
    failDesktopSsoFlow,
    cancelDesktopSsoLogin,
    issueAgentAccessToken,
    refreshKanbanConnection: () => state.kanbanRuntime?.refreshDeviceInfo(),
    stopTunnelHubRuntime,
    refreshEnterpriseChat: () => options.enterpriseChatRuntime.refresh(),
    stopEnterpriseChat: () => options.enterpriseChatRuntime.handleSignedOut(),
    invalidateRealtimeIdentity: () => assistantBridgeRuntime.realtimeBroker.rotateIdentity()
  }));
  registerEnterpriseChatIpcHandlers(
    ipcMain,
    options.enterpriseChatRuntime,
    assistantBridge
  );
  registerTunnelHubIpcHandlers(ipcMain);
  registerKanbanIpcHandlers(ipcMain, createKanbanIpcHandlerOptions(context, {
    listKanbanIssues: () => state.kanbanRuntime?.listIssues() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    resyncKanbanCloud: () => state.kanbanRuntime?.resyncCloudBoard() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: [],
      connectionState: "disabled"
    },
    getKanbanSettings: () => state.kanbanRuntime?.getSettings() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      settings: {
        enabled: false,
        cloud: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    saveKanbanSettings: (_app: any, input: any) => state.kanbanRuntime?.saveSettings(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      settings: {
        enabled: false,
        cloud: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    getKanbanCloudConfig: () => state.kanbanRuntime?.getCloudConfig() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      config: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    saveKanbanCloudConfig: (_app: any, input: any) => state.kanbanRuntime?.saveCloudConfig(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      config: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    createKanbanIssue: (_app: any, input: any) => state.kanbanRuntime?.createIssue(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    updateKanbanIssue: (_app: any, issueId: string, input: any) => state.kanbanRuntime?.updateIssue(issueId, input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    deleteKanbanIssueWithAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      state.kanbanRuntime?.deleteIssueWithAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: t("kanban.runtime.uninitialized"),
        issues: []
      },
    moveKanbanIssue: (_app: any, input: any) => state.kanbanRuntime?.moveIssue(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    claimKanbanIssue: (_app: any, issueId: string) => state.kanbanRuntime?.claimIssue(issueId) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    runKanbanIssue: (_app: any, input: any) => state.kanbanRuntime?.runIssue(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    bindKanbanHumanReferenceChat: (_app: any, input: any) => state.kanbanRuntime?.bindHumanReferenceChat(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized")
    },
    unbindKanbanHumanReferenceChat: (_app: any, issueChatId: string) => state.kanbanRuntime?.unbindHumanReferenceChat(issueChatId) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized")
    },
    syncKanbanIssueAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      state.kanbanRuntime?.syncIssueAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: t("kanban.runtime.uninitialized"),
        issues: []
      },
    callAgentPlatform
  }));
  registerWebIpcHandlers(ipcMain, {
    app,
    showFileDialog: options.showFileDialog as any,
    showSaveDialog: options.showSaveDialog as any,
    getDataRoot,
    emitWebappChanged: assistantBridgeRuntime.emitWebappChanged
  });
  registerDesktopPetIpcHandlers(ipcMain, createDesktopPetIpcHandlerOptions(context, {
    clearActiveRuns: () => petRuntime.clearActiveRuns(),
    showWindow: () => petRuntime.showWindow(),
    hideWindow: () => petRuntime.hideWindow(),
    openAssistant: () => petRuntime.openAssistant(),
    openTaskChat: (input: any) => petRuntime.openTaskChat(input),
    moveWindowBy: (delta: any) => petRuntime.moveWindowBy(delta),
    beginDrag: (point: any) => petRuntime.beginDrag(point),
    endDrag: () => petRuntime.endDrag(),
    setPreviewExpanded: (expanded: boolean) => petRuntime.setPreviewExpanded(expanded),
    dismissPreview: () => petRuntime.dismissPreview(),
    setMouseInteractive: (interactive: boolean) => petRuntime.setMouseInteractive(Boolean(interactive)),
    setWindowMode: (mode: unknown) => petRuntime.setWindowMode(mode),
    scheduleStatusRefresh: (delayMs: number) => petRuntime.scheduleStatusRefresh(delayMs),
    refreshState: () => petRuntime.refreshState(),
    replyMessage: (input: any) => petRuntime.replyMessage(assistantBridge, input),
    dismissMessage: (input: any) => petRuntime.dismissMessage(input)
  }));
  registerSettingsIpcHandlers(ipcMain, createSettingsIpcHandlerOptions(context, {
    getDataRoot,
    resetRuntimeEnv: resetBundledRuntimeEnv,
    initializeMainI18n,
    isSupportedLocale,
    setMainLocale,
    getAppInfo: () => options.desktopAppInfo,
    buildApplicationMenu: options.buildApplicationMenu,
    refreshTrayContextMenu: options.refreshTrayContextMenu,
    refreshMainWindowAppearance: options.refreshMainWindowAppearance,
    emitLocaleChanged: options.emitLocaleChanged,
    createAppPairingPayload,
    onGeneralSettingsChanged: (settings) => {
      assistantRunWakeLock.sync();
      state.kanbanRuntime?.refreshDeviceInfo();
    },
    onEnterpriseImSettingsChanged: (settings) => {
      void options.enterpriseChatRuntime.reloadConfiguration(settings.enabled);
    },
    getDesktopWsServerRuntimeState: assistantBridgeRuntime.getDesktopWsServerRuntimeStateForSettings,
    startDesktopWsServer: assistantBridgeRuntime.startDesktopWsServerForSettings,
    stopDesktopWsServer: assistantBridgeRuntime.stopDesktopWsServerForSettings,
    applyTunnelHubSettings,
    getTunnelHubRuntimeStatus
  }));
}
