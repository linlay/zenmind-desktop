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
  assert.doesNotMatch(detail, /DetailTab|activeTab|showGroup|kanban-detail-tabs/);
  assert.match(detail, /!isCloud \? <button[\s\S]{0,220}setEditing\(true\)/);
  assert.match(detail, /kanban\.detail\.cloudReadonly/);
  assert.doesNotMatch(detail, /"(?:issue\.(?:transition|assignRun|dispatchDesktop)|review\.comment\.|issueLabel\.|issue\.dependency\.)/);
});

test("Kanban detail keeps content on the left and all remaining issue data on the right", () => {
  const resolver = read("src", "renderer", "pages", "kanban", "issueFieldResolution.ts");
  const detail = read("src", "renderer", "pages", "kanban", "KanbanIssueDetailDialog.tsx");
  const styles = read("src", "renderer", "styles", "kanban.css");
  const content = detail.slice(detail.indexOf('<main className="kanban-detail-content">'), detail.indexOf("</main>"));
  const rail = detail.slice(detail.indexOf('<aside className="kanban-detail-rail"'), detail.indexOf("</aside>"));
  assert.match(resolver, /buildKanbanProjectDistances/);
  assert.match(resolver, /candidateRank\.specificity > currentRank\.specificity/);
  assert.match(resolver, /candidateDistance < currentDistance/);
  assert.match(resolver, /candidateRank\.dimension > currentRank\.dimension/);
  assert.match(detail, /valueType\.includes\("user"\)/);
  assert.match(detail, /valueType\.includes\("issue"\)/);
  assert.match(detail, /valueType\.includes\("select"\)/);
  assert.match(detail, /valueType === "json"/);
  assert.match(content, /kanban-detail-issue-heading[\s\S]*kanban\.detail\.descriptionTitle[\s\S]*kanban\.detail\.attachmentsTitle[\s\S]*kanban\.detail\.commentsTitle/);
  assert.doesNotMatch(content, /kanban\.detail\.(?:customFieldsTitle|labelsTitle|subtasksTitle|dependenciesTitle|reviewsTitle|runsTitle|activityTitle|sourceTitle)/);
  assert.match(rail, /kanban\.detail\.scopeTitle[\s\S]*kanban\.detail\.peopleTitle[\s\S]*kanban\.detail\.customFieldsTitle[\s\S]*kanban\.detail\.labelsTitle[\s\S]*kanban\.detail\.automationTitle[\s\S]*kanban\.detail\.subtasksTitle[\s\S]*kanban\.detail\.dependenciesTitle[\s\S]*kanban\.detail\.reviewsTitle[\s\S]*kanban\.detail\.runsTitle[\s\S]*kanban\.detail\.activityTitle[\s\S]*kanban\.detail\.sourceTitle/);
  assert.match(styles, /\.kanban-detail-body\s*\{[\s\S]{0,180}grid-template-columns: minmax\(0, 3fr\) min\(40%, 320px\)/);
  assert.doesNotMatch(styles, /grid-template-columns: minmax\(0, 1fr\) 286px/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.kanban-detail-body \{ display: block/);
  assert.match(styles, /:root\[data-theme="dark"\] \.kanban-detail-layer/);
});
