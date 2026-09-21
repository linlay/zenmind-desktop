import type { AppPathProvider, KanbanCloudMutationOutboxItem, KanbanRunEventOutboxItem } from "./store-model";
import type { KanbanCurrentUser } from "../../../shared/contracts";
import { withDesktopKanbanDatabase } from "./store-database";
import { parseJsonRecord, nullableTrimmedText, trimText } from "./store-values";

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
