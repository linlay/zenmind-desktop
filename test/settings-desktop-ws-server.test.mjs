import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { registerSettingsIpcHandlers } = require("../dist-electron/main/ipc/settings-handlers.js");
const { readDesktopProfileFromRoot } = require("../dist-electron/main/desktop-profile-store.js");
const { getDesktopConfigRoot } = require("../dist-electron/main/user-paths.js");
const {
  DESKTOP_WS_HOST,
  DESKTOP_WS_PATH,
  DESKTOP_WS_PORT,
  DESKTOP_WS_URL
} = require("../dist-electron/shared/desktop-ws.js");

function createApp(homePath) {
  return {
    name: "ZenMind Test",
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "app-data");
      }
      assert.fail(`unexpected app.getPath(${name})`);
    },
    getVersion() {
      return "0.0.0-test";
    }
  };
}

function createIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      assert.equal(typeof handler, "function", `missing ipc handler ${channel}`);
      return handler({}, ...args);
    }
  };
}

function runtimeState(running) {
  return {
    running,
    host: DESKTOP_WS_HOST,
    port: DESKTOP_WS_PORT,
    path: DESKTOP_WS_PATH,
    url: DESKTOP_WS_URL
  };
}

function registerSettingsHandlers(app, overrides = {}) {
  const ipcMain = createIpcMain();
  registerSettingsIpcHandlers(ipcMain, {
    app,
    platform: "darwin",
    nativeTheme: { themeSource: "system" },
    getDataRoot: () => "",
    initializeMainI18n: () => ({ locale: "zh-CN", source: "system" }),
    isSupportedLocale: () => true,
    setMainLocale: () => ({ locale: "zh-CN", source: "user" }),
    buildApplicationMenu() {},
    refreshTrayContextMenu() {},
    emitLocaleChanged() {},
    ...overrides
  });
  return ipcMain;
}

test("desktop ws server setting defaults to disabled and does not start by reading state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-ws-setting-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  let startCalls = 0;
  const ipcMain = registerSettingsHandlers(app, {
    getDesktopWsServerRuntimeState: () => runtimeState(false),
    startDesktopWsServer: async () => {
      startCalls += 1;
      return runtimeState(true);
    }
  });

  const state = await ipcMain.invoke("settings.getDesktopWsServerState");
  assert.deepEqual(state, {
    enabled: false,
    ...runtimeState(false)
  });
  assert.equal(startCalls, 0);
  assert.equal(readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.desktopWsServerEnabled, false);
});

test("desktop ws server setting persists successful open and close", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-ws-setting-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  let running = false;
  let startCalls = 0;
  let stopCalls = 0;
  const ipcMain = registerSettingsHandlers(app, {
    getDesktopWsServerRuntimeState: () => runtimeState(running),
    startDesktopWsServer: async () => {
      startCalls += 1;
      running = true;
      return runtimeState(running);
    },
    stopDesktopWsServer: async () => {
      stopCalls += 1;
      running = false;
      return runtimeState(running);
    }
  });

  const openState = await ipcMain.invoke("settings.setDesktopWsServerEnabled", true);
  assert.equal(openState.enabled, true);
  assert.equal(openState.running, true);
  assert.equal(openState.url, DESKTOP_WS_URL);
  assert.equal(startCalls, 1);
  assert.equal(readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.desktopWsServerEnabled, true);

  await ipcMain.invoke("settings.saveGeneralSettings", {
    preventSleepWhileRunning: false,
    desktopWsServerEnabled: false,
    desktopActionConfirmationEnabled: false
  });
  let general = readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general;
  assert.equal(general.desktopWsServerEnabled, true);
  assert.equal(general.desktopActionConfirmationEnabled, false);

  const closeState = await ipcMain.invoke("settings.setDesktopWsServerEnabled", false);
  assert.equal(closeState.enabled, false);
  assert.equal(closeState.running, false);
  assert.equal(stopCalls, 1);
  general = readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general;
  assert.equal(general.desktopWsServerEnabled, false);
  assert.equal(general.desktopActionConfirmationEnabled, false);
});

test("general settings persist desktop device name and expose device info", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-general-device-info-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  const changedSettings = [];
  const ipcMain = registerSettingsHandlers(app, {
    onGeneralSettingsChanged: (settings) => {
      changedSettings.push(settings);
    }
  });

  const saved = await ipcMain.invoke("settings.saveGeneralSettings", {
    deviceName: "  Studio Mac  ",
    preventSleepWhileRunning: false,
    desktopActionConfirmationEnabled: false
  });
  assert.equal(saved.deviceName, "Studio Mac");
  assert.equal(saved.preventSleepWhileRunning, false);
  assert.equal(saved.desktopActionConfirmationEnabled, false);
  assert.equal(changedSettings.at(-1).deviceName, "Studio Mac");
  let general = readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general;
  assert.equal(general.deviceName, "Studio Mac");
  assert.equal(general.desktopActionConfirmationEnabled, false);

  const info = await ipcMain.invoke("settings.getDesktopDeviceInfo");
  assert.equal(info.configuredDeviceName, "Studio Mac");
  assert.equal(info.deviceName, "Studio Mac");
  assert.match(info.deviceId, /^[0-9a-f-]+$/u);
  assert.equal(typeof info.hostname, "string");
  assert.equal(typeof info.username, "string");
  assert.equal(typeof info.platform, "string");
  assert.equal(typeof info.arch, "string");

  const cleared = await ipcMain.invoke("settings.saveGeneralSettings", {
    deviceName: ""
  });
  assert.equal(cleared.deviceName, "");
  assert.equal(cleared.desktopActionConfirmationEnabled, false);
  const fallbackInfo = await ipcMain.invoke("settings.getDesktopDeviceInfo");
  assert.equal(fallbackInfo.configuredDeviceName, "");
  assert.equal(typeof fallbackInfo.deviceName, "string");
  assert.ok(fallbackInfo.deviceName.length > 0);
});

test("desktop ws server setting does not persist enable when start fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-ws-setting-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  const ipcMain = registerSettingsHandlers(app, {
    getDesktopWsServerRuntimeState: () => runtimeState(false),
    startDesktopWsServer: async () => {
      throw new Error("EADDRINUSE: address already in use 127.0.0.1:7082");
    }
  });

  const state = await ipcMain.invoke("settings.setDesktopWsServerEnabled", true);
  assert.equal(state.enabled, false);
  assert.equal(state.running, false);
  assert.match(state.message, /EADDRINUSE/);
  assert.equal(readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.desktopWsServerEnabled, false);
});

test("runtime env reset reports that restart is required before bootstrap resumes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-runtime-reset-result-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createApp(path.join(root, "home"));
  const ipcMain = registerSettingsHandlers(app, {
    resetRuntimeEnv: async () => ({
      targetRoot: path.join(root, "home", ".zenmind"),
      backupPath: path.join(root, "home", ".zenmind-123"),
      copiedFiles: 12,
      skippedFiles: 0,
      sourceZipPath: path.join(root, "env.zip")
    })
  });

  const result = await ipcMain.invoke("settings.resetRuntimeEnv");
  assert.equal(result.ok, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.copiedFiles, 12);
  assert.match(result.backupPath, /\.zenmind-123$/u);
});
