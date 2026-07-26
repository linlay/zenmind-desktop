import type { EpochMilliseconds } from "../time-contract";

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
  online: boolean | null;
}

export interface EnterpriseChatMember {
  user: EnterpriseChatUser;
  role: string;
  joinedSeq: number;
}

export interface EnterpriseChatMessage {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  clientMessageId: string;
  kind: string;
  body: string;
  createdAt: EpochMilliseconds;
  editedAt?: EpochMilliseconds;
  revokedAt?: EpochMilliseconds;
}

export interface EnterpriseChatConversation {
  id: string;
  type: "direct";
  title: string;
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

export interface EnterpriseChatSendMessageInput {
  conversationId: string;
  clientMessageId: string;
  body: string;
}

export interface EnterpriseChatMarkReadInput {
  conversationId: string;
  seq: number;
}

export type EnterpriseChatSnapshotListener = (snapshot: EnterpriseChatSnapshot) => void;
