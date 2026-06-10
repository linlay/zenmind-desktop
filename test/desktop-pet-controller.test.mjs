import test from "node:test";
import assert from "node:assert/strict";

const {
  computeDesktopPetBoundsUpdate,
  computeDesktopPetPositionPersistence,
  computeDesktopPetStateRefresh,
  createDesktopPetActiveRunTracker,
  createDesktopPetActiveTasksFromNavigationSnapshot,
  createDesktopPetDonePreviewDismissalTracker,
  createDesktopPetIdleResetAction,
  resolveDesktopPetWindowMode,
  createDesktopPetDragController,
  createDesktopPetWindowController,
  createDesktopPetClientLifecycleController,
  createDesktopPetPreviewController
} = await import("../dist-electron/main/desktop-pet-controller.js");

test("desktop pet dismissal tracker suppresses a completed agent reminder until it is cleared", () => {
  const tracker = createDesktopPetDonePreviewDismissalTracker();
  const agentStatus = {
    agentKey: "zenmi",
    displayName: "ZenMi",
    role: "assistant",
    presence: "away",
    unreadCount: 1,
    latestPreview: "finished reply",
    chatId: "chat-1",
    hasPendingAwaiting: false,
    stale: false,
    updatedAt: "2026-05-28T00:00:00.000Z"
  };

  assert.equal(tracker.rememberFrom({
    status: "done",
    chatId: "chat-1",
    runId: "run-1"
  }, null), true);

  assert.equal(tracker.isDismissedChat("chat-1"), true);
  assert.deepEqual(tracker.filterAgentStatus(agentStatus), {
    ...agentStatus,
    presence: "available",
    latestPreview: "",
    unreadCount: 0
  });

  assert.equal(tracker.clear("chat-1", "run-1"), true);
  assert.equal(tracker.isDismissedChat("chat-1"), false);
  assert.equal(tracker.filterAgentStatus(agentStatus), agentStatus);
});

test("desktop pet dismissal tracker ignores non-completion previews and matches completion events by chat/run", () => {
  const tracker = createDesktopPetDonePreviewDismissalTracker();

  assert.equal(tracker.rememberFrom({
    status: "running",
    chatId: "chat-1",
    runId: "run-1"
  }, {
    chatId: "chat-agent"
  }), false);

  assert.equal(tracker.rememberFrom({
    status: "done",
    chatId: null,
    runId: "run-2"
  }, {
    chatId: "chat-agent"
  }), true);

  assert.equal(tracker.isDismissedCompletionEvent({
    type: "run.complete",
    chatId: "chat-other",
    runId: "run-2"
  }), false);
  assert.equal(tracker.isDismissedCompletionEvent({
    type: "done",
    chatId: "chat-agent",
    runId: "run-2"
  }), true);

  assert.equal(tracker.clear("chat-missing", "run-2"), true);
  assert.equal(tracker.isDismissedChat("chat-agent"), false);
});

test("desktop pet active run tracker updates idempotently and combines task-board runs", () => {
  const tracker = createDesktopPetActiveRunTracker();

  assert.equal(tracker.getRunningTaskCount({ fallbackRunning: false }), 0);
  assert.equal(tracker.update({ type: "run.started", runId: "run-1" }), true);
  assert.equal(tracker.update({ type: "run.started", runId: "run-1" }), false);
  assert.equal(tracker.update({ type: "run.start", data: { runId: "run-2" } }), true);

  assert.deepEqual(tracker.getActiveRunIds().sort(), ["run-1", "run-2"]);
  assert.equal(tracker.getRunningTaskCount({
    taskBoardRunIds: ["run-2", "run-3"],
    fallbackRunning: false
  }), 2);

  assert.equal(tracker.update({ type: "run.finished", runId: "run-1" }), true);
  assert.equal(tracker.clear(), true);
  assert.equal(tracker.clear(), false);
  assert.equal(tracker.getRunningTaskCount({ fallbackRunning: true }), 1);
});

