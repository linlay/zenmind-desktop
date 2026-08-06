import { openAsBlob } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  EnterpriseChatAttachment,
  EnterpriseChatAttachmentData,
  EnterpriseChatAttachmentInput,
  EnterpriseChatConnectionState,
  EnterpriseChatConversation,
  EnterpriseChatCreateGroupInput,
  EnterpriseChatDesktopAction,
  EnterpriseChatDesktopActionResult,
  EnterpriseChatDesktopActionStatus,
  EnterpriseChatDownloadResult,
  EnterpriseChatExecuteActionInput,
  EnterpriseChatExecuteActionResult,
  EnterpriseChatMarkReadInput,
  EnterpriseChatMessage,
  EnterpriseChatOpenConversationInput,
  EnterpriseChatOpenDirectInput,
  EnterpriseChatSaveSelfProfileInput,
  EnterpriseChatSendFilesInput,
  EnterpriseChatSendMessageInput,
  EnterpriseChatSendPastedFilesInput,
  EnterpriseChatScreenshotMode,
  EnterpriseChatSendScreenshotInput,
  EnterpriseChatSendSupportBundleInput,
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../shared/contracts";
import {
  ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES,
  ENTERPRISE_CHAT_MAX_PASTED_FILES
} from "../shared/contracts/enterprise-chat";
import {
  ENTERPRISE_CHAT_REMOTE_ACTION_NAMES,
  getEnterpriseChatRemoteAction
} from "../shared/enterprise-chat-actions";
import type { DesktopActionCallResponse } from "../shared/desktop-actions";
import type { EpochMilliseconds } from "../shared/time-contract";
import { getDesktopDeviceInfo } from "./desktop-device-info";
import {
  EnterpriseChatActionLedger,
  enterpriseChatActionScope,
  type EnterpriseChatActionLedgerEntry
} from "./enterprise-chat-action-ledger";
import {
  clearEnterpriseChatAvatar,
  readEnterpriseChatSelfProfile,
  saveEnterpriseChatAvatar,
  saveEnterpriseChatMotto
} from "./enterprise-chat-local-profile";
import { createEnterpriseChatSupportBundle } from "./enterprise-chat-support-bundle";
import {
  DEFAULT_ENTERPRISE_IM_BASE_URL,
  normalizeEnterpriseImBaseUrl
} from "./enterprise-im-settings";
import { t } from "./i18n/main-i18n";
import { getDesktopSsoAccessToken } from "./oidc-sso";

const ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS = 15_000;
const ENTERPRISE_CHAT_RECONNECT_MAX_MS = 30_000;
const ENTERPRISE_CHAT_INLINE_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
const ENTERPRISE_CHAT_DOWNLOAD_MAX_BYTES = 110 * 1024 * 1024;
const ENTERPRISE_CHAT_MAX_SELECTED_FILES = 10;

type FetchResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

type WebSocketMessageEventLike = { data: unknown };

type WebSocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: () => void;
};

type PendingWebSocketRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type EnterpriseChatRuntimeOptions = {
  app: App;
  serverUrl?: string;
  getServerUrl?: () => string;
  initialEnabled?: boolean;
  fetchImpl?: FetchLike;
  createWebSocket?: (url: string) => WebSocketLike;
  getIdentityToken?: () => string | null;
  refreshIdentityToken?: () => Promise<string | null>;
  getDeviceInfo?: () => { deviceId: string; deviceName: string };
  platform?: NodeJS.Platform;
  selectFiles?: () => Promise<string[]>;
  selectAvatar?: () => Promise<string[]>;
  createSupportBundle?: () => Promise<{ filename: string; bytes: Buffer }>;
  captureScreenshot?: (mode: EnterpriseChatScreenshotMode) => Promise<{
    ok: boolean;
    message?: string;
    dataBase64?: string;
    mimeType?: string;
    cancelled?: boolean;
  }>;
  createSupportArtifact?: (
    action: string,
    args: Record<string, unknown>
  ) => Promise<{ filename: string; contentType: string; bytes: Buffer }>;
  executeDesktopAction?: (
    request: EnterpriseChatDesktopAction & {
      messageId: string;
      conversationId: string;
      senderId: string;
    }
  ) => Promise<{ response?: DesktopActionCallResponse; message: string }>;
  onStateChanged?: (snapshot: EnterpriseChatSnapshot) => void;
};

type ServerSession = {
  token: string;
  expiresAt: number;
  user: EnterpriseChatUser;
};

type ServerBootstrap = {
  user: EnterpriseChatUser;
  conversations: EnterpriseChatConversation[];
  latestEventId: number;
};

class EnterpriseChatRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readEpochMilliseconds(value: unknown): EpochMilliseconds {
  return Math.max(0, Math.trunc(readNumber(value))) as EpochMilliseconds;
}

function readOnline(value: Record<string, unknown>) {
  if (value.alwaysOnline === true) {
    return true;
  }
  if (typeof value.online === "boolean") {
    return value.online;
  }
  // `status=active` is an account state, not a live connection signal.
  return null;
}

function normalizeUser(value: unknown): EnterpriseChatUser {
  const record = isRecord(value) ? value : {};
  const kind = readText(record.kind) === "service_bot" ? "service_bot" : "employee";
  return {
    id: readText(record.id),
    displayName: readText(record.displayName) || readText(record.email) || readText(record.id),
    email: readText(record.email),
    avatarUrl: readText(record.avatarUrl),
    status: readText(record.status),
    kind,
    alwaysOnline: record.alwaysOnline === true || kind === "service_bot",
    online: readOnline(record)
  };
}

function normalizeAttachment(value: unknown): EnterpriseChatAttachment | null {
  const record = isRecord(value) ? value : {};
  const id = readText(record.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: readText(record.name) || "attachment",
    contentType: readText(record.contentType) || "application/octet-stream",
    sizeBytes: Math.max(0, Math.trunc(readNumber(record.sizeBytes))),
    sha256: readText(record.sha256),
    createdAt: readEpochMilliseconds(record.createdAt)
  };
}

function localizedDesktopActionSummary(
  action: string,
  args: Record<string, unknown>,
  fallback: string
) {
  let summary = "";
  switch (action) {
    case "desktop.webapp.open":
      summary = t("enterpriseChat.desktopActionWebappOpen");
      break;
    case "desktop.webapp.updatePreferences":
      summary = t("enterpriseChat.desktopActionWebappUpdate");
      break;
    case "desktop.webapp.restart":
      summary = t("enterpriseChat.desktopActionWebappRestart");
      break;
    case "desktop.support.requestWebappLogs":
      summary = t("enterpriseChat.desktopActionWebappRequestLogs");
      break;
    default:
      break;
  }
  if (!summary) {
    return fallback;
  }
  const target = readText(args.webappId) || readText(args.id);
  return target
    ? `${summary}${t("enterpriseChat.desktopActionTargetSuffix", { target })}`
    : summary;
}

function normalizeDesktopAction(value: unknown): EnterpriseChatDesktopAction | undefined {
  const payload = isRecord(value) ? value : {};
  const requestId = readText(payload.requestId);
  const targetDeviceId = readText(payload.targetDeviceId);
  const action = readText(payload.action);
  const definition = getEnterpriseChatRemoteAction(action);
  if (!requestId || !targetDeviceId || !definition) {
    return undefined;
  }
  const args = isRecord(payload.args) ? payload.args : {};
  const fallbackSummary = definition.summary(args);
  return {
    requestId,
    targetDeviceId,
    action,
    args,
    summary: localizedDesktopActionSummary(action, args, fallbackSummary).slice(0, 500),
    operatorNote: readText(payload.operatorNote).slice(0, 500),
    expiresAt: readEpochMilliseconds(payload.expiresAt)
  };
}

