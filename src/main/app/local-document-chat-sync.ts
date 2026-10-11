import type { WebContents } from "electron";
import { readAgentWebclientCanonicalChatSource, readAgentWebclientNewChatSource, type CanonicalChatSyncRequest, type CanonicalChatSyncResult } from "../../shared/canonical-chat-sync";
import type { BrowserSurfaceRegistry } from "../modules/web-surfaces";

type SyncInput = Omit<CanonicalChatSyncRequest, "requestId">;
type DraftPromotionInput = { ownerWebContentsId: number; agentKey: string; newChat: string; chatId: string };

/** A server chat.start promotes local preview ownership only after the existing trusted surface ACK. */
export function createLocalDocumentChatSync(ports: {
  getMainContents(): WebContents | null;
  resolveSurface: BrowserSurfaceRegistry["resolveWebviewSurfaceTarget"];
  request(ownerWebContentsId: number, input: SyncInput): Promise<CanonicalChatSyncResult>;
  begin(input: DraftPromotionInput): boolean;
  cancel(input: DraftPromotionInput): void;
  promote(input: DraftPromotionInput): boolean;
  delay?(ms: number): Promise<void>;
}) {
  return async (ownerWebContentsId: number, input: SyncInput): Promise<CanonicalChatSyncResult> => {
    const main = ports.getMainContents();
    const frame = main?.mainFrame;
    const original = ports.resolveSurface(input.guestWebContentsId);
    const source = original && readAgentWebclientNewChatSource(original.currentUrl || original.pageRouteIdentity || original.pageRoute || "");
    const sourceMatches = main && frame && !main.isDestroyed() && main.id === ownerWebContentsId && original &&
      original.ownerWebContentsId === ownerWebContentsId && original.registrationId === input.registrationId &&
      original.surfaceId === "main-chat" && original.surfaceRole === "main-chat" && original.surfaceLevel === "root" &&
      original.serviceId === "agent-webclient" && original.active &&
      source?.agentKey === input.agentKey && source.newChat === input.newChat;
    if (!sourceMatches) return { requestId: "", ok: false, code: "stale_source", message: "File preview Chat source is unavailable." };

    const promotion = { ownerWebContentsId, agentKey: input.agentKey, newChat: input.newChat, chatId: input.chatId };
    let hasDraft: boolean;
    try { hasDraft = ports.begin(promotion); }
    catch { return { requestId: "", ok: false, code: "stale_source", message: "File preview source could not begin canonical synchronization." }; }
    // Ordinary new Chats keep the existing canonical-sync behavior. A local
    // draft association is needed only when this precise nonce owns files.
    if (!hasDraft) return ports.request(ownerWebContentsId, input);

    let promoted = false;
    let result: CanonicalChatSyncResult | undefined;
    try {
      result = await ports.request(ownerWebContentsId, input);
      if (!result.ok) return result;
      // The ACK installs a guard and schedules outer navigation; it does not
      // mean the host URL and canonical Registry snapshot have committed yet.
      let committed = false;
      for (let attempt = 0; attempt <= 30; attempt += 1) {
        if (ports.getMainContents() !== main || main.isDestroyed() || main.mainFrame !== frame) {
          return { requestId: result.requestId, ok: false, code: "stale_source", message: "File preview Main lifecycle changed." };
        }
        const current = ports.resolveSurface(input.guestWebContentsId);
        const registeredRoute = current?.pageRouteIdentity || current?.pageRoute || "";
        const canonical = readAgentWebclientCanonicalChatSource(registeredRoute);
        const registeredDraft = readAgentWebclientNewChatSource(registeredRoute);
        const guestDraft = current && readAgentWebclientNewChatSource(current.currentUrl);
        const guestChat = current && readAgentWebclientCanonicalChatSource(current.currentUrl);
        const guestMatches = current && (!current.currentUrl.trim() ||
          (guestDraft?.agentKey === input.agentKey && guestDraft.newChat === input.newChat) ||
          (guestChat?.agentKey === input.agentKey && guestChat.chatId === input.chatId));
        const rawHost = main.getURL();
        const parsedHost = new URL(rawHost, "http://desktop.local");
        const hostRoute = parsedHost.hash.startsWith("#/") ? parsedHost.hash.slice(1) : `${parsedHost.pathname}${parsedHost.search}`;
        const hostChat = readAgentWebclientCanonicalChatSource(hostRoute);
        const hostDraft = readAgentWebclientNewChatSource(hostRoute);
        const registeredMatches = canonical?.agentKey === input.agentKey && canonical.chatId === input.chatId ||
          registeredDraft?.agentKey === input.agentKey && registeredDraft.newChat === input.newChat;
        const hostMatches = hostChat?.agentKey === input.agentKey && hostChat.chatId === input.chatId ||
          hostDraft?.agentKey === input.agentKey && hostDraft.newChat === input.newChat;
        if (ports.getMainContents() !== main || main.isDestroyed() || main.mainFrame !== frame || !current ||
          current.registrationId !== input.registrationId || current.ownerWebContentsId !== ownerWebContentsId ||
          current.webContentsId !== input.guestWebContentsId || current.surfaceId !== "main-chat" ||
          current.surfaceRole !== "main-chat" || current.surfaceLevel !== "root" || current.serviceId !== "agent-webclient" ||
          !guestMatches || !registeredMatches || !hostMatches ||
          current.ownerChatId && current.ownerChatId !== input.chatId) {
          return { requestId: result.requestId, ok: false, code: "stale_source", message: "File preview Chat source changed during canonical synchronization." };
        }
        if (current.active && current.ownerChatId === input.chatId && canonical?.chatId === input.chatId && hostChat?.chatId === input.chatId) {
          committed = true;
          break;
        }
        if (attempt < 30) await (ports.delay ? ports.delay(50) : new Promise<void>(resolve => setTimeout(resolve, 50)));
      }
      if (!committed) return { requestId: result.requestId, ok: false, code: "surface_registration_failure", message: "Canonical file preview context did not commit." };
      // Do not wait for the guest to consume chat.start here. Presentation is
      // acknowledged by canonical file binding at the later WorkPanel tool call.
      promoted = ports.promote(promotion);
      return promoted ? result : { requestId: result.requestId, ok: false, code: "stale_source", message: "File preview draft is no longer available." };
    } catch {
      return { requestId: result?.requestId ?? "", ok: false, code: "stale_source", message: "File preview ownership could not be promoted." };
    } finally {
      if (!promoted) ports.cancel(promotion);
    }
  };
}
