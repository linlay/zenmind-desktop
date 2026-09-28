import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
let createTaskbarUnreadController;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { nativeImage: { createFromBuffer: (buffer) => buffer } };
  return originalLoad.call(this, request, parent, isMain);
};
try {
  ({ createTaskbarUnreadController } = require("../dist-electron/main/modules/shell/taskbar-unread.js"));
} finally {
  Module._load = originalLoad;
}

function snapshot(count) {
  return {
    ok: true,
    items: [{ agentKey: "project", workspaceDir: "C:/project", unreadCount: count }],
    chatItems: [],
    pinnedChatItems: []
  };
}

function setup(platform = "win32") {
  const calls = [];
  const errors = [];
  const makeWindow = () => ({
    isDestroyed: () => false,
    setOverlayIcon: (icon, description) => calls.push({ icon, description })
  });
  const state = { window: makeWindow() };
  const controller = createTaskbarUnreadController({
    platform,
    getWindow: () => state.window,
    onError: (...args) => errors.push(args)
  });
  return { controller, state, calls, errors, makeWindow };
}

test("Windows follows authoritative unread, excludes pending and counts pins once", () => {
  const { controller, calls } = setup();
  controller.refresh({
    ...snapshot(4),
    chatItems: [{ chatId: "chat", agentKey: "general", isRead: false }],
    pinnedChatItems: [
      { chatId: "chat", agentKey: "general", isRead: false },
      { chatId: "pin", agentKey: "general", isRead: false },
      { chatId: "project-pin", agentKey: "project", isRead: false },
      { chatId: "pending", agentKey: "general", isRead: true, hasPendingAwaiting: true }
    ]
  });
  assert.equal(calls[0].description, "6 个未读会话");
  assert.equal(calls[0].icon.subarray(1, 4).toString(), "PNG");
  controller.refresh(snapshot(0));
  assert.deepEqual(calls[1], { icon: null, description: "" });
  controller.refresh(snapshot(2));
  controller.refresh({ ok: false });
  assert.equal(calls.at(-1).icon, null);
});

test("unchanged counts skip rasterization but restored and recreated windows reapply", () => {
  const { controller, calls, state, makeWindow } = setup();
  controller.refresh(snapshot(9));
  controller.refresh(snapshot(9));
  assert.equal(calls.length, 1);
  controller.refresh(snapshot(9), true);
  state.window = makeWindow();
  controller.refresh(snapshot(9));
  assert.equal(calls.length, 3);
  state.window = null;
  controller.refresh(snapshot(1));
  state.window = { isDestroyed: () => true };
  controller.refresh(snapshot(1));
  assert.equal(calls.length, 3);
});

test("large counts share the 99+ image while retaining the exact accessible count", () => {
  const { controller, calls } = setup();
  for (const count of [1, 9, 10, 99, 100, 101]) controller.refresh(snapshot(count));
  assert.notDeepEqual(calls[3].icon, calls[4].icon);
  assert.deepEqual(calls[4].icon, calls[5].icon);
  assert.equal(calls[5].description, "101 个未读会话");
});

test("macOS and Linux do not access a window or apply Windows overlays", () => {
  for (const platform of ["darwin", "linux"]) {
    createTaskbarUnreadController({
      platform,
      getWindow: () => { throw new Error("must not access window"); },
      onError: () => assert.fail("unexpected error")
    }).refresh(snapshot(3));
  }
});

test("native failures do not break navigation updates and can be retried", () => {
  const { controller, state, calls, errors, makeWindow } = setup();
  state.window.setOverlayIcon = () => { throw new Error("native failure"); };
  assert.doesNotThrow(() => controller.refresh(snapshot(3)));
  assert.equal(errors.length, 1);
  state.window = makeWindow();
  controller.refresh(snapshot(3));
  assert.equal(calls[0].description, "3 个未读会话");
});
