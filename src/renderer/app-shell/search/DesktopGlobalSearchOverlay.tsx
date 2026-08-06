import {
  ClockCircleOutlined,
  MessageOutlined,
  UserOutlined
} from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  AssistantChatSearchResult,
  AssistantNavAgentItem,
  DesktopGlobalSearchShortcut,
  DesktopGlobalSearchShortcutSlot
} from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";
import {
  createAgentWebclientAgentPath,
  createAgentWebclientRoute,
} from "../../../shared/agent-webclient-routes";
import { getAssistantAwaitingStatusKey } from "../../assistantNavigation";
import { SidebarActionIcon, SidebarIllustration } from "../../components/BrandMark";
import { AgentIcon } from "../navigation/AgentIcon";
import {
  buildDesktopGlobalSearchSections,
  buildDesktopGlobalSearchShortcutTargets,
  resolveDesktopGlobalSearchAgentKey,
  type DesktopGlobalSearchActionId,
  type DesktopGlobalSearchRow,
  type DesktopGlobalSearchShortcutTargets
} from "./globalSearchRows";

type DesktopGlobalSearchOverlayProps = {
  open: boolean;
  agents: AssistantNavAgentItem[];
  currentRoute: string;
  defaultChatAgentKey: string;
  shortcutPlatform: "darwin" | "win32" | null;
  t: TranslateFunction;
  onClose: () => void;
  onNavigate: (targetPath: string) => void;
};

const SEARCH_DEBOUNCE_MS = 250;
const EMPTY_SHORTCUT_TARGETS: DesktopGlobalSearchShortcutTargets = { attention: [], agents: [] };

