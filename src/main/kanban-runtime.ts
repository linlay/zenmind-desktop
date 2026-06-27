import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import type { App } from "electron";
import type {
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
  KanbanSettings,
  KanbanSettingsInput,
  KanbanSettingsResult,
  KanbanStatus
} from "../shared/contracts";
import { APP_BRAND } from "../shared/brand";
import { getDesktopDeviceInfo } from "./desktop-device-info";
import { getDesktopDeviceId } from "./device-identity";
import { getDesktopSsoStatus } from "./oidc-sso";
import { readDesktopSsoSiteAccessToken, readDesktopSsoSiteTokenUser } from "./sso-site-token";
import { buildKanbanAutomationPayload, resolveKanbanRunStateFromAssistantEvent, resolveKanbanStatusFromAssistantEvent } from "./kanban-sync";
import {
  applyDesktopKanbanCloudSnapshot,
  createPrivateDesktopKanbanIssue,
  deleteDesktopKanbanIssue,
  getDesktopKanbanIssue,
  listDesktopKanbanIssues,
  moveDesktopKanbanIssue,
  readDesktopKanbanSyncCursor,
  setDesktopKanbanIssuePosition,
  tombstoneDesktopKanbanCloudIssue,
  updateDesktopKanbanIssue,
  updateDesktopKanbanIssueByChatId,
  updateDesktopKanbanIssueByRunId,
  upsertDispatchedDesktopKanbanIssue,
  writeDesktopKanbanSyncCursor,
  type KanbanCloudSnapshot
} from "./kanban-local-store";
import { getDesktopConfigRoot } from "./user-paths";
import {
  convertLocalProjectIssuesToPrivate,
  createLocalDesktopProject,
  findLocalDesktopProject
} from "./kanban-local-projects";
import { DesktopCloudSyncEngine } from "./kanban-cloud-sync";
import {
  KanbanDesktopWsClient,
  type KanbanDesktopDelivery,
  type KanbanDesktopDeliveryApplyResult,
  type KanbanDesktopConnectionState,
  type KanbanDesktopIssueEvent,
  type KanbanDesktopIssueEventApplyResult,
  type KanbanDesktopSyncLocalProject,
  type KanbanDesktopWsConfig
} from "./kanban-desktop-ws-client";
import { t } from "./i18n/main-i18n";

type AgentPlatformCaller<TApp> = <T = unknown>(
  app: TApp,
  path: string,
  options?: {
    method?: string;
    body?: unknown;
  }
) => Promise<T>;

type AssistantBridgeLike = {
  listAgents: () => Promise<DesktopPetAgentOption[]>;
  startRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
};

