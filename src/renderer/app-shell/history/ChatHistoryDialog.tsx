import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DeleteOutlined,
  DownloadOutlined,
  FilterOutlined,
  InboxOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type {
  AssistantHistoryChatItem,
  AssistantNavAgentItem,
} from "../../../shared/contracts";
import { useI18n } from "../../i18n/useI18n";

type ChatHistoryDialogProps = {
  agentKey?: string;
  agents: AssistantNavAgentItem[];
  isMac: boolean;
  isWindows: boolean;
  onClose: () => void;
  onOpenChat: (request: { agentKey: string; chatId: string }) => void;
  onChatRemoved: (
    chat: AssistantHistoryChatItem,
    nextChat: AssistantHistoryChatItem | null,
  ) => void;
};

type HistoryAction = "export" | "archive" | "delete";
type HistoryFeedback = { tone: "success" | "error"; message: string } | null;
type DeleteDialogState = {
  chat: AssistantHistoryChatItem;
  pending: boolean;
  error: string;
} | null;

const ALL_OWNERS = "all";

function getDialogFocusableElements(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((element) => element !== dialog && !element.hasAttribute("hidden"));
}

function dateBoundary(value: string, endOfDay: boolean) {
  if (!value) return null;
  const boundary = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  const timestamp = boundary.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatHistoryTime(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function findNextHistoryChat(
  items: AssistantHistoryChatItem[],
  removed: AssistantHistoryChatItem,
) {
  return items.find(
    (item) =>
      item.chatId !== removed.chatId &&
      item.agentKey &&
      item.agentKey === removed.agentKey,
  ) ?? null;
}

export function ChatHistoryDialog({
  agentKey = "",
  agents,
  isMac,
  isWindows,
  onClose,
  onOpenChat,
  onChatRemoved,
}: ChatHistoryDialogProps) {
  const { t } = useI18n();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const filtersRef = useRef<HTMLDivElement | null>(null);
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const loadRequestIdRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const normalizedAgentKey = agentKey.trim();
  const [items, setItems] = useState<AssistantHistoryChatItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [ownerKey, setOwnerKey] = useState(normalizedAgentKey || ALL_OWNERS);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [pendingByChatId, setPendingByChatId] = useState<Record<string, HistoryAction>>({});
  const [feedback, setFeedback] = useState<HistoryFeedback>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const deleteDialogOpen = Boolean(deleteDialog);

  const ownerOptions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const agent of agents) {
      const key = agent.agentKey.trim();
      if (key) labels.set(key, agent.displayName.trim() || key);
    }
    for (const item of items) {
      const key = item.agentKey.trim();
      if (key && !labels.has(key)) labels.set(key, key);
    }
    return Array.from(labels, ([key, label]) => ({ key, label })).sort((left, right) =>
      left.label.localeCompare(right.label),
    );
  }, [agents, items]);

  const ownerLabelByKey = useMemo(
    () => new Map(ownerOptions.map((option) => [option.key, option.label] as const)),
    [ownerOptions],
  );

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const startAt = dateBoundary(startDate, false);
    const endAt = dateBoundary(endDate, true);
    return items.filter((item) => {
      if (ownerKey !== ALL_OWNERS && item.agentKey !== ownerKey) return false;
      if (startAt !== null && item.updatedAt < startAt) return false;
      if (endAt !== null && item.updatedAt > endAt) return false;
      if (!normalizedQuery) return true;
      const ownerLabel = ownerLabelByKey.get(item.agentKey) || item.agentKey;
      return [item.chatName, item.lastRunContent, item.chatId, ownerLabel]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [endDate, items, ownerKey, ownerLabelByKey, query, startDate]);

  const loadHistory = useCallback(async (silent = false) => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    if (!silent) setLoading(true);
    setLoadError("");
    try {
      const result = await window.electronAPI.assistant.listHistoryChats();
      if (loadRequestIdRef.current !== requestId) return;
      if (!result?.ok) {
        const message = result?.message || t("history.dialog.loadFailed");
        if (silent) setFeedback({ tone: "error", message });
        else setLoadError(message);
        return;
      }
      setItems(Array.isArray(result.items) ? result.items : []);
    } catch (error) {
      if (loadRequestIdRef.current !== requestId) return;
      const message = error instanceof Error
        ? error.message
        : t("history.dialog.loadFailed");
      if (silent) setFeedback({ tone: "error", message });
      else setLoadError(message);
    } finally {
      if (loadRequestIdRef.current === requestId) setLoading(false);
    }
  }, [t]);

  useLayoutEffect(() => {
    const previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    searchInputRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    void loadHistory();
    const unsubscribe = window.electronAPI.assistant.onNavigationAgentsChanged(() => {
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void loadHistory(true);
      }, 250);
    });
    return () => {
      loadRequestIdRef.current += 1;
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      unsubscribe();
    };
  }, [loadHistory]);

  useEffect(() => {
    const layer = layerRef.current;
    const appShell = layer?.closest<HTMLElement>(".app-shell");
    if (!layer || !appShell) return;
    const siblings = Array.from(appShell.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== layer,
    );
    const previousInert = siblings.map((element) => element.inert);
    siblings.forEach((element) => {
      element.inert = true;
    });
    return () => {
      siblings.forEach((element, index) => {
        element.inert = previousInert[index] ?? false;
      });
    };
  }, []);

  useLayoutEffect(() => {
    if (!deleteDialogOpen) return;
    const previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    deleteCancelRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus({ preventScroll: true });
      }
    };
  }, [deleteDialogOpen]);

  useEffect(() => {
    if (!filtersOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && filtersRef.current?.contains(target)) return;
      setFiltersOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [filtersOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (deleteDialog && !deleteDialog.pending) {
          setDeleteDialog(null);
        } else if (filtersOpen) {
          setFiltersOpen(false);
          filtersTriggerRef.current?.focus({ preventScroll: true });
        } else if (!deleteDialog) {
          onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = deleteDialog ? deleteDialogRef.current : dialogRef.current;
      if (!dialog) return;
      const focusableElements = getDialogFocusableElements(dialog);
      const firstElement = focusableElements[0];
      const lastElement = focusableElements.at(-1);
      if (!firstElement || !lastElement) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === firstElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        lastElement.focus({ preventScroll: true });
      } else if (!event.shiftKey && (activeElement === lastElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        firstElement.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [deleteDialog, filtersOpen, onClose]);

  function setPending(chatId: string, action: HistoryAction | null) {
    setPendingByChatId((current) => {
      const next = { ...current };
      if (action) next[chatId] = action;
      else delete next[chatId];
      return next;
    });
  }

  function removeChat(chat: AssistantHistoryChatItem) {
    const nextChat = findNextHistoryChat(items, chat);
    setItems((current) => current.filter((item) => item.chatId !== chat.chatId));
    onChatRemoved(chat, nextChat);
  }

  async function exportChat(chat: AssistantHistoryChatItem) {
    if (pendingByChatId[chat.chatId]) return;
    setPending(chat.chatId, "export");
    setFeedback(null);
    try {
      const result = await window.electronAPI.assistant.exportChat(chat.chatId);
      if (!result.ok) throw new Error(result.message || t("sidebar.chat.exportFailed"));
      setFeedback({
        tone: "success",
        message: result.filePath
          ? t("sidebar.chat.exportedTo", { path: result.filePath })
          : result.message,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : t("sidebar.chat.exportFailed"),
      });
    } finally {
      setPending(chat.chatId, null);
    }
  }

  async function archiveChat(chat: AssistantHistoryChatItem) {
    if (pendingByChatId[chat.chatId]) return;
    setPending(chat.chatId, "archive");
    setFeedback(null);
    try {
      const result = await window.electronAPI.assistant.archiveChat(chat.chatId);
      if (!result?.ok) throw new Error(result?.message || t("sidebar.chat.archiveFailed"));
      removeChat(chat);
      setFeedback({ tone: "success", message: result.message });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : t("sidebar.chat.archiveFailed"),
      });
    } finally {
      setPending(chat.chatId, null);
    }
  }

  async function confirmDeleteChat() {
    if (!deleteDialog || deleteDialog.pending) return;
    const chat = deleteDialog.chat;
    setDeleteDialog({ ...deleteDialog, pending: true, error: "" });
    setPending(chat.chatId, "delete");
    setFeedback(null);
    try {
      const result = await window.electronAPI.assistant.deleteChat(chat.chatId);
      if (!result.ok) throw new Error(result.message || t("sidebar.chat.deleteFailed"));
      setDeleteDialog(null);
      removeChat(chat);
      setFeedback({ tone: "success", message: result.message });
    } catch (error) {
      setDeleteDialog({
        chat,
        pending: false,
        error: error instanceof Error ? error.message : t("sidebar.chat.deleteFailed"),
      });
    } finally {
      setPending(chat.chatId, null);
    }
  }

  function resetFilters() {
    setQuery("");
    setOwnerKey(ALL_OWNERS);
    setStartDate("");
    setEndDate("");
    setFiltersOpen(false);
    searchInputRef.current?.focus({ preventScroll: true });
  }

  const title = t("sidebar.chats.viewMoreHistory");
  const activeFilterCount = Number(ownerKey !== ALL_OWNERS)
    + Number(Boolean(startDate))
    + Number(Boolean(endDate));
  return (
    <div
      ref={layerRef}
      className="chat-history-dialog-layer"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !deleteDialog) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={[
          "chat-history-dialog",
          isMac ? "is-mac" : "",
          isWindows ? "is-windows" : "",
        ].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-agent-key={normalizedAgentKey || undefined}
      >
        <div className="chat-history-dialog-commandbar">
          <SearchOutlined className="chat-history-dialog-search-icon" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            aria-label={t("history.dialog.search")}
            placeholder={t("history.dialog.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div ref={filtersRef} className="chat-history-dialog-filters">
            <button
              ref={filtersTriggerRef}
              type="button"
              className={`chat-history-dialog-filter-trigger ${filtersOpen ? "is-open" : ""} ${activeFilterCount > 0 ? "is-active" : ""}`}
              aria-haspopup="dialog"
              aria-expanded={filtersOpen}
              aria-label={`${t("history.dialog.filters")}: ${t("history.dialog.count", { filtered: filteredItems.length, total: items.length })}`}
              title={`${t("history.dialog.filters")} · ${t("history.dialog.count", { filtered: filteredItems.length, total: items.length })}`}
              onClick={() => setFiltersOpen((current) => !current)}
            >
              <FilterOutlined aria-hidden="true" />
              <span className="chat-history-dialog-filter-label">{t("history.dialog.filters")}</span>
              {activeFilterCount > 0 ? (
                <span className="chat-history-dialog-filter-active-count" aria-hidden="true">
                  {activeFilterCount}
                </span>
              ) : null}
              <span className="chat-history-dialog-filter-result-count" aria-hidden="true">
                {t("history.dialog.count", { filtered: filteredItems.length, total: items.length })}
              </span>
            </button>
            {filtersOpen ? (
              <div
                className="chat-history-dialog-filter-menu"
                role="dialog"
                aria-label={t("history.dialog.filters")}
              >
                <label className="chat-history-dialog-filter-field">
                  <span>{t("history.dialog.owner")}</span>
                  <select
                    value={ownerKey}
                    onChange={(event) => setOwnerKey(event.target.value)}
                  >
                    <option value={ALL_OWNERS}>{t("history.dialog.ownerAll")}</option>
                    {ownerOptions.map((option) => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="chat-history-dialog-filter-dates">
                  <label className="chat-history-dialog-filter-field">
                    <span>{t("history.dialog.startDate")}</span>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(event) => setStartDate(event.target.value)}
                    />
                  </label>
                  <label className="chat-history-dialog-filter-field">
                    <span>{t("history.dialog.endDate")}</span>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(event) => setEndDate(event.target.value)}
                    />
                  </label>
                </div>
                <div className="chat-history-dialog-filter-actions">
                  <button type="button" onClick={resetFilters}>
                    {t("history.dialog.reset")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="chat-history-dialog-commandbar-button"
            aria-label={t("history.dialog.refresh")}
            title={t("history.dialog.refresh")}
            disabled={loading}
            onClick={() => void loadHistory()}
          >
            <ReloadOutlined aria-hidden="true" />
          </button>
          <kbd className="chat-history-dialog-close-hint" aria-hidden="true">Esc</kbd>
        </div>

        {feedback ? (
          <div className={`chat-history-dialog-feedback is-${feedback.tone}`} role="status">
            {feedback.message}
          </div>
        ) : null}

        <div className="chat-history-dialog-content">
          {loading && items.length === 0 ? (
            <div className="chat-history-dialog-state">{t("history.dialog.loading")}</div>
          ) : loadError ? (
            <div className="chat-history-dialog-state is-error" role="alert">
              <span>{loadError}</span>
              <button type="button" onClick={() => void loadHistory()}>{t("common.retry")}</button>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="chat-history-dialog-state">{t("history.dialog.empty")}</div>
          ) : (
            <div className="chat-history-dialog-list" role="list">
              {filteredItems.map((chat) => {
                const pendingAction = pendingByChatId[chat.chatId];
                const ownerLabel = ownerLabelByKey.get(chat.agentKey)
                  || chat.agentKey
                  || chat.teamId
                  || t("history.dialog.ownerUnknown");
                return (
                  <article
                    key={chat.chatId}
                    className="chat-history-dialog-row"
                    role="listitem"
                    data-chat-id={chat.chatId}
                  >
                    <button
                      type="button"
                      className="chat-history-dialog-row-main"
                      disabled={!chat.agentKey}
                      onClick={() => onOpenChat({ agentKey: chat.agentKey, chatId: chat.chatId })}
                    >
                      <span className="chat-history-dialog-row-title-line">
                        {!chat.isRead ? <i className="chat-history-dialog-unread" aria-label={t("sidebar.chat.unread")} /> : null}
                        <strong title={chat.chatName}>{chat.chatName}</strong>
                        <span className="chat-history-dialog-row-meta">
                          {chat.hasActiveRun ? <em className="is-running">{t("sidebar.agent.running")}</em> : null}
                          {chat.hasPendingAwaiting ? <em className="is-awaiting">{t("sidebar.agent.awaiting")}</em> : null}
                          <span title={ownerLabel}>{ownerLabel}</span>
                          <time dateTime={new Date(chat.updatedAt).toISOString()}>{formatHistoryTime(chat.updatedAt)}</time>
                        </span>
                      </span>
                      <span className="chat-history-dialog-row-preview" title={chat.lastRunContent}>
                        {chat.lastRunContent || t("history.dialog.noPreview")}
                      </span>
                    </button>
                    <div className="chat-history-dialog-row-actions">
                      <button
                        type="button"
                        aria-label={t("sidebar.chat.export")}
                        title={t("sidebar.chat.export")}
                        disabled={Boolean(pendingAction)}
                        onClick={() => void exportChat(chat)}
                      >
                        <DownloadOutlined aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={t("sidebar.chat.archive")}
                        title={t("sidebar.chat.archive")}
                        disabled={Boolean(pendingAction)}
                        onClick={() => void archiveChat(chat)}
                      >
                        <InboxOutlined aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        aria-label={t("sidebar.chat.delete")}
                        title={t("sidebar.chat.delete")}
                        disabled={Boolean(pendingAction)}
                        onClick={() => setDeleteDialog({ chat, pending: false, error: "" })}
                      >
                        <DeleteOutlined aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {deleteDialog ? (
          <div className="chat-history-delete-layer" role="presentation">
            <div
              ref={deleteDialogRef}
              className="chat-history-delete-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="chat-history-delete-title"
              aria-describedby="chat-history-delete-message"
            >
              <strong id="chat-history-delete-title">{t("sidebar.chat.delete")}</strong>
              <p id="chat-history-delete-message">
                {t("sidebar.chat.deleteConfirm", { name: deleteDialog.chat.chatName || deleteDialog.chat.chatId })}
              </p>
              {deleteDialog.error ? <div className="chat-history-delete-error" role="alert">{deleteDialog.error}</div> : null}
              <div className="chat-history-delete-actions">
                <button
                  ref={deleteCancelRef}
                  type="button"
                  disabled={deleteDialog.pending}
                  onClick={() => setDeleteDialog(null)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="is-danger"
                  disabled={deleteDialog.pending}
                  onClick={() => void confirmDeleteChat()}
                >
                  {deleteDialog.pending ? t("sidebar.common.processing") : t("common.confirm")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
