import { applyDesktopPetActiveRunEvent, resolveDesktopPetRunningTaskCount } from "../../../shared/desktop-pet";
import type {
  DesktopPetDismissedPreview,
  DesktopPetPreviewPanelLike,
  DesktopPetCompletionEventLike,
  DesktopPetAgentStatusLike
} from "./controller-model";

export function createDesktopPetActiveRunTracker() {
  let activeRunIds = new Set<string>();

  function update(event: { type?: unknown; runId?: unknown; data?: unknown } | null | undefined) {
    const result = applyDesktopPetActiveRunEvent(activeRunIds, event);
    if (!result.changed) {
      return false;
    }
    activeRunIds = result.activeRunIds;
    return true;
  }

  function clear() {
    if (activeRunIds.size === 0) {
      return false;
    }
    activeRunIds = new Set();
    return true;
  }

  function getActiveRunIds() {
    return [...activeRunIds];
  }

  function getRunningTaskCount(input: {
    kanbanRunIds?: Array<string | null | undefined>;
    fallbackRunning?: boolean;
  } = {}) {
    return resolveDesktopPetRunningTaskCount({
      activeRunIds,
      kanbanRunIds: input.kanbanRunIds,
      fallbackRunning: input.fallbackRunning
    });
  }

  return {
    clear,
    getActiveRunIds,
    getRunningTaskCount,
    update
  };
}

export function createDesktopPetDonePreviewDismissalTracker() {
  let dismissedPreview: DesktopPetDismissedPreview | null = null;

  function rememberFrom(panel: DesktopPetPreviewPanelLike | null | undefined, agentStatus?: { chatId?: string | null } | null) {
    const chatId = panel?.chatId || agentStatus?.chatId || "";
    if (panel?.status !== "done" || !chatId) {
      return false;
    }

    dismissedPreview = {
      chatId,
      runId: panel.runId || ""
    };
    return true;
  }

  function clear(chatId?: string | null, runId?: string | null) {
    if (!dismissedPreview) {
      return false;
    }
    if (
      !chatId ||
      dismissedPreview.chatId === chatId ||
      (runId && dismissedPreview.runId === runId)
    ) {
      dismissedPreview = null;
      return true;
    }
    return false;
  }

  function isDismissedChat(chatId: string | null | undefined) {
    return Boolean(chatId && dismissedPreview?.chatId === chatId);
  }

  function isDismissedCompletionEvent(event: DesktopPetCompletionEventLike | null | undefined) {
    if (!event || (event.type !== "run.complete" && event.type !== "done")) {
      return false;
    }
    if (!dismissedPreview || dismissedPreview.chatId !== event.chatId) {
      return false;
    }
    return !event.runId || dismissedPreview.runId === event.runId;
  }

  function filterAgentStatus<TAgentStatus extends DesktopPetAgentStatusLike | null>(agentStatus: TAgentStatus): TAgentStatus {
    if (!agentStatus || agentStatus.presence !== "away" || !isDismissedChat(agentStatus.chatId)) {
      return agentStatus;
    }
    return {
      ...agentStatus,
      presence: "available" as const,
      latestPreview: "",
      unreadCount: 0
    };
  }

  return {
    clear,
    filterAgentStatus,
    isDismissedChat,
    isDismissedCompletionEvent,
    rememberFrom
  };
}
