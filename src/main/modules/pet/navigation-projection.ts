import { readEpochMillis } from "../../../shared/time-contract";
import type {
  AssistantNavChatItem,
  DesktopPetTaskItem,
  AssistantNavAgentItem,
  DesktopPetMessageStatus,
  DesktopPetMessageItem
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import type { DesktopPetNavigationSnapshotLike } from "./controller-model";

export const DESKTOP_PET_GENERIC_TASK_PREVIEWS = new Set([
  "",
  "思考中",
  "思考中...",
  "正在生成回复",
  "回复生成中",
  "回复已生成",
  "已完成",
  "完成",
  "打开对话查看完整回复"
]);

export function toDesktopPetTaskText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

export function getDesktopPetTaskTimestamp(value: unknown) {
  return readEpochMillis(value) ?? 0;
}

export function getUsableDesktopPetTaskPreview(value: unknown) {
  const preview = toDesktopPetTaskText(value);
  return DESKTOP_PET_GENERIC_TASK_PREVIEWS.has(preview) ? "" : preview;
}

export function resolveDesktopPetTaskTitle(chat: AssistantNavChatItem) {
  return toDesktopPetTaskText(chat.chatName) ||
    getUsableDesktopPetTaskPreview(chat.lastRunContent) ||
    t("desktopPet.task.untitled");
}

export function shouldReplaceDesktopPetTask(existing: DesktopPetTaskItem, next: DesktopPetTaskItem) {
  if (existing.status !== next.status) {
    return next.status === "awaiting";
  }
  return getDesktopPetTaskTimestamp(next.updatedAt) > getDesktopPetTaskTimestamp(existing.updatedAt);
}

export function readDesktopPetAwaitingCount(chat: { awaitingCount?: unknown; hasPendingAwaiting?: unknown }) {
  if (!chat.hasPendingAwaiting) {
    return 0;
  }
  return Math.max(1, Math.round(Number(chat.awaitingCount) || 0));
}

export function readDesktopPetNavigationItems(snapshot: DesktopPetNavigationSnapshotLike | null | undefined) {
  if (!snapshot?.ok) {
    return null;
  }
  return Array.isArray(snapshot.activityItems) ? snapshot.activityItems : snapshot.items;
}

export function createDesktopPetActiveTasksFromNavigationSnapshot(
  snapshot: DesktopPetNavigationSnapshotLike | null | undefined
): DesktopPetTaskItem[] {
  const items = readDesktopPetNavigationItems(snapshot);
  if (!Array.isArray(items)) {
    return [];
  }

  const tasksByChatId = new Map<string, DesktopPetTaskItem>();
  for (const agent of items as AssistantNavAgentItem[]) {
    const agentKey = toDesktopPetTaskText(agent?.agentKey);
    if (!agentKey || !Array.isArray(agent?.recentChats)) {
      continue;
    }
    const agentDisplayName = toDesktopPetTaskText(agent.displayName) || agentKey;
    for (const chat of agent.recentChats) {
      if (!chat?.hasPendingAwaiting && !chat?.hasActiveRun) {
        continue;
      }
      const chatId = toDesktopPetTaskText(chat.chatId);
      if (!chatId) {
        continue;
      }
      const taskAgentKey = toDesktopPetTaskText(chat.agentKey) || agentKey;
      const status = chat.hasPendingAwaiting ? "awaiting" : "running";
      const updatedAt = readEpochMillis(chat.updatedAt) ?? readEpochMillis(agent.updatedAt);
      if (updatedAt === undefined) {
        continue;
      }
      const awaitingCount = readDesktopPetAwaitingCount(chat);
      const task: DesktopPetTaskItem = {
        id: `${taskAgentKey}:${chatId}`,
        agentKey: taskAgentKey,
        agentDisplayName,
        chatId,
        runId: toDesktopPetTaskText(chat.lastRunId) || null,
        title: resolveDesktopPetTaskTitle(chat),
        preview: getUsableDesktopPetTaskPreview(chat.lastRunContent),
        status,
        ...(awaitingCount > 0 ? { awaitingCount } : {}),
        ...(chat.awaitingMode ? { awaitingMode: chat.awaitingMode } : {}),
        updatedAt
      };
      const existingTask = tasksByChatId.get(chatId);
      if (!existingTask || shouldReplaceDesktopPetTask(existingTask, task)) {
        tasksByChatId.set(chatId, task);
      }
    }
  }

  return [...tasksByChatId.values()].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "awaiting" ? -1 : 1;
    }
    const timeDelta = getDesktopPetTaskTimestamp(right.updatedAt) - getDesktopPetTaskTimestamp(left.updatedAt);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return left.title.localeCompare(right.title, "zh-CN");
  });
}

