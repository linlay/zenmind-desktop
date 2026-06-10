import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { registerDesktopPetIpcHandlers } = await import("../dist-electron/main/ipc/desktop-pet-handlers.js");

test("registerDesktopPetIpcHandlers registers desktopPet.getSettings", async () => {
  const handlers = {};
  const mockIpcMain = {
    handle(channel, callback) {
      handlers[channel] = callback;
    }
  };

  const mockOptions = {
    getSettings() {
      return {
        enabled: true,
        boundAgentKey: "test-agent",
        appearanceId: "classic"
      };
    }
  };

  registerDesktopPetIpcHandlers(mockIpcMain, mockOptions);

  assert.ok(handlers["desktopPet.getSettings"], "Should register desktopPet.getSettings");
  const result = await handlers["desktopPet.getSettings"]();
  assert.deepEqual(result, {
    enabled: true,
    boundAgentKey: "test-agent",
    appearanceId: "classic"
  }, "Should return mapped settings");
});

test("registerDesktopPetIpcHandlers registers desktopPet.getState", async () => {
  const handlers = {};
  const mockIpcMain = {
    handle(channel, callback) {
      handlers[channel] = callback;
    }
  };

  let scheduleStatusRefreshVal = null;
  let refreshStateCalled = false;
  let enabled = true;

  const mockOptions = {
    getSettings() {
      return { enabled };
    },
    scheduleStatusRefresh(val) {
      scheduleStatusRefreshVal = val;
    },
    refreshState() {
      refreshStateCalled = true;
      return { state: "mock-state" };
    }
  };

  registerDesktopPetIpcHandlers(mockIpcMain, mockOptions);

  assert.ok(handlers["desktopPet.getState"], "Should register desktopPet.getState");

  // Case 1: Enabled
  const result1 = await handlers["desktopPet.getState"]();
  assert.equal(scheduleStatusRefreshVal, 0);
  assert.equal(refreshStateCalled, true);
  assert.deepEqual(result1, { state: "mock-state" });

  // Case 2: Disabled
  enabled = false;
  scheduleStatusRefreshVal = null;
  refreshStateCalled = false;
  const result2 = await handlers["desktopPet.getState"]();
  assert.equal(scheduleStatusRefreshVal, null);
  assert.equal(refreshStateCalled, true);
  assert.deepEqual(result2, { state: "mock-state" });
});

test("registerDesktopPetIpcHandlers registers desktopPet.saveSettings", async () => {
  const handlers = {};
  const mockIpcMain = {
    handle(channel, callback) {
      handlers[channel] = callback;
    }
  };

  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-test-home-"));
  const mockApp = {
    getPath(name) {
      if (name === "home") return testHome;
      return "";
    }
  };

  let savedSettings = null;
  let clearedActiveRuns = false;
  let statusRefreshVal = null;
  let agentStatusVal = undefined;
  let windowShown = false;
  let windowHidden = false;

  let currentSettings = {
    enabled: false,
    boundAgentKey: "zenmi",
    appearanceId: "classic"
  };

  const mockOptions = {
    platform: "win32",
    app: mockApp,
    getSettings() {
      return currentSettings;
    },
    saveSettingsInState(settings) {
      savedSettings = settings;
      currentSettings = { ...currentSettings, ...settings };
    },
    setAgentStatus(status) {
      agentStatusVal = status;
    },
    clearActiveRuns() {
      clearedActiveRuns = true;
    },
    scheduleStatusRefresh(val) {
      statusRefreshVal = val;
    },
    showWindow() {
      windowShown = true;
    },
    hideWindow(disable) {
      windowHidden = disable;
    },
    refreshState() {
      return { state: "refreshed", settings: currentSettings };
    }
  };

  registerDesktopPetIpcHandlers(mockIpcMain, mockOptions);

  assert.ok(handlers["desktopPet.saveSettings"], "Should register desktopPet.saveSettings");

  // Case 1: Unsupported platform -> should return state without saving
  const unsupportedOptions = { ...mockOptions, platform: "linux" };
  const handlersLinux = {};
  const mockIpcMainLinux = {
    handle(channel, callback) {
      handlersLinux[channel] = callback;
    }
  };
  registerDesktopPetIpcHandlers(mockIpcMainLinux, unsupportedOptions);
  const resLinux = await handlersLinux["desktopPet.saveSettings"]({}, { enabled: true });
  assert.deepEqual(resLinux, { state: "refreshed", settings: currentSettings });
  assert.equal(savedSettings, null);

  // Case 2: Supported platform, no boundAgent change, just enabled change
  const resWin = await handlers["desktopPet.saveSettings"]({}, { enabled: true });
  assert.equal(windowShown, true);
  assert.equal(savedSettings, null);

  // Case 3: boundAgent input is ignored; appearanceId still changes
  windowShown = false;
  const resWinAgent = await handlers["desktopPet.saveSettings"]({}, { boundAgentKey: "test-agent", appearanceId: "dario" });
  assert.equal(savedSettings.boundAgentKey, "zenmi");
  assert.equal(savedSettings.appearanceId, "dario");
  assert.equal(clearedActiveRuns, false);
  assert.equal(agentStatusVal, undefined);
  assert.equal(statusRefreshVal, null);

  // Clean up
  fs.rmSync(testHome, { recursive: true, force: true });
});

