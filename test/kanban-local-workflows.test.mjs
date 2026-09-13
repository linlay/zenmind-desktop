import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalDesktopKanbanIssue, listDesktopKanbanIssues, moveDesktopKanbanIssue, updateDesktopKanbanIssue, updateDesktopKanbanIssueRuntimeState } from "../dist-electron/main/modules/kanban/local-store.js";
import { saveLocalWorkflowDefinitions } from "../dist-electron/main/modules/kanban/local-workflow-settings.js";
import { validateLocalWorkflows, moveLocalWorkflow } from "../dist-electron/main/modules/kanban/local-workflows.js";

const user = { id: "local-user", name: "Local", email: "local@example.test", source: "test" };
function appFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-workflow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { getPath: (name) => path.join(root, name) };
}
function move(app, issue, status) {
  const result = moveDesktopKanbanIssue(app, user, { id: issue.id, status, position: 1 });
  assert.equal(result.ok, true);
  return result.issue;
}

test("development requires both reviews and only completes after submission", (t) => {
  const app = appFor(t);
  let issue = createLocalDesktopKanbanIssue(app, user, { title: "Build", localWorkflowId: "local-development", status: "completed" }).issue;
  assert.equal(issue.status, "todo");
  for (const stage of ["development", "testing"]) {
    assert.equal(issue.stageId, stage);
    issue = move(app, issue, "completed");
    assert.equal(issue.status, "in_review");
    issue = move(app, issue, "todo");
    assert.equal(issue.stageId, stage);
    issue = move(app, issue, "completed");
    issue = move(app, issue, "completed");
    assert.equal(issue.status, "todo");
  }
  assert.equal(issue.stageId, "submit");
  issue = move(app, issue, "completed");
  assert.equal(issue.status, "completed");
  assert.equal(listDesktopKanbanIssues(app, user).issues[0].stageId, "submit");
});

test("bug flow starts at reporting; edits and removal preserve issue snapshots across database opens", (t) => {
  const app = appFor(t);
  const workflows = listDesktopKanbanIssues(app, user).localWorkflows;
  let issue = createLocalDesktopKanbanIssue(app, user, { title: "Bug", localWorkflowId: "local-bug" }).issue;
  assert.equal(issue.localWorkflow.stages.length, 4);
  assert.equal(issue.stageId, "report");
  workflows[0].name = "Custom";
  workflows[0].stages = workflows[0].stages.reverse().map(({ rollbackToStageId, ...stage }) => stage);
  saveLocalWorkflowDefinitions(app, user, [workflows[0]]);
  assert.equal(listDesktopKanbanIssues(app, user).localWorkflows[0].name, "Custom");
  issue = listDesktopKanbanIssues(app, user).issues[0];
  assert.equal(issue.localWorkflow.stages[0].id, "report");
  issue = move(app, issue, "completed");
  assert.equal(issue.stageId, "development");
  const updated = updateDesktopKanbanIssue(app, user, issue.id, { title: "Updated bug", status: "completed" });
  assert.equal(updated.issue.title, "Updated bug");
  assert.equal(updated.issue.status, "in_review");
  assert.equal(createLocalDesktopKanbanIssue(app, user, { title: "Gone", localWorkflowId: "local-bug" }).ok, false);
});

test("runtime success requests review without approving; next stage releases run and chat identity", (t) => {
  const app = appFor(t);
  let issue = createLocalDesktopKanbanIssue(app, user, { title: "Run", localWorkflowId: "local-development" }).issue;
  issue = updateDesktopKanbanIssueRuntimeState(app, user, issue.id, { status: "in_progress", runId: "run-1", chatId: "chat-1", runState: "running" }).issue;
  const finish = () => updateDesktopKanbanIssueRuntimeState(app, user, issue.id, { status: "completed", runId: null, runState: "completed" }).issue;
  issue = finish();
  assert.equal(issue.status, "in_review");
  issue = finish();
  assert.equal(issue.stageId, "development");
  issue = move(app, issue, "completed");
  assert.equal(issue.stageId, "testing");
  assert.equal(issue.chatId, null);
  assert.equal(issue.activeRunId, null);
});

test("invalid definitions are rejected without replacing saved data; cloud and unstaged behavior stay separate", (t) => {
  const app = appFor(t);
  const definitions = listDesktopKanbanIssues(app, user).localWorkflows;
  for (const invalid of [[], [{ ...definitions[0], name: " " }], [definitions[0], definitions[0]], [{ ...definitions[0], stages: [] }], [{ ...definitions[0], stages: [definitions[0].stages[0], definitions[0].stages[0]] }]]) {
    assert.throws(() => saveLocalWorkflowDefinitions(app, user, invalid));
  }
  assert.deepEqual(listDesktopKanbanIssues(app, user).localWorkflows, definitions);
  assert.throws(() => validateLocalWorkflows([{ id: "cloud-id", name: "Cloud", stages: definitions[0].stages }]));
  let issue = createLocalDesktopKanbanIssue(app, user, { title: "Plain" }).issue;
  issue = move(app, issue, "completed");
  assert.equal(issue.status, "completed");
  const cloud = { ...issue, syncMode: "cloud", localWorkflow: definitions[0], stageId: "development", status: "todo" };
  assert.equal(moveLocalWorkflow(cloud, "completed").stageId, "development");
  assert.equal(updateDesktopKanbanIssue(app, user, issue.id, { title: "Renamed", description: "Keep edits", status: "todo" }).issue.description, "Keep edits");
});


