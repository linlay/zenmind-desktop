import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createDesktopPetRuntime } = require("../dist-electron/main/modules/pet/runtime.js");

for (const platform of ["darwin", "win32"]) {
  test(`pet close keeps the unread card and badge until the authoritative read state arrives (${platform})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-dismiss-read-"));
    const now = Date.now();
    const chat = { chatId: "chat-1", chatName: "Test", agentKey: "cutej", updatedAt: now, lastRunId: "run-1", lastRunContent: "Result", isRead: false, hasActiveRun: false, hasPendingAwaiting: false };
    const agent = { agentKey: "cutej", displayName: "CuteJ", role: "", unreadCount: 1, unreadChatCount: 1, recentChats: [chat] };
    const snapshot = { ok: true, items: [agent], chatItems: [chat] };
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
      const awaitingReadState = runtime.refreshState();
      assert.equal(awaitingReadState.messages.length, 1);
      assert.equal(awaitingReadState.unreadCount, 1);
      assert.equal(awaitingReadState.messages.length, awaitingReadState.navigationAttention.total.unreadCount);
      assert.equal(chat.isRead, false, "runtime must wait for the authoritative read Push");

      chat.isRead = true;
      chat.readRunId = "run-1";
      agent.unreadCount = 0;
      agent.unreadChatCount = 0;
      const readState = runtime.refreshState();
      assert.equal(readState.messages.length, 0);
      assert.equal(readState.unreadCount, 0);
      assert.equal(readState.messages.length, readState.navigationAttention.total.unreadCount);

      chat.lastRunId = "run-2";
      chat.updatedAt = now + 1;
      chat.isRead = false;
      agent.unreadCount = 1;
      agent.unreadChatCount = 1;
      const newRunState = runtime.refreshState();
      assert.equal(newRunState.messages.length, 1, "new run must remain visible");
      assert.equal(newRunState.unreadCount, 1);
      assert.equal((await runtime.dismissMessage(bridge, message)).ok, false);
      assert.equal(calls.length, 2, "stale dismissal must not mark a newer run read");

      const replyCalls = [];
      const replyResult = await runtime.replyMessage({
        startRun: async (input) => { replyCalls.push(input); return { ok: true, runId: "run-3" }; },
      }, { chatId: "chat-1", agentKey: "cutej", message: "Continue" });
      assert.equal(replyResult.ok, true);
      assert.deepEqual(replyCalls, [{ chatId: "chat-1", agentKey: "cutej", message: "Continue" }]);
      const repliedState = runtime.refreshState();
      assert.equal(repliedState.messages.length, 1, "a successful reply does not mark the previous content read");
      assert.equal(repliedState.unreadCount, 1);
    } finally {
      runtime.clearIdleResetTimer();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const isRead of [false, true]) {
    test(`pet awaiting cards only open the original chat and reject reply or dismissal (${platform}, read=${isRead})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-awaiting-actions-"));
      const now = Date.now();
      const chat = {
        chatId: "waiting", chatName: "Approval", agentKey: "cutej", createdAt: now - 1, updatedAt: now,
        lastRunId: "run-1", lastRunContent: "Please confirm", isRead,
        hasActiveRun: true, hasPendingAwaiting: true, awaitingMode: "approval", awaitingCount: 1,
      };
      const agent = {
        agentKey: "cutej", displayName: "CuteJ", role: "", updatedAt: now,
        unreadCount: Number(!isRead), unreadChatCount: Number(!isRead), hasPendingAwaiting: true,
        recentChats: [chat], attentionChats: [chat],
      };
      const snapshot = { ok: true, items: [agent], activityItems: [agent], chatItems: [chat] };
      const display = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
      const openCalls = [];
      const readCalls = [];
      const replyCalls = [];
      const runtime = createDesktopPetRuntime({
        app: { getPath: name => path.join(root, name), getAppPath: () => root }, platform,
        getMainWindow: () => null, isHandlingQuit: () => false, getNavigationSnapshot: () => snapshot,
        screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => display, getDisplayMatching: () => display },
        preloadPath: "", loadRendererRoute: async () => {}, showMainWindow: () => {},
        openAssistantWorker: async input => { openCalls.push(input); },
        publishPluginAssistantActiveTasks: () => {}, refreshTrayContextMenu: () => {},
      });
      try {
        runtime.initializeState(false);
        const initialState = runtime.refreshState();
        const message = initialState.messages[0];
        assert.ok(message, "read awaiting is visible alongside unread awaiting");
        assert.equal(message.status, "awaiting");
        assert.equal(message.unread, !isRead);
        assert.equal(initialState.navigationAttention.total.pendingCount, 1);
        assert.equal(initialState.unreadCount, Number(!isRead));

        const readBridge = { markChatRead: async (...args) => { readCalls.push(args); return { ok: true }; } };
        assert.equal((await runtime.dismissMessage(readBridge, message)).ok, false);
        assert.equal((await runtime.dismissMessage(readBridge, { ...message, status: "done", unread: true })).ok, false,
          "a stale renderer cannot turn waiting into an ordinary unread dismissal");
        assert.equal((await runtime.replyMessage({
          startRun: async input => { replyCalls.push(input); return { ok: true, runId: "run-2" }; },
        }, { chatId: message.chatId, agentKey: message.agentKey, message: "Continue" })).ok, false);
        assert.deepEqual(readCalls, [], "dismissal cannot mark an unresolved awaiting read");
        assert.deepEqual(replyCalls, [], "awaiting must be answered in its original chat");

        assert.equal((await runtime.openTaskChat({ chatId: message.chatId, agentKey: message.agentKey })).ok, true);
        assert.deepEqual(openCalls, [{ agentKey: "cutej", chatId: "waiting", focusComposerOnComplete: false }]);
        const openedState = runtime.refreshState();
        assert.equal(openedState.messages.length, 1, "opening the chat does not resolve awaiting");
        assert.equal(openedState.navigationAttention.total.pendingCount, 1);
        assert.equal(chat.isRead, isRead, "open navigation does not mark content read");
      } finally {
        runtime.clearIdleResetTimer();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
