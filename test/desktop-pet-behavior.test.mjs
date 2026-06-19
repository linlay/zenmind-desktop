import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  createDesktopPetState,
  createDefaultDesktopPetLocalStatus,
  getDesktopPetContextMenuItems,
  listUserDesktopPetAppearanceOptions,
  __testInternals
} = require("../dist-electron/main/assistant/pet/desktop-pet.js");
const {
  createDesktopPetMessagesFromAgentStatus,
  createDesktopPetMessagesFromNavigationSnapshot,
  createDesktopPetActiveTasksFromNavigationSnapshot,
  createDesktopPetDragController,
  resolveDesktopPetWindowMode
} = require("../dist-electron/main/desktop-pet-controller.js");
const { getDesktopPetsDataRoot } = require("../dist-electron/main/user-paths.js");
const { APP_BRAND } = require("../dist-electron/shared/generated/brand.js");
const {
  DEFAULT_DESKTOP_PET_BUILTIN_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DEFAULT_DESKTOP_PET_DESCRIPTION,
  DEFAULT_DESKTOP_PET_DISPLAY_NAME,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  DESKTOP_PET_USER_ASSET_PROTOCOL,
  resolveDesktopPetSignatureActions
} = require("../dist-electron/shared/desktop-pet.js");

function createApp(root) {
  return {
    getPath(name) {
      if (name === "home") return path.join(root, "home");
      if (name === "desktop") return path.join(root, "home", "Desktop");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "userData") return path.join(root, "user-data");
      if (name === "temp") return path.join(root, "temp");
      throw new Error(`unexpected getPath(${name})`);
    }
  };
}

function createSettings(overrides = {}) {
  return {
    enabled: true,
    unreadCount: 0,
    boundAgentKey: "zenmi",
    appearanceId: "classic",
    ...overrides
  };
}

function createAgentStatus(overrides = {}) {
  return {
    agentKey: "zenmi",
    displayName: "小宅",
    role: "assistant",
    presence: "busy",
    unreadCount: 0,
    latestPreview: "",
    chatId: "chat-1",
    hasPendingAwaiting: false,
    stale: false,
    updatedAt: "2026-06-13T00:00:00.000Z",
    ...overrides
  };
}

function visibleFootprintRect(bounds, footprint) {
  return {
    x: bounds.x + footprint.x,
    y: bounds.y + footprint.y,
    width: footprint.width,
    height: footprint.height
  };
}

function visibleFootprintCenter(bounds, footprint) {
  return {
    x: bounds.x + footprint.x + Math.round(footprint.width / 2),
    y: bounds.y + footprint.y + Math.round(footprint.height / 2)
  };
}

function edgeAdjustedFootprint(mode, position, displayArea, internals) {
  const {
    DESKTOP_PET_VISIBLE_FOOTPRINT,
    DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
    DESKTOP_PET_WINDOW_SIZES
  } = internals;
  const footprint = {
    ...DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS[mode]
  };
  if (mode === "base") {
    return footprint;
  }
  const visibleLeft = position.x + DESKTOP_PET_VISIBLE_FOOTPRINT.x;
  const visibleTop = position.y + DESKTOP_PET_VISIBLE_FOOTPRINT.y;
  const visibleRight = visibleLeft + DESKTOP_PET_VISIBLE_FOOTPRINT.width;
  const visibleBottom = visibleTop + DESKTOP_PET_VISIBLE_FOOTPRINT.height;
  if (visibleLeft <= displayArea.x) {
    footprint.x = DESKTOP_PET_VISIBLE_FOOTPRINT.x;
  } else if (visibleRight >= displayArea.x + displayArea.width) {
    footprint.x = DESKTOP_PET_WINDOW_SIZES[mode].width - DESKTOP_PET_VISIBLE_FOOTPRINT.width;
  }
  if (visibleTop <= displayArea.y) {
    footprint.y = DESKTOP_PET_VISIBLE_FOOTPRINT.y;
  } else if (visibleBottom >= displayArea.y + displayArea.height) {
    footprint.y = DESKTOP_PET_WINDOW_SIZES[mode].height - DESKTOP_PET_VISIBLE_FOOTPRINT.height;
  }
  return footprint;
}

