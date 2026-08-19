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

export function readAgentWebclientNewChatSource(value: string) {
  try {
    const url = new URL(value, "http://desktop.local");
    const match = /^\/agent\/([^/]+)$/u.exec(url.pathname);
    const agentKey = match ? decodeRoutePathSegment(match[1]) : null;
    const newChatValues = url.searchParams.getAll("newChat").map((item) => item.trim()).filter(Boolean);
    const chatId = url.searchParams.get("chatId")?.trim() ?? "";
    if (!agentKey || newChatValues.length !== 1 || chatId) return null;
    return { agentKey, newChat: newChatValues[0] };
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
