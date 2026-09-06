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

import { AssistantNavigationApplyResult, AssistantNavigationChatApplyResult, IGNORED_PUSH_TYPES, NAVIGATION_AGENT_CHAT_LIMIT, NavigationPushFrame, createApiUrl, readApiJson } from "./navigation-status-client.part-1";

import { applyChatRuntimeStatusToAgents, applyChatRuntimeStatusToChats, buildAssistantCopilotAgentsFromPlatformAgents, buildAssistantNavigationAgentsFromPlatformAgents, createChatPatchFromPush, createChatRuntimeStatusPatch, enrichNavigationAgentsWithGitBranches, findAgentIndexForPush, isValidReadProjectionPush, mergeNavigationAgentGroups, readPushAgentKey, readPushChatId, readPushUnreadCount, refreshAgentDerivedFields, toPushEvent } from "./navigation-status-client.part-2";

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

export async function readAssistantNavigationAgentsFromPlatformScope(
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
