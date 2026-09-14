import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KanbanRuntime, getKanbanConfigPath } from "../dist-electron/main/modules/kanban/runtime.js";
import { isLocalIssueRunnable } from "../dist-electron/main/modules/kanban/local-scheduler.js";

async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(check(), "scheduler did not converge");
}
function setup(t, start) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-scheduler-"));
  const app = { getPath: name => path.join(root, name) };
  const config = getKanbanConfigPath(app);
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ enabled: true, cloud: { serverUrl: "", remoteControlEnabled: false } }));
  const calls = [];
  const runtime = new KanbanRuntime({ app, assistantBridge: {
    listAgents: async () => [],
    startRun: async request => {
      calls.push(request);
      return start ? start(request, runtime) : { ok: true, runId: request.runId, chatId: request.chatId, message: "accepted" };
    }
  }, callAgentPlatform: async () => ({}) });
  t.after(() => { runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime, calls };
}
function finish(runtime, call, status = "completed", finishReason = "complete") {
  runtime.sendNavigationPushEvent({ frame: "push", type: "run.finished", runId: call.runId,
    chatId: call.chatId, status, finishReason, finishedAt: Date.now() });
}

test("eligibility excludes cloud, no executor, automation and active/terminal failures", () => {
  const ready = { syncMode: "local", status: "todo", assigneeAgentKey: "agent" };
  assert.equal(isLocalIssueRunnable(ready), true);
  assert.equal(isLocalIssueRunnable({ ...ready, assigneeAgentKey: null, workerAgent: "agent" }), true);
  for (const patch of [{ syncMode: "cloud" }, { status: "backlog" }, { status: "in_review" },
    { status: "completed" }, { workerType: "human" }, { assigneeAgentKey: null },
    { automationEnabled: true }, { runId: "run" }, { activeRunId: "run" },
    { runState: "running" }, { runState: "failed" }, { runState: "cancelled" }]) {
    assert.equal(isLocalIssueRunnable({ ...ready, ...patch }), false, JSON.stringify(patch));
  }
});

test("new todo waits two seconds despite repeated wakes and only starts once", async t => {
  const started = [];
  const { runtime, calls } = setup(t, request => {
    started.push(Date.now());
    return { ok: true, ...request };
  });
  runtime.start();
  const before = Date.now();
  const { issue } = await runtime.createIssue({ status: "todo", title: "delayed", assigneeAgentKey: "a" });
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    finish(runtime, { runId: "other", chatId: "other" });
    const current = runtime.listIssues().issues.find(item => item.id === issue.id);
    assert.equal(current.status, "todo");
    assert.equal(current.runId, null);
    assert.equal(calls.length, 0);
  }
  await until(() => calls.length === 1 && runtime.listIssues().issues[0].status === "in_progress");
  assert.ok(started[0] - before >= 2_000);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls.length, 1);
});

test("clearing the executor during the delay cancels admission", async t => {
  const { runtime, calls } = setup(t);
  runtime.start();
  const { issue } = await runtime.createIssue({ status: "todo", title: "clear", assigneeAgentKey: "a" });
  await new Promise(resolve => setTimeout(resolve, 500));
  await runtime.updateIssue(issue.id, { assigneeAgentKey: null, workerAgent: null, workerType: null });
  await new Promise(resolve => setTimeout(resolve, 1_700));
  assert.equal(calls.length, 0);
  assert.equal(runtime.listIssues().issues[0].status, "todo");
});

test("startup scans existing todo and update assignment starts without a renderer", async t => {
  const { runtime, calls } = setup(t);
  const first = await runtime.createIssue({ status: "todo", title: "existing", assigneeAgentKey: "a" });
  const second = await runtime.createIssue({ status: "todo", title: "unassigned" });
  runtime.start();
  await until(() => calls.length === 1 && runtime.listIssues().issues.find(i => i.id === first.issue.id)?.status === "in_progress");
  await runtime.updateIssue(second.issue.id, { assigneeAgentKey: "a" });
  await until(() => calls.length === 2 && runtime.listIssues().issues.every(i => i.status === "in_progress"));
  for (let i = 0; i < 5; i++) runtime.sendNavigationPushEvent({ frame: "push", type: "agent.updated" });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.length, 2);
});

