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
import type {
  DesktopPetAppearanceOption,
  DesktopPetPreviewItemStatus,
  DesktopPetSignatureAction,
  DesktopPetSignatureTrigger,
  DesktopPetSignatureVariant,
  DesktopPetState,
  DesktopPetStateAsset,
  DesktopPetStatus,
  DesktopPetTaskItem
} from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  getDesktopPetStateAsset,
  getDesktopPetStatusAssetPath,
  isDesktopPetAnimatedAsset,
  normalizeDesktopPetAppearanceId,
  resolveDesktopPetSignatureActions
} from "../../../shared/desktop-pet";
import {
  deriveDesktopPetVisualStatus,
  type DesktopPetDragDirection,
  type DesktopPetVisualStatus
} from "../../../shared/desktop-pet-visual";
import { PRODUCT_NAME } from "../../../shared/generated/brand";

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
    activeTasks: [],
    previewPanel: null,
    runningTaskCount: 0,
    edgeDock: null,
    signature: [],
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
  if (status === "awaiting") {
    return "等待你确认";
  }
  if (status === "running") {
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

function formatTaskStatus(task: DesktopPetTaskItem) {
  if (task.status !== "awaiting") {
    return "运行中";
  }
  switch (task.awaitingMode) {
    case "plan":
      return "待确认计划";
    case "question":
      return "待回答";
    case "approval":
      return "待审批";
    case "form":
      return "待填写";
    default:
      return "待确认";
  }
}

const DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH = 30;
const DESKTOP_PET_TASK_VISIBLE_LIMIT = 3;

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

type ActiveDesktopPetSignature = {
  actionId: string;
  trigger: DesktopPetSignatureTrigger;
  variant: DesktopPetSignatureVariant;
  assetPath: string;
};

const DESKTOP_PET_DONE_VISUAL_HOLD_MS = 2500;
const DESKTOP_PET_ERROR_VISUAL_HOLD_MS = 3000;
const DESKTOP_PET_IDLE_RANDOM_DELAY_MS = 25000;
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
    pointIntersectsElement(".desktop-pet-task-panel", x, y) ||
    pointIntersectsElement(".desktop-pet-preview", x, y);
}

function getDesktopPetSpriteAssetBasePath(appearanceId: string) {
  return appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID
    ? "./desktop-pet"
    : `./desktop-pet/${appearanceId}`;
}

function joinDesktopPetAssetPath(basePath: string, relativePath: string) {
  const normalizedBasePath = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return `${normalizedBasePath}${relativePath.replace(/^\/+/u, "")}`;
}

function resolveDesktopPetAppearanceOption(
  state: DesktopPetState,
  appearanceId: string
): DesktopPetAppearanceOption | null {
  return state.appearanceOptions.find((option) => option.id === appearanceId) ?? null;
}

function resolveDesktopPetVisualAsset(
  state: DesktopPetState,
  appearanceId: string,
  status: string
): { assetPath: string; asset: DesktopPetStateAsset | null } {
  const customAppearance = resolveDesktopPetAppearanceOption(state, appearanceId);
  const stateAsset = getDesktopPetStateAsset(customAppearance?.states, status);
  if (stateAsset) {
    const basePath = customAppearance?.assetBasePath ?? getDesktopPetSpriteAssetBasePath(appearanceId);
    return {
      assetPath: joinDesktopPetAssetPath(basePath, stateAsset.path),
      asset: stateAsset
    };
  }
  return {
    assetPath: getDesktopPetStatusAssetPath(appearanceId, status),
    asset: null
  };
}

function resolveDesktopPetSignatureAssetPath(
  state: DesktopPetState,
  appearanceId: string,
  variantPath: string
) {
  const appearance = resolveDesktopPetAppearanceOption(state, appearanceId);
  const basePath = appearance?.assetBasePath ?? getDesktopPetSpriteAssetBasePath(appearanceId);
  return joinDesktopPetAssetPath(basePath, variantPath);
}

function chooseDesktopPetSignatureVariant(action: DesktopPetSignatureAction): DesktopPetSignatureVariant | null {
  const variants = action.variants.filter((variant) => variant.frameCount >= 1 && variant.durationMs > 0 && variant.path.trim());
  if (variants.length === 0) {
    return null;
  }
  const totalWeight = variants.reduce((sum, variant) => sum + Math.max(1, Math.round(Number(variant.weight) || 1)), 0);
  let cursor = Math.random() * totalWeight;
  for (const variant of variants) {
    cursor -= Math.max(1, Math.round(Number(variant.weight) || 1));
    if (cursor <= 0) {
      return variant;
    }
  }
  return variants[variants.length - 1];
}