test("desktop pet active tasks are built from all navigation agents with awaiting first", () => {
  const tasks = createDesktopPetActiveTasksFromNavigationSnapshot({
    ok: true,
    items: [
      {
        agentKey: "writer",
        displayName: "写作助手",
        updatedAt: "2026-06-10T10:00:00.000Z",
        recentChats: [
          {
            chatId: "chat-running",
            chatName: "整理周报",
            agentKey: "writer",
            updatedAt: "2026-06-10T10:00:00.000Z",
            lastRunId: "run-1",
            lastRunContent: "思考中",
            isRead: true,
            hasActiveRun: true,
            hasPendingAwaiting: false
          }
        ]
      },
      {
        agentKey: "coder",
        displayName: "开发助手",
        updatedAt: "2026-06-10T09:00:00.000Z",
        recentChats: [
          {
            chatId: "chat-awaiting",
            chatName: "",
            agentKey: "coder",
            updatedAt: "2026-06-10T09:00:00.000Z",
            lastRunId: "run-2",
            lastRunContent: "需要确认发布计划",
            isRead: true,
            hasActiveRun: true,
            hasPendingAwaiting: true,
            awaitingMode: "plan"
          },
          {
            chatId: "chat-idle",
            chatName: "已完成任务",
            agentKey: "coder",
            updatedAt: "2026-06-10T11:00:00.000Z",
            lastRunId: "",
            lastRunContent: "done",
            isRead: false,
            hasActiveRun: false,
            hasPendingAwaiting: false
          }
        ]
      }
    ]
  });

  assert.deepEqual(tasks.map((task) => task.id), ["coder:chat-awaiting", "writer:chat-running"]);
  assert.equal(tasks[0].status, "awaiting");
  assert.equal(tasks[0].awaitingMode, "plan");
  assert.equal(tasks[0].title, "需要确认发布计划");
  assert.equal(tasks[0].agentDisplayName, "开发助手");
  assert.equal(tasks[1].title, "整理周报");
  assert.equal(tasks[1].preview, "");
});

test("desktop pet active tasks are empty for unavailable navigation snapshots", () => {
  assert.deepEqual(createDesktopPetActiveTasksFromNavigationSnapshot(null), []);
  assert.deepEqual(createDesktopPetActiveTasksFromNavigationSnapshot({ ok: false, items: [] }), []);
});

test("desktop pet state refresh applies local patches and reports settings persistence changes", () => {
  const result = computeDesktopPetStateRefresh({
    settings: {
      enabled: true,
      lastVisible: false,
      unreadCount: 0,
      boundAgentKey: "zenmi",
      appearanceId: "dario"
    },
    supported: true,
    visible: true,
    localStatus: {
      status: "idle",
      hint: "",
      unreadCount: 0,
      chatId: null
    },
    patch: {
      status: "running",
      unreadCount: 2,
      chatId: "chat-1"
    },
    agentStatus: null,
    agentOptions: [],
    activeTasks: [{
      id: "zenmi:chat-1",
      agentKey: "zenmi",
      agentDisplayName: "小宅",
      chatId: "chat-1",
      runId: "run-1",
      title: "整理项目",
      preview: "",
      status: "running",
      updatedAt: "2026-06-10T00:00:00.000Z"
    }],
    previewPanel: null,
    runningTaskCount: 1,
    edgeDock: "top"
  });

  assert.deepEqual(result.localStatus, {
    status: "running",
    hint: "",
    unreadCount: 2,
    chatId: "chat-1"
  });
  assert.equal(result.state.status, "running");
  assert.equal(result.state.visible, true);
  assert.equal(result.state.runningTaskCount, 1);
  assert.equal(result.state.activeTasks[0].title, "整理项目");
  assert.equal(result.state.edgeDock, "top");
  assert.deepEqual(result.settingsPatch, {
    unreadCount: 2,
    lastVisible: true
  });
});

test("desktop pet state refresh skips persistence when unread and visibility are unchanged", () => {
  const result = computeDesktopPetStateRefresh({
    settings: {
      enabled: true,
      lastVisible: true,
      unreadCount: 0,
      boundAgentKey: "zenmi",
      appearanceId: "dario"
    },
    supported: true,
    visible: true,
    localStatus: {
      status: "idle",
      hint: "",
      unreadCount: 0,
      chatId: null
    },
    agentStatus: null,
    agentOptions: [],
    previewPanel: null,
    runningTaskCount: 0,
    edgeDock: null
  });

  assert.equal(result.state.status, "idle");
  assert.equal(result.settingsPatch, null);
});

