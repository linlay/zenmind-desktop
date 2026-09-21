import type { AppPathProvider } from "./store-model";
import type {
  KanbanCurrentUser,
  KanbanListResult,
  KanbanIssueInput,
  KanbanIssueResult,
  KanbanIssueUpdateInput,
  KanbanIssue,
  KanbanIssueMoveInput,
  KanbanStatus,
  KanbanDeleteResult
} from "../../../shared/contracts";
import { withDesktopKanbanDatabase, getDesktopKanbanDatabasePath } from "./store-database";
import { t } from "../../support/i18n/main-i18n";
import { selectIssues, selectProjects, selectProjectBindings } from "./store-queries";
import { readLocalWorkflows, initializeLocalWorkflow, moveLocalWorkflow } from "./local-workflows";
import { BOARD_ID, PROJECT_ID, normalizeDueDate, nowIso, trimText } from "./store-values";
import { selectCloudDetailData } from "./store-cloud-details";
import { readDesktopKanbanRevision, writeDesktopKanbanSyncCursorInDb } from "./store-sync-cursor";
import { buildLocalIssue, applyIssueUpdate } from "./store-local-issue-model";
import { insertOrReplaceIssue } from "./store-issue-writes";
import { applyLocalWorkflowAction } from "./local-workflow-actions";
import type { LocalRunDetails } from "./store-local-issue-model";

export function listDesktopKanbanIssues(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  connectionState: KanbanListResult["connectionState"] = "disabled"
): KanbanListResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => ({
    ok: true,
    message: connectionState === "open" ? t("kanban.runtime.synced") : t("kanban.runtime.loadedFromCache"),
    issues: selectIssues(db, currentUser),
    localWorkflows: readLocalWorkflows(db, BOARD_ID),
    projects: selectProjects(db),
    projectBindings: selectProjectBindings(db),
    cloudDetails: selectCloudDetailData(db, currentUser),
    storagePath: getDesktopKanbanDatabasePath(app),
    boardId: BOARD_ID,
    projectId: PROJECT_ID,
    revision: readDesktopKanbanRevision(db),
    currentUser,
    connectionState
  }));
}

export function createLocalDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  input: KanbanIssueInput
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    if (input.dueDate !== undefined && normalizeDueDate(input.dueDate) === undefined) {
      return { ok: false, message: t("kanban.runtime.invalidDueDate"), issues: selectIssues(db, currentUser) };
    }
    const issue = buildLocalIssue(db, input, currentUser);
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.titleRequired"), issues: selectIssues(db, currentUser) };
    }
    if (input.localWorkflowId) {
      const workflow = readLocalWorkflows(db, BOARD_ID).find((item) => item.id === input.localWorkflowId);
      if (!workflow) return { ok: false, message: t("kanban.localWorkflow.missing"), issues: selectIssues(db, currentUser) };
      initializeLocalWorkflow(issue, workflow);
    }
    issue.localIssueId = issue.id;
    insertOrReplaceIssue(db, issue, {
      syncMode: "local",
      syncState: "local",
      origin: "desktop",
      ownerUserId: currentUser.id
    });
    return {
      ok: true,
      message: t("kanban.runtime.localCreated"),
      issue,
      issues: selectIssues(db, currentUser)
    };
  });
}

