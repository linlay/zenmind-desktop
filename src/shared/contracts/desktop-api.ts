import type { DesktopActionCallRequest, DesktopActionCallResponse, DesktopActionDefinition } from "../desktop-actions";
import type { ServiceId, ServiceState, ServiceCommandResult, ServiceConfigReadResult, ServiceImportResult, ServiceLogsMeta, ServiceLogReadOptions, ServiceLogReadResult, ServiceLogStreamListener, ServiceLogStreamOptions, ServiceLogTarget, ServiceOpenLogViewerRequest, ServiceRevealPathOptions, ServiceRevealPathResult } from "./services";
import type { PluginInstallResult } from "./manifest";
import type { NavigateListener, ServicesChangedListener, StartupRestoreState, StartupRestoreStateListener } from "./startup";
import type { CustomSidebarDeleteResult, CustomSidebarItemInput, CustomSidebarItemResult, CustomSidebarItemsResult, CustomSidebarTransferResult, CustomSidebarUpdateInput } from "./navigation";
import type { DesktopPetAgentOption, DesktopPetDanceRequestedListener, DesktopPetSettings, DesktopPetSettingsInput, DesktopPetState, DesktopPetStateListener } from "./pet-copilot";
import type { MarketCommandResult, MarketListResult, MarketSettings, MarketSettingsInput, SandboxImageImportProgressEvent } from "./marketplace";
import type { TaskBoardDeleteResult, TaskBoardIssueInput, TaskBoardIssueMoveInput, TaskBoardIssueResult, TaskBoardIssueUpdateInput, TaskBoardListResult } from "./task-board";
import type { AssistantAttachmentCancelResult, AssistantAttachmentPickResult, AssistantAttachmentProgressListener } from "./attachments";
import type { AssistantChatDetail, AssistantChatSummary, AssistantEventListener, AssistantMemoryItem, AssistantMemorySettings, AssistantMemorySettingsInput, AssistantMemoryStats, AssistantMemoryStorage, AssistantMemorySummary, AssistantNavActionResult, AssistantNavAgentItemsResult, AssistantNavigationAgentsChangedListener, AssistantPastedImageInput, AssistantSettingsInput, AssistantSettingsPublic, AssistantStartRunRequest, AssistantStartRunResult, AssistantStopRunResult, AssistantSubmitAwaitingRequest, AssistantSubmitAwaitingResult, AssistantVoiceCorrectionRequest, AssistantVoiceCorrectionResult, AssistantVoiceTranscriptionRequest, AssistantVoiceTranscriptionResult, AssistantWorkerOpenListener, DesktopActionCallListener, DesktopActionRendererResponse, DesktopPageContextSnapshot, WebviewOpenTabListener } from "./copilot";

export interface PanAuthStatus {
  configured: boolean;
  path: string;
  message: string;
}

export interface PanAuthImportResult {
  ok: boolean;
  message: string;
  status: PanAuthStatus;
}

export type AgentAuthRefreshReason = "missing" | "unauthorized";

export interface AgentAuthIssueResult {
  ok: boolean;
  token: string;
  message: string;
}

export interface DesktopSsoClaims {
  sub: string;
  name?: string;
  email?: string;
  issuer: string;
  audience: string;
}

export interface DesktopSsoStatus {
  configured: boolean;
  authenticated: boolean;
  pending: boolean;
  user: DesktopSsoClaims | null;
  message: string;
  error?: string;
  updatedAt: string;
}

export interface DesktopSsoStartResult {
  ok: boolean;
  authorizeUrl?: string;
  browserUrl?: string;
  browserOrigin?: string;
  status: DesktopSsoStatus;
  message: string;
}

export interface DesktopSsoLogoutResult {
  ok: boolean;
  logoutUrl?: string;
  browserUrl?: string;
  browserOrigin?: string;
  status: DesktopSsoStatus;
  message: string;
}

export type DesktopSsoStatusListener = (status: DesktopSsoStatus) => void;

export type NativeDialogVisibilityListener = (state: { open: boolean }) => void;
export type SandboxImageImportProgressListener = (event: SandboxImageImportProgressEvent) => void;

