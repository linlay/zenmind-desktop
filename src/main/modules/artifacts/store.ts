import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { App } from "electron";
import type { DesktopArtifactListInput, DesktopArtifactListResult, DesktopArtifactRecord } from "../../../shared/artifacts";
import { isAgentPlatformEpochMilliseconds } from "../../../shared/time-contract";
import { getDesktopRoot } from "../../infrastructure/filesystem/user-paths";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.length <= maxLength && !/[\u0000-\u001f]/u.test(value) ? value.trim() : "";
}

// Resource upload notifications share the same metadata index as published artifacts.
export function parseArtifactPush(value: unknown): DesktopArtifactRecord | null {
  const frame = record(value);
  if (!frame || frame.frame !== "push" || frame.type !== "resource.pushed") return null;
  const data = record(frame.data) ?? record(frame.payload) ?? frame;
  const chatId = text(data.chatId, 256);
  const artifactId = text(data.artifactId, 256);
  const name = text(data.name, 1024);
  if (!chatId || !artifactId || !name || !isAgentPlatformEpochMilliseconds(data.pushedAt) ||
      !Number.isSafeInteger(data.sizeBytes) || Number(data.sizeBytes) < 0) return null;
  return {
    chatId, artifactId, name,
    mimeType: text(data.mimeType, 256),
    sizeBytes: Number(data.sizeBytes),
    sha256: text(data.sha256, 256),
    pushedAt: data.pushedAt,
  };
}

export function getArtifactDatabasePath(app: App, platform: NodeJS.Platform = process.platform) {
  const root = getDesktopRoot(app, platform);
  // Honor Windows registered data roots, including drive-letter paths in cross-platform tests.
  if (platform === "win32" && path.win32.isAbsolute(root) && !path.posix.isAbsolute(root)) {
    return path.win32.join(root, "data", "artifacts.db");
  }
  return path.join(root, "data", "artifacts.db");
}

export class ArtifactStore {
  constructor(private readonly databasePath: () => string) {}

  ingestPublished(event: Record<string, unknown>): boolean {
    if (event.type !== "artifact.publish" || !Array.isArray(event.artifacts) ||
        !isAgentPlatformEpochMilliseconds(event.timestamp)) return false;
    let changed = false;
    for (const value of event.artifacts) {
      const artifact = record(value);
      if (!artifact) continue;
      const written = this.ingest({ frame: "push", type: "resource.pushed", data: {
        ...artifact, chatId: event.chatId, pushedAt: event.timestamp,
      } });
      changed = written || changed;
    }
    return changed;
  }

  private withDatabase<T>(read: (db: DatabaseSync) => T): T {
    const filename = this.databasePath();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    try {
      db.exec("PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;");
      db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
        chat_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        sha256 TEXT NOT NULL,
        pushed_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, artifact_id)
      );
      CREATE INDEX IF NOT EXISTS artifacts_pushed_at ON artifacts(pushed_at DESC, chat_id, artifact_id);`);
      return read(db);
    } finally { db.close(); }
  }

  ingest(frame: unknown): boolean {
    const item = parseArtifactPush(frame);
    if (!item) return false;
    return this.withDatabase((db) => {
      const result = db.prepare(`INSERT INTO artifacts
        (chat_id, artifact_id, name, mime_type, size_bytes, sha256, pushed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, artifact_id) DO UPDATE SET
          name=excluded.name, mime_type=excluded.mime_type, size_bytes=excluded.size_bytes,
          sha256=excluded.sha256, pushed_at=excluded.pushed_at
        WHERE excluded.pushed_at > artifacts.pushed_at`).run(
        item.chatId, item.artifactId, item.name, item.mimeType, item.sizeBytes, item.sha256, item.pushedAt,
      );
      return Number(result.changes) > 0;
    });
  }

  list(input: DesktopArtifactListInput = {}): DesktopArtifactListResult {
    const search = typeof input?.search === "string" ? input.search.trim().slice(0, 256) : "";
    const offset = Number.isSafeInteger(input?.offset) ? Math.max(0, Math.min(input.offset!, 1_000_000)) : 0;
    const limit = Number.isSafeInteger(input?.limit) ? Math.max(1, Math.min(input.limit!, 100)) : 50;
    const escaped = `%${search.replace(/[\\%_]/gu, "\\$&")}%`;
    const where = search ? "WHERE name LIKE ? ESCAPE '\\' OR chat_id LIKE ? ESCAPE '\\' OR artifact_id LIKE ? ESCAPE '\\' OR mime_type LIKE ? ESCAPE '\\'" : "";
    const params = search ? [escaped, escaped, escaped, escaped] : [];
    return this.withDatabase((db) => {
      const count = db.prepare(`SELECT COUNT(*) AS total FROM artifacts ${where}`).get(...params)!;
      const rows = db.prepare(`SELECT chat_id AS chatId, artifact_id AS artifactId, name,
        mime_type AS mimeType, size_bytes AS sizeBytes, sha256, pushed_at AS pushedAt
        FROM artifacts ${where} ORDER BY pushed_at DESC, chat_id, artifact_id LIMIT ? OFFSET ?`).all(...params, limit, offset);
      return { total: Number(count.total), records: rows as unknown as DesktopArtifactRecord[] };
    });
  }
}
