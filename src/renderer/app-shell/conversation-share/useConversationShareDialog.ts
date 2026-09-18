import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_ASSISTANT_CONVERSATION_SHARE_EXPIRATION,
  type AssistantConversationShareExpiration,
  type AssistantConversationShareRecord,
} from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";

const COPY_FEEDBACK_DURATION_MS = 1_600;

export type ConversationShareDialogState = {
  chatId: string;
  chatName: string;
  expiration: AssistantConversationShareExpiration;
  createdRecord: AssistantConversationShareRecord | null;
  creating: boolean;
  copied: boolean;
  actionError: string;
  notice: string;
};

export type ConversationShareDialogSession = {
  chatId: string;
  chatName: string;
};

export function useConversationShareDialog(
  session: ConversationShareDialogSession,
  t: TranslateFunction,
) {
  const [state, setState] = useState<ConversationShareDialogState>(() => ({
    chatId: session.chatId,
    chatName: session.chatName || t("sidebar.chat.current"),
    expiration: DEFAULT_ASSISTANT_CONVERSATION_SHARE_EXPIRATION,
    createdRecord: null,
    creating: false,
    copied: false,
    actionError: "",
    notice: "",
  }));
  const generationRef = useRef(0);
  const copyFeedbackTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      generationRef.current += 1;
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );

  function clearCopyFeedbackTimer() {
    if (copyFeedbackTimerRef.current === null) return;
    window.clearTimeout(copyFeedbackTimerRef.current);
    copyFeedbackTimerRef.current = null;
  }

  async function create() {
    const current = state;
    if (current.creating) return;
    const generation = generationRef.current;
    setState({ ...current, creating: true, copied: false, actionError: "", notice: "" });
    try {
      const result = await window.electronAPI.assistant.shareChat({
        chatId: current.chatId,
        expiration: current.expiration,
      });
      setState((latest) => {
        if (
          generationRef.current !== generation ||
          latest.chatId !== current.chatId
        ) {
          return latest;
        }
        if (!result.ok) {
          return {
            ...latest,
            creating: false,
            actionError: result.message || t("sidebar.chat.shareFailed"),
          };
        }
        return {
          ...latest,
          creating: false,
          createdRecord: result.record,
          copied: false,
          actionError: "",
          notice: result.message || t("sidebar.chat.shareCreated"),
        };
      });
    } catch (error) {
      setState((latest) =>
        generationRef.current === generation && latest.chatId === current.chatId
          ? {
              ...latest,
              creating: false,
              actionError:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.shareFailed"),
            }
          : latest,
      );
    }
  }

  function setExpiration(expiration: AssistantConversationShareExpiration) {
    setState((current) =>
      !current.creating
        ? { ...current, expiration, actionError: "", notice: "" }
        : current,
    );
  }

  async function copyCreatedLink() {
    const current = state;
    const record = current.createdRecord;
    if (!record) return;
    const generation = generationRef.current;
    try {
      const result = await window.electronAPI.clipboard.writeText(record.url);
      if (generationRef.current === generation) clearCopyFeedbackTimer();
      setState((latest) =>
        generationRef.current === generation
          ? {
              ...latest,
              copied: result.ok,
              actionError: result.ok
                ? ""
                : result.message || t("sidebar.chat.shareCopyFailed"),
            }
          : latest,
      );
      if (generationRef.current === generation && result.ok) {
        copyFeedbackTimerRef.current = window.setTimeout(() => {
          copyFeedbackTimerRef.current = null;
          setState((latest) =>
            generationRef.current === generation && latest.copied
              ? { ...latest, copied: false }
              : latest,
          );
        }, COPY_FEEDBACK_DURATION_MS);
      }
    } catch (error) {
      if (generationRef.current === generation) clearCopyFeedbackTimer();
      setState((latest) =>
        generationRef.current === generation
          ? {
              ...latest,
              copied: false,
              actionError:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.shareCopyFailed"),
            }
          : latest,
      );
    }
  }

  return {
    state,
    create,
    copyCreatedLink,
    setExpiration,
  };
}