test("desktop pet window mode resolves drag, preview and bubble states", () => {
  assert.equal(resolveDesktopPetWindowMode({
    dragging: true,
    state: { status: "idle", hint: "", messagePreview: "", unreadCount: 0 },
    previewPanel: null
  }), "base");

  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: { status: "idle", hint: "", messagePreview: "", unreadCount: 0 },
    previewPanel: { visible: true, expanded: false }
  }), "preview-collapsed");

  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: { status: "idle", hint: "", messagePreview: "", unreadCount: 0 },
    previewPanel: { visible: true, expanded: true }
  }), "preview-expanded");

  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: { status: "idle", hint: "", messagePreview: "new reply", unreadCount: 0 },
    previewPanel: null
  }), "bubble");

  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: { status: "running", hint: "", messagePreview: "", unreadCount: 0 },
    previewPanel: null
  }), "bubble");

  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: { status: "idle", hint: "", messagePreview: "", unreadCount: 0 },
    previewPanel: null
  }), "base");

  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: { status: "idle", hint: "", messagePreview: "", unreadCount: 0, activeTasks: [{ id: "task-1" }] },
    previewPanel: { visible: true, expanded: true }
  }), "task-list");
});

test("desktop pet idle reset action describes preview clearing and idle patch", () => {
  assert.deepEqual(createDesktopPetIdleResetAction(false), {
    clearPreview: false,
    rememberDismissedDonePreview: false,
    patch: {
      status: "idle",
      hint: "",
      unreadCount: 0
    }
  });

  assert.deepEqual(createDesktopPetIdleResetAction(true), {
    clearPreview: true,
    rememberDismissedDonePreview: true,
    patch: {
      status: "idle",
      hint: "",
      unreadCount: 0
    }
  });
});

test("desktop pet bounds update skips unchanged bounds and arms a guard for programmatic moves", () => {
  const currentBounds = { x: 10, y: 20, width: 176, height: 198 };

  assert.deepEqual(computeDesktopPetBoundsUpdate({
    currentBounds,
    nextBounds: { x: 10, y: 20, width: 176, height: 198 }
  }), {
    clearPendingGuard: true,
    pendingSignature: null,
    setBounds: null
  });

  assert.deepEqual(computeDesktopPetBoundsUpdate({
    currentBounds,
    nextBounds: { x: 40, y: 50, width: 224, height: 228 }
  }), {
    clearPendingGuard: false,
    pendingSignature: "40:50:224:228",
    setBounds: { x: 40, y: 50, width: 224, height: 228 }
  });
});

test("desktop pet position persistence ignores programmatic bounds echoes and saves user moves", () => {
  const bounds = { x: 40, y: 50, width: 224, height: 228 };

  assert.deepEqual(computeDesktopPetPositionPersistence({
    bounds,
    mode: "bubble",
    pendingSignature: "40:50:224:228",
    currentPosition: { x: 0, y: 0 }
  }), {
    clearPendingGuard: true,
    position: null,
    shouldPersist: false
  });

  assert.deepEqual(computeDesktopPetPositionPersistence({
    bounds,
    mode: "bubble",
    pendingSignature: "1:2:3:4",
    currentPosition: { x: 0, y: 0 }
  }), {
    clearPendingGuard: false,
    position: null,
    shouldPersist: false
  });

  assert.deepEqual(computeDesktopPetPositionPersistence({
    bounds,
    mode: "bubble",
    pendingSignature: null,
    currentPosition: { x: 88, y: 80 }
  }), {
    clearPendingGuard: false,
    position: null,
    shouldPersist: false
  });

  assert.deepEqual(computeDesktopPetPositionPersistence({
    bounds,
    mode: "bubble",
    pendingSignature: null,
    currentPosition: { x: 0, y: 0 }
  }), {
    clearPendingGuard: false,
    position: { x: 88, y: 80 },
    shouldPersist: true
  });
});

test("createDesktopPetDragController manages drag states and snaps user moves correctly", () => {
  let savedSettings = null;
  let windowBounds = { x: 100, y: 100, width: 176, height: 198 };
  let windowDestroyed = false;
  let moves = 0;
  let cursorPoint = { x: 200, y: 200 };
  let refreshed = 0;
  let persisted = null;

  const mockWindow = {
    isDestroyed: () => windowDestroyed,
    getBounds: () => windowBounds,
    setBounds: (b) => { windowBounds = b; },
    moveTop: () => { moves++; }
  };

  const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };

  let tickCallback = null;
  const mockSetInterval = (cb) => {
    tickCallback = cb;
    return 123;
  };
  const mockClearInterval = (id) => {
    assert.equal(id, 123);
    tickCallback = null;
  };

  const controller = createDesktopPetDragController({
    platform: "win32",
    getWindow: () => mockWindow,
    getSettings: () => ({ position: { x: 100, y: 100 } }),
    saveSettings: (s) => { savedSettings = s; },
    getMode: () => "base",
    getCursorScreenPoint: () => cursorPoint,
    getDisplayBounds: () => displayBounds,
    getPointDisplayBounds: () => displayBounds,
    persistPosition: (mode) => { persisted = mode; },
    refreshState: () => { refreshed++; },
    setInterval: mockSetInterval,
    clearInterval: mockClearInterval,
    forceEndMs: 1000
  });

  assert.equal(controller.isDragging(), false);

  // begin drag
  const beginRes = controller.beginDrag({ x: 200, y: 200 });
  assert.deepEqual(beginRes, { ok: true });
  assert.equal(controller.isDragging(), true);
  assert.equal(refreshed, 1);

  // move less than threshold
  cursorPoint = { x: 202, y: 202 };
  tickCallback();
  assert.equal(moves, 0); // No move call yet

  // move greater than threshold
  cursorPoint = { x: 205, y: 200 };
  tickCallback();
  assert.ok(moves > 0);
  assert.equal(windowBounds.x, 105);

  // end drag
  const endRes = controller.endDrag();
  assert.equal(endRes.ok, true);
  assert.equal(endRes.moved, true);
  assert.equal(controller.isDragging(), false);
  assert.equal(persisted, "base");
});

