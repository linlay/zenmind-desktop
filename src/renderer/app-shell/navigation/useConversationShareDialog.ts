import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_ASSISTANT_CONVERSATION_SHARE_EXPIRATION,
  type AssistantConversationShareExpiration,
  type AssistantConversationShareRecord,
} from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";

type ConversationShareListStatus = "loading" | "ready" | "error";
const COPY_FEEDBACK_DURATION_MS = 1_600;

export type ConversationShareDialogState = {
  chatId: string;
  chatName: string;
  expiration: AssistantConversationShareExpiration;
  records: AssistantConversationShareRecord[];
  listStatus: ConversationShareListStatus;
  listError: string;
  creating: boolean;
  revokingShareId: string;
  confirmingRevokeShareId: string;
  copiedShareId: string;
  actionError: string;
  notice: string;
};

export function useConversationShareDialog(t: TranslateFunction) {
  const [state, setState] = useState<ConversationShareDialogState | null>(null);
  const generationRef = useRef(0);
  const locallyCreatedShareIdsRef = useRef(new Set<string>());
  const revokedShareIdsRef = useRef(new Set<string>());
  const copyFeedbackTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
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

  function open(chatId: string, chatName: string) {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    clearCopyFeedbackTimer();
    locallyCreatedShareIdsRef.current = new Set();
    revokedShareIdsRef.current = new Set();
    setState({
      chatId: normalizedChatId,
      chatName: chatName.trim() || t("sidebar.chat.current"),
      expiration: DEFAULT_ASSISTANT_CONVERSATION_SHARE_EXPIRATION,
      records: [],
      listStatus: "loading",
      listError: "",
      creating: false,
      revokingShareId: "",
      confirmingRevokeShareId: "",
      copiedShareId: "",
      actionError: "",
      notice: "",
    });
    void load(normalizedChatId, generation);
  }

  function close() {
    generationRef.current += 1;
    clearCopyFeedbackTimer();
    locallyCreatedShareIdsRef.current.clear();
    revokedShareIdsRef.current.clear();
    setState(null);
  }

  async function load(chatId: string, generation: number) {
    try {
      const result = await window.electronAPI.assistant.listChatShares(chatId);
      setState((latest) => {
        if (
          generationRef.current !== generation ||
          !latest ||
          latest.chatId !== chatId
        ) {
          return latest;
        }
        if (!result.ok) {
          return {
            ...latest,
            listStatus: "error",
            listError: result.message || t("sidebar.chat.shareListFailed"),
          };
        }
        const revokedShareIds = revokedShareIdsRef.current;
        const records = result.records.filter(
          (record) => !revokedShareIds.has(record.shareId),
        );
        const serverShareIds = new Set(records.map((record) => record.shareId));
        for (const shareId of serverShareIds) {
          locallyCreatedShareIdsRef.current.delete(shareId);
        }
        for (const record of latest.records) {
          if (
            locallyCreatedShareIdsRef.current.has(record.shareId) &&
            !serverShareIds.has(record.shareId) &&
            !revokedShareIds.has(record.shareId)
          ) {
            records.push(record);
          }
        }
        records.sort((left, right) => right.createdAt - left.createdAt);
        return { ...latest, records, listStatus: "ready", listError: "" };
      });
    } catch (error) {
      setState((latest) =>
        generationRef.current === generation && latest?.chatId === chatId
          ? {
              ...latest,
              listStatus: "error",
              listError:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.shareListFailed"),
            }
          : latest,
      );
    }
  }

  function retryList() {
    const current = state;
    if (!current || current.listStatus === "loading") return;
    const generation = generationRef.current;
    setState({ ...current, listStatus: "loading", listError: "" });
    void load(current.chatId, generation);
  }

  async function create() {
    const current = state;
    if (!current || current.creating) return;
    const generation = generationRef.current;
    setState({ ...current, creating: true, actionError: "", notice: "" });
    try {
      const result = await window.electronAPI.assistant.shareChat({
        chatId: current.chatId,
        expiration: current.expiration,
      });
      setState((latest) => {
        if (
          generationRef.current !== generation ||
          !latest ||
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
        locallyCreatedShareIdsRef.current.add(result.record.shareId);
        return {
          ...latest,
          creating: false,
          records: [
            result.record,
            ...latest.records.filter(
              (record) => record.shareId !== result.record.shareId,
            ),
          ],
          actionError: "",
          notice: result.message || t("sidebar.chat.shareCreated"),
        };
      });
    } catch (error) {
      setState((latest) =>
        generationRef.current === generation &&
        latest?.chatId === current.chatId
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
      current && !current.creating ? { ...current, expiration } : current,
    );
  }

  async function copy(shareId: string) {
    const current = state;
    const record = current?.records.find((item) => item.shareId === shareId);
    if (!current || !record) return;
    const generation = generationRef.current;
    try {
      const result = await window.electronAPI.clipboard.writeText(record.url);
      if (generationRef.current === generation) {
        clearCopyFeedbackTimer();
      }
      setState((latest) =>
        generationRef.current === generation && latest
          ? {
              ...latest,
              copiedShareId: result.ok ? shareId : "",
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
            generationRef.current === generation &&
            latest?.copiedShareId === shareId
              ? { ...latest, copiedShareId: "" }
              : latest,
          );
        }, COPY_FEEDBACK_DURATION_MS);
      }
    } catch (error) {
      if (generationRef.current === generation) {
        clearCopyFeedbackTimer();
      }
      setState((latest) =>
        generationRef.current === generation && latest
          ? {
              ...latest,
              copiedShareId: "",
              actionError:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.shareCopyFailed"),
            }
          : latest,
      );
    }
  }

  function requestRevoke(shareId: string) {
    setState((current) =>
      current && !current.revokingShareId
        ? {
            ...current,
            confirmingRevokeShareId: shareId,
            actionError: "",
            notice: "",
          }
        : current,
    );
  }

  function cancelRevoke() {
    setState((current) =>
      current && !current.revokingShareId
        ? { ...current, confirmingRevokeShareId: "" }
        : current,
    );
  }

  async function confirmRevoke() {
    const current = state;
    const shareId = current?.confirmingRevokeShareId || "";
    if (!current || current.revokingShareId || !shareId) return;
    const generation = generationRef.current;
    setState({
      ...current,
      revokingShareId: shareId,
      confirmingRevokeShareId: "",
      actionError: "",
      notice: "",
    });
    try {
      const result =
        await window.electronAPI.assistant.revokeChatShare(shareId);
      setState((latest) => {
        if (generationRef.current !== generation || !latest) return latest;
        if (!result.ok) {
          return {
            ...latest,
            revokingShareId: "",
            actionError: result.message,
          };
        }
        revokedShareIdsRef.current.add(shareId);
        locallyCreatedShareIdsRef.current.delete(shareId);
        return {
          ...latest,
          revokingShareId: "",
          records: latest.records.filter(
            (record) => record.shareId !== shareId,
          ),
          notice: result.message || t("assistant.chatShareRevoked"),
        };
      });
    } catch (error) {
      setState((latest) =>
        generationRef.current === generation && latest
          ? {
              ...latest,
              revokingShareId: "",
              actionError:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.shareRevokeFailed"),
            }
          : latest,
      );
    }
  }

  return {
    state,
    open,
    close,
    retryList,
    create,
    copy,
    requestRevoke,
    cancelRevoke,
    confirmRevoke,
    setExpiration,
  };
}
