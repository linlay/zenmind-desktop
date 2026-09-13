import { useId, useState } from "react";
import { CheckOutlined, UserOutlined } from "@ant-design/icons";
import type { AssistantNavAgentItem } from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";
import { AgentIcon } from "../../app-shell/navigation/AgentIcon";

const PREVIEW_AGENT_COUNT = 5;

export function KanbanExecutorPicker({ agents, value, disabled, onChange, defaultValue, onSetDefault, t }: {
  agents: AssistantNavAgentItem[];
  value: string;
  disabled: boolean;
  onChange: (agentKey: string) => void;
  defaultValue: string | null;
  onSetDefault: () => void;
  t: TranslateFunction;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const labelId = useId();
  const listId = useId();
  const preview = agents.slice(0, PREVIEW_AGENT_COUNT);
  const selected = agents.find((agent) => agent.agentKey === value);
  if (selected && !preview.some((agent) => agent.agentKey === value)) preview.push(selected);
  const search = query.trim().toLocaleLowerCase();
  const showUnassigned = !expanded || !search || t("kanban.form.unassigned").toLocaleLowerCase().includes(search);
  const visibleAgents = expanded ? agents.filter((agent) => `${agent.displayName} ${agent.agentKey}`.toLocaleLowerCase().includes(search)) : preview;
  return <div className="kanban-field">
    <div className="kanban-field-head">
      <div className="kanban-executor-heading">
        <span id={labelId}>{t("kanban.form.executor")}</span>
        <button type="button" className="kanban-executor-more" disabled={disabled || defaultValue === value || Boolean(value && !selected)} onClick={onSetDefault}>
          {t(defaultValue === value ? "kanban.form.executorDefault" : "kanban.form.executorSetDefault")}
        </button>
      </div>
      <div className="kanban-executor-actions">
        {expanded && <input className="kanban-executor-search" type="search" value={query}
          aria-label={t("kanban.form.executorSearch")} placeholder={t("kanban.form.executorSearch")}
          onChange={(event) => setQuery(event.target.value)} />}
        {agents.length > PREVIEW_AGENT_COUNT && <button type="button" className="kanban-executor-more"
          aria-expanded={expanded} aria-controls={listId} onClick={() => { setExpanded((current) => !current); setQuery(""); }}>
          {t(expanded ? "kanban.form.executorLess" : "kanban.form.executorMore")}
        </button>}
      </div>
    </div>
    <div id={listId} className="kanban-executor-cards" role="group" aria-labelledby={labelId}>
      {showUnassigned && <button type="button" className="kanban-executor-card" aria-pressed={!value} disabled={disabled} onClick={() => onChange("")}>
        <span className="kanban-executor-avatar" aria-hidden="true"><UserOutlined /></span>
        <span className="kanban-executor-name">{t("kanban.form.unassigned")}</span>
        {!value && <CheckOutlined className="kanban-executor-check" aria-hidden="true" />}
      </button>}
      {visibleAgents.map((agent) => <button key={agent.agentKey} type="button" className="kanban-executor-card"
        title={agent.displayName || agent.agentKey} aria-pressed={value === agent.agentKey} disabled={disabled}
        onClick={() => onChange(agent.agentKey)}>
        <span className="kanban-executor-avatar" aria-hidden="true"><AgentIcon icon={agent.icon} size={20} type="agent" /></span>
        <span className="kanban-executor-name">{agent.displayName || agent.agentKey}</span>
        {value === agent.agentKey && <CheckOutlined className="kanban-executor-check" aria-hidden="true" />}
      </button>)}
      {expanded && search && !showUnassigned && visibleAgents.length === 0 && <small>{t("kanban.form.executorNoResults")}</small>}
      {value && !selected && <button type="button" className="kanban-executor-card" aria-pressed="true" disabled>
        <span className="kanban-executor-name">{value}</span><CheckOutlined aria-hidden="true" />
      </button>}
    </div>
  </div>;
}
