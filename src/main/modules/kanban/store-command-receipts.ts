import type { AppPathProvider, KanbanCommandReceipt, KanbanCommandReceiptState } from "./store-model";
import type { KanbanCurrentUser } from "../../../shared/contracts";
import { withDesktopKanbanDatabase } from "./store-database";
import { trimText, parseCloudIssue, nowIso, createCloudCacheIssueId } from "./store-values";
import { stableJson, cloudIssueToLocalIssue, findLocalSyncForRemote } from "./store-cloud-snapshot";
import { createHash } from "node:crypto";
import { insertOrReplaceIssue } from "./store-issue-writes";
import { DatabaseSync } from "node:sqlite";

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
