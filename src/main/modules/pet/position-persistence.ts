import type { DesktopPetBoundsLike } from "./controller-model";
import type { DesktopPetWindowMode } from "./desktop-pet";
import { getDesktopPetLogicalPositionFromBounds } from "./pet-window-layout";

export function getDesktopPetBoundsSignature(bounds: DesktopPetBoundsLike) {
  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
}

export function computeDesktopPetBoundsUpdate(input: {
  currentBounds: DesktopPetBoundsLike;
  nextBounds: DesktopPetBoundsLike;
}) {
  if (
    input.currentBounds.x === input.nextBounds.x &&
    input.currentBounds.y === input.nextBounds.y &&
    input.currentBounds.width === input.nextBounds.width &&
    input.currentBounds.height === input.nextBounds.height
  ) {
    return {
      clearPendingGuard: true,
      pendingSignature: null,
      setBounds: null
    };
  }

  return {
    clearPendingGuard: false,
    pendingSignature: getDesktopPetBoundsSignature(input.nextBounds),
    setBounds: input.nextBounds
  };
}

export function computeDesktopPetPositionPersistence(input: {
  bounds: DesktopPetBoundsLike;
  mode: DesktopPetWindowMode;
  pendingSignature?: string | null;
  currentPosition?: { x: number; y: number };
  displayArea?: DesktopPetBoundsLike;
}) {
  const boundsSignature = getDesktopPetBoundsSignature(input.bounds);
  if (input.pendingSignature) {
    return {
      clearPendingGuard: boundsSignature === input.pendingSignature,
      position: null,
      shouldPersist: false
    };
  }

  const logicalPosition = getDesktopPetLogicalPositionFromBounds(
    input.bounds,
    input.mode,
    input.displayArea,
    input.currentPosition
  );
  if (
    input.currentPosition &&
    input.currentPosition.x === logicalPosition.x &&
    input.currentPosition.y === logicalPosition.y
  ) {
    return {
      clearPendingGuard: false,
      position: null,
      shouldPersist: false
    };
  }

  return {
    clearPendingGuard: false,
    position: logicalPosition,
    shouldPersist: true
  };
}
