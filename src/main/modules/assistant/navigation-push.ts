import {
  type NavigationPushFrame,
  type NavigationPushEvent,
  type AssistantNavigationChatRuntimeStatusPatch,
  type AssistantNavigationApplyResult,
  type AssistantNavigationChatApplyResult,
  IGNORED_PUSH_TYPES
} from "./navigation-contracts";
import {
  isObjectRecord,
  toText,
  toTimestampMs,
  toNonNegativeInteger,
  hasPendingAwaitingPayload,
  countPendingAwaitingPayload,
  toAwaitingMode
} from "./navigation-values";
import { readAgentPlatformPushEpochMillis, validateAgentPlatformPushTimeContract } from "../../../shared/agent-platform-push-time-contract";
import { type AssistantNavChatItem, type AssistantAwaitingMode, type AssistantNavAgentItem } from "../../../shared/contracts";
import { readAwaitingPayloadMode, readActiveRunValue, limitNavigationChats, resolveNavigationUnreadCount } from "./navigation-projections";
import { t } from "../../support/i18n/main-i18n";

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
    ...(current?.pinned ? { pinned: true } : {}),
    ...(current?.mode ? { mode: current.mode } : {}),
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
  const recentChats = limitNavigationChats(agent.recentChats);
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
  if (!isValidReadProjectionPush(event)) {
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
      unreadCount: readPushUnreadCount(event, nextAgent.unreadCount, "preserve"),
      unreadChatCount: readPushUnreadCount(event, nextAgent.unreadChatCount, "preserve"),
      recentChats: nextAgent.recentChats.map((chat) => ({
        ...chat,
        isRead: true,
        readRunId: chat.lastRunId || chat.readRunId,
      }))
    });
    nextItems[agentIndex] = nextAgent;
    return { items: nextItems, changed: true, shouldRefresh: false };
  }

  if (type === "chat.deleted" || type === "chat.archived") {
    if (!chatId || !currentChat) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    nextAgent.recentChats = nextAgent.recentChats.filter((chat) => chat.chatId !== chatId);
    nextAgent.chatCount = Math.max(0, nextAgent.chatCount - (chatIndex >= 0 ? 1 : 0));
    nextAgent.unreadCount = currentChat && !currentChat.isRead ? Math.max(0, nextAgent.unreadCount - 1) : nextAgent.unreadCount;
    nextItems[agentIndex] = refreshAgentDerivedFields(nextAgent);
    return { items: nextItems, changed: true, shouldRefresh: true };
  }

  if (type === "chat.read" || type === "chat.unread") {
    if (!currentChat) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    const patch = createChatPatchFromPush(event, currentChat);
    if (!patch) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    if (patch === currentChat) {
      return { items: currentItems, changed: false, shouldRefresh: false };
    }
    nextAgent.recentChats[chatIndex] = patch;
    nextAgent.unreadCount = readPushUnreadCount(
      event,
      nextAgent.unreadCount,
      type === "chat.read" ? "decrement" : "increment"
    );
    nextItems[agentIndex] = refreshAgentDerivedFields(nextAgent);
    return { items: nextItems, changed: true, shouldRefresh: false };
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
      items: nextItems,
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
  if (!isValidReadProjectionPush(event)) {
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
      return {
        ...chat,
        isRead: true,
        readRunId: chat.lastRunId || chat.readRunId,
      };
    });
    return { items: nextItems, changed, shouldRefresh: !changed };
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
    if (patch === currentItems[chatIndex]) {
      return { items: currentItems, changed: false, shouldRefresh: false };
    }
    const nextItems = currentItems.slice();
    nextItems[chatIndex] = patch;
    return { items: nextItems, changed: true, shouldRefresh: false };
  }

  return { items: currentItems, changed: false, shouldRefresh: true };
}
