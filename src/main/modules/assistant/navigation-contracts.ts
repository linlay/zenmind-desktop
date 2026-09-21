import {
  type AssistantNavAgentItem,
  type AssistantNavChatItem,
  type AssistantAwaitingMode,
  type ServiceId,
  type AssistantChatSortMode
} from "../../../shared/contracts";

export type AgentPlatformApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

export type PlatformActiveRunSummary = {
  runId?: unknown;
  agentKey?: unknown;
  teamId?: unknown;
  state?: unknown;
  lastSeq?: unknown;
  oldestSeq?: unknown;
  startedAt?: unknown;
  planningMode?: unknown;
};

export type PlatformChatSummary = {
  pinned?: unknown;
  id?: unknown;
  chatId?: unknown;
  chatName?: unknown;
  name?: unknown;
  title?: unknown;
  agentKey?: unknown;
  firstAgentKey?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastRunId?: unknown;
  lastRunContent?: unknown;
  lastMessage?: unknown;
  preview?: unknown;
  message?: unknown;
  read?: unknown;
  isRead?: unknown;
  readAt?: unknown;
  readRunId?: unknown;
  activeRun?: PlatformActiveRunSummary | null;
  awaiting?: unknown;
  hasPendingAwaiting?: unknown;
  awaitingCount?: unknown;
  awaitingMode?: unknown;
  mode?: unknown;
  status?: unknown;
};

export type PlatformChatOrder = {
  pinnedChats?: unknown;
  sortMode?: unknown;
  updatedAt?: unknown;
};

export type PlatformAgentSummary = {
  key?: unknown;
  name?: unknown;
  displayName?: unknown;
  updatedAt?: unknown;
  role?: unknown;
  icon?: unknown;
  mode?: unknown;
  workspaceDir?: unknown;
  workspaceRoot?: unknown;
  workspace?: {
    root?: unknown;
  };
  runtimeConfig?: {
    workspaceRoot?: unknown;
  };
  stats?: {
    totalCount?: unknown;
    unreadCount?: unknown;
  };
  chats?: unknown;
  recentChats?: unknown;
  relatedChats?: unknown;
  chatList?: unknown;
  conversations?: unknown;
};

export type NavigationPushFrame = {
  frame?: unknown;
  type?: unknown;
  payload?: unknown;
  data?: unknown;
  [key: string]: unknown;
};

export type NavigationPushEvent = {
  type: string;
  chatId?: unknown;
  chatName?: unknown;
  agentKey?: unknown;
  firstAgentKey?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  answeredAt?: unknown;
  resolvedAt?: unknown;
  timestamp?: unknown;
  lastRunId?: unknown;
  runId?: unknown;
  lastRunContent?: unknown;
  text?: unknown;
  message?: unknown;
  read?: unknown;
  isRead?: unknown;
  readAt?: unknown;
  readRunId?: unknown;
  hasActiveRun?: unknown;
  activeRun?: unknown;
  running?: unknown;
  agentUnreadCount?: unknown;
  unreadCount?: unknown;
  awaiting?: unknown;
  hasPendingAwaiting?: unknown;
  awaitingCount?: unknown;
  awaitingMode?: unknown;
  mode?: unknown;
  status?: unknown;
  [key: string]: unknown;
};

export type AssistantNavigationApplyResult = {
  items: AssistantNavAgentItem[];
  changed: boolean;
  shouldRefresh: boolean;
};

export type AssistantNavigationChatApplyResult = {
  items: AssistantNavChatItem[];
  changed: boolean;
  shouldRefresh: boolean;
};

export type AssistantNavigationChatRuntimeStatusPatch = {
  chatId: string;
  lastRunId?: string;
  hasActiveRun?: boolean;
  hasPendingAwaiting: boolean;
  awaitingCount: number;
  awaitingMode?: AssistantAwaitingMode;
};

export type AssistantNavigationRecordedRuntimeStatusPush = {
  sequence: number;
  frame: NavigationPushFrame;
};

export const AGENT_PLATFORM_SERVICE_ID: ServiceId = "agent-platform";

export const NAVIGATION_AGENT_HISTORY_LIMIT = 50;

export const NAVIGATION_AGENT_CHAT_LIMIT = NAVIGATION_AGENT_HISTORY_LIMIT;

export const NAVIGATION_CHAT_LIMIT = 24;

export const NAVIGATION_CHAT_PROBE_LIMIT = NAVIGATION_CHAT_LIMIT + 1;

export const NAVIGATION_CHAT_AGENT_MODE = "REACT";

export const NAVIGATION_REFRESH_DEBOUNCE_MS = 350;

export const NAVIGATION_UNAVAILABLE_RETRY_MS = 12_000;

export const NAVIGATION_LIVE_FRAME_LIMIT = 20;

export const IGNORED_PUSH_TYPES = new Set(["heartbeat", "live.connected"]);

export const JOURNALED_NAVIGATION_PUSH_TYPES = new Set([
  "chat.read",
  "chat.unread",
  "chat.read_all",
]);

export const STRUCTURED_PUSH_TIME_FIELDS = [
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "completedAt",
  "lastRunAt",
  "archivedAt",
  "answeredAt",
  "resolvedAt",
  "timestamp",
  "expiresAt",
  "readAt",
  "pushedAt",
] as const;

export const FINISHED_AWAITING_STATUSES = new Set([
  "answered",
  "cancelled",
  "canceled",
  "completed",
  "done",
  "error",
  "expired",
  "failed",
  "resolved",
  "timeout"
]);

export type AssistantNavigationChatsSnapshot = {
  chatItems: AssistantNavChatItem[];
  chatItemsHasMore: boolean;
};

export type AssistantNavigationChatOrderSnapshot = {
  pinnedChatItems: AssistantNavChatItem[];
  chatPinningSupported: boolean;
  chatSortMode: AssistantChatSortMode;
  chatOrderingSupported: boolean;
};
