import {
  type PlatformAgentSummary,
  type PlatformChatSummary,
  NAVIGATION_AGENT_CHAT_LIMIT,
  type AssistantNavigationChatsSnapshot,
  NAVIGATION_CHAT_LIMIT
} from "./navigation-contracts";
import {
  toText,
  isObjectRecord,
  toTimestampMs,
  toNonNegativeInteger,
  hasPendingAwaitingPayload,
  countPendingAwaitingPayload,
  toAwaitingMode,
  validateNavigationPayloadTimes,
  validatePresentNavigationTimes,
  toOptionalNonNegativeInteger
} from "./navigation-values";
import {
  type AssistantNavAgentIcon,
  type AssistantAwaitingMode,
  type AssistantNavChatItem,
  type AssistantNavAgentItem
} from "../../../shared/contracts";
import { requireAgentPlatformEpochMillis, parseOptionalNullableAgentPlatformEpochMillis } from "../../../shared/time-contract";
import { t } from "../../support/i18n/main-i18n";
import { readAgentWorkspaceDir, checkWorkspaceDirExists } from "./navigation-workspace";

export function readAgentKey(agent: PlatformAgentSummary) {
  return toText(agent.key);
}

export function readAgentDisplayName(agent: PlatformAgentSummary, fallback: string) {
  return toText(agent.name) || toText(agent.displayName) || fallback;
}

export function readAgentIcon(agent: PlatformAgentSummary): AssistantNavAgentIcon | undefined {
  if (typeof agent.icon === "string" && agent.icon.trim()) {
    return agent.icon.trim();
  }
  if (isObjectRecord(agent.icon)) {
    const color = toText(agent.icon.color);
    const name = toText(agent.icon.name);
    if (color || name) {
      return {
        ...(color ? { color } : {}),
        ...(name ? { name } : {})
      };
    }
  }
  return undefined;
}

export function readChatAgentKey(chat: PlatformChatSummary, fallbackAgentKey = "") {
  return toText(chat.agentKey) || toText(chat.firstAgentKey) || fallbackAgentKey;
}

export function readChatIsRead(chat: PlatformChatSummary) {
  if (typeof chat.isRead === "boolean") {
    return chat.isRead;
  }
  if (typeof chat.read === "boolean") {
    return chat.read;
  }
  if (isObjectRecord(chat.read) && typeof chat.read.isRead === "boolean") {
    return chat.read.isRead;
  }
  return true;
}

export function readChatReadAt(chat: PlatformChatSummary) {
  if (isObjectRecord(chat.read)) {
    return toTimestampMs(chat.read.readAt) ?? toTimestampMs(chat.readAt);
  }
  return toTimestampMs(chat.readAt);
}

export function readChatReadRunId(chat: PlatformChatSummary) {
  if (isObjectRecord(chat.read)) {
    return toText(chat.read.readRunId) || toText(chat.readRunId);
  }
  return toText(chat.readRunId);
}

export function readChatPendingAwaiting(chat: PlatformChatSummary) {
  if (chat.hasPendingAwaiting === true) {
    return true;
  }
  if (chat.hasPendingAwaiting === false) {
    return false;
  }
  if (toNonNegativeInteger(chat.awaitingCount) > 0) {
    return true;
  }
  if (hasPendingAwaitingPayload(chat.awaiting)) {
    return true;
  }
  return toText(chat.status).toLowerCase() === "awaiting";
}

export function readChatAwaitingCount(chat: PlatformChatSummary) {
  const explicitCount = toNonNegativeInteger(chat.awaitingCount);
  if (explicitCount > 0) {
    return explicitCount;
  }
  const payloadCount = countPendingAwaitingPayload(chat.awaiting);
  if (payloadCount > 0) {
    return payloadCount;
  }
  return readChatPendingAwaiting(chat) ? 1 : 0;
}

export function readAwaitingPayloadMode(value: unknown): AssistantAwaitingMode | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const mode = readAwaitingPayloadMode(item);
      if (mode) {
        return mode;
      }
    }
    return undefined;
  }
  if (!isObjectRecord(value)) {
    return undefined;
  }
  return toAwaitingMode(value.mode) || readAwaitingPayloadMode(value.awaiting);
}

