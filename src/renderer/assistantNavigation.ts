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
    hasPendingAwaiting: record.hasPendingAwaiting === true
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
    rowType: record.rowType === "agent" ? "agent" : undefined,
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
  return {
    ...result,
    items: normalizeAssistantNavAgents(result.items)
  };
}

export function getAssistantNavAgentRecentChats(agent: Pick<AssistantNavAgentItem, "recentChats"> | null | undefined) {
  return Array.isArray(agent?.recentChats) ? agent.recentChats : [];
}

export function getAssistantNavAgentNonNegativeInteger(value: unknown) {
  return toNonNegativeInteger(value);
}
