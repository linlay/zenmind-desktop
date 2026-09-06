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

import { AppPathProvider, DATABASE_DIRECTORY, DATABASE_FILENAME, KanbanCommandReceipt, KanbanCommandReceiptState, PROJECT_ID, createCloudCacheIssueId, getDesktopKanbanDatabasePath, nowIso, parseCloudIssue, trimText } from "./local-store.part-1";

import { withDesktopKanbanDatabase } from "./local-store.part-2";

import { insertOrReplaceIssue, insertOrReplaceProjectBinding, readDesktopKanbanRevision, selectIssues, writeDesktopKanbanSyncCursorInDb } from "./local-store.part-3";

import { cloudIssueToLocalIssue, findLocalSyncForRemote, listDesktopKanbanIssues } from "./local-store.part-4";

export function recordDesktopKanbanCommandReceipt(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  input: { commandId: string; deliverySeq: number; projectId?: string | null; sourceRevision?: number; payload: Record<string, unknown>; issue: unknown }
): { ok: boolean; executable: boolean; message: string; receipt: KanbanCommandReceipt } {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const commandId = trimText(input.commandId);
    const issueRecord = parseCloudIssue(input.issue);
      const issueId = trimText(issueRecord?.id);
    const issueRunId = trimText(input.payload.issueRunId);
    const commandType = trimText(input.payload.reviewId) ? "review" : "run";
    if (!commandId || !issueId || !issueRunId) throw new Error("commandId, issue.id and issueRunId are required");
    const payloadJson = stableJson(input.payload);
    const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
    const idHash = createHash("sha256").update(commandId).digest("hex").slice(0, 32);
    const timestamp = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = readCommandReceiptInDb(db, commandId);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          db.prepare(`UPDATE kanban_command_receipt SET STATE_ = 'failed', LAST_ERROR_ = ?, UPDATED_AT_ = ? WHERE COMMAND_ID_ = ?`)
            .run("command payload hash mismatch", timestamp, commandId);
          db.exec("COMMIT");
          const receipt = readCommandReceiptInDb(db, commandId)!;
          return { ok: true, executable: false, message: receipt.lastError || "command payload mismatch", receipt };
        }
        db.exec("COMMIT");
        return { ok: true, executable: existing.state === "received" || existing.state === "starting", message: "command already received", receipt: existing };
      }
      const cloudIssue = cloudIssueToLocalIssue(issueRecord!, currentUser, input.sourceRevision ?? 0);
      if (!cloudIssue) throw new Error("invalid command issue snapshot");
      const existingSync = findLocalSyncForRemote(db, issueId);
      cloudIssue.id = existingSync.localIssueId || createCloudCacheIssueId();
      cloudIssue.localIssueId = cloudIssue.id;
      insertOrReplaceIssue(db, cloudIssue, {
        syncMode: "cloud",
        syncState: "synced",
        origin: existingSync.origin ?? "cloud_dispatch",
        ownerUserId: currentUser.id,
        lastRemoteRevision: cloudIssue.revision,
        lastSyncedAt: timestamp,
        syncError: null
      });
      db.prepare(`
        INSERT INTO kanban_command_receipt (
          COMMAND_ID_, DELIVERY_SEQ_, PROJECT_ID_, ISSUE_ID_, ISSUE_RUN_ID_, COMMAND_TYPE_, PAYLOAD_JSON_, PAYLOAD_HASH_, CHAT_ID_, RUN_ID_, REQUEST_ID_,
          STATE_, ATTEMPT_COUNT_, LAST_ERROR_, CREATED_AT_, UPDATED_AT_
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, NULL, ?, ?)
      `).run(commandId, input.deliverySeq, trimText(input.projectId), issueId, issueRunId, commandType, payloadJson, payloadHash,
        trimText(input.payload.preferredChatId) || `chat_kanban_${idHash}`, `run_kanban_${idHash}`, `request_kanban_${idHash}`, timestamp, timestamp);
      db.exec("COMMIT");
      return { ok: true, executable: true, message: "command received", receipt: readCommandReceiptInDb(db, commandId)! };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export function listPendingDesktopKanbanCommandReceipts(app: AppPathProvider, currentUser: KanbanCurrentUser): KanbanCommandReceipt[] {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const rows = db.prepare(`
      SELECT COMMAND_ID_ AS commandId FROM kanban_command_receipt
      WHERE STATE_ IN ('received','starting','started') OR (STATE_ = 'failed' AND TERMINAL_REPORTED_AT_ IS NULL)
      ORDER BY DELIVERY_SEQ_
    `).all() as Array<{ commandId: string }>;
    return rows.map((row) => readCommandReceiptInDb(db, row.commandId)).filter((item): item is KanbanCommandReceipt => Boolean(item));
  });
}

export function getDesktopKanbanCommandReceiptByRunId(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  runId: string
): KanbanCommandReceipt | null {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const row = db.prepare(`
      SELECT COMMAND_ID_ AS commandId
      FROM kanban_command_receipt
      WHERE RUN_ID_ = ?
      ORDER BY UPDATED_AT_ DESC
      LIMIT 1
    `).get(trimText(runId)) as { commandId?: string } | undefined;
    return row?.commandId ? readCommandReceiptInDb(db, row.commandId) : null;
  });
}

