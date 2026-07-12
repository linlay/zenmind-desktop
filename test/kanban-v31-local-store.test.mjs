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
  recordDesktopKanbanCommandReceipt
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