test("createDesktopPetDragController handles force end timeout", () => {
  let windowBounds = { x: 100, y: 100, width: 176, height: 198 };
  const mockWindow = {
    isDestroyed: () => false,
    getBounds: () => windowBounds,
    setBounds: (b) => { windowBounds = b; },
    moveTop: () => {}
  };
  const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  let tickCallback = null;

  const controller = createDesktopPetDragController({
    platform: "win32",
    getWindow: () => mockWindow,
    getSettings: () => ({ position: { x: 100, y: 100 } }),
    saveSettings: () => {},
    getMode: () => "base",
    getCursorScreenPoint: () => ({ x: 200, y: 200 }),
    getDisplayBounds: () => displayBounds,
    getPointDisplayBounds: () => displayBounds,
    persistPosition: () => {},
    refreshState: () => {},
    setInterval: (cb) => { tickCallback = cb; return 999; },
    clearInterval: () => { tickCallback = null; },
    forceEndMs: -1 // triggers force end immediately
  });

  controller.beginDrag({ x: 200, y: 200 });
  assert.equal(controller.isDragging(), true);

  tickCallback();
  assert.equal(controller.isDragging(), false); // Ended automatically
});

test("createDesktopPetWindowController handles unsupported platform", () => {
  let refreshed = 0;
  const controller = createDesktopPetWindowController({
    platform: "linux",
    createWindow: () => { assert.fail("Should not call createWindow on linux"); },
    getSettings: () => ({ enabled: false, lastVisible: false }),
    saveSettings: () => {},
    getMode: () => "base",
    getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    isHandlingQuit: () => false,
    loadRendererRoute: async () => {},
    buildContextMenu: () => {},
    startStatusClient: () => {},
    stopStatusClient: () => {},
    endDrag: () => {},
    clearIdleResetTimer: () => {},
    clearPreviewRefreshTimer: () => {},
    clearPreview: () => {},
    refreshState: () => { refreshed++; return { state: "refreshed" }; },
    setMouseInteractive: () => {}
  });

  assert.equal(controller.getWindow(), null);
  assert.equal(controller.createWindow(), null);
  assert.deepEqual(controller.showWindow(), { state: "refreshed" });
  assert.equal(refreshed, 1);
});

