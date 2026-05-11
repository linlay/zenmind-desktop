import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { DesktopPetPreviewItemStatus, DesktopPetState, DesktopPetStatus } from "../../shared/contracts";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  getDesktopPetStatusAssetPath,
  normalizeDesktopPetAppearanceId
} from "../../shared/desktop-pet";

function createFallbackDesktopPetState(): DesktopPetState {
  return {
    supported: true,
    enabled: true,
    visible: true,
    status: "idle",
    hint: "",
    messagePreview: "",
    unreadCount: 0,
    chatId: null,
    appearanceId: DEFAULT_DESKTOP_PET_APPEARANCE_ID,
    appearanceOptions: [...DESKTOP_PET_APPEARANCE_OPTIONS],
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agentDisplayName: "",
    agentRole: "",
    agentPresence: "offline",
    agentStatusStale: true,
    agentOptions: [],
    previewPanel: null,
    updatedAt: ""
  };
}

function normalizePetStatus(status: DesktopPetStatus): DesktopPetStatus {
  if (status === "running") {
    return "running";
  }
  if (status === "awaiting") {
    return "awaiting";
  }
  if (status === "done") {
    return "done";
  }
  if (status === "error") {
    return "error";
  }
  return "idle";
}

function formatPetHint(status: DesktopPetStatus) {
  if (status === "running" || status === "awaiting") {
    return "思考中";
  }
  if (status === "done") {
    return "已完成";
  }
  if (status === "error") {
    return "出错了";
  }
  return "";
}

function formatPreviewStatus(status: DesktopPetPreviewItemStatus) {
  switch (status) {
    case "running":
      return "运行中";
    case "waiting":
      return "等待中";
    case "error":
      return "失败";
    case "cancelled":
      return "已取消";
    case "success":
    case "done":
      return "完成";
    default:
      return "待处理";
  }
}

type DesktopPetDragState = {
  pointerId: number;
  target: HTMLElement;
};

type DesktopPetVisualStatus = DesktopPetStatus | "dragging" | "hover" | "message" | "thinking" | "dancing";

const DESKTOP_PET_DANCE_DURATION_MS = 3000;
const DESKTOP_PET_IMAGE_HIT_MARGIN = 8;

function rectContainsPoint(rect: DOMRect, x: number, y: number, margin = 0) {
  return x >= rect.left - margin &&
    x <= rect.right + margin &&
    y >= rect.top - margin &&
    y <= rect.bottom + margin;
}

function pointIntersectsElement(selector: string, x: number, y: number, margin = 0) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  return rectContainsPoint(rect, x, y, margin);
}

function pointIntersectsVisiblePetArea(x: number, y: number) {
  return pointIntersectsElement(".desktop-pet-image", x, y, DESKTOP_PET_IMAGE_HIT_MARGIN) ||
    pointIntersectsElement(".desktop-pet-unread-badge", x, y, 4) ||
    pointIntersectsElement(".desktop-pet-speech", x, y) ||
    pointIntersectsElement(".desktop-pet-preview", x, y);
}

