import fs from "node:fs";
import os from "node:os";
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
  TaskBoardStatus
} from "../shared/contracts";
import { APP_BRAND } from "../shared/generated/brand";
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

const CONTROL_CONFIG_FILE = "control.json";
const LEGACY_KANBAN_CONFIG_FILE = "kanban.json";
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

function shortDeviceId(deviceId: string) {
  const text = readText(deviceId);
  return text ? text.slice(0, 8) : "";
}

function getHostname() {
  try {
    return readText(os.hostname());
  } catch {
    return "";
  }
}

function getUsername() {
  try {
    return readText(os.userInfo().username);
  } catch {
    return "";
  }
}

function buildDeviceName(input: { deviceAlias?: string; hostname?: string; username?: string; deviceId?: string }) {
  const deviceAlias = readText(input.deviceAlias);
  if (deviceAlias) {
    return deviceAlias;
  }
  const systemName = [readText(input.hostname), readText(input.username)].filter(Boolean).join(" · ");
  return systemName || shortDeviceId(readText(input.deviceId)) || "桌面端设备";
}

function getTaskBoardConfigPath(app: App) {
  return path.join(getDesktopConfigRoot(app), CONTROL_CONFIG_FILE);
}

function getLegacyTaskBoardConfigPath(app: App) {
  return path.join(getDesktopConfigRoot(app), LEGACY_KANBAN_CONFIG_FILE);
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

function readTaskBoardConfigFile(app: App): TaskBoardDesktopConfigFile {
  const configPath = getTaskBoardConfigPath(app);
  const legacyPath = getLegacyTaskBoardConfigPath(app);
  if (fs.existsSync(configPath)) {
    if (fs.existsSync(legacyPath)) {
      try {
        const legacyMtime = fs.statSync(legacyPath).mtimeMs;
        const configMtime = fs.statSync(configPath).mtimeMs;
        if (legacyMtime > configMtime) {
          const legacy = readTaskBoardOwnerConfig(JSON.parse(fs.readFileSync(legacyPath, "utf8")));
          writeTaskBoardCloudConfig(app, legacy);
          return legacy;
        }
      } catch {
        // Fall back to the canonical control.json below.
      }
    }
    try {
      return readTaskBoardOwnerConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
    } catch {
      return {};
    }
  }

  if (!fs.existsSync(legacyPath)) {
    return {};
  }

  try {
    const legacy = readTaskBoardOwnerConfig(JSON.parse(fs.readFileSync(legacyPath, "utf8")));
    writeTaskBoardCloudConfig(app, legacy);
    return legacy;
  } catch {
    return {};
  }
}

export function readTaskBoardWsConfig(app: App): KanbanDesktopWsConfig | null {
  const config = normalizeTaskBoardCloudConfig(readTaskBoardConfigFile(app));
  const serverUrl = readText(process.env.ZENMIND_KANBAN_SERVER_URL) || readText(config.serverUrl);
  const remoteControlEnabled = process.env.ZENMIND_KANBAN_REMOTE_CONTROL_ENABLED === "true" ||
    config.remoteControlEnabled;
  if (!remoteControlEnabled || !serverUrl) {
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
  return normalizeTaskBoardCloudConfig(readTaskBoardConfigFile(app));
}

function writeTaskBoardCloudConfig(app: App, input: TaskBoardDesktopConfigFile): TaskBoardCloudConfig {
  const config = normalizeTaskBoardCloudConfig(input);
  const configPath = getTaskBoardConfigPath(app);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    taskBoard: config
  }, null, 2)}\n`, "utf8");
  return config;
}

function getTaskBoardDeviceInfo(app: App) {
  const config = readTaskBoardCloudConfig(app);
  const deviceId = getDesktopDeviceId(app);
  const hostname = getHostname();
  const username = getUsername();
  const deviceAlias = readText(config.deviceAlias);
  return {
    deviceName: buildDeviceName({ deviceAlias, hostname, username, deviceId }),
    deviceAlias: deviceAlias || undefined,
    hostname: hostname || undefined,
    username: username || undefined
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
        "kanban.issue.dispatch",
        "kanban.issue.sync",
        "desktop.issue.sync",
        "desktop.project.bind",
        "desktop.project.createLocal",
        "desktop.project.select",
        "desktop.assistant.listAgents",
        "desktop.assistant.startRun",
        "desktop.automation.sync"
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

  listIssues(): TaskBoardListResult {
    this.refreshConnection();
    return listDesktopKanbanIssues(this.options.app, this.currentUser(), this.connectionState);
  }

  getCloudConfig(): TaskBoardCloudConfigResult {
    this.refreshConnection();
    return {
      ok: true,
      message: "云端看板配置已加载。",
      config: readTaskBoardCloudConfig(this.options.app),
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
        message: "云端看板服务未连接。"
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
        message: error instanceof Error ? error.message : "在线设备列表读取失败。"
      };
    }
  }

  async listLocalProjects(): Promise<{ ok: boolean; projects: TaskBoardProject[]; message: string }> {
    const result = this.listIssues();
    return {
      ok: true,
      projects: result.projects ?? [],
      message: "本地项目列表已读取。"
    };
  }

  saveCloudConfig(input: TaskBoardCloudConfig): TaskBoardCloudConfigResult {
    const config = writeTaskBoardCloudConfig(this.options.app, input);
    this.refreshConnection({ forceReconnect: true });
    return {
      ok: true,
      message: config.serverUrl ? "云端看板配置已保存，正在重新连接。" : "云端看板配置已保存，连接已关闭。",
      config,
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
        message: "连接云端看板服务后才能创建云同步任务。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    try {
      const response = await this.wsClient.request("kanban.issue.create", toCloudIssueInput(input));
      return this.applyCloudIssueResponse(response, "任务已同步到云端看板。", "desktop");
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
        message: "任务不存在。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }

    if (issueSyncMode(issue) === "private") {
      if (input.syncToCloud === true) {
        if (!this.wsClient.isOpen()) {
          return {
            ok: false,
            message: "连接云端看板服务后才能同步私有任务。",
            issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
          };
        }
        const localResult = updateDesktopKanbanIssue(this.options.app, currentUser, issue.id, input);
        if (!localResult.ok || !localResult.issue) {
          return localResult;
        }
        markDesktopKanbanIssueSyncing(this.options.app, currentUser, localResult.issue.id);
        try {
          const response = await this.wsClient.request("kanban.issue.create", toCloudIssueInput(localResult.issue));
          const remoteIssue = resultIssuePayload(response);
          if (!remoteIssue) {
            return this.applyCloudIssueResponse(response, "任务已同步到云端看板。", "desktop");
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
        message: "云同步任务需要连接云端看板服务后才能修改。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    try {
      markDesktopKanbanIssueSyncing(this.options.app, currentUser, issue.id);
      const response = await this.wsClient.request("kanban.issue.update", {
        id: getRemoteIssueId(issue),
        input: {
          ...toCloudIssueInput(input),
          baseIssueRevision: baseIssueRevision(issue)
        }
      });
      return this.applyCloudIssueResponse(response, "云同步任务已更新。", issue.origin ?? "cloud_dispatch");
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
        message: "任务不存在。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (issueSyncMode(issue) === "private") {
      return moveDesktopKanbanIssue(this.options.app, currentUser, input);
    }
    if (!this.wsClient.isOpen()) {
      return {
        ok: false,
        message: "云同步任务需要连接云端看板服务后才能移动。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    try {
      markDesktopKanbanIssueSyncing(this.options.app, currentUser, issue.id);
      const response = await this.wsClient.request("kanban.issue.move", {
        id: getRemoteIssueId(issue),
        status: input.status,
        position: input.position,
        baseIssueRevision: baseIssueRevision(issue)
      });
      return this.applyCloudIssueResponse(response, "云同步任务已移动。", issue.origin ?? "cloud_dispatch");
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
      return { ok: false, message: "任务不存在。", issues: currentIssues };
    }
    if (issueSyncMode(issue) === "cloud" && !this.wsClient.isOpen()) {
      return {
        ok: false,
        message: "云同步任务需要连接云端看板服务后才能删除。",
        issues: currentIssues
      };
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
          message: `自动化删除失败：${error instanceof Error ? error.message : String(error)}`,
          issues: currentIssues
        };
      }
    }
    if (issueSyncMode(issue) === "private") {
      return deleteDesktopKanbanIssue(this.options.app, currentUser, issue.id);
    }
    try {
      markDesktopKanbanIssueSyncing(this.options.app, currentUser, issue.id);
      const response = await this.wsClient.request("kanban.issue.delete", {
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
          message: resultMessage(response, "云同步任务已删除。"),
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
        message: "任务不存在。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (issueSyncMode(issue) === "cloud" && !this.wsClient.isOpen()) {
      return {
        ok: false,
        message: "云同步任务需要连接云端看板服务后才能同步自动化。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    const localResult = await this.syncAutomationForIssue(issue, callAgentPlatform);
    if (!localResult.ok || !localResult.issue || issueSyncMode(localResult.issue) === "private") {
      return localResult;
    }
    try {
      markDesktopKanbanIssueSyncing(this.options.app, currentUser, localResult.issue.id);
      const response = await this.wsClient.request("kanban.issue.update", {
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
      return this.applyCloudIssueResponse(response, "云同步任务自动化已同步。", localResult.issue.origin ?? "cloud_dispatch");
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
      `云端看板同步智能体终态事件：type=${event.type || ""} status=${event.status || ""} runState=${runState || ""} runId=${event.runId || ""} chatId=${event.chatId || ""} message=${event.message || event.error || ""}`
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
      return { ok: false, message: "缺少本地项目 ID。" };
    }
    const project = findLocalDesktopProject(this.options.app, this.currentUser(), localProjectId);
    if (!project) {
      return { ok: false, message: "本地项目不存在，请先在桌面端创建。" };
    }
    return {
      ok: true,
      message: "本地项目绑定已确认。",
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
        ? `本地项目已解绑，${converted} 个云端任务已转为本地私有任务。`
        : "本地项目解绑已确认。"
    };
  }

  private async listAgents(): Promise<DesktopPetAgentOption[]> {
    this.options.onDebug?.("云端看板正在读取本地智能体列表。");
    const installedAgents = readInstalledAgentOptions(this.options.app);
    const localAgents = normalizeDesktopPetAgentOptions(this.options.listLocalAgents?.() ?? []);
    let platformAgents: DesktopPetAgentOption[] = [];
    try {
      platformAgents = normalizeDesktopPetAgentOptions(await withTimeout(
        () => this.options.assistantBridge.listAgents(),
        ASSISTANT_AGENT_LIST_TIMEOUT_MS,
        "agent-platform 智能体列表读取超时。"
      ));
    } catch (error) {
      this.options.onDebug?.(`agent-platform 智能体列表读取失败，改用本地安装目录/缓存：${error instanceof Error ? error.message : String(error)}`);
    }
    const agents = normalizeDesktopPetAgentOptions([
      ...installedAgents,
      ...platformAgents,
      ...localAgents
    ]);
    this.options.onDebug?.(`云端看板返回智能体：${agents.length} 个（安装目录 ${installedAgents.length}，平台 ${platformAgents.length}，缓存 ${localAgents.length}）。`);
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
      this.options.onDebug?.(`云端看板后台启动智能体失败：${error instanceof Error ? error.message : String(error)}`);
    });
    this.options.onDebug?.("云端看板远程 startRun 启动较慢，已先返回运行中状态。");
    return {
      ok: true,
      runId: fallbackRunId,
      chatId,
      message: "已派发到桌面端，智能体正在启动。"
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
      message: "云端看板服务未返回任务数据。",
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
        message: "请选择智能体后再启用定时任务。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (!issue.automationCron?.trim()) {
      return {
        ok: false,
        message: "请设置自动化 cron。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    if (!issue.automationMessage?.trim()) {
      return {
        ok: false,
        message: "请填写自动化要执行的内容。",
        issues: listDesktopKanbanIssues(this.options.app, currentUser, this.connectionState).issues
      };
    }
    const payload = buildTaskBoardAutomationPayload(issue);
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
        message: "agent-platform 未返回自动化 ID。",
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
      return { ok: false, message: "自动化同步缺少任务数据。" };
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
        message: "自动化已关闭。",
        issue: {
          ...issue,
          automationId: null,
          automationEnabled: false
        }
      };
    }
    if (!issue.assigneeAgentKey?.trim()) {
      return { ok: false, message: "请选择智能体后再启用定时任务。" };
    }
    if (!issue.automationCron?.trim()) {
      return { ok: false, message: "请设置自动化 cron。" };
    }
    if (!issue.automationMessage?.trim()) {
      return { ok: false, message: "请填写自动化要执行的内容。" };
    }
    const automationPayload = buildTaskBoardAutomationPayload(issue);
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
      return { ok: false, message: "agent-platform 未返回自动化 ID。" };
    }
    const result = {
      ok: true,
      message: "自动化已同步。",
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
