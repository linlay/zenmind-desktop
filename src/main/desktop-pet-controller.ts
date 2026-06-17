import {
  applyDesktopPetActiveRunEvent,
  resolveDesktopPetRunningTaskCount
} from "../shared/desktop-pet";
import type {
  AssistantNavAgentItem,
  AssistantNavChatItem,
  DesktopPetAgentOption,
  DesktopPetAppearanceOption,
  DesktopPetEdgeDock,
  DesktopPetPreviewPanel,
  DesktopPetTaskItem
} from "../shared/contracts";
import type {
  DesktopPetBoundAgentStatus,
  DesktopPetLocalStatus,
  DesktopPetWindowMode
} from "./copilot/pet-copilot/desktop-pet";
import {
  createDesktopPetState,
  getDesktopPetLogicalPositionFromBounds,
  clampDesktopPetPosition,
  getAnchoredDesktopPetBounds,
  getDesktopPetWindowSize,
  isDesktopPetSupportedPlatform,
  DESKTOP_PET_WINDOW_SIZE
} from "./copilot/pet-copilot/desktop-pet";
import { normalizeDesktopPetAgentEvent } from "./copilot/pet-copilot/desktop-pet-preview";

type DesktopPetPreviewPanelLike = {
  status?: string;
  chatId?: string | null;
  runId?: string;
};

type DesktopPetAgentStatusLike = {
  presence: string;
  chatId?: string | null;
  latestPreview?: string;
  unreadCount?: number;
};

type DesktopPetCompletionEventLike = {
  type?: string | null;
  chatId?: string | null;
  runId?: string | null;
};

type DesktopPetDismissedPreview = {
  chatId: string;
  runId: string;
};

export interface DesktopPetSettingsLike {
  enabled: boolean;
  unreadCount: number;
  boundAgentKey: string;
  appearanceId: string;
  position?: { x: number; y: number };
}

type DesktopPetWindowModeStateLike = {
  status?: string;
  hint?: unknown;
  messagePreview?: unknown;
  unreadCount?: unknown;
  activeTasks?: unknown;
};

type DesktopPetBoundsLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function createDesktopPetDonePreviewDismissalTracker() {
  let dismissedPreview: DesktopPetDismissedPreview | null = null;

  function rememberFrom(panel: DesktopPetPreviewPanelLike | null | undefined, agentStatus?: { chatId?: string | null } | null) {
    const chatId = panel?.chatId || agentStatus?.chatId || "";
    if (panel?.status !== "done" || !chatId) {
      return false;
    }

    dismissedPreview = {
      chatId,
      runId: panel.runId || ""
    };
    return true;
  }

  function clear(chatId?: string | null, runId?: string | null) {
    if (!dismissedPreview) {
      return false;
    }
    if (
      !chatId ||
      dismissedPreview.chatId === chatId ||
      (runId && dismissedPreview.runId === runId)
    ) {
      dismissedPreview = null;
      return true;
    }
    return false;
  }

  function isDismissedChat(chatId: string | null | undefined) {
    return Boolean(chatId && dismissedPreview?.chatId === chatId);
  }

  function isDismissedCompletionEvent(event: DesktopPetCompletionEventLike | null | undefined) {
    if (!event || (event.type !== "run.complete" && event.type !== "done")) {
      return false;
    }
    if (!dismissedPreview || dismissedPreview.chatId !== event.chatId) {
      return false;
    }
    return !event.runId || dismissedPreview.runId === event.runId;
  }

  function filterAgentStatus<TAgentStatus extends DesktopPetAgentStatusLike | null>(agentStatus: TAgentStatus): TAgentStatus {
    if (!agentStatus || agentStatus.presence !== "away" || !isDismissedChat(agentStatus.chatId)) {
      return agentStatus;
    }
    return {
      ...agentStatus,
      presence: "available" as const,
      latestPreview: "",
      unreadCount: 0
    };
  }

  return {
    clear,
    filterAgentStatus,
    isDismissedChat,
    isDismissedCompletionEvent,
    rememberFrom
  };
}

