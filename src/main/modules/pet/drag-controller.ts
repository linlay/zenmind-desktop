import type { DesktopPetDragControllerOptions, DesktopPetDragController, DesktopPetBounds } from "./controller-model";
import type { DesktopPetWindowMode } from "./desktop-pet";
import type { DesktopPetDragDirection } from "../../../shared/contracts";
import { isDesktopPetSupportedPlatform } from "./pet-settings";
import { resolveDesktopPetWindowLayout, getDesktopPetLogicalPositionFromBounds, clampDesktopPetPosition } from "./pet-window-layout";
import { DESKTOP_PET_WINDOW_SIZE } from "./pet-window-metrics";

export function createDesktopPetDragController(options: DesktopPetDragControllerOptions): DesktopPetDragController {
  let dragState: {
    startPoint: { x: number; y: number };
    startLogicalPosition: { x: number; y: number };
    lastPoint: { x: number; y: number };
    moved: boolean;
    startedAt: number;
    lastMovedAt: number;
    mode: DesktopPetWindowMode;
    direction: DesktopPetDragDirection;
  } | null = null;
  let lastRequestedDragAnchor: {
    position: { x: number; y: number };
    displayBounds: DesktopPetBounds;
    mode: DesktopPetWindowMode;
  } | null = null;
  let dragTimer: any = null;

  const runSetInterval = options.setInterval || setInterval;
  const runClearInterval = options.clearInterval || clearInterval;
  const forceEndMs = typeof options.forceEndMs === "number" ? options.forceEndMs : 30000;

  function isDragging() {
    return Boolean(dragState);
  }

  function getDragDirection(): DesktopPetDragDirection {
    return dragState?.direction ?? null;
  }

  function hasDragMovement() {
    return dragState?.moved ?? false;
  }

  function clearTimer() {
    if (dragTimer) {
      runClearInterval(dragTimer);
      dragTimer = null;
    }
  }

  function prepareWindowForDrag(mode: DesktopPetWindowMode) {
    void mode;
    // Do not resize/re-anchor the window while the pointer is already down.
    // Switching from bubble/task bounds to base bounds here breaks the cursor offset on multi-display setups.
  }

  function moveWindowToLogicalPosition(
    position: { x: number; y: number },
    cursorPoint: { x: number; y: number },
    mode: DesktopPetWindowMode
  ) {
    const window = options.getWindow();
    if (!isDesktopPetSupportedPlatform(options.platform) || !window || window.isDestroyed()) {
      return { ok: false };
    }
    const displayBounds = options.getPointDisplayBounds(cursorPoint);
    const layout = resolveDesktopPetWindowLayout(position, displayBounds, mode);
    lastRequestedDragAnchor = {
      position: layout.position,
      displayBounds,
      mode
    };
    window.setBounds(layout.bounds, false);
    options.onLayoutChanged?.(layout);
    window.moveTop();
    return { ok: true };
  }

  function moveWindowBy(delta: { x?: unknown; y?: unknown }) {
    const window = options.getWindow();
    if (!isDesktopPetSupportedPlatform(options.platform) || !window || window.isDestroyed()) {
      return { ok: false };
    }
    const deltaX = Number(delta.x);
    const deltaY = Number(delta.y);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return { ok: false };
    }
    if (deltaX === 0 && deltaY === 0) {
      return { ok: true };
    }

    const currentBounds = window.getBounds();
    const cursorPoint = options.getCursorScreenPoint();
    const displayBounds = options.getPointDisplayBounds(cursorPoint);
    const mode = dragState?.mode ?? options.getMode();
    const logicalPosition = lastRequestedDragAnchor?.mode === mode
      ? lastRequestedDragAnchor.position
      : getDesktopPetLogicalPositionFromBounds(
          currentBounds,
          mode,
          displayBounds,
          options.getSettings().position
        );
    return moveWindowToLogicalPosition({
      x: logicalPosition.x + Math.round(deltaX),
      y: logicalPosition.y + Math.round(deltaY)
    }, cursorPoint, mode);
  }

  function stickToEdge(mode: DesktopPetWindowMode = options.getMode()) {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) {
      return null;
    }
    const currentBounds = window.getBounds();
    const requestedAnchor = lastRequestedDragAnchor?.mode === mode
      ? lastRequestedDragAnchor
      : null;
    const currentCenter = requestedAnchor
      ? null
      : {
          x: currentBounds.x + Math.round(currentBounds.width / 2),
          y: currentBounds.y + Math.round(currentBounds.height / 2)
        };
    const currentDisplayBounds = requestedAnchor
      ? requestedAnchor.displayBounds
      : options.getPointDisplayBounds(currentCenter!);
    const logicalPosition = requestedAnchor?.position ??
      getDesktopPetLogicalPositionFromBounds(currentBounds, mode, currentDisplayBounds, options.getSettings().position);
    const displayBounds = requestedAnchor?.displayBounds ?? options.getDisplayBounds(logicalPosition);
    const snappedBounds = clampDesktopPetPosition(logicalPosition, displayBounds, DESKTOP_PET_WINDOW_SIZE, {
      allowVisibleEdgeDock: true,
      stickToEdges: true
    });
    const snappedPosition = {
      x: snappedBounds.x,
      y: snappedBounds.y
    };
    const layout = resolveDesktopPetWindowLayout(snappedPosition, displayBounds, mode);
    const nextBounds = layout.bounds;
    options.guardProgrammaticBounds?.(nextBounds);
    if (
      currentBounds.x === nextBounds.x &&
      currentBounds.y === nextBounds.y &&
      currentBounds.width === nextBounds.width &&
      currentBounds.height === nextBounds.height
    ) {
      options.onLayoutChanged?.(layout);
      return {
        position: snappedPosition,
        bounds: nextBounds
      };
    }
    window.setBounds(nextBounds, false);
    options.onLayoutChanged?.(layout);
    return {
      position: snappedPosition,
      bounds: nextBounds
    };
  }

  function beginDrag(point: { x?: unknown; y?: unknown }) {
    const window = options.getWindow();
    if (!isDesktopPetSupportedPlatform(options.platform) || !window || window.isDestroyed()) {
      return { ok: false };
    }
    void point;
    const startPoint = options.getCursorScreenPoint();
    const initialMode = options.getMode();
    const startDisplayBounds = options.getPointDisplayBounds(startPoint);
    const startLogicalPosition = getDesktopPetLogicalPositionFromBounds(
      window.getBounds(),
      initialMode,
      startDisplayBounds,
      options.getSettings().position
    );
    lastRequestedDragAnchor = null;
    clearTimer();
    const startedAt = Date.now();
    dragState = {
      startPoint,
      startLogicalPosition,
      lastPoint: startPoint,
      moved: false,
      startedAt,
      lastMovedAt: startedAt,
      mode: initialMode,
      direction: null
    };
    prepareWindowForDrag(initialMode);
    options.onLayoutChanged?.(resolveDesktopPetWindowLayout(startLogicalPosition, startDisplayBounds, initialMode));
    options.refreshState();

    dragTimer = runSetInterval(() => {
      if (!dragState || !window || window.isDestroyed()) {
        clearTimer();
        return;
      }
      if (Date.now() - dragState.lastMovedAt > forceEndMs) {
        endDrag();
        return;
      }

      updateDragPosition();
    }, 16);

    return { ok: true };
  }

  function updateDragPosition() {
    if (!dragState) {
      return;
    }
    const cursorPoint = options.getCursorScreenPoint();
    const totalDeltaX = cursorPoint.x - dragState.startPoint.x;
    const totalDeltaY = cursorPoint.y - dragState.startPoint.y;
    if (!dragState.moved && Math.hypot(totalDeltaX, totalDeltaY) < 4) {
      return;
    }
    const deltaX = cursorPoint.x - dragState.lastPoint.x;
    const deltaY = cursorPoint.y - dragState.lastPoint.y;
    const wasMoved = dragState.moved;
    dragState.moved = true;
    dragState.lastPoint = cursorPoint;
    const nextDirection = Math.abs(deltaX) >= 3
      ? deltaX < 0 ? "left" : "right"
      : dragState.direction;
    if (!wasMoved || nextDirection !== dragState.direction) {
      dragState.direction = nextDirection;
      options.refreshState();
    }
    if (deltaX !== 0 || deltaY !== 0) {
      dragState.lastMovedAt = Date.now();
      moveWindowToLogicalPosition({
        x: dragState.startLogicalPosition.x + Math.round(totalDeltaX),
        y: dragState.startLogicalPosition.y + Math.round(totalDeltaY)
      }, cursorPoint, dragState.mode);
    }
  }

  function endDrag() {
    if (!dragState) {
      return { ok: true, moved: false };
    }
    // The release can arrive between two 16 ms samples. Keep its final position.
    updateDragPosition();
    const moved = dragState.moved;
    const mode = dragState.mode;
    dragState = null;
    clearTimer();
    if (moved) {
      const snappedAnchor = stickToEdge(mode);
      if (snappedAnchor) {
        options.saveSettings({
          position: snappedAnchor.position
        });
      } else {
        options.persistPosition(mode);
      }
    }
    lastRequestedDragAnchor = null;
    options.refreshState();
    return {
      ok: true,
      moved
    };
  }

  return {
    isDragging,
    getDragDirection,
    hasDragMovement,
    beginDrag,
    endDrag,
    moveWindowBy,
    stickToEdge,
    prepareWindowForDrag,
    clearTimer
  };
}
