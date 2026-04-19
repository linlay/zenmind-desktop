export function resolveOutgoingChatId(input: {
  preferredChatId?: string;
  activeChatId?: string;
  newConversationPending?: boolean;
}): string {
  if (input.newConversationPending) {
    return '';
  }

  return String(input.preferredChatId || input.activeChatId || '').trim();
}

export function isOutgoingChatSameAsActive(input: {
  targetChatId?: string;
  activeChatId?: string;
  newConversationPending?: boolean;
}): boolean {
  if (input.newConversationPending) {
    return false;
  }

  const targetChatId = String(input.targetChatId || '').trim();
  const activeChatId = String(input.activeChatId || '').trim();

  return !targetChatId || targetChatId === activeChatId;
}
