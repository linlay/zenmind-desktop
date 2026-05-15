import test from "node:test";
import assert from "node:assert/strict";

const {
  getQuickAssistantWebCopilotBounds,
  isQuickAssistantMediaPermissionAllowed,
  isQuickAssistantSupportedPlatform,
  QUICK_ASSISTANT_SHORTCUT,
  QUICK_ASSISTANT_WEB_COPILOT_SIZE
} = await import("../dist-electron/main/quick-assistant.js");

test("quick assistant is only enabled on macOS", () => {
  assert.equal(isQuickAssistantSupportedPlatform("darwin"), true);
  assert.equal(isQuickAssistantSupportedPlatform("win32"), false);
  assert.equal(isQuickAssistantSupportedPlatform("linux"), false);
});

test("quick assistant uses option-space", () => {
  assert.equal(QUICK_ASSISTANT_SHORTCUT, "Alt+Space");
});

test("quick assistant web copilot window uses the floating copilot surface", () => {
  assert.equal(QUICK_ASSISTANT_WEB_COPILOT_SIZE.width, 360);
  assert.equal(QUICK_ASSISTANT_WEB_COPILOT_SIZE.height, 600);

  const bounds = getQuickAssistantWebCopilotBounds({
    workArea: { x: 0, y: 25, width: 1440, height: 875 }
  });

  assert.deepEqual(bounds, {
    x: 540,
    y: 163,
    width: QUICK_ASSISTANT_WEB_COPILOT_SIZE.width,
    height: QUICK_ASSISTANT_WEB_COPILOT_SIZE.height
  });
});

test("quick assistant web copilot window is constrained by small work areas", () => {
  const bounds = getQuickAssistantWebCopilotBounds({
    workArea: { x: 20, y: 30, width: 320, height: 500 }
  });

  assert.deepEqual(bounds, {
    x: 32,
    y: 42,
    width: 296,
    height: 476
  });
});

test("quick assistant media permission allows audio capture from desktop windows", () => {
  assert.equal(isQuickAssistantMediaPermissionAllowed({
    permission: "media",
    contentsId: 8,
    mainContentsId: 3,
    quickContentsId: 8,
    mediaTypes: ["audio"]
  }), true);
  assert.equal(isQuickAssistantMediaPermissionAllowed({
    permission: "media",
    contentsId: 3,
    mainContentsId: 3,
    quickContentsId: 8,
    mediaTypes: ["audio"]
  }), true);
});

test("quick assistant media permission rejects unrelated windows and non-audio capture", () => {
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
  assert.equal(isQuickAssistantMediaPermissionAllowed({
    permission: "display-capture",
    contentsId: 8,
    mainContentsId: 3,
    quickContentsId: 8,
    mediaTypes: ["audio"]
  }), false);
});
