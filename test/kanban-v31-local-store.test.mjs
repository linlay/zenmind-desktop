import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const {
  applyDesktopKanbanCloudSnapshot,
  createPrivateDesktopKanbanIssue,
  deleteDesktopKanbanIssue,
  getDesktopKanbanDatabasePath,
  getDesktopKanbanManualRunByRunId,
  listDesktopKanbanCloudMutations,
  listDesktopKanbanIssues,
  listDesktopKanbanRunEvents,
  listPendingDesktopKanbanCommandReceipts,
  moveDesktopKanbanIssue,
  recordDesktopKanbanCloudMutation,
  recordDesktopKanbanCommandReceipt,
  recordDesktopKanbanManualRun,
  recordDesktopKanbanRunEvent,
  updateDesktopKanbanIssue,
  upsertDispatchedDesktopKanbanIssue
} = await import("../dist-electron/main/kanban-local-store.js");

const currentUser = { id: "user-1", name: "User One", email: "user@example.test", source: "test" };

function createTempApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-kanban-v31-"));
  const app = {
    getPath(name) {
      if (name === "home") return path.join(root, "home");
      if (name === "appData") return path.join(root, "app-data");
      throw new Error(`unexpected app path: ${name}`);
    }
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return app;
}

function cloudIssue(overrides = {}) {
  return {
    id: "cloud-issue-1",
    projectId: "cloud-project-1",
    workflowId: "workflow-standard-requirement",
    title: "Cloud task",
    description: "",
    status: "todo",
    priority: "P2",
    severity: "medium",
    position: 1,
    revision: 50,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides
  };
}

test("private issue IDs use the short local-prefixed Server base36 format", (t) => {
  const app = createTempApp(t);
  const fixedNow = 1_786_588_420_234;
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  let first;
  let second;
  try {
    first = createPrivateDesktopKanbanIssue(app, currentUser, { title: "First private issue" });
    second = createPrivateDesktopKanbanIssue(app, currentUser, { title: "Second private issue" });
  } finally {
    Date.now = originalDateNow;
  }

  const tick = Math.floor(fixedNow / 100);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.issue.id, `local-${tick.toString(36).toUpperCase()}`);
  assert.equal(second.issue.id, `local-${(tick + 1).toString(36).toUpperCase()}`);
  assert.match(first.issue.id, /^local-[0-9A-Z]+$/);
});

test("Desktop cloud mutation, run event, and manual run receipts persist idempotently", (t) => {
  const app = createTempApp(t);
  recordDesktopKanbanCloudMutation(app, currentUser, {
    id: "mutation-claim-1",
    requestType: "issue.claim",
    projectId: "cloud-project-1",
    issueId: "cloud-issue-1",
    payload: { id: "cloud-issue-1", baseIssueRevision: 12 }
  });
  recordDesktopKanbanCloudMutation(app, currentUser, {
    id: "mutation-claim-1",
    requestType: "issue.claim",
    projectId: "cloud-project-1",
    issueId: "cloud-issue-1",
    payload: { id: "cloud-issue-1", baseIssueRevision: 99 }
  });
  assert.deepEqual(listDesktopKanbanCloudMutations(app, currentUser).map((item) => ({ id: item.id, payload: item.payload })), [{
    id: "mutation-claim-1",
    payload: { id: "cloud-issue-1", baseIssueRevision: 12 }
  }]);

  recordDesktopKanbanRunEvent(app, currentUser, {
    clientEventId: "device-1:cloud-issue-1:run-1:run.started",
    projectId: "cloud-project-1",
    issueId: "cloud-issue-1",
    runId: "run-1",
    chatId: "chat-1",
    eventType: "run.started",
    sourceDeliverySeq: 0,
    payload: { source: "desktop_manual", agentKey: "codeAssistant" }
  });
  recordDesktopKanbanRunEvent(app, currentUser, {
    clientEventId: "device-1:cloud-issue-1:run-1:run.started",
    projectId: "cloud-project-1",
    issueId: "cloud-issue-1",
    runId: "run-1",
    chatId: "chat-1",
    eventType: "run.started",
    sourceDeliverySeq: 0,
    payload: { source: "desktop_manual", agentKey: "different-agent" }
  });
  const events = listDesktopKanbanRunEvents(app, currentUser);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.agentKey, "codeAssistant");

  recordDesktopKanbanManualRun(app, currentUser, {
    runId: "run-1",
    chatId: "chat-1",
    issueId: "cloud-issue-1",
    projectId: "cloud-project-1",
    agentKey: "codeAssistant"
  });
  assert.deepEqual({ ...getDesktopKanbanManualRunByRunId(app, currentUser, "run-1") }, {
    runId: "run-1",
    chatId: "chat-1",
    issueId: "cloud-issue-1",
    projectId: "cloud-project-1",
    agentKey: "codeAssistant",
    state: "starting",
    lastError: null
  });
});

