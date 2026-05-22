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

function createApp(userDataRoot) {
  return {
    getPath(name) {
      if (name === "userData") {
        return userDataRoot;
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

function createTempApp(t, prefix = "zenmind-task-board-") {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const app = createApp(path.join(tempRoot, "user-data"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return app;
}

test("task board initializes an empty local issue store", (t) => {
  const app = createTempApp(t);
  const result = listTaskBoardIssues(app);

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(fs.existsSync(__testInternals.getTaskBoardIssuesPath(app)), true);
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

test("task board creates issues with defaults and sorted identifiers", (t) => {
  const app = createTempApp(t);

  const first = createTaskBoardIssue(app, {
    title: "  设计任务看板  ",
    description: "  复刻 Multica board  "
  });
  const second = createTaskBoardIssue(app, {
    title: "接入智能体运行",
    status: "in_progress",
    priority: "high",
    assigneeAgentKey: "zenmi",
    assigneeName: "小宅"
  });

  assert.equal(first.ok, true);
  assert.equal(first.issue?.identifier, "ZEN-1");
  assert.equal(first.issue?.title, "设计任务看板");
  assert.equal(first.issue?.description, "复刻 Multica board");
  assert.equal(first.issue?.status, "backlog");
  assert.equal(first.issue?.priority, "medium");
  assert.equal(second.ok, true);
  assert.equal(second.issue?.identifier, "ZEN-2");
  assert.equal(second.issue?.assigneeAgentKey, "zenmi");

  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => issue.identifier),
    ["ZEN-1", "ZEN-2"]
  );
});

test("task board updates and deletes existing issues", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "旧标题",
    priority: "low",
    scheduleEnabled: true,
    scheduleCron: " 0 8 * * * ",
    scheduleMessage: " 每天 8 点检查状态 ",
    scheduleTimezone: " Asia/Shanghai "
  });
  assert.ok(created.issue);
  assert.equal(created.issue.scheduleEnabled, true);
  assert.equal(created.issue.scheduleId, null);
  assert.equal(created.issue.scheduleCron, "0 8 * * *");
  assert.equal(created.issue.scheduleMessage, "每天 8 点检查状态");
  assert.equal(created.issue.scheduleTimezone, "Asia/Shanghai");

  const updated = updateTaskBoardIssue(app, created.issue.id, {
    title: "新标题",
    priority: "urgent",
    chatId: "chat-1",
    runId: "run-1",
    scheduleId: "schedule-1",
    scheduleEnabled: false,
    scheduleCron: null,
    scheduleMessage: null,
    scheduleTimezone: null
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.issue?.title, "新标题");
  assert.equal(updated.issue?.priority, "urgent");
  assert.equal(updated.issue?.chatId, "chat-1");
  assert.equal(updated.issue?.runId, "run-1");
  assert.equal(updated.issue?.scheduleId, "schedule-1");
  assert.equal(updated.issue?.scheduleEnabled, false);
  assert.equal(updated.issue?.scheduleCron, null);
  assert.equal(updated.issue?.scheduleMessage, null);
  assert.equal(updated.issue?.scheduleTimezone, null);

  const removed = deleteTaskBoardIssue(app, created.issue.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.issues, []);
});

test("task board promotes todo issues to in progress when an assignee is set", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "交给负责人处理",
    status: "todo"
  }).issue;
  assert.ok(created);

  const updated = updateTaskBoardIssue(app, created.id, {
    assigneeAgentKey: "zenmi",
    assigneeName: "小宅"
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.issue?.status, "in_progress");
  assert.equal(updated.issue?.assigneeAgentKey, "zenmi");
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.assigneeAgentKey]),
    [["交给负责人处理", "in_progress", "zenmi"]]
  );
});

