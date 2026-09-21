import { DatabaseSync } from "node:sqlite";
import { BOARD_ID, SYNC_CACHE_SCHEMA_VERSION } from "./store-values";
import type { KanbanDesktopSyncCursor, AppPathProvider } from "./store-model";
import type { KanbanCurrentUser } from "../../../shared/contracts";
import { withDesktopKanbanDatabase } from "./store-database";

export function readDesktopKanbanRevision(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT VALUE_ AS value FROM board_meta
    WHERE BOARD_ID_ = ? AND KEY_ = 'revision'
  `).get(BOARD_ID) as { value?: string } | undefined;
  const revision = Number.parseInt(row?.value ?? "0", 10);
  return Number.isFinite(revision) ? revision : 0;
}

export function readBoardMetaInteger(db: DatabaseSync, key: string, fallback = 0) {
  const row = db.prepare(`
    SELECT VALUE_ AS value FROM board_meta
    WHERE BOARD_ID_ = ? AND KEY_ = ?
  `).get(BOARD_ID, key) as { value?: string } | undefined;
  const value = Number.parseInt(row?.value ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function writeBoardMetaInteger(db: DatabaseSync, key: string, value: number) {
  db.prepare(`
    INSERT INTO board_meta (BOARD_ID_, KEY_, VALUE_)
    VALUES (?, ?, ?)
    ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_
  `).run(BOARD_ID, key, String(Math.max(0, Math.floor(value))));
}

export function writeDesktopKanbanRevision(db: DatabaseSync, revision: number) {
  db.prepare(`
    INSERT INTO board_meta (BOARD_ID_, KEY_, VALUE_)
    VALUES (?, 'revision', ?)
    ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_
  `).run(BOARD_ID, String(Math.max(0, Math.floor(revision))));
}

export function readDesktopKanbanSyncCursorFromDb(db: DatabaseSync): KanbanDesktopSyncCursor {
  return {
    lastAckedDeliverySeq: readBoardMetaInteger(db, "sync.lastAckedDeliverySeq"),
    lastAppliedRevision: Math.max(
      readBoardMetaInteger(db, "sync.lastAppliedRevision"),
      readDesktopKanbanRevision(db)
    ),
    cacheSchemaVersion: readBoardMetaInteger(db, "sync.cacheSchemaVersion", SYNC_CACHE_SCHEMA_VERSION) || SYNC_CACHE_SCHEMA_VERSION
  };
}

export function writeDesktopKanbanSyncCursorInDb(db: DatabaseSync, cursor: Partial<KanbanDesktopSyncCursor>) {
  if (cursor.lastAckedDeliverySeq !== undefined) {
    writeBoardMetaInteger(db, "sync.lastAckedDeliverySeq", cursor.lastAckedDeliverySeq);
  }
  if (cursor.lastAppliedRevision !== undefined) {
    const revision = Math.max(readDesktopKanbanRevision(db), cursor.lastAppliedRevision);
    writeBoardMetaInteger(db, "sync.lastAppliedRevision", revision);
    writeDesktopKanbanRevision(db, revision);
  }
  writeBoardMetaInteger(db, "sync.cacheSchemaVersion", cursor.cacheSchemaVersion ?? SYNC_CACHE_SCHEMA_VERSION);
}

export function readDesktopKanbanSyncCursor(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser
): KanbanDesktopSyncCursor {
  return withDesktopKanbanDatabase(app, currentUser, (db) => readDesktopKanbanSyncCursorFromDb(db));
}

export function writeDesktopKanbanSyncCursor(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  cursor: Partial<KanbanDesktopSyncCursor>
): KanbanDesktopSyncCursor {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const current = readDesktopKanbanSyncCursorFromDb(db);
    writeDesktopKanbanSyncCursorInDb(db, {
      lastAckedDeliverySeq: Math.max(current.lastAckedDeliverySeq, cursor.lastAckedDeliverySeq ?? 0),
      lastAppliedRevision: Math.max(current.lastAppliedRevision, cursor.lastAppliedRevision ?? 0),
      cacheSchemaVersion: cursor.cacheSchemaVersion ?? current.cacheSchemaVersion
    });
    return readDesktopKanbanSyncCursorFromDb(db);
  });
}
