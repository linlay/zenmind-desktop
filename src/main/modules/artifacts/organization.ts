import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DesktopArtifactBatchInput, DesktopArtifactFolder, DesktopArtifactFolderInput, DesktopArtifactMutationResult } from "../../../shared/artifacts";
import { cleanText, validIdentity } from "./metadata";

const MAX_DEPTH = 20;
const fail = (error: Exclude<DesktopArtifactMutationResult, { ok: true }>["error"]): DesktopArtifactMutationResult => ({ ok: false, error });

export function readArtifactFolders(db: DatabaseSync): DesktopArtifactFolder[] {
  const rows = db.prepare("SELECT id,parent_id AS parentId,name FROM artifact_folders ORDER BY name COLLATE NOCASE,id").all();
  const folders = rows.map(row => ({ ...row, directCount: 0, totalCount: 0, childCount: 0 })) as unknown as DesktopArtifactFolder[];
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  for (const folder of folders) {
    if (folder.parentId) {
      const parent = byId.get(folder.parentId);
      if (parent) parent.childCount++;
    }
  }
  for (const row of db.prepare("SELECT folder_id,COUNT(*) AS count FROM artifacts WHERE folder_id IS NOT NULL GROUP BY folder_id").all()) {
    const folder = byId.get(String(row.folder_id));
    if (!folder) continue;
    folder.directCount = Number(row.count);
    let current: DesktopArtifactFolder | undefined = folder;
    const seen = new Set<string>();
    while (current && !seen.has(current.id) && seen.size < MAX_DEPTH) {
      seen.add(current.id);
      current.totalCount += Number(row.count);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return folders;
}

export function mutateArtifactFolder(db: DatabaseSync, input: DesktopArtifactFolderInput): DesktopArtifactMutationResult {
  if (!input || !["create", "rename", "delete"].includes(input.action)) return fail("invalid_request");
  if (input.action !== "create" && (!cleanText(input.id) || !db.prepare("SELECT 1 FROM artifact_folders WHERE id=?").get(input.id))) return fail("folder_missing");
  if (input.action === "delete") {
    if (db.prepare("SELECT 1 FROM artifact_folders WHERE parent_id=?").get(input.id) ||
        db.prepare("SELECT 1 FROM artifacts WHERE folder_id=?").get(input.id)) return fail("folder_not_empty");
    db.prepare("DELETE FROM artifact_folders WHERE id=?").run(input.id);
    return { ok: true };
  }
  const name = cleanText(input.name, 64);
  if (!name) return fail("invalid_name");
  const parentId = input.action === "create" ? input.parentId : db.prepare("SELECT parent_id FROM artifact_folders WHERE id=?").get(input.id)!.parent_id;
  if (parentId !== null && (typeof parentId !== "string" || !db.prepare("SELECT 1 FROM artifact_folders WHERE id=?").get(parentId))) return fail("folder_missing");
  if (input.action === "create") {
    let current = parentId, depth = 1;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current) || ++depth > MAX_DEPTH) return fail("folder_depth");
      seen.add(current);
      const parent = db.prepare("SELECT parent_id FROM artifact_folders WHERE id=?").get(current);
      current = parent?.parent_id as string | null;
    }
  }
  const duplicate = db.prepare("SELECT id FROM artifact_folders WHERE parent_id IS ? AND name=? COLLATE NOCASE").get(parentId!, name);
  if (duplicate && (input.action === "create" || duplicate.id !== input.id)) return fail("duplicate_name");
  if (input.action === "create") db.prepare("INSERT INTO artifact_folders(id,parent_id,name) VALUES(?,?,?)").run(randomUUID(), parentId!, name);
  else db.prepare("UPDATE artifact_folders SET name=? WHERE id=?").run(name, input.id);
  return { ok: true };
}

export function organizeArtifactBatch(db: DatabaseSync, input: DesktopArtifactBatchInput): DesktopArtifactMutationResult {
  if (!input || !Array.isArray(input.items) || !input.items.length || input.items.length > 100 || input.items.some(item => !validIdentity(item)) ||
      (input.favorite !== undefined && typeof input.favorite !== "boolean") ||
      (input.folderId === undefined && input.favorite === undefined)) return fail("invalid_request");
  if (input.folderId !== undefined && input.folderId !== null &&
      (typeof input.folderId !== "string" || !db.prepare("SELECT 1 FROM artifact_folders WHERE id=?").get(input.folderId))) return fail("folder_missing");
  // Validate the whole selection before changing anything, including deletion during a move dialog.
  for (const item of input.items) {
    if (!db.prepare("SELECT 1 FROM artifacts WHERE chat_id=? AND run_id=? AND artifact_id=?").get(item.chatId, item.runId, item.artifactId)) return fail("items_missing");
  }
  for (const item of input.items) {
    if (input.folderId !== undefined) db.prepare("UPDATE artifacts SET folder_id=? WHERE chat_id=? AND run_id=? AND artifact_id=?").run(input.folderId, item.chatId, item.runId, item.artifactId);
    if (input.favorite !== undefined) db.prepare("UPDATE artifacts SET favorite=? WHERE chat_id=? AND run_id=? AND artifact_id=?").run(Number(input.favorite), item.chatId, item.runId, item.artifactId);
  }
  return { ok: true };
}
