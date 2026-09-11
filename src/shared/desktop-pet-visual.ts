import type {
  DesktopPetDragDirection,
  DesktopPetSignatureTrigger,
  DesktopPetStatus
} from "./contracts/pet-copilot";
import type { AssistantNavigationAttentionSummary } from "./contracts/copilot";

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

export type DesktopPetUnreadBadgeTone = "awaiting" | "unread";

export type DesktopPetUnreadBadgeCountsInput = {
  navigationAttention: AssistantNavigationAttentionSummary;
};

export type DesktopPetUnreadBadgeToneInput = DesktopPetUnreadBadgeCountsInput;

export type DesktopPetUnreadBadgeCounts = {
  pendingCount: number;
  unreadCount: number;
};

function normalizeUnreadBadgeCount(value: unknown) {
  return Math.max(0, Math.round(Number(value) || 0));
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

  return counts.pendingCount > 0 && counts.unreadCount === 0
    ? "awaiting"
    : "unread";
}

export function resolveDesktopPetUnreadBadgeCounts(input: DesktopPetUnreadBadgeCountsInput): DesktopPetUnreadBadgeCounts {
  return {
    pendingCount: normalizeUnreadBadgeCount(input.navigationAttention.total.pendingCount),
    unreadCount: normalizeUnreadBadgeCount(input.navigationAttention.total.unreadCount)
  };
}