test("task board moves issues across status columns and reorders positions", (t) => {
  const app = createTempApp(t);
  const first = createTaskBoardIssue(app, { title: "第一项" }).issue;
  const second = createTaskBoardIssue(app, { title: "第二项" }).issue;
  const third = createTaskBoardIssue(app, { title: "第三项" }).issue;
  assert.ok(first);
  assert.ok(second);
  assert.ok(third);

  const moved = moveTaskBoardIssue(app, {
    id: third.id,
    status: "todo",
    position: -1
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.issue?.status, "todo");
  assert.equal(moved.issue?.position, -1);

  const reordered = moveTaskBoardIssue(app, {
    id: second.id,
    status: "backlog",
    position: -2
  });
  assert.equal(reordered.ok, true);

  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.identifier, issue.status, issue.position]),
    [
      ["ZEN-2", "backlog", -2],
      ["ZEN-1", "backlog", 1],
      ["ZEN-3", "todo", -1]
    ]
  );
});

test("task board migrates completed status aliases into the done column", (t) => {
  const app = createTempApp(t);
  const targetPath = __testInternals.getTaskBoardIssuesPath(app);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify({
    version: 1,
    issues: [
      {
        id: "issue-completed",
        number: 1,
        identifier: "ZEN-1",
        title: "新的任务",
        description: "name",
        status: "completed",
        priority: "medium",
        assigneeAgentKey: "zenmi",
        assigneeName: "小宅",
        position: 1,
        chatId: "chat-1",
        runId: null,
        createdAt: "2026-05-21T08:00:00.000Z",
        updatedAt: "2026-05-21T08:01:00.000Z"
      }
    ]
  }, null, 2), "utf8");

  const result = listTaskBoardIssues(app);

  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].identifier, "ZEN-1");
  assert.equal(result.issues[0].status, "done");
  assert.equal(JSON.parse(fs.readFileSync(targetPath, "utf8")).issues[0].status, "done");
});

test("task board allows moving in-progress issues that are not assigned to an active run", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "手动进行中的任务",
    status: "in_progress"
  }).issue;
  assert.ok(created);

  const moved = moveTaskBoardIssue(app, {
    id: created.id,
    status: "in_review",
    position: 1
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.issue?.status, "in_review");
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.runId]),
    [["手动进行中的任务", "in_review", null]]
  );
});

test("task board rejects status moves while an issue has an active assistant run", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "交给智能体处理",
    status: "todo"
  }).issue;
  assert.ok(created);
  const running = updateTaskBoardIssue(app, created.id, {
    status: "in_progress",
    chatId: "chat-1",
    runId: "run-1"
  }).issue;
  assert.ok(running);

  const moved = moveTaskBoardIssue(app, {
    id: running.id,
    status: "done",
    position: 1
  });

  assert.equal(moved.ok, false);
  assert.match(moved.message, /智能体正在回答/);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.runId]),
    [["交给智能体处理", "in_progress", "run-1"]]
  );
});

test("task board rejects manual status updates while an issue has an active assistant run", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "交给智能体处理",
    status: "todo"
  }).issue;
  assert.ok(created);
  const running = updateTaskBoardIssue(app, created.id, {
    status: "in_progress",
    chatId: "chat-1",
    runId: "run-1"
  }).issue;
  assert.ok(running);

  const updated = updateTaskBoardIssue(app, running.id, {
    status: "done"
  });

  assert.equal(updated.ok, false);
  assert.match(updated.message, /智能体正在回答/);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.runId]),
    [["交给智能体处理", "in_progress", "run-1"]]
  );
});

test("task board moves assistant completion updates into review and clears an active run", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "交给智能体处理",
    status: "todo"
  }).issue;
  assert.ok(created);
  const running = updateTaskBoardIssue(app, created.id, {
    status: "in_progress",
    chatId: "chat-1",
    runId: "run-1"
  }).issue;
  assert.ok(running);

  const updated = updateTaskBoardIssue(app, running.id, {
    status: "in_review",
    chatId: "chat-1",
    runId: null
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.issue?.status, "in_review");
  assert.equal(updated.issue?.runId, null);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.runId]),
    [["交给智能体处理", "in_review", null]]
  );
});

