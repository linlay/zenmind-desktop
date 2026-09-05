import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import type { App } from "electron";
import type {
  AssistantNavigationPushEvent,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  KanbanCloudConfig,
  KanbanCloudConfigResult,
  KanbanCurrentUser,
  KanbanDeleteResult,
  KanbanIssue,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueResult,
  KanbanIssueUpdateInput,
  KanbanListResult,
  KanbanProject,
  KanbanRunState,
  KanbanRunIssueInput,
  KanbanRunIssueResult,
  KanbanSettings,
  KanbanSettingsInput,
  KanbanSettingsResult,
  KanbanStatus
} from "../shared/contracts";
import { parseKanbanPriority } from "../shared/contracts";
import { PRODUCT_NAME } from "../shared/brand";
import { isAgentPlatformEpochMilliseconds } from "../shared/time-contract";
import { getDesktopDeviceInfo } from "./desktop-device-info";
import { getDesktopDeviceId } from "./device-identity";
import { readDesktopSsoAccessToken, readDesktopSsoAccessTokenUser } from "./oidc-sso";
import { resolveRuntimeRoot } from "./env-bootstrap";
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
} from "./kanban-local-store";
import { getDesktopConfigRoot } from "./user-paths";
import {
  convertLocalProjectIssuesToLocal,
  createLocalDesktopProject,
  findLocalDesktopProject
} from "./kanban-local-projects";
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
} from "./kanban-desktop-ws-client";
import { t } from "./i18n/main-i18n";
import { appendKanbanWsLog } from "./logs/desktop";

type AgentPlatformCaller<TApp> = <T = unknown>(
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

function buildKanbanAutomationMessage(issue: KanbanIssue) {
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

type AssistantBridgeLike = {
  listAgents: () => Promise<DesktopPetAgentOption[]>;
  startRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  stopRun?: (runId: string) => Promise<{ ok: boolean; message?: string }>;
  getChat?: (chatId: string) => Promise<{
    messages?: Array<{ runId?: string; role?: string; content?: string }>;
    events?: Array<{ runId?: string; seq?: number; type?: string; status?: string; message?: string; error?: string }>;
  } | null>;
};

type KanbanRuntimeOptions = {
  app: App;
  assistantBridge: AssistantBridgeLike;
  callAgentPlatform: AgentPlatformCaller<App>;
  listLocalAgents?: () => DesktopPetAgentOption[];
  canUseDesktopSsoCredentials?: () => boolean;
  onChanged?: () => void;
  onDebug?: (message: string) => void;
};

type KanbanDesktopConfigFile = {
  schemaVersion?: unknown;
  kanban?: unknown;
  enabled?: unknown;
  cloud?: unknown;
  serverUrl?: unknown;
  token?: unknown;
  remoteControlEnabled?: unknown;
  deviceAlias?: unknown;
};

const KANBAN_CONFIG_FILE = "kanban.json";
const DEFAULT_SELECTED_PROJECT_ID = "default";
const ASSISTANT_AGENT_LIST_TIMEOUT_MS = 2_000;
const REMOTE_START_RUN_ACK_TIMEOUT_MS = readPositiveIntegerEnv(
  "DESKTOP_KANBAN_REMOTE_START_ACK_TIMEOUT_MS",
  5_000
);

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseStructuredReviewText(value: string): { verdict: "approved" | "changes_requested" | "rejected"; summary: string } | undefined {
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

function nullableText(value: unknown) {
  const text = readText(value);
  return text ? text : null;
}

function optionalText(value: unknown) {
  const text = readText(value);
  return text ? text : undefined;
}

function readBoolean(value: unknown) {
  return value === true;
}

function readStringList(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(readText).filter(Boolean))]
    : [];
}

function readEffortSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  const seconds = Math.trunc(value);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

function readDueDate(value: unknown) {
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

function getKanbanConfigPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), KANBAN_CONFIG_FILE);
}


function readKanbanOwnerConfig(input: unknown): KanbanDesktopConfigFile {
  if (!isRecord(input)) {
    return {};
  }
  return isRecord(input.kanban)
    ? input.kanban as KanbanDesktopConfigFile
    : input as KanbanDesktopConfigFile;
}