test("createDesktopPetWindowController manages window show and hide lifecycles on supported platform", () => {
  let settings = { enabled: false, lastVisible: false };
  let savedSettings = null;
  let clientStarted = false;
  let clientStopped = false;
  let routeLoaded = null;
  let dragEnded = false;
  let refreshed = 0;
  let menuBuilt = false;
  let interactive = null;
  let windowCreated = 0;

  const eventListeners = {};
  const mockWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    showInactive: () => {},
    moveTop: () => {},
    hide: () => {},
    setBounds: () => {},
    getBounds: () => ({ x: 100, y: 100, width: 176, height: 198 }),
    on: (event, cb) => { eventListeners[event] = cb; },
    webContents: {
      on: (event, cb) => { eventListeners[`wc-${event}`] = cb; }
    }
  };

  const controller = createDesktopPetWindowController({
    platform: "win32",
    createWindow: () => { windowCreated++; return mockWindow; },
    getSettings: () => settings,
    saveSettings: (s) => { savedSettings = s; settings = { ...settings, ...s }; },
    getMode: () => "base",
    getBounds: () => ({ x: 100, y: 100, width: 176, height: 198 }),
    isHandlingQuit: () => false,
    loadRendererRoute: async (win, route) => { routeLoaded = route; },
    buildContextMenu: () => { menuBuilt = true; return { popup: () => {} }; },
    startStatusClient: () => { clientStarted = true; },
    stopStatusClient: () => { clientStopped = true; },
    endDrag: () => { dragEnded = true; },
    clearIdleResetTimer: () => {},
    clearPreviewRefreshTimer: () => {},
    clearPreview: () => {},
    refreshState: () => { refreshed++; return { state: "refreshed" }; },
    setMouseInteractive: (val) => { interactive = val; }
  });

  // showWindow
  const state = controller.showWindow();
  assert.deepEqual(state, { state: "refreshed" });
  assert.equal(windowCreated, 1);
  assert.equal(routeLoaded, "/desktop-pet");
  assert.equal(clientStarted, true);
  assert.deepEqual(savedSettings, { enabled: true, lastVisible: true });
  assert.equal(controller.isVisible(), true);

  // trigger window close event
  let prevented = false;
  eventListeners["close"]({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(clientStopped, true); // hide flow disables and stops status client

  // trigger window closed event
  eventListeners["closed"]();
  assert.equal(controller.getWindow(), null);
  assert.equal(controller.isVisible(), false);
});

test("createDesktopPetClientLifecycleController handles unsupported platform", () => {
  let statusClientInstantiated = false;
  class MockStatusClient {
    constructor() {
      statusClientInstantiated = true;
    }
  }
  const controller = createDesktopPetClientLifecycleController({
    platform: "linux",
    app: {},
    AgentStatusClientClass: MockStatusClient,
    AgentStreamClientClass: class {},
    getServiceState: async () => {},
    issueAccessToken: async () => {},
    getSettings: () => ({ enabled: true, boundAgentKey: "agent-1" }),
    setAgentStatus: () => {},
    setAgentOptions: () => {},
    clearActiveRuns: () => {},
    updateActiveRuns: () => {},
    clearDismissedPreview: () => {},
    getPreviewPanel: () => null,
    ingestAgentEvent: () => {},
    refreshCompletedPreviewFromStatus: () => false,
    refreshState: () => {}
  });

  assert.equal(controller.ensureStatusClient(), null);
  assert.equal(controller.ensureStreamClient(), null);
  assert.equal(statusClientInstantiated, false);
});

test("createDesktopPetClientLifecycleController manages start and stop lifecycle", () => {
  let settings = { enabled: false, boundAgentKey: "agent-1" };
  let startCalled = 0;
  let stopCalled = 0;
  let scheduleRefreshCalled = 0;
  let scheduleRefreshDelay = null;

  class MockStatusClient {
    start() { startCalled++; }
    stop() { stopCalled++; }
    scheduleRefresh(delayMs) {
      scheduleRefreshCalled++;
      scheduleRefreshDelay = delayMs;
    }
  }

  let agentStatus = "initial";
  let agentOptions = ["initial"];
  let activeRunsCleared = false;

  const controller = createDesktopPetClientLifecycleController({
    platform: "win32",
    app: {},
    AgentStatusClientClass: MockStatusClient,
    AgentStreamClientClass: class { stop() {} },
    getServiceState: async () => {},
    issueAccessToken: async () => {},
    getSettings: () => settings,
    setAgentStatus: (status) => { agentStatus = status; },
    setAgentOptions: (options) => { agentOptions = options; },
    clearActiveRuns: () => { activeRunsCleared = true; },
    updateActiveRuns: () => {},
    clearDismissedPreview: () => {},
    getPreviewPanel: () => null,
    ingestAgentEvent: () => {},
    refreshCompletedPreviewFromStatus: () => false,
    refreshState: () => {}
  });

  // Since enabled is false, startStatusClient should NOT start status client
  controller.startStatusClient();
  assert.equal(controller.getStatusClient(), null);
  assert.equal(startCalled, 0);

  // Now enable the pet settings
  settings.enabled = true;

  // Start lifecycle should instantiate status client and call start()
  controller.startStatusClient();
  const statusClient = controller.getStatusClient();
  assert.ok(statusClient instanceof MockStatusClient);
  assert.equal(startCalled, 1);

  // Calling scheduleStatusRefresh should delegate to the status client
  controller.scheduleStatusRefresh(456);
  assert.equal(scheduleRefreshCalled, 1);
  assert.equal(scheduleRefreshDelay, 456);

  // stopStatusClient should stop client and reset status/options
  controller.stopStatusClient();
  assert.equal(stopCalled, 1);
  assert.equal(controller.getStatusClient(), null);
  assert.equal(agentStatus, null);
  assert.deepEqual(agentOptions, []);
  assert.equal(activeRunsCleared, true);
});

test("createDesktopPetClientLifecycleController propagates callbacks", () => {
  let agentStatus = null;
  let agentOptions = null;
  let activeRunsCleared = false;
  let activeRunsUpdated = null;
  let dismissedPreviewCleared = null;
  let previewPanel = { chatId: "chat-123", runId: "run-123" };
  let ingestedAgentEvent = null;
  let ingestedContext = null;
  let refreshCompletedPreviewCalled = null;
  let refreshedState = 0;
  let streamAttached = null;

  let savedOnStatus = null;
  let savedOnAgents = null;
  let savedOnRunStarted = null;
  let savedOnRunFinished = null;

  class MockStatusClient {
    constructor(opts) {
      savedOnStatus = opts.onStatus;
      savedOnAgents = opts.onAgents;
      savedOnRunStarted = opts.onRunStarted;
      savedOnRunFinished = opts.onRunFinished;
    }
    start() {}
  }

  class MockStreamClient {
    constructor(opts) {
      this.onEvent = opts.onEvent;
    }
    attach(runId, chatId) {
      streamAttached = { runId, chatId };
    }
  }

  let streamClientInstance = null;
  const controller = createDesktopPetClientLifecycleController({
    platform: "win32",
    app: {},
    AgentStatusClientClass: MockStatusClient,
    AgentStreamClientClass: class extends MockStreamClient {
      constructor(opts) {
        super(opts);
        streamClientInstance = this;
      }
    },
    getServiceState: async () => {},
    issueAccessToken: async () => {},
    getSettings: () => ({ enabled: true, boundAgentKey: "agent-initial" }),
    setAgentStatus: (status) => { agentStatus = status; },
    setAgentOptions: (options) => { agentOptions = options; },
    clearActiveRuns: () => { activeRunsCleared = true; },
    updateActiveRuns: (event) => { activeRunsUpdated = event; },
    clearDismissedPreview: (chatId, runId) => { dismissedPreviewCleared = { chatId, runId }; },
    getPreviewPanel: () => previewPanel,
    ingestAgentEvent: (event, context) => { ingestedAgentEvent = event; ingestedContext = context; },
    refreshCompletedPreviewFromStatus: (status) => {
      refreshCompletedPreviewCalled = status;
      return status === "should-skip-refresh";
    },
    refreshState: () => { refreshedState++; }
  });

  // Instantiate status client by starting it
  controller.startStatusClient();
  // Ensure stream client is instantiated
  controller.ensureStreamClient();

  assert.ok(savedOnStatus);
  assert.ok(savedOnAgents);
  assert.ok(savedOnRunStarted);
  assert.ok(savedOnRunFinished);

  // 1. Test onStatus normal
  savedOnStatus("status-ok");
  assert.equal(agentStatus, "status-ok");
  assert.equal(refreshedState, 1);

  // 2. Test onStatus null (should clear active runs)
  savedOnStatus(null);
  assert.equal(agentStatus, null);
  assert.equal(activeRunsCleared, true);

  // 3. Test onStatus returns true for skip refresh
  refreshedState = 0;
  savedOnStatus("should-skip-refresh");
  assert.equal(refreshedState, 0); // did not increment because of return in onStatus

  // 4. Test onAgents
  savedOnAgents(["agent-opt-1"]);
  assert.deepEqual(agentOptions, ["agent-opt-1"]);
  assert.equal(refreshedState, 1);

  // 5. Test onRunStarted
  savedOnRunStarted({ runId: "run-started-1", chatId: "chat-started-1" });
  assert.deepEqual(activeRunsUpdated, { type: "run.started", runId: "run-started-1" });
  assert.deepEqual(dismissedPreviewCleared, { chatId: "chat-started-1", runId: "run-started-1" });
  assert.deepEqual(streamAttached, { runId: "run-started-1", chatId: "chat-started-1" });

  // 6. Test onRunFinished
  savedOnRunFinished({ runId: "run-finished-1", chatId: "chat-finished-1", message: "finished message" });
  assert.deepEqual(activeRunsUpdated, { type: "run.finished", runId: "run-finished-1" });
  assert.equal(ingestedAgentEvent.runId, "run-finished-1");
  assert.equal(ingestedAgentEvent.chatId, "chat-finished-1");
  assert.equal(ingestedAgentEvent.message, "finished message");
  assert.deepEqual(ingestedContext, { source: "agent-platform-status", transportMode: "ws" });

  // 7. Test stream event ingestion
  assert.ok(streamClientInstance);
  streamClientInstance.onEvent("sse-event");
  assert.equal(ingestedAgentEvent, "sse-event");
  assert.deepEqual(ingestedContext, { source: "agent-platform-attach", transportMode: "sse" });
});

test("createDesktopPetPreviewController handles unsupported platform", () => {
  let projectCalled = 0;
  const mockProjector = {
    ingest: () => { projectCalled++; return { changed: true }; }
  };
  const controller = createDesktopPetPreviewController({
    platform: "linux",
    previewProjector: mockProjector,
    dismissalTracker: {},
    activeRunTracker: {},
    getAgentStatus: () => null,
    scheduleIdleReset: () => {},
    clearIdleResetTimer: () => {},
    refreshState: () => {}
  });

  controller.ingestAgentEvent({ type: "some-event" });
  assert.equal(projectCalled, 0);

  const res = controller.dismissPreview();
  assert.deepEqual(res, { ok: false });
});

test("createDesktopPetPreviewController dismissPreview behavior", () => {
  let clearedIdleReset = false;
  let clearedPreview = false;
  let rememberedFrom = null;
  let refreshedState = null;

  const mockProjector = {
    getPanel: () => ({ status: "done", chatId: "chat-1", runId: "run-1" }),
    clear: () => { clearedPreview = true; }
  };
  const mockDismissalTracker = {
    rememberFrom: (panel, status) => { rememberedFrom = { panel, status }; }
  };

  const controller = createDesktopPetPreviewController({
    platform: "win32",
    previewProjector: mockProjector,
    dismissalTracker: mockDismissalTracker,
    activeRunTracker: {},
    getAgentStatus: () => "agent-status-mock",
    scheduleIdleReset: () => {},
    clearIdleResetTimer: () => { clearedIdleReset = true; },
    refreshState: (patch) => { refreshedState = patch; }
  });

  const res = controller.dismissPreview();
  assert.deepEqual(res, { ok: true });
  assert.equal(clearedIdleReset, true);
  assert.equal(clearedPreview, true);
  assert.deepEqual(rememberedFrom, {
    panel: { status: "done", chatId: "chat-1", runId: "run-1" },
    status: "agent-status-mock"
  });
  assert.deepEqual(refreshedState, {
    status: "idle",
    hint: "",
    unreadCount: 0,
    chatId: null
  });
});

test("createDesktopPetPreviewController ingestAgentEvent behavior", () => {
  let clearedDismissed = null;
  let activeRunUpdated = null;
  let ingestedEvent = null;
  let ingestedMeta = null;
  let scheduledIdleReset = null;
  let clearedIdleReset = false;
  let refreshedState = null;
  let timerCb = null;

  const mockDismissalTracker = {
    clear: (chatId, runId) => { clearedDismissed = { chatId, runId }; },
    isDismissedCompletionEvent: (e) => e?.type === "dismissed"
  };

  const mockActiveRunTracker = {
    update: (e) => { activeRunUpdated = e; }
  };

  let mockProjectResult = { changed: true, holdMs: 0, refresh: "immediate", panel: { status: "stopped", chatId: "chat-1" } };
  let currentPanel = { status: "stopped", chatId: "chat-1" };
  const mockProjector = {
    ingest: (e, m) => {
      ingestedEvent = e;
      ingestedMeta = m;
      currentPanel = mockProjectResult.panel;
      return mockProjectResult;
    },
    getPanel: () => currentPanel
  };

  const controller = createDesktopPetPreviewController({
    platform: "win32",
    previewProjector: mockProjector,
    dismissalTracker: mockDismissalTracker,
    activeRunTracker: mockActiveRunTracker,
    getAgentStatus: () => null,
    scheduleIdleReset: (holdMs, force) => { scheduledIdleReset = { holdMs, force }; },
    clearIdleResetTimer: () => { clearedIdleReset = true; },
    refreshState: (patch) => { refreshedState = patch; },
    setTimeout: (cb) => { timerCb = cb; return 99; },
    clearTimeout: () => { timerCb = null; }
  });

  // 1. Test query event clears dismissal
  controller.ingestAgentEvent({ type: "request.query", chatId: "chat-1", runId: "run-1" }, { source: "src" });
  assert.deepEqual(clearedDismissed, { chatId: "chat-1", runId: "run-1" });
  assert.equal(activeRunUpdated.type, "request.query");
  assert.equal(activeRunUpdated.chatId, "chat-1");
  assert.equal(activeRunUpdated.runId, "run-1");
  assert.equal(ingestedEvent.type, "request.query");
  assert.equal(ingestedEvent.chatId, "chat-1");
  assert.equal(ingestedEvent.runId, "run-1");
  assert.deepEqual(ingestedMeta, { source: "src" });
  assert.equal(clearedIdleReset, true);
  assert.deepEqual(refreshedState, { status: "idle", hint: "", chatId: "chat-1", unreadCount: 0 });

  // 2. Test dismissed event skips
  clearedDismissed = null;
  activeRunUpdated = null;
  ingestedEvent = null;
  controller.ingestAgentEvent({ type: "dismissed", runId: "run-1" });
  assert.equal(ingestedEvent, null); // skipped

  // 3. Test holdMs triggers scheduleIdleReset
  mockProjectResult = { changed: true, holdMs: 5000, refresh: "immediate", panel: { status: "waiting", chatId: "chat-1" } };
  controller.ingestAgentEvent({ type: "some-event", runId: "run-1" });
  assert.deepEqual(scheduledIdleReset, { holdMs: 5000, force: true });
  assert.deepEqual(refreshedState, { status: "awaiting", hint: "思考中", chatId: "chat-1", unreadCount: 0 });

  // 4. Test throttled refresh uses setTimeout
  mockProjectResult = { changed: true, holdMs: 0, refresh: "throttled", panel: { status: "done", chatId: "chat-1", summary: "text" } };
  refreshedState = null;
  controller.ingestAgentEvent({ type: "some-event", runId: "run-1" });
  assert.ok(timerCb);
  assert.equal(refreshedState, null); // not refreshed yet

  timerCb(); // trigger throttle timer
  assert.deepEqual(refreshedState, { status: "done", hint: "text", chatId: "chat-1", unreadCount: 0 });
});

test("createDesktopPetPreviewController refreshCompletedPreviewFromAgentStatus behavior", () => {
  let ingestedEvent = null;

  const mockDismissalTracker = {
    isDismissedChat: (chatId) => chatId === "dismissed-chat",
    isDismissedCompletionEvent: () => false,
    clear: () => {}
  };

  let mockPanel = { status: "done", chatId: "chat-1", runId: "run-1", title: "old-title", summary: "old-summary" };
  const mockProjector = {
    getPanel: () => mockPanel,
    ingest: (e) => { ingestedEvent = e; return { changed: true, panel: mockPanel }; }
  };

  const controller = createDesktopPetPreviewController({
    platform: "win32",
    previewProjector: mockProjector,
    dismissalTracker: mockDismissalTracker,
    activeRunTracker: { update: () => {} },
    getAgentStatus: () => null,
    scheduleIdleReset: () => {},
    clearIdleResetTimer: () => {},
    refreshState: () => {}
  });

  // 1. stale status returns false
  assert.equal(controller.refreshCompletedPreviewFromAgentStatus({ stale: true, presence: "away", latestPreview: "new text", chatId: "chat-1" }), false);

  // 2. presence not away returns false
  assert.equal(controller.refreshCompletedPreviewFromAgentStatus({ stale: false, presence: "available", latestPreview: "new text", chatId: "chat-1" }), false);

  // 3. dismissed chat returns false
  assert.equal(controller.refreshCompletedPreviewFromAgentStatus({ stale: false, presence: "away", latestPreview: "new text", chatId: "dismissed-chat" }), false);

  // 4. generic preview returns false
  assert.equal(controller.refreshCompletedPreviewFromAgentStatus({ stale: false, presence: "away", latestPreview: "思考中", chatId: "chat-1" }), false);

  // 5. different chat id returns false
  assert.equal(controller.refreshCompletedPreviewFromAgentStatus({ stale: false, presence: "away", latestPreview: "new text", chatId: "chat-different" }), false);

  // 6. matching title and summary returns false
  mockPanel.title = "new text";
  mockPanel.summary = "new text";
  assert.equal(controller.refreshCompletedPreviewFromAgentStatus({ stale: false, presence: "away", latestPreview: "new text", chatId: "chat-1" }), false);

  // 7. normal status returns true and triggers ingestAgentEvent
  mockPanel.title = "old-title";
  mockPanel.summary = "old-summary";
  assert.equal(controller.refreshCompletedPreviewFromAgentStatus({ stale: false, presence: "away", latestPreview: "new text", chatId: "chat-1" }), true);
  assert.equal(ingestedEvent.type, "run.complete");
  assert.equal(ingestedEvent.message, "new text");
  assert.equal(ingestedEvent.chatId, "chat-1");
  assert.equal(ingestedEvent.runId, "run-1");
});