test("create and move share scheduling; no fabricated in_progress before acceptance", async t => {
  let accept;
  const { runtime, calls } = setup(t, request => new Promise(resolve => {
    accept = () => resolve({ ok: true, runId: request.runId, chatId: request.chatId, message: "accepted" });
  }));
  runtime.start();
  const created = await runtime.createIssue({ status: "todo", title: "backlog", status: "backlog", assigneeAgentKey: "a" });
  await runtime.moveIssue({ id: created.issue.id, status: "in_progress", position: 1 });
  await until(() => calls.length === 1);
  assert.equal(runtime.listIssues().issues[0].status, "todo");
  accept();
  await until(() => runtime.listIssues().issues[0].status === "in_progress");
});

test("Platform capacity rejection leaves todo and any Chat finish wakes the queue", async t => {
  let busy = true;
  const { runtime, calls } = setup(t, request => ({ ok: !busy, runId: request.runId, chatId: request.chatId, message: busy ? "capacity full" : "accepted" }));
  runtime.start();
  await runtime.createIssue({ status: "todo", title: "queued", assigneeAgentKey: "a" });
  await until(() => calls.length === 1 && !runtime.listIssues().issues[0].runId);
  assert.equal(runtime.listIssues().issues[0].status, "todo");
  assert.equal(runtime.listIssues().issues[0].runErrorMessage, "capacity full");
  busy = false;
  finish(runtime, { runId: "ordinary-chat-run", chatId: "ordinary-chat" });
  await until(() => calls.length === 2 && runtime.listIssues().issues[0].status === "in_progress");
});

test("pending admission of one Agent does not block another; duplicate wakes do not resubmit", async t => {
  let accept;
  const { runtime, calls } = setup(t, request => request.agentKey === "a" ? new Promise(resolve => {
    accept = () => resolve({ ok: true, ...request });
  }) : { ok: true, ...request });
  runtime.start();
  await runtime.createIssue({ status: "todo", title: "a", assigneeAgentKey: "a" });
  await runtime.createIssue({ status: "todo", title: "b", assigneeAgentKey: "b" });
  await until(() => calls.length === 2 && runtime.listIssues().issues.some(i => i.title === "b" && i.status === "in_progress"));
  for (let i = 0; i < 5; i++) finish(runtime, { runId: "other", chatId: "other" });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.length, 2);
  accept();
  await until(() => runtime.listIssues().issues.every(i => i.status === "in_progress"));
});

test("finish before query acceptance cannot regress a completed issue to in_progress", async t => {
  const { runtime, calls } = setup(t, (request, runtime) => {
    finish(runtime, request);
    return { ok: true, ...request };
  });
  runtime.start();
  await runtime.createIssue({ status: "todo", title: "instant", assigneeAgentKey: "a" });
  await until(() => runtime.listIssues().issues[0]?.status === "completed");
  assert.equal(calls.length, 1);
  assert.equal(runtime.listIssues().issues[0].runId, null);
});

test("stage completion schedules following stage; review waits for approval", async t => {
  const { runtime, calls } = setup(t);
  runtime.start();
  await runtime.createIssue({ status: "todo", title: "flow", assigneeAgentKey: "a", localWorkflowId: "local-bug" });
  await until(() => calls.length === 1 && runtime.listIssues().issues[0].status === "in_progress");
  finish(runtime, calls[0]);
  await until(() => calls.length === 2 && runtime.listIssues().issues[0].status === "in_progress");
  assert.equal(runtime.listIssues().issues[0].stageId, "development");
  finish(runtime, calls[1]);
  await until(() => runtime.listIssues().issues[0].status === "in_review");
  await runtime.updateIssue(runtime.listIssues().issues[0].id, { status: "completed" });
  await until(() => calls.length === 3 && runtime.listIssues().issues[0].status === "in_progress");
  assert.equal(runtime.listIssues().issues[0].stageId, "testing");
});