function readInstalledAgentOptions(app: App): DesktopPetAgentOption[] {
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

function normalizeKanbanCloudConfig(input: KanbanDesktopConfigFile): KanbanCloudConfig {
  return {
    serverUrl: readText(input.serverUrl),
    remoteControlEnabled: readBoolean(input.remoteControlEnabled),
    deviceAlias: readText(input.deviceAlias)
  };
}

function hasKanbanCloudFields(input: KanbanDesktopConfigFile) {
  return "serverUrl" in input ||
    "token" in input ||
    "remoteControlEnabled" in input ||
    "deviceAlias" in input;
}

function hasLegacyKanbanSelectedProjectId(input: unknown) {
  const owner = readKanbanOwnerConfig(input);
  const cloudInput = isRecord(owner.cloud)
    ? owner.cloud
    : isRecord(owner.kanban)
      ? owner.kanban
      : owner;
  return isRecord(cloudInput) && "selectedProjectId" in cloudInput;
}

function hasLegacyKanbanToken(input: unknown) {
  const owner = readKanbanOwnerConfig(input);
  const cloudInput = isRecord(owner.cloud)
    ? owner.cloud
    : isRecord(owner.kanban)
      ? owner.kanban
      : owner;
  return isRecord(cloudInput) && "token" in cloudInput;
}

function normalizeKanbanSettings(
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

function isKanbanCloudConfigComplete(config: KanbanCloudConfig) {
  return Boolean(config.serverUrl.trim());
}

function readJsonConfigFile(filePath: string) {
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

type KanbanConnectionFallbackState = Extract<KanbanDesktopConnectionState, "disabled" | "auth_required">;

function resolveKanbanWsConnection(
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

function readKanbanCloudConfig(app: App): KanbanCloudConfig {
  return readKanbanSettings(app).cloud;
}

function writeKanbanSettings(
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

function writeKanbanCloudConfig(app: App, input: KanbanDesktopConfigFile): KanbanCloudConfig {
  const configPath = getKanbanConfigPath(app);
  return saveKanbanSettings(app, {
    ...(fs.existsSync(configPath) ? {} : { enabled: true }),
    cloud: input as Partial<KanbanCloudConfig>
  }).cloud;
}

export function writeKanbanSettingsIfAbsent(app: App, input: KanbanSettingsInput) {
  const configPath = getKanbanConfigPath(app);
  if (fs.existsSync(configPath)) {
    return false;
  }
  saveKanbanSettings(app, input);
  return true;
}

function getKanbanDeviceInfo(app: App) {
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

function issueSyncMode(issue: KanbanIssue | null | undefined) {
  return issue?.syncMode === "cloud" ? "cloud" : "local";
}

function getRemoteIssueId(issue: KanbanIssue) {
  return readText(issue.remoteIssueId) || readText(issue.id);
}

function normalizeRemoteAccessLevel(value: unknown): AssistantStartRunRequest["accessLevel"] | undefined {
  const text = readText(value);
  return text === "default" || text === "auto_approve" || text === "full_access" ? text : undefined;
}

function deliveryPayloadRecord(delivery: KanbanDesktopDelivery): Record<string, unknown> {
  return isRecord(delivery.payload) ? delivery.payload : {};
}

function deliverySourceRevision(delivery: KanbanDesktopDelivery) {
  const payload = deliveryPayloadRecord(delivery);
  const revision = typeof delivery.sourceRevision === "number" && Number.isFinite(delivery.sourceRevision)
    ? delivery.sourceRevision
    : typeof payload.revision === "number" && Number.isFinite(payload.revision)
      ? payload.revision
      : 0;
  return Math.max(0, Math.floor(revision));
}

function deliveryIssuePayload(delivery: KanbanDesktopDelivery) {
  const payload = deliveryPayloadRecord(delivery);
  return "issue" in payload ? payload.issue : null;
}

function deliveryIssueId(delivery: KanbanDesktopDelivery) {
  const payload = deliveryPayloadRecord(delivery);
  const issue = deliveryIssuePayload(delivery);
  return readText(payload.issueId) ||
    readText(payload.deletedIssueId) ||
    (isRecord(issue) ? readText(issue.id) : "");
}

function issueEventIssuePayload(event: KanbanDesktopIssueEvent) {
  const payload = isRecord(event.payload) ? event.payload : {};
  return event.issue ?? ("issue" in payload ? payload.issue : null);
}

function issueEventIssueId(event: KanbanDesktopIssueEvent) {
  const issue = issueEventIssuePayload(event);
  return readText(event.issueId) ||
    readText(event.deletedIssueId) ||
    (isRecord(issue) ? readText(issue.id) : "");
}

function stableClientEventId(deviceId: string, parts: Array<string | number | null | undefined>) {
  return [deviceId, ...parts.map((part) => readText(String(part ?? ""))).filter(Boolean)].join(":");
}

function kanbanIssueFromAutomationPayload(payload: unknown): KanbanIssue | null {
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

export class KanbanRuntime {
  private readonly wsClient: KanbanDesktopWsClient;
  private connectionState: KanbanDesktopConnectionState = "disabled";
  private connectionFallbackState: KanbanConnectionFallbackState = "disabled";
  private commandReceiptProcessing = false;
  private commandReceiptRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private cloudMutationProcessing = false;
  private runEventProcessing = false;
  private negotiatedContractVersion = "";
  private negotiatedCapabilities: string[] = [];

  constructor(private readonly options: KanbanRuntimeOptions) {
    this.wsClient = new KanbanDesktopWsClient({
      capabilities: [
        "command.dispatchIssue",
        "command.runIssue",
        "command.reviewIssue",
        "run.event.append",
        "issue.run.prepare",
        "issue.chat.bind",
        "issue.chat.unbind",
        "issue.claim",
        "agent.listDesktop",
        "automation.sync"
      ],
      getDeviceId: () => getDesktopDeviceId(this.options.app),
      getDeviceInfo: () => getKanbanDeviceInfo(this.options.app),
      getSyncCursor: () => readDesktopKanbanSyncCursor(this.options.app, this.currentUser()),
      onSyncCursor: (cursor) => {
        writeDesktopKanbanSyncCursor(this.options.app, this.currentUser(), cursor);
      },
      onSnapshot: (snapshot) => this.applySnapshot(snapshot),
      onDelivery: (delivery) => this.applyDelivery(delivery),
      onDeliveryAcked: () => this.processPendingCommandReceipts(),
      onIssueEvent: (event) => this.applyIssueEvent(event),
      onDispatchIssue: (issue, revision) => this.applyDispatch(issue, revision),
      onListAgents: () => this.listAgents(),
      onStartRun: (request) => this.startRemoteRun(request),
      onAutomationSync: (payload) => this.syncRemoteAutomationPayload(payload),
      onListLocalProjects: () => this.listLocalProjects(),
      onListSyncLocalProjects: () => this.listSyncLocalProjects(),
      onCreateLocalProject: (payload) => Promise.resolve(this.createLocalProject(payload)),
      onBindProject: (payload) => Promise.resolve(this.bindLocalProject(payload)),
      onUnbindProject: (payload) => Promise.resolve(this.unbindLocalProject(payload)),
      onContractNegotiated: (contractVersion, capabilities) => {
        this.negotiatedContractVersion = contractVersion;
        this.negotiatedCapabilities = capabilities;
        this.notifyChanged();
      },
      onConnected: () => {
        void this.flushCloudOutboxes()
          .then(() => this.recoverPendingManualRuns())
          .then(() => this.processPendingCommandReceipts())
          .catch((error) => this.options.onDebug?.(error instanceof Error ? error.message : String(error)));
      },
      onStateChanged: (state) => {
        this.connectionState = state === "disabled" ? this.connectionFallbackState : state;
        this.notifyChanged();
      },
      onDebug: (message) => appendKanbanWsLog(this.options.app, {
        event: "debug",
        message
      }),
      onWsLog: (entry) => appendKanbanWsLog(this.options.app, entry)
    });
  }

  start() {
    this.refreshConnection();
  }

  stop() {
    if (this.commandReceiptRetryTimer) {
      clearTimeout(this.commandReceiptRetryTimer);
      this.commandReceiptRetryTimer = null;
    }
    this.connectionFallbackState = "disabled";
    this.negotiatedContractVersion = "";
    this.negotiatedCapabilities = [];
    this.wsClient.stop();
  }

  refreshDeviceInfo() {
    this.refreshConnection({ forceReconnect: true });
    this.notifyChanged();
  }

  listIssues(): KanbanListResult {
    this.refreshConnection();
    return {
      ...listDesktopKanbanIssues(this.options.app, this.currentUser(), this.connectionState),
      cloudCapabilities: this.negotiatedContractVersion.startsWith("1.")
        ? [
          ...(this.negotiatedCapabilities.includes("issue.claim") ? ["issue.claim"] : []),
          ...(this.negotiatedCapabilities.includes("run.event.append") ? ["run.event.append"] : []),
          ...(this.negotiatedCapabilities.includes("issue.chat.bind") ? ["issue.chat.bind"] : [])
        ]
        : []
    };
  }

  getCloudConfig(): KanbanCloudConfigResult {
    this.refreshConnection();
    return {
      ok: true,
      message: t("kanban.runtime.cloudConfigLoaded"),
      config: readKanbanCloudConfig(this.options.app),
      configPath: getKanbanConfigPath(this.options.app),
      connectionState: this.connectionState
    };
  }

  getSettings(): KanbanSettingsResult {
    this.refreshConnection();
    return {
      ok: true,
      message: t("kanban.runtime.settingsLoaded"),
      settings: readKanbanSettings(this.options.app),
      configPath: getKanbanConfigPath(this.options.app),
      connectionState: this.connectionState
    };
  }

  async resyncCloudBoard(): Promise<KanbanListResult> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    if (!this.wsClient.isOpen()) {
      return {
        ...listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState),
        ok: false,
        message: t("kanban.cloudSync.notConnected")
      };
    }
    try {
      await this.wsClient.resyncFromCloud();
      return listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState);
    } catch (error) {
      return {
        ...listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState),
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listLocalProjects(): Promise<{ ok: boolean; projects: KanbanProject[]; message: string }> {
    const result = this.listIssues();
    return {
      ok: true,
      projects: result.projects ?? [],
      message: t("kanban.runtime.localProjectsLoaded")
    };
  }

  async listSyncLocalProjects(): Promise<KanbanDesktopSyncLocalProject[]> {
    const deviceId = getDesktopDeviceId(this.options.app);
    let result = this.listIssues();
    let bindings = (result.projectBindings ?? []).filter((binding) =>
      binding.deviceId === deviceId &&
      binding.status === "active"
    );
    if (bindings.length === 0) {
      const cloud = readKanbanCloudConfig(this.options.app);
      if (cloud.remoteControlEnabled) {
        ensureDesktopKanbanDefaultBinding(this.options.app, this.currentUser(), deviceId, readText(process.env.DESKTOP_KANBAN_PROJECT_ID) || DEFAULT_SELECTED_PROJECT_ID);
        result = this.listIssues();
        bindings = (result.projectBindings ?? []).filter((binding) => binding.deviceId === deviceId && binding.status === "active");
      }
    }
    if (bindings.length > 0) {
      return bindings.map((binding) => ({
        projectId: binding.projectId,
        localProjectId: binding.localProjectId,
        localDisplayName: binding.localDisplayName || binding.localProjectId,
        controlMode: binding.controlMode === "disabled"
          ? "disabled"
          : binding.controlMode === "observe" ? "readonly" : "execute"
      }));
    }
    return [];
  }

  saveCloudConfig(input: KanbanCloudConfig): KanbanCloudConfigResult {
    const config = writeKanbanCloudConfig(this.options.app, input);
    this.refreshConnection({ forceReconnect: true });
    return {
      ok: true,
      message: config.serverUrl ? t("kanban.runtime.cloudConfigSavedReconnect") : t("kanban.runtime.cloudConfigSavedClosed"),
      config,
      configPath: getKanbanConfigPath(this.options.app),
      connectionState: this.connectionState
    };
  }

  saveSettings(input: KanbanSettingsInput): KanbanSettingsResult {
    const settings = saveKanbanSettings(this.options.app, input);
    this.refreshConnection({ forceReconnect: true });
    const requestedEnable = input.enabled === true;
    return {
      ok: true,
      message: requestedEnable && !settings.enabled
        ? t("kanban.runtime.settingsNeedsCloudConfig")
        : settings.enabled
          ? t("kanban.runtime.settingsSaved")
          : t("kanban.runtime.disabled"),
      settings,
      configPath: getKanbanConfigPath(this.options.app),
      connectionState: this.connectionState
    };
  }

  async createIssue(input: KanbanIssueInput): Promise<KanbanIssueResult> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    if (input.syncToCloud !== true) {
      return createLocalDesktopKanbanIssue(this.options.app, currentUser, input);
    }
    return this.cloudIssueReadOnlyResult();
  }

  async updateIssue(issueId: string, input: KanbanIssueUpdateInput): Promise<KanbanIssueResult> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, issueId);
    if (!issue) {
      return {
        ok: false,
        message: t("kanban.runtime.missing"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }

    if (issueSyncMode(issue) === "local") {
      if (input.syncToCloud === true) {
        return this.cloudIssueReadOnlyResult();
      }
      return updateDesktopKanbanIssue(this.options.app, currentUser, issue.id, input);
    }

    return this.cloudIssueReadOnlyResult();
  }

  async moveIssue(input: KanbanIssueMoveInput): Promise<KanbanIssueResult> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, input.id);
    if (!issue) {
      return {
        ok: false,
        message: t("kanban.runtime.missing"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (issueSyncMode(issue) === "local") {
      return moveDesktopKanbanIssue(this.options.app, currentUser, input);
    }
    return this.cloudIssueReadOnlyResult();
  }

  async deleteIssueWithAutomation(
    issueId: string,
    callAgentPlatform: AgentPlatformCaller<App> = this.options.callAgentPlatform
  ): Promise<KanbanDeleteResult | { ok: false; message: string; issues: KanbanIssue[] }> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, issueId);
    const currentIssues = listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues;
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.missing"), issues: currentIssues };
    }
    if (issueSyncMode(issue) === "cloud") {
      return this.cloudIssueReadOnlyDeleteResult(currentIssues);
    }
    if (issue.automationId) {
      try {
        await callAgentPlatform(this.options.app, "/api/automation/delete", {
          method: "POST",
          body: { id: issue.automationId }
        });
      } catch (error) {
        return {
          ok: false,
          message: t("kanban.automation.deleteFailed", { message: error instanceof Error ? error.message : String(error) }),
          issues: currentIssues
        };
      }
    }
    if (issueSyncMode(issue) === "local") {
      return deleteDesktopKanbanIssue(this.options.app, currentUser, issue.id);
    }
    return deleteDesktopKanbanIssue(this.options.app, currentUser, issue.id);
  }

  async syncIssueAutomation(
    issueId: string,
    callAgentPlatform: AgentPlatformCaller<App> = this.options.callAgentPlatform
  ): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, issueId);
    if (!issue) {
      return {
        ok: false,
        message: t("kanban.runtime.missing"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (issueSyncMode(issue) === "cloud") {
      return this.cloudIssueReadOnlyResult();
    }
    const localResult = await this.syncAutomationForIssue(issue, callAgentPlatform);
    if (!localResult.ok || !localResult.issue || issueSyncMode(localResult.issue) === "local") {
      return localResult;
    }
    return localResult;
  }

  async claimIssue(issueId: string): Promise<KanbanIssueResult> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, issueId);
    const issues = listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues;
    if (!issue || issueSyncMode(issue) !== "cloud") {
      return { ok: false, message: t("kanban.runtime.missing"), issues };
    }
    if (!this.negotiatedContractVersion.startsWith("1.") || !this.negotiatedCapabilities.includes("issue.claim")) {
      return { ok: false, message: t("kanban.cloud.claimUnsupported"), issues };
    }
    if (!this.wsClient.isOpen()) {
      return { ok: false, message: t("kanban.cloudSync.notConnected"), issues };
    }
    const remoteIssueId = getRemoteIssueId(issue);
    const projectId = readText(issue.projectId) || DEFAULT_SELECTED_PROJECT_ID;
    const requestId = stableClientEventId(getDesktopDeviceId(this.options.app), ["claim", remoteIssueId, issue.revision ?? issue.lastRemoteRevision ?? 0]);
    const payload = { id: remoteIssueId, baseIssueRevision: issue.revision ?? issue.lastRemoteRevision ?? 0 };
    recordDesktopKanbanCloudMutation(this.options.app, currentUser, {
      id: requestId,
      requestType: "issue.claim",
      projectId,
      issueId: remoteIssueId,
      payload
    });
    const result = await this.sendCloudMutation({ id: requestId, requestType: "issue.claim", projectId, issueId: remoteIssueId, payload, attemptCount: 0, lastError: null });
    return {
      ok: result.ok,
      message: result.message,
      issue: result.issue,
      issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
    };
  }

  async runIssue(input: KanbanRunIssueInput): Promise<KanbanRunIssueResult> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, readText(input?.issueId));
    const currentIssues = listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues;
    if (!issue || issueSyncMode(issue) !== "cloud") {
      return { ok: false, message: t("kanban.runtime.missing"), issues: currentIssues };
    }
    if (!this.negotiatedContractVersion.startsWith("1.") || !this.negotiatedCapabilities.includes("run.event.append") || !this.wsClient.isOpen()) {
      return { ok: false, message: t("kanban.cloudSync.notConnected"), issues: currentIssues };
    }
    if (issue.status !== "todo") {
      return { ok: false, message: t("kanban.run.todoRequired"), issues: currentIssues };
    }
    if (readText(issue.assigneeId) !== currentUser.id) {
      return { ok: false, message: t("kanban.run.claimRequired"), issues: currentIssues };
    }
    if (issue.runState === "running" || readText(issue.activeRunId)) {
      return { ok: false, message: t("kanban.run.alreadyRunning"), issues: currentIssues };
    }
    const agentKey = readText(input?.agentKey);
    const availableAgents = await this.listAgents();
    if (!agentKey || !availableAgents.some((agent) => agent.agentKey === agentKey)) {
      return { ok: false, message: t("kanban.feedback.noAgents"), issues: currentIssues };
    }
    const projectId = readText(issue.projectId) || DEFAULT_SELECTED_PROJECT_ID;
    const remoteIssueId = getRemoteIssueId(issue);
    let prepared: { issueRun?: { id?: string }; preferredChatId?: string };
    try {
      prepared = await this.wsClient.request("issue.run.prepare", {
        issueId: remoteIssueId,
        agentKey,
        forceNewChat: input.forceNewChat === true
      });
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        issues: currentIssues,
        agentKey
      };
    }
    const issueRunId = readText(prepared.issueRun?.id);
    if (!issueRunId) {
      return { ok: false, message: t("kanban.runtime.dispatchInvalid"), issues: currentIssues, agentKey };
    }
    const preferredChatId = input.forceNewChat === true ? "" : readText(prepared.preferredChatId);
    let chatId = preferredChatId || createKanbanRemoteChatId();
    let missingPreferredChatId = "";
    if (preferredChatId && this.options.assistantBridge.getChat) {
      try {
        if (!await this.options.assistantBridge.getChat(preferredChatId)) {
          missingPreferredChatId = preferredChatId;
          chatId = createKanbanRemoteChatId();
        }
      } catch {
        missingPreferredChatId = preferredChatId;
        chatId = createKanbanRemoteChatId();
      }
    }
    const runId = createKanbanRemoteRunId();
    recordDesktopKanbanManualRun(this.options.app, currentUser, { issueRunId, runId, chatId, issueId: remoteIssueId, projectId, agentKey });
    const failPreparedRun = async (message: string) => {
      updateDesktopKanbanManualRun(this.options.app, currentUser, runId, "failed", message);
      await this.appendRunEvent({
        projectId,
        issueId: remoteIssueId,
        issueRunId,
        runId,
        chatId,
        eventType: "run.failed",
        payload: { source: "desktop_manual", status: "failed", agentKey, runId, chatId, error: message }
      }).catch(() => undefined);
    };
    let runResult: AssistantStartRunResult;
    try {
      runResult = await this.options.assistantBridge.startRun({
        agentKey,
        chatId,
        runId,
        requestId: runId,
        message: buildDesktopKanbanRunPrompt(issue),
        source: "sidebar"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failPreparedRun(message);
      return { ok: false, message, issues: currentIssues, chatId, runId, agentKey };
    }
    if (!runResult.ok) {
      await failPreparedRun(runResult.message);
      return { ok: false, message: runResult.message, issues: currentIssues, chatId, runId, agentKey };
    }
    if (readText(runResult.runId) !== runId || readText(runResult.chatId) !== chatId) {
      await this.options.assistantBridge.stopRun?.(readText(runResult.runId) || runId).catch(() => undefined);
      const message = t("kanban.run.identityMismatch");
      await failPreparedRun(message);
      return { ok: false, message, issues: currentIssues, chatId, runId, agentKey };
    }
    updateDesktopKanbanManualRun(this.options.app, currentUser, runId, "started");
    try {
      const appended = await this.appendRunEvent({
        projectId,
        issueId: remoteIssueId,
        issueRunId,
        runId,
        chatId,
        eventType: "run.started",
        payload: {
          source: "desktop_manual",
          status: "running",
          agentKey,
          runId,
          chatId,
          ...(missingPreferredChatId ? { missingPreferredChatId } : {})
        }
      });
      if (!appended.accepted && !appended.queued) {
        updateDesktopKanbanManualRun(this.options.app, currentUser, runId, "failed", appended.message);
        return { ok: false, message: appended.message, issues: currentIssues, chatId, runId, agentKey };
      }
      return {
        ok: true,
        message: t("kanban.feedback.assignedToAssistant"),
        issue,
        issues: currentIssues,
        chatId,
        runId,
        agentKey
      };
    } catch (error) {
      await this.options.assistantBridge.stopRun?.(runId).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      await failPreparedRun(message);
      return { ok: false, message, issues: currentIssues, chatId, runId, agentKey };
    }
  }

  async bindHumanReferenceChat(input: { issueId: string; stageId: string; statusId: string; chatId: string }) {
    this.refreshConnection();
    if (!this.wsClient.isOpen() || !this.negotiatedContractVersion.startsWith("1.")) {
      return { ok: false, message: t("kanban.cloudSync.notConnected") };
    }
    try {
      const result = await this.wsClient.request<{ ok: boolean; message?: string }>("issue.chat.bind", input);
      if (result.ok) await this.resyncCloudBoard();
      return result;
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async unbindHumanReferenceChat(issueChatId: string) {
    this.refreshConnection();
    if (!this.wsClient.isOpen() || !this.negotiatedContractVersion.startsWith("1.")) {
      return { ok: false, message: t("kanban.cloudSync.notConnected") };
    }
    try {
      const result = await this.wsClient.request<{ ok: boolean; message?: string }>("issue.chat.unbind", { issueChatId });
      if (result.ok) await this.resyncCloudBoard();
      return result;
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async sendCloudMutation(item: ReturnType<typeof listDesktopKanbanCloudMutations>[number]): Promise<{ ok: boolean; message: string; issue?: KanbanIssue }> {
    const currentUser = this.currentUser();
    try {
      const result = await this.wsClient.requestWithId<{ ok?: boolean; message?: string; issue?: unknown; revision?: number }>(
        item.requestType,
        item.payload,
        item.id,
        undefined,
        item.projectId
      );
      if (result.ok === false) {
        deleteDesktopKanbanCloudMutation(this.options.app, currentUser, item.id);
        return { ok: false, message: readText(result.message) || t("kanban.ws.operationFailed", { type: item.requestType }) };
      }
      let issue: KanbanIssue | undefined;
      if (result.issue) {
        const applied = upsertDispatchedDesktopKanbanIssue(this.options.app, currentUser, result.issue, Number(result.revision) || 0, "cloud_dispatch");
        issue = applied.issue;
      }
      deleteDesktopKanbanCloudMutation(this.options.app, currentUser, item.id);
      this.notifyChanged();
      return { ok: true, message: readText(result.message) || t("kanban.claim.succeeded"), issue };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof KanbanDesktopRequestError) {
        deleteDesktopKanbanCloudMutation(this.options.app, currentUser, item.id);
      } else {
        markDesktopKanbanCloudMutationAttempt(this.options.app, currentUser, item.id, message);
      }
      return { ok: false, message };
    }
  }

  private async flushCloudOutboxes() {
    await this.flushCloudMutationOutbox();
    await this.flushRunEventOutbox();
  }

  private async flushCloudMutationOutbox() {
    if (this.cloudMutationProcessing || !this.wsClient.isOpen()) return;
    this.cloudMutationProcessing = true;
    try {
      for (const item of listDesktopKanbanCloudMutations(this.options.app, this.currentUser())) {
        const result = await this.sendCloudMutation(item);
        if (!result.ok && !this.wsClient.isOpen()) break;
      }
    } finally {
      this.cloudMutationProcessing = false;
    }
  }

  private async flushRunEventOutbox() {
    if (this.runEventProcessing || !this.wsClient.isOpen()) return;
    this.runEventProcessing = true;
    try {
      for (const item of listDesktopKanbanRunEvents(this.options.app, this.currentUser())) {
        const result = await this.sendRunEventOutboxItem(item);
        if (!result.accepted && !result.queued) {
          await this.handleRejectedRunEvent(item, result.message);
          continue;
        }
        if (result.queued) break;
      }
    } finally {
      this.runEventProcessing = false;
    }
  }

  private async sendRunEventOutboxItem(item: ReturnType<typeof listDesktopKanbanRunEvents>[number]) {
    const currentUser = this.currentUser();
    if (!this.wsClient.isOpen()) {
      return { accepted: false, queued: true, message: t("kanban.cloudSync.notConnected") };
    }
    try {
      const result = await this.wsClient.requestWithId<{ ok?: boolean; message?: string }>("run.event.append", {
        deviceId: getDesktopDeviceId(this.options.app),
        clientEventId: item.clientEventId,
        sourceDeliverySeq: item.sourceDeliverySeq,
        projectId: item.projectId,
        issueId: item.issueId,
        issueRunId: item.issueRunId,
        externalRunId: item.externalRunId,
        chatId: item.chatId || undefined,
        eventType: item.eventType,
        payload: item.payload
      }, item.clientEventId, undefined, item.projectId);
      if (result?.ok === false) {
        deleteDesktopKanbanRunEvent(this.options.app, currentUser, item.clientEventId);
        return { accepted: false, queued: false, message: readText(result.message) || t("kanban.ws.operationFailed", { type: "run.event.append" }) };
      }
      deleteDesktopKanbanRunEvent(this.options.app, currentUser, item.clientEventId);
      return { accepted: true, queued: false, message: readText(result?.message) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof KanbanDesktopRequestError) {
        deleteDesktopKanbanRunEvent(this.options.app, currentUser, item.clientEventId);
        return { accepted: false, queued: false, message };
      }
      markDesktopKanbanRunEventAttempt(this.options.app, currentUser, item.clientEventId, message);
      return { accepted: false, queued: true, message };
    }
  }

  private async handleRejectedRunEvent(item: ReturnType<typeof listDesktopKanbanRunEvents>[number], message: string) {
    if (item.eventType !== "run.started" || readText(item.payload.source) !== "desktop_manual") return;
    await this.options.assistantBridge.stopRun?.(item.runId).catch(() => undefined);
    updateDesktopKanbanManualRun(this.options.app, this.currentUser(), item.runId, "failed", message);
  }

  private async recoverPendingManualRuns() {
    if (!this.wsClient.isOpen()) return;
    const currentUser = this.currentUser();
    const issues = listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues;
    for (const receipt of listPendingDesktopKanbanManualRuns(this.options.app, currentUser)) {
      const recovery = await this.inspectReceiptRun(receipt.chatId, receipt.runId);
      const issue = issues.find((candidate) => issueSyncMode(candidate) === "cloud" && getRemoteIssueId(candidate) === receipt.issueId);
      if (recovery.terminalEventType) {
        await this.appendRunEvent({
          projectId: receipt.projectId,
          issueId: receipt.issueId,
          issueRunId: receipt.issueRunId,
          runId: receipt.runId,
          chatId: receipt.chatId,
          eventType: recovery.terminalEventType,
          payload: {
            source: "desktop_manual",
            status: recovery.terminalEventType === "run.completed" ? "completed" : recovery.terminalEventType === "run.cancelled" ? "cancelled" : "failed",
            agentKey: receipt.agentKey,
            runId: receipt.runId,
            chatId: receipt.chatId,
            message: recovery.message,
            error: recovery.error
          }
        });
        updateDesktopKanbanManualRun(this.options.app, currentUser, receipt.runId, recovery.terminalEventType === "run.completed" ? "completed" : recovery.terminalEventType === "run.cancelled" ? "cancelled" : "failed", recovery.error ?? null);
        continue;
      }
      if (!recovery.exists && receipt.state === "starting") {
        if (!issue) {
          updateDesktopKanbanManualRun(this.options.app, currentUser, receipt.runId, "failed", t("kanban.runtime.missing"));
          continue;
        }
        const result = await this.options.assistantBridge.startRun({
          agentKey: receipt.agentKey,
          chatId: receipt.chatId,
          runId: receipt.runId,
          requestId: receipt.runId,
          message: buildDesktopKanbanRunPrompt(issue),
          source: "sidebar"
        });
        if (!result.ok) {
          updateDesktopKanbanManualRun(this.options.app, currentUser, receipt.runId, "failed", result.message);
          await this.appendRunEvent({
            projectId: receipt.projectId,
            issueId: receipt.issueId,
            issueRunId: receipt.issueRunId,
            runId: receipt.runId,
            chatId: receipt.chatId,
            eventType: "run.failed",
            payload: { source: "desktop_manual", status: "failed", agentKey: receipt.agentKey, error: result.message }
          });
          continue;
        }
      }
      if (!recovery.exists && receipt.state === "started") {
        continue;
      }
      if (receipt.state === "starting") {
        updateDesktopKanbanManualRun(this.options.app, currentUser, receipt.runId, "started");
      }
      const started = await this.appendRunEvent({
        projectId: receipt.projectId,
        issueId: receipt.issueId,
        issueRunId: receipt.issueRunId,
        runId: receipt.runId,
        chatId: receipt.chatId,
        eventType: "run.started",
        payload: { source: "desktop_manual", status: "running", agentKey: receipt.agentKey, runId: receipt.runId, chatId: receipt.chatId }
      });
      if (!started.accepted && !started.queued) {
        await this.handleRejectedRunEvent({
          clientEventId: stableClientEventId(getDesktopDeviceId(this.options.app), [receipt.issueId, receipt.runId, "run.started"]),
          projectId: receipt.projectId,
          issueId: receipt.issueId,
          issueRunId: receipt.issueRunId,
          externalRunId: receipt.runId,
          runId: receipt.runId,
          chatId: receipt.chatId,
          eventType: "run.started",
          sourceDeliverySeq: 0,
          payload: { source: "desktop_manual", agentKey: receipt.agentKey },
          attemptCount: 0,
          lastError: null
        }, started.message);
      }
    }
  }

  sendNavigationPushEvent(event: AssistantNavigationPushEvent) {
    this.refreshConnection();
    const runId = event.runId?.trim() ?? "";
    const semanticTime = event.type === "run.started" ? event.startedAt : event.finishedAt;
    if (
      event.frame !== "push" ||
      (event.type !== "run.started" && event.type !== "run.finished") ||
      !runId ||
      !isAgentPlatformEpochMilliseconds(semanticTime)
    ) {
      this.options.onDebug?.(
        `ignored invalid navigation push: frame=${event.frame || ""} type=${event.type || ""} runId=${runId} semanticTime=${String(semanticTime ?? "")}`,
      );
      return;
    }
    const currentUser = this.currentUser();
    const issues = listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues;
    const matchingLocalIssue = issues.find((issue) =>
      issueSyncMode(issue) !== "cloud" && (issue.runId === runId || issue.activeRunId === runId)
    );

    if (event.type === "run.started") {
      if (!matchingLocalIssue) {
        return;
      }
      const result = updateDesktopKanbanIssueRuntimeState(this.options.app, currentUser, matchingLocalIssue.id, {
        status: "in_progress",
        chatId: event.chatId || matchingLocalIssue.chatId,
        runId,
        runState: "running",
      });
      if (result.ok) {
        this.notifyChanged();
      }
      return;
    }

    const terminal = resolveKanbanRunFinishedPush(event);
    if (!terminal) {
      this.options.onDebug?.(
        `ignored invalid run.finished protocol: runId=${runId} status=${event.status || ""} finishReason=${event.finishReason || ""}`,
      );
      return;
    }

    this.options.onDebug?.(
      `accepted navigation run.finished: runId=${runId} status=${event.status} finishReason=${event.finishReason} runState=${terminal.runState}`,
    );
    if (matchingLocalIssue) {
      const result = updateDesktopKanbanIssueRuntimeState(this.options.app, currentUser, matchingLocalIssue.id, {
        status: terminal.status,
        chatId: event.chatId || matchingLocalIssue.chatId,
        runId: null,
        runState: terminal.runState,
      });
      if (result.ok) {
        this.notifyChanged();
      }
      return;
    }

    const manualReceipt = getDesktopKanbanManualRunByRunId(this.options.app, currentUser, runId);
    const commandReceipt = getDesktopKanbanCommandReceiptByRunId(this.options.app, currentUser, runId);
    const matchingCloudIssue = issues.find((issue) =>
      issueSyncMode(issue) === "cloud" && (
        (manualReceipt && getRemoteIssueId(issue) === manualReceipt.issueId) ||
        (commandReceipt && getRemoteIssueId(issue) === commandReceipt.issueId)
      )
    );
    if (matchingCloudIssue || manualReceipt || commandReceipt) {
      const commandId = commandReceipt?.commandId || readText(matchingCloudIssue?.dispatchCommandId);
      if (manualReceipt) {
        updateDesktopKanbanManualRun(
          this.options.app,
          currentUser,
          runId,
          terminal.runState === "completed" ? "completed" : terminal.runState === "cancelled" ? "cancelled" : "failed",
          null,
        );
      }
      void (async () => {
        const reviewResult = commandReceipt?.commandType === "review" && terminal.terminalEventType === "run.completed"
          ? await this.readStructuredReviewResult(commandReceipt.chatId, runId)
          : undefined;
        await this.appendRunEvent({
          projectId: commandReceipt?.projectId || manualReceipt?.projectId || matchingCloudIssue?.projectId || "",
          issueId: commandReceipt?.issueId || manualReceipt?.issueId || (matchingCloudIssue ? getRemoteIssueId(matchingCloudIssue) : ""),
          issueRunId: commandReceipt?.issueRunId || manualReceipt?.issueRunId,
          runId,
          chatId: event.chatId || commandReceipt?.chatId,
          eventType: terminal.terminalEventType,
          payload: {
            ...(manualReceipt ? { source: "desktop_manual", agentKey: manualReceipt.agentKey } : {}),
            ...(commandReceipt ? { agentKey: optionalText(commandReceipt.payload.agentKey) } : {}),
            ...(commandId ? { commandId } : {}),
            ...(reviewResult ? { reviewResult } : {}),
            type: event.type,
            status: event.status,
            finishReason: event.finishReason,
            runState: terminal.runState,
            chatId: event.chatId || commandReceipt?.chatId,
            runId,
          }
        });
        if (commandReceipt) {
          completeDesktopKanbanCommandReceiptByRunId(
            this.options.app,
            currentUser,
            runId,
            terminal.runState === "completed" ? "completed" : "failed",
          );
        }
      })().catch((error) => this.options.onDebug?.(error instanceof Error ? error.message : String(error)));
    }
  }

  private currentUser(): KanbanCurrentUser {
    const user = this.options.canUseDesktopSsoCredentials?.() === false
      ? null
      : readDesktopSsoAccessTokenUser(this.options.app);
    if (user?.sub?.trim()) {
      return {
        id: user.sub.trim(),
        name: user.name?.trim() || user.email?.trim() || user.sub.trim(),
        email: user.email?.trim() || "",
        source: "sso"
      };
    }
    const deviceId = getDesktopDeviceId(this.options.app);
    const deviceInfo = getKanbanDeviceInfo(this.options.app);
    return {
      id: `device:${deviceId}`,
      name: deviceInfo.deviceName,
      email: "",
      source: "device"
    };
  }

  private refreshConnection(options: { forceReconnect?: boolean } = {}) {
    const resolution = resolveKanbanWsConnection(
      this.options.app,
      this.options.canUseDesktopSsoCredentials?.() !== false
    );
    this.connectionFallbackState = resolution.fallbackState;
    this.wsClient.start(resolution.config, options.forceReconnect ? { forceReconnect: true } : undefined);
    this.connectionState = resolution.config ? this.wsClient.getState() : resolution.fallbackState;
  }

  private applySnapshot(snapshot: KanbanCloudSnapshot) {
    applyDesktopKanbanCloudSnapshot(this.options.app, this.currentUser(), snapshot);
    this.notifyChanged();
  }

  private applyDispatch(issue: unknown, revision: number): KanbanIssueResult {
    const result = upsertDispatchedDesktopKanbanIssue(this.options.app, this.currentUser(), issue, revision, "cloud_dispatch");
    this.notifyChanged();
    return result;
  }

  private cloudIssueReadOnlyResult(): KanbanIssueResult {
    return {
      ok: false,
      message: t("kanban.runtime.cloudReadOnly"),
      issues: listDesktopKanbanIssues(this.options.app, this.currentUser(), this.connectionState).issues
    };
  }

  private cloudIssueReadOnlyDeleteResult(issues: KanbanIssue[]): { ok: false; message: string; issues: KanbanIssue[] } {
    return {
      ok: false,
      message: t("kanban.runtime.cloudReadOnly"),
      issues
    };
  }

  private async applyIssueEvent(event: KanbanDesktopIssueEvent): Promise<KanbanDesktopIssueEventApplyResult> {
    const currentUser = this.currentUser();
    const cursor = readDesktopKanbanSyncCursor(this.options.app, currentUser);
    const seq = Math.max(0, Math.floor(event.seq));
    if (seq <= 0) {
      return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: event.eventType || "unknown" }) };
    }
    if (seq <= cursor.lastAppliedRevision) {
      return { ok: true, lastAppliedRevision: cursor.lastAppliedRevision };
    }

    const issuePayload = issueEventIssuePayload(event);
    const scopedTombstone = !issuePayload && Boolean(event.deletedIssueId || event.issueId);
    if (event.eventType === "issue.deleted" || scopedTombstone || (event.toProjectId && !hasDesktopKanbanCloudProject(this.options.app, currentUser, event.toProjectId))) {
      tombstoneDesktopKanbanCloudIssue(this.options.app, currentUser, issueEventIssueId(event), seq);
    } else {
      const issue = issuePayload;
      if (!issue) {
        return { ok: false, message: t("kanban.runtime.dispatchInvalid") };
      }
      const result = upsertDispatchedDesktopKanbanIssue(this.options.app, currentUser, issue, seq, "cloud_dispatch");
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
    }

    writeDesktopKanbanSyncCursor(this.options.app, currentUser, { lastAppliedRevision: seq });
    this.notifyChanged();
    return {
      ok: true,
      lastAppliedRevision: Math.max(cursor.lastAppliedRevision, seq)
    };
  }

  private async applyDelivery(delivery: KanbanDesktopDelivery): Promise<KanbanDesktopDeliveryApplyResult> {
    const currentUser = this.currentUser();
    const cursor = readDesktopKanbanSyncCursor(this.options.app, currentUser);
    const sourceRevision = deliverySourceRevision(delivery);

    if (delivery.kind === "snapshot_reset") {
      const snapshot = await this.wsClient.request<KanbanCloudSnapshot>("snapshot.get", {
        scope: "project_set",
        deviceId: getDesktopDeviceId(this.options.app)
      });
      this.applySnapshot(snapshot);
      return {
        ok: true,
        lastAppliedRevision: readDesktopKanbanSyncCursor(this.options.app, currentUser).lastAppliedRevision
      };
    }

    if (delivery.kind !== "command") {
      return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: delivery.kind || "unknown" }) };
    }

    const payload = deliveryPayloadRecord(delivery);
    const issue = deliveryIssuePayload(delivery);
    if (delivery.eventType === "command.dispatchIssue") {
      const result = this.applyDispatch(issue, sourceRevision);
      return { ok: result.ok, message: result.message, lastAppliedRevision: cursor.lastAppliedRevision };
    }
    if (delivery.eventType === "command.runIssue" || delivery.eventType === "command.reviewIssue") {
      const commandId = readText(delivery.commandId) || `delivery:${getDesktopDeviceId(this.options.app)}:${delivery.deliverySeq}`;
      const receipt = recordDesktopKanbanCommandReceipt(this.options.app, currentUser, {
        commandId,
        deliverySeq: delivery.deliverySeq,
        projectId: readText(delivery.projectId) || readText(payload.projectId),
        sourceRevision,
        payload,
        issue
      });
      this.notifyChanged();
      return { ok: receipt.ok, message: receipt.message, lastAppliedRevision: Math.max(cursor.lastAppliedRevision, sourceRevision) };
    }
    return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: delivery.eventType || "unknown" }) };
  }

  private async processPendingCommandReceipts() {
    if (this.commandReceiptProcessing) return;
    this.commandReceiptProcessing = true;
    try {
      const currentUser = this.currentUser();
      const receipts = listPendingDesktopKanbanCommandReceipts(this.options.app, currentUser);
      for (const receipt of receipts) {
        if (receipt.state === "failed") {
          await this.reportFailedCommandReceipt(receipt, receipt.lastError || "Desktop failed to start the command");
          continue;
        }
        const recovery = receipt.state === "starting" || receipt.state === "started"
          ? await this.inspectReceiptRun(receipt.chatId, receipt.runId)
          : { exists: false as const, terminalEventType: undefined, message: undefined, error: undefined };
        if (recovery.terminalEventType) {
          const reviewResult = receipt.commandType === "review" && recovery.terminalEventType === "run.completed"
            ? await this.readStructuredReviewResult(receipt.chatId, receipt.runId)
            : undefined;
          await this.appendRunEvent({
            sourceDeliverySeq: receipt.deliverySeq,
            projectId: receipt.projectId,
            issueId: receipt.issueId,
            issueRunId: receipt.issueRunId,
            runId: receipt.runId,
            chatId: receipt.chatId,
            eventType: recovery.terminalEventType,
            payload: {
              status: recovery.terminalEventType === "run.completed" ? "completed" : recovery.terminalEventType === "run.cancelled" ? "cancelled" : "failed",
              commandId: receipt.commandId,
              runId: receipt.runId,
              chatId: receipt.chatId,
              message: recovery.message,
              error: recovery.error,
              ...(reviewResult ? { reviewResult } : {})
            }
          });
          updateDesktopKanbanCommandReceipt(
            this.options.app,
            currentUser,
            receipt.commandId,
            recovery.terminalEventType === "run.completed" ? "completed" : "failed"
          );
          continue;
        }
        if (!recovery.exists) {
          updateDesktopKanbanCommandReceipt(this.options.app, currentUser, receipt.commandId, "starting", null, true);
          const issue = receipt.payload.issue;
          const issueRevision = isRecord(issue) && typeof issue.revision === "number" ? issue.revision : 0;
          const preferredChatId = readText(receipt.payload.preferredChatId);
          const preferredChatMissing = preferredChatId === receipt.chatId && !await this.localChatExists(preferredChatId);
          const requiresNewChat = receipt.commandType === "review" || receipt.payload.forceNewChat === true || readText(receipt.payload.chatPolicy) === "new" || preferredChatMissing;
          if (requiresNewChat) {
            const freshChatId = createKanbanRemoteChatId();
            updateDesktopKanbanCommandReceiptIdentity(this.options.app, currentUser, receipt.commandId, freshChatId, receipt.runId);
            receipt.chatId = freshChatId;
          }
          const runResult = await this.startRemoteRun({
            issue,
            revision: issueRevision,
            agentKey: optionalText(receipt.payload.agentKey),
            accessLevel: normalizeRemoteAccessLevel(receipt.payload.accessLevel),
            chatId: receipt.chatId,
            runId: receipt.runId,
            requestId: receipt.requestId,
            message: readText(receipt.payload.message),
            source: "sidebar"
          });
          if (!runResult.ok) {
            updateDesktopKanbanCommandReceipt(this.options.app, currentUser, receipt.commandId, "failed", runResult.message);
            await this.reportFailedCommandReceipt(receipt, runResult.message);
            continue;
          }
        }
        updateDesktopKanbanCommandReceipt(this.options.app, currentUser, receipt.commandId, "started");
        const preferredChatId = readText(receipt.payload.preferredChatId);
        const missingPreferredChatId = receipt.commandType === "run" && preferredChatId && receipt.chatId !== preferredChatId &&
          receipt.payload.forceNewChat !== true && readText(receipt.payload.chatPolicy) !== "new"
          ? preferredChatId
          : "";
        await this.appendRunEvent({
          sourceDeliverySeq: receipt.deliverySeq,
          projectId: receipt.projectId,
          issueId: receipt.issueId,
          issueRunId: receipt.issueRunId,
          runId: receipt.runId,
          chatId: receipt.chatId,
          eventType: "run.started",
          payload: {
            status: "running",
            agentKey: optionalText(receipt.payload.agentKey),
            commandId: receipt.commandId,
            runId: receipt.runId,
            chatId: receipt.chatId,
            ...(missingPreferredChatId ? { missingPreferredChatId } : {})
          }
        });
      }
    } finally {
      this.commandReceiptProcessing = false;
      this.scheduleCommandReceiptRecovery();
    }
  }

  private async inspectReceiptRun(chatId: string, runId: string): Promise<{
    exists: boolean;
    terminalEventType?: "run.completed" | "run.failed" | "run.cancelled";
    message?: string;
    error?: string;
  }> {
    if (!this.options.assistantBridge.getChat) return { exists: false };
    try {
      const detail = await this.options.assistantBridge.getChat(chatId);
      const events = (detail?.events ?? []).filter((event) => event.runId === runId).sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
      const terminal = [...events].reverse().find((event) => ["run.complete", "run.error", "run.stopped", "run.interrupt", "run.expired"].includes(readText(event.type)));
      if (terminal) {
        const type = readText(terminal.type);
        return {
          exists: true,
          terminalEventType: type === "run.complete" ? "run.completed" : type === "run.stopped" || type === "run.interrupt" ? "run.cancelled" : "run.failed",
          message: readText(terminal.message) || undefined,
          error: readText(terminal.error) || undefined
        };
      }
      return {
        exists: Boolean(detail?.messages?.some((message) => message.runId === runId) || events.length > 0)
      };
    } catch {
      return { exists: false };
    }
  }

  private async localChatExists(chatId: string) {
    if (!chatId || !this.options.assistantBridge.getChat) return true;
    try {
      return Boolean(await this.options.assistantBridge.getChat(chatId));
    } catch {
      return false;
    }
  }

  private async readStructuredReviewResult(chatId: string, runId: string) {
    if (!this.options.assistantBridge.getChat) return undefined;
    try {
      const detail = await this.options.assistantBridge.getChat(chatId);
      const messages = (detail?.messages ?? []).filter((message) => message.runId === runId);
      for (const message of [...messages].reverse()) {
        const parsed = parseStructuredReviewText(readText(message.content));
        if (parsed) return parsed;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async reportFailedCommandReceipt(receipt: KanbanCommandReceipt, error: string) {
    await this.appendRunEvent({
      sourceDeliverySeq: receipt.deliverySeq,
      projectId: receipt.projectId,
      issueId: receipt.issueId,
      issueRunId: receipt.issueRunId,
      runId: receipt.runId,
      chatId: receipt.chatId,
      eventType: "run.failed",
      payload: {
        status: "failed",
        commandId: receipt.commandId,
        runId: receipt.runId,
        chatId: receipt.chatId,
        error
      }
    });
    markDesktopKanbanCommandReceiptReported(this.options.app, this.currentUser(), receipt.commandId);
  }

  private scheduleCommandReceiptRecovery() {
    if (this.commandReceiptRetryTimer) clearTimeout(this.commandReceiptRetryTimer);
    const pending = listPendingDesktopKanbanCommandReceipts(this.options.app, this.currentUser());
    if (pending.length === 0 || !this.wsClient.isOpen()) {
      this.commandReceiptRetryTimer = null;
      return;
    }
    this.commandReceiptRetryTimer = setTimeout(() => {
      this.commandReceiptRetryTimer = null;
      void this.processPendingCommandReceipts().catch((error) => this.options.onDebug?.(error instanceof Error ? error.message : String(error)));
    }, 5_000);
  }

  private async appendRunEvent(input: {
    sourceDeliverySeq?: number;
    projectId?: string;
    issueId: string;
    issueRunId?: string | null;
    runId?: string | null;
    chatId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<{ accepted: boolean; queued: boolean; message: string }> {
    const issueId = readText(input.issueId);
    if (!issueId) {
      return { accepted: false, queued: false, message: t("kanban.runtime.dispatchInvalid") };
    }
    const deviceId = getDesktopDeviceId(this.options.app);
    const issueRunId = readText(input.issueRunId);
    const item = {
      clientEventId: stableClientEventId(deviceId, [issueRunId || issueId, readText(input.runId), input.eventType]),
      sourceDeliverySeq: input.sourceDeliverySeq ?? 0,
      projectId: readText(input.projectId) || DEFAULT_SELECTED_PROJECT_ID,
      issueId,
      issueRunId,
      externalRunId: readText(input.runId),
      runId: readText(input.runId),
      chatId: readText(input.chatId),
      eventType: input.eventType,
      payload: input.payload
    };
    recordDesktopKanbanRunEvent(this.options.app, this.currentUser(), item);
    const result = await this.sendRunEventOutboxItem({
      ...item,
      attemptCount: 0,
      lastError: null
    });
    if (!result.accepted && !result.queued) {
      await this.handleRejectedRunEvent({ ...item, attemptCount: 0, lastError: null }, result.message);
    }
    return result;
  }

  // 响应云端 desktop.project.createLocal:在本地真正创建项目。
  private createLocalProject(payload: unknown) {
    const record = isRecord(payload) ? payload : {};
    const result = createLocalDesktopProject(this.options.app, this.currentUser(), {
      id: readText(record.localProjectId),
      name: readText(record.name),
      versions: readStringList(record.versions),
      components: readStringList(record.components)
    });
    if (result.ok) {
      this.notifyChanged();
    }
    return result;
  }

  // 响应云端 desktop.project.bind:校验本地项目存在并返回项目信息。
  private bindLocalProject(payload: unknown) {
    const record = isRecord(payload) ? payload : {};
    const localProjectId = readText(record.localProjectId);
    if (!localProjectId) {
      return { ok: false, message: t("kanban.localProject.idRequired") };
    }
    const project = findLocalDesktopProject(this.options.app, this.currentUser(), localProjectId);
    if (!project) {
      return { ok: false, message: t("kanban.localProject.notFound") };
    }
    return {
      ok: true,
      message: t("kanban.localProject.bindConfirmed"),
      project: { id: project.id, name: project.name, slug: project.slug, path: project.path }
    };
  }

  // 响应云端 desktop.project.unbind:把该本地项目下的 cloud issue 转为 local 保留副本。
  private unbindLocalProject(payload: unknown) {
    const record = isRecord(payload) ? payload : {};
    const localProjectId = readText(record.localProjectId);
    const converted = localProjectId
      ? convertLocalProjectIssuesToLocal(this.options.app, this.currentUser(), localProjectId)
      : 0;
    if (converted > 0) {
      this.notifyChanged();
    }
    return {
      ok: true,
      message: converted > 0
        ? t("kanban.localProject.unboundWithConverted", { count: converted })
        : t("kanban.localProject.unboundConfirmed")
    };
  }

  private async listAgents(): Promise<DesktopPetAgentOption[]> {
    this.options.onDebug?.(t("kanban.runtime.debugReadingAgents"));
    const installedAgents = readInstalledAgentOptions(this.options.app);
    const localAgents = normalizeDesktopPetAgentOptions(this.options.listLocalAgents?.() ?? []);
    let platformAgents: DesktopPetAgentOption[] = [];
    try {
      platformAgents = normalizeDesktopPetAgentOptions(await withTimeout(
        () => this.options.assistantBridge.listAgents(),
        ASSISTANT_AGENT_LIST_TIMEOUT_MS,
        t("kanban.runtime.agentListTimeout")
      ));
    } catch (error) {
      this.options.onDebug?.(t("kanban.runtime.debugAgentListFallback", {
        message: error instanceof Error ? error.message : String(error)
      }));
    }
    const agents = normalizeDesktopPetAgentOptions([
      ...installedAgents,
      ...platformAgents,
      ...localAgents
    ]);
    this.options.onDebug?.(t("kanban.runtime.debugAgentsReturned", {
      total: agents.length,
      installed: installedAgents.length,
      platform: platformAgents.length,
      cached: localAgents.length
    }));
    return agents;
  }

  private async startRemoteRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult> {
    const currentUser = this.currentUser();
    let localIssueId = "";
    if (request.issue !== undefined) {
      const dispatchResult = upsertDispatchedDesktopKanbanIssue(
        this.options.app,
        currentUser,
        request.issue,
        request.revision ?? 0,
        "cloud_dispatch"
      );
      this.notifyChanged();
      if (!dispatchResult.ok || !dispatchResult.issue) {
        return {
          ok: false,
          runId: "",
          chatId: request.chatId?.trim() || "",
          message: dispatchResult.message
        };
      }
      localIssueId = dispatchResult.issue.id;
    }

    const chatId = request.chatId?.trim() || createKanbanRemoteChatId();
    const fallbackRunId = request.runId?.trim() || createKanbanRemoteRunId();
    const startRequest = { ...request, chatId, runId: fallbackRunId, requestId: request.requestId?.trim() || fallbackRunId };
    const startRun = this.options.assistantBridge.startRun(startRequest);
    const applyRunResult = (runResult: AssistantStartRunResult) => {
      if (runResult.ok && localIssueId) {
        updateDesktopKanbanIssueRuntimeState(this.options.app, currentUser, localIssueId, {
          status: "in_progress",
          chatId: runResult.chatId,
          runId: runResult.runId,
          runState: "running"
        });
        this.notifyChanged();
      }
    };

    try {
      const runResult = await waitForRemoteStartRunAck(startRun, REMOTE_START_RUN_ACK_TIMEOUT_MS);
      if (runResult) {
        applyRunResult(runResult);
        return runResult;
      }
    } catch (error) {
      return {
        ok: false,
        runId: "",
        chatId,
        message: error instanceof Error ? error.message : String(error)
      };
    }

    if (localIssueId) {
      updateDesktopKanbanIssueRuntimeState(this.options.app, currentUser, localIssueId, {
        status: "in_progress",
        chatId,
        runId: fallbackRunId,
        runState: "running"
      });
      this.notifyChanged();
    }
    void startRun.then((runResult) => {
      applyRunResult(runResult);
      if (!runResult.ok) {
        void this.handleRemoteStartFailure(fallbackRunId, chatId, runResult.message)
          .catch((error) => this.options.onDebug?.(error instanceof Error ? error.message : String(error)));
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      void this.handleRemoteStartFailure(fallbackRunId, chatId, message)
        .catch((failureError) => this.options.onDebug?.(failureError instanceof Error ? failureError.message : String(failureError)));
      this.options.onDebug?.(t("kanban.runtime.debugBackgroundStartFailed", { message }));
    });
    this.options.onDebug?.(t("kanban.runtime.debugSlowStartRun"));
    return {
      ok: true,
      runId: fallbackRunId,
      chatId,
      message: t("kanban.runtime.dispatchedStarting")
    };
  }

  private async handleRemoteStartFailure(runId: string, chatId: string, message: string) {
    const currentUser = this.currentUser();
    const manualReceipt = getDesktopKanbanManualRunByRunId(this.options.app, currentUser, runId);
    const commandReceipt = getDesktopKanbanCommandReceiptByRunId(this.options.app, currentUser, runId);
    const matchingCloudIssue = listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues.find((issue) =>
      issueSyncMode(issue) === "cloud" && (
        (manualReceipt && getRemoteIssueId(issue) === manualReceipt.issueId) ||
        (commandReceipt && getRemoteIssueId(issue) === commandReceipt.issueId)
      )
    );
    if (!matchingCloudIssue && !manualReceipt && !commandReceipt) {
      return;
    }
    if (manualReceipt) {
      updateDesktopKanbanManualRun(this.options.app, currentUser, runId, "failed", message);
    }
    await this.appendRunEvent({
      projectId: commandReceipt?.projectId || manualReceipt?.projectId || matchingCloudIssue?.projectId || "",
      issueId: commandReceipt?.issueId || manualReceipt?.issueId || (matchingCloudIssue ? getRemoteIssueId(matchingCloudIssue) : ""),
      issueRunId: commandReceipt?.issueRunId || manualReceipt?.issueRunId,
      runId,
      chatId: chatId || commandReceipt?.chatId,
      eventType: "run.failed",
      payload: {
        ...(manualReceipt ? { source: "desktop_manual", agentKey: manualReceipt.agentKey } : {}),
        ...(commandReceipt ? { commandId: commandReceipt.commandId, agentKey: optionalText(commandReceipt.payload.agentKey) } : {}),
        status: "failed",
        runState: "failed",
        runId,
        chatId: chatId || commandReceipt?.chatId,
        error: message,
      },
    });
    if (commandReceipt) {
      completeDesktopKanbanCommandReceiptByRunId(this.options.app, currentUser, runId, "failed");
    }
  }

  private notifyChanged() {
    this.options.onChanged?.();
  }

  private async syncAutomationForIssue(
    issue: KanbanIssue,
    callAgentPlatform: AgentPlatformCaller<App>
  ): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> {
    const currentUser = this.currentUser();
    if (!issue.automationEnabled) {
      if (issue.automationId) {
        await callAgentPlatform(this.options.app, "/api/automation/delete", {
          method: "POST",
          body: { id: issue.automationId }
        });
      }
      return updateDesktopKanbanIssue(this.options.app, currentUser, issue.id, {
        automationId: null,
        automationEnabled: false
      });
    }
    if (!issue.assigneeAgentKey?.trim()) {
      return {
        ok: false,
        message: t("kanban.automation.assigneeRequired"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (!issue.automationCron?.trim()) {
      return {
        ok: false,
        message: t("kanban.automation.cronRequired"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (!issue.automationMessage?.trim()) {
      return {
        ok: false,
        message: t("kanban.automation.messageRequired"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    const payload = buildKanbanAutomationPayload(issue);
    const detail = issue.automationId
      ? await callAgentPlatform<{ id?: string; scheduleId?: string }>(this.options.app, "/api/automation/update", {
        method: "POST",
        body: { id: issue.automationId, ...payload }
      })
      : await callAgentPlatform<{ id?: string; scheduleId?: string }>(this.options.app, "/api/automation/create", {
        method: "POST",
        body: payload
      });
    const automationId = readText(detail?.id) || readText(detail?.scheduleId) || issue.automationId;
    if (!automationId) {
      return {
        ok: false,
        message: t("kanban.automation.platformIdMissing"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    return updateDesktopKanbanIssue(this.options.app, currentUser, issue.id, {
      automationId,
      automationEnabled: true
    });
  }

  private async syncRemoteAutomationPayload(payload: unknown) {
    const issue = kanbanIssueFromAutomationPayload(payload);
    if (!issue) {
      return { ok: false, message: t("kanban.automation.payloadMissing") };
    }
    if (!issue.automationEnabled) {
      if (issue.automationId) {
        await this.options.callAgentPlatform(this.options.app, "/api/automation/delete", {
          method: "POST",
          body: { id: issue.automationId }
        });
      }
      return {
        ok: true,
        message: t("kanban.automation.disabled"),
        issue: {
          ...issue,
          automationId: null,
          automationEnabled: false
        }
      };
    }
    if (!issue.assigneeAgentKey?.trim()) {
      return { ok: false, message: t("kanban.automation.assigneeRequired") };
    }
    if (!issue.automationCron?.trim()) {
      return { ok: false, message: t("kanban.automation.cronRequired") };
    }
    if (!issue.automationMessage?.trim()) {
      return { ok: false, message: t("kanban.automation.messageRequired") };
    }
    const automationPayload = buildKanbanAutomationPayload(issue);
    const detail = issue.automationId
      ? await this.options.callAgentPlatform<{ id?: string; scheduleId?: string }>(this.options.app, "/api/automation/update", {
        method: "POST",
        body: { id: issue.automationId, ...automationPayload }
      })
      : await this.options.callAgentPlatform<{ id?: string; scheduleId?: string }>(this.options.app, "/api/automation/create", {
        method: "POST",
        body: automationPayload
      });
    const automationId = readText(detail?.id) || readText(detail?.scheduleId) || issue.automationId;
    if (!automationId) {
      return { ok: false, message: t("kanban.automation.platformIdMissing") };
    }
    const result = {
      ok: true,
      message: t("kanban.automation.synced"),
      issue: {
        ...issue,
        automationId,
        automationEnabled: true
      }
    };
    return {
      ok: result.ok,
      message: result.message,
      issue: result.issue
    };
  }
}

export function createKanbanRuntime(options: KanbanRuntimeOptions) {
  return new KanbanRuntime(options);
}

function normalizeDesktopPetAgentOptions(agents: DesktopPetAgentOption[]) {
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

function createKanbanRemoteChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function createKanbanRemoteRunId() {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function buildDesktopKanbanRunPrompt(issue: KanbanIssue) {
  return [readText(issue.title), readText(issue.description)].filter(Boolean).join("\n\n");
}

function waitForRemoteStartRunAck(startRun: Promise<AssistantStartRunResult>, timeoutMs: number) {
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

async function withTimeout<T>(producer: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
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
