export const AGENT_WEBCLIENT_SERVICE_ID = "agent-webclient";
export const AGENT_WEBCLIENT_TARGET_PATH = "/agents";

export type AgentWebclientRouteKey =
  | "agents"
  | "archives"
  | "schedules"
  | "memory"
  | "registries"
  | "skills"
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
    key: "skills",
    routePath: "/skills",
    embedPath: "/skills",
    labelKey: "nav.skills",
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
  "agent-webclient-copilot-dock"
]);

export function createAgentWebclientRoute(request: {
  agentKey?: string | null;
  chatId?: string | null;
}) {
  const agentKey = request.agentKey?.trim() ?? "";
  if (!agentKey) {
    return AGENT_WEBCLIENT_TARGET_PATH;
  }

  const params = new URLSearchParams();
  const chatId = request.chatId?.trim() ?? "";
  if (chatId) {
    params.set("chatId", chatId);
  }
  const query = params.toString();
  return `/agent/${encodeURIComponent(agentKey)}${query ? `?${query}` : ""}`;
}

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

const AGENT_WEBCLIENT_HOST_ROUTE_QUERY_PARAMS = new Set([
  "theme",
  "hostTheme",
  "lang",
  "wsSource"
]);

export function areAgentWebclientHostRouteParamsEqual(
  currentUrl: string,
  targetUrl: string
): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return Array.from(AGENT_WEBCLIENT_HOST_ROUTE_QUERY_PARAMS).every(
      (key) => current.searchParams.get(key) === target.searchParams.get(key)
    );
  } catch {
    return false;
  }
}

interface AgentWebclientChatNavigationIdentity {
  origin: string;
  agentKey: string;
  hash: string;
  businessQueryEntries: Array<readonly [string, string]>;
}

function decodeAgentKey(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function resolveAgentWebclientChatNavigationIdentity(
  value: string
): AgentWebclientChatNavigationIdentity | null {
  try {
    const url = new URL(value);
    const match = /^\/agent\/([^/]+)$/.exec(url.pathname);
    const agentKey = match ? decodeAgentKey(match[1]) : null;
    if (!agentKey) {
      return null;
    }

    const businessQueryEntries = Array.from(url.searchParams.entries())
      .filter(([key]) => !AGENT_WEBCLIENT_HOST_ROUTE_QUERY_PARAMS.has(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        const keyOrder = leftKey.localeCompare(rightKey);
        return keyOrder || leftValue.localeCompare(rightValue);
      });

    return {
      origin: url.origin,
      agentKey,
      hash: url.hash,
      businessQueryEntries
    };
  } catch {
    return null;
  }
}

/**
 * Compare an embedded main-chat URL by its WebClient business route identity.
 *
 * Desktop-owned presentation parameters can be added in a different order as
 * the WebClient promotes `newChat` to `chatId`; they must not replay the route
 * inside the already-running WebView. Every other query parameter is business
 * state and deliberately remains part of the identity.
 */
export function areAgentWebclientChatNavigationUrlsEquivalent(
  currentUrl: string,
  targetUrl: string
): boolean {
  const current = resolveAgentWebclientChatNavigationIdentity(currentUrl);
  const target = resolveAgentWebclientChatNavigationIdentity(targetUrl);
  if (!current || !target) {
    return false;
  }

  if (
    current.origin !== target.origin ||
    current.agentKey !== target.agentKey ||
    current.hash !== target.hash ||
    current.businessQueryEntries.length !== target.businessQueryEntries.length
  ) {
    return false;
  }

  return current.businessQueryEntries.every(
    ([key, value], index) =>
      target.businessQueryEntries[index]?.[0] === key &&
      target.businessQueryEntries[index]?.[1] === value
  );
}

export function findAgentWebclientRouteDefinition(pathname: string) {
  return AGENT_WEBCLIENT_ROUTE_DEFINITIONS.find((item) => item.routePath === pathname) ?? null;
}

export function isEmbeddedAgentWebclientRoute(route: AgentWebclientResolvedRoute | null | undefined) {
  return route?.mode === "embedded";
}