function writeStrictUserPet(petRoot, overrides = {}) {
  fs.mkdirSync(path.join(petRoot, "signature"), { recursive: true });
  for (const fileName of [
    "idle.webp",
    "jumping.webp",
    "moving-left.webp",
    "dragging.webp",
    "done.webp",
    "failed.webp",
    "running.webp",
    "awaiting.webp",
    "review.webp"
  ]) {
    fs.writeFileSync(path.join(petRoot, fileName), "fake asset", "utf8");
  }
  fs.writeFileSync(path.join(petRoot, "signature", "dance.webp"), "fake webp", "utf8");
  const manifest = {
    id: "pony",
    displayName: "小凌",
    version: "1.0.0",
    description: "Strict user pet",
    preview: "idle.webp",
    states: {
      idle: { path: "idle.webp", frameCount: 4, durationMs: 6000, loop: true },
      jumping: { path: "jumping.webp", frameCount: 4, durationMs: 1000, loop: false },
      "moving-left": {
        path: "moving-left.webp",
        frameCount: 8,
        durationMs: 900,
        loop: true,
        mirror: true
      },
      dragging: { path: "dragging.webp", frameCount: 4, durationMs: 900, loop: true },
      done: { path: "done.webp", frameCount: 6, durationMs: 1200, loop: false, holdMs: 2500 },
      failed: { path: "failed.webp", frameCount: 4, durationMs: 1000, loop: false, holdMs: 3000 },
      running: { path: "running.webp", frameCount: 8, durationMs: 1600, loop: true },
      awaiting: { path: "awaiting.webp", frameCount: 4, durationMs: 1200, loop: true },
      review: { path: "review.webp", frameCount: 4, durationMs: 1400, loop: true }
    },
    signature: [
      {
        id: "dance",
        label: "跳舞",
        trigger: ["manual"],
        variants: [
          {
            path: "signature/dance.webp",
            frameCount: 30,
            durationMs: 5200
          }
        ]
      }
    ],
    ...overrides
  };
  fs.writeFileSync(path.join(petRoot, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("desktop pet state exposes awaiting when the bound agent has a pending awaiting prompt", () => {
  const state = createDesktopPetState(createSettings(), {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: createAgentStatus({
      presence: "busy",
      hasPendingAwaiting: true,
      latestPreview: "需要你确认计划"
    })
  });

  assert.equal(state.status, "awaiting");
  assert.equal(state.hint, "需要你确认计划");
});

test("desktop pet builds a message history item from bound agent status when navigation messages are empty", () => {
  const messages = createDesktopPetMessagesFromAgentStatus(createAgentStatus({
    presence: "available",
    unreadCount: 1,
    latestPreview: "这是上一条历史回复",
    chatId: "chat-history",
    updatedAt: "2026-06-17T00:00:00.000Z"
  }));

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    id: "zenmi:chat-history",
    chatId: "chat-history",
    runId: null,
    agentKey: "zenmi",
    agentDisplayName: "小宅",
    title: "小宅",
    preview: "这是上一条历史回复",
    status: "done",
    unread: true,
    updatedAt: "2026-06-17T00:00:00.000Z"
  });
});

test("desktop pet window modes keep the visible pet footprint anchored", () => {
  const {
    DESKTOP_PET_VISIBLE_FOOTPRINT,
    DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
    DESKTOP_PET_WINDOW_SIZES,
    getAnchoredDesktopPetBounds,
    getDesktopPetLogicalPositionFromBounds
  } = __testInternals;
  const displayArea = { x: 0, y: 0, width: 1440, height: 900 };
  const position = { x: 320, y: 240 };
  const baseBounds = getAnchoredDesktopPetBounds(position, displayArea, "base");

  for (const mode of Object.keys(DESKTOP_PET_WINDOW_SIZES)) {
    const modeBounds = getAnchoredDesktopPetBounds(position, displayArea, mode);
    assert.equal(modeBounds.width, DESKTOP_PET_WINDOW_SIZES[mode].width);
    assert.equal(modeBounds.height, DESKTOP_PET_WINDOW_SIZES[mode].height);
    assert.deepEqual(
      visibleFootprintRect(modeBounds, DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS[mode]),
      visibleFootprintRect(baseBounds, DESKTOP_PET_VISIBLE_FOOTPRINT)
    );
    assert.deepEqual(
      visibleFootprintCenter(modeBounds, DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS[mode]),
      visibleFootprintCenter(baseBounds, DESKTOP_PET_VISIBLE_FOOTPRINT)
    );
    assert.deepEqual(getDesktopPetLogicalPositionFromBounds(modeBounds, mode), {
      x: baseBounds.x,
      y: baseBounds.y
    });
  }
});

test("desktop pet window modes allow panels to overflow edges instead of moving the pet", () => {
	  const {
	    DESKTOP_PET_VISIBLE_FOOTPRINT,
	    DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
	    DESKTOP_PET_WINDOW_SIZES,
	    getAnchoredDesktopPetBounds,
	    getDesktopPetLogicalPositionFromBounds
	  } = __testInternals;
	  const displayArea = { x: 100, y: 80, width: 500, height: 400 };
  const edgePositions = [
    {
      x: displayArea.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x,
      y: displayArea.y
    },
    {
      x: displayArea.x + displayArea.width -
        DESKTOP_PET_VISIBLE_FOOTPRINT.x -
        DESKTOP_PET_VISIBLE_FOOTPRINT.width,
      y: displayArea.y
    },
    {
      x: displayArea.x + 180,
      y: displayArea.y
    },
	    {
	      x: displayArea.x + 180,
	      y: displayArea.y + displayArea.height -
	        DESKTOP_PET_VISIBLE_FOOTPRINT.y -
	        DESKTOP_PET_VISIBLE_FOOTPRINT.height
	    },
	    {
	      x: displayArea.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x,
	      y: displayArea.y + displayArea.height -
	        DESKTOP_PET_VISIBLE_FOOTPRINT.y -
	        DESKTOP_PET_VISIBLE_FOOTPRINT.height
	    },
	    {
	      x: displayArea.x + displayArea.width -
	        DESKTOP_PET_VISIBLE_FOOTPRINT.x -
	        DESKTOP_PET_VISIBLE_FOOTPRINT.width,
	      y: displayArea.y + displayArea.height -
	        DESKTOP_PET_VISIBLE_FOOTPRINT.y -
	        DESKTOP_PET_VISIBLE_FOOTPRINT.height
	    }
	  ];

  for (const position of edgePositions) {
	    const baseBounds = getAnchoredDesktopPetBounds(position, displayArea, "base");
	    const baseFootprint = visibleFootprintRect(baseBounds, DESKTOP_PET_VISIBLE_FOOTPRINT);
	    for (const mode of Object.keys(DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS)) {
	      const modeBounds = getAnchoredDesktopPetBounds(position, displayArea, mode);
	      const modeFootprint = edgeAdjustedFootprint(mode, baseBounds, displayArea, {
	        DESKTOP_PET_VISIBLE_FOOTPRINT,
	        DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
	        DESKTOP_PET_WINDOW_SIZES
	      });
	      assert.deepEqual(
	        visibleFootprintRect(modeBounds, modeFootprint),
	        baseFootprint
      );
      assert.deepEqual(getDesktopPetLogicalPositionFromBounds(modeBounds, mode, displayArea, baseBounds), {
        x: baseBounds.x,
        y: baseBounds.y
      });
    }
  }
});

test("desktop pet top-edge panels anchor below the pet instead of pushing the pet down", () => {
  const {
    DESKTOP_PET_VISIBLE_FOOTPRINT,
    DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
    getAnchoredDesktopPetBounds,
    getDesktopPetLogicalPositionFromBounds
  } = __testInternals;
  const displayArea = { x: 0, y: 25, width: 500, height: 400 };
  const position = { x: 180, y: displayArea.y - DESKTOP_PET_VISIBLE_FOOTPRINT.y };
  const baseBounds = getAnchoredDesktopPetBounds(position, displayArea, "base");
  const taskBounds = getAnchoredDesktopPetBounds(position, displayArea, "task-list");
  const topEdgeFootprint = {
    ...DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS["task-list"],
    y: DESKTOP_PET_VISIBLE_FOOTPRINT.y
  };

  assert.equal(taskBounds.y, displayArea.y - DESKTOP_PET_VISIBLE_FOOTPRINT.y);
  assert.deepEqual(
    visibleFootprintRect(taskBounds, topEdgeFootprint),
    visibleFootprintRect(baseBounds, DESKTOP_PET_VISIBLE_FOOTPRINT)
  );
  assert.deepEqual(getDesktopPetLogicalPositionFromBounds(taskBounds, "task-list", displayArea, position), position);
});

test("desktop pet drag keeps the press-time window mode instead of jumping to base bounds", () => {
  const {
    DESKTOP_PET_WINDOW_SIZES,
    DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
    getAnchoredDesktopPetBounds
  } = __testInternals;
  const displayArea = { x: 1920, y: 0, width: 1440, height: 900 };
  const initialPosition = { x: 2420, y: 300 };
  let bounds = getAnchoredDesktopPetBounds(initialPosition, displayArea, "bubble");
  let cursorPoint = {
    x: bounds.x + DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS.bubble.x +
      Math.round(DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS.bubble.width / 2),
    y: bounds.y + DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS.bubble.y +
      Math.round(DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS.bubble.height / 2)
  };
  const startPoint = { ...cursorPoint };
  const setBoundsCalls = [];
  const persistedModes = [];
  let intervalCallback = null;
  let getModeCalls = 0;
  const fakeWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ ...bounds }),
    setBounds: (nextBounds) => {
      bounds = { ...nextBounds };
      setBoundsCalls.push({ ...nextBounds });
    },
    moveTop: () => {}
  };

  const controller = createDesktopPetDragController({
    platform: "darwin",
    getWindow: () => fakeWindow,
    getSettings: () => ({}),
    saveSettings: () => {},
    getMode: () => {
      getModeCalls += 1;
      return getModeCalls === 1 ? "bubble" : "base";
    },
    getCursorScreenPoint: () => ({ ...cursorPoint }),
    getDisplayBounds: () => displayArea,
    getPointDisplayBounds: () => displayArea,
    persistPosition: (mode) => {
      persistedModes.push(mode);
    },
    refreshState: () => {},
    setInterval: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearInterval: () => {},
    forceEndMs: 100000
  });

  assert.deepEqual(controller.beginDrag(startPoint), { ok: true });
  assert.equal(setBoundsCalls.length, 0);

  cursorPoint = {
    x: startPoint.x + 24,
    y: startPoint.y + 10
  };
  intervalCallback();

  assert.equal(bounds.width, DESKTOP_PET_WINDOW_SIZES.bubble.width);
  assert.equal(bounds.height, DESKTOP_PET_WINDOW_SIZES.bubble.height);
  assert.deepEqual(controller.endDrag(), { ok: true, moved: true });
  assert.deepEqual(persistedModes, ["bubble"]);
});