export function createDesktopPetActiveRunTracker() {
  let activeRunIds = new Set<string>();

  function update(event: { type?: unknown; runId?: unknown; data?: unknown } | null | undefined) {
    const result = applyDesktopPetActiveRunEvent(activeRunIds, event);
    if (!result.changed) {
      return false;
    }
    activeRunIds = result.activeRunIds;
    return true;
  }

  function clear() {
    if (activeRunIds.size === 0) {
      return false;
    }
    activeRunIds = new Set();
    return true;
  }

  function getActiveRunIds() {
    return [...activeRunIds];
  }

  function getRunningTaskCount(input: {
    taskBoardRunIds?: Array<string | null | undefined>;
    fallbackRunning?: boolean;
  } = {}) {
    return resolveDesktopPetRunningTaskCount({
      activeRunIds,
      taskBoardRunIds: input.taskBoardRunIds,
      fallbackRunning: input.fallbackRunning
    });
  }

  return {
    clear,
    getActiveRunIds,
    getRunningTaskCount,
    update
  };
}

const DESKTOP_PET_TASK_TITLE_FALLBACK = "未命名任务";
const DESKTOP_PET_GENERIC_TASK_PREVIEWS = new Set([
  "",
  "思考中",
  "思考中...",
  "正在生成回复",
  "回复生成中",
  "回复已生成",
  "已完成",
  "完成",
  "打开对话查看完整回复"
]);

function toDesktopPetTaskText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function getDesktopPetTaskTimestamp(value: unknown) {
  const text = toDesktopPetTaskText(value);
  if (!text) {
    return 0;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getUsableDesktopPetTaskPreview(value: unknown) {
  const preview = toDesktopPetTaskText(value);
  return DESKTOP_PET_GENERIC_TASK_PREVIEWS.has(preview) ? "" : preview;
}

function resolveDesktopPetTaskTitle(chat: AssistantNavChatItem) {
  return toDesktopPetTaskText(chat.chatName) ||
    getUsableDesktopPetTaskPreview(chat.lastRunContent) ||
    DESKTOP_PET_TASK_TITLE_FALLBACK;
}

// 同一个会话（chatId）可能出现在多个 agent 分组的 recentChats 中，按 chatId 去重时
// 优先保留更需要用户处理的任务：awaiting 优先于 running，同状态下保留更新时间更晚的。
function shouldReplaceDesktopPetTask(existing: DesktopPetTaskItem, next: DesktopPetTaskItem) {
  if (existing.status !== next.status) {
    return next.status === "awaiting";
  }
  return getDesktopPetTaskTimestamp(next.updatedAt) > getDesktopPetTaskTimestamp(existing.updatedAt);
}

export function createDesktopPetActiveTasksFromNavigationSnapshot(
  snapshot: { ok?: unknown; items?: unknown } | null | undefined
): DesktopPetTaskItem[] {
  if (!snapshot?.ok || !Array.isArray(snapshot.items)) {
    return [];
  }

  const tasksByChatId = new Map<string, DesktopPetTaskItem>();
  for (const agent of snapshot.items as AssistantNavAgentItem[]) {
    const agentKey = toDesktopPetTaskText(agent?.agentKey);
    if (!agentKey || !Array.isArray(agent?.recentChats)) {
      continue;
    }
    const agentDisplayName = toDesktopPetTaskText(agent.displayName) || agentKey;
    for (const chat of agent.recentChats) {
      if (!chat?.hasPendingAwaiting && !chat?.hasActiveRun) {
        continue;
      }
      const chatId = toDesktopPetTaskText(chat.chatId);
      if (!chatId) {
        continue;
      }
      const taskAgentKey = toDesktopPetTaskText(chat.agentKey) || agentKey;
      const status = chat.hasPendingAwaiting ? "awaiting" : "running";
      const updatedAt = toDesktopPetTaskText(chat.updatedAt) || toDesktopPetTaskText(agent.updatedAt);
      const task: DesktopPetTaskItem = {
        id: `${taskAgentKey}:${chatId}`,
        agentKey: taskAgentKey,
        agentDisplayName,
        chatId,
        runId: toDesktopPetTaskText(chat.lastRunId) || null,
        title: resolveDesktopPetTaskTitle(chat),
        preview: getUsableDesktopPetTaskPreview(chat.lastRunContent),
        status,
        ...(chat.awaitingMode ? { awaitingMode: chat.awaitingMode } : {}),
        updatedAt
      };
      const existingTask = tasksByChatId.get(chatId);
      if (!existingTask || shouldReplaceDesktopPetTask(existingTask, task)) {
        tasksByChatId.set(chatId, task);
      }
    }
  }

  return [...tasksByChatId.values()].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "awaiting" ? -1 : 1;
    }
    const timeDelta = getDesktopPetTaskTimestamp(right.updatedAt) - getDesktopPetTaskTimestamp(left.updatedAt);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return left.title.localeCompare(right.title, "zh-CN");
  });
}