export function readChatAwaitingMode(chat: PlatformChatSummary): AssistantAwaitingMode | undefined {
  // Top-level mode is the chat's Agent Mode (for example REACT), not an
  // awaiting interaction mode. Awaiting state is carried separately.
  return (
    toAwaitingMode(chat.awaitingMode) ||
    readAwaitingPayloadMode(chat.awaiting)
  );
}

export function readActiveRunValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    return !["0", "false", "done", "finished", "complete", "completed"].includes(normalized);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value > 0 : null;
  }
  if (isObjectRecord(value)) {
    return true;
  }
  return null;
}

export function readChatActiveRun(chat: PlatformChatSummary) {
  return isObjectRecord(chat.activeRun) && !Array.isArray(chat.activeRun);
}

export function compareNavChats(left: AssistantNavChatItem, right: AssistantNavChatItem) {
  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  return left.chatId.localeCompare(right.chatId);
}

export function mergeNavigationChats(
  primaryChats: AssistantNavChatItem[],
  secondaryChats: AssistantNavChatItem[]
) {
  const chatsById = new Map<string, AssistantNavChatItem>();
  for (const chat of [...primaryChats, ...secondaryChats]) {
    const chatId = toText(chat.chatId);
    if (!chatId) {
      continue;
    }
    const existing = chatsById.get(chatId);
    if (!existing || chat.updatedAt > existing.updatedAt) {
      chatsById.set(chatId, chat);
    }
  }
  return limitNavigationChats([...chatsById.values()]);
}

export function limitNavigationChats(chats: AssistantNavChatItem[]) {
  const sorted = [...chats].sort(compareNavChats);
  return [...sorted.filter((chat) => chat.pinned), ...sorted.filter((chat) => !chat.pinned).slice(0, NAVIGATION_AGENT_CHAT_LIMIT)].sort(compareNavChats);
}

export function resolveNavigationUnreadCount(options: {
  statsUnreadCount: number | undefined;
  unreadFromChats: number;
}) {
  return options.statsUnreadCount ?? options.unreadFromChats;
}

export function pickLatestTimestamp(
  left: AssistantNavAgentItem["updatedAt"],
  right: AssistantNavAgentItem["updatedAt"],
) {
  const leftTimestamp = left ?? undefined;
  const rightTimestamp = right ?? undefined;
  if (leftTimestamp === undefined || rightTimestamp === undefined) {
    return left ?? right;
  }
  return rightTimestamp > leftTimestamp ? rightTimestamp : leftTimestamp;
}

export function mergeNavigationAgentItem(
  primary: AssistantNavAgentItem,
  secondary: AssistantNavAgentItem
): AssistantNavAgentItem {
  const recentChats = mergeNavigationChats(primary.recentChats, secondary.recentChats);
  const latestChat = recentChats[0] ?? null;
  const unreadFromChats = recentChats.filter((chat) => !chat.isRead).length;
  const chatCount = Math.max(primary.chatCount, secondary.chatCount, recentChats.length);
  const unreadCount = resolveNavigationUnreadCount({
    statsUnreadCount: Math.max(primary.unreadCount, secondary.unreadCount),
    unreadFromChats,
  });
  const unreadChatCount = unreadCount;
  const latestPreview = latestChat
    ? (latestChat.lastRunContent || latestChat.chatName).replace(/\s+/gu, " ").trim()
    : primary.latestPreview || secondary.latestPreview;
  return {
    ...secondary,
    ...primary,
    role: primary.role || secondary.role,
    ...(primary.icon !== undefined || secondary.icon !== undefined ? { icon: primary.icon ?? secondary.icon } : {}),
    unreadCount,
    unreadChatCount,
    chatCount,
    hasPendingAwaiting: primary.hasPendingAwaiting || secondary.hasPendingAwaiting || recentChats.some((chat) => chat.hasPendingAwaiting),
    latestChatId: latestChat?.chatId ?? primary.latestChatId ?? secondary.latestChatId,
    latestPreview: latestPreview.slice(0, 120),
    ...(pickLatestTimestamp(primary.updatedAt, secondary.updatedAt) !== undefined
      ? { updatedAt: pickLatestTimestamp(primary.updatedAt, secondary.updatedAt) }
      : {}),
    recentChats,
    mode: primary.mode ?? secondary.mode,
    workspaceDir: primary.workspaceDir ?? secondary.workspaceDir,
    workspaceDirExists: primary.workspaceDirExists ?? secondary.workspaceDirExists,
    gitBranch: primary.gitBranch ?? secondary.gitBranch,
  };
}

