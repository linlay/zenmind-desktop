import {
  applyDesktopPetActiveRunEvent,
  resolveDesktopPetRunningTaskCount
} from "../shared/desktop-pet";
import type {
  AssistantNavAgentItem,
  AssistantNavChatItem,
  DesktopPetAgentOption,
  DesktopPetAppearanceOption,
  DesktopPetDragDirection,
  DesktopPetEdgeDock,
  DesktopPetPanelPlacement,
  DesktopPetPreviewPanel,
  DesktopPetTaskItem,
  DesktopPetMessageItem,
  DesktopPetMessageStatus,
  AssistantNavigationAttentionSummary,
} from "../shared/contracts";
import { readEpochMillis } from "../shared/time-contract";
import type {
  DesktopPetBoundAgentStatus,
  DesktopPetLocalStatus,
  DesktopPetWindowMode
} from "./assistant/pet/desktop-pet";
import {
  createDesktopPetState,
  getDesktopPetLogicalPositionFromBounds,
  clampDesktopPetPosition,
  getAnchoredDesktopPetBounds,
  getDesktopPetWindowSize,
  isDesktopPetSupportedPlatform,
  DESKTOP_PET_EDGE_SNAP_DISTANCE_PX,
  DESKTOP_PET_WINDOW_SIZE
} from "./assistant/pet/desktop-pet";
import { normalizeDesktopPetAgentEvent } from "./assistant/pet/desktop-pet-preview";
import { t } from "./i18n/main-i18n";

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
  messages?: unknown;
};