export function computeDesktopPetStateRefresh(input: {
  settings: DesktopPetSettingsLike;
  supported: boolean;
  visible: boolean;
  localStatus: DesktopPetLocalStatus;
  patch?: Partial<DesktopPetLocalStatus>;
  agentStatus: DesktopPetBoundAgentStatus | null;
  agentOptions: DesktopPetAgentOption[];
  activeTasks?: DesktopPetTaskItem[];
  appearanceOptions?: DesktopPetAppearanceOption[];
  previewPanel: DesktopPetPreviewPanel | null;
  runningTaskCount: number;
  edgeDock: DesktopPetEdgeDock;
}) {
  const localStatus = input.patch && Object.keys(input.patch).length > 0
    ? {
        ...input.localStatus,
        ...input.patch
      }
    : input.localStatus;
  const state = createDesktopPetState(input.settings, {
    supported: input.supported,
    visible: input.visible,
    localStatus,
    agentStatus: input.agentStatus,
    agentOptions: input.agentOptions,
    activeTasks: input.activeTasks,
    appearanceOptions: input.appearanceOptions,
    previewPanel: input.previewPanel,
    runningTaskCount: input.runningTaskCount,
    edgeDock: input.edgeDock
  });
  const settingsPatch = input.settings.unreadCount !== state.unreadCount
    ? {
        unreadCount: state.unreadCount
      }
    : null;
  return {
    localStatus,
    settingsPatch,
    state
  };
}

export function resolveDesktopPetWindowMode(input: {
  dragging?: boolean;
  state: DesktopPetWindowModeStateLike;
  previewPanel?: { visible?: boolean; expanded?: boolean } | null;
}): DesktopPetWindowMode {
  if (input.dragging) {
    return "base";
  }
  const activeTasks = Array.isArray(input.state.activeTasks) ? input.state.activeTasks : [];
  if (activeTasks.length > 0) {
    return activeTasks.length <= 2 ? "task-list-compact" : "task-list";
  }
  const panel = input.previewPanel;
  if (panel?.visible) {
    return panel.expanded ? "preview-expanded" : "preview-collapsed";
  }

  const messagePreview = typeof input.state.messagePreview === "string"
    ? input.state.messagePreview.trim()
    : "";
  const hint = typeof input.state.hint === "string"
    ? input.state.hint.trim()
    : "";
  const unreadCount = Number(input.state.unreadCount);
  const shouldShowBubble = input.state.status === "idle"
    ? messagePreview.length > 0 || (Number.isFinite(unreadCount) && unreadCount > 0)
    : hint.length > 0 ||
      input.state.status === "running" ||
      input.state.status === "awaiting" ||
      input.state.status === "done" ||
      input.state.status === "error";
  return shouldShowBubble ? "bubble" : "base";
}