test("priority uses P0-P3 and only normalizes legacy values at the cache boundary", (t) => {
  const app = createTempApp(t);
  applyDesktopKanbanCloudSnapshot(app, currentUser, {
    scope: "project_set",
    complete: true,
    projectIds: ["cloud-project-1"],
    lastSeq: 40,
    projects: [],
    issues: [cloudIssue({ priority: "P0" })]
  });

  const cached = listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1");
  assert.equal(cached?.priority, "P0");

  const legacy = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({
    priority: "high",
    revision: 41
  }), 41);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.issue.priority, "P1");
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1")?.priority,
    "P1"
  );

  const urgent = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({
    priority: "urgent",
    revision: 42
  }), 42);
  assert.equal(urgent.issue.priority, "P0");

  const local = createPrivateDesktopKanbanIssue(app, currentUser, { title: "Optional priority" });
  assert.equal(local.ok, true);
  assert.equal(local.issue.priority, null);
  assert.equal(local.issue.severity, null);
});

test("project catalogs and new issue fields survive snapshots, incremental upserts, and private updates", (t) => {
  const app = createTempApp(t);
  applyDesktopKanbanCloudSnapshot(app, currentUser, {
    scope: "project_set",
    complete: true,
    projectIds: ["cloud-project-1"],
    lastSeq: 45,
    projects: [{
      id: "cloud-project-1",
      name: "Cloud Project",
      slug: "cloud-project-1",
      versions: ["1.0.0", "2.0.0"],
      components: ["desktop", "sync"],
      path: "default/cloud-project-1",
      depth: 1,
      position: 1,
      revision: 44,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }],
    workflowStages: [{
      id: "stage-development",
      workflowId: "workflow-standard-requirement",
      key: "development",
      name: "Development",
      color: "#7c3aed",
      position: 1
    }],
    issues: [cloudIssue({
      projectVersion: "2.0.0",
      dueDate: "2026-07-12",
      dueRisk: "high",
      resolution: "fixed",
      securityLevelKey: "internal",
      reporterId: "user-1",
      componentKeys: ["desktop", "sync"],
      originalEstimate: 7200,
      remainingEstimate: 3600,
      timeSpent: 1800
    })]
  });

  const cached = listDesktopKanbanIssues(app, currentUser);
  assert.deepEqual(cached.projects.find((project) => project.id === "cloud-project-1")?.versions, ["1.0.0", "2.0.0"]);
  assert.deepEqual(cached.projects.find((project) => project.id === "cloud-project-1")?.components, ["desktop", "sync"]);
  assert.equal(cached.cloudDetails.workflowStages[0]?.color, "#7c3aed");
  const cachedCloudIssue = cached.issues.find((issue) => issue.remoteIssueId === "cloud-issue-1");
  assert.equal(cachedCloudIssue?.projectVersion, "2.0.0");
  assert.equal(cachedCloudIssue?.dueDate, "2026-07-12");
  assert.equal(cachedCloudIssue?.dueRisk, "high");
  assert.equal(cachedCloudIssue?.resolution, "fixed");
  assert.equal(cachedCloudIssue?.securityLevelKey, "internal");
  assert.equal(cachedCloudIssue?.reporterId, "user-1");
  assert.deepEqual(cachedCloudIssue?.componentKeys, ["desktop", "sync"]);
  assert.deepEqual(
    [cachedCloudIssue?.originalEstimate, cachedCloudIssue?.remainingEstimate, cachedCloudIssue?.timeSpent],
    [7200, 3600, 1800]
  );
  const rejectedCloudWrite = updateDesktopKanbanIssue(app, currentUser, cachedCloudIssue.id, {
    dueDate: "2026-07-30",
    projectVersion: "1.0.0",
    componentKeys: []
  });
  assert.equal(rejectedCloudWrite.ok, false);
  assert.equal(moveDesktopKanbanIssue(app, currentUser, {
    id: cachedCloudIssue.id,
    status: "in_progress",
    position: 2
  }).ok, false);
  assert.equal(deleteDesktopKanbanIssue(app, currentUser, cachedCloudIssue.id).ok, false);
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.id === cachedCloudIssue.id)?.dueDate,
    "2026-07-12"
  );

  const local = createPrivateDesktopKanbanIssue(app, currentUser, {
    title: "Local versioned task",
    projectId: "cloud-project-1",
    version: "1.0.0",
    dueDate: "2026-08-01",
    priority: "urgent",
    severity: "critical",
    resolution: "planned",
    securityLevelKey: "private",
    reporterId: "user-1",
    componentKeys: ["desktop"],
    originalEstimate: 3600.9,
    remainingEstimate: 2400,
    timeSpent: 1200
  });
  assert.equal(local.ok, true);
  assert.equal(local.issue.projectVersion, "1.0.0");
  assert.equal(local.issue.priority, "P0");
  assert.equal(local.issue.originalEstimate, 3600);
  assert.equal(local.issue.dueRisk, null);
  const updated = updateDesktopKanbanIssue(app, currentUser, local.issue.id, {
    projectVersion: null,
    dueDate: null,
    priority: null,
    severity: null,
    componentKeys: ["sync"],
    originalEstimate: 0,
    remainingEstimate: 0,
    timeSpent: 3600
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.issue.projectVersion, null);
  assert.equal(updated.issue.dueDate, null);
  assert.equal(updated.issue.priority, null);
  assert.equal(updated.issue.severity, null);
  assert.deepEqual(updated.issue.componentKeys, ["sync"]);
  assert.equal(listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.id === local.issue.id)?.timeSpent, 3600);

  const incremental = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({
    revision: 51,
    projectVersion: "1.0.0",
    dueDate: null,
    dueTime: "2026-09-30T18:00:00+08:00",
    dueRisk: "medium",
    componentKeys: ["sync"],
    originalEstimate: 100.8,
    remainingEstimate: 50.2,
    timeSpent: 50.9
  }), 51);
  assert.equal(incremental.ok, true);
  assert.equal(incremental.issue.projectVersion, "1.0.0");
  assert.equal(incremental.issue.dueDate, null);
  assert.equal(incremental.issue.dueRisk, "medium");
  assert.deepEqual(incremental.issue.componentKeys, ["sync"]);
  assert.deepEqual(
    [incremental.issue.originalEstimate, incremental.issue.remainingEstimate, incremental.issue.timeSpent],
    [100, 50, 50]
  );
  assert.deepEqual(
    listDesktopKanbanIssues(app, currentUser).projects.find((project) => project.id === "cloud-project-1")?.components,
    ["desktop", "sync"]
  );

  const invalidDate = createPrivateDesktopKanbanIssue(app, currentUser, { title: "Invalid date", dueDate: "2026-02-30" });
  assert.equal(invalidDate.ok, false);
});

