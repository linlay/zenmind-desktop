import type { KanbanCurrentUser, KanbanIssue, KanbanOrigin, KanbanListResult, KanbanIssueResult } from "../../../shared/contracts";
import {
  trimText,
  nowIso,
  normalizeDueDate,
  BOARD_ID,
  PROJECT_ID,
  nullableTrimmedText,
  normalizeStringList,
  normalizeEffortSeconds,
  normalizeKanbanStatus,
  normalizeKanbanPriority,
  normalizeKanbanSeverity,
  normalizeAttachments,
  normalizeCustomFields,
  parseCloudIssue,
  createCloudCacheIssueId
} from "./store-values";
import { DatabaseSync } from "node:sqlite";
import type { AppPathProvider, KanbanCloudSnapshot } from "./store-model";
import { withDesktopKanbanDatabase, getDesktopKanbanDatabasePath } from "./store-database";
import { readDesktopKanbanRevision, writeDesktopKanbanRevision, writeDesktopKanbanSyncCursorInDb } from "./store-sync-cursor";
import { parseCloudProject, parseCloudProjectBinding } from "./store-row-codec";
import { insertOrReplaceProject, insertOrReplaceProjectBinding } from "./store-project-writes";
import { insertOrReplaceIssue } from "./store-issue-writes";
import { storeCloudDetailData, selectCloudDetailData } from "./store-cloud-details";
import { t } from "../../support/i18n/main-i18n";
import { selectIssues, selectProjects, selectProjectBindings } from "./store-queries";
import { readLocalWorkflows } from "./local-workflows";
import { listDesktopKanbanIssues } from "./store-issues";

