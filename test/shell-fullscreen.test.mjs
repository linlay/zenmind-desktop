import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const {
  registerShellIpcHandlers,
  transitionWindowFullScreen
} = await import("../dist-electron/main/modules/shell/ipc.js");

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

  getBounds() {
    return { x: 80, y: 90, width: 1440, height: 920 };
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

test("deprecated renderer compatibility diagnostics omit routes and keep their stable source", () => {
  const listeners = new Map();
  const reports = [];
  const sender = {
    getURL() {
      throw new Error("deprecated compatibility diagnostics must not read the renderer URL");
    }
  };
  registerShellIpcHandlers({
    handle: () => undefined,
    on: (channel, handler) => listeners.set(channel, handler)
  }, {
    BrowserWindow: {
      fromWebContents: () => ({ id: 71 })
    },
    reportRendererDiagnostic: (source, details) => reports.push({ source, details })
  });

  listeners.get("diagnostics.rendererError")({ sender }, {
    source: "deprecated-compatibility",
    level: "warn",
    message: "surface.legacy-alias",
    details: {
      category: "fixed",
      canonicalRole: "main-chat",
      chatId: "must-not-be-logged",
      path: "/must/not/be/logged"
    },
    stack: "must-not-be-logged",
    filename: "/must/not/be/logged.ts"
  });

  assert.deepEqual(reports, [{
    source: "deprecated-compatibility",
    details: {
      diagnosticLevel: "warn",
      windowId: 71,
      source: "deprecated-compatibility",
      message: "surface.legacy-alias",
      details: { category: "fixed", canonicalRole: "main-chat" }
    }
  }]);
  assert.equal(Object.hasOwn(reports[0].details, "route"), false);
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
    platform: "darwin",
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

test("Windows drag preserves initial size and ignores native bounds drift on every tick", async () => {
  const handlers = new Map();
  const sender = {};
  const mainWindow = new FakeFullscreenWindow();
  let cursor = { x: 1920, y: 100 };
  let tick;
  let bounds = mainWindow.getBounds();
  const updates = [];
  mainWindow.getBounds = () => ({ ...bounds });
  mainWindow.setPosition = () => assert.fail("Windows drag must not use setPosition");
  mainWindow.setBounds = (next, animate) => {
    assert.equal(animate, false);
    updates.push(next);
    // Simulate native frame/DPI rounding after each requested move.
    bounds = { x: next.x + 1, y: next.y + 1, width: next.width + 2, height: next.height + 2 };
  };
  mainWindow.moveTop = () => {};
  registerShellIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler), on: () => {}
  }, {
    platform: "win32", mainWindow,
    BrowserWindow: { fromWebContents: () => mainWindow },
    screen: { getCursorScreenPoint: () => ({ ...cursor }) },
    setInterval: (callback) => { tick = callback; return 1; }, clearInterval: () => {}
  });
  assert.deepEqual(await handlers.get("desktopShell.beginWindowDrag")({ sender }), { ok: true });
  for (let step = 1; step <= 100; step++) {
    cursor = { x: 1920 + step * 2, y: 100 + step };
    tick();
    assert.deepEqual(updates.at(-1), { x: 80 + step * 2, y: 90 + step, width: 1440, height: 920 });
  }
  tick();
  assert.equal(updates.length, 100);
  await handlers.get("desktopShell.endWindowDrag")();
  cursor.x += 10;
  tick();
  assert.equal(updates.length, 100);
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: maximize/restore ends the drag before resizing and preserves native fullscreen`, async () => {
    const handlers = new Map();
    const sender = {};
    const mainWindow = new FakeFullscreenWindow();
    let tick;
    const timer = {};
    let activeTimer = null;
    registerShellIpcHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => undefined,
    }, {
      platform,
      mainWindow,
      BrowserWindow: { fromWebContents: (contents) => contents === sender ? mainWindow : null },
      screen: { getCursorScreenPoint: () => ({ x: 100, y: 100 }) },
      setInterval: (callback) => { tick = callback; activeTimer = timer; return timer; },
      clearInterval: (handle) => { assert.equal(handle, timer); activeTimer = null; },
    });
    for (const eventName of ["maximize", "unmaximize"]) {
      mainWindow.on(eventName, () => assert.equal(activeTimer, null));
    }
    const beginDrag = handlers.get("desktopShell.beginWindowDrag");
    const toggleMaximize = handlers.get("desktopShell.toggleWindowMaximize");
    for (const expected of [true, false]) {
      await beginDrag({ sender });
      assert.equal(activeTimer, timer);
      assert.deepEqual(await toggleMaximize({ sender }), { ok: true, isMaximized: expected });
      tick(); // A tick already queued before cancellation must not move the resized window.
    }
    await beginDrag({ sender });
    mainWindow.fullscreen = true; // Native state can change before renderer receives its event.
    assert.deepEqual(await toggleMaximize({ sender }), { ok: true, isMaximized: false });
    assert.equal(activeTimer, null);
    assert.equal(mainWindow.fullscreen, true);
    assert.deepEqual(mainWindow.requests, []);
    assert.equal((await toggleMaximize({ sender: {} })).ok, false);
  });
}