test("registerDesktopPetIpcHandlers registers other window and interaction handlers", async () => {
  const handlers = {};
  const mockIpcMain = {
    handle(channel, callback) {
      handlers[channel] = callback;
    }
  };

  let showWindowCalled = false;
  let hideWindowVal = null;
  let openAssistantCalled = false;
  let openTaskChatVal = null;
  let moveByVal = null;
  let beginDragVal = null;
  let endDragCalled = false;
  let previewExpandedVal = null;
  let dismissPreviewCalled = false;
  let mouseInteractiveVal = null;
  let refreshStateCalled = false;

  const mockWebContents = { id: 42 };
  let windowMock = {
    isDestroyed() { return false; },
    webContents: mockWebContents
  };

  const mockOptions = {
    showWindow() { showWindowCalled = true; },
    hideWindow(val) { hideWindowVal = val; },
    openAssistant() {
      openAssistantCalled = true;
      return Promise.resolve("assistant-opened");
    },
    openTaskChat(input) {
      openTaskChatVal = input;
      return Promise.resolve({ ok: true });
    },
    moveWindowBy(delta) {
      moveByVal = delta;
      return { ok: true };
    },
    beginDrag(point) {
      beginDragVal = point;
      return { ok: true };
    },
    endDrag() {
      endDragCalled = true;
      return { ok: true, moved: true };
    },
    setPreviewExpanded(val) {
      previewExpandedVal = val;
    },
    dismissPreview() {
      dismissPreviewCalled = true;
      return { ok: true };
    },
    setMouseInteractive(val) {
      mouseInteractiveVal = val;
      return { ok: true };
    },
    refreshState() {
      refreshStateCalled = true;
      return { state: "refreshed" };
    },
    getWindow() {
      return windowMock;
    }
  };

  registerDesktopPetIpcHandlers(mockIpcMain, mockOptions);

  // show, hide, openAssistant
  await handlers["desktopPet.show"]();
  assert.equal(showWindowCalled, true);

  await handlers["desktopPet.hide"]();
  assert.equal(hideWindowVal, true);

  const openRes = await handlers["desktopPet.openAssistant"]();
  assert.equal(openAssistantCalled, true);
  assert.equal(openRes, "assistant-opened");

  const openTaskRes = await handlers["desktopPet.openTaskChat"](null, { agentKey: "zenmi", chatId: "chat-1" });
  assert.deepEqual(openTaskChatVal, { agentKey: "zenmi", chatId: "chat-1" });
  assert.deepEqual(openTaskRes, { ok: true });

  // Verification checks for event.sender (moveBy, beginDrag, endDrag, setPreviewExpanded, dismissPreview, setMouseInteractive)
  // Case 1: no window
  windowMock = null;
  const resNoWin = await handlers["desktopPet.moveBy"]({ sender: mockWebContents }, { x: 10, y: 20 });
  assert.deepEqual(resNoWin, { ok: false });

  // Case 2: window destroyed
  windowMock = {
    isDestroyed() { return true; },
    webContents: mockWebContents
  };
  const resDestroyed = await handlers["desktopPet.beginDrag"]({ sender: mockWebContents }, { x: 1, y: 2 });
  assert.deepEqual(resDestroyed, { ok: false });

  // Case 3: sender mismatch
  windowMock = {
    isDestroyed() { return false; },
    webContents: mockWebContents
  };
  const resMismatch = await handlers["desktopPet.endDrag"]({ sender: { id: 99 } });
  assert.deepEqual(resMismatch, { ok: false, moved: false });

  // Case 4: valid sender matches webContents
  const resMove = await handlers["desktopPet.moveBy"]({ sender: mockWebContents }, { x: 5, y: 5 });
  assert.deepEqual(resMove, { ok: true });
  assert.deepEqual(moveByVal, { x: 5, y: 5 });

  const resBegin = await handlers["desktopPet.beginDrag"]({ sender: mockWebContents }, { x: 2, y: 2 });
  assert.deepEqual(resBegin, { ok: true });
  assert.deepEqual(beginDragVal, { x: 2, y: 2 });

  const resEnd = await handlers["desktopPet.endDrag"]({ sender: mockWebContents });
  assert.deepEqual(resEnd, { ok: true, moved: true });
  assert.equal(endDragCalled, true);

  const resPreview = await handlers["desktopPet.setPreviewExpanded"]({ sender: mockWebContents }, true);
  assert.deepEqual(resPreview, { ok: true });
  assert.equal(previewExpandedVal, true);
  assert.equal(refreshStateCalled, true);

  refreshStateCalled = false;
  const resDismiss = await handlers["desktopPet.dismissPreview"]({ sender: mockWebContents });
  assert.deepEqual(resDismiss, { ok: true });
  assert.equal(dismissPreviewCalled, true);

  const resInteractive = await handlers["desktopPet.setMouseInteractive"]({ sender: mockWebContents }, false);
  assert.deepEqual(resInteractive, { ok: true });
  assert.equal(mouseInteractiveVal, false);
});
