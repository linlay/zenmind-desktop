export type ServiceId = string;
export type ServiceKind = "builtin" | "plugin";
export type FrontendMode = "none" | "embedded" | "standalone";
export type ServiceLogTarget = "main" | "error";
export type ServiceStatus =
  | "not-installed"
  | "initialization-required"
  | "stopped"
  | "running"
  | "config-required"
  | "dependency-missing"
  | "error";

export interface ServiceConfigFile {
  key: string;
  label: string;
  relativePath: string;
  absolutePath: string;
  required: boolean;
  exists: boolean;
}

export interface ServiceHealthMeta {
  pid: number | null;
  pidFilePath: string;
  logFilePath: string;
  errorLogFilePath: string;
  webUrl: string;
  port: number | null;
  prerequisites: string[];
}

export interface ServiceState {
  id: ServiceId;
  name: string;
  kind: ServiceKind;
  version: string;
  description: string;
  installDir: string;
  installed: boolean;
  status: ServiceStatus;
  statusLabel: string;
  message: string;
  frontendMode: FrontendMode;
  configFiles: ServiceConfigFile[];
  healthMeta: ServiceHealthMeta;
}

export interface ServiceCommandResult {
  ok: boolean;
  message: string;
  service: ServiceState;
}

export interface ServiceConfigReadResult {
  ok: boolean;
  path: string;
  content: string;
  exists: boolean;
  source: "file" | "template" | "missing";
}

export interface ServiceLogsMeta {
  ok: boolean;
  logPath: string;
  exists: boolean;
}

export interface ServiceLogReadOptions {
  beforeOffset?: number;
  limitBytes?: number;
}

export interface ServiceLogReadResult {
  ok: boolean;
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  startOffset: number;
  endOffset: number;
  hasPrevious: boolean;
  resetRequired: boolean;
  totalBytes: number;
}

export interface ServiceImportResult {
  ok: boolean;
  message: string;
  targetPath: string;
  service: ServiceState;
}

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

export interface ManifestPlatform {
  os: string;
  arch: string;
}

export interface ManifestFrontend {
  mode: FrontendMode;
  entry?: string;
  assetsPrefix?: string;
  directAccess?: boolean;
  hostManaged?: boolean;
  dist?: string;
  index?: string;
  spa?: boolean;
}

export interface ManifestApi {
  enabled: boolean;
  adminBaseUrl?: string;
  openidBaseUrl?: string;
  oauth2BaseUrl?: string;
}

export interface ManifestBackend {
  entry: string;
}

export type ManifestCommand = string | string[];

export interface ManifestScripts {
  start: ManifestCommand;
  stop: ManifestCommand;
  deploy?: ManifestCommand;
}

export interface ManifestConfigFile {
  key: string;
  label: string;
  relativePath: string;
  templateRelativePath?: string;
  required: boolean;
}

export interface ManifestRuntime {
  pidRelativePath?: string;
  logRelativePath?: string;
  errorLogRelativePath?: string;
  requiredPaths?: string[];
}

export interface ManifestWeb {
  routePath: string;
  portEnvKey: string;
  defaultPort: number;
}

export interface ManifestDesktopBridge {
  category: "bridge";
  channelId: string;
  channelName: string;
  gatewayInfoEndpoint: string;
}

export interface ManifestDesktop {
  assetFileName?: string;
  bundleTopLevelDir?: string;
  envBindings?: ManifestEnvBinding[];
  bridge?: ManifestDesktopBridge;
}

export interface ManifestEnvBinding {
  key: string;
  value?: string;
  fromService?: string;
  template?: string;
  onlyIfDefault?: boolean;
  defaults?: string[];
}

export interface Manifest {
  id: string;
  name: string;
  kind: ServiceKind;
  version: string;
  description: string;
  platform?: ManifestPlatform;
  frontend: ManifestFrontend;
  api?: ManifestApi;
  backend?: ManifestBackend;
  scripts: ManifestScripts;
  configFiles?: ManifestConfigFile[];
  runtime: ManifestRuntime;
  web?: ManifestWeb;
  prerequisites?: string[];
  desktop?: ManifestDesktop;
}

export interface PluginInstallResult {
  ok: boolean;
  message: string;
  serviceId?: string;
}

