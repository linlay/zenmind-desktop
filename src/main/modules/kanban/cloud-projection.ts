import type {
  KanbanCurrentUser,
  KanbanIssueResult,
  KanbanListResult
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { issueEventIssueId, issueEventIssuePayload } from "./cloud-event-model";
import {
  applyDesktopKanbanCloudSnapshot,
  hasDesktopKanbanCloudProject,
  listDesktopKanbanIssues,
  readDesktopKanbanSyncCursor,
  tombstoneDesktopKanbanCloudIssue,
  upsertDispatchedDesktopKanbanIssue,
  writeDesktopKanbanSyncCursor,
  type KanbanCloudSnapshot
} from "./local-store";
import { KanbanRuntimeOptions } from "./runtime-options";
import {
  KanbanDesktopWsClient,
  type KanbanDesktopConnectionState,
  type KanbanDesktopIssueEvent,
  type KanbanDesktopIssueEventApplyResult
} from "./ws-client";

export interface CloudProjectionDependencies {
  refreshConnection(options?: { forceReconnect?: boolean }): void;
  readonly options: Pick<KanbanRuntimeOptions, "app" | "onChanged">;
  currentUser(): KanbanCurrentUser;
  readonly connectionState: KanbanDesktopConnectionState;
  readonly negotiatedContractVersion: string;
  readonly negotiatedCapabilities: string[];
  readonly wsClient: Pick<KanbanDesktopWsClient, "isOpen" | "resyncFromCloud">;
  notifyChanged(): void;
}

export function listIssues(dependencies: CloudProjectionDependencies): KanbanListResult {
  dependencies.refreshConnection();
  return {
    ...listDesktopKanbanIssues(dependencies.options.app, dependencies.currentUser(), dependencies.connectionState),
    cloudCapabilities: dependencies.negotiatedContractVersion.startsWith("1.")
      ? [
        ...(dependencies.negotiatedCapabilities.includes("issue.claim") ? ["issue.claim"] : []),
        ...(dependencies.negotiatedCapabilities.includes("run.event.append") ? ["run.event.append"] : []),
        ...(dependencies.negotiatedCapabilities.includes("issue.chat.bind") ? ["issue.chat.bind"] : [])
      ]
      : []
  };
}

export async function resyncCloudBoard(dependencies: CloudProjectionDependencies): Promise<KanbanListResult> {
  dependencies.refreshConnection();
  const currentUser = dependencies.currentUser();
  if (!dependencies.wsClient.isOpen()) {
    return {
      ...listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState),
      ok: false,
      message: t("kanban.cloudSync.notConnected")
    };
  }
  try {
    await dependencies.wsClient.resyncFromCloud();
    return listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState);
  }
  catch (error) {
    return {
      ...listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState),
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function applySnapshot(dependencies: CloudProjectionDependencies, snapshot: KanbanCloudSnapshot) {
  applyDesktopKanbanCloudSnapshot(dependencies.options.app, dependencies.currentUser(), snapshot);
  dependencies.notifyChanged();
}

export function applyDispatch(dependencies: CloudProjectionDependencies, issue: unknown, revision: number): KanbanIssueResult {
  const result = upsertDispatchedDesktopKanbanIssue(dependencies.options.app, dependencies.currentUser(), issue, revision, "cloud_dispatch");
  dependencies.notifyChanged();
  return result;
}

export async function applyIssueEvent(dependencies: CloudProjectionDependencies, event: KanbanDesktopIssueEvent): Promise<KanbanDesktopIssueEventApplyResult> {
  const currentUser = dependencies.currentUser();
  const cursor = readDesktopKanbanSyncCursor(dependencies.options.app, currentUser);
  const seq = Math.max(0, Math.floor(event.seq));
  if (seq <= 0) {
    return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: event.eventType || "unknown" }) };
  }
  if (seq <= cursor.lastAppliedRevision) {
    return { ok: true, lastAppliedRevision: cursor.lastAppliedRevision };
  }
  const issuePayload = issueEventIssuePayload(event);
  const scopedTombstone = !issuePayload && Boolean(event.deletedIssueId || event.issueId);
  if (event.eventType === "issue.deleted" || scopedTombstone || (event.toProjectId && !hasDesktopKanbanCloudProject(dependencies.options.app, currentUser, event.toProjectId))) {
    tombstoneDesktopKanbanCloudIssue(dependencies.options.app, currentUser, issueEventIssueId(event), seq);
  }
  else {
    const issue = issuePayload;
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.dispatchInvalid") };
    }
    const result = upsertDispatchedDesktopKanbanIssue(dependencies.options.app, currentUser, issue, seq, "cloud_dispatch");
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
  }
  writeDesktopKanbanSyncCursor(dependencies.options.app, currentUser, { lastAppliedRevision: seq });
  dependencies.notifyChanged();
  return {
    ok: true,
    lastAppliedRevision: Math.max(cursor.lastAppliedRevision, seq)
  };
}

export function notifyChanged(dependencies: CloudProjectionDependencies) {
  dependencies.options.onChanged?.();
}
