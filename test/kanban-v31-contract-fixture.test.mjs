import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Kanban v3.1 golden fixtures keep canonical envelope shapes", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/kanban-v3.1/contract-fixtures.json", import.meta.url), "utf8"));
  assert.equal(fixture.contractVersion, "3.1");
  assert.equal(fixture.wireVersion, 3);
  const assign = fixture.cases.issueAssignRequest;
  assert.equal(assign.frame, "request");
  assert.equal(assign.payload.baseIssueRevision, 35);
  assert.deepEqual(assign.payload.worker, { type: "agent", agentKey: "codeAssistant" });
  const moved = fixture.cases.crossProjectIssueEvent;
  assert.equal(moved.payload.eventType, "issue.updated");
  assert.equal(moved.payload.reason, "moved");
  assert.equal(moved.payload.issue.revision, moved.payload.seq);
  assert.equal(moved.payload.issue.priority, "medium");
  assert.equal(moved.payload.issue.projectVersion, "2.0.0");
  assert.equal(moved.payload.issue.dueDate, "2026-07-18");
  assert.deepEqual(moved.payload.issue.componentKeys, ["sync"]);
  assert.deepEqual(
    [moved.payload.issue.originalEstimate, moved.payload.issue.remainingEstimate, moved.payload.issue.timeSpent],
    [28800, 14400, 7200]
  );
  assert.equal(moved.payload.fromProjectId, "project-1");
  assert.equal(moved.payload.toProjectId, "project-2");
  const snapshot = fixture.cases.projectSetSnapshot.payload;
  assert.equal(snapshot.scope, "project_set");
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.projectIds, ["project-1", "project-2"]);
  assert.deepEqual(snapshot.projects[0].components, ["desktop-shell", "sync"]);
  assert.equal(snapshot.workflowStages[0].color, "#7c3aed");
  const deleted = fixture.cases.projectDeletedEvent.payload;
  assert.deepEqual(deleted.deletedProjectIds, ["project-1", "project-child"]);
  const delivery = fixture.cases.runDelivery.payload.items[0];
  assert.equal(delivery.eventType, "command.runIssue");
  assert.equal(delivery.commandId, "command-1");
  assert.equal(delivery.payload.issue.revision, delivery.sourceRevision);
  assert.equal(delivery.payload.issue.priority, null);
  assert.equal(delivery.payload.issue.dueDate, null);
});
