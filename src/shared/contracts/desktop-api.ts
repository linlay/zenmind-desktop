import type { DesktopActionCallRequest, DesktopActionCallResponse, DesktopActionDefinition } from "../desktop-actions";
import type { DesktopLogTarget, ServiceId, ServiceState, ServiceCommandResult, ServiceConfigReadResult, ServiceImportResult, ServiceLogsMeta, ServiceLogReadOptions, ServiceLogReadResult, ServiceLogStreamListener, ServiceLogStreamOptions, ServiceLogTarget, ServiceOpenLogViewerRequest, ServiceRevealPathOptions, ServiceRevealPathResult, TunnelHubSettings, TunnelHubSettingsInput, TunnelHubSettingsResult, TunnelHubRuntimeCommandResult, TunnelHubRuntimeStatus, PluginSettingsReadResult, PluginSettingsValues, PluginSettingsWriteResult, PluginSettingsPageResult } from "./services";
import type { PluginInstallResult } from "./manifest";
import type { NavigateListener, ServicesChangedListener, StartupRestoreState, StartupRestoreStateListener } from "./startup";
import type { WebListResult, WebappCommandResult, WebappDeleteResult, WebappExportResult, WebappImportResult, WebappItemsResult, WebappLogReadOptions, WebappLogReadResult, WebappLogTarget, WebappPublishResult, WebappPublishStatusResult, WebappResult, WebappRuntimeCheckResult, WebappRuntimeSettingsInput, WebappRuntimeSettingsResult, WebappStatusResult, WebappUpdateInput, WebappUserConfigResult, WebsChangedListener, WebsiteDeleteResult, WebsiteFaviconCacheInput, WebsiteFaviconCacheResult, WebsiteInput, WebsiteItemsResult, WebsiteResult, WebsiteTransferResult, WebsiteUpdateInput } from "./webs";
import type { DesktopPetAgentOption, DesktopPetSettings, DesktopPetSettingsInput, DesktopPetSignatureRequestedListener, DesktopPetState, DesktopPetStateListener, DesktopPetWindowMode } from "./pet-copilot";
import type { MarketCommandResult, MarketFavoriteInput, MarketFavoriteResult, MarketListOptions, MarketListResult, MarketSettings, MarketSettingsInput, SandboxImageImportProgressEvent } from "./marketplace";
import type { KanbanChangedListener, KanbanCloudConfig, KanbanCloudConfigResult, KanbanDeleteResult, KanbanIssueInput, KanbanIssueMoveInput, KanbanIssueResult, KanbanIssueUpdateInput, KanbanListResult, KanbanRunIssueInput, KanbanRunIssueResult, KanbanSettingsInput, KanbanSettingsResult } from "./kanban";
import type { AssistantAttachmentCancelResult, AssistantAttachmentPickResult, AssistantAttachmentProgressListener } from "./attachments";
import type { AssistantChatDetail, AssistantChatSearchRequest, AssistantChatSearchResponse, AssistantChatSummary, AssistantCreateCoderProjectRequest, AssistantCreateCoderProjectResult, AssistantCreateProjectRequest, AssistantCreateProjectResult, AssistantEventListener, AssistantMemoryItem, AssistantMemorySettings, AssistantMemorySettingsInput, AssistantMemoryStats, AssistantMemoryStorage, AssistantMemorySummary, AssistantNavActionResult, AssistantNavAgentItemsResult, AssistantNavigationAgentsChangedListener, AssistantNavigationListOptions, AssistantNavigationLiveStatus, AssistantNavigationPushEventListener, AssistantPastedImageInput, AssistantSettingsInput, AssistantSettingsPublic, AssistantStartRunRequest, AssistantStartRunResult, AssistantStopRunResult, AssistantSubmitAwaitingRequest, AssistantSubmitAwaitingResult, AssistantVoiceCorrectionRequest, AssistantVoiceCorrectionResult, AssistantVoiceTranscriptionRequest, AssistantVoiceTranscriptionResult, AssistantWorkerOpenListener, CopilotDevToolsTargetInput, DesktopActionCallListener, DesktopActionConfirmationListener, DesktopActionConfirmationResponse, DesktopActionRendererResponse, DesktopPageContextSnapshot, WebviewOpenTabListener } from "./copilot";
import type { LocaleSettings, SupportedLocale } from "../i18n";
import type {
  SidebarContextMenuPopupRequest,
  SidebarContextMenuPopupResult
} from "../sidebar-context-menu";
import type {
  ChatWorkPanelTabContextMenuPopupRequest,
  ChatWorkPanelTabContextMenuPopupResult
} from "../chat-work-panel-tab-context-menu";
import type { WebviewSelectionToolbarStateListener } from "../webview-selection-toolbar";
import type { DesktopCopilotPagePreferences } from "../assistant-settings";
import type {
  EmbeddedCdpSurfaceRegistration,
  EmbeddedCdpSurfaceRemoval,
  EmbeddedCdpSurfaceTargetStateRequest,
  EmbeddedCdpSurfaceTargetStateResult
} from "../embedded-cdp";
import type { EpochMilliseconds } from "../time-contract";
import type { ShutdownProgressListener } from "../shutdown";
import type { ChatWorkPanelClearSessionRequest } from "../chat-work-panel";
import type { DesktopHelpSettings } from "../help";
import type {
  EnterpriseChatAttachmentData,
  EnterpriseChatAttachmentInput,
  EnterpriseChatCreateGroupInput,
  EnterpriseChatDownloadResult,
  EnterpriseChatExecuteActionInput,
  EnterpriseChatExecuteActionResult,
  EnterpriseChatMarkReadInput,
  EnterpriseChatOpenConversationInput,
  EnterpriseChatOpenDirectInput,
  EnterpriseChatSaveSelfProfileInput,
  EnterpriseChatSendFilesInput,
  EnterpriseChatSendMessageInput,
  EnterpriseChatSendPastedFilesInput,
  EnterpriseChatSendScreenshotInput,
  EnterpriseChatSendSupportBundleInput,
  EnterpriseChatSnapshot,
  EnterpriseChatSnapshotListener
} from "./enterprise-chat";

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
  target: "localDebug";
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

