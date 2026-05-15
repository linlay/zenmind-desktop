import test from "node:test";
import assert from "node:assert/strict";

const {
  getQuickAssistantBounds,
  getQuickAssistantWebCopilotBounds,
  isQuickAssistantMediaPermissionAllowed,
  isQuickAssistantSupportedPlatform,
  QUICK_ASSISTANT_ATTACHMENT_SIZE,
  QUICK_ASSISTANT_COMPACT_SIZE,
  QUICK_ASSISTANT_COMPACT_MENU_SIZE,
  QUICK_ASSISTANT_SHORTCUT,
  QUICK_ASSISTANT_WEB_COPILOT_SIZE,
  createQuickAssistantWindowState
} = await import("../dist-electron/main/quick-assistant.js");

test("quick assistant is only enabled on macOS", () => {
  assert.equal(isQuickAssistantSupportedPlatform("darwin"), true);
  assert.equal(isQuickAssistantSupportedPlatform("win32"), false);
  assert.equal(isQuickAssistantSupportedPlatform("linux"), false);
});

test("quick assistant uses option-space", () => {
  assert.equal(QUICK_ASSISTANT_SHORTCUT, "Alt+Space");
});

test("quick assistant compact window matches the slim reference capsule", () => {
  assert.equal(QUICK_ASSISTANT_COMPACT_SIZE.width, 430);
  assert.equal(QUICK_ASSISTANT_COMPACT_SIZE.height, 76);
});

test("quick assistant web copilot window uses the larger floating surface", () => {
  assert.equal(QUICK_ASSISTANT_WEB_COPILOT_SIZE.width, 480);
  assert.equal(QUICK_ASSISTANT_WEB_COPILOT_SIZE.height, 600);

  const bounds = getQuickAssistantWebCopilotBounds({
    workArea: { x: 0, y: 25, width: 1440, height: 875 }
  });

  assert.deepEqual(bounds, {
    x: 480,
    y: 163,
    width: QUICK_ASSISTANT_WEB_COPILOT_SIZE.width,
    height: QUICK_ASSISTANT_WEB_COPILOT_SIZE.height
  });
});

test("quick assistant attachment mode keeps file previews inside the compact popup", () => {
  assert.equal(QUICK_ASSISTANT_ATTACHMENT_SIZE.width, 430);
  assert.equal(QUICK_ASSISTANT_ATTACHMENT_SIZE.height, 128);

  const bounds = getQuickAssistantBounds({
    mode: "attachment",
    workArea: { x: 0, y: 25, width: 1440, height: 875 }
  });

  assert.deepEqual(bounds, {
    x: 505,
    y: 661,
    width: QUICK_ASSISTANT_ATTACHMENT_SIZE.width,
    height: QUICK_ASSISTANT_ATTACHMENT_SIZE.height
  });
});

test("quick assistant compact menu only reserves room for the upload action", () => {
  assert.equal(QUICK_ASSISTANT_COMPACT_MENU_SIZE.width, 430);
  assert.equal(QUICK_ASSISTANT_COMPACT_MENU_SIZE.height, 138);

  const bounds = getQuickAssistantBounds({
    mode: "compactMenu",
    workArea: { x: 0, y: 25, width: 1440, height: 875 }
  });

  assert.deepEqual(bounds, {
    x: 505,
    y: 656,
    width: QUICK_ASSISTANT_COMPACT_MENU_SIZE.width,
    height: QUICK_ASSISTANT_COMPACT_MENU_SIZE.height
  });
});

test("quick assistant resets display mode to compact before shortcut show", () => {
  const state = createQuickAssistantWindowState();

  assert.equal(state.isExpanded(), false);
  assert.equal(state.setExpanded(true), true);
  assert.equal(state.getDisplayMode(), "expanded");
  assert.equal(state.setDisplayMode("attachment"), "attachment");
  assert.equal(state.setDisplayMode("compactMenu"), "compactMenu");
  state.setInteractionState({ busy: true, mouseInside: true });
  const snapshot = state.prepareCompactShow();

  assert.equal(snapshot.expanded, false);
  assert.equal(snapshot.displayMode, "compact");
  assert.deepEqual(snapshot.interactionState, { busy: false, mouseInside: false });
  assert.equal(state.isExpanded(), false);
  assert.equal(state.getDisplayMode(), "compact");
});

test("quick assistant compact window sits below the screen center", () => {
  const bounds = getQuickAssistantBounds({
    expanded: false,
    workArea: { x: 0, y: 25, width: 1440, height: 875 }
  });

  assert.deepEqual(bounds, {
    x: 505,
    y: 687,
    width: QUICK_ASSISTANT_COMPACT_SIZE.width,
    height: QUICK_ASSISTANT_COMPACT_SIZE.height
  });
});

test("quick assistant expanded window opens lower on roomy screens", () => {
  const bounds = getQuickAssistantBounds({
    expanded: true,
    workArea: { x: 0, y: 25, width: 1440, height: 875 }
  });

  assert.deepEqual(bounds, {
    x: 470,
    y: 280,
    width: 500,
    height: 600
  });
});

test("quick assistant expanded window is constrained by the work area", () => {
  const bounds = getQuickAssistantBounds({
    expanded: true,
    workArea: { x: 120, y: 40, width: 760, height: 620 }
  });

  assert.equal(bounds.width, 500);
  assert.equal(bounds.height, 580);
  assert.equal(bounds.x, 250);
  assert.equal(bounds.y, 60);
});

test("quick assistant media permission allows audio capture from the quick window", () => {
  assert.equal(isQuickAssistantMediaPermissionAllowed({
    permission: "media",
    contentsId: 8,
    mainContentsId: 3,
    quickContentsId: 8,
    mediaTypes: ["audio"]
  }), true);
});

test("quick assistant media permission still rejects unrelated windows and non-audio capture", () => {
  assert.equal(isQuickAssistantMediaPermissionAllowed({
    permission: "media",
    contentsId: 9,
    mainContentsId: 3,
    quickContentsId: 8,
    mediaTypes: ["audio"]
  }), false);
  assert.equal(isQuickAssistantMediaPermissionAllowed({
    permission: "media",
    contentsId: 8,
    mainContentsId: 3,
    quickContentsId: 8,
    mediaTypes: ["video"]
  }), false);
});
