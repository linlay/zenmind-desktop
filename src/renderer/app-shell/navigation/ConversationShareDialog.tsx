import { createPortal } from "react-dom";
import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import type {
  AssistantConversationShareExpiration,
  AssistantConversationShareRecord,
} from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";
import { formatEpochMillis } from "../../../shared/time-contract";
import type { ConversationShareDialogState } from "./useConversationShareDialog";

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
  return createPortal(
    <div
      className="sidebar-agent-dialog-layer"
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
        <div className="sidebar-agent-dialog-head">
          <strong id="sidebar-chat-share-dialog-title">
            {t("sidebar.chat.shareTitle")}
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

        <p className="sidebar-chat-share-name">{state.chatName}</p>
        <p className="sidebar-agent-dialog-message">
          {t("sidebar.chat.shareConfirm")}
        </p>

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
              <option value="5m">{t("sidebar.chat.shareExpiration.5m")}</option>
              <option value="30m">
                {t("sidebar.chat.shareExpiration.30m")}
              </option>
              <option value="1h">{t("sidebar.chat.shareExpiration.1h")}</option>
              <option value="3h">{t("sidebar.chat.shareExpiration.3h")}</option>
              <option value="1d">{t("sidebar.chat.shareExpiration.1d")}</option>
              <option value="5d">{t("sidebar.chat.shareExpiration.5d")}</option>
              <option value="15d">
                {t("sidebar.chat.shareExpiration.15d")}
              </option>
              <option value="30d">
                {t("sidebar.chat.shareExpiration.30d")}
              </option>
              <option value="permanent">
                {t("sidebar.chat.shareExpiration.permanent")}
              </option>
            </select>
          </label>
          <button
            type="button"
            className="sidebar-agent-primary-button"
            disabled={state.creating}
            onClick={onCreate}
          >
            {state.creating
              ? t("sidebar.common.processing")
              : t("sidebar.chat.shareCreate")}
          </button>
        </div>

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

        <div className="sidebar-chat-share-history-head">
          <strong>{t("sidebar.chat.shareHistory")}</strong>
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
          {state.listStatus === "error" ? (
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
        <div className="sidebar-agent-dialog-actions sidebar-chat-share-dialog-actions">
          <button
            type="button"
            className="sidebar-agent-primary-button"
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
          <input
            aria-label={t("sidebar.chat.shareLink")}
            title={record.url}
            value={record.url}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="sidebar-chat-share-copy-button"
            data-copied={copied || undefined}
            aria-live="polite"
            onClick={onCopy}
          >
            {copied ? (
              <CheckOutlined aria-hidden="true" />
            ) : (
              <CopyOutlined aria-hidden="true" />
            )}
            <span>
              {copied ? t("sidebar.chat.shareCopied") : t("common.copy")}
            </span>
          </button>
        </div>
        <div
          className="sidebar-chat-share-record-actions"
          role={confirmingRevoke ? "group" : undefined}
          aria-label={
            confirmingRevoke ? t("sidebar.chat.shareRevokeConfirm") : undefined
          }
        >
          {confirmingRevoke ? (
            <>
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
            </>
          ) : (
            <button
              type="button"
              className="sidebar-chat-share-revoke-button"
              disabled={revoking || anotherRevokePending}
              onClick={onRequestRevoke}
            >
              {revoking
                ? t("sidebar.common.processing")
                : t("sidebar.chat.shareRevoke")}
            </button>
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
            {record.expiresAt === null ? (
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