export function updateDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string,
  input: KanbanIssueUpdateInput
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.missing"), issues: selectIssues(db, currentUser) };
    }
    if (issue.syncMode === "cloud") {
      return { ok: false, message: t("kanban.runtime.cloudReadOnly"), issues: selectIssues(db, currentUser) };
    }
    if (input.dueDate !== undefined && normalizeDueDate(input.dueDate) === undefined) {
      return { ok: false, message: t("kanban.runtime.invalidDueDate"), issues: selectIssues(db, currentUser) };
    }
    let nextIssue: KanbanIssue | null;
    try {
      if (input.localWorkflowAction !== undefined && Object.keys(input).some((key) => key !== "localWorkflowAction")) {
        throw new Error(t("kanban.localWorkflow.invalidAction"));
      }
      nextIssue = input.localWorkflowAction !== undefined
        ? applyLocalWorkflowAction(issue, input.localWorkflowAction, currentUser,
          input.localWorkflowAction?.type === "refresh_rollback_rules" ? readLocalWorkflows(db, BOARD_ID) : [])
        : applyIssueUpdate(issue, input);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : t("kanban.localWorkflow.invalidAction"), issues: selectIssues(db, currentUser) };
    }
    if (!nextIssue) {
      return { ok: false, message: t("kanban.runtime.titleRequired"), issues: selectIssues(db, currentUser) };
    }
    insertOrReplaceIssue(db, nextIssue, {
      syncMode: nextIssue.syncMode ?? "local",
      syncState: nextIssue.syncMode === "cloud" ? "synced" : "local",
      origin: nextIssue.origin ?? "desktop",
      ownerUserId: nextIssue.ownerUserId ?? currentUser.id,
      lastRemoteRevision: nextIssue.lastRemoteRevision,
      lastSyncedAt: nextIssue.lastSyncedAt,
      syncError: null
    });
    return { ok: true, message: t("kanban.runtime.updated"), issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

export function updateDesktopKanbanIssueByPredicate(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  predicate: (issue: KanbanIssue) => boolean,
  input: KanbanIssueUpdateInput,
  missingMessage: string,
  runDetails: LocalRunDetails = {}
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issues = selectIssues(db, currentUser);
    const issue = issues.find(predicate);
    if (!issue) {
      return { ok: false, message: missingMessage, issues };
    }
    const runtimeInput = issue.localWorkflow && input.status === "completed"
      && issue.localWorkflow.stages.find((stage) => stage.id === issue.stageId)?.reviewRequired
      ? { ...input, status: "in_review" as const } : input;
    const nextIssue = applyIssueUpdate(issue, runtimeInput);
    if (!nextIssue) {
      return { ok: false, message: t("kanban.runtime.titleRequired"), issues };
    }
    if (nextIssue.syncMode !== "cloud") Object.assign(nextIssue, runDetails);
    insertOrReplaceIssue(db, nextIssue, {
      syncMode: nextIssue.syncMode ?? "local",
      syncState: nextIssue.syncMode === "cloud" ? "synced" : "local",
      origin: nextIssue.origin ?? "desktop",
      ownerUserId: nextIssue.ownerUserId ?? currentUser.id,
      lastRemoteRevision: nextIssue.lastRemoteRevision,
      lastSyncedAt: nextIssue.lastSyncedAt,
      syncError: null
    });
    return { ok: true, message: t("kanban.runtime.updated"), issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

export function updateDesktopKanbanIssueRuntimeState(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string,
  input: Pick<KanbanIssueUpdateInput, "status" | "chatId" | "runId" | "runState">,
  runDetails: LocalRunDetails = {}
): KanbanIssueResult {
  return updateDesktopKanbanIssueByPredicate(
    app,
    currentUser,
    (issue) => issue.id === issueId,
    input,
    t("kanban.runtime.missing"),
    runDetails
  );
}

export function moveDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  input: KanbanIssueMoveInput
): KanbanIssueResult {
  return setDesktopKanbanIssuePosition(app, currentUser, input.id, input.status, input.position);
}

export function setDesktopKanbanIssuePosition(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string,
  status: KanbanStatus,
  position: number
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.missing"), issues: selectIssues(db, currentUser) };
    }
    if (issue.syncMode === "cloud") {
      return { ok: false, message: t("kanban.runtime.cloudReadOnly"), issues: selectIssues(db, currentUser) };
    }
    const nextIssue = {
      ...moveLocalWorkflow(issue, status),
      position,
      runState: status === issue.status ? issue.runState : null,
      updatedAt: nowIso()
    };
    insertOrReplaceIssue(db, nextIssue, {
      syncMode: nextIssue.syncMode ?? "local",
      syncState: nextIssue.syncMode === "cloud" ? "synced" : "local",
      origin: nextIssue.origin ?? "desktop",
      ownerUserId: nextIssue.ownerUserId ?? currentUser.id,
      lastRemoteRevision: nextIssue.lastRemoteRevision,
      lastSyncedAt: nextIssue.lastSyncedAt,
      syncError: null
    });
    return { ok: true, message: t("kanban.runtime.moved"), issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

export function deleteDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string
): KanbanDeleteResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.missing"), issues: selectIssues(db, currentUser) };
    }
    if (issue.syncMode === "cloud") {
      return { ok: false, message: t("kanban.runtime.cloudReadOnly"), issues: selectIssues(db, currentUser) };
    }
    db.prepare("UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ?").run(nowIso(), nowIso(), issueId);
    return {
      ok: true,
      message: t("kanban.runtime.deleted"),
      deletedIssueId: issueId,
      issues: selectIssues(db, currentUser)
    };
  });
}

export function tombstoneDesktopKanbanCloudIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  remoteIssueId: string,
  revision = 0
): KanbanDeleteResult {
  const normalizedRemoteIssueId = trimText(remoteIssueId);
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const row = db.prepare(`
      SELECT LOCAL_ISSUE_ID_ AS localIssueId
      FROM desktop_issue_sync
      WHERE REMOTE_ISSUE_ID_ = ?
    `).get(normalizedRemoteIssueId) as { localIssueId?: string } | undefined;
    const localIssueId = row?.localIssueId ?? "";
    const timestamp = nowIso();
    if (localIssueId) {
      db.prepare("UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ?").run(timestamp, timestamp, localIssueId);
      db.prepare(`
        UPDATE desktop_issue_sync
        SET SYNC_STATE_ = 'synced',
          LAST_REMOTE_REVISION_ = MAX(LAST_REMOTE_REVISION_, ?),
          LAST_SYNCED_AT_ = ?,
          SYNC_ERROR_ = NULL
        WHERE LOCAL_ISSUE_ID_ = ?
      `).run(Math.max(0, Math.floor(revision)), timestamp, localIssueId);
    }
    writeDesktopKanbanSyncCursorInDb(db, { lastAppliedRevision: Math.max(readDesktopKanbanRevision(db), revision) });
    return {
      ok: true,
      message: t("kanban.runtime.deleted"),
      deletedIssueId: localIssueId || normalizedRemoteIssueId,
      issues: selectIssues(db, currentUser)
    };
  });
}

export function getDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) =>
    selectIssues(db, currentUser).find((candidate) => candidate.id === issueId) ?? null
  );
}