export function createDesktopPetIdleResetAction(clearPreview = false) {
  return {
    clearPreview,
    rememberDismissedDonePreview: clearPreview,
    patch: {
      status: "idle" as const,
      hint: "",
      unreadCount: 0
    }
  };
}

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
}) {
  const boundsSignature = getDesktopPetBoundsSignature(input.bounds);
  if (input.pendingSignature) {
    return {
      clearPendingGuard: boundsSignature === input.pendingSignature,
      position: null,
      shouldPersist: false
    };
  }

  const logicalPosition = getDesktopPetLogicalPositionFromBounds(input.bounds, input.mode);
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

export interface DesktopPetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserWindowLike {
  isDestroyed(): boolean;
  getBounds(): DesktopPetBounds;
  setBounds(bounds: DesktopPetBounds, animate?: boolean): void;
  moveTop(): void;
}


export interface DesktopPetDragControllerOptions {
  platform: string;
  getWindow: () => BrowserWindowLike | null;
  getSettings: () => { position?: { x: number; y: number } };
  saveSettings: (settings: { position: { x: number; y: number } }) => void;
  getMode: () => DesktopPetWindowMode;
  getCursorScreenPoint: () => { x: number; y: number };
  getDisplayBounds: (position?: { x: number; y: number }) => DesktopPetBounds;
  getPointDisplayBounds: (point: { x: number; y: number }) => DesktopPetBounds;
  persistPosition: (mode: DesktopPetWindowMode) => void;
  refreshState: () => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  forceEndMs?: number;
}

export interface DesktopPetDragController {
  isDragging(): boolean;
  beginDrag(point: { x?: unknown; y?: unknown }): { ok: boolean };
  endDrag(): { ok: boolean; moved: boolean };
  moveWindowBy(delta: { x?: unknown; y?: unknown }): { ok: boolean };
  stickToEdge(mode?: DesktopPetWindowMode): void;
  prepareWindowForDrag(mode: DesktopPetWindowMode): void;
  clearTimer(): void;
}

export function createDesktopPetDragController(options: DesktopPetDragControllerOptions): DesktopPetDragController {
  let dragState: {
    startPoint: { x: number; y: number };
    lastPoint: { x: number; y: number };
    moved: boolean;
    startedAt: number;
  } | null = null;
  let dragTimer: any = null;

  const runSetInterval = options.setInterval || setInterval;
  const runClearInterval = options.clearInterval || clearInterval;
  const forceEndMs = typeof options.forceEndMs === "number" ? options.forceEndMs : 4000;

  function isDragging() {
    return Boolean(dragState);
  }

  function clearTimer() {
    if (dragTimer) {
      runClearInterval(dragTimer);
      dragTimer = null;
    }
  }

  function prepareWindowForDrag(mode: DesktopPetWindowMode) {
    const window = options.getWindow();
    if (!window || window.isDestroyed() || mode === "base") {
      return;
    }
    const currentBounds = window.getBounds();
    const logicalPosition = getDesktopPetLogicalPositionFromBounds(currentBounds, mode);
    const displayBounds = options.getDisplayBounds(logicalPosition);
    const nextBounds = getAnchoredDesktopPetBounds(logicalPosition, displayBounds, "base");
    if (
      currentBounds.x === nextBounds.x &&
      currentBounds.y === nextBounds.y &&
      currentBounds.width === nextBounds.width &&
      currentBounds.height === nextBounds.height
    ) {
      return;
    }
    window.setBounds(nextBounds, false);
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
    const mode = options.getMode();
    const size = getDesktopPetWindowSize(mode);
    const nextBounds = clampDesktopPetPosition({
      x: currentBounds.x + Math.round(deltaX),
      y: currentBounds.y + Math.round(deltaY)
    }, options.getPointDisplayBounds(cursorPoint), size, {
      allowVisibleEdgeDock: mode === "base"
    });
    window.setBounds(nextBounds, false);
    window.moveTop();
    return { ok: true };
  }

  function stickToEdge(mode: DesktopPetWindowMode = options.getMode()) {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    const currentBounds = window.getBounds();
    const logicalPosition = getDesktopPetLogicalPositionFromBounds(currentBounds, mode);
    const displayBounds = options.getDisplayBounds(logicalPosition);
    const snappedBounds = clampDesktopPetPosition(logicalPosition, displayBounds, DESKTOP_PET_WINDOW_SIZE, {
      allowVisibleEdgeDock: true,
      stickToEdges: true
    });
    const snappedPosition = {
      x: snappedBounds.x,
      y: snappedBounds.y
    };
    const nextBounds = getAnchoredDesktopPetBounds(snappedPosition, displayBounds, mode);
    if (
      currentBounds.x === nextBounds.x &&
      currentBounds.y === nextBounds.y &&
      currentBounds.width === nextBounds.width &&
      currentBounds.height === nextBounds.height
    ) {
      return;
    }
    window.setBounds(nextBounds, false);
  }

  function beginDrag(point: { x?: unknown; y?: unknown }) {
    const window = options.getWindow();
    if (!isDesktopPetSupportedPlatform(options.platform) || !window || window.isDestroyed()) {
      return { ok: false };
    }
    const startX = Number(point.x);
    const startY = Number(point.y);
    const fallbackPoint = options.getCursorScreenPoint();
    const startPoint = {
      x: Number.isFinite(startX) ? startX : fallbackPoint.x,
      y: Number.isFinite(startY) ? startY : fallbackPoint.y
    };
    const initialMode = options.getMode();
    clearTimer();
    dragState = {
      startPoint,
      lastPoint: startPoint,
      moved: false,
      startedAt: Date.now()
    };
    prepareWindowForDrag(initialMode);
    options.refreshState();

    dragTimer = runSetInterval(() => {
      if (!dragState || !window || window.isDestroyed()) {
        clearTimer();
        return;
      }
      if (Date.now() - dragState.startedAt > forceEndMs) {
        endDrag();
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
      dragState.moved = true;
      dragState.lastPoint = cursorPoint;
      if (deltaX !== 0 || deltaY !== 0) {
        moveWindowBy({ x: deltaX, y: deltaY });
      }
    }, 16);

    return { ok: true };
  }

  function endDrag() {
    if (!dragState) {
      return { ok: true, moved: false };
    }
    const moved = dragState.moved;
    dragState = null;
    clearTimer();
    if (moved) {
      stickToEdge("base");
      options.persistPosition("base");
    }
    options.refreshState();
    return {
      ok: true,
      moved
    };
  }

  return {
    isDragging,
    beginDrag,
    endDrag,
    moveWindowBy,
    stickToEdge,
    prepareWindowForDrag,
    clearTimer
  };
}

export interface DesktopPetWindowControllerOptions {
  platform: string;
  createWindow: (options: any) => any;
  getSettings: () => DesktopPetSettingsLike;
  saveSettings: (settings: Partial<DesktopPetSettingsLike>) => void;
  getMode: () => DesktopPetWindowMode;
  getBounds: () => DesktopPetBounds;
  isHandlingQuit: () => boolean;
  loadRendererRoute: (window: any, route: string) => Promise<void>;
  buildContextMenu: (appearanceId: string, window: any) => any;
  startStatusClient: () => void;
  stopStatusClient: () => void;
  endDrag: () => void;
  clearIdleResetTimer: () => void;
  clearPreviewRefreshTimer: () => void;
  clearPreview: () => void;
  refreshState: (patch?: Partial<DesktopPetLocalStatus>) => any;
  setMouseInteractive: (interactive: boolean) => void;
  onWindowMove?: () => void;
}

export interface DesktopPetWindowController {
  getWindow(): any | null;
  setWindow(window: any): void;
  createWindow(): any;
  showWindow(): any;
  hideWindow(disable?: boolean): any;
  isVisible(): boolean;
}

export function createDesktopPetWindowController(
  options: DesktopPetWindowControllerOptions
): DesktopPetWindowController {
  let window: any = null;

  function getWindow() {
    return window;
  }

  function setWindow(win: any) {
    window = win;
  }

  function isVisible() {
    return Boolean(
      options.getSettings().enabled &&
      window &&
      !window.isDestroyed() &&
      window.isVisible()
    );
  }

  function createWindow() {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return null;
    }
    if (window && !window.isDestroyed()) {
      return window;
    }

    window = options.createWindow(options.getBounds());

    window.on("move", () => {
      if (options.onWindowMove) {
        options.onWindowMove();
      }
    });

    window.on("show", () => {
      options.setMouseInteractive(false);
      options.refreshState();
    });

    window.on("hide", () => {
      options.setMouseInteractive(false);
      options.refreshState();
    });

    window.on("close", (event: any) => {
      if (options.isHandlingQuit()) {
        return;
      }
      event.preventDefault();
      hideWindow(true);
    });

    window.on("closed", () => {
      options.endDrag();
      window = null;
      options.setMouseInteractive(true);
      options.refreshState();
    });

    if (window.webContents) {
      window.webContents.on("context-menu", (event: any, params: any) => {
        options.endDrag();
        if (!window || window.isDestroyed()) {
          return;
        }
        const menu = options.buildContextMenu(options.getSettings().appearanceId, window);
        if (menu && typeof menu.popup === "function") {
          menu.popup({
            window,
            x: params.x,
            y: params.y
          });
        }
      });
    }

    options.loadRendererRoute(window, "/desktop-pet").catch((error) => {
      console.error("failed to load desktop pet renderer", error);
    });

    return window;
  }

  function showWindow() {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return options.refreshState();
    }
    options.saveSettings({
      enabled: true
    });
    options.startStatusClient();
    const targetWindow = createWindow();
    if (!targetWindow || targetWindow.isDestroyed()) {
      return options.refreshState();
    }

    const bounds = options.getBounds();
    targetWindow.setBounds(bounds, true);
    targetWindow.showInactive();
    targetWindow.moveTop();
    return options.refreshState();
  }

  function hideWindow(disable = false) {
    options.endDrag();
    options.setMouseInteractive(false);
    if (disable && options.getSettings().enabled) {
      options.clearIdleResetTimer();
      options.clearPreviewRefreshTimer();
      options.clearPreview();
      options.saveSettings({
        enabled: false,
        unreadCount: 0
      });
      options.stopStatusClient();
    }
    if (window && !window.isDestroyed() && window.isVisible()) {
      window.hide();
    }
    return options.refreshState({
      ...(disable ? { unreadCount: 0 } : {})
    });
  }

  return {
    getWindow,
    setWindow,
    createWindow,
    showWindow,
    hideWindow,
    isVisible
  };
}

