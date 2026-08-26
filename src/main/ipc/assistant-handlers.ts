import path from "node:path";
import fs from "node:fs";
import {
  getAssistantExportDefaultPath,
  getAvailableFilePath
} from "../download-paths";
import { buildProjectAgentCreateRequest, type ProjectCreateType } from "../assistant/core/coder-project";
import { PRODUCT_NAME } from "../../shared/brand";
import type {
  AssistantChatOrderMutationRequest,
  AssistantChatOrderMutationResult,
  AssistantChatSortMode,
  AssistantConversationShareRequest,
  AssistantNavigationListOptions,
  AssistantReorderProjectsRequest,
  AssistantReorderProjectsResult,
} from "../../shared/contracts";
import { isTimeContractViolation, requireEpochMillis } from "../../shared/time-contract";
import {
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot,
} from "../desktop-profile-store";
import { getDesktopConfigRoot } from "../user-paths";
import { t } from "../i18n/main-i18n";
import { COPILOT_DOCK_SURFACE_ID } from "../../shared/surface-identity";
import {
  createConversationShare,
  listConversationShares,
  revokeConversationShare
} from "../assistant/core/conversation-share-controller";
import { saveConversationHtmlExport } from "../assistant/core/conversation-html-export";
import { ConversationHtmlRenderService } from "../assistant/core/conversation-html-render-service";
import { TunnelConversationShareClient } from "../assistant/core/tunnel-conversation-share-client";
import {
  createProjectAgentOrderPlan,
  validateProjectAgentOrderRequestKeys,
} from "../assistant/core/project-agent-order";

export interface AssistantIpcHandlerOptions {
  assistantBridge: any;
  assistantNavigationStatusClient: any;
  /** The shared pending-renderer-requests Map (desktopActions.respond resolves into it) */
  desktopActionRendererRequests: Map<string, { resolve: (r: any) => void; timeout: ReturnType<typeof setTimeout> | null }>;
  /** The shared pending-confirmation-requests Map (desktopActions.respondConfirmation resolves into it) */
  desktopActionConfirmationRequests: Map<string, { resolve: (r: any) => void; timeout: ReturnType<typeof setTimeout> | null }>;
  /** Optional external getter for currentPage snapshot (bridges to callers that need it) */
  getCurrentPageSnapshot?: () => any;
  /** Optional external setter for currentPage snapshot (called when renderer publishes) */
  setCurrentPageSnapshot?: (snapshot: any) => void;
  /** Optional getter/setter for the currently preferred Copilot DevTools webview target. */
  getCopilotDevToolsTarget?: () => any;
  setCopilotDevToolsTarget?: (target: any) => void;
  getWebContentsById?: (id: number) => any;
  /** Optional diagnostic sink for crash breadcrumbs. */
  reportRendererDiagnostic?: (source: string, details: Record<string, unknown>) => void;
  desktopActionOptions: any;
  app: any;
  mainWindow: any;
  shell: any;
  showFileDialog: ((opts: any, owner?: any) => Promise<any>) | null;
  callAgentPlatform: ((app: any, path: string, options?: any) => Promise<any>) | null;
  handleDesktopActionRequest: ((opts: any, request: any) => Promise<any>) | null;
  DESKTOP_ACTION_DEFINITIONS: ReadonlyArray<any> | any[];
  emitAssistantAttachmentProgress: ((progress: any) => void) | null;
  getAssistantSettings: ((app: any) => any) | null;
  saveAssistantSettings: ((app: any, input: any) => any) | null;
  getAgentPlatformMinimaxSettingsPublic: ((app: any) => any) | null;
  resolveAssistantAttachmentPath: ((app: any, chatId: string, attachmentId: string) => string) | null;
  createAssistantAttachmentFromPastedImage: ((app: any, chatId: any, input: any) => any) | null;
  cancelAssistantAttachmentTask: ((taskId: string) => any) | null;
  createAssistantAttachmentsFromFiles: ((app: any, chatId: any, filePaths: string[], opts: any) => any) | null;
  captureAssistantScreenshot: ((chatId: any) => any) | null;
  openDesktopActionWorkbenchWindow?: () => Promise<{ ok: boolean }> | { ok: boolean };
  closeDesktopActionWorkbenchWindow?: () => Promise<{ ok: boolean }> | { ok: boolean };
  consumeFirstInstallBootstrapNavigation?: () => { shouldOpen: boolean };
  platform?: string;
}