export function DesktopGlobalSearchOverlay(props: DesktopGlobalSearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchRequestIdRef = useRef(0);
  const shortcutTargetsRef = useRef<DesktopGlobalSearchShortcutTargets>(EMPTY_SHORTCUT_TARGETS);
  const [query, setQuery] = useState("");
  const [remoteResults, setRemoteResults] = useState<AssistantChatSearchResult[]>([]);
  const [remotePending, setRemotePending] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [shortcutTargets, setShortcutTargets] = useState<DesktopGlobalSearchShortcutTargets>(EMPTY_SHORTCUT_TARGETS);
  const currentAgentKey = useMemo(
    () => resolveDesktopGlobalSearchAgentKey(props.currentRoute),
    [props.currentRoute]
  );
  const newChatAgentKey = currentAgentKey || props.defaultChatAgentKey.trim();
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
      shortcutTargetsRef.current = EMPTY_SHORTCUT_TARGETS;
      setShortcutTargets(EMPTY_SHORTCUT_TARGETS);
      return;
    }
    const nextShortcutTargets = buildDesktopGlobalSearchShortcutTargets(props.agents, props.t);
    shortcutTargetsRef.current = nextShortcutTargets;
    setShortcutTargets(nextShortcutTargets);
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [props.open]);

  useEffect(() => {
    if (!props.open || typeof window.electronAPI.onGlobalSearchShortcut !== "function") {
      return;
    }
    return window.electronAPI.onGlobalSearchShortcut((shortcut) => {
      activateGlobalSearchShortcut(shortcut, shortcutTargetsRef.current, {
        newChatAgentKey,
        onNavigate: props.onNavigate,
        onClose: props.onClose
      });
    });
  }, [newChatAgentKey, props.onClose, props.onNavigate, props.open]);

  useEffect(() => {
    if (!props.open) {
      window.electronAPI.desktopShell.setGlobalSearchOverlayVisible(false);
      return;
    }
    window.electronAPI.desktopShell.setGlobalSearchOverlayVisible(true);
    return () => {
      window.electronAPI.desktopShell.setGlobalSearchOverlayVisible(false);
    };
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
        newChatAgentKey,
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
          {props.shortcutPlatform ? (
            <kbd title={props.t("desktop.globalSearch.shortcutHint")}>
              <ShortcutKeyHint platform={props.shortcutPlatform} keyLabel="K" />
            </kbd>
          ) : null}
        </div>
        <div className="desktop-global-search-results" role="listbox" aria-label={props.t("desktop.globalSearch.results")}>
          {sections.length > 0 ? sections.map((section) => (
            <div className="desktop-global-search-section" key={section.id}>
              <div className="desktop-global-search-section-title">{section.title}</div>
              {section.rows.map((row) => {
                renderedRowIndex += 1;
                const rowIndex = renderedRowIndex;
                const rowShortcut = resolveRowShortcut(row, shortcutTargets);
                const rowShortcutLabel = formatShortcutLabel(rowShortcut, props.shortcutPlatform);
                const rowAriaShortcut = formatAriaShortcut(rowShortcut, props.shortcutPlatform);
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={rowIndex === activeIndex}
                    aria-keyshortcuts={rowAriaShortcut || undefined}
                    className={[
                      "desktop-global-search-row",
                      `is-${row.kind}`,
                      row.kind === "chat" && row.hasPendingAwaiting ? "is-awaiting" : "",
                      row.kind === "chat" && row.isUnread ? "is-unread" : "",
                      rowIndex === activeIndex ? "is-active" : ""
                    ].filter(Boolean).join(" ")}
                    onMouseEnter={() => setActiveIndex(rowIndex)}
                    onClick={() => activateRow(row, {
                      newChatAgentKey,
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
                    {rowShortcutLabel ? (
                      <kbd className="desktop-global-search-row-shortcut">
                        <ShortcutKeyHint
                          platform={props.shortcutPlatform}
                          keyLabel={rowShortcutLabel}
                          optionOnly={rowShortcut?.kind === "agent"}
                        />
                      </kbd>
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
  options: { newChatAgentKey: string; onNavigate: (targetPath: string) => void; onClose: () => void }
) {
  const targetPath = resolveRowTargetPath(row, options.newChatAgentKey);
  if (!targetPath) {
    return;
  }
  options.onNavigate(targetPath);
  options.onClose();
}

function activateGlobalSearchShortcut(
  shortcut: DesktopGlobalSearchShortcut,
  targets: DesktopGlobalSearchShortcutTargets,
  options: { newChatAgentKey: string; onNavigate: (targetPath: string) => void; onClose: () => void }
) {
  if (shortcut.kind === "action") {
    const targetPath = resolveActionTargetPath(shortcut.actionId, options.newChatAgentKey);
    if (targetPath) {
      options.onNavigate(targetPath);
      options.onClose();
    }
    return;
  }
  const target = shortcut.kind === "attention"
    ? targets.attention[shortcut.slot - 1]
    : targets.agents[shortcut.slot - 1];
  if (target) {
    activateRow(target, options);
  }
}

function resolveRowTargetPath(row: DesktopGlobalSearchRow, newChatAgentKey: string) {
  if (row.kind === "agent") {
    return createAgentWebclientAgentPath(row.agentKey);
  }
  if (row.kind === "chat") {
    return createAgentWebclientRoute({
      agentKey: row.agentKey,
      chatId: row.chatId,
    });
  }
  return resolveActionTargetPath(row.actionId, newChatAgentKey);
}

function resolveActionTargetPath(actionId: DesktopGlobalSearchActionId, newChatAgentKey: string) {
  if (actionId === "newChat") {
    if (!newChatAgentKey) {
      return "";
    }
    const params = new URLSearchParams();
    params.set("newChat", String(Date.now()));
    return createAgentWebclientAgentPath(newChatAgentKey, params);
  }
  if (actionId === "agents") {
    return "/agents";
  }
  if (actionId === "skills") {
    return "/skills";
  }
  if (actionId === "mcpConnectors") {
    return "/mcp-servers";
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
  if (row.actionId === "mcpConnectors") {
    return <SidebarIllustration kind="connector" />;
  }
  return <SidebarIllustration kind="settings" />;
}

function resolveRowShortcut(
  row: DesktopGlobalSearchRow,
  targets: DesktopGlobalSearchShortcutTargets
): DesktopGlobalSearchShortcut | null {
  if (row.kind === "action") {
    return row.actionId === "settings" ? null : { kind: "action", actionId: row.actionId };
  }
  if (row.kind === "chat") {
    const index = targets.attention.findIndex((target) => target.key === row.key);
    return index >= 0 ? { kind: "attention", slot: (index + 1) as DesktopGlobalSearchShortcutSlot } : null;
  }
  const index = targets.agents.findIndex((target) => target.key === row.key);
  return index >= 0 ? { kind: "agent", slot: (index + 1) as DesktopGlobalSearchShortcutSlot } : null;
}

function formatShortcutLabel(
  shortcut: DesktopGlobalSearchShortcut | null,
  platform: DesktopGlobalSearchOverlayProps["shortcutPlatform"]
) {
  if (!shortcut || !platform) {
    return "";
  }
  return shortcut.kind === "action"
    ? shortcut.actionId === "newChat"
      ? "N"
      : shortcut.actionId === "agents"
        ? "A"
        : shortcut.actionId === "skills"
          ? "S"
          : "M"
    : shortcut.slot === 10
      ? "0"
      : String(shortcut.slot);
}

function formatAriaShortcut(
  shortcut: DesktopGlobalSearchShortcut | null,
  platform: DesktopGlobalSearchOverlayProps["shortcutPlatform"]
) {
  if (!shortcut || !platform) {
    return "";
  }
  const suffix = shortcut.kind === "action"
    ? shortcut.actionId === "newChat"
      ? "N"
      : shortcut.actionId === "agents"
        ? "A"
        : shortcut.actionId === "skills"
          ? "S"
          : "M"
    : shortcut.slot === 10
      ? "0"
      : String(shortcut.slot);
  return shortcut.kind === "agent"
    ? `Alt+${suffix}`
    : `${platform === "darwin" ? "Meta" : "Control"}+${suffix}`;
}

function ShortcutKeyHint({
  platform,
  keyLabel,
  optionOnly = false
}: {
  platform: DesktopGlobalSearchOverlayProps["shortcutPlatform"];
  keyLabel: string;
  optionOnly?: boolean;
}) {
  if (!platform) {
    return null;
  }
  return (
    <span className="desktop-global-search-shortcut-content" aria-hidden="true">
      {platform === "darwin" ? (
        optionOnly ? <OptionShortcutIcon /> : <CommandShortcutIcon />
      ) : (
        <span className="desktop-global-search-shortcut-modifier">{optionOnly ? "Alt" : "Ctrl"}</span>
      )}
      <span className="desktop-global-search-shortcut-key">{keyLabel}</span>
    </span>
  );
}

function CommandShortcutIcon() {
  return (
    <svg className="desktop-global-search-shortcut-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 5.5H3.75A2.25 2.25 0 1 1 6 3.25v9.5A2.25 2.25 0 1 1 3.75 10.5H12.25A2.25 2.25 0 1 1 10 12.75v-9.5A2.25 2.25 0 1 1 12.25 5.5H5.5v5h5" />
    </svg>
  );
}

function OptionShortcutIcon() {
  return (
    <svg className="desktop-global-search-shortcut-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4h3l5 8h4" />
      <path d="M9 4h5" />
    </svg>
  );
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