export interface DesktopPetClientLifecycleControllerOptions {
  platform: string;
  app: any;
  AgentStatusClientClass: any;
  AgentStreamClientClass: any;
  getServiceState: (app: any, serviceId: string) => Promise<any>;
  issueAccessToken: (app: any, reason: any) => Promise<any>;
  getSettings: () => DesktopPetSettingsLike;
  setAgentStatus: (status: any) => void;
  setAgentOptions: (options: any[]) => void;
  clearActiveRuns: () => void;
  updateActiveRuns: (event: any) => void;
  clearDismissedPreview: (chatId: string | null | undefined, runId: string | null | undefined) => void;
  getPreviewPanel: () => { chatId?: string | null; runId?: string | null } | null;
  ingestAgentEvent: (event: any, context: { source: string; transportMode: string }) => void;
  refreshCompletedPreviewFromStatus: (status: any) => boolean;
  refreshState: () => void;
}

export interface DesktopPetClientLifecycleController {
  getStatusClient(): any | null;
  getStreamClient(): any | null;
  ensureStatusClient(): any | null;
  ensureStreamClient(): any | null;
  startStatusClient(): void;
  stopStatusClient(): void;
  scheduleStatusRefresh(delayMs?: number, force?: boolean): void;
}

export function createDesktopPetClientLifecycleController(
  options: DesktopPetClientLifecycleControllerOptions
): DesktopPetClientLifecycleController {
  let statusClient: any = null;
  let streamClient: any = null;

  function getStatusClient() {
    return statusClient;
  }

  function getStreamClient() {
    return streamClient;
  }

  function ensureStatusClient() {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return null;
    }
    if (statusClient) {
      return statusClient;
    }
    statusClient = new options.AgentStatusClientClass({
      app: options.app,
      getServiceState: options.getServiceState,
      issueAccessToken: options.issueAccessToken,
      onStatus: (status: any) => {
        options.setAgentStatus(status);
        if (!status) {
          options.clearActiveRuns();
        }
        if (options.refreshCompletedPreviewFromStatus(status)) {
          return;
        }
        options.refreshState();
      },
      onAgents: (agents: any) => {
        options.setAgentOptions(agents);
        options.refreshState();
      },
      onRunStarted: ({ runId, chatId }: { runId: string; chatId: string | null }) => {
        options.updateActiveRuns({ type: "run.started", runId });
        options.clearDismissedPreview(chatId, runId);
        ensureStreamClient()?.attach(runId, chatId);
      },
      onRunFinished: ({ runId, chatId, message }: { runId: string; chatId: string | null; message: string }) => {
        options.updateActiveRuns({ type: "run.finished", runId });
        const panel = options.getPreviewPanel();
        const resolvedRunId = runId || (panel && (!chatId || panel.chatId === chatId) ? panel.runId : "");
        if (!resolvedRunId) {
          return;
        }
        options.ingestAgentEvent({
          runId: resolvedRunId,
          chatId: chatId ?? panel?.chatId ?? null,
          type: "run.complete",
          createdAt: new Date().toISOString(),
          message
        }, {
          source: "agent-platform-status",
          transportMode: "ws"
        });
      },
      onDebug: (message: string) => {
        console.warn(`[desktop-pet] agent-platform status unavailable: ${message}`);
      }
    });
    return statusClient;
  }

  function ensureStreamClient() {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return null;
    }
    if (streamClient) {
      return streamClient;
    }
    streamClient = new options.AgentStreamClientClass({
      app: options.app,
      getServiceState: options.getServiceState,
      issueAccessToken: options.issueAccessToken,
      onEvent: (event: any) => {
        options.ingestAgentEvent(event, {
          source: "agent-platform-attach",
          transportMode: "sse"
        });
      },
      onDebug: (message: string) => {
        console.warn(`[desktop-pet] agent-platform stream unavailable: ${message}`);
      }
    });
    return streamClient;
  }

  function startStatusClient() {
    if (!options.getSettings().enabled) {
      return;
    }
    ensureStatusClient()?.start();
  }

  function stopStatusClient() {
    statusClient?.stop();
    statusClient = null;
    streamClient?.stop();
    streamClient = null;
    options.setAgentStatus(null);
    options.setAgentOptions([]);
    options.clearActiveRuns();
  }

  function scheduleStatusRefresh(delayMs = 0, force = false) {
    if (!force && !options.getSettings().enabled) {
      return;
    }
    ensureStatusClient()?.scheduleRefresh(delayMs);
  }

  return {
    getStatusClient,
    getStreamClient,
    ensureStatusClient,
    ensureStreamClient,
    startStatusClient,
    stopStatusClient,
    scheduleStatusRefresh
  };
}

