import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { App } from "electron";
import { ARTIFACT_CATEGORIES, type DesktopArtifactAccessState, type DesktopArtifactContentState, type DesktopArtifactIdentity, type DesktopArtifactListInput, type DesktopArtifactListResult, type DesktopArtifactOrganizeInput, type DesktopArtifactRecord, type DesktopArtifactSourceState } from "../../../shared/artifacts";
import { isAgentPlatformEpochMilliseconds } from "../../../shared/time-contract";
import { getDesktopRoot } from "../../infrastructure/filesystem/user-paths";
import { cleanText, object, parseArtifactMetadata, validIdentity } from "./metadata";
export function parseArtifactPush(value: unknown): DesktopArtifactRecord | null {
  const frame = object(value);
  if (frame.frame !== "push" || !["artifact.published", "resource.pushed"].includes(String(frame.type)))
    return null;
  const data = object(frame.data ?? frame.payload ?? frame);
  if (frame.type === "artifact.published" && !isAgentPlatformEpochMilliseconds(data.publishedAt))
    return null;
  return parseArtifactMetadata({ ...data, publishedAt: frame.type === "artifact.published" ? data.publishedAt : data.pushedAt }, frame.type === "resource.pushed");
}
export function getArtifactDatabasePath(app: App, platform: NodeJS.Platform = process.platform) {
  const root = getDesktopRoot(app, platform);
  if (platform === "win32" && path.win32.isAbsolute(root) && !path.posix.isAbsolute(root))
    return path.win32.join(root, "data", "artifacts.db");
  return path.join(root, "data", "artifacts.db");
}
const COLUMNS = `a.chat_id AS chatId, a.run_id AS runId, a.artifact_id AS artifactId, a.name,
 a.mime_type AS mimeType, a.size_bytes AS sizeBytes, a.sha256, a.pushed_at AS pushedAt,
 a.category, a.favorite, a.tags, a.content_state AS contentState,
 COALESCE(c.source_state, 'active') AS sourceState, COALESCE(c.access_state, 'unknown') AS accessState,
 COALESCE(c.chat_name, '') AS chatName, COALESCE(c.agent_key, '') AS agentKey`;
