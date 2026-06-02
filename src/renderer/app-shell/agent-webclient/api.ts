import type {
  Agent,
  AgentDetailResponse,
  AgentEditorOptionsResponse,
  AgentOrderResponse,
  AutomationDetailResponse,
  AutomationExecutionsRequest,
  AutomationExecutionListResponse,
  AutomationListRequest,
  AutomationListResponse,
  CreateAgentRequest,
  CreateAutomationRequest,
  DeleteAgentRequest,
  DeleteAutomationRequest,
  GetAgentsOptions,
  Team,
  ToggleAutomationRequest,
  UpdateAgentOrderRequest,
  UpdateAgentRequest,
  UpdateAutomationRequest
} from "./types";

async function requestAgentPlatform<T>(input: {
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}): Promise<T> {
  const api = window.electronAPI.agentPlatform?.request;
  if (!api) {
    throw new Error("当前窗口尚未连接智能体平台桥接，请重启 ZenMind 后重试。");
  }

  let result: Awaited<ReturnType<typeof api<T>>>;
  try {
    result = await api<T>(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("agentPlatform.request") || message.includes("No handler registered")) {
      throw new Error("当前窗口尚未连接智能体平台桥接，请重启 ZenMind 后重试。");
    }
    throw error;
  }
  if (!result.ok) {
    throw new Error(result.message || "agent-platform request failed");
  }
  return result.data as T;
}

export function getAgents(options: GetAgentsOptions = {}) {
  return requestAgentPlatform<Agent[]>({
    path: "/api/agents",
    query: {
      includeChats: options.includeChats,
      scope: options.scope
    }
  });
}

export function getAgentOrder() {
  return requestAgentPlatform<AgentOrderResponse>({
    path: "/api/agents/order"
  });
}

export function putAgentOrder(params: UpdateAgentOrderRequest) {
  return requestAgentPlatform<AgentOrderResponse>({
    path: "/api/agents/order",
    method: "PUT",
    body: params
  });
}

export function getAgent(agentKey: string) {
  return requestAgentPlatform<AgentDetailResponse>({
    path: "/api/agent",
    query: { agentKey }
  });
}

export function createAgent(params: CreateAgentRequest) {
  return requestAgentPlatform<AgentDetailResponse>({
    path: "/api/agent/create",
    method: "POST",
    body: params
  });
}

export function updateAgent(params: UpdateAgentRequest) {
  return requestAgentPlatform<AgentDetailResponse>({
    path: "/api/agent/update",
    method: "POST",
    body: params
  });
}

export function deleteAgent(params: DeleteAgentRequest) {
  return requestAgentPlatform<{ key: string; deleted: boolean }>({
    path: "/api/agent/delete",
    method: "POST",
    body: params
  });
}

export function getAgentEditorOptions() {
  return requestAgentPlatform<AgentEditorOptionsResponse>({
    path: "/api/agent/editor-options"
  });
}

export function getTools(options: { tag?: string; kind?: string } = {}) {
  return requestAgentPlatform<unknown[]>({
    path: "/api/tools",
    query: {
      tag: options.tag,
      kind: options.kind
    }
  });
}

export function getSkills(tag?: string) {
  return requestAgentPlatform<unknown[]>({
    path: "/api/skills",
    query: { tag }
  });
}

export function getTeams() {
  return requestAgentPlatform<Team[]>({
    path: "/api/teams"
  });
}

export function getAutomations(params: AutomationListRequest = {}) {
  return requestAgentPlatform<AutomationListResponse>({
    path: "/api/automations",
    method: "POST",
    body: params
  });
}

export function getAutomation(id: string) {
  return requestAgentPlatform<AutomationDetailResponse>({
    path: "/api/automation",
    method: "POST",
    body: { id }
  });
}

export function createAutomation(params: CreateAutomationRequest) {
  return requestAgentPlatform<AutomationDetailResponse>({
    path: "/api/automation/create",
    method: "POST",
    body: params
  });
}

export function updateAutomation(params: UpdateAutomationRequest) {
  return requestAgentPlatform<AutomationDetailResponse>({
    path: "/api/automation/update",
    method: "POST",
    body: params
  });
}

export function deleteAutomation(params: DeleteAutomationRequest) {
  return requestAgentPlatform<{ id: string; deleted: boolean }>({
    path: "/api/automation/delete",
    method: "POST",
    body: params
  });
}

export function toggleAutomation(params: ToggleAutomationRequest) {
  return requestAgentPlatform<AutomationDetailResponse>({
    path: "/api/automation/toggle",
    method: "POST",
    body: params
  });
}

export function getAutomationExecutions(params: AutomationExecutionsRequest) {
  return requestAgentPlatform<AutomationExecutionListResponse>({
    path: "/api/automation/executions",
    method: "POST",
    body: params
  });
}

export const __testInternals = {
  requestAgentPlatform
};
