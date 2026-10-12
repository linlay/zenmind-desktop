import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { configureMainWindowLifecycleEvents } = require("../dist-electron/main/modules/shell/main-window-events.js");
const { configureAttachedWebview } = require("../dist-electron/main/modules/shell/webview-events.js");
const preloadUrl = new URL("../dist-electron/preload/index.js", import.meta.url);
const preloadSource = readFileSync(preloadUrl, "utf8");
const preloadRequire = createRequire(preloadUrl);

function fixture(platform) {
  const ipc = new EventEmitter();
  let api;
  runInNewContext(preloadSource, {
    exports: {}, process, window: { addEventListener() {} },
    require: name => name === "electron" ? {
      ipcRenderer: ipc,
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
    } : preloadRequire(name),
  });
  const received = [];
  const progress = [];
  const unsubscribe = api.onHistoryNavigation(direction => received.push(direction));
  api.onHistoryGestureProgress(value => progress.push(value));
  const main = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: Object.assign(new EventEmitter(), {
      mainFrame: {},
      send(channel, payload) { ipc.emit(channel, {}, payload); },
    }),
  });
  configureMainWindowLifecycleEvents(main, {
    platform, lifecycle: {}, isDevToolsShortcut: () => false,
    isHandlingQuit: () => false, requestAppQuit() {}, clearWindow() {},
  });
  return { main, ipc, received, progress, api, unsubscribe };
}

function key(contents, keyName, overrides = {}) {
  let prevented = false;
  contents.emit("before-input-event", { preventDefault() { prevented = true; } }, {
    type: "keyDown", key: keyName, alt: true, control: false,
    meta: false, shift: false, isAutoRepeat: false, isComposing: false,
    ...overrides,
  });
  return prevented;
}

function guestFor(main, platform, restrictedDocumentPreview = false) {
  const guest = Object.assign(new EventEmitter(), {
    id: 42, mainFrame: {}, getURL: () => "https://example.test/page", setWindowOpenHandler() {},
  });
  configureAttachedWebview(guest, {
    platform, restrictedDocumentPreview, getMainWindow: () => main,
    isDevToolsShortcut: () => false,
  });
  return guest;
}

function gesture(contents, direction, event = {}) {
  const payload = direction === "back" || direction === "forward"
    ? { direction, progress: 1, committed: true }
    : direction;
  contents.emit("ipc-message", { sender: contents, senderFrame: contents.mainFrame, ...event },
    "desktopShell.historyGesture", payload);
}

test("macOS forwards preview progress without moving history until the gesture commits", () => {
  const { main, received, progress } = fixture("darwin");
  const preview = { direction: "back", progress: 0.1, committed: false };
  gesture(main.webContents, preview);
  assert.deepEqual(received, []);
  assert.deepEqual(progress, [preview]);
  gesture(main.webContents, { ...preview, progress: 0.9 });
  assert.deepEqual(received, []);
  gesture(main.webContents, "back");
  assert.deepEqual(received, ["back"]);
  gesture(main.webContents, preview);
  gesture(main.webContents, null);
  assert.equal(progress.length, 3, "inertia cannot restart the preview after committing");
});

test("macOS two-finger gesture directions reach the host while three-finger swipes stay with the system", () => {
  const { main, received } = fixture("darwin");
  assert.equal(main.listenerCount("swipe"), 0);
  gesture(main.webContents, null);
  gesture(main.webContents, "back");
  assert.deepEqual(received, ["back"]);
  main.destroyed = true;
  gesture(main.webContents, "forward");
  assert.equal(received.length, 1);
});

test("macOS consumes one gesture across host and guest switches, then accepts a new gesture after idle", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const { main, received } = fixture("darwin");
  const guest = guestFor(main, "darwin");
  gesture(main.webContents, "back");
  for (let index = 0; index < 5; index += 1) {
    now += 200;
    gesture(guest, null);
    gesture(guest, "back");
  }
  assert.deepEqual(received, ["back"]);
  now += 321;
  gesture(guest, "forward");
  assert.deepEqual(received, ["back", "forward"]);
});

