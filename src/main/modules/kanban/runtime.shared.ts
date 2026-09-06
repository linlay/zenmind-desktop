import fs from "node:fs";

import path from "node:path";

import { randomUUID } from "node:crypto";

import yaml from "js-yaml";

import type { App } from "electron";

import type {
  AssistantNavigationPushEvent,
  AssistantAttachment,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  KanbanCloudConfig,
  KanbanCloudConfigResult,
  KanbanCreateLocalProjectResult,
  KanbanCurrentUser,
  KanbanDeleteResult,
  KanbanIssue,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueResult,
  KanbanIssueUpdateInput,
  KanbanListResult,
  KanbanProject,
  KanbanPriority,
  KanbanRunState,
  KanbanRunIssueInput,
  KanbanRunIssueResult,
  KanbanSettings,
  KanbanSettingsInput,
  KanbanSettingsResult,
  KanbanSeverity,
  KanbanSyncMode,
  KanbanSyncState,
  KanbanOrigin,
  KanbanStatus
} from "../../../shared/contracts";

import { parseKanbanPriority } from "../../../shared/contracts";

import { PRODUCT_NAME } from "../../../shared/brand";

import { isAgentPlatformEpochMilliseconds } from "../../../shared/time-contract";

import { getDesktopDeviceInfo } from "../identity";

import { getDesktopDeviceId } from "../identity";

import { readDesktopSsoAccessToken, readDesktopSsoAccessTokenUser } from "../identity";

import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";

import {
  applyDesktopKanbanCloudSnapshot,
  completeDesktopKanbanCommandReceiptByRunId,
  createLocalDesktopKanbanIssue,
  deleteDesktopKanbanCloudMutation,
  deleteDesktopKanbanRunEvent,
  deleteDesktopKanbanIssue,
  ensureDesktopKanbanDefaultBinding,
  getDesktopKanbanCommandReceiptByRunId,
  getDesktopKanbanIssue,
  getDesktopKanbanManualRunByRunId,
  hasDesktopKanbanCloudProject,
  listPendingDesktopKanbanManualRuns,
  listPendingDesktopKanbanCommandReceipts,
  listDesktopKanbanCloudMutations,
  listDesktopKanbanRunEvents,
  markDesktopKanbanCommandReceiptReported,
  markDesktopKanbanCloudMutationAttempt,
  markDesktopKanbanRunEventAttempt,
  listDesktopKanbanIssues,
  moveDesktopKanbanIssue,
  readDesktopKanbanSyncCursor,
  recordDesktopKanbanCommandReceipt,
  recordDesktopKanbanCloudMutation,
  recordDesktopKanbanManualRun,
  recordDesktopKanbanRunEvent,
  tombstoneDesktopKanbanCloudIssue,
  updateDesktopKanbanIssue,
  updateDesktopKanbanCommandReceipt,
  updateDesktopKanbanCommandReceiptIdentity,
  updateDesktopKanbanManualRun,
  updateDesktopKanbanIssueRuntimeState,
  upsertDispatchedDesktopKanbanIssue,
  writeDesktopKanbanSyncCursor,
  type KanbanCloudSnapshot,
  type KanbanCommandReceipt
} from "./local-store";

import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

import {
  convertLocalProjectIssuesToLocal,
  createLocalDesktopProject,
  findLocalDesktopProject
} from "./local-projects";

import {
  KanbanDesktopWsClient,
  KanbanDesktopRequestError,
  type KanbanDesktopDelivery,
  type KanbanDesktopDeliveryApplyResult,
  type KanbanDesktopConnectionState,
  type KanbanDesktopIssueEvent,
  type KanbanDesktopIssueEventApplyResult,
  type KanbanDesktopSyncLocalProject,
  type KanbanDesktopWsConfig
} from "./ws-client";

import { t } from "../../support/i18n/main-i18n";

import { appendKanbanWsLog } from "../../support/logging/desktop";

export type AgentPlatformCaller<TApp> = <T = unknown>(
  app: TApp,
  path: string,
  options?: {
    method?: string;
    body?: unknown;
  }
) => Promise<T>;

export type KanbanRunFinishedPushResolution = {
  status: KanbanStatus;
  runState: Exclude<KanbanRunState, "running">;
  terminalEventType: "run.completed" | "run.failed" | "run.cancelled";
};

