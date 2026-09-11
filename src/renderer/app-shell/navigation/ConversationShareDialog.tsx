import { createPortal } from "react-dom";
import {
  CheckOutlined,
  CopyOutlined,
  DisconnectOutlined,
  LinkOutlined,
  MessageOutlined,
} from "@ant-design/icons";
import {
  ASSISTANT_CONVERSATION_SHARE_EXPIRATIONS,
  type AssistantConversationShareExpiration,
  type AssistantConversationShareRecord,
} from "../../../shared/contracts";
import type { TranslateFunction, TranslationKey } from "../../../shared/i18n";
import { formatEpochMillis } from "../../../shared/time-contract";
import type { ConversationShareDialogState } from "./useConversationShareDialog";

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
  state: ConversationShareDialogState | null;
  t: TranslateFunction;
  onClose: () => void;
  onCreate: () => void;
  onRetryList: () => void;
  onExpirationChange: (
    expiration: AssistantConversationShareExpiration,
  ) => void;
  onCopy: (shareId: string) => void;
  onRequestRevoke: (shareId: string) => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
};

export function ConversationShareDialog({
  state,
  t,
  onClose,
  onCreate,
  onRetryList,
  onExpirationChange,
  onCopy,
  onRequestRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: ConversationShareDialogProps) {
  if (!state || typeof document === "undefined") {
    return null;
  }
  const showListError =
    state.listStatus === "error" &&
    Boolean(state.listError) &&
    state.listError !== state.actionError;
  return createPortal(
    <div
      className="sidebar-agent-dialog-layer sidebar-chat-share-dialog-layer"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="sidebar-agent-dialog sidebar-chat-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-chat-share-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sidebar-agent-dialog-head sidebar-chat-share-dialog-head">
          <div className="sidebar-chat-share-heading">
            <strong id="sidebar-chat-share-dialog-title">
              <MessageOutlined aria-hidden="true" />
              <span>{t("sidebar.chat.shareTitle")}</span>
            </strong>
            <p className="sidebar-chat-share-name">
              {t("sidebar.chat.shareConversation", { name: state.chatName })}
            </p>
          </div>
          <button
            type="button"
            className="sidebar-agent-dialog-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <p className="sidebar-agent-dialog-message">
          {t("sidebar.chat.shareConfirm")}
        </p>

        <section
          className="sidebar-chat-share-section sidebar-chat-share-settings"
          aria-labelledby="sidebar-chat-share-settings-title"
        >
          <h3 id="sidebar-chat-share-settings-title">
            {t("sidebar.chat.shareSettings")}
          </h3>
          <div className="sidebar-chat-share-create-row">
            <label className="sidebar-agent-dialog-field">
              <span>{t("sidebar.chat.shareExpiration")}</span>
              <select
                value={state.expiration}
                disabled={state.creating}
                onChange={(event) =>
                  onExpirationChange(
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
              className="sidebar-agent-primary-button sidebar-chat-share-create-button"
              disabled={state.creating}
              onClick={onCreate}
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
            <p className="sidebar-chat-share-once-warning" role="note">
              {t("sidebar.chat.shareExpiration.onceWarning")}
            </p>
          ) : null}
        </section>

        {state.notice ? (
          <div className="sidebar-chat-share-notice" role="status">
            {state.notice}
          </div>
        ) : null}
        {state.actionError ? (
          <div className="sidebar-agent-dialog-error" role="alert">
            {state.actionError}
          </div>
        ) : null}

        <section
          className="sidebar-chat-share-section sidebar-chat-share-current"
          aria-labelledby="sidebar-chat-share-history-title"
        >
          <div className="sidebar-chat-share-history-head">
            <h3 id="sidebar-chat-share-history-title">
              {t("sidebar.chat.shareHistory")}
            </h3>
            {state.listStatus === "error" ? (
              <button
                type="button"
                className="sidebar-chat-share-text-button"
                onClick={onRetryList}
              >
                {t("common.retry")}
              </button>
            ) : null}
          </div>

          <div
            className="sidebar-chat-share-history"
            aria-busy={state.listStatus === "loading"}
          >
            {state.listStatus === "loading" && state.records.length === 0 ? (
              <p className="sidebar-chat-share-empty">
                {t("sidebar.chat.shareHistoryLoading")}
              </p>
            ) : null}
            {showListError ? (
              <div className="sidebar-agent-dialog-error" role="alert">
                {state.listError}
              </div>
            ) : null}
            {state.listStatus === "ready" && state.records.length === 0 ? (
              <p className="sidebar-chat-share-empty">
                {t("sidebar.chat.shareHistoryEmpty")}
              </p>
            ) : null}
            {state.records.map((record) => (
              <ConversationShareRecordItem
                key={record.shareId}
                record={record}
                copied={state.copiedShareId === record.shareId}
                confirmingRevoke={
                  state.confirmingRevokeShareId === record.shareId
                }
                revoking={state.revokingShareId === record.shareId}
                anotherRevokePending={Boolean(
                  state.revokingShareId &&
                  state.revokingShareId !== record.shareId,
                )}
                t={t}
                onCopy={() => onCopy(record.shareId)}
                onRequestRevoke={() => onRequestRevoke(record.shareId)}
                onCancelRevoke={onCancelRevoke}
                onConfirmRevoke={onConfirmRevoke}
              />
            ))}
          </div>

          <p className="sidebar-chat-share-hint">
            {t("sidebar.chat.sharePublicHint")}
          </p>
        </section>

        <div className="sidebar-agent-dialog-actions sidebar-chat-share-dialog-actions">
          <button
            type="button"
            className="sidebar-agent-secondary-button sidebar-chat-share-done-button"
            onClick={onClose}
          >
            {t("common.done")}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

type ConversationShareRecordItemProps = {
  record: AssistantConversationShareRecord;
  copied: boolean;
  confirmingRevoke: boolean;
  revoking: boolean;
  anotherRevokePending: boolean;
  t: TranslateFunction;
  onCopy: () => void;
  onRequestRevoke: () => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
};

function ConversationShareRecordItem({
  record,
  copied,
  confirmingRevoke,
  revoking,
  anotherRevokePending,
  t,
  onCopy,
  onRequestRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: ConversationShareRecordItemProps) {
  return (
    <article className="sidebar-chat-share-record">
      <div className="sidebar-chat-share-record-main">
        <div className="sidebar-chat-share-link-control">
          <LinkOutlined
            className="sidebar-chat-share-link-icon"
            aria-hidden="true"
          />
          <input
            aria-label={t("sidebar.chat.shareLink")}
            title={record.url}
            value={record.url}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
        <div
          className="sidebar-chat-share-record-actions"
          role={confirmingRevoke ? "group" : undefined}
          aria-label={
            confirmingRevoke ? t("sidebar.chat.shareRevokeConfirm") : undefined
          }
        >
          {confirmingRevoke ? (
            <div className="sidebar-chat-share-revoke-confirmation">
              <button
                type="button"
                className="sidebar-agent-secondary-button"
                onClick={onCancelRevoke}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="sidebar-agent-danger-button"
                onClick={onConfirmRevoke}
              >
                {t("sidebar.chat.shareRevoke")}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="sidebar-chat-share-record-action sidebar-chat-share-copy-button"
                data-copied={copied || undefined}
                aria-live="polite"
                onClick={onCopy}
              >
                <span className="sidebar-chat-share-record-action-icon">
                  {copied ? (
                    <CheckOutlined aria-hidden="true" />
                  ) : (
                    <CopyOutlined aria-hidden="true" />
                  )}
                </span>
                <span>
                  {copied ? t("sidebar.chat.shareCopied") : t("common.copy")}
                </span>
              </button>
              <button
                type="button"
                className="sidebar-chat-share-record-action sidebar-chat-share-revoke-button"
                disabled={revoking || anotherRevokePending}
                onClick={onRequestRevoke}
              >
                <span className="sidebar-chat-share-record-action-icon">
                  <DisconnectOutlined aria-hidden="true" />
                </span>
                <span>
                  {revoking
                    ? t("sidebar.common.processing")
                    : t("sidebar.chat.shareRevokeAction")}
                </span>
              </button>
            </>
          )}
        </div>
      </div>
      <dl className="sidebar-chat-share-meta">
        <div>
          <dt>{t("sidebar.chat.shareCreatedAt")}</dt>
          <dd>
            <time>{formatEpochMillis(record.createdAt)}</time>
          </dd>
        </div>
        <div>
          <dt>{t("sidebar.chat.shareExpiry")}</dt>
          <dd>
            {record.singleUse ? (
              t("sidebar.chat.shareSingleUse")
            ) : record.expiresAt === null ? (
              t("sidebar.chat.sharePermanent")
            ) : (
              <time>{formatEpochMillis(record.expiresAt)}</time>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("sidebar.chat.shareLastAccessedAt")}</dt>
          <dd>
            {record.lastAccessedAt === null ? (
              t("sidebar.chat.shareNeverAccessed")
            ) : (
              <time>{formatEpochMillis(record.lastAccessedAt)}</time>
            )}
          </dd>
        </div>
      </dl>
    </article>
  );
}
