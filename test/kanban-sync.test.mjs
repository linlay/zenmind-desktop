import test from "node:test";
import assert from "node:assert/strict";

const {
  buildKanbanAutomationPayload,
  resolveKanbanRunFinishedPush
} = await import("../dist-electron/main/kanban-sync.js");

test("Kanban sync accepts only the three run.finished status and finishReason pairs", () => {
  assert.deepEqual(resolveKanbanRunFinishedPush({
    frame: "push", type: "run.finished", status: "completed", finishReason: "complete"
  }), { status: "completed", runState: "completed", terminalEventType: "run.completed" });
  assert.deepEqual(resolveKanbanRunFinishedPush({
    frame: "push", type: "run.finished", status: "failed", finishReason: "error"
  }), { status: "todo", runState: "failed", terminalEventType: "run.failed" });
  assert.deepEqual(resolveKanbanRunFinishedPush({
    frame: "push", type: "run.finished", status: "interrupted", finishReason: "cancel"
  }), { status: "todo", runState: "cancelled", terminalEventType: "run.cancelled" });

  for (const event of [
    { frame: "push", type: "run.activity", status: "completed", finishReason: "complete" },
    { frame: "stream", type: "run.finished", status: "completed", finishReason: "complete" },
    { frame: "push", type: "run.finished", status: "completed", finishReason: null },
    { frame: "push", type: "run.finished", status: "completed", finishReason: "error" },
    { frame: "push", type: "run.finished", status: "unknown", finishReason: "complete" },
  ]) {
    assert.equal(resolveKanbanRunFinishedPush(event), null);
  }
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
