import {
  ArrowLeftOutlined,
  CameraOutlined,
  CheckOutlined,
  CloseOutlined,
  DownloadOutlined,
  FileOutlined,
  MessageOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined
} from "@ant-design/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import {
  ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES,
  ENTERPRISE_CHAT_MAX_PASTED_FILES
} from "../../shared/contracts";
import type {
  DesktopSsoStatus,
  EnterpriseChatAttachment,
  EnterpriseChatConversation,
  EnterpriseChatMessage,
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../../shared/contracts";
import { useI18n } from "../i18n/useI18n";

type EnterpriseChatFloatingPanelProps = {
  desktopSsoStatus: DesktopSsoStatus | null;
};

type PanelView = "chats" | "contacts" | "new-group" | "conversation" | "new-action";
type LauncherPosition = { x: number; y: number };

const CHAT_LAUNCHER_POSITION_KEY = "zenmind.enterpriseChat.launcherPosition.v1";
const CHAT_LAUNCHER_SIZE = 54 * 0.7;
const CHAT_LAUNCHER_MARGIN = 12;

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
    conversation.type === "direct" &&
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

function clampLauncherPosition(
  position: LauncherPosition,
  viewport = { width: window.innerWidth, height: window.innerHeight }
) {
  return {
    x: Math.max(
      CHAT_LAUNCHER_MARGIN,
      Math.min(position.x, viewport.width - CHAT_LAUNCHER_SIZE - CHAT_LAUNCHER_MARGIN)
    ),
    y: Math.max(
      CHAT_LAUNCHER_MARGIN,
      Math.min(position.y, viewport.height - CHAT_LAUNCHER_SIZE - CHAT_LAUNCHER_MARGIN)
    )
  };
}

function readLauncherPosition() {
  const fallback = clampLauncherPosition({
    x: window.innerWidth - CHAT_LAUNCHER_SIZE - 20,
    y: window.innerHeight - CHAT_LAUNCHER_SIZE - 20
  });
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_LAUNCHER_POSITION_KEY) || "");
    if (
      typeof parsed?.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed?.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return clampLauncherPosition(parsed);
    }
  } catch {
    // Invalid renderer-only UI preferences fall back to the bottom-right corner.
  }
  return fallback;
}

function formatFileSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImageAttachment(attachment: EnterpriseChatAttachment) {
  return [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp"
  ].includes(attachment.contentType.toLowerCase());
}

