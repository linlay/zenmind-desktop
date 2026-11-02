import test from "node:test";
import assert from "node:assert/strict";
import { registerShellIpcHandlers } from "../dist-electron/main/modules/shell/ipc.js";

test("only the macOS main frame can project a boolean sidebar state to native controls", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const handlers = new Map();
    const mainFrame = {};
    const sender = { mainFrame };
    const window = { webContents: sender, destroyed: false, isDestroyed() { return this.destroyed; } };
    const received = [];
    registerShellIpcHandlers({ handle() {}, on: (channel, handler) => handlers.set(channel, handler) }, {
      platform, getMainWindow: () => window, setMainWindowSidebarCollapsed: value => received.push(value),
    });
    const update = handlers.get("desktopShell.setMainWindowSidebarCollapsed");
    const event = { sender, senderFrame: mainFrame };
    for (const value of ["true", 1, null, {}, { gap: 9 }]) update(event, value);
    update({ sender: { mainFrame }, senderFrame: mainFrame }, false);
    update({ sender, senderFrame: {} }, false);
    update({ sender, senderFrame: null }, false);
    window.destroyed = true;
    update(event, false);
    window.destroyed = false;
    assert.deepEqual(received, []);
    update(event, false);
    update(event, true);
    assert.deepEqual(received, platform === "darwin" ? [false, true] : []);
  }
});
