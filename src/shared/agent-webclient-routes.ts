export const AGENT_WEBCLIENT_SERVICE_ID = "agent-webclient";
export const AGENT_WEBCLIENT_TARGET_PATH = "/agents";

export type AgentWebclientRouteKey =
  | "agents"
  | "archives"
  | "schedules"
  | "memory"
  | "registries"
  | "copilot"
  | "agent-chat"
  | "assistant-target";

export type AgentWebclientRouteKind = "management" | "copilot" | "chat";
export type AgentWebclientRouteMode = "embedded";

export type AgentWebclientRouteDefinition = {
  key: AgentWebclientRouteKey;
  routePath: string;
  embedPath: string;
  labelKey: string;
  kind: AgentWebclientRouteKind;
  mode: AgentWebclientRouteMode;
};

export type AgentWebclientResolvedRoute = {
  key: AgentWebclientRouteKey;
  routePath: string;
  embedPath: string;
  labelKey?: string;
  label?: string;
  kind: AgentWebclientRouteKind;
  mode: AgentWebclientRouteMode;
};

export const AGENT_WEBCLIENT_ROUTE_DEFINITIONS = [
  {
    key: "agents",
    routePath: "/agents",
    embedPath: "/agents",
    labelKey: "nav.agents",
    kind: "management",
    mode: "embedded"
  },
  {
    key: "archives",
    routePath: "/archives",
    embedPath: "/archives",
    labelKey: "nav.archives",
    kind: "management",
    mode: "embedded"
  },
  {
    key: "schedules",
    routePath: "/automations",
    embedPath: "/automations",
    labelKey: "nav.schedules",
    kind: "management",
    mode: "embedded"
  },
  {
    key: "memory",
    routePath: "/memory",
    embedPath: "/memory",
    labelKey: "nav.memory",
    kind: "management",
    mode: "embedded"
  },
  {
    key: "registries",
    routePath: "/registries",
    embedPath: "/registries",
    labelKey: "nav.registries",
    kind: "management",
    mode: "embedded"
  },
  {
    key: "copilot",
    routePath: "/copilot",
    embedPath: "/copilot",
    labelKey: "nav.assistants",
    kind: "copilot",
    mode: "embedded"
  }
] as const satisfies readonly AgentWebclientRouteDefinition[];

export const AGENT_WEBCLIENT_DYNAMIC_ROUTE_PATTERNS = [
  "/agents/:agentKey",
  "/copilot/:agentKey",
  "/agent/:agentKey"
] as const;

const AGENT_WEBCLIENT_CHAT_SURFACE_IDS = new Set([
  "agent-webclient-chat",
  "agent-webclient-kanban-chat"
]);
const AGENT_WEBCLIENT_COPILOT_SURFACE_IDS = new Set([
  "agent-webclient-copilot",
  "agent-webclient-copilot-dock",
  "agent-webclient-quick-copilot"
]);

export function resolveAgentWebclientWsSource(
  surfaceId: string,
  embedPath: string | undefined
): "desktop-chat" | "desktop-copilot" | undefined {
  const normalizedSurfaceId = surfaceId.trim();
  if (AGENT_WEBCLIENT_CHAT_SURFACE_IDS.has(normalizedSurfaceId)) {
    return "desktop-chat";
  }
  if (AGENT_WEBCLIENT_COPILOT_SURFACE_IDS.has(normalizedSurfaceId)) {
    return "desktop-copilot";
  }

  const normalizedEmbedPath = (embedPath ?? "").trim();
  if (normalizedEmbedPath.startsWith("/agent/")) {
    return "desktop-chat";
  }
  if (
    normalizedEmbedPath === "/copilot" ||
    normalizedEmbedPath.startsWith("/copilot/") ||
    normalizedEmbedPath.startsWith("/copilot?")
  ) {
    return "desktop-copilot";
  }
  return undefined;
}

export function findAgentWebclientRouteDefinition(pathname: string) {
  return AGENT_WEBCLIENT_ROUTE_DEFINITIONS.find((item) => item.routePath === pathname) ?? null;
}

export function isEmbeddedAgentWebclientRoute(route: AgentWebclientResolvedRoute | null | undefined) {
  return route?.mode === "embedded";
}
