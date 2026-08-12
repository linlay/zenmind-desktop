import {
  ArrowLeftOutlined,
  CameraOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DesktopOutlined,
  DownloadOutlined,
  FileOutlined,
  FileZipOutlined,
  FolderOpenOutlined,
  LaptopOutlined,
  MessageOutlined,
  MoreOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  ScissorOutlined,
  SendOutlined,
  SettingOutlined,
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
import { createPortal } from "react-dom";
import {
  ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES,
  ENTERPRISE_CHAT_MAX_PASTED_FILES
} from "../../shared/contracts";
import type {
  DesktopSsoStatus,
  EnterpriseChatAttachment,
  EnterpriseChatConversation,
  EnterpriseChatMessage,
  EnterpriseChatScreenshotMode,
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../../shared/contracts";
import { Popover } from "../components/Popover";
import { useI18n } from "../i18n/useI18n";

type EnterpriseChatFloatingPanelProps = {
  desktopSsoStatus: DesktopSsoStatus | null;
};

type PanelView = "chats" | "contacts" | "settings" | "new-group" | "conversation";
type LauncherPosition = { x: number; y: number };
type HiddenConversationPreference = {
  scope: string;
  conversationId: string;
  lastSeq: number;
};

const CHAT_LAUNCHER_POSITION_KEY = "zenmind.enterpriseChat.launcherPosition.v1";
const CHAT_HIDDEN_CONVERSATIONS_KEY = "zenmind.enterpriseChat.hiddenConversations.v1";
const CHAT_LAUNCHER_SIZE = 54 * 0.7;
const CHAT_LAUNCHER_MARGIN = 12;
const CHAT_PANEL_WIDTH = 400;
const CHAT_PANEL_HEIGHT = 500;
const ENTERPRISE_CHAT_COMPOSER_MIN_HEIGHT = 72;
const ENTERPRISE_CHAT_COMPOSER_MAX_HEIGHT = 220;
const ENTERPRISE_CHAT_COMPOSER_DEFAULT_HEIGHT = 96;

function hasEnterpriseLoginSession(status: DesktopSsoStatus | null) {
  return Boolean(
    status?.authenticated &&
    status.completedSteps.session
  );
}

function initials(user: EnterpriseChatUser) {
  const source = (user.displayName || user.email || user.id || "?").trim();
  return source.slice(0, 2).toUpperCase();
}

function EnterpriseChatAvatar({
  user,
  customAvatarDataUrl = ""
}: {
  user: EnterpriseChatUser;
  customAvatarDataUrl?: string;
}) {
  const [failed, setFailed] = useState(false);
  const avatarUrl = customAvatarDataUrl || user.avatarUrl;
  useEffect(() => setFailed(false), [avatarUrl]);
  if (avatarUrl && !failed) {
    return (
      <img
        className={`enterprise-chat-avatar ${user.kind === "service_bot" ? "is-bot" : "is-person"}`}
        src={avatarUrl}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className={`enterprise-chat-avatar enterprise-chat-avatar-fallback ${
        user.kind === "service_bot" ? "is-bot" : "is-person"
      }`}
      aria-hidden="true"
    >
      {user.kind === "service_bot" ? <RobotOutlined /> : initials(user)}
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

function readHiddenConversationPreferences() {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(CHAT_HIDDEN_CONVERSATIONS_KEY) || "[]"
    ) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((value): HiddenConversationPreference[] => {
      if (!value || typeof value !== "object") {
        return [];
      }
      const record = value as Record<string, unknown>;
      if (
        typeof record.scope !== "string" || !record.scope ||
        typeof record.conversationId !== "string" || !record.conversationId ||
        typeof record.lastSeq !== "number" || !Number.isFinite(record.lastSeq)
      ) {
        return [];
      }
      return [{
        scope: record.scope,
        conversationId: record.conversationId,
        lastSeq: Math.max(0, Math.trunc(record.lastSeq))
      }];
    });
  } catch {
    return [];
  }
}

function conversationPreferenceScope(snapshot: EnterpriseChatSnapshot | null) {
  const serverUrl = snapshot?.serverUrl.trim() ?? "";
  const userId = snapshot?.currentUser?.id.trim() ?? "";
  return serverUrl && userId ? JSON.stringify([serverUrl, userId]) : "";
}

function normalizeSearchValue(value: string, locale: string) {
  return value.trim().toLocaleLowerCase(locale);
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

function desktopActionArgsPreview(args: Record<string, unknown>) {
  return JSON.stringify(args, (key, value) =>
    /token|secret|password|authorization|cookie/iu.test(key) ? "[redacted]" : value
  , 2).slice(0, 2_000);
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
  const [actionResults, setActionResults] = useState<Record<string, string>>({});
  const [downloadedAttachmentIds, setDownloadedAttachmentIds] = useState<Record<string, true>>({});
  const [handledActionMessageIds, setHandledActionMessageIds] = useState<Record<string, true>>({});
  const [pendingActionMessage, setPendingActionMessage] = useState<EnterpriseChatMessage | null>(null);
  const [attachmentData, setAttachmentData] = useState<Record<string, string>>({});
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [openConversationMenuId, setOpenConversationMenuId] = useState("");
  const [screenshotMenuOpen, setScreenshotMenuOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [mottoDraft, setMottoDraft] = useState("");
  const [composerHeight, setComposerHeight] = useState(ENTERPRISE_CHAT_COMPOSER_DEFAULT_HEIGHT);
  const [hiddenConversationPreferences, setHiddenConversationPreferences] = useState(
    readHiddenConversationPreferences
  );
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
  const composerResizeRef = useRef<{
    pointerId: number;
    startY: number;
    originHeight: number;
  } | null>(null);
  const searchPreferenceScopeRef = useRef("");
  const reviewedActionMessageIdsRef = useRef(new Set<string>());
  const attachmentDownloadResetTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const signedIn = hasEnterpriseLoginSession(desktopSsoStatus);
  const preferenceScope = conversationPreferenceScope(snapshot);

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
    try {
      window.localStorage.setItem(
        CHAT_HIDDEN_CONVERSATIONS_KEY,
        JSON.stringify(hiddenConversationPreferences)
      );
    } catch {
      // A failed renderer-only preference write must not break enterprise chat.
    }
  }, [hiddenConversationPreferences]);

  useEffect(() => {
    if (searchPreferenceScopeRef.current !== preferenceScope) {
      searchPreferenceScopeRef.current = preferenceScope;
      setChatSearch("");
      setContactSearch("");
      setOpenConversationMenuId("");
      setPendingActionMessage(null);
      setHandledActionMessageIds({});
      reviewedActionMessageIdsRef.current.clear();
    }
  }, [preferenceScope]);

  useEffect(() => {
    if (!open || view !== "conversation") {
      setScreenshotMenuOpen(false);
      setAttachmentMenuOpen(false);
    }
  }, [open, view]);

  useEffect(() => () => {
    for (const timer of attachmentDownloadResetTimersRef.current.values()) {
      clearTimeout(timer);
    }
    attachmentDownloadResetTimersRef.current.clear();
  }, []);

  useEffect(() => {
    if (!preferenceScope || !snapshot) {
      return;
    }
    const lastSeqByConversationId = new Map(
      snapshot.conversations.map((conversation) => [conversation.id, conversation.lastSeq] as const)
    );
    setHiddenConversationPreferences((current) => {
      const next = current.filter((preference) => {
        if (preference.scope !== preferenceScope) {
          return true;
        }
        const lastSeq = lastSeqByConversationId.get(preference.conversationId);
        return lastSeq === undefined || lastSeq <= preference.lastSeq;
      });
      return next.length === current.length ? current : next;
    });
  }, [preferenceScope, snapshot]);

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
  const hiddenSeqByConversationId = useMemo(() => new Map(
    hiddenConversationPreferences
      .filter((preference) => preference.scope === preferenceScope)
      .map((preference) => [preference.conversationId, preference.lastSeq] as const)
  ), [hiddenConversationPreferences, preferenceScope]);
  const visibleConversations = useMemo(
    () => conversations.filter((conversation) => {
      const hiddenAtSeq = hiddenSeqByConversationId.get(conversation.id);
      return hiddenAtSeq === undefined || conversation.lastSeq > hiddenAtSeq;
    }),
    [conversations, hiddenSeqByConversationId]
  );
  const activeConversation = snapshot?.conversations.find(
    (conversation) => conversation.id === snapshot.activeConversationId
  );

  useEffect(() => {
    if (
      !open ||
      view !== "conversation" ||
      activeConversation?.type !== "direct"
    ) {
      if (pendingActionMessage) {
        setPendingActionMessage(null);
      }
      return;
    }
    const projectedPendingAction = pendingActionMessage
      ? snapshot?.activeMessages.find((message) => message.id === pendingActionMessage.id)
      : undefined;
    if (
      pendingActionMessage &&
      (
        pendingActionMessage.conversationId !== activeConversation.id ||
        projectedPendingAction?.desktopActionState !== "pending"
      )
    ) {
      setPendingActionMessage(null);
      return;
    }
    if (pendingActionMessage) {
      return;
    }
    const nextAction = [...(snapshot?.activeMessages ?? [])]
      .reverse()
      .find((message) =>
        message.kind === "desktop_action_request" &&
        Boolean(message.desktopAction) &&
        message.desktopActionState === "pending" &&
        !message.revokedAt &&
        message.senderId !== snapshot?.currentUser?.id &&
        !handledActionMessageIds[message.id] &&
        !reviewedActionMessageIdsRef.current.has(message.id)
      );
    if (!nextAction) {
      return;
    }
    reviewedActionMessageIdsRef.current.add(nextAction.id);
    setError("");
    setPendingActionMessage(nextAction);
  }, [
    activeConversation?.id,
    activeConversation?.type,
    handledActionMessageIds,
    open,
    pendingActionMessage,
    snapshot?.activeMessages,
    snapshot?.currentUser?.id,
    view
  ]);

  useEffect(() => {
    if (!pendingActionMessage) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDesktopAction();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, pendingActionMessage, t]);

  useEffect(() => {
    if (!previewImage) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPreviewImage(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewImage]);

  const activePeer = directPeer(activeConversation, snapshot?.currentUser?.id ?? "");
  const selfUser = snapshot?.currentUser
    ? {
        ...snapshot.currentUser,
        avatarUrl: snapshot.selfProfile.avatarDataUrl || snapshot.currentUser.avatarUrl
      }
    : null;
  const pendingActionSender = activeConversation?.members.find(
    (member) => member.user.id === pendingActionMessage?.senderId
  )?.user;
  const visible = signedIn && snapshot?.enabled === true;

  const panelWidth = Math.min(CHAT_PANEL_WIDTH, viewport.width - 24);
  const panelHeight = Math.min(CHAT_PANEL_HEIGHT, viewport.height - 82);
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
    if (message.kind === "desktop_action_request") {
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

  const normalizedChatSearch = normalizeSearchValue(chatSearch, locale);
  const normalizedContactSearch = normalizeSearchValue(contactSearch, locale);
  const filteredUsers = users.filter((user) => {
    if (!normalizedContactSearch) {
      return true;
    }
    return [user.displayName, user.email].some((value) =>
      normalizeSearchValue(value, locale).includes(normalizedContactSearch)
    );
  });
  const employeeContacts = filteredUsers.filter((user) => user.kind !== "service_bot");
  const botContacts = filteredUsers.filter((user) => user.kind === "service_bot");
  const groupContacts = conversations.filter((conversation) => {
    if (conversation.type !== "group") {
      return false;
    }
    if (!normalizedContactSearch) {
      return true;
    }
    return [
      conversationTitle(conversation),
      ...conversation.members.flatMap((member) => [member.user.displayName, member.user.email])
    ].some((value) => normalizeSearchValue(value, locale).includes(normalizedContactSearch));
  });
  const contactCount = users.length + conversations.filter(
    (conversation) => conversation.type === "group"
  ).length;
  const filteredConversations = visibleConversations.filter((conversation) => {
    if (!normalizedChatSearch) {
      return true;
    }
    const peer = conversation.type === "direct"
      ? directPeer(conversation, snapshot?.currentUser?.id ?? "")
      : null;
    return [
      conversationTitle(conversation),
      peer?.email ?? "",
      conversationPreview(conversation)
    ].some((value) => normalizeSearchValue(value, locale).includes(normalizedChatSearch));
  });
  const unreadCount = visibleConversations.reduce(
    (total, conversation) => total + conversation.unreadCount,
    0
  );

  function restoreHiddenConversation(conversationId: string, scope = preferenceScope) {
    if (!conversationId || !scope) {
      return;
    }
    setHiddenConversationPreferences((current) => current.filter((preference) =>
      preference.scope !== scope || preference.conversationId !== conversationId
    ));
  }

  function hideConversation(conversation: EnterpriseChatConversation) {
    setOpenConversationMenuId("");
    if (!preferenceScope || !window.confirm(t("enterpriseChat.deleteConversationConfirm", {
      name: conversationTitle(conversation)
    }))) {
      return;
    }
    setHiddenConversationPreferences((current) => [
      ...current.filter((preference) =>
        preference.scope !== preferenceScope || preference.conversationId !== conversation.id
      ),
      {
        scope: preferenceScope,
        conversationId: conversation.id,
        lastSeq: conversation.lastSeq
      }
    ]);
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
      restoreHiddenConversation(
        next.activeConversationId,
        conversationPreferenceScope(next)
      );
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

  async function sendSupportBundle() {
    const conversationId = snapshot?.activeConversationId ?? "";
    if (!conversationId || busy) {
      return;
    }
    setAttachmentMenuOpen(false);
    if (!window.confirm(t("enterpriseChat.supportBundleConfirm"))) {
      return;
    }
    setBusy("support-bundle");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.sendSupportBundle({
        conversationId,
        clientMessageId: newClientMessageId()
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function saveSelfProfile(event: FormEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy("profile");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.saveSelfProfile({
        motto: mottoDraft
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function selectSelfAvatar() {
    if (busy) {
      return;
    }
    setBusy("profile-avatar");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.selectSelfAvatar());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function clearSelfAvatar() {
    if (busy) {
      return;
    }
    setBusy("profile-avatar");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.clearSelfAvatar());
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

  async function sendScreenshot(mode: EnterpriseChatScreenshotMode) {
    const conversationId = snapshot?.activeConversationId ?? "";
    if (!conversationId || busy) {
      return;
    }
    setScreenshotMenuOpen(false);
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    setBusy("screenshot");
    setError("");
    try {
      setSnapshot(await window.electronAPI.enterpriseChat.sendScreenshot({
        conversationId,
        clientMessageId: newClientMessageId(),
        mode
      }));
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
      if (result.ok) {
        setDownloadedAttachmentIds((current) => ({ ...current, [attachment.id]: true }));
        const existingTimer = attachmentDownloadResetTimersRef.current.get(attachment.id);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
          setDownloadedAttachmentIds((current) => {
            if (!current[attachment.id]) {
              return current;
            }
            const next = { ...current };
            delete next[attachment.id];
            return next;
          });
          attachmentDownloadResetTimersRef.current.delete(attachment.id);
        }, 3000);
        attachmentDownloadResetTimersRef.current.set(attachment.id, timer);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  function openDesktopActionConfirmation(message: EnterpriseChatMessage) {
    if (
      busy ||
      !message.desktopAction ||
      message.desktopActionState !== "pending" ||
      message.senderId === snapshot?.currentUser?.id
    ) {
      return;
    }
    reviewedActionMessageIdsRef.current.add(message.id);
    setError("");
    setPendingActionMessage(message);
  }

  async function cancelDesktopAction() {
    const messageId = pendingActionMessage?.id;
    if (!messageId || busy) {
      return;
    }
    setPendingActionMessage(null);
    setBusy(`action:${messageId}`);
    try {
      const result = await window.electronAPI.enterpriseChat.executeDesktopAction({
        messageId,
        decision: "decline"
      });
      setActionResults((current) => ({ ...current, [messageId]: result.message }));
      if (result.disposition !== "not_executable") {
        setHandledActionMessageIds((current) => ({ ...current, [messageId]: true }));
      }
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function confirmDesktopAction() {
    const message = pendingActionMessage;
    if (!message?.desktopAction || busy) {
      return;
    }
    setBusy(`action:${message.id}`);
    setError("");
    try {
      const result = await window.electronAPI.enterpriseChat.executeDesktopAction({
        messageId: message.id,
        decision: "confirm"
      });
      setActionResults((current) => ({ ...current, [message.id]: result.message }));
      if (result.confirmed) {
        setHandledActionMessageIds((current) => ({ ...current, [message.id]: true }));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPendingActionMessage(null);
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

  function handleComposerResizePointerDown(event: PointerEvent<HTMLDivElement>) {
    composerResizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      originHeight: composerHeight
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleComposerResizePointerMove(event: PointerEvent<HTMLDivElement>) {
    const resize = composerResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    const deltaY = resize.startY - event.clientY;
    setComposerHeight(Math.max(
      ENTERPRISE_CHAT_COMPOSER_MIN_HEIGHT,
      Math.min(ENTERPRISE_CHAT_COMPOSER_MAX_HEIGHT, resize.originHeight + deltaY)
    ));
  }

  function handleComposerResizePointerEnd(event: PointerEvent<HTMLDivElement>) {
    const resize = composerResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    composerResizeRef.current = null;
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
      </>
    );
  }

  function renderAttachment(attachment: EnterpriseChatAttachment) {
    const imageData = attachmentData[attachment.id];
    return (
      <div className="enterprise-chat-attachment" key={attachment.id}>
        {isImageAttachment(attachment) && imageData?.startsWith("data:") ? (
          <button
            type="button"
            className="enterprise-chat-image-preview-trigger"
            aria-label={t("enterpriseChat.previewImage", { name: attachment.name })}
            onClick={() => setPreviewImage({ src: imageData, name: attachment.name })}
          >
            <img
              className="enterprise-chat-image"
              src={imageData}
              alt={attachment.name}
            />
          </button>
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
          {downloadedAttachmentIds[attachment.id] ? <CheckOutlined /> : <DownloadOutlined />}
        </button>
      </div>
    );
  }

  function renderUserContact(user: EnterpriseChatUser) {
    const conversation = conversationForUser(snapshot?.conversations ?? [], user.id);
    const isBot = user.kind === "service_bot";
    return (
      <button
        type="button"
        className={`enterprise-chat-user ${isBot ? "is-bot" : "is-person"}`}
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
        <span className={`enterprise-chat-contact-kind ${isBot ? "is-bot" : "is-person"}`}>
          {isBot ? <RobotOutlined /> : <UserOutlined />}
          <span>{isBot ? t("enterpriseChat.robot") : t("enterpriseChat.person")}</span>
        </span>
      </button>
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
            {view === "conversation" ? (
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
                  {view === "contacts"
                    ? <UserOutlined />
                    : view === "settings"
                      ? <SettingOutlined />
                      : <MessageOutlined />}
                </span>
                <div className="enterprise-chat-header-copy">
                  <strong>
                    {view === "contacts"
                      ? t("enterpriseChat.contacts")
                      : view === "settings"
                        ? t("enterpriseChat.settings")
                        : t("enterpriseChat.title")}
                  </strong>
                  <span>
                    {view === "settings" ? (
                      t("enterpriseChat.profileLocalHint")
                    ) : (
                      <>
                        <i className={`enterprise-chat-connection-dot is-${snapshot.connectionState}`} />
                        {connectionLabel}
                      </>
                    )}
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
                {view !== "settings" ? (
                  <button
                    type="button"
                    className="enterprise-chat-icon-button"
                    aria-label={t("enterpriseChat.refresh")}
                    disabled={busy === "refresh"}
                    onClick={() => void refresh()}
                  >
                    <ReloadOutlined spin={busy === "refresh"} />
                  </button>
                ) : null}
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

          {view === "chats" || view === "contacts" ? (
            <div className="enterprise-chat-search" role="search">
              <SearchOutlined aria-hidden="true" />
              <input
                type="search"
                autoComplete="off"
                value={view === "chats" ? chatSearch : contactSearch}
                placeholder={view === "chats"
                  ? t("enterpriseChat.searchChatsPlaceholder")
                  : t("enterpriseChat.searchContactsPlaceholder")}
                aria-label={view === "chats"
                  ? t("enterpriseChat.searchChats")
                  : t("enterpriseChat.searchContacts")}
                onChange={(event) => {
                  if (view === "chats") {
                    setChatSearch(event.target.value);
                  } else {
                    setContactSearch(event.target.value);
                  }
                }}
              />
              {(view === "chats" ? chatSearch : contactSearch) ? (
                <button
                  type="button"
                  aria-label={t("enterpriseChat.clearSearch")}
                  title={t("enterpriseChat.clearSearch")}
                  onClick={() => {
                    if (view === "chats") {
                      setChatSearch("");
                    } else {
                      setContactSearch("");
                    }
                  }}
                >
                  <CloseOutlined />
                </button>
              ) : null}
            </div>
          ) : null}

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
                      {message.kind === "desktop_action_request" && message.desktopAction ? (
                        <div className="enterprise-chat-action-card">
                          <span className="enterprise-chat-action-icon"><ThunderboltOutlined /></span>
                          <strong>{message.desktopAction.summary}</strong>
                          <code>{message.desktopAction.action}</code>
                          {!mine && activeConversation?.type === "direct" && message.desktopActionState === "pending" && !handledActionMessageIds[message.id] ? (
                            <button
                              type="button"
                              disabled={Boolean(busy)}
                              onClick={() => openDesktopActionConfirmation(message)}
                            >
                              {t("enterpriseChat.reviewAndExecute")}
                            </button>
                          ) : null}
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
                <div
                  className="enterprise-chat-composer-resize-handle"
                  onPointerDown={handleComposerResizePointerDown}
                  onPointerMove={handleComposerResizePointerMove}
                  onPointerUp={handleComposerResizePointerEnd}
                  onPointerCancel={handleComposerResizePointerEnd}
                >
                  <span aria-hidden="true" />
                </div>
                <div className="enterprise-chat-editor" style={{ height: composerHeight }}>
                  <div className="enterprise-chat-composer-tools">
                    <Popover
                      placement="top-start"
                      open={attachmentMenuOpen}
                      onOpenChange={setAttachmentMenuOpen}
                      disabled={Boolean(busy)}
                      content={(
                        <div
                          className="enterprise-chat-attachment-menu"
                          role="menu"
                          aria-label={t("enterpriseChat.attachmentOptions")}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAttachmentMenuOpen(false);
                              void sendFiles();
                            }}
                          >
                            <FolderOpenOutlined />
                            <span>{t("enterpriseChat.sendAnyFiles")}</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void sendSupportBundle()}
                          >
                            <FileZipOutlined />
                            <span>{t("enterpriseChat.sendSupportBundle")}</span>
                          </button>
                        </div>
                      )}
                    >
                      <button
                        type="button"
                        title={t("enterpriseChat.attachmentOptions")}
                        aria-label={t("enterpriseChat.attachmentOptions")}
                        aria-haspopup="menu"
                        disabled={Boolean(busy)}
                      >
                        <PaperClipOutlined />
                      </button>
                    </Popover>
                    <Popover
                      placement="top-start"
                      open={screenshotMenuOpen}
                      onOpenChange={setScreenshotMenuOpen}
                      disabled={Boolean(busy)}
                      content={(
                        <div
                          className="enterprise-chat-screenshot-menu"
                          role="menu"
                          aria-label={t("enterpriseChat.screenshotOptions")}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void sendScreenshot("region")}
                          >
                            <ScissorOutlined />
                            <span>{t("enterpriseChat.screenshotRegion")}</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void sendScreenshot("window")}
                          >
                            <LaptopOutlined />
                            <span>{t("enterpriseChat.screenshotWindow")}</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void sendScreenshot("desktop")}
                          >
                            <DesktopOutlined />
                            <span>{t("enterpriseChat.screenshotDesktop")}</span>
                          </button>
                        </div>
                      )}
                    >
                      <button
                        type="button"
                        title={t("enterpriseChat.sendScreenshot")}
                        aria-label={t("enterpriseChat.screenshotOptions")}
                        aria-haspopup="menu"
                        disabled={Boolean(busy)}
                      >
                        <CameraOutlined />
                      </button>
                    </Popover>
                    <span className="enterprise-chat-paste-hint" aria-live="polite">
                      {busy === "paste"
                        ? t("enterpriseChat.uploadingPastedFiles")
                        : t("enterpriseChat.pasteFilesHint")}
                    </span>
                  </div>
                  <textarea
                    value={draft}
                    rows={4}
                    maxLength={20_000}
                    placeholder={t("enterpriseChat.messagePlaceholder")}
                    aria-label={t("enterpriseChat.messagePlaceholder")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    onPaste={handleComposerPaste}
                  />
                  <div className="enterprise-chat-composer-footer">
                    <button
                      type="submit"
                      className="enterprise-chat-send-button"
                      aria-label={t("enterpriseChat.send")}
                      disabled={!draft.trim() || Boolean(busy) || snapshot.connectionState !== "connected"}
                    >
                      <SendOutlined />
                    </button>
                  </div>
                </div>
              </form>
            </>
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
          ) : view === "settings" ? (
            <form
              className="enterprise-chat-form enterprise-chat-profile-form"
              onSubmit={(event) => void saveSelfProfile(event)}
            >
              {selfUser ? (
                <div className="enterprise-chat-profile-card">
                  <EnterpriseChatAvatar
                    user={selfUser}
                    customAvatarDataUrl={snapshot.selfProfile.avatarDataUrl}
                  />
                  <span>
                    <strong>{selfUser.displayName}</strong>
                    <small>{selfUser.email || selfUser.id}</small>
                  </span>
                </div>
              ) : null}
              <div className="enterprise-chat-profile-avatar-actions">
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void selectSelfAvatar()}
                >
                  <CameraOutlined />
                  <span>{t("enterpriseChat.chooseAvatar")}</span>
                </button>
                {snapshot.selfProfile.hasCustomAvatar ? (
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void clearSelfAvatar()}
                  >
                    <DeleteOutlined />
                    <span>{t("enterpriseChat.removeAvatar")}</span>
                  </button>
                ) : null}
              </div>
              <label>
                <span>{t("enterpriseChat.motto")}</span>
                <textarea
                  value={mottoDraft}
                  rows={4}
                  maxLength={160}
                  placeholder={t("enterpriseChat.mottoPlaceholder")}
                  onChange={(event) => setMottoDraft(event.target.value)}
                />
                <small className="enterprise-chat-field-count">{mottoDraft.length}/160</small>
              </label>
              <p>{t("enterpriseChat.profileLocalDescription")}</p>
              <button type="submit" disabled={Boolean(busy)}>
                <CheckOutlined />
                {busy === "profile"
                  ? t("enterpriseChat.savingProfile")
                  : t("enterpriseChat.saveProfile")}
              </button>
            </form>
          ) : view === "contacts" ? (
            <div className="enterprise-chat-directory">
              {contactCount === 0 ? (
                <div className="enterprise-chat-empty">
                  <UserOutlined />
                  <strong>{t("enterpriseChat.noContacts")}</strong>
                  <span>{t("enterpriseChat.noContactsDescription")}</span>
                </div>
              ) : employeeContacts.length === 0 && botContacts.length === 0 && groupContacts.length === 0 ? (
                <div className="enterprise-chat-empty">
                  <SearchOutlined />
                  <strong>{t("enterpriseChat.noSearchResults")}</strong>
                  <span>{t("enterpriseChat.noSearchResultsDescription")}</span>
                </div>
              ) : (
                <div className="enterprise-chat-user-list">
                  {employeeContacts.length > 0 ? (
                    <section className="enterprise-chat-contact-section">
                      <h3><UserOutlined />{t("enterpriseChat.people")}</h3>
                      {employeeContacts.map(renderUserContact)}
                    </section>
                  ) : null}
                  {groupContacts.length > 0 ? (
                    <section className="enterprise-chat-contact-section">
                      <h3><TeamOutlined />{t("enterpriseChat.groups")}</h3>
                      {groupContacts.map((conversation) => (
                      <button
                        type="button"
                        className="enterprise-chat-user is-group"
                        key={conversation.id}
                        disabled={busy === `conversation:${conversation.id}`}
                        onClick={() => void openConversation(conversation.id)}
                      >
                        <span className="enterprise-chat-avatar-wrap">
                          <span className="enterprise-chat-avatar enterprise-chat-group-avatar">
                            <TeamOutlined />
                          </span>
                        </span>
                        <span className="enterprise-chat-user-copy">
                          <strong>{conversationTitle(conversation)}</strong>
                          <small>{t("enterpriseChat.groupMemberCount", { count: conversation.members.length })}</small>
                        </span>
                        <span className="enterprise-chat-contact-kind is-group">
                          <TeamOutlined />
                          <span>{t("enterpriseChat.group")}</span>
                        </span>
                      </button>
                      ))}
                    </section>
                  ) : null}
                  {botContacts.length > 0 ? (
                    <section className="enterprise-chat-contact-section">
                      <h3><RobotOutlined />{t("enterpriseChat.robots")}</h3>
                      {botContacts.map(renderUserContact)}
                    </section>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
            <div className="enterprise-chat-conversation-list">
              {visibleConversations.length === 0 ? (
                <div className="enterprise-chat-empty">
                  <MessageOutlined />
                  <strong>{t("enterpriseChat.noConversations")}</strong>
                  <span>{t("enterpriseChat.noConversationsDescription")}</span>
                </div>
              ) : filteredConversations.length === 0 ? (
                <div className="enterprise-chat-empty">
                  <SearchOutlined />
                  <strong>{t("enterpriseChat.noSearchResults")}</strong>
                  <span>{t("enterpriseChat.noSearchResultsDescription")}</span>
                </div>
              ) : filteredConversations.map((conversation) => {
                const peer = conversation.type === "direct"
                  ? directPeer(conversation, snapshot.currentUser?.id ?? "")
                  : null;
                return (
                  <div className="enterprise-chat-conversation-row" key={conversation.id}>
                    <button
                      type="button"
                      className="enterprise-chat-conversation"
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
                    <Popover
                      placement="left-start"
                      open={openConversationMenuId === conversation.id}
                      onOpenChange={(nextOpen) => setOpenConversationMenuId(
                        nextOpen ? conversation.id : ""
                      )}
                      content={(
                        <div
                          className="enterprise-chat-conversation-menu"
                          role="menu"
                          aria-label={t("enterpriseChat.conversationActions")}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => hideConversation(conversation)}
                          >
                            <DeleteOutlined />
                            <span>{t("enterpriseChat.deleteConversation")}</span>
                          </button>
                        </div>
                      )}
                    >
                      <button
                        type="button"
                        className="enterprise-chat-conversation-more"
                        aria-label={t("enterpriseChat.conversationActionsFor", {
                          name: conversationTitle(conversation)
                        })}
                        title={t("enterpriseChat.conversationActions")}
                      >
                        <MoreOutlined />
                      </button>
                    </Popover>
                  </div>
                );
              })}
            </div>
          )}

          {view === "chats" || view === "contacts" || view === "settings" ? (
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
              <button
                type="button"
                className={view === "settings" ? "is-active" : ""}
                onClick={() => {
                  setMottoDraft(snapshot.selfProfile.motto);
                  setView("settings");
                }}
              >
                <SettingOutlined />
                <span>{t("enterpriseChat.settings")}</span>
              </button>
            </nav>
          ) : null}

          {pendingActionMessage?.desktopAction ? (
            <div className="enterprise-chat-action-confirm-backdrop">
              <div
                className="enterprise-chat-action-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="enterprise-chat-action-confirm-title"
                aria-describedby="enterprise-chat-action-confirm-hint"
              >
                <div className="enterprise-chat-action-confirm-heading">
                  <span className="enterprise-chat-action-icon" aria-hidden="true">
                    <ThunderboltOutlined />
                  </span>
                  <div>
                    <strong id="enterprise-chat-action-confirm-title">
                      {t("enterpriseChat.desktopActionConfirmTitle")}
                    </strong>
                    <span>
                      {t("enterpriseChat.desktopActionRequestedBy", {
                        name: pendingActionSender?.displayName || pendingActionMessage.senderId
                      })}
                    </span>
                  </div>
                </div>
                <p className="enterprise-chat-action-confirm-summary">
                  {pendingActionMessage.desktopAction.summary}
                </p>
                <dl>
                  <div>
                    <dt>{t("enterpriseChat.desktopActionCommand")}</dt>
                    <dd><code>{pendingActionMessage.desktopAction.action}</code></dd>
                  </div>
                  <div>
                    <dt>{t("enterpriseChat.desktopActionArguments")}</dt>
                    <dd>
                      <pre>{desktopActionArgsPreview(pendingActionMessage.desktopAction.args)}</pre>
                    </dd>
                  </div>
                </dl>
                <p id="enterprise-chat-action-confirm-hint" className="enterprise-chat-action-confirm-hint">
                  {t("enterpriseChat.desktopActionConfirmationHint")}
                </p>
                {error ? (
                  <div className="enterprise-chat-action-confirm-error" role="alert">{error}</div>
                ) : null}
                <div className="enterprise-chat-action-confirm-buttons">
                  <button
                    type="button"
                    autoFocus
                    disabled={Boolean(busy)}
                    onClick={cancelDesktopAction}
                  >
                    {t("enterpriseChat.desktopActionCancel")}
                  </button>
                  <button
                    type="button"
                    className="is-confirm"
                    disabled={Boolean(busy)}
                    onClick={() => void confirmDesktopAction()}
                  >
                    <ThunderboltOutlined />
                    {t("enterpriseChat.desktopActionConfirm")}
                  </button>
                </div>
              </div>
            </div>
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
      {previewImage ? createPortal(
        <div
          className="enterprise-chat-image-preview-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t("enterpriseChat.previewImage", { name: previewImage.name })}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPreviewImage(null);
            }
          }}
        >
          <button
            type="button"
            className="enterprise-chat-image-preview-close"
            autoFocus
            aria-label={t("enterpriseChat.close")}
            title={t("enterpriseChat.close")}
            onClick={() => setPreviewImage(null)}
          >
            <CloseOutlined />
          </button>
          <figure>
            <img src={previewImage.src} alt={previewImage.name} />
            <figcaption>{previewImage.name}</figcaption>
          </figure>
        </div>,
        document.body
      ) : null}
    </aside>
  );
}