export function mergeNavigationAgentGroups(
  primaryItems: AssistantNavAgentItem[],
  secondaryItems: AssistantNavAgentItem[]
) {
  const mergedItems = primaryItems.slice();
  const indexByKey = new Map(
    mergedItems.map((agent, index) => [agent.agentKey, index] as const),
  );
  for (const agent of secondaryItems) {
    const existingIndex = indexByKey.get(agent.agentKey);
    if (existingIndex === undefined) {
      indexByKey.set(agent.agentKey, mergedItems.length);
      mergedItems.push(agent);
      continue;
    }
    mergedItems[existingIndex] = mergeNavigationAgentItem(
      mergedItems[existingIndex],
      agent,
    );
  }
  return mergedItems;
}

export function mapNavigationChat(
  chat: PlatformChatSummary,
  fallbackAgentKey = "",
  path = "navigation.chat",
): AssistantNavChatItem | null {
  if (!isObjectRecord(chat)) {
    return null;
  }
  validateNavigationPayloadTimes(chat, path);
  const chatId = toText(chat.chatId) || toText(chat.id);
  const createdAt = requireAgentPlatformEpochMillis(chat.createdAt, `${path}.createdAt`);
  const updatedAt = requireAgentPlatformEpochMillis(chat.updatedAt, `${path}.updatedAt`);
  if (!chatId) {
    return null;
  }
  const lastRunContent = toText(chat.lastRunContent) || toText(chat.lastMessage) || toText(chat.preview) || toText(chat.message);
  const chatName = toText(chat.chatName) || toText(chat.name) || toText(chat.title) || t("assistant.newChat");
  return {
    chatId,
    chatName,
    ...(chat.pinned === true ? { pinned: true } : {}),
    ...(toText(chat.mode) ? { mode: toText(chat.mode) } : {}),
    agentKey: readChatAgentKey(chat, fallbackAgentKey),
    createdAt,
    updatedAt,
    lastRunId: toText(chat.lastRunId),
    lastRunContent,
    isRead: readChatIsRead(chat),
    readAt: readChatReadAt(chat),
    readRunId: readChatReadRunId(chat),
    hasActiveRun: readChatActiveRun(chat),
    hasPendingAwaiting: readChatPendingAwaiting(chat),
    awaitingCount: readChatAwaitingCount(chat),
    awaitingMode: readChatAwaitingMode(chat)
  };
}

export function buildAssistantNavigationChatsSnapshotFromPlatform(
  chats: unknown,
): AssistantNavigationChatsSnapshot {
  if (!Array.isArray(chats)) {
    return { chatItems: [], chatItemsHasMore: false };
  }
  const validChats: AssistantNavChatItem[] = [];
  for (const [index, rawChat] of chats.entries()) {
    const chat = mapNavigationChat(rawChat as PlatformChatSummary, "", `navigation.chats[${index}]`);
    if (!chat?.agentKey || chat.pinned) {
      continue;
    }
    validChats.push(chat);
  }
  return {
    chatItems: validChats.slice(0, NAVIGATION_CHAT_LIMIT),
    chatItemsHasMore: validChats.length > NAVIGATION_CHAT_LIMIT,
  };
}

export function buildAssistantNavigationChatsFromPlatform(chats: unknown): AssistantNavChatItem[] {
  return buildAssistantNavigationChatsSnapshotFromPlatform(chats).chatItems;
}

export function readAgentRawChatLists(agent: PlatformAgentSummary): unknown[][] {
  return [
    agent.chats,
    agent.recentChats,
    agent.relatedChats,
    agent.chatList,
    agent.conversations
  ].filter((candidate): candidate is unknown[] => Array.isArray(candidate));
}

export function readAgentChats(agent: PlatformAgentSummary, agentKey: string, agentPath: string): AssistantNavChatItem[] {
  const chatsById = new Map<string, AssistantNavChatItem>();
  for (const [listIndex, rawChats] of readAgentRawChatLists(agent).entries()) {
    for (const [chatIndex, rawChat] of rawChats.entries()) {
      const chat = mapNavigationChat(
        rawChat as PlatformChatSummary,
        agentKey,
        `${agentPath}.chats[${listIndex}][${chatIndex}]`,
      );
      if (!chat || chatsById.has(chat.chatId)) {
        continue;
      }
      chatsById.set(chat.chatId, chat);
    }
  }
  return [...chatsById.values()].sort(compareNavChats);
}