async function saveAssistantChatExport(
  assistantBridge: any,
  chatId: string,
  app: any,
  platform: string
): Promise<any> {
  const result = await assistantBridge.downloadChatExport(chatId);
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  const exportPath = await getAvailableFilePath(getAssistantExportDefaultPath(app, result.filename, platform), {
    platform
  });
  await fs.promises.mkdir(path.dirname(exportPath), { recursive: true });
  await fs.promises.writeFile(exportPath, result.bytes);
  return { ok: true, message: t("assistant.chatExportDownloaded"), filePath: exportPath };
}

const COPILOT_DEVTOOLS_SURFACE_IDS = new Set([
  COPILOT_DOCK_SURFACE_ID
]);

function readOptionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function readOptionalFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nowEpochMillis() {
  return requireEpochMillis(Date.now(), "desktop.assistantIpc.now");
}

function readAgentCatalogKeys(value: unknown, path: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${path}[${index}] must be an object`);
    }
    const key = typeof (item as Record<string, unknown>).key === "string"
      ? String((item as Record<string, unknown>).key).trim()
      : "";
    if (!key) {
      throw new Error(`${path}[${index}].key is required`);
    }
    return key;
  });
}

function readAgentOrderKeys(value: unknown, path: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const order = (value as Record<string, unknown>).order;
  if (!Array.isArray(order)) {
    throw new Error(`${path}.order must be an array`);
  }
  const keys = order.map((item, index) => {
    const key = typeof item === "string" ? item.trim() : "";
    if (!key) {
      throw new Error(`${path}.order[${index}] must be a non-empty agent key`);
    }
    return key;
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${path}.order contains duplicate agent keys`);
  }
  return keys;
}

