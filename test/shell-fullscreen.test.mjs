import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const {
  registerShellIpcHandlers,
  transitionWindowFullScreen
} = await import("../dist-electron/main/ipc/shell-handlers.js");

class FakeFullscreenWindow extends EventEmitter {
  constructor({ destroyed = false, fullscreen = false, mode = "sync" } = {}) {
    super();
    this.destroyed = destroyed;
    this.fullscreen = fullscreen;
    this.maximized = false;
    this.minimized = false;
    this.mode = mode;
    this.requests = [];
  }

  isDestroyed() {
    return this.destroyed;
  }

  isFullScreen() {
    return this.fullscreen;
  }

  isMaximized() {
    return this.maximized;
  }

  minimize() {
    this.minimized = true;
  }

  maximize() {
    this.maximized = true;
    this.emit("maximize");
  }

  unmaximize() {
    this.maximized = false;
    this.emit("unmaximize");
  }

  setFullScreen(enabled) {
    this.requests.push(enabled);
    if (this.mode === "throw") {
      throw new Error("transition failed");
    }
    if (this.mode === "stalled") return;
    const complete = () => {
      this.fullscreen = enabled;
      this.emit(enabled ? "enter-full-screen" : "leave-full-screen");
    };
    if (this.mode === "async") {
      setTimeout(complete, 5);
      return;
    }
    complete();
  }
}

class FakeDragWindow extends EventEmitter {
  constructor(position = [80, 90]) {
    super();
    this.position = position;
    this.moves = [];
  }

  isDestroyed() {
    return false;
  }

  isFullScreen() {
    return false;
  }

  getPosition() {
    return this.position;
  }

  setPosition(x, y) {
    this.position = [x, y];
    this.moves.push([x, y]);
  }

  moveTop() {}
}

test("window fullscreen transition confirms synchronous Windows state", async () => {
  const target = new FakeFullscreenWindow();
  const result = await transitionWindowFullScreen(target, true, {
    platform: "win32",
    timeoutMs: 50
  });

  assert.deepEqual(result, { ok: true, isFullScreen: true });
  assert.deepEqual(target.requests, [true]);
});

test("window fullscreen transition waits for the macOS native event", async () => {
  const target = new FakeFullscreenWindow({ mode: "async" });
  const result = await transitionWindowFullScreen(target, true, {
    platform: "darwin",
    timeoutMs: 50
  });

  assert.deepEqual(result, { ok: true, isFullScreen: true });
  assert.deepEqual(target.requests, [true]);
});

test("window fullscreen transition fails closed on timeout or destroyed windows", async () => {
  const stalled = new FakeFullscreenWindow({ mode: "stalled" });
  assert.deepEqual(
    await transitionWindowFullScreen(stalled, true, { platform: "darwin", timeoutMs: 5 }),
    { ok: false, isFullScreen: false, reason: "transition_timeout" }
  );

  const destroyed = new FakeFullscreenWindow({ destroyed: true });
  assert.deepEqual(
    await transitionWindowFullScreen(destroyed, true, { platform: "win32", timeoutMs: 5 }),
    { ok: false, isFullScreen: false, reason: "window_unavailable" }
  );
  assert.deepEqual(destroyed.requests, []);
});

test("desktopShell fullscreen IPC accepts only boolean requests from the current main window", async () => {
  const handlers = new Map();
  const sender = {};
  const otherSender = {};
  const mainWindow = new FakeFullscreenWindow();
  const otherWindow = new FakeFullscreenWindow();

  registerShellIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => undefined
  }, {
    platform: "win32",
    mainWindow,
    getMainWindow: () => mainWindow,
    BrowserWindow: {
      fromWebContents: (contents) => contents === sender
        ? mainWindow
        : contents === otherSender
          ? otherWindow
          : null
    }
  });

  const handler = handlers.get("desktopShell.setWindowFullScreen");
  assert.equal(typeof handler, "function");

  assert.deepEqual(await handler({ sender }, true), { ok: true, isFullScreen: true });
  assert.equal((await handler({ sender }, "true")).ok, false);
  assert.equal((await handler({ sender: otherSender }, false)).ok, false);
  assert.deepEqual(mainWindow.requests, [true]);
  assert.deepEqual(otherWindow.requests, []);
});

test("desktopShell renderer window controls operate only on the current main window", async () => {
  const handlers = new Map();
  const sender = {};
  const otherSender = {};
  const mainWindow = new FakeFullscreenWindow();
  const otherWindow = new FakeFullscreenWindow();

  registerShellIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => undefined
  }, {
    platform: "win32",
    mainWindow,
    getMainWindow: () => mainWindow,
    BrowserWindow: {
      fromWebContents: (contents) => contents === sender
        ? mainWindow
        : contents === otherSender
          ? otherWindow
          : null
    }
  });

  const minimize = handlers.get("desktopShell.minimizeWindow");
  const toggleMaximize = handlers.get("desktopShell.toggleWindowMaximize");
  const getWindowState = handlers.get("desktopShell.getWindowState");

  assert.deepEqual(await minimize({ sender }), { ok: true });
  assert.equal(mainWindow.minimized, true);
  assert.deepEqual(await toggleMaximize({ sender }), { ok: true, isMaximized: true });
  assert.deepEqual(await toggleMaximize({ sender }), { ok: true, isMaximized: false });
  assert.deepEqual(await getWindowState({ sender }), {
    ok: true,
    isFullScreen: false,
    isMaximized: false,
    windowControlsMasked: false
  });

  assert.equal((await minimize({ sender: otherSender })).ok, false);
  assert.equal((await toggleMaximize({ sender: otherSender })).ok, false);
  assert.equal((await getWindowState({ sender: otherSender })).ok, false);
  assert.equal(otherWindow.minimized, false);
  assert.equal(otherWindow.maximized, false);
});

test("desktopShell drag uses main-process DIP cursor coordinates across mixed-DPI displays", async () => {
  const handlers = new Map();
  const sender = {};
  const mainWindow = new FakeDragWindow();
  let cursorPoint = { x: 1920, y: 100 };
  let dragTick = null;

  registerShellIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => undefined
  }, {
    mainWindow,
    BrowserWindow: {
      fromWebContents: (contents) => contents === sender ? mainWindow : null
    },
    screen: {
      getCursorScreenPoint: () => ({ ...cursorPoint })
    },
    setInterval: (callback) => {
      dragTick = callback;
      return 1;
    },
    clearInterval: () => undefined
  });

  const beginDrag = handlers.get("desktopShell.beginWindowDrag");
  assert.equal(typeof beginDrag, "function");

  // A legacy renderer point from another DPI coordinate space must not seed the drag.
  assert.deepEqual(await beginDrag({ sender }, { x: 3840, y: 200 }), { ok: true });
  cursorPoint = { x: 1935, y: 112 };
  dragTick();

  assert.deepEqual(mainWindow.moves, [[95, 102]]);
});
