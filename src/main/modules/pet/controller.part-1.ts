import {
  applyDesktopPetActiveRunEvent,
  resolveDesktopPetRunningTaskCount
} from "../../../shared/desktop-pet";

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
} from "../../../shared/contracts";

import { readEpochMillis } from "../../../shared/time-contract";

import type {
  DesktopPetBoundAgentStatus,
  DesktopPetLocalStatus,
  DesktopPetWindowMode
} from "./desktop-pet";

import {
  createDesktopPetState,
  getDesktopPetLogicalPositionFromBounds,
  clampDesktopPetPosition,
  getAnchoredDesktopPetBounds,
  getDesktopPetWindowSize,
  isDesktopPetSupportedPlatform,
  DESKTOP_PET_EDGE_SNAP_DISTANCE_PX,
  DESKTOP_PET_WINDOW_SIZE
} from "./desktop-pet";

import { normalizeDesktopPetAgentEvent } from "./desktop-pet-preview";

import { t } from "../../support/i18n/main-i18n";

export type DesktopPetPreviewPanelLike = {
  status?: string;
  chatId?: string | null;
  runId?: string;
};

export type DesktopPetAgentStatusLike = {
  presence: string;
  chatId?: string | null;
  latestPreview?: string;
  unreadCount?: number;
};

export type DesktopPetCompletionEventLike = {
  type?: string | null;
  chatId?: string | null;
  runId?: string | null;
};

export type DesktopPetDismissedPreview = {
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

export type DesktopPetWindowModeStateLike = {
  status?: string;
  hint?: unknown;
  messagePreview?: unknown;
  unreadCount?: unknown;
  activeTasks?: unknown;
  messages?: unknown;
};

export type DesktopPetNavigationSnapshotLike = {
  ok?: unknown;
  items?: unknown;
  activityItems?: unknown;
};

export type DesktopPetBoundsLike = {
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

export const DESKTOP_PET_GENERIC_TASK_PREVIEWS = new Set([
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

export function toDesktopPetTaskText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

export function getDesktopPetTaskTimestamp(value: unknown) {
  return readEpochMillis(value) ?? 0;
}

export function getUsableDesktopPetTaskPreview(value: unknown) {
  const preview = toDesktopPetTaskText(value);
  return DESKTOP_PET_GENERIC_TASK_PREVIEWS.has(preview) ? "" : preview;
}

export function resolveDesktopPetTaskTitle(chat: AssistantNavChatItem) {
  return toDesktopPetTaskText(chat.chatName) ||
    getUsableDesktopPetTaskPreview(chat.lastRunContent) ||
    t("desktopPet.task.untitled");
}

export function shouldReplaceDesktopPetTask(existing: DesktopPetTaskItem, next: DesktopPetTaskItem) {
  if (existing.status !== next.status) {
    return next.status === "awaiting";
  }
  return getDesktopPetTaskTimestamp(next.updatedAt) > getDesktopPetTaskTimestamp(existing.updatedAt);
}

export function readDesktopPetAwaitingCount(chat: { awaitingCount?: unknown; hasPendingAwaiting?: unknown }) {
  if (!chat.hasPendingAwaiting) {
    return 0;
  }
  return Math.max(1, Math.round(Number(chat.awaitingCount) || 0));
}

export function readDesktopPetNavigationItems(snapshot: DesktopPetNavigationSnapshotLike | null | undefined) {
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

export function resolveDesktopPetMessageStatus(chat: AssistantNavChatItem): DesktopPetMessageStatus {
  if (chat.hasPendingAwaiting) {
    return "awaiting";
  }
  if (chat.hasActiveRun) {
    return "running";
  }
  return "done";
}

export function resolveDesktopPetMessageStatusFromAgentStatus(
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

export const DESKTOP_PET_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const DESKTOP_PET_MESSAGE_LIMIT = 50;

export function isDesktopPetMessageRecent(updatedAt: number, now = Date.now()) {
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
