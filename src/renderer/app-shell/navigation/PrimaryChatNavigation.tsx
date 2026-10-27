import { useEffect, useRef, useState, type HTMLAttributes, type MouseEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay, KeyboardCode, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { AssistantNavAgentItem } from "../../../shared/contracts";
import { AgentIcon } from "./AgentIcon";
import { MaterialIcon } from "../../components/icons/MaterialIcon";
import { useI18n } from "../../i18n/useI18n";
import "./PrimaryChatNavigation.css";

type Props = {
  agents: AssistantNavAgentItem[];
  collapsed: boolean;
  currentChatId: string;
  loaded: boolean;
  error: string;
  onRetry: () => void;
  onOpen: (agent: AssistantNavAgentItem) => void;
  onHistory: (agentKey?: string) => void;
  onContextMenu: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, agent: AssistantNavAgentItem) => void;
  onReorder?: (agentKeys: string[]) => Promise<{ ok: boolean; agentKeys: string[]; message: string }>;
  itemProps: (id: string) => HTMLAttributes<HTMLButtonElement>;
};

function PrimaryAgentRow({ agent, props, disabled, drop, suppressClick }: {
  agent: AssistantNavAgentItem; props: Props; disabled: boolean;
  drop: "before" | "after" | undefined; suppressClick: () => boolean;
}) {
  const { t } = useI18n();
  const sortable = useSortable({ id: agent.agentKey, disabled });
  const chat = agent.primaryChat;
  const preview = chat ? (chat.lastRunContent || chat.chatName || t("sidebar.primaryChats.noReply")).replace(/\s+/gu, " ") : t("sidebar.primaryChats.noChat");
  const status = chat?.hasPendingAwaiting ? t("sidebar.agent.awaiting") : chat?.hasActiveRun ? t("sidebar.agent.running") : chat && !chat.isRead ? t("sidebar.chat.unread") : "";
  const roving = props.itemProps(`primary:${agent.agentKey}`);
  return <div className={`primary-chat-row${sortable.isDragging ? " is-dragging" : ""}${drop ? ` drop-${drop}` : ""}`}>
    <button data-agent-pointer-idle="" data-agent-identity="" data-primary-agent-key={agent.agentKey}
      type="button" {...sortable.attributes} {...sortable.listeners} {...roving} aria-disabled={undefined}
      ref={node => { sortable.setNodeRef(node); sortable.setActivatorNodeRef(node); }}
      className={`primary-chat-item${chat && chat.chatId === props.currentChatId ? " is-active" : ""}`}
      aria-current={chat && chat.chatId === props.currentChatId ? "page" : undefined}
      title={`${agent.displayName}\n${preview}${status ? ` · ${status}` : ""}`}
      aria-label={`${agent.displayName}, ${preview}${status ? `, ${status}` : ""}`}
      onKeyDown={event => {
        // Menu-key support uses the same native Agent menu in both sidebar widths.
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault(); event.stopPropagation();
          props.onContextMenu(event, agent);
          return;
        }
        if (event.key === "Enter" && !event.currentTarget.closest('[data-primary-agent-dragging="true"]')) {
          event.preventDefault();
          if (!suppressClick()) props.onOpen(agent);
          return;
        }
        sortable.listeners?.onKeyDown?.(event);
        roving.onKeyDown?.(event);
      }}
      onContextMenu={event => props.onContextMenu(event, agent)}
      onClick={() => { if (!suppressClick()) props.onOpen(agent); }}>
      <AgentIcon icon={agent.icon} mode={agent.mode} size={30} />
      {!props.collapsed && <span className="primary-chat-body"><span className="primary-chat-name">{agent.displayName}</span><span className="primary-chat-preview">{preview}</span></span>}
      <span className="primary-chat-status">
        {chat?.hasPendingAwaiting ? <MaterialIcon name="front_hand" size={13} /> : chat?.hasActiveRun ? <MaterialIcon name="progress_activity" size={13} className="primary-chat-spinner" /> : chat && !chat.isRead ? <span className="assistant-worker-unread-dot chat-unread-dot is-unread" /> : null}
      </span>
    </button>
    {!props.collapsed && <button type="button" className="primary-chat-history" aria-label={`${agent.displayName}: ${t("sidebar.primaryChats.history")}`}
      title={t("sidebar.primaryChats.history")} onClick={() => props.onHistory(agent.agentKey)}><MaterialIcon name="history" size={15} /></button>}
  </div>;
}

