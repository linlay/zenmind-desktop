export const AGENT_WEBCLIENT_SERVICE_ID = "agent-webclient";
export const AGENT_WEBCLIENT_TARGET_PATH = "/agents";

export type AgentWebclientRouteKey =
  | "agents"
  | "schedules"
  | "memory"
  | "copilot"
  | "agent-chat"
  | "assistant-target";

export type AgentWebclientRouteKind = "management" | "copilot" | "chat";
export type AgentWebclientRouteMode = "embedded" | "native";

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
    mode: "native"
  },
  {
    key: "schedules",
    routePath: "/schedules",
    embedPath: "/schedules",
    labelKey: "nav.schedules",
    kind: "management",
    mode: "native"
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

export function findAgentWebclientRouteDefinition(pathname: string) {
  return AGENT_WEBCLIENT_ROUTE_DEFINITIONS.find((item) => item.routePath === pathname) ?? null;
}

export function isEmbeddedAgentWebclientRoute(route: AgentWebclientResolvedRoute | null | undefined) {
  return route?.mode === "embedded";
}
