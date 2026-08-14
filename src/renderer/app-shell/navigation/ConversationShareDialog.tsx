import { createPortal } from "react-dom";
import type { TranslateFunction } from "../../../shared/i18n";
import type { ConversationShareDialogState } from "./useConversationShareDialog";

type ConversationShareDialogProps = {
  state: ConversationShareDialogState | null;
  t: TranslateFunction;
  onClose: () => void;
  onCreate: () => void;
  onCopy: () => void;
  onRevoke: () => void;
};

export function ConversationShareDialog({
  state,
  t,
  onClose,
  onCreate,
  onCopy,
  onRevoke
}: ConversationShareDialogProps) {
  if (!state || typeof document === "undefined") {
    return null;
  }
  const busy = Boolean(state.pending);
  const shareURL = state.result?.ok ? state.result.url ?? "" : "";
  return createPortal(
    <div
      className="sidebar-agent-dialog-layer"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <section
        className="sidebar-agent-dialog sidebar-chat-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-chat-share-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sidebar-agent-dialog-head">
          <strong id="sidebar-chat-share-dialog-title">{t("sidebar.chat.shareTitle")}</strong>
          <button
            type="button"
            className="sidebar-agent-dialog-close"
            aria-label={t("common.close")}
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="sidebar-chat-share-name">{state.chatName}</p>
        {shareURL ? (
          <>
            <p className="sidebar-agent-dialog-message">{t("sidebar.chat.shareCreated")}</p>
            <label className="sidebar-agent-dialog-field">
              <span>{t("sidebar.chat.shareLink")}</span>
              <div className="sidebar-chat-share-link-row">
                <input value={shareURL} readOnly />
                <button type="button" className="sidebar-agent-dialog-copy" onClick={onCopy}>
                  {state.copied ? t("sidebar.chat.shareCopied") : t("common.copy")}
                </button>
              </div>
            </label>
            <p className="sidebar-chat-share-hint">{t("sidebar.chat.sharePublicHint")}</p>
          </>
        ) : (
          <p className="sidebar-agent-dialog-message">{t("sidebar.chat.shareConfirm")}</p>
        )}
        {state.error ? <div className="sidebar-agent-dialog-error" role="alert">{state.error}</div> : null}
        <div className="sidebar-agent-dialog-actions">
          {shareURL ? (
            <>
              <button
                type="button"
                className="sidebar-agent-danger-button"
                disabled={busy}
                onClick={onRevoke}
              >
                {state.pending === "revoke" ? t("sidebar.common.processing") : t("sidebar.chat.shareRevoke")}
              </button>
              <button type="button" className="sidebar-agent-primary-button" disabled={busy} onClick={onClose}>
                {t("common.done")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="sidebar-agent-secondary-button" disabled={busy} onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button type="button" className="sidebar-agent-primary-button" disabled={busy} onClick={onCreate}>
                {state.pending === "create" ? t("sidebar.common.processing") : t("sidebar.chat.shareCreate")}
              </button>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}