export interface DesktopApi {
  clipboard: {
    writeText: (text: string) => Promise<{ ok: boolean; message?: string }>;
  };
  taskBoard: {
    listIssues: () => Promise<TaskBoardListResult>;
    createIssue: (input: TaskBoardIssueInput) => Promise<TaskBoardIssueResult>;
    updateIssue: (id: string, input: TaskBoardIssueUpdateInput) => Promise<TaskBoardIssueResult>;
    deleteIssue: (id: string) => Promise<TaskBoardDeleteResult>;
    moveIssue: (input: TaskBoardIssueMoveInput) => Promise<TaskBoardIssueResult>;
    syncIssueSchedule: (issueId: string) => Promise<TaskBoardIssueResult>;
  };
  assistant: {
    getSettings: () => Promise<AssistantSettingsPublic>;
    saveSettings: (input: AssistantSettingsInput) => Promise<AssistantSettingsPublic>;
    getMemorySettings: () => Promise<AssistantMemorySettings>;
    saveMemorySettings: (input: AssistantMemorySettingsInput) => Promise<AssistantMemorySettings>;
    getMemorySummary: () => Promise<AssistantMemorySummary>;
    listAgents: () => Promise<DesktopPetAgentOption[]>;
    listNavigationAgents: () => Promise<AssistantNavAgentItemsResult>;
    openMemoryDirectory: () => Promise<{ ok: boolean; message: string; path?: string }>;
    listMemoryItems: () => Promise<{
      items: AssistantMemoryItem[];
      settings: AssistantMemorySettings;
      stats: AssistantMemoryStats;
      storage: AssistantMemoryStorage;
    }>;
    deleteMemoryItem: (memoryId: string) => Promise<{ ok: boolean; message: string }>;
    clearMemoryItems: () => Promise<{ ok: boolean; message: string; deletedCount: number }>;
    listChats: () => Promise<AssistantChatSummary[]>;
    getChat: (chatId: string) => Promise<AssistantChatDetail | null>;
    pickAttachments: (chatId?: string | null) => Promise<AssistantAttachmentPickResult>;
    captureScreenshot: (chatId?: string | null) => Promise<AssistantAttachmentPickResult>;
    cancelAttachmentTask: (taskId: string) => Promise<AssistantAttachmentCancelResult>;
    addPastedImage: (
      chatId: string | null | undefined,
      input: AssistantPastedImageInput
    ) => Promise<AssistantAttachmentPickResult>;
    startRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
    stopRun: (runId: string) => Promise<AssistantStopRunResult>;
    correctVoiceText: (request: AssistantVoiceCorrectionRequest) => Promise<AssistantVoiceCorrectionResult>;
    transcribeVoiceAudio: (request: AssistantVoiceTranscriptionRequest) => Promise<AssistantVoiceTranscriptionResult>;
    submitAwaiting: (request: AssistantSubmitAwaitingRequest) => Promise<AssistantSubmitAwaitingResult>;
    openAttachment: (chatId: string, attachmentId: string) => Promise<{ ok: boolean; message: string; path?: string }>;
    deleteChat: (chatId: string) => Promise<{ ok: boolean; message: string }>;
    markAgentChatsRead: (agentKey: string) => Promise<AssistantNavActionResult>;
    renameChat: (chatId: string, chatName: string) => Promise<AssistantNavActionResult>;
    archiveChat: (chatId: string) => Promise<AssistantNavActionResult>;
    exportChat: (chatId: string) => Promise<AssistantNavActionResult>;
    onNavigationAgentsChanged: (listener: AssistantNavigationAgentsChangedListener) => () => void;
    onAssistantEvent: (listener: AssistantEventListener) => () => void;
    onAttachmentProgress: (listener: AssistantAttachmentProgressListener) => () => void;
  };
  services: {
    list: () => Promise<ServiceState[]>;
    getStartupRestoreState: () => Promise<StartupRestoreState>;
    installBuiltinFromBundle: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    installBuiltin: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    initialize: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    getStatus: (serviceId: ServiceId) => Promise<ServiceState>;
    start: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    stop: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    restart: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    readConfig: (serviceId: ServiceId, key: string) => Promise<ServiceConfigReadResult>;
    writeConfig: (serviceId: ServiceId, key: string, content: string) => Promise<ServiceCommandResult>;
    importFile: (serviceId: ServiceId, targetKey: string) => Promise<ServiceImportResult>;
    getLogsMeta: (serviceId: ServiceId) => Promise<ServiceLogsMeta>;
    readLog: (
      serviceId: ServiceId,
      target: ServiceLogTarget,
      options?: ServiceLogReadOptions
    ) => Promise<ServiceLogReadResult>;
    watchLog: (
      serviceId: ServiceId,
      target: ServiceLogTarget,
      options: ServiceLogStreamOptions | undefined,
      listener: ServiceLogStreamListener
    ) => () => void;
    openLogViewer: (request: ServiceOpenLogViewerRequest) => Promise<{ ok: boolean }>;
    revealPath: (targetPath: string, options?: ServiceRevealPathOptions) => Promise<ServiceRevealPathResult>;
    closeLogViewer: () => Promise<{ ok: boolean }>;
  };
  plugins: {
    install: () => Promise<PluginInstallResult>;
    uninstall: (serviceId: ServiceId) => Promise<PluginInstallResult>;
    getServiceWebviewPreloadPath: () => Promise<string>;
    getServiceWebviewPreloadUrl: () => Promise<string>;
  };
  market: {
    getSettings: () => Promise<MarketSettings>;
    saveSettings: (input: MarketSettingsInput) => Promise<MarketSettings>;
    list: () => Promise<MarketListResult>;
    refresh: () => Promise<MarketListResult>;
    install: (itemId: string) => Promise<MarketCommandResult>;
    update: (itemId: string) => Promise<MarketCommandResult>;
    uninstall: (itemId: string) => Promise<MarketCommandResult>;
    importSkill: () => Promise<MarketCommandResult>;
    importSkillFromCommand: (commandText: string) => Promise<MarketCommandResult>;
    importSandboxImage: () => Promise<MarketCommandResult>;
    onSandboxImageImportProgress: (listener: SandboxImageImportProgressListener) => () => void;
    exportSandboxImage: (itemId: string) => Promise<MarketCommandResult>;
    deleteSandboxImage: (itemId: string) => Promise<MarketCommandResult>;
    buildSandboxImage: (itemId: string) => Promise<MarketCommandResult>;
  };
  panAuth: {
    importPrivateKey: () => Promise<PanAuthImportResult>;
    getStatus: () => Promise<PanAuthStatus>;
  };
  agentAuth: {
    issueAccessToken: (reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;
  };
  sso: {
    getStatus: () => Promise<DesktopSsoStatus>;
    startLogin: () => Promise<DesktopSsoStartResult>;
    logout: () => Promise<DesktopSsoLogoutResult>;
    onStatusChanged: (listener: DesktopSsoStatusListener) => () => void;
  };
  settings: {
    getDataRoot: () => Promise<string>;
    getPlatform: () => Promise<string>;
    setNativeThemeSource: (themeMode: "light" | "dark") => Promise<{ ok: boolean; themeSource: "light" | "dark" | "system" }>;
  };
  desktopActions: {
    respond: (response: DesktopActionRendererResponse) => Promise<{ ok: boolean }>;
    list: () => Promise<{ ok: boolean; actions: DesktopActionDefinition[] }>;
    call: (request: DesktopActionCallRequest) => Promise<DesktopActionCallResponse>;
    onCall: (listener: DesktopActionCallListener) => () => void;
  };
  currentPage: {
    publishSnapshot: (snapshot: DesktopPageContextSnapshot) => Promise<{ ok: boolean }>;
    getSnapshot: () => Promise<DesktopPageContextSnapshot | null>;
  };
  desktopPet: {
    getSettings: () => Promise<DesktopPetSettings>;
    getState: () => Promise<DesktopPetState>;
    saveSettings: (input: DesktopPetSettingsInput) => Promise<DesktopPetState>;
    show: () => Promise<DesktopPetState>;
    hide: () => Promise<DesktopPetState>;
    openAssistant: () => Promise<{ ok: boolean }>;
    moveBy: (delta: { x: number; y: number }) => Promise<{ ok: boolean }>;
    beginDrag: (point: { x: number; y: number }) => Promise<{ ok: boolean }>;
    endDrag: () => Promise<{ ok: boolean; moved: boolean }>;
    setPreviewExpanded: (expanded: boolean) => Promise<{ ok: boolean }>;
    dismissPreview: () => Promise<{ ok: boolean }>;
    setMouseInteractive: (interactive: boolean) => Promise<{ ok: boolean }>;
    onStateChanged: (listener: DesktopPetStateListener) => () => void;
    onDanceRequested: (listener: DesktopPetDanceRequestedListener) => () => void;
  };
  quickAssistant: {
    hide: () => Promise<{ ok: boolean }>;
    openControlCenter: () => Promise<{ ok: boolean }>;
  };
  customSidebar: {
    list: () => Promise<CustomSidebarItemsResult>;
    add: (input: CustomSidebarItemInput) => Promise<CustomSidebarItemResult>;
    update: (id: string, input: CustomSidebarUpdateInput) => Promise<CustomSidebarItemResult>;
    remove: (id: string) => Promise<CustomSidebarDeleteResult>;
    import: () => Promise<CustomSidebarTransferResult>;
    export: () => Promise<CustomSidebarTransferResult>;
  };
  onNavigate: (listener: NavigateListener) => () => void;
  onServicesChanged: (listener: ServicesChangedListener) => () => void;
  onStartupRestoreState: (listener: StartupRestoreStateListener) => () => void;
  onOpenAssistantWorker: (listener: AssistantWorkerOpenListener) => () => void;
  onWebviewOpenTab: (listener: WebviewOpenTabListener) => () => void;
  onNativeDialogVisibility: (listener: NativeDialogVisibilityListener) => () => void;
}
