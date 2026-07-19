import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), "utf8");

test("Kanban detail keeps the full cloud snapshot in shared contracts and SQLite cache", () => {
  const contracts = read("src", "shared", "contracts", "kanban.ts");
  const store = read("src", "main", "kanban-local-store.ts");
  assert.match(contracts, /interface KanbanCloudDetailData/);
  assert.match(contracts, /customFields\?: Record<string, unknown>/);
  assert.match(contracts, /parentIssueId\?: string \| null/);
  assert.match(contracts, /runResultMessage\?: string \| null/);
  assert.match(contracts, /cloudDetails\?: KanbanCloudDetailData/);
  assert.match(store, /DETAIL_JSON_ TEXT NOT NULL DEFAULT '\{\}'/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS kanban_cloud_detail_cache/);
  assert.match(store, /storeCloudDetailData\(db, currentUser, snapshot, revision\)/);
  assert.match(store, /const SYNC_CACHE_SCHEMA_VERSION = 3/);
});

test("Kanban detail opens independently from create and preserves the cloud read-only boundary", () => {
  const page = read("src", "renderer", "pages", "kanban", "KanbanPage.tsx");
  const detail = read("src", "renderer", "pages", "kanban", "KanbanIssueDetailDialog.tsx");
  assert.match(page, /setModal\(\{ mode: "create" \}\)/);
  assert.match(page, /const openEditModal = useCallback\(\(issue: KanbanIssue\) => \{[\s\S]{0,180}setDetailIssueId\(issue\.id\)/);
  assert.match(page, /<KanbanIssueDetailDialog/);
  assert.match(page, /onSave=\{\(draft\) => saveIssueDetail\(detailIssue, draft\)\}/);
  assert.match(page, /if \(!kanbanApi \|\| !canEditKanbanIssueBody\(issue\)\)/);
  assert.match(detail, /useState<DetailTab>\("all"\)/);
  assert.match(detail, /const showGroup = \(group:[\s\S]{0,100}activeTab === "all" \|\| activeTab === group/);
  assert.match(detail, /!isCloud \? <button[\s\S]{0,220}setEditing\(true\)/);
  assert.match(detail, /kanban\.detail\.cloudReadonly/);
  assert.doesNotMatch(detail, /"(?:issue\.(?:transition|assignRun|dispatchDesktop)|review\.comment\.|issueLabel\.|issue\.dependency\.)/);
});

test("Kanban dynamic fields use Website specificity rules and detail styles stay scoped", () => {
  const resolver = read("src", "renderer", "pages", "kanban", "issueFieldResolution.ts");
  const detail = read("src", "renderer", "pages", "kanban", "KanbanIssueDetailDialog.tsx");
  const styles = read("src", "renderer", "styles", "kanban.css");
  assert.match(resolver, /buildKanbanProjectDistances/);
  assert.match(resolver, /candidateRank\.specificity > currentRank\.specificity/);
  assert.match(resolver, /candidateDistance < currentDistance/);
  assert.match(resolver, /candidateRank\.dimension > currentRank\.dimension/);
  assert.match(detail, /valueType\.includes\("user"\)/);
  assert.match(detail, /valueType\.includes\("issue"\)/);
  assert.match(detail, /valueType\.includes\("select"\)/);
  assert.match(detail, /valueType === "json"/);
  assert.match(styles, /\.kanban-detail-body\s*\{[\s\S]{0,180}grid-template-columns: minmax\(0, 1fr\) 320px/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.kanban-detail-body \{ display: block/);
  assert.match(styles, /:root\[data-theme="dark"\] \.kanban-detail-layer/);
});
