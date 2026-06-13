export interface AgentPlatformIpcHandlerOptions {
  app: any;
  callAgentPlatform: ((app: any, path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>) | null;
}

export interface AgentPlatformRequestInput {
  path?: unknown;
  method?: unknown;
  query?: unknown;
  body?: unknown;
}

export interface AgentPlatformRequest {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

const ALLOWED_AGENT_PLATFORM_REQUESTS = new Set([
  "GET /api/agents",
  "GET /api/agents/order",
  "PUT /api/agents/order",
  "GET /api/agent",
  "GET /api/admin/agents",
  "GET /api/admin/agents/detail",
  "GET /api/admin/agents/order",
  "POST /api/admin/agents/create",
  "POST /api/admin/agents/update",
  "POST /api/admin/agents/delete",
  "GET /api/admin/agents/editor-options",
  "GET /api/teams",
  "GET /api/skills",
  "GET /api/tools",
  "GET /api/tool",
  "POST /api/automations",
  "POST /api/automation",
  "POST /api/admin/automations/create",
  "POST /api/admin/automations/update",
  "POST /api/admin/automations/delete",
  "POST /api/admin/automations/toggle",
  "POST /api/automation/executions"
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeMethod(value: unknown): AgentPlatformRequest["method"] {
  const method = String(value || "GET").trim().toUpperCase();
  if (method === "GET" || method === "POST" || method === "PUT" || method === "DELETE") {
    return method;
  }
  throw new Error(`unsupported agent-platform method: ${method || "(empty)"}`);
}

function normalizePath(value: unknown) {
  const path = String(value || "").trim();
  if (!path.startsWith("/api/")) {
    throw new Error("agent-platform path must start with /api/");
  }
  if (path.includes("://") || path.startsWith("//")) {
    throw new Error("agent-platform path must be relative");
  }
  return path;
}

function appendQuery(path: string, query: unknown) {
  const queryRecord = asRecord(query);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(queryRecord)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }
  const queryText = params.toString();
  if (!queryText) {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}${queryText}`;
}

export function normalizeAgentPlatformRequest(input: AgentPlatformRequestInput): AgentPlatformRequest {
  const method = normalizeMethod(input.method);
  const rawPath = normalizePath(input.path);
  const pathForAllowlist = rawPath.split("?")[0];
  const allowKey = `${method} ${pathForAllowlist}`;
  if (!ALLOWED_AGENT_PLATFORM_REQUESTS.has(allowKey)) {
    throw new Error(`agent-platform endpoint is not allowed: ${allowKey}`);
  }

  return {
    path: method === "GET" ? appendQuery(rawPath, input.query) : rawPath,
    method,
    ...(method === "GET" ? {} : { body: input.body })
  };
}

export function registerAgentPlatformIpcHandlers(ipcMain: any, options: AgentPlatformIpcHandlerOptions) {
  ipcMain.handle("agentPlatform.request", async (_event: any, input: AgentPlatformRequestInput) => {
    try {
      if (!options.callAgentPlatform) {
        throw new Error("agent-platform bridge is unavailable");
      }
      const request = normalizeAgentPlatformRequest(input);
      const data = await options.callAgentPlatform(options.app, request.path, {
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body })
      });
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

export const __testInternals = {
  normalizeAgentPlatformRequest
};
