import {
  decodeRoutePathSegment,
  encodeRoutePathSegment
} from "./route-path";
import {
  readAgentWebclientCanonicalChatSource,
  readAgentWebclientNewChatSource
} from "./canonical-chat-sync";
import {
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  MAIN_CHAT_SURFACE_ID
} from "./surface-identity";

export const AGENT_WEBCLIENT_SERVICE_ID = "agent-webclient";
export const AGENT_WEBCLIENT_TARGET_PATH = "/agents";

export type AgentWebclientRouteKey =
  | "agents"
  | "archives"
  | "schedules"
  | "memory"
  | "registries"
  | "mcp-servers"
  | "skills"
  | "agent-chat"
  | "assistant-target";

export type AgentWebclientRouteKind = "management" | "chat";
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
    key: "mcp-servers",
    routePath: "/mcp-servers",
    embedPath: "/mcp-servers",
    labelKey: "nav.mcpConnectors",
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
  }
] as const satisfies readonly AgentWebclientRouteDefinition[];

export const AGENT_WEBCLIENT_DYNAMIC_ROUTE_PATTERNS = [
  "/agents/:agentKey",
  "/agent/:agentKey",
  "/skills/:skillKey"
] as const;

const AGENT_WEBCLIENT_CHAT_SURFACE_IDS = new Set([
  MAIN_CHAT_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID
]);
const AGENT_WEBCLIENT_COPILOT_SURFACE_IDS = new Set([
  COPILOT_DOCK_SURFACE_ID
]);

const AGENT_WEBCLIENT_HOST_ROUTE_QUERY_PARAMS = new Set([
  "theme",
  "hostTheme",
  "lang",
  "wsSource"
]);

function normalizeRouteSearch(
  search: string | URLSearchParams | null | undefined
) {
  const query = search instanceof URLSearchParams
    ? search.toString()
    : (search ?? "").trim().replace(/^\?/u, "");
  return query ? `?${query}` : "";
}

export function createAgentWebclientBusinessSearch(
  search: string | URLSearchParams | null | undefined
) {
  const source = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(search ?? "");
  const businessParams = new URLSearchParams();
  for (const [key, value] of source.entries()) {
    if (!AGENT_WEBCLIENT_HOST_ROUTE_QUERY_PARAMS.has(key)) {
      businessParams.append(key, value);
    }
  }
  return businessParams.toString();
}

export function createAgentWebclientAgentPath(
  agentKey: string,
  search?: string | URLSearchParams | null
) {
  const encodedAgentKey = encodeRoutePathSegment(agentKey);
  if (!encodedAgentKey) {
    return AGENT_WEBCLIENT_TARGET_PATH;
  }
  return `/agent/${encodedAgentKey}${normalizeRouteSearch(search)}`;
}

export function createAgentWebclientManagementPath(
  agentKey: string,
  search?: string | URLSearchParams | null
) {
  const encodedAgentKey = encodeRoutePathSegment(agentKey);
  if (!encodedAgentKey) {
    return AGENT_WEBCLIENT_TARGET_PATH;
  }
  return `/agents/${encodedAgentKey}${normalizeRouteSearch(search)}`;
}

export function createAgentWebclientCopilotPath(
  agentKey: string,
  search?: string | URLSearchParams | null
) {
  const encodedAgentKey = encodeRoutePathSegment(agentKey);
  const basePath = encodedAgentKey ? `/copilot/${encodedAgentKey}` : AGENT_WEBCLIENT_TARGET_PATH;
  return `${basePath}${normalizeRouteSearch(search)}`;
}

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
  return createAgentWebclientAgentPath(agentKey, params);
}

export function createAgentWebclientProjectPath(request: {
  agentKey?: string | null;
  chatId?: string | null;
  runId?: string | null;
}) {
  const params = new URLSearchParams();
  const agentKey = request.agentKey?.trim() ?? "";
  const chatId = request.chatId?.trim() ?? "";
  const runId = request.runId?.trim() ?? "";
  const encodedAgentKey = encodeRoutePathSegment(agentKey);
  if (!encodedAgentKey) return "";
  if (chatId) {
    params.set("chatId", chatId);
  }
  if (runId && chatId) {
    params.set("runId", runId);
  }
  const search = params.toString();
  return `/project/${encodedAgentKey}${search ? `?${search}` : ""}`;
}

export function createAgentWebclientOverviewPath(request: {
  chatId: string;
}) {
  const chatId = request.chatId.trim();
  const encodedChatId = encodeRoutePathSegment(chatId);
  return encodedChatId ? `/overview/${encodedChatId}` : "";
}