function normalizeDesktopActionResult(value: unknown): EnterpriseChatDesktopActionResult | undefined {
  const payload = isRecord(value) ? value : {};
  const status = readText(payload.status) as EnterpriseChatDesktopActionStatus;
  if (![
    "succeeded", "failed", "declined", "expired", "unsupported"
  ].includes(status)) {
    return undefined;
  }
  const requestId = readText(payload.requestId);
  const targetDeviceId = readText(payload.targetDeviceId);
  const action = readText(payload.action);
  if (!requestId || !targetDeviceId || !action) {
    return undefined;
  }
  return {
    requestId,
    targetDeviceId,
    action,
    status,
    message: readText(payload.message).slice(0, 1000),
    completedAt: readEpochMilliseconds(payload.completedAt)
  };
}

function normalizeMessage(value: unknown): EnterpriseChatMessage {
  const record = isRecord(value) ? value : {};
  const editedAt = readNumber(record.editedAt);
  const revokedAt = readNumber(record.revokedAt);
  const rawBody = typeof record.body === "string" ? record.body.trim() : "";
  const kind = readText(record.kind) || "text";
  const desktopAction = kind === "desktop_action_request"
    ? normalizeDesktopAction(record.desktopAction)
    : undefined;
  const desktopActionResult = kind === "desktop_action_result"
    ? normalizeDesktopActionResult(record.desktopAction)
    : undefined;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
      .map(normalizeAttachment)
      .filter((item): item is EnterpriseChatAttachment => item !== null)
    : [];
  return {
    id: readText(record.id),
    conversationId: readText(record.conversationId),
    seq: Math.max(0, Math.trunc(readNumber(record.seq))),
    senderId: readText(record.senderId),
    actorUserId: readText(record.actorUserId),
    senderDeviceId: readText(record.senderDeviceId),
    clientMessageId: readText(record.clientMessageId),
    replyToId: readText(record.replyToId),
    kind,
    body: desktopAction?.summary ?? desktopActionResult?.message ?? rawBody,
    attachments,
    ...(desktopAction ? { desktopAction } : {}),
    ...(desktopActionResult ? { desktopActionResult } : {}),
    createdAt: readEpochMilliseconds(record.createdAt),
    ...(editedAt > 0 ? { editedAt: readEpochMilliseconds(editedAt) } : {}),
    ...(revokedAt > 0 ? { revokedAt: readEpochMilliseconds(revokedAt) } : {})
  };
}

function normalizeConversation(value: unknown): EnterpriseChatConversation | null {
  const record = isRecord(value) ? value : {};
  const type = readText(record.type);
  if (type !== "direct" && type !== "group") {
    return null;
  }
  const members = Array.isArray(record.members)
    ? record.members
      .map((member) => {
        const memberRecord = isRecord(member) ? member : {};
        const user = normalizeUser(memberRecord.user);
        return {
          user,
          role: readText(memberRecord.role),
          joinedSeq: Math.max(0, Math.trunc(readNumber(memberRecord.joinedSeq)))
        };
      })
      .filter((member) => member.user.id)
    : [];
  const lastMessage = isRecord(record.lastMessage)
    ? normalizeMessage(record.lastMessage)
    : null;
  const id = readText(record.id);
  if (!id) {
    return null;
  }
  return {
    id,
    type,
    title: readText(record.title),
    createdBy: readText(record.createdBy),
    role: readText(record.role),
    lastReadSeq: Math.max(0, Math.trunc(readNumber(record.lastReadSeq))),
    lastSeq: Math.max(0, Math.trunc(readNumber(record.lastSeq))),
    unreadCount: Math.max(0, Math.trunc(readNumber(record.unreadCount))),
    lastMessage,
    members,
    createdAt: readEpochMilliseconds(record.createdAt),
    updatedAt: readEpochMilliseconds(record.updatedAt)
  };
}

function normalizeConversations(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeConversation).filter((item): item is EnterpriseChatConversation => item !== null)
    : [];
}

function mergeConversationUsers(
  conversations: EnterpriseChatConversation[],
  users: EnterpriseChatUser[]
) {
  const usersById = new Map(users.map((user) => [user.id, user] as const));
  return conversations.map((conversation) => ({
    ...conversation,
    members: conversation.members.map((member) => {
      const directoryUser = usersById.get(member.user.id);
      return directoryUser
        ? {
            ...member,
            user: {
              ...member.user,
              ...directoryUser
            }
          }
        : member;
    })
  }));
}

function normalizeMessages(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeMessage).filter((item) => item.id && item.conversationId)
    : [];
}

function normalizeServerUrl(value: string | undefined) {
  const normalized = normalizeEnterpriseImBaseUrl(readText(value) || DEFAULT_ENTERPRISE_IM_BASE_URL);
  if (!normalized) {
    throw new Error("IM server base URL must use loopback HTTP or remote HTTPS.");
  }
  return normalized;
}

function toWebSocketUrl(serverUrl: string, ticket: string) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/ws`;
  url.search = "";
  url.searchParams.set("v", "1");
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

function createDefaultWebSocket(url: string): WebSocketLike {
  const WebSocketConstructor = (
    globalThis as unknown as { WebSocket?: new (targetUrl: string) => WebSocketLike }
  ).WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("This Desktop runtime does not provide WebSocket support.");
  }
  return new WebSocketConstructor(url);
}

function nowEpochMilliseconds() {
  return Date.now() as EpochMilliseconds;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function readWebSocketText(data: unknown) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (isRecord(data) && typeof data.text === "function") {
    return String(await (data.text as () => Promise<string>)());
  }
  return "";
}

function mergeMessage(messages: EnterpriseChatMessage[], message: EnterpriseChatMessage) {
  const next = messages.filter((item) => item.id !== message.id);
  next.push(message);
  return next.sort((left, right) => left.seq - right.seq);
}

function contentTypeForFile(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function safeDownloadName(value: string, platform: NodeJS.Platform) {
  const base = path.basename(value.trim()) || "attachment";
  if (platform === "win32") {
    const sanitized = base.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "");
    return sanitized || "attachment";
  }
  if (platform === "darwin") {
    return base.replace(/[:/\u0000]/gu, "_") || "attachment";
  }
  return base.replace(/[/\u0000]/gu, "_") || "attachment";
}

function numberedDownloadName(filename: string, attempt: number) {
  if (attempt === 0) {
    return filename;
  }
  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem} (${attempt})${extension}`;
}

export class EnterpriseChatRuntime {
  private readonly app: App;
  private serverUrl: string;
  private readonly getServerUrl: () => string;
  private readonly fetchImpl: FetchLike;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly getIdentityToken: () => string | null;
  private readonly refreshIdentityToken?: () => Promise<string | null>;
  private readonly getDeviceInfo: () => { deviceId: string; deviceName: string };
  private readonly platform: NodeJS.Platform;
  private readonly selectFiles: () => Promise<string[]>;
  private readonly selectAvatar: () => Promise<string[]>;
  private readonly createSupportBundle: () => Promise<{ filename: string; bytes: Buffer }>;
  private readonly captureScreenshot?: EnterpriseChatRuntimeOptions["captureScreenshot"];
  private readonly createSupportArtifact?: EnterpriseChatRuntimeOptions["createSupportArtifact"];
  private readonly executeDesktopAction?: EnterpriseChatRuntimeOptions["executeDesktopAction"];
  private readonly onStateChanged?: (snapshot: EnterpriseChatSnapshot) => void;
  private snapshot: EnterpriseChatSnapshot;
  private imSessionToken = "";
  private imSessionTokenExpiresAt = 0;
  private socket: WebSocketLike | null = null;
  private socketSynced = false;
  private socketClosing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private requestSequence = 0;
  private presenceRevision = 0;
  private desktopActionLedger: EnterpriseChatActionLedger | null = null;
  private desktopActionLedgerPath = "";
  private readonly recoveredDesktopActionScopes = new Set<string>();
  private actionReceiptFlushPromise: Promise<void> | null = null;
  private pendingRequests = new Map<string, PendingWebSocketRequest>();
  private refreshPromise: Promise<EnterpriseChatSnapshot> | null = null;