test("desktop pet drag starts from the main-process cursor point instead of renderer screen coordinates", () => {
  const displayArea = { x: 0, y: 0, width: 1440, height: 900 };
  let bounds = { x: 320, y: 240, width: 176, height: 198 };
  const cursorPoint = { x: 402, y: 346 };
  const setBoundsCalls = [];
  let intervalCallback = null;
  const fakeWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ ...bounds }),
    setBounds: (nextBounds) => {
      bounds = { ...nextBounds };
      setBoundsCalls.push({ ...nextBounds });
    },
    moveTop: () => {}
  };

  const controller = createDesktopPetDragController({
    platform: "darwin",
    getWindow: () => fakeWindow,
    getSettings: () => ({}),
    saveSettings: () => {},
    getMode: () => "base",
    getCursorScreenPoint: () => ({ ...cursorPoint }),
    getDisplayBounds: () => displayArea,
    getPointDisplayBounds: () => displayArea,
    persistPosition: () => {},
    refreshState: () => {},
    setInterval: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearInterval: () => {},
    forceEndMs: 100000
  });

  assert.deepEqual(controller.beginDrag({ x: 9999, y: 9999 }), { ok: true });
  intervalCallback();

  assert.deepEqual(setBoundsCalls, []);
  assert.deepEqual(controller.endDrag(), { ok: true, moved: false });
});

