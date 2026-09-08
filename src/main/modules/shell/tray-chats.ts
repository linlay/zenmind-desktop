import { randomUUID } from "node:crypto";
import type { AssistantNavAgentItemsResult, AssistantNavChatItem } from "../../../shared/contracts";
import { createAgentWebclientAgentPath } from "../../../shared/agent-webclient-routes";

export const TRAY_RECENT_CHAT_LIMIT = 8;

export type AppTrayRecentChat = Pick<AssistantNavChatItem, "agentKey" | "chatId" | "chatName" | "updatedAt"> & {
  agentDisplayName: string;
};

export function getAppTrayRecentChats(snapshot: AssistantNavAgentItemsResult | undefined): AppTrayRecentChat[] {
  if (!snapshot?.ok) return [];

  const agents = [...snapshot.items, ...(snapshot.activityItems ?? [])];
  const agentNames = new Map(agents.map((agent) => [agent.agentKey, agent.displayName]));
  const chatsById = new Map<string, AppTrayRecentChat>();
  // Per-agent recent history also covers Chats outside the sidebar's manual-order window.
  const chats = [...snapshot.chatItems, ...agents.flatMap((agent) => agent.recentChats)];
  for (const chat of chats) {
    const agentKey = chat.agentKey.trim();
    const chatId = chat.chatId.trim();
    if (!agentKey || !chatId) continue;
    const existing = chatsById.get(chatId);
    if (existing && existing.updatedAt >= chat.updatedAt) continue;
    chatsById.set(chatId, {
      agentKey,
      chatId,
      chatName: chat.chatName,
      updatedAt: chat.updatedAt,
      agentDisplayName: agentNames.get(agentKey) || agentKey
    });
  }
  return [...chatsById.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.chatId.localeCompare(right.chatId))
    .slice(0, TRAY_RECENT_CHAT_LIMIT);
}

export function createAppTrayNewChatRoute(agentKey: string) {
  return createAgentWebclientAgentPath(agentKey, new URLSearchParams({ newChat: randomUUID() }));
}
