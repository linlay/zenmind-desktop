import type {
  DesktopPetSignatureTrigger,
  DesktopPetStatus
} from "./contracts/pet-copilot";

export type DesktopPetDragDirection = "left" | "right" | null;

export type DesktopPetVisualStatus =
  | DesktopPetStatus
  | "dragging"
  | "drag-moving"
  | "hover"
<<<<<<< HEAD
  | "message"
=======
>>>>>>> 3074908ee17d8e4b624b43a3a7f90f3cb07fe468
  | "signature";

export type DesktopPetVisualStatusInput = {
  displayStatus: DesktopPetStatus;
  isDragging: boolean;
  dragDirection: DesktopPetDragDirection;
  hasActiveSignature: boolean;
  activeSignatureTrigger?: DesktopPetSignatureTrigger | null;
  shouldShowTaskRunAnimation: boolean;
  canShowHoverReaction: boolean;
  isHovering: boolean;
  isKeyboardFocused: boolean;
};

export function deriveDesktopPetVisualStatus(input: DesktopPetVisualStatusInput): DesktopPetVisualStatus {
  if (input.isDragging) {
    return "drag-moving";
  }
  if (input.displayStatus === "awaiting") {
    return "awaiting";
  }
  if (input.shouldShowTaskRunAnimation) {
    return "running";
  }
  if (input.displayStatus === "running") {
    return "running";
  }
  if (input.displayStatus === "done" || input.displayStatus === "error") {
    return input.displayStatus;
  }
  if (input.hasActiveSignature && input.activeSignatureTrigger === "manual") {
    return "signature";
  }
  if (input.canShowHoverReaction && (input.isHovering || input.isKeyboardFocused)) {
    return "hover";
  }
  if (input.hasActiveSignature) {
    return "signature";
  }
  return "idle";
}