export type NavigateListener = (path: string) => void;
export type ServicesChangedListener = () => void;

export type StartupRestoreMode = "restore" | "bootstrap";
export type StartupRestorePhase = "idle" | "running" | "succeeded" | "failed";
export type StartupRestoreServicePhase =
  | "pending"
  | "installing"
  | "initializing"
  | "starting"
  | "succeeded"
  | "failed"
  | "skipped";

export interface StartupRestoreServiceState {
  serviceId: ServiceId;
  phase: StartupRestoreServicePhase;
  message?: string;
}

export interface StartupRestoreState {
  mode: StartupRestoreMode;
  phase: StartupRestorePhase;
  serviceOrder: ServiceId[];
  currentServiceId: ServiceId | null;
  failedServiceId: ServiceId | null;
  message: string;
  updatedAt: string;
  services: StartupRestoreServiceState[];
}

export type StartupRestoreStateListener = (state: StartupRestoreState) => void;

export interface CustomSidebarItem {
  id: string;
  label: string;
  url: string;
  iconId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CustomSidebarItemInput {
  label?: string;
  url: string;
}

export interface CustomSidebarItemsResult {
  ok: boolean;
  items: CustomSidebarItem[];
  message: string;
}

export interface CustomSidebarItemResult {
  ok: boolean;
  item: CustomSidebarItem | null;
  items: CustomSidebarItem[];
  message: string;
}

export interface CustomSidebarDeleteResult {
  ok: boolean;
  items: CustomSidebarItem[];
  message: string;
}

export interface CustomSidebarTransferResult {
  ok: boolean;
  items: CustomSidebarItem[];
  path: string;
  message: string;
}

export interface SidebarTranslucencyResult {
  ok: boolean;
  enabled: boolean;
  effective: boolean;
  message: string;
}

export interface AssistantWorkerOpenRequest {
  workerKey?: string;
  agentKey?: string;
  chatId?: string;
  displayName?: string;
  role?: string;
  focusComposerOnComplete?: boolean;
}

export type AssistantWorkerOpenListener = (request: AssistantWorkerOpenRequest) => void;

export interface WebviewOpenTabRequest {
  sourceGuestId: number;
  url: string;
}

export type WebviewOpenTabListener = (request: WebviewOpenTabRequest) => void;

export type AssistantMessageRole = "user" | "assistant";

export type AssistantRunAction = "chat" | "summarize_page" | "explain_selection" | "extract_todos";

export interface AssistantPageContext {
  url: string;
  title: string;
  selectedText: string;
  metaDescription: string;
  headings: string[];
  bodyText: string;
  browserTarget?: {
    kind: "webview";
    webContentsId: number;
    surfaceId?: string;
    surfaceLabel?: string;
    currentUrl?: string;
    browserSkill?: string;
  };
}

export interface AssistantChatMessage {
  id: string;
  role: AssistantMessageRole;
  content: string;
  createdAt: string;
  runId?: string;
  attachments?: AssistantAttachment[];
}

export interface AssistantChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessage: string;
  messageCount: number;
}

export interface AssistantChatDetail {
  summary: AssistantChatSummary;
  messages: AssistantChatMessage[];
  events: AssistantRunEvent[];
}

export interface AssistantSettingsPublic {
  baseURL: string;
  model: string;
  configured: boolean;
  apiKeyConfigured: boolean;
  source?: "desktop" | "agent-platform";
  sourceLabel?: string;
}

export interface AssistantSettingsInput {
  baseURL?: string;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface AssistantAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  text: string;
  dataUrl?: string;
  truncated?: boolean;
  error?: string;
}

export interface AssistantAttachmentPickResult {
  ok: boolean;
  chatId: string;
  message: string;
  attachments: AssistantAttachment[];
}

export interface AssistantPastedImageInput {
  name?: string;
  mimeType: string;
  data: ArrayBuffer;
}

export interface AssistantStartRunRequest {
  chatId?: string | null;
  message: string;
  action?: AssistantRunAction;
  pageContext?: AssistantPageContext | null;
  attachments?: AssistantAttachment[];
  historyBeforeMessageId?: string;
}

export interface AssistantStartRunResult {
  ok: boolean;
  runId: string;
  chatId: string;
  message: string;
}

