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
    getDock: () => { throw new Error("Windows must not access Dock"); },
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

function setupDock() {
  const badges = [];
  const errors = [];
  const makeDock = () => ({ setBadge: (text) => badges.push(text) });
  const state = { dock: makeDock() };
  const controller = createTaskbarUnreadController({
    platform: "darwin",
    getWindow: () => { throw new Error("macOS must not access window"); },
    getDock: () => state.dock,
    onError: (...args) => errors.push(args)
  });
  return { controller, state, badges, errors, makeDock };
}

test("macOS Dock follows the same authoritative unread and pin deduplication", () => {
  const { controller, badges } = setupDock();
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
  controller.refresh(snapshot(2));
  controller.refresh(snapshot(0));
  controller.refresh(snapshot(3));
  controller.refresh({ ok: false });
  controller.refresh(snapshot(5));
  controller.refresh(undefined);
  assert.deepEqual(badges, ["6", "2", "", "3", "", "5", ""]);
});

test("macOS Dock shows numeric counts and caps large counts at 99+", () => {
  const { controller, badges } = setupDock();
  for (const count of [1, 9, 10, 99, 100, 101]) controller.refresh(snapshot(count));
  assert.deepEqual(badges, ["1", "9", "10", "99", "99+", "99+"]);
});

test("macOS skips unchanged counts and reapplies after restore or Dock availability", () => {
  const { controller, badges, state, makeDock } = setupDock();
  controller.refresh(snapshot(9));
  controller.refresh(snapshot(9));
  assert.equal(badges.length, 1);
  controller.refresh(snapshot(9), true);
  state.dock = undefined;
  controller.refresh(snapshot(2));
  state.dock = makeDock();
  controller.refresh(snapshot(2));
  assert.deepEqual(badges, ["9", "9", "2"]);
});

test("macOS Dock failures do not break navigation and retry the same count", () => {
  const { controller, badges, state, errors } = setupDock();
  const setBadge = state.dock.setBadge;
  state.dock.setBadge = () => { throw new Error("native failure"); };
  assert.doesNotThrow(() => controller.refresh(snapshot(3)));
  assert.equal(errors.length, 1);
  state.dock.setBadge = setBadge;
  controller.refresh(snapshot(3));
  assert.deepEqual(badges, ["3"]);
});

test("Linux does not access a window or Dock", () => {
  createTaskbarUnreadController({
    platform: "linux",
    getWindow: () => { throw new Error("must not access window"); },
    getDock: () => { throw new Error("must not access Dock"); },
    onError: () => assert.fail("unexpected error")
  }).refresh(snapshot(3));
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

test("unchanged unread counts refresh the accessible label after a locale change", t => {
  const { setMainLocaleForCurrentProcess } = require("../dist-electron/main/support/i18n/main-i18n.js");
  t.after(() => setMainLocaleForCurrentProcess("zh-CN"));
  const { controller, calls } = setup();
  setMainLocaleForCurrentProcess("zh-CN");
  controller.refresh(snapshot(6));
  setMainLocaleForCurrentProcess("en-US");
  controller.refresh(snapshot(6));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].description, "6 个未读会话");
  assert.equal(calls[1].description, "Unread conversations: 6");
});
