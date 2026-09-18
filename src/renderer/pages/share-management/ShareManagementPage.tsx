import {
  ArrowRightOutlined,
  CheckOutlined,
  CopyOutlined,
  DisconnectOutlined,
  LinkOutlined,
  ShareAltOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssistantConversationShareRecord } from "../../../shared/contracts";
import { formatEpochMillis } from "../../../shared/time-contract";
import { useI18n } from "../../i18n/useI18n";

type ShareManagementStatus = "idle" | "loading" | "ready" | "error";

type ShareGroup = {
  chatId: string;
  chatName: string;
  agentKey: string;
  records: AssistantConversationShareRecord[];
};

type ShareChatDetails = Pick<ShareGroup, "chatName" | "agentKey">;

type ShareManagementPageProps = {
  tunnelHubEnabled: boolean;
  onOpenTunnelSettings: () => void;
  onOpenChat: (request: { agentKey: string; chatId: string }) => void;
};

const COPY_FEEDBACK_DURATION_MS = 1_600;

export function ShareManagementPage({
  tunnelHubEnabled,
  onOpenTunnelSettings,
  onOpenChat,
}: ShareManagementPageProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ShareManagementStatus>("idle");
  const [records, setRecords] = useState<AssistantConversationShareRecord[]>([]);
  const [chatDetails, setChatDetails] = useState<Record<string, ShareChatDetails>>({});
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [copiedShareId, setCopiedShareId] = useState("");
  const [selectedChatId, setSelectedChatId] = useState("");
  const [confirmingRevokeShareId, setConfirmingRevokeShareId] = useState("");
  const [revokingShareId, setRevokingShareId] = useState("");
  const requestIdRef = useRef(0);
  const copyFeedbackTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!tunnelHubEnabled) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus("loading");
    setLoadError("");
    try {
      const [shareResult, historyResult] = await Promise.all([
        window.electronAPI.assistant.listConversationShares(),
        window.electronAPI.assistant.listHistoryChats(),
      ]);
      if (requestIdRef.current !== requestId) return;
      if (!shareResult.ok) {
        setStatus("error");
        setLoadError(shareResult.message || t("shareManagement.loadFailed"));
        return;
      }
      const nextChatDetails: Record<string, ShareChatDetails> = {};
      if (historyResult.ok) {
        for (const chat of historyResult.items) {
          const chatId = chat.chatId.trim();
          if (chatId) {
            nextChatDetails[chatId] = {
              chatName: chat.chatName.trim() || chatId,
              agentKey: chat.agentKey.trim(),
            };
          }
        }
      }
      setRecords([...shareResult.records].sort(compareShareRecords));
      setChatDetails(nextChatDetails);
      setStatus("ready");
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setStatus("error");
      setLoadError(error instanceof Error ? error.message : t("shareManagement.loadFailed"));
    }
  }, [t, tunnelHubEnabled]);

  useEffect(() => {
    if (!tunnelHubEnabled) {
      requestIdRef.current += 1;
      setStatus("idle");
      setRecords([]);
      setChatDetails({});
      setLoadError("");
      setActionError("");
      setNotice("");
      setConfirmingRevokeShareId("");
      setRevokingShareId("");
      return;
    }
    void load();
  }, [load, tunnelHubEnabled]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );

  const groups = useMemo(() => groupShares(records, chatDetails), [chatDetails, records]);
  const selectedGroup = groups.find((group) => group.chatId === selectedChatId) ?? groups[0] ?? null;

  async function copyShare(record: AssistantConversationShareRecord) {
    try {
      const result = await window.electronAPI.clipboard.writeText(record.url);
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = null;
      }
      if (!result.ok) {
        setCopiedShareId("");
        setActionError(result.message || t("sidebar.chat.shareCopyFailed"));
        return;
      }
      setCopiedShareId(record.shareId);
      setActionError("");
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        copyFeedbackTimerRef.current = null;
        setCopiedShareId((current) => current === record.shareId ? "" : current);
      }, COPY_FEEDBACK_DURATION_MS);
    } catch (error) {
      setCopiedShareId("");
      setActionError(error instanceof Error ? error.message : t("sidebar.chat.shareCopyFailed"));
    }
  }

  async function confirmRevoke() {
    const shareId = confirmingRevokeShareId;
    if (!shareId || revokingShareId) return;
    setConfirmingRevokeShareId("");
    setRevokingShareId(shareId);
    setActionError("");
    setNotice("");
    try {
      const result = await window.electronAPI.assistant.revokeChatShare(shareId);
      if (!result.ok) {
        setActionError(result.message || t("sidebar.chat.shareRevokeFailed"));
        return;
      }
      setRecords((current) => current.filter((record) => record.shareId !== shareId));
      setNotice(result.message || t("assistant.chatShareRevoked"));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("sidebar.chat.shareRevokeFailed"));
    } finally {
      setRevokingShareId("");
    }
  }

  return (
    <section className="share-management-page" aria-labelledby="share-management-title">
      <header className="share-management-page-header">
        <div>
          <h1 id="share-management-title">{t("shareManagement.title")}</h1>
          <p>{t("shareManagement.description")}</p>
        </div>
        {tunnelHubEnabled ? (
          <button type="button" className="share-management-button" onClick={() => void load()} disabled={status === "loading"}>
            {t("common.refresh")}
          </button>
        ) : null}
      </header>

      {!tunnelHubEnabled ? (
        <div className="share-management-state-card">
          <ShareAltOutlined aria-hidden="true" />
          <h2>{t("shareManagement.tunnelRequiredTitle")}</h2>
          <p>{t("assistant.chatShareTunnelRequired")}</p>
          <button type="button" className="share-management-button is-primary" onClick={onOpenTunnelSettings}>
            {t("shareManagement.openTunnelSettings")}
          </button>
        </div>
      ) : (
        <div className="share-management-content" aria-busy={status === "loading"}>
          {actionError ? <div className="share-management-feedback is-error" role="alert">{actionError}</div> : null}
          {notice ? <div className="share-management-feedback is-success" role="status">{notice}</div> : null}
          {status === "loading" && records.length === 0 ? (
            <div className="share-management-state-card"><p>{t("shareManagement.loading")}</p></div>
          ) : null}
          {status === "error" ? (
            <div className="share-management-state-card">
              <h2>{t("shareManagement.loadFailedTitle")}</h2>
              <p>{loadError}</p>
              <button type="button" className="share-management-button" onClick={() => void load()}>{t("common.retry")}</button>
            </div>
          ) : null}
          {status === "ready" && groups.length === 0 ? (
            <div className="share-management-state-card">
              <ShareAltOutlined aria-hidden="true" />
              <h2>{t("shareManagement.emptyTitle")}</h2>
              <p>{t("shareManagement.emptyDescription")}</p>
            </div>
          ) : null}
          {selectedGroup && status !== "error" ? (
            <div className="share-management-layout">
              <aside className="share-management-list" aria-label={t("shareManagement.title")}>
                <p className="share-management-list-count">
                  {t("shareManagement.linkCount", { count: records.length })}
                </p>
                <div className="share-management-list-items">
                  {groups.map((group) => (
                    <button
                      type="button"
                      className="share-management-list-item"
                      key={group.chatId}
                      aria-current={group.chatId === selectedGroup.chatId ? "true" : undefined}
                      onClick={() => {
                        setSelectedChatId(group.chatId);
                        setConfirmingRevokeShareId("");
                      }}
                    >
                      <strong>{group.chatName}</strong>
                      <span title={group.chatId}>{group.chatId}</span>
                      <small>{t("shareManagement.linkCount", { count: group.records.length })}</small>
                    </button>
                  ))}
                </div>
              </aside>
              <div className="share-management-detail">
                {groups.map((group) => group.chatId === selectedGroup.chatId ? (
                  <section className="share-management-group" key={group.chatId}>
                    <header>
                      <div className="share-management-group-title">
                        <h2>{group.chatName}</h2>
                        <p title={group.chatId}>{group.chatId}</p>
                      </div>
                      <div className="share-management-group-header-actions">
                        <span className="share-management-group-link-count">
                          {t("shareManagement.linkCount", { count: group.records.length })}
                        </span>
                        <button
                          type="button"
                          className="share-management-button share-management-open-chat-button"
                          disabled={!group.agentKey}
                          title={group.agentKey
                            ? t("shareManagement.openConversation")
                            : t("shareManagement.conversationUnavailable")}
                          onClick={() => onOpenChat({ agentKey: group.agentKey, chatId: group.chatId })}
                        >
                          <span>{group.agentKey
                            ? t("shareManagement.openConversation")
                            : t("shareManagement.conversationUnavailable")}</span>
                          <ArrowRightOutlined aria-hidden="true" />
                        </button>
                      </div>
                    </header>
                    <div className="share-management-records">
                      {group.records.map((record) => (
                        <ShareManagementRecord
                          key={record.shareId}
                          record={record}
                          copied={copiedShareId === record.shareId}
                          confirmingRevoke={confirmingRevokeShareId === record.shareId}
                          revoking={revokingShareId === record.shareId}
                          anotherRevokePending={Boolean(revokingShareId && revokingShareId !== record.shareId)}
                          onCopy={() => void copyShare(record)}
                          onRequestRevoke={() => {
                            setConfirmingRevokeShareId(record.shareId);
                            setActionError("");
                            setNotice("");
                          }}
                          onCancelRevoke={() => setConfirmingRevokeShareId("")}
                          onConfirmRevoke={() => void confirmRevoke()}
                        />
                      ))}
                    </div>
                  </section>
                ) : null)}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ShareManagementRecord({
  record,
  copied,
  confirmingRevoke,
  revoking,
  anotherRevokePending,
  onCopy,
  onRequestRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: {
  record: AssistantConversationShareRecord;
  copied: boolean;
  confirmingRevoke: boolean;
  revoking: boolean;
  anotherRevokePending: boolean;
  onCopy: () => void;
  onRequestRevoke: () => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
}) {
  const { t } = useI18n();
  return (
    <article className="share-management-record">
      <div className="share-management-record-main">
        <div className="share-management-link">
          <LinkOutlined aria-hidden="true" />
          <span className="share-management-link-text" title={record.url}>{record.url}</span>
        </div>
        <div className="share-management-record-actions">
          {confirmingRevoke ? (
            <div className="share-management-revoke-confirmation" role="group" aria-label={t("sidebar.chat.shareRevokeConfirm")}>
              <button type="button" className="share-management-button" onClick={onCancelRevoke}>{t("common.cancel")}</button>
              <button type="button" className="share-management-button is-danger" onClick={onConfirmRevoke}>{t("sidebar.chat.shareRevoke")}</button>
            </div>
          ) : (
            <>
              <button type="button" className="share-management-button" data-copied={copied || undefined} aria-live="polite" onClick={onCopy}>
                {copied ? <CheckOutlined aria-hidden="true" /> : <CopyOutlined aria-hidden="true" />}
                <span>{copied ? t("sidebar.chat.shareCopied") : t("common.copy")}</span>
              </button>
              <button type="button" className="share-management-button is-danger" disabled={revoking || anotherRevokePending} onClick={onRequestRevoke}>
                <DisconnectOutlined aria-hidden="true" />
                <span>{revoking ? t("sidebar.common.processing") : t("sidebar.chat.shareRevokeAction")}</span>
              </button>
            </>
          )}
        </div>
      </div>
      <dl className="share-management-meta">
        <div><dt>{t("sidebar.chat.shareCreatedAt")}</dt><dd><time>{formatEpochMillis(record.createdAt)}</time></dd></div>
        <div>
          <dt>{t("sidebar.chat.shareExpiry")}</dt>
          <dd>{record.singleUse ? t("sidebar.chat.shareSingleUse") : record.expiresAt === null ? t("sidebar.chat.sharePermanent") : <time>{formatEpochMillis(record.expiresAt)}</time>}</dd>
        </div>
        <div>
          <dt>{t("sidebar.chat.shareLastAccessedAt")}</dt>
          <dd>{record.lastAccessedAt === null ? t("sidebar.chat.shareNeverAccessed") : <time>{formatEpochMillis(record.lastAccessedAt)}</time>}</dd>
        </div>
      </dl>
    </article>
  );
}

function compareShareRecords(left: AssistantConversationShareRecord, right: AssistantConversationShareRecord) {
  return right.createdAt - left.createdAt || right.shareId.localeCompare(left.shareId);
}

function groupShares(
  records: AssistantConversationShareRecord[],
  chatDetails: Record<string, ShareChatDetails>,
): ShareGroup[] {
  const groups = new Map<string, ShareGroup>();
  for (const record of records) {
    const existing = groups.get(record.chatId);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    const chat = chatDetails[record.chatId];
    groups.set(record.chatId, {
      chatId: record.chatId,
      chatName: chat?.chatName || record.chatId,
      agentKey: chat?.agentKey || "",
      records: [record],
    });
  }
  return [...groups.values()];
}
