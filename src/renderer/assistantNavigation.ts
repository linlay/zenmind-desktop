import type {
  AssistantNavAgentItem,
  AssistantNavAgentItemsResult,
  AssistantNavChatItem
} from "../shared/contracts";

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function toAwaitingMode(value: unknown): AssistantNavChatItem["awaitingMode"] {
  const mode = toText(value).toLowerCase();
  return mode === "approval" ||
    mode === "question" ||
    mode === "form" ||
    mode === "plan"
    ? mode
    : undefined;
}

function normalizeAssistantNavChat(value: unknown, fallbackAgentKey: string): AssistantNavChatItem | null {
  const record = asRecord(value);
  const chatId = toText(record.chatId);
  if (!chatId) {
    return null;
  }

  return {
    chatId,
    chatName: toText(record.chatName),
    agentKey: toText(record.agentKey) || fallbackAgentKey,
    updatedAt: toText(record.updatedAt),
    lastRunId: toText(record.lastRunId),
    lastRunContent: toText(record.lastRunContent),
    isRead: record.isRead !== false,
    hasActiveRun: record.hasActiveRun === true,
    hasPendingAwaiting: record.hasPendingAwaiting === true,
    awaitingMode: toAwaitingMode(record.awaitingMode)
  };
}

export function normalizeAssistantNavAgent(value: unknown): AssistantNavAgentItem | null {
  const record = asRecord(value);
  const agentKey = toText(record.agentKey);
  const displayName = toText(record.displayName) || agentKey;
  if (!agentKey || !displayName) {
    return null;
  }

  const recentChats = Array.isArray(record.recentChats)
    ? record.recentChats
      .map((chat) => normalizeAssistantNavChat(chat, agentKey))
      .filter((chat): chat is AssistantNavChatItem => Boolean(chat))
    : [];
  const unreadCount = toNonNegativeInteger(record.unreadCount);
  const unreadChatCount = toNonNegativeInteger(record.unreadChatCount);
  const chatCount = Math.max(toNonNegativeInteger(record.chatCount), recentChats.length);
  const latestChat = recentChats[0] ?? null;
  const latestChatId = toText(record.latestChatId) || latestChat?.chatId || null;

  return {
    agentKey,
    displayName,
    role: toText(record.role),
    ...(record.icon === undefined ? {} : { icon: record.icon as AssistantNavAgentItem["icon"] }),
    unreadCount: Math.max(unreadCount, unreadChatCount),
    unreadChatCount: Math.max(unreadChatCount, unreadCount),
    chatCount,
    hasPendingAwaiting: record.hasPendingAwaiting === true || recentChats.some((chat) => chat.hasPendingAwaiting),
    latestChatId,
    latestPreview: toText(record.latestPreview),
    updatedAt: toText(record.updatedAt) || latestChat?.updatedAt || "",
    recentChats,
    agentType: toText(record.agentType) || undefined,
    mode: toText(record.mode) || undefined,
    workspaceDir: toText(record.workspaceDir) || undefined,
    workspaceDirExists:
      typeof record.workspaceDirExists === "boolean"
        ? record.workspaceDirExists
        : undefined,
  };
}

export function normalizeAssistantNavAgents(items: unknown): AssistantNavAgentItem[] {
  return Array.isArray(items)
    ? items
      .map(normalizeAssistantNavAgent)
      .filter((item): item is AssistantNavAgentItem => Boolean(item))
    : [];
}

export function normalizeAssistantNavAgentItemsResult(
  result: AssistantNavAgentItemsResult
): AssistantNavAgentItemsResult {
  const activityItems = Array.isArray(result.activityItems)
    ? normalizeAssistantNavAgents(result.activityItems)
    : undefined;
  return {
    ...result,
    items: normalizeAssistantNavAgents(result.items),
    ...(activityItems ? { activityItems } : {})
  };
}

export function getAssistantNavAgentRecentChats(agent: Pick<AssistantNavAgentItem, "recentChats"> | null | undefined) {
  return Array.isArray(agent?.recentChats) ? agent.recentChats : [];
}

export function getAssistantNavAgentNonNegativeInteger(value: unknown) {
  return toNonNegativeInteger(value);
}
