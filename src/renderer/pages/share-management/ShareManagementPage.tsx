import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  CopyOutlined,
  DisconnectOutlined,
  ExclamationCircleOutlined,
  LinkOutlined,
  ShareAltOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShareRecord } from "../../../shared/contracts";
import { formatEpochMillis } from "../../../shared/time-contract";
import { useI18n } from "../../i18n/useI18n";

type ShareManagementStatus = "idle" | "loading" | "ready" | "error";

type ShareManagementPageProps = {
  tunnelHubEnabled: boolean;
  onOpenTunnelSettings: () => void;
  onOpenChat: (request: { agentKey: string; chatId: string }) => void;
};

const COPY_FEEDBACK_DURATION_MS = 1_600;
const ACTION_FEEDBACK_DURATION_MS = 3_200;
type ActionFeedback = { kind: "success" | "error"; message: string };

export function ShareManagementPage({
  tunnelHubEnabled,
  onOpenTunnelSettings,
  onOpenChat,
}: ShareManagementPageProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ShareManagementStatus>("idle");
  const [records, setRecords] = useState<ShareRecord[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const [copiedShareId, setCopiedShareId] = useState("");
  const [selectedChatId, setSelectedChatId] = useState("");
  const [revokingShareId, setRevokingShareId] = useState("");
  const requestIdRef = useRef(0);
  const generationRef = useRef(0);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const actionFeedbackTimerRef = useRef<number | null>(null);

  const clearActionFeedback = useCallback(() => {
    if (actionFeedbackTimerRef.current !== null) {
      window.clearTimeout(actionFeedbackTimerRef.current);
      actionFeedbackTimerRef.current = null;
    }
    setActionFeedback(null);
  }, []);

  const showActionFeedback = useCallback((kind: ActionFeedback["kind"], message: string) => {
    if (actionFeedbackTimerRef.current !== null) window.clearTimeout(actionFeedbackTimerRef.current);
    setActionFeedback({ kind, message });
    actionFeedbackTimerRef.current = window.setTimeout(() => {
      actionFeedbackTimerRef.current = null;
      setActionFeedback(null);
    }, ACTION_FEEDBACK_DURATION_MS);
  }, []);

  const load = useCallback(async () => {
    if (!tunnelHubEnabled) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus("loading");
    setLoadError("");
    try {
      const shareResult = await window.electronAPI.shares.list();
      if (requestIdRef.current !== requestId) return;
      if (!shareResult.ok) {
        setStatus("error");
        setLoadError(shareResult.message || t("shareManagement.loadFailed"));
        return;
      }
      setRecords([...shareResult.records].sort(compareShareRecords));
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
      generationRef.current += 1;
      setStatus("idle");
      setRecords([]);
      setLoadError("");
      clearActionFeedback();
      setRevokingShareId("");
      return;
    }
    void load();
  }, [clearActionFeedback, load, tunnelHubEnabled]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      generationRef.current += 1;
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      if (actionFeedbackTimerRef.current !== null) {
        window.clearTimeout(actionFeedbackTimerRef.current);
      }
    },
    [],
  );

  const groups = useMemo(() => records.map((record) => ({ id: record.id, title: record.title, kind: record.kind, records: [record] })), [records]);
  const selectedGroup = groups.find((group) => group.id === selectedChatId) ?? groups[0] ?? null;

  async function copyShare(record: ShareRecord) {
    const generation = generationRef.current;
    try {
      const result = await window.electronAPI.clipboard.writeText(record.url);
      if (generationRef.current !== generation) return;
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = null;
      }
      if (!result.ok) {
        setCopiedShareId("");
        showActionFeedback("error", result.message || t("sidebar.chat.shareCopyFailed"));
        return;
      }
      setCopiedShareId(record.id);
      clearActionFeedback();
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        copyFeedbackTimerRef.current = null;
        setCopiedShareId((current) => current === record.id ? "" : current);
      }, COPY_FEEDBACK_DURATION_MS);
    } catch (error) {
      if (generationRef.current !== generation) return;
      setCopiedShareId("");
      showActionFeedback("error", error instanceof Error ? error.message : t("sidebar.chat.shareCopyFailed"));
    }
  }

  async function openSource(record: ShareRecord) {
    if (record.source?.module !== "conversation") return;
    const generation = generationRef.current;
    try {
      const chat = await window.electronAPI.assistant.getChatInfo(record.source.id);
      if (generationRef.current !== generation) return;
      if (!chat?.agentKey || chat.chatId !== record.source.id) {
        showActionFeedback("error", t("shareManagement.conversationUnavailable"));
        return;
      }
      onOpenChat({ agentKey: chat.agentKey, chatId: chat.chatId });
    } catch {
      if (generationRef.current === generation) showActionFeedback("error", t("shareManagement.conversationUnavailable"));
    }
  }

  async function revokeShare(shareId: string) {
    if (revokingShareId) return;
    const generation = generationRef.current;
    setRevokingShareId(shareId);
    clearActionFeedback();
    try {
      const result = await window.electronAPI.shares.revoke(shareId);
      if (generationRef.current !== generation) return;
      if (!result.ok) {
        showActionFeedback("error", result.message || t("sidebar.chat.shareRevokeFailed"));
        return;
      }
      requestIdRef.current += 1;
      setStatus("ready");
      setRecords((current) => current.filter((record) => record.id !== shareId));
      showActionFeedback("success", result.message || t("assistant.chatShareRevoked"));
    } catch (error) {
      if (generationRef.current !== generation) return;
      showActionFeedback("error", error instanceof Error ? error.message : t("sidebar.chat.shareRevokeFailed"));
    } finally {
      if (generationRef.current === generation) setRevokingShareId("");
    }
  }

  return (
    <section className="share-management-page" aria-labelledby="share-management-title">
      {actionFeedback ? (
        <div className="share-management-action-toast" data-kind={actionFeedback.kind} role={actionFeedback.kind === "error" ? "alert" : "status"}>
          {actionFeedback.kind === "success" ? <CheckCircleOutlined aria-hidden="true" /> : <ExclamationCircleOutlined aria-hidden="true" />}
          <span>{actionFeedback.message}</span>
        </div>
      ) : null}
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
                      key={group.id}
                      aria-current={group.id === selectedGroup.id ? "true" : undefined}
                      onClick={() => {
                        setSelectedChatId(group.id);
                      }}
                    >
                      <strong>{group.title}</strong>
                      <span title={group.kind}>{group.kind}</span>
                      <small>{t("shareManagement.linkCount", { count: group.records.length })}</small>
                    </button>
                  ))}
                </div>
              </aside>
              <div className="share-management-detail">
                {groups.map((group) => group.id === selectedGroup.id ? (
                  <section className="share-management-group" key={group.id}>
                    <header>
                      <div className="share-management-group-title">
                        <h2>{group.title}</h2>
                        <p title={group.id}>{group.id}</p>
                      </div>
                      <div className="share-management-group-header-actions">
                        <span className="share-management-group-link-count">
                          {t("shareManagement.linkCount", { count: group.records.length })}
                        </span>
                        {group.records[0]?.source?.module === "conversation" ? (
                          <button type="button" className="share-management-button share-management-open-chat-button" onClick={() => void openSource(group.records[0])}>
                            <span>{t("shareManagement.openConversation")}</span><ArrowRightOutlined aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    </header>
                    <div className="share-management-records">
                      {group.records.map((record) => (
                        <ShareManagementRecord
                          key={record.id}
                          record={record}
                          copied={copiedShareId === record.id}
                          revoking={revokingShareId === record.id}
                          anotherRevokePending={Boolean(revokingShareId && revokingShareId !== record.id)}
                          onCopy={() => void copyShare(record)}
                          onRevoke={() => void revokeShare(record.id)}
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
  revoking,
  anotherRevokePending,
  onCopy,
  onRevoke,
}: {
  record: ShareRecord;
  copied: boolean;
  revoking: boolean;
  anotherRevokePending: boolean;
  onCopy: () => void;
  onRevoke: () => void;
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
          <button type="button" className="share-management-button" data-copied={copied || undefined} aria-live="polite" onClick={onCopy}>
            {copied ? <CheckOutlined aria-hidden="true" /> : <CopyOutlined aria-hidden="true" />}
            <span>{copied ? t("sidebar.chat.shareCopied") : t("common.copy")}</span>
          </button>
          <button type="button" className="share-management-button is-danger" disabled={revoking || anotherRevokePending} onClick={onRevoke}>
            <DisconnectOutlined aria-hidden="true" />
            <span>{revoking ? t("sidebar.common.processing") : t("sidebar.chat.shareRevokeAction")}</span>
          </button>
        </div>
      </div>
      <dl className="share-management-meta">
        <div><dt>{t("sidebar.chat.shareCreatedAt")}</dt><dd><time>{formatEpochMillis(record.createdAt)}</time></dd></div>
        <div>
          <dt>{t("sidebar.chat.shareLastAccessedAt")}</dt>
          <dd>{record.lastAccessedAt === null ? t("sidebar.chat.shareNeverAccessed") : <time>{formatEpochMillis(record.lastAccessedAt)}</time>}</dd>
        </div>
      </dl>
    </article>
  );
}

function compareShareRecords(left: ShareRecord, right: ShareRecord) {
  return right.createdAt - left.createdAt || right.id.localeCompare(left.id);
}
