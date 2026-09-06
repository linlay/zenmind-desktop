import fs from "node:fs";

import { execFile } from "node:child_process";

import type { App } from "electron";

import type {
  AgentAuthIssueResult,
  AssistantChatSortMode,
  AssistantAwaitingMode,
  AssistantNavAgentIcon,
  AssistantNavAgentItem,
  AssistantNavAgentItemsResult,
  AssistantNavChatItem,
  AssistantNavigationLiveFrame,
  AssistantNavigationPushEvent,
  AssistantNavigationLiveStatus,
  ServiceId,
  ServiceState
} from "../../../shared/contracts";

import {
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot,
} from "../../infrastructure/filesystem/profile-store";

import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

import {
  isTimeContractViolation,
  isAgentPlatformEpochMilliseconds,
  parseOptionalNullableAgentPlatformEpochMillis,
  requireAgentPlatformEpochMillis,
  requireEpochMillis,
} from "../../../shared/time-contract";

import {
  readAgentPlatformPushEpochMillis,
  validateAgentPlatformPushTimeContract,
} from "../../../shared/agent-platform-push-time-contract";

import { t } from "../../support/i18n/main-i18n";

import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  RealtimeBroker,
} from "../agent-platform";

import type { AgentPlatformRealtimeFrame } from "../agent-platform";

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

export type AssistantGitBranchCacheEntry = {
  branch: string;
  expiresAt: number;
};

export type AssistantGitBranchCommandRunner = (
  command: string,
  args: string[],
) => Promise<string>;

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

export const NAVIGATION_GIT_BRANCH_CACHE_MS = 15_000;

export const NAVIGATION_GIT_BRANCH_TIMEOUT_MS = 1_000;

export const navigationGitBranchCache = new Map<string, AssistantGitBranchCacheEntry>();

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

export function nowEpochMillis() {
  return requireEpochMillis(Date.now(), "desktop.assistantNavigation.now");
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function toAwaitingMode(value: unknown): AssistantAwaitingMode | undefined {
  const mode = toText(value).toLowerCase();
  return mode === "approval" ||
    mode === "question" ||
    mode === "form" ||
    mode === "planning"
    ? mode
    : undefined;
}

export function readAgentWorkspaceDir(agent: PlatformAgentSummary) {
  return (
    toText(agent.workspaceDir) ||
    toText(agent.workspaceRoot) ||
    toText(agent.workspace?.root) ||
    toText(agent.runtimeConfig?.workspaceRoot)
  );
}

export function checkWorkspaceDirExists(workspaceDir: string) {
  if (!workspaceDir || workspaceDir === "@chat") {
    return false;
  }
  try {
    return fs.existsSync(workspaceDir) && fs.statSync(workspaceDir).isDirectory();
  } catch {
    return false;
  }
}

export function resolveAssistantGitExecutable(platform: NodeJS.Platform) {
  if (platform === "win32") {
    return "git.exe";
  }
  if (platform === "darwin") {
    return "git";
  }
  return "git";
}

export function runAssistantGitBranchCommand(command: string, args: string[]) {
  return new Promise<string>((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: NAVIGATION_GIT_BRANCH_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(error || typeof stdout !== "string" ? "" : stdout.trim());
      },
    );
  });
}