test("desktop pet drag clamps the pet body instead of the expanded panel window", () => {
  const {
    DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
    getAnchoredDesktopPetBounds
  } = __testInternals;
  const displayArea = { x: 0, y: 0, width: 500, height: 400 };
  const initialPosition = { x: 360, y: 180 };
  let bounds = getAnchoredDesktopPetBounds(initialPosition, displayArea, "bubble");
  const currentPetLeft = bounds.x + DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS.bubble.x;
  const setBoundsCalls = [];
  const cursorPoint = {
    x: currentPetLeft + 48,
    y: bounds.y + DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS.bubble.y + 54
  };
  const fakeWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ ...bounds }),
    setBounds: (nextBounds) => {
      bounds = { ...nextBounds };
      setBoundsCalls.push({ ...nextBounds });
    },
    moveTop: () => {}
  };

  const controller = createDesktopPetDragController({
    platform: "darwin",
    getWindow: () => fakeWindow,
    getSettings: () => ({}),
    saveSettings: () => {},
    getMode: () => "bubble",
    getCursorScreenPoint: () => ({ ...cursorPoint }),
    getDisplayBounds: () => displayArea,
    getPointDisplayBounds: () => displayArea,
    persistPosition: () => {},
    refreshState: () => {}
  });

  assert.deepEqual(controller.moveWindowBy({ x: -8, y: 0 }), { ok: true });

  assert.equal(setBoundsCalls.length, 1);
  assert.deepEqual(bounds, getAnchoredDesktopPetBounds({ x: initialPosition.x - 8, y: initialPosition.y }, displayArea, "bubble"));
});

