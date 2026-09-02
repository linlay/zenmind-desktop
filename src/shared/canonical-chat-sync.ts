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

export type MainChatIdentity =
  | { kind: "canonical"; agentKey: string; chatId: string }
  | { kind: "new"; agentKey: string; newChat: string };

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

export type CanonicalChatPromotionGuardState =
  | "protecting"
  | "completed"
  | "invalid";

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

export function readMainChatIdentity(value: string): MainChatIdentity | null {
  const canonical = readAgentWebclientCanonicalChatSource(value);
  if (canonical) {
    return { kind: "canonical", ...canonical };
  }
  const pending = readAgentWebclientNewChatSource(value);
  return pending ? { kind: "new", ...pending } : null;
}

export function mainChatIdentitiesEqual(
  left: MainChatIdentity | null | undefined,
  right: MainChatIdentity | null | undefined,
) {
  if (!left || !right || left.kind !== right.kind || left.agentKey !== right.agentKey) {
    return false;
  }
  return left.kind === "canonical" && right.kind === "canonical"
    ? left.chatId === right.chatId
    : left.kind === "new" && right.kind === "new" && left.newChat === right.newChat;
}

export function mainChatIdentityKey(identity: MainChatIdentity | null | undefined) {
  if (!identity) return "";
  return identity.kind === "canonical"
    ? `canonical:${identity.agentKey}:${identity.chatId}`
    : `new:${identity.agentKey}:${identity.newChat}`;
}

export function canCommitMainChatIdentity(input: {
  desired: MainChatIdentity | null | undefined;
  observed: MainChatIdentity | null | undefined;
  ownerChatId?: string | null;
  ownsActiveSurface: boolean;
}) {
  if (
    !input.ownsActiveSurface ||
    !mainChatIdentitiesEqual(input.desired, input.observed) ||
    !input.desired
  ) {
    return false;
  }
  const ownerChatId = input.ownerChatId?.trim() || "";
  return input.desired.kind === "canonical"
    ? ownerChatId === input.desired.chatId
    : !ownerChatId;
}

export function canCommitMainChatRegistration(input: {
  desired: MainChatIdentity | null | undefined;
  observed: MainChatIdentity | null | undefined;
  ownerChatId?: string | null;
  ownsActiveSurface: boolean;
  candidateRevision: number;
  currentRevision: number;
  candidateTransitionKey: string;
  currentTransitionKey: string;
  candidateWebContentsId: number;
  currentWebContentsId?: number;
}) {
  return input.candidateRevision === input.currentRevision &&
    input.candidateTransitionKey === input.currentTransitionKey &&
    input.candidateWebContentsId === input.currentWebContentsId &&
    canCommitMainChatIdentity(input);
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

/**
 * Classify the short hand-off window where Desktop already owns the canonical
 * Chat while the original WebClient guest still renders its new-Chat query.
 */
export function classifyCanonicalChatPromotionGuard(input: {
  request: Pick<
    CanonicalChatSyncRequest,
    "registrationId" | "guestWebContentsId" | "agentKey" | "newChat" | "chatId"
  >;
  registrationId: string;
  guestWebContentsId?: number;
  targetRoute: string;
  guestUrl: string;
}): CanonicalChatPromotionGuardState {
  const requestAgentKey = input.request.agentKey.trim();
  const requestNewChat = input.request.newChat.trim();
  const requestChatId = input.request.chatId.trim();
  const target = readAgentWebclientCanonicalChatSource(input.targetRoute);
  if (
    !requestAgentKey ||
    !requestNewChat ||
    !requestChatId ||
    input.registrationId !== input.request.registrationId ||
    input.guestWebContentsId !== input.request.guestWebContentsId ||
    target?.agentKey !== requestAgentKey ||
    target.chatId !== requestChatId
  ) {
    return "invalid";
  }

  const source = readAgentWebclientNewChatSource(input.guestUrl);
  if (
    source?.agentKey === requestAgentKey &&
    source.newChat === requestNewChat
  ) {
    return "protecting";
  }

  // A mounted guest may briefly expose no URL while its main frame is being
  // recreated. Keep the exact guard until a real guest identity is observed.
  if (!input.guestUrl.trim()) {
    return "protecting";
  }

  const completed = readAgentWebclientCanonicalChatSource(input.guestUrl);
  return completed?.agentKey === requestAgentKey &&
      completed.chatId === requestChatId
    ? "completed"
    : "invalid";
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
