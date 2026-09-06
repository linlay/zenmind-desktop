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

import { DesktopPetBounds, DesktopPetDragController, DesktopPetDragControllerOptions, DesktopPetSettingsLike } from "./controller.part-1";

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

export const DESKTOP_PET_DONE_PREVIEW_FALLBACK = "暂无回复预览";

export const DESKTOP_PET_GENERIC_DONE_PREVIEWS = new Set([
  "思考中",
  "已完成",
  "回复已生成",
  "正在生成回复",
  "生成完成",
  "生成完成。",
  "打开对话查看完整回复",
  DESKTOP_PET_DONE_PREVIEW_FALLBACK
]);

export function normalizeDesktopPetReplyPreview(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

export function getUsableDesktopPetReplyPreview(value: unknown) {
  const preview = normalizeDesktopPetReplyPreview(value);
  return preview && !DESKTOP_PET_GENERIC_DONE_PREVIEWS.has(preview) ? preview : "";
}

export function getDesktopPetStatusPatchFromPreview(panel: DesktopPetPreviewPanel | null | undefined) {
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
