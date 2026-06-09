import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  TaskBoardCloudConfig,
  TaskBoardCloudConfigResult,
  TaskBoardCurrentUser,
  TaskBoardDeleteResult,
  TaskBoardIssue,
  TaskBoardIssueInput,
  TaskBoardIssueMoveInput,
  TaskBoardIssueResult,
  TaskBoardIssueUpdateInput,
  TaskBoardListResult,
  TaskBoardRunState,
  TaskBoardStatus
} from "../shared/contracts";
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
  onChanged?: () => void;
  onDebug?: (message: string) => void;
};

type TaskBoardDesktopConfigFile = {
  serverUrl?: unknown;
  token?: unknown;
  selectedProjectId?: unknown;
};

type TaskBoardAssistantSyncEvent = {
  type?: string;
  status?: string | null;
  chatId?: string | null;
  runId?: string | null;
};

const KANBAN_CONFIG_FILE = "kanban.json";
const DEFAULT_SELECTED_PROJECT_ID = "default";

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

function normalizeTaskBoardCloudConfig(input: TaskBoardDesktopConfigFile): TaskBoardCloudConfig {
  return {
    serverUrl: readText(input.serverUrl),
    token: readText(input.token),
    selectedProjectId: readText(input.selectedProjectId) || DEFAULT_SELECTED_PROJECT_ID
  };
}

function readTaskBoardConfigFile(app: App): TaskBoardDesktopConfigFile {
  const configPath = getTaskBoardConfigPath(app);
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as TaskBoardDesktopConfigFile;
  } catch {
    return {};
  }
}

export function readTaskBoardWsConfig(app: App): KanbanDesktopWsConfig | null {
  const config = normalizeTaskBoardCloudConfig(readTaskBoardConfigFile(app));
  const serverUrl = readText(process.env.ZENMIND_KANBAN_SERVER_URL) || readText(config.serverUrl);
  if (!serverUrl) {
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
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
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
  private connectionState: KanbanDesktopConnectionState = "disabled";

  constructor(private readonly options: TaskBoardRuntimeOptions) {
    this.wsClient = new KanbanDesktopWsClient({
      capabilities: [
        "kanban.issue.dispatch",
        "kanban.issue.sync",
        "desktop.assistant.listAgents",
        "desktop.assistant.startRun",
        "desktop.automation.sync"
      ],
      getCurrentUser: () => this.currentUser(),
      getDeviceId: () => getDesktopDeviceId(this.options.app),
      onSnapshot: (snapshot) => this.applySnapshot(snapshot),
      onDispatchIssue: (issue, revision) => this.applyDispatch(issue, revision),
      onListAgents: () => this.options.assistantBridge.listAgents(),
      onStartRun: (request) => this.options.assistantBridge.startRun(request),
      onAutomationSync: (payload) => this.syncRemoteAutomationPayload(payload),
      onStateChanged: (state) => {
        this.connectionState = state;
        this.notifyChanged();
      },
      onDebug: this.options.onDebug
    });
  }

  start() {
    this.refreshConnection();
  }

  stop() {
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

  saveCloudConfig(input: TaskBoardCloudConfig): TaskBoardCloudConfigResult {
    const config = writeTaskBoardCloudConfig(this.options.app, input);
    this.refreshConnection();
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
      return createPrivateDesktopKanbanIssue(this.options.app, currentUser, input);
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
      return updateDesktopKanbanIssue(this.options.app, currentUser, issue.id, input);
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
    return {
      id: `device:${deviceId}`,
      name: "Desktop User",
      email: "",
      source: "device"
    };
  }

  private refreshConnection() {
    this.wsClient.start(readTaskBoardWsConfig(this.options.app));
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
