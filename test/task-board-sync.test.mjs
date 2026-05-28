import test from "node:test";
import assert from "node:assert/strict";

const {
  buildTaskBoardAutomationPayload,
  resolveTaskBoardRunStateFromAssistantEvent,
  resolveTaskBoardStatusFromAssistantEvent
} = await import("../dist-electron/main/task-board-sync.js");

test("task board sync maps assistant terminal events to task board run state", () => {
  assert.equal(resolveTaskBoardStatusFromAssistantEvent({ type: "run.complete" }), "completed");
  assert.equal(resolveTaskBoardRunStateFromAssistantEvent({ type: "run.complete" }), "completed");
  assert.equal(resolveTaskBoardRunStateFromAssistantEvent({ status: "cancelled" }), "cancelled");
  assert.equal(resolveTaskBoardRunStateFromAssistantEvent({ type: "run.expired" }), "failed");
  assert.equal(resolveTaskBoardRunStateFromAssistantEvent({ type: "run.start" }), null);
});

test("task board automation payload keeps task context hidden in the platform query", () => {
  const payload = buildTaskBoardAutomationPayload({
    id: "ISSUE1",
    title: "Review startup split",
    description: "Check controller wiring",
    assigneeAgentKey: "coder",
    automationCron: " 0 9 * * * ",
    automationMessage: "Run the regression checks",
    automationTimezone: "",
    status: "todo",
    priority: "medium",
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

  assert.equal(payload.name, "任务看板 ISSUE1: Review startup split");
  assert.equal(payload.cron, "0 9 * * *");
  assert.equal(payload.agentKey, "coder");
  assert.equal(payload.zoneId, "Asia/Shanghai");
  assert.equal(payload.query.hidden, true);
  assert.match(payload.query.message, /任务编号：ISSUE1/u);
  assert.deepEqual(payload.query.params, {
    source: "task-board",
    issueId: "ISSUE1"
  });
});