export function resolveKanbanRunFinishedPush(
  event: Pick<AssistantNavigationPushEvent, "frame" | "type" | "status" | "finishReason">
): KanbanRunFinishedPushResolution | null {
  if (event.frame !== "push" || event.type !== "run.finished") {
    return null;
  }
  const status = event.status?.trim() ?? "";
  const finishReason = event.finishReason?.trim() ?? "";
  if (status === "completed" && finishReason === "complete") {
    return { status: "completed", runState: "completed", terminalEventType: "run.completed" };
  }
  if (status === "failed" && finishReason === "error") {
    return { status: "todo", runState: "failed", terminalEventType: "run.failed" };
  }
  if (status === "interrupted" && finishReason === "cancel") {
    return { status: "todo", runState: "cancelled", terminalEventType: "run.cancelled" };
  }
  return null;
}

export function buildKanbanAutomationMessage(issue: KanbanIssue) {
  const message = issue.automationMessage?.trim() || issue.description.trim() || issue.title.trim();
  return [
    message,
    "",
    t("kanban.automation.messageIntro", { productName: PRODUCT_NAME }),
    t("kanban.automation.issueId", { id: issue.id }),
    t("kanban.automation.issueTitle", { title: issue.title })
  ].join("\n");
}

export function buildKanbanAutomationPayload(issue: KanbanIssue) {
  return {
    name: t("kanban.automation.name", { id: issue.id, title: issue.title }).slice(0, 120),
    description: t("kanban.automation.description", { productName: PRODUCT_NAME, id: issue.id }),
    cron: issue.automationCron?.trim() ?? "",
    agentKey: issue.assigneeAgentKey?.trim() ?? "",
    enabled: true,
    zoneId: issue.automationTimezone?.trim() || "Asia/Shanghai",
    query: {
      message: buildKanbanAutomationMessage(issue),
      hidden: true,
      params: {
        source: "kanban",
        issueId: issue.id
      }
    }
  };
}

export type AssistantBridgeLike = {
  listAgents: () => Promise<DesktopPetAgentOption[]>;
  startRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  stopRun?: (runId: string) => Promise<{ ok: boolean; message?: string }>;
  getChat?: (chatId: string) => Promise<{
    messages?: Array<{ runId?: string; role?: string; content?: string }>;
    events?: Array<{ runId?: string; seq?: number; type?: string; status?: string; message?: string; error?: string }>;
  } | null>;
};

export type KanbanRuntimeOptions = {
  app: App;
  assistantBridge: AssistantBridgeLike;
  callAgentPlatform: AgentPlatformCaller<App>;
  listLocalAgents?: () => DesktopPetAgentOption[];
  canUseDesktopSsoCredentials?: () => boolean;
  onChanged?: () => void;
  onDebug?: (message: string) => void;
};

export type KanbanDesktopConfigFile = {
  schemaVersion?: unknown;
  kanban?: unknown;
  enabled?: unknown;
  cloud?: unknown;
  serverUrl?: unknown;
  token?: unknown;
  remoteControlEnabled?: unknown;
  deviceAlias?: unknown;
};

export const KANBAN_CONFIG_FILE = "kanban.json";

export const DEFAULT_SELECTED_PROJECT_ID = "default";

export const ASSISTANT_AGENT_LIST_TIMEOUT_MS = 2_000;

export const REMOTE_START_RUN_ACK_TIMEOUT_MS = readPositiveIntegerEnv(
  "DESKTOP_KANBAN_REMOTE_START_ACK_TIMEOUT_MS",
  5_000
);

export function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseStructuredReviewText(value: string): { verdict: "approved" | "changes_requested" | "rejected"; summary: string } | undefined {
  const text = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const verdict = readText(parsed.verdict);
    const summary = readText(parsed.summary);
    if ((verdict === "approved" || verdict === "changes_requested" || verdict === "rejected") && summary) {
      return { verdict, summary };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function nullableText(value: unknown) {
  const text = readText(value);
  return text ? text : null;
}

export function optionalText(value: unknown) {
  const text = readText(value);
  return text ? text : undefined;
}

export function readBoolean(value: unknown) {
  return value === true;
}

export function readStringList(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(readText).filter(Boolean))]
    : [];
}

