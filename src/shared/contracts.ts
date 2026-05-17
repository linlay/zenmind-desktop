import type {
  DesktopCopilotPagePreferences,
  DesktopCopilotPagePreferencesInput
} from "./assistant-settings";
import type {
  DesktopActionCallRequest,
  DesktopActionCallResponse,
  DesktopActionDefinition
} from "./desktop-actions";

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

export interface ServicePaths {
  programDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
  logDir: string;
}

export interface ServiceState {
  id: ServiceId;
  name: string;
  kind: ServiceKind;
  version: string;
  description: string;
  installDir: string;
  paths: ServicePaths;
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
  verification?: ServiceVerification;
}

export type ServiceDesiredStatus = "running" | "stopped";

export interface ServiceVerificationProbe {
  target: string;
  ok: boolean;
  statusCode?: number;
  contentType?: string;
  message?: string;
}

export interface ServiceVerification {
  verified: boolean;
  desired: ServiceDesiredStatus;
  actualStatus: ServiceStatus;
  pidAlive: boolean;
  portListening: boolean;
  managedPortPid: number | null;
  httpOk: boolean | null;
  runtimeInfoOk: boolean | null;
  checkedAt: string;
  issues: string[];
  probes: ServiceVerificationProbe[];
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

export interface ServiceLogStreamOptions {
  fromOffset?: number;
  pollIntervalMs?: number;
}

export interface ServiceOpenLogViewerRequest {
  serviceId: ServiceId;
  target: ServiceLogTarget;
  title: string;
}

export interface ServiceRevealPathOptions {
  targetType?: "file" | "directory";
}

export interface ServiceRevealPathResult {
  ok: boolean;
  message: string;
  path: string;
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

export type ServiceLogStreamEventType = "append" | "reset" | "error";

export interface ServiceLogStreamEvent {
  subscriptionId: string;
  serviceId: ServiceId;
  target: ServiceLogTarget;
  type: ServiceLogStreamEventType;
  path: string;
  exists: boolean;
  content: string;
  startOffset: number;
  endOffset: number;
  hasPrevious: boolean;
  totalBytes: number;
  message?: string;
}

export type ServiceLogStreamListener = (event: ServiceLogStreamEvent) => void;

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
  agentKey?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CustomSidebarItemInput {
  label?: string;
  url: string;
  agentKey?: string;
}

export interface CustomSidebarUpdateInput {
  label?: string;
  url?: string;
  agentKey?: string;
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

export type DesktopPetStatus = "idle" | "running" | "awaiting" | "done" | "error";
export type DesktopPetAgentPresence = "available" | "busy" | "away" | "offline";

export interface DesktopPetSettings {
  enabled: boolean;
  boundAgentKey: string;
  appearanceId: string;
}

export interface DesktopPetSettingsInput {
  enabled?: boolean;
  boundAgentKey?: string;
  appearanceId?: string;
}

export interface DesktopPetAppearanceOption {
  id: string;
  displayName: string;
  description: string;
  assetBasePath: string;
  previewAssetPath: string;
}

export interface DesktopPetAgentOption {
  agentKey: string;
  displayName: string;
  role: string;
  unreadCount: number;
}

export type DesktopPetPreviewItemKind =
  | "thinking"
  | "content"
  | "tool"
  | "action"
  | "awaiting"
  | "awaiting-answer"
  | "artifact"
  | "plan"
  | "task"
  | "status";

export type DesktopPetPreviewItemStatus =
  | "pending"
  | "running"
  | "waiting"
  | "success"
  | "error"
  | "cancelled"
  | "done";

export interface DesktopPetPreviewItem {
  id: string;
  kind: DesktopPetPreviewItemKind;
  title: string;
  text: string;
  detailText?: string;
  status: DesktopPetPreviewItemStatus;
  createdAt: string;
}

export interface DesktopPetPreviewAwaiting {
  awaitingId: string;
  mode: AssistantAwaitingMode | "";
  count: number;
  title: string;
  timeoutMs?: number | null;
}

export interface DesktopPetPreviewPanel {
  runId: string;
  chatId: string | null;
  visible: boolean;
  expanded: boolean;
  title: string;
  summary: string;
  status: "running" | "waiting" | "done" | "error" | "stopped";
  items: DesktopPetPreviewItem[];
  artifactCount: number;
  awaiting?: DesktopPetPreviewAwaiting;
  updatedAt: string;
}

export interface DesktopPetState {
  supported: boolean;
  enabled: boolean;
  visible: boolean;
  status: DesktopPetStatus;
  hint: string;
  messagePreview: string;
  unreadCount: number;
  chatId: string | null;
  appearanceId: string;
  appearanceOptions: DesktopPetAppearanceOption[];
  boundAgentKey: string;
  agentDisplayName: string;
  agentRole: string;
  agentPresence: DesktopPetAgentPresence;
  agentStatusStale: boolean;
  agentOptions: DesktopPetAgentOption[];
  previewPanel: DesktopPetPreviewPanel | null;
  updatedAt: string;
}

export type DesktopPetStateListener = (state: DesktopPetState) => void;
export type DesktopPetDanceRequestedListener = () => void;

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
export type AssistantPermissionMode = "default" | "full_access";
export type AssistantRunSource = "sidebar" | "quick-assistant";

export interface AssistantPageContext {
  url: string;
  title: string;
  selectedText: string;
  metaDescription: string;
  headings: string[];
  bodyText: string;
  shellSidebarText?: string;
  leftRegionText?: string;
  modalText?: string;
  browserTarget?: (
    {
      kind: "webview";
      webContentsId: number;
      surfaceId?: string;
      surfaceLabel?: string;
      currentUrl?: string;
      browserSkill?: string;
    } |
    {
      kind: "iframe";
      frameMatchUrl: string;
      surfaceId?: string;
      surfaceLabel?: string;
      currentUrl?: string;
      browserSkill?: string;
    }
  );
}

export type DesktopPageKind = "native" | "webview" | "iframe";

export interface DesktopPageContextSnapshot {
  route: string;
  pageKey: string;
  pageKind: DesktopPageKind;
  surfaceId?: string;
  surfaceLabel?: string;
  webContentsId?: number;
  frameMatchUrl?: string;
  snapshotVersion: number;
  snapshotAt: string;
  pageContext: AssistantPageContext | null;
}

export interface EmbeddedWebExecuteInFrameRequest {
  frameMatchUrl: string;
  script: string;
  timeoutMs?: number;
}

export interface EmbeddedWebExecuteInFrameResult {
  ok: boolean;
  frameUrl?: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface DesktopActionRendererRequest {
  requestId: string;
  action: string;
  args: Record<string, unknown>;
  source?: {
    runId?: string;
    chatId?: string;
    agentKey?: string;
  };
}

export interface DesktopActionRendererResponse {
  requestId: string;
  ok: boolean;
  action: string;
  result?: unknown;
  preview?: unknown;
  requiresConfirmation?: boolean;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type DesktopActionCallListener = (request: DesktopActionRendererRequest) => void;

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
  voiceCorrectionEnabled: boolean;
  desktopHelperAgentKey: string;
  quickAssistantEnabled: boolean;
  quickAssistantAgentKey: string;
  desktopCopilotPages: DesktopCopilotPagePreferences;
  source?: "desktop" | "agent-platform";
  sourceLabel?: string;
}

export interface AssistantSettingsInput {
  voiceCorrectionEnabled?: boolean;
  desktopHelperAgentKey?: string;
  quickAssistantEnabled?: boolean;
  quickAssistantAgentKey?: string;
  desktopCopilotPages?: DesktopCopilotPagePreferencesInput;
}

export type AssistantMemoryKind = "fact" | "observation";
export type AssistantMemoryStatus = "active" | "open" | "archived";

export interface AssistantMemoryItem {
  id: string;
  kind: AssistantMemoryKind;
  title: string;
  summary: string;
  category: string;
  scopeType?: "user" | "chat";
  facet?: string;
  subjectKey?: string;
  tags: string[];
  importance: number;
  confidence: number;
  status: AssistantMemoryStatus;
  sourceChatId?: string;
  sourceRunId?: string;
  referenceCount: number;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  lastReferencedAt?: string;
}

export interface AssistantMemorySettings {
  enabled: boolean;
  autoLearn: boolean;
  maxItems: number;
  maxChars: number;
}

export interface AssistantMemorySettingsInput {
  enabled?: boolean;
  autoLearn?: boolean;
  maxItems?: number;
  maxChars?: number;
}

export interface AssistantMemoryStats {
  total: number;
  factCount: number;
  observationCount: number;
  lastLearnedAt: string | null;
  lastReferencedAt: string | null;
}

export interface AssistantMemoryStorage {
  recordsPath: string;
  staticPath: string;
  auditPath: string;
  directoryPath: string;
}

export interface AssistantMemoryAuditSummary {
  operation: string;
  status: string;
  reason?: string;
  stored?: number;
  skipped?: number;
  updated?: number;
  archived?: number;
  timestamp: string;
}

export interface AssistantMemorySummary {
  settings: AssistantMemorySettings;
  stats: AssistantMemoryStats;
  storage: AssistantMemoryStorage;
  directoryPath: string;
  recentAudit: AssistantMemoryAuditSummary | null;
}

export type AssistantDocumentFormat = "text" | "pdf" | "docx" | "xlsx" | "pptx" | "zip" | "image" | "binary";
export type AssistantDocumentReadStatus = "readable" | "truncated" | "unreadable";

export interface AssistantAttachmentDocument {
  format: AssistantDocumentFormat;
  readStatus: AssistantDocumentReadStatus;
  extractedChars: number;
  truncated: boolean;
  pageCount?: number;
  sheetNames?: string[];
  slideCount?: number;
  imageMode?: "vision";
  errorCode?: string;
  visionSummary?: string;
  visionStatus?: "pending" | "readable" | "failed" | "unavailable";
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
  kind?: "input" | "artifact";
  artifactId?: string;
  description?: string;
  sha256?: string;
  url?: string;
  document?: AssistantAttachmentDocument;
  hidden?: boolean;
  sourceAttachmentId?: string;
  pageNumber?: number;
}

export interface AssistantAttachmentPickResult {
  ok: boolean;
  chatId: string;
  message: string;
  attachments: AssistantAttachment[];
  taskId?: string;
  cancelled?: boolean;
}

export type AssistantAttachmentTaskPhase =
  | "queued"
  | "scanning"
  | "copying"
  | "extracting"
  | "rendering"
  | "complete"
  | "cancelled"
  | "error";

export interface AssistantAttachmentTaskProgress {
  taskId: string;
  chatId: string;
  phase: AssistantAttachmentTaskPhase;
  processedFiles: number;
  totalFiles: number;
  processedBytes: number;
  totalBytes: number;
  message: string;
  done?: boolean;
  cancelled?: boolean;
}

export type AssistantAttachmentProgressListener = (progress: AssistantAttachmentTaskProgress) => void;

export interface AssistantAttachmentCancelResult {
  ok: boolean;
  message: string;
}

export type MarketItemType = "plugin" | "skill" | "sandbox-image";
export type MarketInstallState =
  | "not-installed"
  | "installed"
  | "update-available"
  | "local-imported"
  | "incompatible"
  | "installing"
  | "failed";

export interface MarketAsset {
  url: string;
  sha256?: string;
  sizeBytes: number;
  archiveType: "tar.gz" | "zip" | "skill" | "md";
  platform?: string;
}

export interface MarketCatalogItem {
  id: string;
  type: MarketItemType;
  name: string;
  version: string;
  description: string;
  tags: string[];
  minDesktopVersion?: string;
  assets: Record<string, MarketAsset>;
}

export interface MarketItem {
  id: string;
  type: MarketItemType;
  name: string;
  version: string;
  description: string;
  tags: string[];
  state: MarketInstallState;
  source: "cloud" | "local";
  installedVersion?: string;
  installPath?: string;
  serviceId?: string;
  message?: string;
  environmentName?: string;
  imageRef?: string;
  buildStatus?: string;
  buildJobId?: string;
  buildTargetCount?: number;
}

export interface MarketListResult {
  ok: boolean;
  sourceUrl: string;
  offline: boolean;
  message: string;
  items: MarketItem[];
  sandboxMessage?: string;
  sandboxOffline?: boolean;
}

export interface MarketCommandResult {
  ok: boolean;
  itemId: string;
  type: MarketItemType;
  state: MarketInstallState;
  message: string;
  serviceId?: string;
  installPath?: string;
  environmentName?: string;
  imageRef?: string;
  buildJobId?: string;
  buildStatus?: string;
  buildTarget?: string;
}

export interface MarketSettings {
  skillsApiBaseUrl: string;
}

export interface MarketSettingsInput {
  skillsApiBaseUrl: string;
}

export interface AssistantPastedImageInput {
  name?: string;
  mimeType: string;
  data: ArrayBuffer;
}

export interface AssistantStartRunRequest {
  chatId?: string | null;
  agentKey?: string;
  message: string;
  action?: AssistantRunAction;
  permissionMode?: AssistantPermissionMode;
  source?: AssistantRunSource;
  pageContext?: AssistantPageContext | null;
  attachments?: AssistantAttachment[];
  historyBeforeMessageId?: string;
}

export interface AssistantStartRunResult {
  ok: boolean;
  runId: string;
  chatId: string;
  message: string;
  permissionMode?: AssistantPermissionMode;
  fullAccessExpiresAt?: string | null;
  fullAccessRemainingMs?: number;
}

export interface AssistantStopRunResult {
  ok: boolean;
  message: string;
}

export type AssistantVoiceCorrectionLocale = "zh-CN-mixed-en";
export type AssistantVoiceChangeLevel = "none" | "minor" | "major";

export interface AssistantVoiceCorrectionRequest {
  text: string;
  locale: AssistantVoiceCorrectionLocale;
}

export interface AssistantVoiceCorrectionResult {
  ok: boolean;
  text: string;
  message: string;
  rawText?: string;
  correctedText?: string;
  changeLevel?: AssistantVoiceChangeLevel;
  confidence?: number;
  glossaryHits?: string[];
  uncertainTerms?: string[];
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
  rawText?: string;
  correctedText?: string;
  changeLevel?: AssistantVoiceChangeLevel;
  confidence?: number;
  glossaryHits?: string[];
  uncertainTerms?: string[];
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
  | "request.submit"
  | "request.steer"
  | "chat.start"
  | "chat.update"
  | "chat.created"
  | "chat.updated"
  | "chat.read"
  | "chat.unread"
  | "run.start"
  | "run.cancel"
  | "content.delta"
  | "content.start"
  | "content.snapshot"
  | "content.end"
  | "reasoning.start"
  | "reasoning.delta"
  | "reasoning.snapshot"
  | "reasoning.end"
  | "memory.reference"
  | "memory.recalled"
  | "memory.stored"
  | "memory.skipped"
  | "tool.start"
  | "tool.args"
  | "tool.snapshot"
  | "tool.result"
  | "tool.end"
  | "action.start"
  | "action.args"
  | "action.snapshot"
  | "action.result"
  | "action.end"
  | "awaiting.confirm"
  | "awaiting.ask"
  | "awaiting.payload"
  | "awaiting.answer"
  | "artifact.publish"
  | "plan.create"
  | "plan.update"
  | "task.start"
  | "task.complete"
  | "task.fail"
  | "task.cancel"
  | "source.publish"
  | "run.complete"
  | "run.error"
  | "run.interrupt"
  | "run.stopped"
  | "run.expired"
  | "done";

export const ASSISTANT_RUN_EVENT_TYPES = [
  "request.query",
  "request.submit",
  "request.steer",
  "chat.start",
  "chat.update",
  "chat.created",
  "chat.updated",
  "chat.read",
  "chat.unread",
  "run.start",
  "run.cancel",
  "content.delta",
  "content.start",
  "content.snapshot",
  "content.end",
  "reasoning.start",
  "reasoning.delta",
  "reasoning.snapshot",
  "reasoning.end",
  "memory.reference",
  "memory.recalled",
  "memory.stored",
  "memory.skipped",
  "tool.start",
  "tool.args",
  "tool.snapshot",
  "tool.result",
  "tool.end",
  "action.start",
  "action.args",
  "action.snapshot",
  "action.result",
  "action.end",
  "awaiting.confirm",
  "awaiting.ask",
  "awaiting.payload",
  "awaiting.answer",
  "artifact.publish",
  "plan.create",
  "plan.update",
  "task.start",
  "task.complete",
  "task.fail",
  "task.cancel",
  "source.publish",
  "run.complete",
  "run.error",
  "run.interrupt",
  "run.stopped",
  "run.expired",
  "done"
] as const satisfies readonly AssistantRunEventType[];

export const ASSISTANT_LEGACY_STREAM_EVENT_TYPES = [
  "delta",
  "done",
  "error",
  "stopped"
] as const;

export const ASSISTANT_TERMINAL_EVENT_TYPES = [
  "done",
  "stopped",
  "error",
  "run.complete",
  "run.stopped",
  "run.error",
  "run.interrupt",
  "run.expired"
] as const satisfies readonly AssistantEventType[];

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
  source?: AssistantRunSource;
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
  artifactCount?: number;
  artifacts?: unknown[];
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
  source?: AssistantRunSource;
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
  artifactCount?: number;
  artifacts?: unknown[];
  data?: unknown;
}

export type AssistantEventListener = (event: AssistantEvent) => void;
export type NativeDialogVisibilityListener = (state: { open: boolean }) => void;

export interface DesktopApi {
  clipboard: {
    writeText: (text: string) => Promise<{ ok: boolean; message?: string }>;
  };
  assistant: {
    getSettings: () => Promise<AssistantSettingsPublic>;
    saveSettings: (input: AssistantSettingsInput) => Promise<AssistantSettingsPublic>;
    getMemorySettings: () => Promise<AssistantMemorySettings>;
    saveMemorySettings: (input: AssistantMemorySettingsInput) => Promise<AssistantMemorySettings>;
    getMemorySummary: () => Promise<AssistantMemorySummary>;
    listAgents: () => Promise<DesktopPetAgentOption[]>;
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
    buildSandboxImage: (itemId: string) => Promise<MarketCommandResult>;
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
  embeddedWeb: {
    executeInFrame: (request: EmbeddedWebExecuteInFrameRequest) => Promise<EmbeddedWebExecuteInFrameResult>;
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
