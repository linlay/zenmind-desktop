import type {
  AssistantNavAgentItem,
  AssistantNavChatItem,
  AssistantNavigationAttentionCounts,
  AssistantNavigationAttentionSummary,
} from "./contracts";

const NAVIGATION_HIDDEN_AGENT_KEYS = new Set([
  "desktopAssistant",
  "webOperator",
]);

type AssistantNavigationAttentionInput = {
  items?: readonly AssistantNavAgentItem[] | null;
  activityItems?: readonly AssistantNavAgentItem[] | null;
  chatItems?: readonly AssistantNavChatItem[] | null;
  pinnedChatItems?: readonly AssistantNavChatItem[] | null;
};

function getAttentionItems(input: AssistantNavigationAttentionInput) {
  return input.activityItems && input.activityItems.length > 0
    ? input.activityItems
    : input.items ?? [];
}

function getAttentionProjectItems(input: AssistantNavigationAttentionInput) {
  return getAttentionItems(input).filter(isAssistantNavigationAttentionProjectAgent);
}

function uniqueChats(chats: readonly AssistantNavChatItem[]) {
  const chatsById = new Map<string, AssistantNavChatItem>();
  for (const chat of chats) {
    if (!chatsById.has(chat.chatId)) chatsById.set(chat.chatId, chat);
  }
  return [...chatsById.values()];
}

function collectPendingChatCandidates(input: AssistantNavigationAttentionInput) {
  const agents = getAttentionItems(input).filter(
    (agent) => !NAVIGATION_HIDDEN_AGENT_KEYS.has(agent.agentKey.trim()),
  );
  // Complete baselines win over sidebar windows and independently fetched pins.
  // Keep read Chats here: opening an awaiting Chat does not answer its prompt.
  return uniqueChats([
    ...agents.flatMap((agent) => agent.attentionChats ?? agent.recentChats ?? []),
    ...(input.chatItems ?? []),
    ...(input.pinnedChatItems ?? []),
  ]);
}

export function collectAssistantNavigationPendingChats(
  input: AssistantNavigationAttentionInput,
): AssistantNavChatItem[] {
  return collectPendingChatCandidates(input).filter((chat) => chat.hasPendingAwaiting === true);
}

export function collectAssistantNavigationOverviewChats(
  input: AssistantNavigationAttentionInput,
): AssistantNavChatItem[] {
  const unreadChats = collectAssistantNavigationUnreadChats(input);
  const unreadIds = new Set(unreadChats.map((chat) => chat.chatId));
  const candidates = collectPendingChatCandidates(input);
  const overviewIds = new Set([
    ...unreadIds,
    ...candidates.filter((chat) => chat.hasPendingAwaiting).map((chat) => chat.chatId),
  ]);
  // Complete metadata also wins after awaiting resolves, so a stale sidebar
  // unread summary cannot restore its old waiting card. Blue dots retain the
  // unchanged unread scope while the orange count follows complete status.
  return uniqueChats([
    ...candidates,
    ...unreadChats,
  ]).filter((chat) => overviewIds.has(chat.chatId))
    .map((chat) => ({ ...chat, isRead: !unreadIds.has(chat.chatId) }));
}

export function collectAssistantNavigationUnreadChats(
  input: AssistantNavigationAttentionInput,
): AssistantNavChatItem[] {
  const projects = getAttentionProjectItems(input);
  const projectKeys = new Set(projects.map((agent) => agent.agentKey));
  const chatsById = new Map<string, AssistantNavChatItem>();
  const candidates = [
    ...(input.chatItems ?? []),
    ...projects.flatMap((agent) => agent.attentionChats ?? agent.recentChats ?? []),
    ...(input.pinnedChatItems ?? []).filter((chat) => !projectKeys.has(chat.agentKey)),
  ];
  for (const chat of candidates) {
    if (!chatsById.has(chat.chatId)) {
      chatsById.set(chat.chatId, chat);
    }
  }
  return [...chatsById.values()].filter((chat) => chat.isRead === false);
}

function toNonNegativeInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function summarizeChats(
  chats: readonly AssistantNavChatItem[],
): AssistantNavigationAttentionCounts {
  return {
    unreadCount: chats.filter((chat) => chat.isRead === false).length,
    pendingCount: chats.filter((chat) => chat.hasPendingAwaiting === true).length,
  };
}

export function isAssistantNavigationAttentionProjectAgent(agent: AssistantNavAgentItem) {
  return (
    !NAVIGATION_HIDDEN_AGENT_KEYS.has(agent.agentKey.trim()) &&
    Boolean(agent.workspaceDir?.trim())
  );
}

function summarizeProjects(
  agents: readonly AssistantNavAgentItem[],
  pendingChats: readonly AssistantNavChatItem[],
): AssistantNavigationAttentionCounts {
  const projects = agents.filter(isAssistantNavigationAttentionProjectAgent);
  const projectKeys = new Set(projects.map((agent) => agent.agentKey));
  return {
    unreadCount: projects.reduce(
      (total, agent) => total + (agent.attentionChats
        ? agent.attentionChats.filter((chat) => chat.isRead === false).length
        : toNonNegativeInteger(agent.unreadCount)),
      0,
    ),
    pendingCount: pendingChats.filter((chat) => projectKeys.has(chat.agentKey)).length,
  };
}

export function summarizeAssistantNavigationAttention(input: AssistantNavigationAttentionInput): AssistantNavigationAttentionSummary {
  const chats = summarizeChats(input.chatItems ?? []);
  const projectItems = getAttentionItems(input);
  const pendingChats = collectAssistantNavigationPendingChats(input);
  const projects = summarizeProjects(projectItems, pendingChats);
  const projectKeys = new Set(
    projectItems.filter(isAssistantNavigationAttentionProjectAgent)
      .map((agent) => agent.agentKey),
  );
  const visibleChatIDs = new Set((input.chatItems ?? []).map((chat) => chat.chatId));
  // Project counts already include their pinned conversations. Only ordinary
  // pins need to be added to the global total after leaving the Chats section.
  const extraPins = summarizeChats(
    (input.pinnedChatItems ?? []).filter(
      (chat) => !projectKeys.has(chat.agentKey) && !visibleChatIDs.has(chat.chatId),
    ),
  );
  chats.pendingCount = pendingChats.filter((chat) => !projectKeys.has(chat.agentKey)).length;
  return {
    chats,
    projects,
    total: {
      unreadCount: projectItems.filter(isAssistantNavigationAttentionProjectAgent)
        .every((agent) => Array.isArray(agent.attentionChats))
        ? collectAssistantNavigationUnreadChats(input).length
        : chats.unreadCount + projects.unreadCount + extraPins.unreadCount,
      pendingCount: pendingChats.length,
    },
  };
}

export function createEmptyAssistantNavigationAttention(): AssistantNavigationAttentionSummary {
  return summarizeAssistantNavigationAttention({});
}
