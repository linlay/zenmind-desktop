/** View pages are data consumers of one registered Chat/Run, never Run controllers. */
export function allowsViewRequest(input: {
  identityKey?: string; ownerChatId?: string; guestUrl: string;
  type: string; payload: unknown;
}): boolean {
  try {
    if (!input.identityKey?.startsWith("view:")) return false;
    const identity: unknown = JSON.parse(input.identityKey.slice(5));
    if (!Array.isArray(identity) || identity.length !== 4 || identity.some(value => typeof value !== "string" || !value)) return false;
    const [chatId, runId, sourceId, viewIndex] = identity as string[];
    if (chatId !== input.ownerChatId) return false;
    const url = new URL(input.guestUrl);
    if (url.pathname !== `/view-viewer/${encodeURIComponent(sourceId)}` ||
        ["chatId", "runId", "viewIndex"].some((key, index) => url.searchParams.getAll(key).length !== 1 ||
          url.searchParams.get(key) !== [chatId, runId, viewIndex][index])) return false;
    const payload = input.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object" || payload.chatId !== chatId) return false;
    switch (input.type) {
      case "/api/chat": return true;
      case "/api/view": return payload.usage === undefined || payload.usage === "display";
      case "/api/view/query":
      case "/api/view/invoke": return payload.runId === runId;
      default: return false;
    }
  } catch { return false; }
}
