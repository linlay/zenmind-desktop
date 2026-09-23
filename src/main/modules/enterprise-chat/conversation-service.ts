import type {
  EnterpriseChatConversation,
  EnterpriseChatCreateGroupInput,
  EnterpriseChatMarkReadInput,
  EnterpriseChatMessage,
  EnterpriseChatOpenConversationInput,
  EnterpriseChatOpenDirectInput,
  EnterpriseChatSendMessageInput,
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../../../shared/contracts";
import { WebSocketLike } from "./connection-transport";
import { mergeConversationUsers, normalizeConversation, normalizeConversations, normalizeMessage, normalizeMessages } from "./message-projection";
import { isRecord, readNumber, readText } from "./protocol-values";

export interface ConversationServiceDependencies {
  readonly snapshot: EnterpriseChatSnapshot;
  ensureSession(): Promise<void>;
  requestJson<T>(path: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }, useImSessionToken?: boolean): Promise<T>;
  openConversation(input: EnterpriseChatOpenConversationInput): Promise<EnterpriseChatSnapshot>;
  reconcileDesktopActionMessages(messages: EnterpriseChatMessage[], conversation?: EnterpriseChatConversation): void;
  updateSnapshot(patch: Partial<EnterpriseChatSnapshot>): void;
  flushDesktopActionReceipts(): Promise<void>;
  markRead(input: EnterpriseChatMarkReadInput): Promise<EnterpriseChatSnapshot>;
  getState(): EnterpriseChatSnapshot;
  sendMessagePayload(input: {
    conversationId: string;
    clientMessageId: string;
    body: string;
    fileIds: string[];
    replyToId?: string;
    kind?: string;
    desktopAction?: Record<string, unknown>;
  }): Promise<EnterpriseChatSnapshot>;
  assertMessageSendReady(): void;
  sendWebSocketRequest(type: string, payload: unknown): Promise<unknown>;
  applyMessage(message: EnterpriseChatMessage): void;
  readonly socket: WebSocketLike | null;
  readonly socketSynced: boolean;
  readonly presenceRevision: number;
  requestUsers(): Promise<EnterpriseChatUser[]>;
}

