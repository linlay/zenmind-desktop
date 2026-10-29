import ClockCircleOutlined from "@ant-design/icons/ClockCircleOutlined";
import CloseOutlined from "@ant-design/icons/CloseOutlined";
import DownOutlined from "@ant-design/icons/DownOutlined";
import EnterOutlined from "@ant-design/icons/EnterOutlined";
import MessageOutlined from "@ant-design/icons/MessageOutlined";
import UpOutlined from "@ant-design/icons/UpOutlined";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { useLocation } from "react-router-dom";
import type {
  DesktopPetAppearanceOption,
  DesktopPetPreviewPanel,
  DesktopPetSignatureAction,
  DesktopPetSignatureTrigger,
  DesktopPetSignatureVariant,
  DesktopPetState,
  DesktopPetStateAsset,
  DesktopPetStatus,
  DesktopPetMessageItem,
  DesktopPetWindowMode
} from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  getDesktopPetStateAsset,
  getDesktopPetStatusAssetPath,
  isDesktopPetAnimatedAsset,
  normalizeDesktopPetAppearanceId,
  versionedDesktopPetAssetUrl,
  resolveDesktopPetSignatureActions
} from "../../../shared/desktop-pet";
import {
  deriveDesktopPetVisualStatus,
  resolveDesktopPetUnreadBadgeCounts,
  type DesktopPetDragDirection,
  type DesktopPetVisualStatus
} from "../../../shared/desktop-pet-visual";
import { PRODUCT_NAME } from "../../../shared/brand";
import { useI18n } from "../../i18n/useI18n";
import { formatDesktopPetMessagePreview } from "./desktopPetMessagePreview";
import {
  loadDesktopPetAlphaMask,
  pointIntersectsDesktopPetImage,
  type DesktopPetAlphaMask
} from "./desktopPetHitTest";

type DesktopPetTranslate = ReturnType<typeof useI18n>["t"];

