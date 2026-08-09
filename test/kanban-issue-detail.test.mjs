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
  const issueContract = contracts.slice(
    contracts.indexOf("export interface KanbanIssue {"),
    contracts.indexOf("export interface KanbanIssueInput")
  );
  assert.match(contracts, /interface KanbanCloudDetailData/);
  assert.match(contracts, /customFields\?: Record<string, unknown>/);
  assert.match(contracts, /parentIssueId\?: string \| null/);
  assert.match(contracts, /runResultMessage\?: string \| null/);
  assert.match(contracts, /cloudDetails\?: KanbanCloudDetailData/);
  assert.doesNotMatch(issueContract, /reviewerId|reviewRequired/);
  assert.match(store, /DETAIL_JSON_ TEXT NOT NULL DEFAULT '\{\}'/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS kanban_cloud_detail_cache/);
  assert.match(store, /storeCloudDetailData\(db, currentUser, snapshot, revision\)/);
  assert.match(store, /const SYNC_CACHE_SCHEMA_VERSION = 3/);
  assert.doesNotMatch(store, /(?:rawIssue|input|issue|row)\.(?:reviewerId|reviewRequired|reviewer_id|review_required)/);
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
  assert.match(detail, /useState\(!isCloud && Boolean\(initialEditStatus\)\)/);
  assert.match(detail, /P0: "kanban\.priority\.p0"[\s\S]{0,180}P3: "kanban\.priority\.p3"/);
  assert.match(detail, /kanban\.importance\.\$\{issue\.severity\}/);
  assert.match(detail, /id="kanban-detail-title"[\s\S]{0,160}disabled=\{!editing\}/);
  assert.match(detail, /kanban-detail-description-editor[\s\S]{0,160}disabled=\{!editing\}/);
  assert.match(detail, /!isCloud \? <button[\s\S]{0,180}setEditing\(true\)/);
  assert.match(detail, /if \(await onSave\(draft\)\) setEditing\(false\)/);
  assert.match(detail, /kanban\.detail\.cloudReadonly/);
  assert.doesNotMatch(detail, /issue\.reviewerId|kanban\.detail\.reviewer/);
  assert.doesNotMatch(detail, /kanban-detail-footer|const editing = !isCloud/);
  assert.doesNotMatch(detail, /"(?:issue\.(?:transition|assignRun|dispatchDesktop)|review\.comment\.|issueLabel\.|issue\.dependency\.)/);
});