export interface DesktopSsoCompletedSteps {
  session: boolean;
  userInfo: boolean;
  accessToken: boolean;
}

export interface DesktopSsoStatus {
  configured: boolean;
  authenticated: boolean;
  pending: boolean;
  user: DesktopSsoClaims | null;
  completedSteps: DesktopSsoCompletedSteps;
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
  browserOrigin?: string;
  browserLabel?: string;
  openMode?: "embedded" | "system";
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

export type DesktopDeviceIdentityMachineSource =
  | "darwinIOPlatformUUID"
  | "windowsMachineGuid"
  | "unavailable";

export interface DesktopDeviceIdentityInfo {
  identityPath: string;
  version: number;
  installId: string;
  deviceId: string;
  machineHash: string;
  machineSource: DesktopDeviceIdentityMachineSource;
  createdAt: string;
  updatedAt: string;
  lastMachineMismatchAt?: string;
}

export interface DesktopDeviceInfo {
  deviceId: string;
  deviceName: string;
  configuredDeviceName: string;
  hostname: string;
  username: string;
  platform: string;
  arch: string;
}

export interface DesktopUsageProfileProvider {
  providerKey: string;
  providerName: string;
  baseURL: string;
  model: string;
}

export interface DesktopUsageProfileRateLimitDefinition {
  window: string;
  request_quota: number;
  token_quota: number;
  cost_quota_micro: number;
}

export interface DesktopUsageProfileAPIKey {
  id: string;
  name: string;
  description: string;
  key_prefix: string;
  source: string;
  status: string;
  expires_at?: string | null;
  forced_expired: boolean;
  request_quota: number;
  token_quota: number;
  allowed_models: string[];
  rate_limits: DesktopUsageProfileRateLimitDefinition[];
  used_requests: number;
  used_tokens: number;
  last_used_at?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesktopUsageProfileTrafficBucket {
  bucket: string;
  requests: number;
  request_tokens: number;
  response_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  cache_total_tokens: number;
  cache_hit_rate: number | null;
  cost_micro: number;
  error_requests: number;
  average_latency_ms: number;
}

export interface DesktopUsageProfileRateLimitStatus {
  window: string;
  starts_at: string;
  resets_at: string;
  requests: number;
  request_quota: number;
  request_remaining: number;
  tokens: number;
  token_quota: number;
  token_remaining: number;
  cost_micro: number;
  cost_quota_micro: number;
  cost_remaining_micro: number;
}

export interface DesktopUsageProfileLimits {
  lifetime: {
    requests: number;
    request_quota: number;
    request_remaining: number;
    tokens: number;
    token_quota: number;
    token_remaining: number;
  };
  rate_limit_usage: DesktopUsageProfileRateLimitStatus[];
}

export interface DesktopUsageProfileBalance {
  currency: string;
  cost_micro: number;
  unlimited: boolean;
  items: DesktopUsageProfileRateLimitStatus[];
}

export interface DesktopUsageProfileLogEntry {
  id: number;
  api_key_id: string;
  api_key_name: string;
  protocol: string;
  public_model: string;
  upstream_model: string;
  provider: string;
  pool: string;
  account: string;
  device_id: string;
  source: string;
  status_code: number;
  latency_ms: number;
  request_tokens: number;
  response_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  cache_total_tokens: number;
  cache_hit_rate: number | null;
  cost_micro: number;
  estimated: boolean;
  error_type: string;
  created_at: string;
}

export interface DesktopUsageProfileSession {
  api_key_id: string;
  api_key_name: string;
  key_prefix: string;
  device_id: string;
  source: string;
  first_seen_at: string;
  last_seen_at: string;
  active: boolean;
  last_status_code: number;
  request_count: number;
  token_count: number;
}

export interface DesktopUsageProfileListResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface DesktopUsageProfilePrice {
  id: string;
  protocol: string;
  public_model: string;
  input_cost_micro_per_1m_tokens: number;
  input_cache_hit_cost_micro_per_1m_tokens?: number | null;
  output_cost_micro_per_1m_tokens: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

export type DesktopUsageProfileFailureReason =
  | "not-configured"
  | "unauthorized"
  | "unavailable"
  | "error";

export type DesktopUsageProfileResult =
  | {
      ok: true;
      provider: DesktopUsageProfileProvider;
      currentKey: DesktopUsageProfileAPIKey;
      limits: DesktopUsageProfileLimits;
      usage: {
        summary: DesktopUsageProfileTrafficBucket;
        items: DesktopUsageProfileTrafficBucket[];
      };
      balance: DesktopUsageProfileBalance;
      logs: DesktopUsageProfileListResult<DesktopUsageProfileLogEntry>;
      sessions: DesktopUsageProfileListResult<DesktopUsageProfileSession>;
      prices: {
        items: DesktopUsageProfilePrice[];
      };
      fetchedAt: string;
    }
  | {
      ok: false;
      reason: DesktopUsageProfileFailureReason;
      message: string;
      fetchedAt: string;
    };

export interface DesktopRuntimeEnvResetResult {
  ok: boolean;
  restartRequired: boolean;
  message: string;
  runtimeRoot: string;
  backupPath?: string;
  copiedFiles: number;
  skippedFiles: number;
  sourceZipPath?: string;
}

export type DesktopStateFileName =
  | "bootstrap.json"
  | "env-bootstrap.json"
  | "pet-state.json"
  | "sso-session.json"
  | "sso-access-token.txt";

export interface DesktopStateFileSnapshot {
  name: DesktopStateFileName;
  path: string;
  exists: boolean;
  size: number;
  modifiedAt: EpochMilliseconds | null;
  format: "json" | "text";
  content: string;
  error?: string;
}

export interface DesktopStateSnapshot {
  rootPath: string;
  readAt: EpochMilliseconds;
  files: DesktopStateFileSnapshot[];
}

export interface DesktopGeneralSettings {
  deviceName: string;
  preventSleepWhileRunning: boolean;
  desktopWsServerEnabled: boolean;
  desktopActionConfirmationEnabled: boolean;
}

export interface DesktopGeneralSettingsInput {
  deviceName?: string;
  preventSleepWhileRunning?: boolean;
  desktopActionConfirmationEnabled?: boolean;
}

export interface EnterpriseImSettings {
  schemaVersion: 1;
  enabled: boolean;
  baseUrl: string;
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

export interface DesktopWsServerStartOptions {
  host?: string;
}

export interface MobilePairingPayloadV2 {
  v: 2;
  kind: "desktop-ws";
  targetMode: "tunnel";
  wsUrl: string;
  tokenMode: "query" | "subprotocol";
  token: string;
  expiresAtMs: number;
  desktopDeviceId: string;
}

export interface DesktopAppPairingDisplay {
  targetMode: "tunnel";
  wsUrl: string;
  expiresAt: string;
}

export type DesktopAppPairingPayloadResult =
  | {
      ok: true;
      payload: MobilePairingPayloadV2;
      payloadText: string;
      display: DesktopAppPairingDisplay;
    }
  | { ok: false; message: string };

export type NativeDialogVisibilityListener = (state: { open: boolean; platform: string }) => void;
export type SandboxImageImportProgressListener = (event: SandboxImageImportProgressEvent) => void;
export type LocaleChangedListener = (settings: LocaleSettings) => void;
export type DesktopWindowState = {
  isFullScreen: boolean;
};
export type DesktopWindowStateListener = (state: DesktopWindowState) => void;
export type DesktopGlobalSearchActionShortcutId = "newChat" | "agents" | "skills" | "mcpConnectors";
export type DesktopGlobalSearchShortcutSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type DesktopGlobalSearchShortcut =
  | { kind: "action"; actionId: DesktopGlobalSearchActionShortcutId }
  | { kind: "attention"; slot: DesktopGlobalSearchShortcutSlot }
  | { kind: "agent"; slot: DesktopGlobalSearchShortcutSlot };
export type DesktopGlobalSearchShortcutListener = (shortcut: DesktopGlobalSearchShortcut) => void;
export type DesktopConfigChangedEvent = {
  reason: string;
  changedAt: string;
};
export type DesktopConfigChangedListener = (event: DesktopConfigChangedEvent) => void;

export interface RendererDiagnosticReport {
  source: "window-error" | "unhandledrejection" | "react-error-boundary" | "service-webview";
  message: string;
  details?: Record<string, unknown>;
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
  sidebarContextMenu: {
    popup: (
      request: SidebarContextMenuPopupRequest
    ) => Promise<SidebarContextMenuPopupResult>;
  };
  chatWorkPanelTabContextMenu: {
    popup: (
      request: ChatWorkPanelTabContextMenuPopupRequest
    ) => Promise<ChatWorkPanelTabContextMenuPopupResult>;
  };
  desktopShell: {
    openPath: (targetPath: string) => Promise<{ ok: boolean; path?: string; message?: string }>;
    moveWindowBy: (delta: { x: number; y: number }) => Promise<{ ok: boolean; message?: string }>;
    beginWindowDrag: (point: { x: number; y: number }) => Promise<{ ok: boolean; message?: string }>;
    endWindowDrag: () => Promise<{ ok: boolean; message?: string }>;
    setGlobalSearchOverlayVisible: (visible: boolean) => void;
    getWindowState: () => Promise<{ ok: boolean; isFullScreen: boolean; message?: string }>;
    onWindowStateChanged: (listener: DesktopWindowStateListener) => (() => void);
    onShutdownProgress: (listener: ShutdownProgressListener) => (() => void);
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
  kanban: {
    listIssues: () => Promise<KanbanListResult>;
    resyncCloudBoard: () => Promise<KanbanListResult>;
    getSettings: () => Promise<KanbanSettingsResult>;
    saveSettings: (input: KanbanSettingsInput) => Promise<KanbanSettingsResult>;
    getCloudConfig: () => Promise<KanbanCloudConfigResult>;
    saveCloudConfig: (input: KanbanCloudConfig) => Promise<KanbanCloudConfigResult>;
    createIssue: (input: KanbanIssueInput) => Promise<KanbanIssueResult>;
    updateIssue: (id: string, input: KanbanIssueUpdateInput) => Promise<KanbanIssueResult>;
    deleteIssue: (id: string) => Promise<KanbanDeleteResult>;
    moveIssue: (input: KanbanIssueMoveInput) => Promise<KanbanIssueResult>;
    claimIssue: (issueId: string) => Promise<KanbanIssueResult>;
    runIssue: (input: KanbanRunIssueInput) => Promise<KanbanRunIssueResult>;
    syncIssueAutomation: (issueId: string) => Promise<KanbanIssueResult>;
    onChanged: (listener: KanbanChangedListener) => () => void;
  };
  assistant: {
    getSettings: () => Promise<AssistantSettingsPublic>;
    saveSettings: (input: AssistantSettingsInput) => Promise<AssistantSettingsPublic>;
    getMemorySettings: () => Promise<AssistantMemorySettings>;
    saveMemorySettings: (input: AssistantMemorySettingsInput) => Promise<AssistantMemorySettings>;
    getMemorySummary: () => Promise<AssistantMemorySummary>;
    listAgents: () => Promise<DesktopPetAgentOption[]>;
    listNavigationAgents: (options?: AssistantNavigationListOptions) => Promise<AssistantNavAgentItemsResult>;
    getNavigationLiveStatus: () => Promise<AssistantNavigationLiveStatus>;
    listCopilotAgents: () => Promise<AssistantNavAgentItemsResult>;
    createProject: (input: AssistantCreateProjectRequest) => Promise<AssistantCreateProjectResult>;
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
    searchChats: (request: AssistantChatSearchRequest) => Promise<AssistantChatSearchResponse>;
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
    markChatRead: (chatId: string, runId?: string) => Promise<AssistantNavActionResult>;
    renameChat: (chatId: string, chatName: string) => Promise<AssistantNavActionResult>;
    archiveChat: (chatId: string) => Promise<AssistantNavActionResult>;
    exportChat: (chatId: string) => Promise<AssistantNavActionResult>;
    onNavigationAgentsChanged: (listener: AssistantNavigationAgentsChangedListener) => () => void;
    onNavigationPushEvent: (listener: AssistantNavigationPushEventListener) => () => void;
    onAssistantEvent: (listener: AssistantEventListener) => () => void;
    onAttachmentProgress: (listener: AssistantAttachmentProgressListener) => () => void;
  };
  copilot: {
    publishDevToolsTarget: (target: CopilotDevToolsTargetInput) => Promise<{ ok: boolean; message?: string }>;
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
  };
  serviceWebview: {
    getPreloadPath: () => Promise<string>;
    getPreloadUrl: () => Promise<string>;
    onSelectionToolbarState: (
      listener: WebviewSelectionToolbarStateListener
    ) => () => void;
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
  help: {
    getSettings: () => Promise<DesktopHelpSettings>;
  };
  enterpriseChat: {
    getState: () => Promise<EnterpriseChatSnapshot>;
    refresh: () => Promise<EnterpriseChatSnapshot>;
    openDirectConversation: (input: EnterpriseChatOpenDirectInput) => Promise<EnterpriseChatSnapshot>;
    openConversation: (input: EnterpriseChatOpenConversationInput) => Promise<EnterpriseChatSnapshot>;
    createGroup: (input: EnterpriseChatCreateGroupInput) => Promise<EnterpriseChatSnapshot>;
    sendMessage: (input: EnterpriseChatSendMessageInput) => Promise<EnterpriseChatSnapshot>;
    sendFiles: (input: EnterpriseChatSendFilesInput) => Promise<EnterpriseChatSnapshot>;
    sendSupportBundle: (input: EnterpriseChatSendSupportBundleInput) => Promise<EnterpriseChatSnapshot>;
    sendPastedFiles: (input: EnterpriseChatSendPastedFilesInput) => Promise<EnterpriseChatSnapshot>;
    sendScreenshot: (input: EnterpriseChatSendScreenshotInput) => Promise<EnterpriseChatSnapshot>;
    loadAttachment: (input: EnterpriseChatAttachmentInput) => Promise<EnterpriseChatAttachmentData>;
    downloadAttachment: (input: EnterpriseChatAttachmentInput) => Promise<EnterpriseChatDownloadResult>;
    executeDesktopAction: (input: EnterpriseChatExecuteActionInput) => Promise<EnterpriseChatExecuteActionResult>;
    markRead: (input: EnterpriseChatMarkReadInput) => Promise<EnterpriseChatSnapshot>;
    saveSelfProfile: (input: EnterpriseChatSaveSelfProfileInput) => Promise<EnterpriseChatSnapshot>;
    selectSelfAvatar: () => Promise<EnterpriseChatSnapshot>;
    clearSelfAvatar: () => Promise<EnterpriseChatSnapshot>;
    onStateChanged: (listener: EnterpriseChatSnapshotListener) => () => void;
  };
  settings: {
    getDataRoot: () => Promise<string>;
    getPlatform: () => Promise<string>;
    getAppInfo: () => Promise<DesktopAppInfo>;
    getDeviceIdentity: () => Promise<DesktopDeviceIdentityInfo>;
    getDesktopStateSnapshot: () => Promise<DesktopStateSnapshot>;
    getUsageProfile: () => Promise<DesktopUsageProfileResult>;
    getDesktopDeviceInfo: () => Promise<DesktopDeviceInfo>;
    getDesktopWsServerState: () => Promise<DesktopWsServerState>;
    setDesktopWsServerEnabled: (enabled: boolean) => Promise<DesktopWsServerState>;
    getGeneralSettings: () => Promise<DesktopGeneralSettings>;
    saveGeneralSettings: (input: DesktopGeneralSettingsInput) => Promise<DesktopGeneralSettings>;
    getEnterpriseImSettings: () => Promise<EnterpriseImSettings>;
    setEnterpriseImEnabled: (enabled: boolean) => Promise<EnterpriseImSettings>;
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
    respondConfirmation: (response: DesktopActionConfirmationResponse) => Promise<{ ok: boolean }>;
    openWorkbench: () => Promise<{ ok: boolean; message?: string }>;
    closeWorkbench: () => Promise<{ ok: boolean; message?: string }>;
    list: () => Promise<{ ok: boolean; actions: DesktopActionDefinition[] }>;
    call: (request: DesktopActionCallRequest) => Promise<DesktopActionCallResponse>;
    onCall: (listener: DesktopActionCallListener) => () => void;
    onConfirm: (listener: DesktopActionConfirmationListener) => () => void;
  };
  currentPage: {
    publishSnapshot: (snapshot: DesktopPageContextSnapshot | null) => Promise<{ ok: boolean }>;
    getSnapshot: () => Promise<DesktopPageContextSnapshot | null>;
  };
  embeddedCdp: {
    registerSurface: (input: EmbeddedCdpSurfaceRegistration) => Promise<{ ok: boolean }>;
    unregisterSurface: (input: EmbeddedCdpSurfaceRemoval) => Promise<{ ok: boolean }>;
    getSurfaceTargetState: (input: EmbeddedCdpSurfaceTargetStateRequest) => Promise<EmbeddedCdpSurfaceTargetStateResult>;
  };
  chatWorkPanel: {
    clearSession: (input: ChatWorkPanelClearSessionRequest) => Promise<{ ok: boolean }>;
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
    probeDesktopWs: (input: { target: "localDebug" }) => Promise<DesktopWsProbeResult>;
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
    beginDrag: (point: { x?: number; y?: number }) => Promise<{ ok: boolean }>;
    endDrag: () => Promise<{ ok: boolean; moved: boolean }>;
    setPreviewExpanded: (expanded: boolean) => Promise<{ ok: boolean }>;
    dismissPreview: () => Promise<{ ok: boolean }>;
    replyMessage: (input: { chatId: string; agentKey?: string; message: string }) => Promise<{ ok: boolean; message?: string; chatId?: string; runId?: string }>;
    dismissMessage: (input: { chatId: string; runId?: string | null; updatedAt?: number }) => Promise<{ ok: boolean }>;
    setMouseInteractive: (interactive: boolean) => Promise<{ ok: boolean }>;
    setWindowMode: (mode: DesktopPetWindowMode) => Promise<{ ok: boolean }>;
    onStateChanged: (listener: DesktopPetStateListener) => () => void;
    onSignatureRequested: (listener: DesktopPetSignatureRequestedListener) => () => void;
  };
  webs: {
    list: () => Promise<WebListResult>;
    onChanged: (listener: WebsChangedListener) => () => void;
    websites: {
      list: () => Promise<WebsiteItemsResult>;
      add: (input: WebsiteInput) => Promise<WebsiteResult>;
      update: (id: string, input: WebsiteUpdateInput) => Promise<WebsiteResult>;
      remove: (id: string) => Promise<WebsiteDeleteResult>;
      cacheFavicon: (input: WebsiteFaviconCacheInput) => Promise<WebsiteFaviconCacheResult>;
      import: () => Promise<WebsiteTransferResult>;
      export: () => Promise<WebsiteTransferResult>;
    };
    webapps: {
      list: () => Promise<WebappItemsResult>;
      import: () => Promise<WebappImportResult>;
      export: (id: string) => Promise<WebappExportResult>;
      update: (id: string, input: WebappUpdateInput) => Promise<WebappResult>;
      uninstall: (id: string) => Promise<WebappDeleteResult>;
      start: (id: string) => Promise<WebappCommandResult>;
      openWindow: (id: string) => Promise<WebappCommandResult>;
      stop: (id: string) => Promise<WebappCommandResult>;
      restart: (id: string) => Promise<WebappCommandResult>;
      getStatus: (id: string) => Promise<WebappStatusResult>;
      checkRuntime: (id: string) => Promise<WebappRuntimeCheckResult>;
      getRuntimeSettings: () => Promise<WebappRuntimeSettingsResult>;
      saveRuntimeSettings: (input: WebappRuntimeSettingsInput) => Promise<WebappRuntimeSettingsResult>;
      getUserConfig: (id: string) => Promise<WebappUserConfigResult>;
      saveUserConfig: (id: string, values: Record<string, string | number | boolean>) => Promise<WebappUserConfigResult>;
      getPublishStatus: (id: string) => Promise<WebappPublishStatusResult>;
      publish: (id: string) => Promise<WebappPublishResult>;
      unpublish: (id: string) => Promise<WebappPublishResult>;
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
  onOpenGlobalSearch: (listener: () => void) => () => void;
  onGlobalSearchShortcut: (listener: DesktopGlobalSearchShortcutListener) => () => void;
  onOpenAssistantWorker: (listener: AssistantWorkerOpenListener) => () => void;
  onWebviewOpenTab: (listener: WebviewOpenTabListener) => () => void;
  onNativeDialogVisibility: (listener: NativeDialogVisibilityListener) => () => void;
}
