import fs from "node:fs";

import path from "node:path";

import { createHash, randomUUID } from "node:crypto";

import { DatabaseSync } from "node:sqlite";

import type { App } from "electron";

import type {
  AssistantAttachment,
  KanbanCloudDetailData,
  KanbanCurrentUser,
  KanbanDeleteResult,
  KanbanIssue,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueResult,
  KanbanIssueUpdateInput,
  KanbanListResult,
  KanbanOrigin,
  KanbanPriority,
  KanbanProject,
  KanbanProjectBinding,
  KanbanRunState,
  KanbanStatus,
  KanbanSyncMode,
  KanbanSyncState
} from "../../../shared/contracts";

import {
  KANBAN_RUN_STATES,
  KANBAN_STATUSES,
  parseKanbanPriority
} from "../../../shared/contracts";

import { getRuntimeDataRoot } from "../../infrastructure/filesystem/user-paths";

import { t } from "../../support/i18n/main-i18n";

import { AppPathProvider, BOARD_ID, ISSUE_TYPE_ID, KanbanCloudMutationOutboxItem, KanbanCloudSnapshot, KanbanManualRunReceipt, KanbanManualRunReceiptState, KanbanRunEventOutboxItem, PROJECT_ID, WORKFLOW_ID, createCloudCacheIssueId, getDesktopKanbanDatabasePath, normalizeAttachments, normalizeCustomFields, normalizeDueDate, normalizeEffortSeconds, normalizeKanbanPriority, normalizeKanbanRunState, normalizeKanbanSeverity, normalizeKanbanStatus, normalizeStringList, normalizeWorkerType, nowIso, nullableTrimmedText, parseCloudIssue, parseJsonRecord, readLegacyDueDate, selectCloudDetailData, storeCloudDetailData, trimText } from "./local-store.part-1";

import { withDesktopKanbanDatabase } from "./local-store.part-2";

import { buildLocalIssue, insertOrReplaceIssue, insertOrReplaceProject, insertOrReplaceProjectBinding, parseCloudProject, parseCloudProjectBinding, readDesktopKanbanRevision, selectIssues, selectProjectBindings, selectProjects, writeDesktopKanbanRevision, writeDesktopKanbanSyncCursorInDb } from "./local-store.part-3";

