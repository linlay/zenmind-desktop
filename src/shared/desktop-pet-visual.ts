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
  | "signature";

export type DesktopPetVisualStatusInput = {
  displayStatus: DesktopPetStatus;
  isDragging: boolean;
  dragDirection: DesktopPetDragDirection;
  hasActiveSignature: boolean;
  activeSignatureTrigger?: DesktopPetSignatureTrigger | null;
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