test("legacy priority rows migrate to the P0-P3 SQLite constraint", (t) => {
  const app = createTempApp(t);
  const databasePath = getDesktopKanbanDatabasePath(app);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`
    CREATE TABLE issue (
      ID_ TEXT PRIMARY KEY,
      REMOTE_ISSUE_ID_ TEXT,
      BOARD_ID_ TEXT NOT NULL DEFAULT 'default',
      PROJECT_ID_ TEXT NOT NULL DEFAULT 'default',
      WORKFLOW_ID_ TEXT NOT NULL DEFAULT 'workflow-standard-requirement',
      TYPE_ID_ TEXT,
      STAGE_ID_ TEXT,
      STAGE_NAME_ TEXT,
      STATUS_ID_ TEXT,
      STATUS_NAME_ TEXT,
      TITLE_ TEXT NOT NULL,
      DESCRIPTION_ TEXT NOT NULL DEFAULT '',
      STATUS_ TEXT NOT NULL,
      PRIORITY_ TEXT NOT NULL CHECK (PRIORITY_ IN ('high','medium','low')),
      SEVERITY_ TEXT NOT NULL DEFAULT 'medium',
      POSITION_ REAL NOT NULL,
      ASSIGNEE_AGENT_KEY_ TEXT,
      ASSIGNEE_ID_ TEXT,
      WORKER_TYPE_ TEXT,
      WORKER_ID_ TEXT,
      WORKER_AGENT_ TEXT,
      REVIEWER_ID_ TEXT,
      REVIEW_REQUIRED_ INTEGER NOT NULL DEFAULT 0,
      ACTIVE_REVIEW_ID_ TEXT,
      ACTIVE_RUN_ID_ TEXT,
      CHAT_ID_ TEXT,
      RUN_ID_ TEXT,
      RUN_STATE_ TEXT,
      DISPATCH_STATE_ TEXT,
      DISPATCH_DEVICE_ID_ TEXT,
      DISPATCH_COMMAND_ID_ TEXT,
      DISPATCH_UPDATED_AT_ TEXT,
      AUTOMATION_ID_ TEXT,
      AUTOMATION_ENABLED_ INTEGER NOT NULL DEFAULT 0,
      AUTOMATION_CRON_ TEXT,
      AUTOMATION_MESSAGE_ TEXT,
      AUTOMATION_TIMEZONE_ TEXT,
      ATTACHMENT_CHAT_ID_ TEXT,
      ATTACHMENTS_JSON_ TEXT NOT NULL DEFAULT '[]',
      DETAIL_JSON_ TEXT NOT NULL DEFAULT '{}',
      REVISION_ INTEGER NOT NULL DEFAULT 0,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );
    INSERT INTO issue (
      ID_, TITLE_, DESCRIPTION_, STATUS_, PRIORITY_, SEVERITY_, POSITION_, CREATED_AT_, UPDATED_AT_
    ) VALUES (
      'legacy-issue', 'Legacy priority', '', 'backlog', 'high', 'medium', 1,
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'
    );
    UPDATE issue SET DETAIL_JSON_ = '{"version":"1.4.0","dueTime":"2026-07-18T18:00:00+08:00"}' WHERE ID_ = 'legacy-issue';
  `);
  legacyDb.close();

  listDesktopKanbanIssues(app, currentUser);

  const migratedDb = new DatabaseSync(databasePath);
  assert.equal(migratedDb.prepare("SELECT PRIORITY_ AS priority FROM issue WHERE ID_ = 'legacy-issue'").get().priority, "P1");
  const schema = migratedDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issue'").get().sql;
  assert.match(schema, /PRIORITY_ IN \('P0','P1','P2','P3'\)/);
  assert.doesNotMatch(schema, /PRIORITY_ IN \('high','medium','low'\)/);
  const migratedDetail = JSON.parse(migratedDb.prepare("SELECT DETAIL_JSON_ AS detail FROM issue WHERE ID_ = 'legacy-issue'").get().detail);
  assert.equal(migratedDetail.projectVersion, "1.4.0");
  assert.equal(migratedDetail.dueDate, "2026-07-18");
  assert.equal("version" in migratedDetail, false);
  assert.equal("dueTime" in migratedDetail, false);
  migratedDb.close();
});