test("task board rejects non-drag status updates into done", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "需要人工确认",
    status: "in_review"
  }).issue;
  assert.ok(created);

  const updated = updateTaskBoardIssue(app, created.id, {
    status: "done"
  });

  assert.equal(updated.ok, false);
  assert.match(updated.message, /拖拽到 Done/);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status]),
    [["需要人工确认", "in_review"]]
  );
});

test("task board allows user drag moves from review into done", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "需要人工确认",
    status: "in_review"
  }).issue;
  assert.ok(created);

  const moved = moveTaskBoardIssue(app, {
    id: created.id,
    status: "done",
    position: 1
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.issue?.status, "done");
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status]),
    [["需要人工确认", "done"]]
  );
});

test("task board rejects assistant run completion updates directly into done", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "交给智能体处理",
    status: "todo"
  }).issue;
  assert.ok(created);

  updateTaskBoardIssue(app, created.id, {
    status: "in_progress",
    chatId: "chat-1",
    runId: "run-1"
  });

  const completed = updateTaskBoardIssueByRunId(app, "run-1", {
    status: "done",
    chatId: "chat-1",
    runId: null
  });

  assert.equal(completed.ok, false);
  assert.match(completed.message, /拖拽到 Done/);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.runId]),
    [["交给智能体处理", "in_progress", "run-1"]]
  );
});

test("task board recovers from corrupt persisted JSON", (t) => {
  const app = createTempApp(t);
  const targetPath = __testInternals.getTaskBoardIssuesPath(app);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "{broken", "utf8");

  const result = listTaskBoardIssues(app);

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(targetPath, "utf8")));
});

test("task board updates assistant run completion by run id into review", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "交给智能体处理",
    status: "todo"
  }).issue;
  assert.ok(created);

  updateTaskBoardIssue(app, created.id, {
    status: "in_progress",
    chatId: "chat-1",
    runId: "run-1"
  });

  const completed = updateTaskBoardIssueByRunId(app, "run-1", {
    status: "in_review",
    chatId: "chat-1",
    runId: null
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.issue?.status, "in_review");
  assert.equal(completed.issue?.chatId, "chat-1");
  assert.equal(completed.issue?.runId, null);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.runId]),
    [["交给智能体处理", "in_review", null]]
  );
});

test("task board updates stale in-progress assistant runs by chat id into review", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "同一会话继续执行",
    status: "todo"
  }).issue;
  assert.ok(created);

  updateTaskBoardIssue(app, created.id, {
    status: "in_progress",
    chatId: "chat-1",
    runId: "run-old"
  });

  const completed = updateTaskBoardIssueByChatId(app, "chat-1", {
    status: "in_review",
    chatId: "chat-1",
    runId: null
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.issue?.status, "in_review");
  assert.equal(completed.issue?.chatId, "chat-1");
  assert.equal(completed.issue?.runId, null);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.runId]),
    [["同一会话继续执行", "in_review", null]]
  );
});

test("task board rejects assistant chat completion updates directly into done", (t) => {
  const app = createTempApp(t);
  const created = createTaskBoardIssue(app, {
    title: "同一会话继续执行",
    status: "todo"
  }).issue;
  assert.ok(created);

  updateTaskBoardIssue(app, created.id, {
    status: "in_progress",
    chatId: "chat-1",
    runId: "run-old"
  });

  const completed = updateTaskBoardIssueByChatId(app, "chat-1", {
    status: "done",
    chatId: "chat-1",
    runId: null
  });

  assert.equal(completed.ok, false);
  assert.match(completed.message, /拖拽到 Done/);
  assert.deepEqual(
    listTaskBoardIssues(app).issues.map((issue) => [issue.title, issue.status, issue.runId]),
    [["同一会话继续执行", "in_progress", "run-old"]]
  );
});