  constructor(options: EnterpriseChatRuntimeOptions) {
    this.app = options.app;
    this.getServerUrl = options.getServerUrl ?? (() =>
      options.serverUrl ?? DEFAULT_ENTERPRISE_IM_BASE_URL
    );
    this.serverUrl = normalizeServerUrl(this.getServerUrl());
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.createWebSocket = options.createWebSocket ?? createDefaultWebSocket;
    this.getIdentityToken = options.getIdentityToken ?? getDesktopSsoAccessToken;
    this.refreshIdentityToken = options.refreshIdentityToken;
    this.getDeviceInfo = options.getDeviceInfo ?? (() => getDesktopDeviceInfo(this.app));
    this.platform = options.platform ?? process.platform;
    this.selectFiles = options.selectFiles ?? (async () => []);
    this.selectAvatar = options.selectAvatar ?? (async () => []);
    this.createSupportBundle = options.createSupportBundle ?? (() =>
      createEnterpriseChatSupportBundle(this.app, this.platform)
    );
    this.captureScreenshot = options.captureScreenshot;
    this.createSupportArtifact = options.createSupportArtifact;
    this.executeDesktopAction = options.executeDesktopAction;
    this.onStateChanged = options.onStateChanged;
    const initialEnabled = options.initialEnabled ?? false;
    this.snapshot = {
      enabled: initialEnabled,
      connectionState: initialEnabled ? "signed_out" : "disabled",
      message: "",
      serverUrl: this.serverUrl,
      currentUser: null,
      selfProfile: {
        motto: "",
        avatarDataUrl: "",
        hasCustomAvatar: false
      },
      users: [],
      conversations: [],
      activeConversationId: "",
      activeMessages: [],
      latestEventId: 0,
      updatedAt: nowEpochMilliseconds()
    };
  }

  getState() {
    return {
      ...this.snapshot,
      currentUser: this.snapshot.currentUser ? { ...this.snapshot.currentUser } : null,
      selfProfile: { ...this.snapshot.selfProfile },
      users: this.snapshot.users.map((user) => ({ ...user })),
      conversations: this.snapshot.conversations.map((conversation) => ({
        ...conversation,
        lastMessage: conversation.lastMessage
          ? this.projectMessage(conversation.lastMessage, conversation)
          : null,
        members: conversation.members.map((member) => ({
          ...member,
          user: { ...member.user }
        }))
      })),
      activeMessages: this.snapshot.activeMessages.map((message) =>
        this.projectMessage(
          message,
          this.snapshot.conversations.find((conversation) => conversation.id === message.conversationId)
        )
      )
    };
  }

  private currentDesktopActionScope() {
    const userId = this.snapshot.currentUser?.id ?? "";
    const deviceId = this.getDeviceInfo().deviceId;
    return userId && deviceId
      ? enterpriseChatActionScope(this.serverUrl, userId, deviceId)
      : "";
  }

  private getDesktopActionLedger() {
    let ledgerPath = "";
    try {
      ledgerPath = path.join(this.app.getPath("userData"), "enterprise-chat-action-ledger.json");
    } catch {
      return null;
    }
    if (ledgerPath === this.desktopActionLedgerPath) {
      return this.desktopActionLedger;
    }
    this.desktopActionLedgerPath = ledgerPath;
    try {
      this.desktopActionLedger = new EnterpriseChatActionLedger(ledgerPath);
    } catch {
      this.desktopActionLedger = null;
    }
    return this.desktopActionLedger;
  }

  private desktopActionState(
    message: EnterpriseChatMessage,
    conversation?: EnterpriseChatConversation
  ) {
    const request = message.desktopAction;
    if (!request) {
      return undefined;
    }
    const ledger = this.getDesktopActionLedger();
    if (ledger?.hasLegacyMessage(message.id)) {
      return "handled" as const;
    }
    const scope = this.currentDesktopActionScope();
    const entry = scope ? ledger?.find(scope, request.requestId) : undefined;
    if (entry?.phase === "executing") {
      return "executing" as const;
    }
    if (entry?.phase === "terminal") {
      return "handled" as const;
    }
    if (
      !scope ||
      !ledger ||
      !conversation ||
      conversation.type !== "direct" ||
      message.senderId === this.snapshot.currentUser?.id ||
      message.revokedAt ||
      !getEnterpriseChatRemoteAction(request.action) ||
      request.targetDeviceId !== this.getDeviceInfo().deviceId ||
      request.expiresAt <= Date.now()
    ) {
      return "not_executable" as const;
    }
    return "pending" as const;
  }

  private projectMessage(
    message: EnterpriseChatMessage,
    conversation?: EnterpriseChatConversation
  ): EnterpriseChatMessage {
    const desktopActionState = this.desktopActionState(message, conversation);
    return {
      ...message,
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
      ...(message.desktopAction
        ? {
            desktopActionHandled: desktopActionState !== "pending",
            desktopActionState,
            desktopAction: {
              ...message.desktopAction,
              args: { ...message.desktopAction.args }
            }
          }
        : {})
    };
  }

  async setEnabled(enabled: boolean) {
    if (!enabled) {
      this.disconnect();
      this.clearSession();
      this.updateSnapshot({
        enabled: false,
        connectionState: "disabled",
        message: "",
        currentUser: null,
        selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
        users: [],
        conversations: [],
        activeConversationId: "",
        activeMessages: [],
        latestEventId: 0
      });
      return this.getState();
    }

    const wasEnabled = this.snapshot.enabled;
    this.updateSnapshot({
      enabled: true,
      connectionState: this.getIdentityToken() ? "connecting" : "signed_out",
      message: ""
    });
    if (!wasEnabled || !this.socket) {
      return this.refresh();
    }
    return this.getState();
  }

  async refresh() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async reloadConfiguration(enabled: boolean) {
    const nextServerUrl = normalizeServerUrl(this.getServerUrl());
    if (nextServerUrl !== this.serverUrl) {
      this.disconnect();
      this.clearSession();
      this.serverUrl = nextServerUrl;
      this.updateSnapshot({ serverUrl: nextServerUrl });
    }
    return this.setEnabled(enabled);
  }