export function PrimaryChatNavigation(props: Props) {
  const { agents, collapsed, loaded, error, onRetry, onHistory, onReorder } = props;
  const { t } = useI18n();
  const [displayAgents, setDisplayAgents] = useState(agents);
  const [activeKey, setActiveKey] = useState("");
  const [overKey, setOverKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const suppressClickUntil = useRef(0);
  const pending = useRef(false);
  const latestAgents = useRef(agents);
  latestAgents.current = agents;
  useEffect(() => { if (!pending.current) setDisplayAgents(agents); }, [agents]);
  // Reuse Project-style activation; Enter stays available for normal navigation.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: [KeyboardCode.Space], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab] } }),
  );
  const active = displayAgents.find(agent => agent.agentKey === activeKey);
  const activeIndex = displayAgents.findIndex(agent => agent.agentKey === activeKey);
  const overIndex = displayAgents.findIndex(agent => agent.agentKey === overKey);
  const disabled = collapsed || saving || !onReorder || agents.length < 2;
  function finishDrag() {
    setActiveKey(""); setOverKey("");
    suppressClickUntil.current = Date.now() + 250;
  }
  async function saveOrder(activeId: string, overId: string) {
    finishDrag();
    if (!onReorder || pending.current || activeId === overId) return;
    const from = displayAgents.findIndex(agent => agent.agentKey === activeId);
    const to = displayAgents.findIndex(agent => agent.agentKey === overId);
    if (from < 0 || to < 0) return;
    const next = [...displayAgents];
    next.splice(to, 0, next.splice(from, 1)[0]);
    pending.current = true;
    setDisplayAgents(next); setSaving(true); setSaveError("");
    try {
      const result = await onReorder(next.map(agent => agent.agentKey));
      if (!result.ok) throw new Error(result.message || t("sidebar.primaryChats.orderFailed"));
      // Use current summaries, including Push updates received while saving.
      const current = new Map(latestAgents.current.map(agent => [agent.agentKey, agent]));
      const ordered = result.agentKeys.flatMap(key => {
        const agent = current.get(key); current.delete(key); return agent ? [agent] : [];
      });
      setDisplayAgents([...ordered, ...current.values()]);
    } catch (failure) {
      setDisplayAgents(latestAgents.current);
      setSaveError(failure instanceof Error ? failure.message : t("sidebar.primaryChats.orderFailed"));
    } finally {
      pending.current = false; setSaving(false);
    }
  }
  return <section className={`primary-chat-navigation${collapsed ? " is-collapsed" : ""}`} aria-label={t("sidebar.primaryChats.title")} aria-busy={saving}
    data-primary-agent-dragging={Boolean(activeKey)}>
    {!collapsed && <div className="primary-chat-heading"><span>{t("sidebar.primaryChats.title")}</span>
      <button type="button" onClick={() => onHistory()}>{t("sidebar.primaryChats.history")}</button></div>}
    <DndContext sensors={sensors} collisionDetection={closestCenter}
      onDragStart={event => { setActiveKey(String(event.active.id)); setSaveError(""); }}
      onDragOver={event => setOverKey(event.over ? String(event.over.id) : "")}
      onDragCancel={finishDrag}
      onDragEnd={event => { if (event.over) void saveOrder(String(event.active.id), String(event.over.id)); else finishDrag(); }}>
      <SortableContext items={displayAgents.map(agent => agent.agentKey)} strategy={verticalListSortingStrategy}>
        {displayAgents.map(agent => <PrimaryAgentRow key={agent.agentKey} agent={agent} props={props} disabled={disabled}
          suppressClick={() => Date.now() < suppressClickUntil.current}
          drop={overKey === agent.agentKey && activeIndex !== overIndex ? activeIndex > overIndex ? "before" : "after" : undefined} />)}
      </SortableContext>
      {typeof document !== "undefined" && createPortal(<DragOverlay dropAnimation={null}>{active ? <div className="sidebar-project-drag-overlay">{active.displayName}</div> : null}</DragOverlay>, document.body)}
    </DndContext>
    {(error || saveError) && <div className="primary-chat-error" role="alert">{!collapsed && <span>{error || saveError}</span>}<button type="button" title={error || saveError} onClick={() => { setSaveError(""); onRetry(); }}>{t("sidebar.primaryChats.retry")}</button></div>}
    {!error && !agents.length && <div className="sidebar-empty-hint" role="status">{t(loaded ? "sidebar.primaryChats.empty" : "sidebar.primaryChats.loading")}</div>}
  </section>;
}
