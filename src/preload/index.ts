import { contextBridge, ipcRenderer } from "electron";
import type {
  AssistantEvent,
  AssistantChatOrderMutationRequest,
  AssistantChatSearchRequest,
  AssistantConversationShareRequest,
  AssistantCreateCoderProjectRequest,
  AssistantCreateProjectRequest,
  AssistantEventListener,
  AssistantNavigationAgentsChangedListener,
  AssistantNavigationListOptions,
  AssistantNavigationPushEventListener,
  AssistantReorderProjectsRequest,
  AssistantAttachmentProgressListener,
  AssistantMemorySettingsInput,
  AssistantPastedImageInput,
  AssistantSettingsInput,
  AssistantSubmitAwaitingRequest,
  AssistantStartRunRequest,
  AssistantVoiceCorrectionRequest,
  AssistantVoiceTranscriptionRequest,
  DesktopActionCallListener,
  DesktopActionRendererResponse,
  DesktopPetSignatureRequestedListener,
  DesktopSsoEmbeddedLoginListener,
  DesktopSsoStatusListener,
  AssistantWorkerOpenListener,
  AssistantWorkerOpenRequest,
  DesktopConfigChangedListener,
  DesktopActionConfirmationListener,
  DesktopActionConfirmationResponse,
  EnterpriseChatSnapshotListener,
  DesktopWindowStateListener,
  DesktopGlobalSearchShortcutListener,
  DesktopWorkPanelCloseShortcutListener,
  ShutdownProgressListener,
  DesktopPetStateListener,
  DesktopLogTarget,
  DesktopApi,
  LocaleChangedListener,
  NavigateListener,
  NativeDialogVisibilityListener,
  RendererDiagnosticReport,
  SandboxImageImportProgressListener,
  ServicesChangedListener,
  ServiceId,
  ServiceRevealPathOptions,
  ServiceOpenLogViewerRequest,
  ServiceLogReadOptions,
  ServiceLogStreamEvent,
  ServiceLogStreamListener,
  ServiceLogStreamOptions,
  ServiceLogTarget,
  StartupRestoreState,
  StartupRestoreStateListener,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanRunIssueInput,
  KanbanIssueUpdateInput,
  KanbanChangedListener,
  KanbanCloudConfig,
  WebsChangedListener,
  WebviewOpenTabListener,
  WebviewOpenTabRequest,
  ChatWorkPanelTabContextMenuPopupRequest,
  SidebarContextMenuPopupRequest,
  WebviewSelectionToolbarStateListener
} from "../shared/contracts";
import { SIDEBAR_CONTEXT_MENU_POPUP_CHANNEL } from "../shared/sidebar-context-menu";
import {
  CHAT_WORK_PANEL_OPEN_LOCAL_RESOURCE_CHANNEL,
  CHAT_WORK_PANEL_REVEAL_LOCAL_RESOURCE_CHANNEL,
  CHAT_WORK_PANEL_TAB_CONTEXT_MENU_POPUP_CHANNEL,
} from "../shared/chat-work-panel-tab-context-menu";
import { WEBVIEW_SELECTION_TOOLBAR_STATE_CHANNEL } from "../shared/webview-selection-toolbar";
import {
  CANONICAL_CHAT_SYNC_REQUEST_CHANNEL,
  CANONICAL_CHAT_SYNC_RESULT_CHANNEL,
} from "../shared/canonical-chat-sync";
import type { DesktopActionCallRequest } from "../shared/desktop-actions";
import { readInitialLocaleSettingsFromArgv } from "../shared/i18n/initial-locale-args";
import { DEFAULT_LOCALE } from "../shared/i18n/locales";
import type { LocaleSettings } from "../shared/i18n/types";

const fallbackInitialLocaleSettings: LocaleSettings = {
  locale: DEFAULT_LOCALE,
  source: "default"
};
const initialLocaleSettings = readInitialLocaleSettingsFromArgv(process.argv) ?? fallbackInitialLocaleSettings;