test("desktop pet idle and unread states keep base window bounds for stable dragging", () => {
  const idleState = {
    status: "idle",
    hint: "",
    messagePreview: "",
    unreadCount: 0,
    activeTasks: []
  };

  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: idleState,
    previewPanel: null
  }), "base");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: {
      ...idleState,
      unreadCount: 7
    },
    previewPanel: null
  }), "base");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: {
      ...idleState,
      messagePreview: "有新消息"
    },
    previewPanel: null
  }), "base");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: {
      status: "running",
      hint: "",
      messagePreview: "",
      unreadCount: 0,
      activeTasks: [
        {
          id: "cutej:chat-running",
          chatId: "chat-running",
          status: "running",
          updatedAt: "2026-06-17T00:01:00.000Z"
        }
      ],
      messages: [
        {
          id: "cutej:chat-running",
          chatId: "chat-running",
          status: "running",
          updatedAt: "2026-06-17T00:01:00.000Z"
        },
        {
          id: "cutej:chat-history",
          chatId: "chat-history",
          status: "done",
          updatedAt: "2026-06-17T00:00:00.000Z"
        }
      ]
    },
    previewPanel: null
  }), "bubble");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: idleState,
    previewPanel: {
      visible: true,
      expanded: false,
      status: "running"
    }
  }), "base");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: idleState,
    previewPanel: {
      visible: true,
      expanded: false,
      status: "done"
    }
  }), "bubble");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: {
      ...idleState,
      messages: [
        {
          id: "cutej:chat-read",
          chatId: "chat-read",
          updatedAt: "2026-06-17T00:00:00.000Z"
        }
      ]
    },
    previewPanel: null
  }), "bubble");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: {
      ...idleState,
      unreadCount: 1,
      messages: [
        {
          id: "cutej:chat-unread",
          chatId: "chat-unread",
          updatedAt: "2026-06-17T00:00:00.000Z"
        }
      ]
    },
    previewPanel: null
  }), "bubble");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    layoutMode: "base",
    state: {
      ...idleState,
      messages: [
        {
          id: "cutej:chat-collapsed",
          chatId: "chat-collapsed",
          updatedAt: "2026-06-17T00:00:00.000Z"
        }
      ]
    },
    previewPanel: null
  }), "base");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    layoutMode: "task-list-compact",
    state: {
      ...idleState,
      activeTasks: [
        {
          id: "cutej:chat-running",
          chatId: "chat-running",
          status: "running",
          updatedAt: "2026-06-17T00:01:00.000Z"
        }
      ]
    },
    previewPanel: null
  }), "task-list-compact");
  assert.equal(resolveDesktopPetWindowMode({
    dragging: false,
    state: idleState,
    previewPanel: {
      visible: true,
      expanded: true
    }
  }), "preview-expanded");
});

test("desktop pet state exposes awaiting when any active task is awaiting", () => {
  const state = createDesktopPetState(createSettings(), {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: createAgentStatus({
      presence: "busy",
      hasPendingAwaiting: false
    }),
    activeTasks: [
      {
        id: "task-1",
        agentKey: "zenmi",
        agentDisplayName: "小宅",
        chatId: "chat-1",
        runId: "run-1",
        title: "确认计划",
        preview: "等待你审批",
        status: "awaiting",
        awaitingMode: "approval",
        updatedAt: "2026-06-13T00:00:00.000Z"
      }
    ]
  });

  assert.equal(state.status, "awaiting");
});

