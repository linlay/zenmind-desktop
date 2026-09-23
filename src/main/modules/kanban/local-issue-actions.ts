import type { App } from "electron";
import type {
  KanbanCurrentUser,
  KanbanDeleteResult,
  KanbanIssue,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueResult,
  KanbanIssueUpdateInput
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { issueSyncMode } from "./cloud-event-model";
import {
  createLocalDesktopKanbanIssue,
  deleteDesktopKanbanIssue,
  getDesktopKanbanIssue,
  listDesktopKanbanIssues,
  moveDesktopKanbanIssue,
  updateDesktopKanbanIssue
} from "./local-store";
import { AgentPlatformCaller, KanbanRuntimeOptions } from "./runtime-options";
import {
  type KanbanDesktopConnectionState
} from "./ws-client";

export interface LocalIssueActionsDependencies {
  refreshConnection(options?: { forceReconnect?: boolean }): void;
  currentUser(): KanbanCurrentUser;
  readonly options: Pick<KanbanRuntimeOptions, "app" | "callAgentPlatform">;
  cloudIssueReadOnlyResult(): KanbanIssueResult;
  readonly connectionState: KanbanDesktopConnectionState;
  cloudIssueReadOnlyDeleteResult(issues: KanbanIssue[]): { ok: false; message: string; issues: KanbanIssue[]; };
}

export async function createIssue(dependencies: LocalIssueActionsDependencies, input: KanbanIssueInput): Promise<KanbanIssueResult> {
  dependencies.refreshConnection();
  const currentUser = dependencies.currentUser();
  if (input.syncToCloud !== true) {
    return createLocalDesktopKanbanIssue(dependencies.options.app, currentUser, {
      ...input, status: input.status === "in_progress" ? "todo" : input.status
    });
  }
  return dependencies.cloudIssueReadOnlyResult();
}

export async function updateIssue(dependencies: LocalIssueActionsDependencies, issueId: string, input: KanbanIssueUpdateInput): Promise<KanbanIssueResult> {
  dependencies.refreshConnection();
  const currentUser = dependencies.currentUser();
  const issue = getDesktopKanbanIssue(dependencies.options.app, currentUser, issueId);
  if (!issue) {
    return {
      ok: false,
      message: t("kanban.runtime.missing"),
      issues: listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues
    };
  }
  if (issueSyncMode(issue) === "local") {
    if (input.syncToCloud === true) {
      return dependencies.cloudIssueReadOnlyResult();
    }
    return updateDesktopKanbanIssue(dependencies.options.app, currentUser, issue.id, {
      ...input,
      ...(input.status === "in_progress" && !issue.runId && !input.runId ? { status: "todo" as const } : {}),
      ...(input.status === "todo" && !issue.runId && input.runState === undefined ? { runState: null } : {})
    });
  }
  return dependencies.cloudIssueReadOnlyResult();
}

export async function moveIssue(dependencies: LocalIssueActionsDependencies, input: KanbanIssueMoveInput): Promise<KanbanIssueResult> {
  dependencies.refreshConnection();
  const currentUser = dependencies.currentUser();
  const issue = getDesktopKanbanIssue(dependencies.options.app, currentUser, input.id);
  if (!issue) {
    return {
      ok: false,
      message: t("kanban.runtime.missing"),
      issues: listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues
    };
  }
  if (issueSyncMode(issue) === "local") {
    return moveDesktopKanbanIssue(dependencies.options.app, currentUser, {
      ...input, status: input.status === "in_progress" && !issue.runId ? "todo" : input.status
    });
  }
  return dependencies.cloudIssueReadOnlyResult();
}

export async function deleteIssueWithAutomation(dependencies: LocalIssueActionsDependencies, issueId: string, callAgentPlatform: AgentPlatformCaller<App> = dependencies.options.callAgentPlatform): Promise<KanbanDeleteResult | { ok: false; message: string; issues: KanbanIssue[] }> {
  dependencies.refreshConnection();
  const currentUser = dependencies.currentUser();
  const issue = getDesktopKanbanIssue(dependencies.options.app, currentUser, issueId);
  const currentIssues = listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues;
  if (!issue) {
    return { ok: false, message: t("kanban.runtime.missing"), issues: currentIssues };
  }
  if (issueSyncMode(issue) === "cloud") {
    return dependencies.cloudIssueReadOnlyDeleteResult(currentIssues);
  }
  if (issue.automationId) {
    try {
      await callAgentPlatform(dependencies.options.app, "/api/automation/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    }
    catch (error) {
      return {
        ok: false,
        message: t("kanban.automation.deleteFailed", { message: error instanceof Error ? error.message : String(error) }),
        issues: currentIssues
      };
    }
  }
  if (issueSyncMode(issue) === "local") {
    return deleteDesktopKanbanIssue(dependencies.options.app, currentUser, issue.id);
  }
  return deleteDesktopKanbanIssue(dependencies.options.app, currentUser, issue.id);
}
