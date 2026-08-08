import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  applyDesktopKanbanCloudSnapshot,
  createPrivateDesktopKanbanIssue,
  listDesktopKanbanIssues,
  listPendingDesktopKanbanCommandReceipts,
  recordDesktopKanbanCommandReceipt,
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
    priority: "medium",
    severity: "medium",
    position: 1,
    revision: 50,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides
  };
}

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

test("cloud dueTime normalizes to epoch-ms and survives cache reload", (t) => {
  const app = createTempApp(t);
  const expectedDueAt = Date.UTC(2026, 6, 12, 1, 30, 0, 0);
  const issueWithDueTime = cloudIssue({
    dueTime: "2026-07-12T09:30:00.000000000+08:00"
  });

  applyDesktopKanbanCloudSnapshot(app, currentUser, {
    scope: "project_set",
    complete: true,
    projectIds: ["cloud-project-1"],
    lastSeq: 49,
    projects: [],
    issues: [issueWithDueTime]
  });
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1")?.dueAt,
    expectedDueAt
  );

  const valid = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({
    revision: 51,
    dueTime: "2026-07-12T09:30:00.000000000+08:00"
  }), 51);

  assert.equal(valid.ok, true);
  assert.equal(valid.issue.dueAt, expectedDueAt);
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1")?.dueAt,
    expectedDueAt
  );

  const cleared = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({
    revision: 52,
    dueTime: null
  }), 52);
  assert.equal(cleared.issue.dueAt, null);
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1")?.dueAt,
    null
  );

  const missing = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({ revision: 53 }), 53);
  assert.equal(missing.issue.dueAt, undefined);

  for (const [index, dueTime] of [
    "2026-02-30T09:30:00+08:00",
    "2026-07-12T09:30:00",
    "2026-07-12T09:30:00.000000001Z"
  ].entries()) {
    const revision = 54 + index;
    const invalid = upsertDispatchedDesktopKanbanIssue(app, currentUser, cloudIssue({
      revision,
      dueTime
    }), revision);
    assert.equal(invalid.issue.dueAt, undefined);
  }
  assert.equal(
    listDesktopKanbanIssues(app, currentUser).issues.find((issue) => issue.remoteIssueId === "cloud-issue-1")?.dueAt,
    null
  );
});
