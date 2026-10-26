import { readEpochMillis } from "../../../shared/time-contract";
import { collectAssistantNavigationOverviewChats } from "../../../shared/assistant-navigation-attention";
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

export function createDesktopPetMessagesFromNavigationSnapshot(
  snapshot: DesktopPetNavigationSnapshotLike | null | undefined
): DesktopPetMessageItem[] {
  if (!snapshot?.ok) {
    return [];
  }
  const items: AssistantNavAgentItem[] = Array.isArray(snapshot.items) ? snapshot.items : [];
  const activityItems: AssistantNavAgentItem[] = Array.isArray(snapshot.activityItems) ? snapshot.activityItems : [];
  const agentsByKey = new Map([...items, ...activityItems].map((agent) => [agent.agentKey, agent]));
  const chats = collectAssistantNavigationOverviewChats({
    items,
    activityItems,
    chatItems: Array.isArray(snapshot.chatItems) ? snapshot.chatItems : [],
    pinnedChatItems: Array.isArray(snapshot.pinnedChatItems) ? snapshot.pinnedChatItems : [],
  });
  return chats.map((chat): DesktopPetMessageItem => {
    const agent = agentsByKey.get(chat.agentKey);
    const awaitingCount = readDesktopPetAwaitingCount(chat);
    return {
      id: `${chat.agentKey}:${chat.chatId}`,
      chatId: chat.chatId,
      runId: toDesktopPetTaskText(chat.lastRunId) || null,
      agentKey: chat.agentKey,
      agentDisplayName: toDesktopPetTaskText(agent?.displayName) || chat.agentKey,
      title: resolveDesktopPetTaskTitle(chat),
      preview: getUsableDesktopPetTaskPreview(chat.lastRunContent),
      status: resolveDesktopPetMessageStatus(chat),
      unread: chat.isRead === false,
      ...(awaitingCount > 0 ? { awaitingCount } : {}),
      ...(chat.awaitingMode ? { awaitingMode: chat.awaitingMode } : {}),
      updatedAt: readEpochMillis(chat.updatedAt) ?? readEpochMillis(agent?.updatedAt) ?? 0,
    };
  }).sort((left, right) => {
    const awaitingPriority = Number(right.status === "awaiting") - Number(left.status === "awaiting");
    if (awaitingPriority !== 0) {
      return awaitingPriority;
    }
    const timeDelta = getDesktopPetTaskTimestamp(right.updatedAt) - getDesktopPetTaskTimestamp(left.updatedAt);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return left.title.localeCompare(right.title, "zh-CN");
  });
}
