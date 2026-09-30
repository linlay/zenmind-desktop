import { useEffect, useRef, useState } from "react";
import type { AssistantConversationShareRecord } from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";

export type ConversationShareAction = "copy" | "qr" | "browser";
type ConversationSharePhase = "choice" | "qr" | "done";
type ShareFeedback = { kind: "loading" | "success" | "error"; message: string };

export type ConversationShareDialogState = {
  createdRecord: AssistantConversationShareRecord | null;
  phase: ConversationSharePhase;
  workingAction: ConversationShareAction | null;
  feedback: ShareFeedback | null;
  warning: string;
};

export function useConversationShareDialog(
  session: { chatId: string },
  t: TranslateFunction,
) {
  const [state, setState] = useState<ConversationShareDialogState>(() => ({
    createdRecord: null,
    phase: "choice",
    workingAction: null,
    feedback: null,
    warning: "",
  }));
  const generationRef = useRef(0);
  const workingRef = useRef(false);
  const createdRecordRef = useRef<AssistantConversationShareRecord | null>(null);

  useEffect(() => () => { generationRef.current += 1; }, []);

  useEffect(() => {
    if (!state.feedback || state.feedback.kind === "loading") return;
    const timer = window.setTimeout(() => {
      setState((current) => ({ ...current, feedback: null }));
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [state.feedback]);

  async function run(action: ConversationShareAction) {
    if (workingRef.current || state.phase !== "choice") return;
    workingRef.current = true;
    const generation = generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    const pendingMessage = createdRecordRef.current
      ? t(action === "copy" ? "sidebar.chat.shareCopying" : "sidebar.chat.shareOpening")
      : t("sidebar.chat.shareGenerating");
    setState((current) => ({
      ...current,
      workingAction: action,
      feedback: { kind: "loading", message: pendingMessage },
    }));

    try {
      let record = createdRecordRef.current;
      let warning = state.warning;
      if (!record) {
        const result = await window.electronAPI.assistant.shareChat({ chatId: session.chatId });
        if (!result.ok) throw new Error(result.message || t("sidebar.chat.shareFailed"));
        record = result.record;
        warning = result.warning || "";
        if (!isCurrent()) return;
        createdRecordRef.current = record;
        setState((current) => ({ ...current, createdRecord: record, warning }));
      }

      if (action === "copy") {
        const result = await window.electronAPI.clipboard.writeText(record.url);
        if (!result.ok) throw new Error(result.message || t("sidebar.chat.shareCopyFailed"));
      } else if (action === "browser") {
        const result = await window.electronAPI.shell.openExternal(record.url);
        if (!result.ok) throw new Error(t("sidebar.chat.shareBrowserFailed"));
      }
      if (!isCurrent()) return;
      const successMessage = t(action === "copy"
        ? "sidebar.chat.shareCopied"
        : action === "browser"
          ? "sidebar.chat.shareBrowserOpened"
          : "sidebar.chat.shareQrReady");
      setState((current) => ({
        ...current,
        createdRecord: record,
        warning,
        workingAction: null,
        phase: action === "qr" ? "qr" : "done",
        feedback: { kind: "success", message: successMessage },
      }));
    } catch (error) {
      if (!isCurrent()) return;
      setState((current) => ({
        ...current,
        createdRecord: createdRecordRef.current,
        workingAction: null,
        feedback: {
          kind: "error",
          message: error instanceof Error ? error.message : t("sidebar.chat.shareFailed"),
        },
      }));
    } finally {
      workingRef.current = false;
    }
  }

  function notify(feedback: ShareFeedback) {
    setState((current) => ({ ...current, feedback }));
  }

  return { state, run, notify };
}
