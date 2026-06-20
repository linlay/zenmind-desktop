import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import type { App } from "electron";
import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  TaskBoardCloudConfig,
  TaskBoardCloudConfigResult,
  TaskBoardCurrentUser,
  TaskBoardDeleteResult,
  TaskBoardDesktopOnlineResult,
  TaskBoardIssue,
  TaskBoardIssueInput,
  TaskBoardIssueMoveInput,
  TaskBoardIssueResult,
  TaskBoardIssueUpdateInput,
  TaskBoardListResult,
  TaskBoardProject,
  TaskBoardRunState,
  TaskBoardSettings,
  TaskBoardSettingsInput,
  TaskBoardSettingsResult,
  TaskBoardStatus
} from "../shared/contracts";
import { APP_BRAND } from "../shared/brand";
import { getDesktopDeviceInfo } from "./desktop-device-info";
import { getDesktopDeviceId } from "./device-identity";
import { getDesktopSsoStatus } from "./oidc-sso";
import { buildTaskBoardAutomationPayload, resolveTaskBoardRunStateFromAssistantEvent, resolveTaskBoardStatusFromAssistantEvent } from "./task-board-sync";
import {
  applyDesktopKanbanCloudSnapshot,
  createPrivateDesktopKanbanIssue,
  deleteDesktopKanbanIssue,
  getDesktopKanbanIssue,
  listDesktopKanbanIssues,
  linkDesktopKanbanIssueToRemote,
  markDesktopKanbanIssueSyncError,
  markDesktopKanbanIssueSyncing,
  moveDesktopKanbanIssue,
  setDesktopKanbanIssuePosition,
  updateDesktopKanbanIssue,
  updateDesktopKanbanIssueByChatId,
  updateDesktopKanbanIssueByRunId,
  upsertDispatchedDesktopKanbanIssue,
  type TaskBoardCloudSnapshot
} from "./task-board-local-store";
import { getDesktopConfigRoot } from "./user-paths";
import {
  convertLocalProjectIssuesToPrivate,
  createLocalDesktopProject,
  findLocalDesktopProject
} from "./task-board-local-projects";
import { DesktopCloudSyncEngine } from "./task-board-cloud-sync";
import {
  KanbanDesktopWsClient,
  type KanbanDesktopConnectionState,
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

type TaskBoardRuntimeOptions = {
  app: App;
  assistantBridge: AssistantBridgeLike;
  callAgentPlatform: AgentPlatformCaller<App>;
  listLocalAgents?: () => DesktopPetAgentOption[];
  onChanged?: () => void;
  onDebug?: (message: string) => void;
};

type TaskBoardDesktopConfigFile = {
  schemaVersion?: unknown;
  taskBoard?: unknown;
  enabled?: unknown;
  cloud?: unknown;
  serverUrl?: unknown;
  token?: unknown;
  selectedProjectId?: unknown;
  remoteControlEnabled?: unknown;
  deviceAlias?: unknown;
};

type TaskBoardAssistantSyncEvent = {
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
const REMOTE_START_RUN_ACK_TIMEOUT_MS = readPositiveIntegerEnv("ZENMIND_TASK_BOARD_REMOTE_START_ACK_TIMEOUT_MS", 5_000);

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

function getTaskBoardConfigPath(app: App) {
  return path.join(getDesktopConfigRoot(app), KANBAN_CONFIG_FILE);
}


function readTaskBoardOwnerConfig(input: unknown): TaskBoardDesktopConfigFile {
  if (!isRecord(input)) {
    return {};
  }
  return isRecord(input.taskBoard)
    ? input.taskBoard as TaskBoardDesktopConfigFile
    : input as TaskBoardDesktopConfigFile;
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

function normalizeTaskBoardCloudConfig(input: TaskBoardDesktopConfigFile): TaskBoardCloudConfig {
  return {
    serverUrl: readText(input.serverUrl),
    token: readText(input.token),
    selectedProjectId: readText(input.selectedProjectId) || DEFAULT_SELECTED_PROJECT_ID,
    remoteControlEnabled: readBoolean(input.remoteControlEnabled),
    deviceAlias: readText(input.deviceAlias)
  };
}

function hasTaskBoardCloudFields(input: TaskBoardDesktopConfigFile) {
  return "serverUrl" in input ||
    "token" in input ||
    "selectedProjectId" in input ||
    "remoteControlEnabled" in input ||
    "deviceAlias" in input;
}

function normalizeTaskBoardSettings(
  input: TaskBoardDesktopConfigFile,
  defaults: Partial<TaskBoardSettings> = {}
): TaskBoardSettings {
  const cloudInput = isRecord(input.cloud)
    ? input.cloud as TaskBoardDesktopConfigFile
    : isRecord(input.taskBoard)
      ? input.taskBoard as TaskBoardDesktopConfigFile
      : input;
  const hasCloudInput = hasTaskBoardCloudFields(cloudInput);
  const cloud = hasCloudInput
    ? normalizeTaskBoardCloudConfig(cloudInput)
    : defaults.cloud ?? normalizeTaskBoardCloudConfig({});
  const enabled = typeof input.enabled === "boolean"
    ? input.enabled
    : typeof defaults.enabled === "boolean"
      ? defaults.enabled
      : isTaskBoardCloudConfigComplete(cloud);
  return {
    enabled,
    cloud
  };
}

function isTaskBoardCloudConfigComplete(config: TaskBoardCloudConfig) {
  return Boolean(config.serverUrl.trim());
}

function readJsonConfigFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}


export function readTaskBoardSettings(app: App): TaskBoardSettings {
  const configPath = getTaskBoardConfigPath(app);
  if (fs.existsSync(configPath)) {
    const raw = readJsonConfigFile(configPath);
    const parsed = readTaskBoardOwnerConfig(raw);
    const settings = normalizeTaskBoardSettings(parsed);
    if (!isRecord(raw) || !isRecord(raw.cloud) || raw.enabled !== settings.enabled) {
      writeTaskBoardSettings(app, settings);
    }
    return settings;
  }

  const settings = normalizeTaskBoardSettings({});
  writeTaskBoardSettings(app, settings);
  return settings;
}

export function readTaskBoardWsConfig(app: App): KanbanDesktopWsConfig | null {
  const settings = readTaskBoardSettings(app);
  const config = settings.cloud;
  const serverUrl = readText(process.env.ZENMIND_KANBAN_SERVER_URL) || readText(config.serverUrl);
  const remoteControlEnabled = process.env.ZENMIND_KANBAN_REMOTE_CONTROL_ENABLED === "true" ||
    config.remoteControlEnabled;
  if (!settings.enabled || !remoteControlEnabled || !serverUrl) {
    return null;
  }
  return {
    serverUrl,
    token: readText(process.env.ZENMIND_KANBAN_TOKEN) || readText(config.token),
    selectedProjectId: readText(process.env.ZENMIND_KANBAN_PROJECT_ID) ||
      readText(config.selectedProjectId) ||
      DEFAULT_SELECTED_PROJECT_ID
  };
}

function readTaskBoardCloudConfig(app: App): TaskBoardCloudConfig {
  return readTaskBoardSettings(app).cloud;
}

function writeTaskBoardSettings(app: App, input: TaskBoardSettings): TaskBoardSettings {
  const settings = normalizeTaskBoardSettings({
    enabled: input.enabled,
    cloud: input.cloud
  });
  const configPath = getTaskBoardConfigPath(app);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    enabled: settings.enabled,
    cloud: settings.cloud
  }, null, 2)}\n`, "utf8");
  return settings;
}

export function saveTaskBoardSettings(app: App, input: TaskBoardSettingsInput): TaskBoardSettings {
  const current = readTaskBoardSettings(app);
  return writeTaskBoardSettings(app, {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    cloud: normalizeTaskBoardCloudConfig({
      ...current.cloud,
      ...(isRecord(input.cloud) ? input.cloud : {})
    })
  });
}

function writeTaskBoardCloudConfig(app: App, input: TaskBoardDesktopConfigFile): TaskBoardCloudConfig {
  const configPath = getTaskBoardConfigPath(app);
  return saveTaskBoardSettings(app, {
    ...(fs.existsSync(configPath) ? {} : { enabled: true }),
    cloud: input as Partial<TaskBoardCloudConfig>
  }).cloud;
}

export function writeTaskBoardSettingsIfAbsent(app: App, input: TaskBoardSettingsInput) {
  const configPath = getTaskBoardConfigPath(app);
  if (fs.existsSync(configPath)) {
    return false;
  }
  saveTaskBoardSettings(app, input);
  return true;
}

function getTaskBoardDeviceInfo(app: App) {
  const deviceInfo = getDesktopDeviceInfo(app);
  return {
    deviceName: deviceInfo.deviceName,
    deviceAlias: deviceInfo.deviceName,
    hostname: deviceInfo.hostname || undefined,
    username: deviceInfo.username || undefined
  };
}

function issueSyncMode(issue: TaskBoardIssue | null | undefined) {
  return issue?.syncMode === "cloud" ? "cloud" : "private";
}

function getRemoteIssueId(issue: TaskBoardIssue) {
  return readText(issue.remoteIssueId) || readText(issue.id);
}

function toCloudIssueInput(input: TaskBoardIssueInput | TaskBoardIssueUpdateInput | TaskBoardIssue): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const fields = [
    "title",
    "projectId",
    "workflowId",
    "typeId",
    "stageId",
    "statusId",
    "description",
    "status",
    "priority",
    "severity",
    "assigneeAgentKey",
    "assigneeId",
    "workerType",
    "workerId",
    "workerAgent",
    "reviewerId",
    "reviewRequired",
    "chatId",
    "runId",
    "runState",
    "automationId",
    "automationEnabled",
    "automationCron",
    "automationMessage",
    "automationTimezone",
    "attachmentChatId",
    "attachments"
  ] as const;
  for (const field of fields) {
    if (field in input && (input as Record<string, unknown>)[field] !== undefined) {
      payload[field] = (input as Record<string, unknown>)[field];
    }
  }
  return payload;
}

function resultIssuePayload(payload: unknown) {
  return isRecord(payload) && "issue" in payload ? payload.issue : null;
}

function resultIssuesPayload(payload: unknown) {
  return isRecord(payload) && Array.isArray(payload.issues) ? payload.issues : null;
}

function resultRevision(payload: unknown) {
  return isRecord(payload) && typeof payload.revision === "number" ? payload.revision : 0;
}

function resultProjectId(payload: unknown) {
  return isRecord(payload) ? readText(payload.projectId) : "";
}

function resultComplete(payload: unknown) {
  return isRecord(payload) && payload.complete === true;
}

function resultScope(payload: unknown) {
  return isRecord(payload) ? readText(payload.scope) : "";
}

function resultOk(payload: unknown) {
  return !isRecord(payload) || payload.ok !== false;
}

function resultMessage(payload: unknown, fallback: string) {
  return isRecord(payload) ? readText(payload.message) || fallback : fallback;
}

function baseIssueRevision(issue: TaskBoardIssue) {
  return typeof issue.revision === "number" && issue.revision > 0 ? issue.revision : undefined;
}

function buildListLikeIssueResult(list: TaskBoardListResult, message: string, issue?: TaskBoardIssue): TaskBoardIssueResult {
  const remoteIssueId = isRecord(issue) ? readText(issue.remoteIssueId) || readText(issue.id) : "";
  const localIssue = remoteIssueId
    ? list.issues.find((candidate) => candidate.remoteIssueId === remoteIssueId || candidate.id === remoteIssueId)
    : undefined;
  return {
    ok: list.ok,
    message,
    issue: localIssue ?? issue,
    issues: list.issues
  };
}

function taskBoardIssueFromAutomationPayload(payload: unknown): TaskBoardIssue | null {
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
    statusId: optionalText(record.statusId),
    title,
    description: readText(record.description),
    status: (readText(record.status) || "backlog") as TaskBoardStatus,
    priority: (readText(record.priority) || "medium") as TaskBoardIssue["priority"],
    severity: (readText(record.severity) || "medium") as NonNullable<TaskBoardIssue["severity"]>,
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
    runState: nullableText(record.runState) as TaskBoardRunState | null,
    automationId: nullableText(record.automationId),
    automationEnabled: readBoolean(record.automationEnabled),
    automationCron: nullableText(record.automationCron),
    automationMessage: nullableText(record.automationMessage),
    automationTimezone: nullableText(record.automationTimezone),
    attachmentChatId: nullableText(record.attachmentChatId),
    attachments: Array.isArray(record.attachments) ? record.attachments as TaskBoardIssue["attachments"] : [],
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

export class TaskBoardRuntime {
  private readonly wsClient: KanbanDesktopWsClient;
  private readonly cloudSync: DesktopCloudSyncEngine;
  private connectionState: KanbanDesktopConnectionState = "disabled";

  constructor(private readonly options: TaskBoardRuntimeOptions) {
    this.wsClient = new KanbanDesktopWsClient({
      capabilities: [
        "desktop.issue.dispatch",
        "desktop.issue.sync",
        "desktop.issue.sync",
        "desktop.project.bind",
        "desktop.project.createLocal",
        "desktop.project.select",
        "agent.listDesktop",
        "desktop.assistant.startRun",
        "automation.sync"
      ],
      getCurrentUser: () => this.currentUser(),
      getDeviceId: () => getDesktopDeviceId(this.options.app),
      getDeviceInfo: () => getTaskBoardDeviceInfo(this.options.app),
      onSnapshot: (snapshot) => this.applySnapshot(snapshot),
      onDispatchIssue: (issue, revision) => this.applyDispatch(issue, revision),
      onListAgents: () => this.listAgents(),
      onStartRun: (request) => this.startRemoteRun(request),
      onAutomationSync: (payload) => this.syncRemoteAutomationPayload(payload),
      onListLocalProjects: () => this.listLocalProjects(),
      onCreateLocalProject: (payload) => Promise.resolve(this.createLocalProject(payload)),
      onBindProject: (payload) => Promise.resolve(this.bindLocalProject(payload)),
      onUnbindProject: (payload) => Promise.resolve(this.unbindLocalProject(payload)),
      onConnected: () => {
        // 重连对账:下行差异已由快照覆盖,上行补 pending 的本地 issue。
        void this.cloudSync.run();
      },
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

  listIssues(): TaskBoardListResult {
    this.refreshConnection();
    return listDesktopKanbanIssues(this.options.app, this.currentUser(), this.connectionState);
  }

  getCloudConfig(): TaskBoardCloudConfigResult {
    this.refreshConnection();
    return {
      ok: true,
      message: t("taskBoard.runtime.cloudConfigLoaded"),
      config: readTaskBoardCloudConfig(this.options.app),
      configPath: getTaskBoardConfigPath(this.options.app),
      connectionState: this.connectionState
    };
  }

  getSettings(): TaskBoardSettingsResult {
    this.refreshConnection();
    return {
      ok: true,
      message: t("taskBoard.runtime.settingsLoaded"),
      settings: readTaskBoardSettings(this.options.app),
      configPath: getTaskBoardConfigPath(this.options.app),
      connectionState: this.connectionState
    };
  }

  async listOnlineDevices(): Promise<TaskBoardDesktopOnlineResult> {
    this.refreshConnection();
    if (!this.wsClient.isOpen()) {
      return {
        ok: false,
        online: false,
        deviceCount: 0,
        sessionCount: 0,
        agentCount: 0,
        devices: [],
        message: t("taskBoard.cloudSync.notConnected")
      };
    }
    try {
      return await this.wsClient.request<TaskBoardDesktopOnlineResult>("desktop.online.list", {
        projectId: readTaskBoardCloudConfig(this.options.app).selectedProjectId || "default"
      });
    } catch (error) {
      return {
        ok: false,
        online: false,
        deviceCount: 0,
        sessionCount: 0,
        agentCount: 0,
        devices: [],
        message: error instanceof Error ? error.message : t("taskBoard.runtime.onlineDevicesFailed")
      };
    }
  }

  async listLocalProjects(): Promise<{ ok: boolean; projects: TaskBoardProject[]; message: string }> {
    const result = this.listIssues();
    return {
      ok: true,
      projects: result.projects ?? [],
      message: t("taskBoard.runtime.localProjectsLoaded")
    };
  }

  saveCloudConfig(input: TaskBoardCloudConfig): TaskBoardCloudConfigResult {
    const config = writeTaskBoardCloudConfig(this.options.app, input);
    this.refreshConnection({ forceReconnect: true });
    return {
      ok: true,
      message: config.serverUrl ? t("taskBoard.runtime.cloudConfigSavedReconnect") : t("taskBoard.runtime.cloudConfigSavedClosed"),
      config,
      configPath: getTaskBoardConfigPath(this.options.app),
      connectionState: this.connectionState
    };
  }

  saveSettings(input: TaskBoardSettingsInput): TaskBoardSettingsResult {
    const settings = saveTaskBoardSettings(this.options.app, input);
    this.refreshConnection({ forceReconnect: true });
    const requestedEnable = input.enabled === true;
    return {
      ok: true,
      message: requestedEnable && !settings.enabled
        ? t("taskBoard.runtime.settingsNeedsCloudConfig")
        : settings.enabled
          ? t("taskBoard.runtime.settingsSaved")
          : t("taskBoard.runtime.disabled"),
      settings,
      configPath: getTaskBoardConfigPath(this.options.app),
      connectionState: this.connectionState
    };
  }

  async createIssue(input: TaskBoardIssueInput): Promise<TaskBoardIssueResult> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    if (input.syncToCloud !== true) {
      const result = createPrivateDesktopKanbanIssue(this.options.app, currentUser, input);
      if (result.ok) {
        // 新私有 issue 若落在活动绑定的本地项目下,自动触发上行同步
        void this.cloudSync.run();
      }
      return result;
    }
    if (!this.wsClient.isOpen()) {
      return {
        ok: false,
        message: t("taskBoard.runtime.createCloudRequiresConnection"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    try {
      const response = await this.wsClient.request("issue.create", toCloudIssueInput(input));
      return this.applyCloudIssueResponse(response, t("taskBoard.runtime.syncedToCloud"), "desktop");
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
  }

  async updateIssue(issueId: string, input: TaskBoardIssueUpdateInput): Promise<TaskBoardIssueResult> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, issueId);
    if (!issue) {
      return {
        ok: false,
        message: t("taskBoard.runtime.missing"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }

    if (issueSyncMode(issue) === "private") {
      if (input.syncToCloud === true) {
        if (!this.wsClient.isOpen()) {
          return {
            ok: false,
            message: t("taskBoard.runtime.syncPrivateRequiresConnection"),
            issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
          };
        }
        const localResult = updateDesktopKanbanIssue(this.options.app, currentUser, issue.id, input);
        if (!localResult.ok || !localResult.issue) {
          return localResult;
        }
        markDesktopKanbanIssueSyncing(this.options.app, currentUser, localResult.issue.id);
        try {
          const response = await this.wsClient.request("issue.create", toCloudIssueInput(localResult.issue));
          const remoteIssue = resultIssuePayload(response);
          if (!remoteIssue) {
            return this.applyCloudIssueResponse(response, t("taskBoard.runtime.syncedToCloud"), "desktop");
          }
          return linkDesktopKanbanIssueToRemote(
            this.options.app,
            currentUser,
            localResult.issue.id,
            remoteIssue,
            resultRevision(response)
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          markDesktopKanbanIssueSyncError(this.options.app, currentUser, localResult.issue.id, message);
          return {
            ok: false,
            message,
            issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
          };
        }
      }
      const localUpdate = updateDesktopKanbanIssue(this.options.app, currentUser, issue.id, input);
      if (localUpdate.ok) {
        // 私有 issue 更新后若命中活动绑定,自动触发上行同步
        void this.cloudSync.run();
      }
      return localUpdate;
    }

    if (!this.wsClient.isOpen()) {
      return {
        ok: false,
        message: t("taskBoard.runtime.cloudUpdateRequiresConnection"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    try {
      markDesktopKanbanIssueSyncing(this.options.app, currentUser, issue.id);
      const response = await this.wsClient.request("issue.update", {
        id: getRemoteIssueId(issue),
        input: {
          ...toCloudIssueInput(input),
          baseIssueRevision: baseIssueRevision(issue)
        }
      });
      return this.applyCloudIssueResponse(response, t("taskBoard.runtime.cloudUpdated"), issue.origin ?? "cloud_dispatch");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markDesktopKanbanIssueSyncError(this.options.app, currentUser, issue.id, message);
      return {
        ok: false,
        message,
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
  }

  async moveIssue(input: TaskBoardIssueMoveInput): Promise<TaskBoardIssueResult> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, input.id);
    if (!issue) {
      return {
        ok: false,
        message: t("taskBoard.runtime.missing"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (issueSyncMode(issue) === "private") {
      return moveDesktopKanbanIssue(this.options.app, currentUser, input);
    }
    if (!this.wsClient.isOpen()) {
      return {
        ok: false,
        message: t("taskBoard.runtime.cloudMoveRequiresConnection"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    try {
      markDesktopKanbanIssueSyncing(this.options.app, currentUser, issue.id);
      const response = await this.wsClient.request("issue.move", {
        id: getRemoteIssueId(issue),
        status: input.status,
        position: input.position,
        baseIssueRevision: baseIssueRevision(issue)
      });
      return this.applyCloudIssueResponse(response, t("taskBoard.runtime.cloudMoved"), issue.origin ?? "cloud_dispatch");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markDesktopKanbanIssueSyncError(this.options.app, currentUser, issue.id, message);
      return {
        ok: false,
        message,
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
  }

  async deleteIssueWithAutomation(
    issueId: string,
    callAgentPlatform: AgentPlatformCaller<App> = this.options.callAgentPlatform
  ): Promise<TaskBoardDeleteResult | { ok: false; message: string; issues: TaskBoardIssue[] }> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, issueId);
    const currentIssues = listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues;
    if (!issue) {
      return { ok: false, message: t("taskBoard.runtime.missing"), issues: currentIssues };
    }
    if (issueSyncMode(issue) === "cloud" && !this.wsClient.isOpen()) {
      return {
        ok: false,
        message: t("taskBoard.runtime.cloudDeleteRequiresConnection"),
        issues: currentIssues
      };
    }
    if (issue.automationId) {
      try {
        await callAgentPlatform(this.options.app, "/api/admin/automations/delete", {
          method: "POST",
          body: { id: issue.automationId }
        });
      } catch (error) {
        return {
          ok: false,
          message: t("taskBoard.automation.deleteFailed", { message: error instanceof Error ? error.message : String(error) }),
          issues: currentIssues
        };
      }
    }
    if (issueSyncMode(issue) === "private") {
      return deleteDesktopKanbanIssue(this.options.app, currentUser, issue.id);
    }
    try {
      markDesktopKanbanIssueSyncing(this.options.app, currentUser, issue.id);
      const response = await this.wsClient.request("issue.delete", {
        id: getRemoteIssueId(issue),
        baseIssueRevision: baseIssueRevision(issue)
      });
      const snapshotIssues = resultIssuesPayload(response);
      if (snapshotIssues) {
        const list = applyDesktopKanbanCloudSnapshot(this.options.app, currentUser, {
          boardId: isRecord(response) ? readText(response.boardId) : "",
          projectId: resultProjectId(response),
          revision: resultRevision(response),
          complete: resultComplete(response),
          scope: resultScope(response),
          issues: snapshotIssues
        });
        return {
          ok: resultOk(response),
          message: resultMessage(response, t("taskBoard.runtime.cloudDeleted")),
          deletedIssueId: issue.id,
          issues: list.issues
        };
      }
      return deleteDesktopKanbanIssue(this.options.app, currentUser, issue.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markDesktopKanbanIssueSyncError(this.options.app, currentUser, issue.id, message);
      return {
        ok: false,
        message,
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
  }

  async syncIssueAutomation(
    issueId: string,
    callAgentPlatform: AgentPlatformCaller<App> = this.options.callAgentPlatform
  ): Promise<TaskBoardIssueResult | { ok: false; message: string; issues: TaskBoardIssue[] }> {
    this.refreshConnection();
    const currentUser = this.currentUser();
    const issue = getDesktopKanbanIssue(this.options.app, currentUser, issueId);
    if (!issue) {
      return {
        ok: false,
        message: t("taskBoard.runtime.missing"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (issueSyncMode(issue) === "cloud" && !this.wsClient.isOpen()) {
      return {
        ok: false,
        message: t("taskBoard.runtime.cloudAutomationRequiresConnection"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    const localResult = await this.syncAutomationForIssue(issue, callAgentPlatform);
    if (!localResult.ok || !localResult.issue || issueSyncMode(localResult.issue) === "private") {
      return localResult;
    }
    try {
      markDesktopKanbanIssueSyncing(this.options.app, currentUser, localResult.issue.id);
      const response = await this.wsClient.request("issue.update", {
        id: getRemoteIssueId(localResult.issue),
        input: {
          ...toCloudIssueInput({
            automationId: localResult.issue.automationId,
            automationEnabled: localResult.issue.automationEnabled,
            automationCron: localResult.issue.automationCron,
            automationMessage: localResult.issue.automationMessage,
            automationTimezone: localResult.issue.automationTimezone
          }),
          baseIssueRevision: baseIssueRevision(localResult.issue)
        }
      });
      return this.applyCloudIssueResponse(response, t("taskBoard.runtime.cloudAutomationSynced"), localResult.issue.origin ?? "cloud_dispatch");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markDesktopKanbanIssueSyncError(this.options.app, currentUser, localResult.issue.id, message);
      return {
        ok: false,
        message,
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
  }

  sendAssistantEvent(event: TaskBoardAssistantSyncEvent) {
    this.refreshConnection();
    const status = resolveTaskBoardStatusFromAssistantEvent(event);
    const runState = resolveTaskBoardRunStateFromAssistantEvent(event);
    if (!runState || (!event.runId && !event.chatId)) {
      return;
    }
    this.options.onDebug?.(
      t("taskBoard.runtime.debugAssistantTerminal", {
        type: event.type || "",
        status: event.status || "",
        runState: runState || "",
        runId: event.runId || "",
        chatId: event.chatId || "",
        message: event.message || event.error || ""
      })
    );
    const currentUser = this.currentUser();
    const input: TaskBoardIssueUpdateInput = {
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
    if (this.wsClient.isOpen()) {
      void this.wsClient.request("desktop.assistant.event", event).catch((error) => {
        this.options.onDebug?.(error instanceof Error ? error.message : String(error));
      });
    }
  }

  private currentUser(): TaskBoardCurrentUser {
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
    const deviceId = getDesktopDeviceId(this.options.app);
    const deviceInfo = getTaskBoardDeviceInfo(this.options.app);
    return {
      id: `device:${deviceId}`,
      name: deviceInfo.deviceName,
      email: "",
      source: "device"
    };
  }

  private refreshConnection(options: { forceReconnect?: boolean } = {}) {
    this.wsClient.start(readTaskBoardWsConfig(this.options.app), options.forceReconnect ? { forceReconnect: true } : undefined);
    this.connectionState = this.wsClient.getState();
  }

  private applySnapshot(snapshot: TaskBoardCloudSnapshot) {
    applyDesktopKanbanCloudSnapshot(this.options.app, this.currentUser(), snapshot);
    this.notifyChanged();
  }

  private applyDispatch(issue: unknown, revision: number): TaskBoardIssueResult {
    const result = upsertDispatchedDesktopKanbanIssue(this.options.app, this.currentUser(), issue, revision, "cloud_dispatch");
    this.notifyChanged();
    return result;
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
      return { ok: false, message: t("taskBoard.localProject.idRequired") };
    }
    const project = findLocalDesktopProject(this.options.app, this.currentUser(), localProjectId);
    if (!project) {
      return { ok: false, message: t("taskBoard.localProject.notFound") };
    }
    return {
      ok: true,
      message: t("taskBoard.localProject.bindConfirmed"),
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
        ? t("taskBoard.localProject.unboundWithConverted", { count: converted })
        : t("taskBoard.localProject.unboundConfirmed")
    };
  }

  private async listAgents(): Promise<DesktopPetAgentOption[]> {
    this.options.onDebug?.(t("taskBoard.runtime.debugReadingAgents"));
    const installedAgents = readInstalledAgentOptions(this.options.app);
    const localAgents = normalizeDesktopPetAgentOptions(this.options.listLocalAgents?.() ?? []);
    let platformAgents: DesktopPetAgentOption[] = [];
    try {
      platformAgents = normalizeDesktopPetAgentOptions(await withTimeout(
        () => this.options.assistantBridge.listAgents(),
        ASSISTANT_AGENT_LIST_TIMEOUT_MS,
        t("taskBoard.runtime.agentListTimeout")
      ));
    } catch (error) {
      this.options.onDebug?.(t("taskBoard.runtime.debugAgentListFallback", {
        message: error instanceof Error ? error.message : String(error)
      }));
    }
    const agents = normalizeDesktopPetAgentOptions([
      ...installedAgents,
      ...platformAgents,
      ...localAgents
    ]);
    this.options.onDebug?.(t("taskBoard.runtime.debugAgentsReturned", {
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

    const chatId = request.chatId?.trim() || createTaskBoardRemoteChatId();
    const fallbackRunId = createTaskBoardRemoteRunId();
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
      this.options.onDebug?.(t("taskBoard.runtime.debugBackgroundStartFailed", {
        message: error instanceof Error ? error.message : String(error)
      }));
    });
    this.options.onDebug?.(t("taskBoard.runtime.debugSlowStartRun"));
    return {
      ok: true,
      runId: fallbackRunId,
      chatId,
      message: t("taskBoard.runtime.dispatchedStarting")
    };
  }

  private notifyChanged() {
    this.options.onChanged?.();
  }

  private applyCloudIssueResponse(payload: unknown, fallbackMessage: string, origin: TaskBoardIssue["origin"] = "desktop"): TaskBoardIssueResult {
    const currentUser = this.currentUser();
    const issues = resultIssuesPayload(payload);
    if (issues) {
      const list = applyDesktopKanbanCloudSnapshot(this.options.app, currentUser, {
        boardId: isRecord(payload) ? readText(payload.boardId) : "",
        projectId: resultProjectId(payload),
        revision: resultRevision(payload),
        complete: resultComplete(payload),
        scope: resultScope(payload),
        issues
      }, origin);
      const result = buildListLikeIssueResult(list, resultMessage(payload, fallbackMessage), resultIssuePayload(payload) as TaskBoardIssue | undefined);
      return { ...result, ok: result.ok && resultOk(payload) };
    }
    const issue = resultIssuePayload(payload);
    if (issue) {
      return upsertDispatchedDesktopKanbanIssue(
        this.options.app,
        currentUser,
        issue,
        resultRevision(payload),
        origin ?? "desktop"
      );
    }
    return {
      ok: false,
      message: t("taskBoard.runtime.noTaskData"),
      issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
    };
  }

  private async syncAutomationForIssue(
    issue: TaskBoardIssue,
    callAgentPlatform: AgentPlatformCaller<App>
  ): Promise<TaskBoardIssueResult | { ok: false; message: string; issues: TaskBoardIssue[] }> {
    const currentUser = this.currentUser();
    if (!issue.automationEnabled) {
      if (issue.automationId) {
        await callAgentPlatform(this.options.app, "/api/admin/automations/delete", {
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
        message: t("taskBoard.automation.assigneeRequired"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (!issue.automationCron?.trim()) {
      return {
        ok: false,
        message: t("taskBoard.automation.cronRequired"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (!issue.automationMessage?.trim()) {
      return {
        ok: false,
        message: t("taskBoard.automation.messageRequired"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    const payload = buildTaskBoardAutomationPayload(issue);
    const detail = issue.automationId
      ? await callAgentPlatform<{ id?: string; scheduleId?: string }>(this.options.app, "/api/admin/automations/update", {
        method: "POST",
        body: { id: issue.automationId, ...payload }
      })
      : await callAgentPlatform<{ id?: string; scheduleId?: string }>(this.options.app, "/api/admin/automations/create", {
        method: "POST",
        body: payload
      });
    const automationId = readText(detail?.id) || readText(detail?.scheduleId) || issue.automationId;
    if (!automationId) {
      return {
        ok: false,
        message: t("taskBoard.automation.platformIdMissing"),
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    return updateDesktopKanbanIssue(this.options.app, currentUser, issue.id, {
      automationId,
      automationEnabled: true
    });
  }

  private async syncRemoteAutomationPayload(payload: unknown) {
    const issue = taskBoardIssueFromAutomationPayload(payload);
    if (!issue) {
      return { ok: false, message: t("taskBoard.automation.payloadMissing") };
    }
    if (!issue.automationEnabled) {
      if (issue.automationId) {
        await this.options.callAgentPlatform(this.options.app, "/api/admin/automations/delete", {
          method: "POST",
          body: { id: issue.automationId }
        });
      }
      return {
        ok: true,
        message: t("taskBoard.automation.disabled"),
        issue: {
          ...issue,
          automationId: null,
          automationEnabled: false
        }
      };
    }
    if (!issue.assigneeAgentKey?.trim()) {
      return { ok: false, message: t("taskBoard.automation.assigneeRequired") };
    }
    if (!issue.automationCron?.trim()) {
      return { ok: false, message: t("taskBoard.automation.cronRequired") };
    }
    if (!issue.automationMessage?.trim()) {
      return { ok: false, message: t("taskBoard.automation.messageRequired") };
    }
    const automationPayload = buildTaskBoardAutomationPayload(issue);
    const detail = issue.automationId
      ? await this.options.callAgentPlatform<{ id?: string; scheduleId?: string }>(this.options.app, "/api/admin/automations/update", {
        method: "POST",
        body: { id: issue.automationId, ...automationPayload }
      })
      : await this.options.callAgentPlatform<{ id?: string; scheduleId?: string }>(this.options.app, "/api/admin/automations/create", {
        method: "POST",
        body: automationPayload
      });
    const automationId = readText(detail?.id) || readText(detail?.scheduleId) || issue.automationId;
    if (!automationId) {
      return { ok: false, message: t("taskBoard.automation.platformIdMissing") };
    }
    const result = {
      ok: true,
      message: t("taskBoard.automation.synced"),
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

export function createTaskBoardRuntime(options: TaskBoardRuntimeOptions) {
  return new TaskBoardRuntime(options);
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

function createTaskBoardRemoteChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function createTaskBoardRemoteRunId() {
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