export async function openDirectConversation(dependencies: ConversationServiceDependencies, input: EnterpriseChatOpenDirectInput) {
  const userId = readText(input?.userId);
  if (!userId || userId === dependencies.snapshot.currentUser?.id) {
    throw new Error("A different enterprise employee is required.");
  }
  await dependencies.ensureSession();
  let conversation = dependencies.snapshot.conversations.find((item) => item.type === "direct" &&
    item.members.some((member) => member.user.id === userId));
  if (!conversation) {
    const created = await dependencies.requestJson<unknown>("/api/v1/conversations", {
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
    dependencies.snapshot.conversations = [
      conversation,
      ...dependencies.snapshot.conversations.filter((item) => item.id !== conversation?.id)
    ];
  }
  return dependencies.openConversation({ conversationId: conversation.id });
}

export async function openConversation(dependencies: ConversationServiceDependencies, input: EnterpriseChatOpenConversationInput) {
  const conversationId = readText(input?.conversationId);
  if (!conversationId) {
    throw new Error("conversationId is required.");
  }
  await dependencies.ensureSession();
  let conversation = dependencies.snapshot.conversations.find((item) => item.id === conversationId);
  if (!conversation) {
    const response = await dependencies.requestJson<unknown>(`/api/v1/conversations/${encodeURIComponent(conversationId)}`);
    conversation = normalizeConversation(response) ?? undefined;
  }
  if (!conversation) {
    throw new Error("The IM server returned an invalid conversation.");
  }
  [conversation] = mergeConversationUsers([conversation], [
    ...(dependencies.snapshot.currentUser ? [dependencies.snapshot.currentUser] : []),
    ...dependencies.snapshot.users
  ]);
  const response = await dependencies.requestJson<unknown>(`/api/v1/conversations/${encodeURIComponent(conversation.id)}/messages?limit=50`);
  const record = isRecord(response) ? response : {};
  const messages = normalizeMessages(record.items);
  dependencies.reconcileDesktopActionMessages(messages, conversation);
  dependencies.updateSnapshot({
    conversations: [
      conversation,
      ...dependencies.snapshot.conversations.filter((item) => item.id !== conversation?.id)
    ],
    activeConversationId: conversation.id,
    activeMessages: messages,
    message: ""
  });
  void dependencies.flushDesktopActionReceipts();
  if (conversation.lastSeq > conversation.lastReadSeq) {
    await dependencies.markRead({ conversationId: conversation.id, seq: conversation.lastSeq });
  }
  return dependencies.getState();
}

export async function createGroup(dependencies: ConversationServiceDependencies, input: EnterpriseChatCreateGroupInput) {
  const title = readText(input?.title);
  const currentUserId = dependencies.snapshot.currentUser?.id ?? "";
  const memberIds = Array.from(new Set(Array.isArray(input?.memberIds)
    ? input.memberIds.map(readText).filter((id) => id && id !== currentUserId)
    : []));
  if (!title || memberIds.length === 0) {
    throw new Error("A group title and at least one other member are required.");
  }
  await dependencies.ensureSession();
  const created = await dependencies.requestJson<unknown>("/api/v1/conversations", {
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
  [conversation] = mergeConversationUsers([conversation], [
    ...(dependencies.snapshot.currentUser ? [dependencies.snapshot.currentUser] : []),
    ...dependencies.snapshot.users
  ]);
  dependencies.updateSnapshot({
    conversations: [
      conversation,
      ...dependencies.snapshot.conversations.filter((item) => item.id !== conversation.id)
    ]
  });
  return dependencies.openConversation({ conversationId: conversation.id });
}

export async function sendMessage(dependencies: ConversationServiceDependencies, input: EnterpriseChatSendMessageInput) {
  const conversationId = readText(input?.conversationId);
  const clientMessageId = readText(input?.clientMessageId);
  const body = readText(input?.body);
  if (!conversationId || !clientMessageId || !body) {
    throw new Error("conversationId, clientMessageId, and body are required.");
  }
  return dependencies.sendMessagePayload({
    conversationId,
    clientMessageId,
    body,
    fileIds: []
  });
}

export async function sendMessagePayload(dependencies: ConversationServiceDependencies, input: {
  conversationId: string;
  clientMessageId: string;
  body: string;
  fileIds: string[];
  replyToId?: string;
  kind?: string;
  desktopAction?: Record<string, unknown>;
}) {
  dependencies.assertMessageSendReady();
  const result = await dependencies.sendWebSocketRequest("message.send", {
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
    dependencies.applyMessage(message);
  }
  return dependencies.getState();
}

export function assertMessageSendReady(dependencies: ConversationServiceDependencies) {
  if (!dependencies.socket || !dependencies.socketSynced || dependencies.socket.readyState !== 1) {
    throw new Error("Enterprise chat is reconnecting. Try again in a moment.");
  }
}

export async function markRead(dependencies: ConversationServiceDependencies, input: EnterpriseChatMarkReadInput) {
  const conversationId = readText(input?.conversationId);
  const seq = Math.max(0, Math.trunc(readNumber(input?.seq)));
  if (!conversationId || seq <= 0) {
    return dependencies.getState();
  }
  if (dependencies.socket && dependencies.socketSynced && dependencies.socket.readyState === 1) {
    await dependencies.sendWebSocketRequest("receipt.read", { conversationId, seq });
  }
  dependencies.updateSnapshot({
    conversations: dependencies.snapshot.conversations.map((conversation) => conversation.id === conversationId
      ? {
        ...conversation,
        lastReadSeq: Math.max(conversation.lastReadSeq, seq),
        unreadCount: 0
      }
      : conversation)
  });
  return dependencies.getState();
}

export async function refreshConversationSummaries(dependencies: ConversationServiceDependencies) {
  try {
    const response = await dependencies.requestJson<unknown>("/api/v1/conversations");
    const record = isRecord(response) ? response : {};
    dependencies.updateSnapshot({
      conversations: mergeConversationUsers(normalizeConversations(record.items), [
        ...(dependencies.snapshot.currentUser ? [dependencies.snapshot.currentUser] : []),
        ...dependencies.snapshot.users
      ])
    });
  }
  catch {
    // The next durable event or manual refresh will retry the summary projection.
  }
}

export async function refreshEmployeeDirectory(dependencies: ConversationServiceDependencies) {
  const revisionAtRequestStart = dependencies.presenceRevision;
  try {
    let users = await dependencies.requestUsers();
    if (dependencies.presenceRevision !== revisionAtRequestStart) {
      const livePresence = new Map([
        ...(dependencies.snapshot.currentUser ? [dependencies.snapshot.currentUser] : []),
        ...dependencies.snapshot.users
      ].map((user) => [user.id, user.online] as const));
      users = users.map((user) => livePresence.has(user.id)
        ? { ...user, online: livePresence.get(user.id) ?? null }
        : user);
    }
    const currentUserId = dependencies.snapshot.currentUser?.id ?? "";
    const directoryCurrentUser = users.find((user) => user.id === currentUserId);
    const currentUser = dependencies.snapshot.currentUser && directoryCurrentUser
      ? { ...dependencies.snapshot.currentUser, ...directoryCurrentUser }
      : dependencies.snapshot.currentUser;
    const visibleUsers = users.filter((user) => user.id !== currentUserId);
    dependencies.updateSnapshot({
      currentUser,
      users: visibleUsers,
      conversations: mergeConversationUsers(dependencies.snapshot.conversations, [
        ...(currentUser ? [currentUser] : []),
        ...visibleUsers
      ])
    });
  }
  catch {
    // Presence pushes remain usable; the next sync or manual refresh retries the directory.
  }
}
