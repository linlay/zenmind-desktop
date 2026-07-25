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
  DesktopPetPreviewItemStatus,
  DesktopPetSignatureAction,
  DesktopPetSignatureTrigger,
  DesktopPetSignatureVariant,
  DesktopPetState,
  DesktopPetStateAsset,
  DesktopPetStatus,
  DesktopPetTaskItem,
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
  resolveDesktopPetSignatureActions
} from "../../../shared/desktop-pet";
import {
  deriveDesktopPetVisualStatus,
  resolveDesktopPetUnreadBadgeCounts,
  type DesktopPetDragDirection,
  type DesktopPetVisualStatus
} from "../../../shared/desktop-pet-visual";
import { BRAND_ID, PRODUCT_NAME } from "../../../shared/brand";
import { useI18n } from "../../i18n/useI18n";

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

function formatPetHint(status: DesktopPetStatus, t: ReturnType<typeof useI18n>["t"]) {
  if (status === "awaiting") {
    return t("desktopPet.status.awaitingConfirm");
  }
  if (status === "running") {
    return t("desktopPet.status.thinking");
  }
  if (status === "done") {
    return t("desktopPet.doneFallback");
  }
  if (status === "error") {
    return t("desktopPet.status.error");
  }
  return "";
}

function formatPreviewStatus(status: DesktopPetPreviewItemStatus, t: ReturnType<typeof useI18n>["t"]) {
  switch (status) {
    case "running":
      return t("desktopPet.preview.running");
    case "waiting":
      return t("desktopPet.preview.waiting");
    case "error":
      return t("desktopPet.preview.failed");
    case "cancelled":
      return t("desktopPet.preview.cancelled");
    case "success":
    case "done":
      return t("desktopPet.preview.done");
    default:
      return t("desktopPet.preview.pending");
  }
}

function mapDesktopPetPreviewBadgeStatus(status: string): string {
  switch (status) {
    case "success":
    case "done":
      return "done";
    case "running":
      return "running";
    case "waiting":
      return "awaiting";
    case "error":
      return "error";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "idle";
  }
}

function formatTaskStatus(task: DesktopPetTaskItem, t: ReturnType<typeof useI18n>["t"]) {
  if (task.status === "done") {
    return t("desktopPet.status.done");
  }
  if (task.status !== "awaiting") {
    return t("desktopPet.task.running");
  }
  switch (task.awaitingMode) {
    case "planning":
      return t("desktopPet.task.awaitingPlanning");
    case "question":
      return t("desktopPet.task.awaitingQuestion");
    case "approval":
      return t("desktopPet.task.awaitingApproval");
    case "form":
      return t("desktopPet.task.awaitingForm");
    default:
      return t("desktopPet.task.awaitingConfirm");
  }
}

const DESKTOP_PET_INLINE_PREVIEW_MAX_LENGTH = 30;
const DESKTOP_PET_TASK_VISIBLE_LIMIT = 2;

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

function formatTaskPreview(task: DesktopPetTaskItem, t: ReturnType<typeof useI18n>["t"]) {
  const preview = task.preview.trim();
  return preview || formatTaskStatus(task, t);
}

function getDesktopPetMessageCacheKey(message: DesktopPetMessageItem) {
  return message.chatId || message.id;
}

function getDesktopPetMessageVersionKey(message: DesktopPetMessageItem) {
  return [
    message.chatId,
    message.runId ?? "",
    message.updatedAt
  ].join("\u0000");
}

