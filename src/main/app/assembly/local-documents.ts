import { readAgentWebclientCanonicalChatSource, readAgentWebclientNewChatSource } from "../../../shared/canonical-chat-sync";
import { isLocalDocumentNewChat } from "../../../shared/local-document";
import { MAIN_CHAT_SURFACE_ID } from "../../../shared/surface-identity";

type EditingChat = { agentKey: string; chatId: string; newChat?: string };
type MainChatSurface = {
  surfaceId: string;
  serviceId?: string;
  surfaceRole: string;
  surfaceLevel: string;
  active: boolean;
  ownerChatId?: string;
  currentUrl?: string;
  url: string;
};

type EditingChatPorts = {
  getAgentKey(): string;
  getMainChatSurface(): MainChatSurface | undefined;
  getDesktopRoute?(): string;
  delay(ms: number): Promise<void>;
};

/** Open a local draft; WebClient creates its canonical Chat on the first query. */
export function createLocalDocumentEditingChat(ports: EditingChatPorts) {
  let lastNonce = 0;

  function desktopRoute() {
    if (!ports.getDesktopRoute) return "";
    try {
      const desktop = new URL(ports.getDesktopRoute(), "http://desktop.local");
      return desktop.hash.startsWith("#/") ? desktop.hash.slice(1) : `${desktop.pathname}${desktop.search}`;
    } catch { return ""; }
  }

  function activeChat(): EditingChat | undefined {
    const surface = ports.getMainChatSurface();
    if (!surface?.active || surface.surfaceId !== MAIN_CHAT_SURFACE_ID ||
      surface.serviceId !== "agent-webclient" || surface.surfaceRole !== "main-chat" ||
      surface.surfaceLevel !== "root") return;
    const route = surface.currentUrl || surface.url;
    const canonical = readAgentWebclientCanonicalChatSource(route);
    if (canonical && canonical.chatId === surface.ownerChatId) return canonical;
    const draft = readAgentWebclientNewChatSource(route);
    if (!surface.ownerChatId?.trim() && draft && isLocalDocumentNewChat(draft.newChat)) return { ...draft, chatId: "" };
  }

  async function getEditingChat(): Promise<EditingChat> {
    const agentKey = ports.getAgentKey().trim();
    if (!agentKey) throw new Error("editing assistant is unavailable");
    const requested = ports.getDesktopRoute
      ? readAgentWebclientNewChatSource(desktopRoute())
      : activeChat();
    if (requested?.agentKey === agentKey && isLocalDocumentNewChat(requested.newChat)) {
      return { agentKey, chatId: "", newChat: requested.newChat };
    }
    lastNonce = Math.max(Date.now(), lastNonce + 1);
    const newChat = String(lastNonce);
    if (!isLocalDocumentNewChat(newChat)) throw new Error("invalid local file draft nonce");
    return { agentKey, chatId: "", newChat };
  }

  function isEditingChatActive(chatId: string, agentKey: string, newChat?: string) {
    if (ports.getDesktopRoute && !isEditingChatRequested(chatId, agentKey, newChat)) return false;
    const current = activeChat();
    return current?.chatId === chatId && current.agentKey === agentKey && current.newChat === newChat &&
      agentKey === ports.getAgentKey().trim();
  }

  function isEditingChatRequested(chatId: string, agentKey: string, newChat?: string) {
    if (!ports.getDesktopRoute) return isEditingChatActive(chatId, agentKey, newChat);
    if (!agentKey || agentKey !== ports.getAgentKey().trim()) return false;
    if (chatId && newChat === undefined) {
      const requested = readAgentWebclientCanonicalChatSource(desktopRoute());
      return requested?.agentKey === agentKey && requested.chatId === chatId;
    }
    if (chatId || !isLocalDocumentNewChat(newChat)) return false;
    const requested = readAgentWebclientNewChatSource(desktopRoute());
    return requested?.agentKey === agentKey && requested.newChat === newChat;
  }

  async function waitForEditingChatRequested(chatId: string, agentKey: string, newChat?: string) {
    // Let the actual host route settle after app.navigate before another queued
    // OS open chooses a Chat. This does not grant preview/Run authority.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (isEditingChatRequested(chatId, agentKey, newChat)) return true;
      await ports.delay(50);
    }
    return isEditingChatRequested(chatId, agentKey, newChat);
  }

  return { getEditingChat, isEditingChatActive, isEditingChatRequested, waitForEditingChatRequested };
}
