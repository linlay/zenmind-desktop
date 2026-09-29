import { useEffect, useRef } from "react";
import { CopyOutlined, GlobalOutlined, QrcodeOutlined } from "@ant-design/icons";
import { Spin } from "antd";
import type { TranslateFunction } from "../../../shared/i18n";
import { ConversationShareQrDialog } from "./ConversationShareQrDialog";
import { useConversationShareDialog, type ConversationShareAction } from "./useConversationShareDialog";

type ConversationShareDialogProps = {
  chatId: string;
  chatName: string;
  tunnelHubEnabled: boolean;
  t: TranslateFunction;
  onClose: () => void;
  onOpenTunnelSettings: () => void;
};

const ACTIONS = [
  { id: "copy", icon: CopyOutlined, label: "sidebar.chat.shareCopyLink" },
  { id: "qr", icon: QrcodeOutlined, label: "sidebar.chat.shareGenerateQr" },
  { id: "browser", icon: GlobalOutlined, label: "sidebar.chat.shareOpenBrowser" },
] as const;

export function ConversationShareDialog({
  chatId,
  chatName,
  tunnelHubEnabled,
  t,
  onClose,
  onOpenTunnelSettings,
}: ConversationShareDialogProps) {
  const { state, run, notify } = useConversationShareDialog({ chatId }, t);
  const dialogRef = useRef<HTMLElement | null>(null);
  const lastActionRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const returnFocus = document.activeElement;
    return () => {
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    };
  }, []);

  useEffect(() => {
    dialogRef.current?.focus();
  }, [chatId]);

  useEffect(() => {
    if (state.phase === "choice" && state.feedback?.kind === "error") lastActionRef.current?.focus();
  }, [state.phase, state.feedback]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (state.phase !== "done") return;
    const timer = window.setTimeout(() => onCloseRef.current(), 1_800);
    return () => window.clearTimeout(timer);
  }, [state.phase]);

  return (
    <div
      className="conversation-share-dialog-layer"
      data-phase={state.phase}
      role="presentation"
      onMouseDown={onClose}
    >
      {state.feedback ? (
        <div className="conversation-share-toast" data-kind={state.feedback.kind} role={state.feedback.kind === "error" ? "alert" : "status"}>
          {state.feedback.kind === "loading" ? <Spin size="small" aria-hidden="true" /> : null}
          <span>{state.feedback.message}</span>
          {state.phase === "done" && state.warning ? <small>{state.warning}</small> : null}
        </div>
      ) : null}

      {state.phase === "choice" ? (
        <section
          ref={dialogRef}
          className="conversation-share-dialog"
          role="dialog"
          aria-modal="true"
          aria-busy={Boolean(state.workingAction)}
          aria-labelledby="conversation-share-title"
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="conversation-share-dialog-head">
            <h2 id="conversation-share-title">
              {t(tunnelHubEnabled ? "sidebar.chat.shareTitle" : "shareManagement.tunnelRequiredTitle")}
            </h2>
            <button type="button" className="conversation-share-icon-button" aria-label={t("common.close")} onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
          </div>
          {!tunnelHubEnabled ? (
            <div className="conversation-share-tunnel-gate">
              <p>{t("assistant.chatShareTunnelRequired")}</p>
              <button type="button" className="conversation-share-button" onClick={onOpenTunnelSettings}>
                {t("shareManagement.openTunnelSettings")}
              </button>
            </div>
          ) : (
            <div className="conversation-share-choice-body">
              <div className="conversation-share-actions">
                {ACTIONS.map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    type="button"
                    className={`conversation-share-action${state.workingAction === id ? " is-working" : ""}`}
                    disabled={Boolean(state.workingAction)}
                    onClick={(event) => {
                      lastActionRef.current = event.currentTarget;
                      void run(id as ConversationShareAction);
                    }}
                  >
                    <span className="conversation-share-action-icon">
                      {state.workingAction === id ? <Spin size="small" aria-hidden="true" /> : <Icon aria-hidden="true" />}
                    </span>
                    <span>{t(label)}</span>
                  </button>
                ))}
              </div>
              {state.warning ? <p className="conversation-share-warning" role="note">{state.warning}</p> : null}
            </div>
          )}
        </section>
      ) : state.phase === "qr" && state.createdRecord ? (
        <ConversationShareQrDialog
          url={state.createdRecord.url}
          chatId={chatId}
          chatName={chatName}
          warning={state.warning}
          t={t}
          onClose={onClose}
          onFeedback={notify}
        />
      ) : null}
    </div>
  );
}
