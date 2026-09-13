import { useState } from "react";
import { Button, Input, Modal, Switch } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import type { KanbanLocalWorkflow } from "../../../shared/contracts";
import { useI18n } from "../../i18n/useI18n";

export function LocalWorkflowSettings({ workflows, onClose, onSaved }: {
  workflows: KanbanLocalWorkflow[];
  onClose: () => void;
  onSaved: (workflows: KanbanLocalWorkflow[]) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => structuredClone(workflows));
  const [selected, setSelected] = useState(workflows[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const workflow = draft.find((item) => item.id === selected);
  const change = (next: KanbanLocalWorkflow) => setDraft((items) => items.map((item) => item.id === next.id ? next : item));
  const valid = draft.length > 0 && draft.every((item) => item.name.trim() && item.stages.length > 0 && item.stages.every((stage, index) => stage.name.trim() && (!stage.rollbackToStageId || item.stages.slice(0, index).some((previous) => previous.id === stage.rollbackToStageId))));
  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await window.electronAPI.kanban.saveLocalWorkflows(draft);
      if (!result.ok) throw new Error(result.message);
      onSaved(result.localWorkflows ?? draft);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSaving(false); }
  }
  return <Modal open title={t("kanban.localWorkflow.title")} width={860} onCancel={saving ? undefined : onClose}
    maskClosable={!saving} closable={!saving} keyboard={!saving}
    footer={<><Button disabled={saving} onClick={onClose}>{t("kanban.localWorkflow.cancel")}</Button><Button type="primary" loading={saving} disabled={!valid} onClick={() => void save()}>{t("kanban.localWorkflow.save")}</Button></>}>
    <p>{t("kanban.localWorkflow.scope")}</p>
    <div className="kanban-workflow-tabs">
      {draft.map((item) => <Button key={item.id} disabled={saving} type={selected === item.id ? "primary" : "default"} onClick={() => setSelected(item.id)}>{item.name || t("kanban.localWorkflow.untitled")}</Button>)}
      <Button icon={<PlusOutlined />} disabled={saving || draft.length >= 20} onClick={() => {
        const item = { id: `local-${crypto.randomUUID()}`, name: t("kanban.localWorkflow.untitled"), stages: [{ id: crypto.randomUUID(), name: t("kanban.localWorkflow.development"), reviewRequired: true }] };
        setDraft([...draft, item]); setSelected(item.id);
      }}>{t("kanban.localWorkflow.add")}</Button>
    </div>
    {workflow && <fieldset disabled={saving} className="kanban-workflow-editor">
      <div className="kanban-workflow-name"><Input aria-label={t("kanban.localWorkflow.name")} maxLength={80} value={workflow.name} onChange={(event) => change({ ...workflow, name: event.target.value })} />
        <Button danger disabled={saving || draft.length <= 1} onClick={() => {
          const remaining = draft.filter((item) => item.id !== selected); setDraft(remaining); setSelected(remaining[0].id);
        }}>{t("kanban.localWorkflow.remove")}</Button></div>
      <div className="kanban-workflow-preview" aria-label={t("kanban.localWorkflow.preview")}>
        {workflow.stages.map((stage, index) => <div className="kanban-workflow-preview-stage" key={stage.id}>
          <strong>{index + 1}. {stage.name}</strong><span>{t("kanban.status.todo")} → {t("kanban.status.inProgress")}</span>
          {stage.reviewRequired && <span>{t("kanban.localWorkflow.review")}</span>}
          <small>{index === workflow.stages.length - 1 ? t("kanban.status.completed") : t("kanban.localWorkflow.next")}</small>
          {stage.rollbackToStageId && <small className="kanban-workflow-rollback-hint">↶ {t("kanban.localWorkflow.rollbackTo", { value: workflow.stages.find((item) => item.id === stage.rollbackToStageId)?.name ?? t("kanban.localWorkflow.invalidTargetLabel") })}</small>}
        </div>)}
      </div>
      <p>{t("kanban.localWorkflow.rollbackDefinitionHelp")}</p>
      {workflow.stages.map((stage, index) => <div className="kanban-workflow-stage-editor" key={stage.id}><div className="kanban-workflow-stage-row">
        <span>{index + 1}</span><Input maxLength={80} aria-label={t("kanban.localWorkflow.stageName")} value={stage.name} onChange={(event) => change({ ...workflow, stages: workflow.stages.map((item) => item.id === stage.id ? { ...item, name: event.target.value } : item) })} />
        <label><Switch size="small" disabled={saving} checked={stage.reviewRequired} onChange={(checked) => change({ ...workflow, stages: workflow.stages.map((item) => item.id === stage.id ? { ...item, reviewRequired: checked } : item) })} /> {t("kanban.localWorkflow.review")}</label>
        {([-1, 1] as const).map((direction) => <Button key={direction} disabled={saving || index + direction < 0 || index + direction >= workflow.stages.length} aria-label={t(direction < 0 ? "kanban.localWorkflow.up" : "kanban.localWorkflow.down")} icon={direction < 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />} onClick={() => {
          const stages = [...workflow.stages]; [stages[index], stages[index + direction]] = [stages[index + direction], stages[index]]; change({ ...workflow, stages });
        }} />)}
        <Button danger disabled={saving || workflow.stages.length <= 1} aria-label={t("kanban.localWorkflow.removeStage")} icon={<DeleteOutlined />} onClick={() => change({ ...workflow, stages: workflow.stages.filter((item) => item.id !== stage.id) })} />
      </div>
        <label className="kanban-workflow-rollback-target">
          <span>{t("kanban.localWorkflow.rollbackTarget")}</span>
          <select aria-label={t("kanban.localWorkflow.rollbackTargetFor", { value: stage.name })} value={stage.rollbackToStageId ?? ""} onChange={(event) => change({ ...workflow, stages: workflow.stages.map((item) => {
            if (item.id !== stage.id) return item;
            const { rollbackToStageId: _previous, ...definition } = item;
            return { ...definition, ...(event.target.value ? { rollbackToStageId: event.target.value } : {}) };
          }) })}>
            <option value="">{t("kanban.localWorkflow.noRollback")}</option>
            {workflow.stages.slice(0, index).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
            {stage.rollbackToStageId && !workflow.stages.slice(0, index).some((item) => item.id === stage.rollbackToStageId) && <option disabled value={stage.rollbackToStageId}>{t("kanban.localWorkflow.invalidTargetLabel")}</option>}
          </select>
        </label>
      </div>)}
      <Button icon={<PlusOutlined />} disabled={saving || workflow.stages.length >= 12} onClick={() => change({ ...workflow, stages: [...workflow.stages, { id: crypto.randomUUID(), name: t("kanban.localWorkflow.newStage"), reviewRequired: false }] })}>{t("kanban.localWorkflow.addStage")}</Button>
    </fieldset>}
    {!valid && <p role="alert" className="kanban-workflow-error">{t("kanban.localWorkflow.invalidDefinitionHelp")}</p>}
    {error && <p role="alert" className="kanban-workflow-error">{error}</p>}
  </Modal>;
}
