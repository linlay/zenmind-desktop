import type { AssistantNavAgentItem } from "../../../shared/contracts";
import { STORAGE_NAMESPACE } from "../../../shared/brand";
import { createAgentWebclientAgentPath, createAgentWebclientRoute } from "../../../shared/agent-webclient-routes";

const STORAGE_KEY = `${STORAGE_NAMESPACE}:primary-chat-navigation`;
export function readPrimaryChatNavigation(): boolean {
  try { return window.localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
}
export function savePrimaryChatNavigation(enabled: boolean) {
  try { window.localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* Optional view preference. */ }
}
/** A primary pointer is never inferred from recency, pins or project previews. */
export function primaryChatNavigationTarget(agent: AssistantNavAgentItem, nonce = Date.now()): string {
  return agent.primaryChat?.chatId
    ? createAgentWebclientRoute({ agentKey: agent.agentKey, chatId: agent.primaryChat.chatId })
    : `${createAgentWebclientAgentPath(agent.agentKey)}?newChat=${nonce}&primaryNewChat=true`;
}
