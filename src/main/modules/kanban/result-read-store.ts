import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "electron";
import type { KanbanListResult } from "../../../shared/contracts/kanban";
import { resolveKanbanResultIdentity } from "../../../shared/kanban-result-read";
import { getDesktopConfigRoot, getDataRoot } from "../../infrastructure/filesystem/user-paths";

export function kanbanReadScope(app: App, result: KanbanListResult) {
  let serverUrl = "";
  const configPath = path.join(getDesktopConfigRoot(app), "kanban.json");
  if (fs.existsSync(configPath)) serverUrl = JSON.parse(fs.readFileSync(configPath, "utf8")).cloud?.serverUrl || "";
  return JSON.stringify([result.currentUser?.id || "", process.env.DESKTOP_KANBAN_SERVER_URL?.trim() || serverUrl]);
}

export function kanbanReadScopeToken(scope: string) {
  return createHash("sha256").update(scope).digest("hex");
}

export function createKanbanResultReadStore(app: App, scope: string) {
  const hash = kanbanReadScopeToken(scope);
  const filename = path.join(getDataRoot(app), "state", "desktop", "kanban-read", `${hash}.json`);
  function read(): Record<string, string> {
    if (!fs.existsSync(filename)) return {};
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (value.schemaVersion !== 1 || !value.receipts || typeof value.receipts !== "object") throw new Error("Invalid Kanban read receipts");
    return value.receipts;
  }
  return {
    has(issueId: string, key: string) { return read()[issueId] === key; },
    mark(issueId: string, key: string) {
      const receipts = read();
      receipts[issueId] = key;
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, receipts }), "utf8");
      fs.renameSync(temporary, filename);
    },
    project(result: KanbanListResult): KanbanListResult {
      const receipts = read();
      return { ...result, issues: result.issues.map((issue) => {
        const identity = resolveKanbanResultIdentity(issue, result.cloudDetails);
        return { ...issue, resultRead: identity ? { key: identity.key, scope: hash, isRead: receipts[issue.id] === identity.key } : undefined };
      }) };
    }
  };
}

export function projectKanbanResultReads(app: App, result: KanbanListResult) {
  return createKanbanResultReadStore(app, kanbanReadScope(app, result)).project(result);
}