type KanbanRuntimeOptions = {
  app: App;
  assistantBridge: AssistantBridgeLike;
  callAgentPlatform: AgentPlatformCaller<App>;
  listLocalAgents?: () => DesktopPetAgentOption[];
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

type KanbanAssistantSyncEvent = {
  type?: string;
  status?: string | null;
  chatId?: string | null;
  runId?: string | null;
  message?: string | null;
  error?: string | null;
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

function getKanbanConfigPath(app: App) {
  return path.join(getDesktopConfigRoot(app), KANBAN_CONFIG_FILE);
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
  const agentsRoot = path.join(app.getPath("home"), APP_BRAND.paths.runtimeRootDirName, "agents");
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
    token: readText(input.token),
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


export function readKanbanSettings(app: App): KanbanSettings {
  const configPath = getKanbanConfigPath(app);
  if (fs.existsSync(configPath)) {
    const raw = readJsonConfigFile(configPath);
    const parsed = readKanbanOwnerConfig(raw);
    const settings = normalizeKanbanSettings(parsed);
    if (!isRecord(raw) || !isRecord(raw.cloud) || raw.enabled !== settings.enabled || hasLegacyKanbanSelectedProjectId(raw)) {
      writeKanbanSettings(app, settings);
    }
    return settings;
  }

  const settings = normalizeKanbanSettings({});
  writeKanbanSettings(app, settings);
  return settings;
}

export function readKanbanWsConfig(app: App): KanbanDesktopWsConfig | null {
  const settings = readKanbanSettings(app);
  const config = settings.cloud;
  const serverUrl = readText(process.env.DESKTOP_KANBAN_SERVER_URL) ||
    readText(config.serverUrl);
  const remoteControlEnabled = process.env.DESKTOP_KANBAN_REMOTE_CONTROL_ENABLED === "true" ||
    config.remoteControlEnabled;
  const token = readText(process.env.DESKTOP_KANBAN_TOKEN) ||
    readDesktopSsoSiteAccessToken(app);
  if (!settings.enabled || !remoteControlEnabled || !serverUrl || !token) {
    return null;
  }
  return {
    serverUrl,
    token,
    selectedProjectId: readText(process.env.DESKTOP_KANBAN_PROJECT_ID) ||
      DEFAULT_SELECTED_PROJECT_ID
  };
}

function readKanbanCloudConfig(app: App): KanbanCloudConfig {
  return readKanbanSettings(app).cloud;
}

function writeKanbanSettings(app: App, input: KanbanSettings): KanbanSettings {
  const settings = normalizeKanbanSettings({
    enabled: input.enabled,
    cloud: input.cloud
  });
  const configPath = getKanbanConfigPath(app);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    enabled: settings.enabled,
    cloud: settings.cloud
  }, null, 2)}\n`, "utf8");
  return settings;
}

export function saveKanbanSettings(app: App, input: KanbanSettingsInput): KanbanSettings {
  const current = readKanbanSettings(app);
  return writeKanbanSettings(app, {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    cloud: normalizeKanbanCloudConfig({
      ...current.cloud,
      ...(isRecord(input.cloud) ? input.cloud : {})
    })
  });
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
  return issue?.syncMode === "cloud" ? "cloud" : "private";
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
    workflowId: readText(record.workflowId) || "workflow-standard-requirement",
    typeId: optionalText(record.typeId),
    stageId: optionalText(record.stageId),
    stageName: optionalText(record.stageName),
    statusId: optionalText(record.statusId),
    statusName: optionalText(record.statusName),
    statusKey: optionalText(record.statusKey),
    title,
    description: readText(record.description),
    status: (readText(record.status) || "backlog") as KanbanStatus,
    priority: (readText(record.priority) || "medium") as KanbanIssue["priority"],
    severity: (readText(record.severity) || "medium") as NonNullable<KanbanIssue["severity"]>,
    assigneeAgentKey: nullableText(record.assigneeAgentKey),
    assigneeId: nullableText(record.assigneeId),
    workerType: readText(record.workerType) === "human" || readText(record.workerType) === "agent" ? readText(record.workerType) as "human" | "agent" : null,
    workerId: nullableText(record.workerId),
    workerAgent: nullableText(record.workerAgent),
    reviewerId: nullableText(record.reviewerId),
    reviewRequired: readBoolean(record.reviewRequired),
    activeReviewId: nullableText(record.activeReviewId),
    activeRunId: nullableText(record.activeRunId),
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
  private readonly cloudSync: DesktopCloudSyncEngine;
  private connectionState: KanbanDesktopConnectionState = "disabled";

  constructor(private readonly options: KanbanRuntimeOptions) {
    this.wsClient = new KanbanDesktopWsClient({
      capabilities: [
        "command.dispatchIssue",
        "command.runIssue",
        "run.event.append",
        "agent.listDesktop",
        "automation.sync"
      ],
      getCurrentUser: () => this.currentUser(),
      getDeviceId: () => getDesktopDeviceId(this.options.app),
      getDeviceInfo: () => getKanbanDeviceInfo(this.options.app),
      getSyncCursor: () => readDesktopKanbanSyncCursor(this.options.app, this.currentUser()),
      onSyncCursor: (cursor) => {
        writeDesktopKanbanSyncCursor(this.options.app, this.currentUser(), cursor);
      },
      onSnapshot: (snapshot) => this.applySnapshot(snapshot),
      onDelivery: (delivery) => this.applyDelivery(delivery),
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
      onStateChanged: (state) => {
        this.connectionState = state;
        this.notifyChanged();
      },
      onDebug: this.options.onDebug
    });
    this.cloudSync = new DesktopCloudSyncEngine({
      app: this.options.app,
      getCurrentUser: () => this.currentUser(),
      getDeviceId: () => getDesktopDeviceId(this.options.app),
      wsClient: this.wsClient,
      onChanged: () => this.notifyChanged(),
      onDebug: this.options.onDebug
    });
  }

  start() {
    this.refreshConnection();
  }

  stop() {
    this.cloudSync.stop();
    this.wsClient.stop();
  }

  refreshDeviceInfo() {
    this.refreshConnection({ forceReconnect: true });
    this.notifyChanged();
  }

  listIssues(): KanbanListResult {
    this.refreshConnection();
    return listDesktopKanbanIssues(this.options.app, this.currentUser(), this.connectionState);
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
    const selectedProjectId = readText(process.env.DESKTOP_KANBAN_PROJECT_ID) || DEFAULT_SELECTED_PROJECT_ID;
    const result = this.listIssues();
    const bindings = (result.projectBindings ?? []).filter((binding) =>
      binding.deviceId === deviceId &&
      binding.status === "active"
    );
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
    const projects = result.projects ?? [];
    const localProject = projects.find((project) => project.id === DEFAULT_SELECTED_PROJECT_ID) ?? projects[0];
    return [{
      projectId: selectedProjectId,
      localProjectId: localProject?.id || DEFAULT_SELECTED_PROJECT_ID,
      localDisplayName: localProject?.name || DEFAULT_SELECTED_PROJECT_ID,
      controlMode: "execute"
    }];
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
      return createPrivateDesktopKanbanIssue(this.options.app, currentUser, input);
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

    if (issueSyncMode(issue) === "private") {
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
    if (issueSyncMode(issue) === "private") {
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
    if (issueSyncMode(issue) === "private") {
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
    if (!localResult.ok || !localResult.issue || issueSyncMode(localResult.issue) === "private") {
      return localResult;
    }
    return localResult;
  }

  sendAssistantEvent(event: KanbanAssistantSyncEvent) {
    this.refreshConnection();
    const status = resolveKanbanStatusFromAssistantEvent(event);
    const runState = resolveKanbanRunStateFromAssistantEvent(event);
    if (!runState || (!event.runId && !event.chatId)) {
      return;
    }
    this.options.onDebug?.(
      t("kanban.runtime.debugAssistantTerminal", {
        type: event.type || "",
        status: event.status || "",
        runState: runState || "",
        runId: event.runId || "",
        chatId: event.chatId || "",
        message: event.message || event.error || ""
      })
    );
    const currentUser = this.currentUser();
    const input: KanbanIssueUpdateInput = {
      runId: null,
      runState
    };
    if (status) {
      input.status = status;
    }
    if (event.chatId) {
      input.chatId = event.chatId;
    }
    const issues = listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues;
    const matchingIssue = issues.find((issue) =>
      (event.runId && (issue.runId === event.runId || issue.activeRunId === event.runId)) ||
      (event.chatId && (issue.chatId === event.chatId || issue.attachmentChatId === event.chatId))
    );
    if (matchingIssue && issueSyncMode(matchingIssue) !== "cloud") {
      if (event.runId) {
        updateDesktopKanbanIssueByRunId(this.options.app, currentUser, event.runId, input);
      } else if (event.chatId) {
        updateDesktopKanbanIssueByChatId(this.options.app, currentUser, event.chatId, input);
      }
      return;
    }
    if (matchingIssue && issueSyncMode(matchingIssue) === "cloud") {
      void this.appendRunEvent({
        projectId: matchingIssue.projectId,
        issueId: getRemoteIssueId(matchingIssue),
        runId: event.runId,
        chatId: event.chatId,
        eventType: readText(event.type) || `run.${runState}`,
        clientEventParts: [
          "assistant",
          getRemoteIssueId(matchingIssue),
          event.runId || event.chatId,
          readText(event.type) || readText(event.status) || runState
        ],
        payload: {
          type: event.type,
          status: status ?? event.status ?? runState,
          runState,
          chatId: event.chatId,
          runId: event.runId,
          message: event.message,
          error: event.error
        }
      }).catch((error) => {
        this.options.onDebug?.(error instanceof Error ? error.message : String(error));
      });
    }
  }

  private currentUser(): KanbanCurrentUser {
    const status = getDesktopSsoStatus(this.options.app);
    const user = status.authenticated ? status.user : null;
    if (user?.sub?.trim()) {
      return {
        id: user.sub.trim(),
        name: user.name?.trim() || user.email?.trim() || user.sub.trim(),
        email: user.email?.trim() || "",
        source: "sso"
      };
    }
    const siteTokenUser = readDesktopSsoSiteTokenUser(this.options.app);
    if (siteTokenUser?.sub) {
      return {
        id: siteTokenUser.sub,
        name: siteTokenUser.name || siteTokenUser.email || siteTokenUser.sub,
        email: siteTokenUser.email,
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
    this.wsClient.start(readKanbanWsConfig(this.options.app), options.forceReconnect ? { forceReconnect: true } : undefined);
    this.connectionState = this.wsClient.getState();
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

    if (event.eventType === "issue.deleted") {
      tombstoneDesktopKanbanCloudIssue(this.options.app, currentUser, issueEventIssueId(event), seq);
    } else {
      const issue = issueEventIssuePayload(event);
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
        projectId: delivery.projectId || DEFAULT_SELECTED_PROJECT_ID,
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
    if (delivery.eventType === "command.runIssue") {
      const agentKey = optionalText(payload.agentKey);
      const runResult = await this.startRemoteRun({
        issue,
        revision: sourceRevision,
        agentKey,
        accessLevel: normalizeRemoteAccessLevel(payload.accessLevel),
        chatId: nullableText(payload.chatId),
        message: readText(payload.message),
        source: "sidebar"
      });
      if (!runResult.ok) {
        return { ok: false, message: runResult.message };
      }
      await this.appendRunEvent({
        sourceDeliverySeq: delivery.deliverySeq,
        projectId: readText(delivery.projectId) || readText(payload.projectId),
        issueId: deliveryIssueId(delivery),
        runId: runResult.runId,
        chatId: runResult.chatId,
        eventType: "run.started",
        clientEventParts: ["delivery", delivery.deliverySeq, "run.started"],
        payload: {
          status: "running",
          agentKey,
          runId: runResult.runId,
          chatId: runResult.chatId
        }
      });
      return { ok: true, lastAppliedRevision: cursor.lastAppliedRevision };
    }
    return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: delivery.eventType || "unknown" }) };
  }

  private async appendRunEvent(input: {
    sourceDeliverySeq?: number;
    projectId?: string;
    issueId: string;
    runId?: string | null;
    chatId?: string | null;
    eventType: string;
    clientEventParts: Array<string | number | null | undefined>;
    payload: Record<string, unknown>;
  }) {
    const issueId = readText(input.issueId);
    if (!issueId || !this.wsClient.isOpen()) {
      return;
    }
    const deviceId = getDesktopDeviceId(this.options.app);
    await this.wsClient.request("run.event.append", {
      deviceId,
      clientEventId: stableClientEventId(deviceId, input.clientEventParts),
      sourceDeliverySeq: input.sourceDeliverySeq ?? 0,
      projectId: readText(input.projectId) || DEFAULT_SELECTED_PROJECT_ID,
      issueId,
      runId: readText(input.runId) || undefined,
      chatId: readText(input.chatId) || undefined,
      eventType: input.eventType,
      payload: input.payload
    });
  }

  // 响应云端 desktop.project.createLocal:在本地真正创建项目。
  private createLocalProject(payload: unknown) {
    const record = isRecord(payload) ? payload : {};
    const result = createLocalDesktopProject(this.options.app, this.currentUser(), {
      id: readText(record.localProjectId),
      name: readText(record.name)
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

  // 响应云端 desktop.project.unbind:把该本地项目下的 cloud issue 转为 private 保留副本。
  private unbindLocalProject(payload: unknown) {
    const record = isRecord(payload) ? payload : {};
    const localProjectId = readText(record.localProjectId);
    const converted = localProjectId
      ? convertLocalProjectIssuesToPrivate(this.options.app, this.currentUser(), localProjectId)
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
    const fallbackRunId = createKanbanRemoteRunId();
    const startRequest = { ...request, chatId };
    const startRun = this.options.assistantBridge.startRun(startRequest);
    const applyRunResult = (runResult: AssistantStartRunResult) => {
      if (runResult.ok && localIssueId) {
        updateDesktopKanbanIssue(this.options.app, currentUser, localIssueId, {
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
      updateDesktopKanbanIssue(this.options.app, currentUser, localIssueId, {
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
        this.sendAssistantEvent({ type: "error", status: "failed", chatId, runId: fallbackRunId });
      }
    }).catch((error) => {
      if (localIssueId) {
        updateDesktopKanbanIssue(this.options.app, currentUser, localIssueId, {
          status: "todo",
          chatId,
          runId: fallbackRunId,
          runState: "failed"
        });
        this.notifyChanged();
      }
      this.sendAssistantEvent({ type: "error", status: "failed", chatId, runId: fallbackRunId });
      this.options.onDebug?.(t("kanban.runtime.debugBackgroundStartFailed", {
        message: error instanceof Error ? error.message : String(error)
      }));
    });
    this.options.onDebug?.(t("kanban.runtime.debugSlowStartRun"));
    return {
      ok: true,
      runId: fallbackRunId,
      chatId,
      message: t("kanban.runtime.dispatchedStarting")
    };
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
