import { Menu, type App, type BrowserWindow, type MenuItemConstructorOptions, type Rectangle } from "electron";
import type {
  AssistantEvent,
  AssistantWorkerOpenRequest,
  DesktopPetAgentOption,
  DesktopPetMessageItem,
  DesktopPetPanelPlacement,
  DesktopPetTaskItem
} from "../../../shared/contracts";
import { PRODUCT_NAME } from "../../../shared/brand";
import { readEpochMillis } from "../../../shared/time-contract";
import { issueAgentAccessToken as defaultIssueAgentAccessToken } from "../../agent-auth";
import type { MainAppState } from "../../app-state";
import {
  computeDesktopPetBoundsUpdate,
  computeDesktopPetPositionPersistence,
  computeDesktopPetStateRefresh,
  createDesktopPetActiveRunTracker,
  createDesktopPetActiveTasksFromNavigationSnapshot,
  createDesktopPetMessagesFromAgentStatus,
  createDesktopPetMessagesFromNavigationSnapshot,
  createDesktopPetDonePreviewDismissalTracker,
  createDesktopPetIdleResetAction,
  resolveDesktopPetWindowMode,
  createDesktopPetDragController,
  createDesktopPetWindowController,
  createDesktopPetClientLifecycleController,
  createDesktopPetPreviewController,
  getDesktopPetBoundsSignature
} from "../../desktop-pet-controller";
import { getResponsiveServiceState as defaultGetResponsiveServiceState } from "../../services/manager";
import { t } from "../../i18n/main-i18n";
import {
  createDesktopPetState,
  createDefaultDesktopPetLocalStatus,
  DESKTOP_PET_VISIBLE_FOOTPRINT,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  getDesktopPetVisibleFootprintForMode,
  getDesktopPetContextMenuItems,
  getAnchoredDesktopPetBounds,
  getDesktopPetLogicalPositionFromBounds,
  getDesktopPetWindowSize,
  isDesktopPetSupportedPlatform,
  listUserDesktopPetAppearanceOptions,
  readDesktopPetStoredState,
  resolveDesktopPetEdgeDock,
  resolveDesktopPetDisplayArea,
  resolveDesktopPetPanelWindowBounds,
  saveDesktopPetSettings,
  type DesktopPetLocalStatus,
  type DesktopPetWindowMode
} from "./desktop-pet";
import { DesktopPetPreviewProjector } from "./desktop-pet-preview";
import { AgentPlatformPetStatusClient } from "./pet-status-client";
import { AgentPlatformPetStreamClient } from "./pet-stream-client";
import type { RealtimeBroker } from "../../realtime/realtime-broker";
import { applyDesktopPetBrowserWindowLayering, createDesktopPetBrowserWindow } from "./window";

export type DesktopPetRuntimeOptions = {
  app: App;
  platform: NodeJS.Platform;
  state: MainAppState;
  screen: {
    getCursorScreenPoint: () => { x: number; y: number };
    getPrimaryDisplay: () => { bounds: Rectangle; workArea: Rectangle };
    getDisplayMatching: (rect: Rectangle) => { bounds: Rectangle; workArea: Rectangle };
  };
  preloadPath: string;
  loadRendererRoute: (targetWindow: BrowserWindow, routePath: string) => Promise<unknown>;
  showMainWindow: (targetPath?: string) => void;
  openAssistantWorker: (request: AssistantWorkerOpenRequest) => Promise<void> | void;
  publishPluginAssistantActiveTasks: (tasks: DesktopPetTaskItem[], runningTaskCount: number) => void;
  refreshTrayContextMenu: () => void;
  getResponsiveServiceState?: typeof defaultGetResponsiveServiceState;
  issueAgentAccessToken?: typeof defaultIssueAgentAccessToken;
  realtimeBroker?: RealtimeBroker;
};

const DESKTOP_PET_RENDERER_WINDOW_MODES: readonly DesktopPetWindowMode[] = [
  "base",
  "bubble",
  "preview-collapsed",
  "preview-expanded",
  "task-list-compact",
  "task-list"
];

function getDesktopPetMessageCacheKey(message: DesktopPetMessageItem) {
  return message.chatId || message.id;
}

function normalizeDesktopPetRendererWindowMode(mode: unknown): DesktopPetWindowMode {
  return typeof mode === "string" &&
    DESKTOP_PET_RENDERER_WINDOW_MODES.includes(mode as DesktopPetWindowMode)
    ? mode as DesktopPetWindowMode
    : "base";
}

