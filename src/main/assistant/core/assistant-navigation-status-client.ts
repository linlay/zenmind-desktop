import fs from "node:fs";
import { execFile } from "node:child_process";
import type { App } from "electron";
import type {
  AgentAuthIssueResult,
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
import { getDesktopDeviceId } from "../../device-identity";
import { t } from "../../i18n/main-i18n";

type AgentPlatformApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type PlatformActiveRunSummary = {
  runId?: unknown;
  agentKey?: unknown;
  teamId?: unknown;
  state?: unknown;
  lastSeq?: unknown;
  oldestSeq?: unknown;
  startedAt?: unknown;
  planningMode?: unknown;
};

type PlatformChatSummary = {
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
  activeRun?: PlatformActiveRunSummary | null;
  awaiting?: unknown;
  hasPendingAwaiting?: unknown;
  awaitingCount?: unknown;
  awaitingMode?: unknown;
  mode?: unknown;
  status?: unknown;
};

type PlatformAgentSummary = {
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

type NavigationPushFrame = {
  frame?: unknown;
  type?: unknown;
  payload?: unknown;
  data?: unknown;
  [key: string]: unknown;
};

type NavigationPushEvent = {
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

type MinimalWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

type AssistantGitBranchCacheEntry = {
  branch: string;
  expiresAt: number;
};

type AssistantGitBranchCommandRunner = (
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

type AssistantNavigationChatRuntimeStatusPatch = {
  chatId: string;
  lastRunId?: string;
  hasActiveRun?: boolean;
  hasPendingAwaiting: boolean;
  awaitingCount: number;
  awaitingMode?: AssistantAwaitingMode;
};

type AssistantNavigationRecordedRuntimeStatusPush = {
  sequence: number;
  frame: NavigationPushFrame;
};

const NAVIGATION_RUNTIME_ACTIVE_RUN_OVERRIDE_LIMIT = 256;

const AGENT_PLATFORM_SERVICE_ID: ServiceId = "agent-platform";
const NAVIGATION_AGENT_HISTORY_LIMIT = 50;
const NAVIGATION_AGENT_CHAT_LIMIT = NAVIGATION_AGENT_HISTORY_LIMIT;
const NAVIGATION_CHAT_LIMIT = 8;
const NAVIGATION_CHAT_PROBE_LIMIT = NAVIGATION_CHAT_LIMIT + 1;
const NAVIGATION_CHAT_AGENT_MODE = "REACT";
const NAVIGATION_REFRESH_DEBOUNCE_MS = 350;
const NAVIGATION_WS_REQUEST_TIMEOUT_MS = 8_000;
const NAVIGATION_UNAVAILABLE_RETRY_MS = 12_000;
const NAVIGATION_RECONNECT_MS = 10_000;
const NAVIGATION_LIVE_FRAME_LIMIT = 20;
const NAVIGATION_GIT_BRANCH_CACHE_MS = 15_000;
const NAVIGATION_GIT_BRANCH_TIMEOUT_MS = 1_000;
const navigationGitBranchCache = new Map<string, AssistantGitBranchCacheEntry>();
const IGNORED_PUSH_TYPES = new Set(["heartbeat", "live.connected"]);
const STRUCTURED_PUSH_TIME_FIELDS = [
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
const FINISHED_AWAITING_STATUSES = new Set([
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

function nowEpochMillis() {
  return requireEpochMillis(Date.now(), "desktop.assistantNavigation.now");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAwaitingMode(value: unknown): AssistantAwaitingMode | undefined {
  const mode = toText(value).toLowerCase();
  return mode === "approval" ||
    mode === "question" ||
    mode === "form" ||
    mode === "planning"
    ? mode
    : undefined;
}

function readAgentWorkspaceDir(agent: PlatformAgentSummary) {
  return (
    toText(agent.workspaceDir) ||
    toText(agent.workspaceRoot) ||
    toText(agent.workspace?.root) ||
    toText(agent.runtimeConfig?.workspaceRoot)
  );
}

function checkWorkspaceDirExists(workspaceDir: string) {
  if (!workspaceDir || workspaceDir === "@chat") {
    return false;
  }
  try {
    return fs.existsSync(workspaceDir) && fs.statSync(workspaceDir).isDirectory();
  } catch {
    return false;
  }
}

function resolveAssistantGitExecutable(platform: NodeJS.Platform) {
  if (platform === "win32") {
    return "git.exe";
  }
  if (platform === "darwin") {
    return "git";
  }
  return "git";
}

function runAssistantGitBranchCommand(command: string, args: string[]) {
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

function toFiniteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toNonNegativeInteger(value: unknown) {
  return Math.max(0, Math.round(toFiniteNumber(value)));
}

function toOptionalNonNegativeInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.max(0, Math.round(numeric))
    : undefined;
}

function isFinishedAwaitingStatus(value: string) {
  return FINISHED_AWAITING_STATUSES.has(value);
}

function hasPendingAwaitingPayload(value: unknown): boolean {
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

function countPendingAwaitingPayload(value: unknown): number {
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

function toTimestampMs(value: unknown) {
  return isAgentPlatformEpochMilliseconds(value) ? value : undefined;
}

function validatePresentNavigationTimes(record: Record<string, unknown>, path: string) {
  for (const field of STRUCTURED_PUSH_TIME_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) {
      parseOptionalNullableAgentPlatformEpochMillis(record[field], `${path}.${field}`);
    }
  }
}

function validateNavigationPayloadTimes(value: unknown, path: string): void {
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

function createApiUrl(baseUrl: string, pathname: string) {
  const url = new URL(pathname, baseUrl);
  return url.toString();
}

const ASSISTANT_NAVIGATION_WS_SOURCE = "desktop-nav";

function createWsUrl(baseUrl: string, token: string, source = "", deviceId = "") {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token.trim()) {
    url.searchParams.set("token", token.trim());
  }
  url.searchParams.set("source", source.trim());
  url.searchParams.set("deviceId", deviceId.trim());
  return url.toString();
}

function createRedactedWsEndpoint(baseUrl: string) {
  try {
    const url = new URL("/ws", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  } catch {
    return null;
  }
}

function getWebSocketConstructor(): MinimalWebSocketConstructor | null {
  const candidate = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : null;
}

function unwrapApiResponse<T>(payload: unknown): T {
  if (isObjectRecord(payload) && "code" in payload && "data" in payload) {
    const response = payload as AgentPlatformApiResponse<T>;
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data as T;
  }
  return payload as T;
}

async function readApiJson<T>(url: string, token: string): Promise<T> {
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

function readAgentKey(agent: PlatformAgentSummary) {
  return toText(agent.key);
}

function readAgentDisplayName(agent: PlatformAgentSummary, fallback: string) {
  return toText(agent.name) || toText(agent.displayName) || fallback;
}

function readAgentIcon(agent: PlatformAgentSummary): AssistantNavAgentIcon | undefined {
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

function readChatAgentKey(chat: PlatformChatSummary, fallbackAgentKey = "") {
  return toText(chat.agentKey) || toText(chat.firstAgentKey) || fallbackAgentKey;
}

function readChatIsRead(chat: PlatformChatSummary) {
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

function readChatPendingAwaiting(chat: PlatformChatSummary) {
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

function readChatAwaitingCount(chat: PlatformChatSummary) {
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

function readAwaitingPayloadMode(value: unknown): AssistantAwaitingMode | undefined {
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

function readChatAwaitingMode(chat: PlatformChatSummary): AssistantAwaitingMode | undefined {
  // Top-level mode is the chat's Agent Mode (for example REACT), not an
  // awaiting interaction mode. Awaiting state is carried separately.
  return (
    toAwaitingMode(chat.awaitingMode) ||
    readAwaitingPayloadMode(chat.awaiting)
  );
}

function readActiveRunValue(value: unknown): boolean | null {
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

function readChatActiveRun(chat: PlatformChatSummary) {
  return isObjectRecord(chat.activeRun) && !Array.isArray(chat.activeRun);
}

function compareNavChats(left: AssistantNavChatItem, right: AssistantNavChatItem) {
  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  return left.chatId.localeCompare(right.chatId);
}

function readAgentTimestamp(agent: AssistantNavAgentItem) {
  return agent.updatedAt ?? undefined;
}

function compareNavigationAgents(left: AssistantNavAgentItem, right: AssistantNavAgentItem) {
  const rightTime = readAgentTimestamp(right);
  const leftTime = readAgentTimestamp(left);
  if (rightTime !== undefined && leftTime !== undefined && rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  if (leftTime === undefined && rightTime !== undefined) {
    return 1;
  }
  if (leftTime !== undefined && rightTime === undefined) {
    return -1;
  }
  const displayNameComparison = left.displayName.localeCompare(right.displayName, "zh-CN");
  if (displayNameComparison !== 0) {
    return displayNameComparison;
  }
  return left.agentKey.localeCompare(right.agentKey);
}

function sortNavigationAgents(items: AssistantNavAgentItem[]) {
  return [...items].sort(compareNavigationAgents);
}

function mergeNavigationChats(
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

function resolveNavigationUnreadCount(options: {
  statsUnreadCount: number | undefined;
  unreadFromChats: number;
}) {
  return options.statsUnreadCount ?? options.unreadFromChats;
}

function pickLatestTimestamp(
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

function mergeNavigationAgentItem(
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

function mergeNavigationAgentGroups(
  primaryItems: AssistantNavAgentItem[],
  secondaryItems: AssistantNavAgentItem[]
) {
  const agentsByKey = new Map<string, AssistantNavAgentItem>();
  for (const agent of primaryItems) {
    agentsByKey.set(agent.agentKey, agent);
  }
  for (const agent of secondaryItems) {
    const existing = agentsByKey.get(agent.agentKey);
    agentsByKey.set(agent.agentKey, existing ? mergeNavigationAgentItem(existing, agent) : agent);
  }
  return sortNavigationAgents([...agentsByKey.values()]);
}

function mapNavigationChat(
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
  const chatName = toText(chat.chatName) || toText(chat.name) || toText(chat.title) || lastRunContent || t("assistant.newChat");
  return {
    chatId,
    chatName,
    agentKey: readChatAgentKey(chat, fallbackAgentKey),
    createdAt,
    updatedAt,
    lastRunId: toText(chat.lastRunId),
    lastRunContent,
    isRead: readChatIsRead(chat),
    hasActiveRun: readChatActiveRun(chat),
    hasPendingAwaiting: readChatPendingAwaiting(chat),
    awaitingCount: readChatAwaitingCount(chat),
    awaitingMode: readChatAwaitingMode(chat)
  };
}

export type AssistantNavigationChatsSnapshot = {
  chatItems: AssistantNavChatItem[];
  chatItemsHasMore: boolean;
};

export function buildAssistantNavigationChatsSnapshotFromPlatform(
  chats: unknown,
): AssistantNavigationChatsSnapshot {
  if (!Array.isArray(chats)) {
    return { chatItems: [], chatItemsHasMore: false };
  }
  const validChats: AssistantNavChatItem[] = [];
  for (const [index, rawChat] of chats.entries()) {
    const chat = mapNavigationChat(rawChat as PlatformChatSummary, "", `navigation.chats[${index}]`);
    if (!chat?.agentKey) {
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

function isWorkspaceProjectAgent(agent: AssistantNavAgentItem) {
  const mode = agent.mode?.trim().toUpperCase() ?? "";
  return mode === "CODER" || mode === "KBASE";
}

export async function enrichNavigationAgentsWithGitBranches(
  items: AssistantNavAgentItem[],
  resolveGitBranch: (workspaceDir: string) => Promise<string> = resolveAssistantWorkspaceGitBranch,
) {
  const branchesByWorkspace = new Map<string, Promise<string>>();
  for (const agent of items) {
    const workspaceDir = agent.workspaceDir?.trim() ?? "";
    if (!isWorkspaceProjectAgent(agent) || !workspaceDir || agent.workspaceDirExists === false) {
      continue;
    }
    if (!branchesByWorkspace.has(workspaceDir)) {
      branchesByWorkspace.set(workspaceDir, resolveGitBranch(workspaceDir));
    }
  }

  if (branchesByWorkspace.size === 0) {
    return items;
  }

  const resolvedBranches = new Map<string, string>();
  await Promise.all(
    [...branchesByWorkspace.entries()].map(async ([workspaceDir, branch]) => {
      resolvedBranches.set(workspaceDir, await branch);
    }),
  );
  return items.map((agent) => {
    const workspaceDir = agent.workspaceDir?.trim() ?? "";
    const gitBranch = workspaceDir ? resolvedBranches.get(workspaceDir)?.trim() ?? "" : "";
    return gitBranch ? { ...agent, gitBranch } : agent;
  });
}

function readAgentRawChatLists(agent: PlatformAgentSummary): unknown[][] {
  return [
    agent.chats,
    agent.recentChats,
    agent.relatedChats,
    agent.chatList,
    agent.conversations
  ].filter((candidate): candidate is unknown[] => Array.isArray(candidate));
}

function readAgentChats(agent: PlatformAgentSummary, agentKey: string, agentPath: string): AssistantNavChatItem[] {
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

function createNavigationAgentItem(agent: PlatformAgentSummary, includeChatLimit: number, path: string): AssistantNavAgentItem | null {
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

function createCopilotAgentItem(agent: PlatformAgentSummary, path: string): AssistantNavAgentItem | null {
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
  return sortNavigationAgents(agents
    .map((agent, index) => createNavigationAgentItem(agent, includeChatLimit, `navigation.agents[${index}]`))
    .filter((agent): agent is AssistantNavAgentItem => Boolean(agent)));
}

export function buildAssistantCopilotAgentsFromPlatformAgents(agentsInput: unknown): AssistantNavAgentItem[] {
  const agents = Array.isArray(agentsInput) ? agentsInput as PlatformAgentSummary[] : [];
  return sortNavigationAgents(agents
    .map((agent, index) => createCopilotAgentItem(agent, `copilot.agents[${index}]`))
    .filter((agent): agent is AssistantNavAgentItem => Boolean(agent)));
}

function normalizePushType(type: string) {
  if (type === "run.started") {
    return "run.start";
  }
  if (type === "run.finished") {
    return "run.complete";
  }
  return type;
}

function toPushEvent(frame: NavigationPushFrame): NavigationPushEvent {
  const nestedRecord = isObjectRecord(frame.payload)
    ? frame.payload
    : isObjectRecord(frame.data)
      ? frame.data
      : {};
  const { frame: _frame, payload: _payload, data: _data, ...topLevel } = frame;
  const type = normalizePushType(toText(frame.type) || toText(nestedRecord.type));
  return {
    ...nestedRecord,
    ...topLevel,
    type
  } as NavigationPushEvent;
}

function readPushChatUpdateTimestamp(event: NavigationPushEvent) {
  return readAgentPlatformPushEpochMillis(event.type, event);
}

function readPushAgentKey(event: NavigationPushEvent) {
  return toText(event.agentKey) || toText(event.firstAgentKey);
}

function readPushChatId(event: NavigationPushEvent) {
  return toText(event.chatId);
}

function readPushCreatedAt(
  event: NavigationPushEvent,
  fallback?: AssistantNavChatItem["createdAt"],
) {
  if (event.type !== "chat.created" && event.type !== "awaiting.asking") {
    return fallback;
  }
  return toTimestampMs(event.createdAt) ?? fallback;
}

function readPushPreview(event: NavigationPushEvent) {
  return toText(event.lastRunContent) || toText(event.text) || toText(event.message);
}

function readPushPendingAwaiting(event: NavigationPushEvent, fallback: boolean) {
  if (event.type === "awaiting.asking") {
    return true;
  }
  if (
    event.type === "awaiting.answered" ||
    event.type === "run.start" ||
    event.type === "run.complete"
  ) {
    return false;
  }
  if (event.hasPendingAwaiting === true) {
    return true;
  }
  if (event.hasPendingAwaiting === false) {
    return false;
  }
  if (toNonNegativeInteger(event.awaitingCount) > 0) {
    return true;
  }
  if (hasPendingAwaitingPayload(event.awaiting)) {
    return true;
  }
  if (toText(event.status).toLowerCase() === "awaiting") {
    return true;
  }
  return fallback;
}

function readPushAwaitingCount(event: NavigationPushEvent, hasPendingAwaiting: boolean, fallback = 0) {
  if (!hasPendingAwaiting) {
    return 0;
  }
  const explicitCount = toNonNegativeInteger(event.awaitingCount);
  if (explicitCount > 0) {
    return explicitCount;
  }
  const payloadCount = countPendingAwaitingPayload(event.awaiting);
  if (payloadCount > 0) {
    return payloadCount;
  }
  return Math.max(1, toNonNegativeInteger(fallback));
}

function readPushAwaitingMode(
  event: NavigationPushEvent,
  hasPendingAwaiting: boolean,
  fallback?: AssistantAwaitingMode,
) {
  if (!hasPendingAwaiting) {
    return undefined;
  }
  return (
    toAwaitingMode(event.awaitingMode) ||
    toAwaitingMode(event.mode) ||
    readAwaitingPayloadMode(event.awaiting) ||
    fallback
  );
}

function readPushActiveRun(event: NavigationPushEvent, fallback: boolean) {
  if (event.type === "run.start") {
    return true;
  }
  if (event.type === "run.complete") {
    return false;
  }
  const explicitActiveRun = readActiveRunValue(event.hasActiveRun);
  if (explicitActiveRun !== null) {
    return explicitActiveRun;
  }
  const activeRun = readActiveRunValue(event.activeRun);
  if (activeRun !== null) {
    return activeRun;
  }
  const running = readActiveRunValue(event.running);
  if (running !== null) {
    return running;
  }
  const status = toText(event.status).toLowerCase();
  if (status === "running" || status === "active" || status === "in_progress") {
    return true;
  }
  if (status === "done" || status === "finished" || status === "complete" || status === "completed") {
    return false;
  }
  return fallback;
}

function createChatPatchFromPush(event: NavigationPushEvent, current?: AssistantNavChatItem): AssistantNavChatItem | null {
  const chatId = readPushChatId(event);
  if (!chatId) {
    return null;
  }
  const preview = readPushPreview(event);
  const agentKey = readPushAgentKey(event) || current?.agentKey || "";
  const chatName = toText(event.chatName) || current?.chatName || preview || t("assistant.newChat");
  const eventTimestamp = readPushChatUpdateTimestamp(event);
  const canReuseCurrentTimestamp = event.type === "chat.read" || event.type === "chat.unread";
  if (eventTimestamp === undefined && (!canReuseCurrentTimestamp || !current)) {
    return null;
  }
  const createdAt = readPushCreatedAt(event, current?.createdAt) ?? eventTimestamp;
  const updatedAt = eventTimestamp ?? current?.updatedAt;
  if (createdAt === undefined || updatedAt === undefined) {
    return null;
  }
  let isRead = current?.isRead ?? true;
  if (event.type === "chat.read") {
    isRead = true;
  } else if (event.type === "chat.unread") {
    isRead = false;
  } else if (typeof event.isRead === "boolean") {
    isRead = event.isRead;
  } else if (typeof event.read === "boolean") {
    isRead = event.read;
  } else if (isObjectRecord(event.read) && typeof event.read.isRead === "boolean") {
    isRead = event.read.isRead;
  }
  const hasPendingAwaiting = readPushPendingAwaiting(event, current?.hasPendingAwaiting ?? false);
  return {
    chatId,
    chatName,
    agentKey,
    createdAt,
    updatedAt,
    lastRunId: toText(event.lastRunId) || toText(event.runId) || current?.lastRunId || "",
    lastRunContent: preview || current?.lastRunContent || "",
    isRead,
    hasActiveRun: readPushActiveRun(event, current?.hasActiveRun ?? false),
    hasPendingAwaiting,
    awaitingCount: readPushAwaitingCount(event, hasPendingAwaiting, current?.awaitingCount),
    awaitingMode: readPushAwaitingMode(event, hasPendingAwaiting, current?.awaitingMode)
  };
}

function readPushUnreadCount(event: NavigationPushEvent, fallback: number, change: "increment" | "decrement" | "preserve") {
  if (event.agentUnreadCount !== undefined) {
    return toNonNegativeInteger(event.agentUnreadCount);
  }
  if (event.unreadCount !== undefined) {
    return toNonNegativeInteger(event.unreadCount);
  }
  if (change === "increment") {
    return toNonNegativeInteger(fallback + 1);
  }
  if (change === "decrement") {
    return toNonNegativeInteger(fallback - 1);
  }
  return fallback;
}

function refreshAgentDerivedFields(agent: AssistantNavAgentItem): AssistantNavAgentItem {
  const recentChats = [...agent.recentChats].sort(compareNavChats).slice(0, NAVIGATION_AGENT_CHAT_LIMIT);
  const latestChat = recentChats[0] ?? null;
  const unreadFromChats = recentChats.filter((chat) => !chat.isRead).length;
  const unreadCount = resolveNavigationUnreadCount({
    statsUnreadCount: agent.unreadCount,
    unreadFromChats,
  });
  const latestPreview = latestChat
    ? (latestChat.lastRunContent || latestChat.chatName).replace(/\s+/gu, " ").trim()
    : "";
  return {
    ...agent,
    recentChats,
    unreadCount,
    unreadChatCount: unreadCount,
    hasPendingAwaiting: recentChats.some((chat) => chat.hasPendingAwaiting),
    latestChatId: latestChat?.chatId ?? null,
    latestPreview: latestPreview.slice(0, 120),
    ...(agent.updatedAt !== undefined ? { updatedAt: agent.updatedAt } : {})
  };
}

function createChatRuntimeStatusPatch(
  event: NavigationPushEvent,
): AssistantNavigationChatRuntimeStatusPatch | null {
  const chatId = readPushChatId(event);
  if (!chatId) {
    return null;
  }
  if (event.type === "run.start") {
    return {
      chatId,
      lastRunId: toText(event.runId) || toText(event.lastRunId) || undefined,
      hasActiveRun: true,
      hasPendingAwaiting: false,
      awaitingCount: 0,
    };
  }
  if (event.type === "run.complete") {
    return {
      chatId,
      lastRunId: toText(event.runId) || toText(event.lastRunId) || undefined,
      hasActiveRun: false,
      hasPendingAwaiting: false,
      awaitingCount: 0,
    };
  }
  if (event.type === "awaiting.asking") {
    return {
      chatId,
      hasPendingAwaiting: true,
      awaitingCount: readPushAwaitingCount(event, true),
      awaitingMode: readPushAwaitingMode(event, true),
    };
  }
  if (event.type === "awaiting.answered") {
    return {
      chatId,
      hasPendingAwaiting: false,
      awaitingCount: 0,
    };
  }
  return null;
}

function applyChatRuntimeStatusPatch(
  chat: AssistantNavChatItem,
  patch: AssistantNavigationChatRuntimeStatusPatch,
) {
  const nextChat: AssistantNavChatItem = {
    ...chat,
    ...(patch.lastRunId ? { lastRunId: patch.lastRunId } : {}),
    ...(patch.hasActiveRun !== undefined
      ? { hasActiveRun: patch.hasActiveRun }
      : {}),
    hasPendingAwaiting: patch.hasPendingAwaiting,
    awaitingCount: patch.awaitingCount,
  };
  if (patch.awaitingMode) {
    nextChat.awaitingMode = patch.awaitingMode;
  } else {
    delete nextChat.awaitingMode;
  }
  return nextChat;
}

function applyChatRuntimeStatusToAgents(
  currentItems: AssistantNavAgentItem[],
  patch: AssistantNavigationChatRuntimeStatusPatch,
): AssistantNavigationApplyResult {
  let changed = false;
  const nextItems = currentItems.map((agent) => {
    let agentChanged = false;
    const recentChats = agent.recentChats.map((chat) => {
      if (chat.chatId !== patch.chatId) {
        return chat;
      }
      agentChanged = true;
      changed = true;
      return applyChatRuntimeStatusPatch(chat, patch);
    });
    return agentChanged
      ? refreshAgentDerivedFields({ ...agent, recentChats })
      : agent;
  });
  return {
    items: changed ? sortNavigationAgents(nextItems) : currentItems,
    changed,
    shouldRefresh: !changed,
  };
}

function applyChatRuntimeStatusToChats(
  currentItems: AssistantNavChatItem[],
  patch: AssistantNavigationChatRuntimeStatusPatch,
): AssistantNavigationChatApplyResult {
  let changed = false;
  const nextItems = currentItems.map((chat) => {
    if (chat.chatId !== patch.chatId) {
      return chat;
    }
    changed = true;
    return applyChatRuntimeStatusPatch(chat, patch);
  });
  return {
    items: changed ? nextItems : currentItems,
    changed,
    shouldRefresh: !changed,
  };
}

function applyActiveRunOverridesToChats(
  currentItems: AssistantNavChatItem[],
  overrides: ReadonlyMap<string, boolean>,
) {
  let changed = false;
  const items = currentItems.map((chat) => {
    const hasActiveRun = overrides.get(chat.chatId);
    if (hasActiveRun === undefined || hasActiveRun === chat.hasActiveRun) {
      return chat;
    }
    changed = true;
    return { ...chat, hasActiveRun };
  });
  return changed ? items : currentItems;
}

function applyActiveRunOverridesToAgents(
  currentItems: AssistantNavAgentItem[],
  overrides: ReadonlyMap<string, boolean>,
) {
  let changed = false;
  const items = currentItems.map((agent) => {
    const recentChats = applyActiveRunOverridesToChats(agent.recentChats, overrides);
    if (recentChats === agent.recentChats) {
      return agent;
    }
    changed = true;
    return refreshAgentDerivedFields({ ...agent, recentChats });
  });
  return changed ? sortNavigationAgents(items) : currentItems;
}

function findAgentIndexForPush(items: AssistantNavAgentItem[], event: NavigationPushEvent) {
  const chatId = readPushChatId(event);
  if (chatId) {
    const chatOwnerIndex = items.findIndex((item) =>
      item.recentChats.some((chat) => chat.chatId === chatId),
    );
    if (chatOwnerIndex >= 0) {
      return chatOwnerIndex;
    }
  }
  const agentKey = readPushAgentKey(event);
  if (agentKey) {
    return items.findIndex((item) => item.agentKey === agentKey);
  }
  return -1;
}

export function applyAssistantNavigationPush(
  currentItems: AssistantNavAgentItem[],
  frame: NavigationPushFrame
): AssistantNavigationApplyResult {
  const event = toPushEvent(frame);
  const type = event.type;
  if (!type) {
    return { items: currentItems, changed: false, shouldRefresh: false };
  }
  if (validateAgentPlatformPushTimeContract(type, event)) {
    return { items: currentItems, changed: false, shouldRefresh: true };
  }
  if (IGNORED_PUSH_TYPES.has(type)) {
    return { items: currentItems, changed: false, shouldRefresh: false };
  }

  const runtimeStatusPatch = createChatRuntimeStatusPatch(event);
  if (runtimeStatusPatch) {
    return applyChatRuntimeStatusToAgents(currentItems, runtimeStatusPatch);
  }

  const agentIndex = findAgentIndexForPush(currentItems, event);
  if (agentIndex < 0) {
    return { items: currentItems, changed: false, shouldRefresh: true };
  }

  const nextItems = currentItems.slice();
  const currentAgent = currentItems[agentIndex];
  let nextAgent = { ...currentAgent, recentChats: currentAgent.recentChats.slice() };
  const chatId = readPushChatId(event);
  const chatIndex = chatId ? nextAgent.recentChats.findIndex((chat) => chat.chatId === chatId) : -1;
  const currentChat = chatIndex >= 0 ? nextAgent.recentChats[chatIndex] : undefined;

  if (type === "chat.read_all") {
    nextAgent = refreshAgentDerivedFields({
      ...nextAgent,
      unreadCount: 0,
      unreadChatCount: 0,
      recentChats: nextAgent.recentChats.map((chat) => ({ ...chat, isRead: true }))
    });
    nextItems[agentIndex] = nextAgent;
    return { items: sortNavigationAgents(nextItems), changed: true, shouldRefresh: false };
  }

  if (type === "chat.deleted" || type === "chat.archived") {
    if (!chatId || !currentChat) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    nextAgent.recentChats = nextAgent.recentChats.filter((chat) => chat.chatId !== chatId);
    nextAgent.chatCount = Math.max(0, nextAgent.chatCount - (chatIndex >= 0 ? 1 : 0));
    nextAgent.unreadCount = currentChat && !currentChat.isRead ? Math.max(0, nextAgent.unreadCount - 1) : nextAgent.unreadCount;
    nextItems[agentIndex] = refreshAgentDerivedFields(nextAgent);
    return { items: sortNavigationAgents(nextItems), changed: true, shouldRefresh: true };
  }

  if (type === "chat.read" || type === "chat.unread") {
    if (!currentChat) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    const patch = createChatPatchFromPush(event, currentChat);
    if (!patch) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    nextAgent.recentChats[chatIndex] = patch;
    nextAgent.unreadCount = readPushUnreadCount(
      event,
      nextAgent.unreadCount,
      type === "chat.read" ? "decrement" : "increment"
    );
    nextItems[agentIndex] = refreshAgentDerivedFields(nextAgent);
    return { items: sortNavigationAgents(nextItems), changed: true, shouldRefresh: false };
  }

  if (
    type === "chat.created" ||
    type === "chat.updated"
  ) {
    if (!currentChat && type !== "chat.created") {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    const patch = createChatPatchFromPush(event, currentChat);
    if (!patch) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    if (chatIndex >= 0) {
      nextAgent.recentChats[chatIndex] = patch;
    } else {
      nextAgent.recentChats.unshift(patch);
      nextAgent.chatCount = Math.max(nextAgent.chatCount + 1, nextAgent.recentChats.length);
    }
    nextAgent.unreadCount = readPushUnreadCount(event, nextAgent.unreadCount, "preserve");
    nextItems[agentIndex] = refreshAgentDerivedFields(nextAgent);
    return {
      items: sortNavigationAgents(nextItems),
      changed: true,
      shouldRefresh: false
    };
  }

  return { items: currentItems, changed: false, shouldRefresh: true };
}

export function applyAssistantNavigationChatPush(
  currentItems: AssistantNavChatItem[],
  frame: NavigationPushFrame
): AssistantNavigationChatApplyResult {
  const event = toPushEvent(frame);
  const type = event.type;
  if (!type) {
    return { items: currentItems, changed: false, shouldRefresh: false };
  }
  if (validateAgentPlatformPushTimeContract(type, event)) {
    return { items: currentItems, changed: false, shouldRefresh: true };
  }
  if (IGNORED_PUSH_TYPES.has(type)) {
    return { items: currentItems, changed: false, shouldRefresh: false };
  }

  const runtimeStatusPatch = createChatRuntimeStatusPatch(event);
  if (runtimeStatusPatch) {
    return applyChatRuntimeStatusToChats(currentItems, runtimeStatusPatch);
  }

  if (type === "chat.read_all") {
    const agentKey = readPushAgentKey(event);
    if (!agentKey) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    let changed = false;
    const nextItems = currentItems.map((chat) => {
      if (chat.agentKey !== agentKey || chat.isRead) {
        return chat;
      }
      changed = true;
      return { ...chat, isRead: true };
    });
    return { items: nextItems, changed, shouldRefresh: false };
  }

  const chatId = readPushChatId(event);
  if (!chatId) {
    return { items: currentItems, changed: false, shouldRefresh: true };
  }
  const chatIndex = currentItems.findIndex((chat) => chat.chatId === chatId);
  if (chatIndex < 0) {
    return { items: currentItems, changed: false, shouldRefresh: true };
  }

  if (type === "chat.deleted" || type === "chat.archived") {
    return { items: currentItems, changed: false, shouldRefresh: true };
  }

  if (
    type === "chat.created" ||
    type === "chat.updated" ||
    type === "chat.read" ||
    type === "chat.unread"
  ) {
    const patch = createChatPatchFromPush(event, currentItems[chatIndex]);
    if (!patch) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    const nextItems = currentItems.slice();
    nextItems[chatIndex] = patch;
    return { items: nextItems, changed: true, shouldRefresh: false };
  }

  return { items: currentItems, changed: false, shouldRefresh: true };
}

export async function readAssistantNavigationAgentsFromPlatform(
  baseUrl: string,
  token: string,
  includeChatLimit = NAVIGATION_AGENT_CHAT_LIMIT
): Promise<AssistantNavAgentItem[]> {
  const agents = await readAssistantNavigationAgentsFromPlatformScope(baseUrl, token, "nav", includeChatLimit);
  return await enrichNavigationAgentsWithGitBranches(
    buildAssistantNavigationAgentsFromPlatformAgents(agents, includeChatLimit),
  );
}

async function readAssistantNavigationAgentsFromPlatformScope(
  baseUrl: string,
  token: string,
  scope: "nav" | "copilot",
  includeChatLimit = NAVIGATION_AGENT_CHAT_LIMIT
): Promise<unknown[]> {
  return await readApiJson<unknown[]>(
    `${createApiUrl(baseUrl, "/api/agents")}?includeChats=${encodeURIComponent(String(includeChatLimit))}&scope=${scope}`,
    token
  );
}

export async function readAssistantNavigationActivityAgentsFromPlatform(
  baseUrl: string,
  token: string,
  includeChatLimit = NAVIGATION_AGENT_CHAT_LIMIT,
  navigationItems?: AssistantNavAgentItem[]
): Promise<AssistantNavAgentItem[]> {
  const navItems = navigationItems ?? await readAssistantNavigationAgentsFromPlatform(baseUrl, token, includeChatLimit);
  let copilotItems: AssistantNavAgentItem[] = [];
  try {
    const copilotAgents = await readAssistantNavigationAgentsFromPlatformScope(baseUrl, token, "copilot", includeChatLimit);
    copilotItems = await enrichNavigationAgentsWithGitBranches(
      buildAssistantNavigationAgentsFromPlatformAgents(copilotAgents, includeChatLimit),
    );
  } catch (error) {
    if (isTimeContractViolation(error)) {
      throw error;
    }
    copilotItems = [];
  }
  return mergeNavigationAgentGroups(navItems, copilotItems);
}

export async function readAssistantCopilotAgentsFromPlatform(
  baseUrl: string,
  token: string
): Promise<AssistantNavAgentItem[]> {
  const agents = await readApiJson<unknown[]>(
    `${createApiUrl(baseUrl, "/api/agents")}?scope=copilot`,
    token
  );
  if (Array.isArray(agents) && agents.length > 0) {
    return await enrichNavigationAgentsWithGitBranches(
      buildAssistantCopilotAgentsFromPlatformAgents(agents),
    );
  }
  const fallbackAgents = await readApiJson<unknown[]>(
    `${createApiUrl(baseUrl, "/api/agents")}?scope=nav`,
    token
  );
  return await enrichNavigationAgentsWithGitBranches(
    buildAssistantCopilotAgentsFromPlatformAgents(fallbackAgents),
  );
}

export class AssistantNavigationStatusClient {
  private ws: MinimalWebSocket | null = null;
  private wsOpenPromise: Promise<void> | null = null;
  private resolveWsOpen: (() => void) | null = null;
  private rejectWsOpen: ((error: Error) => void) | null = null;
  private readonly pendingWsRequests = new Map<string, {
    resolve: (frame: NavigationPushFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private wsRequestSequence = 0;
  private stopped = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight: Promise<AssistantNavAgentItemsResult> | null = null;
  private refreshRequestedWhileInFlight = false;
  private runtimeStatusPushSequence = 0;
  private runtimeStatusPushes: AssistantNavigationRecordedRuntimeStatusPush[] = [];
  private readonly activeRunOverrides = new Map<string, boolean>();
  private latestResult: AssistantNavAgentItemsResult = {
    ok: false,
    items: [],
    activityItems: [],
    chatItems: [],
    chatItemsHasMore: false,
    message: t("assistant.navigationStatusUninitialized"),
    updatedAt: nowEpochMillis()
  };
  private liveStatus: AssistantNavigationLiveStatus = {
    phase: "idle",
    source: ASSISTANT_NAVIGATION_WS_SOURCE,
    endpoint: null,
    connectedAt: null,
    lastMessageAt: null,
    lastRefreshAt: null,
    lastPushType: null,
    lastError: null,
    recentFrames: [],
  };
  private lastBaseUrl = "";
  private lastToken = "";

  constructor(private readonly options: {
    app: App;
    getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
    onSnapshot: (result: AssistantNavAgentItemsResult) => void;
    onPushEvent?: (event: AssistantNavigationPushEvent) => void;
    onDebug?: (message: string) => void;
  }) {}

  start() {
    this.stopped = false;
    this.runtimeStatusPushSequence = 0;
    this.runtimeStatusPushes = [];
    this.activeRunOverrides.clear();
    this.updateLiveStatus({
      phase: "idle",
      endpoint: null,
      connectedAt: null,
      lastMessageAt: null,
      lastRefreshAt: null,
      lastPushType: null,
      lastError: null,
      recentFrames: [],
    });
    this.scheduleRefresh(0);
  }

  stop() {
    this.stopped = true;
    this.refreshRequestedWhileInFlight = false;
    this.runtimeStatusPushes = [];
    this.activeRunOverrides.clear();
    this.clearTimers();
    this.updateLiveStatus({
      phase: "idle",
      endpoint: null,
      connectedAt: null,
      lastMessageAt: null,
      lastRefreshAt: null,
      lastPushType: null,
      lastError: null,
      recentFrames: [],
    });
    this.closeWebSocket();
  }

  getSnapshot() {
    return this.latestResult;
  }

  getLiveStatus(): AssistantNavigationLiveStatus {
    return {
      ...this.liveStatus,
      recentFrames: this.liveStatus.recentFrames.map((frame) => ({ ...frame })),
    };
  }

  scheduleRefresh(delayMs = NAVIGATION_REFRESH_DEBOUNCE_MS) {
    if (this.stopped) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshNow().catch((error) => {
        this.options.onDebug?.(error instanceof Error ? error.message : String(error));
      });
    }, Math.max(0, delayMs));
  }

  async refreshNow(): Promise<AssistantNavAgentItemsResult> {
    if (this.refreshInFlight) {
      this.refreshRequestedWhileInFlight = true;
      return this.refreshInFlight;
    }
    const refresh = this.performRefreshNow();
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) {
        this.refreshInFlight = null;
      }
      if (this.refreshRequestedWhileInFlight && !this.stopped) {
        this.refreshRequestedWhileInFlight = false;
        this.scheduleRefresh(0);
      }
    }
  }

  private async performRefreshNow(): Promise<AssistantNavAgentItemsResult> {
    if (this.stopped) {
      return this.latestResult;
    }
    const runtimeStatusSequenceAtStart = this.runtimeStatusPushSequence;
    this.updateLiveStatus({ lastRefreshAt: nowEpochMillis() });
    try {
      const serviceState = await this.options.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID);
      const baseUrl = serviceState.status === "running" ? serviceState.healthMeta.webUrl.trim() : "";
      if (!baseUrl) {
        const message = t("agentPlatform.notRunning");
        this.updateLiveStatus({
          phase: "unavailable",
          endpoint: null,
          lastError: message,
        });
        this.setSnapshot({
          ok: false,
          items: [],
          chatItems: [],
          chatItemsHasMore: false,
          message,
          updatedAt: nowEpochMillis()
        });
        this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
        return this.latestResult;
      }

      const tokenResult = await this.options.issueAccessToken(this.options.app, "missing");
      const token = tokenResult.ok ? tokenResult.token.trim() : "";
      if (!token) {
        const message = tokenResult.message || t("agentPlatform.accessTokenMissing");
        this.updateLiveStatus({
          phase: "unavailable",
          endpoint: createRedactedWsEndpoint(baseUrl),
          lastError: message,
        });
        this.setSnapshot({
          ok: false,
          items: [],
          chatItems: [],
          chatItemsHasMore: false,
          message,
          updatedAt: nowEpochMillis()
        });
        this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
        return this.latestResult;
      }

      const items = await readAssistantNavigationAgentsFromPlatform(baseUrl, token);
      const activityItems = await readAssistantNavigationActivityAgentsFromPlatform(
        baseUrl,
        token,
        NAVIGATION_AGENT_CHAT_LIMIT,
        items
      );
      await this.connectWebSocket(baseUrl, token);
      const chatSnapshot = await this.requestNavigationChats();
      const refreshedResult = this.applyActiveRunOverrides(this.replayRuntimeStatusPushesSince({
        ok: true,
        items,
        activityItems,
        ...chatSnapshot,
        message: t("assistant.navigationStatusRead"),
        updatedAt: nowEpochMillis()
      }, runtimeStatusSequenceAtStart));
      this.setSnapshot(refreshedResult);
      this.runtimeStatusPushes = this.runtimeStatusPushes.filter(
        (recorded) => recorded.sequence > runtimeStatusSequenceAtStart,
      );
      return this.latestResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onDebug?.(message);
      this.updateLiveStatus({
        phase: this.reconnectTimer ? "reconnecting" : "error",
        lastError: message,
      });
      if (isTimeContractViolation(error)) {
        this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
        throw error;
      }
      this.setSnapshot({
        ok: false,
        items: [],
        chatItems: [],
        chatItemsHasMore: false,
        message,
        updatedAt: nowEpochMillis()
      });
      this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
      return this.latestResult;
    }
  }

  private recordRuntimeStatusPush(
    frame: NavigationPushFrame,
    event: NavigationPushEvent,
  ) {
    if (!createChatRuntimeStatusPatch(event)) {
      return;
    }
    this.runtimeStatusPushSequence += 1;
    this.runtimeStatusPushes.push({
      sequence: this.runtimeStatusPushSequence,
      frame,
    });
    const chatId = readPushChatId(event);
    if (chatId && (event.type === "run.start" || event.type === "run.complete")) {
      this.activeRunOverrides.delete(chatId);
      this.activeRunOverrides.set(chatId, event.type === "run.start");
      while (this.activeRunOverrides.size > NAVIGATION_RUNTIME_ACTIVE_RUN_OVERRIDE_LIMIT) {
        const oldestChatId = this.activeRunOverrides.keys().next().value;
        if (typeof oldestChatId !== "string") {
          break;
        }
        this.activeRunOverrides.delete(oldestChatId);
      }
    }
  }

  private applyActiveRunOverrides(result: AssistantNavAgentItemsResult) {
    if (this.activeRunOverrides.size === 0) {
      return result;
    }
    return {
      ...result,
      items: applyActiveRunOverridesToAgents(result.items, this.activeRunOverrides),
      activityItems: applyActiveRunOverridesToAgents(
        result.activityItems ?? [],
        this.activeRunOverrides,
      ),
      chatItems: applyActiveRunOverridesToChats(result.chatItems, this.activeRunOverrides),
    };
  }

  private replayRuntimeStatusPushesSince(
    result: AssistantNavAgentItemsResult,
    sequence: number,
  ) {
    let nextResult = result;
    for (const recorded of this.runtimeStatusPushes) {
      if (recorded.sequence <= sequence) {
        continue;
      }
      const next = applyAssistantNavigationPush(nextResult.items, recorded.frame);
      const nextActivity = applyAssistantNavigationPush(
        nextResult.activityItems ?? [],
        recorded.frame,
      );
      const nextChats = applyAssistantNavigationChatPush(
        nextResult.chatItems,
        recorded.frame,
      );
      if (!next.changed && !nextActivity.changed && !nextChats.changed) {
        continue;
      }
      nextResult = {
        ...nextResult,
        items: next.items,
        activityItems: nextActivity.items,
        chatItems: nextChats.items,
      };
    }
    return nextResult;
  }

  private setSnapshot(result: AssistantNavAgentItemsResult) {
    this.latestResult = result;
    this.options.onSnapshot(result);
  }

  private updateLiveStatus(update: Partial<Omit<AssistantNavigationLiveStatus, "source">>) {
    this.liveStatus = {
      ...this.liveStatus,
      ...update,
      source: ASSISTANT_NAVIGATION_WS_SOURCE,
    };
  }

  private recordLiveFrame(frame: Omit<AssistantNavigationLiveFrame, "at">) {
    const recentFrames = [
      ...this.liveStatus.recentFrames,
      { ...frame, at: nowEpochMillis() },
    ].slice(-NAVIGATION_LIVE_FRAME_LIMIT);
    this.updateLiveStatus({ recentFrames });
  }

  private connectWebSocket(baseUrl: string, token: string): Promise<void> {
    const WebSocketConstructor = getWebSocketConstructor();
    if (!WebSocketConstructor) {
      this.recordLiveFrame({ direction: "connection", kind: "error", type: null });
      this.updateLiveStatus({
        phase: "error",
        endpoint: createRedactedWsEndpoint(baseUrl),
        lastError: "WebSocket is unavailable",
      });
      return Promise.reject(new Error("WebSocket is unavailable"));
    }
    if (this.ws && this.lastBaseUrl === baseUrl && this.lastToken === token) {
      return this.wsOpenPromise ?? Promise.resolve();
    }
    this.closeWebSocket();
    this.lastBaseUrl = baseUrl;
    this.lastToken = token;
    this.updateLiveStatus({
      phase: "connecting",
      endpoint: createRedactedWsEndpoint(baseUrl),
      lastError: null,
    });
    this.recordLiveFrame({ direction: "connection", kind: "connecting", type: null });
    const socket = new WebSocketConstructor(
      createWsUrl(
        baseUrl,
        token,
        ASSISTANT_NAVIGATION_WS_SOURCE,
        getDesktopDeviceId(this.options.app)
      )
    );
    this.ws = socket;
    this.wsOpenPromise = new Promise<void>((resolve, reject) => {
      this.resolveWsOpen = resolve;
      this.rejectWsOpen = reject;
    });
    socket.onmessage = (event) => this.handleWebSocketMessage(event.data);
    socket.onclose = () => this.handleWebSocketClosed();
    socket.onerror = () => this.handleWebSocketClosed();
    socket.onopen = () => {
      this.recordLiveFrame({ direction: "connection", kind: "connected", type: null });
      this.updateLiveStatus({
        phase: "connected",
        connectedAt: nowEpochMillis(),
        lastError: null,
      });
      this.resolveWsOpen?.();
      this.resolveWsOpen = null;
      this.rejectWsOpen = null;
    };
    return this.wsOpenPromise;
  }

  private async requestNavigationChats(): Promise<AssistantNavigationChatsSnapshot> {
    const socket = this.ws;
    if (!socket) {
      throw new Error("agent-platform WebSocket is unavailable");
    }
    const id = `desktop-nav-chats-${++this.wsRequestSequence}`;
    const frame = await new Promise<NavigationPushFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWsRequests.delete(id);
        reject(new Error("agent-platform WebSocket request timed out"));
      }, NAVIGATION_WS_REQUEST_TIMEOUT_MS);
      this.pendingWsRequests.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({
          frame: "request",
          type: "/api/chats",
          id,
          payload: {
            mode: NAVIGATION_CHAT_AGENT_MODE,
            limit: NAVIGATION_CHAT_PROBE_LIMIT,
          },
        }));
        this.recordLiveFrame({ direction: "outbound", kind: "request", type: "/api/chats" });
      } catch (error) {
        clearTimeout(timer);
        this.pendingWsRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return buildAssistantNavigationChatsSnapshotFromPlatform(
      unwrapApiResponse<unknown[]>(frame),
    );
  }

  private handleWebSocketMessage(data: unknown) {
    if (this.stopped) {
      return;
    }
    const raw = typeof data === "string" ? data : String(data ?? "");
    let frame: NavigationPushFrame;
    try {
      frame = JSON.parse(raw) as NavigationPushFrame;
    } catch {
      this.recordLiveFrame({ direction: "inbound", kind: "invalid", type: null });
      return;
    }
    this.updateLiveStatus({ lastMessageAt: nowEpochMillis() });
    const frameKind = toText(frame.frame);
    const frameType = toText(frame.type) || null;
    const liveFrameKind = frameKind === "response"
      ? "response"
      : frameKind === "error"
        ? "error"
        : frameKind === "push"
          ? "push"
          : "invalid";
    this.recordLiveFrame({ direction: "inbound", kind: liveFrameKind, type: frameType });
    const requestId = toText(frame.id);
    if ((frameKind === "response" || frameKind === "error") && requestId) {
      const pending = this.pendingWsRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingWsRequests.delete(requestId);
        if (frameKind === "error") {
          pending.reject(new Error(toText(frame.msg) || "agent-platform WebSocket request failed"));
        } else {
          pending.resolve(frame);
        }
      }
      return;
    }
    if (frameKind !== "push") {
      return;
    }
    const event = toPushEvent(frame);
    this.updateLiveStatus({ lastPushType: event.type || null });
    const invalidTimeField = validateAgentPlatformPushTimeContract(event.type, event);
    if (invalidTimeField) {
      this.options.onDebug?.(
        `time_contract_violation: navigation.push.${event.type}.${invalidTimeField} violates the push time contract`,
      );
      this.scheduleRefresh();
      return;
    }
    if (IGNORED_PUSH_TYPES.has(event.type)) {
      return;
    }
    this.recordRuntimeStatusPush(frame, event);
    this.options.onPushEvent?.({
      type: event.type,
      chatId: readPushChatId(event) || null,
      runId: toText(event.runId) || toText(event.lastRunId) || null,
      status: toText(event.status) || null
    });
    const next = applyAssistantNavigationPush(this.latestResult.items, frame);
    const hasActivityItems = Array.isArray(this.latestResult.activityItems);
    const nextActivity = hasActivityItems
      ? applyAssistantNavigationPush(this.latestResult.activityItems ?? [], frame)
      : next;
    const nextChats = applyAssistantNavigationChatPush(this.latestResult.chatItems, frame);
    if (next.changed || nextActivity.changed || nextChats.changed) {
      this.setSnapshot({
        ok: true,
        items: next.items,
        activityItems: nextActivity.items,
        chatItems: nextChats.items,
        chatItemsHasMore: this.latestResult.chatItemsHasMore,
        message: t("assistant.navigationNotificationSynced"),
        updatedAt: nowEpochMillis()
      });
    }
    // A new chat cannot be optimistically inserted into the global Chats list:
    // the server owns its ordering and top-eight cutoff. Refresh it immediately
    // so the route mirrored from agent-webclient can select the new list item.
    this.scheduleRefresh(event.type === "chat.created" ? 0 : undefined);
  }

  private handleWebSocketClosed() {
    if (this.stopped) {
      return;
    }
    this.closeWebSocket();
    this.recordLiveFrame({ direction: "connection", kind: "closed", type: null });
    this.updateLiveStatus({
      phase: "reconnecting",
      connectedAt: null,
      lastError: "agent-platform WebSocket closed",
    });
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.scheduleRefresh(0);
    }, NAVIGATION_RECONNECT_MS);
  }

  private closeWebSocket() {
    const socket = this.ws;
    this.ws = null;
    const openError = new Error("agent-platform WebSocket closed");
    this.rejectWsOpen?.(openError);
    this.resolveWsOpen = null;
    this.rejectWsOpen = null;
    this.wsOpenPromise = null;
    for (const [id, pending] of this.pendingWsRequests) {
      clearTimeout(pending.timer);
      pending.reject(openError);
      this.pendingWsRequests.delete(id);
    }
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000, "assistant navigation refresh");
    } catch {
      // Ignore close failures for sockets that are already closing.
    }
  }

  private clearTimers() {
    for (const timer of [this.refreshTimer, this.reconnectTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    this.refreshTimer = null;
    this.reconnectTimer = null;
  }
}

export const __testInternals = {
  NAVIGATION_AGENT_CHAT_LIMIT,
  NAVIGATION_AGENT_HISTORY_LIMIT,
  NAVIGATION_CHAT_LIMIT,
  createWsUrl,
  toPushEvent
};
