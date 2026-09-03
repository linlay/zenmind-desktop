import type {
  AssistantNavAgentItem,
  AssistantNavChatItem,
  AssistantNavigationAttentionCounts,
  AssistantNavigationAttentionSummary,
} from "./contracts";

const PROJECT_AGENT_MODES = new Set(["CODER", "KBASE"]);
const NAVIGATION_HIDDEN_AGENT_KEYS = new Set([
  "desktopAssistant",
  "webOperator",
]);

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
    PROJECT_AGENT_MODES.has(agent.mode?.trim().toUpperCase() ?? "")
  );
}

function summarizeProjects(
  agents: readonly AssistantNavAgentItem[],
): AssistantNavigationAttentionCounts {
  const projects = agents.filter(isAssistantNavigationAttentionProjectAgent);
  return {
    unreadCount: projects.reduce(
      (total, agent) => total + toNonNegativeInteger(agent.unreadCount),
      0,
    ),
    pendingCount: projects.filter(
      (agent) => agent.hasPendingAwaiting === true,
    ).length,
  };
}

export function summarizeAssistantNavigationAttention(input: {
  items?: readonly AssistantNavAgentItem[] | null;
  activityItems?: readonly AssistantNavAgentItem[] | null;
  chatItems?: readonly AssistantNavChatItem[] | null;
}): AssistantNavigationAttentionSummary {
  const chats = summarizeChats(input.chatItems ?? []);
  const projectItems = input.activityItems && input.activityItems.length > 0
    ? input.activityItems
    : input.items ?? [];
  const projects = summarizeProjects(projectItems);
  return {
    chats,
    projects,
    total: {
      unreadCount: chats.unreadCount + projects.unreadCount,
      pendingCount: chats.pendingCount + projects.pendingCount,
    },
  };
}

export function createEmptyAssistantNavigationAttention(): AssistantNavigationAttentionSummary {
  return summarizeAssistantNavigationAttention({});
}