test("desktop pet visual arbitration keeps awaiting above hover and signature", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  const visualStatus = deriveDesktopPetVisualStatus({
    displayStatus: "awaiting",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: true,
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: true,
    isKeyboardFocused: false
  });

  assert.equal(visualStatus, "awaiting");
});

test("desktop pet visual arbitration keeps idle-random signature below idle reactions", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "idle-random",
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: true,
    isKeyboardFocused: false
  }), "signature");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "idle-random",
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: true,
    isKeyboardFocused: false
  }), "signature");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "idle-random",
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: false,
    isKeyboardFocused: false
  }), "signature");
});

test("desktop pet hover does not switch visual state", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: false,
    activeSignatureTrigger: null,
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: true,
    isKeyboardFocused: false
  }), "idle");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: false,
    activeSignatureTrigger: null,
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: false,
    isKeyboardFocused: true
  }), "idle");
});

test("desktop pet visual arbitration does not emit thinking or message states", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  const base = {
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isReviewing: false,
    isHovering: false,
    isKeyboardFocused: false
  };

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "running"
  }), "running");

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "idle"
  }), "idle");
});

test("desktop pet unread badge tone separates awaiting from completed unread messages", () => {
  const {
    resolveDesktopPetUnreadBadgeTone
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(resolveDesktopPetUnreadBadgeTone({
    displayStatus: "awaiting",
    unreadCount: 2,
    visibleMessages: [
      { status: "done", unread: true },
      { status: "done", unread: true }
    ]
  }), "message");

  assert.equal(resolveDesktopPetUnreadBadgeTone({
    displayStatus: "idle",
    unreadCount: 1,
    visibleMessages: [
      { status: "awaiting", unread: true }
    ]
  }), "awaiting");

  assert.equal(resolveDesktopPetUnreadBadgeTone({
    displayStatus: "awaiting",
    unreadCount: 1,
    visibleMessages: []
  }), "awaiting");
});

test("desktop pet unread badge counts render awaiting and completed badges separately", () => {
  const {
    resolveDesktopPetUnreadBadgeCounts
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.deepEqual(resolveDesktopPetUnreadBadgeCounts({
    displayStatus: "awaiting",
    unreadCount: 2,
    visibleMessages: [
      { status: "awaiting", unread: true, awaitingCount: 2 }
    ]
  }), {
    awaitingCount: 2,
    completedCount: 0
  });

  assert.deepEqual(resolveDesktopPetUnreadBadgeCounts({
    displayStatus: "awaiting",
    unreadCount: 2,
    activeTasks: [
      { status: "awaiting", awaitingCount: 2 }
    ],
    visibleMessages: []
  }), {
    awaitingCount: 2,
    completedCount: 0
  });

  assert.deepEqual(resolveDesktopPetUnreadBadgeCounts({
    displayStatus: "awaiting",
    unreadCount: 3,
    activeTasks: [
      { status: "awaiting" }
    ],
    visibleMessages: [
      { status: "done", unread: true },
      { status: "done", unread: true }
    ]
  }), {
    awaitingCount: 1,
    completedCount: 2
  });

  assert.deepEqual(resolveDesktopPetUnreadBadgeCounts({
    displayStatus: "awaiting",
    unreadCount: 2,
    visibleMessages: []
  }), {
    awaitingCount: 2,
    completedCount: 0
  });

  assert.deepEqual(resolveDesktopPetUnreadBadgeCounts({
    displayStatus: "idle",
    unreadCount: 4,
    visibleMessages: []
  }), {
    awaitingCount: 0,
    completedCount: 4
  });
});

test("desktop pet preserves per-chat awaiting counts from navigation snapshots", () => {
  const snapshot = {
    ok: true,
    items: [{
      agentKey: "cutej",
      displayName: "小君",
      role: "",
      unreadCount: 0,
      unreadChatCount: 0,
      chatCount: 1,
      hasPendingAwaiting: true,
      latestChatId: "chat-awaiting",
      latestPreview: "等待确认",
      updatedAt: "2026-06-17T12:00:00.000Z",
      recentChats: [{
        chatId: "chat-awaiting",
        chatName: "审批发布",
        agentKey: "cutej",
        updatedAt: "2026-06-17T12:00:00.000Z",
        lastRunId: "run-awaiting",
        lastRunContent: "需要你确认两项操作",
        isRead: true,
        hasActiveRun: true,
        hasPendingAwaiting: true,
        awaitingCount: 2
      }]
    }]
  };

  assert.equal(createDesktopPetActiveTasksFromNavigationSnapshot(snapshot)[0]?.awaitingCount, 2);
  assert.equal(createDesktopPetMessagesFromNavigationSnapshot(snapshot)[0]?.awaitingCount, 2);
});

test("desktop pet visual arbitration lets manual signature surface over hover", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "manual",
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: true,
    isKeyboardFocused: false
  }), "signature");
});

