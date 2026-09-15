import { randomUUID } from "node:crypto";
import type { KanbanCurrentUser, KanbanIssue, KanbanLocalWorkflow, KanbanLocalWorkflowAction } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";

export function applyLocalWorkflowAction(
  issue: KanbanIssue,
  action: KanbanLocalWorkflowAction,
  user: KanbanCurrentUser,
  templates: KanbanLocalWorkflow[]
): KanbanIssue {
  if (!action || !issue.localWorkflow || issue.syncMode === "cloud") throw new Error(t("kanban.localWorkflow.invalidAction"));
  if (issue.runId || issue.activeRunId || issue.runState === "running") throw new Error(t("kanban.localWorkflow.running"));
  const workflow = issue.localWorkflow;
  const updatedAt = new Date().toISOString();
  if (action.type === "refresh_rollback_rules") {
    const template = templates.find((item) => item.id === workflow.id);
    if (!template || template.stages.length !== workflow.stages.length
      || template.stages.some((stage, index) => stage.id !== workflow.stages[index].id)) {
      throw new Error(t("kanban.localWorkflow.templateMismatch"));
    }
    // Explicitly adopt only rollback rules. Keep the issue's stage, review requirements and names.
    return { ...issue, updatedAt, localWorkflow: { ...workflow, stages: workflow.stages.map((stage, index) => {
      const { rollbackToStageId: _previous, ...definition } = stage;
      const target = template.stages[index].rollbackToStageId;
      return { ...definition, ...(target === undefined ? {} : { rollbackToStageId: target }) };
    }) } };
  }
  if (action.type !== "rollback") throw new Error(t("kanban.localWorkflow.invalidAction"));
  if (issue.status === "completed" || issue.stageId !== action.fromStageId || issue.status !== action.fromStatus) {
    throw new Error(t("kanban.localWorkflow.staleAction"));
  }
  const index = workflow.stages.findIndex((stage) => stage.id === issue.stageId);
  const targetIndex = workflow.stages.findIndex((stage) => stage.id === action.toStageId);
  const stage = workflow.stages[index];
  if (!stage || !stage.rollbackToStageId || action.toStageId !== stage.rollbackToStageId || targetIndex < 0 || targetIndex >= index) {
    throw new Error(t("kanban.localWorkflow.invalidRollbackTarget"));
  }
  const reason = typeof action.reason === "string" ? action.reason.trim() : "";
  if (!reason || reason.length > 2000) throw new Error(t("kanban.localWorkflow.reasonRequired"));
  const target = workflow.stages[targetIndex];
  return {
    ...issue, updatedAt, stageId: target.id, stageKey: target.id, stageName: target.name, status: "todo",
    chatId: null, runId: null, activeRunId: null, runState: null,
    lastRunId: null, lastRunChatId: null,
    runAgentKey: null, runCommandId: null, runStartedAt: null, runFinishedAt: null, runResultMessage: null, runErrorMessage: null,
    localWorkflowRollbacks: [...(issue.localWorkflowRollbacks ?? []), {
      id: randomUUID(), fromStageId: stage.id, fromStageName: stage.name, fromStatus: issue.status,
      toStageId: target.id, toStageName: target.name, reason, actorId: user.id, actorName: user.name, createdAt: updatedAt
    }]
  };
}