export async function resolveAssistantWorkspaceGitBranch(
  workspaceDir: string,
  options: {
    platform?: NodeJS.Platform;
    now?: () => number;
    cache?: Map<string, AssistantGitBranchCacheEntry>;
    runCommand?: AssistantGitBranchCommandRunner;
  } = {},
) {
  const normalizedWorkspaceDir = workspaceDir.trim();
  if (!checkWorkspaceDirExists(normalizedWorkspaceDir)) {
    return "";
  }

  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? navigationGitBranchCache;
  const cacheKey = `${platform}:${normalizedWorkspaceDir}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now()) {
    return cached.branch;
  }

  const runCommand = options.runCommand ?? runAssistantGitBranchCommand;
  let branch = "";
  try {
    branch = (await runCommand(
      resolveAssistantGitExecutable(platform),
      ["-C", normalizedWorkspaceDir, "branch", "--show-current"],
    )).trim();
  } catch {
    branch = "";
  }

  cache.set(cacheKey, {
    branch,
    expiresAt: now() + NAVIGATION_GIT_BRANCH_CACHE_MS,
  });
  return branch;
}

export function toFiniteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function toNonNegativeInteger(value: unknown) {
  return Math.max(0, Math.round(toFiniteNumber(value)));
}

export function toOptionalNonNegativeInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.max(0, Math.round(numeric))
    : undefined;
}

export function isFinishedAwaitingStatus(value: string) {
  return FINISHED_AWAITING_STATUSES.has(value);
}

export function hasPendingAwaitingPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasPendingAwaitingPayload(item));
  }
  if (!isObjectRecord(value)) {
    return false;
  }

  const type = toText(value.type).toLowerCase();
  if (type === "awaiting.answered") {
    return false;
  }

  const status = toText(value.status).toLowerCase();
  if (isFinishedAwaitingStatus(status)) {
    return false;
  }

  if (isObjectRecord(value.answer)) {
    const answerType = toText(value.answer.type).toLowerCase();
    const answerStatus = toText(value.answer.status).toLowerCase();
    if (
      answerType === "awaiting.answered" ||
      isFinishedAwaitingStatus(answerStatus)
    ) {
      return false;
    }
  }

  if (value.hasPendingAwaiting === true) {
    return true;
  }
  if (value.hasPendingAwaiting === false) {
    return false;
  }
  if (toNonNegativeInteger(value.awaitingCount) > 0) {
    return true;
  }
  if (
    type === "awaiting.asking" ||
    status === "awaiting" ||
    status === "pending" ||
    toText(value.awaitingId)
  ) {
    return true;
  }
  return hasPendingAwaitingPayload(value.awaiting);
}

export function countPendingAwaitingPayload(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countPendingAwaitingPayload(item), 0);
  }
  if (!isObjectRecord(value) || !hasPendingAwaitingPayload(value)) {
    return 0;
  }

  const explicitCount = toNonNegativeInteger(value.awaitingCount);
  if (explicitCount > 0) {
    return explicitCount;
  }
  const nestedCount = countPendingAwaitingPayload(value.awaiting);
  return nestedCount > 0 ? nestedCount : 1;
}

export function toTimestampMs(value: unknown) {
  return isAgentPlatformEpochMilliseconds(value) ? value : undefined;
}

export function validatePresentNavigationTimes(record: Record<string, unknown>, path: string) {
  for (const field of STRUCTURED_PUSH_TIME_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) {
      parseOptionalNullableAgentPlatformEpochMillis(record[field], `${path}.${field}`);
    }
  }
}

export function validateNavigationPayloadTimes(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNavigationPayloadTimes(item, `${path}[${index}]`));
    return;
  }
  if (!isObjectRecord(value)) {
    return;
  }
  validatePresentNavigationTimes(value, path);
  if (value.awaiting !== undefined) {
    validateNavigationPayloadTimes(value.awaiting, `${path}.awaiting`);
  }
}

export function createApiUrl(baseUrl: string, pathname: string) {
  const url = new URL(pathname, baseUrl);
  return url.toString();
}

export const ASSISTANT_NAVIGATION_WS_SOURCE = "desktop-nav";

export function createRedactedWsEndpoint(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function unwrapApiResponse<T>(payload: unknown): T {
  if (isObjectRecord(payload) && "code" in payload && "data" in payload) {
    const response = payload as AgentPlatformApiResponse<T>;
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data as T;
  }
  return payload as T;
}

export async function readApiJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`agent-platform returned HTTP ${response.status}`);
  }
  return unwrapApiResponse<T>(await response.json());
}

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
  return [...chatsById.values()].sort(compareNavChats).slice(0, NAVIGATION_AGENT_CHAT_LIMIT);
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
