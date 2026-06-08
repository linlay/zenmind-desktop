import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  __testInternals,
  applyDesktopKanbanCloudSnapshot,
  createPrivateDesktopKanbanIssue,
  getDesktopKanbanIssue,
  listDesktopKanbanIssues
} = await import("../dist-electron/main/task-board-local-store.js");

function createTempApp(t, prefix = "zenmind-desktop-kanban-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    getPath(name) {
      if (name === "home") return home;
      if (name === "appData") return path.join(home, "Library", "Application Support");
      return path.join(home, name);
    }
  };
}

function currentUser(id = "user-1") {
  return {
    id,
    name: "Desktop User",
    email: "desktop@example.com",
    source: "sso"
  };
}

test("desktop kanban local store initializes new sqlite path and ignores legacy task-board.db", (t) => {
  const app = createTempApp(t);
  const legacyPath = path.join(app.getPath("home"), ".zenmind", ".desktop", "task-board.db");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, "legacy", "utf8");

  const result = listDesktopKanbanIssues(app, currentUser());
  const databasePath = __testInternals.getDesktopKanbanDatabasePath(app);

  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.storagePath, databasePath);
  assert.equal(databasePath.endsWith(path.join("data", "desktop-kanban", "kanban.db")), true);
  assert.equal(databasePath === legacyPath, false);
  assert.equal(fs.existsSync(databasePath), true);
  assert.equal(fs.readFileSync(legacyPath, "utf8"), "legacy");
});

test("desktop kanban private tasks stay local by default", (t) => {
  const app = createTempApp(t);
  const user = currentUser();

  const result = createPrivateDesktopKanbanIssue(app, user, {
    title: "Private task",
    description: "Only on this desktop",
    status: "todo",
    syncToCloud: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.issue.syncMode, "private");
  assert.equal(result.issue.syncState, "local");
  assert.equal(result.issue.origin, "desktop");
  assert.equal(result.issue.remoteIssueId, null);
  assert.equal(result.issue.ownerUserId, user.id);
  assert.equal(listDesktopKanbanIssues(app, user).issues[0].title, "Private task");
});

test("desktop kanban cloud snapshot maps remote issue to stable local issue", (t) => {
  const app = createTempApp(t);
  const user = currentUser();
  const privateIssue = createPrivateDesktopKanbanIssue(app, user, { title: "Private task" }).issue;
  const timestamp = new Date().toISOString();

  const first = applyDesktopKanbanCloudSnapshot(app, user, {
    revision: 7,
    issues: [{
      id: "ISS-1",
      title: "Cloud task",
      description: "Dispatched",
      status: "todo",
      priority: "high",
      assigneeId: user.id,
      position: 3,
      revision: 7,
      createdAt: timestamp,
      updatedAt: timestamp
    }]
  });
  const cloudIssue = first.issues.find((issue) => issue.remoteIssueId === "ISS-1");

  assert.equal(first.ok, true);
  assert.ok(privateIssue);
  assert.ok(first.issues.some((issue) => issue.id === privateIssue.id));
  assert.ok(cloudIssue);
  assert.equal(cloudIssue.syncMode, "cloud");
  assert.equal(cloudIssue.syncState, "synced");
  assert.equal(cloudIssue.origin, "cloud_dispatch");
  assert.equal(cloudIssue.lastRemoteRevision, 7);

  const second = applyDesktopKanbanCloudSnapshot(app, user, {
    revision: 8,
    issues: [{
      id: "ISS-1",
      title: "Cloud task updated",
      status: "in_review",
      priority: "medium",
      assigneeId: user.id,
      position: 4,
      revision: 8,
      createdAt: timestamp,
      updatedAt: timestamp
    }]
  });
  const updatedCloudIssue = second.issues.find((issue) => issue.remoteIssueId === "ISS-1");

  assert.equal(updatedCloudIssue.id, cloudIssue.id);
  assert.equal(updatedCloudIssue.title, "Cloud task updated");
  assert.equal(updatedCloudIssue.status, "in_review");
  assert.equal(getDesktopKanbanIssue(app, user, cloudIssue.id).remoteIssueId, "ISS-1");
});
