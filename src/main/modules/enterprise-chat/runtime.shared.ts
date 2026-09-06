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
  EnterpriseChatSendRawAgentChatInput,
  EnterpriseChatScreenshotMode,
  EnterpriseChatSendScreenshotInput,
  EnterpriseChatSendSupportBundleInput,
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../../../shared/contracts";

import {
  ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES,
  ENTERPRISE_CHAT_MAX_PASTED_FILES
} from "../../../shared/contracts/enterprise-chat";

import {
  ENTERPRISE_CHAT_REMOTE_ACTION_NAMES,
  getEnterpriseChatRemoteAction
} from "../../../shared/enterprise-chat-actions";

import type { DesktopActionCallResponse } from "../../../shared/desktop-actions";

import type { EpochMilliseconds } from "../../../shared/time-contract";

import { getDesktopDeviceInfo } from "../identity";

import {
  EnterpriseChatActionLedger,
  enterpriseChatActionScope,
  type EnterpriseChatActionLedgerEntry
} from "./action-ledger";

import {
  clearEnterpriseChatAvatar,
  readEnterpriseChatSelfProfile,
  saveEnterpriseChatAvatar,
  saveEnterpriseChatMotto
} from "./local-profile";

import { createEnterpriseChatSupportBundle } from "./support-bundle";

import {
  DEFAULT_ENTERPRISE_IM_BASE_URL,
  normalizeEnterpriseImBaseUrl
} from "./settings";

import { t } from "../../support/i18n/main-i18n";

import { getDesktopSsoAccessToken } from "../identity";

export const ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS = 15_000;

export const ENTERPRISE_CHAT_RECONNECT_MAX_MS = 30_000;

export const ENTERPRISE_CHAT_INLINE_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

export const ENTERPRISE_CHAT_DOWNLOAD_MAX_BYTES = 110 * 1024 * 1024;

export const ENTERPRISE_CHAT_RAW_AGENT_CHAT_MAX_BYTES = 100 * 1024 * 1024;

export const ENTERPRISE_CHAT_MAX_SELECTED_FILES = 10;

export type EnterpriseChatRawAgentChatData = {
  filename: string;
  bytes: Uint8Array;
};

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export type WebSocketMessageEventLike = { data: unknown };

export type WebSocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: () => void;
};

