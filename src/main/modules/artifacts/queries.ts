import type { DatabaseSync } from "node:sqlite";
import { ARTIFACT_CATEGORIES, type DesktopArtifactListInput, type DesktopArtifactListResult, type DesktopArtifactRecord } from "../../../shared/artifacts";
import { readArtifactFolders } from "./organization";

export const ARTIFACT_COLUMNS = `a.chat_id AS chatId,a.run_id AS runId,a.artifact_id AS artifactId,a.name,
  a.mime_type AS mimeType,a.size_bytes AS sizeBytes,a.sha256,a.pushed_at AS pushedAt,
  a.category,a.favorite,a.tags,a.content_state AS contentState,a.folder_id AS folderId,a.display_name AS displayName,
  COALESCE(c.source_state,'active') AS sourceState,COALESCE(c.access_state,'unknown') AS accessState,
  COALESCE(c.chat_name,'') AS chatName,COALESCE(c.agent_key,'') AS agentKey`;
export const ARTIFACT_FROM = "FROM artifacts a LEFT JOIN artifact_chats c ON a.chat_id=c.chat_id";
export function decodeArtifactRow(row: Record<string, unknown>): DesktopArtifactRecord {
  return { ...row, favorite: !!row.favorite, tags: JSON.parse(String(row.tags)) } as unknown as DesktopArtifactRecord;
}

export function readArtifactList(db: DatabaseSync, input: DesktopArtifactListInput = {}): DesktopArtifactListResult {
  const search = typeof input?.search === "string" ? input.search.trim().slice(0, 256) : "";
  const offset = Number.isSafeInteger(input?.offset) ? Math.max(0, Math.min(input.offset!, 1_000_000)) : 0;
  const limit = Number.isSafeInteger(input?.limit) ? Math.max(1, Math.min(input.limit!, 100)) : 50;
  const clauses: string[] = [], params: (string | number)[] = [];
  if (search) {
    clauses.push(`(a.name LIKE ? ESCAPE '\\' OR a.display_name LIKE ? ESCAPE '\\' OR a.chat_id LIKE ? ESCAPE '\\'
      OR a.artifact_id LIKE ? ESCAPE '\\' OR a.mime_type LIKE ? ESCAPE '\\' OR c.chat_name LIKE ? ESCAPE '\\'
      OR EXISTS(SELECT 1 FROM json_each(a.tags) WHERE value LIKE ? ESCAPE '\\'))`);
    params.push(...Array(7).fill(`%${search.replace(/[\\%_]/gu, "\\$&")}%`));
  }
  if (input?.favoritesOnly === true) clauses.push("a.favorite=1");
  const recentSince = Date.now() - 3 * 24 * 60 * 60 * 1000;
  if (input?.recent === true) { clauses.push("a.pushed_at>=?"); params.push(recentSince); }
  if (input?.folderId === null) clauses.push("a.folder_id IS NULL");
  else if (typeof input?.folderId === "string") { clauses.push("a.folder_id=?"); params.push(input.folderId.slice(0, 256)); }
  if (typeof input?.chatId === "string") { clauses.push("a.chat_id=?"); params.push(input.chatId.slice(0, 256)); }
  if (typeof input?.tag === "string" && input.tag) { clauses.push("EXISTS(SELECT 1 FROM json_each(a.tags) WHERE value=?)"); params.push(input.tag.slice(0, 64)); }
  const scopeWhere = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const scopeParams = [...params];
  if (ARTIFACT_CATEGORIES.includes(input?.category!)) { clauses.push("a.category=?"); params.push(input.category!); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const nameSort = "COALESCE(NULLIF(a.display_name,''),a.name) COLLATE NOCASE";
  const order = input?.sort === "name" ? `${nameSort},a.pushed_at DESC` : input?.sort === "type" ? `a.category,${nameSort},a.pushed_at DESC` : "a.pushed_at DESC";
  const counts = db.prepare(`SELECT COUNT(*) AS allCount,COALESCE(SUM(favorite),0) AS starred,
    COALESCE(SUM(folder_id IS NULL),0) AS unfiled,COALESCE(SUM(pushed_at>=?),0) AS recent FROM artifacts`).get(recentSince)!;
  const categories = Object.fromEntries(db.prepare(`SELECT a.category,COUNT(*) AS count ${ARTIFACT_FROM} ${scopeWhere} GROUP BY a.category`).all(...scopeParams).map(row => [String(row.category), Number(row.count)]));
  return {
    total: Number(db.prepare(`SELECT COUNT(*) AS total ${ARTIFACT_FROM} ${where}`).get(...params)!.total),
    records: db.prepare(`SELECT ${ARTIFACT_COLUMNS} ${ARTIFACT_FROM} ${where} ORDER BY ${order},a.chat_id,a.run_id,a.artifact_id LIMIT ? OFFSET ?`).all(...params, limit, offset).map(decodeArtifactRow),
    tags: db.prepare("SELECT DISTINCT value FROM artifacts,json_each(tags) ORDER BY value").all().map(row => String(row.value)),
    sync: { phase: "idle", completed: 0, total: 0, failed: 0, denied: 0 },
    folders: readArtifactFolders(db),
    counts: { all: Number(counts.allCount), starred: Number(counts.starred), unfiled: Number(counts.unfiled), recent: Number(counts.recent) },
    categories,
  };
}