test("project-set replacement removes cloud cache and preserves private issues", (t) => {
  const app = createTempApp(t);
  applyDesktopKanbanCloudSnapshot(app, currentUser, {
    scope: "project_set",
    complete: true,
    projectIds: ["cloud-project-1"],
    lastSeq: 50,
    projects: [{
      id: "cloud-project-1",
      name: "Cloud Project",
      slug: "cloud-project-1",
      path: "default/cloud-project-1",
      depth: 1,
      position: 1,
      revision: 49,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }],
    projectBindings: [{
      id: "server-binding-1",
      projectId: "cloud-project-1",
      deviceId: "device-1",
      currentUserId: "user-1",
      localProjectId: "default",
      localDisplayName: "默认项目",
      controlMode: "execute",
      status: "active",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }],
    issues: [cloudIssue()]
  });
  const local = createPrivateDesktopKanbanIssue(app, currentUser, {
    title: "Private task",
    projectId: "cloud-project-1"
  });
  assert.equal(local.ok, true);

  applyDesktopKanbanCloudSnapshot(app, currentUser, {
    scope: "project_set",
    complete: true,
    projectIds: [],
    lastSeq: 60,
    projects: [],
    issues: []
  });

  const list = listDesktopKanbanIssues(app, currentUser);
  assert.equal(list.issues.some((issue) => issue.remoteIssueId === "cloud-issue-1"), false);
  const privateIssue = list.issues.find((issue) => issue.title === "Private task");
  assert.ok(privateIssue);
  assert.equal(privateIssue.syncMode, "private");
  assert.equal(privateIssue.projectId, "local-private-orphans");
  assert.equal(list.projects.some((project) => project.id === "cloud-project-1"), false);
  assert.equal(list.projectBindings.length, 0);
});