test("desktop pet visual arbitration lets manual signature surface while running or awaiting", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "running",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "manual",
    isReviewing: false
  }), "signature");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "awaiting",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "manual",
    isReviewing: false
  }), "signature");
});

test("desktop pet context menu exposes manual signature actions", () => {
  if (APP_BRAND.desktopPet.signature?.length) {
    const [firstAction] = APP_BRAND.desktopPet.signature;
    assert.deepEqual(getDesktopPetContextMenuItems("classic")[0], {
      action: "signature",
      signatureId: firstAction.id,
      label: firstAction.label
    });
  } else {
    assert.deepEqual(getDesktopPetContextMenuItems("classic")[0], {
      action: "hide",
      label: "关闭宠物"
    });
  }

  assert.deepEqual(getDesktopPetContextMenuItems("user:desk-cat", [
    {
      id: "chant",
      label: "念经",
      trigger: ["manual", "idle-random"],
      variants: [
        {
          path: "signatures/chant-1.webp",
          frameCount: 30,
          durationMs: 4200,
          weight: 2
        }
      ]
    },
    {
      id: "sleep",
      label: "打盹",
      trigger: ["idle-random"],
      variants: [
        {
          path: "signatures/sleep-1.webp",
          frameCount: 18,
          durationMs: 3000
        }
      ]
    }
  ]), [
    {
      action: "signature",
      signatureId: "chant",
      label: "念经"
    },
    {
      action: "hide",
      label: "关闭宠物"
    }
  ]);
});

test("desktop pet exposes brand-specific built-in appearance defaults", () => {
  const brandPet = APP_BRAND.desktopPet;
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS.map((option) => option.id), ["classic"]);
  assert.equal(DEFAULT_DESKTOP_PET_BUILTIN_ID, brandPet.id);
  assert.equal(DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, brandPet.id);
  assert.equal(DEFAULT_DESKTOP_PET_DISPLAY_NAME, brandPet.displayName);
  assert.equal(DEFAULT_DESKTOP_PET_DESCRIPTION, brandPet.description);
  assert.equal(DESKTOP_PET_APPEARANCE_OPTIONS[0].displayName, brandPet.displayName);
  assert.equal(DESKTOP_PET_APPEARANCE_OPTIONS[0].description, brandPet.description);
  assert.equal(DESKTOP_PET_APPEARANCE_OPTIONS[0].preview, brandPet.preview);
  assert.equal(DESKTOP_PET_APPEARANCE_OPTIONS[0].previewUrl, `./desktop-pet/${brandPet.preview}`);
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states, brandPet.states);
  if (!brandPet.signature) {
    assert.deepEqual(resolveDesktopPetSignatureActions("classic", []), []);
  } else {
    assert.deepEqual(resolveDesktopPetSignatureActions("classic", []), brandPet.signature);
    if (DEFAULT_DESKTOP_PET_BUILTIN_ID === "cutej") {
      assert.deepEqual(brandPet.signature[0], {
        id: "work-hard",
        label: "努力工作",
        trigger: ["manual"],
        variants: [
          {
            path: "signature/work-hard-v3.webp",
            frameCount: 14,
            durationMs: 5200,
            weight: 1
          }
        ]
      });
    }
  }

  assert.deepEqual(resolveDesktopPetSignatureActions("user:pony", []), []);
  const ponyDanceAction = {
    id: "dance",
    label: "跳舞",
    trigger: ["manual", "idle-random"],
    variants: [
      {
        path: "signature/dance.webp",
        frameCount: 30,
        durationMs: 5200,
        weight: 1
      }
    ]
  };
  assert.deepEqual(resolveDesktopPetSignatureActions("user:pony", [ponyDanceAction]), [ponyDanceAction]);
  assert.deepEqual(getDesktopPetContextMenuItems("user:pony", [ponyDanceAction])[0], {
    action: "signature",
    signatureId: "dance",
    label: "跳舞"
  });
});

