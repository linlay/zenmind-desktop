import {
  isOutgoingChatSameAsActive,
  resolveOutgoingChatId,
} from './conversationIntent';

describe('conversationIntent', () => {
  it('forces the next send onto a fresh chat while new conversation is pending', () => {
    expect(
      resolveOutgoingChatId({
        preferredChatId: 'chat_old',
        activeChatId: 'chat_old',
        newConversationPending: true,
      }),
    ).toBe('');
  });

  it('does not treat a pending new conversation as the active chat', () => {
    expect(
      isOutgoingChatSameAsActive({
        targetChatId: '',
        activeChatId: 'chat_old',
        newConversationPending: true,
      }),
    ).toBe(false);
  });

  it('falls back to the active chat when no new conversation is pending', () => {
    expect(
      resolveOutgoingChatId({
        activeChatId: 'chat_active',
        newConversationPending: false,
      }),
    ).toBe('chat_active');
  });
});