type DesktopPetNavigationSnapshotLike = {
  ok?: unknown;
  items?: unknown;
  activityItems?: unknown;
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
    kanbanRunIds?: Array<string | null | undefined>;
    fallbackRunning?: boolean;
  } = {}) {
    return resolveDesktopPetRunningTaskCount({
      activeRunIds,
      kanbanRunIds: input.kanbanRunIds,
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
  return readEpochMillis(value) ?? 0;
}

function getUsableDesktopPetTaskPreview(value: unknown) {
  const preview = toDesktopPetTaskText(value);
  return DESKTOP_PET_GENERIC_TASK_PREVIEWS.has(preview) ? "" : preview;
}

function resolveDesktopPetTaskTitle(chat: AssistantNavChatItem) {
  return toDesktopPetTaskText(chat.chatName) ||
    getUsableDesktopPetTaskPreview(chat.lastRunContent) ||
    t("desktopPet.task.untitled");
}

// 同一个会话（chatId）可能出现在多个 agent 分组的 recentChats 中，按 chatId 去重时
// 优先保留更需要用户处理的任务：awaiting 优先于 running，同状态下保留更新时间更晚的。
function shouldReplaceDesktopPetTask(existing: DesktopPetTaskItem, next: DesktopPetTaskItem) {
  if (existing.status !== next.status) {
    return next.status === "awaiting";
  }
  return getDesktopPetTaskTimestamp(next.updatedAt) > getDesktopPetTaskTimestamp(existing.updatedAt);
}

function readDesktopPetAwaitingCount(chat: { awaitingCount?: unknown; hasPendingAwaiting?: unknown }) {
  if (!chat.hasPendingAwaiting) {
    return 0;
  }
  return Math.max(1, Math.round(Number(chat.awaitingCount) || 0));
}

function readDesktopPetNavigationItems(snapshot: DesktopPetNavigationSnapshotLike | null | undefined) {
  if (!snapshot?.ok) {
    return null;
  }
  return Array.isArray(snapshot.activityItems) ? snapshot.activityItems : snapshot.items;
}

export function createDesktopPetActiveTasksFromNavigationSnapshot(
  snapshot: DesktopPetNavigationSnapshotLike | null | undefined
): DesktopPetTaskItem[] {
  const items = readDesktopPetNavigationItems(snapshot);
  if (!Array.isArray(items)) {
    return [];
  }

  const tasksByChatId = new Map<string, DesktopPetTaskItem>();
  for (const agent of items as AssistantNavAgentItem[]) {
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
      const updatedAt = readEpochMillis(chat.updatedAt) ?? readEpochMillis(agent.updatedAt);
      if (updatedAt === undefined) {
        continue;
      }
      const awaitingCount = readDesktopPetAwaitingCount(chat);
      const task: DesktopPetTaskItem = {
        id: `${taskAgentKey}:${chatId}`,
        agentKey: taskAgentKey,
        agentDisplayName,
        chatId,
        runId: toDesktopPetTaskText(chat.lastRunId) || null,
        title: resolveDesktopPetTaskTitle(chat),
        preview: getUsableDesktopPetTaskPreview(chat.lastRunContent),
        status,
        ...(awaitingCount > 0 ? { awaitingCount } : {}),
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

function resolveDesktopPetMessageStatus(chat: AssistantNavChatItem): DesktopPetMessageStatus {
  if (chat.hasPendingAwaiting) {
    return "awaiting";
  }
  if (chat.hasActiveRun) {
    return "running";
  }
  return "done";
}

function resolveDesktopPetMessageStatusFromAgentStatus(
  agentStatus: DesktopPetBoundAgentStatus
): DesktopPetMessageStatus {
  if (agentStatus.hasPendingAwaiting) {
    return "awaiting";
  }
  if (agentStatus.presence === "busy") {
    return "running";
  }
  return "done";
}

const DESKTOP_PET_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DESKTOP_PET_MESSAGE_LIMIT = 50;

function isDesktopPetMessageRecent(updatedAt: number, now = Date.now()) {
  return updatedAt >= now - DESKTOP_PET_MESSAGE_RETENTION_MS;
}

export function createDesktopPetMessagesFromAgentStatus(
  agentStatus: DesktopPetBoundAgentStatus | null | undefined
): DesktopPetMessageItem[] {
  if (!agentStatus || agentStatus.stale) {
    return [];
  }
  const agentKey = toDesktopPetTaskText(agentStatus.agentKey);
  const chatId = toDesktopPetTaskText(agentStatus.chatId);
  const updatedAt = readEpochMillis(agentStatus.updatedAt);
  if (!agentKey || !chatId || updatedAt === undefined) {
    return [];
  }
  const unreadCount = Math.max(0, Math.round(Number(agentStatus.unreadCount) || 0));
  const status = resolveDesktopPetMessageStatusFromAgentStatus(agentStatus);
  if ((unreadCount <= 0 && status !== "awaiting") || !isDesktopPetMessageRecent(updatedAt)) {
    return [];
  }
  const preview = getUsableDesktopPetTaskPreview(agentStatus.latestPreview) ||
    (unreadCount > 0 ? "有新消息" : "") ||
    (status === "awaiting" ? "等待你确认" : "");
  if (!preview && status === "done") {
    return [];
  }
  const agentDisplayName = toDesktopPetTaskText(agentStatus.displayName) || agentKey;
  return [
    {
      id: `${agentKey}:${chatId}`,
      chatId,
      runId: null,
      agentKey,
      agentDisplayName,
      title: agentDisplayName,
      preview: preview || "打开对话查看历史消息",
      status,
      unread: unreadCount > 0,
      updatedAt
    }
  ];
}

// 把 recentChats 映射成桌宠"消息列表"：只保留七天内的未读或待确认会话。
// 每条 = 一个会话的最新一条 agent 回复；待确认会话只负责打开原对话，不在桌宠内直接作答。
export function createDesktopPetMessagesFromNavigationSnapshot(
  snapshot: DesktopPetNavigationSnapshotLike | null | undefined
): DesktopPetMessageItem[] {
  const items = readDesktopPetNavigationItems(snapshot);
  if (!Array.isArray(items)) {
    return [];
  }
  const messagesByChatId = new Map<string, DesktopPetMessageItem>();
  for (const agent of items as AssistantNavAgentItem[]) {
    const agentKey = toDesktopPetTaskText(agent?.agentKey);
    if (!agentKey || !Array.isArray(agent?.recentChats)) {
      continue;
    }
    const agentDisplayName = toDesktopPetTaskText(agent.displayName) || agentKey;
    for (const chat of agent.recentChats) {
      const chatId = toDesktopPetTaskText(chat.chatId);
      if (!chatId) {
        continue;
      }
      const unread = chat.isRead === false;
      const status = resolveDesktopPetMessageStatus(chat);
      if (!unread && status !== "awaiting") {
        continue;
      }
      if (!toDesktopPetTaskText(chat.lastRunContent) && !chat.hasActiveRun && !chat.hasPendingAwaiting) {
        continue;
      }
      const messageAgentKey = toDesktopPetTaskText(chat.agentKey) || agentKey;
      const updatedAt = readEpochMillis(chat.updatedAt) ?? readEpochMillis(agent.updatedAt);
      if (updatedAt === undefined || !isDesktopPetMessageRecent(updatedAt)) {
        continue;
      }
      const awaitingCount = readDesktopPetAwaitingCount(chat);
      const message: DesktopPetMessageItem = {
        id: `${messageAgentKey}:${chatId}`,
        chatId,
        runId: toDesktopPetTaskText(chat.lastRunId) || null,
        agentKey: messageAgentKey,
        agentDisplayName,
        title: resolveDesktopPetTaskTitle(chat),
        preview: getUsableDesktopPetTaskPreview(chat.lastRunContent),
        status,
        unread,
        ...(awaitingCount > 0 ? { awaitingCount } : {}),
        ...(chat.awaitingMode ? { awaitingMode: chat.awaitingMode } : {}),
        updatedAt
      };
      const existing = messagesByChatId.get(chatId);
      if (!existing || getDesktopPetTaskTimestamp(message.updatedAt) > getDesktopPetTaskTimestamp(existing.updatedAt)) {
        messagesByChatId.set(chatId, message);
      }
    }
  }
  return [...messagesByChatId.values()].sort((left, right) => {
    if (left.unread !== right.unread) {
      return left.unread ? -1 : 1;
    }
    const timeDelta = getDesktopPetTaskTimestamp(right.updatedAt) - getDesktopPetTaskTimestamp(left.updatedAt);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return left.title.localeCompare(right.title, "zh-CN");
  }).slice(0, DESKTOP_PET_MESSAGE_LIMIT);
}

export function computeDesktopPetStateRefresh(input: {
  settings: DesktopPetSettingsLike;
  supported: boolean;
  enabled: boolean;
  windowMode?: DesktopPetWindowMode;
  localStatus: DesktopPetLocalStatus;
  patch?: Partial<DesktopPetLocalStatus>;
  agentStatus: DesktopPetBoundAgentStatus | null;
  agentOptions: DesktopPetAgentOption[];
  activeTasks?: DesktopPetTaskItem[];
  messages?: DesktopPetMessageItem[];
  navigationAttention?: AssistantNavigationAttentionSummary;
  appearanceOptions?: DesktopPetAppearanceOption[];
  previewPanel: DesktopPetPreviewPanel | null;
  runningTaskCount: number;
  edgeDock: DesktopPetEdgeDock;
  panelPlacement?: DesktopPetPanelPlacement;
  dragDirection?: DesktopPetDragDirection;
  dragMoved?: unknown;
}) {
  const localStatus = input.patch && Object.keys(input.patch).length > 0
    ? {
        ...input.localStatus,
        ...input.patch
      }
    : input.localStatus;
  const state = createDesktopPetState(input.settings, {
    supported: input.supported,
    enabled: input.enabled,
    windowMode: input.windowMode ?? "base",
    localStatus,
    agentStatus: input.agentStatus,
    agentOptions: input.agentOptions,
    activeTasks: input.activeTasks,
    messages: input.messages,
    navigationAttention: input.navigationAttention,
    appearanceOptions: input.appearanceOptions,
    previewPanel: input.previewPanel,
    runningTaskCount: input.runningTaskCount,
    edgeDock: input.edgeDock,
    panelPlacement: input.panelPlacement,
    dragDirection: input.dragDirection ?? null,
    dragMoved: input.dragMoved
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
  layoutMode?: DesktopPetWindowMode;
  state: DesktopPetWindowModeStateLike;
  previewPanel?: { visible?: boolean; expanded?: boolean; status?: string } | null;
}): DesktopPetWindowMode {
  if (input.dragging) {
    return "base";
  }
  if (input.layoutMode) {
    return input.layoutMode;
  }
  const messagePreview = typeof input.state.messagePreview === "string"
    ? input.state.messagePreview.trim()
    : "";
  const hint = typeof input.state.hint === "string"
    ? input.state.hint.trim()
    : "";
  const unreadCount = Number(input.state.unreadCount);
  const hasHistoryMessages = Array.isArray(input.state.messages) && input.state.messages.length > 0;
  const hasMessageReaction = input.state.status === "idle" && (
    messagePreview.length > 0 ||
    (Number.isFinite(unreadCount) && unreadCount > 0)
  );
  if (hasHistoryMessages) {
    return "bubble";
  }

  const activeTasks = Array.isArray(input.state.activeTasks) ? input.state.activeTasks : [];
  if (activeTasks.length > 0) {
    return activeTasks.length <= 2 ? "task-list-compact" : "task-list";
  }
  const panel = input.previewPanel;
  if (panel?.visible) {
    return panel.status === "done" ? "bubble" : panel.expanded ? "preview-expanded" : "base";
  }

  const shouldShowBubble = hasHistoryMessages || input.state.status !== "idle" && (
    hint.length > 0 ||
    messagePreview.length > 0 ||
    (Number.isFinite(unreadCount) && unreadCount > 0) ||
    input.state.status === "running" ||
    input.state.status === "awaiting" ||
    input.state.status === "done" ||
    input.state.status === "error"
  );
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
  guardProgrammaticBounds?: (bounds: DesktopPetBounds) => void;
  refreshState: () => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  forceEndMs?: number;
}

export interface DesktopPetDragController {
  isDragging(): boolean;
  getDragDirection(): DesktopPetDragDirection;
  hasDragMovement(): boolean;
  beginDrag(point: { x?: unknown; y?: unknown }): { ok: boolean };
  endDrag(): { ok: boolean; moved: boolean };
  moveWindowBy(delta: { x?: unknown; y?: unknown }): { ok: boolean };
  stickToEdge(mode?: DesktopPetWindowMode): { position: { x: number; y: number }; bounds: DesktopPetBounds } | null;
  prepareWindowForDrag(mode: DesktopPetWindowMode): void;
  clearTimer(): void;
}

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

  function shouldSnapToCursorEdge(cursorPoint: { x: number; y: number }, displayBounds: DesktopPetBounds) {
    const rightEdge = displayBounds.x + displayBounds.width;
    const bottomEdge = displayBounds.y + displayBounds.height;
    return cursorPoint.x <= displayBounds.x + DESKTOP_PET_EDGE_SNAP_DISTANCE_PX ||
      cursorPoint.x >= rightEdge - DESKTOP_PET_EDGE_SNAP_DISTANCE_PX ||
      cursorPoint.y <= displayBounds.y + DESKTOP_PET_EDGE_SNAP_DISTANCE_PX ||
      cursorPoint.y >= bottomEdge - DESKTOP_PET_EDGE_SNAP_DISTANCE_PX;
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
    const nextLogicalBounds = clampDesktopPetPosition(position, displayBounds, DESKTOP_PET_WINDOW_SIZE, {
      allowVisibleEdgeDock: true,
      stickToEdges: shouldSnapToCursorEdge(cursorPoint, displayBounds)
    });
    const nextBounds = getAnchoredDesktopPetBounds({
      x: nextLogicalBounds.x,
      y: nextLogicalBounds.y
    }, displayBounds, mode);
    lastRequestedDragAnchor = {
      position: {
        x: nextLogicalBounds.x,
        y: nextLogicalBounds.y
      },
      displayBounds,
      mode
    };
    window.setBounds(nextBounds, false);
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
    const logicalPosition = getDesktopPetLogicalPositionFromBounds(
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
      getDesktopPetLogicalPositionFromBounds(currentBounds, mode, currentDisplayBounds);
    const displayBounds = requestedAnchor?.displayBounds ?? options.getDisplayBounds(logicalPosition);
    const snappedBounds = clampDesktopPetPosition(logicalPosition, displayBounds, DESKTOP_PET_WINDOW_SIZE, {
      allowVisibleEdgeDock: true,
      stickToEdges: true
    });
    const snappedPosition = {
      x: snappedBounds.x,
      y: snappedBounds.y
    };
    const nextBounds = getAnchoredDesktopPetBounds(snappedPosition, displayBounds, mode);
    options.guardProgrammaticBounds?.(nextBounds);
    if (
      currentBounds.x === nextBounds.x &&
      currentBounds.y === nextBounds.y &&
      currentBounds.width === nextBounds.width &&
      currentBounds.height === nextBounds.height
    ) {
      return {
        position: snappedPosition,
        bounds: nextBounds
      };
    }
    window.setBounds(nextBounds, false);
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
    }, 16);

    return { ok: true };
  }

  function endDrag() {
    if (!dragState) {
      return { ok: true, moved: false };
    }
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
  hideWindow(): any;
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
      if (!options.isHandlingQuit() && options.getSettings().enabled) {
        hideWindow();
        return;
      }
      options.refreshState();
    });

    window.on("close", (event: any) => {
      if (options.isHandlingQuit()) {
        return;
      }
      event.preventDefault();
      hideWindow();
    });

    window.on("closed", () => {
      options.endDrag();
      window = null;
      options.setMouseInteractive(true);
      if (!options.isHandlingQuit() && options.getSettings().enabled) {
        options.clearIdleResetTimer();
        options.clearPreviewRefreshTimer();
        options.clearPreview();
        options.saveSettings({
          enabled: false,
          unreadCount: 0
        });
      }
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

    const createdWindow = window;
    options.loadRendererRoute(createdWindow, "/desktop-pet").catch((error) => {
      console.error("failed to load desktop pet renderer", error);
      if (window === createdWindow && !createdWindow.isDestroyed()) {
        hideWindow();
      }
    });

    return window;
  }

  function showWindow() {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return hideWindow();
    }
    try {
      const targetWindow = createWindow();
      if (!targetWindow || targetWindow.isDestroyed()) {
        throw new Error("Desktop pet window was not created.");
      }

      const bounds = options.getBounds();
      targetWindow.setBounds(bounds, true);
      targetWindow.showInactive();
      targetWindow.moveTop();
      if (!targetWindow.isVisible()) {
        throw new Error("Desktop pet window did not become visible.");
      }
      options.saveSettings({
        enabled: true
      });
      return options.refreshState();
    } catch (error) {
      console.error("failed to show desktop pet window", error);
      return hideWindow();
    }
  }

  function hideWindow() {
    options.endDrag();
    options.setMouseInteractive(false);
    options.clearIdleResetTimer();
    options.clearPreviewRefreshTimer();
    options.clearPreview();
    options.saveSettings({
      enabled: false,
      unreadCount: 0
    });
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
    return options.refreshState({
      unreadCount: 0
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
      hint: t("desktopPet.status.thinking"),
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
      hint: t("desktopPet.status.error"),
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
    hint: t("desktopPet.status.thinking"),
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
    const timestamp = readEpochMillis(status.updatedAt);
    if (!replyPreview || timestamp === undefined) {
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
      createdAt: timestamp,
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
