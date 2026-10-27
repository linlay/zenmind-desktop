import { isObjectRecord } from "./navigation-values";
import { type AgentPlatformApiResponse, type PlatformChatSummary, NAVIGATION_AGENT_CHAT_LIMIT } from "./navigation-contracts";
import { type AssistantNavAgentItem, type AssistantNavChatItem } from "../../../shared/contracts";
import { enrichNavigationAgentsWithGitBranches } from "./navigation-workspace";
import {
  mapNavigationChat,
  buildAssistantNavigationAgentsFromPlatformAgents,
  buildAssistantCopilotAgentsFromPlatformAgents
} from "./navigation-projections";

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

export async function readAssistantNavigationAgentsFromPlatform(
  baseUrl: string,
  token: string,
  includeChatLimit = NAVIGATION_AGENT_CHAT_LIMIT
): Promise<AssistantNavAgentItem[]> {
  const agents = await readAssistantNavigationAgentsFromPlatformScope(baseUrl, token, "nav", includeChatLimit, false);
  return await enrichNavigationAgentsWithGitBranches(
    buildAssistantNavigationAgentsFromPlatformAgents(agents, includeChatLimit),
  );
}

export async function readAssistantNavigationAgentsFromPlatformScope(
  baseUrl: string,
  token: string,
  scope: "nav" | "copilot",
  includeChatLimit = NAVIGATION_AGENT_CHAT_LIMIT,
  chatsPinned?: boolean,
): Promise<unknown[]> {
  return await readApiJson<unknown[]>(
    `${createApiUrl(baseUrl, "/api/agents")}?includeChats=${encodeURIComponent(String(includeChatLimit))}&scope=${scope}${chatsPinned === undefined ? "" : `&chatsPinned=${chatsPinned}`}`,
    token
  );
}

// Sidebar Projects: every agent with a project directory plus its recent
// unpinned chats, in one request. Visibility scope is not part of this query.
export async function readAssistantNavigationProjectAgentsFromPlatform(
  baseUrl: string,
  token: string,
  includeChatLimit = NAVIGATION_AGENT_CHAT_LIMIT
): Promise<AssistantNavAgentItem[]> {
  const agents = await readApiJson<unknown[]>(
    `${createApiUrl(baseUrl, "/api/agents")}?hasWorkspace=true&includeChats=${encodeURIComponent(String(includeChatLimit))}&chatsPinned=false`,
    token
  );
  const projects = buildAssistantNavigationAgentsFromPlatformAgents(agents, includeChatLimit);
  const orderedProjects = await Promise.all(projects.map(async (agent) => {
    // Project unread totals include old and pinned Chats outside the sidebar window.
    // Keep their identities and read cursors in the same Navigation baseline.
    const chats = await readApiJson<PlatformChatSummary[]>(
      `${createApiUrl(baseUrl, "/api/chats")}?agentKey=${encodeURIComponent(agent.agentKey)}`,
      token,
    );
    const attentionChats = chats.map((chat, index) => mapNavigationChat(
      chat, agent.agentKey, `navigation.projects.${agent.agentKey}.chats[${index}]`,
    )).filter((chat): chat is NonNullable<typeof chat> => Boolean(chat));
    const projectChats = attentionChats.filter((chat) => !chat.pinned).slice(0, includeChatLimit);
    const unreadCount = attentionChats.filter((chat) => chat.isRead === false).length;
    return {
      ...agent, attentionChats, projectChats, unreadCount, unreadChatCount: unreadCount,
      hasPendingAwaiting: attentionChats.some((chat) => chat.hasPendingAwaiting),
    };
  }));
  return await enrichNavigationAgentsWithGitBranches(orderedProjects);
}

// Chat-type agents the user can start a conversation with. This is an agent
// directory only; their conversations come from the global chat list.
export async function readAssistantNavigationChatAgentsFromPlatform(
  baseUrl: string,
  token: string
): Promise<AssistantNavAgentItem[]> {
  const agents = await readApiJson<unknown[]>(
    `${createApiUrl(baseUrl, "/api/agents")}?scope=nav&hasWorkspace=false`,
    token
  );
  return buildAssistantNavigationAgentsFromPlatformAgents(agents, 0);
}

// Runtime activity must not inherit the sidebar's manual order or 24-chat
// window, nor the new-chat picker's visibility scope.
export async function readAssistantNavigationChatActivityFromPlatform(
  baseUrl: string,
  token: string,
): Promise<AssistantNavAgentItem[]> {
  const [agents, chats] = await Promise.all([
    readApiJson<unknown[]>(
      `${createApiUrl(baseUrl, "/api/agents")}?hasWorkspace=false&includeChats=${NAVIGATION_AGENT_CHAT_LIMIT}&chatsPinned=false`,
      token,
    ),
    readApiJson<PlatformChatSummary[]>(
      `${createApiUrl(baseUrl, "/api/chats")}?hasWorkspace=false`,
      token,
    ),
  ]);
  const chatsByAgent = new Map<string, AssistantNavChatItem[]>();
  for (const [index, rawChat] of chats.entries()) {
    const chat = mapNavigationChat(rawChat, "", `navigation.chatActivity.chats[${index}]`);
    if (!chat?.agentKey) continue;
    const ownerChats = chatsByAgent.get(chat.agentKey) ?? [];
    ownerChats.push(chat);
    chatsByAgent.set(chat.agentKey, ownerChats);
  }
  const activity = buildAssistantNavigationAgentsFromPlatformAgents(agents, NAVIGATION_AGENT_CHAT_LIMIT);
  const knownAgentKeys = new Set(activity.map((agent) => agent.agentKey));
  for (const [agentKey, attentionChats] of chatsByAgent) {
    if (knownAgentKeys.has(agentKey)) continue;
    // Deleted catalog owners can still have published Chat history. Only their
    // attention is retained; no history is added to task/tray recency windows.
    activity.push({
      agentKey, displayName: agentKey, role: "", unreadCount: 0, unreadChatCount: 0,
      chatCount: attentionChats.length, hasPendingAwaiting: false,
      latestChatId: null, latestPreview: "", recentChats: [],
    });
  }
  return activity.map((agent) => {
    const attentionChats = chatsByAgent.get(agent.agentKey) ?? [];
    const unreadCount = attentionChats.filter((chat) => chat.isRead === false).length;
    return {
      ...agent, attentionChats, unreadCount, unreadChatCount: unreadCount,
      hasPendingAwaiting: attentionChats.some((chat) => chat.hasPendingAwaiting),
    };
  });
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

export async function readAssistantNavigationAgentOrderFromPlatform(baseUrl: string, token: string) {
  const response = await fetch(createApiUrl(baseUrl, "/api/agents/order"), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (response.status === 404 || response.status === 405) return null;
  if (!response.ok) throw new Error(`agent-platform returned HTTP ${response.status}`);
  const data = unwrapApiResponse<{ order: string[] }>(await response.json());
  if (!data || !Array.isArray(data.order) || data.order.some(key => typeof key !== "string" || !key.trim()) ||
      new Set(data.order.map(key => key.trim())).size !== data.order.length) throw new Error("invalid Agent catalog order");
  return data.order.map(key => key.trim());
}

export function orderNavigationAgents(items: AssistantNavAgentItem[], order: string[] | null) {
  if (!order) return items;
  const byKey = new Map(items.map(agent => [agent.agentKey, agent]));
  const ordered = order.flatMap(key => {
    const agent = byKey.get(key);
    byKey.delete(key);
    return agent ? [agent] : [];
  });
  // A concurrently created Agent may arrive before its order snapshot.
  return [...ordered, ...byKey.values()];
}
