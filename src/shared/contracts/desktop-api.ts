import type { DesktopActionCallRequest, DesktopActionCallResponse, DesktopActionDefinition } from "../desktop-actions";
import type { DesktopLogTarget, ServiceId, ServiceState, ServiceCommandResult, ServiceConfigReadResult, ServiceImportResult, ServiceLogsMeta, ServiceLogReadOptions, ServiceLogReadResult, ServiceLogStreamListener, ServiceLogStreamOptions, ServiceLogTarget, ServiceOpenLogViewerRequest, ServiceRevealPathOptions, ServiceRevealPathResult, TunnelHubSettings, TunnelHubSettingsInput, TunnelHubSettingsResult, TunnelHubRuntimeCommandResult, TunnelHubRuntimeStatus, PluginSettingsReadResult, PluginSettingsValues, PluginSettingsWriteResult, PluginSettingsPageResult } from "./services";
import type { PluginInstallResult } from "./manifest";
import type { NavigateListener, ServicesChangedListener, StartupRestoreState, StartupRestoreStateListener } from "./startup";
import type { WebListResult, WebappCommandResult, WebappLogReadOptions, WebappLogReadResult, WebappLogTarget, WebappStatusResult, WebsiteDeleteResult, WebsiteInput, WebsiteItemsResult, WebsiteResult, WebsiteTransferResult, WebsiteUpdateInput } from "./webs";
import type { DesktopPetAgentOption, DesktopPetSettings, DesktopPetSettingsInput, DesktopPetSignatureRequestedListener, DesktopPetState, DesktopPetStateListener, DesktopPetWindowMode } from "./pet-copilot";
import type { MarketCommandResult, MarketFavoriteInput, MarketFavoriteResult, MarketListOptions, MarketListResult, MarketSettings, MarketSettingsInput, SandboxImageImportProgressEvent } from "./marketplace";
import type { TaskBoardChangedListener, TaskBoardCloudConfig, TaskBoardCloudConfigResult, TaskBoardDeleteResult, TaskBoardDesktopOnlineResult, TaskBoardIssueInput, TaskBoardIssueMoveInput, TaskBoardIssueResult, TaskBoardIssueUpdateInput, TaskBoardListResult, TaskBoardSettingsInput, TaskBoardSettingsResult } from "./task-board";
import type { AssistantAttachmentCancelResult, AssistantAttachmentPickResult, AssistantAttachmentProgressListener } from "./attachments";
import type { AssistantChatDetail, AssistantChatSummary, AssistantCreateCoderProjectRequest, AssistantCreateCoderProjectResult, AssistantEventListener, AssistantMemoryItem, AssistantMemorySettings, AssistantMemorySettingsInput, AssistantMemoryStats, AssistantMemoryStorage, AssistantMemorySummary, AssistantNavActionResult, AssistantNavAgentItemsResult, AssistantNavigationAgentsChangedListener, AssistantPastedImageInput, AssistantSettingsInput, AssistantSettingsPublic, AssistantStartRunRequest, AssistantStartRunResult, AssistantStopRunResult, AssistantSubmitAwaitingRequest, AssistantSubmitAwaitingResult, AssistantVoiceCorrectionRequest, AssistantVoiceCorrectionResult, AssistantVoiceTranscriptionRequest, AssistantVoiceTranscriptionResult, AssistantWorkerOpenListener, DesktopActionCallListener, DesktopActionRendererResponse, DesktopPageContextSnapshot, WebviewOpenTabListener } from "./copilot";
import type { LocaleSettings, SupportedLocale } from "../i18n";
import type { DesktopCopilotPagePreferences } from "../assistant-settings";

export type AgentAuthRefreshReason = "missing" | "unauthorized";

export interface AgentAuthIssueResult {
  ok: boolean;
  token: string;
  message: string;
}

export interface IdentityAccessTokenInspection {
  ok: boolean;
  message: string;
  token: string;
  header: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  claims: {
    subject: string;
    issuer: string;
    audience: string;
    scope: string;
    deviceId: string;
    issuedAt: string;
    expiresAt: string;
    expired: boolean;
  };
  parseError?: string;
}

export interface TunnelDebugSnapshot {
  status: TunnelHubRuntimeStatus;
  capturedAt: string;
}

export interface DesktopWsProbeFrame {
  requestType: "session.hello" | "runtime.info";
  ok: boolean;
  frame: Record<string, unknown> | null;
  message: string;
}

export interface DesktopWsProbeResult {
  ok: boolean;
  target: "localDebug" | "remoteUpstream";
  url: string;
  message: string;
  frames: DesktopWsProbeFrame[];
}

export interface DesktopSsoClaims {
  sub: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
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
  browserLabel?: string;
  openMode?: "embedded" | "system";
  status: DesktopSsoStatus;
  message: string;
}

