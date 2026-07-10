import type {
  AssistantNavAgentItem,
  AssistantNavAgentItemsResult,
  AssistantNavChatItem
} from "../shared/contracts";

const PRIMARY_NAV_HIDDEN_ASSISTANT_AGENT_KEYS = new Set<string>([
  "desktopAssistant",
  "webOperator",
]);

export type AssistantNavSortMode = "byName" | "byTime";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown) {
  return isObjectRecord(value) ? value : {};
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toScalarText(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function toNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function toOptionalNonNegativeInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.max(0, Math.floor(numeric))
    : undefined;
}

function resolveAssistantNavUnreadCount(options: {
  statsUnreadCount: number | undefined;
  statsUnreadChatCount: number | undefined;
  unreadFromChats: number;
}) {
  return options.statsUnreadCount ??
    options.statsUnreadChatCount ??
    options.unreadFromChats;
}

function normalizeAssistantNavUpdatedAt(value: unknown) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return 0;
}

function compareAssistantNavChatFreshness(
  left: AssistantNavChatItem,
  right: AssistantNavChatItem,
) {
  const leftUpdatedAt = normalizeAssistantNavUpdatedAt(left.updatedAt);
  const rightUpdatedAt = normalizeAssistantNavUpdatedAt(right.updatedAt);
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }

  return left.chatId.localeCompare(right.chatId);
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

function readAssistantNavChatIsRead(record: Record<string, unknown>) {
  if (typeof record.isRead === "boolean") {
    return record.isRead;
  }
  if (typeof record.read === "boolean") {
    return record.read;
  }
  if (isObjectRecord(record.read) && typeof record.read.isRead === "boolean") {
    return record.read.isRead;
  }
  return true;
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
    updatedAt: toScalarText(record.updatedAt),
    lastRunId: toText(record.lastRunId),
    lastRunContent: toText(record.lastRunContent),
    isRead: readAssistantNavChatIsRead(record),
    hasActiveRun: record.hasActiveRun === true,
    hasPendingAwaiting: record.hasPendingAwaiting === true,
    awaitingCount: toNonNegativeInteger(record.awaitingCount),
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
  const unreadCount = toOptionalNonNegativeInteger(record.unreadCount);
  const unreadChatCount = toOptionalNonNegativeInteger(record.unreadChatCount);
  const unreadFromChats = recentChats.filter((chat) => chat.isRead === false).length;
  const chatCount = Math.max(toNonNegativeInteger(record.chatCount), recentChats.length);
  const latestChat = recentChats[0] ?? null;
  const latestChatId = toText(record.latestChatId) || latestChat?.chatId || null;
  const resolvedUnreadCount = resolveAssistantNavUnreadCount({
    statsUnreadCount: unreadCount,
    statsUnreadChatCount: unreadChatCount,
    unreadFromChats,
  });

  return {
    agentKey,
    displayName,
    role: toText(record.role),
    ...(record.icon === undefined ? {} : { icon: record.icon as AssistantNavAgentItem["icon"] }),
    unreadCount: resolvedUnreadCount,
    unreadChatCount: resolvedUnreadCount,
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

export function getPrimaryAssistantNavAgents(items: AssistantNavAgentItem[]) {
  return items.filter(
    (agent) => !PRIMARY_NAV_HIDDEN_ASSISTANT_AGENT_KEYS.has(agent.agentKey.trim()),
  );
}

function toAssistantSortTimestamp(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function readAssistantAgentLatestTimestamp(agent: AssistantNavAgentItem) {
  const latestChat = getAssistantNavAgentSortedChats(agent)[0];
  if (latestChat) {
    return toAssistantSortTimestamp(latestChat.updatedAt);
  }
  return agent.latestChatId ? toAssistantSortTimestamp(agent.updatedAt) : 0;
}

function compareAssistantAgentsByName(
  left: AssistantNavAgentItem,
  right: AssistantNavAgentItem,
) {
  const displayNameComparison = left.displayName.localeCompare(
    right.displayName,
    "zh-CN",
  );
  return displayNameComparison || left.agentKey.localeCompare(right.agentKey);
}

function compareAssistantAgentsByTime(
  left: AssistantNavAgentItem,
  right: AssistantNavAgentItem,
) {
  const timestampDifference =
    readAssistantAgentLatestTimestamp(right) -
    readAssistantAgentLatestTimestamp(left);
  return timestampDifference || compareAssistantAgentsByName(left, right);
}

export function sortAssistantNavAgentsForMode(
  items: AssistantNavAgentItem[],
  sortMode: AssistantNavSortMode,
) {
  const compare =
    sortMode === "byName"
      ? compareAssistantAgentsByName
      : compareAssistantAgentsByTime;
  return [...items].sort(compare);
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

export function getAssistantNavAgentSortedChats(
  agent: Pick<AssistantNavAgentItem, "recentChats"> | null | undefined,
) {
  return getAssistantNavAgentRecentChats(agent)
    .slice()
    .sort(compareAssistantNavChatFreshness);
}

export function getAssistantNavAgentPreviewChats(
  agent: Pick<AssistantNavAgentItem, "recentChats"> | null | undefined,
  limit = 5,
) {
  const normalizedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (normalizedLimit <= 0) {
    return [];
  }

  return getAssistantNavAgentSortedChats(agent).slice(0, normalizedLimit);
}

export function getAssistantNavAgentAttentionChat(
  agent: Pick<AssistantNavAgentItem, "recentChats"> | null | undefined,
) {
  const chats = getAssistantNavAgentSortedChats(agent);
  const runningChat = chats.find((chat) => chat.hasActiveRun === true);
  if (runningChat) {
    return runningChat;
  }

  const latestChat = chats[0];
  if (
    latestChat &&
    (latestChat.hasPendingAwaiting === true ||
      latestChat.isRead === false ||
      latestChat.hasActiveRun === true)
  ) {
    return latestChat;
  }

  return null;
}

export function getAssistantNavAgentNonNegativeInteger(value: unknown) {
  return toNonNegativeInteger(value);
}
