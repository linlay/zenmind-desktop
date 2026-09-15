import type { DatabaseSync } from "node:sqlite";
import type { KanbanIssue, KanbanLocalWorkflow, KanbanStatus } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";

export function defaultLocalWorkflows(): KanbanLocalWorkflow[] {
  const development = [
    { id: "development", name: t("kanban.localWorkflow.development"), reviewRequired: true },
    { id: "testing", name: t("kanban.localWorkflow.testing"), reviewRequired: true, rollbackToStageId: "development" },
    { id: "submit", name: t("kanban.localWorkflow.submit"), reviewRequired: false, rollbackToStageId: "testing" }
  ];
  return [
    { id: "local-development", name: t("kanban.localWorkflow.developmentFlow"), stages: development },
    { id: "local-bug", name: t("kanban.localWorkflow.bugFlow"), stages: [
      { id: "report", name: t("kanban.localWorkflow.report"), reviewRequired: false }, ...development
    ] }
  ];
}

export function validateLocalWorkflows(input: unknown): KanbanLocalWorkflow[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error(t("kanban.localWorkflow.invalid"));
  const ids = new Set<string>();
  const validText = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
  return input.map((workflow) => {
    if (!workflow || !validText(workflow.id, 100) || !workflow.id.startsWith("local-") || ids.has(workflow.id)
      || !validText(workflow.name, 80) || !Array.isArray(workflow.stages) || workflow.stages.length < 1 || workflow.stages.length > 12) {
      throw new Error(t("kanban.localWorkflow.invalid"));
    }
    ids.add(workflow.id);
    const stages = new Set<string>();
    return { id: workflow.id, name: workflow.name.trim(), stages: workflow.stages.map((stage: KanbanLocalWorkflow["stages"][number]) => {
      if (!stage || !validText(stage.id, 100) || stages.has(stage.id) || !validText(stage.name, 80) || typeof stage.reviewRequired !== "boolean") {
        throw new Error(t("kanban.localWorkflow.invalid"));
      }
      // A rollback may only target an earlier stage in this same definition.
      if (stage.rollbackToStageId !== undefined && (!validText(stage.rollbackToStageId, 100) || !stages.has(stage.rollbackToStageId))) {
        throw new Error(t("kanban.localWorkflow.invalidRollbackTarget"));
      }
      stages.add(stage.id);
      return { id: stage.id, name: stage.name.trim(), reviewRequired: stage.reviewRequired,
        ...(stage.rollbackToStageId !== undefined ? { rollbackToStageId: stage.rollbackToStageId } : {}) };
    }) };
  });
}

export function readLocalWorkflows(db: DatabaseSync, boardId: string): KanbanLocalWorkflow[] {
  const row = db.prepare("SELECT VALUE_ AS value FROM board_meta WHERE BOARD_ID_ = ? AND KEY_ = 'local_workflows'").get(boardId) as { value: string } | undefined;
  return row ? validateLocalWorkflows(JSON.parse(row.value)) : defaultLocalWorkflows();
}

export function initializeLocalWorkflow(issue: KanbanIssue, workflow: KanbanLocalWorkflow) {
  // Freeze the definition on each issue: editing templates never changes work already in flight.
  issue.localWorkflow = structuredClone(workflow);
  issue.workflowId = workflow.id;
  issue.stageId = workflow.stages[0].id;
  issue.stageName = workflow.stages[0].name;
  issue.stageKey = workflow.stages[0].id;
  issue.status = "todo";
}

export function moveLocalWorkflow(issue: KanbanIssue, status: KanbanStatus): KanbanIssue {
  const next = { ...issue, status };
  const workflow = issue.syncMode !== "cloud" ? issue.localWorkflow : undefined;
  if (!workflow || status !== "completed" || issue.status === "completed") return next;
  const index = workflow.stages.findIndex((stage) => stage.id === issue.stageId);
  if (index < 0) throw new Error(t("kanban.localWorkflow.invalid"));
  const stage = workflow.stages[index];
  if (stage.reviewRequired && issue.status !== "in_review") return { ...next, status: "in_review" };
  const following = workflow.stages[index + 1];
  if (!following) return next;
  return { ...next, stageId: following.id, stageKey: following.id, stageName: following.name,
    status: "todo", chatId: null, runId: null, activeRunId: null, runState: null };
}