export function applyIssueUpdate(issue: KanbanIssue, input: KanbanIssueUpdateInput): KanbanIssue | null {
  const nextIssue: KanbanIssue = {
    ...issue,
    attachments: [...issue.attachments],
    updatedAt: nowIso()
  };
  if (input.title !== undefined) {
    const title = trimText(input.title);
    if (!title) return null;
    nextIssue.title = title;
  }
  if (input.projectId !== undefined) nextIssue.projectId = nullableTrimmedText(input.projectId) ?? PROJECT_ID;
  if (input.projectVersion !== undefined || input.version !== undefined) {
    nextIssue.projectVersion = nullableTrimmedText(input.projectVersion !== undefined ? input.projectVersion : input.version);
  }
  if (input.dueDate !== undefined) nextIssue.dueDate = normalizeDueDate(input.dueDate) ?? null;
  if (input.resolution !== undefined) nextIssue.resolution = nullableTrimmedText(input.resolution);
  if (input.securityLevelKey !== undefined) nextIssue.securityLevelKey = nullableTrimmedText(input.securityLevelKey);
  if (input.reporterId !== undefined) nextIssue.reporterId = nullableTrimmedText(input.reporterId);
  if (input.componentKeys !== undefined) nextIssue.componentKeys = normalizeStringList(input.componentKeys);
  if (input.originalEstimate !== undefined) nextIssue.originalEstimate = normalizeEffortSeconds(input.originalEstimate);
  if (input.remainingEstimate !== undefined) nextIssue.remainingEstimate = normalizeEffortSeconds(input.remainingEstimate);
  if (input.timeSpent !== undefined) nextIssue.timeSpent = normalizeEffortSeconds(input.timeSpent);
  if (input.description !== undefined) nextIssue.description = typeof input.description === "string" ? input.description.trim() : "";
  if (input.status !== undefined) {
    nextIssue.status = normalizeKanbanStatus(input.status);
  }
  if (input.priority !== undefined) nextIssue.priority = normalizeKanbanPriority(input.priority);
  if (input.severity !== undefined) nextIssue.severity = normalizeKanbanSeverity(input.severity);
  if (input.assigneeAgentKey !== undefined) {
    nextIssue.assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
    nextIssue.workerAgent = nextIssue.assigneeAgentKey;
    if (nextIssue.assigneeAgentKey) nextIssue.workerType = "agent";
  }
  if (input.assigneeId !== undefined) nextIssue.assigneeId = nullableTrimmedText(input.assigneeId);
  if (input.workerType !== undefined) nextIssue.workerType = normalizeWorkerType(input.workerType);
  if (input.workerId !== undefined) nextIssue.workerId = nullableTrimmedText(input.workerId);
  if (input.workerAgent !== undefined) nextIssue.workerAgent = nullableTrimmedText(input.workerAgent);
  if (input.chatId !== undefined) nextIssue.chatId = nullableTrimmedText(input.chatId);
  if (input.runId !== undefined) {
    nextIssue.runId = nullableTrimmedText(input.runId);
    nextIssue.activeRunId = nextIssue.runId;
  }
  if (input.runState !== undefined) {
    nextIssue.runState = normalizeKanbanRunState(input.runState);
  } else if (input.runId !== undefined) {
    nextIssue.runState = nextIssue.runId ? "running" : nextIssue.status === "completed" ? "completed" : nextIssue.runState;
  }
  if (input.automationId !== undefined) nextIssue.automationId = nullableTrimmedText(input.automationId);
  if (input.automationEnabled !== undefined) nextIssue.automationEnabled = input.automationEnabled === true;
  if (input.automationCron !== undefined) nextIssue.automationCron = nullableTrimmedText(input.automationCron);
  if (input.automationMessage !== undefined) nextIssue.automationMessage = nullableTrimmedText(input.automationMessage);
  if (input.automationTimezone !== undefined) nextIssue.automationTimezone = nullableTrimmedText(input.automationTimezone);
  if (input.attachmentChatId !== undefined) nextIssue.attachmentChatId = nullableTrimmedText(input.attachmentChatId);
  if (input.attachments !== undefined) nextIssue.attachments = normalizeAttachments(input.attachments);
  return nextIssue;
}