const DESKTOP_PET_DONE_PREVIEW_FALLBACK = "暂无回复预览";
const DESKTOP_PET_GENERIC_DONE_PREVIEWS = new Set([
  "思考中",
  "已完成",
  "回复已生成",
  "正在生成回复",
  "生成完成",
  "生成完成。",
  "打开对话查看完整回复",
  DESKTOP_PET_DONE_PREVIEW_FALLBACK
]);

function normalizeDesktopPetReplyPreview(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function getUsableDesktopPetReplyPreview(value: unknown) {
  const preview = normalizeDesktopPetReplyPreview(value);
  return preview && !DESKTOP_PET_GENERIC_DONE_PREVIEWS.has(preview) ? preview : "";
}

function getDesktopPetStatusPatchFromPreview(panel: DesktopPetPreviewPanel | null | undefined) {
  if (!panel) {
    return null;
  }
  if (panel.status === "waiting") {
    return {
      status: "awaiting" as const,
      hint: "思考中",
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  if (panel.status === "done") {
    return {
      status: "done" as const,
      hint: panel.summary,
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  if (panel.status === "error") {
    return {
      status: "error" as const,
      hint: "出错了",
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  if (panel.status === "stopped") {
    return {
      status: "idle" as const,
      hint: "",
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  return {
    status: "running" as const,
    hint: "思考中",
    chatId: panel.chatId,
    unreadCount: 0
  };
}

export interface DesktopPetPreviewControllerOptions {
  platform: string;
  previewProjector: any;
  dismissalTracker: any;
  activeRunTracker: any;
  getAgentStatus: () => any;
  scheduleIdleReset: (holdMs: number, force: boolean) => void;
  clearIdleResetTimer: () => void;
  refreshState: (patch?: any) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface DesktopPetPreviewController {
  clearRefreshTimer(): void;
  clearPreview(): void;
  getPanel(): any;
  setExpanded(expanded: boolean): void;
  ingestAgentEvent(event: any, meta?: { source?: string; transportMode?: string }): void;
  refreshCompletedPreviewFromAgentStatus(status: any): boolean;
  dismissPreview(): { ok: boolean };
}

export function createDesktopPetPreviewController(
  options: DesktopPetPreviewControllerOptions
): DesktopPetPreviewController {
  let previewRefreshTimer: any = null;

  const runSetTimeout = options.setTimeout || setTimeout;
  const runClearTimeout = options.clearTimeout || clearTimeout;

  function clearRefreshTimer() {
    if (previewRefreshTimer) {
      runClearTimeout(previewRefreshTimer);
      previewRefreshTimer = null;
    }
  }

  function clearPreview() {
    options.previewProjector.clear();
  }

  function getPanel() {
    return options.previewProjector.getPanel();
  }

  function setExpanded(expanded: boolean) {
    options.previewProjector.setExpanded(expanded);
  }

  function refreshPreviewThrottled() {
    if (previewRefreshTimer) {
      return;
    }
    previewRefreshTimer = runSetTimeout(() => {
      previewRefreshTimer = null;
      const patch = getDesktopPetStatusPatchFromPreview(options.previewProjector.getPanel());
      options.refreshState(patch ?? {});
    }, 120);
  }

  function ingestAgentEvent(event: any, meta: { source?: string; transportMode?: string } = {}) {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return;
    }
    const normalizedEvent = normalizeDesktopPetAgentEvent(event);
    if (normalizedEvent?.type === "request.query" || normalizedEvent?.type === "run.start") {
      options.dismissalTracker.clear(normalizedEvent.chatId, normalizedEvent.runId);
    }
    options.activeRunTracker.update(normalizedEvent);
    if (options.dismissalTracker.isDismissedCompletionEvent(normalizedEvent)) {
      return;
    }
    const result = options.previewProjector.ingest(normalizedEvent ?? event, meta);
    if (!result.changed) {
      return;
    }

    if (result.holdMs) {
      options.scheduleIdleReset(result.holdMs, true);
    } else {
      options.clearIdleResetTimer();
    }

    if (result.refresh === "throttled") {
      refreshPreviewThrottled();
      return;
    }

    clearRefreshTimer();
    const patch = getDesktopPetStatusPatchFromPreview(result.panel);
    options.refreshState(patch ?? {});
  }

  function refreshCompletedPreviewFromAgentStatus(status: any) {
    if (!status || status.stale || status.presence !== "away") {
      return false;
    }
    if (options.dismissalTracker.isDismissedChat(status.chatId)) {
      return false;
    }
    const replyPreview = getUsableDesktopPetReplyPreview(status.latestPreview);
    if (!replyPreview) {
      return false;
    }
    const panel = options.previewProjector.getPanel();
    if (!panel || panel.status !== "done") {
      return false;
    }
    if (panel.chatId && status.chatId && panel.chatId !== status.chatId) {
      return false;
    }
    if (
      normalizeDesktopPetReplyPreview(panel.title) === replyPreview &&
      normalizeDesktopPetReplyPreview(panel.summary) === replyPreview
    ) {
      return false;
    }

    ingestAgentEvent({
      runId: panel.runId,
      chatId: panel.chatId ?? status.chatId,
      type: "run.complete",
      createdAt: new Date().toISOString(),
      message: replyPreview
    }, {
      source: "agent-platform-status",
      transportMode: "snapshot"
    });
    return true;
  }

  function dismissPreview() {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return { ok: false };
    }
    options.clearIdleResetTimer();
    clearRefreshTimer();
    options.dismissalTracker.rememberFrom(options.previewProjector.getPanel(), options.getAgentStatus());
    options.previewProjector.clear();
    options.refreshState({
      status: "idle",
      hint: "",
      unreadCount: 0,
      chatId: null
    });
    return { ok: true };
  }

  return {
    clearRefreshTimer,
    clearPreview,
    getPanel,
    setExpanded,
    ingestAgentEvent,
    refreshCompletedPreviewFromAgentStatus,
    dismissPreview
  };
}