export function createNavigationAgentItem(agent: PlatformAgentSummary, includeChatLimit: number, path: string): AssistantNavAgentItem | null {
  validatePresentNavigationTimes(agent as Record<string, unknown>, path);
  const agentKey = readAgentKey(agent);
  if (!agentKey) {
    return null;
  }
  const workspaceDir = readAgentWorkspaceDir(agent);
  const chats = readAgentChats(agent, agentKey, path);
  const recentChats = chats.slice(0, includeChatLimit);
  const latestChat = recentChats[0] ?? null;
  const totalCount = toNonNegativeInteger(agent.stats?.totalCount);
  const statsUnreadCount = toOptionalNonNegativeInteger(agent.stats?.unreadCount);
  const unreadFromChats = chats.filter((chat) => !chat.isRead).length;
  const chatCount = Math.max(totalCount, chats.length);
  const unreadCount = resolveNavigationUnreadCount({
    statsUnreadCount,
    unreadFromChats,
  });
  const latestPreview = latestChat
    ? (latestChat.lastRunContent || latestChat.chatName).replace(/\s+/gu, " ").trim()
    : "";
  const updatedAt = parseOptionalNullableAgentPlatformEpochMillis(agent.updatedAt, `${path}.updatedAt`);
  return {
    agentKey,
    displayName: readAgentDisplayName(agent, agentKey),
    role: toText(agent.role),
    ...(readAgentIcon(agent) ? { icon: readAgentIcon(agent) } : {}),
    unreadCount,
    unreadChatCount: unreadCount,
    chatCount,
    hasPendingAwaiting: chats.some((chat) => chat.hasPendingAwaiting),
    latestChatId: latestChat?.chatId ?? null,
    latestPreview: latestPreview.slice(0, 120),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    recentChats,
    mode: toText(agent.mode) || undefined,
    workspaceDir: workspaceDir || undefined,
    workspaceDirExists: checkWorkspaceDirExists(workspaceDir),
  };
}

export function createCopilotAgentItem(agent: PlatformAgentSummary, path: string): AssistantNavAgentItem | null {
  validatePresentNavigationTimes(agent as Record<string, unknown>, path);
  const agentKey = readAgentKey(agent);
  if (!agentKey) {
    return null;
  }
  const workspaceDir = readAgentWorkspaceDir(agent);
  const updatedAt = parseOptionalNullableAgentPlatformEpochMillis(agent.updatedAt, `${path}.updatedAt`);
  return {
    agentKey,
    displayName: readAgentDisplayName(agent, agentKey),
    role: toText(agent.role),
    ...(readAgentIcon(agent) ? { icon: readAgentIcon(agent) } : {}),
    unreadCount: 0,
    unreadChatCount: 0,
    chatCount: 0,
    hasPendingAwaiting: false,
    latestChatId: null,
    latestPreview: "",
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    recentChats: [],
    mode: toText(agent.mode) || undefined,
    workspaceDir: workspaceDir || undefined,
    workspaceDirExists: checkWorkspaceDirExists(workspaceDir),
  };
}

export function buildAssistantNavigationAgentsFromPlatformAgents(
  agentsInput: unknown,
  includeChatLimit = NAVIGATION_AGENT_CHAT_LIMIT
): AssistantNavAgentItem[] {
  const agents = Array.isArray(agentsInput) ? agentsInput as PlatformAgentSummary[] : [];
  return agents
    .map((agent, index) => createNavigationAgentItem(agent, includeChatLimit, `navigation.agents[${index}]`))
    .filter((agent): agent is AssistantNavAgentItem => Boolean(agent));
}

export function buildAssistantCopilotAgentsFromPlatformAgents(agentsInput: unknown): AssistantNavAgentItem[] {
  const agents = Array.isArray(agentsInput) ? agentsInput as PlatformAgentSummary[] : [];
  return agents
    .map((agent, index) => createCopilotAgentItem(agent, `copilot.agents[${index}]`))
    .filter((agent): agent is AssistantNavAgentItem => Boolean(agent));
}