export function listDesktopKanbanIssues(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  connectionState: KanbanListResult["connectionState"] = "disabled"
): KanbanListResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => ({
    ok: true,
    message: connectionState === "open" ? t("kanban.runtime.synced") : t("kanban.runtime.loadedFromCache"),
    issues: selectIssues(db, currentUser),
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
    const nextIssue = applyIssueUpdate(issue, input);
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
  missingMessage: string
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issues = selectIssues(db, currentUser);
    const issue = issues.find(predicate);
    if (!issue) {
      return { ok: false, message: missingMessage, issues };
    }
    const nextIssue = applyIssueUpdate(issue, input);
    if (!nextIssue) {
      return { ok: false, message: t("kanban.runtime.titleRequired"), issues };
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

export function updateDesktopKanbanIssueRuntimeState(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string,
  input: Pick<KanbanIssueUpdateInput, "status" | "chatId" | "runId" | "runState">
): KanbanIssueResult {
  return updateDesktopKanbanIssueByPredicate(
    app,
    currentUser,
    (issue) => issue.id === issueId,
    input,
    t("kanban.runtime.missing")
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
      ...issue,
      status,
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
    projectVersion: nullableTrimmedText(rawIssue.projectVersion !== undefined ? rawIssue.projectVersion : rawIssue.version),
    dueDate: rawIssue.dueDate !== undefined
      ? canonicalDueDate ?? null
      : readLegacyDueDate(rawIssue.dueTime, rawIssue.dueAt) ?? null,
    dueRisk: nullableTrimmedText(rawIssue.dueRisk),
    resolution: nullableTrimmedText(rawIssue.resolution),
    securityLevelKey: nullableTrimmedText(rawIssue.securityLevelKey),
    reporterId: nullableTrimmedText(rawIssue.reporterId),
    componentKeys: normalizeStringList(rawIssue.componentKeys),
    originalEstimate: normalizeEffortSeconds(rawIssue.originalEstimate),
    remainingEstimate: normalizeEffortSeconds(rawIssue.remainingEstimate),
    timeSpent: normalizeEffortSeconds(rawIssue.timeSpent),
    parentIssueId: nullableTrimmedText(rawIssue.parentIssueId),
    workflowId: trimText(rawIssue.workflowId) || WORKFLOW_ID,
    typeId: trimText(rawIssue.issueTypeKey) || trimText(rawIssue.typeId) || ISSUE_TYPE_ID,
    issueTypeKey: trimText(rawIssue.issueTypeKey) || trimText(rawIssue.typeId) || ISSUE_TYPE_ID,
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
          `).run(localContainerId, WORKFLOW_ID, timestamp, timestamp);
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

export function recordDesktopKanbanCloudMutation(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  item: Omit<KanbanCloudMutationOutboxItem, "attemptCount" | "lastError">
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO kanban_cloud_mutation_outbox (
        ID_, REQUEST_TYPE_, PROJECT_ID_, ISSUE_ID_, PAYLOAD_JSON_, CREATED_AT_, UPDATED_AT_
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ID_) DO NOTHING
    `).run(item.id, item.requestType, item.projectId, item.issueId, JSON.stringify(item.payload), now, now);
  });
}

export function listDesktopKanbanCloudMutations(app: AppPathProvider, currentUser: KanbanCurrentUser): KanbanCloudMutationOutboxItem[] {
  return withDesktopKanbanDatabase(app, currentUser, (db) => (db.prepare(`
    SELECT ID_ AS id, REQUEST_TYPE_ AS requestType, PROJECT_ID_ AS projectId, ISSUE_ID_ AS issueId,
      PAYLOAD_JSON_ AS payloadJson, ATTEMPT_COUNT_ AS attemptCount, LAST_ERROR_ AS lastError
    FROM kanban_cloud_mutation_outbox ORDER BY CREATED_AT_, ID_
  `).all() as Array<Omit<KanbanCloudMutationOutboxItem, "payload"> & { payloadJson: string }>).map((row) => {
    const { payloadJson, ...item } = row;
    return { ...item, payload: parseJsonRecord(payloadJson) };
  }));
}

export function markDesktopKanbanCloudMutationAttempt(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  id: string,
  error: string | null
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`UPDATE kanban_cloud_mutation_outbox SET ATTEMPT_COUNT_ = ATTEMPT_COUNT_ + 1, LAST_ERROR_ = ?, UPDATED_AT_ = ? WHERE ID_ = ?`)
      .run(nullableTrimmedText(error), new Date().toISOString(), trimText(id));
  });
}

export function deleteDesktopKanbanCloudMutation(app: AppPathProvider, currentUser: KanbanCurrentUser, id: string) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`DELETE FROM kanban_cloud_mutation_outbox WHERE ID_ = ?`).run(trimText(id));
  });
}