export function createDesktopPetRuntime(options: DesktopPetRuntimeOptions) {
  const state = options.state;
  const getResponsiveServiceState = options.getResponsiveServiceState ?? defaultGetResponsiveServiceState;
  const issueAgentAccessToken = options.issueAgentAccessToken ?? defaultIssueAgentAccessToken;
  const desktopPetPreviewProjector = new DesktopPetPreviewProjector();
  const desktopPetDonePreviewDismissalTracker = createDesktopPetDonePreviewDismissalTracker();
  const desktopPetActiveRunTracker = createDesktopPetActiveRunTracker();
  const desktopPetDismissedMessages = new Map<string, number>();
  const desktopPetMessageCache = new Map<string, DesktopPetMessageItem>();
  let destroyingPanelWindow = false;
  let desktopPetPanelPlacement: DesktopPetPanelPlacement = null;

  function isPanelWindowMode(mode: DesktopPetWindowMode) {
    return mode !== "base" && mode !== "preview-collapsed";
  }

  function getPanelWindowGap(_mode: DesktopPetWindowMode) {
    return 4;
  }

  function getPanelWindowSize(mode: DesktopPetWindowMode) {
    const size = getDesktopPetWindowSize(mode);
    return {
      width: size.width,
      height: Math.max(180, size.height - DESKTOP_PET_VISIBLE_FOOTPRINT.height)
    };
  }

  function clearIdleResetTimer() {
    if (state.desktopPetIdleResetTimer) {
      clearTimeout(state.desktopPetIdleResetTimer);
      state.desktopPetIdleResetTimer = null;
    }
  }

  const desktopPetPreviewController = createDesktopPetPreviewController({
    platform: options.platform,
    previewProjector: desktopPetPreviewProjector,
    dismissalTracker: desktopPetDonePreviewDismissalTracker,
    activeRunTracker: desktopPetActiveRunTracker,
    getAgentStatus: () => state.desktopPetAgentStatus,
    scheduleIdleReset: (holdMs: number, force: boolean) => {
      scheduleIdleReset(holdMs, force);
    },
    clearIdleResetTimer,
    refreshState: (patch: any) => {
      refreshState(patch);
    }
  });

  const desktopPetDragController = createDesktopPetDragController({
    platform: options.platform,
    getWindow: () => state.desktopPetWindow,
    getSettings: () => state.desktopPetSettings,
    saveSettings: (settings) => {
      state.desktopPetSettings = saveDesktopPetSettings(options.app, settings, options.platform);
    },
    getMode: () => "base",
    getCursorScreenPoint: () => options.screen.getCursorScreenPoint(),
    getDisplayBounds: (position) => getDisplayBounds(position),
    getPointDisplayBounds: (point) => getPointDisplayBounds(point),
    persistPosition: () => persistPosition("base"),
    guardProgrammaticBounds: (bounds) => {
      armProgrammaticBoundsGuard(getDesktopPetBoundsSignature(bounds));
    },
    refreshState: () => refreshState()
  });

  const desktopPetWindowController = createDesktopPetWindowController({
    platform: options.platform,
    createWindow: (bounds) => {
      const win = createDesktopPetBrowserWindow({
        bounds,
        platform: options.platform,
        preloadPath: options.preloadPath,
        focusable: false,
        onClosed: () => {
          state.desktopPetWindow = null;
          hidePanelWindow(false);
        }
      });
      state.desktopPetWindow = win;
      return win;
    },
    getSettings: () => state.desktopPetSettings,
    saveSettings: (settings) => {
      state.desktopPetSettings = saveDesktopPetSettings(options.app, settings, options.platform);
    },
    getMode: () => "base",
    getBounds: () => getPetBounds(),
    isHandlingQuit: () => state.isHandlingQuit,
    loadRendererRoute: async (win, route) => {
      await options.loadRendererRoute(win, route);
    },
    buildContextMenu: () => buildContextMenu(),
    startStatusClient: () => {
      startStatusClient();
    },
    stopStatusClient: () => {
      stopStatusClient();
    },
    endDrag: () => {
      endDrag();
    },
    clearIdleResetTimer,
    clearPreviewRefreshTimer: () => {
      desktopPetPreviewController.clearRefreshTimer();
    },
    clearPreview: () => {
      desktopPetPreviewController.clearPreview();
    },
    refreshState: (patch) => {
      return refreshState(patch);
    },
    setMouseInteractive: (interactive) => {
      setMouseInteractive(interactive);
    },
    onWindowMove: () => {
      persistPosition("base");
      applyPanelWindowBounds();
    }
  });

  const desktopPetClientLifecycleController = createDesktopPetClientLifecycleController({
    platform: options.platform,
    app: options.app,
    AgentStatusClientClass: AgentPlatformPetStatusClient,
    AgentStreamClientClass: AgentPlatformPetStreamClient,
    getServiceState: getResponsiveServiceState,
    issueAccessToken: issueAgentAccessToken,
    realtimeBroker: options.realtimeBroker,
    getSettings: () => state.desktopPetSettings,
    setAgentStatus: (status) => {
      state.desktopPetAgentStatus = status;
    },
    setAgentOptions: (agentOptions) => {
      state.desktopPetAgentOptions = agentOptions;
    },
    clearActiveRuns: () => {
      clearActiveRuns();
    },
    updateActiveRuns: (event) => {
      updateActiveRuns(event);
    },
    clearDismissedPreview: (chatId, runId) => {
      desktopPetDonePreviewDismissalTracker.clear(chatId, runId);
    },
    getPreviewPanel: () => desktopPetPreviewController.getPanel(),
    ingestAgentEvent: (event, context) => {
      desktopPetPreviewController.ingestAgentEvent(event, context);
    },
    refreshCompletedPreviewFromStatus: (status) => {
      return desktopPetPreviewController.refreshCompletedPreviewFromAgentStatus(status);
    },
    refreshState: () => {
      refreshState();
    }
  });

  function initializeState(isFirstDesktopInstall: boolean) {
    state.desktopPetSettings = readDesktopPetStoredState(options.app, options.platform, { isFirstInstall: isFirstDesktopInstall });
    if (isFirstDesktopInstall) {
      state.desktopPetSettings = saveDesktopPetSettings(options.app, state.desktopPetSettings, options.platform);
    }
    state.desktopPetLocalStatus = createDefaultDesktopPetLocalStatus(state.desktopPetSettings);
    state.desktopPetAgentStatus = null;
    state.desktopPetAgentOptions = [];
    state.desktopPetState = createDesktopPetState(state.desktopPetSettings, {
      supported: isDesktopPetSupportedPlatform(options.platform),
      enabled: false,
      localStatus: state.desktopPetLocalStatus,
      agentStatus: state.desktopPetAgentStatus,
      agentOptions: state.desktopPetAgentOptions,
      appearanceOptions: listUserDesktopPetAppearanceOptions(options.app)
    });
  }

  function updateActiveRuns(event: { type?: unknown; runId?: unknown; data?: unknown } | null | undefined) {
    if (!desktopPetActiveRunTracker.update(event)) {
      return false;
    }
    refreshState();
    return true;
  }

  function clearActiveRuns() {
    if (!desktopPetActiveRunTracker.clear()) {
      return false;
    }
    refreshState();
    return true;
  }

  function getKanbanActiveRunIds() {
    try {
      return (state.kanbanRuntime?.listIssues().issues ?? [])
        .filter((issue) => issue.status === "in_progress" && Boolean(issue.runId))
        .map((issue) => issue.runId)
        .filter((runId): runId is string => Boolean(runId));
    } catch (error) {
      console.warn("[desktop-pet] failed to read kanban active runs", error);
      return [];
    }
  }

  function getRunningTaskCount() {
    const fallbackRunning = state.desktopPetLocalStatus.status === "running" ||
      state.desktopPetLocalStatus.status === "awaiting" ||
      state.desktopPetAgentStatus?.presence === "busy" ||
      Boolean(state.desktopPetAgentStatus?.hasPendingAwaiting);
    return desktopPetActiveRunTracker.getRunningTaskCount({
      kanbanRunIds: getKanbanActiveRunIds(),
      fallbackRunning
    });
  }

  function getActiveTasks() {
    return createDesktopPetActiveTasksFromNavigationSnapshot(
      state.assistantNavigationStatusClient?.getSnapshot()
    );
  }

  function getAssistantActiveTasksSnapshotForPlugins() {
    const tasks = getActiveTasks();
    return {
      tasks,
      runningTaskCount: Math.max(getRunningTaskCount(), tasks.length),
      updatedAt: Date.now()
    };
  }

  function rememberMessages(messages: DesktopPetMessageItem[]) {
    for (const message of messages) {
      const key = getDesktopPetMessageCacheKey(message);
      if (key) {
        desktopPetMessageCache.set(key, message);
      }
    }
  }

  function mergeMessages(primaryMessages: DesktopPetMessageItem[], fallbackMessages: DesktopPetMessageItem[]) {
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

  function isMessageVisible(message: DesktopPetMessageItem) {
    const dismissedAt = desktopPetDismissedMessages.get(message.chatId);
    return !dismissedAt || message.updatedAt > dismissedAt;
  }

  function getMessagesForState() {
    const navigationMessages = createDesktopPetMessagesFromNavigationSnapshot(
      state.assistantNavigationStatusClient?.getSnapshot()
    );
    const liveMessages = navigationMessages.length > 0
      ? navigationMessages
      : createDesktopPetMessagesFromAgentStatus(getAgentStatusForState());
    rememberMessages(liveMessages);
    const messages = mergeMessages(liveMessages, [...desktopPetMessageCache.values()]);
    return messages.filter(isMessageVisible);
  }

  function getAgentStatusForState() {
    return desktopPetDonePreviewDismissalTracker.filterAgentStatus(state.desktopPetAgentStatus);
  }

  function listKanbanLocalAgents(): DesktopPetAgentOption[] {
    const agents = new Map<string, DesktopPetAgentOption>();
    const fallbackKanbanAgentKey = DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY;
    for (const agent of state.desktopPetAgentOptions) {
      const agentKey = agent.agentKey?.trim();
      if (!agentKey || agents.has(agentKey)) {
        continue;
      }
      agents.set(agentKey, {
        ...agent,
        agentKey,
        displayName: agent.displayName?.trim() || agentKey,
        role: agent.role?.trim() || "",
        unreadCount: Math.max(0, Math.round(agent.unreadCount ?? 0))
      });
    }

    const status = getAgentStatusForState();
    const statusAgentKey = status?.agentKey?.trim() ?? "";
    if (status && !status.stale && statusAgentKey && !agents.has(statusAgentKey)) {
      agents.set(statusAgentKey, {
        agentKey: statusAgentKey,
        displayName: status.displayName?.trim() || statusAgentKey,
        role: status.role?.trim() || "",
        unreadCount: Math.max(0, Math.round(status.unreadCount ?? 0))
      });
    }
    if (agents.size === 0) {
      agents.set(fallbackKanbanAgentKey, {
        agentKey: fallbackKanbanAgentKey,
        displayName: t("main.fallbackAgentName"),
        role: t("main.fallbackAgentRole"),
        unreadCount: 0
      });
    }
    return [...agents.values()];
  }

  function getWindowMode(): DesktopPetWindowMode {
    return resolveDesktopPetWindowMode({
      dragging: desktopPetDragController.isDragging(),
      layoutMode: state.desktopPetRendererWindowMode,
      state: state.desktopPetState,
      previewPanel: desktopPetPreviewController.getPanel()
    });
  }

  function setWindowMode(mode: unknown) {
    const nextMode = normalizeDesktopPetRendererWindowMode(mode);
    if (state.desktopPetRendererWindowMode !== nextMode) {
      state.desktopPetRendererWindowMode = nextMode;
      applyPetWindowBounds();
      applyPanelWindowBounds();
      refreshState();
    }
    return { ok: true };
  }

  function isVisible() {
    return desktopPetWindowController.isVisible();
  }

  function ensureStatusClient() {
    return desktopPetClientLifecycleController.ensureStatusClient();
  }

  function ensureStreamClient() {
    return desktopPetClientLifecycleController.ensureStreamClient();
  }

  function startStatusClient() {
    desktopPetClientLifecycleController.startStatusClient();
  }

  function stopStatusClient() {
    desktopPetClientLifecycleController.stopStatusClient();
  }

  function scheduleStatusRefresh(delayMs = 0, force = false) {
    desktopPetClientLifecycleController.scheduleStatusRefresh(delayMs, force);
  }

  function refreshState(patch: Partial<DesktopPetLocalStatus> = {}) {
    const enabled = isVisible();
    const activeTasks = getActiveTasks();
    const messages = getMessagesForState();
    const runningTaskCount = Math.max(getRunningTaskCount(), activeTasks.length);
    const refresh = computeDesktopPetStateRefresh({
      settings: state.desktopPetSettings,
      supported: isDesktopPetSupportedPlatform(options.platform),
      enabled,
      localStatus: state.desktopPetLocalStatus,
      patch,
      agentStatus: getAgentStatusForState(),
      agentOptions: state.desktopPetAgentOptions,
      appearanceOptions: listUserDesktopPetAppearanceOptions(options.app),
      activeTasks,
      messages,
      previewPanel: desktopPetPreviewController.getPanel(),
      runningTaskCount,
      windowMode: state.desktopPetRendererWindowMode,
      edgeDock: getCurrentPetEdgeDock(),
      panelPlacement: isPanelWindowMode(state.desktopPetRendererWindowMode) ? desktopPetPanelPlacement : null,
      dragDirection: desktopPetDragController.getDragDirection(),
      dragMoved: desktopPetDragController.hasDragMovement()
    });
    state.desktopPetLocalStatus = refresh.localStatus;
    state.desktopPetState = refresh.state;
    applyPetWindowBounds();
    applyPanelWindowBounds({ publishPlacement: false });
    if (refresh.settingsPatch) {
      state.desktopPetSettings = saveDesktopPetSettings(options.app, {
        unreadCount: refresh.settingsPatch.unreadCount
      }, options.platform);
    }
    sendDesktopPetStateToWindows();
    options.publishPluginAssistantActiveTasks(refresh.state.activeTasks, refresh.state.runningTaskCount);
    options.refreshTrayContextMenu();
    return state.desktopPetState;
  }

  function sendDesktopPetStateToWindows() {
    for (const targetWindow of [state.mainWindow, state.desktopPetWindow, state.desktopPetPanelWindow]) {
      if (!targetWindow || targetWindow.isDestroyed()) {
        continue;
      }
      targetWindow.webContents.send("desktopPet.state", state.desktopPetState);
    }
  }

  function updatePanelPlacement(nextPlacement: DesktopPetPanelPlacement, publishPlacement: boolean) {
    const normalizedPlacement = isPanelWindowMode(state.desktopPetRendererWindowMode) ? nextPlacement : null;
    if (
      desktopPetPanelPlacement === normalizedPlacement &&
      state.desktopPetState.panelPlacement === normalizedPlacement
    ) {
      return;
    }
    desktopPetPanelPlacement = normalizedPlacement;
    state.desktopPetState = {
      ...state.desktopPetState,
      panelPlacement: normalizedPlacement
    };
    if (publishPlacement) {
      sendDesktopPetStateToWindows();
    }
  }

  function scheduleIdleReset(timeoutMs = 4200, clearPreview = false) {
    clearIdleResetTimer();
    state.desktopPetIdleResetTimer = setTimeout(() => {
      const action = createDesktopPetIdleResetAction(clearPreview);
      if (action.rememberDismissedDonePreview) {
        desktopPetDonePreviewDismissalTracker.rememberFrom(desktopPetPreviewController.getPanel(), state.desktopPetAgentStatus);
      }
      if (action.clearPreview) {
        desktopPetPreviewController.clearPreview();
      }
      refreshState(action.patch);
      state.desktopPetIdleResetTimer = null;
    }, timeoutMs);
  }

  function getDisplayBounds(position?: { x: number; y: number }) {
    if (position) {
      return getPointDisplayBounds({
        x: position.x + DESKTOP_PET_VISIBLE_FOOTPRINT.x +
          Math.round(DESKTOP_PET_VISIBLE_FOOTPRINT.width / 2),
        y: position.y + DESKTOP_PET_VISIBLE_FOOTPRINT.y +
          Math.round(DESKTOP_PET_VISIBLE_FOOTPRINT.height / 2)
      });
    }
    return resolveDesktopPetDisplayArea(options.screen.getPrimaryDisplay());
  }

  function getPointDisplayBounds(point: { x: number; y: number }) {
    return resolveDesktopPetDisplayArea(options.screen.getDisplayMatching({
      x: point.x,
      y: point.y,
      width: 1,
      height: 1
    }));
  }

  function getPetBounds() {
    return getAnchoredDesktopPetBounds(
      state.desktopPetSettings.position,
      getDisplayBounds(state.desktopPetSettings.position),
      "base"
    );
  }

  function getCurrentPetLogicalPosition() {
    const displayArea = getDisplayBounds(state.desktopPetSettings.position);
    return getDesktopPetLogicalPositionFromBounds(
      getPetBounds(),
      "base",
      displayArea,
      state.desktopPetSettings.position
    );
  }

  function getCurrentPetEdgeDock() {
    const displayArea = getDisplayBounds(state.desktopPetSettings.position);
    return resolveDesktopPetEdgeDock(getCurrentPetLogicalPosition(), displayArea);
  }

  function getPanelLayout(mode: DesktopPetWindowMode) {
    const displayArea = getDisplayBounds(state.desktopPetSettings.position);
    const petBounds = getPetBounds();
    const edgeDock = getCurrentPetEdgeDock();
    const footprint = getDesktopPetVisibleFootprintForMode("base", edgeDock);
    const petRect = {
      x: petBounds.x + footprint.x,
      y: petBounds.y + footprint.y,
      width: footprint.width,
      height: footprint.height
    };
    return resolveDesktopPetPanelWindowBounds({
      displayArea,
      petRect,
      windowSize: getPanelWindowSize(mode),
      gap: getPanelWindowGap(mode)
    });
  }

  function getPanelBounds(mode: DesktopPetWindowMode) {
    return getPanelLayout(mode).rect;
  }

  function clearProgrammaticBoundsGuard() {
    if (state.desktopPetProgrammaticBoundsGuardTimer) {
      clearTimeout(state.desktopPetProgrammaticBoundsGuardTimer);
      state.desktopPetProgrammaticBoundsGuardTimer = null;
    }
  }

  function armProgrammaticBoundsGuard(signature: string) {
    state.desktopPetPendingProgrammaticBoundsSignature = signature;
    clearProgrammaticBoundsGuard();
    state.desktopPetProgrammaticBoundsGuardTimer = setTimeout(() => {
      state.desktopPetPendingProgrammaticBoundsSignature = null;
      state.desktopPetProgrammaticBoundsGuardTimer = null;
    }, 180);
  }

  function applyPetWindowBounds() {
    if (!isDesktopPetSupportedPlatform(options.platform) || !state.desktopPetWindow || state.desktopPetWindow.isDestroyed()) {
      return;
    }
    if (desktopPetDragController.isDragging()) {
      return;
    }
    const nextBounds = getPetBounds();
    const currentBounds = state.desktopPetWindow.getBounds();
    const update = computeDesktopPetBoundsUpdate({ currentBounds, nextBounds });
    if (update.clearPendingGuard) {
      state.desktopPetPendingProgrammaticBoundsSignature = null;
      clearProgrammaticBoundsGuard();
      return;
    }
    if (update.pendingSignature) {
      armProgrammaticBoundsGuard(update.pendingSignature);
    }
    if (update.setBounds) {
      state.desktopPetWindow.setBounds(update.setBounds, false);
    }
  }

  function restoreWindowLayering() {
    if (
      !isDesktopPetSupportedPlatform(options.platform) ||
      !state.desktopPetSettings.enabled
    ) {
      return;
    }
    for (const targetWindow of [state.desktopPetWindow, state.desktopPetPanelWindow]) {
      applyDesktopPetBrowserWindowLayering(targetWindow, options.platform);
    }
  }

  function createPanelWindow(mode: DesktopPetWindowMode) {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return null;
    }
    if (state.desktopPetPanelWindow && !state.desktopPetPanelWindow.isDestroyed()) {
      return state.desktopPetPanelWindow;
    }

    const win = createDesktopPetBrowserWindow({
      bounds: getPanelBounds(mode),
      platform: options.platform,
      preloadPath: options.preloadPath,
      onClosed: () => {
        state.desktopPetPanelWindow = null;
      }
    });
    state.desktopPetPanelWindow = win;
    win.on("close", (event: any) => {
      if (state.isHandlingQuit || destroyingPanelWindow) {
        return;
      }
      event.preventDefault();
      hidePanelWindow(true);
    });
    win.on("closed", () => {
      state.desktopPetPanelWindow = null;
    });
    options.loadRendererRoute(win, "/desktop-pet?role=panel").catch((error) => {
      console.error("failed to load desktop pet panel renderer", error);
    });
    return win;
  }

  function hidePanelWindow(resetMode = false, publishPlacement = true) {
    if (resetMode && state.desktopPetRendererWindowMode !== "base") {
      state.desktopPetRendererWindowMode = "base";
    }
    updatePanelPlacement(null, publishPlacement);
    const panelWindow = state.desktopPetPanelWindow;
    if (panelWindow && !panelWindow.isDestroyed()) {
      destroyingPanelWindow = true;
      panelWindow.destroy();
      destroyingPanelWindow = false;
      state.desktopPetPanelWindow = null;
    }
  }

  function applyPanelWindowBounds(input: { publishPlacement?: boolean } = {}) {
    const publishPlacement = input.publishPlacement ?? true;
    const mode = state.desktopPetRendererWindowMode;
    if (
      !isDesktopPetSupportedPlatform(options.platform) ||
      !isPanelWindowMode(mode) ||
      !state.desktopPetSettings.enabled ||
      !state.desktopPetWindow ||
      state.desktopPetWindow.isDestroyed() ||
      !state.desktopPetWindow.isVisible() ||
      desktopPetDragController.isDragging()
    ) {
      hidePanelWindow(false, publishPlacement);
      return;
    }
    const panelWindow = createPanelWindow(mode);
    if (!panelWindow || panelWindow.isDestroyed()) {
      return;
    }
    const layout = getPanelLayout(mode);
    updatePanelPlacement(layout.side, publishPlacement);
    panelWindow.setBounds(layout.rect, false);
    if (!panelWindow.isVisible()) {
      panelWindow.showInactive();
    }
    restoreWindowLayering();
  }

  function persistPosition(mode: DesktopPetWindowMode = getWindowMode()) {
    if (!state.desktopPetWindow || state.desktopPetWindow.isDestroyed()) {
      return;
    }
    if (desktopPetDragController.isDragging()) {
      return;
    }
    const bounds = state.desktopPetWindow.getBounds();
    const currentPosition = state.desktopPetSettings.position;
    const currentDisplayArea = currentPosition
      ? getDisplayBounds(currentPosition)
      : null;
    const edgeDock = resolveDesktopPetEdgeDock(currentPosition, currentDisplayArea ?? getDisplayBounds(currentPosition));
    const footprint = getDesktopPetVisibleFootprintForMode(mode, edgeDock);
    const displayArea = currentDisplayArea ?? getPointDisplayBounds({
      x: bounds.x + footprint.x + Math.round(footprint.width / 2),
      y: bounds.y + footprint.y + Math.round(footprint.height / 2)
    });
    const persistence = computeDesktopPetPositionPersistence({
      bounds,
      mode,
      displayArea,
      pendingSignature: state.desktopPetPendingProgrammaticBoundsSignature,
      currentPosition
    });
    if (persistence.clearPendingGuard) {
      state.desktopPetPendingProgrammaticBoundsSignature = null;
      clearProgrammaticBoundsGuard();
    }
    if (!persistence.shouldPersist || !persistence.position) {
      return;
    }
    state.desktopPetSettings = saveDesktopPetSettings(options.app, {
      position: persistence.position
    }, options.platform);
    refreshState();
  }

  function moveWindowBy(delta: { x?: unknown; y?: unknown }) {
    return desktopPetDragController.moveWindowBy(delta);
  }

  function stickWindowToEdge(mode: DesktopPetWindowMode = getWindowMode()) {
    desktopPetDragController.stickToEdge("base");
  }

  function prepareWindowForDrag(mode: DesktopPetWindowMode) {
    desktopPetDragController.prepareWindowForDrag("base");
    hidePanelWindow(true);
  }

  function beginDrag(point: { x?: unknown; y?: unknown }) {
    return desktopPetDragController.beginDrag(point);
  }

  function endDrag() {
    return desktopPetDragController.endDrag();
  }

  function hideWindow() {
    hidePanelWindow(true);
    return desktopPetWindowController.hideWindow();
  }

  function setMouseInteractive(interactive: boolean) {
    if (!state.desktopPetWindow || state.desktopPetWindow.isDestroyed()) {
      state.desktopPetMouseInteractive = true;
      return { ok: false };
    }
    if (state.desktopPetMouseInteractive === interactive) {
      return { ok: true };
    }
    state.desktopPetMouseInteractive = interactive;
    if (options.platform === "darwin") {
      state.desktopPetWindow.setIgnoreMouseEvents(!interactive, { forward: true });
      return { ok: true };
    }
    if (options.platform === "win32") {
      // Windows cannot forward mousemove events while ignored, so keep the pet window interactive there.
      state.desktopPetWindow.setIgnoreMouseEvents(false);
      return { ok: true };
    }
    state.desktopPetWindow.setIgnoreMouseEvents(false);
    return { ok: true };
  }

  async function markAgentPlatformChatRead(chatId: string) {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }
    try {
      const serviceState = await getResponsiveServiceState(options.app, "agent-platform");
      const baseUrl = serviceState.status === "running" ? serviceState.healthMeta.webUrl.trim() : "";
      if (!baseUrl) {
        return;
      }
      const tokenResult = await issueAgentAccessToken(options.app, "missing");
      if (!tokenResult.ok || !tokenResult.token.trim()) {
        return;
      }
      const response = await fetch(new URL("/api/read", baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenResult.token.trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ chatId: normalizedChatId })
      });
      if (!response.ok) {
        throw new Error(`agent-platform /api/read returned HTTP ${response.status}`);
      }
      const payload = await response.json() as { data?: unknown };
      const data = typeof payload.data === "object" && payload.data !== null
        ? payload.data as { agentKey?: unknown; agentUnreadCount?: unknown }
        : {};
      const agentKey = typeof data.agentKey === "string" ? data.agentKey.trim() : "";
      const rawUnreadCount = Number(data.agentUnreadCount);
      const fallbackUnreadCount = Math.max(0, (state.desktopPetAgentStatus?.unreadCount ?? 1) - 1);
      const unreadCount = Number.isFinite(rawUnreadCount) && rawUnreadCount >= 0
        ? Math.round(rawUnreadCount)
        : fallbackUnreadCount;

      if (!state.desktopPetAgentStatus || (agentKey && agentKey !== state.desktopPetAgentStatus.agentKey)) {
        return;
      }
      state.desktopPetAgentStatus = {
        ...state.desktopPetAgentStatus,
        chatId: normalizedChatId,
        unreadCount,
        stale: false,
        updatedAt: Date.now()
      };
      refreshState();
    } catch (error) {
      console.warn("[desktop-pet] failed to mark agent chat read", error);
    } finally {
      scheduleStatusRefresh(250, true);
    }
  }

  async function openAssistant() {
    options.showMainWindow();
    const targetWindow = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null;
    return {
      ok: Boolean(targetWindow),
      message: targetWindow ? t("main.appOpened", { appName: PRODUCT_NAME }) : t("main.mainWindowUnavailable", { appName: PRODUCT_NAME })
    };
  }

  async function openTaskChat(input: { agentKey?: unknown; chatId?: unknown } = {}) {
    const agentKey = typeof input.agentKey === "string" ? input.agentKey.trim() : "";
    const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
    if (!agentKey || !chatId) {
      return {
        ok: false,
        message: t("main.taskMissingAgentOrChat")
      };
    }
    await options.openAssistantWorker({
      agentKey,
      chatId,
      focusComposerOnComplete: false
    });
    return {
      ok: true,
      message: t("main.taskChatOpened")
    };
  }

  function requestSignature(signatureId: string) {
    if (!state.desktopPetWindow || state.desktopPetWindow.isDestroyed()) {
      return { ok: false };
    }
    state.desktopPetWindow.webContents.send("desktopPet.signatureRequested", signatureId);
    return { ok: true };
  }

  function buildContextMenu() {
    const template = getDesktopPetContextMenuItems(
      state.desktopPetState.appearanceId,
      state.desktopPetState.signature ?? []
    )
      .map((item): MenuItemConstructorOptions => ({
        label: item.label,
        click: () => {
          if (item.action === "signature") {
            requestSignature(item.signatureId);
            return;
          }
          hideWindow();
        }
      }));
    return Menu.buildFromTemplate(template);
  }

  function createWindow() {
    return desktopPetWindowController.createWindow();
  }

  function showWindow() {
    const result = desktopPetWindowController.showWindow();
    applyPanelWindowBounds();
    restoreWindowLayering();
    return result;
  }

  function ingestAgentEvent(event: unknown, meta: { source?: string; transportMode?: string } = {}) {
    desktopPetPreviewController.ingestAgentEvent(event, meta);
  }

  function dismissPreview() {
    return desktopPetPreviewController.dismissPreview();
  }

  function handleAssistantEvent(event: AssistantEvent) {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return;
    }
    ingestAgentEvent(event, {
      source: "local",
      transportMode: "local"
    });
  }

  function setPreviewExpanded(expanded: boolean) {
    desktopPetPreviewProjector.setExpanded(Boolean(expanded));
  }

  async function replyMessage(assistantBridge: { startRun: (input: any) => Promise<any> }, input: any) {
    const chatId = typeof input?.chatId === "string" ? input.chatId.trim() : "";
    const message = typeof input?.message === "string" ? input.message.trim() : "";
    const agentKey = typeof input?.agentKey === "string" ? input.agentKey.trim() : "";
    if (!chatId || !message) {
      return { ok: false, message: t("desktopPet.replyMissingContent") };
    }
    const result = await assistantBridge.startRun({
      chatId,
      agentKey: agentKey || undefined,
      message
    });
    desktopPetDismissedMessages.delete(chatId);
    scheduleStatusRefresh(200);
    return result;
  }

  function dismissMessage(input: any) {
    const chatId = typeof input?.chatId === "string" ? input.chatId.trim() : "";
    const updatedAt = readEpochMillis(input?.updatedAt);
    if (!chatId || updatedAt === undefined) {
      return { ok: false };
    }
    desktopPetDismissedMessages.set(chatId, updatedAt);
    refreshState();
    return { ok: true };
  }

  return {
    initializeState,
    clearIdleResetTimer,
    updateActiveRuns,
    clearActiveRuns,
    getRunningTaskCount,
    getActiveTasks,
    getAssistantActiveTasksSnapshotForPlugins,
    listKanbanLocalAgents,
    getWindowMode,
    setWindowMode,
    isVisible,
    ensureStatusClient,
    ensureStreamClient,
    startStatusClient,
    stopStatusClient,
    scheduleStatusRefresh,
    refreshState,
    scheduleIdleReset,
    getDisplayBounds,
    getPointDisplayBounds,
    getBounds: getPetBounds,
    applyWindowBounds: applyPetWindowBounds,
    restoreWindowLayering,
    persistPosition,
    moveWindowBy,
    stickWindowToEdge,
    prepareWindowForDrag,
    beginDrag,
    endDrag,
    hideWindow,
    setMouseInteractive,
    markAgentPlatformChatRead,
    openAssistant,
    openTaskChat,
    requestSignature,
    buildContextMenu,
    createWindow,
    showWindow,
    ingestAgentEvent,
    dismissPreview,
    handleAssistantEvent,
    setPreviewExpanded,
    replyMessage,
    dismissMessage
  };
}

export type DesktopPetRuntime = ReturnType<typeof createDesktopPetRuntime>;