export function readEffortSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  const seconds = Math.trunc(value);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

export function readDueDate(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maxDay = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= maxDay ? value.trim() : null;
}

export function getKanbanConfigPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), KANBAN_CONFIG_FILE);
}

export function readKanbanOwnerConfig(input: unknown): KanbanDesktopConfigFile {
  if (!isRecord(input)) {
    return {};
  }
  return isRecord(input.kanban)
    ? input.kanban as KanbanDesktopConfigFile
    : input as KanbanDesktopConfigFile;
}

export function readInstalledAgentOptions(app: App): DesktopPetAgentOption[] {
  const agentsRoot = path.join(resolveRuntimeRoot(app), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: DesktopPetAgentOption[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const agentFile = ["agent.yml", "agent.yaml"]
      .map((fileName) => path.join(agentsRoot, entry.name, fileName))
      .find((filePath) => fs.existsSync(filePath));
    if (!agentFile) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(agentFile, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const agentKey = readText(parsed.key) || entry.name.trim();
    if (!agentKey) {
      continue;
    }
    agents.push({
      agentKey,
      displayName: readText(parsed.name) || agentKey,
      role: readText(parsed.role),
      unreadCount: 0
    });
  }
  return normalizeDesktopPetAgentOptions(agents);
}

export function normalizeKanbanCloudConfig(input: KanbanDesktopConfigFile): KanbanCloudConfig {
  return {
    serverUrl: readText(input.serverUrl),
    remoteControlEnabled: readBoolean(input.remoteControlEnabled),
    deviceAlias: readText(input.deviceAlias)
  };
}

export function hasKanbanCloudFields(input: KanbanDesktopConfigFile) {
  return "serverUrl" in input ||
    "token" in input ||
    "remoteControlEnabled" in input ||
    "deviceAlias" in input;
}

export function hasLegacyKanbanSelectedProjectId(input: unknown) {
  const owner = readKanbanOwnerConfig(input);
  const cloudInput = isRecord(owner.cloud)
    ? owner.cloud
    : isRecord(owner.kanban)
      ? owner.kanban
      : owner;
  return isRecord(cloudInput) && "selectedProjectId" in cloudInput;
}

export function hasLegacyKanbanToken(input: unknown) {
  const owner = readKanbanOwnerConfig(input);
  const cloudInput = isRecord(owner.cloud)
    ? owner.cloud
    : isRecord(owner.kanban)
      ? owner.kanban
      : owner;
  return isRecord(cloudInput) && "token" in cloudInput;
}

export function normalizeKanbanSettings(
  input: KanbanDesktopConfigFile,
  defaults: Partial<KanbanSettings> = {}
): KanbanSettings {
  const cloudInput = isRecord(input.cloud)
    ? input.cloud as KanbanDesktopConfigFile
    : isRecord(input.kanban)
      ? input.kanban as KanbanDesktopConfigFile
      : input;
  const hasCloudInput = hasKanbanCloudFields(cloudInput);
  const cloud = hasCloudInput
    ? normalizeKanbanCloudConfig(cloudInput)
    : defaults.cloud ?? normalizeKanbanCloudConfig({});
  const enabled = typeof input.enabled === "boolean"
    ? input.enabled
    : typeof defaults.enabled === "boolean"
      ? defaults.enabled
      : isKanbanCloudConfigComplete(cloud);
  return {
    enabled,
    cloud
  };
}

export function isKanbanCloudConfigComplete(config: KanbanCloudConfig) {
  return Boolean(config.serverUrl.trim());
}

export function readJsonConfigFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function readKanbanSettings(app: App, platform: NodeJS.Platform = process.platform): KanbanSettings {
  const configPath = getKanbanConfigPath(app, platform);
  if (fs.existsSync(configPath)) {
    const raw = readJsonConfigFile(configPath);
    const parsed = readKanbanOwnerConfig(raw);
    const settings = normalizeKanbanSettings(parsed);
    if (!isRecord(raw) || !isRecord(raw.cloud) || raw.enabled !== settings.enabled || hasLegacyKanbanSelectedProjectId(raw) || hasLegacyKanbanToken(raw)) {
      writeKanbanSettings(app, settings, platform);
    }
    return settings;
  }

  const settings = normalizeKanbanSettings({});
  writeKanbanSettings(app, settings, platform);
  return settings;
}

export function readKanbanWsConfig(app: App): KanbanDesktopWsConfig | null {
  return resolveKanbanWsConnection(app).config;
}

export type KanbanConnectionFallbackState = Extract<KanbanDesktopConnectionState, "disabled" | "auth_required">;

export function resolveKanbanWsConnection(
  app: App,
  canUseDesktopSsoCredentials = true
): { config: KanbanDesktopWsConfig | null; fallbackState: KanbanConnectionFallbackState } {
  const settings = readKanbanSettings(app);
  const config = settings.cloud;
  const serverUrl = readText(process.env.DESKTOP_KANBAN_SERVER_URL) ||
    readText(config.serverUrl);
  const remoteControlEnabled = process.env.DESKTOP_KANBAN_REMOTE_CONTROL_ENABLED === "true" ||
    config.remoteControlEnabled;
  if (!settings.enabled || !remoteControlEnabled || !serverUrl) {
    return { config: null, fallbackState: "disabled" };
  }
  if (!canUseDesktopSsoCredentials) {
    return { config: null, fallbackState: "auth_required" };
  }
  const token = readDesktopSsoAccessToken(app);
  if (!token || !readDesktopSsoAccessTokenUser(app)) {
    return { config: null, fallbackState: "auth_required" };
  }
  return {
    config: {
      serverUrl,
      token,
      selectedProjectId: readText(process.env.DESKTOP_KANBAN_PROJECT_ID) ||
        DEFAULT_SELECTED_PROJECT_ID
    },
    fallbackState: "disabled"
  };
}

export function readKanbanCloudConfig(app: App): KanbanCloudConfig {
  return readKanbanSettings(app).cloud;
}

export function writeKanbanSettings(
  app: App,
  input: KanbanSettings,
  platform: NodeJS.Platform = process.platform
): KanbanSettings {
  const settings = normalizeKanbanSettings({
    enabled: input.enabled,
    cloud: input.cloud
  });
  const configPath = getKanbanConfigPath(app, platform);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    enabled: settings.enabled,
    cloud: settings.cloud
  }, null, 2)}\n`, "utf8");
  return settings;
}

export function saveKanbanSettings(
  app: App,
  input: KanbanSettingsInput,
  platform: NodeJS.Platform = process.platform
): KanbanSettings {
  const current = readKanbanSettings(app, platform);
  return writeKanbanSettings(app, {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    cloud: normalizeKanbanCloudConfig({
      ...current.cloud,
      ...(isRecord(input.cloud) ? input.cloud : {})
    })
  }, platform);
}

export function writeKanbanCloudConfig(app: App, input: KanbanDesktopConfigFile): KanbanCloudConfig {
  const configPath = getKanbanConfigPath(app);
  return saveKanbanSettings(app, {
    ...(fs.existsSync(configPath) ? {} : { enabled: true }),
    cloud: input as Partial<KanbanCloudConfig>
  }).cloud;
}

export function getKanbanDeviceInfo(app: App) {
  const deviceInfo = getDesktopDeviceInfo(app);
  const config = readKanbanCloudConfig(app);
  const deviceName = readText(deviceInfo.configuredDeviceName) || readText(config.deviceAlias) || deviceInfo.deviceName;
  return {
    deviceName,
    deviceAlias: deviceName,
    hostname: deviceInfo.hostname || undefined,
    username: deviceInfo.username || undefined
  };
}

export function issueSyncMode(issue: KanbanIssue | null | undefined) {
  return issue?.syncMode === "cloud" ? "cloud" : "local";
}

export function getRemoteIssueId(issue: KanbanIssue) {
  return readText(issue.remoteIssueId) || readText(issue.id);
}

export function normalizeRemoteAccessLevel(value: unknown): AssistantStartRunRequest["accessLevel"] | undefined {
  const text = readText(value);
  return text === "default" || text === "auto_approve" || text === "full_access" ? text : undefined;
}

export function deliveryPayloadRecord(delivery: KanbanDesktopDelivery): Record<string, unknown> {
  return isRecord(delivery.payload) ? delivery.payload : {};
}

export function deliverySourceRevision(delivery: KanbanDesktopDelivery) {
  const payload = deliveryPayloadRecord(delivery);
  const revision = typeof delivery.sourceRevision === "number" && Number.isFinite(delivery.sourceRevision)
    ? delivery.sourceRevision
    : typeof payload.revision === "number" && Number.isFinite(payload.revision)
      ? payload.revision
      : 0;
  return Math.max(0, Math.floor(revision));
}

export function deliveryIssuePayload(delivery: KanbanDesktopDelivery) {
  const payload = deliveryPayloadRecord(delivery);
  return "issue" in payload ? payload.issue : null;
}

export function deliveryIssueId(delivery: KanbanDesktopDelivery) {
  const payload = deliveryPayloadRecord(delivery);
  const issue = deliveryIssuePayload(delivery);
  return readText(payload.issueId) ||
    readText(payload.deletedIssueId) ||
    (isRecord(issue) ? readText(issue.id) : "");
}

export function issueEventIssuePayload(event: KanbanDesktopIssueEvent) {
  const payload = isRecord(event.payload) ? event.payload : {};
  return event.issue ?? ("issue" in payload ? payload.issue : null);
}

export function issueEventIssueId(event: KanbanDesktopIssueEvent) {
  const issue = issueEventIssuePayload(event);
  return readText(event.issueId) ||
    readText(event.deletedIssueId) ||
    (isRecord(issue) ? readText(issue.id) : "");
}

export function stableClientEventId(deviceId: string, parts: Array<string | number | null | undefined>) {
  return [deviceId, ...parts.map((part) => readText(String(part ?? ""))).filter(Boolean)].join(":");
}

export function kanbanIssueFromAutomationPayload(payload: unknown): KanbanIssue | null {
  const record = isRecord(payload) && isRecord(payload.issue) ? payload.issue : payload;
  if (!isRecord(record)) {
    return null;
  }
  const now = new Date().toISOString();
  const id = readText(record.id);
  const title = readText(record.title);
  if (!id || !title) {
    return null;
  }
  return {
    id,
    localIssueId: optionalText(record.localIssueId),
    remoteIssueId: nullableText(record.remoteIssueId) ?? id,
    boardId: readText(record.boardId) || "default",
    projectId: readText(record.projectId) || "default",
    projectPath: optionalText(record.projectPath),
    projectName: optionalText(record.projectName),
    projectVersion: nullableText(record.projectVersion !== undefined ? record.projectVersion : record.version),
    dueDate: readDueDate(record.dueDate),
    dueRisk: nullableText(record.dueRisk),
    resolution: nullableText(record.resolution),
    securityLevelKey: nullableText(record.securityLevelKey),
    reporterId: nullableText(record.reporterId),
    componentKeys: readStringList(record.componentKeys),
    originalEstimate: readEffortSeconds(record.originalEstimate),
    remainingEstimate: readEffortSeconds(record.remainingEstimate),
    timeSpent: readEffortSeconds(record.timeSpent),
    parentIssueId: nullableText(record.parentIssueId),
    workflowId: readText(record.workflowId) || "workflow-standard-requirement",
    typeId: optionalText(record.issueTypeKey) ?? optionalText(record.typeId),
    issueTypeKey: optionalText(record.issueTypeKey) ?? optionalText(record.typeId),
    stageId: optionalText(record.stageId),
    stageKey: optionalText(record.stageKey),
    stageName: optionalText(record.stageName),
    statusId: optionalText(record.statusId),
    statusName: optionalText(record.statusName),
    statusKey: optionalText(record.statusKey),
    columnKey: optionalText(record.columnKey),
    title,
    description: readText(record.description),
    status: (readText(record.status) || "backlog") as KanbanStatus,
    priority: parseKanbanPriority(record.priority),
    severity: (["critical", "high", "medium", "low"] as const).includes(readText(record.severity) as "critical" | "high" | "medium" | "low")
      ? readText(record.severity) as NonNullable<KanbanIssue["severity"]>
      : null,
    assigneeAgentKey: nullableText(record.assigneeAgentKey),
    assigneeId: nullableText(record.assigneeId),
    workerType: readText(record.workerType) === "human" || readText(record.workerType) === "agent" ? readText(record.workerType) as "human" | "agent" : null,
    workerId: nullableText(record.workerId),
    workerAgent: nullableText(record.workerAgent),
    activeReviewId: nullableText(record.activeReviewId),
    activeIssueRunId: nullableText(record.activeIssueRunId),
    activeRunId: nullableText(record.activeIssueRunId) ?? nullableText(record.activeRunId),
    position: typeof record.position === "number" ? record.position : 1,
    chatId: nullableText(record.chatId),
    runId: nullableText(record.runId),
    runState: nullableText(record.runState) as KanbanRunState | null,
    automationId: nullableText(record.automationId),
    automationEnabled: readBoolean(record.automationEnabled),
    automationCron: nullableText(record.automationCron),
    automationMessage: nullableText(record.automationMessage),
    automationTimezone: nullableText(record.automationTimezone),
    attachmentChatId: nullableText(record.attachmentChatId),
    attachments: Array.isArray(record.attachments) ? record.attachments as KanbanIssue["attachments"] : [],
    syncMode: "cloud",
    syncState: "synced",
    origin: "cloud_dispatch",
    ownerUserId: nullableText(record.ownerUserId) ?? undefined,
    lastRemoteRevision: typeof record.revision === "number" ? record.revision : 0,
    lastSyncedAt: null,
    syncError: null,
    revision: typeof record.revision === "number" ? record.revision : 0,
    createdAt: readText(record.createdAt) || now,
    updatedAt: readText(record.updatedAt) || now
  };
}

export interface KanbanRuntimeMethodContext {
  wsClient: KanbanDesktopWsClient;
  connectionState: KanbanDesktopConnectionState;
  connectionFallbackState: KanbanConnectionFallbackState;
  commandReceiptProcessing: boolean;
  commandReceiptRetryTimer: NodeJS.Timeout | null;
  cloudMutationProcessing: boolean;
  runEventProcessing: boolean;
  negotiatedContractVersion: string;
  negotiatedCapabilities: string[];
  options: KanbanRuntimeOptions;
  start(): void;
  stop(): void;
  refreshDeviceInfo(): void;
  listIssues(): KanbanListResult;
  getCloudConfig(): KanbanCloudConfigResult;
  getSettings(): KanbanSettingsResult;
  resyncCloudBoard(): Promise<KanbanListResult>;
  listLocalProjects(): Promise<{ ok: boolean; projects: KanbanProject[]; message: string; }>;
  listSyncLocalProjects(): Promise<KanbanDesktopSyncLocalProject[]>;
  saveCloudConfig(input: KanbanCloudConfig): KanbanCloudConfigResult;
  saveSettings(input: KanbanSettingsInput): KanbanSettingsResult;
  createIssue(input: KanbanIssueInput): Promise<KanbanIssueResult>;
  updateIssue(issueId: string, input: KanbanIssueUpdateInput): Promise<KanbanIssueResult>;
  moveIssue(input: KanbanIssueMoveInput): Promise<KanbanIssueResult>;
  deleteIssueWithAutomation(issueId: string, callAgentPlatform?: AgentPlatformCaller<App>): Promise<KanbanDeleteResult | { ok: false; message: string; issues: KanbanIssue[]; }>;
  syncIssueAutomation(issueId: string, callAgentPlatform?: AgentPlatformCaller<App>): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[]; }>;
  claimIssue(issueId: string): Promise<KanbanIssueResult>;
  runIssue(input: KanbanRunIssueInput): Promise<KanbanRunIssueResult>;
  bindHumanReferenceChat(input: { issueId: string; stageId: string; statusId: string; chatId: string }): Promise<{ ok: boolean; message?: string; }>;
  unbindHumanReferenceChat(issueChatId: string): Promise<{ ok: boolean; message?: string; }>;
  sendCloudMutation(item: ReturnType<typeof listDesktopKanbanCloudMutations>[number]): Promise<{ ok: boolean; message: string; issue?: KanbanIssue; }>;
  flushCloudOutboxes(): Promise<void>;
  flushCloudMutationOutbox(): Promise<void>;
  flushRunEventOutbox(): Promise<void>;
  sendRunEventOutboxItem(item: ReturnType<typeof listDesktopKanbanRunEvents>[number]): Promise<{ accepted: boolean; queued: boolean; message: string; }>;
  handleRejectedRunEvent(item: ReturnType<typeof listDesktopKanbanRunEvents>[number], message: string): Promise<void>;
  recoverPendingManualRuns(): Promise<void>;
  sendNavigationPushEvent(event: AssistantNavigationPushEvent): void;
  currentUser(): KanbanCurrentUser;
  refreshConnection(options?: { forceReconnect?: boolean }): void;
  applySnapshot(snapshot: KanbanCloudSnapshot): void;
  applyDispatch(issue: unknown, revision: number): KanbanIssueResult;
  cloudIssueReadOnlyResult(): KanbanIssueResult;
  cloudIssueReadOnlyDeleteResult(issues: KanbanIssue[]): { ok: false; message: string; issues: KanbanIssue[]; };
  applyIssueEvent(event: KanbanDesktopIssueEvent): Promise<KanbanDesktopDeliveryApplyResult>;
  applyDelivery(delivery: KanbanDesktopDelivery): Promise<KanbanDesktopDeliveryApplyResult>;
  processPendingCommandReceipts(): Promise<void>;
  inspectReceiptRun(chatId: string, runId: string): Promise<{ exists: boolean; terminalEventType?: "run.completed" | "run.failed" | "run.cancelled"; message?: string; error?: string; }>;
  localChatExists(chatId: string): Promise<boolean>;
  readStructuredReviewResult(chatId: string, runId: string): Promise<{ verdict: "approved" | "changes_requested" | "rejected"; summary: string; } | undefined>;
  reportFailedCommandReceipt(receipt: KanbanCommandReceipt, error: string): Promise<void>;
  scheduleCommandReceiptRecovery(): void;
  appendRunEvent(input: {
    sourceDeliverySeq?: number;
    projectId?: string;
    issueId: string;
    issueRunId?: string | null;
    runId?: string | null;
    chatId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<{ accepted: boolean; queued: boolean; message: string; }>;
  createLocalProject(payload: unknown): KanbanCreateLocalProjectResult;
  bindLocalProject(payload: unknown): { ok: boolean; message: string; project?: undefined; } | { ok: boolean; message: string; project: { id: string; name: string; slug: string; path: string; }; };
  unbindLocalProject(payload: unknown): { ok: boolean; message: string; };
  listAgents(): Promise<DesktopPetAgentOption[]>;
  startRemoteRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult>;
  handleRemoteStartFailure(runId: string, chatId: string, message: string): Promise<void>;
  notifyChanged(): void;
  syncAutomationForIssue(issue: KanbanIssue, callAgentPlatform: AgentPlatformCaller<App>): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[]; }>;
  syncRemoteAutomationPayload(payload: unknown): Promise<{ ok: boolean; message: string; issue?: undefined; } | { ok: boolean; message: string; issue: { automationId: null; automationEnabled: boolean; id: string; localIssueId?: string; remoteIssueId?: string | null; boardId?: string; projectId?: string; projectPath?: string; projectName?: string; projectVersion?: string | null; dueDate?: string | null; dueRisk?: string | null; resolution?: string | null; securityLevelKey?: string | null; reporterId?: string | null; componentKeys: string[]; originalEstimate: number; remainingEstimate: number; timeSpent: number; parentIssueId?: string | null; workflowId?: string; typeId?: string; issueTypeKey?: string; stageId?: string; stageKey?: string; stageName?: string; statusId?: string; statusName?: string; statusKey?: string; columnKey?: string; title: string; description: string; status: KanbanStatus; priority: KanbanPriority | null; severity: KanbanSeverity | null; assigneeAgentKey: string | null; assigneeId?: string | null; workerType?: "human" | "agent" | null; workerId?: string | null; workerAgent?: string | null; activeReviewId?: string | null; activeIssueRunId?: string | null; activeRunId?: string | null; position: number; chatId: string | null; runId: string | null; runState: KanbanRunState | null; runAgentKey?: string | null; runCommandId?: string | null; runStartedAt?: string | null; runFinishedAt?: string | null; runResultMessage?: string | null; runErrorMessage?: string | null; dispatchState?: "waiting_for_device" | "delivered" | "running" | "completed" | "failed" | "cancelled" | null; dispatchDeviceId?: string | null; dispatchCommandId?: string | null; dispatchUpdatedAt?: string | null; automationCron: string | null; automationMessage: string | null; automationTimezone: string | null; attachmentChatId: string | null; attachments: AssistantAttachment[]; customFields?: Record<string, unknown>; createdBy?: string | null; updatedBy?: string | null; createdByAgent?: string | null; updatedByAgent?: string | null; syncMode?: KanbanSyncMode; syncState?: KanbanSyncState; origin?: KanbanOrigin; ownerUserId?: string; lastRemoteRevision?: number; lastSyncedAt?: string | null; syncError?: string | null; revision?: number; createdAt: string; updatedAt: string; }; } | { ok: boolean; message: string; issue: { automationId: string; automationEnabled: boolean; id: string; localIssueId?: string; remoteIssueId?: string | null; boardId?: string; projectId?: string; projectPath?: string; projectName?: string; projectVersion?: string | null; dueDate?: string | null; dueRisk?: string | null; resolution?: string | null; securityLevelKey?: string | null; reporterId?: string | null; componentKeys: string[]; originalEstimate: number; remainingEstimate: number; timeSpent: number; parentIssueId?: string | null; workflowId?: string; typeId?: string; issueTypeKey?: string; stageId?: string; stageKey?: string; stageName?: string; statusId?: string; statusName?: string; statusKey?: string; columnKey?: string; title: string; description: string; status: KanbanStatus; priority: KanbanPriority | null; severity: KanbanSeverity | null; assigneeAgentKey: string | null; assigneeId?: string | null; workerType?: "human" | "agent" | null; workerId?: string | null; workerAgent?: string | null; activeReviewId?: string | null; activeIssueRunId?: string | null; activeRunId?: string | null; position: number; chatId: string | null; runId: string | null; runState: KanbanRunState | null; runAgentKey?: string | null; runCommandId?: string | null; runStartedAt?: string | null; runFinishedAt?: string | null; runResultMessage?: string | null; runErrorMessage?: string | null; dispatchState?: "waiting_for_device" | "delivered" | "running" | "completed" | "failed" | "cancelled" | null; dispatchDeviceId?: string | null; dispatchCommandId?: string | null; dispatchUpdatedAt?: string | null; automationCron: string | null; automationMessage: string | null; automationTimezone: string | null; attachmentChatId: string | null; attachments: AssistantAttachment[]; customFields?: Record<string, unknown>; createdBy?: string | null; updatedBy?: string | null; createdByAgent?: string | null; updatedByAgent?: string | null; syncMode?: KanbanSyncMode; syncState?: KanbanSyncState; origin?: KanbanOrigin; ownerUserId?: string; lastRemoteRevision?: number; lastSyncedAt?: string | null; syncError?: string | null; revision?: number; createdAt: string; updatedAt: string; }; }>;
}

export function normalizeDesktopPetAgentOptions(agents: DesktopPetAgentOption[]) {
  const seen = new Set<string>();
  const result: DesktopPetAgentOption[] = [];
  for (const agent of agents) {
    const agentKey = typeof agent?.agentKey === "string" ? agent.agentKey.trim() : "";
    if (!agentKey || seen.has(agentKey)) {
      continue;
    }
    seen.add(agentKey);
    const displayName = typeof agent.displayName === "string" && agent.displayName.trim() ? agent.displayName.trim() : agentKey;
    const role = typeof agent.role === "string" ? agent.role.trim() : "";
    const unreadCount = Number.isFinite(agent.unreadCount) ? Math.max(0, Math.round(agent.unreadCount)) : 0;
    result.push({
      agentKey,
      displayName,
      role,
      ...(agent.icon ? { icon: agent.icon } : {}),
      unreadCount
    });
  }
  return result;
}

export function createKanbanRemoteChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function createKanbanRemoteRunId() {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function buildDesktopKanbanRunPrompt(issue: KanbanIssue) {
  return [readText(issue.title), readText(issue.description)].filter(Boolean).join("\n\n");
}

export function waitForRemoteStartRunAck(startRun: Promise<AssistantStartRunResult>, timeoutMs: number) {
  return new Promise<AssistantStartRunResult | null>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    startRun.then((result) => {
      clearTimeout(timeout);
      resolve(result);
    }).catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export async function withTimeout<T>(producer: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(producer),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
