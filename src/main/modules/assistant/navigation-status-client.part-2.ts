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

import { AssistantNavigationApplyResult, AssistantNavigationChatApplyResult, AssistantNavigationChatRuntimeStatusPatch, NAVIGATION_AGENT_CHAT_LIMIT, NAVIGATION_CHAT_LIMIT, NavigationPushEvent, NavigationPushFrame, PlatformAgentSummary, PlatformChatSummary, checkWorkspaceDirExists, compareNavChats, countPendingAwaitingPayload, hasPendingAwaitingPayload, isObjectRecord, mergeNavigationAgentItem, readActiveRunValue, readAgentDisplayName, readAgentIcon, readAgentKey, readAgentWorkspaceDir, readAwaitingPayloadMode, readChatActiveRun, readChatAgentKey, readChatAwaitingCount, readChatAwaitingMode, readChatIsRead, readChatPendingAwaiting, readChatReadAt, readChatReadRunId, resolveAssistantWorkspaceGitBranch, resolveNavigationUnreadCount, toAwaitingMode, toNonNegativeInteger, toOptionalNonNegativeInteger, toText, toTimestampMs, validateNavigationPayloadTimes, validatePresentNavigationTimes } from "./navigation-status-client.part-1";

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

export type AssistantNavigationChatsSnapshot = {
  chatItems: AssistantNavChatItem[];
  chatItemsHasMore: boolean;
};