export interface AssistantStopRunResult {
  ok: boolean;
  message: string;
}

export type AssistantVoiceCorrectionLocale = "zh-CN-mixed-en";

export interface AssistantVoiceCorrectionRequest {
  text: string;
  locale: AssistantVoiceCorrectionLocale;
}

export interface AssistantVoiceCorrectionResult {
  ok: boolean;
  text: string;
  message: string;
}

export interface AssistantVoiceTranscriptionRequest {
  mimeType: string;
  data: ArrayBuffer;
  locale: AssistantVoiceCorrectionLocale;
}

export interface AssistantVoiceTranscriptionResult {
  ok: boolean;
  text: string;
  message: string;
}

export type AssistantAwaitingMode = "approval" | "question" | "form";

export interface AssistantAwaitingQuestion {
  id: string;
  label: string;
  header?: string;
  question?: string;
  type?: "text" | "number" | "select" | "multi-select" | "password";
  placeholder?: string;
  required?: boolean;
  allowFreeText?: boolean;
  freeTextPlaceholder?: string;
  options?: Array<{
    label: string;
    value?: string;
    description?: string;
  }>;
}

export interface AssistantAwaitingApprovalOption {
  label: string;
  description?: string;
  decision: string;
}

export interface AssistantAwaitingApproval {
  id: string;
  command?: string;
  ruleKey?: string;
  description?: string;
  summary?: string;
  risk?: string;
  cwd?: string;
  paths?: string[];
  options?: AssistantAwaitingApprovalOption[];
  allowFreeText?: boolean;
  freeTextPlaceholder?: string;
}

export interface AssistantAwaitingForm {
  id: string;
  action?: string;
  form?: Record<string, unknown> | null;
  title?: string;
}

export interface AssistantAwaitingPayload {
  awaitingId: string;
  mode: AssistantAwaitingMode;
  title: string;
  description?: string;
  toolName?: string;
  runId: string;
  chatId: string;
  createdAt?: number | string;
  timeout?: number | null;
  timeoutMs?: number;
  questions?: AssistantAwaitingQuestion[];
  approvals?: AssistantAwaitingApproval[];
  approval?: {
    summary: string;
    risk?: string;
    command?: string;
    cwd?: string;
    paths?: string[];
    options?: AssistantAwaitingApprovalOption[];
    allowFreeText?: boolean;
    freeTextPlaceholder?: string;
  };
  forms?: AssistantAwaitingForm[];
  viewportKey?: string;
  viewportHtml?: string;
  loading?: boolean;
  loadError?: string;
  resolvedByOther?: boolean;
}

export interface AssistantSubmitAwaitingRequest {
  awaitingId: string;
  runId?: string;
  chatId?: string;
  action: "submit" | "reject" | "dismiss";
  params?: unknown[];
  reason?: string;
}

export interface AssistantSubmitAwaitingResult {
  ok: boolean;
  message: string;
}

export type AssistantRunEventType =
  | "request.query"
  | "chat.start"
  | "run.start"
  | "content.delta"
  | "tool.start"
  | "tool.args"
  | "tool.result"
  | "tool.end"
  | "awaiting.confirm"
  | "awaiting.ask"
  | "awaiting.answer"
  | "artifact.publish"
  | "run.complete"
  | "run.error"
  | "run.interrupt"
  | "run.stopped"
  | "done";

export type AssistantRunEventStatus =
  | "running"
  | "waiting"
  | "ok"
  | "answered"
  | "rejected"
  | "cancelled"
  | "timeout"
  | "error"
  | "blocked"
  | "stopped";

export interface AssistantRunEvent {
  id: string;
  seq: number;
  runId: string;
  chatId: string;
  type: AssistantRunEventType;
  createdAt: string;
  status?: AssistantRunEventStatus;
  message?: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  action?: string;
  target?: string;
  error?: string;
  awaiting?: AssistantAwaitingPayload;
  awaitingId?: string;
  mode?: AssistantAwaitingMode;
  viewportType?: string;
  viewportKey?: string;
  timeout?: number | null;
  timeoutMs?: number;
  timestamp?: number;
  questions?: AssistantAwaitingQuestion[];
  approvals?: AssistantAwaitingApproval[];
  forms?: AssistantAwaitingForm[];
  data?: unknown;
}