test("Kanban detail keeps content on the left and all remaining issue data on the right", () => {
  const resolver = read("src", "renderer", "pages", "kanban", "issueFieldResolution.ts");
  const detail = read("src", "renderer", "pages", "kanban", "KanbanIssueDetailDialog.tsx");
  const styles = read("src", "renderer", "styles", "kanban.css");
  const content = detail.slice(detail.indexOf('<main className="kanban-detail-content">'), detail.indexOf("</main>"));
  const rail = detail.slice(detail.indexOf('<aside className="kanban-detail-rail"'), detail.indexOf("</aside>"));
  const header = detail.slice(detail.indexOf('<header className="kanban-detail-header">'), detail.indexOf('<div className="kanban-detail-body">'));
  const scope = rail.slice(rail.indexOf('sectionId="kanban-detail-scope"'), rail.indexOf('sectionId="kanban-detail-people"'));
  assert.match(resolver, /buildKanbanProjectDistances/);
  assert.match(resolver, /candidateRank\.specificity > currentRank\.specificity/);
  assert.match(resolver, /candidateDistance < currentDistance/);
  assert.match(resolver, /candidateRank\.dimension > currentRank\.dimension/);
  assert.match(detail, /valueType\.includes\("user"\)/);
  assert.match(detail, /valueType\.includes\("issue"\)/);
  assert.match(detail, /valueType\.includes\("select"\)/);
  assert.match(detail, /valueType === "json"/);
  assert.match(detail, /function DetailProperty[\s\S]{0,700}kanban-detail-property-editor[\s\S]{0,200}kanban-detail-property-value/);
  assert.match(content, /kanban-detail-issue-heading[\s\S]*kanban\.detail\.descriptionTitle[\s\S]*kanban\.detail\.attachmentsTitle[\s\S]*kanban\.detail\.commentsTitle/);
  assert.match(header, /kanban-detail-breadcrumb[\s\S]*kanban\.detail\.cloudOrigin/);
  assert.doesNotMatch(header, /kanban-detail-kicker|DETAIL_STATUS_LABELS|DETAIL_PRIORITY_LABELS|kanban\.detail\.localOrigin/);
  assert.match(detail, /```mermaid/);
  assert.match(detail, /shell\.openExternal\(attachment\.url\)/);
  assert.doesNotMatch(detail, /description=\{t\("kanban\.detail\./);
  assert.doesNotMatch(content, /kanban\.detail\.(?:customFieldsTitle|labelsTitle|subtasksTitle|dependenciesTitle|reviewsTitle|runsTitle|activityTitle|sourceTitle)/);
  assert.match(rail, /kanban-detail-anchor-nav[\s\S]*kanban\.detail\.scopeTitle[\s\S]*kanban\.detail\.peopleTitle[\s\S]*kanban\.detail\.automationTitle[\s\S]*kanban\.detail\.relatedTitle[\s\S]*kanban\.detail\.runsTitle[\s\S]*kanban\.detail\.activityTitle[\s\S]*kanban\.detail\.sourceTitle/);
  assert.match(scope, /kanban\.detail\.issueId[\s\S]*kanban\.detail\.labelsTitle[\s\S]*resolvedFields\.map/);
  assert.doesNotMatch(rail, /kanban\.detail\.customFieldsTitle|kanban\.detail\.noCustomFields/);
  assert.match(styles, /\.kanban-detail-dialog\s*\{[\s\S]{0,180}width: min\(1062px, calc\(90vw - 43\.2px\)\);[\s\S]{0,80}height: min\(81vh, 738px\);[\s\S]{0,80}min-height: 558px/);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]{0,180}\.kanban-detail-dialog \{ min-height: 0; \}/);
  assert.match(styles, /\.kanban-detail-layer\s*\{[\s\S]{0,760}background: rgba\(22, 29, 40, 0\.16\);[\s\S]{0,100}backdrop-filter: none/);
  assert.match(styles, /:root\[data-theme="dark"\] \.kanban-detail-layer\s*\{[\s\S]{0,760}background: rgba\(3, 5, 8, 0\.32\)/);
  assert.match(styles, /\.kanban-detail-body\s*\{[\s\S]{0,180}grid-template-columns: minmax\(0, 1fr\) 280px/);
  assert.match(styles, /\.kanban-detail-properties > div \{[^\n]*grid-template-columns: minmax\(72px, 42%\) minmax\(0, 1fr\)/);
  assert.match(detail, /function resizeTextareaToContent[\s\S]{0,320}scrollHeight \+ borderHeight/);
  assert.match(detail, /useLayoutEffect\(\(\) => \{[\s\S]{0,140}resizeTextareaToContent\(descriptionEditorRef\.current\)[\s\S]{0,80}\[draft\.description, editing\]/);
  assert.match(detail, /new ResizeObserver[\s\S]{0,360}resizeTextareaToContent\(textarea\)/);
  assert.match(detail, /<textarea ref=\{descriptionEditorRef\}/);
  assert.match(styles, /\.kanban-detail-description-editor \{[^\n]*min-height: 120px;[^\n]*overflow-y: hidden; resize: none/);
  assert.match(styles, /\.kanban-detail-description-editor\.is-editing \{ min-height: 200px; \}/);
  assert.doesNotMatch(styles, /\.kanban-detail-description-editor(?:\.is-editing)? \{[^\n]*(?<!-)height:/);
  assert.match(styles, /\.kanban-detail-title-input \{[\s\S]{0,260}font-size: clamp\(17px, 1\.35vw, 20px\)/);
  assert.match(styles, /\.kanban-detail-anchor-nav \{[\s\S]{0,100}position: sticky;[\s\S]{0,80}top: 0/);
  assert.match(styles, /\.kanban-detail-section \{[\s\S]{0,260}border: 0;[\s\S]{0,120}border-bottom: 1px solid var\(--detail-line-subtle\)/);
  assert.match(styles, /\.kanban-detail-rail \{[^\n]*border-left: 1px solid var\(--detail-line-subtle\)/);
  assert.match(styles, /\.kanban-detail-property-editor select/);
  assert.match(styles, /\.kanban-detail-title-input:disabled \{[\s\S]{0,100}border-color: transparent/);
  assert.doesNotMatch(styles, /grid-template-columns: minmax\(0, 1fr\) 286px/);
  assert.doesNotMatch(styles, /\.kanban-detail-footer/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.kanban-detail-body \{ display: block/);
  assert.match(styles, /:root\[data-theme="dark"\] \.kanban-detail-layer/);
});