test("runtime advancement cannot carry the previous stage chat into the next stage", (t) => {
  const app = appFor(t);
  const created = createLocalDesktopKanbanIssue(app, user, { title: "Report", localWorkflowId: "local-bug" }).issue;
  const result = updateDesktopKanbanIssueRuntimeState(app, user, created.id, { status: "completed", chatId: "report-chat", runId: null, runState: "completed" });
  assert.equal(result.issue.stageId, "development");
  assert.equal(result.issue.chatId, null);
  assert.equal(result.issue.runState, null);
});


function action(app, issue, details) {
  return updateDesktopKanbanIssue(app, user, issue.id, { localWorkflowAction: details });
}
function toTesting(app) {
  let issue = createLocalDesktopKanbanIssue(app, user, { title: "Verify rollback", localWorkflowId: "local-development" }).issue;
  issue = move(app, issue, "completed");
  return move(app, issue, "completed");
}

test("failed testing returns to development, records reason and requires both reviews again", (t) => {
  const app = appFor(t);
  let issue = toTesting(app);
  const request = { type: "rollback", fromStageId: "testing", fromStatus: issue.status, toStageId: "development", reason: "Reproduce: save loses content" };
  const result = action(app, issue, request);
  assert.equal(result.ok, true);
  issue = result.issue;
  assert.equal(issue.stageId, "development");
  assert.equal(issue.status, "todo");
  assert.equal(issue.chatId, null);
  assert.equal(issue.localWorkflowRollbacks[0].reason, request.reason);
  assert.equal(issue.localWorkflowRollbacks[0].actorId, user.id);
  assert.equal(listDesktopKanbanIssues(app, user).issues[0].localWorkflowRollbacks[0].id, issue.localWorkflowRollbacks[0].id);
  assert.equal(action(app, issue, request).ok, false, "stale duplicate cannot roll back again");
  issue = move(app, issue, "completed");
  assert.equal(issue.status, "in_review");
  issue = move(app, issue, "completed");
  assert.equal(issue.stageId, "testing");
  issue = move(app, issue, "completed");
  assert.equal(issue.status, "in_review");
  issue = move(app, issue, "completed");
  assert.equal(issue.stageId, "submit");
});

test("rollback validates target, reason, run lock and current state without mutation", (t) => {
  const app = appFor(t);
  const issue = toTesting(app);
  const request = { type: "rollback", fromStageId: "testing", fromStatus: issue.status, toStageId: "development", reason: "Fail" };
  for (const patch of [{ toStageId: "submit" }, { toStageId: "testing" }, { toStageId: "absent" }, { fromStatus: "in_review" }, { reason: " " }, { reason: "x".repeat(2001) }]) {
    assert.equal(action(app, issue, { ...request, ...patch }).ok, false);
  }
  assert.equal(listDesktopKanbanIssues(app, user).issues[0].stageId, "testing");
  updateDesktopKanbanIssueRuntimeState(app, user, issue.id, { status: "in_progress", runId: "run-testing", runState: "running" });
  assert.equal(action(app, issue, { ...request, fromStatus: "in_progress" }).ok, false);
});

test("workflow templates reject missing, same-stage and forward rollback targets", (t) => {
  const app = appFor(t);
  const templates = listDesktopKanbanIssues(app, user).localWorkflows;
  for (const target of ["testing", "submit", "absent", ""]) {
    const invalid = structuredClone(templates);
    invalid[0].stages[1].rollbackToStageId = target;
    assert.throws(() => saveLocalWorkflowDefinitions(app, user, invalid));
  }
  assert.deepEqual(listDesktopKanbanIssues(app, user).localWorkflows, templates);
});

test("existing issue explicitly adopts only changed rollback rules from a matching template", (t) => {
  const app = appFor(t);
  const templates = listDesktopKanbanIssues(app, user).localWorkflows;
  delete templates[0].stages[1].rollbackToStageId;
  saveLocalWorkflowDefinitions(app, user, templates);
  let issue = toTesting(app);
  assert.equal(issue.localWorkflow.stages[1].rollbackToStageId, undefined);
  templates[0].stages[1].rollbackToStageId = "development";
  templates[0].stages[0].reviewRequired = false;
  saveLocalWorkflowDefinitions(app, user, templates);
  assert.equal(listDesktopKanbanIssues(app, user).issues[0].localWorkflow.stages[1].rollbackToStageId, undefined);
  issue = action(app, issue, { type: "refresh_rollback_rules" }).issue;
  assert.equal(issue.localWorkflow.stages[1].rollbackToStageId, "development");
  assert.equal(issue.localWorkflow.stages[0].reviewRequired, true);
  assert.equal(issue.stageId, "testing");
  templates[0].stages[0].id = "new-development";
  templates[0].stages[1].rollbackToStageId = "new-development";
  saveLocalWorkflowDefinitions(app, user, templates);
  assert.equal(action(app, issue, { type: "refresh_rollback_rules" }).ok, false);
});
