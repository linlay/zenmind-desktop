import type {
  DesktopPetMessageItem,
  DesktopPetDragDirection,
  DesktopPetSignatureTrigger,
  DesktopPetStatus,
  DesktopPetTaskItem
} from "./contracts/pet-copilot";

export type { DesktopPetDragDirection } from "./contracts/pet-copilot";

export type DesktopPetVisualStatus =
  | DesktopPetStatus
  | "dragging"
  | "failed"
  | "jumping"
  | "moving-left"
  | "review"
  | "signature";

export type DesktopPetVisualStatusInput = {
  displayStatus: DesktopPetStatus;
  isDragging: boolean;
  dragDirection: DesktopPetDragDirection;
  hasDragMovement?: boolean;
  activeStandardAction?: "jumping" | null;
  hasActiveSignature: boolean;
  activeSignatureTrigger?: DesktopPetSignatureTrigger | null;
  isReviewing: boolean;
};

export type DesktopPetUnreadBadgeTone = "awaiting" | "message";

type DesktopPetUnreadBadgeMessage = Pick<DesktopPetMessageItem, "chatId" | "status" | "unread" | "awaitingCount">;
type DesktopPetUnreadBadgeTask = Pick<DesktopPetTaskItem, "chatId" | "status" | "awaitingCount">;

export type DesktopPetUnreadBadgeCountsInput = {
  displayStatus: DesktopPetStatus;
  unreadCount?: unknown;
  visibleMessages?: readonly DesktopPetUnreadBadgeMessage[];
  messages?: readonly DesktopPetUnreadBadgeMessage[];
  activeTasks?: readonly DesktopPetUnreadBadgeTask[];
};

export type DesktopPetUnreadBadgeToneInput = Omit<DesktopPetUnreadBadgeCountsInput, "activeTasks">;

export type DesktopPetUnreadBadgeCounts = {
  awaitingCount: number;
  completedCount: number;
};

function normalizeUnreadBadgeCount(value: unknown) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function normalizeAwaitingBadgeCount(value: unknown) {
  const count = normalizeUnreadBadgeCount(value);
  return count > 0 ? count : 1;
}

function countBadgeMessages(
  messages: readonly DesktopPetUnreadBadgeMessage[] | undefined,
  status: DesktopPetMessageItem["status"],
  unreadOnly: boolean
) {
  return (messages ?? []).filter((message) => message.status === status && (!unreadOnly || message.unread)).length;
}

function setAwaitingBadgeCount(countsByKey: Map<string, number>, key: string, count: number) {
  countsByKey.set(key, Math.max(countsByKey.get(key) ?? 0, count));
}

export function deriveDesktopPetVisualStatus(input: DesktopPetVisualStatusInput): DesktopPetVisualStatus {
  if (input.isDragging) {
    return input.dragDirection || input.hasDragMovement ? "moving-left" : "dragging";
  }
  if (input.hasActiveSignature && input.activeSignatureTrigger === "manual") {
    return "signature";
  }
  if (input.displayStatus === "awaiting") {
    return "awaiting";
  }
  if (input.displayStatus === "running" && input.isReviewing) {
    return "review";
  }
  if (input.displayStatus === "running") {
    return "running";
  }
  if (input.displayStatus === "done") {
    return "done";
  }
  if (input.displayStatus === "error") {
    return "failed";
  }
  if (input.activeStandardAction === "jumping") {
    return "jumping";
  }
  if (input.hasActiveSignature) {
    return "signature";
  }
  return "idle";
}

export function resolveDesktopPetUnreadBadgeTone(input: DesktopPetUnreadBadgeToneInput): DesktopPetUnreadBadgeTone {
  const counts = resolveDesktopPetUnreadBadgeCounts(input);

  return counts.awaitingCount > 0 && counts.completedCount === 0
    ? "awaiting"
    : "message";
}

export function resolveDesktopPetUnreadBadgeCounts(input: DesktopPetUnreadBadgeCountsInput): DesktopPetUnreadBadgeCounts {
  const visibleMessages = input.visibleMessages ?? [];
  const usesVisibleMessages = visibleMessages.length > 0;
  const messageSource = usesVisibleMessages ? visibleMessages : input.messages ?? [];
  const unreadOnly = !usesVisibleMessages;
  const completedMessageCount = countBadgeMessages(messageSource, "done", unreadOnly);
  const awaitingCountsByKey = new Map<string, number>();
  messageSource.forEach((message, index) => {
    if (message.status !== "awaiting" || (unreadOnly && !message.unread)) {
      return;
    }
    setAwaitingBadgeCount(
      awaitingCountsByKey,
      message.chatId || `message:${index}`,
      normalizeAwaitingBadgeCount(message.awaitingCount)
    );
  });
  (input.activeTasks ?? []).forEach((task, index) => {
    if (task.status !== "awaiting") {
      return;
    }
    setAwaitingBadgeCount(
      awaitingCountsByKey,
      task.chatId || `task:${index}`,
      normalizeAwaitingBadgeCount(task.awaitingCount)
    );
  });
  const awaitingCount = [...awaitingCountsByKey.values()].reduce((total, count) => total + count, 0);
  const unreadCount = normalizeUnreadBadgeCount(input.unreadCount);

  if (messageSource.length > 0 || awaitingCount > 0) {
    return {
      awaitingCount,
      completedCount: completedMessageCount
    };
  }

  if (input.displayStatus === "awaiting") {
    return {
      awaitingCount: unreadCount,
      completedCount: 0
    };
  }

  return {
    awaitingCount: 0,
    completedCount: unreadCount
  };
}