export interface DesktopSsoLogoutResult {
  ok: boolean;
  logoutUrl?: string;
  browserUrl?: string;
  browserOrigin?: string;
  browserLabel?: string;
  openMode?: "embedded" | "system";
  status: DesktopSsoStatus;
  message: string;
}

export interface DesktopSsoSiteTokenBridgeStartResult {
  ok: boolean;
  configured: boolean;
  required: boolean;
  startUrl?: string;
  browserLabel?: string;
  message: string;
}

export interface DesktopSsoCancelResult {
  ok: boolean;
  status: DesktopSsoStatus;
  message: string;
}

export interface DesktopSsoEmbeddedLoginRequest {
  url: string;
  label: string;
  partition: string;
  userAgent: string;
}

export type DesktopSsoStatusListener = (status: DesktopSsoStatus) => void;
export type DesktopSsoEmbeddedLoginListener = (request: DesktopSsoEmbeddedLoginRequest) => void;

export interface DesktopAppInfo {
  productName: string;
  version: string;
  buildTime: string;
}

export interface DesktopRuntimeEnvResetResult {
  ok: boolean;
  message: string;
  runtimeRoot: string;
  backupPath?: string;
  copiedFiles: number;
  skippedFiles: number;
  sourceZipPath?: string;
}

export interface DesktopGeneralSettings {
  preventSleepWhileRunning: boolean;
  desktopWsServerEnabled: boolean;
}

export interface DesktopGeneralSettingsInput {
  preventSleepWhileRunning?: boolean;
}

export interface DesktopWsServerState {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  path: string;
  url: string;
  message?: string;
}

export interface DesktopAppPairingPayload {
  desktopDeviceId: string;
  desktopIdentityCreatedAt: string;
  desktopUsername: string;
  desktopHostname: string;
  identityCenterIssuer: string;
  identityCenterPublicKeySha256: string;
  apiBaseUrl: string;
  pairingId: string;
  secret: string;
  expiresAt: string;
}

export type DesktopAppPairingPayloadResult =
  | { ok: true; payload: DesktopAppPairingPayload; payloadText: string }
  | { ok: false; message: string };

export type NativeDialogVisibilityListener = (state: { open: boolean }) => void;
export type SandboxImageImportProgressListener = (event: SandboxImageImportProgressEvent) => void;
export type LocaleChangedListener = (settings: LocaleSettings) => void;
export type DesktopConfigChangedEvent = {
  reason: string;
  changedAt: string;
};
export type DesktopConfigChangedListener = (event: DesktopConfigChangedEvent) => void;

export interface RendererDiagnosticReport {
  source: "window-error" | "unhandledrejection" | "react-error-boundary";
  message: string;
  stack?: string;
  componentStack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}

