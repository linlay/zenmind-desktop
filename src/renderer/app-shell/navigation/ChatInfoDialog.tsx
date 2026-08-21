import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TranslateFunction } from "../../../shared/i18n";
import {
  buildChatInfoCopyAllText,
  buildChatInfoRows,
  type ChatInfoRow,
} from "../../../shared/chat-info";
import type { ChatInfoDialogState } from "./useChatInfoDialog";

type CopyFeedback = "copied" | "failed";

type ChatInfoDialogProps = {
  state: ChatInfoDialogState | null;
  t: TranslateFunction;
  onRetry: () => void;
  onClose: () => void;
};

function CopyIcon({ copied = false }: { copied?: boolean }) {
  return copied ? (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m5 12 4 4L19 6" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

export function ChatInfoDialog({
  state,
  t,
  onRetry,
  onClose,
}: ChatInfoDialogProps) {
  const [copyFeedback, setCopyFeedback] = useState<Record<string, CopyFeedback>>({});
  const timersRef = useRef<Map<string, number>>(new Map());
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const rows = useMemo(
    () => state
      ? buildChatInfoRows({ summary: state.summary, detail: state.detail, t })
      : [],
    [state, t],
  );
  const copyAllText = useMemo(() => buildChatInfoCopyAllText(rows), [rows]);

  useEffect(() => {
    if (!state) return;
    dialogRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state?.summary.chatId]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current.clear();
    setCopyFeedback({});
  }, [state?.summary.chatId]);

  if (!state || typeof document === "undefined") {
    return null;
  }

  function flashFeedback(key: string, feedback: CopyFeedback) {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current.clear();
    setCopyFeedback({ [key]: feedback });
    const timer = window.setTimeout(() => {
      setCopyFeedback({});
      timersRef.current.delete(key);
    }, 1600);
    timersRef.current.set(key, timer);
  }

  async function copy(key: string, value: string) {
    if (!value) return;
    try {
      const result = await window.electronAPI.clipboard.writeText(value);
      flashFeedback(key, result.ok ? "copied" : "failed");
    } catch {
      flashFeedback(key, "failed");
    }
  }

  function renderRow(row: ChatInfoRow) {
    const feedback = copyFeedback[`row:${row.key}`];
    const feedbackLabel = feedback === "copied"
      ? t("sidebar.chat.infoCopied")
      : feedback === "failed"
        ? t("sidebar.chat.infoCopyFailed")
        : t("sidebar.chat.infoCopyField", { label: row.label });
    return (
      <div className="sidebar-chat-info-row" key={row.key}>
        <span className="sidebar-chat-info-row-label">{row.label}</span>
        <pre className="sidebar-chat-info-row-value">{row.displayValue}</pre>
        <button
          type="button"
          className={[
            "sidebar-chat-info-row-copy",
            feedback === "copied" ? "is-copied" : "",
            feedback === "failed" ? "is-failed" : "",
          ].filter(Boolean).join(" ")}
          aria-label={feedbackLabel}
          title={feedbackLabel}
          onClick={() => void copy(`row:${row.key}`, row.copyValue)}
        >
          <CopyIcon copied={feedback === "copied"} />
        </button>
      </div>
    );
  }

  const visibleCopyFeedback = Object.values(copyFeedback)[0];
  return createPortal(
    <div
      className="sidebar-agent-dialog-layer"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={dialogRef}
        className="sidebar-agent-dialog sidebar-chat-info-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-chat-info-dialog-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sidebar-agent-dialog-head">
          <strong id="sidebar-chat-info-dialog-title">
            {t("sidebar.chat.infoTitle")}
          </strong>
          <button
            type="button"
            className="sidebar-agent-dialog-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {state.error ? (
          <div className="sidebar-chat-info-alert" role="alert">
            <div>
              <strong>{t("sidebar.chat.infoLoadFailed")}</strong>
              <span>{state.error}</span>
            </div>
            <button
              type="button"
              className="sidebar-agent-secondary-button"
              onClick={onRetry}
            >
              {t("common.retry")}
            </button>
          </div>
        ) : null}
        {state.loading ? (
          <div className="sidebar-chat-info-loading" role="status">
            <span className="sidebar-chat-info-spinner" aria-hidden="true" />
            <span>{t("sidebar.chat.infoLoading")}</span>
          </div>
        ) : null}
        <div className="sidebar-chat-info-content">
          <h3>{t("sidebar.chat.infoBasic")}</h3>
          <div className="sidebar-chat-info-rows">
            {rows.map(renderRow)}
          </div>
        </div>
        <div className="sidebar-agent-dialog-actions sidebar-chat-info-actions">
          <span className="sidebar-chat-info-copy-feedback" aria-live="polite">
            {visibleCopyFeedback === "copied"
              ? t("sidebar.chat.infoCopied")
              : visibleCopyFeedback === "failed"
                ? t("sidebar.chat.infoCopyFailed")
                : ""}
          </span>
          <button
            type="button"
            className="sidebar-agent-secondary-button"
            disabled={!copyAllText}
            onClick={() => void copy("copy-all", copyAllText)}
          >
            {t("sidebar.chat.infoCopyAll")}
          </button>
          <button
            type="button"
            className="sidebar-agent-secondary-button"
            disabled={!state.detail?.rawJson}
            onClick={() => void copy("copy-json", state.detail?.rawJson ?? "")}
          >
            {t("sidebar.chat.infoCopyJson")}
          </button>
          <button
            type="button"
            className="sidebar-agent-primary-button"
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
