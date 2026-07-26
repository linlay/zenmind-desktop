import {
  ArrowLeftOutlined,
  CloseOutlined,
  MessageOutlined,
  ReloadOutlined,
  SendOutlined,
  TeamOutlined
} from "@ant-design/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from "react";
import type {
  DesktopSsoStatus,
  EnterpriseChatConversation,
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../../shared/contracts";
import { useI18n } from "../i18n/useI18n";

type EnterpriseChatFloatingPanelProps = {
  desktopSsoStatus: DesktopSsoStatus | null;
};

function hasCompleteEnterpriseLogin(status: DesktopSsoStatus | null) {
  return Boolean(
    status?.authenticated &&
    status.completedSteps.session &&
    status.completedSteps.userInfo &&
    status.completedSteps.accessToken
  );
}

function initials(user: EnterpriseChatUser) {
  const source = (user.displayName || user.email || user.id || "?").trim();
  return source.slice(0, 2).toUpperCase();
}

function EnterpriseChatAvatar({ user }: { user: EnterpriseChatUser }) {
  const [failed, setFailed] = useState(false);
  if (user.avatarUrl && !failed) {
    return (
      <img
        className="enterprise-chat-avatar"
        src={user.avatarUrl}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="enterprise-chat-avatar enterprise-chat-avatar-fallback" aria-hidden="true">
      {initials(user)}
    </span>
  );
}

function directPeer(
  conversation: EnterpriseChatConversation | undefined,
  currentUserId: string
) {
  return conversation?.members.find((member) => member.user.id !== currentUserId)?.user ?? null;
}

function conversationForUser(
  conversations: EnterpriseChatConversation[],
  userId: string
) {
  return conversations.find((conversation) =>
    conversation.members.some((member) => member.user.id === userId)
  );
}

function presenceRank(user: EnterpriseChatUser) {
  return user.online === true ? 0 : user.online === null ? 1 : 2;
}

function presenceClass(user: EnterpriseChatUser) {
  return user.online === true
    ? "is-online"
    : user.online === false
      ? "is-offline"
      : "is-unknown";
}

function newClientMessageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `desktop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function EnterpriseChatFloatingPanel({
  desktopSsoStatus
}: EnterpriseChatFloatingPanelProps) {
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = useState<EnterpriseChatSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [busyUserId, setBusyUserId] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const signedIn = hasCompleteEnterpriseLogin(desktopSsoStatus);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.enterpriseChat.getState()
      .then((state) => {
        if (!cancelled) {
          setSnapshot(state);
        }
      })
      .catch(() => undefined);
    const dispose = window.electronAPI.enterpriseChat.onStateChanged((state) => {
      setSnapshot(state);
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setOpen(false);
      setConversationOpen(false);
      setSelectedUserId("");
    }
    void window.electronAPI.enterpriseChat.refresh()
      .then(setSnapshot)
      .catch(() => undefined);
  }, [signedIn]);

  useEffect(() => {
    if (!conversationOpen || !open || !snapshot?.activeMessages.length) {
      return;
    }
    const lastMessage = snapshot.activeMessages[snapshot.activeMessages.length - 1];
    const activeConversation = snapshot.conversations.find(
      (conversation) => conversation.id === snapshot.activeConversationId
    );
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth"
    });
    if (
      lastMessage.senderId !== snapshot.currentUser?.id &&
      snapshot.activeConversationId &&
      (activeConversation?.lastReadSeq ?? 0) < lastMessage.seq
    ) {
      void window.electronAPI.enterpriseChat.markRead({
        conversationId: snapshot.activeConversationId,
        seq: lastMessage.seq
      }).then(setSnapshot).catch(() => undefined);
    }
  }, [
    conversationOpen,
    open,
    snapshot?.activeConversationId,
    snapshot?.activeMessages,
    snapshot?.currentUser?.id
  ]);

  const users = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return [...snapshot.users].sort((left, right) => {
      const presenceOrder = presenceRank(left) - presenceRank(right);
      if (presenceOrder) {
        return presenceOrder;
      }
      const leftConversation = conversationForUser(snapshot.conversations, left.id);
      const rightConversation = conversationForUser(snapshot.conversations, right.id);
      const recency = (rightConversation?.updatedAt ?? 0) - (leftConversation?.updatedAt ?? 0);
      return recency || left.displayName.localeCompare(right.displayName, locale);
    });
  }, [locale, snapshot]);

  const activeConversation = snapshot?.conversations.find(
    (conversation) => conversation.id === snapshot.activeConversationId
  );
  const activePeer = directPeer(activeConversation, snapshot?.currentUser?.id ?? "") ??
    users.find((user) => user.id === selectedUserId) ??
    null;
  const unreadCount = snapshot?.conversations.reduce(
    (total, conversation) => total + conversation.unreadCount,
    0
  ) ?? 0;
  const visible = signedIn && snapshot?.enabled === true;

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.refresh());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRefreshing(false);
    }
  }

  async function openConversation(user: EnterpriseChatUser) {
    setBusyUserId(user.id);
    setError("");
    try {
      const next = await window.electronAPI.enterpriseChat.openDirectConversation({
        userId: user.id
      });
      setSnapshot(next);
      setSelectedUserId(user.id);
      setConversationOpen(true);
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyUserId("");
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    const conversationId = snapshot?.activeConversationId ?? "";
    if (!body || !conversationId || sending) {
      return;
    }
    setSending(true);
    setError("");
    try {
      const next = await window.electronAPI.enterpriseChat.sendMessage({
        conversationId,
        clientMessageId: newClientMessageId(),
        body
      });
      setSnapshot(next);
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  if (!visible) {
    return null;
  }

  const connectionLabel = snapshot.connectionState === "connected"
    ? t("enterpriseChat.connected")
    : snapshot.connectionState === "connecting" || snapshot.connectionState === "reconnecting"
      ? t("enterpriseChat.connecting")
      : t("enterpriseChat.unavailable");
  const presenceLabel = (user: EnterpriseChatUser) => user.online === true
    ? t("enterpriseChat.online")
    : user.online === false
      ? t("enterpriseChat.offline")
      : t("enterpriseChat.presenceUnknown");

  return (
    <aside className="enterprise-chat-floating" aria-label={t("enterpriseChat.title")}>
      {open ? (
        <section className="enterprise-chat-panel" role="dialog" aria-label={t("enterpriseChat.title")}>
          <header className="enterprise-chat-header">
            {conversationOpen ? (
              <button
                type="button"
                className="enterprise-chat-icon-button"
                aria-label={t("enterpriseChat.back")}
                onClick={() => {
                  setConversationOpen(false);
                  setError("");
                }}
              >
                <ArrowLeftOutlined />
              </button>
            ) : (
              <span className="enterprise-chat-header-icon" aria-hidden="true">
                <TeamOutlined />
              </span>
            )}
            <div className="enterprise-chat-header-copy">
              <strong>{conversationOpen && activePeer ? activePeer.displayName : t("enterpriseChat.title")}</strong>
              <span>
                <i
                  className={`enterprise-chat-connection-dot ${
                    conversationOpen && activePeer
                      ? presenceClass(activePeer)
                      : `is-${snapshot.connectionState}`
                  }`}
                />
                {conversationOpen && activePeer
                  ? activePeer.email || presenceLabel(activePeer)
                  : connectionLabel}
              </span>
            </div>
            {!conversationOpen ? (
              <button
                type="button"
                className="enterprise-chat-icon-button"
                aria-label={t("enterpriseChat.refresh")}
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <ReloadOutlined spin={refreshing} />
              </button>
            ) : null}
            <button
              type="button"
              className="enterprise-chat-icon-button"
              aria-label={t("enterpriseChat.close")}
              onClick={() => setOpen(false)}
            >
              <CloseOutlined />
            </button>
          </header>

          {conversationOpen ? (
            <>
              <div className="enterprise-chat-message-list" ref={messageListRef}>
                {snapshot.activeMessages.length === 0 ? (
                  <div className="enterprise-chat-empty">
                    <MessageOutlined />
                    <strong>{t("enterpriseChat.noMessages")}</strong>
                    <span>{t("enterpriseChat.noMessagesDescription")}</span>
                  </div>
                ) : snapshot.activeMessages.map((message) => {
                  const mine = message.senderId === snapshot.currentUser?.id;
                  return (
                    <div
                      className={mine ? "enterprise-chat-message is-mine" : "enterprise-chat-message"}
                      key={message.id}
                    >
                      <div className="enterprise-chat-message-bubble">
                        {message.revokedAt
                          ? <em>{t("enterpriseChat.revoked")}</em>
                          : message.body}
                      </div>
                      <time>
                        {new Intl.DateTimeFormat(locale, {
                          hour: "2-digit",
                          minute: "2-digit"
                        }).format(message.createdAt)}
                      </time>
                    </div>
                  );
                })}
              </div>
              <form className="enterprise-chat-composer" onSubmit={(event) => void sendMessage(event)}>
                {error ? <div className="enterprise-chat-error" role="alert">{error}</div> : null}
                <div className="enterprise-chat-composer-row">
                  <textarea
                    value={draft}
                    rows={2}
                    maxLength={20_000}
                    placeholder={t("enterpriseChat.messagePlaceholder")}
                    aria-label={t("enterpriseChat.messagePlaceholder")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                  />
                  <button
                    type="submit"
                    className="enterprise-chat-send-button"
                    aria-label={t("enterpriseChat.send")}
                    disabled={!draft.trim() || sending || snapshot.connectionState !== "connected"}
                  >
                    <SendOutlined />
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div className="enterprise-chat-directory">
              <div className="enterprise-chat-directory-title">
                <strong>{t("enterpriseChat.employees")}</strong>
                <span>{t("enterpriseChat.employeeCount", { count: users.length })}</span>
              </div>
              {error || snapshot.message ? (
                <div className="enterprise-chat-error" role="alert">{error || snapshot.message}</div>
              ) : null}
              {users.length === 0 ? (
                <div className="enterprise-chat-empty">
                  <TeamOutlined />
                  <strong>{t("enterpriseChat.noEmployees")}</strong>
                  <span>{t("enterpriseChat.noEmployeesDescription")}</span>
                </div>
              ) : (
                <div className="enterprise-chat-user-list">
                  {users.map((user) => {
                    const conversation = conversationForUser(snapshot.conversations, user.id);
                    return (
                      <button
                        type="button"
                        className="enterprise-chat-user"
                        key={user.id}
                        disabled={busyUserId === user.id}
                        onClick={() => void openConversation(user)}
                      >
                        <span className="enterprise-chat-avatar-wrap">
                          <EnterpriseChatAvatar user={user} />
                          <i className={presenceClass(user)} />
                        </span>
                        <span className="enterprise-chat-user-copy">
                          <strong>{user.displayName}</strong>
                          <small>
                            {conversation?.lastMessage?.body ||
                              user.email ||
                              presenceLabel(user)}
                          </small>
                        </span>
                        {conversation?.unreadCount ? (
                          <span className="enterprise-chat-user-unread">
                            {Math.min(99, conversation.unreadCount)}
                          </span>
                        ) : (
                          <span className={`enterprise-chat-presence ${presenceClass(user)}`}>
                            {presenceLabel(user)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>
      ) : null}
      <button
        type="button"
        className={open ? "enterprise-chat-launcher is-open" : "enterprise-chat-launcher"}
        aria-label={open ? t("enterpriseChat.close") : t("enterpriseChat.open")}
        title={open ? t("enterpriseChat.close") : t("enterpriseChat.open")}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <CloseOutlined /> : <MessageOutlined />}
        {!open && unreadCount > 0 ? (
          <span className="enterprise-chat-launcher-badge">{Math.min(99, unreadCount)}</span>
        ) : null}
      </button>
    </aside>
  );
}