export function DesktopPet() {
  const [petState, setPetState] = useState<DesktopPetState>(createFallbackDesktopPetState);
  const [isHovering, setIsHovering] = useState(false);
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDancing, setIsDancing] = useState(false);
  const dragStateRef = useRef<DesktopPetDragState | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const danceTimeoutRef = useRef<number | null>(null);
  const appearanceIdRef = useRef(DEFAULT_DESKTOP_PET_APPEARANCE_ID);
  const draggingRef = useRef(false);
  const mouseInteractiveRef = useRef(true);

  function clearDragCleanup() {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
  }

  function releaseDragPointerCapture(dragState: DesktopPetDragState) {
    try {
      if (dragState.target.hasPointerCapture(dragState.pointerId)) {
        dragState.target.releasePointerCapture(dragState.pointerId);
      }
    } catch {
      // The capture may already be gone if macOS moved focus or opened a context menu.
    }
  }

  function resetLocalDragState() {
    const dragState = dragStateRef.current;
    clearDragCleanup();
    if (dragState) {
      releaseDragPointerCapture(dragState);
    }
    dragStateRef.current = null;
    setIsDragging(false);
  }

  function clearDanceTimer() {
    if (danceTimeoutRef.current !== null) {
      window.clearTimeout(danceTimeoutRef.current);
      danceTimeoutRef.current = null;
    }
  }

  function stopDancing() {
    clearDanceTimer();
    setIsDancing(false);
  }

  function setMouseInteractive(interactive: boolean) {
    if (mouseInteractiveRef.current === interactive) {
      return;
    }
    mouseInteractiveRef.current = interactive;
    if (typeof window.electronAPI.desktopPet.setMouseInteractive !== "function") {
      return;
    }
    void window.electronAPI.desktopPet.setMouseInteractive(interactive).catch(() => undefined);
  }

  function updateMouseInteractivityFromPoint(point: { x: number; y: number }) {
    const interactive = draggingRef.current || pointIntersectsVisiblePetArea(point.x, point.y);
    setMouseInteractive(interactive);
    setIsHovering(interactive && !draggingRef.current);
  }

  function startDance() {
    if (appearanceIdRef.current !== DEFAULT_DESKTOP_PET_APPEARANCE_ID || draggingRef.current) {
      return;
    }
    clearDanceTimer();
    setIsDancing(true);
    danceTimeoutRef.current = window.setTimeout(() => {
      danceTimeoutRef.current = null;
      setIsDancing(false);
    }, DESKTOP_PET_DANCE_DURATION_MS);
  }

  function beginDrag(point: { x: number; y: number }) {
    void window.electronAPI.desktopPet.beginDrag(point).catch(() => {
      resetLocalDragState();
    });
  }

  async function endDrag() {
    try {
      return await window.electronAPI.desktopPet.endDrag();
    } catch {
      return {
        ok: false,
        moved: false
      };
    }
  }

  useEffect(() => {
    document.body.classList.add("desktop-pet-body");
    setMouseInteractive(false);
    void window.electronAPI.desktopPet.getState().then((nextState) => {
      setPetState(nextState);
      if (!nextState.visible || normalizeDesktopPetAppearanceId(nextState.appearanceId) !== DEFAULT_DESKTOP_PET_APPEARANCE_ID) {
        stopDancing();
      }
    }).catch(() => undefined);
    const dispose = window.electronAPI.desktopPet.onStateChanged((nextState) => {
      setPetState(nextState);
      if (!nextState.visible || normalizeDesktopPetAppearanceId(nextState.appearanceId) !== DEFAULT_DESKTOP_PET_APPEARANCE_ID) {
        stopDancing();
      }
    });
    const disposeDanceRequested = typeof window.electronAPI.desktopPet.onDanceRequested === "function"
      ? window.electronAPI.desktopPet.onDanceRequested(startDance)
      : () => undefined;
    const handleWindowMouseMove = (event: globalThis.MouseEvent) => {
      updateMouseInteractivityFromPoint({
        x: event.clientX,
        y: event.clientY
      });
    };
    const handleWindowMouseLeave = () => {
      if (!draggingRef.current) {
        setMouseInteractive(false);
        setIsHovering(false);
      }
    };
    const handleWindowInactive = () => {
      if (!draggingRef.current) {
        setMouseInteractive(false);
        setIsHovering(false);
      }
    };
    const handleMouseVisibilityChange = () => {
      if (document.hidden && !draggingRef.current) {
        setMouseInteractive(false);
        setIsHovering(false);
      }
    };
    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseleave", handleWindowMouseLeave);
    window.addEventListener("blur", handleWindowInactive);
    document.addEventListener("visibilitychange", handleMouseVisibilityChange);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseleave", handleWindowMouseLeave);
      window.removeEventListener("blur", handleWindowInactive);
      document.removeEventListener("visibilitychange", handleMouseVisibilityChange);
      setMouseInteractive(false);
      dispose();
      disposeDanceRequested();
      clearDanceTimer();
      resetLocalDragState();
      void endDrag();
      document.body.classList.remove("desktop-pet-body");
    };
  }, []);

  const displayStatus = useMemo(() => normalizePetStatus(petState.status), [petState.status]);
  const unreadCount = Math.max(0, Math.round(Number(petState.unreadCount) || 0));
  const messagePreview = typeof petState.messagePreview === "string" ? petState.messagePreview.trim() : "";
  const previewPanel = petState.previewPanel?.visible ? petState.previewPanel : null;
  const hasMessageReaction = displayStatus === "idle" && !isDragging && (messagePreview.length > 0 || unreadCount > 0);
  const canShowHoverReaction = displayStatus === "idle" && !isDragging && !hasMessageReaction;
  const appearanceId = useMemo(
    () => normalizeDesktopPetAppearanceId(petState.appearanceId),
    [petState.appearanceId]
  );
  useEffect(() => {
    appearanceIdRef.current = appearanceId;
    if (appearanceId !== DEFAULT_DESKTOP_PET_APPEARANCE_ID) {
      stopDancing();
    }
  }, [appearanceId]);
  useEffect(() => {
    draggingRef.current = isDragging;
    if (isDragging) {
      setMouseInteractive(true);
      stopDancing();
    }
  }, [isDragging]);
  const visualStatus: DesktopPetVisualStatus = isDragging
    ? "dragging"
    : isDancing && appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID
      ? "dancing"
    : displayStatus === "running" || displayStatus === "awaiting"
      ? "thinking"
      : displayStatus === "done" || displayStatus === "error"
        ? displayStatus
        : hasMessageReaction
          ? "message"
          : canShowHoverReaction && (isHovering || isKeyboardFocused)
            ? "hover"
            : "idle";
  const assetPath = useMemo(
    () => getDesktopPetStatusAssetPath(appearanceId, visualStatus),
    [appearanceId, visualStatus]
  );
  const statusBubbleText = petState.hint.trim() || formatPetHint(displayStatus);
  const bubbleText = visualStatus === "message"
    ? messagePreview || "有新消息"
    : statusBubbleText;
  const showPreviewPanel = !isDragging && Boolean(previewPanel);
  const showBubble = !isDragging && !showPreviewPanel && bubbleText.length > 0;
  const showUnreadBadge = unreadCount > 0;
  const unreadText = unreadCount > 99 ? "99+" : String(unreadCount);

  function handlePreviewPointerDown(event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function handlePreviewClick(event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function togglePreviewExpanded(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!previewPanel) {
      return;
    }
    void window.electronAPI.desktopPet.setPreviewExpanded(!previewPanel.expanded);
  }

  async function finishDrag(pointerId: number | null, openAssistantIfClick: boolean) {
    const dragState = dragStateRef.current;
    if (!dragState || (pointerId !== null && dragState.pointerId !== pointerId)) {
      return;
    }
    resetLocalDragState();
    const result = await endDrag();
    if (openAssistantIfClick && !result.moved) {
      void window.electronAPI.desktopPet.openAssistant();
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }
    setMouseInteractive(true);
    stopDancing();
    void finishDrag(null, false);
    const target = event.currentTarget;
    dragStateRef.current = {
      pointerId: event.pointerId,
      target
    };
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Transparent Electron windows can reject capture during fast focus changes.
    }
    setIsDragging(true);
    event.preventDefault();
    beginDrag({ x: event.screenX, y: event.screenY });

    const pointerId = event.pointerId;
    const handleWindowPointerUp = (pointerEvent: globalThis.PointerEvent) => {
      void finishDrag(pointerEvent.pointerId, true);
    };
    const handleWindowPointerCancel = (pointerEvent: globalThis.PointerEvent) => {
      void finishDrag(pointerEvent.pointerId, false);
    };
    const handleWindowMouseUp = (mouseEvent: globalThis.MouseEvent) => {
      if (mouseEvent.button === 0) {
        void finishDrag(pointerId, true);
      }
    };
    const handleLostPointerCapture = () => {
      void finishDrag(pointerId, false);
    };
    const handleForcedDragEnd = () => {
      void finishDrag(pointerId, false);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        void finishDrag(pointerId, false);
      }
    };

    dragCleanupRef.current = () => {
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
      window.removeEventListener("mouseup", handleWindowMouseUp);
      window.removeEventListener("blur", handleForcedDragEnd);
      window.removeEventListener("contextmenu", handleForcedDragEnd);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      target.removeEventListener("lostpointercapture", handleLostPointerCapture);
    };
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    window.addEventListener("mouseup", handleWindowMouseUp);
    window.addEventListener("blur", handleForcedDragEnd);
    window.addEventListener("contextmenu", handleForcedDragEnd);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    target.addEventListener("lostpointercapture", handleLostPointerCapture);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    void finishDrag(event.pointerId, true);
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    void finishDrag(event.pointerId, false);
  }

  function handlePointerEnter() {
    setIsHovering(true);
  }

  function handlePointerLeave() {
    setIsHovering(false);
  }

  function handleButtonFocus(event: ReactFocusEvent<HTMLButtonElement>) {
    setIsKeyboardFocused(event.currentTarget.matches(":focus-visible"));
  }

  function handleButtonBlur() {
    setIsKeyboardFocused(false);
  }

  return (
    <main
      className={[
        "desktop-pet-root",
        `is-${visualStatus}`,
        `is-appearance-${appearanceId}`,
        showPreviewPanel ? "has-preview" : "",
        showBubble ? "has-bubble" : "",
        isDragging ? "is-dragging" : ""
      ].filter(Boolean).join(" ")}
      aria-label="ZenMind 桌面仙尊"
    >
      <div
        className="desktop-pet-hitbox"
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {showPreviewPanel && previewPanel ? (
          <section
            className={[
              "desktop-pet-preview",
              `is-${previewPanel.status}`,
              previewPanel.expanded ? "is-expanded" : "is-collapsed"
            ].filter(Boolean).join(" ")}
            aria-live="polite"
            onPointerDown={handlePreviewPointerDown}
            onClick={handlePreviewClick}
          >
            <div className="desktop-pet-preview-head">
              <span className="desktop-pet-preview-status-dot" aria-hidden="true" />
              <div className="desktop-pet-preview-copy">
                <strong>{previewPanel.title}</strong>
                <span>{previewPanel.summary}</span>
              </div>
              <button
                type="button"
                className={[
                  "desktop-pet-preview-toggle",
                  previewPanel.expanded ? "is-expanded" : ""
                ].filter(Boolean).join(" ")}
                aria-label={previewPanel.expanded ? "收起运行预览" : "展开运行预览"}
                aria-expanded={previewPanel.expanded}
                onClick={togglePreviewExpanded}
              >
                <span className="desktop-pet-preview-toggle-icon" aria-hidden="true" />
              </button>
            </div>
            {previewPanel.expanded ? (
              <ol className="desktop-pet-preview-list">
                {previewPanel.items.map((item) => {
                  const itemDetailText = item.detailText ?? item.text;
                  return (
                    <li key={item.id} className={`desktop-pet-preview-item is-${item.status}`}>
                      <span className="desktop-pet-preview-item-dot" aria-hidden="true" />
                      <div className="desktop-pet-preview-item-copy">
                        <strong>{item.title}</strong>
                        {itemDetailText ? <span>{itemDetailText}</span> : null}
                      </div>
                      <small>{formatPreviewStatus(item.status)}</small>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </section>
        ) : showBubble ? (
          <div
            className={`desktop-pet-speech is-${visualStatus === "message" ? "message" : displayStatus}`}
            aria-live="polite"
          >
            <span>{bubbleText}</span>
          </div>
        ) : null}
        <button
          type="button"
          className="desktop-pet-button"
          aria-label="打开侧边栏助手"
          onFocus={handleButtonFocus}
          onBlur={handleButtonBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void window.electronAPI.desktopPet.openAssistant();
            }
          }}
        >
          <img src={assetPath} alt="" aria-hidden="true" className="desktop-pet-image" />
          {showUnreadBadge ? (
            <span className="desktop-pet-unread-badge" aria-label={`${unreadCount} 条未读消息`}>
              {unreadText}
            </span>
          ) : null}
        </button>
      </div>
    </main>
  );
}
