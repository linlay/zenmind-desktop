import type { App, BrowserWindow, WebContents } from "electron";
import path from "node:path";
import type {
  CopilotDevToolsTarget,
  DesktopPageContextSnapshot,
  MarketListResult
} from "../../shared/contracts";
import { createAppPairingPayload } from "../modules/identity";
import {
  cancelDesktopSsoLogin,
  failDesktopSsoFlow,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  logoutDesktopSso,
  startDesktopSsoLogin
} from "../modules/identity";
import { loadBuiltinServices } from "../modules/services";
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
} from "../modules/services";
import {
  emitPluginBridgeHook,
  getPluginGlobalShortcutStatuses,
  installPluginFromArchive,
  invokePluginDesktopAction,
  loadInstalledPlugins
} from "../modules/plugins";
import { handlePluginUninstall } from "../modules/plugins";
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
} from "../modules/marketplace";

import { getAgentPlatformMinimaxSettingsPublic } from "../modules/agent-platform";

import { ContainerHubClient, getAssistantSettings, readAssistantSettings, saveAssistantSettings, toPublicAssistantSettings } from "../modules/assistant";

import {
  cancelAssistantAttachmentTask,
  createAssistantAttachmentFromPastedImage,
  createAssistantAttachmentsFromFiles,
  resolveAssistantAttachmentPath
} from "../modules/assistant";

import {
  callAgentPlatform,
  handleAgentWebclientWorkPanelActionRequest,
  handleDesktopActionRequest
} from "../modules/desktop-actions";

import {
  applyDesktopInitBootstrap,
  applyDesktopInitVersionUpgrade
} from "./bootstrap/desktop-init";

import {
  generateBackupDirName,
  importEnvZipToRuntime,
  migrateOldRootToBackup,
  resetBundledRuntimeEnv,
  runtimeEnvExists,
  shouldPromptEnvRootConflict
} from "../infrastructure/filesystem/runtime-environment";

import { getDataRoot } from "../infrastructure/filesystem/user-paths";

import {
  openPluginSettingsPage,
  readPluginSettingsSnapshot,
  writePluginSettingsValues
} from "../modules/plugins";

import { t, initializeMainI18n, setMainLocale } from "../support/i18n/main-i18n";

import { isSupportedLocale } from "../../shared/i18n";

import { DESKTOP_ACTION_DEFINITIONS } from "../../shared/desktop-actions";

import { applyTunnelHubSettings, getTunnelHubRuntimeStatus, stopTunnelHubRuntime } from "../modules/tunnel";

import type { AssistantBridgeRuntime } from "../modules/assistant";

import type { AssistantRunWakeLock } from "../modules/assistant";

import type { DesktopPetRuntime } from "../modules/pet";

import type { LogsRuntime } from "../support/logging/runtime";

import { registerAssistantIpcHandlers } from "../modules/assistant";

import { registerDesktopPetIpcHandlers } from "../modules/pet";

import { registerMarketplaceIpcHandlers } from "../modules/marketplace";

import { registerServicesIpcHandlers } from "../modules/services";

import { registerSettingsIpcHandlers } from "../modules/settings";

import { registerShellIpcHandlers } from "../modules/shell";

import { registerSsoIpcHandlers } from "../modules/identity";

import { registerKanbanIpcHandlers } from "../modules/kanban";

import { registerTunnelHubIpcHandlers } from "../modules/tunnel";

import { registerWebIpcHandlers } from "../modules/webs";

import { registerEmbeddedCdpIpcHandlers } from "../modules/web-surfaces";

import { registerAgentWebclientBridgeIpcHandlers } from "../modules/agent-platform";

import { registerCanonicalChatSyncIpc } from "../modules/agent-platform";

import type { BrowserSurfaceRegistry } from "../modules/web-surfaces";

import type { EnterpriseChatRuntime } from "../modules/enterprise-chat";

import { registerEnterpriseChatIpcHandlers } from "../modules/enterprise-chat";

import { registerHelpIpcHandlers } from "../modules/settings";

import { registerSidebarContextMenuIpcHandlers } from "../modules/web-surfaces";

import { registerChatWorkPanelTabContextMenuIpcHandlers } from "../modules/work-panel";

import {
  normalizeChatWorkPanelOpenLocalResourceRequest,
  registerChatWorkPanelLocalFileIpcHandlers,
  resolveWorkPanelLocalFileFromWorkspace,
} from "../modules/work-panel";