const api: DesktopApi = {
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell.openExternal", url)
  },
  desktopDialog: {
    selectDirectory: () => ipcRenderer.invoke("desktopDialog.selectDirectory")
  },
  sidebarContextMenu: {
    popup: (request: SidebarContextMenuPopupRequest) =>
      ipcRenderer.invoke(SIDEBAR_CONTEXT_MENU_POPUP_CHANNEL, request)
  },
  chatWorkPanelTabContextMenu: {
    popup: (request: ChatWorkPanelTabContextMenuPopupRequest) =>
      ipcRenderer.invoke(CHAT_WORK_PANEL_TAB_CONTEXT_MENU_POPUP_CHANNEL, request),
    openLocalResource: (request) =>
      ipcRenderer.invoke(CHAT_WORK_PANEL_OPEN_LOCAL_RESOURCE_CHANNEL, request),
    revealLocalResource: (request) =>
      ipcRenderer.invoke(CHAT_WORK_PANEL_REVEAL_LOCAL_RESOURCE_CHANNEL, request)
  },
  desktopShell: {
    openPath: (targetPath: string) => ipcRenderer.invoke("desktopShell.openPath", targetPath),
    revealPath: (targetPath: string) => ipcRenderer.invoke("desktopShell.revealPath", targetPath),
    moveWindowBy: (delta: { x: number; y: number }) => ipcRenderer.invoke("desktopShell.moveWindowBy", delta),
    beginWindowDrag: () => ipcRenderer.invoke("desktopShell.beginWindowDrag"),
    endWindowDrag: () => ipcRenderer.invoke("desktopShell.endWindowDrag"),
    setGlobalSearchOverlayVisible: (visible: boolean) => ipcRenderer.send("desktopShell.setGlobalSearchOverlayVisible", visible),
    setWebviewModalOverlayVisible: (sourceId: string, visible: boolean) =>
      ipcRenderer.send("desktopShell.setWebviewModalOverlayVisible", sourceId, visible),
    setWorkPanelKeyboardFocusActive: (active: boolean) =>
      ipcRenderer.send("desktopShell.setWorkPanelKeyboardFocusActive", active),
    setWorkPanelFullscreenActive: (active: boolean) =>
      ipcRenderer.send("desktopShell.setWorkPanelFullscreenActive", active),
    requestWindowClose: () => ipcRenderer.send("desktopShell.requestWindowClose"),
    minimizeWindow: () => ipcRenderer.invoke("desktopShell.minimizeWindow"),
    toggleWindowMaximize: () => ipcRenderer.invoke("desktopShell.toggleWindowMaximize"),
    getWindowState: () => ipcRenderer.invoke("desktopShell.getWindowState"),
    setWindowFullScreen: (enabled: boolean) =>
      ipcRenderer.invoke("desktopShell.setWindowFullScreen", enabled),
    onWindowStateChanged: (listener: DesktopWindowStateListener) => {
      const handleWindowStateChanged = (
        _event: Electron.IpcRendererEvent,
        state: Parameters<DesktopWindowStateListener>[0]
      ) => {
        listener(state);
      };

      ipcRenderer.on("desktopShell.windowStateChanged", handleWindowStateChanged);
      return () => {
        ipcRenderer.off("desktopShell.windowStateChanged", handleWindowStateChanged);
      };
    },
    onShutdownProgress: (listener: ShutdownProgressListener) => {
      const handleShutdownProgress = (
        _event: Electron.IpcRendererEvent,
        progress: Parameters<ShutdownProgressListener>[0]
      ) => {
        listener(progress);
      };

      ipcRenderer.on("desktopShell.shutdownProgress", handleShutdownProgress);
      return () => {
        ipcRenderer.off("desktopShell.shutdownProgress", handleShutdownProgress);
      };
    }
  },
  canonicalChatSync: {
    respond: (result) => ipcRenderer.send(CANONICAL_CHAT_SYNC_RESULT_CHANNEL, result),
    onRequest: (listener) => {
      const handleRequest = (
        _event: Electron.IpcRendererEvent,
        request: Parameters<typeof listener>[0],
      ) => listener(request);
      ipcRenderer.on(CANONICAL_CHAT_SYNC_REQUEST_CHANNEL, handleRequest);
      return () => {
        ipcRenderer.off(CANONICAL_CHAT_SYNC_REQUEST_CHANNEL, handleRequest);
      };
    },
  },
  desktopDownloads: {
    saveFile: (input) => ipcRenderer.invoke("desktopDownloads.saveFile", input)
  },
  desktopScreenshot: {
    capture: () => ipcRenderer.invoke("desktopScreenshot.capture")
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke("clipboard.writeText", text)
  },
  kanban: {
    listIssues: () => ipcRenderer.invoke("kanban.listIssues"),
    resyncCloudBoard: () => ipcRenderer.invoke("kanban.resyncCloudBoard"),
    getSettings: () => ipcRenderer.invoke("kanban.getSettings"),
    saveSettings: (input) => ipcRenderer.invoke("kanban.saveSettings", input),
    getCloudConfig: () => ipcRenderer.invoke("kanban.getCloudConfig"),
    saveCloudConfig: (input: KanbanCloudConfig) => ipcRenderer.invoke("kanban.saveCloudConfig", input),
    createIssue: (input: KanbanIssueInput) => ipcRenderer.invoke("kanban.createIssue", input),
    updateIssue: (id: string, input: KanbanIssueUpdateInput) =>
      ipcRenderer.invoke("kanban.updateIssue", id, input),
    deleteIssue: (id: string) => ipcRenderer.invoke("kanban.deleteIssue", id),
    moveIssue: (input: KanbanIssueMoveInput) => ipcRenderer.invoke("kanban.moveIssue", input),
    claimIssue: (issueId: string) => ipcRenderer.invoke("kanban.claimIssue", issueId),
    runIssue: (input: KanbanRunIssueInput) => ipcRenderer.invoke("kanban.runIssue", input),
    bindHumanReferenceChat: (input: { issueId: string; stageId: string; statusId: string; chatId: string }) => ipcRenderer.invoke("kanban.bindHumanReferenceChat", input),
    unbindHumanReferenceChat: (issueChatId: string) => ipcRenderer.invoke("kanban.unbindHumanReferenceChat", issueChatId),
    syncIssueAutomation: (issueId: string) => ipcRenderer.invoke("kanban.syncIssueAutomation", issueId),
    onChanged: (listener: KanbanChangedListener) => {
      const handleKanbanChanged = () => {
        listener();
      };

      ipcRenderer.on("kanban.changed", handleKanbanChanged);
      return () => {
        ipcRenderer.off("kanban.changed", handleKanbanChanged);
      };
    }
  },
  assistant: {
    getSettings: () => ipcRenderer.invoke("assistant.getSettings"),
    consumeFirstInstallBootstrapNavigation: () =>
      ipcRenderer.invoke("assistant.consumeFirstInstallBootstrapNavigation"),
    saveSettings: (input: AssistantSettingsInput) => ipcRenderer.invoke("assistant.saveSettings", input),
    getMemorySettings: () => ipcRenderer.invoke("assistant.getMemorySettings"),
    saveMemorySettings: (input: AssistantMemorySettingsInput) =>
      ipcRenderer.invoke("assistant.saveMemorySettings", input),
    getMemorySummary: () => ipcRenderer.invoke("assistant.getMemorySummary"),
    listAgents: () => ipcRenderer.invoke("assistant.listAgents"),
    listNavigationAgents: (options?: AssistantNavigationListOptions) =>
      ipcRenderer.invoke("assistant.listNavigationAgents", options),
    updateChatOrder: (input: AssistantChatOrderMutationRequest) =>
      ipcRenderer.invoke("assistant.updateChatOrder", input),
    reorderProjects: (input: AssistantReorderProjectsRequest) =>
      ipcRenderer.invoke("assistant.reorderProjects", input),
    getNavigationLiveStatus: () => ipcRenderer.invoke("assistant.getNavigationLiveStatus"),
    listCopilotAgents: () => ipcRenderer.invoke("assistant.listCopilotAgents"),
    createProject: (input: AssistantCreateProjectRequest) =>
      ipcRenderer.invoke("assistant.createProject", input),
    createCoderProject: (input: AssistantCreateCoderProjectRequest) =>
      ipcRenderer.invoke("assistant.createCoderProject", input),
    openMemoryDirectory: () => ipcRenderer.invoke("assistant.openMemoryDirectory"),
    listMemoryItems: () => ipcRenderer.invoke("assistant.listMemoryItems"),
    deleteMemoryItem: (memoryId: string) => ipcRenderer.invoke("assistant.deleteMemoryItem", memoryId),
    clearMemoryItems: () => ipcRenderer.invoke("assistant.clearMemoryItems"),
    listChats: () => ipcRenderer.invoke("assistant.listChats"),
    listHistoryChats: () => ipcRenderer.invoke("assistant.listHistoryChats"),
    getChat: (chatId: string) => ipcRenderer.invoke("assistant.getChat", chatId),
    getChatInfo: (chatId: string) => ipcRenderer.invoke("assistant.getChatInfo", chatId),
    revealChatInFolder: (chatId: string) => ipcRenderer.invoke("assistant.revealChatInFolder", chatId),
    searchChats: (request: AssistantChatSearchRequest) => ipcRenderer.invoke("assistant.searchChats", request),
    pickAttachments: (chatId?: string | null) => ipcRenderer.invoke("assistant.pickAttachments", chatId),
    cancelAttachmentTask: (taskId: string) => ipcRenderer.invoke("assistant.cancelAttachmentTask", taskId),
    addPastedImage: (chatId: string | null | undefined, input: AssistantPastedImageInput) =>
      ipcRenderer.invoke("assistant.addPastedImage", chatId, input),
    captureScreenshot: (chatId?: string | null) => ipcRenderer.invoke("assistant.captureScreenshot", chatId),
    startRun: (request: AssistantStartRunRequest) => ipcRenderer.invoke("assistant.startRun", request),
    stopRun: (runId: string) => ipcRenderer.invoke("assistant.stopRun", runId),
    correctVoiceText: (request: AssistantVoiceCorrectionRequest) =>
      ipcRenderer.invoke("assistant.correctVoiceText", request),
    transcribeVoiceAudio: (request: AssistantVoiceTranscriptionRequest) =>
      ipcRenderer.invoke("assistant.transcribeVoiceAudio", request),
    submitAwaiting: (request: AssistantSubmitAwaitingRequest) => ipcRenderer.invoke("assistant.submitAwaiting", request),
    openAttachment: (chatId: string, attachmentId: string) =>
      ipcRenderer.invoke("assistant.openAttachment", chatId, attachmentId),
    deleteChat: (chatId: string) => ipcRenderer.invoke("assistant.deleteChat", chatId),
    markAgentChatsRead: (agentKey: string) => ipcRenderer.invoke("assistant.markAgentChatsRead", agentKey),
    markChatRead: (chatId: string, runId?: string) =>
      ipcRenderer.invoke("assistant.markChatRead", chatId, runId),
    renameChat: (chatId: string, chatName: string) => ipcRenderer.invoke("assistant.renameChat", chatId, chatName),
    archiveChat: (chatId: string) => ipcRenderer.invoke("assistant.archiveChat", chatId),
    exportChat: (chatId: string) => ipcRenderer.invoke("assistant.exportChat", chatId),
    exportChatHtml: (chatId: string) => ipcRenderer.invoke("assistant.exportChatHtml", chatId),
    shareChat: (request: AssistantConversationShareRequest) => ipcRenderer.invoke("assistant.shareChat", request),
    listChatShares: (chatId: string) => ipcRenderer.invoke("assistant.listChatShares", chatId),
    revokeChatShare: (shareId: string) => ipcRenderer.invoke("assistant.revokeChatShare", shareId),
    onNavigationAgentsChanged: (listener: AssistantNavigationAgentsChangedListener) => {
      const handleNavigationAgentsChanged = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<AssistantNavigationAgentsChangedListener>[0]
      ) => {
        listener(payload);
      };

      ipcRenderer.on("assistant.navigationAgentsChanged", handleNavigationAgentsChanged);
      return () => {
        ipcRenderer.off("assistant.navigationAgentsChanged", handleNavigationAgentsChanged);
      };
    },
    onNavigationPushEvent: (listener: AssistantNavigationPushEventListener) => {
      const handleNavigationPushEvent = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<AssistantNavigationPushEventListener>[0]
      ) => {
        listener(payload);
      };

      ipcRenderer.on("assistant.navigationPushEvent", handleNavigationPushEvent);
      return () => {
        ipcRenderer.off("assistant.navigationPushEvent", handleNavigationPushEvent);
      };
    },
    onAssistantEvent: (listener: AssistantEventListener) => {
      const handleAssistantEvent = (_event: Electron.IpcRendererEvent, payload: AssistantEvent) => {
        listener(payload);
      };

      ipcRenderer.on("assistant.event", handleAssistantEvent);
      return () => {
        ipcRenderer.off("assistant.event", handleAssistantEvent);
      };
    },
    onAttachmentProgress: (listener: AssistantAttachmentProgressListener) => {
      const handleAttachmentProgress = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<AssistantAttachmentProgressListener>[0]
      ) => {
        listener(payload);
      };

      ipcRenderer.on("assistant.attachmentProgress", handleAttachmentProgress);
      return () => {
        ipcRenderer.off("assistant.attachmentProgress", handleAttachmentProgress);
      };
    }
  },
  services: {
    list: () => ipcRenderer.invoke("services.list"),
    getStartupRestoreState: () => ipcRenderer.invoke("services.getStartupRestoreState"),
    installBuiltinFromBundle: (serviceId: ServiceId) =>
      ipcRenderer.invoke("services.installBuiltinFromBundle", serviceId),
    installBuiltin: (serviceId: ServiceId) => ipcRenderer.invoke("services.installBuiltin", serviceId),
    initialize: (serviceId: ServiceId) => ipcRenderer.invoke("services.initialize", serviceId),
    getStatus: (serviceId: ServiceId) => ipcRenderer.invoke("services.getStatus", serviceId),
    start: (serviceId: ServiceId) => ipcRenderer.invoke("services.start", serviceId),
    stop: (serviceId: ServiceId) => ipcRenderer.invoke("services.stop", serviceId),
    restart: (serviceId: ServiceId) => ipcRenderer.invoke("services.restart", serviceId),
    invokePluginAction: (serviceId: ServiceId, actionId: string) =>
      ipcRenderer.invoke("services.invokePluginAction", serviceId, actionId),
    readPluginSettings: (serviceId: ServiceId) => ipcRenderer.invoke("services.readPluginSettings", serviceId),
    writePluginSettings: (serviceId: ServiceId, values) =>
      ipcRenderer.invoke("services.writePluginSettings", serviceId, values),
    openPluginSettingsPage: (serviceId: ServiceId) =>
      ipcRenderer.invoke("services.openPluginSettingsPage", serviceId),
    readConfig: (serviceId: ServiceId, key: string) => ipcRenderer.invoke("services.readConfig", serviceId, key),
    writeConfig: (serviceId: ServiceId, key: string, content: string) =>
      ipcRenderer.invoke("services.writeConfig", serviceId, key, content),
    importFile: (serviceId: ServiceId, targetKey: string) =>
      ipcRenderer.invoke("services.importFile", serviceId, targetKey),
    getLogsMeta: (serviceId: ServiceId) => ipcRenderer.invoke("services.getLogsMeta", serviceId),
    readLog: (serviceId: ServiceId, target: ServiceLogTarget, options?: ServiceLogReadOptions) =>
      ipcRenderer.invoke("services.readLog", serviceId, target, options),
    watchLog: (
      serviceId: ServiceId,
      target: ServiceLogTarget,
      options: ServiceLogStreamOptions | undefined,
      listener: ServiceLogStreamListener
    ) => {
      const subscriptionId = `log-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const handleLogStream = (_event: Electron.IpcRendererEvent, payload: ServiceLogStreamEvent) => {
        if (payload.subscriptionId === subscriptionId) {
          listener(payload);
        }
      };

      ipcRenderer.on("services.logStream", handleLogStream);
      void ipcRenderer.invoke("services.watchLog.start", subscriptionId, serviceId, target, options);

      return () => {
        ipcRenderer.off("services.logStream", handleLogStream);
        void ipcRenderer.invoke("services.watchLog.stop", subscriptionId);
      };
    },
    openLogViewer: (request: ServiceOpenLogViewerRequest) => ipcRenderer.invoke("services.openLogViewer", request),
    openAgentPlatformMonitor: () => ipcRenderer.invoke("services.openAgentPlatformMonitor"),
    revealPath: (targetPath: string, options?: ServiceRevealPathOptions) =>
      ipcRenderer.invoke("services.revealPath", targetPath, options),
    closeLogViewer: () => ipcRenderer.invoke("services.closeLogViewer"),
    minimizeLogViewer: () => ipcRenderer.invoke("services.minimizeLogViewer"),
    maximizeLogViewer: () => ipcRenderer.invoke("services.maximizeLogViewer"),
    onLogViewerMaximized: (listener: (maximized: boolean) => void) => {
      const handleMaximized = (_event: Electron.IpcRendererEvent, maximized: boolean) => {
        listener(maximized);
      };
      ipcRenderer.on("log-viewer.maximized", handleMaximized);
      return () => {
        ipcRenderer.off("log-viewer.maximized", handleMaximized);
      };
    },
    importEnvZip: () => ipcRenderer.invoke("services.importEnvZip")
  },
  plugins: {
    install: () => ipcRenderer.invoke("plugins.install"),
    uninstall: (serviceId: ServiceId) => ipcRenderer.invoke("plugins.uninstall", serviceId)
  },
  serviceWebview: {
    getPreloadPath: () => ipcRenderer.invoke("serviceWebview.getPreloadPath"),
    getPreloadUrl: () => ipcRenderer.invoke("serviceWebview.getPreloadUrl"),
    onSelectionToolbarState: (listener: WebviewSelectionToolbarStateListener) => {
      const handleSelectionToolbarState = (
        _event: Electron.IpcRendererEvent,
        state: Parameters<WebviewSelectionToolbarStateListener>[0]
      ) => {
        listener(state);
      };
      ipcRenderer.on(WEBVIEW_SELECTION_TOOLBAR_STATE_CHANNEL, handleSelectionToolbarState);
      return () => {
        ipcRenderer.off(WEBVIEW_SELECTION_TOOLBAR_STATE_CHANNEL, handleSelectionToolbarState);
      };
    }
  },
  market: {
    getSettings: () => ipcRenderer.invoke("market.getSettings"),
    saveSettings: (input) => ipcRenderer.invoke("market.saveSettings", input),
    list: (options) => ipcRenderer.invoke("market.list", options),
    refresh: (options) => ipcRenderer.invoke("market.refresh", options),
    toggleFavorite: (input) => ipcRenderer.invoke("market.toggleFavorite", input),
    install: (itemId: string) => ipcRenderer.invoke("market.install", itemId),
    update: (itemId: string) => ipcRenderer.invoke("market.update", itemId),
    uninstall: (itemId: string) => ipcRenderer.invoke("market.uninstall", itemId),
    importSkill: () => ipcRenderer.invoke("market.importSkill"),
    importSkillFromCommand: (commandText: string) => ipcRenderer.invoke("market.importSkillFromCommand", commandText),
    importSandboxImage: () => ipcRenderer.invoke("market.importSandboxImage"),
    onSandboxImageImportProgress: (listener: SandboxImageImportProgressListener) => {
      const handleSandboxImageImportProgress = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<SandboxImageImportProgressListener>[0]
      ) => {
        listener(payload);
      };

      ipcRenderer.on("market.sandboxImageImportProgress", handleSandboxImageImportProgress);
      return () => {
        ipcRenderer.off("market.sandboxImageImportProgress", handleSandboxImageImportProgress);
      };
    },
    exportSandboxImage: (itemId: string) => ipcRenderer.invoke("market.exportSandboxImage", itemId),
    deleteSandboxImage: (itemId: string) => ipcRenderer.invoke("market.deleteSandboxImage", itemId),
    buildSandboxImage: (itemId: string) => ipcRenderer.invoke("market.buildSandboxImage", itemId)
  },
  agentAuth: {
    issueAccessToken: (reason) => ipcRenderer.invoke("agentAuth.issueAccessToken", reason)
  },
  tunnelHub: {
    getStatus: () => ipcRenderer.invoke("tunnelHub.getStatus"),
    start: () => ipcRenderer.invoke("tunnelHub.start"),
    stop: () => ipcRenderer.invoke("tunnelHub.stop"),
    restart: () => ipcRenderer.invoke("tunnelHub.restart"),
    readLog: (options) => ipcRenderer.invoke("tunnelHub.readLog", options)
  },
  sso: {
    getStatus: () => ipcRenderer.invoke("sso.getStatus"),
    startLogin: () => ipcRenderer.invoke("sso.startLogin"),
    cancelLogin: () => ipcRenderer.invoke("sso.cancelLogin"),
    logout: () => ipcRenderer.invoke("sso.logout"),
    onStatusChanged: (listener: DesktopSsoStatusListener) => {
      const handleSsoStatusChanged = (
        _event: Electron.IpcRendererEvent,
        status: Parameters<DesktopSsoStatusListener>[0]
      ) => {
        listener(status);
      };

      ipcRenderer.on("sso.statusChanged", handleSsoStatusChanged);
      return () => {
        ipcRenderer.off("sso.statusChanged", handleSsoStatusChanged);
      };
    },
    onEmbeddedLoginOpen: (listener: DesktopSsoEmbeddedLoginListener) => {
      const handleEmbeddedLoginOpen = (
        _event: Electron.IpcRendererEvent,
        request: Parameters<DesktopSsoEmbeddedLoginListener>[0]
      ) => {
        listener(request);
      };

      ipcRenderer.on("sso.embeddedLogin.open", handleEmbeddedLoginOpen);
      return () => {
        ipcRenderer.off("sso.embeddedLogin.open", handleEmbeddedLoginOpen);
      };
    }
  },
  help: {
    getSettings: () => ipcRenderer.invoke("help.getSettings")
  },
  enterpriseChat: {
    getState: () => ipcRenderer.invoke("enterpriseChat.getState"),
    refresh: () => ipcRenderer.invoke("enterpriseChat.refresh"),
    openDirectConversation: (input) =>
      ipcRenderer.invoke("enterpriseChat.openDirectConversation", input),
    openConversation: (input) =>
      ipcRenderer.invoke("enterpriseChat.openConversation", input),
    createGroup: (input) => ipcRenderer.invoke("enterpriseChat.createGroup", input),
    sendMessage: (input) => ipcRenderer.invoke("enterpriseChat.sendMessage", input),
    sendFiles: (input) => ipcRenderer.invoke("enterpriseChat.sendFiles", input),
    sendSupportBundle: (input) => ipcRenderer.invoke("enterpriseChat.sendSupportBundle", input),
    sendRawAgentChat: (input) => ipcRenderer.invoke("enterpriseChat.sendRawAgentChat", input),
    sendPastedFiles: (input) => ipcRenderer.invoke("enterpriseChat.sendPastedFiles", input),
    sendScreenshot: (input) => ipcRenderer.invoke("enterpriseChat.sendScreenshot", input),
    loadAttachment: (input) => ipcRenderer.invoke("enterpriseChat.loadAttachment", input),
    downloadAttachment: (input) =>
      ipcRenderer.invoke("enterpriseChat.downloadAttachment", input),
    executeDesktopAction: (input) =>
      ipcRenderer.invoke("enterpriseChat.executeDesktopAction", input),
    markRead: (input) => ipcRenderer.invoke("enterpriseChat.markRead", input),
    saveSelfProfile: (input) => ipcRenderer.invoke("enterpriseChat.saveSelfProfile", input),
    selectSelfAvatar: () => ipcRenderer.invoke("enterpriseChat.selectSelfAvatar"),
    clearSelfAvatar: () => ipcRenderer.invoke("enterpriseChat.clearSelfAvatar"),
    onStateChanged: (listener: EnterpriseChatSnapshotListener) => {
      const handleStateChanged = (
        _event: Electron.IpcRendererEvent,
        snapshot: Parameters<EnterpriseChatSnapshotListener>[0]
      ) => {
        listener(snapshot);
      };
      ipcRenderer.on("enterpriseChat.stateChanged", handleStateChanged);
      return () => {
        ipcRenderer.off("enterpriseChat.stateChanged", handleStateChanged);
      };
    }
  },
  settings: {
    getDataRoot: () => ipcRenderer.invoke("settings.getDataRoot"),
    getPlatform: () => ipcRenderer.invoke("settings.getPlatform"),
    getAppInfo: () => ipcRenderer.invoke("settings.getAppInfo"),
    getDeviceIdentity: () => ipcRenderer.invoke("settings.getDeviceIdentity"),
    getDesktopStateSnapshot: () => ipcRenderer.invoke("settings.getDesktopStateSnapshot"),
    getUsageProfile: () => ipcRenderer.invoke("settings.getUsageProfile"),
    getDesktopDeviceInfo: () => ipcRenderer.invoke("settings.getDesktopDeviceInfo"),
    getDesktopWsServerState: () => ipcRenderer.invoke("settings.getDesktopWsServerState"),
    setDesktopWsServerEnabled: (enabled) => ipcRenderer.invoke("settings.setDesktopWsServerEnabled", enabled),
    getGeneralSettings: () => ipcRenderer.invoke("settings.getGeneralSettings"),
    saveGeneralSettings: (input) => ipcRenderer.invoke("settings.saveGeneralSettings", input),
    getEnterpriseImSettings: () => ipcRenderer.invoke("settings.getEnterpriseImSettings"),
    setEnterpriseImEnabled: (enabled) => ipcRenderer.invoke("settings.setEnterpriseImEnabled", enabled),
    getTunnelHubSettings: () => ipcRenderer.invoke("settings.getTunnelHubSettings"),
    saveTunnelHubSettings: (input) => ipcRenderer.invoke("settings.saveTunnelHubSettings", input),
    resetRuntimeEnv: () => ipcRenderer.invoke("settings.resetRuntimeEnv"),
    getThemePreference: () => ipcRenderer.invoke("settings.getThemePreference"),
    getNavigationPreferences: () => ipcRenderer.invoke("settings.getNavigationPreferences"),
    saveNavigationPreferences: (input) => ipcRenderer.invoke("settings.saveNavigationPreferences", input),
    setNativeThemeSource: (themeMode) => ipcRenderer.invoke("settings.setNativeThemeSource", themeMode),
    getInitialLocale: () => ({ ...initialLocaleSettings }),
    getLocale: () => ipcRenderer.invoke("settings.getLocale"),
    setLocale: (locale) => ipcRenderer.invoke("settings.setLocale", locale),
    createAppPairingPayload: () => ipcRenderer.invoke("settings.createAppPairingPayload"),
    onLocaleChanged: (listener: LocaleChangedListener) => {
      const handleLocaleChanged = (
        _event: Electron.IpcRendererEvent,
        settings: Parameters<LocaleChangedListener>[0]
      ) => {
        listener(settings);
      };

      ipcRenderer.on("settings.localeChanged", handleLocaleChanged);
      return () => {
        ipcRenderer.off("settings.localeChanged", handleLocaleChanged);
      };
    },
    onDesktopConfigChanged: (listener: DesktopConfigChangedListener) => {
      const handleDesktopConfigChanged = (
        _event: Electron.IpcRendererEvent,
        event: Parameters<DesktopConfigChangedListener>[0]
      ) => {
        listener(event);
      };

      ipcRenderer.on("settings.desktopConfigChanged", handleDesktopConfigChanged);
      return () => {
        ipcRenderer.off("settings.desktopConfigChanged", handleDesktopConfigChanged);
      };
    }
  },
  desktopActions: {
    respond: (response: DesktopActionRendererResponse) => ipcRenderer.invoke("desktopActions.respond", response),
    respondConfirmation: (response: DesktopActionConfirmationResponse) =>
      ipcRenderer.invoke("desktopActions.respondConfirmation", response),
    openWorkbench: () => ipcRenderer.invoke("desktopActions.openWorkbench"),
    closeWorkbench: () => ipcRenderer.invoke("desktopActions.closeWorkbench"),
    list: () => ipcRenderer.invoke("desktopActions.list"),
    call: (request: DesktopActionCallRequest) => ipcRenderer.invoke("desktopActions.call", request),
    onCall: (listener: DesktopActionCallListener) => {
      const handleDesktopActionCall = (
        _event: Electron.IpcRendererEvent,
        request: Parameters<DesktopActionCallListener>[0]
      ) => {
        listener(request);
      };

      ipcRenderer.on("desktopActions.call", handleDesktopActionCall);
      return () => {
        ipcRenderer.off("desktopActions.call", handleDesktopActionCall);
      };
    },
    onConfirm: (listener: DesktopActionConfirmationListener) => {
      const handleDesktopActionConfirmation = (
        _event: Electron.IpcRendererEvent,
        request: Parameters<DesktopActionConfirmationListener>[0]
      ) => {
        listener(request);
      };

      ipcRenderer.on("desktopActions.confirm", handleDesktopActionConfirmation);
      return () => {
        ipcRenderer.off("desktopActions.confirm", handleDesktopActionConfirmation);
      };
    }
  },
  currentPage: {
    publishSnapshot: (snapshot) => ipcRenderer.invoke("currentPage.publishSnapshot", snapshot),
    getSnapshot: () => ipcRenderer.invoke("currentPage.getSnapshot")
  },
  embeddedCdp: {
    registerSurface: (input) => ipcRenderer.invoke("embeddedCdp.registerSurface", input),
    unregisterSurface: (input) => ipcRenderer.invoke("embeddedCdp.unregisterSurface", input),
    getSurfaceTargetState: (input) => ipcRenderer.invoke("embeddedCdp.getSurfaceTargetState", input)
  },
  chatWorkPanel: {
    clearSession: (input) => ipcRenderer.invoke("chatWorkPanel.clearSession", input),
    localFiles: {
      getReviewPreloadUrl: () => ipcRenderer.invoke("chatWorkPanel.localFiles.getReviewPreloadUrl"),
      select: (input) => ipcRenderer.invoke("chatWorkPanel.localFiles.select", input),
      claim: (input) => ipcRenderer.invoke("chatWorkPanel.localFiles.claim", input),
      release: (input) => ipcRenderer.invoke("chatWorkPanel.localFiles.release", input),
      open: (input) => ipcRenderer.invoke("chatWorkPanel.localFiles.open", input),
      reveal: (input) => ipcRenderer.invoke("chatWorkPanel.localFiles.reveal", input)
    },
    resourceImages: {
      claim: (input) => ipcRenderer.invoke("chatWorkPanel.resourceImages.claim", input),
      read: (input) => ipcRenderer.invoke("chatWorkPanel.resourceImages.read", input),
      release: (input) => ipcRenderer.invoke("chatWorkPanel.resourceImages.release", input),
      openExternal: (input) => ipcRenderer.invoke("chatWorkPanel.resourceImages.openExternal", input),
      ai: (input) => ipcRenderer.invoke("chatWorkPanel.resourceImages.ai", input),
      cancelAi: (input) => ipcRenderer.invoke("chatWorkPanel.resourceImages.cancelAi", input),
      commit: (input) => ipcRenderer.invoke("chatWorkPanel.resourceImages.commit", input),
      onChanged: (listener) => {
        const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
        ipcRenderer.on("chatWorkPanel.resourceImages.changed", handler);
        return () => ipcRenderer.off("chatWorkPanel.resourceImages.changed", handler);
      }
    }
  },
  copilot: {
    publishDevToolsTarget: (target) => ipcRenderer.invoke("copilot.publishDevToolsTarget", target)
  },
  diagnostics: {
    reportRendererError: (report: RendererDiagnosticReport) => {
      ipcRenderer.send("diagnostics.rendererError", report);
    },
    openDesktopLogViewer: (target: DesktopLogTarget) =>
      ipcRenderer.invoke("diagnostics.openDesktopLogViewer", target),
    revealDesktopLogFolder: () => ipcRenderer.invoke("diagnostics.revealDesktopLogFolder"),
    readDesktopLog: (target: DesktopLogTarget, options?: ServiceLogReadOptions) =>
      ipcRenderer.invoke("diagnostics.readDesktopLog", target, options),
    watchDesktopLog: (
      target: DesktopLogTarget,
      options: ServiceLogStreamOptions | undefined,
      listener: ServiceLogStreamListener
    ) => {
      const subscriptionId = `desktop-log-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const handleDesktopLogStream = (_event: Electron.IpcRendererEvent, payload: ServiceLogStreamEvent) => {
        if (payload.subscriptionId === subscriptionId) {
          listener(payload);
        }
      };

      ipcRenderer.on("diagnostics.desktopLogStream", handleDesktopLogStream);
      void ipcRenderer.invoke("diagnostics.watchDesktopLog.start", subscriptionId, target, options);

      return () => {
        ipcRenderer.off("diagnostics.desktopLogStream", handleDesktopLogStream);
        void ipcRenderer.invoke("diagnostics.watchDesktopLog.stop", subscriptionId);
      };
    },
    inspectIdentityAccessToken: (input) => ipcRenderer.invoke("diagnostics.inspectIdentityAccessToken", input),
    getTunnelDebugSnapshot: () => ipcRenderer.invoke("diagnostics.getTunnelDebugSnapshot"),
    probeDesktopWs: (input) => ipcRenderer.invoke("diagnostics.probeDesktopWs", input),
    openAgentRealtimeInspector: () =>
      ipcRenderer.invoke("diagnostics.openAgentRealtimeInspector"),
    openAgentRealtimeTargetDevTools: (input) =>
      ipcRenderer.invoke("diagnostics.openAgentRealtimeTargetDevTools", input),
    getAgentRealtimeDebugSnapshot: (input) =>
      ipcRenderer.invoke("diagnostics.getAgentRealtimeDebugSnapshot", input),
    clearAgentRealtimeDebugTrace: () =>
      ipcRenderer.invoke("diagnostics.clearAgentRealtimeDebugTrace")
  },
  desktopPet: {
    getSettings: () => ipcRenderer.invoke("desktopPet.getSettings"),
    getState: () => ipcRenderer.invoke("desktopPet.getState"),
    saveSettings: (input) => ipcRenderer.invoke("desktopPet.saveSettings", input),
    show: () => ipcRenderer.invoke("desktopPet.show"),
    hide: () => ipcRenderer.invoke("desktopPet.hide"),
    openAssistant: () => ipcRenderer.invoke("desktopPet.openAssistant"),
    openTaskChat: (input) => ipcRenderer.invoke("desktopPet.openTaskChat", input),
    moveBy: (delta) => ipcRenderer.invoke("desktopPet.moveBy", delta),
    beginDrag: (point) => ipcRenderer.invoke("desktopPet.beginDrag", point),
    endDrag: () => ipcRenderer.invoke("desktopPet.endDrag"),
    setPreviewExpanded: (expanded) => ipcRenderer.invoke("desktopPet.setPreviewExpanded", expanded),
    dismissPreview: () => ipcRenderer.invoke("desktopPet.dismissPreview"),
    replyMessage: (input) => ipcRenderer.invoke("desktopPet.replyMessage", input),
    dismissMessage: (input) => ipcRenderer.invoke("desktopPet.dismissMessage", input),
    setMouseInteractive: (interactive) => ipcRenderer.invoke("desktopPet.setMouseInteractive", interactive),
    setWindowMode: (mode) => ipcRenderer.invoke("desktopPet.setWindowMode", mode),
    onStateChanged: (listener: DesktopPetStateListener) => {
      const handleDesktopPetStateChanged = (
        _event: Electron.IpcRendererEvent,
        state: Parameters<DesktopPetStateListener>[0]
      ) => {
        listener(state);
      };

      ipcRenderer.on("desktopPet.state", handleDesktopPetStateChanged);
      return () => {
        ipcRenderer.off("desktopPet.state", handleDesktopPetStateChanged);
      };
    },
    onSignatureRequested: (listener: DesktopPetSignatureRequestedListener) => {
      const handleDesktopPetSignatureRequested = (
        _event: Electron.IpcRendererEvent,
        signatureId?: string
      ) => {
        listener(signatureId);
      };

      ipcRenderer.on("desktopPet.signatureRequested", handleDesktopPetSignatureRequested);
      return () => {
        ipcRenderer.off("desktopPet.signatureRequested", handleDesktopPetSignatureRequested);
      };
    }
  },
  webs: {
    list: () => ipcRenderer.invoke("webs.list"),
    onChanged: (listener: WebsChangedListener) => {
      const handleWebsChanged = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<WebsChangedListener>[0]
      ) => {
        listener(payload);
      };

      ipcRenderer.on("webs.changed", handleWebsChanged);
      return () => {
        ipcRenderer.off("webs.changed", handleWebsChanged);
      };
    },
    websites: {
      list: () => ipcRenderer.invoke("webs.websites.list"),
      add: (input) => ipcRenderer.invoke("webs.websites.add", input),
      update: (id, input) => ipcRenderer.invoke("webs.websites.update", id, input),
      remove: (id: string) => ipcRenderer.invoke("webs.websites.remove", id),
      cacheFavicon: (input) => ipcRenderer.invoke("webs.websites.cacheFavicon", input),
      import: () => ipcRenderer.invoke("webs.websites.import"),
      export: () => ipcRenderer.invoke("webs.websites.export")
    },
    webapps: {
      list: () => ipcRenderer.invoke("webs.webapps.list"),
      import: () => ipcRenderer.invoke("webs.webapps.import"),
      export: (id: string) => ipcRenderer.invoke("webs.webapps.export", id),
      update: (id: string, input) => ipcRenderer.invoke("webs.webapps.update", id, input),
      uninstall: (id: string) => ipcRenderer.invoke("webs.webapps.uninstall", id),
      start: (id: string) => ipcRenderer.invoke("webs.webapps.start", id),
      openWindow: (id: string) => ipcRenderer.invoke("webs.webapps.openWindow", id),
      listOpenWindows: () => ipcRenderer.invoke("webs.webapps.listOpenWindows"),
      stop: (id: string) => ipcRenderer.invoke("webs.webapps.stop", id),
      restart: (id: string) => ipcRenderer.invoke("webs.webapps.restart", id),
      getStatus: (id: string) => ipcRenderer.invoke("webs.webapps.getStatus", id),
      checkRuntime: (id: string) => ipcRenderer.invoke("webs.webapps.checkRuntime", id),
      getRuntimeSettings: () => ipcRenderer.invoke("webs.webapps.getRuntimeSettings"),
      saveRuntimeSettings: (input) => ipcRenderer.invoke("webs.webapps.saveRuntimeSettings", input),
      getUserConfig: (id: string) => ipcRenderer.invoke("webs.webapps.getUserConfig", id),
      saveUserConfig: (id: string, values) => ipcRenderer.invoke("webs.webapps.saveUserConfig", id, values),
      getPublishStatus: (id: string) => ipcRenderer.invoke("webs.webapps.getPublishStatus", id),
      publish: (id: string) => ipcRenderer.invoke("webs.webapps.publish", id),
      unpublish: (id: string) => ipcRenderer.invoke("webs.webapps.unpublish", id),
      readLog: (id, target, options) => ipcRenderer.invoke("webs.webapps.readLog", id, target, options)
    }
  },
  onNavigate: (listener: NavigateListener) => {
    const handleNavigate = (_event: Electron.IpcRendererEvent, path: string) => {
      listener(path);
    };

    ipcRenderer.on("app.navigate", handleNavigate);
    return () => {
      ipcRenderer.off("app.navigate", handleNavigate);
    };
  },
  onServicesChanged: (listener: ServicesChangedListener) => {
    const handleServicesChanged = () => {
      listener();
    };

    ipcRenderer.on("services.changed", handleServicesChanged);
    return () => {
      ipcRenderer.off("services.changed", handleServicesChanged);
    };
  },
  onStartupRestoreState: (listener: StartupRestoreStateListener) => {
    const handleStartupRestoreState = (_event: Electron.IpcRendererEvent, state: StartupRestoreState) => {
      listener(state);
    };

    ipcRenderer.on("services.startupRestoreState", handleStartupRestoreState);
    return () => {
      ipcRenderer.off("services.startupRestoreState", handleStartupRestoreState);
    };
  },
  onOpenGlobalSearch: (listener: () => void) => {
    const handleOpenGlobalSearch = () => {
      listener();
    };

    ipcRenderer.on("app.openGlobalSearch", handleOpenGlobalSearch);
    return () => {
      ipcRenderer.off("app.openGlobalSearch", handleOpenGlobalSearch);
    };
  },
  onGlobalSearchShortcut: (listener: DesktopGlobalSearchShortcutListener) => {
    const handleGlobalSearchShortcut = (
      _event: Electron.IpcRendererEvent,
      shortcut: Parameters<DesktopGlobalSearchShortcutListener>[0]
    ) => {
      listener(shortcut);
    };

    ipcRenderer.on("app.globalSearchShortcut", handleGlobalSearchShortcut);
    return () => {
      ipcRenderer.off("app.globalSearchShortcut", handleGlobalSearchShortcut);
    };
  },
  onWorkPanelCloseShortcut: (listener: DesktopWorkPanelCloseShortcutListener) => {
    const handleWorkPanelCloseShortcut = (
      _event: Electron.IpcRendererEvent,
      request: Parameters<DesktopWorkPanelCloseShortcutListener>[0]
    ) => {
      listener(request);
    };

    ipcRenderer.on("app.workPanelCloseShortcut", handleWorkPanelCloseShortcut);
    return () => {
      ipcRenderer.off("app.workPanelCloseShortcut", handleWorkPanelCloseShortcut);
    };
  },
  onWorkPanelFullscreenExitShortcut: (listener: () => void) => {
    ipcRenderer.on("app.workPanelFullscreenExitShortcut", listener);
    return () => {
      ipcRenderer.off("app.workPanelFullscreenExitShortcut", listener);
    };
  },
  onOpenAssistantWorker: (listener: AssistantWorkerOpenListener) => {
    const handleOpenAssistantWorker = (
      _event: Electron.IpcRendererEvent,
      request: AssistantWorkerOpenRequest
    ) => {
      listener(request);
    };

    ipcRenderer.on("app.openAssistantWorker", handleOpenAssistantWorker);
    return () => {
      ipcRenderer.off("app.openAssistantWorker", handleOpenAssistantWorker);
    };
  },
  onWebviewOpenTab: (listener: WebviewOpenTabListener) => {
    const handleWebviewOpenTab = (
      _event: Electron.IpcRendererEvent,
      request: WebviewOpenTabRequest
    ) => {
      listener(request);
    };

    ipcRenderer.on("webview.openTab", handleWebviewOpenTab);
    return () => {
      ipcRenderer.off("webview.openTab", handleWebviewOpenTab);
    };
  },
  onNativeDialogVisibility: (listener: NativeDialogVisibilityListener) => {
    const handleNativeDialogVisibility = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<NativeDialogVisibilityListener>[0]
    ) => {
      listener(state);
    };

    ipcRenderer.on("app.nativeDialogVisibility", handleNativeDialogVisibility);
    return () => {
      ipcRenderer.off("app.nativeDialogVisibility", handleNativeDialogVisibility);
    };
  }
};

window.addEventListener("error", (event) => {
  api.diagnostics.reportRendererError({
    level: "error",
    source: "window-error",
    message: event.message || "Renderer window error",
    stack: event.error instanceof Error ? event.error.stack : undefined,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  api.diagnostics.reportRendererError({
    level: "error",
    source: "unhandledrejection",
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

contextBridge.exposeInMainWorld("electronAPI", api);