export type PendingWebSocketRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type EnterpriseChatRuntimeOptions = {
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
  showSaveDialog?: (options: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled?: boolean; filePath?: string }>;
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

export type ServerSession = {
  token: string;
  expiresAt: number;
  user: EnterpriseChatUser;
};

export type ServerBootstrap = {
  user: EnterpriseChatUser;
  conversations: EnterpriseChatConversation[];
  latestEventId: number;
};

export class EnterpriseChatRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readEpochMilliseconds(value: unknown): EpochMilliseconds {
  return Math.max(0, Math.trunc(readNumber(value))) as EpochMilliseconds;
}

export function readOnline(value: Record<string, unknown>) {
  if (value.alwaysOnline === true) {
    return true;
  }
  if (typeof value.online === "boolean") {
    return value.online;
  }
  // `status=active` is an account state, not a live connection signal.
  return null;
}

export function normalizeUser(value: unknown): EnterpriseChatUser {
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

export function normalizeAttachment(value: unknown): EnterpriseChatAttachment | null {
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

export function localizedDesktopActionSummary(
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

export function normalizeDesktopAction(value: unknown): EnterpriseChatDesktopAction | undefined {
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

export function normalizeDesktopActionResult(value: unknown): EnterpriseChatDesktopActionResult | undefined {
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

export function normalizeMessage(value: unknown): EnterpriseChatMessage {
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

export function normalizeConversation(value: unknown): EnterpriseChatConversation | null {
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

export function normalizeConversations(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeConversation).filter((item): item is EnterpriseChatConversation => item !== null)
    : [];
}

export function mergeConversationUsers(
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

export function normalizeMessages(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeMessage).filter((item) => item.id && item.conversationId)
    : [];
}

export function normalizeServerUrl(value: string | undefined) {
  const normalized = normalizeEnterpriseImBaseUrl(readText(value) || DEFAULT_ENTERPRISE_IM_BASE_URL);
  if (!normalized) {
    throw new Error("IM server base URL must use loopback HTTP or remote HTTPS.");
  }
  return normalized;
}

export function toWebSocketUrl(serverUrl: string, ticket: string) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/ws`;
  url.search = "";
  url.searchParams.set("v", "1");
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export function createDefaultWebSocket(url: string): WebSocketLike {
  const WebSocketConstructor = (
    globalThis as unknown as { WebSocket?: new (targetUrl: string) => WebSocketLike }
  ).WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("This Desktop runtime does not provide WebSocket support.");
  }
  return new WebSocketConstructor(url);
}

export function nowEpochMilliseconds() {
  return Date.now() as EpochMilliseconds;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function readWebSocketText(data: unknown) {
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

export function mergeMessage(messages: EnterpriseChatMessage[], message: EnterpriseChatMessage) {
  const next = messages.filter((item) => item.id !== message.id);
  next.push(message);
  return next.sort((left, right) => left.seq - right.seq);
}

export function contentTypeForFile(filePath: string) {
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

export function safeDownloadName(value: string, platform: NodeJS.Platform) {
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

export function safeRawAgentChatFilename(
  chatName: string,
  chatId: string,
  platform: NodeJS.Platform
) {
  const source = (chatName.trim() || chatId).replace(/\.jsonl$/iu, "").slice(0, 180);
  const stem = source.replace(/[\\/]+/gu, "_").trim() || chatId;
  return safeDownloadName(`${stem}.jsonl`, platform);
}

export interface EnterpriseChatRuntimeMethodContext {
  app: Electron.App;
  serverUrl: string;
  getServerUrl: () => string;
  fetchImpl: FetchLike;
  createWebSocket: (url: string) => WebSocketLike;
  getIdentityToken: () => string | null;
  refreshIdentityToken?: (() => Promise<string | null>) | undefined;
  getDeviceInfo: () => { deviceId: string; deviceName: string; };
  platform: NodeJS.Platform;
  selectFiles: () => Promise<string[]>;
  selectAvatar: () => Promise<string[]>;
  showSaveDialog?: ((options: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[]; }>; }) => Promise<{ canceled?: boolean; filePath?: string; }>) | undefined;
  createSupportBundle: () => Promise<{ filename: string; bytes: Buffer; }>;
  captureScreenshot?: ((mode: EnterpriseChatScreenshotMode) => Promise<{ ok: boolean; message?: string; dataBase64?: string; mimeType?: string; cancelled?: boolean; }>) | undefined;
  createSupportArtifact?: ((action: string, args: Record<string, unknown>) => Promise<{ filename: string; contentType: string; bytes: Buffer; }>) | undefined;
  executeDesktopAction?: ((request: EnterpriseChatDesktopAction & { messageId: string; conversationId: string; senderId: string; }) => Promise<{ response?: DesktopActionCallResponse; message: string; }>) | undefined;
  onStateChanged?: ((snapshot: EnterpriseChatSnapshot) => void) | undefined;
  snapshot: EnterpriseChatSnapshot;
  imSessionToken: string;
  imSessionTokenExpiresAt: number;
  socket: WebSocketLike | null;
  socketSynced: boolean;
  socketClosing: boolean;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  sessionRefreshTimer: NodeJS.Timeout | null;
  requestSequence: number;
  presenceRevision: number;
  desktopActionLedger: EnterpriseChatActionLedger | null;
  desktopActionLedgerPath: string;
  recoveredDesktopActionScopes: Set<string>;
  actionReceiptFlushPromise: Promise<void> | null;
  pendingRequests: Map<string, PendingWebSocketRequest>;
  refreshPromise: Promise<EnterpriseChatSnapshot> | null;
  getState(): { currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; };
  currentDesktopActionScope(): string;
  getDesktopActionLedger(): EnterpriseChatActionLedger | null;
  desktopActionState(message: EnterpriseChatMessage, conversation?: EnterpriseChatConversation): "pending" | "executing" | "handled" | "not_executable" | undefined;
  projectMessage(message: EnterpriseChatMessage, conversation?: EnterpriseChatConversation): EnterpriseChatMessage;
  setEnabled(enabled: boolean): Promise<EnterpriseChatSnapshot>;
  refresh(): Promise<EnterpriseChatSnapshot>;
  reloadConfiguration(enabled: boolean): Promise<EnterpriseChatSnapshot>;
  performRefresh(): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  updateServerUrl(): void;
  openDirectConversation(input: EnterpriseChatOpenDirectInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  openConversation(input: EnterpriseChatOpenConversationInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  createGroup(input: EnterpriseChatCreateGroupInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  sendMessage(input: EnterpriseChatSendMessageInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  sendFiles(input: EnterpriseChatSendFilesInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  sendSupportBundle(input: EnterpriseChatSendSupportBundleInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  sendRawAgentChat(input: EnterpriseChatSendRawAgentChatInput, rawChat: EnterpriseChatRawAgentChatData): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  saveSelfProfile(input: EnterpriseChatSaveSelfProfileInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  selectSelfAvatar(): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  clearSelfAvatar(): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  sendPastedFiles(input: EnterpriseChatSendPastedFilesInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  sendScreenshot(input: EnterpriseChatSendScreenshotInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  loadAttachment(input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatAttachmentData>;
  downloadAttachment(input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatDownloadResult>;
  executeMessageDesktopAction(input: EnterpriseChatExecuteActionInput): Promise<EnterpriseChatExecuteActionResult>;
  handledDesktopActionResult(entry?: EnterpriseChatActionLedgerEntry): EnterpriseChatExecuteActionResult;
  notExecutableDesktopActionResult(message?: string): EnterpriseChatExecuteActionResult;
  createRemoteSupportAttachment(request: EnterpriseChatDesktopAction): Promise<string[]>;
  deliverDesktopActionReceipt(entry: EnterpriseChatActionLedgerEntry): Promise<boolean>;
  flushDesktopActionReceipts(): Promise<void>;
  reconcileDesktopActionMessages(messages: EnterpriseChatMessage[], conversation?: EnterpriseChatConversation): void;
  sendMessagePayload(input: {
    conversationId: string;
    clientMessageId: string;
    body: string;
    fileIds: string[];
    replyToId?: string;
    kind?: string;
    desktopAction?: Record<string, unknown>;
  }): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  assertMessageSendReady(): void;
  markRead(input: EnterpriseChatMarkReadInput): Promise<{ currentUser: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; } | null; selfProfile: { motto: string; avatarDataUrl: string; hasCustomAvatar: boolean; }; users: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }[]; conversations: { lastMessage: EnterpriseChatMessage | null; members: { user: { id: string; displayName: string; email: string; avatarUrl: string; status: string; kind: "employee" | "service_bot"; alwaysOnline: boolean; online: boolean | null; }; role: string; joinedSeq: number; }[]; id: string; type: "direct" | "group"; title: string; createdBy: string; role: string; lastReadSeq: number; lastSeq: number; unreadCount: number; createdAt: EpochMilliseconds; updatedAt: EpochMilliseconds; }[]; activeMessages: EnterpriseChatMessage[]; enabled: boolean; connectionState: EnterpriseChatConnectionState; message: string; serverUrl: string; activeConversationId: string; latestEventId: number; updatedAt: EpochMilliseconds; }>;
  handleSignedOut(): void;
  stop(): void;
  ensureSession(): Promise<void>;
  uploadFilePath(filePath: string): Promise<EnterpriseChatAttachment>;
  uploadBlob(blob: Blob, filename: string): Promise<EnterpriseChatAttachment>;
  fetchAttachment(fileId: string, maxBytes: number): Promise<{ buffer: Buffer<ArrayBuffer>; contentType: string; }>;
  exchangeSession(identityToken: string): Promise<ServerSession>;
  requestBootstrap(): Promise<ServerBootstrap>;
  requestUsers(): Promise<EnterpriseChatUser[]>;
  requestJson<T>(path: string, init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    }, useImSessionToken?: boolean): Promise<T>;
  connectWebSocket(): Promise<void>;
  handleWebSocketMessage(data: unknown): Promise<void>;
  applyMessage(message: EnterpriseChatMessage): void;
  applyPresence(userId: string, online: boolean): void;
  refreshConversationSummaries(): Promise<void>;
  refreshEmployeeDirectory(): Promise<void>;
  sendWebSocketRequest(type: string, payload: unknown): Promise<unknown>;
  nextRequestId(prefix: string): string;
  updateSnapshot(patch: Partial<EnterpriseChatSnapshot>): void;
  scheduleReconnect(): void;
  scheduleSessionRefresh(): void;
  disconnect(): void;
  clearSession(): void;
  rejectPendingRequests(error: Error): void;
}
