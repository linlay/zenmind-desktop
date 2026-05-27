import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  createTaskBoardIssue,
  deleteTaskBoardIssue,
  listTaskBoardIssues,
  moveTaskBoardIssue,
  updateTaskBoardIssueByChatId,
  updateTaskBoardIssueByRunId,
  updateTaskBoardIssue,
  __testInternals
} = await import("../dist-electron/main/task-board-store.js");

function createApp(homeRoot) {
  return {
    getPath(name) {
      if (name === "home") {
        return homeRoot;
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

function createTempApp(t, prefix = "zenmind-task-board-") {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const app = createApp(path.join(tempRoot, "home"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return app;
}

function assertTaskBoardId(value) {
  assert.match(value, /^[0-9A-Z]+$/);
  assert.equal(Number.isFinite(Number.parseInt(value, 36)), true);
}

function waitForNextMillisecond() {
  const startedAt = Date.now();
  while (Date.now() === startedAt) {
    // Keep timestamps deterministic for ordering tests.
  }
}

test("task board initializes an empty fresh database under the desktop home directory", (t) => {
  const app = createTempApp(t);
  const result = listTaskBoardIssues(app);

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(
    result.storagePath,
    path.join(app.getPath("home"), ".zenmind", ".desktop", "task-board.db")
  );
  assert.equal(fs.existsSync(__testInternals.getTaskBoardDatabasePath(app)), true);
});

test("task board ignores legacy userData JSON/SQLite stores", (t) => {
  const app = createTempApp(t);
  const legacyRoot = path.join(app.getPath("home"), "userData", "task-board");
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "issues.json"), JSON.stringify({
    version: 1,
    issues: [{ id: "legacy", title: "旧任务" }]
  }));

  const result = listTaskBoardIssues(app);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test("task board rejects empty issue titles", (t) => {
  const app = createTempApp(t);
  const result = createTaskBoardIssue(app, {
    title: "   ",
    description: "ignored"
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /标题不能为空/);
  assert.deepEqual(result.issues, []);
});

test("task board creates issues with simplified defaults and monotonic ids", (t) => {
  const app = createTempApp(t);

  const first = createTaskBoardIssue(app, {
    title: "  设计任务看板  ",
    description: "  复刻 Multica board  "
  });
  const second = createTaskBoardIssue(app, {
    title: "接入智能体运行",
    status: "in_progress",
    priority: "high",
    assigneeAgentKey: "zenmi"
  });

  assert.equal(first.ok, true);
  assertTaskBoardId(first.issue.id);
  assert.equal(first.issue.title, "设计任务看板");
  assert.equal(first.issue.description, "复刻 Multica board");
  assert.equal(first.issue.status, "backlog");
  assert.equal(first.issue.priority, "medium");
  assert.equal(first.issue.automationEnabled, false);
  assert.equal(second.ok, true);
  assertTaskBoardId(second.issue.id);
  assert.equal(Number.parseInt(second.issue.id, 36) > Number.parseInt(first.issue.id, 36), true);
  assert.equal(second.issue.assigneeAgentKey, "zenmi");

  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => issue.id),
    [first.issue.id, second.issue.id]
  );
});

test("task board persists issue attachments across create, update, and reload", (t) => {
  const app = createTempApp(t);
  const firstAttachment = {
    id: "att_1",
    name: "需求说明.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234,
    text: "需求说明正文",
    document: {
      format: "pdf",
      readStatus: "readable",
      extractedChars: 6,
      truncated: false,
      pageCount: 1
    }
  };
  const secondAttachment = {
    id: "att_2",
    name: "截图.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    text: "",
    dataUrl: "data:image/png;base64,abc"
  };

  const created = createTaskBoardIssue(app, {
    title: "带附件的任务",
    description: "请阅读附件",
    attachments: [firstAttachment]
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.issue.attachments, [firstAttachment]);

  const updated = updateTaskBoardIssue(app, created.issue.id, {
    attachments: [firstAttachment, secondAttachment]
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.issue.attachments, [firstAttachment, secondAttachment]);
  assert.deepEqual(listTaskBoardIssues(app).issues[0].attachments, [firstAttachment, secondAttachment]);
});

test("task board updates automation fields and deletes existing issues", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "旧标题",
    priority: "low",
    automationEnabled: true,
    automationCron: " 0 8 * * * ",
    automationMessage: " 每天 8 点检查状态 ",
    automationTimezone: " Asia/Shanghai "
  });
  assert.equal(created.issue.automationEnabled, true);
  assert.equal(created.issue.automationId, null);
  assert.equal(created.issue.automationCron, "0 8 * * *");
  assert.equal(created.issue.automationMessage, "每天 8 点检查状态");
  assert.equal(created.issue.automationTimezone, "Asia/Shanghai");

  const updated = updateTaskBoardIssue(app, created.issue.id, {
    title: "新标题",
    priority: "high",
    chatId: "chat-1",
    runId: "run-1",
    automationId: "automation-1",
    automationEnabled: false,
    automationCron: null,
    automationMessage: null,
    automationTimezone: null
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.issue.title, "新标题");
  assert.equal(updated.issue.priority, "high");
  assert.equal(updated.issue.chatId, "chat-1");
  assert.equal(updated.issue.runId, "run-1");
  assert.equal(updated.issue.automationId, "automation-1");
  assert.equal(updated.issue.automationEnabled, false);
  assert.equal(updated.issue.automationCron, null);

  const removed = deleteTaskBoardIssue(app, created.issue.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.issues, []);
});

test("task board moves issues across status columns and reorders positions", (t) => {
  const app = createTempApp(t);
  const first = createTaskBoardIssue(app, { title: "第一项" }).issue;
  const second = createTaskBoardIssue(app, { title: "第二项" }).issue;
  const third = createTaskBoardIssue(app, { title: "第三项" }).issue;

  const moved = moveTaskBoardIssue(app, {
    id: third.id,
    status: "todo",
    position: -1
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.issue.status, "todo");

  const reordered = moveTaskBoardIssue(app, {
    id: second.id,
    status: "backlog",
    position: -2
  });
  assert.equal(reordered.ok, true);

  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.id, issue.status, issue.position]),
    [
      [second.id, "backlog", -2],
      [first.id, "backlog", 1],
      [third.id, "todo", -1]
    ]
  );
});

test("task board orders todo issues by position before updated time", (t) => {
  const app = createTempApp(t);
  const first = createTaskBoardIssue(app, { title: "第一项", status: "todo" }).issue;
  const second = createTaskBoardIssue(app, { title: "第二项", status: "todo" }).issue;
  const third = createTaskBoardIssue(app, { title: "第三项", status: "todo" }).issue;

  waitForNextMillisecond();
  const updated = updateTaskBoardIssue(app, third.id, { title: "第三项更新" });
  assert.equal(updated.ok, true);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => issue.id),
    [first.id, second.id, third.id]
  );

  const moved = moveTaskBoardIssue(app, {
    id: third.id,
    status: "todo",
    position: 0
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => issue.id),
    [third.id, first.id, second.id]
  );
});

test("task board supports completed as the terminal column", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "用户确认完成",
    status: "in_progress",
    priority: "high"
  }).issue;

  const moved = moveTaskBoardIssue(app, {
    id: created.id,
    status: "completed",
    position: 1
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.issue.status, "completed");
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status]),
    [["用户确认完成", "completed"]]
  );
});