export function cloudIssueToLocalIssue(rawIssue: Record<string, unknown>, currentUser: KanbanCurrentUser, revision: number): KanbanIssue | null {
  const remoteIssueId = trimText(rawIssue.id);
  const title = trimText(rawIssue.title);
  if (!remoteIssueId || !title) return null;
  const timestamp = trimText(rawIssue.updatedAt) || nowIso();
  const issueRevision = typeof rawIssue.revision === "number" && Number.isFinite(rawIssue.revision)
    ? Math.max(0, Math.floor(rawIssue.revision))
    : Math.max(0, Math.floor(revision));
  const canonicalDueDate = normalizeDueDate(rawIssue.dueDate);
  return {
    id: "",
    localIssueId: "",
    remoteIssueId,
    boardId: trimText(rawIssue.boardId) || BOARD_ID,
    projectId: trimText(rawIssue.projectId) || PROJECT_ID,
    projectPath: trimText(rawIssue.projectPath) || undefined,
    projectName: trimText(rawIssue.projectName) || undefined,
    projectVersion: nullableTrimmedText(rawIssue.projectVersion),
    dueDate: canonicalDueDate ?? null,
    dueRisk: nullableTrimmedText(rawIssue.dueRisk),
    resolution: nullableTrimmedText(rawIssue.resolution),
    securityLevelKey: nullableTrimmedText(rawIssue.securityLevelKey),
    reporterId: nullableTrimmedText(rawIssue.reporterId),
    componentKeys: normalizeStringList(rawIssue.componentKeys),
    originalEstimate: normalizeEffortSeconds(rawIssue.originalEstimate),
    remainingEstimate: normalizeEffortSeconds(rawIssue.remainingEstimate),
    timeSpent: normalizeEffortSeconds(rawIssue.timeSpent),
    parentIssueId: nullableTrimmedText(rawIssue.parentIssueId),
    workflowId: trimText(rawIssue.workflowId) || undefined,
    typeId: trimText(rawIssue.issueTypeKey) || trimText(rawIssue.typeId) || undefined,
    issueTypeKey: trimText(rawIssue.issueTypeKey) || trimText(rawIssue.typeId) || undefined,
    stageId: trimText(rawIssue.stageId) || undefined,
    stageKey: trimText(rawIssue.stageKey) || undefined,
    stageName: trimText(rawIssue.stageName) || undefined,
    statusId: trimText(rawIssue.statusId) || undefined,
    statusName: trimText(rawIssue.statusName) || undefined,
    statusKey: trimText(rawIssue.statusKey) || undefined,
    columnKey: trimText(rawIssue.columnKey) || undefined,
    title,
    description: trimText(rawIssue.description),
    status: normalizeKanbanStatus(rawIssue.status),
    priority: normalizeKanbanPriority(rawIssue.priority),
    severity: normalizeKanbanSeverity(rawIssue.severity),
    assigneeAgentKey: nullableTrimmedText(rawIssue.assigneeAgentKey),
    assigneeId: nullableTrimmedText(rawIssue.assigneeId),
    // Contract 1.0 keeps cloud execution identity in issueStageWorkers and
    // execution state in issueChats/issueRuns. Never dual-read retired Issue scalars.
    workerType: null,
    workerId: null,
    workerAgent: null,
    activeReviewId: nullableTrimmedText(rawIssue.activeReviewId),
    activeIssueRunId: nullableTrimmedText(rawIssue.activeIssueRunId),
    activeRunId: nullableTrimmedText(rawIssue.activeIssueRunId),
    position: typeof rawIssue.position === "number" && Number.isFinite(rawIssue.position) ? rawIssue.position : 1,
    chatId: null,
    runId: null,
    runState: null,
    runAgentKey: null,
    runCommandId: null,
    runStartedAt: null,
    runFinishedAt: null,
    runResultMessage: null,
    runErrorMessage: null,
    dispatchState: null,
    dispatchDeviceId: null,
    dispatchCommandId: null,
    dispatchUpdatedAt: null,
    automationId: nullableTrimmedText(rawIssue.automationId),
    automationEnabled: rawIssue.automationEnabled === true,
    automationCron: nullableTrimmedText(rawIssue.automationCron),
    automationMessage: nullableTrimmedText(rawIssue.automationMessage),
    automationTimezone: nullableTrimmedText(rawIssue.automationTimezone),
    attachmentChatId: nullableTrimmedText(rawIssue.attachmentChatId),
    attachments: normalizeAttachments(rawIssue.attachments),
    customFields: normalizeCustomFields(rawIssue.customFields),
    createdBy: nullableTrimmedText(rawIssue.createdBy),
    updatedBy: nullableTrimmedText(rawIssue.updatedBy),
    createdByAgent: nullableTrimmedText(rawIssue.createdByAgent),
    updatedByAgent: nullableTrimmedText(rawIssue.updatedByAgent),
    syncMode: "cloud",
    syncState: "synced",
    origin: "cloud_dispatch",
    ownerUserId: currentUser.id,
    lastRemoteRevision: issueRevision,
    lastSyncedAt: nowIso(),
    syncError: null,
    revision: issueRevision,
    createdAt: trimText(rawIssue.createdAt) || timestamp,
    updatedAt: timestamp
  };
}

export function findLocalSyncForRemote(db: DatabaseSync, remoteIssueId: string) {
  const row = db.prepare(`
    SELECT LOCAL_ISSUE_ID_ AS localIssueId, ORIGIN_ AS origin FROM desktop_issue_sync
    WHERE REMOTE_ISSUE_ID_ = ?
  `).get(remoteIssueId) as { localIssueId?: string; origin?: KanbanOrigin } | undefined;
  return {
    localIssueId: row?.localIssueId ?? "",
    origin: row?.origin
  };
}