function pastedFileName(file: File, index: number) {
  const explicitName = file.name.trim();
  if (explicitName) {
    return explicitName;
  }
  const extension = file.type === "image/jpeg"
    ? "jpg"
    : file.type === "image/gif"
      ? "gif"
      : file.type === "image/webp"
        ? "webp"
        : file.type === "image/bmp"
          ? "bmp"
          : "png";
  return `pasted-image-${Date.now()}-${index + 1}.${extension}`;
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read pasted file."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error("Unable to read pasted file."));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function EnterpriseChatFloatingPanel({
  desktopSsoStatus
}: EnterpriseChatFloatingPanelProps) {
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = useState<EnterpriseChatSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PanelView>("chats");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [groupTitle, setGroupTitle] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);
  const [actionName, setActionName] = useState("");
  const [actionArgs, setActionArgs] = useState("{}");
  const [actionSummary, setActionSummary] = useState("");
  const [actionResults, setActionResults] = useState<Record<string, string>>({});
  const [attachmentData, setAttachmentData] = useState<Record<string, string>>({});
  const [launcherPosition, setLauncherPosition] = useState<LauncherPosition>(readLauncherPosition);
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressLauncherClickRef = useRef(false);
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
    const dispose = window.electronAPI.enterpriseChat.onStateChanged(setSnapshot);
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setOpen(false);
      setView("chats");
    }
    void window.electronAPI.enterpriseChat.refresh()
      .then(setSnapshot)
      .catch(() => undefined);
  }, [signedIn]);

  useEffect(() => {
    const handleResize = () => {
      const nextViewport = {
        width: window.innerWidth,
        height: window.innerHeight
      };
      setViewport(nextViewport);
      setLauncherPosition((current) => clampLauncherPosition(current, nextViewport));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      CHAT_LAUNCHER_POSITION_KEY,
      JSON.stringify(launcherPosition)
    );
  }, [launcherPosition]);

  useEffect(() => {
    if (view !== "conversation" || !open || !snapshot?.activeMessages.length) {
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
    open,
    snapshot?.activeConversationId,
    snapshot?.activeMessages,
    snapshot?.conversations,
    snapshot?.currentUser?.id,
    view
  ]);

  useEffect(() => {
    const images = snapshot?.activeMessages
      .flatMap((message) => message.attachments)
      .filter(isImageAttachment) ?? [];
    for (const attachment of images) {
      if (attachmentData[attachment.id]) {
        continue;
      }
      setAttachmentData((current) => ({ ...current, [attachment.id]: "loading" }));
      void window.electronAPI.enterpriseChat.loadAttachment({
        fileId: attachment.id,
        contentType: attachment.contentType,
        name: attachment.name
      }).then((result) => {
        setAttachmentData((current) => ({
          ...current,
          [attachment.id]: `data:${result.contentType};base64,${result.dataBase64}`
        }));
      }).catch(() => {
        setAttachmentData((current) => ({ ...current, [attachment.id]: "error" }));
      });
    }
  }, [attachmentData, snapshot?.activeMessages]);

  const users = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return [...snapshot.users].sort((left, right) => {
      const presenceOrder = presenceRank(left) - presenceRank(right);
      if (presenceOrder) {
        return presenceOrder;
      }
      return left.displayName.localeCompare(right.displayName, locale);
    });
  }, [locale, snapshot]);

  const conversations = useMemo(
    () => [...(snapshot?.conversations ?? [])]
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [snapshot?.conversations]
  );
  const activeConversation = snapshot?.conversations.find(
    (conversation) => conversation.id === snapshot.activeConversationId
  );
  const activePeer = directPeer(activeConversation, snapshot?.currentUser?.id ?? "");
  const unreadCount = conversations.reduce(
    (total, conversation) => total + conversation.unreadCount,
    0
  );
  const visible = signedIn && snapshot?.enabled === true;

  const panelWidth = Math.min(460, viewport.width - 24);
  const panelHeight = Math.min(540, viewport.height - 82);
  const panelLeft = Math.max(
    12,
    Math.min(
      launcherPosition.x + CHAT_LAUNCHER_SIZE - panelWidth,
      viewport.width - panelWidth - 12
    )
  );
  const panelTop = launcherPosition.y >= panelHeight + 20
    ? launcherPosition.y - panelHeight - 12
    : Math.max(
        12,
        Math.min(
          launcherPosition.y + CHAT_LAUNCHER_SIZE + 12,
          viewport.height - panelHeight - 12
        )
      );
  const floatingStyle = {
    left: launcherPosition.x,
    top: launcherPosition.y
  } satisfies CSSProperties;
  const panelStyle = {
    left: panelLeft,
    top: panelTop,
    width: panelWidth,
    height: panelHeight
  } satisfies CSSProperties;

  const presenceLabel = (user: EnterpriseChatUser) => user.online === true
    ? t("enterpriseChat.online")
    : user.online === false
      ? t("enterpriseChat.offline")
      : t("enterpriseChat.presenceUnknown");

  function conversationTitle(conversation: EnterpriseChatConversation) {
    if (conversation.type === "group") {
      return conversation.title || t("enterpriseChat.unnamedGroup");
    }
    return directPeer(conversation, snapshot?.currentUser?.id ?? "")?.displayName ||
      t("enterpriseChat.directConversation");
  }

  function conversationPreview(conversation: EnterpriseChatConversation) {
    const message = conversation.lastMessage;
    if (!message) {
      return conversation.type === "group"
        ? t("enterpriseChat.groupMemberCount", { count: conversation.members.length })
        : t("enterpriseChat.noMessages");
    }
    if (message.kind === "desktop_action") {
      return t("enterpriseChat.desktopActionPreview", {
        action: message.desktopAction?.action ?? ""
      });
    }
    if (message.attachments.length > 0) {
      const hasImage = message.attachments.some(isImageAttachment);
      return hasImage ? t("enterpriseChat.imageMessage") : t("enterpriseChat.fileMessage");
    }
    return message.body;
  }

  async function refresh() {
    setBusy("refresh");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.refresh());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function openConversation(conversationId: string) {
    setBusy(`conversation:${conversationId}`);
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.openConversation({ conversationId }));
      setView("conversation");
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function openDirectConversation(user: EnterpriseChatUser) {
    setBusy(`user:${user.id}`);
    setError("");
    try {
      const next = await window.electronAPI.enterpriseChat.openDirectConversation({
        userId: user.id
      });
      setSnapshot(next);
      setView("conversation");
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    if (!groupTitle.trim() || groupMemberIds.length === 0) {
      return;
    }
    setBusy("group");
    setError("");
    try {
      const next = await window.electronAPI.enterpriseChat.createGroup({
        title: groupTitle.trim(),
        memberIds: groupMemberIds
      });
      setSnapshot(next);
      setGroupTitle("");
      setGroupMemberIds([]);
      setView("conversation");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    const conversationId = snapshot?.activeConversationId ?? "";
    if (!body || !conversationId || busy) {
      return;
    }
    setBusy("send");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.sendMessage({
        conversationId,
        clientMessageId: newClientMessageId(),
        body
      }));
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function sendFiles() {
    const conversationId = snapshot?.activeConversationId ?? "";
    if (!conversationId || busy) {
      return;
    }
    setBusy("files");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.sendFiles({
        conversationId,
        clientMessageId: newClientMessageId()
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function sendPastedFiles(files: File[]) {
    const conversationId = snapshot?.activeConversationId ?? "";
    if (!conversationId || files.length === 0) {
      return;
    }
    if (busy) {
      setError(t("enterpriseChat.sendBusy"));
      return;
    }
    if (files.length > ENTERPRISE_CHAT_MAX_PASTED_FILES) {
      setError(t("enterpriseChat.pastedFilesTooMany", {
        count: ENTERPRISE_CHAT_MAX_PASTED_FILES
      }));
      return;
    }
    const oversized = files.find((file) => file.size > ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES);
    if (oversized) {
      setError(t("enterpriseChat.pastedFileTooLarge", {
        name: pastedFileName(oversized, 0),
        size: formatFileSize(ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES)
      }));
      return;
    }

    setBusy("paste");
    setError("");
    try {
      const payloadFiles = await Promise.all(files.map(async (file, index) => ({
        name: pastedFileName(file, index),
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        dataBase64: await readFileAsBase64(file)
      })));
      setSnapshot(await window.electronAPI.enterpriseChat.sendPastedFiles({
        conversationId,
        clientMessageId: newClientMessageId(),
        files: payloadFiles
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function sendScreenshot() {
    const conversationId = snapshot?.activeConversationId ?? "";
    if (!conversationId || busy) {
      return;
    }
    setBusy("screenshot");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.sendScreenshot({
        conversationId,
        clientMessageId: newClientMessageId()
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function sendDesktopAction(event: FormEvent) {
    event.preventDefault();
    const conversationId = snapshot?.activeConversationId ?? "";
    if (!conversationId || !actionName.trim() || busy) {
      return;
    }
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(actionArgs || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(t("enterpriseChat.desktopActionArgsObject"));
      }
      args = parsed as Record<string, unknown>;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setBusy("action");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.sendDesktopAction({
        conversationId,
        clientMessageId: newClientMessageId(),
        action: actionName.trim(),
        args,
        summary: actionSummary.trim()
      }));
      setActionName("");
      setActionArgs("{}");
      setActionSummary("");
      setView("conversation");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function downloadAttachment(attachment: EnterpriseChatAttachment) {
    setBusy(`download:${attachment.id}`);
    setError("");
    try {
      const result = await window.electronAPI.enterpriseChat.downloadAttachment({
        fileId: attachment.id,
        name: attachment.name,
        contentType: attachment.contentType
      });
      setActionResults((current) => ({
        ...current,
        [attachment.id]: result.ok
          ? t("enterpriseChat.downloaded")
          : result.message
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function executeDesktopAction(message: EnterpriseChatMessage) {
    setBusy(`action:${message.id}`);
    setError("");
    try {
      const result = await window.electronAPI.enterpriseChat.executeDesktopAction({
        messageId: message.id
      });
      setActionResults((current) => ({ ...current, [message.id]: result.message }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const files = itemFiles.length > 0
      ? itemFiles
      : Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    void sendPastedFiles(files);
  }

  function handleLauncherPointerDown(event: PointerEvent<HTMLButtonElement>) {
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: launcherPosition.x,
      originY: launcherPosition.y,
      moved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleLauncherPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) >= 4) {
      drag.moved = true;
    }
    if (drag.moved) {
      setLauncherPosition(clampLauncherPosition({
        x: drag.originX + deltaX,
        y: drag.originY + deltaY
      }, viewport));
    }
  }

  function handleLauncherPointerEnd(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    suppressLauncherClickRef.current = drag.moved;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  if (!visible || !snapshot) {
    return null;
  }

  const connectionLabel = snapshot.connectionState === "connected"
    ? t("enterpriseChat.connected")
    : snapshot.connectionState === "connecting" || snapshot.connectionState === "reconnecting"
      ? t("enterpriseChat.connecting")
      : t("enterpriseChat.unavailable");

  function renderConversationHeader() {
    const title = activeConversation ? conversationTitle(activeConversation) : t("enterpriseChat.title");
    const subtitle = activeConversation?.type === "group"
      ? t("enterpriseChat.groupMemberCount", { count: activeConversation.members.length })
      : activePeer
        ? presenceLabel(activePeer)
        : connectionLabel;
    return (
      <>
        <button
          type="button"
          className="enterprise-chat-icon-button"
          aria-label={t("enterpriseChat.back")}
          onClick={() => {
            setView("chats");
            setError("");
          }}
        >
          <ArrowLeftOutlined />
        </button>
        <div className="enterprise-chat-header-copy">
          <strong>{title}</strong>
          <span>
            <i className={`enterprise-chat-connection-dot ${
              activePeer ? presenceClass(activePeer) : `is-${snapshot?.connectionState ?? "error"}`
            }`} />
            {subtitle}
          </span>
        </div>
        {activeConversation?.type === "direct" ? (
          <button
            type="button"
            className="enterprise-chat-icon-button"
            aria-label={t("enterpriseChat.desktopAction")}
            onClick={() => {
              setError("");
              setView("new-action");
            }}
          >
            <ThunderboltOutlined />
          </button>
        ) : null}
      </>
    );
  }

  function renderAttachment(attachment: EnterpriseChatAttachment) {
    const imageData = attachmentData[attachment.id];
    return (
      <div className="enterprise-chat-attachment" key={attachment.id}>
        {isImageAttachment(attachment) && imageData?.startsWith("data:") ? (
          <img
            className="enterprise-chat-image"
            src={imageData}
            alt={attachment.name}
          />
        ) : (
          <span className="enterprise-chat-file-icon" aria-hidden="true">
            {isImageAttachment(attachment) ? <CameraOutlined /> : <FileOutlined />}
          </span>
        )}
        <span className="enterprise-chat-file-copy">
          <strong>{attachment.name}</strong>
          <small>
            {formatFileSize(attachment.sizeBytes)}
            {imageData === "loading" ? ` · ${t("enterpriseChat.loadingImage")}` : ""}
          </small>
        </span>
        <button
          type="button"
          className="enterprise-chat-attachment-download"
          aria-label={t("enterpriseChat.download")}
          disabled={busy === `download:${attachment.id}`}
          onClick={() => void downloadAttachment(attachment)}
        >
          {actionResults[attachment.id] ? <CheckOutlined /> : <DownloadOutlined />}
        </button>
      </div>
    );
  }

  return (
    <aside
      className="enterprise-chat-floating"
      style={floatingStyle}
      aria-label={t("enterpriseChat.title")}
    >
      {open ? (
        <section
          className="enterprise-chat-panel"
          style={panelStyle}
          role="dialog"
          aria-label={t("enterpriseChat.title")}
        >
          <header className="enterprise-chat-header">
            {view === "conversation" || view === "new-action" ? (
              renderConversationHeader()
            ) : view === "new-group" ? (
              <>
                <button
                  type="button"
                  className="enterprise-chat-icon-button"
                  aria-label={t("enterpriseChat.back")}
                  onClick={() => setView("chats")}
                >
                  <ArrowLeftOutlined />
                </button>
                <div className="enterprise-chat-header-copy">
                  <strong>{t("enterpriseChat.newGroup")}</strong>
                  <span>{t("enterpriseChat.selectGroupMembers")}</span>
                </div>
              </>
            ) : (
              <>
                <span className="enterprise-chat-header-icon" aria-hidden="true">
                  {view === "contacts" ? <UserOutlined /> : <MessageOutlined />}
                </span>
                <div className="enterprise-chat-header-copy">
                  <strong>{view === "contacts" ? t("enterpriseChat.contacts") : t("enterpriseChat.title")}</strong>
                  <span>
                    <i className={`enterprise-chat-connection-dot is-${snapshot.connectionState}`} />
                    {connectionLabel}
                  </span>
                </div>
                {view === "chats" ? (
                  <button
                    type="button"
                    className="enterprise-chat-icon-button"
                    aria-label={t("enterpriseChat.newGroup")}
                    onClick={() => {
                      setError("");
                      setView("new-group");
                    }}
                  >
                    <PlusOutlined />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="enterprise-chat-icon-button"
                  aria-label={t("enterpriseChat.refresh")}
                  disabled={busy === "refresh"}
                  onClick={() => void refresh()}
                >
                  <ReloadOutlined spin={busy === "refresh"} />
                </button>
              </>
            )}
            <button
              type="button"
              className="enterprise-chat-icon-button"
              aria-label={t("enterpriseChat.close")}
              onClick={() => setOpen(false)}
            >
              <CloseOutlined />
            </button>
          </header>

          {error ? <div className="enterprise-chat-error" role="alert">{error}</div> : null}

          {view === "conversation" ? (
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
                  const sender = activeConversation?.members.find(
                    (member) => member.user.id === message.senderId
                  )?.user;
                  return (
                    <div
                      className={mine ? "enterprise-chat-message is-mine" : "enterprise-chat-message"}
                      key={message.id}
                    >
                      {!mine && activeConversation?.type === "group" ? (
                        <span className="enterprise-chat-message-sender">
                          {sender?.displayName || message.senderId}
                        </span>
                      ) : null}
                      {message.kind === "desktop_action" && message.desktopAction ? (
                        <div className="enterprise-chat-action-card">
                          <span className="enterprise-chat-action-icon"><ThunderboltOutlined /></span>
                          <strong>{message.desktopAction.summary}</strong>
                          <code>{message.desktopAction.action}</code>
                          {!mine ? (
                            <button
                              type="button"
                              disabled={busy === `action:${message.id}`}
                              onClick={() => void executeDesktopAction(message)}
                            >
                              {t("enterpriseChat.reviewAndExecute")}
                            </button>
                          ) : (
                            <small>{t("enterpriseChat.desktopActionSent")}</small>
                          )}
                          {actionResults[message.id] ? (
                            <small>{actionResults[message.id]}</small>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          {message.revokedAt ? (
                            <div className="enterprise-chat-message-bubble">
                              <em>{t("enterpriseChat.revoked")}</em>
                            </div>
                          ) : message.body ? (
                            <div className="enterprise-chat-message-bubble">{message.body}</div>
                          ) : null}
                          {message.attachments.length > 0 ? (
                            <div className="enterprise-chat-attachments">
                              {message.attachments.map(renderAttachment)}
                            </div>
                          ) : null}
                        </>
                      )}
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
                <div className="enterprise-chat-composer-tools">
                  <button
                    type="button"
                    title={t("enterpriseChat.sendFiles")}
                    aria-label={t("enterpriseChat.sendFiles")}
                    disabled={Boolean(busy)}
                    onClick={() => void sendFiles()}
                  >
                    <PaperClipOutlined />
                  </button>
                  <button
                    type="button"
                    title={t("enterpriseChat.sendScreenshot")}
                    aria-label={t("enterpriseChat.sendScreenshot")}
                    disabled={Boolean(busy)}
                    onClick={() => void sendScreenshot()}
                  >
                    <CameraOutlined />
                  </button>
                  <span className="enterprise-chat-paste-hint" aria-live="polite">
                    {busy === "paste"
                      ? t("enterpriseChat.uploadingPastedFiles")
                      : t("enterpriseChat.pasteFilesHint")}
                  </span>
                </div>
                <div className="enterprise-chat-composer-row">
                  <textarea
                    value={draft}
                    rows={2}
                    maxLength={20_000}
                    placeholder={t("enterpriseChat.messagePlaceholder")}
                    aria-label={t("enterpriseChat.messagePlaceholder")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    onPaste={handleComposerPaste}
                  />
                  <button
                    type="submit"
                    className="enterprise-chat-send-button"
                    aria-label={t("enterpriseChat.send")}
                    disabled={!draft.trim() || Boolean(busy) || snapshot.connectionState !== "connected"}
                  >
                    <SendOutlined />
                  </button>
                </div>
              </form>
            </>
          ) : view === "new-action" ? (
            <form className="enterprise-chat-form" onSubmit={(event) => void sendDesktopAction(event)}>
              <label>
                <span>{t("enterpriseChat.desktopActionName")}</span>
                <input
                  value={actionName}
                  placeholder={t("enterpriseChat.desktopActionNamePlaceholder")}
                  onChange={(event) => setActionName(event.target.value)}
                />
              </label>
              <label>
                <span>{t("enterpriseChat.desktopActionSummary")}</span>
                <input
                  value={actionSummary}
                  placeholder={t("enterpriseChat.desktopActionSummaryPlaceholder")}
                  onChange={(event) => setActionSummary(event.target.value)}
                />
              </label>
              <label>
                <span>{t("enterpriseChat.desktopActionArgs")}</span>
                <textarea
                  rows={9}
                  value={actionArgs}
                  spellCheck={false}
                  onChange={(event) => setActionArgs(event.target.value)}
                />
              </label>
              <p>{t("enterpriseChat.desktopActionSafety")}</p>
              <button type="submit" disabled={!actionName.trim() || Boolean(busy)}>
                <ThunderboltOutlined />
                {t("enterpriseChat.sendDesktopAction")}
              </button>
            </form>
          ) : view === "new-group" ? (
            <form className="enterprise-chat-form enterprise-chat-group-form" onSubmit={(event) => void createGroup(event)}>
              <label>
                <span>{t("enterpriseChat.groupName")}</span>
                <input
                  value={groupTitle}
                  maxLength={120}
                  onChange={(event) => setGroupTitle(event.target.value)}
                />
              </label>
              <div className="enterprise-chat-member-picker">
                {users.map((user) => {
                  const selected = groupMemberIds.includes(user.id);
                  return (
                    <button
                      type="button"
                      className={selected ? "is-selected" : ""}
                      key={user.id}
                      onClick={() => setGroupMemberIds((current) =>
                        selected
                          ? current.filter((id) => id !== user.id)
                          : [...current, user.id]
                      )}
                    >
                      <EnterpriseChatAvatar user={user} />
                      <span>
                        <strong>{user.displayName}</strong>
                        <small>{user.email || presenceLabel(user)}</small>
                      </span>
                      {selected ? <CheckOutlined /> : null}
                    </button>
                  );
                })}
              </div>
              <button
                type="submit"
                disabled={!groupTitle.trim() || groupMemberIds.length === 0 || Boolean(busy)}
              >
                <TeamOutlined />
                {t("enterpriseChat.createGroup", { count: groupMemberIds.length })}
              </button>
            </form>
          ) : view === "contacts" ? (
            <div className="enterprise-chat-directory">
              {users.length === 0 ? (
                <div className="enterprise-chat-empty">
                  <UserOutlined />
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
                        disabled={busy === `user:${user.id}`}
                        onClick={() => void openDirectConversation(user)}
                      >
                        <span className="enterprise-chat-avatar-wrap">
                          <EnterpriseChatAvatar user={user} />
                          <i className={presenceClass(user)} />
                        </span>
                        <span className="enterprise-chat-user-copy">
                          <strong>{user.displayName}</strong>
                          <small>
                            {conversation
                              ? conversationPreview(conversation)
                              : user.email || presenceLabel(user)}
                          </small>
                        </span>
                        <span className={`enterprise-chat-presence ${presenceClass(user)}`}>
                          {presenceLabel(user)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="enterprise-chat-conversation-list">
              {conversations.length === 0 ? (
                <div className="enterprise-chat-empty">
                  <MessageOutlined />
                  <strong>{t("enterpriseChat.noConversations")}</strong>
                  <span>{t("enterpriseChat.noConversationsDescription")}</span>
                </div>
              ) : conversations.map((conversation) => {
                const peer = conversation.type === "direct"
                  ? directPeer(conversation, snapshot.currentUser?.id ?? "")
                  : null;
                return (
                  <button
                    type="button"
                    className="enterprise-chat-conversation"
                    key={conversation.id}
                    disabled={busy === `conversation:${conversation.id}`}
                    onClick={() => void openConversation(conversation.id)}
                  >
                    <span className="enterprise-chat-avatar-wrap">
                      {peer ? (
                        <EnterpriseChatAvatar user={peer} />
                      ) : (
                        <span className="enterprise-chat-avatar enterprise-chat-group-avatar">
                          <TeamOutlined />
                        </span>
                      )}
                      {peer ? <i className={presenceClass(peer)} /> : null}
                    </span>
                    <span className="enterprise-chat-user-copy">
                      <strong>{conversationTitle(conversation)}</strong>
                      <small>{conversationPreview(conversation)}</small>
                    </span>
                    <span className="enterprise-chat-conversation-meta">
                      <time>
                        {new Intl.DateTimeFormat(locale, {
                          hour: "2-digit",
                          minute: "2-digit"
                        }).format(conversation.updatedAt)}
                      </time>
                      {conversation.unreadCount > 0 ? (
                        <b>{Math.min(99, conversation.unreadCount)}</b>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {view === "chats" || view === "contacts" ? (
            <nav className="enterprise-chat-tabs" aria-label={t("enterpriseChat.navigation")}>
              <button
                type="button"
                className={view === "chats" ? "is-active" : ""}
                onClick={() => setView("chats")}
              >
                <MessageOutlined />
                <span>{t("enterpriseChat.chats")}</span>
                {unreadCount > 0 ? <b>{Math.min(99, unreadCount)}</b> : null}
              </button>
              <button
                type="button"
                className={view === "contacts" ? "is-active" : ""}
                onClick={() => setView("contacts")}
              >
                <UserOutlined />
                <span>{t("enterpriseChat.contacts")}</span>
              </button>
            </nav>
          ) : null}
        </section>
      ) : null}
      <button
        type="button"
        className={open ? "enterprise-chat-launcher is-open" : "enterprise-chat-launcher"}
        aria-label={open ? t("enterpriseChat.close") : t("enterpriseChat.open")}
        title={open ? t("enterpriseChat.close") : t("enterpriseChat.open")}
        onPointerDown={handleLauncherPointerDown}
        onPointerMove={handleLauncherPointerMove}
        onPointerUp={handleLauncherPointerEnd}
        onPointerCancel={handleLauncherPointerEnd}
        onClick={() => {
          if (suppressLauncherClickRef.current) {
            suppressLauncherClickRef.current = false;
            return;
          }
          setOpen((current) => !current);
        }}
      >
        {open ? <CloseOutlined /> : <MessageOutlined />}
        {!open && unreadCount > 0 ? (
          <span className="enterprise-chat-launcher-badge">{Math.min(99, unreadCount)}</span>
        ) : null}
      </button>
    </aside>
  );
}