test("command receipt deduplicates stable command IDs and rejects payload drift", (t) => {
  const app = createTempApp(t);
  const payload = { issue: cloudIssue(), agentKey: "codeAssistant", message: "run once" };
  const first = recordDesktopKanbanCommandReceipt(app, currentUser, {
    commandId: "command-1",
    deliverySeq: 1,
    projectId: "cloud-project-1",
    sourceRevision: 50,
    payload,
    issue: payload.issue
  });
  const replay = recordDesktopKanbanCommandReceipt(app, currentUser, {
    commandId: "command-1",
    deliverySeq: 1,
    projectId: "cloud-project-1",
    sourceRevision: 50,
    payload,
    issue: payload.issue
  });
  assert.equal(first.receipt.runId, replay.receipt.runId);
  assert.equal(first.receipt.requestId, replay.receipt.requestId);
  assert.equal(listPendingDesktopKanbanCommandReceipts(app, currentUser).length, 1);

  const mismatch = recordDesktopKanbanCommandReceipt(app, currentUser, {
    commandId: "command-1",
    deliverySeq: 1,
    projectId: "cloud-project-1",
    sourceRevision: 50,
    payload: { ...payload, message: "different command" },
    issue: payload.issue
  });
  assert.equal(mismatch.executable, false);
  assert.equal(mismatch.receipt.state, "failed");
  assert.equal(listPendingDesktopKanbanCommandReceipts(app, currentUser)[0].state, "failed");
});

