import { isObjectRecord } from "./navigation-values";
import { type AgentPlatformApiResponse, NAVIGATION_AGENT_CHAT_LIMIT } from "./navigation-contracts";
import { type AssistantNavAgentItem } from "../../../shared/contracts";
import { enrichNavigationAgentsWithGitBranches } from "./navigation-workspace";
import {
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
  return await enrichNavigationAgentsWithGitBranches(
    buildAssistantNavigationAgentsFromPlatformAgents(agents, includeChatLimit),
  );
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
  const agents = await readApiJson<unknown[]>(
    `${createApiUrl(baseUrl, "/api/agents")}?hasWorkspace=false&includeChats=${NAVIGATION_AGENT_CHAT_LIMIT}&chatsPinned=false`,
    token,
  );
  return buildAssistantNavigationAgentsFromPlatformAgents(agents, NAVIGATION_AGENT_CHAT_LIMIT);
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