export function createAgentWebclientBtwPath(request: { chatId: string }) {
  const chatId = request.chatId.trim();
  const encodedChatId = encodeRoutePathSegment(chatId);
  return encodedChatId ? `/btw/${encodedChatId}` : "";
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

export function readAgentWebclientAgentRouteKey(value: string): string {
  try {
    const url = new URL(value, "http://desktop.local");
    const match = /^\/agent\/([^/]+)$/u.exec(url.pathname);
    return match ? decodeRoutePathSegment(match[1]) ?? "" : "";
  } catch {
    return "";
  }
}

function resolveAgentWebclientChatNavigationIdentity(
  value: string
): AgentWebclientChatNavigationIdentity | null {
  try {
    const url = new URL(value, "http://desktop.local");
    const match = /^\/agent\/([^/]+)$/.exec(url.pathname);
    const agentKey = match ? decodeRoutePathSegment(match[1]) : null;
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

function areAgentWebclientChatRouteIdentitiesEqual(
  current: AgentWebclientChatNavigationIdentity,
  target: AgentWebclientChatNavigationIdentity,
  compareOrigin: boolean
) {
  if (
    (compareOrigin && current.origin !== target.origin) ||
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

  return areAgentWebclientChatRouteIdentitiesEqual(current, target, true);
}

export function areAgentWebclientChatBusinessRoutesEquivalent(
  currentRoute: string,
  targetRoute: string
): boolean {
  const current = resolveAgentWebclientChatNavigationIdentity(currentRoute);
  const target = resolveAgentWebclientChatNavigationIdentity(targetRoute);
  if (!current || !target) {
    return false;
  }

  return areAgentWebclientChatRouteIdentitiesEqual(current, target, false);
}

/**
 * Match the trusted Desktop Main Chat route to the live guest route.
 *
 * Canonical Chat navigation intentionally uses a separate parser below: that
 * parser must continue rejecting ownerless newChat routes. Surface alignment,
 * however, accepts either an exact canonical identity or an exact one-shot
 * newChat identity while ignoring Desktop-owned presentation parameters.
 */
export function isAgentWebclientMainChatRouteAligned(
  desktopRoute: string,
  guestUrl: string,
  embeddedUrl: string
) {
  let guest: URL;
  let embedded: URL;
  try {
    guest = new URL(guestUrl);
    embedded = new URL(embeddedUrl);
  } catch {
    return false;
  }
  if (
    (guest.protocol !== "http:" && guest.protocol !== "https:") ||
    (embedded.protocol !== "http:" && embedded.protocol !== "https:") ||
    guest.origin !== embedded.origin
  ) {
    return false;
  }

  const desktopCanonical = readAgentWebclientCanonicalChatSource(desktopRoute);
  const guestCanonical = readAgentWebclientCanonicalChatSource(guestUrl);
  if (desktopCanonical || guestCanonical) {
    return Boolean(
      desktopCanonical &&
      guestCanonical &&
      desktopCanonical.agentKey === guestCanonical.agentKey &&
      desktopCanonical.chatId === guestCanonical.chatId &&
      areAgentWebclientChatBusinessRoutesEquivalent(desktopRoute, guestUrl)
    );
  }

  const desktopNewChat = readAgentWebclientNewChatSource(desktopRoute);
  const guestNewChat = readAgentWebclientNewChatSource(guestUrl);
  return Boolean(
    desktopNewChat &&
    guestNewChat &&
    desktopNewChat.agentKey === guestNewChat.agentKey &&
    desktopNewChat.newChat === guestNewChat.newChat &&
    areAgentWebclientChatBusinessRoutesEquivalent(desktopRoute, guestUrl)
  );
}

export function resolveAgentWebclientDesktopChatRouteFromUrl(
  value: string,
  webviewSrcUrl: string
) {
  let parsed: URL;
  let src: URL;
  try {
    parsed = new URL(value);
    src = new URL(webviewSrcUrl);
  } catch {
    return "";
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    (src.protocol !== "http:" && src.protocol !== "https:") ||
    parsed.origin !== src.origin
  ) {
    return "";
  }

  const match = /^\/agent\/([^/]+)$/u.exec(parsed.pathname);
  const agentKey = match ? decodeRoutePathSegment(match[1]) : null;
  const chatId = parsed.searchParams.get("chatId")?.trim() ?? "";
  if (!agentKey || !chatId) {
    return "";
  }

  const businessSearch = createAgentWebclientBusinessSearch(parsed.searchParams);
  return createAgentWebclientAgentPath(agentKey, businessSearch);
}

/**
 * Recognize a trusted WebClient worker switch without treating a bare Agent
 * route as a canonical Chat identity. Desktop will mint the one-shot newChat
 * source after this returns the new Agent key.
 */
export function resolveAgentWebclientDesktopAgentSwitchTarget(
  value: string,
  webviewSrcUrl: string,
  currentDesktopRoute: string,
): string {
  let parsed: URL;
  let src: URL;
  try {
    parsed = new URL(value);
    src = new URL(webviewSrcUrl);
  } catch {
    return "";
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    (src.protocol !== "http:" && src.protocol !== "https:") ||
    parsed.origin !== src.origin ||
    Boolean(parsed.hash) ||
    createAgentWebclientBusinessSearch(parsed.searchParams)
  ) {
    return "";
  }

  const targetAgentKey = readAgentWebclientAgentRouteKey(parsed.toString());
  const currentAgentKey = readAgentWebclientAgentRouteKey(currentDesktopRoute);
  return targetAgentKey && currentAgentKey && targetAgentKey !== currentAgentKey
    ? targetAgentKey
    : "";
}

export function findAgentWebclientRouteDefinition(pathname: string) {
  return AGENT_WEBCLIENT_ROUTE_DEFINITIONS.find((item) => item.routePath === pathname) ?? null;
}

export function isEmbeddedAgentWebclientRoute(route: AgentWebclientResolvedRoute | null | undefined) {
  return route?.mode === "embedded";
}
