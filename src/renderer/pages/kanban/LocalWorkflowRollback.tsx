import { useState } from "react";
import type { KanbanIssue, KanbanLocalWorkflow, KanbanLocalWorkflowAction } from "../../../shared/contracts";
import { useI18n } from "../../i18n/useI18n";

export function LocalWorkflowRollback({ issue, templates, disabled, onAction }: {
  issue: KanbanIssue;
  templates: KanbanLocalWorkflow[];
  disabled: boolean;
  onAction: (action: KanbanLocalWorkflowAction) => Promise<boolean>;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const workflow = issue.localWorkflow;
  if (!workflow || issue.syncMode === "cloud") return null;
  const stageIndex = workflow.stages.findIndex((stage) => stage.id === issue.stageId);
  const stage = workflow.stages[stageIndex];
  const target = workflow.stages.slice(0, stageIndex).find((item) => item.id === stage?.rollbackToStageId);
  const template = templates.find((item) => item.id === workflow.id);
  const canRefresh = template?.stages.length === workflow.stages.length
    && template.stages.every((item, index) => item.id === workflow.stages[index].id)
    && template.stages.some((item, index) => item.rollbackToStageId !== workflow.stages[index].rollbackToStageId);
  const running = Boolean(issue.runId || issue.activeRunId || issue.runState === "running");
  const blocked = disabled || busy || running;
  async function perform(action: KanbanLocalWorkflowAction) {
    setBusy(true); setError("");
    try {
      if (await onAction(action)) { setOpen(false); setReason(""); }
      else setError(t("kanban.localWorkflow.actionFailed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }
  return <div className="kanban-workflow-rollback">
    {target && issue.status !== "completed" && <button type="button" className="kanban-detail-secondary-button" disabled={blocked} onClick={() => setOpen(!open)}>
      ↶ {t("kanban.localWorkflow.rollbackTo", { value: target.name })}
    </button>}
    {running && target && <p>{t("kanban.localWorkflow.running")}</p>}
    {open && target && <div className="kanban-workflow-rollback-form">
      <p>{t("kanban.localWorkflow.rollbackEffect", { value: target.name })}</p>
      <label>{t("kanban.localWorkflow.rollbackReason")}
        <textarea autoFocus rows={3} maxLength={2000} disabled={blocked} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="kanban-workflow-tabs">
        <button type="button" className="kanban-detail-primary-button" disabled={blocked || !reason.trim()} onClick={() => void perform({ type: "rollback", fromStageId: issue.stageId ?? "", fromStatus: issue.status, toStageId: target.id, reason })}>{t("kanban.localWorkflow.confirmRollback")}</button>
        <button type="button" className="kanban-detail-secondary-button" disabled={busy} onClick={() => setOpen(false)}>{t("kanban.localWorkflow.cancel")}</button>
      </div>
    </div>}
    {canRefresh && <div className="kanban-workflow-refresh">
      <p>{t("kanban.localWorkflow.refreshHelp")}</p>
      <button type="button" className="kanban-detail-secondary-button" disabled={blocked || open} onClick={() => void perform({ type: "refresh_rollback_rules" })}>{t("kanban.localWorkflow.refreshRules")}</button>
    </div>}
    {error && <p role="alert" className="kanban-workflow-error">{error}</p>}
    {!!issue.localWorkflowRollbacks?.length && <details className="kanban-workflow-rollback-history">
      <summary>{t("kanban.localWorkflow.rollbackHistory")}</summary>
      {[...issue.localWorkflowRollbacks].reverse().map((entry) => <article key={entry.id}>
        <strong>{entry.fromStageName} → {entry.toStageName}</strong>
        <small>{entry.actorName} · {new Date(entry.createdAt).toLocaleString(locale)}</small>
        <p>{entry.reason}</p>
      </article>)}
    </details>}
  </div>;
}