function mergeDesktopPetMessageLists(
  primaryMessages: readonly DesktopPetMessageItem[],
  fallbackMessages: readonly DesktopPetMessageItem[]
) {
  const merged: DesktopPetMessageItem[] = [];
  const seenKeys = new Set<string>();
  for (const message of [...primaryMessages, ...fallbackMessages]) {
    const key = getDesktopPetMessageCacheKey(message);
    if (!key || seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    merged.push(message);
  }
  return merged;
}

function getVisibleDesktopPetMessages(input: {
  messages: readonly DesktopPetMessageItem[];
  cachedMessages: readonly DesktopPetMessageItem[];
  previewHistoryMessage: DesktopPetMessageItem | null;
  dismissedKeys: ReadonlySet<string>;
}) {
  const mergedMessages = mergeDesktopPetMessageLists(input.messages, input.cachedMessages);
  const withPreview = input.previewHistoryMessage
    ? mergeDesktopPetMessageLists(mergedMessages, [input.previewHistoryMessage])
    : mergedMessages;
  return withPreview.filter((message) => !input.dismissedKeys.has(getDesktopPetMessageVersionKey(message)));
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
  if (isThinking || message.status === "running") {
    return t("desktopPet.status.thinking");
  }
  const preview = message.preview.trim();
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

function formatStatusPanelTitle(status: DesktopPetStatus, hasMessageReaction: boolean, t: DesktopPetTranslate) {
  if (hasMessageReaction) {
    return t("desktopPet.newMessage");
  }
  if (status === "idle") {
    return t("desktopPet.status.idle");
  }
  if (status === "running") {
    return t("desktopPet.status.processing");
  }
  if (status === "awaiting") {
    return t("desktopPet.status.awaiting");
  }
  if (status === "done") {
    return t("desktopPet.status.done");
  }
  return t("desktopPet.status.error");
}

function formatStatusPanelPreview(
  status: DesktopPetStatus,
  hasMessageReaction: boolean,
  message: string,
  hint: string,
  t: DesktopPetTranslate
) {
  if (hasMessageReaction) {
    return message || t("desktopPet.newMessage");
  }
  if (hint) {
    return hint;
  }
  if (status === "idle") {
    return t("desktopPet.task.none");
  }
  if (status === "running") {
    return t("desktopPet.task.backgroundRunning");
  }
  if (status === "awaiting") {
    return t("desktopPet.task.awaitingPlanningConfirm");
  }
  if (status === "done") {
    return t("desktopPet.task.completed");
  }
  return t("desktopPet.task.openDesktop");
}

type DesktopPetPanelStatus = DesktopPetStatus | "message";

function normalizePreviewPanelStatus(status: DesktopPetPreviewPanel["status"]): DesktopPetStatus {
  switch (status) {
    case "done":
      return "done";
    case "error":
    case "stopped":
      return "error";
    case "waiting":
      return "awaiting";
    case "running":
    default:
      return "running";
  }
}

function formatPreviewPanelHeaderTitle(panel: DesktopPetPreviewPanel, t: DesktopPetTranslate) {
  const status = normalizePreviewPanelStatus(panel.status);
  if (status === "done") {
    return t("desktopPet.status.done");
  }
  if (status === "error") {
    return t("desktopPet.status.stopped");
  }
  if (status === "awaiting") {
    return t("desktopPet.status.awaiting");
  }
  return t("desktopPet.preview.running");
}

function formatPreviewPanelSummary(panel: DesktopPetPreviewPanel, t: DesktopPetTranslate) {
  const summary = panel.summary.trim();
  if (summary) {
    return formatInlinePetPreview(summary);
  }
  const status = normalizePreviewPanelStatus(panel.status);
  if (status === "done") {
    return panel.artifactCount > 0
      ? t("desktopPet.preview.completedArtifacts", { count: panel.artifactCount })
      : t("desktopPet.status.done");
  }
  if (status === "error") {
    return t("desktopPet.status.stopped");
  }
  if (status === "awaiting") {
    return panel.awaiting?.title.trim() || t("desktopPet.status.awaiting");
  }
  return t("desktopPet.task.thinking");
}

type DesktopPetDragState = {
  pointerId: number;
  target: HTMLElement;
  lastScreenX: number;
};

type DesktopPetDragAnchorMode =
  | "bubble"
  | "preview-expanded"
  | "task-list"
  | "task-list-compact"
  | null;

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
const DESKTOP_PET_IMAGE_HIT_MARGIN = 8;
const DESKTOP_PET_STANDARD_IDLE_ACTION_ID: DesktopPetStandardIdleAction = "jumping";
const DESKTOP_PET_REVIEW_TEXT_PATTERN = /review|检查|校验|验证|整理|复核|审阅/iu;

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
    pointIntersectsElement(".desktop-pet-unread-badges", x, y, 4) ||
    pointIntersectsElement(".desktop-pet-speech", x, y) ||
    pointIntersectsElement(".desktop-pet-task-panel", x, y) ||
    pointIntersectsElement(".desktop-pet-preview", x, y);
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
  const [messageCache, setMessageCache] = useState<readonly DesktopPetMessageItem[]>([]);
  const [dismissedMessageKeys, setDismissedMessageKeys] = useState<readonly string[]>([]);
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
    const interactive = draggingRef.current || pointIntersectsVisiblePetArea(point.x, point.y);
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

  function rememberMessagesFromState(nextState: DesktopPetState) {
    const nextMessages = Array.isArray(nextState.messages) ? nextState.messages : [];
    if (nextMessages.length === 0) {
      return;
    }
    setMessageCache((current) => mergeDesktopPetMessageLists(nextMessages, current));
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
      rememberMessagesFromState(nextState);
      if (!nextState.enabled || shouldInterruptSignature(nextState)) {
        stopSignature();
      }
      if (!nextState.enabled || shouldInterruptStandardAction(nextState)) {
        stopStandardAction();
      }
    }).catch(() => undefined);
    const dispose = window.electronAPI.desktopPet.onStateChanged((nextState) => {
      setPetState(nextState);
      rememberMessagesFromState(nextState);
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
        setMouseInteractive(false);
      }
    };
    if (!isPanelWindow) {
      window.addEventListener("mousemove", handleWindowMouseMove);
      window.addEventListener("mouseleave", handleWindowMouseLeave);
      window.addEventListener("blur", handleWindowInactive);
      document.addEventListener("visibilitychange", handleMouseVisibilityChange);
    }
    return () => {
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
  const activeTasks = Array.isArray(petState.activeTasks) ? petState.activeTasks : [];
  const visibleTasks = activeTasks.slice(0, DESKTOP_PET_TASK_VISIBLE_LIMIT);
  const hiddenTaskCount = Math.max(0, activeTasks.length - visibleTasks.length);
  const petMessages = Array.isArray(petState.messages) ? petState.messages : [];
  const dismissedMessageKeySet = new Set(dismissedMessageKeys);
  const runningTaskCount = activeTasks.filter((task) => task.status === "running").length;
  const awaitingTaskCount = activeTasks.filter((task) => task.status === "awaiting").length;
  const completedTaskCount = activeTasks.filter((task) => task.status === "done").length;
  const previewPanel = petState.previewPanel?.visible ? petState.previewPanel : null;
  const isDonePreviewPanel = previewPanel?.status === "done";
  const previewHistoryMessage: DesktopPetMessageItem | null =
    isDonePreviewPanel && previewPanel?.chatId
      ? {
          id: `preview:${previewPanel.runId}:${previewPanel.chatId}`,
          chatId: previewPanel.chatId,
          runId: previewPanel.runId,
          agentKey: petState.boundAgentKey,
          agentDisplayName: petState.agentDisplayName || petState.boundAgentKey,
          title: formatPreviewPanelHeaderTitle(previewPanel, t),
          preview: formatPreviewPanelSummary(previewPanel, t),
          status: "done",
          unread: false,
          updatedAt: previewPanel.updatedAt
        }
      : null;
  const previewHistoryMessageCacheKey = previewHistoryMessage
    ? [
        getDesktopPetMessageVersionKey(previewHistoryMessage),
        previewHistoryMessage.title,
        previewHistoryMessage.preview,
        previewHistoryMessage.status
      ].join("\u0001")
    : "";
  useEffect(() => {
    if (!previewHistoryMessage) {
      return;
    }
    setMessageCache((current) => mergeDesktopPetMessageLists([previewHistoryMessage], current));
  }, [previewHistoryMessageCacheKey]);
  const visibleMessages = getVisibleDesktopPetMessages({
    messages: petMessages,
    cachedMessages: messageCache,
    previewHistoryMessage,
    dismissedKeys: dismissedMessageKeySet
  });
  const hasHistoryMessages = visibleMessages.length > 0;
  const hasCollapsedPreviewPanel = Boolean(previewPanel && !previewPanel.expanded && !isDonePreviewPanel && !hasHistoryMessages);
  const hasTaskPanelContent = activeTasks.length > 0 && !hasHistoryMessages;
  const shouldShowTaskPanel = !isDragging && isWidgetExpanded && hasTaskPanelContent;
  const showTaskPanel = isPanelWindow && shouldShowTaskPanel;
  const useCompactTaskPanel = shouldShowTaskPanel && activeTasks.length <= DESKTOP_PET_TASK_VISIBLE_LIMIT;
  const shouldShowPreviewPanel = !isDragging && isWidgetExpanded && !hasHistoryMessages && !shouldShowTaskPanel && Boolean(previewPanel && previewPanel.expanded && !isDonePreviewPanel);
  const showPreviewPanel = isPanelWindow && shouldShowPreviewPanel;
  const previewPanelSummary = previewPanel ? formatPreviewPanelSummary(previewPanel, t) : "";
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
  const hasSignatureAura = BRAND_ID === "cutej";
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
      hasHistoryMessages ||
      shouldShowTaskPanel ||
      shouldShowPreviewPanel
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
    shouldShowTaskPanel,
    shouldShowPreviewPanel,
    signature,
    appearanceId
  ]);
  const assetPath = visualAsset.assetPath;
  const statusBubbleText = displayStatus === "idle"
    ? ""
    : petState.hint.trim() || formatPetHint(displayStatus, t);
  const bubbleText = hasMessageReaction
    ? messagePreview || t("desktopPet.newMessage")
    : statusBubbleText;
  const showMessageBadgeOnly = hasMessageReaction && !hasHistoryMessages && !shouldShowTaskPanel && !shouldShowPreviewPanel && !isDonePreviewPanel;
  const canShowStatusPanel =
    !isDragging &&
    !shouldShowTaskPanel &&
    !shouldShowPreviewPanel &&
    !hasCollapsedPreviewPanel &&
    !showMessageBadgeOnly &&
    (hasHistoryMessages || displayStatus !== "idle");
  const shouldShowStatusPanel = canShowStatusPanel && isWidgetExpanded;
  const showStatusPanel = isPanelWindow && shouldShowStatusPanel;
  const unreadBadgeCounts = resolveDesktopPetUnreadBadgeCounts({
    displayStatus,
    unreadCount,
    visibleMessages,
    messages: petMessages,
    activeTasks
  });
  const unreadBadgeItems = [
    ...(unreadBadgeCounts.awaitingCount > 0
      ? [{
          key: "awaiting" as const,
          tone: "awaiting" as const,
          count: unreadBadgeCounts.awaitingCount,
          ariaLabel: t("desktopPet.panel.expandAwaiting", { count: unreadBadgeCounts.awaitingCount })
        }]
      : []),
    ...(unreadBadgeCounts.completedCount > 0
      ? [{
          key: "completed" as const,
          tone: "message" as const,
          count: unreadBadgeCounts.completedCount,
          ariaLabel: hasHistoryMessages
            ? t("desktopPet.panel.expandCompleted", { count: unreadBadgeCounts.completedCount })
            : t("desktopPet.unread", { count: unreadBadgeCounts.completedCount })
        }]
      : [])
  ];
  const showUnreadBadges = unreadBadgeItems.length > 0 && !shouldShowTaskPanel && !shouldShowPreviewPanel && !shouldShowStatusPanel;
  const previewTitle = previewPanel ? formatInlinePetPreview(previewPanel.title) : "";
  const previewSummary = previewPanel && previewPanel.expanded
    ? formatInlinePetPreview(previewPanel.summary)
    : "";
  const showPreviewSummary = shouldShowSecondaryPreview(previewTitle, previewSummary);
  const taskPanelTitle = petState.agentDisplayName?.trim() || t("desktopPet.panel.defaultAgent");
  const taskSummaryText = t("desktopPet.panel.taskSummary", {
    running: runningTaskCount,
    awaiting: awaitingTaskCount,
    completed: completedTaskCount
  });
  const statusPanelStatus: DesktopPetPanelStatus = hasMessageReaction ? "message" : displayStatus;
  const statusPanelTitle = hasHistoryMessages
    ? t("desktopPet.panel.overview")
    : formatStatusPanelTitle(displayStatus, hasMessageReaction, t);
  const statusPanelPreview = formatStatusPanelPreview(displayStatus, hasMessageReaction, bubbleText, petState.hint.trim(), t);
  const activeDragAnchorMode = isDragging ? dragAnchorMode : null;
  const hasTaskPanelAnchor =
    showTaskPanel ||
    activeDragAnchorMode === "task-list" ||
    activeDragAnchorMode === "task-list-compact";
  const hasCompactTaskPanelAnchor =
    (isPanelWindow && useCompactTaskPanel) ||
    activeDragAnchorMode === "task-list-compact";
  const hasPreviewExpandedAnchor =
    showPreviewPanel ||
    activeDragAnchorMode === "preview-expanded";
  const hasBubbleAnchor = showStatusPanel || activeDragAnchorMode === "bubble";
  const desiredWindowMode: DesktopPetWindowMode = isPanelWindow
    ? "base"
    : isDragging
      ? activeDragAnchorMode ?? "base"
      : shouldShowTaskPanel
        ? useCompactTaskPanel ? "task-list-compact" : "task-list"
        : shouldShowPreviewPanel
          ? "preview-expanded"
          : shouldShowStatusPanel
            ? "bubble"
            : "base";

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
    if (shouldShowTaskPanel) {
      return useCompactTaskPanel ? "task-list-compact" : "task-list";
    }
    if (shouldShowPreviewPanel) {
      return "preview-expanded";
    }
    if (shouldShowStatusPanel) {
      return "bubble";
    }
    return null;
  }

  function handlePreviewPointerDown(event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function handleTaskPointerDown(event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function stopPanelClick(event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
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
    if (hasTaskPanelContent || canShowStatusPanel || hasHistoryMessages) {
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
    if (!text) {
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

  function handleDismissMessage(message: DesktopPetMessageItem) {
    const dismissedKey = getDesktopPetMessageVersionKey(message);
    setDismissedMessageKeys((current) => current.includes(dismissedKey) ? current : [...current, dismissedKey]);
    setMessageCache((current) => current.filter((cachedMessage) =>
      getDesktopPetMessageVersionKey(cachedMessage) !== dismissedKey
    ));
    void window.electronAPI.desktopPet
      .dismissMessage({ chatId: message.chatId, runId: message.runId, updatedAt: message.updatedAt })
      .catch(() => undefined);
    if (replyingChatId === message.chatId) {
      setReplyingChatId(null);
    }
    if (previewPanel?.status === "done" && previewPanel.chatId === message.chatId && previewPanel.runId === message.runId) {
      void window.electronAPI.desktopPet.dismissPreview();
    }
  }

  function handleDismissMessageClick(event: ReactMouseEvent<HTMLButtonElement>, message: DesktopPetMessageItem) {
    stopPanelClick(event);
    handleDismissMessage(message);
  }

  function handleOpenMessageClick(event: ReactMouseEvent<HTMLButtonElement>, message: DesktopPetMessageItem) {
    stopPanelClick(event);
    void window.electronAPI.desktopPet.openTaskChat({
      agentKey: message.agentKey,
      chatId: message.chatId
    });
  }

  function handleOpenAssistantFromPanel(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    void window.electronAPI.desktopPet.openAssistant();
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
      if (!isWidgetExpanded && (hasTaskPanelContent || canShowStatusPanel || hasHistoryMessages)) {
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
          hasSignatureAura && visualStatus === "signature" ? "has-signature-aura" : "",
          shouldShowStateSpriteAnimation ? "has-state-animation" : "",
          hasTaskPanelAnchor ? "has-tasks" : "",
          hasCompactTaskPanelAnchor ? "has-compact-tasks" : "",
          showPreviewPanel ? "has-preview" : "",
          hasPreviewExpandedAnchor ? "has-preview-expanded" : "",
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
        {showTaskPanel ? (
          <section
            className={[
              "desktop-pet-task-panel",
              isWidgetExpanded ? "is-expanded" : "is-collapsed"
            ].join(" ")}
            aria-live="polite"
            onPointerDown={handleTaskPointerDown}
          >
            <div className="desktop-pet-task-head">
              <span className="desktop-pet-task-head-copy">
                <strong>{taskPanelTitle}</strong>
                <span>{taskSummaryText}</span>
              </span>
              <button
                type="button"
                className="desktop-pet-task-head-action"
                aria-label={
                  isWidgetExpanded
                    ? t("desktopPet.panel.collapseWidget")
                    : t("desktopPet.panel.expandWidget")
                }
                aria-expanded={isWidgetExpanded}
                onClick={toggleWidgetExpanded}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            {isWidgetExpanded ? (
              <>
                <div className="desktop-pet-task-list">
                  {visibleTasks.map((task) => (
                    <button
                      type="button"
                      key={task.id}
                      className={`desktop-pet-issue-card is-${task.status}`}
                      onClick={(event) => handleTaskClick(event, task)}
                    >
                      <span className="desktop-pet-task-copy">
                        <strong>{task.title}</strong>
                        <span>{formatTaskPreview(task, t)}</span>
                      </span>
                      <span
                        className={`desktop-pet-task-status-badge is-${task.status}`}
                        aria-label={formatTaskStatus(task, t)}
                      />
                    </button>
                  ))}
                </div>
                {hiddenTaskCount > 0 || completedTaskCount > 0 ? (
                  <div className="desktop-pet-task-actions">
                    <span className="desktop-pet-task-more">
                      {completedTaskCount > 0
                        ? t("desktopPet.panel.completedMore", { count: completedTaskCount })
                        : t("desktopPet.panel.more", { count: hiddenTaskCount })}
                    </span>
                  </div>
                ) : null}
                <div className="desktop-pet-task-legend" aria-hidden="true">
                  <span><i className="is-done" />{t("desktopPet.panel.legendDone")}</span>
                  <span><i className="is-running" />{t("desktopPet.panel.legendRunning")}</span>
                  <span><i className="is-awaiting" />{t("desktopPet.panel.legendAwaiting")}</span>
                </div>
              </>
            ) : null}
          </section>
        ) : showPreviewPanel && previewPanel ? (
          <section
            className={[
              "desktop-pet-task-panel",
              "desktop-pet-preview-panel",
              `is-${mapDesktopPetPreviewBadgeStatus(previewPanel.status)}`,
              previewPanel.expanded ? "is-expanded" : "is-collapsed"
            ].filter(Boolean).join(" ")}
            aria-live="polite"
            onPointerDown={handlePreviewPointerDown}
            onClick={handlePreviewClick}
          >
            <div className="desktop-pet-task-head">
              <span className="desktop-pet-task-head-copy">
                <strong>{previewTitle || formatPreviewPanelHeaderTitle(previewPanel, t)}</strong>
                {showPreviewSummary ? <span>{previewSummary}</span> : null}
              </span>
              {previewPanel.status !== "done" ? (
                <button
                  type="button"
                  className="desktop-pet-task-head-action"
                  aria-label={previewPanel.expanded ? t("desktopPet.collapsePreview") : t("desktopPet.expandPreview")}
                  aria-expanded={previewPanel.expanded}
                  onClick={togglePreviewExpanded}
                >
                  <span aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {previewPanel.expanded ? (
              <div className="desktop-pet-task-list">
                {previewPanel.items.map((item) => {
                  const itemDetailText = item.detailText ?? item.text;
                  const itemTitle = formatInlinePetPreview(item.title);
                  const itemDetailPreview = formatInlinePetPreview(itemDetailText);
                  const showItemDetail = shouldShowSecondaryPreview(itemTitle, itemDetailPreview);
                  const itemBadgeStatus = mapDesktopPetPreviewBadgeStatus(item.status);
                  return (
                    <div
                      key={item.id}
                      className={`desktop-pet-issue-card is-${itemBadgeStatus}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className="desktop-pet-task-copy">
                        <strong>{itemTitle}</strong>
                        {showItemDetail ? <span>{itemDetailPreview}</span> : null}
                      </span>
                      <span
                        className={`desktop-pet-task-status-badge is-${itemBadgeStatus}`}
                        aria-label={formatPreviewStatus(item.status, t)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : showStatusPanel ? (
          <section
            className={[
              "desktop-pet-task-panel",
              "desktop-pet-status-panel",
              `is-${statusPanelStatus}`,
              isWidgetExpanded ? "is-expanded" : "is-collapsed"
            ].join(" ")}
            aria-live="polite"
            onPointerDown={handleTaskPointerDown}
          >
            <div className="desktop-pet-task-head">
              <span className="desktop-pet-task-head-copy">
                <strong>{statusPanelTitle}</strong>
              </span>
              <button
                type="button"
                className="desktop-pet-task-head-action"
                aria-label={t("desktopPet.message.collapse")}
                aria-expanded={isWidgetExpanded}
                onClick={toggleWidgetExpanded}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            {isWidgetExpanded ? (
              <>
                <div className={`desktop-pet-message-stack${replyingChatId ? " is-replying" : ""}`}>
                  {visibleMessages.length > 0 ? (
                    visibleMessages.map((message) => {
                      const isThinking =
                        message.status === "running" || pendingReplyIds.includes(message.chatId);
                      const cardStatus = isThinking ? "running" : message.status;
                      const isReplying = replyingChatId === message.chatId;
                      const replyDraftPreview = isReplying ? replyText : "";
                      const previewText = formatMessageCardPreview(message, isThinking, replyDraftPreview, t);
                      return (
                      <div
                        key={message.id}
                        className={`desktop-pet-message-card is-${cardStatus}${message.unread ? " is-unread" : ""}${isReplying ? " is-replying" : ""}`}
                        onPointerDown={handleTaskPointerDown}
                      >
                        <div className="desktop-pet-message-meta">
                          <button
                            type="button"
                            className="desktop-pet-message-dismiss"
                            aria-label={t("desktopPet.message.close")}
                            onClick={(event) => handleDismissMessageClick(event, message)}
                          >
                            <span aria-hidden="true" />
                          </button>
                        </div>
                        <button
                          type="button"
                          className="desktop-pet-message-main"
                          onClick={(event) => handleOpenMessageClick(event, message)}
                        >
                          <span className="desktop-pet-task-copy">
                            <strong>{message.title}</strong>
                            <span>{previewText}</span>
                          </span>
                          <span
                            className={`desktop-pet-task-status-badge is-${cardStatus}`}
                            aria-label={message.title}
                          />
                        </button>
                        {isReplying ? (
                          <div
                            className="desktop-pet-message-reply-box"
                            onPointerDown={handleTaskPointerDown}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <input
                              className="desktop-pet-message-reply-input"
                              value={replyText}
                              placeholder={
                                message.status === "awaiting"
                                  ? t("desktopPet.reply.awaitingPlaceholder")
                                  : t("desktopPet.reply.placeholder")
                              }
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
                        ) : (
                          <button
                            type="button"
                            className="desktop-pet-message-reply"
                            onClick={(event) => handleReplyToggleClick(event, message.chatId)}
                          >
                            {t("desktopPet.reply.action")}
                          </button>
                        )}
                      </div>
                      );
                    })
                  ) : (
                    <button
                      type="button"
                      className={`desktop-pet-issue-card is-${statusPanelStatus}`}
                      onClick={handleOpenAssistantFromPanel}
                    >
                      <span className="desktop-pet-task-copy">
                        <strong>{statusPanelTitle}</strong>
                        <span>{statusPanelPreview}</span>
                      </span>
                      <span
                        className={`desktop-pet-task-status-badge is-${statusPanelStatus}`}
                        aria-label={statusPanelTitle}
                      />
                    </button>
                  )}
                </div>
                {unreadCount > visibleMessages.length && !replyingChatId ? (
                  <div className="desktop-pet-task-actions">
                    <span className="desktop-pet-task-more">
                      {t("desktopPet.message.more", { count: unreadCount - visibleMessages.length })}
                    </span>
                  </div>
                ) : null}
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
                onPointerDown={handleUnreadBadgePointerDown}
                onClick={handleUnreadBadgeClick}
              >
                {badge.count > 99 ? "99+" : String(badge.count)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </main>
  );
}
