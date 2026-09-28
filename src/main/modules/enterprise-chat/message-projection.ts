import type {
  EnterpriseChatAttachment,
  EnterpriseChatConversation,
  EnterpriseChatDesktopAction,
  EnterpriseChatDesktopActionResult,
  EnterpriseChatDesktopActionStatus,
  EnterpriseChatMessage,
  EnterpriseChatUser
} from "../../../shared/contracts";
import {
  getEnterpriseChatRemoteAction
} from "../../../shared/enterprise-chat-actions";
import { t } from "../../support/i18n/main-i18n";
import { isRecord, readEpochMilliseconds, readNumber, readText } from "./protocol-values";

export type ServerBootstrap = {
  user: EnterpriseChatUser;
  conversations: EnterpriseChatConversation[];
  latestEventId: number;
};

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

export function mergeMessage(messages: EnterpriseChatMessage[], message: EnterpriseChatMessage) {
  const next = messages.filter((item) => item.id !== message.id);
  next.push(message);
  return next.sort((left, right) => left.seq - right.seq);
}
