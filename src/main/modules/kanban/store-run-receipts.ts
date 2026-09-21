import type { AppPathProvider, KanbanManualRunReceipt, KanbanManualRunReceiptState } from "./store-model";
import type { KanbanCurrentUser } from "../../../shared/contracts";
import { withDesktopKanbanDatabase } from "./store-database";
import { nullableTrimmedText, trimText } from "./store-values";

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
