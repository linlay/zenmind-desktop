import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createDesktopPetRuntime } = require("../dist-electron/main/modules/pet/runtime.js");

for (const platform of ["darwin", "win32"]) {
  test(`pet close marks the displayed run read before dismissal (${platform})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-dismiss-read-"));
    const now = Date.now();
    const chat = { chatId: "chat-1", chatName: "Test", agentKey: "cutej", updatedAt: now, lastRunId: "run-1", lastRunContent: "Result", isRead: false, hasActiveRun: false, hasPendingAwaiting: false };
    const snapshot = { ok: true, items: [{ agentKey: "cutej", displayName: "CuteJ", role: "", unreadCount: 1, recentChats: [chat] }] };
    const display = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
    const runtime = createDesktopPetRuntime({
      app: { getPath: name => path.join(root, name), getAppPath: () => root }, platform,
      getMainWindow: () => null, isHandlingQuit: () => false, getNavigationSnapshot: () => snapshot,
      screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => display, getDisplayMatching: () => display },
      preloadPath: "", loadRendererRoute: async () => {}, showMainWindow: () => {}, openAssistantWorker: async () => {},
      publishPluginAssistantActiveTasks: () => {}, refreshTrayContextMenu: () => {}
    });
    try {
      runtime.initializeState(false);
      const message = runtime.refreshState().messages[0];
      assert.ok(message);
      let fail = true;
      const calls = [];
      const bridge = { markChatRead: async (...args) => { calls.push(args); return { ok: !fail }; } };
      assert.equal((await runtime.dismissMessage(bridge, { ...message, updatedAt: now - 1 })).ok, false);
      assert.equal(calls.length, 0);
      assert.equal((await runtime.dismissMessage(bridge, message)).ok, false);
      assert.equal(runtime.refreshState().messages.length, 1);
      fail = false;
      assert.equal((await runtime.dismissMessage(bridge, message)).ok, true);
      assert.deepEqual(calls, [["chat-1", "run-1"], ["chat-1", "run-1"]]);
      assert.equal(runtime.refreshState().messages.length, 0);
      assert.equal(chat.isRead, false, "runtime must wait for the authoritative read Push");
      chat.lastRunId = "run-2";
      chat.updatedAt = now + 1;
      assert.equal(runtime.refreshState().messages.length, 1, "new run must remain visible");
      assert.equal((await runtime.dismissMessage(bridge, message)).ok, false);
      assert.equal(calls.length, 2, "stale dismissal must not mark a newer run read");
    } finally {
      runtime.clearIdleResetTimer();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
