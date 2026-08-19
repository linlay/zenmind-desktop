import test from "node:test";
import assert from "node:assert/strict";

const { registerShellIpcHandlers } = await import("../dist-electron/main/ipc/shell-handlers.js");

class FakeDragWindow {
  constructor() {
    this.position = [20, 30];
    this.moveTopCount = 0;
  }

  isDestroyed() {
    return false;
  }

  isFullScreen() {
    return false;
  }

  getPosition() {
    return [...this.position];
  }

  setPosition(x, y) {
    this.position = [x, y];
  }

  moveTop() {
    this.moveTopCount += 1;
  }
}

test("guest pointer updates move only the window that started the active drag", async () => {
  const handlers = new Map();
  const listeners = new Map();
  const sender = {};
  const otherSender = {};
  const mainWindow = new FakeDragWindow();
  const otherWindow = new FakeDragWindow();

  registerShellIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener)
  }, {
    mainWindow,
    BrowserWindow: {
      fromWebContents: (contents) => contents === sender
        ? mainWindow
        : contents === otherSender
          ? otherWindow
          : null
    },
    setInterval: () => 1,
    clearInterval: () => undefined,
    screen: {
      getCursorScreenPoint: () => ({ x: 100, y: 100 })
    }
  });

  const begin = handlers.get("desktopShell.beginWindowDrag");
  const end = handlers.get("desktopShell.endWindowDrag");
  const update = listeners.get("desktopShell.updateWindowDrag");
  assert.equal(typeof begin, "function");
  assert.equal(typeof end, "function");
  assert.equal(typeof update, "function");

  assert.deepEqual(await begin({ sender }, { x: 100, y: 100 }), { ok: true });
  update({ sender: otherSender }, { x: 180, y: 160 });
  assert.deepEqual(mainWindow.position, [20, 30]);
  assert.deepEqual(otherWindow.position, [20, 30]);

  update({ sender }, { x: 140, y: 125 });
  assert.deepEqual(mainWindow.position, [60, 55]);
  assert.equal(mainWindow.moveTopCount, 1);

  assert.deepEqual(await end(), { ok: true });
  update({ sender }, { x: 180, y: 160 });
  assert.deepEqual(mainWindow.position, [60, 55]);
});
