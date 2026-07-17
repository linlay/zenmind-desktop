import {
  ClockCircleOutlined,
  MessageOutlined,
  UserOutlined
} from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  AssistantChatSearchResult,
  AssistantNavAgentItem
} from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";
import { getAssistantAwaitingStatusKey } from "../../assistantNavigation";
import { SidebarActionIcon, SidebarIllustration } from "../../components/BrandMark";
import { AgentIcon } from "../navigation/AgentIcon";
import { SettingsSidebarIcon } from "../navigation/SettingsSidebarIcon";
import {
  buildDesktopGlobalSearchSections,
  resolveDesktopGlobalSearchAgentKey,
  type DesktopGlobalSearchActionId,
  type DesktopGlobalSearchRow
} from "./globalSearchRows";

type DesktopGlobalSearchOverlayProps = {
  open: boolean;
  agents: AssistantNavAgentItem[];
  currentRoute: string;
  shortcutLabel: string;
  t: TranslateFunction;
  onClose: () => void;
  onNavigate: (targetPath: string) => void;
};

const SEARCH_DEBOUNCE_MS = 250;

export function DesktopGlobalSearchOverlay(props: DesktopGlobalSearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchRequestIdRef = useRef(0);
  const [query, setQuery] = useState("");
  const [remoteResults, setRemoteResults] = useState<AssistantChatSearchResult[]>([]);
  const [remotePending, setRemotePending] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const currentAgentKey = useMemo(
    () => resolveDesktopGlobalSearchAgentKey(props.currentRoute),
    [props.currentRoute]
  );
  const sections = useMemo(
    () => buildDesktopGlobalSearchSections({
      agents: props.agents,
      query,
      currentAgentKey,
      remoteResults,
      t: props.t
    }),
    [currentAgentKey, props.agents, props.t, query, remoteResults]
  );
  const flatRows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  useEffect(() => {
    if (!props.open) {
      setQuery("");
      setRemoteResults([]);
      setRemoteError("");
      setRemotePending(false);
      return;
    }
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setActiveIndex(0);
  }, [props.open, query]);

  useEffect(() => {
    if (flatRows.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((current) => Math.max(0, Math.min(current, flatRows.length - 1)));
  }, [flatRows.length]);

  useEffect(() => {
    const trimmedQuery = query.trim();
    searchRequestIdRef.current += 1;
    const requestId = searchRequestIdRef.current;
    if (!props.open || !trimmedQuery) {
      setRemoteResults([]);
      setRemotePending(false);
      setRemoteError("");
      return;
    }
    setRemotePending(true);
    setRemoteError("");
    const timer = window.setTimeout(() => {
      window.electronAPI.assistant.searchChats({ query: trimmedQuery, limit: 30 })
        .then((response) => {
          if (searchRequestIdRef.current !== requestId) {
            return;
          }
          setRemoteResults(Array.isArray(response.results) ? response.results : []);
          setRemoteError("");
        })
        .catch((error) => {
          if (searchRequestIdRef.current !== requestId) {
            return;
          }
          setRemoteResults([]);
          setRemoteError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (searchRequestIdRef.current === requestId) {
            setRemotePending(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [props.open, query]);

  if (!props.open) {
    return null;
  }

  const activeRow = flatRows[activeIndex] ?? null;
  const hasQuery = Boolean(query.trim());
  const emptyMessage = hasQuery
    ? props.t("desktop.globalSearch.empty.query")
    : props.t("desktop.globalSearch.empty.default");

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => flatRows.length === 0 ? 0 : (current + 1) % flatRows.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => flatRows.length === 0 ? 0 : (current - 1 + flatRows.length) % flatRows.length);
      return;
    }
    if (event.key === "Enter" && activeRow) {
      event.preventDefault();
      activateRow(activeRow, {
        currentAgentKey,
        onNavigate: props.onNavigate,
        onClose: props.onClose
      });
    }
  };

  let renderedRowIndex = -1;
  return (
    <div className="desktop-global-search-layer" role="presentation" onMouseDown={props.onClose}>
      <section
        className="desktop-global-search-panel"
        role="dialog"
        aria-modal="true"
        aria-label={props.t("desktop.globalSearch.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="desktop-global-search-input-shell">
          <svg className="desktop-global-search-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.8" />
            <line x1="15.5" y1="15.5" x2="20" y2="20" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder={props.t("desktop.globalSearch.placeholder")}
            aria-label={props.t("desktop.globalSearch.placeholder")}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          {props.shortcutLabel ? (
            <kbd title={props.t("desktop.globalSearch.shortcutHint")}>{props.shortcutLabel}</kbd>
          ) : null}
        </div>
        <div className="desktop-global-search-results" role="listbox" aria-label={props.t("desktop.globalSearch.results")}>
          {sections.length > 0 ? sections.map((section) => (
            <div className="desktop-global-search-section" key={section.id}>
              <div className="desktop-global-search-section-title">{section.title}</div>
              {section.rows.map((row) => {
                renderedRowIndex += 1;
                const rowIndex = renderedRowIndex;
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={rowIndex === activeIndex}
                    className={[
                      "desktop-global-search-row",
                      `is-${row.kind}`,
                      row.kind === "chat" && row.hasPendingAwaiting ? "is-awaiting" : "",
                      row.kind === "chat" && row.isUnread ? "is-unread" : "",
                      rowIndex === activeIndex ? "is-active" : ""
                    ].filter(Boolean).join(" ")}
                    onMouseEnter={() => setActiveIndex(rowIndex)}
                    onClick={() => activateRow(row, {
                      currentAgentKey,
                      onNavigate: props.onNavigate,
                      onClose: props.onClose
                    })}
                  >
                    <span className="desktop-global-search-row-icon">
                      {renderRowIcon(row, props.t)}
                    </span>
                    <span className="desktop-global-search-row-body">
                      <span className="desktop-global-search-row-title">{row.label}</span>
                      {row.kind === "agent" && row.description ? (
                        <span className="desktop-global-search-row-detail">{renderRowDetail(row)}</span>
                      ) : null}
                    </span>
                    {row.kind === "chat" ? (
                      <span className="desktop-global-search-row-meta">
                        {renderChatStatus(row, props.t)}
                        <span className="desktop-global-search-row-agent">{row.agentLabel}</span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )) : (
            <div className="desktop-global-search-empty">{emptyMessage}</div>
          )}
        </div>
        {remotePending || remoteError ? (
          <div className={remoteError ? "desktop-global-search-status is-error" : "desktop-global-search-status"}>
            {remoteError || props.t("desktop.globalSearch.searching")}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function activateRow(
  row: DesktopGlobalSearchRow,
  options: { currentAgentKey: string; onNavigate: (targetPath: string) => void; onClose: () => void }
) {
  const targetPath = resolveRowTargetPath(row, options.currentAgentKey);
  if (!targetPath) {
    return;
  }
  options.onNavigate(targetPath);
  options.onClose();
}

function resolveRowTargetPath(row: DesktopGlobalSearchRow, currentAgentKey: string) {
  if (row.kind === "agent") {
    return `/agent/${encodeURIComponent(row.agentKey)}`;
  }
  if (row.kind === "chat") {
    return `/agent/${encodeURIComponent(row.agentKey)}?chatId=${encodeURIComponent(row.chatId)}`;
  }
  return resolveActionTargetPath(row.actionId, currentAgentKey);
}

function resolveActionTargetPath(actionId: DesktopGlobalSearchActionId, currentAgentKey: string) {
  if (actionId === "newChat") {
    if (!currentAgentKey) {
      return "";
    }
    return `/agent/${encodeURIComponent(currentAgentKey)}?newChat=${Date.now()}`;
  }
  if (actionId === "agents") {
    return "/agents";
  }
  if (actionId === "skills") {
    return "/skills";
  }
  if (actionId === "controlCenter") {
    return "/control-center";
  }
  if (actionId === "settings") {
    return "/settings";
  }
  return "";
}

function renderRowIcon(row: DesktopGlobalSearchRow, t: TranslateFunction) {
  if (row.kind === "agent") {
    if (row.projectKind) {
      return <AgentIcon icon={row.projectKind} size={16} type="agent" />;
    }
    return <UserOutlined />;
  }
  if (row.kind === "chat") {
    if (row.hasPendingAwaiting || row.hasActiveRun) {
      return <span className="worker-chat-loading assistant-material-icon is-loading" aria-hidden="true" />;
    }
    if (row.isUnread) {
      return (
        <span
          className="assistant-worker-unread-dot chat-unread-dot is-unread"
          aria-label={t("sidebar.chat.unread")}
        />
      );
    }
    return row.source === "remote" ? <MessageOutlined /> : <ClockCircleOutlined />;
  }
  if (row.actionId === "newChat") {
    return <SidebarActionIcon kind="new_chat" />;
  }
  if (row.actionId === "agents") {
    return <SidebarIllustration kind="agent" />;
  }
  if (row.actionId === "skills") {
    return <SidebarIllustration kind="skill" />;
  }
  if (row.actionId === "controlCenter") {
    return <SettingsSidebarIcon kind="control" />;
  }
  return <SidebarIllustration kind="settings" />;
}

function renderRowDetail(row: Extract<DesktopGlobalSearchRow, { kind: "agent" }>) {
  return row.description;
}

function renderChatStatus(row: Extract<DesktopGlobalSearchRow, { kind: "chat" }>, t: TranslateFunction) {
  if (row.hasPendingAwaiting) {
    return (
      <span className="desktop-global-search-row-status is-awaiting">
        {t(getAssistantAwaitingStatusKey(row.awaitingMode))}
      </span>
    );
  }
  if (row.hasActiveRun) {
    return (
      <span className="desktop-global-search-row-status is-running">
        {t("desktop.globalSearch.status.running")}
      </span>
    );
  }
  return null;
}
