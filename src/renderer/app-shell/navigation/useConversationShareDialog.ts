import { useState } from "react";
import type { AssistantConversationShareResult } from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";

export type ConversationShareDialogState = {
  chatId: string;
  chatName: string;
  pending: "" | "create" | "revoke";
  result: AssistantConversationShareResult | null;
  error: string;
  copied: boolean;
};

export function useConversationShareDialog(t: TranslateFunction) {
  const [state, setState] = useState<ConversationShareDialogState | null>(null);

  function open(chatId: string, chatName: string) {
    if (!chatId.trim()) return;
    setState({
      chatId: chatId.trim(),
      chatName: chatName.trim() || t("sidebar.chat.current"),
      pending: "",
      result: null,
      error: "",
      copied: false,
    });
  }

  function close() {
    setState(null);
  }

  async function create() {
    const current = state;
    if (!current || current.pending) return;
    setState({
      ...current,
      pending: "create",
      error: "",
      copied: false,
    });
    try {
      const result = await window.electronAPI.assistant.shareChat(current.chatId);
      setState((latest) =>
        latest && latest.chatId === current.chatId
          ? {
              ...latest,
              pending: "",
              result: result.ok ? result : null,
              error:
                result.ok
                  ? ""
                  : result.message || t("sidebar.chat.shareFailed"),
            }
          : latest,
      );
    } catch (error) {
      setState((latest) =>
        latest && latest.chatId === current.chatId
          ? {
              ...latest,
              pending: "",
              error:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.shareFailed"),
            }
          : latest,
      );
    }
  }

  async function copy() {
    const url = state?.result?.url?.trim() || "";
    if (!url) return;
    try {
      const result = await window.electronAPI.clipboard.writeText(url);
      setState((current) =>
        current
          ? {
              ...current,
              copied: result.ok,
              error:
                result.ok
                  ? ""
                  : result.message || t("sidebar.chat.shareCopyFailed"),
            }
          : current,
      );
    } catch (error) {
      setState((current) =>
        current
          ? {
              ...current,
              copied: false,
              error:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.shareCopyFailed"),
            }
          : current,
      );
    }
  }

  async function revoke() {
    const shareId = state?.result?.shareId?.trim() || "";
    if (!state || state.pending || !shareId) return;
    setState((current) =>
      current ? { ...current, pending: "revoke", error: "" } : current,
    );
    try {
      const result = await window.electronAPI.assistant.revokeChatShare(shareId);
      if (!result.ok) {
        setState((current) =>
          current
            ? { ...current, pending: "", error: result.message }
            : current,
        );
        return;
      }
      setState(null);
    } catch (error) {
      setState((current) =>
        current
          ? {
              ...current,
              pending: "",
              error:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.shareRevokeFailed"),
            }
          : current,
      );
    }
  }

  return { state, open, close, create, copy, revoke };
}
