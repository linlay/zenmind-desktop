import { useEffect, useRef } from "react";
import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  LinkOutlined,
  ShareAltOutlined,
} from "@ant-design/icons";
import {
  ASSISTANT_CONVERSATION_SHARE_EXPIRATIONS,
  type AssistantConversationShareExpiration,
} from "../../../shared/contracts";
import type { TranslateFunction, TranslationKey } from "../../../shared/i18n";
import { useConversationShareDialog } from "./useConversationShareDialog";

const EXPIRATION_LABEL_KEYS: Record<
  AssistantConversationShareExpiration,
  TranslationKey
> = {
  once: "sidebar.chat.shareExpiration.once",
  "3h": "sidebar.chat.shareExpiration.3h",
  "1d": "sidebar.chat.shareExpiration.1d",
  "7d": "sidebar.chat.shareExpiration.7d",
  "30d": "sidebar.chat.shareExpiration.30d",
  permanent: "sidebar.chat.shareExpiration.permanent",
};

type ConversationShareDialogProps = {
  chatId: string;
  chatName: string;
  tunnelHubEnabled: boolean;
  t: TranslateFunction;
  onClose: () => void;
  onOpenTunnelSettings: () => void;
};

export function ConversationShareDialog({
  chatId,
  chatName,
  tunnelHubEnabled,
  t,
  onClose,
  onOpenTunnelSettings,
}: ConversationShareDialogProps) {
  const dialog = useConversationShareDialog({ chatId, chatName }, t);
  const { state } = dialog;
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chatId]);

  return (
    <div className="conversation-share-dialog-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="conversation-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-share-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="conversation-share-dialog-head">
          <div className="conversation-share-dialog-heading">
            <ShareAltOutlined aria-hidden="true" />
            <div>
              <h2 id="conversation-share-dialog-title">{t("sidebar.chat.shareTitle")}</h2>
              <p>{t("sidebar.chat.shareConversation", { name: state.chatName })}</p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="conversation-share-icon-button conversation-share-dialog-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <CloseOutlined aria-hidden="true" />
          </button>
        </header>

        <div className="conversation-share-dialog-body">
          {!tunnelHubEnabled ? (
            <section className="conversation-share-tunnel-gate">
              <ShareAltOutlined aria-hidden="true" />
              <div>
                <h3>{t("shareManagement.tunnelRequiredTitle")}</h3>
                <p>{t("assistant.chatShareTunnelRequired")}</p>
              </div>
              <button
                type="button"
                className="conversation-share-button is-primary"
                onClick={onOpenTunnelSettings}
              >
                {t("shareManagement.openTunnelSettings")}
              </button>
            </section>
          ) : (
            <>
              <div className="conversation-share-settings">
                <div className="conversation-share-create-row">
                  <label className="conversation-share-field">
                    <span>{t("sidebar.chat.shareExpiration")}</span>
                    <select
                      value={state.expiration}
                      disabled={state.creating}
                      onChange={(event) =>
                        dialog.setExpiration(
                          event.target.value as AssistantConversationShareExpiration,
                        )
                      }
                    >
                      {ASSISTANT_CONVERSATION_SHARE_EXPIRATIONS.map((expiration) => (
                        <option key={expiration} value={expiration}>
                          {t(EXPIRATION_LABEL_KEYS[expiration])}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="conversation-share-button is-primary"
                    disabled={state.creating}
                    onClick={() => void dialog.create()}
                  >
                    <LinkOutlined aria-hidden="true" />
                    <span>
                      {state.creating
                        ? t("sidebar.common.processing")
                        : t("sidebar.chat.shareCreate")}
                    </span>
                  </button>
                </div>
                {state.expiration === "once" ? (
                  <p className="conversation-share-warning" role="note">
                    {t("sidebar.chat.shareExpiration.onceWarning")}
                  </p>
                ) : null}
              </div>

              <details className="conversation-share-details">
                <summary>{t("sidebar.chat.shareDetails")}</summary>
                <p>{t("sidebar.chat.shareDetailsDescription")}</p>
              </details>

              {state.notice ? (
                <div className="conversation-share-feedback is-success" role="status">
                  {state.notice}
                </div>
              ) : null}
              {state.actionError ? (
                <div className="conversation-share-feedback is-error" role="alert">
                  {state.actionError}
                </div>
              ) : null}

              {state.createdRecord ? (
                <section className="conversation-share-created-result" aria-label={t("sidebar.chat.shareCreated")}>
                  <div className="conversation-share-link-control">
                    <LinkOutlined aria-hidden="true" />
                    <input
                      aria-label={t("sidebar.chat.shareLink")}
                      title={state.createdRecord.url}
                      value={state.createdRecord.url}
                      readOnly
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </div>
                  <button
                    type="button"
                    className="conversation-share-button is-compact"
                    data-copied={state.copied || undefined}
                    aria-live="polite"
                    onClick={() => void dialog.copyCreatedLink()}
                  >
                    {state.copied ? <CheckOutlined aria-hidden="true" /> : <CopyOutlined aria-hidden="true" />}
                    <span>{state.copied ? t("sidebar.chat.shareCopied") : t("common.copy")}</span>
                  </button>
                </section>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