export function applyDesktopKanbanCloudSnapshot(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  snapshot: KanbanCloudSnapshot,
  origin: KanbanOrigin = "cloud_dispatch"
): KanbanListResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const currentRevision = readDesktopKanbanRevision(db);
    const snapshotLastSeq = typeof snapshot.lastSeq === "number" && Number.isFinite(snapshot.lastSeq)
      ? Math.max(0, Math.floor(snapshot.lastSeq))
      : undefined;
    const snapshotRevision = typeof snapshot.revision === "number" && Number.isFinite(snapshot.revision)
      ? Math.max(0, Math.floor(snapshot.revision))
      : undefined;
    const revision = snapshotLastSeq ?? snapshotRevision ?? currentRevision;
    const snapshotProjectId = trimText(snapshot.projectId);
    const snapshotProjectIds = new Set((snapshot.projectIds ?? []).map(trimText).filter(Boolean));
    const isProjectSet = snapshot.complete === true && snapshot.scope === "project_set";
    const canTombstoneMissing = snapshot.complete === true && ((snapshot.scope === "project" && Boolean(snapshotProjectId)) || isProjectSet);
    const remoteIds = new Set<string>();
    const remoteProjectIds = new Set<string>();
    const remoteBindingIds = new Set<string>();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const rawProject of snapshot.projects ?? []) {
        const project = parseCloudProject(rawProject);
        if (project) {
          remoteProjectIds.add(project.id);
          insertOrReplaceProject(db, project, "cloud");
        }
      }
      for (const rawBinding of snapshot.projectBindings ?? []) {
        const binding = parseCloudProjectBinding(rawBinding);
        if (binding) {
          remoteBindingIds.add(binding.id);
          insertOrReplaceProjectBinding(db, binding);
        }
      }
      for (const raw of snapshot.issues ?? []) {
        const cloudIssue = parseCloudIssue(raw);
        if (!cloudIssue) continue;
        const localIssue = cloudIssueToLocalIssue(cloudIssue, currentUser, revision);
        if (!localIssue?.remoteIssueId) continue;
        remoteIds.add(localIssue.remoteIssueId);
        const existingSync = findLocalSyncForRemote(db, localIssue.remoteIssueId);
        const existingLocalId = existingSync.localIssueId;
        localIssue.id = existingLocalId || createCloudCacheIssueId();
        localIssue.localIssueId = localIssue.id;
        insertOrReplaceIssue(db, localIssue, {
          syncMode: "cloud",
          syncState: "synced",
          origin: existingSync.origin ?? origin,
          ownerUserId: currentUser.id,
          lastRemoteRevision: localIssue.revision ?? revision,
          lastSyncedAt: nowIso(),
          syncError: null
        });
      }
      if (canTombstoneMissing) {
        const cloudRows = db.prepare(`
        SELECT sync.LOCAL_ISSUE_ID_ AS localIssueId, sync.REMOTE_ISSUE_ID_ AS remoteIssueId, sync.LAST_REMOTE_REVISION_ AS lastRemoteRevision, issue.PROJECT_ID_ AS projectId
        FROM desktop_issue_sync sync
        JOIN issue ON issue.ID_ = sync.LOCAL_ISSUE_ID_
        WHERE sync.SYNC_MODE_ = 'cloud'
      `).all() as Array<{ localIssueId: string; remoteIssueId: string | null; lastRemoteRevision: number; projectId: string }>;
        for (const row of cloudRows) {
          if (
            (isProjectSet ? snapshotProjectIds.has(row.projectId) : row.projectId === snapshotProjectId) &&
            row.remoteIssueId &&
            !remoteIds.has(row.remoteIssueId) &&
            row.lastRemoteRevision <= revision
          ) {
            db.prepare("UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ?").run(nowIso(), nowIso(), row.localIssueId);
          }
        }
      }
      if (isProjectSet) {
        const timestamp = nowIso();
        const cachedBindings = db.prepare(`SELECT ID_ AS id FROM project_desktop_binding WHERE DELETED_AT_ IS NULL`).all() as Array<{ id: string }>;
        const tombstoneBinding = db.prepare(`UPDATE project_desktop_binding SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ? AND DELETED_AT_ IS NULL`);
        for (const binding of cachedBindings) {
          if (!remoteBindingIds.has(binding.id)) tombstoneBinding.run(timestamp, timestamp, binding.id);
        }
        const cachedCloudProjects = db.prepare(`SELECT ID_ AS id FROM project WHERE SYNC_MODE_ = 'cloud' AND DELETED_AT_ IS NULL`).all() as Array<{ id: string }>;
        const removedProjectIds = cachedCloudProjects.map((row) => row.id).filter((id) => !remoteProjectIds.has(id));
        if (removedProjectIds.length > 0) {
          const localContainerId = "local-private-orphans";
          db.prepare(`
            INSERT INTO project (
              ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, PATH_, DEPTH_, POSITION_, REVISION_, SYNC_MODE_,
              VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
            ) VALUES (?, NULL, 'private-orphans', 'PRIVATE', 'Local Issues', '', 'private-orphans', 0, 999999, 0, 'local', 'private', ?, ?, ?, NULL)
            ON CONFLICT(ID_) DO UPDATE SET NAME_ = excluded.NAME_, SYNC_MODE_ = excluded.SYNC_MODE_, DELETED_AT_ = NULL, UPDATED_AT_ = excluded.UPDATED_AT_
          `).run(localContainerId, "", timestamp, timestamp);
          const updateLocalIssues = db.prepare(`
            UPDATE issue SET PROJECT_ID_ = ?, UPDATED_AT_ = ?
            WHERE PROJECT_ID_ = ? AND ID_ IN (SELECT LOCAL_ISSUE_ID_ FROM desktop_issue_sync WHERE SYNC_MODE_ = 'local')
          `);
          const tombstoneCloudIssues = db.prepare(`
            UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ?
            WHERE PROJECT_ID_ = ? AND ID_ IN (SELECT LOCAL_ISSUE_ID_ FROM desktop_issue_sync WHERE SYNC_MODE_ = 'cloud')
          `);
          const tombstoneProject = db.prepare("UPDATE project SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ? AND SYNC_MODE_ = 'cloud'");
          const removeBinding = db.prepare("UPDATE project_desktop_binding SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE PROJECT_ID_ = ? AND DELETED_AT_ IS NULL");
          for (const projectId of removedProjectIds) {
            updateLocalIssues.run(localContainerId, timestamp, projectId);
            tombstoneCloudIssues.run(timestamp, timestamp, projectId);
            tombstoneProject.run(timestamp, timestamp, projectId);
            removeBinding.run(timestamp, timestamp, projectId);
          }
        }
      }
      storeCloudDetailData(db, currentUser, snapshot, revision);
      writeDesktopKanbanRevision(db, Math.max(currentRevision, revision));
      writeDesktopKanbanSyncCursorInDb(db, { lastAppliedRevision: Math.max(currentRevision, revision) });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      ok: true,
      message: t("kanban.runtime.snapshotSynced"),
      issues: selectIssues(db, currentUser),
      localWorkflows: readLocalWorkflows(db, BOARD_ID),
      projects: selectProjects(db),
      projectBindings: selectProjectBindings(db),
      cloudDetails: selectCloudDetailData(db, currentUser),
      storagePath: getDesktopKanbanDatabasePath(app),
      boardId: BOARD_ID,
      projectId: snapshotProjectId || PROJECT_ID,
      revision,
      currentUser,
      connectionState: "open"
    };
  });
}

