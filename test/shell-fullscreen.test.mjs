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
    this.mode = mode;
    this.requests = [];
  }

  isDestroyed() {
    return this.destroyed;
  }

  isFullScreen() {
    return this.fullscreen;
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
