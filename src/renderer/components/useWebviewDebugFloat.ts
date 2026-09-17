import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clampWebviewDebugFloatPosition,
  moveWebviewDebugDockCorner,
  resolveWebviewDebugDockCorner,
  type WebviewDebugDockCorner,
} from "../debug/webviewDebugFloatGeometry";

const DRAG_THRESHOLD_PX = 5;
const SAFE_INSET_PX = 12;
let lastWebviewDebugDockCorner: WebviewDebugDockCorner = "bottom-right";

type ActiveDrag = {
  cancel: () => void;
};

export function useWebviewDebugFloat(enabled: boolean) {
  const [corner, setCorner] = useState<WebviewDebugDockCorner>(
    () => lastWebviewDebugDockCorner,
  );
  const overlayRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLElement | null>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  const setItemRef = useCallback((node: HTMLElement | null) => {
    itemRef.current = node;
  }, []);

  const focusItem = useCallback(() => {
    window.requestAnimationFrame(() => itemRef.current?.focus());
  }, []);

  const commitCorner = useCallback((nextCorner: WebviewDebugDockCorner) => {
    lastWebviewDebugDockCorner = nextCorner;
    setCorner(nextCorner);
  }, []);

  const cancelActiveDrag = useCallback(() => {
    activeDragRef.current?.cancel();
  }, []);

  useEffect(() => {
    if (!enabled) {
      cancelActiveDrag();
    }
  }, [cancelActiveDrag, enabled]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => cancelActiveDrag());
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [cancelActiveDrag, enabled]);

  useEffect(() => () => {
    cancelActiveDrag();
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
    }
  }, [cancelActiveDrag]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const nestedButton = event.target instanceof Element
      ? event.target.closest("button")
      : null;
    if (
      !enabled ||
      !event.isPrimary ||
      event.button !== 0 ||
      (nestedButton !== null && nestedButton !== event.currentTarget)
    ) {
      return;
    }

    const overlay = overlayRef.current;
    const item = itemRef.current;
    if (!overlay || !item) {
      return;
    }
    const dragOverlay = overlay;
    const dragItem = item;

    cancelActiveDrag();
    const overlayRect = dragOverlay.getBoundingClientRect();
    const itemRect = dragItem.getBoundingClientRect();
    if (overlayRect.width <= 0 || overlayRect.height <= 0) {
      return;
    }

    const pointerId = event.pointerId;
    const pointerTarget = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = {
      x: itemRect.left - overlayRect.left,
      y: itemRect.top - overlayRect.top,
    };
    const itemSize = { width: itemRect.width, height: itemRect.height };
    const containerSize = { width: overlayRect.width, height: overlayRect.height };
    let lastPosition = startPosition;
    let hasDragged = false;
    let ended = false;

    const clearDragStyles = () => {
      dragItem.style.removeProperty("--webview-debug-float-x");
      dragItem.style.removeProperty("--webview-debug-float-y");
      dragItem.removeAttribute("data-dragging");
      dragOverlay.removeAttribute("data-dragging");
    };

    const removeListeners = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      pointerTarget.removeEventListener("lostpointercapture", handleLostPointerCapture);
    };

    const finish = (commit: boolean) => {
      if (ended) return;
      ended = true;
      removeListeners();
      activeDragRef.current = null;
      try {
        if (pointerTarget.hasPointerCapture(pointerId)) {
          pointerTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // Pointer capture may already be gone after focus or visibility changes.
      }
      clearDragStyles();

      if (!hasDragged) return;
      suppressClickRef.current = true;
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressClickTimerRef.current = null;
      }, 0);
      if (commit) {
        commitCorner(resolveWebviewDebugDockCorner(lastPosition, itemSize, containerSize));
      }
    };

    function handlePointerMove(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      const deltaX = pointerEvent.clientX - startX;
      const deltaY = pointerEvent.clientY - startY;
      if (!hasDragged && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) {
        return;
      }
      if (!hasDragged) {
        hasDragged = true;
        dragOverlay.setAttribute("data-dragging", "true");
        dragItem.setAttribute("data-dragging", "true");
      }
      lastPosition = clampWebviewDebugFloatPosition(
        { x: startPosition.x + deltaX, y: startPosition.y + deltaY },
        itemSize,
        containerSize,
        SAFE_INSET_PX,
      );
      dragItem.style.setProperty("--webview-debug-float-x", `${lastPosition.x}px`);
      dragItem.style.setProperty("--webview-debug-float-y", `${lastPosition.y}px`);
      pointerEvent.preventDefault();
      pointerEvent.stopPropagation();
    }

    function handlePointerUp(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId === pointerId) finish(true);
    }

    function handlePointerCancel(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId === pointerId) finish(false);
    }

    function handleWindowBlur() {
      finish(false);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") finish(false);
    }

    function handleLostPointerCapture(captureEvent: Event) {
      if ((captureEvent as PointerEvent).pointerId === pointerId) finish(false);
    }

    activeDragRef.current = { cancel: () => finish(false) };
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    pointerTarget.addEventListener("lostpointercapture", handleLostPointerCapture);
    try {
      pointerTarget.setPointerCapture(pointerId);
    } catch {
      // Window listeners still complete or cancel the gesture.
    }
  }, [cancelActiveDrag, commitCorner, enabled]);

  const handleDockKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || !event.key.startsWith("Arrow")) {
      return;
    }
    const nextCorner = moveWebviewDebugDockCorner(corner, event.key);
    if (nextCorner !== corner) {
      commitCorner(nextCorner);
    }
    event.preventDefault();
    event.stopPropagation();
  }, [commitCorner, corner]);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
  }, []);

  return {
    corner,
    overlayRef,
    setItemRef,
    focusItem,
    handlePointerDown,
    handleDockKeyDown,
    handleClickCapture,
  };
}