test("cloud detail snapshot survives cache reload and incremental issue updates", (t) => {
  const app = createTempApp(t);
  const richIssue = cloudIssue({
    parentIssueId: "cloud-parent-1",
    issueTypeKey: "story",
    stageKey: "delivery",
    statusKey: "todo",
    columnKey: "todo",
    customFields: { budget: 120000, stakeholders: ["team-payments"] },
    runAgentKey: "codeAssistant",
    runCommandId: "command-rich-1",
    runStartedAt: "2026-07-11T01:00:00.000Z",
    runResultMessage: "Scope ready",
    createdBy: "user-1",
    updatedByAgent: "codeAssistant"
  });
  applyDesktopKanbanCloudSnapshot(app, currentUser, {
    scope: "project_set",
    complete: true,
    projectIds: ["cloud-project-1"],
    lastSeq: 70,
    projects: [{
      id: "cloud-project-1",
      name: "Cloud Project",
      slug: "cloud-project-1",
      path: "default/cloud-project-1",
      depth: 1,
      position: 1,
      revision: 69,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }],
    issues: [richIssue],
    users: [{ id: "user-1", email: "user@example.test", displayName: "User One", status: "active" }],
    issueTypes: [{ key: "story", name: "Story", position: 1, isActive: true }],
    issueFieldDefs: [{ id: "field-budget", key: "budget", name: "Budget", valueType: "number", unit: "CNY" }],
    issueFieldContexts: [{ id: "context-budget", fieldId: "field-budget", projectId: "cloud-project-1", required: true, position: 1, isActive: true }],
    issueFieldOptions: [],
    workflows: [{ id: "workflow-standard-requirement", issueTypeKey: "story", key: "story", name: "Story workflow" }],
    workflowStages: [{ id: "stage-delivery", workflowId: "workflow-standard-requirement", key: "delivery", name: "Delivery" }],
    workflowStatuses: [{ id: "status-todo", workflowId: "workflow-standard-requirement", stageId: "stage-delivery", key: "todo", name: "Todo" }],
    issueLabels: [{ id: "label-backend", projectId: "cloud-project-1", key: "backend", name: "Backend", color: "#3b82f6" }],
    issueLabelLinks: [{ issueId: "cloud-issue-1", labelId: "label-backend" }],
    issueDependencies: [{ id: "dep-1", fromIssueId: "cloud-issue-1", toIssueId: "cloud-parent-1", type: "blocks" }],
    reviews: [{ id: "review-1", issueId: "cloud-issue-1", reviewType: "acceptance", status: "pending", requestedAt: "2026-07-11T02:00:00.000Z", summary: "Please review", createdAt: "2026-07-11T02:00:00.000Z", updatedAt: "2026-07-11T02:00:00.000Z" }],
    issueComments: [{ id: "comment-1", issueId: "cloud-issue-1", authorUserId: "user-1", body: "Looks good", createdAt: "2026-07-11T02:01:00.000Z", updatedAt: "2026-07-11T02:01:00.000Z" }],
    recentEvents: [{ id: 1, issueId: "cloud-issue-1", revision: 70, eventType: "issue.updated", actorId: "user-1", payload: {}, createdAt: "2026-07-11T02:02:00.000Z" }]
  });

  const cached = listDesktopKanbanIssues(app, currentUser);
  const cachedIssue = cached.issues.find((issue) => issue.remoteIssueId === "cloud-issue-1");
  assert.equal(cachedIssue?.issueTypeKey, "story");
  assert.equal(cachedIssue?.parentIssueId, "cloud-parent-1");
  assert.deepEqual(cachedIssue?.customFields, { budget: 120000, stakeholders: ["team-payments"] });
  assert.equal(cachedIssue?.runResultMessage, "Scope ready");
  assert.equal(cached.cloudDetails.users[0].displayName, "User One");
  assert.equal(cached.cloudDetails.issueFieldDefs[0].key, "budget");
  assert.equal(cached.cloudDetails.issueComments[0].body, "Looks good");

  const updated = upsertDispatchedDesktopKanbanIssue(app, currentUser, {
    ...richIssue,
    revision: 71,
    customFields: { budget: 160000 },
    runResultMessage: "Scope updated"
  }, 71);
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.issue.customFields, { budget: 160000 });
  assert.equal(listDesktopKanbanIssues(app, currentUser).cloudDetails.issueLabels.length, 1);

  applyDesktopKanbanCloudSnapshot(app, currentUser, {
    scope: "project_set",
    complete: true,
    projectIds: ["cloud-project-1"],
    lastSeq: 72,
    projects: [],
    issues: [{ ...richIssue, revision: 72 }]
  });
  const replaced = listDesktopKanbanIssues(app, currentUser);
  assert.equal(replaced.cloudDetails.issueLabels.length, 0);
  assert.equal(replaced.cloudDetails.recentEvents.length, 0);
});

test("dueDate remains a timezone-free calendar date and legacy dueTime is read compatibly", (t) => {
  const app = createTempApp(t);
  const issueWithDueDate = cloudIssue({
    dueDate: "2026-07-12"
  });

  applyDesktopKanbanCloudSnapshot(app, currentUser, {
    scope: "project_set",
    complete: true,
    projectIds: ["cloud-project-1"],
    lastSeq: 49,
    projects: [],
    issues: [issueWithDueDate]
  });
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1")?.dueDate,
    "2026-07-12"
  );

  const valid = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({
    revision: 51,
    dueTime: "2026-07-13T23:30:00-08:00"
  }), 51);

  assert.equal(valid.ok, true);
  assert.equal(valid.issue.dueDate, "2026-07-13");
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1")?.dueDate,
    "2026-07-13"
  );

  const cleared = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({
    revision: 52,
    dueDate: null
  }), 52);
  assert.equal(cleared.issue.dueDate, null);
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1")?.dueDate,
    null
  );

  const missing = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({ revision: 53 }), 53);
  assert.equal(missing.issue.dueDate, null);

  for (const [index, dueDate] of [
    "2026-02-30",
    "2026-07-12T09:30:00",
    "07/12/2026"
  ].entries()) {
    const revision = 54 + index;
    const invalid = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({
      revision,
      dueDate
    }), revision);
    assert.equal(invalid.issue.dueDate, null);
  }
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1")?.dueDate,
    null
  );
});