export function recordDesktopKanbanRunEvent(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  item: Omit<KanbanRunEventOutboxItem, "attemptCount" | "lastError">
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO kanban_run_event_outbox (
        CLIENT_EVENT_ID_, PROJECT_ID_, ISSUE_ID_, ISSUE_RUN_ID_, EXTERNAL_RUN_ID_, RUN_ID_, CHAT_ID_, EVENT_TYPE_, SOURCE_DELIVERY_SEQ_, PAYLOAD_JSON_, CREATED_AT_, UPDATED_AT_
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(CLIENT_EVENT_ID_) DO NOTHING
    `).run(item.clientEventId, item.projectId, item.issueId, item.issueRunId, item.externalRunId, item.runId, item.chatId, item.eventType, item.sourceDeliverySeq, JSON.stringify(item.payload), now, now);
  });
}

export function listDesktopKanbanRunEvents(app: AppPathProvider, currentUser: KanbanCurrentUser): KanbanRunEventOutboxItem[] {
  return withDesktopKanbanDatabase(app, currentUser, (db) => (db.prepare(`
    SELECT CLIENT_EVENT_ID_ AS clientEventId, PROJECT_ID_ AS projectId, ISSUE_ID_ AS issueId,
      ISSUE_RUN_ID_ AS issueRunId, EXTERNAL_RUN_ID_ AS externalRunId, RUN_ID_ AS runId, CHAT_ID_ AS chatId, EVENT_TYPE_ AS eventType, SOURCE_DELIVERY_SEQ_ AS sourceDeliverySeq,
      PAYLOAD_JSON_ AS payloadJson, ATTEMPT_COUNT_ AS attemptCount, LAST_ERROR_ AS lastError
    FROM kanban_run_event_outbox ORDER BY CREATED_AT_, CLIENT_EVENT_ID_
  `).all() as Array<Omit<KanbanRunEventOutboxItem, "payload"> & { payloadJson: string }>).map((row) => {
    const { payloadJson, ...item } = row;
    return { ...item, payload: parseJsonRecord(payloadJson) };
  }));
}

export function markDesktopKanbanRunEventAttempt(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  clientEventId: string,
  error: string | null
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`UPDATE kanban_run_event_outbox SET ATTEMPT_COUNT_ = ATTEMPT_COUNT_ + 1, LAST_ERROR_ = ?, UPDATED_AT_ = ? WHERE CLIENT_EVENT_ID_ = ?`)
      .run(nullableTrimmedText(error), new Date().toISOString(), trimText(clientEventId));
  });
}

export function deleteDesktopKanbanRunEvent(app: AppPathProvider, currentUser: KanbanCurrentUser, clientEventId: string) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`DELETE FROM kanban_run_event_outbox WHERE CLIENT_EVENT_ID_ = ?`).run(trimText(clientEventId));
  });
}

export function recordDesktopKanbanManualRun(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  receipt: Omit<KanbanManualRunReceipt, "state" | "lastError">
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO kanban_manual_run_receipt (
        ISSUE_RUN_ID_, RUN_ID_, CHAT_ID_, ISSUE_ID_, PROJECT_ID_, AGENT_KEY_, STATE_, CREATED_AT_, UPDATED_AT_
      ) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?)
      ON CONFLICT(RUN_ID_) DO NOTHING
    `).run(receipt.issueRunId, receipt.runId, receipt.chatId, receipt.issueId, receipt.projectId, receipt.agentKey, now, now);
  });
}

export function updateDesktopKanbanManualRun(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  runId: string,
  state: KanbanManualRunReceiptState,
  error: string | null = null
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`UPDATE kanban_manual_run_receipt SET STATE_ = ?, LAST_ERROR_ = ?, UPDATED_AT_ = ? WHERE RUN_ID_ = ?`)
      .run(state, nullableTrimmedText(error), new Date().toISOString(), trimText(runId));
  });
}

export function getDesktopKanbanManualRunByRunId(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  runId: string
): KanbanManualRunReceipt | null {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const row = db.prepare(`
      SELECT ISSUE_RUN_ID_ AS issueRunId, RUN_ID_ AS runId, CHAT_ID_ AS chatId, ISSUE_ID_ AS issueId, PROJECT_ID_ AS projectId,
        AGENT_KEY_ AS agentKey, STATE_ AS state, LAST_ERROR_ AS lastError
      FROM kanban_manual_run_receipt WHERE RUN_ID_ = ?
    `).get(trimText(runId)) as KanbanManualRunReceipt | undefined;
    return row ?? null;
  });
}

export function listPendingDesktopKanbanManualRuns(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser
): KanbanManualRunReceipt[] {
  return withDesktopKanbanDatabase(app, currentUser, (db) => db.prepare(`
    SELECT ISSUE_RUN_ID_ AS issueRunId, RUN_ID_ AS runId, CHAT_ID_ AS chatId, ISSUE_ID_ AS issueId, PROJECT_ID_ AS projectId,
      AGENT_KEY_ AS agentKey, STATE_ AS state, LAST_ERROR_ AS lastError
    FROM kanban_manual_run_receipt
    WHERE STATE_ IN ('starting', 'started')
    ORDER BY CREATED_AT_, RUN_ID_
  `).all() as KanbanManualRunReceipt[]);
}
