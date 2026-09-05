import type { AssistantAttachment } from "./attachments";

export const KANBAN_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "completed"
] as const;

export const KANBAN_PRIORITIES = [
  "P0",
  "P1",
  "P2",
  "P3"
] as const;

export const KANBAN_RUN_STATES = [
  "running",
  "completed",
  "failed",
  "cancelled"
] as const;

export type KanbanStatus = typeof KANBAN_STATUSES[number];
export type KanbanPriority = typeof KANBAN_PRIORITIES[number];
export type KanbanWirePriority = "urgent" | "high" | "medium" | "low";
export type KanbanSeverity = "critical" | "high" | "medium" | "low";
export type KanbanRunState = typeof KANBAN_RUN_STATES[number];
export type KanbanSyncMode = "local" | "cloud";
export type KanbanSyncState = "local" | "syncing" | "synced" | "error";
export type KanbanOrigin = "desktop" | "cloud_dispatch";

const LEGACY_KANBAN_PRIORITY_ALIASES: Record<string, KanbanPriority> = {
  urgent: "P0",
  high: "P1",
  medium: "P2",
  low: "P3"
};

export function parseKanbanPriority(value: unknown): KanbanPriority | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (KANBAN_PRIORITIES.includes(normalized as KanbanPriority)) {
    return normalized as KanbanPriority;
  }
  return LEGACY_KANBAN_PRIORITY_ALIASES[value.trim().toLowerCase()] ?? null;
}

export interface KanbanCurrentUser {
  id: string;
  name: string;
  email: string;
  source: "sso" | "device";
}

export interface KanbanCloudUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  status?: string;
}

export interface KanbanIssueTypeDef {
  key: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  position?: number;
  isSystem?: boolean;
  isActive?: boolean;
}

export interface KanbanIssueFieldDef {
  id: string;
  key: string;
  name: string;
  valueType: string;
  description?: string;
  unit?: string;
}

export interface KanbanIssueFieldContext {
  id: string;
  fieldId: string;
  projectId?: string | null;
  issueTypeKey?: string | null;
  workflowId?: string | null;
  required: boolean;
  position: number;
  defaultValue?: unknown;
  validation?: Record<string, unknown>;
  ui?: Record<string, unknown>;
  isActive: boolean;
}

export interface KanbanIssueFieldOption {
  id: string;
  fieldId: string;
  key: string;
  name: string;
  value?: unknown;
  color?: string;
  position: number;
  isActive: boolean;
}

export interface KanbanResolvedIssueField {
  def: KanbanIssueFieldDef;
  context: KanbanIssueFieldContext;
  options: KanbanIssueFieldOption[];
  projectDistance?: number;
}

export interface KanbanWorkflow {
  id: string;
  issueTypeKey?: string;
  key: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  transitionMode?: string;
}

export interface KanbanWorkflowStage {
  id: string;
  workflowId: string;
  stageDefId?: string;
  key: string;
  name: string;
  color?: string;
  position?: number;
  isStart?: boolean;
  isEnd?: boolean;
}

export interface KanbanWorkflowStatus {
  id: string;
  workflowId: string;
  stageId?: string;
  statusDefId?: string;
  key: string;
  name: string;
  columnKey?: string;
  position?: number;
  isStart?: boolean;
  isTerminal?: boolean;
  isActive?: boolean;
  reviewRequired?: boolean;
}