test("user desktop pet appearances expose strict renderer-safe asset protocol URLs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-pet-assets-"));
  try {
    const app = createApp(root);
    const petRoot = path.join(getDesktopPetsDataRoot(app), "pony");
    fs.mkdirSync(petRoot, { recursive: true });
    writeStrictUserPet(petRoot);

    const options = listUserDesktopPetAppearanceOptions(app);
    assert.equal(options.length, 1);
    assert.equal(options[0].id, "user:pony");
    assert.equal(options[0].assetBasePath, `${DESKTOP_PET_USER_ASSET_PROTOCOL}://pony/`);
    assert.equal(options[0].previewUrl, `${DESKTOP_PET_USER_ASSET_PROTOCOL}://pony/idle.webp`);
    assert.deepEqual(options[0].states, {
      idle: { path: "idle.webp", frameCount: 4, durationMs: 6000, loop: true },
      jumping: { path: "jumping.webp", frameCount: 4, durationMs: 1000, loop: false },
      "moving-left": {
        path: "moving-left.webp",
        frameCount: 8,
        durationMs: 900,
        loop: true,
        mirror: true
      },
      dragging: { path: "dragging.webp", frameCount: 4, durationMs: 900, loop: true },
      done: { path: "done.webp", frameCount: 6, durationMs: 1200, loop: false, holdMs: 2500 },
      failed: { path: "failed.webp", frameCount: 4, durationMs: 1000, loop: false, holdMs: 3000 },
      running: { path: "running.webp", frameCount: 8, durationMs: 1600, loop: true },
      awaiting: { path: "awaiting.webp", frameCount: 4, durationMs: 1200, loop: true },
      review: { path: "review.webp", frameCount: 4, durationMs: 1400, loop: true }
    });
    assert.equal(options[0].signature?.[0]?.variants[0]?.path, "signature/dance.webp");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("user desktop pet appearances reject legacy manifest fields and state names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-pet-legacy-"));
  try {
    const app = createApp(root);
    const petRoot = path.join(getDesktopPetsDataRoot(app), "legacy");
    fs.mkdirSync(petRoot, { recursive: true });
    fs.writeFileSync(path.join(petRoot, "pet-idle.png"), "fake png", "utf8");
    fs.writeFileSync(path.join(petRoot, "pet.json"), `${JSON.stringify({
      id: "legacy",
      displayName: "Legacy",
      previewAssetPath: "pet-idle.png",
      states: {
        idle: { path: "pet-idle.png" },
        thinking: { path: "pet-thinking.png" },
        "dragging-moving": { path: "task-run-left.webp" }
      },
      signatureActions: []
    }, null, 2)}\n`, "utf8");

    assert.deepEqual(listUserDesktopPetAppearanceOptions(app), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop pet visual keeps drag hold stable and maps movement onto the walking state", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  const base = {
    displayStatus: "idle",
    isDragging: true,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isReviewing: false,
    isHovering: false,
    isKeyboardFocused: false
  };

  assert.equal(deriveDesktopPetVisualStatus(base), "idle");
  assert.equal(deriveDesktopPetVisualStatus({ ...base, dragDirection: "left" }), "moving-left");
  assert.equal(deriveDesktopPetVisualStatus({ ...base, dragDirection: "right" }), "moving-left");
});

test("desktop pet visual keeps running as the running state", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "running",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isReviewing: false,
    isHovering: false,
    isKeyboardFocused: false
  }), "running");
});

test("desktop pet visual maps review, failed, and rare idle jumping onto standard states", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  const base = {
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isHovering: false,
    isKeyboardFocused: false
  };

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "running",
    isReviewing: true
  }), "review");

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "error",
    isReviewing: false
  }), "failed");

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "idle",
    activeStandardAction: "jumping",
    isReviewing: false
  }), "jumping");
});