function isLiveWebviewContents(contents: any) {
  return Boolean(
    contents &&
    typeof contents.isDestroyed === "function" &&
    typeof contents.getType === "function" &&
    !contents.isDestroyed() &&
    contents.getType() === "webview"
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAssistantIpcHandlers(ipcMain: any, options: AssistantIpcHandlerOptions) {
  const {
    assistantBridge,
    assistantNavigationStatusClient,
    desktopActionRendererRequests,
    desktopActionConfirmationRequests,
    desktopActionOptions,
    app,
    mainWindow,
    shell,
    showFileDialog,
    callAgentPlatform,
    handleDesktopActionRequest,
    DESKTOP_ACTION_DEFINITIONS,
    emitAssistantAttachmentProgress,
    getAssistantSettings,
    saveAssistantSettings,
    getAgentPlatformMinimaxSettingsPublic,
    resolveAssistantAttachmentPath,
    createAssistantAttachmentFromPastedImage,
    cancelAssistantAttachmentTask,
    createAssistantAttachmentsFromFiles,
    captureAssistantScreenshot,
    openDesktopActionWorkbenchWindow,
    closeDesktopActionWorkbenchWindow,
    platform = process.platform
  } = options;
  const conversationShareClient = new TunnelConversationShareClient();
  const conversationHtmlRenderer = new ConversationHtmlRenderService({
    app,
    snapshotProvider: assistantBridge
  });
  conversationHtmlRenderer.start();
  app.once("will-quit", () => {
    void conversationHtmlRenderer.dispose();
  });

  // ---------------------------------------------------------------------------
  // currentPage — pure snapshot state
  // Internal fallback state when no external getter/setter is provided.
  // ---------------------------------------------------------------------------
  let _internalSnapshot: any = null;
  const getSnapshot = options.getCurrentPageSnapshot ?? (() => _internalSnapshot);
  const setSnapshot = options.setCurrentPageSnapshot ?? ((s: any) => { _internalSnapshot = s; });
  let _internalCopilotDevToolsTarget: any = null;
  const getCopilotDevToolsTarget = options.getCopilotDevToolsTarget ?? (() => _internalCopilotDevToolsTarget);
  const setCopilotDevToolsTarget = options.setCopilotDevToolsTarget ?? ((target: any) => {
    _internalCopilotDevToolsTarget = target;
  });
  const getWebContentsById = options.getWebContentsById ?? (() => null);
  const copilotDevToolsOwnerCleanupIds = new Set<number>();

  function currentChatSortMode(): AssistantChatSortMode {
    return readDesktopProfileFromRoot(
      getDesktopConfigRoot(app, platform as NodeJS.Platform),
    ).navigation.chatSortMode;
  }

  function normalizeChatOrderMutation(
    input: AssistantChatOrderMutationRequest,
  ): AssistantChatOrderMutationRequest {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(t("assistant.chatOrderInvalidRequest"));
    }
    if (input.operation === "set_mode") {
      if (input.sortMode !== "recent" && input.sortMode !== "manual") {
        throw new Error(t("assistant.chatOrderInvalidRequest"));
      }
      return { operation: "set_mode", sortMode: input.sortMode };
    }
    if (input.operation !== "move") {
      throw new Error(t("assistant.chatOrderInvalidRequest"));
    }
    const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
    const beforeChatId = typeof input.beforeChatId === "string"
      ? input.beforeChatId.trim()
      : "";
    const afterChatId = typeof input.afterChatId === "string"
      ? input.afterChatId.trim()
      : "";
    if (
      !chatId ||
      (Boolean(beforeChatId) === Boolean(afterChatId)) ||
      chatId === (beforeChatId || afterChatId)
    ) {
      throw new Error(t("assistant.chatOrderInvalidRequest"));
    }
    return {
      operation: "move",
      chatId,
      ...(beforeChatId ? { beforeChatId } : { afterChatId }),
    };
  }

  ipcMain.handle("currentPage.publishSnapshot", async (_event: any, snapshot: any) => {
    setSnapshot(snapshot);
    if (snapshot && typeof snapshot === "object") {
      const currentPage = snapshot as Record<string, unknown>;
      options.reportRendererDiagnostic?.("current-page", {
        diagnosticLevel: "debug",
        route: currentPage.route,
        pageKey: currentPage.pageKey,
        pageKind: currentPage.pageKind,
        surfaceId: currentPage.surfaceId,
        surfaceLabel: currentPage.surfaceLabel,
        surfaceRoute: currentPage.surfaceRoute,
        embedPath: currentPage.embedPath,
        webContentsId: currentPage.webContentsId,
        pageContext: currentPage.pageContext
      });
    } else {
      options.reportRendererDiagnostic?.("current-page", {
        diagnosticLevel: "debug",
        cleared: true
      });
    }
    return { ok: true };
  });

  ipcMain.handle("currentPage.getSnapshot", async () => getSnapshot());

  ipcMain.handle("copilot.publishDevToolsTarget", async (event: any, input: any) => {
    const request = input && typeof input === "object" ? input : {};
    const surfaceId = readOptionalString(request.surfaceId);
    const ownerWebContentsId = readOptionalFiniteNumber(event?.sender?.id);
    const clearCurrentTarget = () => {
      const current = getCopilotDevToolsTarget();
      if (
        current &&
        current.surfaceId === surfaceId &&
        current.ownerWebContentsId === ownerWebContentsId
      ) {
        setCopilotDevToolsTarget(null);
      }
    };

    if (!surfaceId || !COPILOT_DEVTOOLS_SURFACE_IDS.has(surfaceId)) {
      return { ok: false, message: "Unsupported Copilot DevTools target." };
    }

    if (request.active === false) {
      clearCurrentTarget();
      return { ok: true };
    }

    if (ownerWebContentsId === undefined) {
      return { ok: false, message: "Copilot DevTools target owner is unavailable." };
    }

    const webContentsId = readOptionalFiniteNumber(request.webContentsId);
    if (webContentsId === undefined) {
      clearCurrentTarget();
      return { ok: false, message: "Copilot DevTools webContentsId is unavailable." };
    }

    const targetContents = getWebContentsById(webContentsId);
    if (!isLiveWebviewContents(targetContents)) {
      clearCurrentTarget();
      return { ok: false, message: "Copilot DevTools target is not a live webview." };
    }

    const currentUrl = readOptionalString(request.currentUrl);
    setCopilotDevToolsTarget({
      surfaceId,
      webContentsId,
      ownerWebContentsId,
      ...(currentUrl ? { currentUrl } : {})
    });

    if (
      !copilotDevToolsOwnerCleanupIds.has(ownerWebContentsId) &&
      event?.sender &&
      typeof event.sender.once === "function"
    ) {
      copilotDevToolsOwnerCleanupIds.add(ownerWebContentsId);
      event.sender.once("destroyed", () => {
        copilotDevToolsOwnerCleanupIds.delete(ownerWebContentsId);
        const current = getCopilotDevToolsTarget();
        if (current?.ownerWebContentsId === ownerWebContentsId) {
          setCopilotDevToolsTarget(null);
        }
      });
    }

    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // assistant — settings
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.getSettings", async () =>
    (getAgentPlatformMinimaxSettingsPublic?.(app) ?? null) ?? getAssistantSettings?.(app)
  );

  ipcMain.handle("assistant.consumeFirstInstallBootstrapNavigation", async () =>
    options.consumeFirstInstallBootstrapNavigation?.() ?? { shouldOpen: false }
  );

  ipcMain.handle("assistant.saveSettings", async (_event: any, input: any) => {
    return saveAssistantSettings?.(app, input);
  });

  ipcMain.handle("assistant.getMemorySettings", async () =>
    assistantBridge?.getMemorySettings()
  );

  ipcMain.handle("assistant.saveMemorySettings", async (_event: any, input: any) =>
    assistantBridge?.saveMemorySettings(input)
  );

  ipcMain.handle("assistant.getMemorySummary", async () =>
    assistantBridge?.getMemorySummary()
  );

  // ---------------------------------------------------------------------------
  // assistant — agents
  // ---------------------------------------------------------------------------
  async function createProject(input: any): Promise<any> {
    const projectTypeValue = String(input?.projectType || "").trim().toLowerCase();
    const projectType: ProjectCreateType | null =
      projectTypeValue === "coder" || projectTypeValue === "kbase"
        ? projectTypeValue
        : null;
    const workspaceDir = String(input?.workspaceDir || "").trim();
    const acpProxyId = String(input?.acpProxyId || "").trim();
    if (!projectType) {
      return { ok: false, message: t("assistant.projectTypeUnsupported") };
    }
    if (!workspaceDir) {
      return { ok: false, message: t("assistant.projectWorkspaceMissing") };
    }

    const request = buildProjectAgentCreateRequest(projectType, workspaceDir, { acpProxyId });
    try {
      const response = await callAgentPlatform?.(app, "/api/admin/agents/create", {
        method: "POST",
        body: request
      });
      const agentKey = String(response?.key || "").trim();
      assistantNavigationStatusClient?.scheduleRefresh(0);
      return { ok: true, message: t("assistant.projectCreated"), agentKey, workspaceDir };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        agentKey: "",
        workspaceDir
      };
    }
  }

  ipcMain.handle("assistant.listAgents", async () => {
    try {
      return await assistantBridge.listAgents();
    } catch (error) {
      console.warn("[assistant] failed to list agent-platform agents", error);
      return [];
    }
  });

  ipcMain.handle("assistant.listNavigationAgents", async (
    _event: unknown,
    options?: AssistantNavigationListOptions
  ): Promise<any> => {
    try {
      if (options?.force !== true) {
        const cached = assistantNavigationStatusClient?.getSnapshot();
        if (cached?.ok) {
          return cached;
        }
      }
      return await (assistantNavigationStatusClient?.refreshNow() ?? assistantBridge?.listNavigationAgents());
    } catch (error) {
      console.warn("[assistant] failed to list navigation agents", error);
      if (isTimeContractViolation(error)) {
        throw error;
      }
      return {
        ok: false,
        items: [],
        chatItems: [],
        chatItemsHasMore: false,
        message: error instanceof Error ? error.message : t("assistant.agentPlatformUnavailable"),
        updatedAt: nowEpochMillis()
      };
    }
  });

  ipcMain.handle("assistant.updateChatOrder", async (
    _event: unknown,
    input: AssistantChatOrderMutationRequest,
  ): Promise<AssistantChatOrderMutationResult> => {
    const previousMode = currentChatSortMode();
    try {
      if (!callAgentPlatform) {
        throw new Error(t("assistant.chatOrderUnavailable"));
      }
      const request = normalizeChatOrderMutation(input);
      const response = await callAgentPlatform(
        app,
        "/api/chats/order",
        { method: "PUT", body: request },
      ) as Record<string, unknown> | null;
      const sortMode = response?.sortMode;
      if (sortMode !== "recent" && sortMode !== "manual") {
        throw new Error(t("assistant.chatOrderInvalidResponse"));
      }
      const updatedAt = response?.updatedAt === undefined || response.updatedAt === null
        ? undefined
        : requireEpochMillis(
            response.updatedAt,
            "assistant.chatOrder.updatedAt",
          );
      updateDesktopProfileInRoot(
        getDesktopConfigRoot(app, platform as NodeJS.Platform),
        { navigation: { chatSortMode: sortMode } },
      );
      await assistantNavigationStatusClient?.refreshNow?.();
      return {
        ok: true,
        sortMode,
        message: t("assistant.chatOrderSaved"),
        ...(updatedAt === undefined ? {} : { updatedAt }),
      };
    } catch (error) {
      console.warn("[assistant] failed to update chat order", error);
      return {
        ok: false,
        sortMode: previousMode,
        message: error instanceof Error
          ? error.message
          : t("assistant.chatOrderSaveFailed"),
      };
    }
  });

  ipcMain.handle("assistant.reorderProjects", async (
    _event: unknown,
    input: AssistantReorderProjectsRequest,
  ): Promise<AssistantReorderProjectsResult> => {
    const requestedAgentKeys = input && typeof input === "object" && !Array.isArray(input)
      ? input.agentKeys
      : undefined;
    try {
      const normalizedRequestedAgentKeys = validateProjectAgentOrderRequestKeys(
        requestedAgentKeys,
      );
      if (!callAgentPlatform) {
        return {
          ok: false,
          agentKeys: [],
          message: t("assistant.projectOrderUnavailable"),
        };
      }
      const projectAgents = await callAgentPlatform(
        app,
        "/api/agents?scope=nav&mode=CODER&mode=KBASE",
      );
      const agentOrder = await callAgentPlatform(app, "/api/agents/order");
      const plan = createProjectAgentOrderPlan({
        requestedProjectAgentKeys: normalizedRequestedAgentKeys,
        currentProjectAgentKeys: readAgentCatalogKeys(
          projectAgents,
          "assistant.projectOrder.projects",
        ),
        fullAgentKeys: readAgentOrderKeys(
          agentOrder,
          "assistant.projectOrder.agentOrder",
        ),
      });
      const response = await callAgentPlatform(
        app,
        "/api/agents/order",
        { method: "PUT", body: { order: plan.fullAgentKeys } },
      ) as Record<string, unknown> | null;
      const savedAgentKeys = readAgentOrderKeys(
        response,
        "assistant.projectOrder.savedOrder",
      );
      const plannedProjectKeySet = new Set(plan.projectAgentKeys);
      const savedProjectAgentKeys = savedAgentKeys.filter((key) =>
        plannedProjectKeySet.has(key)
      );
      if (savedProjectAgentKeys.length !== plan.projectAgentKeys.length) {
        throw new Error("saved Agent order is missing a Project agent");
      }
      const updatedAt = response?.updatedAt === undefined || response.updatedAt === null
        ? undefined
        : requireEpochMillis(
            response.updatedAt,
            "assistant.projectOrder.updatedAt",
          );
      assistantNavigationStatusClient?.scheduleRefresh?.(0);
      return {
        ok: true,
        agentKeys: savedProjectAgentKeys,
        message: t("assistant.projectOrderSaved"),
        ...(updatedAt === undefined ? {} : { updatedAt }),
      };
    } catch (error) {
      console.warn("[assistant] failed to reorder projects", error);
      return {
        ok: false,
        agentKeys: [],
        message: error instanceof Error
          ? error.message
          : t("assistant.projectOrderSaveFailed"),
      };
    }
  });

  ipcMain.handle("assistant.getNavigationLiveStatus", () =>
    assistantNavigationStatusClient?.getLiveStatus?.() ?? {
      phase: "idle",
      source: "desktop-nav",
      endpoint: null,
      connectedAt: null,
      lastMessageAt: null,
      lastRefreshAt: null,
      lastPushType: null,
      lastError: null,
      recentFrames: [],
    },
  );

  ipcMain.handle("assistant.listCopilotAgents", async (): Promise<any> => {
    try {
      return await assistantBridge.listCopilotAgents();
    } catch (error) {
      console.warn("[assistant] failed to list copilot agents", error);
      if (isTimeContractViolation(error)) {
        throw error;
      }
      return {
        ok: false,
        items: [],
        chatItems: [],
        chatItemsHasMore: false,
        message: error instanceof Error ? error.message : t("assistant.agentPlatformUnavailable"),
        updatedAt: nowEpochMillis()
      };
    }
  });

  ipcMain.handle("assistant.createProject", async (_event: any, input: any): Promise<any> =>
    createProject(input)
  );

  ipcMain.handle("assistant.createCoderProject", async (_event: any, input: any): Promise<any> =>
    createProject({
      ...(
        input && typeof input === "object" && !Array.isArray(input)
          ? input
          : {}
      ),
      projectType: "coder"
    })
  );

  // ---------------------------------------------------------------------------
  // assistant — memory (legacy stub + bridge delegates)
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.openMemoryDirectory", async () => ({
    ok: false,
    message: t("assistant.memoryManagedByAgentPlatform"),
    path: ""
  }));

  ipcMain.handle("assistant.listMemoryItems", async () =>
    assistantBridge?.listMemoryItems()
  );

  ipcMain.handle("assistant.deleteMemoryItem", async (_event: any, memoryId: string) =>
    assistantBridge?.deleteMemoryItem(memoryId)
  );

  ipcMain.handle("assistant.clearMemoryItems", async () =>
    assistantBridge?.clearMemoryItems()
  );

  // ---------------------------------------------------------------------------
  // assistant — chats
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.listChats", async () =>
    assistantBridge?.listChats()
  );

  ipcMain.handle("assistant.listHistoryChats", async () =>
    assistantBridge?.listHistoryChats()
  );

  ipcMain.handle("assistant.getChat", async (_event: any, chatId: string) =>
    assistantBridge?.getChat(chatId)
  );

  ipcMain.handle("assistant.getChatInfo", async (_event: any, chatId: string) =>
    assistantBridge?.getChatInfo(chatId)
  );

  ipcMain.handle("assistant.searchChats", async (_event: any, request: any) =>
    assistantBridge?.searchChats(request)
  );

  ipcMain.handle("assistant.deleteChat", async (_event: any, chatId: string) => {
    const result = await assistantBridge.deleteChat(chatId);
    if (result.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });

  ipcMain.handle("assistant.markAgentChatsRead", async (_event: any, agentKey: string) => {
    const result = await assistantBridge?.markAgentChatsRead(agentKey);
    if (result?.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });

  ipcMain.handle("assistant.markChatRead", async (_event: any, chatId: string, runId?: string) => {
    const result = await assistantBridge?.markChatRead(chatId, runId);
    if (result?.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });

  ipcMain.handle("assistant.renameChat", async (_event: any, chatId: string, chatName: string) => {
    const result = await assistantBridge?.renameChat(chatId, chatName);
    if (result?.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });

  ipcMain.handle("assistant.archiveChat", async (_event: any, chatId: string) => {
    const result = await assistantBridge?.archiveChat(chatId);
    if (result?.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });

  ipcMain.handle("assistant.exportChat", async (_event: any, chatId: string) =>
    saveAssistantChatExport(assistantBridge, chatId, app, platform)
  );

  ipcMain.handle("assistant.exportChatHtml", async (_event: any, chatId: string) =>
    saveConversationHtmlExport(app, conversationHtmlRenderer, chatId, platform)
  );

  ipcMain.handle("assistant.shareChat", async (_event: any, request: AssistantConversationShareRequest) =>
    createConversationShare(app, conversationHtmlRenderer, conversationShareClient, request)
  );

  ipcMain.handle("assistant.listChatShares", async (_event: any, chatId: string) =>
    listConversationShares(app, conversationShareClient, chatId)
  );

  ipcMain.handle("assistant.revokeChatShare", async (_event: any, shareId: string) =>
    revokeConversationShare(app, conversationShareClient, shareId)
  );

  // ---------------------------------------------------------------------------
  // assistant — attachments
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.pickAttachments", async (_event: any, chatId?: string | null) => {
    const result = await showFileDialog?.({
      title: t("dialog.chooseAttachment.title", { appName: PRODUCT_NAME }),
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: t("assistant.attachmentFilter.readable"),
          extensions: [
            "txt", "md", "csv", "json", "jsonl", "log", "html", "xml",
            "yml", "yaml", "png", "jpg", "jpeg", "webp", "gif",
            "pdf", "docx", "xlsx", "pptx"
          ]
        },
        { name: t("assistant.attachmentFilter.all"), extensions: ["*"] }
      ]
    }, mainWindow);
    if (!result || result.canceled || result.filePaths.length === 0) {
      return { ok: false, chatId: chatId ?? "", message: t("attachment.cancelled"), attachments: [] };
    }
    return createAssistantAttachmentsFromFiles?.(app, chatId, result.filePaths, {
      onProgress: emitAssistantAttachmentProgress
    });
  });

  ipcMain.handle("assistant.cancelAttachmentTask", async (_event: any, taskId: string) =>
    cancelAssistantAttachmentTask?.(taskId)
  );

  ipcMain.handle(
    "assistant.addPastedImage",
    async (_event: any, chatId: string | null | undefined, input: any) =>
      createAssistantAttachmentFromPastedImage?.(app, chatId, input)
  );

  ipcMain.handle("assistant.captureScreenshot", async (_event: any, chatId?: string | null) =>
    captureAssistantScreenshot?.(chatId)
  );

  ipcMain.handle("assistant.openAttachment", async (_event: any, chatId: string, attachmentId: string) => {
    try {
      const attachmentPath = resolveAssistantAttachmentPath?.(app, chatId, attachmentId) ?? "";
      const error = await shell?.openPath(attachmentPath) ?? "";
      return {
        ok: !error,
        message: error ? t("attachment.openFailed", { message: error }) : t("attachment.opened"),
        path: attachmentPath
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        path: ""
      };
    }
  });

  // ---------------------------------------------------------------------------
  // assistant — run lifecycle
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.startRun", async (_event: any, request: any) =>
    assistantBridge?.startRun(request)
  );

  ipcMain.handle("assistant.stopRun", async (_event: any, runId: string) =>
    assistantBridge?.stopRun(runId)
  );

  ipcMain.handle("assistant.correctVoiceText", async (_event: any, request: any) =>
    assistantBridge?.correctVoiceText(request)
  );

  ipcMain.handle("assistant.transcribeVoiceAudio", async (_event: any, request: any) =>
    assistantBridge?.transcribeVoiceAudio(request)
  );

  ipcMain.handle("assistant.submitAwaiting", async (_event: any, request: any) =>
    assistantBridge?.submitAwaiting(request)
  );

  // ---------------------------------------------------------------------------
  // desktopActions
  // ---------------------------------------------------------------------------
  ipcMain.handle("desktopActions.respond", async (_event: any, response: any) => {
    const requestId = typeof response?.requestId === "string" ? response.requestId : "";
    if (!requestId) return { ok: false };
    const pending = desktopActionRendererRequests.get(requestId);
    if (!pending) return { ok: false };
    desktopActionRendererRequests.delete(requestId);
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    pending.resolve(response);
    return { ok: true };
  });

  ipcMain.handle("desktopActions.respondConfirmation", async (_event: any, response: any) => {
    const requestId = typeof response?.requestId === "string" ? response.requestId : "";
    if (!requestId) return { ok: false };
    const pending = desktopActionConfirmationRequests.get(requestId);
    if (!pending) return { ok: false };
    desktopActionConfirmationRequests.delete(requestId);
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    pending.resolve(response);
    return { ok: true };
  });

  ipcMain.handle("desktopActions.openWorkbench", async () =>
    openDesktopActionWorkbenchWindow?.() ?? { ok: false }
  );

  ipcMain.handle("desktopActions.closeWorkbench", async () =>
    closeDesktopActionWorkbenchWindow?.() ?? { ok: false }
  );

  ipcMain.handle("desktopActions.list", async () => ({
    ok: true,
    actions: DESKTOP_ACTION_DEFINITIONS
  }));

  ipcMain.handle("desktopActions.call", async (_event: any, request: any) =>
    handleDesktopActionRequest?.(desktopActionOptions, request)
  );
}