export interface DesktopApi {
  shell: {
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  };
  desktopDialog: {
    selectDirectory: () => Promise<{ ok: boolean; path?: string; message?: string }>;
  };
  desktopShell: {
    openPath: (targetPath: string) => Promise<{ ok: boolean; path?: string; message?: string }>;
    moveWindowBy: (delta: { x: number; y: number }) => Promise<{ ok: boolean; message?: string }>;
    beginWindowDrag: (point: { x: number; y: number }) => Promise<{ ok: boolean; message?: string }>;
    endWindowDrag: () => Promise<{ ok: boolean; message?: string }>;
  };
  desktopDownloads: {
    saveFile: (input: {
      filename?: string;
      mimeType?: string;
      dataBase64?: string;
    }) => Promise<{ ok: boolean; path?: string; message?: string }>;
  };
  desktopScreenshot: {
    capture: () => Promise<{
      ok: boolean;
      message?: string;
      dataBase64?: string;
      mimeType?: string;
      width?: number;
      height?: number;
      sizeBytes?: number;
      cancelled?: boolean;
    }>;
  };
  clipboard: {
    writeText: (text: string) => Promise<{ ok: boolean; message?: string }>;
  };
  taskBoard: {
    listIssues: () => Promise<TaskBoardListResult>;
    listOnlineDevices: () => Promise<TaskBoardDesktopOnlineResult>;
    getSettings: () => Promise<TaskBoardSettingsResult>;
    saveSettings: (input: TaskBoardSettingsInput) => Promise<TaskBoardSettingsResult>;
    getCloudConfig: () => Promise<TaskBoardCloudConfigResult>;
    saveCloudConfig: (input: TaskBoardCloudConfig) => Promise<TaskBoardCloudConfigResult>;
    createIssue: (input: TaskBoardIssueInput) => Promise<TaskBoardIssueResult>;
    updateIssue: (id: string, input: TaskBoardIssueUpdateInput) => Promise<TaskBoardIssueResult>;
    deleteIssue: (id: string) => Promise<TaskBoardDeleteResult>;
    moveIssue: (input: TaskBoardIssueMoveInput) => Promise<TaskBoardIssueResult>;
    syncIssueAutomation: (issueId: string) => Promise<TaskBoardIssueResult>;
    onChanged: (listener: TaskBoardChangedListener) => () => void;
  };
  assistant: {
    getSettings: () => Promise<AssistantSettingsPublic>;
    saveSettings: (input: AssistantSettingsInput) => Promise<AssistantSettingsPublic>;
    getMemorySettings: () => Promise<AssistantMemorySettings>;
    saveMemorySettings: (input: AssistantMemorySettingsInput) => Promise<AssistantMemorySettings>;
    getMemorySummary: () => Promise<AssistantMemorySummary>;
    listAgents: () => Promise<DesktopPetAgentOption[]>;
    listNavigationAgents: () => Promise<AssistantNavAgentItemsResult>;
    listCopilotAgents: () => Promise<AssistantNavAgentItemsResult>;
    createCoderProject: (input: AssistantCreateCoderProjectRequest) => Promise<AssistantCreateCoderProjectResult>;
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
    invokePluginAction: (serviceId: ServiceId, actionId: string) => Promise<ServiceCommandResult>;
    readPluginSettings: (serviceId: ServiceId) => Promise<PluginSettingsReadResult>;
    writePluginSettings: (serviceId: ServiceId, values: PluginSettingsValues) => Promise<PluginSettingsWriteResult>;
    openPluginSettingsPage: (serviceId: ServiceId) => Promise<PluginSettingsPageResult>;
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
    openAgentPlatformMonitor: () => Promise<{ ok: boolean; message?: string }>;
    revealPath: (targetPath: string, options?: ServiceRevealPathOptions) => Promise<ServiceRevealPathResult>;
    closeLogViewer: () => Promise<{ ok: boolean }>;
    minimizeLogViewer: () => Promise<{ ok: boolean }>;
    maximizeLogViewer: () => Promise<{ ok: boolean }>;
    onLogViewerMaximized: (listener: (maximized: boolean) => void) => () => void;
    importEnvZip: () => Promise<{ ok: boolean; message: string }>;
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
    list: (options?: MarketListOptions) => Promise<MarketListResult>;
    refresh: (options?: MarketListOptions) => Promise<MarketListResult>;
    toggleFavorite: (input: MarketFavoriteInput) => Promise<MarketFavoriteResult>;
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
  agentAuth: {
    issueAccessToken: (reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;
  };
  tunnelHub: {
    getStatus: () => Promise<TunnelHubRuntimeStatus>;
    start: () => Promise<TunnelHubRuntimeCommandResult>;
    stop: () => Promise<TunnelHubRuntimeCommandResult>;
    restart: () => Promise<TunnelHubRuntimeCommandResult>;
    readLog: (options?: ServiceLogReadOptions) => Promise<ServiceLogReadResult>;
  };
  sso: {
    getStatus: () => Promise<DesktopSsoStatus>;
    startLogin: () => Promise<DesktopSsoStartResult>;
    cancelLogin: () => Promise<DesktopSsoCancelResult>;
    logout: () => Promise<DesktopSsoLogoutResult>;
    onStatusChanged: (listener: DesktopSsoStatusListener) => () => void;
    onEmbeddedLoginOpen: (listener: DesktopSsoEmbeddedLoginListener) => () => void;
  };
  settings: {
    getDataRoot: () => Promise<string>;
    getPlatform: () => Promise<string>;
    getAppInfo: () => Promise<DesktopAppInfo>;
    getDesktopWsServerState: () => Promise<DesktopWsServerState>;
    setDesktopWsServerEnabled: (enabled: boolean) => Promise<DesktopWsServerState>;
    getGeneralSettings: () => Promise<DesktopGeneralSettings>;
    saveGeneralSettings: (input: DesktopGeneralSettingsInput) => Promise<DesktopGeneralSettings>;
    getTunnelHubSettings: () => Promise<TunnelHubSettings>;
    saveTunnelHubSettings: (input: TunnelHubSettingsInput) => Promise<TunnelHubSettingsResult>;
    resetRuntimeEnv: () => Promise<DesktopRuntimeEnvResetResult>;
    getThemePreference: () => Promise<"light" | "dark" | "system">;
    getNavigationPreferences: () => Promise<{ mainOrder: string[]; webOrder: string[]; desktopCopilotPages: DesktopCopilotPagePreferences }>;
    saveNavigationPreferences: (input: { mainOrder?: string[]; webOrder?: string[] }) => Promise<{ mainOrder: string[]; webOrder: string[]; desktopCopilotPages: DesktopCopilotPagePreferences }>;
    setNativeThemeSource: (themeMode: "light" | "dark" | "system") => Promise<{ ok: boolean; themeSource: "light" | "dark" | "system" }>;
    getInitialLocale: () => LocaleSettings;
    getLocale: () => Promise<LocaleSettings>;
    setLocale: (locale: SupportedLocale) => Promise<LocaleSettings>;
    createAppPairingPayload: () => Promise<DesktopAppPairingPayloadResult>;
    onLocaleChanged: (listener: LocaleChangedListener) => () => void;
    onDesktopConfigChanged: (listener: DesktopConfigChangedListener) => () => void;
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
  diagnostics: {
    reportRendererError: (report: RendererDiagnosticReport) => void;
    openDesktopLogViewer: (target: DesktopLogTarget) => Promise<{ ok: boolean }>;
    revealDesktopLogFolder: () => Promise<ServiceRevealPathResult>;
    readDesktopLog: (
      target: DesktopLogTarget,
      options?: ServiceLogReadOptions
    ) => Promise<ServiceLogReadResult>;
    watchDesktopLog: (
      target: DesktopLogTarget,
      options: ServiceLogStreamOptions | undefined,
      listener: ServiceLogStreamListener
    ) => () => void;
    inspectIdentityAccessToken: (input?: {
      reason?: AgentAuthRefreshReason;
    }) => Promise<IdentityAccessTokenInspection>;
    getTunnelDebugSnapshot: () => Promise<TunnelDebugSnapshot>;
    probeDesktopWs: (input: { target: "localDebug" | "remoteUpstream" }) => Promise<DesktopWsProbeResult>;
  };
  desktopPet: {
    getSettings: () => Promise<DesktopPetSettings>;
    getState: () => Promise<DesktopPetState>;
    saveSettings: (input: DesktopPetSettingsInput) => Promise<DesktopPetState>;
    show: () => Promise<DesktopPetState>;
    hide: () => Promise<DesktopPetState>;
    openAssistant: () => Promise<{ ok: boolean }>;
    openTaskChat: (input: { agentKey: string; chatId: string }) => Promise<{ ok: boolean; message?: string }>;
    moveBy: (delta: { x: number; y: number }) => Promise<{ ok: boolean }>;
    beginDrag: (point: { x: number; y: number }) => Promise<{ ok: boolean }>;
    endDrag: () => Promise<{ ok: boolean; moved: boolean }>;
    setPreviewExpanded: (expanded: boolean) => Promise<{ ok: boolean }>;
    dismissPreview: () => Promise<{ ok: boolean }>;
    replyMessage: (input: { chatId: string; agentKey?: string; message: string }) => Promise<{ ok: boolean; message?: string; chatId?: string; runId?: string }>;
    dismissMessage: (input: { chatId: string; runId?: string | null; updatedAt?: string }) => Promise<{ ok: boolean }>;
    setMouseInteractive: (interactive: boolean) => Promise<{ ok: boolean }>;
    setWindowMode: (mode: DesktopPetWindowMode) => Promise<{ ok: boolean }>;
    onStateChanged: (listener: DesktopPetStateListener) => () => void;
    onSignatureRequested: (listener: DesktopPetSignatureRequestedListener) => () => void;
  };
  quickAssistant: {
    hide: () => Promise<{ ok: boolean }>;
    openControlCenter: () => Promise<{ ok: boolean }>;
  };
  webs: {
    list: () => Promise<WebListResult>;
    websites: {
      list: () => Promise<WebsiteItemsResult>;
      add: (input: WebsiteInput) => Promise<WebsiteResult>;
      update: (id: string, input: WebsiteUpdateInput) => Promise<WebsiteResult>;
      remove: (id: string) => Promise<WebsiteDeleteResult>;
      import: () => Promise<WebsiteTransferResult>;
      export: () => Promise<WebsiteTransferResult>;
    };
    webapps: {
      start: (id: string) => Promise<WebappCommandResult>;
      stop: (id: string) => Promise<WebappCommandResult>;
      restart: (id: string) => Promise<WebappCommandResult>;
      getStatus: (id: string) => Promise<WebappStatusResult>;
      readLog: (
        id: string,
        target: WebappLogTarget,
        options?: WebappLogReadOptions
      ) => Promise<WebappLogReadResult>;
    };
  };
  onNavigate: (listener: NavigateListener) => () => void;
  onServicesChanged: (listener: ServicesChangedListener) => () => void;
  onStartupRestoreState: (listener: StartupRestoreStateListener) => () => void;
  onOpenAssistantWorker: (listener: AssistantWorkerOpenListener) => () => void;
  onWebviewOpenTab: (listener: WebviewOpenTabListener) => () => void;
  onNativeDialogVisibility: (listener: NativeDialogVisibilityListener) => () => void;
}
