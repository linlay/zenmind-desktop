import type {
  AssistantNavAgentItem,
  AssistantNavAgentItemsResult,
  AssistantNavChatItem
} from "../shared/contracts";
import {
  parseOptionalNullableAgentPlatformEpochMillis,
  requireAgentPlatformEpochMillis,
} from "../shared/time-contract";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown) {
  return isObjectRecord(value) ? value : {};
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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

const PROJECT_ASSISTANT_MODES = new Set(["CODER", "KBASE"]);
const HIDDEN_CHAT_AGENT_KEYS = new Set(["desktopAssistant", "webOperator"]);

function resolveAssistantNavUnreadCount(options: {
  statsUnreadCount: number | undefined;
  statsUnreadChatCount: number | undefined;
  unreadFromChats: number;
}) {
  return options.statsUnreadCount ??
    options.statsUnreadChatCount ??
    options.unreadFromChats;
}

function compareAssistantNavChatFreshness(
  left: AssistantNavChatItem,
  right: AssistantNavChatItem,
) {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }

  return left.chatId.localeCompare(right.chatId);
}

function toAwaitingMode(value: unknown): AssistantNavChatItem["awaitingMode"] {
  const mode = toText(value).toLowerCase();
  return mode === "approval" ||
    mode === "question" ||
    mode === "form" ||
    mode === "planning"
    ? mode
    : undefined;
}

export function getAssistantAwaitingStatusKey(
  mode?: AssistantNavChatItem["awaitingMode"],
) {
  switch (mode) {
    case "planning":
      return "sidebar.assistants.awaitingStatus.planning";
    case "question":
      return "sidebar.assistants.awaitingStatus.question";
    case "approval":
      return "sidebar.assistants.awaitingStatus.approval";
    case "form":
      return "sidebar.assistants.awaitingStatus.form";
    default:
      return "kanban.run.awaitingApproval";
  }
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
  const createdAt = requireAgentPlatformEpochMillis(record.createdAt, "assistantNavigation.chat.createdAt");
  const updatedAt = requireAgentPlatformEpochMillis(record.updatedAt, "assistantNavigation.chat.updatedAt");

  return {
    chatId,
    chatName: toText(record.chatName),
    agentKey: toText(record.agentKey) || fallbackAgentKey,
    createdAt,
    updatedAt,
    lastRunId: toText(record.lastRunId),
    lastRunContent: toText(record.lastRunContent),
    isRead: readAssistantNavChatIsRead(record),
    hasActiveRun: record.hasActiveRun === true,
    hasPendingAwaiting: record.hasPendingAwaiting === true,
    awaitingCount: toNonNegativeInteger(record.awaitingCount),
    awaitingMode: toAwaitingMode(record.awaitingMode)
  };
}

export function normalizeAssistantNavChats(
  items: unknown,
  options: { requireAgentKey?: boolean } = {},
): AssistantNavChatItem[] {
  const requireAgentKey = options.requireAgentKey === true;
  return Array.isArray(items)
    ? items
      .map((chat) => normalizeAssistantNavChat(chat, ""))
      .filter((chat): chat is AssistantNavChatItem => chat !== null)
      .filter((chat) => !requireAgentKey || Boolean(chat.agentKey))
    : [];
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
  const updatedAt = parseOptionalNullableAgentPlatformEpochMillis(
    record.updatedAt,
    "assistantNavigation.agent.updatedAt",
  );
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
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    recentChats,
    mode: toText(record.mode) || undefined,
    workspaceDir: toText(record.workspaceDir) || undefined,
    workspaceDirExists:
      typeof record.workspaceDirExists === "boolean"
        ? record.workspaceDirExists
        : undefined,
    gitBranch: toText(record.gitBranch) || undefined,
  };
}

export function normalizeAssistantNavAgents(items: unknown): AssistantNavAgentItem[] {
  return Array.isArray(items)
    ? items
      .map(normalizeAssistantNavAgent)
      .filter((item): item is AssistantNavAgentItem => Boolean(item))
    : [];
}

export function isAssistantNavProjectAgent(
  agent: Pick<AssistantNavAgentItem, "mode"> | null | undefined,
) {
  return PROJECT_ASSISTANT_MODES.has(agent?.mode?.trim().toUpperCase() ?? "");
}

export function isAssistantNavChatAgent(
  agent: Pick<AssistantNavAgentItem, "agentKey" | "mode"> | null | undefined,
) {
  const agentKey = agent?.agentKey.trim() ?? "";
  return Boolean(agentKey) &&
    !HIDDEN_CHAT_AGENT_KEYS.has(agentKey) &&
    !isAssistantNavProjectAgent(agent);
}

