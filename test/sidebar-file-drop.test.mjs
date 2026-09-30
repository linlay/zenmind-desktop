import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { registerShellIpcHandlers } = await import("../dist-electron/main/modules/shell/ipc.js");

for (const platform of ["darwin", "win32"]) {
  test(`dropped project directory validates source and filesystem (${platform})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-drop-"));
    try {
      const directory = path.join(root, "项目 folder");
      fs.mkdirSync(directory);
      const archive = path.join(root, "app.zip");
      fs.writeFileSync(archive, "fixture");
      const handlers = new Map();
      const sender = { mainFrame: {} };
      const mainWindow = { webContents: sender, isDestroyed: () => false };
      registerShellIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler), on() {} }, {
        platform, mainWindow,
        BrowserWindow: { fromWebContents: contents => contents === sender ? mainWindow : null }
      });
      const resolve = handlers.get("desktopDialog.resolveDroppedDirectory");
      const event = { sender, senderFrame: sender.mainFrame };
      assert.deepEqual(await resolve(event, directory), { ok: true, path: fs.realpathSync(directory) });
      for (const invalid of [archive, "relative", "", null, path.join(root, "missing")]) {
        assert.equal((await resolve(event, invalid)).ok, false);
      }
      assert.equal((await resolve({ sender: {}, senderFrame: {} }, directory)).ok, false);
      assert.equal((await resolve({ sender, senderFrame: {} }, directory)).ok, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
