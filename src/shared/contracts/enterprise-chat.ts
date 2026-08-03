import type { EpochMilliseconds } from "../time-contract";
import type { DesktopActionCallResponse } from "../desktop-actions";

export const ENTERPRISE_CHAT_DESKTOP_ACTION_PREFIX = "zenmind-desktop-action:v1\n";
export const ENTERPRISE_CHAT_MAX_PASTED_FILES = 10;
export const ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES = 32 * 1024 * 1024;

export type EnterpriseChatConnectionState =
  | "disabled"
  | "signed_out"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface EnterpriseChatUser {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string;
  status: string;
  kind: "employee" | "service_bot";
  alwaysOnline: boolean;
  online: boolean | null;
}

export interface EnterpriseChatSelfProfile {
  motto: string;
  avatarDataUrl: string;
  hasCustomAvatar: boolean;
}

export interface EnterpriseChatMember {
  user: EnterpriseChatUser;
  role: string;
  joinedSeq: number;
}

export interface EnterpriseChatAttachment {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: EpochMilliseconds;
}

export interface EnterpriseChatDesktopAction {
  action: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface EnterpriseChatMessage {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  clientMessageId: string;
  kind: string;
  body: string;
  attachments: EnterpriseChatAttachment[];
  desktopAction?: EnterpriseChatDesktopAction;
  createdAt: EpochMilliseconds;
  editedAt?: EpochMilliseconds;
  revokedAt?: EpochMilliseconds;
}

export interface EnterpriseChatConversation {
  id: string;
  type: "direct" | "group";
  title: string;
  createdBy: string;
  role: string;
  lastReadSeq: number;
  lastSeq: number;
  unreadCount: number;
  lastMessage: EnterpriseChatMessage | null;
  members: EnterpriseChatMember[];
  createdAt: EpochMilliseconds;
  updatedAt: EpochMilliseconds;
}

export interface EnterpriseChatSnapshot {
  enabled: boolean;
  connectionState: EnterpriseChatConnectionState;
  message: string;
  serverUrl: string;
  currentUser: EnterpriseChatUser | null;
  selfProfile: EnterpriseChatSelfProfile;
  users: EnterpriseChatUser[];
  conversations: EnterpriseChatConversation[];
  activeConversationId: string;
  activeMessages: EnterpriseChatMessage[];
  latestEventId: number;
  updatedAt: EpochMilliseconds;
}

export interface EnterpriseChatOpenDirectInput {
  userId: string;
}

export interface EnterpriseChatOpenConversationInput {
  conversationId: string;
}

export interface EnterpriseChatCreateGroupInput {
  title: string;
  memberIds: string[];
}

export interface EnterpriseChatSendMessageInput {
  conversationId: string;
  clientMessageId: string;
  body?: string;
}

export interface EnterpriseChatSendFilesInput {
  conversationId: string;
  clientMessageId: string;
}

export interface EnterpriseChatSendSupportBundleInput {
  conversationId: string;
  clientMessageId: string;
}

export interface EnterpriseChatSaveSelfProfileInput {
  motto: string;
}

export interface EnterpriseChatPastedFile {
  name: string;
  contentType: string;
  sizeBytes: number;
  dataBase64: string;
}

export interface EnterpriseChatSendPastedFilesInput {
  conversationId: string;
  clientMessageId: string;
  files: EnterpriseChatPastedFile[];
}

export type EnterpriseChatScreenshotMode = "region" | "window" | "desktop";

export interface EnterpriseChatSendScreenshotInput {
  conversationId: string;
  clientMessageId: string;
  mode: EnterpriseChatScreenshotMode;
}

export interface EnterpriseChatAttachmentInput {
  fileId: string;
  name?: string;
  contentType?: string;
}

export interface EnterpriseChatAttachmentData {
  fileId: string;
  contentType: string;
  sizeBytes: number;
  dataBase64: string;
}

export interface EnterpriseChatDownloadResult {
  ok: boolean;
  path: string;
  message: string;
}

export interface EnterpriseChatExecuteActionInput {
  messageId: string;
  confirmed: true;
}

export interface EnterpriseChatExecuteActionResult {
  confirmed: boolean;
  response?: DesktopActionCallResponse;
  message: string;
}

export interface EnterpriseChatMarkReadInput {
  conversationId: string;
  seq: number;
}

export type EnterpriseChatSnapshotListener = (snapshot: EnterpriseChatSnapshot) => void;
