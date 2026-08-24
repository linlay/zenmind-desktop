import { decodeRoutePathSegment } from "./route-path";

export const CANONICAL_CHAT_SYNC_REQUEST_CHANNEL = "app.canonicalChatSync.request";
export const CANONICAL_CHAT_SYNC_RESULT_CHANNEL = "app.canonicalChatSync.result";

export type CanonicalChatSyncRequest = {
  requestId: string;
  sourceId: string;
  surfaceId: "main-chat";
  registrationId: string;
  guestWebContentsId: number;
  agentKey: string;
  newChat: string;
  chatId: string;
};

export type CanonicalChatSyncFailureCode =
  | "stale_source"
  | "route_mismatch"
  | "surface_registration_failure";

export type CanonicalChatSyncResult =
  | { requestId: string; ok: true }
  | {
      requestId: string;
      ok: false;
      code: CanonicalChatSyncFailureCode;
      message: string;
    };

export type CanonicalChatSyncRequestListener = (
  request: CanonicalChatSyncRequest,
) => void;

function readAgentRouteKey(url: URL) {
  const match = /^\/agent\/([^/]+)$/u.exec(url.pathname);
  return match ? decodeRoutePathSegment(match[1]) : null;
}

export function readAgentWebclientNewChatSource(value: string) {
  try {
    const url = new URL(value, "http://desktop.local");
    const agentKey = readAgentRouteKey(url);
    const newChatValues = url.searchParams.getAll("newChat");
    const newChat = newChatValues[0]?.trim() || "";
    if (
      !agentKey ||
      newChatValues.length !== 1 ||
      !newChat ||
      url.searchParams.has("chatId")
    ) return null;
    return { agentKey, newChat };
  } catch {
    return null;
  }
}

export function readAgentWebclientCanonicalChatSource(value: string) {
  try {
    const url = new URL(value, "http://desktop.local");
    const agentKey = readAgentRouteKey(url);
    const chatIdValues = url.searchParams.getAll("chatId");
    const chatId = chatIdValues[0]?.trim() || "";
    if (
      !agentKey ||
      chatIdValues.length !== 1 ||
      !chatId ||
      url.searchParams.has("newChat")
    ) return null;
    return { agentKey, chatId };
  } catch {
    return null;
  }
}

export function createCanonicalAgentChatRoute(
  currentRoute: string,
  input: Pick<CanonicalChatSyncRequest, "agentKey" | "newChat" | "chatId">,
) {
  const source = readAgentWebclientNewChatSource(currentRoute);
  const chatId = input.chatId.trim();
  if (
    !source ||
    !chatId ||
    source.agentKey !== input.agentKey.trim() ||
    source.newChat !== input.newChat.trim()
  ) {
    return "";
  }
  const url = new URL(currentRoute, "http://desktop.local");
  url.searchParams.delete("newChat");
  url.searchParams.set("chatId", chatId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export type AgentWebclientNewChatPrepareInput = {
  agentKey: string;
  sourceChatId: string;
  newChat: string;
};

export type AgentWebclientNewChatRegistrationState =
  | "source_pending"
  | "target_ready"
  | "invalid";

export type AgentWebclientNewChatRegistrationOutcome =
  | "wait"
  | "acknowledge"
  | "fail";

export function classifyAgentWebclientNewChatRegistration(input: {
  sourceRoute: string;
  targetRoute: string;
  pageRouteIdentity: string;
  guestUrl: string;
  ownerChatId?: string;
}): AgentWebclientNewChatRegistrationState {
  const source = readAgentWebclientCanonicalChatSource(input.sourceRoute);
  const target = readAgentWebclientNewChatSource(input.targetRoute);
  const pageTarget = readAgentWebclientNewChatSource(input.pageRouteIdentity);
  if (
    !source ||
    !target ||
    !pageTarget ||
    input.ownerChatId?.trim() ||
    source.agentKey !== target.agentKey ||
    pageTarget.agentKey !== target.agentKey ||
    pageTarget.newChat !== target.newChat
  ) {
    return "invalid";
  }

  const guestTarget = readAgentWebclientNewChatSource(input.guestUrl);
  if (
    guestTarget?.agentKey === target.agentKey &&
    guestTarget.newChat === target.newChat
  ) {
    return "target_ready";
  }

  const guestSource = readAgentWebclientCanonicalChatSource(input.guestUrl);
  if (
    guestSource?.agentKey === source.agentKey &&
    guestSource.chatId === source.chatId
  ) {
    return "source_pending";
  }

  return "invalid";
}

export function resolveAgentWebclientNewChatRegistrationOutcome(
  state: AgentWebclientNewChatRegistrationState,
  registrationAccepted: boolean,
): AgentWebclientNewChatRegistrationOutcome {
  if (state === "source_pending") return "wait";
  if (state === "target_ready" && registrationAccepted) return "acknowledge";
  return "fail";
}

/**
 * Convert an exact canonical Main Chat route into its one-shot new Chat source.
 * All previous conversation-scoped query state is deliberately discarded.
 */
export function createPreparedAgentChatRoute(
  currentRoute: string,
  input: AgentWebclientNewChatPrepareInput,
) {
  const agentKey = input.agentKey.trim();
  const sourceChatId = input.sourceChatId.trim();
  const newChat = input.newChat.trim();
  if (!agentKey || !sourceChatId || !/^[1-9]\d{12}$/u.test(newChat)) {
    return "";
  }

  try {
    const url = new URL(currentRoute, "http://desktop.local");
    const match = /^\/agent\/([^/]+)$/u.exec(url.pathname);
    const routeAgentKey = match ? decodeRoutePathSegment(match[1]) : null;
    const chatIds = url.searchParams
      .getAll("chatId")
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      routeAgentKey !== agentKey ||
      chatIds.length !== 1 ||
      chatIds[0] !== sourceChatId ||
      url.searchParams.has("newChat")
    ) {
      return "";
    }

    const search = new URLSearchParams({ newChat });
    return `${url.pathname}?${search.toString()}`;
  } catch {
    return "";
  }
}