function createFallbackDesktopPetState(): DesktopPetState {
  return {
    supported: true,
    enabled: true,
    windowMode: "base",
    status: "idle",
    hint: "",
    messagePreview: "",
    unreadCount: 0,
    navigationAttention: {
      chats: { unreadCount: 0, pendingCount: 0 },
      projects: { unreadCount: 0, pendingCount: 0 },
      total: { unreadCount: 0, pendingCount: 0 }
    },
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
    messages: [],
    previewPanel: null,
    runningTaskCount: 0,
    edgeDock: null,
    panelPlacement: null,
    dragDirection: null,
    dragMoved: false,
    signature: [],
    updatedAt: Date.now()
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

const DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH = 30;

function formatInlinePetPreview(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH - 3)).trimEnd()}...`;
}

function getVisibleDesktopPetMessages(messages: readonly DesktopPetMessageItem[]) {
  return messages
    .filter((message) => message.unread || message.status === "awaiting")
    .sort((left, right) => {
      const awaitingPriority = Number(right.status === "awaiting") - Number(left.status === "awaiting");
      return awaitingPriority || right.updatedAt - left.updatedAt;
    });
}

function formatMessageCardPreview(
  message: DesktopPetMessageItem,
  isThinking: boolean,
  draftText: string,
  t: DesktopPetTranslate
) {
  const draftPreview = formatInlinePetPreview(draftText);
  if (draftPreview) {
    return t("desktopPet.replyPreview", { text: draftPreview });
  }
  if (message.status !== "awaiting" && (isThinking || message.status === "running")) {
    return t("desktopPet.status.thinking");
  }
  const preview = formatDesktopPetMessagePreview(message.preview);
  if (preview) {
    return preview;
  }
  if (message.status === "awaiting") {
    return t("desktopPet.status.awaitingConfirm");
  }
  if (message.status === "error") {
    return t("desktopPet.status.failed");
  }
  return t("desktopPet.status.ready");
}

type DesktopPetDragState = {
  pointerId: number;
  target: HTMLElement;
  lastScreenX: number;
};

type DesktopPetDragAnchorMode = "bubble" | null;

type ActiveDesktopPetSignature = {
  actionId: string;
  trigger: DesktopPetSignatureTrigger;
  variant: DesktopPetSignatureVariant;
  assetPath: string;
};

type DesktopPetStandardIdleAction = "jumping";

type ActiveDesktopPetStandardAction = {
  actionId: DesktopPetStandardIdleAction;
  durationMs: number;
};

const DESKTOP_PET_DONE_VISUAL_HOLD_MS = 2500;
const DESKTOP_PET_ERROR_VISUAL_HOLD_MS = 3000;
const DESKTOP_PET_IDLE_RANDOM_DELAY_MS = 25000;
const DESKTOP_PET_DRAG_DIRECTION_THRESHOLD_PX = 3;
const DESKTOP_PET_STANDARD_IDLE_ACTION_ID: DesktopPetStandardIdleAction = "jumping";
const DESKTOP_PET_REVIEW_TEXT_PATTERN = /review|检查|校验|验证|整理|复核|审阅/iu;

function rectContainsPoint(rect: DOMRect, x: number, y: number, margin = 0) {
  return x >= rect.left - margin &&
    x <= rect.right + margin &&
    y >= rect.top - margin &&
    y <= rect.bottom + margin;
}

function pointIntersectsElement(selector: string, x: number, y: number) {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).some((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rectContainsPoint(rect, x, y);
  });
}

function pointIntersectsVisiblePetArea(x: number, y: number, mask: DesktopPetAlphaMask | null) {
  const image = document.querySelector<HTMLElement>(".desktop-pet-image");
  return Boolean(image && pointIntersectsDesktopPetImage(image, mask, x, y)) ||
    pointIntersectsElement(".desktop-pet-unread-badge", x, y) ||
    pointIntersectsElement(".desktop-pet-task-panel", x, y);
}

function shouldShowReviewAction(previewPanel: DesktopPetPreviewPanel | null) {
  if (!previewPanel || previewPanel.status !== "running" || previewPanel.items.length === 0) {
    return false;
  }
  const latestItem = previewPanel.items[previewPanel.items.length - 1];
  if (latestItem.kind === "plan" || latestItem.kind === "artifact") {
    return true;
  }
  if (latestItem.kind !== "status") {
    return false;
  }
  return DESKTOP_PET_REVIEW_TEXT_PATTERN.test([
    latestItem.title,
    latestItem.text,
    latestItem.detailText ?? ""
  ].join(" "));
}

function getDesktopPetSpriteAssetBasePath(appearanceId: string) {
  return appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID
    ? "./desktop-pet"
    : `./desktop-pet/${appearanceId}`;
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
      assetPath: versionedDesktopPetAssetUrl(basePath, stateAsset.path, customAppearance?.assetVersion),
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
  return versionedDesktopPetAssetUrl(basePath, variantPath, appearance?.assetVersion);
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
  const { t } = useI18n();
  const location = useLocation();
  const isPanelWindow = new URLSearchParams(location.search).get("role") === "panel";
  const [petState, setPetState] = useState<DesktopPetState>(createFallbackDesktopPetState);
  const [isDragging, setIsDragging] = useState(false);
  const [dragDirection, setDragDirection] = useState<DesktopPetDragDirection>(null);
  const [dragAnchorMode, setDragAnchorMode] = useState<DesktopPetDragAnchorMode>(null);
  const [activeSignature, setActiveSignature] = useState<ActiveDesktopPetSignature | null>(null);
  const [activeStandardAction, setActiveStandardAction] = useState<ActiveDesktopPetStandardAction | null>(null);
  const [terminalVisualStatus, setTerminalVisualStatus] = useState<"done" | "error" | null>(null);
  const [isWidgetExpanded, setIsWidgetExpanded] = useState(false);
  const [replyingChatId, setReplyingChatId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [dismissingMessageIds, setDismissingMessageIds] = useState<readonly string[]>([]);
  const [dismissErrorChatId, setDismissErrorChatId] = useState<string | null>(null);
  // 回复发送后到后端状态回填前的乐观「思考中」占位（按 chatId），超时自动清除
  const [pendingReplyIds, setPendingReplyIds] = useState<readonly string[]>([]);
  const pendingReplyTimersRef = useRef<Map<string, number>>(new Map());
  const dragStateRef = useRef<DesktopPetDragState | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const signatureTimeoutRef = useRef<number | null>(null);
  const standardActionTimeoutRef = useRef<number | null>(null);
  const idleRandomTimeoutRef = useRef<number | null>(null);
  const terminalVisualTimeoutRef = useRef<number | null>(null);
  const appearanceIdRef = useRef(DEFAULT_DESKTOP_PET_APPEARANCE_ID);
  const draggingRef = useRef(false);
  const mouseInteractiveRef = useRef(true);
  const imageAlphaMaskRef = useRef<DesktopPetAlphaMask | null>(null);
  const mousePointRef = useRef<{ x: number; y: number } | null>(null);
  const activeSignatureRef = useRef<ActiveDesktopPetSignature | null>(activeSignature);
  const activeStandardActionRef = useRef<ActiveDesktopPetStandardAction | null>(activeStandardAction);
  const petStateRef = useRef<DesktopPetState>(petState);
  activeSignatureRef.current = activeSignature;
  activeStandardActionRef.current = activeStandardAction;
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
    setDragAnchorMode(null);
  }

  function clearSignatureTimer() {
    if (signatureTimeoutRef.current !== null) {
      window.clearTimeout(signatureTimeoutRef.current);
      signatureTimeoutRef.current = null;
    }
  }

  function clearStandardActionTimer() {
    if (standardActionTimeoutRef.current !== null) {
      window.clearTimeout(standardActionTimeoutRef.current);
      standardActionTimeoutRef.current = null;
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

  function stopStandardAction() {
    clearStandardActionTimer();
    setActiveStandardAction(null);
  }

  function setMouseInteractive(interactive: boolean) {
    if (isPanelWindow) {
      return;
    }
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
    mousePointRef.current = point;
    const interactive = draggingRef.current || pointIntersectsVisiblePetArea(point.x, point.y, imageAlphaMaskRef.current);
    setMouseInteractive(interactive);
  }

  function startSignature(actionId?: string, trigger: "manual" | "idle-random" = "manual") {
    if (draggingRef.current) {
      return;
    }
    const currentPetState = petStateRef.current;
    const currentStatus = normalizePetStatus(currentPetState.status);
    if (trigger !== "manual" && currentStatus !== "idle") {
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

  function startStandardIdleAction(actionId: DesktopPetStandardIdleAction = DESKTOP_PET_STANDARD_IDLE_ACTION_ID) {
    if (draggingRef.current || activeSignatureRef.current) {
      return;
    }
    const currentPetState = petStateRef.current;
    const currentStatus = normalizePetStatus(currentPetState.status);
    if (currentStatus !== "idle") {
      return;
    }
    const visual = resolveDesktopPetVisualAsset(currentPetState, appearanceIdRef.current, actionId);
    const durationMs = Math.max(100, Math.round(Number(visual.asset?.durationMs) || 1000));
    clearStandardActionTimer();
    clearIdleRandomTimer();
    setActiveStandardAction({
      actionId,
      durationMs
    });
    standardActionTimeoutRef.current = window.setTimeout(() => {
      standardActionTimeoutRef.current = null;
      setActiveStandardAction(null);
    }, durationMs);
  }

  function shouldInterruptSignature(nextState: DesktopPetState) {
    const currentSignature = activeSignatureRef.current;
    const nextStatus = normalizePetStatus(nextState.status);
    const nextMessagePreview = typeof nextState.messagePreview === "string" ? nextState.messagePreview.trim() : "";
    const hasMessages = Array.isArray(nextState.messages) && nextState.messages.length > 0;
    if (currentSignature?.trigger === "manual") {
      return false;
    }
    return nextStatus !== "idle" ||
      Math.max(0, Math.round(Number(nextState.runningTaskCount) || 0)) > 0 ||
      (Array.isArray(nextState.activeTasks) && nextState.activeTasks.length > 0) ||
      nextMessagePreview.length > 0 ||
      hasMessages ||
      Math.max(0, Math.round(Number(nextState.unreadCount) || 0)) > 0;
  }

  function shouldInterruptStandardAction(nextState: DesktopPetState) {
    const nextStatus = normalizePetStatus(nextState.status);
    const nextMessagePreview = typeof nextState.messagePreview === "string" ? nextState.messagePreview.trim() : "";
    return nextStatus !== "idle" ||
      Math.max(0, Math.round(Number(nextState.runningTaskCount) || 0)) > 0 ||
      (Array.isArray(nextState.activeTasks) && nextState.activeTasks.length > 0) ||
      (Array.isArray(nextState.messages) && nextState.messages.length > 0) ||
      nextMessagePreview.length > 0 ||
      Math.max(0, Math.round(Number(nextState.unreadCount) || 0)) > 0;
  }

  async function beginDrag() {
    try {
      const result = await window.electronAPI.desktopPet.beginDrag({});
      if (!result.ok) {
        resetLocalDragState();
        return false;
      }
      return true;
    } catch {
      resetLocalDragState();
      return false;
    }
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
    if (!isPanelWindow) {
      setMouseInteractive(false);
    }
    void window.electronAPI.desktopPet.getState().then((nextState) => {
      setPetState(nextState);
      if (!nextState.enabled || shouldInterruptSignature(nextState)) {
        stopSignature();
      }
      if (!nextState.enabled || shouldInterruptStandardAction(nextState)) {
        stopStandardAction();
      }
    }).catch(() => undefined);
    const dispose = window.electronAPI.desktopPet.onStateChanged((nextState) => {
      setPetState(nextState);
      if (!nextState.enabled || shouldInterruptSignature(nextState)) {
        stopSignature();
      }
      if (!nextState.enabled || shouldInterruptStandardAction(nextState)) {
        stopStandardAction();
      }
    });
    const disposeSignatureRequested = !isPanelWindow && typeof window.electronAPI.desktopPet.onSignatureRequested === "function"
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
        mousePointRef.current = null;
        setMouseInteractive(false);
      }
    };
    const handleWindowInactive = () => {
      if (!draggingRef.current) {
        setMouseInteractive(false);
      }
    };
    const handleMouseVisibilityChange = () => {
      if (document.hidden && !draggingRef.current) {
        mousePointRef.current = null;
        setMouseInteractive(false);
      }
    };
    if (!isPanelWindow) {
      window.addEventListener("mousemove", handleWindowMouseMove);
      window.addEventListener("mouseleave", handleWindowMouseLeave);
      window.addEventListener("blur", handleWindowInactive);
      document.addEventListener("visibilitychange", handleMouseVisibilityChange);
    }
    // The sprite can move away from a stationary cursor between mouse events.
    const hitTestTimer = !isPanelWindow ? window.setInterval(() => {
      if (mousePointRef.current && !draggingRef.current) {
        updateMouseInteractivityFromPoint(mousePointRef.current);
      }
    }, 50) : null;
    return () => {
      if (hitTestTimer !== null) {
        window.clearInterval(hitTestTimer);
      }
      if (!isPanelWindow) {
        window.removeEventListener("mousemove", handleWindowMouseMove);
        window.removeEventListener("mouseleave", handleWindowMouseLeave);
        window.removeEventListener("blur", handleWindowInactive);
        document.removeEventListener("visibilitychange", handleMouseVisibilityChange);
        setMouseInteractive(false);
      }
      dispose();
      disposeSignatureRequested();
      clearSignatureTimer();
      clearStandardActionTimer();
      clearIdleRandomTimer();
      clearTerminalVisualTimer();
      resetLocalDragState();
      if (!isPanelWindow) {
        void endDrag();
      }
      document.body.classList.remove("desktop-pet-body");
    };
  }, [isPanelWindow]);

  useEffect(() => {
    const mode = petState.windowMode ?? "base";
    if (isPanelWindow || mode === "base") {
      setIsWidgetExpanded(mode !== "base");
    }
  }, [isPanelWindow, petState.windowMode]);

  useEffect(() => {
    const timers = pendingReplyTimersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
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
  const petMessages = Array.isArray(petState.messages) ? petState.messages : [];
  const visibleMessages = getVisibleDesktopPetMessages(petMessages);
  const hasHistoryMessages = visibleMessages.length > 0;
  const hasExpandedOverview = !isDragging && isWidgetExpanded && hasHistoryMessages;
  const showStatusPanel = isPanelWindow && hasExpandedOverview;
  const previewPanel = petState.previewPanel?.visible ? petState.previewPanel : null;
  const hasMessageReaction = displayStatus === "idle" && !isDragging && (messagePreview.length > 0 || unreadCount > 0);
  const isReviewing = displayStatus === "running" && shouldShowReviewAction(previewPanel);
  const stateDragDirection: DesktopPetDragDirection =
    petState.dragDirection === "left" || petState.dragDirection === "right"
      ? petState.dragDirection
      : null;
  const effectiveDragDirection: DesktopPetDragDirection = isDragging
    ? stateDragDirection ?? dragDirection
    : null;
  const hasDragMovement = isDragging && (Boolean(petState.dragMoved) || Boolean(effectiveDragDirection));
  const appearanceId = useMemo(
    () => normalizeDesktopPetAppearanceId(petState.appearanceId),
    [petState.appearanceId]
  );
  const signature = resolveDesktopPetSignatureActions(appearanceId, petState.signature);
  const visualStatus: DesktopPetVisualStatus = deriveDesktopPetVisualStatus({
    displayStatus,
    isDragging,
    dragDirection: effectiveDragDirection,
    hasDragMovement,
    activeStandardAction: activeStandardAction?.actionId ?? null,
    hasActiveSignature: Boolean(activeSignature),
    activeSignatureTrigger: activeSignature?.trigger ?? null,
    isReviewing
  });
  const visualAsset = useMemo(
    () => resolveDesktopPetVisualAsset(petState, appearanceId, visualStatus),
    [appearanceId, petState, visualStatus]
  );
  const shouldShowSignatureSpriteAnimation = visualStatus === "signature" && Boolean(activeSignature);
  const shouldShowStateSpriteAnimation = !shouldShowSignatureSpriteAnimation && isDesktopPetAnimatedAsset(visualAsset.asset);
  const stateAnimationFrameCount = Math.max(1, Math.round(Number(visualAsset.asset?.frameCount) || 1));
  const stateAnimationDurationMs = Math.max(100, Math.round(Number(visualAsset.asset?.durationMs) || 0));
  const hitTestAssetPath = shouldShowSignatureSpriteAnimation && activeSignature
    ? activeSignature.assetPath
    : visualAsset.assetPath;
  const hitTestFrameCount = shouldShowSignatureSpriteAnimation && activeSignature
    ? activeSignature.variant.frameCount
    : shouldShowStateSpriteAnimation ? stateAnimationFrameCount : 1;
  const hitTestIsSprite = shouldShowSignatureSpriteAnimation || shouldShowStateSpriteAnimation;
  useEffect(() => {
    if (isPanelWindow) {
      return;
    }
    let cancelled = false;
    imageAlphaMaskRef.current = null;
    void loadDesktopPetAlphaMask(hitTestAssetPath, hitTestFrameCount, hitTestIsSprite).then((mask) => {
      if (!cancelled) {
        imageAlphaMaskRef.current = mask;
        if (mousePointRef.current) {
          updateMouseInteractivityFromPoint(mousePointRef.current);
        }
      }
    });
    return () => { cancelled = true; };
  }, [isPanelWindow, hitTestAssetPath, hitTestFrameCount, hitTestIsSprite]);
  const rootStyle = {
    ...(!isPanelWindow && petState.bodyOffset ? {
      "--desktop-pet-button-left": `${petState.bodyOffset.x - 18}px`,
      "--desktop-pet-button-top": `${petState.bodyOffset.y - 16}px`
    } : {}),
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
          "--desktop-pet-idle-steps": String(Math.max(1, stateAnimationFrameCount - 1)),
          "--desktop-pet-idle-end": `${-96 * (stateAnimationFrameCount - 1)}px`,
          "--desktop-pet-state-loop-count": visualAsset.asset?.loop === false ? "1" : "infinite"
        }
      : {})
  } as CSSProperties;
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
      stopStandardAction();
    }
  }, [isDragging]);
  useEffect(() => {
    clearIdleRandomTimer();
    if (
      displayStatus !== "idle" ||
      isDragging ||
      activeSignature ||
      activeStandardAction ||
      hasMessageReaction ||
      hasHistoryMessages
    ) {
      return undefined;
    }
    idleRandomTimeoutRef.current = window.setTimeout(() => {
      idleRandomTimeoutRef.current = null;
      if (signature.some((action) => action.trigger.includes("idle-random")) && Math.random() < 0.2) {
        startSignature(undefined, "idle-random");
        return;
      }
      startStandardIdleAction();
    }, DESKTOP_PET_IDLE_RANDOM_DELAY_MS);
    return clearIdleRandomTimer;
  }, [
    displayStatus,
    isDragging,
    activeSignature,
    activeStandardAction,
    hasMessageReaction,
    hasHistoryMessages,
    signature,
    appearanceId
  ]);
  const assetPath = visualAsset.assetPath;
  const unreadBadgeCounts = resolveDesktopPetUnreadBadgeCounts({
    navigationAttention: petState.navigationAttention
  });
  const unreadBadgeItems = [
    ...(unreadBadgeCounts.pendingCount > 0
      ? [{
          key: "awaiting" as const,
          tone: "awaiting" as const,
          count: unreadBadgeCounts.pendingCount,
          ariaLabel: t("desktopPet.panel.expandAwaiting", { count: unreadBadgeCounts.pendingCount })
        }]
      : []),
    ...(unreadBadgeCounts.unreadCount > 0
      ? [{
          key: "unread" as const,
          tone: "unread" as const,
          count: unreadBadgeCounts.unreadCount,
          ariaLabel: t("desktopPet.unread", { count: unreadBadgeCounts.unreadCount })
        }]
      : []),
  ];
  // The pet and its panel are separate windows; expanding the panel must not
  // remove the pet's only visible status/count affordance.
  const showUnreadBadges = unreadBadgeItems.length > 0;
  const activeDragAnchorMode = isDragging ? dragAnchorMode : null;
  const hasBubbleAnchor = hasExpandedOverview || activeDragAnchorMode === "bubble";
  const desiredWindowMode: DesktopPetWindowMode = isPanelWindow
    ? "base"
    : isDragging
      ? activeDragAnchorMode ?? "base"
      : hasExpandedOverview ? "bubble" : "base";

  useEffect(() => {
    if (isPanelWindow) {
      return;
    }
    if (typeof window.electronAPI.desktopPet.setWindowMode !== "function") {
      return;
    }
    void window.electronAPI.desktopPet.setWindowMode(desiredWindowMode).catch(() => undefined);
  }, [desiredWindowMode, isPanelWindow]);

  function resolveCurrentDragAnchorMode(): DesktopPetDragAnchorMode {
    return hasBubbleAnchor ? "bubble" : null;
  }

  function stopPanelClick(event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
  }

  function handleTaskPointerDown(event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function toggleWidgetExpanded(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (isPanelWindow) {
      void window.electronAPI.desktopPet.setWindowMode("base").catch(() => undefined);
      return;
    }
    setIsWidgetExpanded((current) => !current);
  }

  function handleUnreadBadgePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    setMouseInteractive(true);
  }

  function handleUnreadBadgeClick(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (hasHistoryMessages) {
      setIsWidgetExpanded(true);
      return;
    }
    void window.electronAPI.desktopPet.openAssistant();
  }

  function handleReplyToggle(chatId: string) {
    setReplyText("");
    setReplyingChatId((prev) => (prev === chatId ? null : chatId));
  }

  function handleReplyCancel() {
    setReplyingChatId(null);
    setReplyText("");
  }

  function markReplyPending(chatId: string) {
    setPendingReplyIds((prev) => (prev.includes(chatId) ? prev : [...prev, chatId]));
    const timers = pendingReplyTimersRef.current;
    const existing = timers.get(chatId);
    if (existing) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      timers.delete(chatId);
      setPendingReplyIds((prev) => prev.filter((id) => id !== chatId));
    }, 2500);
    timers.set(chatId, timer);
  }

  function handleReplySubmit(message: DesktopPetMessageItem) {
    const text = replyText.trim();
    if (!text || message.status === "awaiting") {
      return;
    }
    void window.electronAPI.desktopPet
      .replyMessage({ chatId: message.chatId, agentKey: message.agentKey, message: text })
      .catch(() => undefined);
    markReplyPending(message.chatId);
    setReplyingChatId(null);
    setReplyText("");
  }

  function handleReplyToggleClick(event: ReactMouseEvent<HTMLButtonElement>, chatId: string) {
    stopPanelClick(event);
    handleReplyToggle(chatId);
  }

  function handleReplyCancelClick(event: ReactMouseEvent<HTMLButtonElement>) {
    stopPanelClick(event);
    handleReplyCancel();
  }

  function handleReplySubmitClick(event: ReactMouseEvent<HTMLButtonElement>, message: DesktopPetMessageItem) {
    stopPanelClick(event);
    handleReplySubmit(message);
  }

  async function handleDismissMessage(message: DesktopPetMessageItem) {
    if (dismissingMessageIds.includes(message.chatId)) return;
    setDismissingMessageIds((current) => [...current, message.chatId]);
    setDismissErrorChatId(null);
    try {
      const result = await window.electronAPI.desktopPet.dismissMessage({
        chatId: message.chatId, runId: message.runId, updatedAt: message.updatedAt
      });
      if (!result.ok) {
        setDismissErrorChatId(message.chatId);
        return;
      }
      if (replyingChatId === message.chatId) {
        setReplyingChatId(null);
      }

    } catch {
      setDismissErrorChatId(message.chatId);
    } finally {
      setDismissingMessageIds((current) => current.filter((id) => id !== message.chatId));
    }
  }

  function handleDismissMessageClick(event: ReactMouseEvent<HTMLButtonElement>, message: DesktopPetMessageItem) {
    stopPanelClick(event);
    void handleDismissMessage(message);
  }

  function handleOpenMessageClick(event: ReactMouseEvent<HTMLButtonElement>, message: DesktopPetMessageItem) {
    stopPanelClick(event);
    void window.electronAPI.desktopPet
      .openTaskChat({
        agentKey: message.agentKey,
        chatId: message.chatId
      })
      .catch(() => undefined);
  }

  async function finishDrag(pointerId: number | null, openAppIfClick: boolean) {
    const dragState = dragStateRef.current;
    if (!dragState || (pointerId !== null && dragState.pointerId !== pointerId)) {
      return;
    }
    resetLocalDragState();
    const result = await endDrag();
    if (openAppIfClick && !result.moved) {
      if (!isWidgetExpanded && hasHistoryMessages) {
        setIsWidgetExpanded(true);
        return;
      }
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
    setDragAnchorMode(resolveCurrentDragAnchorMode());
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
    event.preventDefault();

    const pointerId = event.pointerId;
    void beginDrag().then((started) => {
      const currentDragState = dragStateRef.current;
      if (!started || !currentDragState || currentDragState.pointerId !== pointerId) {
        return;
      }
      setIsDragging(true);
    });
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
    const handleLostPointerCapture = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.buttons !== 0) {
        return;
      }
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

  return (
    <main
      className={[
        "desktop-pet-root",
        isPanelWindow ? "is-panel-window" : "is-pet-window",
        `is-${visualStatus}`,
        `is-appearance-${appearanceId}`,
          shouldShowSignatureSpriteAnimation ? "has-signature-animation" : "",
          shouldShowStateSpriteAnimation ? "has-state-animation" : "",
          hasBubbleAnchor ? "has-bubble" : "",
        isWidgetExpanded ? "is-widget-expanded" : "is-widget-collapsed",
	        petState.edgeDock?.includes("top") ? "is-edge-dock-top" : "",
	        petState.edgeDock?.includes("right") ? "is-edge-dock-right" : "",
	        petState.edgeDock?.includes("bottom") ? "is-edge-dock-bottom" : "",
	        petState.edgeDock?.includes("left") ? "is-edge-dock-left" : "",
        petState.panelPlacement ? `is-panel-placement-${petState.panelPlacement}` : "",
        isDragging ? "is-dragging" : "",
        visualStatus === "moving-left" && effectiveDragDirection === "right" && (visualAsset.asset?.mirror ?? true) ? "is-drag-mirror" : ""
      ].filter(Boolean).join(" ")}
      style={rootStyle}
      aria-label={t("desktopPet.ariaLabel", { appName: PRODUCT_NAME })}
    >
      <div
        className="desktop-pet-hitbox"
        onPointerDown={isPanelWindow ? undefined : handlePointerDown}
        onPointerUp={isPanelWindow ? undefined : handlePointerUp}
        onPointerCancel={isPanelWindow ? undefined : handlePointerCancel}
      >
        <span className="desktop-pet-stage" aria-hidden="true" />
        {showStatusPanel ? (
          <section
            className={[
              "desktop-pet-task-panel",
              "desktop-pet-status-panel",
              "is-message",
              isWidgetExpanded ? "is-expanded" : "is-collapsed"
            ].join(" ")}
            aria-live="polite"
            onPointerDown={handleTaskPointerDown}
          >
            <div className="desktop-pet-task-head">
              <span className="desktop-pet-task-head-copy">
                <strong>
                  <MessageOutlined aria-hidden="true" />{t("desktopPet.panel.overview")}
                </strong>
                <span className="desktop-pet-overview-counts">
                  <span className="desktop-pet-message-count is-unread">{t("desktopPet.panel.unreadCount", { count: unreadBadgeCounts.unreadCount })}</span>
                  <span className="desktop-pet-message-count is-awaiting">{t("desktopPet.panel.awaitingCount", { count: unreadBadgeCounts.pendingCount })}</span>
                </span>
              </span>
              <button
                type="button"
                className="desktop-pet-task-head-action"
                aria-label={t("desktopPet.message.collapse")}
                aria-expanded={isWidgetExpanded}
                onClick={toggleWidgetExpanded}
              >
                {isWidgetExpanded ? (
                  <UpOutlined aria-hidden="true" />
                ) : (
                  <DownOutlined aria-hidden="true" />
                )}
              </button>
            </div>
            {isWidgetExpanded ? (
              <>
                <div className={`desktop-pet-message-stack${replyingChatId ? " is-replying" : ""}`}>
                  {visibleMessages.map((message) => {
                      const isThinking =
                        message.status !== "awaiting" && (message.status === "running" || pendingReplyIds.includes(message.chatId));
                      const cardStatus = isThinking ? "running" : message.status;
                      const canReply = message.status !== "awaiting";
                      const isReplying = canReply && replyingChatId === message.chatId;
                      const replyDraftPreview = isReplying ? replyText : "";
                      const previewText = formatMessageCardPreview(message, isThinking, replyDraftPreview, t);
                      return (
                      <div
                        key={message.id}
                        className={`desktop-pet-message-card is-${cardStatus}${message.unread ? " is-unread" : ""}${canReply ? " can-reply" : ""}${isReplying ? " is-replying" : ""}`}
                        data-chat-id={message.chatId}
                        onPointerDown={handleTaskPointerDown}
                      >
                        <button
                          type="button"
                          className="desktop-pet-message-main"
                          onClick={(event) => handleOpenMessageClick(event, message)}
                        >
                          <span className="desktop-pet-message-copy">
                            {dismissErrorChatId === message.chatId ? (
                              <span role="alert">{t("desktopPet.message.closeFailed")}</span>
                            ) : null}
                            <span className="desktop-pet-message-title-line">
                              <strong>{message.title}</strong>
                              {message.status === "awaiting" ? (
                                <span
                                  className="desktop-pet-message-status is-awaiting"
                                  aria-label={t("desktopPet.status.awaiting")}
                                >
                                  <ClockCircleOutlined aria-hidden="true" />
                                </span>
                              ) : message.unread ? (
                                <span
                                  className="desktop-pet-message-status is-unread"
                                  aria-label={t("desktopPet.unread", { count: 1 })}
                                />
                              ) : null}
                            </span>
                            <span className="desktop-pet-message-preview">{previewText}</span>
                          </span>
                        </button>
                        <div className="desktop-pet-message-meta">
                          {canReply && !isReplying ? (
                            <button
                              type="button"
                              className="desktop-pet-message-reply"
                              aria-label={t("desktopPet.reply.action")}
                              title={t("desktopPet.reply.action")}
                              onClick={(event) => handleReplyToggleClick(event, message.chatId)}
                            >
                              <EnterOutlined aria-hidden="true" />
                            </button>
                          ) : null}
                          {canReply ? (
                          <button
                            type="button"
                            className="desktop-pet-message-dismiss"
                            aria-label={t("desktopPet.message.close")}
                            title={t("desktopPet.message.close")}
                            disabled={dismissingMessageIds.includes(message.chatId)}
                            onClick={(event) => handleDismissMessageClick(event, message)}
                          >
                            <CloseOutlined aria-hidden="true" />
                          </button>
                          ) : null}
                        </div>
                        {isReplying ? (
                          <div
                            className="desktop-pet-message-reply-box"
                            onPointerDown={handleTaskPointerDown}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <input
                              className="desktop-pet-message-reply-input"
                              value={replyText}
                              placeholder={t("desktopPet.reply.placeholder")}
                              autoFocus
                              onFocus={() => setMouseInteractive(true)}
                              onChange={(event) => setReplyText(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  handleReplySubmit(message);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  handleReplyCancel();
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="desktop-pet-message-reply-cancel"
                              aria-label={t("desktopPet.reply.cancel")}
                              onClick={handleReplyCancelClick}
                            >
                              {t("desktopPet.reply.cancel")}
                            </button>
                            <button
                              type="button"
                              className="desktop-pet-message-reply-send"
                              disabled={replyText.trim().length === 0}
                              onClick={(event) => handleReplySubmitClick(event, message)}
                            >
                              {t("desktopPet.reply.send")}
                            </button>
                          </div>
                        ) : null}
                      </div>
                      );
                    })}
                </div>
              </>
            ) : null}
          </section>
        ) : null}
            {!isPanelWindow ? (
            <button
              type="button"
              className="desktop-pet-button"
              aria-label={t("desktopPet.openApp", { appName: PRODUCT_NAME })}
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
        </button>
            ) : null}
        {!isPanelWindow && showUnreadBadges ? (
          <div
            className={`desktop-pet-unread-badges ${unreadBadgeItems.length > 1 ? "has-multiple" : "has-single"}`}
            role="group"
            aria-label={t("desktopPet.message.status")}
          >
            {unreadBadgeItems.map((badge) => (
              <button
                type="button"
                key={badge.key}
                className={`desktop-pet-unread-badge is-${badge.tone} is-${badge.key}`}
                aria-label={badge.ariaLabel}
                title={badge.ariaLabel}
                onPointerDown={handleUnreadBadgePointerDown}
                onClick={handleUnreadBadgeClick}
              >
                {badge.count > 99
                  ? "99+"
                  : String(badge.count)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </main>
  );
}
