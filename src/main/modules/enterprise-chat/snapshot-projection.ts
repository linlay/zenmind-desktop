import type {
  EnterpriseChatConversation,
  EnterpriseChatMessage,
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../../../shared/contracts";
import { mergeMessage } from "./message-projection";
import { nowEpochMilliseconds } from "./protocol-values";

export interface SnapshotProjectionDependencies {
  snapshot: EnterpriseChatSnapshot;
  projectMessage(message: EnterpriseChatMessage, conversation?: EnterpriseChatConversation): EnterpriseChatMessage;
  desktopActionState(message: EnterpriseChatMessage, conversation?: EnterpriseChatConversation): "pending" | "executing" | "handled" | "not_executable" | undefined;
  reconcileDesktopActionMessages(messages: EnterpriseChatMessage[], conversation?: EnterpriseChatConversation): void;
  updateSnapshot(patch: Partial<EnterpriseChatSnapshot>): void;
  presenceRevision: number;
  readonly onStateChanged?: ((snapshot: EnterpriseChatSnapshot) => void) | undefined;
  getState(): EnterpriseChatSnapshot;
}

export function getState(dependencies: SnapshotProjectionDependencies) {
  return {
    ...dependencies.snapshot,
    currentUser: dependencies.snapshot.currentUser ? { ...dependencies.snapshot.currentUser } : null,
    selfProfile: { ...dependencies.snapshot.selfProfile },
    users: dependencies.snapshot.users.map((user) => ({ ...user })),
    conversations: dependencies.snapshot.conversations.map((conversation) => ({
      ...conversation,
      lastMessage: conversation.lastMessage
        ? dependencies.projectMessage(conversation.lastMessage, conversation)
        : null,
      members: conversation.members.map((member) => ({
        ...member,
        user: { ...member.user }
      }))
    })),
    activeMessages: dependencies.snapshot.activeMessages.map((message) => dependencies.projectMessage(message, dependencies.snapshot.conversations.find((conversation) => conversation.id === message.conversationId)))
  };
}

export function projectMessage(dependencies: SnapshotProjectionDependencies, message: EnterpriseChatMessage, conversation?: EnterpriseChatConversation): EnterpriseChatMessage {
  const desktopActionState = dependencies.desktopActionState(message, conversation);
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

export function applyMessage(dependencies: SnapshotProjectionDependencies, message: EnterpriseChatMessage) {
  const isActive = dependencies.snapshot.activeConversationId === message.conversationId;
  const conversation = dependencies.snapshot.conversations.find((item) => item.id === message.conversationId);
  dependencies.reconcileDesktopActionMessages(isActive ? mergeMessage(dependencies.snapshot.activeMessages, message) : [message], conversation);
  dependencies.updateSnapshot({
    activeMessages: isActive
      ? mergeMessage(dependencies.snapshot.activeMessages, message)
      : dependencies.snapshot.activeMessages,
    conversations: dependencies.snapshot.conversations.map((conversation) => conversation.id === message.conversationId
      ? {
        ...conversation,
        lastSeq: Math.max(conversation.lastSeq, message.seq),
        lastMessage: message,
        updatedAt: message.createdAt,
        unreadCount: message.senderId !== dependencies.snapshot.currentUser?.id && !isActive
          ? conversation.unreadCount + 1
          : conversation.unreadCount
      }
      : conversation)
  });
}

export function applyPresence(dependencies: SnapshotProjectionDependencies, userId: string, online: boolean) {
  dependencies.presenceRevision += 1;
  const updateUser = (user: EnterpriseChatUser) => user.id === userId ? { ...user, online } : user;
  dependencies.updateSnapshot({
    currentUser: dependencies.snapshot.currentUser
      ? updateUser(dependencies.snapshot.currentUser)
      : null,
    users: dependencies.snapshot.users.map(updateUser),
    conversations: dependencies.snapshot.conversations.map((conversation) => ({
      ...conversation,
      members: conversation.members.map((member) => ({
        ...member,
        user: updateUser(member.user)
      }))
    }))
  });
}

export function updateSnapshot(dependencies: SnapshotProjectionDependencies, patch: Partial<EnterpriseChatSnapshot>) {
  dependencies.snapshot = {
    ...dependencies.snapshot,
    ...patch,
    updatedAt: nowEpochMilliseconds()
  };
  dependencies.onStateChanged?.(dependencies.getState());
}