export function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, normalize(nested)]));
  };
  return JSON.stringify(normalize(value));
}

export function upsertDispatchedDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issue: unknown,
  revision = 0,
  origin: KanbanOrigin = "cloud_dispatch"
): KanbanIssueResult {
  const cloudIssue = parseCloudIssue(issue);
  if (!cloudIssue) {
    return {
      ok: false,
      message: t("kanban.runtime.dispatchInvalid"),
      issues: listDesktopKanbanIssues(app, currentUser).issues
    };
  }
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const localIssue = cloudIssueToLocalIssue(cloudIssue, currentUser, revision);
    if (!localIssue?.remoteIssueId) {
      return { ok: false, message: t("kanban.runtime.dispatchMissingId"), issues: selectIssues(db, currentUser) };
    }
    localIssue.id = findLocalSyncForRemote(db, localIssue.remoteIssueId).localIssueId || createCloudCacheIssueId();
    localIssue.localIssueId = localIssue.id;
    insertOrReplaceIssue(db, localIssue, {
      syncMode: "cloud",
      syncState: "synced",
      origin,
      ownerUserId: currentUser.id,
      lastRemoteRevision: localIssue.revision ?? revision,
      lastSyncedAt: nowIso(),
      syncError: null
    });
    writeDesktopKanbanSyncCursorInDb(db, { lastAppliedRevision: Math.max(readDesktopKanbanRevision(db), revision) });
    return { ok: true, message: t("kanban.runtime.dispatched"), issue: localIssue, issues: selectIssues(db, currentUser) };
  });
}
