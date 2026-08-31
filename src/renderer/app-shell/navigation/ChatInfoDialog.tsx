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
type RevealFeedback = "idle" | "loading" | "failed";
const CODE_VALUE_FIELDS = new Set([
  "chatId",
  "agentKey",
  "firstAgentKey",
  "teamId",
  "source",
  "createdAt",
  "updatedAt",
  "lastRunId",
]);

type ChatInfoDialogProps = {
  state: ChatInfoDialogState | null;
  t: TranslateFunction;
  isMac: boolean;
  isWindows: boolean;
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

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}

function FolderRevealIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3.5 7.5v9.25A2.25 2.25 0 0 0 5.75 19h12.5a2.25 2.25 0 0 0 2.25-2.25v-7.5A2.25 2.25 0 0 0 18.25 7H12l-2-2H5.75A2.25 2.25 0 0 0 3.5 7.25Z" />
      <path d="m13.5 11 2 2 2-2M15.5 8.5V13" />
    </svg>
  );
}

function JsonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 5.5H7.75A1.75 1.75 0 0 0 6 7.25V10a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2.75a1.75 1.75 0 0 0 1.75 1.75H9M15 5.5h1.25A1.75 1.75 0 0 1 18 7.25V10a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2.75a1.75 1.75 0 0 1-1.75 1.75H15" />
    </svg>
  );
}

export function ChatInfoDialog({
  state,
  t,
  isMac,
  isWindows,
  onRetry,
  onClose,
}: ChatInfoDialogProps) {
  const [copyFeedback, setCopyFeedback] = useState<Record<string, CopyFeedback>>({});
  const [revealFeedback, setRevealFeedback] = useState<RevealFeedback>("idle");
  const [revealMessage, setRevealMessage] = useState("");
  const timersRef = useRef<Map<string, number>>(new Map());
  const revealRequestIdRef = useRef(0);
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
    revealRequestIdRef.current += 1;
    setRevealFeedback("idle");
    setRevealMessage("");
  }, [state?.summary.chatId]);

  if (!state || typeof document === "undefined") {
    return null;
  }
  const activeChatId = state.summary.chatId;

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
    setRevealFeedback("idle");
    setRevealMessage("");
    try {
      const result = await window.electronAPI.clipboard.writeText(value);
      flashFeedback(key, result.ok ? "copied" : "failed");
    } catch {
      flashFeedback(key, "failed");
    }
  }

  async function revealChatInFolder() {
    if (revealFeedback === "loading") return;
    const requestId = revealRequestIdRef.current + 1;
    revealRequestIdRef.current = requestId;
    setCopyFeedback({});
    setRevealFeedback("loading");
    setRevealMessage("");
    try {
      const result = await window.electronAPI.assistant.revealChatInFolder(
        activeChatId,
      );
      if (revealRequestIdRef.current !== requestId) return;
      setRevealFeedback(result.ok ? "idle" : "failed");
      setRevealMessage(result.ok ? "" : result.message);
    } catch {
      if (revealRequestIdRef.current !== requestId) return;
      setRevealFeedback("failed");
      setRevealMessage(t("sidebar.chat.infoRevealUnavailable"));
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
        <pre
          className={[
            "sidebar-chat-info-row-value",
            CODE_VALUE_FIELDS.has(row.key) ? "is-code" : "",
          ].filter(Boolean).join(" ")}
        >{row.displayValue}</pre>
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

  const revealLabel = isMac
    ? t("sidebar.chat.infoRevealFinder")
    : isWindows
      ? t("sidebar.chat.infoRevealExplorer")
      : t("sidebar.chat.infoRevealFileManager");
  const copyAllFeedback = copyFeedback["copy-all"];
  const copyJsonFeedback = copyFeedback["copy-json"];
  return createPortal(
    <div
      className="sidebar-agent-dialog-layer sidebar-chat-info-dialog-layer"
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
            <CloseIcon />
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
          <div className="sidebar-chat-info-rows">
            {rows.map(renderRow)}
          </div>
        </div>
        <footer className="sidebar-chat-info-footer">
          <div className="sidebar-agent-dialog-actions sidebar-chat-info-actions">
            <button
              type="button"
              className={[
                "sidebar-agent-secondary-button",
                "sidebar-chat-info-action-button",
                "sidebar-chat-info-reveal-button",
                revealFeedback === "failed" ? "is-failed" : "",
              ].filter(Boolean).join(" ")}
              disabled={revealFeedback === "loading"}
              onClick={() => void revealChatInFolder()}
            >
              <FolderRevealIcon />
              <span>{revealLabel}</span>
            </button>
            <div className="sidebar-chat-info-action-group">
              <button
                type="button"
                className={[
                  "sidebar-agent-secondary-button",
                  "sidebar-chat-info-action-button",
                  copyAllFeedback === "copied" ? "is-success" : "",
                  copyAllFeedback === "failed" ? "is-failed" : "",
                ].filter(Boolean).join(" ")}
                disabled={!copyAllText}
                onClick={() => void copy("copy-all", copyAllText)}
              >
                <CopyIcon copied={copyAllFeedback === "copied"} />
                <span>{t("sidebar.chat.infoCopyAll")}</span>
              </button>
              <button
                type="button"
                className={[
                  "sidebar-agent-secondary-button",
                  "sidebar-chat-info-action-button",
                  copyJsonFeedback === "copied" ? "is-success" : "",
                  copyJsonFeedback === "failed" ? "is-failed" : "",
                ].filter(Boolean).join(" ")}
                disabled={!state.detail?.rawJson}
                onClick={() => void copy("copy-json", state.detail?.rawJson ?? "")}
              >
                <JsonIcon />
                <span>{t("sidebar.chat.infoCopyJson")}</span>
              </button>
              <button
                type="button"
                className="sidebar-agent-primary-button sidebar-chat-info-close-button"
                onClick={onClose}
              >
                {t("common.close")}
              </button>
            </div>
          </div>
          {revealFeedback === "failed" && revealMessage ? (
            <span className="sidebar-chat-info-feedback is-failed" role="alert">
              {revealMessage}
            </span>
          ) : null}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