test("task board rejects invalid statuses and priorities by falling back to defaults", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "非法字段",
    status: "invalid_status",
    priority: "invalid_priority"
  });

  assert.equal(created.ok, true);
  assert.equal(created.issue.status, "backlog");
  assert.equal(created.issue.priority, "medium");
});

test("task board rejects status moves while an issue has an active assistant run", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "交给智能体处理",
    status: "in_progress"
  }).issue;
  const running = updateTaskBoardIssue(app, created.id, {
    runId: "run-1",
    chatId: "chat-1"
  }).issue;

  const moved = moveTaskBoardIssue(app, {
    id: running.id,
    status: "completed",
    position: 1
  });

  assert.equal(moved.ok, false);
  assert.match(moved.message, /正在回答/);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.runId]),
    [["交给智能体处理", "in_progress", "run-1"]]
  );
});

test("task board rejects manual status updates into completed", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "需要人工确认",
    status: "in_progress"
  }).issue;

  const updated = updateTaskBoardIssue(app, created.id, {
    status: "completed"
  });

  assert.equal(updated.ok, false);
  assert.match(updated.message, /已完成/);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status]),
    [["需要人工确认", "in_progress"]]
  );
});

test("task board allows assistant completion updates to completed when clearing active run", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "交给智能体处理",
    status: "in_progress"
  }).issue;
  updateTaskBoardIssue(app, created.id, {
    runId: "run-1",
    chatId: "chat-1"
  });

  const completed = updateTaskBoardIssueByRunId(app, "run-1", {
    status: "completed",
    runId: null
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.issue.status, "completed");
  assert.equal(completed.issue.runId, null);
  assert.equal(completed.issue.runState, "completed");
});

test("task board persists failed assistant run state when returning to todo", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "交给智能体处理",
    status: "in_progress"
  }).issue;
  updateTaskBoardIssue(app, created.id, {
    runId: "run-1",
    chatId: "chat-1",
    runState: "running"
  });

  const failed = updateTaskBoardIssueByRunId(app, "run-1", {
    status: "todo",
    runId: null,
    runState: "failed"
  });

  assert.equal(failed.ok, true);
  assert.equal(failed.issue.status, "todo");
  assert.equal(failed.issue.runId, null);
  assert.equal(failed.issue.runState, "failed");
});

test("task board persists cancelled assistant run state without moving columns", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "取消后留在当前列",
    status: "in_progress"
  }).issue;
  updateTaskBoardIssue(app, created.id, {
    runId: "run-cancelled",
    chatId: "chat-cancelled",
    runState: "running"
  });

  const cancelled = updateTaskBoardIssueByRunId(app, "run-cancelled", {
    runId: null,
    runState: "cancelled"
  });

  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.issue.status, "in_progress");
  assert.equal(cancelled.issue.runId, null);
  assert.equal(cancelled.issue.runState, "cancelled");
});

test("task board clears stale run state on manual cross-column moves", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "需要重新整理",
    status: "todo",
    runState: "failed"
  }).issue;

  const moved = moveTaskBoardIssue(app, {
    id: created.id,
    status: "backlog",
    position: 1
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.issue.status, "backlog");
  assert.equal(moved.issue.runState, null);
});

test("task board updates stale in-progress assistant runs by chat id", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "同一会话继续执行",
    status: "in_progress"
  }).issue;
  updateTaskBoardIssue(app, created.id, {
    runId: "run-1",
    chatId: "chat-1"
  });

  const completed = updateTaskBoardIssueByChatId(app, "chat-1", {
    status: "completed",
    runId: null
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.issue.status, "completed");
  assert.equal(completed.issue.runId, null);
  assert.equal(completed.issue.runState, "completed");
});
