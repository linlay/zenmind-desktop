import type {
  DesktopPetSignatureTrigger,
  DesktopPetStatus
} from "./contracts/pet-copilot";

export type DesktopPetDragDirection = "left" | "right" | null;

export type DesktopPetVisualStatus =
  | DesktopPetStatus
  | "dragging"
  | "failed"
  | "hover"
  | "jumping"
  | "moving-left"
  | "review"
  | "signature";

export type DesktopPetVisualStatusInput = {
  displayStatus: DesktopPetStatus;
  isDragging: boolean;
  dragDirection: DesktopPetDragDirection;
  activeStandardAction?: "jumping" | null;
  hasActiveSignature: boolean;
  activeSignatureTrigger?: DesktopPetSignatureTrigger | null;
  isReviewing: boolean;
  canShowHoverReaction: boolean;
  isHovering: boolean;
  isKeyboardFocused: boolean;
};

export function deriveDesktopPetVisualStatus(input: DesktopPetVisualStatusInput): DesktopPetVisualStatus {
  if (input.isDragging) {
    return input.dragDirection ? "moving-left" : "dragging";
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
  if (input.hasActiveSignature && input.activeSignatureTrigger === "manual") {
    return "signature";
  }
  if (input.activeStandardAction === "jumping") {
    return "jumping";
  }
  if (input.canShowHoverReaction && (input.isHovering || input.isKeyboardFocused)) {
    return "hover";
  }
  if (input.hasActiveSignature) {
    return "signature";
  }
  return "idle";
}