export function updateDesktopKanbanCommandReceipt(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  commandId: string,
  state: KanbanCommandReceiptState,
  lastError: string | null = null,
  incrementAttempt = false
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`
      UPDATE kanban_command_receipt
      SET STATE_ = ?, LAST_ERROR_ = ?, ATTEMPT_COUNT_ = ATTEMPT_COUNT_ + ?, UPDATED_AT_ = ?
      WHERE COMMAND_ID_ = ? AND (? IN ('completed','failed') OR STATE_ NOT IN ('completed','failed'))
    `).run(state, lastError, incrementAttempt ? 1 : 0, nowIso(), trimText(commandId), state);
    return readCommandReceiptInDb(db, commandId);
  });
}

export function updateDesktopKanbanCommandReceiptIdentity(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  commandId: string,
  chatId: string,
  runId: string
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`UPDATE kanban_command_receipt SET CHAT_ID_ = ?, RUN_ID_ = ?, UPDATED_AT_ = ? WHERE COMMAND_ID_ = ?`)
      .run(trimText(chatId), trimText(runId), nowIso(), trimText(commandId));
  });
}

export function completeDesktopKanbanCommandReceiptByRunId(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  runId: string,
  state: "completed" | "failed"
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`UPDATE kanban_command_receipt SET STATE_ = ?, UPDATED_AT_ = ? WHERE RUN_ID_ = ?`)
      .run(state, nowIso(), trimText(runId));
  });
}

export function markDesktopKanbanCommandReceiptReported(app: AppPathProvider, currentUser: KanbanCurrentUser, commandId: string) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`UPDATE kanban_command_receipt SET TERMINAL_REPORTED_AT_ = ?, UPDATED_AT_ = ? WHERE COMMAND_ID_ = ?`)
      .run(nowIso(), nowIso(), trimText(commandId));
  });
}

export function hasDesktopKanbanCloudProject(app: AppPathProvider, currentUser: KanbanCurrentUser, projectId: string) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM project WHERE ID_ = ? AND SYNC_MODE_ = 'cloud' AND DELETED_AT_ IS NULL`)
      .get(trimText(projectId)) as { count?: number } | undefined;
    return (row?.count ?? 0) > 0;
  });
}

export function ensureDesktopKanbanDefaultBinding(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  deviceId: string,
  remoteProjectId: string
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const timestamp = nowIso();
    const localProject = db.prepare(`SELECT ID_ AS id, NAME_ AS name FROM project WHERE ID_ = ? AND DELETED_AT_ IS NULL`)
      .get(PROJECT_ID) as { id: string; name: string } | undefined;
    if (!localProject) return null;
    const binding: KanbanProjectBinding = {
      id: `binding:${trimText(deviceId)}:${trimText(remoteProjectId)}:${localProject.id}`,
      projectId: trimText(remoteProjectId) || PROJECT_ID,
      deviceId: trimText(deviceId),
      currentUserId: currentUser.id,
      localProjectId: localProject.id,
      localDisplayName: localProject.name,
      syncPolicy: "future",
      controlMode: "dispatch",
      status: "active",
      lastRemoteRevision: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    insertOrReplaceProjectBinding(db, binding);
    return binding;
  });
}

export function readCommandReceiptInDb(db: DatabaseSync, commandId: string): KanbanCommandReceipt | null {
  const row = db.prepare(`
    SELECT COMMAND_ID_ AS commandId, DELIVERY_SEQ_ AS deliverySeq, PROJECT_ID_ AS projectId, ISSUE_ID_ AS issueId,
      ISSUE_RUN_ID_ AS issueRunId, COMMAND_TYPE_ AS commandType,
      PAYLOAD_JSON_ AS payloadJson, PAYLOAD_HASH_ AS payloadHash, CHAT_ID_ AS chatId, RUN_ID_ AS runId,
      REQUEST_ID_ AS requestId, STATE_ AS state, ATTEMPT_COUNT_ AS attemptCount, LAST_ERROR_ AS lastError,
      TERMINAL_REPORTED_AT_ AS terminalReportedAt, CREATED_AT_ AS createdAt, UPDATED_AT_ AS updatedAt
    FROM kanban_command_receipt WHERE COMMAND_ID_ = ?
  `).get(trimText(commandId)) as (Omit<KanbanCommandReceipt, "payload"> & { payloadJson: string }) | undefined;
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payloadJson) as Record<string, unknown>; } catch { payload = {}; }
  const { payloadJson: _payloadJson, ...receipt } = row;
  return { ...receipt, projectId: receipt.projectId || "", payload };
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

export function getDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) =>
    selectIssues(db, currentUser).find((candidate) => candidate.id === issueId) ?? null
  );
}

export const __testInternals = {
  DATABASE_DIRECTORY,
  DATABASE_FILENAME,
  getDesktopKanbanDatabasePath,
  withDesktopKanbanDatabase
};
