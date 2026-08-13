import test from "node:test";
import assert from "node:assert/strict";

const {
  buildKanbanAutomationPayload,
  resolveKanbanRunStateFromAssistantEvent,
  resolveKanbanStatusFromAssistantEvent
} = await import("../dist-electron/main/kanban-sync.js");

test("Kanban sync maps assistant terminal events to Kanban run state", () => {
  assert.equal(resolveKanbanStatusFromAssistantEvent({ type: "run.complete" }), "completed");
  assert.equal(resolveKanbanStatusFromAssistantEvent({ type: "run.completed" }), "completed");
  assert.equal(resolveKanbanStatusFromAssistantEvent({ type: "completed" }), "completed");
  assert.equal(resolveKanbanStatusFromAssistantEvent({ status: "succeeded" }), "completed");
  assert.equal(resolveKanbanStatusFromAssistantEvent({ status: "success" }), "completed");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ type: "run.complete" }), "completed");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ type: "run.completed" }), "completed");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ type: "completed" }), "completed");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ status: "succeeded" }), "completed");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ status: "success" }), "completed");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ status: "cancelled" }), "cancelled");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ type: "run.cancelled" }), "cancelled");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ type: "run.failed" }), "failed");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ type: "run.expired" }), "failed");
  assert.equal(resolveKanbanRunStateFromAssistantEvent({ type: "run.start" }), null);
});

test("Kanban automation payload keeps issue context hidden in the platform query", () => {
  const payload = buildKanbanAutomationPayload({
    id: "ISSUE1",
    title: "Review startup split",
    description: "Check controller wiring",
    assigneeAgentKey: "coder",
    automationCron: " 0 9 * * * ",
    automationMessage: "Run the regression checks",
    automationTimezone: "",
    status: "todo",
    priority: "P2",
    position: 1,
    chatId: null,
    runId: null,
    runState: null,
    automationId: null,
    automationEnabled: true,
    attachmentChatId: null,
    attachments: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z"
  });

  assert.equal(payload.name, "看板 ISSUE1: Review startup split");
  assert.equal(payload.cron, "0 9 * * *");
  assert.equal(payload.agentKey, "coder");
  assert.equal(payload.zoneId, "Asia/Shanghai");
  assert.equal(payload.query.hidden, true);
  assert.match(payload.query.message, /问题编号：ISSUE1/u);
  assert.deepEqual(payload.query.params, {
    source: "kanban",
    issueId: "ISSUE1"
  });
});