import {
  registerChatWorkPanelDocumentHtmlIpcHandlers,
  workPanelDocumentHtmlRegistry,
} from "../modules/work-panel";

import {
  registerChatWorkPanelResourceImageIpcHandlers,
  workPanelResourceImageRegistry,
} from "../modules/work-panel";

import { requireEpochMillis } from "../../shared/time-contract";

import type { AgentRealtimeDebugTarget } from "../../shared/contracts";

import { MainIpcRegistrationOptions, PLATFORM_DOCUMENT_REVISION_HEADER, createAgentRealtimeRuntimeDiagnostics } from "./module-registry.part-1";

export function registerMainIpcHandlers(options: MainIpcRegistrationOptions) {
  const {
    app,
    ipcMain,
    assistantBridgeRuntime,
    assistantRunWakeLock,
    logsRuntime,
    petRuntime
  } = options;
  const services = options.servicesFacade;
  const { assistantBridge, desktopActionOptions } = assistantBridgeRuntime;
  const withMarketplacePorts = (marketOptions: Record<string, unknown> = {}) => ({
    ...marketOptions,
    createContainerHubClient: (config: ConstructorParameters<typeof ContainerHubClient>[0]) =>
      new ContainerHubClient(config),
    webs: options.websFacade
  });
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
      if (!bytes.length || bytes.length > 100 * 1024 * 1024) return null;
      return {
        bytes,
        mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "",
        revision: response.headers.get(PLATFORM_DOCUMENT_REVISION_HEADER)?.trim() || "",
      };
    } catch {
      return null;
    }
  };
  registerChatWorkPanelDocumentHtmlIpcHandlers(ipcMain, {
    app,
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

  registerEmbeddedCdpIpcHandlers(ipcMain, options.browserSurfaces);
  const canonicalChatSync = registerCanonicalChatSyncIpc(ipcMain, {
    resolveRenderer: (ownerWebContentsId) => {
      const mainWindow = options.getMainWindow();
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
    normalizeWorkPanelOpenLocalResourceRequest: normalizeChatWorkPanelOpenLocalResourceRequest,
    realtimeBroker: assistantBridgeRuntime.realtimeBroker,
    getServiceState,
    issueAccessToken: options.issueAgentAccessToken,
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
      const mainWindow = options.getMainWindow();
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
      const mainWindow = options.getMainWindow();
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
            ? resolveWorkPanelLocalFileFromWorkspace(workspaceDir, source.path, options.platform)
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
    const replayEventCount = brokerDiagnostics.replay.reduce((total: number, item: { eventCount: number }) =>
      total + item.eventCount,
    0);
    const replayBytes = brokerDiagnostics.replay.reduce((total: number, item: { bytes: number }) =>
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
        pendingClones: brokerDiagnostics.pendingClones.map((pending: {
          parentGeneration: string; runId: string; chatId: string; waitReason: string;
        }) => ({
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
      runRecovery: brokerDiagnostics.replay.map((run: {
        lane: "primary" | "btw"; runId: string; chatId: string; lastSeq: number;
        lastEventType?: string; lastEventSeq?: number; lastPlanTaskEventType?: string;
        lastPlanTaskEventSeq?: number; state: string; terminalReason?: string;
        terminalSource?: string; rootObserverCount: number; cloneCount: number;
        upstreamState: string; restoreCount: number; lastRestoreResult: string;
      }) => ({
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
        : trace.filter((entry: { sequence: number }) => entry.sequence > normalizedAfterSequence),
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

  registerServicesIpcHandlers(ipcMain, {
    app,
    shell: options.shell,
    platform: options.platform,
    listServices: services.listServices,
    getServiceState: services.getServiceState,
    getResponsiveServiceState: services.getResponsiveServiceState,
    installBuiltinService: services.installBuiltinService,
    initializeService: services.initializeService,
    startService: services.startService,
    stopService: services.stopService,
    restartService: services.restartService,
    readPluginSettings: readPluginSettingsSnapshot,
    writePluginSettings: writePluginSettingsValues,
    openPluginSettingsPage,
    refreshPluginGlobalShortcuts: options.refreshPluginDesktopGlobalShortcuts,
    emitPluginBridgeHook,
    getPluginGlobalShortcutStatuses,
    invokePluginDesktopAction,
    readServiceConfig: services.readServiceConfig,
    writeServiceConfig: services.writeServiceConfig,
    importServiceFile: services.importServiceFile,
    getServiceLogsMeta: services.getServiceLogsMeta,
    watchServiceLog: services.watchServiceLog,
    readServiceLog: services.readServiceLog,
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
    issueAgentPlatformAccessToken: options.issueAgentAccessToken,
    revealPathInFileManager: options.revealPathInFileManager,
    getServiceWebviewPreloadPath: options.getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl: options.getServiceWebviewPreloadUrl,
    startupRestoreController: options.startupRestoreController,
    importEnvZipToRuntime: importEnvZipToRuntime as any,
    importEnvZipIntoExistingRuntime: (targetApp, zipPath, desktopVersion, platform) =>
      importEnvZipIntoExistingRuntime(
        targetApp,
        zipPath,
        desktopVersion,
        platform,
        applyDesktopInitVersionUpgrade
      ),
    runtimeEnvExists,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyServicesChanged: options.notifyServicesChanged,
    onStartupPreparationSucceeded: options.onStartupPreparationSucceeded,
    onStartupPreparationBlocked: options.onStartupPreparationBlocked,
    runStartupPreparation: (targetApp, callbacks) => services.runStartupPreparation(targetApp, {
      ...callbacks,
      applyDesktopConfiguration: applyDesktopInitVersionUpgrade
    }),
    desktopVersion: options.desktopAppInfo.version,
    logStreamSubscriptions: logsRuntime.getServiceLogSubscriptions(),
    applyDesktopInitBootstrap,
    refreshDesktopRuntimeConfigFromCanonicalFiles: options.refreshDesktopRuntimeConfigFromCanonicalFiles,
    oldRootDecisionRef: options.oldRootDecisionRef,
    generateBackupDirName: generateBackupDirName as any,
    migrateOldRootToBackup: migrateOldRootToBackup as any,
    shouldPromptEnvRootConflict: shouldPromptEnvRootConflict as any,
    isFirstDesktopInstall: options.isFirstDesktopInstall,
    bundledEnvZipExistsAtStartup: options.bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup: options.runtimeRootExistedAtStartup,
    runtimeRootAtProcessStart: options.runtimeRootAtProcessStart,
    clearSessionCache: () => options.session.defaultSession.clearCache()
  });

  registerMarketplaceIpcHandlers(ipcMain, {
    app,
    platform: options.platform,
    mainWindow: options.getMainWindow(),
    t,
    runServiceMutation: options.runServiceMutation,
    showArchiveDialog: options.showArchiveDialog,
    showFileDialog: options.showFileDialog,
    showSaveDialog: options.showSaveDialog,
    clearSessionCache: () => options.session.defaultSession.clearCache(),
    installPluginFromArchive,
    handlePluginUninstall,
    getMarketSettings,
    saveMarketSettings,
    listMarketItems: async (marketApp, listOptions) => {
      const result = await listMarketItems(marketApp, withMarketplacePorts(listOptions));
      return mergeMarketMcpStatuses(result);
    },
    refreshMarketCatalog: async (marketApp, listOptions) => {
      const result = await refreshMarketCatalog(marketApp, withMarketplacePorts(listOptions));
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
    installMarketItem: (marketApp, itemId) => installMarketItem(marketApp, itemId, withMarketplacePorts()),
    updateMarketItem: (marketApp, itemId) => updateMarketItem(marketApp, itemId, withMarketplacePorts()),
    uninstallMarketItem: (marketApp, itemId) =>
      uninstallMarketItem(marketApp, itemId, withMarketplacePorts()),
    buildSandboxImage: (marketApp, itemId) => buildSandboxImage(marketApp, itemId, withMarketplacePorts()),
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
  });

  registerSsoIpcHandlers(ipcMain, {
    app,
    desktopSsoController: options.desktopSsoController,
    getDesktopSsoStatus,
    startDesktopSsoLogin,
    logoutDesktopSso,
    failDesktopSsoFlow,
    cancelDesktopSsoLogin,
    issueAgentAccessToken: options.issueAgentAccessToken,
    refreshKanbanConnection: assistantBridgeRuntime.refreshKanbanDeviceInfo,
    stopTunnelHubRuntime,
    refreshEnterpriseChat: () => options.enterpriseChatRuntime.refresh(),
    stopEnterpriseChat: () => options.enterpriseChatRuntime.handleSignedOut(),
    invalidateRealtimeIdentity: () => assistantBridgeRuntime.realtimeBroker.rotateIdentity()
  });
  registerEnterpriseChatIpcHandlers(
    ipcMain,
    options.enterpriseChatRuntime,
    assistantBridge
  );
  registerTunnelHubIpcHandlers(ipcMain);
  registerKanbanIpcHandlers(ipcMain, {
    app,
    listKanbanIssues: () => assistantBridgeRuntime.getKanbanRuntime()?.listIssues() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    resyncKanbanCloud: () => assistantBridgeRuntime.getKanbanRuntime()?.resyncCloudBoard() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: [],
      connectionState: "disabled"
    },
    getKanbanSettings: () => assistantBridgeRuntime.getKanbanRuntime()?.getSettings() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      settings: {
        enabled: false,
        cloud: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    saveKanbanSettings: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.saveSettings(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      settings: {
        enabled: false,
        cloud: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    getKanbanCloudConfig: () => assistantBridgeRuntime.getKanbanRuntime()?.getCloudConfig() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      config: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    saveKanbanCloudConfig: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.saveCloudConfig(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      config: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    createKanbanIssue: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.createIssue(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    updateKanbanIssue: (_app: any, issueId: string, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.updateIssue(issueId, input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    deleteKanbanIssueWithAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      assistantBridgeRuntime.getKanbanRuntime()?.deleteIssueWithAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: t("kanban.runtime.uninitialized"),
        issues: []
      },
    moveKanbanIssue: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.moveIssue(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    claimKanbanIssue: (_app: any, issueId: string) => assistantBridgeRuntime.getKanbanRuntime()?.claimIssue(issueId) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    runKanbanIssue: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.runIssue(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    bindKanbanHumanReferenceChat: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.bindHumanReferenceChat(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized")
    },
    unbindKanbanHumanReferenceChat: (_app: any, issueChatId: string) => assistantBridgeRuntime.getKanbanRuntime()?.unbindHumanReferenceChat(issueChatId) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized")
    },
    syncKanbanIssueAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      assistantBridgeRuntime.getKanbanRuntime()?.syncIssueAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: t("kanban.runtime.uninitialized"),
        issues: []
      },
    callAgentPlatform
  });
  registerWebIpcHandlers(ipcMain, {
    app,
    websFacade: options.websFacade,
    showFileDialog: options.showFileDialog as any,
    showSaveDialog: options.showSaveDialog as any,
    getDataRoot,
    emitWebappChanged: assistantBridgeRuntime.emitWebappChanged
  });
  registerDesktopPetIpcHandlers(ipcMain, {
    platform: options.platform,
    app,
    getSettings: petRuntime.getSettings,
    saveSettingsInState: petRuntime.saveSettings,
    getWindow: petRuntime.getWindow,
    getPanelWindow: petRuntime.getPanelWindow,
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
    refreshState: () => petRuntime.refreshState(),
    replyMessage: (input: any) => petRuntime.replyMessage(assistantBridge, input),
    dismissMessage: (input: any) => petRuntime.dismissMessage(input)
  });
  registerSettingsIpcHandlers(ipcMain, {
    app,
    platform: options.platform,
    nativeTheme: options.nativeTheme,
    getDataRoot,
    resetRuntimeEnv: resetBundledRuntimeEnv as any,
    initializeMainI18n,
    isSupportedLocale,
    setMainLocale,
    getAppInfo: () => options.desktopAppInfo,
    buildApplicationMenu: options.buildApplicationMenu,
    refreshTrayContextMenu: options.refreshTrayContextMenu,
    refreshMainWindowAppearance: options.refreshMainWindowAppearance,
    emitLocaleChanged: options.emitLocaleChanged,
    createAppPairingPayload: (targetApp, pairingOptions) =>
      createAppPairingPayload(targetApp, { ...pairingOptions, issueAccessToken: options.issueAgentAccessToken }),
    onGeneralSettingsChanged: () => {
      assistantRunWakeLock.sync();
      assistantBridgeRuntime.refreshKanbanDeviceInfo();
    },
    onEnterpriseImSettingsChanged: (settings) => {
      void options.enterpriseChatRuntime.reloadConfiguration(settings.enabled);
    },
    getDesktopWsServerRuntimeState: assistantBridgeRuntime.getDesktopWsServerRuntimeStateForSettings,
    startDesktopWsServer: assistantBridgeRuntime.startDesktopWsServerForSettings,
    stopDesktopWsServer: assistantBridgeRuntime.stopDesktopWsServerForSettings,
    applyTunnelHubSettings,
    getTunnelHubRuntimeStatus
  });
}
