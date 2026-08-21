import { useRef, useState } from "react";
import type {
  AssistantChatInfo,
  AssistantNavChatItem,
} from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";
import type { ChatInfoSummary } from "../../../shared/chat-info";

export type ChatInfoDialogState = {
  summary: ChatInfoSummary;
  detail: AssistantChatInfo | null;
  loading: boolean;
  error: string;
};

export function useChatInfoDialog(t: TranslateFunction) {
  const [state, setState] = useState<ChatInfoDialogState | null>(null);
  const requestIdRef = useRef(0);

  async function load(summary: ChatInfoSummary) {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) =>
      current?.summary.chatId === summary.chatId
        ? { ...current, detail: null, loading: true, error: "" }
        : { summary, detail: null, loading: true, error: "" },
    );
    try {
      const detail = await window.electronAPI.assistant.getChatInfo(summary.chatId);
      if (requestIdRef.current !== requestId) return;
      if (!detail) {
        throw new Error(t("sidebar.chat.infoNotFound"));
      }
      setState((current) =>
        current?.summary.chatId === summary.chatId
          ? { ...current, detail, loading: false, error: "" }
          : current,
      );
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setState((current) =>
        current?.summary.chatId === summary.chatId
          ? {
              ...current,
              detail: null,
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.infoLoadFailed"),
            }
          : current,
      );
    }
  }

  function open(chat: AssistantNavChatItem) {
    const chatId = chat.chatId.trim();
    if (!chatId) return;
    const summary = {
      chatId,
      chatName: chat.chatName.trim(),
      agentKey: chat.agentKey.trim(),
    };
    setState({ summary, detail: null, loading: true, error: "" });
    void load(summary);
  }

  function retry() {
    if (!state || state.loading) return;
    void load(state.summary);
  }

  function close() {
    requestIdRef.current += 1;
    setState(null);
  }

  return { state, open, retry, close };
}
