import type { AssistantNavAgentIcon } from "../../../shared/contracts";

export interface Agent {
  key?: string;
  name?: string;
  role?: string;
  description?: string;
  icon?: AssistantNavAgentIcon | unknown;
  mode?: string;
  model?: string;
  modelKey?: string;
  tools?: string[];
  skills?: string[];
  wonders?: string[];
  modelConfig?: Record<string, unknown>;
  toolConfig?: Record<string, unknown>;
  skillConfig?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface Team {
  teamId?: string;
  id?: string;
  name?: string;
  agentKeys?: string[];
  agents?: unknown[];
  members?: unknown[];
}

export interface GetAgentsOptions {
  includeChats?: number;
  scope?: "nav" | "copilot" | "invoke" | "internal" | "all";
}

export interface AgentSource {
  kind: string;
  path?: string;
  agentDir?: string;
}

export interface AgentDetailResponse {
  key: string;
  name: string;
  type?: "agent" | "coder";
  workspaceDir?: string;
  workspaceName?: string;
  icon?: AssistantNavAgentIcon | unknown;
  description?: string;
  role?: string;
  wonders?: string[];
  model: string;
  mode: string;
  tools: string[];
  skills: string[];
  controls: Array<Record<string, unknown>>;
  meta: Record<string, unknown>;
  definition?: Record<string, unknown>;
  soulPrompt?: string;
  agentsPrompt?: string;
  source?: AgentSource;
}

export interface AgentEditorOption {
  key: string;
  label: string;
}

export interface AgentEditorModelOption {
  key: string;
  name?: string;
  provider?: string;
  modelId?: string;
  protocol?: string;
  isVision?: boolean;
  contextWindow?: number;
}

export interface AgentEditorProxyConfigSchema {
  fields?: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
  }>;
  defaultTimeoutMs?: number;
}

export interface AgentEditorOptionsResponse {
  models: AgentEditorModelOption[];
  contextTags: AgentEditorOption[];
  visibilityScopes?: AgentEditorOption[];
  modes: AgentEditorOption[];
  proxyConfigSchema?: AgentEditorProxyConfigSchema;
}

export interface CreateAgentRequest {
  key?: string;
  definition: Record<string, unknown>;
  soulPrompt?: string;
  agentsPrompt?: string;
}

export interface UpdateAgentRequest {
  key: string;
  definition: Record<string, unknown>;
  soulPrompt?: string;
  agentsPrompt?: string;
}

export interface DeleteAgentRequest {
  key: string;
}

export interface UpdateAgentOrderRequest {
  order: string[];
}

export interface AgentOrderResponse {
  version: number;
  order: string[];
  updatedAt: number;
}

export interface AutomationListRequest {
  tag?: string;
}

export interface AutomationListResponse {
  items: AutomationSummaryResponse[];
  total: number;
}

export interface AutomationExecutionListResponse {
  items: AutomationExecutionResponse[];
  total: number;
}

export interface AutomationExecutionBrief {
  id: string;
  status: string;
  startedAt: number;
  durationMs?: number;
  error?: string;
}

export interface AutomationSummaryResponse {
  id: string;
  name: string;
  description: string;
  cron: string;
  agentKey: string;
  enabled: boolean;
  teamId?: string;
  zoneId?: string;
  sourceFile?: string;
  remainingRuns?: number;
  nextFireTime?: string;
  lastExecution?: AutomationExecutionBrief;
}

export interface AutomationQueryResponse {
  message: string;
  chatId?: string;
  role?: string;
  params?: Record<string, unknown>;
  hidden?: boolean;
}

export interface AutomationDetailResponse extends AutomationSummaryResponse {
  query: AutomationQueryResponse;
}

export interface AutomationExecutionResponse {
  id: string;
  automationId: string;
  automationName: string;
  sourceFile: string;
  agentKey: string;
  teamId: string;
  status: string;
  error: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
}

export interface AutomationQueryRequest {
  message: string;
  chatId?: string;
  role?: string;
  params?: Record<string, unknown>;
  hidden?: boolean;
}

export interface CreateAutomationRequest {
  name: string;
  description: string;
  cron: string;
  agentKey: string;
  enabled?: boolean;
  teamId?: string;
  zoneId?: string;
  remainingRuns?: number;
  query: AutomationQueryRequest;
}

export interface UpdateAutomationRequest {
  id: string;
  name?: string;
  description?: string;
  cron?: string;
  agentKey?: string;
  teamId?: string;
  zoneId?: string;
  enabled?: boolean;
  remainingRuns?: number;
  query?: AutomationQueryRequest;
}

export interface ToggleAutomationRequest {
  id: string;
  enabled: boolean;
}

export interface DeleteAutomationRequest {
  id: string;
}

export interface AutomationExecutionsRequest {
  id: string;
  limit?: number;
  offset?: number;
}
