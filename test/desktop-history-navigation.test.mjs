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
  const unsubscribe = api.onHistoryNavigation(direction => received.push(direction));
  const main = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: Object.assign(new EventEmitter(), {
      send(channel, payload) { ipc.emit(channel, {}, payload); },
    }),
  });
  configureMainWindowLifecycleEvents(main, {
    platform, lifecycle: {}, isDevToolsShortcut: () => false,
    isHandlingQuit: () => false, requestAppQuit() {}, clearWindow() {},
  });
  return { main, ipc, received, unsubscribe };
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
    id: 42, getURL: () => "https://example.test/page", setWindowOpenHandler() {},
  });
  configureAttachedWebview(guest, {
    platform, restrictedDocumentPreview, getMainWindow: () => main,
    isDevToolsShortcut: () => false,
  });
  return guest;
}

test("macOS horizontal window swipes reach the host preload with browser directions", () => {
  const { main, received } = fixture("darwin");
  for (const direction of ["up", "down", "unknown"]) main.emit("swipe", {}, direction);
  assert.deepEqual(received, []);
  main.emit("swipe", {}, "right");
  main.emit("swipe", {}, "left");
  assert.deepEqual(received, ["back", "forward"]);
  main.destroyed = true;
  main.emit("swipe", {}, "right");
  assert.equal(received.length, 2);
});

test("Windows swipes are not registered and only exact navigation shortcuts are consumed", () => {
  const { main, received } = fixture("win32");
  assert.equal(main.listenerCount("swipe"), 0);
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