export type AssistantNavigationChatOrderSnapshot = {
  chatSortMode: AssistantChatSortMode;
  chatOrderingSupported: boolean;
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

export function isWorkspaceProjectAgent(agent: AssistantNavAgentItem) {
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

export function normalizePushType(type: string) {
  if (type === "run.started") {
    return "run.start";
  }
  if (type === "run.finished") {
    return "run.complete";
  }
  return type;
}

export function toPushEvent(frame: NavigationPushFrame): NavigationPushEvent {
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

export function readPushChatUpdateTimestamp(event: NavigationPushEvent) {
  return readAgentPlatformPushEpochMillis(event.type, event);
}

export function readPushAgentKey(event: NavigationPushEvent) {
  return toText(event.agentKey) || toText(event.firstAgentKey);
}

export function readPushChatId(event: NavigationPushEvent) {
  return toText(event.chatId);
}

export function readPushCreatedAt(
  event: NavigationPushEvent,
  fallback?: AssistantNavChatItem["createdAt"],
) {
  if (event.type !== "chat.created" && event.type !== "awaiting.asking") {
    return fallback;
  }
  return toTimestampMs(event.createdAt) ?? fallback;
}

export function readPushPreview(event: NavigationPushEvent) {
  return toText(event.lastRunContent) || toText(event.text) || toText(event.message);
}

export function readPushPendingAwaiting(event: NavigationPushEvent, fallback: boolean) {
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

export function readPushAwaitingCount(event: NavigationPushEvent, hasPendingAwaiting: boolean, fallback = 0) {
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

export function readPushAwaitingMode(
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

export function readPushActiveRun(event: NavigationPushEvent, fallback: boolean) {
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

export function parseRunIdMillis(runId: string): number | undefined {
  const normalized = runId.trim().toLowerCase();
  if (!normalized || !/^[0-9a-z]+$/.test(normalized)) {
    return undefined;
  }
  const millis = Number.parseInt(normalized, 36);
  return Number.isSafeInteger(millis) ? millis : undefined;
}

export function isRunIdAfter(runId: string, cursor: string) {
  const normalizedRunId = runId.trim();
  const normalizedCursor = cursor.trim();
  const runMillis = parseRunIdMillis(normalizedRunId);
  const cursorMillis = parseRunIdMillis(normalizedCursor);
  if (runMillis !== undefined && cursorMillis !== undefined && runMillis !== cursorMillis) {
    return runMillis > cursorMillis;
  }
  return normalizedRunId.localeCompare(normalizedCursor) > 0;
}

export function isValidReadProjectionPush(event: NavigationPushEvent) {
  if (event.type !== "chat.read" && event.type !== "chat.unread") {
    return true;
  }
  const agentUnreadCount = Number(event.agentUnreadCount);
  return Boolean(
    readPushChatId(event) &&
    Object.hasOwn(event, "agentKey") &&
    typeof event.agentKey === "string" &&
    (toText(event.lastRunId) || toText(event.runId)) &&
    Object.hasOwn(event, "readRunId") &&
    typeof event.readRunId === "string" &&
    Number.isInteger(agentUnreadCount) &&
    agentUnreadCount >= 0,
  );
}

export function shouldIgnoreReadStatePush(
  event: NavigationPushEvent,
  current: AssistantNavChatItem,
) {
  const eventLastRunId = toText(event.lastRunId) || toText(event.runId);
  const eventReadRunId = toText(event.readRunId);
  if (event.type === "chat.read") {
    if (!eventReadRunId) {
      return false;
    }
    if (current.lastRunId && isRunIdAfter(current.lastRunId, eventReadRunId)) {
      return true;
    }
    if (current.readRunId && isRunIdAfter(current.readRunId, eventReadRunId)) {
      return true;
    }
    const eventReadAt = toTimestampMs(event.readAt);
    return Boolean(
      current.isRead &&
      current.readRunId === eventReadRunId &&
      current.readAt !== undefined &&
      eventReadAt !== undefined &&
      current.readAt > eventReadAt,
    );
  }

  if (!eventLastRunId || !isRunIdAfter(eventLastRunId, eventReadRunId)) {
    return true;
  }
  if (current.lastRunId && isRunIdAfter(current.lastRunId, eventLastRunId)) {
    return true;
  }
  if (current.isRead && current.readRunId && !isRunIdAfter(eventLastRunId, current.readRunId)) {
    return true;
  }
  const eventCreatedAt = toTimestampMs(event.createdAt);
  return Boolean(
    current.isRead &&
    !current.readRunId &&
    current.readAt !== undefined &&
    eventCreatedAt !== undefined &&
    eventCreatedAt <= current.readAt,
  );
}

export function createChatPatchFromPush(event: NavigationPushEvent, current?: AssistantNavChatItem): AssistantNavChatItem | null {
  const chatId = readPushChatId(event);
  if (!chatId) {
    return null;
  }
  const preview = readPushPreview(event);
  const agentKey = readPushAgentKey(event) || current?.agentKey || "";
  const chatName = toText(event.chatName) || current?.chatName || t("assistant.newChat");
  const eventTimestamp = readPushChatUpdateTimestamp(event);
  const isReadStatePush = event.type === "chat.read" || event.type === "chat.unread";
  const canReuseCurrentTimestamp = isReadStatePush;
  if (eventTimestamp === undefined && (!canReuseCurrentTimestamp || !current)) {
    return null;
  }
  const createdAt = readPushCreatedAt(event, current?.createdAt) ?? eventTimestamp;
  const updatedAt = event.type === "chat.read"
    ? current?.updatedAt
    : eventTimestamp ?? current?.updatedAt;
  if (createdAt === undefined || updatedAt === undefined) {
    return null;
  }

  if (isReadStatePush && current && shouldIgnoreReadStatePush(event, current)) {
    return current;
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
    readAt: event.type === "chat.read"
      ? toTimestampMs(event.readAt)
      : current?.readAt,
    readRunId: isReadStatePush
      ? toText(event.readRunId)
      : current?.readRunId || "",
    hasActiveRun: readPushActiveRun(event, current?.hasActiveRun ?? false),
    hasPendingAwaiting,
    awaitingCount: readPushAwaitingCount(event, hasPendingAwaiting, current?.awaitingCount),
    awaitingMode: readPushAwaitingMode(event, hasPendingAwaiting, current?.awaitingMode)
  };
}

export function readPushUnreadCount(event: NavigationPushEvent, fallback: number, change: "increment" | "decrement" | "preserve") {
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

export function refreshAgentDerivedFields(agent: AssistantNavAgentItem): AssistantNavAgentItem {
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

export function createChatRuntimeStatusPatch(
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

export function applyChatRuntimeStatusPatch(
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

export function applyChatRuntimeStatusToAgents(
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
    items: changed ? nextItems : currentItems,
    changed,
    shouldRefresh: !changed,
  };
}

export function applyChatRuntimeStatusToChats(
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

export function findAgentIndexForPush(items: AssistantNavAgentItem[], event: NavigationPushEvent) {
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