test("failed execution does not loop; explicit todo retry resumes admission", async t => {
  const { runtime, calls } = setup(t);
  runtime.start();
  const { issue } = await runtime.createIssue({ status: "todo", title: "fails", assigneeAgentKey: "a" });
  await until(() => calls.length === 1 && runtime.listIssues().issues[0].status === "in_progress");
  finish(runtime, calls[0], "failed", "error");
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.length, 1);
  await runtime.updateIssue(issue.id, { status: "todo" });
  await until(() => calls.length === 2);
});

test("uncertain admission retains identity and never replays on wake", async t => {
  const { runtime, calls } = setup(t, request => ({ ok: false, ...request, message: "connection_lost_before_acceptance" }));
  runtime.start();
  await runtime.createIssue({ status: "todo", title: "uncertain", assigneeAgentKey: "a" });
  await until(() => calls.length === 1 && !!runtime.listIssues().issues[0].runErrorMessage);
  finish(runtime, { runId: "other", chatId: "other" });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.length, 1);
  assert.equal(runtime.listIssues().issues[0].runId, calls[0].runId);
});

test("five todos fill available Agent slots and continue after capacity is released", async t => {
  const active = new Map();
  const accepted = [];
  const { runtime } = setup(t, request => {
    if (active.size >= 2) return { ok: false, ...request, message: "capacity full" };
    active.set(request.runId, request);
    accepted.push(request);
    return { ok: true, ...request };
  });
  for (let i = 0; i < 5; i++) await runtime.createIssue({ status: "todo", title: `Task ${i}`, assigneeAgentKey: "a" });
  runtime.start();
  await until(() => accepted.length === 2 && runtime.listIssues().issues.filter(i => i.status === "in_progress").length === 2);
  assert.equal(runtime.listIssues().issues.filter(i => i.status === "todo").length, 3);
  while (accepted.length < 5) {
    const count = accepted.length;
    const [runId, call] = active.entries().next().value;
    active.delete(runId);
    finish(runtime, call);
    await until(() => accepted.length === count + 1);
  }
  assert.equal(new Set(accepted.map(r => r.message)).size, 5);
  assert.equal(new Set(accepted.map(r => r.runId)).size, 5);
  await until(() => runtime.listIssues().issues.filter(i => i.status === "in_progress").length === 2);
  for (const call of active.values()) finish(runtime, call);
  await until(() => runtime.listIssues().issues.every(i => i.status === "completed"));
});

test("disabled runtime waits; stop prevents new admissions", async t => {
  const { runtime, calls } = setup(t);
  runtime.saveSettings({ enabled: false });
  runtime.start();
  await runtime.createIssue({ status: "todo", title: "waiting", workerAgent: "a", workerType: "agent" });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.length, 0);
  runtime.saveSettings({ enabled: true });
  await until(() => calls.length === 1);
  runtime.stop();
  await runtime.createIssue({ status: "todo", title: "stopped", assigneeAgentKey: "a" });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.length, 1);
});

test("rejected rerun preserves the last completed result and Chat association", async t => {
  let busy = false;
  const { runtime, calls } = setup(t, request => ({ ok: !busy, ...request, message: busy ? "capacity full" : "accepted" }));
  runtime.start();
  const { issue } = await runtime.createIssue({ status: "todo", title: "rerun", assigneeAgentKey: "a" });
  await until(() => calls.length === 1 && runtime.listIssues().issues[0].status === "in_progress");
  finish(runtime, calls[0]);
  runtime.sendNavigationPushEvent({ frame: "push", type: "chat.updated", chatId: calls[0].chatId,
    lastRunId: calls[0].runId, lastRunContent: "Previous result", updatedAt: Date.now() });
  busy = true;
  await runtime.updateIssue(issue.id, { status: "todo" });
  await until(() => calls.length === 2 && !runtime.listIssues().issues[0].runId);
  const current = runtime.listIssues().issues[0];
  assert.equal(current.lastRunId, calls[0].runId);
  assert.equal(current.lastRunChatId, calls[0].chatId);
  assert.equal(current.chatId, calls[0].chatId);
  assert.equal(current.runResultMessage, "Previous result");
});