export function resolveDesktopPetMessageStatus(chat: AssistantNavChatItem): DesktopPetMessageStatus {
  if (chat.hasPendingAwaiting) {
    return "awaiting";
  }
  if (chat.hasActiveRun) {
    return "running";
  }
  return "done";
}

export const DESKTOP_PET_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const DESKTOP_PET_MESSAGE_LIMIT = 50;

export function isDesktopPetMessageRecent(updatedAt: number, now = Date.now()) {
  return updatedAt >= now - DESKTOP_PET_MESSAGE_RETENTION_MS;
}

export function createDesktopPetMessagesFromNavigationSnapshot(
  snapshot: DesktopPetNavigationSnapshotLike | null | undefined
): DesktopPetMessageItem[] {
  const items = readDesktopPetNavigationItems(snapshot);
  if (!Array.isArray(items)) {
    return [];
  }
  const messagesByChatId = new Map<string, DesktopPetMessageItem>();
  for (const agent of items as AssistantNavAgentItem[]) {
    const agentKey = toDesktopPetTaskText(agent?.agentKey);
    if (!agentKey || !Array.isArray(agent?.recentChats)) {
      continue;
    }
    const agentDisplayName = toDesktopPetTaskText(agent.displayName) || agentKey;
    for (const chat of agent.recentChats) {
      const chatId = toDesktopPetTaskText(chat.chatId);
      if (!chatId) {
        continue;
      }
      const unread = chat.isRead === false;
      const status = resolveDesktopPetMessageStatus(chat);
      if (!unread && status !== "awaiting") {
        continue;
      }
      if (!toDesktopPetTaskText(chat.lastRunContent) && !chat.hasActiveRun && !chat.hasPendingAwaiting) {
        continue;
      }
      const messageAgentKey = toDesktopPetTaskText(chat.agentKey) || agentKey;
      const updatedAt = readEpochMillis(chat.updatedAt) ?? readEpochMillis(agent.updatedAt);
      if (updatedAt === undefined || !isDesktopPetMessageRecent(updatedAt)) {
        continue;
      }
      const awaitingCount = readDesktopPetAwaitingCount(chat);
      const message: DesktopPetMessageItem = {
        id: `${messageAgentKey}:${chatId}`,
        chatId,
        runId: toDesktopPetTaskText(chat.lastRunId) || null,
        agentKey: messageAgentKey,
        agentDisplayName,
        title: resolveDesktopPetTaskTitle(chat),
        preview: getUsableDesktopPetTaskPreview(chat.lastRunContent),
        status,
        unread,
        ...(awaitingCount > 0 ? { awaitingCount } : {}),
        ...(chat.awaitingMode ? { awaitingMode: chat.awaitingMode } : {}),
        updatedAt
      };
      const existing = messagesByChatId.get(chatId);
      if (!existing || getDesktopPetTaskTimestamp(message.updatedAt) > getDesktopPetTaskTimestamp(existing.updatedAt)) {
        messagesByChatId.set(chatId, message);
      }
    }
  }
  return [...messagesByChatId.values()].sort((left, right) => {
    if (left.unread !== right.unread) {
      return left.unread ? -1 : 1;
    }
    const timeDelta = getDesktopPetTaskTimestamp(right.updatedAt) - getDesktopPetTaskTimestamp(left.updatedAt);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return left.title.localeCompare(right.title, "zh-CN");
  }).slice(0, DESKTOP_PET_MESSAGE_LIMIT);
}