export function DesktopPet() {
  const [petState, setPetState] = useState<DesktopPetState>(createFallbackDesktopPetState);
  const [isHovering, setIsHovering] = useState(false);
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragDirection, setDragDirection] = useState<DesktopPetDragDirection>(null);
  const [activeSignature, setActiveSignature] = useState<ActiveDesktopPetSignature | null>(null);
  const [terminalVisualStatus, setTerminalVisualStatus] = useState<"done" | "error" | null>(null);
  const dragStateRef = useRef<DesktopPetDragState | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const signatureTimeoutRef = useRef<number | null>(null);
  const idleRandomTimeoutRef = useRef<number | null>(null);
  const terminalVisualTimeoutRef = useRef<number | null>(null);
  const appearanceIdRef = useRef(DEFAULT_DESKTOP_PET_APPEARANCE_ID);
  const draggingRef = useRef(false);
  const mouseInteractiveRef = useRef(true);
  const activeSignatureRef = useRef<ActiveDesktopPetSignature | null>(activeSignature);
  const petStateRef = useRef<DesktopPetState>(petState);
  activeSignatureRef.current = activeSignature;
  petStateRef.current = petState;

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

  function clearSignatureTimer() {
    if (signatureTimeoutRef.current !== null) {
      window.clearTimeout(signatureTimeoutRef.current);
      signatureTimeoutRef.current = null;
    }
  }

  function clearIdleRandomTimer() {
    if (idleRandomTimeoutRef.current !== null) {
      window.clearTimeout(idleRandomTimeoutRef.current);
      idleRandomTimeoutRef.current = null;
    }
  }

  function clearTerminalVisualTimer() {
    if (terminalVisualTimeoutRef.current !== null) {
      window.clearTimeout(terminalVisualTimeoutRef.current);
      terminalVisualTimeoutRef.current = null;
    }
  }

  function stopSignature() {
    clearSignatureTimer();
    setActiveSignature(null);
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

  function startSignature(actionId?: string, trigger: "manual" | "idle-random" = "manual") {
    if (draggingRef.current) {
      return;
    }
    const currentPetState = petStateRef.current;
    const currentStatus = normalizePetStatus(currentPetState.status);
    if (currentStatus !== "idle") {
      return;
    }
    const actions = resolveDesktopPetSignatureActions(
      appearanceIdRef.current,
      currentPetState.signature
    );
    const action = actions.find((candidate) =>
      (!actionId || candidate.id === actionId) && candidate.trigger.includes(trigger)
    );
    if (!action) {
      return;
    }
    const variant = chooseDesktopPetSignatureVariant(action);
    if (!variant) {
      return;
    }
    clearSignatureTimer();
    clearIdleRandomTimer();
    setActiveSignature({
      actionId: action.id,
      trigger,
      variant,
      assetPath: resolveDesktopPetSignatureAssetPath(currentPetState, appearanceIdRef.current, variant.path)
    });
    signatureTimeoutRef.current = window.setTimeout(() => {
      signatureTimeoutRef.current = null;
      setActiveSignature(null);
    }, variant.durationMs);
  }

  function shouldInterruptSignature(nextState: DesktopPetState) {
    const currentSignature = activeSignatureRef.current;
    const nextStatus = normalizePetStatus(nextState.status);
    const nextMessagePreview = typeof nextState.messagePreview === "string" ? nextState.messagePreview.trim() : "";
    return nextStatus !== "idle" ||
      Math.max(0, Math.round(Number(nextState.runningTaskCount) || 0)) > 0 ||
      (Array.isArray(nextState.activeTasks) && nextState.activeTasks.length > 0) ||
      (currentSignature?.trigger !== "manual" && (
        nextMessagePreview.length > 0 ||
        Math.max(0, Math.round(Number(nextState.unreadCount) || 0)) > 0
      ));
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
      if (!nextState.visible || shouldInterruptSignature(nextState)) {
        stopSignature();
      }
    }).catch(() => undefined);
    const dispose = window.electronAPI.desktopPet.onStateChanged((nextState) => {
      setPetState(nextState);
      if (!nextState.visible || shouldInterruptSignature(nextState)) {
        stopSignature();
      }
    });
    const disposeSignatureRequested = typeof window.electronAPI.desktopPet.onSignatureRequested === "function"
      ? window.electronAPI.desktopPet.onSignatureRequested((signatureId) => {
          startSignature(signatureId, "manual");
        })
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
      disposeSignatureRequested();
      clearSignatureTimer();
      clearIdleRandomTimer();
      clearTerminalVisualTimer();
      resetLocalDragState();
      void endDrag();
      document.body.classList.remove("desktop-pet-body");
    };
  }, []);

  const rawDisplayStatus = useMemo(() => normalizePetStatus(petState.status), [petState.status]);
  useEffect(() => {
    clearTerminalVisualTimer();
    if (rawDisplayStatus !== "done" && rawDisplayStatus !== "error") {
      setTerminalVisualStatus(null);
      return undefined;
    }
    setTerminalVisualStatus(rawDisplayStatus);
    terminalVisualTimeoutRef.current = window.setTimeout(() => {
      terminalVisualTimeoutRef.current = null;
      setTerminalVisualStatus(null);
    }, rawDisplayStatus === "done" ? DESKTOP_PET_DONE_VISUAL_HOLD_MS : DESKTOP_PET_ERROR_VISUAL_HOLD_MS);
    return clearTerminalVisualTimer;
  }, [rawDisplayStatus]);
  const displayStatus: DesktopPetStatus = rawDisplayStatus === "done" || rawDisplayStatus === "error"
    ? terminalVisualStatus ?? "idle"
    : rawDisplayStatus;
  const unreadCount = Math.max(0, Math.round(Number(petState.unreadCount) || 0));
  const messagePreview = typeof petState.messagePreview === "string" ? petState.messagePreview.trim() : "";
  const activeTasks = Array.isArray(petState.activeTasks) ? petState.activeTasks : [];
  const visibleTasks = activeTasks.slice(0, DESKTOP_PET_TASK_VISIBLE_LIMIT);
  const hiddenTaskCount = Math.max(0, activeTasks.length - visibleTasks.length);
  const previewPanel = petState.previewPanel?.visible ? petState.previewPanel : null;
  const showTaskPanel = !isDragging && activeTasks.length > 0;
  const showPreviewPanel = !isDragging && !showTaskPanel && Boolean(previewPanel);
  const hasMessageReaction = displayStatus === "idle" && !isDragging && (messagePreview.length > 0 || unreadCount > 0);
  const canShowHoverReaction = displayStatus === "idle" && !isDragging && !hasMessageReaction;
  const appearanceId = useMemo(
    () => normalizeDesktopPetAppearanceId(petState.appearanceId),
    [petState.appearanceId]
  );
  const signature = resolveDesktopPetSignatureActions(appearanceId, petState.signature);
  const visualStatus: DesktopPetVisualStatus = deriveDesktopPetVisualStatus({
    displayStatus,
    isDragging,
    dragDirection,
    hasActiveSignature: Boolean(activeSignature),
    activeSignatureTrigger: activeSignature?.trigger ?? null,
    canShowHoverReaction,
    isHovering,
    isKeyboardFocused
  });
  const visualAsset = useMemo(
    () => resolveDesktopPetVisualAsset(petState, appearanceId, visualStatus),
    [appearanceId, petState, visualStatus]
  );
  const shouldShowSignatureSpriteAnimation = visualStatus === "signature" && Boolean(activeSignature);
  const shouldShowStateSpriteAnimation = !shouldShowSignatureSpriteAnimation && isDesktopPetAnimatedAsset(visualAsset.asset);
  const stateAnimationFrameCount = Math.max(1, Math.round(Number(visualAsset.asset?.frameCount) || 1));
  const stateAnimationDurationMs = Math.max(100, Math.round(Number(visualAsset.asset?.durationMs) || 0));
  const rootStyle = shouldShowStateSpriteAnimation ||
    (shouldShowSignatureSpriteAnimation && activeSignature)
    ? ({
        ...(shouldShowSignatureSpriteAnimation && activeSignature
          ? {
              "--desktop-pet-signature-duration": `${activeSignature.variant.durationMs}ms`,
              "--desktop-pet-signature-frames": String(activeSignature.variant.frameCount)
            }
          : {}),
        ...(shouldShowStateSpriteAnimation
          ? {
              "--desktop-pet-state-duration": `${stateAnimationDurationMs}ms`,
              "--desktop-pet-state-frames": String(stateAnimationFrameCount),
              "--desktop-pet-state-loop-count": visualAsset.asset?.loop === false ? "1" : "infinite"
            }
          : {})
      } as CSSProperties)
    : undefined;
  const signatureSpriteStyle = shouldShowSignatureSpriteAnimation && activeSignature
    ? {
        backgroundImage: `url("${activeSignature.assetPath}")`
      }
    : undefined;
  const stateSpriteStyle = shouldShowStateSpriteAnimation
    ? {
        backgroundImage: `url("${visualAsset.assetPath}")`
      }
    : undefined;
  useEffect(() => {
    appearanceIdRef.current = appearanceId;
  }, [appearanceId]);
  useEffect(() => {
    draggingRef.current = isDragging;
    if (isDragging) {
      setMouseInteractive(true);
      stopSignature();
    }
  }, [isDragging]);
  useEffect(() => {
    clearIdleRandomTimer();
    if (
      displayStatus !== "idle" ||
      isDragging ||
      activeSignature ||
      hasMessageReaction ||
      showTaskPanel ||
      showPreviewPanel ||
      !signature.some((action) => action.trigger.includes("idle-random"))
    ) {
      return undefined;
    }
    idleRandomTimeoutRef.current = window.setTimeout(() => {
      idleRandomTimeoutRef.current = null;
      startSignature(undefined, "idle-random");
    }, DESKTOP_PET_IDLE_RANDOM_DELAY_MS);
    return clearIdleRandomTimer;
  }, [
    displayStatus,
    isDragging,
    activeSignature,
    hasMessageReaction,
    showTaskPanel,
    showPreviewPanel,
    signature,
    appearanceId
  ]);
  const assetPath = visualAsset.assetPath;
  const statusBubbleText = displayStatus === "idle"
    ? ""
    : petState.hint.trim() || formatPetHint(displayStatus);
  const bubbleText = hasMessageReaction
    ? messagePreview || "有新消息"
    : statusBubbleText;
  const inlineBubbleText = formatInlinePetPreview(bubbleText);
  const previewTitle = previewPanel ? formatInlinePetPreview(previewPanel.title) : "";
  const previewSummary = previewPanel && previewPanel.expanded
    ? formatInlinePetPreview(previewPanel.summary)
    : "";
  const showPreviewSummary = shouldShowSecondaryPreview(previewTitle, previewSummary);
  const showBubble = !isDragging && !showTaskPanel && !showPreviewPanel && bubbleText.length > 0;
  const showUnreadBadge = unreadCount > 0;
  const unreadText = unreadCount > 99 ? "99+" : String(unreadCount);

  function handlePreviewPointerDown(event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function handleTaskPointerDown(event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function handleTaskClick(event: ReactMouseEvent<HTMLButtonElement>, task: DesktopPetTaskItem) {
    event.preventDefault();
    event.stopPropagation();
    void window.electronAPI.desktopPet.openTaskChat({
      agentKey: task.agentKey,
      chatId: task.chatId
    });
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
    stopSignature();
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
        shouldShowSignatureSpriteAnimation ? "has-signature-animation" : "",
        shouldShowStateSpriteAnimation ? "has-state-animation" : "",
        showTaskPanel ? "has-tasks" : "",
        showPreviewPanel ? "has-preview" : "",
        showBubble ? "has-bubble" : "",
        petState.edgeDock === "top" ? "is-edge-dock-top" : "",
        isDragging ? "is-dragging" : "",
        visualStatus === "drag-moving" && dragDirection === "right" && (visualAsset.asset?.mirror ?? true) ? "is-drag-mirror" : ""
      ].filter(Boolean).join(" ")}
      style={rootStyle}
      aria-label={`${PRODUCT_NAME} 桌面宠物`}
    >
      <div
        className="desktop-pet-hitbox"
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {showTaskPanel ? (
          <section
            className="desktop-pet-task-panel"
            aria-live="polite"
            onPointerDown={handleTaskPointerDown}
          >
            <div className="desktop-pet-task-head">
              <span className="desktop-pet-task-head-dot" aria-hidden="true" />
              <strong>进行中 {activeTasks.length}</strong>
            </div>
            <div className="desktop-pet-task-list">
              {visibleTasks.map((task) => (
                <button
                  type="button"
                  key={task.id}
                  className={`desktop-pet-task-row is-${task.status}`}
                  onClick={(event) => handleTaskClick(event, task)}
                >
                  <span className="desktop-pet-task-dot" aria-hidden="true" />
                  <span className="desktop-pet-task-copy">
                    <strong>{task.title}</strong>
                    <span>{task.agentDisplayName}</span>
                  </span>
                  <small>{formatTaskStatus(task)}</small>
                </button>
              ))}
            </div>
            {hiddenTaskCount > 0 ? (
              <div className="desktop-pet-task-more">+{hiddenTaskCount}</div>
            ) : null}
          </section>
        ) : showPreviewPanel && previewPanel ? (
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
            className={`desktop-pet-speech is-${hasMessageReaction ? "unread" : displayStatus}`}
            aria-live="polite"
          >
            <span>{inlineBubbleText}</span>
          </div>
        ) : null}
        <button
          type="button"
          className="desktop-pet-button"
          aria-label={`打开 ${PRODUCT_NAME}`}
          onFocus={handleButtonFocus}
          onBlur={handleButtonBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void window.electronAPI.desktopPet.openAssistant();
            }
          }}
        >
          {shouldShowSignatureSpriteAnimation ? (
            <span
              aria-hidden="true"
              className="desktop-pet-image desktop-pet-signature-sprite"
              style={signatureSpriteStyle}
            />
          ) : shouldShowStateSpriteAnimation ? (
            <span
              aria-hidden="true"
              className="desktop-pet-image desktop-pet-state-sprite"
              style={stateSpriteStyle}
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
