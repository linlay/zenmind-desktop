import type {
  KanbanCurrentUser,
  KanbanIssue,
  KanbanIssueResult,
  KanbanListResult
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { getDesktopDeviceId } from "../identity";
import { getRemoteIssueId, issueSyncMode } from "./cloud-event-model";
import {
  deleteDesktopKanbanCloudMutation,
  getDesktopKanbanIssue,
  listDesktopKanbanCloudMutations,
  listDesktopKanbanIssues,
  markDesktopKanbanCloudMutationAttempt,
  recordDesktopKanbanCloudMutation,
  upsertDispatchedDesktopKanbanIssue
} from "./local-store";
import { readText } from "./protocol-values";
import { stableClientEventId } from "./run-policy";
import { DEFAULT_SELECTED_PROJECT_ID } from "./runtime-config";
import { KanbanRuntimeOptions } from "./runtime-options";
import {
  KanbanDesktopRequestError,
  KanbanDesktopWsClient,
  type KanbanDesktopConnectionState
} from "./ws-client";

export interface CloudIssueActionsDependencies {
  refreshConnection(options?: { forceReconnect?: boolean }): void;
  currentUser(): KanbanCurrentUser;
  readonly options: Pick<KanbanRuntimeOptions, "app">;
  readonly connectionState: KanbanDesktopConnectionState;
  readonly negotiatedContractVersion: string;
  readonly negotiatedCapabilities: string[];
  readonly wsClient: Pick<KanbanDesktopWsClient, "isOpen" | "request" | "requestWithId">;
  sendCloudMutation(item: ReturnType<typeof listDesktopKanbanCloudMutations>[number]): Promise<{ ok: boolean; message: string; issue?: KanbanIssue; }>;
  resyncCloudBoard(): Promise<KanbanListResult>;
  notifyChanged(): void;
  cloudMutationProcessing: boolean;
}

export async function claimIssue(dependencies: CloudIssueActionsDependencies, issueId: string): Promise<KanbanIssueResult> {
  dependencies.refreshConnection();
  const currentUser = dependencies.currentUser();
  const issue = getDesktopKanbanIssue(dependencies.options.app, currentUser, issueId);
  const issues = listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues;
  if (!issue || issueSyncMode(issue) !== "cloud") {
    return { ok: false, message: t("kanban.runtime.missing"), issues };
  }
  if (!dependencies.negotiatedContractVersion.startsWith("1.") || !dependencies.negotiatedCapabilities.includes("issue.claim")) {
    return { ok: false, message: t("kanban.cloud.claimUnsupported"), issues };
  }
  if (!dependencies.wsClient.isOpen()) {
    return { ok: false, message: t("kanban.cloudSync.notConnected"), issues };
  }
  const remoteIssueId = getRemoteIssueId(issue);
  const projectId = readText(issue.projectId) || DEFAULT_SELECTED_PROJECT_ID;
  const requestId = stableClientEventId(getDesktopDeviceId(dependencies.options.app), ["claim", remoteIssueId, issue.revision ?? issue.lastRemoteRevision ?? 0]);
  const payload = { id: remoteIssueId, baseIssueRevision: issue.revision ?? issue.lastRemoteRevision ?? 0 };
  recordDesktopKanbanCloudMutation(dependencies.options.app, currentUser, {
    id: requestId,
    requestType: "issue.claim",
    projectId,
    issueId: remoteIssueId,
    payload
  });
  const result = await dependencies.sendCloudMutation({ id: requestId, requestType: "issue.claim", projectId, issueId: remoteIssueId, payload, attemptCount: 0, lastError: null });
  return {
    ok: result.ok,
    message: result.message,
    issue: result.issue,
    issues: listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues
  };
}

export async function bindHumanReferenceChat(dependencies: CloudIssueActionsDependencies, input: { issueId: string; stageId: string; statusId: string; chatId: string }) {
  dependencies.refreshConnection();
  if (!dependencies.wsClient.isOpen() || !dependencies.negotiatedContractVersion.startsWith("1.")) {
    return { ok: false, message: t("kanban.cloudSync.notConnected") };
  }
  try {
    const result = await dependencies.wsClient.request<{
      ok: boolean;
      message?: string;
    }>("issue.chat.bind", input);
    if (result.ok)
      await dependencies.resyncCloudBoard();
    return result;
  }
  catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function unbindHumanReferenceChat(dependencies: CloudIssueActionsDependencies, issueChatId: string) {
  dependencies.refreshConnection();
  if (!dependencies.wsClient.isOpen() || !dependencies.negotiatedContractVersion.startsWith("1.")) {
    return { ok: false, message: t("kanban.cloudSync.notConnected") };
  }
  try {
    const result = await dependencies.wsClient.request<{
      ok: boolean;
      message?: string;
    }>("issue.chat.unbind", { issueChatId });
    if (result.ok)
      await dependencies.resyncCloudBoard();
    return result;
  }
  catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendCloudMutation(dependencies: CloudIssueActionsDependencies, item: ReturnType<typeof listDesktopKanbanCloudMutations>[number]): Promise<{ ok: boolean; message: string; issue?: KanbanIssue }> {
  const currentUser = dependencies.currentUser();
  try {
    const result = await dependencies.wsClient.requestWithId<{
      ok?: boolean;
      message?: string;
      issue?: unknown;
      revision?: number;
    }>(item.requestType, item.payload, item.id, undefined, item.projectId);
    if (result.ok === false) {
      deleteDesktopKanbanCloudMutation(dependencies.options.app, currentUser, item.id);
      return { ok: false, message: readText(result.message) || t("kanban.ws.operationFailed", { type: item.requestType }) };
    }
    let issue: KanbanIssue | undefined;
    if (result.issue) {
      const applied = upsertDispatchedDesktopKanbanIssue(dependencies.options.app, currentUser, result.issue, Number(result.revision) || 0, "cloud_dispatch");
      issue = applied.issue;
    }
    deleteDesktopKanbanCloudMutation(dependencies.options.app, currentUser, item.id);
    dependencies.notifyChanged();
    return { ok: true, message: readText(result.message) || t("kanban.claim.succeeded"), issue };
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof KanbanDesktopRequestError) {
      deleteDesktopKanbanCloudMutation(dependencies.options.app, currentUser, item.id);
    }
    else {
      markDesktopKanbanCloudMutationAttempt(dependencies.options.app, currentUser, item.id, message);
    }
    return { ok: false, message };
  }
}

export async function flushCloudMutationOutbox(dependencies: CloudIssueActionsDependencies) {
  if (dependencies.cloudMutationProcessing || !dependencies.wsClient.isOpen())
    return;
  dependencies.cloudMutationProcessing = true;
  try {
    for (const item of listDesktopKanbanCloudMutations(dependencies.options.app, dependencies.currentUser())) {
      const result = await dependencies.sendCloudMutation(item);
      if (!result.ok && !dependencies.wsClient.isOpen())
        break;
    }
  }
  finally {
    dependencies.cloudMutationProcessing = false;
  }
}

export function cloudIssueReadOnlyResult(dependencies: CloudIssueActionsDependencies): KanbanIssueResult {
  return {
    ok: false,
    message: t("kanban.runtime.cloudReadOnly"),
    issues: listDesktopKanbanIssues(dependencies.options.app, dependencies.currentUser(), dependencies.connectionState).issues
  };
}

export function cloudIssueReadOnlyDeleteResult(dependencies: CloudIssueActionsDependencies, issues: KanbanIssue[]): { ok: false; message: string; issues: KanbanIssue[] } {
  return {
    ok: false,
    message: t("kanban.runtime.cloudReadOnly"),
    issues
  };
}
