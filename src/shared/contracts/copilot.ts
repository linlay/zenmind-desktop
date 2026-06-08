import type { DesktopCopilotPagePreferences, DesktopCopilotPagePreferencesInput } from "../assistant-settings";
import type { AssistantAttachment } from "./attachments";

export interface AssistantWorkerOpenRequest {
  workerKey?: string;
  agentKey?: string;
  chatId?: string;
  displayName?: string;
  role?: string;
  focusComposerOnComplete?: boolean;
}

export type AssistantWorkerOpenListener = (request: AssistantWorkerOpenRequest) => void;

export type AssistantNavigationAgentsChangedListener = (result: AssistantNavAgentItemsResult) => void;

export interface WebviewOpenTabRequest {
  sourceGuestId: number;
  url: string;
  partition?: string;
  userAgent?: string;
}

export type WebviewOpenTabListener = (request: WebviewOpenTabRequest) => void;

export type AssistantMessageRole = "user" | "assistant";

export type AssistantRunAction = "chat" | "summarize_page" | "explain_selection" | "extract_todos";
export type AssistantPermissionMode = "default" | "page_control" | "full_access";
export type AssistantRunSource = "sidebar" | "quick-assistant" | "copilot";

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
  browserTarget?: {
    kind: "webview";
    webContentsId?: number;
    surfaceId?: string;
    surfaceLabel?: string;
    currentUrl?: string;
    surfaceRoute?: string;
    embedPath?: string;
    browserSkill?: string;
  };
}

export type DesktopPageKind = "native" | "webview";

export interface DesktopPageContextSnapshot {
  route: string;
  pageKey: string;
  pageKind: DesktopPageKind;
  surfaceId?: string;
  surfaceLabel?: string;
  surfaceRoute?: string;
  embedPath?: string;
  webContentsId?: number;
  pageContext: AssistantPageContext | null;
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

export type AssistantNavAgentIcon = string | {
  color?: string;
  name?: string;
};

export interface AssistantNavChatItem {
  chatId: string;
  chatName: string;
  agentKey: string;
  updatedAt: string;
  lastRunId: string;
  lastRunContent: string;
  isRead: boolean;
  hasActiveRun: boolean;
  hasPendingAwaiting: boolean;
  awaitingMode?: AssistantAwaitingMode;
}

export interface AssistantNavAgentItem {
  agentKey: string;
  displayName: string;
  role: string;
  icon?: AssistantNavAgentIcon;
  unreadCount: number;
  unreadChatCount: number;
  chatCount: number;
  hasPendingAwaiting: boolean;
  latestChatId: string | null;
  latestPreview: string;
  updatedAt: string;
  recentChats: AssistantNavChatItem[];
  agentType?: string;
  mode?: string;
  workspaceDir?: string;
  workspaceDirExists?: boolean;
}

export interface AssistantNavAgentItemsResult {
  ok: boolean;
  items: AssistantNavAgentItem[];
  message: string;
  updatedAt: string;
}

export interface AssistantCreateCoderProjectRequest {
  workspaceDir: string;
  acpProxyId?: string;
}

export interface AssistantCreateCoderProjectResult {
  ok: boolean;
  message: string;
  agentKey?: string;
  workspaceDir?: string;
}

export interface AssistantNavActionResult {
  ok: boolean;
  message: string;
  filePath?: string;
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

export type AssistantAwaitingMode = "approval" | "question" | "form" | "plan";

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
  | "awaiting.asking"
  | "awaiting.payload"
  | "awaiting.answer"
  | "awaiting.answered"
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
  "awaiting.asking",
  "awaiting.payload",
  "awaiting.answer",
  "awaiting.answered",
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