const FROM = "FROM artifacts a LEFT JOIN artifact_chats c ON a.chat_id=c.chat_id";
function decode(row: Record<string, unknown>): DesktopArtifactRecord {
  return { ...row, favorite: !!row.favorite, tags: JSON.parse(String(row.tags)) } as unknown as DesktopArtifactRecord;
}
export class ArtifactStore {
  constructor(private readonly databasePath: () => string) { }
  private withDatabase<T>(read: (db: DatabaseSync) => T): T {
    const filename = this.databasePath();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    try {
      db.exec("PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;");
      const columns = db.prepare("PRAGMA table_info(artifacts)").all();
      const legacy = columns.length > 0 && !columns.some(c => c.name === "run_id");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (legacy)
          db.exec("ALTER TABLE artifacts RENAME TO artifacts_legacy; DROP INDEX IF EXISTS artifacts_pushed_at;");
        db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
     chat_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
     name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
     sha256 TEXT NOT NULL, pushed_at INTEGER NOT NULL, category TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', content_state TEXT NOT NULL,
     PRIMARY KEY(chat_id, run_id, artifact_id));
     CREATE INDEX IF NOT EXISTS artifacts_pushed_at ON artifacts(pushed_at DESC, chat_id, run_id, artifact_id);
     CREATE TABLE IF NOT EXISTS artifact_chats (
      chat_id TEXT PRIMARY KEY, source_state TEXT NOT NULL DEFAULT 'active',
      access_state TEXT NOT NULL DEFAULT 'unknown', chat_name TEXT NOT NULL DEFAULT '', agent_key TEXT NOT NULL DEFAULT '');`);
        if (legacy) {
          db.exec(`INSERT INTO artifacts(chat_id,run_id,artifact_id,name,mime_type,size_bytes,sha256,pushed_at,category,content_state)
      SELECT chat_id,'',artifact_id,name,mime_type,size_bytes,sha256,pushed_at,'other','unresolved' FROM artifacts_legacy;
      DROP TABLE artifacts_legacy;`);
          // Reclassify migrated metadata with exactly the same MIME rules as new publications.
          for (const row of db.prepare("SELECT * FROM artifacts").all()) {
            const item = parseArtifactMetadata({ chatId: row.chat_id, runId: "", artifactId: row.artifact_id, name: row.name,
              mimeType: row.mime_type, sizeBytes: row.size_bytes, sha256: row.sha256, pushedAt: row.pushed_at }, true);
            if (item)
              db.prepare("UPDATE artifacts SET category=? WHERE chat_id=? AND artifact_id=?").run(item.category, item.chatId, item.artifactId);
          }
        }
        db.exec("COMMIT");
      }
      catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return read(db);
    }
    finally {
      db.close();
    }
  }
  ingestPublished(event: Record<string, unknown>): boolean {
    if (event.type !== "artifact.publish" || !Array.isArray(event.artifacts) || !isAgentPlatformEpochMilliseconds(event.timestamp))
      return false;
    let changed = false;
    for (const value of event.artifacts) {
      changed = this.ingest({ frame: "push", type: "resource.pushed", data: { ...object(value),
          chatId: event.chatId, runId: event.runId, pushedAt: event.timestamp } }) || changed;
    }
    return changed;
  }
  ingest(frame: unknown): boolean {
    const item = parseArtifactPush(frame);
    if (!item)
      return false;
    return this.withDatabase(db => this.upsert(db, item));
  }
  private upsert(db: DatabaseSync, item: DesktopArtifactRecord, authoritative = false): boolean {
    if (db.prepare("SELECT 1 FROM artifact_chats WHERE chat_id=? AND source_state IN ('deleted','archived')").get(item.chatId))
      return false;
    // Upload notifications without a run cannot replace an already resolved publication.
    if (!item.runId && db.prepare("SELECT 1 FROM artifacts WHERE chat_id=? AND artifact_id=? AND run_id<>''").get(item.chatId, item.artifactId))
      return false;
    const result = db.prepare(`INSERT INTO artifacts(chat_id,run_id,artifact_id,name,mime_type,size_bytes,sha256,pushed_at,category,content_state)
   VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,run_id,artifact_id) DO UPDATE SET
    name=excluded.name,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,sha256=excluded.sha256,
    pushed_at=excluded.pushed_at,category=excluded.category,
    content_state=CASE WHEN ${authoritative ? "0" : "artifacts.content_state='ambiguous'"} OR (artifacts.run_id<>'' AND
     (artifacts.sha256<>excluded.sha256 OR artifacts.name<>excluded.name))
     THEN 'ambiguous' ELSE artifacts.content_state END
   WHERE ${authoritative ? "1 OR" : ""} excluded.pushed_at>=artifacts.pushed_at AND
    (excluded.pushed_at<>artifacts.pushed_at OR excluded.sha256<>artifacts.sha256 OR excluded.name<>artifacts.name
     OR excluded.mime_type<>artifacts.mime_type OR excluded.size_bytes<>artifacts.size_bytes)`).run(item.chatId, item.runId, item.artifactId, item.name, item.mimeType, item.sizeBytes, item.sha256, item.pushedAt, item.category, item.contentState);
    return Number(result.changes) > 0;
  }
  replaceChatManifest(chatId: string, items: DesktopArtifactRecord[]) {
    this.withDatabase(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const counts = new Map<string, number>();
        for (const item of items)
          counts.set(JSON.stringify([item.runId, item.artifactId]), (counts.get(JSON.stringify([item.runId, item.artifactId])) ?? 0) + 1);
        for (const item of items) {
          if (item.chatId !== chatId || !item.runId)
            throw new Error("Invalid artifact identity");
          this.upsert(db, item, true);
          if (counts.get(JSON.stringify([item.runId, item.artifactId]))! > 1) {
            db.prepare("UPDATE artifacts SET content_state='ambiguous' WHERE chat_id=? AND run_id=? AND artifact_id=?").run(chatId, item.runId, item.artifactId);
          }
          else {
            db.prepare("UPDATE artifacts SET content_state='ready' WHERE chat_id=? AND run_id=? AND artifact_id=? AND content_state='ambiguous'").run(chatId, item.runId, item.artifactId);
          }
        }
        // A legacy pointer is transferred only on an exact, unique metadata match.
        const legacy = db.prepare("SELECT * FROM artifacts WHERE chat_id=? AND run_id='' ").all(chatId);
        for (const old of legacy) {
          const matches = items.filter(i => i.artifactId === old.artifact_id && i.sha256 === old.sha256 && i.name === old.name && i.sizeBytes === old.size_bytes);
          if (matches.length !== 1)
            continue;
          const target = matches[0];
          const tags = db.prepare("SELECT tags FROM artifacts WHERE chat_id=? AND run_id=? AND artifact_id=?").get(chatId, target.runId, target.artifactId)!;
          db.prepare("UPDATE artifacts SET favorite=MAX(favorite,?),tags=? WHERE chat_id=? AND run_id=? AND artifact_id=?").run(Number(old.favorite), JSON.stringify([...new Set([...JSON.parse(String(old.tags)), ...JSON.parse(String(tags.tags))])]), chatId, target.runId, target.artifactId);
          db.prepare("DELETE FROM artifacts WHERE chat_id=? AND run_id='' AND artifact_id=?").run(chatId, old.artifact_id!);
        }
        db.exec("COMMIT");
      }
      catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  setChat(chatId: string, sourceState: DesktopArtifactSourceState | "deleted", accessState: DesktopArtifactAccessState = "unknown", chatName = "", agentKey = "") {
    this.withDatabase(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO artifact_chats(chat_id,source_state,access_state,chat_name,agent_key) VALUES(?,?,?,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET source_state=excluded.source_state,access_state=excluded.access_state,
     chat_name=CASE WHEN excluded.chat_name<>'' THEN excluded.chat_name ELSE artifact_chats.chat_name END,
     agent_key=CASE WHEN excluded.agent_key<>'' THEN excluded.agent_key ELSE artifact_chats.agent_key END`).run(chatId, sourceState, accessState, chatName, agentKey);
        if (sourceState === "deleted")
          db.prepare("DELETE FROM artifacts WHERE chat_id=?").run(chatId);
        db.exec("COMMIT");
      }
      catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  knownChats(): string[] { return this.withDatabase(db => (db.prepare("SELECT DISTINCT chat_id FROM artifacts").all()).map(r => String(r.chat_id))); }
  get(identity: DesktopArtifactIdentity): DesktopArtifactRecord | null {
    if (!validIdentity(identity))
      return null;
    return this.withDatabase(db => {
      const row = db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE a.chat_id=? AND a.run_id=? AND a.artifact_id=?`).get(identity.chatId, identity.runId, identity.artifactId);
      return row ? decode(row) : null;
    });
  }
  setContentState(identity: DesktopArtifactIdentity, state: DesktopArtifactContentState) {
    this.withDatabase(db => db.prepare("UPDATE artifacts SET content_state=? WHERE chat_id=? AND run_id=? AND artifact_id=?").run(state, identity.chatId, identity.runId, identity.artifactId));
  }
  organize(input: DesktopArtifactOrganizeInput) {
    if (!validIdentity(input) || (input.favorite !== undefined && typeof input.favorite !== "boolean") ||
      (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some(t => !cleanText(t, 64)))))
      throw new Error("Invalid library metadata");
    this.withDatabase(db => {
      if (input.favorite !== undefined)
        db.prepare("UPDATE artifacts SET favorite=? WHERE chat_id=? AND run_id=? AND artifact_id=?").run(Number(input.favorite), input.chatId, input.runId, input.artifactId);
      if (input.tags !== undefined)
        db.prepare("UPDATE artifacts SET tags=? WHERE chat_id=? AND run_id=? AND artifact_id=?").run(JSON.stringify([...new Set(input.tags.map(t => t.trim()))]), input.chatId, input.runId, input.artifactId);
    });
  }
  list(input: DesktopArtifactListInput = {}): DesktopArtifactListResult {
    const search = typeof input?.search === "string" ? input.search.trim().slice(0, 256) : "";
    const offset = Number.isSafeInteger(input?.offset) ? Math.max(0, Math.min(input.offset!, 1000000)) : 0;
    const limit = Number.isSafeInteger(input?.limit) ? Math.max(1, Math.min(input.limit!, 100)) : 50;
    const clauses: string[] = [], params: (string | number)[] = [];
    if (search) {
      clauses.push("(a.name LIKE ? ESCAPE '\\' OR a.chat_id LIKE ? ESCAPE '\\' OR a.artifact_id LIKE ? ESCAPE '\\' OR a.mime_type LIKE ? ESCAPE '\\' OR c.chat_name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(a.tags) WHERE value LIKE ? ESCAPE '\\'))");
      params.push(...Array(6).fill(`%${search.replace(/[\\%_]/gu, "\\$&")}%`));
    }
    if (ARTIFACT_CATEGORIES.includes(input?.category!)) {
      clauses.push("a.category=?");
      params.push(input.category!);
    }
    if (input?.favoritesOnly === true)
      clauses.push("a.favorite=1");
    if (typeof input?.chatId === "string") {
      clauses.push("a.chat_id=?");
      params.push(input.chatId.slice(0, 256));
    }
    if (typeof input?.tag === "string" && input.tag) {
      clauses.push("EXISTS(SELECT 1 FROM json_each(a.tags) WHERE value=?)");
      params.push(input.tag.slice(0, 64));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.withDatabase(db => ({
      total: Number(db.prepare(`SELECT COUNT(*) AS total ${FROM} ${where}`).get(...params)!.total),
      records: db.prepare(`SELECT ${COLUMNS} ${FROM} ${where} ORDER BY a.pushed_at DESC,a.chat_id,a.run_id,a.artifact_id LIMIT ? OFFSET ?`).all(...params, limit, offset).map(decode),
      tags: db.prepare("SELECT DISTINCT value FROM artifacts,json_each(tags) ORDER BY value").all().map(r => String(r.value)),
      sync: { phase: "idle", completed: 0, total: 0, failed: 0, denied: 0 },
    }));
  }
}