export interface KanbanWorkflowStageDef {
  id: string;
  key: string;
  name: string;
  description?: string;
  isSystem?: boolean;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface KanbanWorkflowStatusDef {
  id: string;
  key: string;
  name: string;
  columnKey: string;
  description?: string;
  isSystem?: boolean;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface KanbanWorkflowTransition {
  id: string;
  workflowId: string;
  fromStageId: string;
  fromStatusId: string;
  toStageId: string;
  toStatusId: string;
  actionKey: string;
  name: string;
  actorType: string;
  requiresReview: boolean;
  isActive: boolean;
  position: number;
  createdAt?: string;
}

export interface KanbanWorkflowDecomposeRule {
  id: string;
  workflowId: string;
  fromStageId: string;
  fromStatusId: string;
  toStageId: string;
  toStatusId: string;
  childTypeKey: string;
  childWorkflowId?: string | null;
  actionKey: string;
  name: string;
  actorType: string;
  minItems: number;
  maxItems: number;
  isActive: boolean;
  position: number;
  createdAt?: string;
}

export interface KanbanTeam {
  id: string;
  slug: string;
  name: string;
  description?: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface KanbanTeamMember {
  teamId: string;
  userId: string;
  role: string;
  invitedBy?: string | null;
  joinedAt?: string;
  leftAt?: string | null;
}

export interface KanbanProjectPermission {
  id: string;
  projectId: string;
  principalType: string;
  principalId: string;
  role: string;
  inheritToChildren: boolean;
  createdBy?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
}

export interface KanbanIssueLabel {
  id: string;
  projectId: string;
  key: string;
  name: string;
  color?: string;
}

export interface KanbanIssueLabelLink {
  issueId: string;
  labelId: string;
}

export interface KanbanIssueDependency {
  id: string;
  fromIssueId: string;
  toIssueId: string;
  type: string;
  createdBy?: string | null;
  createdAt?: string;
}

export interface KanbanIssueReview {
  id: string;
  issueId: string;
  stageId: string;
  statusId: string;
  workerType: "human" | "agent";
  workerId?: string | null;
  workerAgent?: string | null;
  deviceId?: string | null;
  issueRunId?: string | null;
  issueChatId?: string | null;
  attemptState: "awaiting_human" | "queued" | "running" | "decided" | "failed" | "cancelled";
  reviewType: string;
  reviewerId?: string | null;
  status: string;
  requestedBy?: string | null;
  requestedAt: string;
  submittedAt?: string | null;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanIssueStageWorker {
  issueId: string;
  stageId: string;
  workerRole: "run" | "review";
  workerType: "human" | "agent";
  workerId?: string | null;
  workerAgent?: string | null;
  deviceId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanIssueChat {
  id: string;
  issueId: string;
  deviceId?: string | null;
  chatId: string;
  stageId: string;
  statusId: string;
  agentKey?: string | null;
  purpose: "run" | "review" | "human_reference";
  reviewId?: string | null;
  isPreferred: boolean;
  state: "active" | "missing" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface KanbanIssueRun {
  id: string;
  issueId: string;
  stageId: string;
  statusId: string;
  workerRole: "run" | "review";
  workerAgent: string;
  deviceId: string;
  issueChatId?: string | null;
  externalRunId?: string | null;
  source: "desktop_manual" | "cloud_dispatch" | "review";
  commandId?: string | null;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: string | null;
  finishedAt?: string | null;
  resultMessage?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanIssueComment {
  id: string;
  issueId: string;
  authorUserId?: string | null;
  authorAgent?: string | null;
  body: string;
  issueStageId?: string | null;
  issueStatusId?: string | null;
  issueRevision?: number;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanRecentEvent {
  id: number;
  projectId?: string | null;
  issueId?: string | null;
  revision: number;
  eventType: string;
  actorId?: string | null;
  actorAgent?: string | null;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface KanbanCloudDetailData {
  users: KanbanCloudUser[];
  issueTypes: KanbanIssueTypeDef[];
  issueFieldDefs: KanbanIssueFieldDef[];
  issueFieldContexts: KanbanIssueFieldContext[];
  issueFieldOptions: KanbanIssueFieldOption[];
  workflows: KanbanWorkflow[];
  workflowStageDefs: KanbanWorkflowStageDef[];
  workflowStatusDefs: KanbanWorkflowStatusDef[];
  workflowStages: KanbanWorkflowStage[];
  workflowStatuses: KanbanWorkflowStatus[];
  workflowTransitions: KanbanWorkflowTransition[];
  workflowDecomposeRules: KanbanWorkflowDecomposeRule[];
  teams: KanbanTeam[];
  teamMembers: KanbanTeamMember[];
  projectPermissions: KanbanProjectPermission[];
  issueLabels: KanbanIssueLabel[];
  issueLabelLinks: KanbanIssueLabelLink[];
  issueDependencies: KanbanIssueDependency[];
  reviews: KanbanIssueReview[];
  issueStageWorkers: KanbanIssueStageWorker[];
  issueChats: KanbanIssueChat[];
  issueRuns: KanbanIssueRun[];
  issueComments: KanbanIssueComment[];
  recentEvents: KanbanRecentEvent[];
}

export interface KanbanIssue {
  id: string;
  localIssueId?: string;
  remoteIssueId?: string | null;
  boardId?: string;
  projectId?: string;
  projectPath?: string;
  projectName?: string;
  projectVersion?: string | null;
  dueDate?: string | null;
  dueRisk?: string | null;
  resolution?: string | null;
  securityLevelKey?: string | null;
  reporterId?: string | null;
  componentKeys: string[];
  originalEstimate: number;
  remainingEstimate: number;
  timeSpent: number;
  parentIssueId?: string | null;
  workflowId?: string;
  typeId?: string;
  issueTypeKey?: string;
  stageId?: string;
  stageKey?: string;
  stageName?: string;
  statusId?: string;
  statusName?: string;
  statusKey?: string;
  columnKey?: string;
  title: string;
  description: string;
  status: KanbanStatus;
  priority: KanbanPriority | null;
  severity: KanbanSeverity | null;
  assigneeAgentKey: string | null;
  assigneeId?: string | null;
  workerType?: "human" | "agent" | null;
  workerId?: string | null;
  workerAgent?: string | null;
  activeReviewId?: string | null;
  activeIssueRunId?: string | null;
  /** Local-only legacy run identity. Cloud Contract 1.0 uses activeIssueRunId. */
  activeRunId?: string | null;
  position: number;
  chatId: string | null;
  runId: string | null;
  runState: KanbanRunState | null;
  runAgentKey?: string | null;
  runCommandId?: string | null;
  runStartedAt?: string | null;
  runFinishedAt?: string | null;
  runResultMessage?: string | null;
  runErrorMessage?: string | null;
  dispatchState?: "waiting_for_device" | "delivered" | "running" | "completed" | "failed" | "cancelled" | null;
  dispatchDeviceId?: string | null;
  dispatchCommandId?: string | null;
  dispatchUpdatedAt?: string | null;
  automationId: string | null;
  automationEnabled: boolean;
  automationCron: string | null;
  automationMessage: string | null;
  automationTimezone: string | null;
  attachmentChatId: string | null;
  attachments: AssistantAttachment[];
  customFields?: Record<string, unknown>;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdByAgent?: string | null;
  updatedByAgent?: string | null;
  syncMode?: KanbanSyncMode;
  syncState?: KanbanSyncState;
  origin?: KanbanOrigin;
  ownerUserId?: string;
  lastRemoteRevision?: number;
  lastSyncedAt?: string | null;
  syncError?: string | null;
  revision?: number;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanProject {
  id: string;
  parentId: string | null;
  slug: string;
  key?: string;
  name: string;
  description?: string;
  versions?: string[];
  components?: string[];
  path: string;
  depth: number;
  position: number;
  revision?: number;
  visibility?: string;
  defaultWorkflowId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanProjectBinding {
  id: string;
  projectId: string;
  deviceId: string;
  currentUserId?: string;
  localProjectId: string;
  localDisplayName: string;
  syncPolicy: "future" | "select" | "all";
  controlMode: "dispatch" | "observe" | "disabled";
  status: "active" | "paused" | "error";
  lastRemoteRevision: number;
  syncSinceAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanProjectBindingIssue {
  bindingId: string;
  issueId: string;
  source?: "select" | "dispatch" | "desktop_sync";
  createdAt?: string;
}

export interface KanbanDispatchBindingContext {
  id: string;
  localProjectId: string;
  localDisplayName?: string;
}

export interface KanbanCreateLocalProjectRequest {
  name: string;
  localProjectId?: string;
  cloudProjectId?: string;
  versions?: string[];
  components?: string[];
}

export interface KanbanCreateLocalProjectResult {
  ok: boolean;
  message?: string;
  project?: {
    id: string;
    name: string;
    slug?: string;
    path?: string;
  };
}

export interface KanbanIssueInput {
  title: string;
  projectId?: string | null;
  projectVersion?: string | null;
  /** @deprecated Compatibility alias; normalized to projectVersion at the Desktop boundary. */
  version?: string | null;
  dueDate?: string | null;
  resolution?: string | null;
  securityLevelKey?: string | null;
  reporterId?: string | null;
  componentKeys?: string[];
  originalEstimate?: number;
  remainingEstimate?: number;
  timeSpent?: number;
  description?: string | null;
  status?: KanbanStatus;
  priority?: KanbanPriority | KanbanWirePriority | null;
  severity?: KanbanSeverity | null;
  assigneeAgentKey?: string | null;
  assigneeId?: string | null;
  workerType?: "human" | "agent" | null;
  workerId?: string | null;
  workerAgent?: string | null;
  runState?: KanbanRunState | null;
  automationId?: string | null;
  automationEnabled?: boolean;
  automationCron?: string | null;
  automationMessage?: string | null;
  automationTimezone?: string | null;
  attachmentChatId?: string | null;
  attachments?: AssistantAttachment[];
  syncToCloud?: boolean;
}

export interface KanbanIssueUpdateInput {
  title?: string;
  projectId?: string | null;
  projectVersion?: string | null;
  /** @deprecated Compatibility alias; normalized to projectVersion at the Desktop boundary. */
  version?: string | null;
  dueDate?: string | null;
  resolution?: string | null;
  securityLevelKey?: string | null;
  reporterId?: string | null;
  componentKeys?: string[];
  originalEstimate?: number;
  remainingEstimate?: number;
  timeSpent?: number;
  description?: string | null;
  status?: KanbanStatus;
  priority?: KanbanPriority | KanbanWirePriority | null;
  severity?: KanbanSeverity | null;
  assigneeAgentKey?: string | null;
  assigneeId?: string | null;
  workerType?: "human" | "agent" | null;
  workerId?: string | null;
  workerAgent?: string | null;
  chatId?: string | null;
  runId?: string | null;
  runState?: KanbanRunState | null;
  automationId?: string | null;
  automationEnabled?: boolean;
  automationCron?: string | null;
  automationMessage?: string | null;
  automationTimezone?: string | null;
  attachmentChatId?: string | null;
  attachments?: AssistantAttachment[];
  syncToCloud?: boolean;
  baseIssueRevision?: number;
}

export interface KanbanIssueMoveInput {
  id: string;
  status: KanbanStatus;
  position: number;
  baseIssueRevision?: number;
}

export interface KanbanRunIssueInput {
  issueId: string;
  agentKey: string;
  forceNewChat?: boolean;
}

export interface KanbanRunIssueResult extends KanbanIssueResult {
  chatId?: string;
  runId?: string;
  agentKey?: string;
}

export interface KanbanListResult {
  ok: boolean;
  message: string;
  issues: KanbanIssue[];
  projects?: KanbanProject[];
  projectBindings?: KanbanProjectBinding[];
  projectBindingIssues?: KanbanProjectBindingIssue[];
  cloudDetails?: KanbanCloudDetailData;
  storagePath?: string;
  boardId?: string;
  projectId?: string;
  revision?: number;
  currentUser?: KanbanCurrentUser;
  connectionState?: "disabled" | "auth_required" | "connecting" | "open" | "closed" | "error";
  cloudCapabilities?: string[];
}

export interface KanbanCloudConfig {
  serverUrl: string;
  remoteControlEnabled: boolean;
  deviceAlias?: string;
}

export interface KanbanSettings {
  enabled: boolean;
  cloud: KanbanCloudConfig;
}

export interface KanbanSettingsInput {
  enabled?: boolean;
  cloud?: Partial<KanbanCloudConfig>;
}

export interface KanbanSettingsResult {
  ok: boolean;
  message: string;
  settings: KanbanSettings;
  configPath?: string;
  connectionState?: KanbanListResult["connectionState"];
}

export interface KanbanCloudConfigResult {
  ok: boolean;
  message: string;
  config: KanbanCloudConfig;
  configPath?: string;
  connectionState?: KanbanListResult["connectionState"];
}

export interface KanbanIssueResult {
  ok: boolean;
  message: string;
  issue?: KanbanIssue;
  issues: KanbanIssue[];
}

export interface KanbanDeleteResult {
  ok: boolean;
  message: string;
  deletedIssueId?: string;
  issues: KanbanIssue[];
}

export type KanbanChangedListener = () => void;
