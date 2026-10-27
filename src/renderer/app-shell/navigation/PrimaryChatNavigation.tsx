import type { HTMLAttributes } from "react";
import type { AssistantNavAgentItem } from "../../../shared/contracts";
import { AgentIcon } from "./AgentIcon";
import { MaterialIcon } from "../../components/icons/MaterialIcon";
import { useI18n } from "../../i18n/useI18n";
import "./PrimaryChatNavigation.css";

export function PrimaryChatNavigation({ agents, collapsed, currentChatId, loaded, error, onRetry, onOpen, onHistory, itemProps }: {
  agents: AssistantNavAgentItem[]; collapsed: boolean; currentChatId: string; loaded: boolean; error: string; onRetry: () => void;
  onOpen: (agent: AssistantNavAgentItem) => void;
  onHistory: (agentKey?: string) => void;
  itemProps: (id: string) => HTMLAttributes<HTMLButtonElement>;
}) {
  const { t } = useI18n();
  return <section className={`primary-chat-navigation${collapsed ? " is-collapsed" : ""}`} aria-label={t("sidebar.primaryChats.title")}>
    {!collapsed && <div className="primary-chat-heading"><span>{t("sidebar.primaryChats.title")}</span>
      <button type="button" onClick={() => onHistory()}>{t("sidebar.primaryChats.history")}</button></div>}
    {agents.map(agent => {
      const chat = agent.primaryChat;
      const preview = chat ? (chat.lastRunContent || chat.chatName || t("sidebar.primaryChats.noReply")).replace(/\s+/gu, " ") : t("sidebar.primaryChats.noChat");
      const status = chat?.hasPendingAwaiting ? t("sidebar.agent.awaiting") : chat?.hasActiveRun ? t("sidebar.agent.running") : chat && !chat.isRead ? t("sidebar.chat.unread") : "";
      return <div className="primary-chat-row" key={agent.agentKey}>
        <button data-agent-pointer-idle="" data-agent-identity="" type="button" {...itemProps(`primary:${agent.agentKey}`)}
          className={`primary-chat-item${chat && chat.chatId === currentChatId ? " is-active" : ""}`}
          aria-current={chat && chat.chatId === currentChatId ? "page" : undefined}
          title={`${agent.displayName}\n${preview}${status ? ` · ${status}` : ""}`}
          aria-label={`${agent.displayName}, ${preview}${status ? `, ${status}` : ""}`}
          onClick={() => onOpen(agent)}>
          <AgentIcon icon={agent.icon} mode={agent.mode} size={30} />
          {!collapsed && <span className="primary-chat-body"><span className="primary-chat-name">{agent.displayName}</span><span className="primary-chat-preview">{preview}</span></span>}
          <span className="primary-chat-status">
            {chat?.hasPendingAwaiting ? <MaterialIcon name="front_hand" size={13} /> : chat?.hasActiveRun ? <MaterialIcon name="progress_activity" size={13} className="primary-chat-spinner" /> : chat && !chat.isRead ? <span className="assistant-worker-unread-dot chat-unread-dot is-unread" /> : null}
          </span>
        </button>
        {!collapsed && <button type="button" className="primary-chat-history" aria-label={`${agent.displayName}: ${t("sidebar.primaryChats.history")}`}
          title={t("sidebar.primaryChats.history")} onClick={() => onHistory(agent.agentKey)}><MaterialIcon name="history" size={15} /></button>}
      </div>;
    })}
    {error && <div className="primary-chat-error" role="alert">{!collapsed && <span>{error}</span>}<button type="button" title={error} onClick={onRetry}>{t("sidebar.primaryChats.retry")}</button></div>}
    {!error && !agents.length && <div className="sidebar-empty-hint" role="status">{t(loaded ? "sidebar.primaryChats.empty" : "sidebar.primaryChats.loading")}</div>}
  </section>;
}