  private async performRefresh() {
    if (!this.snapshot.enabled) {
      return this.getState();
    }
    const identityToken = readText(this.getIdentityToken());
    if (!identityToken) {
      this.disconnect();
      this.clearSession();
      this.updateSnapshot({
        connectionState: "signed_out",
        message: "",
        currentUser: null,
        selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
        users: [],
        conversations: [],
        activeConversationId: "",
        activeMessages: [],
        latestEventId: 0
      });
      return this.getState();
    }

    this.disconnect();
    this.clearSession();
    try {
      this.updateServerUrl();
      this.updateSnapshot({
        connectionState: "connecting",
        message: "",
        serverUrl: this.serverUrl
      });
      let session: ServerSession;
      try {
        session = await this.exchangeSession(identityToken);
      } catch (error) {
        if (!(error instanceof EnterpriseChatRequestError) || error.status !== 401 || !this.refreshIdentityToken) {
          throw error;
        }
        const refreshedIdentityToken = readText(await this.refreshIdentityToken());
        if (!refreshedIdentityToken) {
          throw error;
        }
        session = await this.exchangeSession(refreshedIdentityToken);
      }
      this.imSessionToken = session.token;
      this.imSessionTokenExpiresAt = session.expiresAt;
      this.scheduleSessionRefresh();

      const [bootstrap, users] = await Promise.all([
        this.requestBootstrap(),
        this.requestUsers()
      ]);
      const bootstrapCurrentUser = bootstrap.user.id ? bootstrap.user : session.user;
      const directoryCurrentUser = users.find((user) => user.id === bootstrapCurrentUser.id);
      const currentUser = directoryCurrentUser
        ? { ...bootstrapCurrentUser, ...directoryCurrentUser }
        : bootstrapCurrentUser;
      const visibleUsers = users.filter((user) => user.id && user.id !== currentUser.id);
      const selfProfile = readEnterpriseChatSelfProfile(
        this.app,
        this.platform,
        this.serverUrl,
        currentUser.id
      );
      this.updateSnapshot({
        currentUser,
        selfProfile,
        users: visibleUsers,
        conversations: mergeConversationUsers(
          bootstrap.conversations,
          [currentUser, ...visibleUsers]
        ),
        latestEventId: bootstrap.latestEventId,
        activeConversationId: "",
        activeMessages: [],
        connectionState: "connecting",
        message: ""
      });
      const actionScope = this.currentDesktopActionScope();
      if (actionScope && !this.recoveredDesktopActionScopes.has(actionScope)) {
        this.recoveredDesktopActionScopes.add(actionScope);
        if (this.getDesktopActionLedger()?.recoverExecuting(actionScope).length) {
          this.updateSnapshot({});
        }
      }
      await this.connectWebSocket();
    } catch (error) {
      this.disconnect();
      this.clearSession();
      this.updateSnapshot({
        connectionState: "error",
        message: errorMessage(error),
        currentUser: null,
        selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
        users: [],
        conversations: [],
        activeConversationId: "",
        activeMessages: [],
        latestEventId: 0
      });
    }
    return this.getState();
  }

  private updateServerUrl() {
    this.serverUrl = normalizeServerUrl(this.getServerUrl());
  }

  async openDirectConversation(input: EnterpriseChatOpenDirectInput) {
    const userId = readText(input?.userId);
    if (!userId || userId === this.snapshot.currentUser?.id) {
      throw new Error("A different enterprise employee is required.");
    }
    await this.ensureSession();
    let conversation = this.snapshot.conversations.find((item) =>
      item.type === "direct" &&
      item.members.some((member) => member.user.id === userId)
    );
    if (!conversation) {
      const created = await this.requestJson<unknown>("/api/v1/conversations", {
        method: "POST",
        body: JSON.stringify({
          type: "direct",
          memberIds: [userId]
        })
      });
      conversation = normalizeConversation(created) ?? undefined;
      if (!conversation) {
        throw new Error("The IM server returned an invalid direct conversation.");
      }
      this.snapshot.conversations = [
        conversation,
        ...this.snapshot.conversations.filter((item) => item.id !== conversation?.id)
      ];
    }
    return this.openConversation({ conversationId: conversation.id });
  }

