import type { KanbanCloudDetailData, KanbanCurrentUser } from "../../../shared/contracts";
import { parseJsonRecord, parseCloudIssue, trimText, nowIso } from "./store-values";
import { DatabaseSync } from "node:sqlite";
import type { KanbanCloudSnapshot } from "./store-model";

export function emptyCloudDetailData(): KanbanCloudDetailData {
  return {
    users: [],
    issueTypes: [],
    issueFieldDefs: [],
    issueFieldContexts: [],
    issueFieldOptions: [],
    workflows: [],
    workflowStageDefs: [],
    workflowStatusDefs: [],
    workflowStages: [],
    workflowStatuses: [],
    workflowTransitions: [],
    workflowDecomposeRules: [],
    teams: [],
    teamMembers: [],
    projectPermissions: [],
    issueLabels: [],
    issueLabelLinks: [],
    issueDependencies: [],
    reviews: [],
    issueStageWorkers: [],
    issueChats: [],
    issueRuns: [],
    issueComments: [],
    recentEvents: []
  };
}

export const CLOUD_DETAIL_KEYS = [
  "users",
  "issueTypes",
  "issueFieldDefs",
  "issueFieldContexts",
  "issueFieldOptions",
  "workflows",
  "workflowStageDefs",
  "workflowStatusDefs",
  "workflowStages",
  "workflowStatuses",
  "workflowTransitions",
  "workflowDecomposeRules",
  "teams",
  "teamMembers",
  "projectPermissions",
  "issueLabels",
  "issueLabelLinks",
  "issueDependencies",
  "reviews",
  "issueStageWorkers",
  "issueChats",
  "issueRuns",
  "issueComments",
  "recentEvents"
] as const satisfies ReadonlyArray<keyof KanbanCloudDetailData>;

export function parseCloudDetailData(value: string | null | undefined): KanbanCloudDetailData {
  const record = parseJsonRecord(value);
  const detail = emptyCloudDetailData();
  for (const key of CLOUD_DETAIL_KEYS) {
    if (Array.isArray(record[key])) {
      (detail[key] as unknown[]) = record[key] as unknown[];
    }
  }
  return detail;
}

export function detailItemKey(key: keyof KanbanCloudDetailData, item: unknown, index: number) {
  const record = parseCloudIssue(item);
  if (!record) return `${key}:${index}`;
  if (key === "issueTypes") return trimText(record.key) || `${key}:${index}`;
  if (key === "teamMembers") return `${trimText(record.teamId)}:${trimText(record.userId)}`;
  if (key === "issueLabelLinks") return `${trimText(record.issueId)}:${trimText(record.labelId)}`;
  return String(record.id ?? `${key}:${index}`);
}

export function mergeCloudDetailArray(key: keyof KanbanCloudDetailData, current: unknown[], incoming: unknown[]) {
  const merged = new Map(current.map((item, index) => [detailItemKey(key, item, index), item]));
  incoming.forEach((item, index) => merged.set(detailItemKey(key, item, index), item));
  return [...merged.values()];
}

export function selectCloudDetailData(db: DatabaseSync, currentUser: KanbanCurrentUser): KanbanCloudDetailData {
  const row = db.prepare(`
    SELECT PAYLOAD_JSON_ AS payloadJson
    FROM kanban_cloud_detail_cache
    WHERE OWNER_USER_ID_ = ?
  `).get(currentUser.id) as { payloadJson?: string } | undefined;
  return parseCloudDetailData(row?.payloadJson);
}

export function storeCloudDetailData(
  db: DatabaseSync,
  currentUser: KanbanCurrentUser,
  snapshot: KanbanCloudSnapshot,
  revision: number
) {
  const replace = snapshot.complete === true && snapshot.scope === "project_set";
  const current = replace ? emptyCloudDetailData() : selectCloudDetailData(db, currentUser);
  for (const key of CLOUD_DETAIL_KEYS) {
    const incoming = snapshot[key];
    if (replace) {
      (current[key] as unknown[]) = Array.isArray(incoming) ? incoming : [];
    } else if (Array.isArray(incoming)) {
      (current[key] as unknown[]) = mergeCloudDetailArray(key, current[key] as unknown[], incoming);
    }
  }
  db.prepare(`
    INSERT INTO kanban_cloud_detail_cache (OWNER_USER_ID_, REVISION_, PAYLOAD_JSON_, UPDATED_AT_)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(OWNER_USER_ID_) DO UPDATE SET
      REVISION_ = excluded.REVISION_,
      PAYLOAD_JSON_ = excluded.PAYLOAD_JSON_,
      UPDATED_AT_ = excluded.UPDATED_AT_
  `).run(currentUser.id, revision, JSON.stringify(current), nowIso());
}
