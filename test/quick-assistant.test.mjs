import test from "node:test";
import assert from "node:assert/strict";

const {
  getQuickAssistantBounds,
  isQuickAssistantMediaPermissionAllowed,
  isQuickAssistantSupportedPlatform,
  QUICK_ASSISTANT_COMPACT_SIZE,
  QUICK_ASSISTANT_SHORTCUT
} = await import("../dist-electron/main/quick-assistant.js");

test("quick assistant is only enabled on macOS", () => {
  assert.equal(isQuickAssistantSupportedPlatform("darwin"), true);
  assert.equal(isQuickAssistantSupportedPlatform("win32"), false);
  assert.equal(isQuickAssistantSupportedPlatform("linux"), false);
});

test("quick assistant uses option-space", () => {
  assert.equal(QUICK_ASSISTANT_SHORTCUT, "Alt+Space");
});

test("quick assistant compact window leaves enough room for chatting", () => {
  assert.ok(QUICK_ASSISTANT_COMPACT_SIZE.height >= 112);
});

test("quick assistant compact window sits below the screen center", () => {
  const bounds = getQuickAssistantBounds({
    expanded: false,
    workArea: { x: 0, y: 25, width: 1440, height: 875 }
  });

  assert.deepEqual(bounds, {
    x: 460,
    y: 669,
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