test("macOS ignores invalid directions, other senders, child/stale frames and unavailable owners", () => {
  const { main, received } = fixture("darwin");
  for (const direction of ["up", {}, 1, ["back"], undefined]) gesture(main.webContents, direction);
  for (const sample of [
    { direction: "back", progress: -0.1, committed: false },
    { direction: "back", progress: 1.1, committed: false },
    { direction: "back", progress: Number.NaN, committed: false },
    { direction: "back", progress: 0.5, committed: true },
    { direction: "back", progress: 1, committed: true, extra: true },
  ]) gesture(main.webContents, sample);
  gesture(main.webContents, "back", { sender: {} });
  gesture(main.webContents, "back", { senderFrame: {} });
  gesture(main.webContents, "back", { senderFrame: null });
  gesture(guestFor(null, "darwin"), "back");
  assert.deepEqual(received, []);
});

test("Windows swipes are not registered and only exact navigation shortcuts are consumed", () => {
  const { main, received } = fixture("win32");
  assert.equal(main.listenerCount("swipe"), 0);
  gesture(main.webContents, "back");
  assert.deepEqual(received, []);
  assert.equal(key(main.webContents, "ArrowLeft"), true);
  assert.equal(key(main.webContents, "ArrowRight"), true);
  assert.deepEqual(received, ["back", "forward"]);
  for (const overrides of [
    { type: "keyUp" }, { alt: false }, { control: true },
    { meta: true }, { shift: true }, { isComposing: true },
  ]) assert.equal(key(main.webContents, "ArrowLeft", overrides), false);
  assert.equal(key(main.webContents, "ArrowUp"), false);
  assert.equal(key(main.webContents, "ArrowLeft", { isAutoRepeat: true }), true);
  assert.deepEqual(received, ["back", "forward"], "held keys cannot fall through to Chromium history");
  main.destroyed = true;
  assert.equal(key(main.webContents, "ArrowLeft"), true);
  assert.equal(received.length, 2);
});

test("Windows guest shortcuts go to Desktop even in a restricted document preview", () => {
  for (const restrictedDocumentPreview of [false, true]) {
    const { main, received } = fixture("win32");
    const guest = guestFor(main, "win32", restrictedDocumentPreview);
    assert.equal(key(guest, "ArrowLeft"), true);
    assert.equal(key(guest, "ArrowRight"), true);
    assert.equal(key(guest, "ArrowRight", { isAutoRepeat: true }), true);
    assert.equal(key(guest, "ArrowLeft", { control: true }), false);
    assert.deepEqual(received, ["back", "forward"]);
    main.destroyed = true;
    assert.equal(key(guest, "ArrowLeft"), true);
    assert.equal(received.length, 2);
  }
  const guest = guestFor(null, "win32");
  assert.equal(key(guest, "ArrowLeft"), true, "an unavailable owner cannot redirect navigation into the guest");
});

test("macOS keeps Windows Alt+arrow shortcuts available to both renderer and guests", () => {
  const { main, received } = fixture("darwin");
  const guest = guestFor(main, "darwin");
  for (const contents of [main.webContents, guest]) {
    assert.equal(key(contents, "ArrowLeft"), false);
    assert.equal(key(contents, "ArrowRight"), false);
  }
  assert.deepEqual(received, []);
});

test("host preload filters illegal directions and unsubscribes without retaining callbacks", () => {
  const { ipc, received, unsubscribe } = fixture("darwin");
  for (const direction of [null, "up", {}, ["back"], 1]) ipc.emit("app.historyNavigation", {}, direction);
  assert.deepEqual(received, []);
  ipc.emit("app.historyNavigation", {}, "back");
  assert.deepEqual(received, ["back"]);
  unsubscribe();
  assert.equal(ipc.listenerCount("app.historyNavigation"), 0);
  ipc.emit("app.historyNavigation", {}, "forward");
  assert.deepEqual(received, ["back"]);
});

test("host preload validates progress packets and releases its progress subscription", () => {
  const { ipc, api } = fixture("darwin");
  const received = [];
  const unsubscribe = api.onHistoryGestureProgress(value => received.push(value));
  for (const value of ["back", {}, [],
    { direction: "up", progress: 0.5, committed: false },
    { direction: "back", progress: -1, committed: false },
    { direction: "back", progress: 0.5, committed: true },
  ]) ipc.emit("app.historyGestureProgress", {}, value);
  assert.deepEqual(received, []);
  const preview = { direction: "forward", progress: 0.5, committed: false };
  ipc.emit("app.historyGestureProgress", {}, preview);
  ipc.emit("app.historyGestureProgress", {}, null);
  assert.deepEqual(received, [preview, null]);
  unsubscribe();
  ipc.emit("app.historyGestureProgress", {}, preview);
  assert.equal(received.length, 2);
});