export type AssistantEventType =
  | "delta"
  | "done"
  | "error"
  | "stopped"
  | AssistantRunEventType;

export interface AssistantEvent {
  id?: string;
  seq?: number;
  runId: string;
  chatId: string;
  type: AssistantEventType;
  createdAt?: string;
  status?: AssistantRunEventStatus;
  delta?: string;
  message?: string;
  toolCallId?: string;
  toolName?: string;
  action?: string;
  target?: string;
  error?: string;
  awaiting?: AssistantAwaitingPayload;
  awaitingId?: string;
  mode?: AssistantAwaitingMode;
  viewportType?: string;
  viewportKey?: string;
  timeout?: number | null;
  timeoutMs?: number;
  timestamp?: number;
  questions?: AssistantAwaitingQuestion[];
  approvals?: AssistantAwaitingApproval[];
  forms?: AssistantAwaitingForm[];
  data?: unknown;
}

export type AssistantEventListener = (event: AssistantEvent) => void;

export interface DesktopApi {
  clipboard: {
    writeText: (text: string) => Promise<{ ok: boolean; message?: string }>;
  };
  assistant: {
    getSettings: () => Promise<AssistantSettingsPublic>;
    saveSettings: (input: AssistantSettingsInput) => Promise<AssistantSettingsPublic>;
    listChats: () => Promise<AssistantChatSummary[]>;
    getChat: (chatId: string) => Promise<AssistantChatDetail | null>;
    pickAttachments: (chatId?: string | null) => Promise<AssistantAttachmentPickResult>;
    addPastedImage: (
      chatId: string | null | undefined,
      input: AssistantPastedImageInput
    ) => Promise<AssistantAttachmentPickResult>;
    startRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
    stopRun: (runId: string) => Promise<AssistantStopRunResult>;
    correctVoiceText: (request: AssistantVoiceCorrectionRequest) => Promise<AssistantVoiceCorrectionResult>;
    transcribeVoiceAudio: (request: AssistantVoiceTranscriptionRequest) => Promise<AssistantVoiceTranscriptionResult>;
    submitAwaiting: (request: AssistantSubmitAwaitingRequest) => Promise<AssistantSubmitAwaitingResult>;
    deleteChat: (chatId: string) => Promise<{ ok: boolean; message: string }>;
    onAssistantEvent: (listener: AssistantEventListener) => () => void;
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
  };
  plugins: {
    install: () => Promise<PluginInstallResult>;
    uninstall: (serviceId: ServiceId) => Promise<PluginInstallResult>;
  };
  panAuth: {
    importPrivateKey: () => Promise<PanAuthImportResult>;
    getStatus: () => Promise<PanAuthStatus>;
  };
  agentAuth: {
    issueAccessToken: (reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;
  };
  settings: {
    getDataRoot: () => Promise<string>;
    getPlatform: () => Promise<string>;
    setSidebarTranslucency: (enabled: boolean) => Promise<SidebarTranslucencyResult>;
  };
  quickAssistant: {
    setExpanded: (expanded: boolean) => Promise<{ ok: boolean }>;
    setInteractionState: (state: { busy?: boolean; mouseInside?: boolean }) => Promise<{ ok: boolean }>;
    hide: () => Promise<{ ok: boolean }>;
    openMainAssistant: (chatId?: string | null) => Promise<{ ok: boolean }>;
    openSettings: () => Promise<{ ok: boolean }>;
  };
  customSidebar: {
    list: () => Promise<CustomSidebarItemsResult>;
    add: (input: CustomSidebarItemInput) => Promise<CustomSidebarItemResult>;
    remove: (id: string) => Promise<CustomSidebarDeleteResult>;
    import: () => Promise<CustomSidebarTransferResult>;
    export: () => Promise<CustomSidebarTransferResult>;
  };
  onNavigate: (listener: NavigateListener) => () => void;
  onServicesChanged: (listener: ServicesChangedListener) => () => void;
  onStartupRestoreState: (listener: StartupRestoreStateListener) => () => void;
  onOpenAssistantWorker: (listener: AssistantWorkerOpenListener) => () => void;
  onWebviewOpenTab: (listener: WebviewOpenTabListener) => () => void;
}