  async openConversation(input: EnterpriseChatOpenConversationInput) {
    const conversationId = readText(input?.conversationId);
    if (!conversationId) {
      throw new Error("conversationId is required.");
    }
    await this.ensureSession();
    let conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) {
      const response = await this.requestJson<unknown>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}`
      );
      conversation = normalizeConversation(response) ?? undefined;
    }
    if (!conversation) {
      throw new Error("The IM server returned an invalid conversation.");
    }
    [conversation] = mergeConversationUsers(
      [conversation],
      [
        ...(this.snapshot.currentUser ? [this.snapshot.currentUser] : []),
        ...this.snapshot.users
      ]
    );
    const response = await this.requestJson<unknown>(
      `/api/v1/conversations/${encodeURIComponent(conversation.id)}/messages?limit=50`
    );
    const record = isRecord(response) ? response : {};
    const messages = normalizeMessages(record.items);
    this.reconcileDesktopActionMessages(messages, conversation);
    this.updateSnapshot({
      conversations: [
        conversation,
        ...this.snapshot.conversations.filter((item) => item.id !== conversation?.id)
      ],
      activeConversationId: conversation.id,
      activeMessages: messages,
      message: ""
    });
    void this.flushDesktopActionReceipts();
    if (conversation.lastSeq > conversation.lastReadSeq) {
      await this.markRead({ conversationId: conversation.id, seq: conversation.lastSeq });
    }
    return this.getState();
  }

  async createGroup(input: EnterpriseChatCreateGroupInput) {
    const title = readText(input?.title);
    const currentUserId = this.snapshot.currentUser?.id ?? "";
    const memberIds = Array.from(new Set(
      Array.isArray(input?.memberIds)
        ? input.memberIds.map(readText).filter((id) => id && id !== currentUserId)
        : []
    ));
    if (!title || memberIds.length === 0) {
      throw new Error("A group title and at least one other member are required.");
    }
    await this.ensureSession();
    const created = await this.requestJson<unknown>("/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        type: "group",
        title,
        memberIds
      })
    });
    let conversation = normalizeConversation(created);
    if (!conversation || conversation.type !== "group") {
      throw new Error("The IM server returned an invalid group conversation.");
    }
    [conversation] = mergeConversationUsers(
      [conversation],
      [
        ...(this.snapshot.currentUser ? [this.snapshot.currentUser] : []),
        ...this.snapshot.users
      ]
    );
    this.updateSnapshot({
      conversations: [
        conversation,
        ...this.snapshot.conversations.filter((item) => item.id !== conversation.id)
      ]
    });
    return this.openConversation({ conversationId: conversation.id });
  }

  async sendMessage(input: EnterpriseChatSendMessageInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    const body = readText(input?.body);
    if (!conversationId || !clientMessageId || !body) {
      throw new Error("conversationId, clientMessageId, and body are required.");
    }
    return this.sendMessagePayload({
      conversationId,
      clientMessageId,
      body,
      fileIds: []
    });
  }

  async sendFiles(input: EnterpriseChatSendFilesInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    if (!conversationId || !clientMessageId) {
      throw new Error("conversationId and clientMessageId are required.");
    }
    const selected = (await this.selectFiles())
      .map((filePath) => filePath.trim())
      .filter(Boolean)
      .slice(0, ENTERPRISE_CHAT_MAX_SELECTED_FILES);
    if (selected.length === 0) {
      return this.getState();
    }
    await this.ensureSession();
    this.assertMessageSendReady();
    const fileIds: string[] = [];
    for (const filePath of selected) {
      const attachment = await this.uploadFilePath(filePath);
      fileIds.push(attachment.id);
    }
    return this.sendMessagePayload({
      conversationId,
      clientMessageId,
      body: "",
      fileIds
    });
  }

  async sendSupportBundle(input: EnterpriseChatSendSupportBundleInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    if (!conversationId || !clientMessageId) {
      throw new Error("conversationId and clientMessageId are required.");
    }
    await this.ensureSession();
    this.assertMessageSendReady();
    const bundle = await this.createSupportBundle();
    const bundleBytes = Uint8Array.from(bundle.bytes);
    const attachment = await this.uploadBlob(
      new Blob([bundleBytes.buffer], { type: "application/zip" }),
      bundle.filename
    );
    return this.sendMessagePayload({
      conversationId,
      clientMessageId,
      body: "",
      fileIds: [attachment.id]
    });
  }

  async saveSelfProfile(input: EnterpriseChatSaveSelfProfileInput) {
    const userId = this.snapshot.currentUser?.id ?? "";
    if (!userId) {
      throw new Error("Enterprise chat profile requires a signed-in user.");
    }
    const selfProfile = await saveEnterpriseChatMotto(
      this.app,
      this.platform,
      this.serverUrl,
      userId,
      typeof input?.motto === "string" ? input.motto : ""
    );
    this.updateSnapshot({ selfProfile });
    return this.getState();
  }

  async selectSelfAvatar() {
    const userId = this.snapshot.currentUser?.id ?? "";
    if (!userId) {
      throw new Error("Enterprise chat profile requires a signed-in user.");
    }
    const selected = (await this.selectAvatar()).map((value) => value.trim()).filter(Boolean);
    if (selected.length === 0) {
      return this.getState();
    }
    const selfProfile = await saveEnterpriseChatAvatar(
      this.app,
      this.platform,
      this.serverUrl,
      userId,
      selected[0]
    );
    this.updateSnapshot({ selfProfile });
    return this.getState();
  }

  async clearSelfAvatar() {
    const userId = this.snapshot.currentUser?.id ?? "";
    if (!userId) {
      throw new Error("Enterprise chat profile requires a signed-in user.");
    }
    const selfProfile = await clearEnterpriseChatAvatar(
      this.app,
      this.platform,
      this.serverUrl,
      userId
    );
    this.updateSnapshot({ selfProfile });
    return this.getState();
  }

  async sendPastedFiles(input: EnterpriseChatSendPastedFilesInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    const files = Array.isArray(input?.files) ? input.files : [];
    if (!conversationId || !clientMessageId) {
      throw new Error("conversationId and clientMessageId are required.");
    }
    if (files.length === 0 || files.length > ENTERPRISE_CHAT_MAX_PASTED_FILES) {
      throw new Error(`Paste between 1 and ${ENTERPRISE_CHAT_MAX_PASTED_FILES} files.`);
    }

    const blobs = files.map((file, index) => {
      const value: unknown = file;
      const record = isRecord(value) ? value : {};
      const name = readText(record.name) || `pasted-file-${Date.now()}-${index + 1}`;
      const contentType = readText(record.contentType) || contentTypeForFile(name);
      const sizeBytes = Math.max(0, Math.trunc(readNumber(record.sizeBytes)));
      const rawDataBase64 = record.dataBase64;
      const hasData = typeof rawDataBase64 === "string";
      const dataBase64 = hasData
        ? rawDataBase64.trim()
        : "";
      const maxBase64Length = Math.ceil(ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES / 3) * 4 + 4;
      if (
        !hasData ||
        dataBase64.length > maxBase64Length ||
        dataBase64.length % 4 === 1 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(dataBase64)
      ) {
        throw new Error(`Pasted file "${name}" has invalid data.`);
      }
      const bytes = Buffer.from(dataBase64, "base64");
      if (
        bytes.length > ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES ||
        bytes.length !== sizeBytes
      ) {
        throw new Error(`Pasted file "${name}" exceeds the local attachment limit.`);
      }
      return {
        blob: new Blob([bytes], { type: contentType }),
        name
      };
    });

    await this.ensureSession();
    this.assertMessageSendReady();
    const fileIds: string[] = [];
    for (const file of blobs) {
      const attachment = await this.uploadBlob(file.blob, file.name);
      fileIds.push(attachment.id);
    }
    return this.sendMessagePayload({
      conversationId,
      clientMessageId,
      body: "",
      fileIds
    });
  }

  async sendScreenshot(input: EnterpriseChatSendScreenshotInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    const mode = readText(input?.mode);
    if (!conversationId || !clientMessageId) {
      throw new Error("conversationId and clientMessageId are required.");
    }
    if (mode !== "region" && mode !== "window" && mode !== "desktop") {
      throw new Error("Screenshot mode is invalid.");
    }
    if (!this.captureScreenshot) {
      throw new Error("Screenshot capture is unavailable.");
    }
    const capture = await this.captureScreenshot(mode);
    if (!capture.ok) {
      if (capture.cancelled) {
        return this.getState();
      }
      throw new Error(capture.message || "Screenshot capture failed.");
    }
    const bytes = Buffer.from(capture.dataBase64 ?? "", "base64");
    if (bytes.length === 0) {
      throw new Error("Screenshot capture returned no image.");
    }
    await this.ensureSession();
    this.assertMessageSendReady();
    const attachment = await this.uploadBlob(
      new Blob([bytes], { type: capture.mimeType || "image/png" }),
      `screenshot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`
    );
    return this.sendMessagePayload({
      conversationId,
      clientMessageId,
      body: "",
      fileIds: [attachment.id]
    });
  }

  async loadAttachment(input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatAttachmentData> {
    const fileId = readText(input?.fileId);
    if (!fileId) {
      throw new Error("fileId is required.");
    }
    const { buffer, contentType } = await this.fetchAttachment(
      fileId,
      ENTERPRISE_CHAT_INLINE_ATTACHMENT_MAX_BYTES
    );
    return {
      fileId,
      contentType: readText(input?.contentType) || contentType,
      sizeBytes: buffer.length,
      dataBase64: buffer.toString("base64")
    };
  }

  async downloadAttachment(input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatDownloadResult> {
    const fileId = readText(input?.fileId);
    if (!fileId) {
      throw new Error("fileId is required.");
    }
    const { buffer } = await this.fetchAttachment(fileId, ENTERPRISE_CHAT_DOWNLOAD_MAX_BYTES);
    const filename = safeDownloadName(readText(input?.name) || "attachment", this.platform);
    const downloadsRoot = this.app.getPath("downloads");
    await fs.promises.mkdir(downloadsRoot, { recursive: true });
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const target = path.join(downloadsRoot, numberedDownloadName(filename, attempt));
      try {
        if (this.platform === "win32") {
          await fs.promises.writeFile(target, buffer, { flag: "wx" });
        } else if (this.platform === "darwin") {
          await fs.promises.writeFile(target, buffer, { flag: "wx", mode: 0o600 });
        } else {
          await fs.promises.writeFile(target, buffer, { flag: "wx", mode: 0o600 });
        }
        return { ok: true, path: target, message: "" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Unable to allocate a download filename.");
  }

  async executeMessageDesktopAction(
    input: EnterpriseChatExecuteActionInput
  ): Promise<EnterpriseChatExecuteActionResult> {
    const messageId = readText(input?.messageId);
    if (input?.decision !== "confirm" && input?.decision !== "decline") {
      throw new Error("A local Desktop action decision is required.");
    }
    const message = this.snapshot.activeMessages.find((item) => item.id === messageId);
    const conversation = message
      ? this.snapshot.conversations.find((item) => item.id === message.conversationId)
      : undefined;
    const request = message?.desktopAction;
    const scope = this.currentDesktopActionScope();
    const ledger = this.getDesktopActionLedger();
    const existing = request && scope
      ? ledger?.find(scope, request.requestId)
      : undefined;
    if (existing || (message && ledger?.hasLegacyMessage(message.id))) {
      return this.handledDesktopActionResult(existing);
    }
    if (
      !message ||
      !request ||
      !conversation ||
      this.desktopActionState(message, conversation) !== "pending" ||
      !scope ||
      !ledger
    ) {
      return this.notExecutableDesktopActionResult();
    }

    let claimed: EnterpriseChatActionLedgerEntry;
    try {
      const claim = ledger.claim({
        scope,
        messageId: message.id,
        requestId: request.requestId,
        conversationId: message.conversationId,
        targetDeviceId: request.targetDeviceId,
        action: request.action
      });
      if (!claim.created) {
        return this.handledDesktopActionResult(claim.entry);
      }
      claimed = claim.entry;
    } catch (error) {
      return this.notExecutableDesktopActionResult(errorMessage(error));
    }
    this.updateSnapshot({});

    let status: EnterpriseChatDesktopActionStatus;
    let resultMessage: string;
    let fileIds: string[] = [];
    let response: DesktopActionCallResponse | undefined;
    if (input.decision === "decline") {
      status = "declined";
      resultMessage = "User declined the Desktop action request.";
    } else {
      try {
        if (request.action.startsWith("desktop.support.")) {
          fileIds = await this.createRemoteSupportAttachment(request);
          status = "succeeded";
          resultMessage = fileIds.length > 0
            ? "Requested support information was sent."
            : "Support request completed.";
        } else if (!this.executeDesktopAction) {
          status = "unsupported";
          resultMessage = "Desktop action execution is unavailable.";
        } else {
          const result = await this.executeDesktopAction({
            ...request,
            args: { ...request.args },
            messageId: message.id,
            conversationId: message.conversationId,
            senderId: message.senderId
          });
          response = result.response;
          status = result.response?.ok === true ? "succeeded" : "failed";
          resultMessage = result.message;
        }
      } catch (error) {
        status = "failed";
        resultMessage = errorMessage(error);
      }
    }

    const terminal = ledger.complete(scope, claimed.requestId, {
      status,
      resultMessage,
      fileIds
    });
    this.updateSnapshot({});
    const delivered = await this.deliverDesktopActionReceipt(terminal);
    return {
      confirmed: input.decision === "confirm",
      status,
      disposition: "completed",
      deliveryState: delivered ? "delivered" : "pending",
      ...(response ? { response } : {}),
      message: resultMessage
    };
  }

  private handledDesktopActionResult(
    entry?: EnterpriseChatActionLedgerEntry
  ): EnterpriseChatExecuteActionResult {
    return {
      confirmed: entry?.status !== "declined",
      status: entry?.status ?? "failed",
      disposition: "already_handled",
      deliveryState: entry?.phase === "terminal"
        ? entry.deliveryState
        : "not_applicable",
      message: entry?.resultMessage || "This Desktop action request was already handled."
    };
  }

  private notExecutableDesktopActionResult(
    message = "This Desktop action request is not executable."
  ): EnterpriseChatExecuteActionResult {
    return {
      confirmed: false,
      status: "unsupported",
      disposition: "not_executable",
      deliveryState: "not_applicable",
      message
    };
  }

  private async createRemoteSupportAttachment(request: EnterpriseChatDesktopAction) {
    if (request.action === "desktop.support.requestDiagnostics") {
      const bundle = await this.createSupportBundle();
      const attachment = await this.uploadBlob(
        new Blob([Uint8Array.from(bundle.bytes).buffer], { type: "application/zip" }),
        bundle.filename
      );
      return [attachment.id];
    }
    if (request.action === "desktop.support.requestScreenshot") {
      const mode = readText(request.args.mode) as EnterpriseChatScreenshotMode;
      if (!this.captureScreenshot || !["region", "window", "desktop"].includes(mode)) {
        throw new Error("Screenshot capture is unavailable or the mode is invalid.");
      }
      const capture = await this.captureScreenshot(mode);
      if (!capture.ok || capture.cancelled) {
        throw new Error(capture.message || "Screenshot capture was cancelled.");
      }
      const bytes = Buffer.from(capture.dataBase64 ?? "", "base64");
      if (bytes.length === 0) {
        throw new Error("Screenshot capture returned no image.");
      }
      const attachment = await this.uploadBlob(
        new Blob([bytes], { type: capture.mimeType || "image/png" }),
        `desktop-screenshot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`
      );
      return [attachment.id];
    }
    if (!this.createSupportArtifact) {
      throw new Error("The requested support artifact is unavailable.");
    }
    const artifact = await this.createSupportArtifact(request.action, request.args);
    const attachment = await this.uploadBlob(
      new Blob([Uint8Array.from(artifact.bytes).buffer], { type: artifact.contentType }),
      artifact.filename
    );
    return [attachment.id];
  }

  private async deliverDesktopActionReceipt(entry: EnterpriseChatActionLedgerEntry) {
    if (
      entry.phase !== "terminal" ||
      !entry.status ||
      entry.deliveryState === "delivered" ||
      !this.socket ||
      !this.socketSynced ||
      this.socket.readyState !== 1
    ) {
      return entry.deliveryState === "delivered";
    }
    try {
      await this.sendMessagePayload({
        conversationId: entry.conversationId,
        clientMessageId: `desktop-action-result:${entry.requestId}`,
        body: entry.resultMessage.slice(0, 1000),
        fileIds: entry.fileIds,
        replyToId: entry.messageId,
        kind: "desktop_action_result",
        desktopAction: {
          requestId: entry.requestId,
          targetDeviceId: entry.targetDeviceId,
          action: entry.action,
          status: entry.status,
          message: entry.resultMessage.slice(0, 1000),
          completedAt: entry.completedAt
        }
      });
      this.getDesktopActionLedger()?.markDelivered(entry.scope, entry.requestId);
      return true;
    } catch {
      return false;
    }
  }

  private flushDesktopActionReceipts() {
    if (this.actionReceiptFlushPromise) {
      return this.actionReceiptFlushPromise;
    }
    const scope = this.currentDesktopActionScope();
    const ledger = this.getDesktopActionLedger();
    if (!scope || !ledger) {
      return Promise.resolve();
    }
    this.actionReceiptFlushPromise = (async () => {
      for (const entry of ledger.pendingReceipts(scope)) {
        if (!await this.deliverDesktopActionReceipt(entry)) {
          break;
        }
      }
    })().finally(() => {
      this.actionReceiptFlushPromise = null;
      this.updateSnapshot({});
    });
    return this.actionReceiptFlushPromise;
  }

  private reconcileDesktopActionMessages(
    messages: EnterpriseChatMessage[],
    conversation?: EnterpriseChatConversation
  ) {
    const scope = this.currentDesktopActionScope();
    const ledger = this.getDesktopActionLedger();
    const currentUserId = this.snapshot.currentUser?.id ?? "";
    const currentDeviceId = this.getDeviceInfo().deviceId;
    if (!scope || !ledger || !currentUserId || !currentDeviceId) {
      return;
    }
    const requestsById = new Map(
      messages
        .filter((message) => Boolean(message.desktopAction))
        .map((message) => [message.id, message] as const)
    );
    for (const resultMessage of messages) {
      const result = resultMessage.desktopActionResult;
      const requestMessage = requestsById.get(resultMessage.replyToId);
      const request = requestMessage?.desktopAction;
      if (
        !result ||
        !requestMessage ||
        !request ||
        resultMessage.senderId !== currentUserId ||
        result.targetDeviceId !== currentDeviceId ||
        request.requestId !== result.requestId ||
        request.targetDeviceId !== result.targetDeviceId ||
        request.action !== result.action ||
        requestMessage.conversationId !== resultMessage.conversationId
      ) {
        continue;
      }
      ledger.recordDelivered({
        scope,
        messageId: requestMessage.id,
        requestId: request.requestId,
        conversationId: requestMessage.conversationId,
        targetDeviceId: request.targetDeviceId,
        action: request.action,
        status: result.status,
        resultMessage: result.message,
        fileIds: resultMessage.attachments.map((attachment) => attachment.id),
        completedAt: result.completedAt
      });
    }

    if (!conversation || conversation.type !== "direct") {
      return;
    }
    for (const requestMessage of requestsById.values()) {
      const request = requestMessage.desktopAction;
      if (
        !request ||
        request.expiresAt > Date.now() ||
        requestMessage.senderId === currentUserId ||
        requestMessage.revokedAt ||
        request.targetDeviceId !== currentDeviceId ||
        !getEnterpriseChatRemoteAction(request.action) ||
        ledger.hasLegacyMessage(requestMessage.id) ||
        ledger.find(scope, request.requestId)
      ) {
        continue;
      }
      try {
        ledger.claim({
          scope,
          messageId: requestMessage.id,
          requestId: request.requestId,
          conversationId: requestMessage.conversationId,
          targetDeviceId: request.targetDeviceId,
          action: request.action
        });
        ledger.complete(scope, request.requestId, {
          status: "expired",
          resultMessage: "Desktop action request expired."
        });
      } catch {
        // Expired requests remain non-executable even if their acknowledgement cannot be persisted.
      }
    }
  }

  private async sendMessagePayload(input: {
    conversationId: string;
    clientMessageId: string;
    body: string;
    fileIds: string[];
    replyToId?: string;
    kind?: string;
    desktopAction?: Record<string, unknown>;
  }) {
    this.assertMessageSendReady();
    const result = await this.sendWebSocketRequest("message.send", {
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      body: input.body,
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.desktopAction ? { desktopAction: input.desktopAction } : {}),
      mentionUserIds: [],
      fileIds: input.fileIds
    });
    const record = isRecord(result) ? result : {};
    const message = normalizeMessage(record.message);
    if (message.id) {
      this.applyMessage(message);
    }
    return this.getState();
  }

  private assertMessageSendReady() {
    if (!this.socket || !this.socketSynced || this.socket.readyState !== 1) {
      throw new Error("Enterprise chat is reconnecting. Try again in a moment.");
    }
  }

  async markRead(input: EnterpriseChatMarkReadInput) {
    const conversationId = readText(input?.conversationId);
    const seq = Math.max(0, Math.trunc(readNumber(input?.seq)));
    if (!conversationId || seq <= 0) {
      return this.getState();
    }
    if (this.socket && this.socketSynced && this.socket.readyState === 1) {
      await this.sendWebSocketRequest("receipt.read", { conversationId, seq });
    }
    this.updateSnapshot({
      conversations: this.snapshot.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              lastReadSeq: Math.max(conversation.lastReadSeq, seq),
              unreadCount: 0
            }
          : conversation
      )
    });
    return this.getState();
  }

  handleSignedOut() {
    this.disconnect();
    this.clearSession();
    this.updateSnapshot({
      connectionState: this.snapshot.enabled ? "signed_out" : "disabled",
      message: "",
      currentUser: null,
      selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
      users: [],
      conversations: [],
      activeConversationId: "",
      activeMessages: [],
      latestEventId: 0
    });
  }

  stop() {
    this.disconnect();
    this.clearSession();
  }

  private async ensureSession() {
    if (
      this.imSessionToken &&
      this.imSessionTokenExpiresAt > Date.now() + 30_000
    ) {
      return;
    }
    const state = await this.refresh();
    if (!this.imSessionToken || state.connectionState === "error") {
      throw new Error(state.message || "Enterprise chat session is unavailable.");
    }
  }

  private async uploadFilePath(filePath: string) {
    const blob = await openAsBlob(filePath, { type: contentTypeForFile(filePath) });
    return this.uploadBlob(blob, path.basename(filePath));
  }

  private async uploadBlob(blob: Blob, filename: string) {
    const form = new FormData();
    form.append("file", blob, safeDownloadName(filename, this.platform));
    const response = await this.requestJson<unknown>("/api/v1/files", {
      method: "POST",
      body: form
    });
    const attachment = normalizeAttachment(response);
    if (!attachment) {
      throw new Error("The IM server returned invalid attachment metadata.");
    }
    return attachment;
  }

  private async fetchAttachment(fileId: string, maxBytes: number) {
    await this.ensureSession();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${this.serverUrl}/api/v1/files/${encodeURIComponent(fileId)}`,
        {
          headers: {
            Authorization: `Bearer ${this.imSessionToken}`
          },
          signal: controller.signal
        }
      );
      if (!response.ok) {
        throw new Error(`Attachment download failed (${response.status}).`);
      }
      if (typeof response.arrayBuffer !== "function") {
        throw new Error("Attachment response cannot be read.");
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        throw new Error("Attachment exceeds the local preview or download limit.");
      }
      return {
        buffer,
        contentType: "application/octet-stream"
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async exchangeSession(identityToken: string): Promise<ServerSession> {
    const device = this.getDeviceInfo();
    const response = await this.requestJson<unknown>("/api/v1/session/exchange", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${identityToken}`
      },
      body: JSON.stringify({
        deviceId: device.deviceId,
        deviceName: device.deviceName
      })
    }, false);
    const record = isRecord(response) ? response : {};
    const token = readText(record.token);
    const expiresAt = readNumber(record.expiresAt);
    const user = normalizeUser(record.user);
    if (!token || expiresAt <= Date.now() || !user.id) {
      throw new Error("The IM server returned an invalid session.");
    }
    return { token, expiresAt, user };
  }

  private async requestBootstrap(): Promise<ServerBootstrap> {
    const response = await this.requestJson<unknown>("/api/v1/sync/bootstrap");
    const record = isRecord(response) ? response : {};
    const user = normalizeUser(record.user);
    if (!user.id) {
      throw new Error("The IM server returned an invalid employee identity.");
    }
    return {
      user,
      conversations: normalizeConversations(record.conversations),
      latestEventId: Math.max(0, Math.trunc(readNumber(record.latestEventId)))
    };
  }

  private async requestUsers() {
    const users: EnterpriseChatUser[] = [];
    const pageSize = 100;
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      const response = await this.requestJson<unknown>(
        `/api/v1/users?limit=${pageSize}&offset=${offset}`
      );
      const record = isRecord(response) ? response : {};
      const page = Array.isArray(record.items)
        ? record.items.map(normalizeUser).filter((user) => user.id)
        : [];
      users.push(...page);
      if (page.length < pageSize) {
        break;
      }
    }
    return users;
  }

  private async requestJson<T>(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
    useImSessionToken = true
  ): Promise<T> {
    if (!this.fetchImpl) {
      throw new Error("This Desktop runtime does not provide fetch support.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    };
    if (useImSessionToken) {
      if (!this.imSessionToken) {
        clearTimeout(timeout);
        throw new Error("Enterprise chat session is unavailable.");
      }
      headers.Authorization = `Bearer ${this.imSessionToken}`;
    }
    try {
      const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        let detail = "";
        try {
          const payload = await response.json();
          const record = isRecord(payload) ? payload : {};
          const error = isRecord(record.error) ? record.error : {};
          detail = readText(error.message) || readText(record.message);
        } catch {
          detail = readText(await response.text().catch(() => ""));
        }
        throw new EnterpriseChatRequestError(
          response.status,
          detail || `Enterprise chat request failed (${response.status}).`
        );
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async connectWebSocket() {
    if (!this.snapshot.enabled || !this.imSessionToken) {
      return;
    }
    const ticketResponse = await this.requestJson<unknown>("/api/v1/ws-tickets", {
      method: "POST",
      body: "{}"
    });
    const ticketRecord = isRecord(ticketResponse) ? ticketResponse : {};
    const ticket = readText(ticketRecord.ticket);
    if (!ticket) {
      throw new Error("The IM server did not issue a WebSocket ticket.");
    }
    const socket = this.createWebSocket(toWebSocketUrl(this.serverUrl, ticket));
    this.socket = socket;
    this.socketSynced = false;
    this.socketClosing = false;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      void this.sendWebSocketRequest("sync.resume", {
        afterEventId: this.snapshot.latestEventId
      }).catch((error) => {
        if (this.socket !== socket || this.socketClosing) {
          return;
        }
        this.updateSnapshot({
          connectionState: "reconnecting",
          message: errorMessage(error)
        });
        socket.close();
      });
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) {
        void this.handleWebSocketMessage(event.data);
      }
    };
    socket.onerror = () => {
      if (this.socket === socket && !this.socketClosing) {
        this.updateSnapshot({
          connectionState: "reconnecting",
          message: "Enterprise chat WebSocket connection failed."
        });
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.socketSynced = false;
      this.rejectPendingRequests(new Error("Enterprise chat connection closed."));
      if (!this.socketClosing && this.snapshot.enabled && this.getIdentityToken()) {
        this.updateSnapshot({
          connectionState: "reconnecting",
          message: ""
        });
        this.scheduleReconnect();
      }
    };
  }

  private async handleWebSocketMessage(data: unknown) {
    const text = await readWebSocketText(data);
    if (!text) {
      return;
    }
    let envelope: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) {
        return;
      }
      envelope = parsed;
    } catch {
      return;
    }
    const frame = readText(envelope.frame);
    const type = readText(envelope.type);
    if (frame === "response") {
      const id = readText(envelope.id);
      const pending = this.pendingRequests.get(id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      if (envelope.ok === true) {
        pending.resolve(envelope.result);
      } else {
        const error = isRecord(envelope.error) ? envelope.error : {};
        pending.reject(new Error(readText(error.message) || "Enterprise chat request failed."));
      }
      return;
    }
    if (frame !== "push") {
      return;
    }
    const eventId = Math.max(0, Math.trunc(readNumber(envelope.eventId)));
    if (eventId > this.snapshot.latestEventId) {
      this.snapshot.latestEventId = eventId;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    if (type === "sync.ready") {
      this.socketSynced = true;
      this.reconnectAttempt = 0;
      this.updateSnapshot({
        connectionState: "connected",
        message: "",
        latestEventId: Math.max(
          this.snapshot.latestEventId,
          Math.trunc(readNumber(payload.eventId))
        )
      });
      void this.sendWebSocketRequest("device.capabilities.publish", {
        clientKind: "desktop",
        platform: this.platform,
        clientVersion: this.app.getVersion(),
        actions: ENTERPRISE_CHAT_REMOTE_ACTION_NAMES
      }).catch((error) => {
        this.updateSnapshot({ message: errorMessage(error) });
      });
      void this.refreshEmployeeDirectory();
      void this.flushDesktopActionReceipts();
      return;
    }
    if (type === "sync.reset_required") {
      void this.refresh();
      return;
    }
    if (type === "presence.changed") {
      const userRecord = isRecord(payload.user) ? payload.user : {};
      const userId = readText(payload.userId) || readText(userRecord.id);
      const online = typeof payload.online === "boolean"
        ? payload.online
        : typeof userRecord.online === "boolean"
          ? userRecord.online
          : null;
      if (userId && online !== null) {
        const knownUser = this.snapshot.currentUser?.id === userId ||
          this.snapshot.users.some((user) => user.id === userId);
        this.applyPresence(userId, online);
        if (!knownUser) {
          void this.refreshEmployeeDirectory();
        }
      }
      return;
    }
    if (type === "message.created" || type === "message.edited" || type === "message.revoked") {
      const message = normalizeMessage(payload.message);
      if (message.id) {
        this.applyMessage(message);
      }
      void this.refreshConversationSummaries();
      return;
    }
    if (
      type === "conversation.created" ||
      type === "conversation.updated" ||
      type === "member.added" ||
      type === "member.updated" ||
      type === "member.removed" ||
      type === "receipt.read"
    ) {
      void this.refreshConversationSummaries();
    }
  }

  private applyMessage(message: EnterpriseChatMessage) {
    const isActive = this.snapshot.activeConversationId === message.conversationId;
    const conversation = this.snapshot.conversations.find(
      (item) => item.id === message.conversationId
    );
    this.reconcileDesktopActionMessages(
      isActive ? mergeMessage(this.snapshot.activeMessages, message) : [message],
      conversation
    );
    this.updateSnapshot({
      activeMessages: isActive
        ? mergeMessage(this.snapshot.activeMessages, message)
        : this.snapshot.activeMessages,
      conversations: this.snapshot.conversations.map((conversation) =>
        conversation.id === message.conversationId
          ? {
              ...conversation,
              lastSeq: Math.max(conversation.lastSeq, message.seq),
              lastMessage: message,
              updatedAt: message.createdAt,
              unreadCount: message.senderId !== this.snapshot.currentUser?.id && !isActive
                ? conversation.unreadCount + 1
                : conversation.unreadCount
            }
          : conversation
      )
    });
  }

  private applyPresence(userId: string, online: boolean) {
    this.presenceRevision += 1;
    const updateUser = (user: EnterpriseChatUser) =>
      user.id === userId ? { ...user, online } : user;
    this.updateSnapshot({
      currentUser: this.snapshot.currentUser
        ? updateUser(this.snapshot.currentUser)
        : null,
      users: this.snapshot.users.map(updateUser),
      conversations: this.snapshot.conversations.map((conversation) => ({
        ...conversation,
        members: conversation.members.map((member) => ({
          ...member,
          user: updateUser(member.user)
        }))
      }))
    });
  }

  private async refreshConversationSummaries() {
    try {
      const response = await this.requestJson<unknown>("/api/v1/conversations");
      const record = isRecord(response) ? response : {};
      this.updateSnapshot({
        conversations: mergeConversationUsers(
          normalizeConversations(record.items),
          [
            ...(this.snapshot.currentUser ? [this.snapshot.currentUser] : []),
            ...this.snapshot.users
          ]
        )
      });
    } catch {
      // The next durable event or manual refresh will retry the summary projection.
    }
  }

  private async refreshEmployeeDirectory() {
    const revisionAtRequestStart = this.presenceRevision;
    try {
      let users = await this.requestUsers();
      if (this.presenceRevision !== revisionAtRequestStart) {
        const livePresence = new Map(
          [
            ...(this.snapshot.currentUser ? [this.snapshot.currentUser] : []),
            ...this.snapshot.users
          ].map((user) => [user.id, user.online] as const)
        );
        users = users.map((user) =>
          livePresence.has(user.id)
            ? { ...user, online: livePresence.get(user.id) ?? null }
            : user
        );
      }
      const currentUserId = this.snapshot.currentUser?.id ?? "";
      const directoryCurrentUser = users.find((user) => user.id === currentUserId);
      const currentUser = this.snapshot.currentUser && directoryCurrentUser
        ? { ...this.snapshot.currentUser, ...directoryCurrentUser }
        : this.snapshot.currentUser;
      const visibleUsers = users.filter((user) => user.id !== currentUserId);
      this.updateSnapshot({
        currentUser,
        users: visibleUsers,
        conversations: mergeConversationUsers(
          this.snapshot.conversations,
          [
            ...(currentUser ? [currentUser] : []),
            ...visibleUsers
          ]
        )
      });
    } catch {
      // Presence pushes remain usable; the next sync or manual refresh retries the directory.
    }
  }

  private sendWebSocketRequest(type: string, payload: unknown) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error("Enterprise chat connection is unavailable."));
    }
    const id = this.nextRequestId(type);
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("Enterprise chat request timed out."));
      }, ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({
        v: 1,
        frame: "request",
        id,
        type,
        payload
      }));
    });
  }

  private nextRequestId(prefix: string) {
    this.requestSequence += 1;
    return `${prefix}-${Date.now()}-${this.requestSequence}`;
  }

  private updateSnapshot(patch: Partial<EnterpriseChatSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      updatedAt: nowEpochMilliseconds()
    };
    this.onStateChanged?.(this.getState());
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.snapshot.enabled) {
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(
      ENTERPRISE_CHAT_RECONNECT_MAX_MS,
      1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5)
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.refresh();
    }, delay);
  }

  private scheduleSessionRefresh() {
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
    }
    const delay = Math.max(5_000, this.imSessionTokenExpiresAt - Date.now() - 60_000);
    this.sessionRefreshTimer = setTimeout(() => {
      this.sessionRefreshTimer = null;
      void this.refresh();
    }, delay);
  }

  private disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socketClosing = true;
    const socket = this.socket;
    this.socket = null;
    this.socketSynced = false;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      try {
        socket.close();
      } catch {
        // Closing an already-closed WebSocket is harmless.
      }
    }
    this.rejectPendingRequests(new Error("Enterprise chat connection closed."));
  }

  private clearSession() {
    this.imSessionToken = "";
    this.imSessionTokenExpiresAt = 0;
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
      this.sessionRefreshTimer = null;
    }
  }

  private rejectPendingRequests(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

export const __testInternals = {
  normalizeDesktopAction,
  mergeConversationUsers,
  normalizeConversation,
  normalizeMessage,
  normalizeServerUrl,
  normalizeUser,
  toWebSocketUrl
};
