import type {
  TaskBoardCurrentUser,
  TaskBoardIssue,
  TaskBoardIssueSyncRequest,
  TaskBoardIssueSyncResult,
  TaskBoardIssueSyncUpsert,
  TaskBoardProjectBinding
} from "../shared/contracts";
import {
  applyDesktopIssueSyncResults,
  listPendingUpstreamIssues
} from "./task-board-local-projects";
import { listDesktopKanbanIssues } from "./task-board-local-store";
import { t } from "./i18n/main-i18n";

type AppPathProvider = {
  getPath: (name: "userData") => string;
};

type WsRequester = {
  isOpen: () => boolean;
  request: <T = unknown>(messageType: string, payload: unknown) => Promise<T>;
};

export type DesktopCloudSyncOptions = {
  app: AppPathProvider;
  getCurrentUser: () => TaskBoardCurrentUser;
  getDeviceId: () => string;
  wsClient: WsRequester;
  onChanged?: () => void;
  onDebug?: (message: string) => void;
};

export type DesktopCloudSyncRunResult = {
  ok: boolean;
  message: string;
  attempted: number;
  synced: number;
  conflicts: number;
  errors: number;
};

const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 120_000;

function trimText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toSyncIssueInput(issue: TaskBoardIssue, cloudProjectId: string): Record<string, unknown> {
  const input: Record<string, unknown> = {
    title: issue.title,
    projectId: cloudProjectId,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    severity: issue.severity,
    assigneeAgentKey: issue.assigneeAgentKey,
    assigneeId: issue.assigneeId,
    workerType: issue.workerType,
    workerId: issue.workerId,
    workerAgent: issue.workerAgent,
    reviewerId: issue.reviewerId,
    reviewRequired: issue.reviewRequired,
    automationId: issue.automationId,
    automationEnabled: issue.automationEnabled,
    automationCron: issue.automationCron,
    automationMessage: issue.automationMessage,
    automationTimezone: issue.automationTimezone,
    attachmentChatId: issue.attachmentChatId,
    attachments: issue.attachments
  };
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) {
      delete input[key];
    }
  }
  return input;
}

// 上行同步引擎:把本地新建/失败重试的 issue 批量推送到云端(desktop.issue.sync)。
// 防回环:快照应用路径写 syncState='synced',这里只收集 'local'/'error'。
export class DesktopCloudSyncEngine {
  private running = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = RETRY_BASE_DELAY_MS;

  constructor(private readonly options: DesktopCloudSyncOptions) {}

  stop() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // 列出参与上行的活动绑定(本设备 + controlMode≠disabled + status=active)。
  private activeBindings(): TaskBoardProjectBinding[] {
    const deviceId = trimText(this.options.getDeviceId());
    const result = listDesktopKanbanIssues(this.options.app, this.options.getCurrentUser());
    return (result.projectBindings ?? []).filter((binding) =>
      binding.deviceId === deviceId &&
      binding.controlMode !== "disabled" &&
      binding.status === "active"
    );
  }

  // 触发一轮上行同步;并发调用时只保留一轮。
  async run(): Promise<DesktopCloudSyncRunResult> {
    if (this.running) {
      return { ok: true, message: t("taskBoard.cloudSync.running"), attempted: 0, synced: 0, conflicts: 0, errors: 0 };
    }
    if (!this.options.wsClient.isOpen()) {
      return { ok: false, message: t("taskBoard.cloudSync.notConnected"), attempted: 0, synced: 0, conflicts: 0, errors: 0 };
    }
    this.running = true;
    try {
      return await this.runOnce();
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<DesktopCloudSyncRunResult> {
    const currentUser = this.options.getCurrentUser();
    const bindings = this.activeBindings();
    if (bindings.length === 0) {
      return { ok: true, message: t("taskBoard.cloudSync.noBindings"), attempted: 0, synced: 0, conflicts: 0, errors: 0 };
    }
    let attempted = 0;
    let synced = 0;
    let conflicts = 0;
    let errors = 0;
    let hadFailure = false;
    for (const binding of bindings) {
      const pending = listPendingUpstreamIssues(this.options.app, currentUser, [binding.localProjectId]);
      if (pending.length === 0) {
        continue;
      }
      attempted += pending.length;
      const upserts: TaskBoardIssueSyncUpsert[] = pending.map((issue) => ({
        localIssueId: issue.id,
        remoteIssueId: issue.remoteIssueId ?? null,
        baseIssueRevision: issue.remoteIssueId ? issue.lastRemoteRevision ?? 0 : 0,
        input: toSyncIssueInput(issue, binding.projectId)
      }));
      const request: TaskBoardIssueSyncRequest = {
        deviceId: trimText(this.options.getDeviceId()),
        projectId: binding.projectId,
        localProjectId: binding.localProjectId,
        baseRevision: binding.lastRemoteRevision,
        upserts
      };
      try {
        const result = await this.options.wsClient.request<TaskBoardIssueSyncResult>("desktop.issue.sync", request);
        const applied = applyDesktopIssueSyncResults(
          this.options.app,
          currentUser,
          result.results ?? [],
          result.revision ?? 0
        );
        synced += applied.synced;
        conflicts += applied.conflicts;
        errors += applied.errors;
        this.options.onDebug?.(
          t("taskBoard.cloudSync.debugComplete", {
            bindingId: binding.id,
            count: upserts.length,
            synced: applied.synced,
            conflicts: applied.conflicts,
            errors: applied.errors
          })
        );
      } catch (error) {
        hadFailure = true;
        errors += pending.length;
        this.options.onDebug?.(
          t("taskBoard.cloudSync.debugFailed", {
            bindingId: binding.id,
            message: error instanceof Error ? error.message : String(error)
          })
        );
      }
    }
    if (synced > 0 || conflicts > 0) {
      this.options.onChanged?.();
    }
    if (hadFailure) {
      this.scheduleRetry();
    } else {
      this.retryDelayMs = RETRY_BASE_DELAY_MS;
    }
    return {
      ok: !hadFailure,
      message: attempted === 0
        ? t("taskBoard.cloudSync.noPending")
        : t("taskBoard.cloudSync.complete", { synced, conflicts, errors }),
      attempted,
      synced,
      conflicts,
      errors
    };
  }

  // 指数退避重试;离线时 pending 留在 syncState='local',由重连对账兜底。
  private scheduleRetry() {
    if (this.retryTimer) {
      return;
    }
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_DELAY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.run();
    }, delay);
  }
}

export const __testInternals = {
  toSyncIssueInput
};