export type AssistantNavChatRuntimeAgent = {
  agent: AssistantNavAgentItem | null;
  agentKey: string;
  defaultAgentAvailable: boolean;
  bootstrapAgentAvailable: boolean;
  bootstrapActive: boolean;
};

export type FirstInstallBootstrapNavigationTarget = {
  agentKey: string;
  chatId?: string;
};

export function resolveFirstInstallBootstrapNavigationTarget(
  agents: AssistantNavAgentItem[],
  chats: AssistantNavChatItem[],
  options: {
    defaultChatAgentKey?: string;
    bootstrapAgentKey?: string;
    bootstrapChatId?: string;
  },
): FirstInstallBootstrapNavigationTarget | null {
  const defaultChatAgentKey = toText(options.defaultChatAgentKey);
  const bootstrapAgentKey = toText(options.bootstrapAgentKey);
  const bootstrapChatId = toText(options.bootstrapChatId);
  const bootstrapAgentAvailable = Boolean(
    bootstrapAgentKey && agents.some((agent) => agent.agentKey === bootstrapAgentKey),
  );

  if (bootstrapAgentAvailable) {
    const seedChatIndexed = Boolean(
      bootstrapChatId && chats.some((chat) =>
        chat.chatId === bootstrapChatId && chat.agentKey === bootstrapAgentKey,
      ),
    );
    return {
      agentKey: bootstrapAgentKey,
      ...(seedChatIndexed ? { chatId: bootstrapChatId } : {}),
    };
  }

  const defaultAgentAvailable = Boolean(
    defaultChatAgentKey && agents.some((agent) => agent.agentKey === defaultChatAgentKey),
  );
  return defaultAgentAvailable ? { agentKey: defaultChatAgentKey } : null;
}

export function resolveAssistantNavChatRuntimeAgent(
  agents: AssistantNavAgentItem[],
  options: {
    defaultChatAgentKey?: string;
    bootstrapAgentKey?: string;
    bootstrapNavigationRequested?: boolean;
  },
): AssistantNavChatRuntimeAgent {
  const defaultChatAgentKey = toText(options.defaultChatAgentKey);
  const bootstrapAgentKey = toText(options.bootstrapAgentKey);
  const defaultAgent = defaultChatAgentKey
    ? agents.find((agent) => agent.agentKey === defaultChatAgentKey) ?? null
    : null;
  const bootstrapAgent = bootstrapAgentKey
    ? agents.find((agent) => agent.agentKey === bootstrapAgentKey) ?? null
    : null;
  const bootstrapNavigationRequested = Boolean(
    bootstrapAgentKey && options.bootstrapNavigationRequested,
  );

  return {
    agent: defaultAgent,
    agentKey: defaultAgent?.agentKey ?? defaultChatAgentKey,
    defaultAgentAvailable: Boolean(defaultAgent),
    bootstrapAgentAvailable: Boolean(bootstrapAgent),
    bootstrapActive: Boolean(bootstrapNavigationRequested && bootstrapAgent),
  };
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
    chatItems: normalizeAssistantNavChats(result.chatItems, { requireAgentKey: true }),
    chatItemsHasMore: result.chatItemsHasMore === true,
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

export type AssistantNavChatsOverviewItem = {
  agent: Pick<
    AssistantNavAgentItem,
    "agentKey" | "displayName" | "mode" | "workspaceDir" | "workspaceDirExists" | "gitBranch"
  >;
  chat: AssistantNavChatItem;
};

export function getAssistantNavRecentChatsOverview(
  agents: AssistantNavAgentItem[],
  limit = 10,
) {
  const normalizedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (normalizedLimit <= 0) {
    return [];
  }

  const chatsById = new Map<string, AssistantNavChatsOverviewItem>();
  for (const agent of agents) {
    for (const chat of getAssistantNavAgentSortedChats(agent)) {
      const normalizedChat = {
        ...chat,
        agentKey: chat.agentKey || agent.agentKey,
      };
      const existing = chatsById.get(normalizedChat.chatId);
      if (
        !existing ||
        compareAssistantNavChatFreshness(normalizedChat, existing.chat) < 0
      ) {
        chatsById.set(normalizedChat.chatId, {
          agent: {
            agentKey: agent.agentKey,
            displayName: agent.displayName,
            mode: agent.mode,
            workspaceDir: agent.workspaceDir,
            workspaceDirExists: agent.workspaceDirExists,
            gitBranch: agent.gitBranch,
          },
          chat: normalizedChat,
        });
      }
    }
  }

  return Array.from(chatsById.values())
    .sort((left, right) => compareAssistantNavChatFreshness(left.chat, right.chat))
    .slice(0, normalizedLimit);
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
