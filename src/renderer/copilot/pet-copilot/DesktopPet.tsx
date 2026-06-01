import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { DesktopPetPreviewItemStatus, DesktopPetState, DesktopPetStatus } from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  getDesktopPetRunningTaskAnimationDurationMs,
  getDesktopPetStatusAssetPath,
  isDesktopPetDanceAppearance,
  normalizeDesktopPetAppearanceId,
  shouldUseDesktopPetTaskRunningAnimation
} from "../../../shared/desktop-pet";

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
    runningTaskCount: 0,
    edgeDock: null,
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
    return "暂无回复预览";
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

const DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH = 30;

function formatInlinePetPreview(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH - 3)).trimEnd()}...`;
}

function shouldShowSecondaryPreview(primary: string, secondary: string) {
  return Boolean(secondary) && secondary !== primary;
}

type DesktopPetDragState = {
  pointerId: number;
  target: HTMLElement;
  lastScreenX: number;
};

type DesktopPetDragDirection = "left" | "right" | null;
type DesktopPetVisualStatus =
  | DesktopPetStatus
  | "dragging"
  | "dragging-left"
  | "dragging-right"
  | "hover"
  | "message"
  | "thinking"
  | "dancing";

const DESKTOP_PET_DANCE_DURATION_MS = 3000;
const DESKTOP_PET_IDOL_PONY_DANCE_DURATION_MS = 5200;
const DESKTOP_PET_DRAG_DIRECTION_THRESHOLD_PX = 3;
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

function getDesktopPetTaskRunSpritePath(appearanceId: string) {
  return `./desktop-pet/${appearanceId}/task-run-left.webp`;
}

function getDesktopPetDanceSpritePath(appearanceId: string) {
  return `./desktop-pet/${appearanceId}/dance.webp`;
}

function getDesktopPetDanceDurationMs(appearanceId: string) {
  return appearanceId === "idol-pony" ? DESKTOP_PET_IDOL_PONY_DANCE_DURATION_MS : DESKTOP_PET_DANCE_DURATION_MS;
}

export function DesktopPet() {
  const [petState, setPetState] = useState<DesktopPetState>(createFallbackDesktopPetState);
  const [isHovering, setIsHovering] = useState(false);
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragDirection, setDragDirection] = useState<DesktopPetDragDirection>(null);
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
    setDragDirection(null);
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
    if (!isDesktopPetDanceAppearance(appearanceIdRef.current) || draggingRef.current) {
      return;
    }
    const durationMs = getDesktopPetDanceDurationMs(appearanceIdRef.current);
    clearDanceTimer();
    setIsDancing(true);
    danceTimeoutRef.current = window.setTimeout(() => {
      danceTimeoutRef.current = null;
      setIsDancing(false);
    }, durationMs);
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
      if (!nextState.visible || !isDesktopPetDanceAppearance(nextState.appearanceId)) {
        stopDancing();
      }
    }).catch(() => undefined);
    const dispose = window.electronAPI.desktopPet.onStateChanged((nextState) => {
      setPetState(nextState);
      if (!nextState.visible || !isDesktopPetDanceAppearance(nextState.appearanceId)) {
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
  const runningTaskCount = Math.max(0, Math.round(Number(petState.runningTaskCount) || 0));
  const shouldShowDanceSpriteAnimation = isDancing && appearanceId === "idol-pony";
  const shouldShowTaskRunAnimation = !isDragging && !isDancing &&
    shouldUseDesktopPetTaskRunningAnimation(appearanceId, runningTaskCount);
  const taskRunAnimationDurationMs = getDesktopPetRunningTaskAnimationDurationMs(runningTaskCount);
  const rootStyle = shouldShowTaskRunAnimation
    ? ({
        "--desktop-pet-task-run-animation-duration": `${taskRunAnimationDurationMs}ms`
      } as CSSProperties)
    : undefined;
  const taskRunSpriteStyle = shouldShowTaskRunAnimation
    ? {
        backgroundImage: `url("${getDesktopPetTaskRunSpritePath(appearanceId)}")`
      }
    : undefined;
  const danceSpriteStyle = shouldShowDanceSpriteAnimation
    ? {
        backgroundImage: `url("${getDesktopPetDanceSpritePath(appearanceId)}")`
      }
    : undefined;
  useEffect(() => {
    appearanceIdRef.current = appearanceId;
    if (!isDesktopPetDanceAppearance(appearanceId)) {
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
    ? dragDirection === "left"
      ? "dragging-left"
      : dragDirection === "right"
        ? "dragging-right"
        : "dragging"
    : isDancing && isDesktopPetDanceAppearance(appearanceId)
      ? "dancing"
    : shouldShowTaskRunAnimation
      ? "running"
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
  const inlineBubbleText = formatInlinePetPreview(bubbleText);
  const showPreviewPanel = !isDragging && Boolean(previewPanel);
  const previewTitle = previewPanel ? formatInlinePetPreview(previewPanel.title) : "";
  const previewSummary = previewPanel && previewPanel.expanded
    ? formatInlinePetPreview(previewPanel.summary)
    : "";
  const showPreviewSummary = shouldShowSecondaryPreview(previewTitle, previewSummary);
  const showBubble = !isDragging && !showPreviewPanel && bubbleText.length > 0;
  const showUnreadBadge = unreadCount > 0;
  const unreadText = unreadCount > 99 ? "99+" : String(unreadCount);

  function handlePreviewPointerDown(event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function handlePreviewClick(event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
    if (!previewPanel) {
      return;
    }
    if (previewPanel.status === "done") {
      void window.electronAPI.desktopPet.dismissPreview();
      return;
    }
    void window.electronAPI.desktopPet.setPreviewExpanded(!previewPanel.expanded);
  }

  function togglePreviewExpanded(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!previewPanel) {
      return;
    }
    void window.electronAPI.desktopPet.setPreviewExpanded(!previewPanel.expanded);
  }

  async function finishDrag(pointerId: number | null, openAppIfClick: boolean) {
    const dragState = dragStateRef.current;
    if (!dragState || (pointerId !== null && dragState.pointerId !== pointerId)) {
      return;
    }
    resetLocalDragState();
    const result = await endDrag();
    if (openAppIfClick && !result.moved) {
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
      target,
      lastScreenX: event.screenX
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
    const handleWindowPointerMove = (pointerEvent: globalThis.PointerEvent) => {
      const currentDragState = dragStateRef.current;
      if (!currentDragState || currentDragState.pointerId !== pointerEvent.pointerId) {
        return;
      }
      const deltaX = pointerEvent.screenX - currentDragState.lastScreenX;
      currentDragState.lastScreenX = pointerEvent.screenX;
      if (Math.abs(deltaX) < DESKTOP_PET_DRAG_DIRECTION_THRESHOLD_PX) {
        return;
      }
      setDragDirection(deltaX < 0 ? "left" : "right");
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
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
      window.removeEventListener("mouseup", handleWindowMouseUp);
      window.removeEventListener("blur", handleForcedDragEnd);
      window.removeEventListener("contextmenu", handleForcedDragEnd);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      target.removeEventListener("lostpointercapture", handleLostPointerCapture);
    };
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointermove", handleWindowPointerMove);
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
        shouldShowDanceSpriteAnimation ? "has-dance-animation" : "",
        shouldShowTaskRunAnimation ? "has-task-run-animation" : "",
        showPreviewPanel ? "has-preview" : "",
        showBubble ? "has-bubble" : "",
        petState.edgeDock === "top" ? "is-edge-dock-top" : "",
        isDragging ? "is-dragging" : ""
      ].filter(Boolean).join(" ")}
      style={rootStyle}
      aria-label="ZenMind 桌面宠物"
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
                <strong>{previewTitle}</strong>
                {showPreviewSummary ? <span>{previewSummary}</span> : null}
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
                  const itemTitle = formatInlinePetPreview(item.title);
                  const itemDetailPreview = formatInlinePetPreview(itemDetailText);
                  const showItemDetail = shouldShowSecondaryPreview(itemTitle, itemDetailPreview);
                  return (
                    <li key={item.id} className={`desktop-pet-preview-item is-${item.status}`}>
                      <span className="desktop-pet-preview-item-dot" aria-hidden="true" />
                      <div className="desktop-pet-preview-item-copy">
                        <strong>{itemTitle}</strong>
                        {showItemDetail ? <span>{itemDetailPreview}</span> : null}
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
            <span>{inlineBubbleText}</span>
          </div>
        ) : null}
        <button
          type="button"
          className="desktop-pet-button"
          aria-label="打开 ZenMind"
          onFocus={handleButtonFocus}
          onBlur={handleButtonBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void window.electronAPI.desktopPet.openAssistant();
            }
          }}
        >
          {shouldShowDanceSpriteAnimation ? (
            <span
              aria-hidden="true"
              className="desktop-pet-image desktop-pet-dance-sprite"
              style={danceSpriteStyle}
            />
          ) : shouldShowTaskRunAnimation ? (
            <span
              aria-hidden="true"
              className="desktop-pet-image desktop-pet-task-run-sprite"
              style={taskRunSpriteStyle}
            />
          ) : (
            <img src={assetPath} alt="" aria-hidden="true" className="desktop-pet-image" />
          )}
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
