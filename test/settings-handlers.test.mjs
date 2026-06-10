import test from "node:test";
import assert from "node:assert/strict";

const { registerSettingsIpcHandlers } = await import("../dist-electron/main/ipc/settings-handlers.js");

function makeMockIpcMain() {
  const handlers = {};
  return {
    ipc: {
      handle(channel, callback) {
        handlers[channel] = callback;
      }
    },
    handlers
  };
}

function makeBaseOptions(overrides = {}) {
  return {
    app: { name: "test-app" },
    platform: "linux",
    nativeTheme: { themeSource: "light" },
    getDataRoot: () => "/data/root",
    initializeMainI18n: () => ({ locale: "en-US", source: "stored" }),
    isSupportedLocale: (locale) => locale === "en-US" || locale === "zh-CN",
    setMainLocale: (_app, locale) => ({ locale, source: "stored" }),
    buildApplicationMenu: () => {},
    refreshTrayContextMenu: () => {},
    emitLocaleChanged: () => {},
    ...overrides
  };
}

test("settings handlers expose data root and platform", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerSettingsIpcHandlers(ipc, makeBaseOptions({
    platform: "win32",
    getDataRoot: (app) => {
      assert.equal(app.name, "test-app");
      return "C:/ZenMind/Data";
    }
  }));

  assert.ok(handlers["settings.getDataRoot"], "Should register settings.getDataRoot");
  assert.ok(handlers["settings.getPlatform"], "Should register settings.getPlatform");
  assert.equal(await handlers["settings.getDataRoot"]({}), "C:/ZenMind/Data");
  assert.equal(await handlers["settings.getPlatform"]({}), "win32");
});

test("settings.createAppPairingPayload delegates to injected pairing creator", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const payloadResult = {
    ok: true,
    payload: {
      desktopDeviceId: "9d8f4d98-14e6-4af9-b60e-6f949560dbb6",
      desktopIdentityCreatedAt: "2026-06-01T00:00:00.000Z",
      desktopUsername: "alice",
      desktopHostname: "workstation",
      appServerIssuer: "http://127.0.0.1:7076",
      appServerPublicKeySha256: "abc123",
      apiBaseUrl: "http://192.168.1.8:7076",
      pairingId: "55823d81-647c-4108-a035-cdff249e2e40",
      secret: "secret",
      expiresAt: "2026-06-10T10:00:00.000Z"
    },
    payloadText: "{}"
  };

  registerSettingsIpcHandlers(ipc, makeBaseOptions({
    createAppPairingPayload: async (app) => {
      assert.equal(app.name, "test-app");
      return payloadResult;
    }
  }));

  assert.deepEqual(await handlers["settings.createAppPairingPayload"]({}), payloadResult);
});

test("settings.createAppPairingPayload reports unavailable creator", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  registerSettingsIpcHandlers(ipc, makeBaseOptions());

  assert.deepEqual(await handlers["settings.createAppPairingPayload"]({}), {
    ok: false,
    message: "App 配对功能不可用。"
  });
});

test("settings.resetRuntimeEnv returns structured success details", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];

  registerSettingsIpcHandlers(ipc, makeBaseOptions({
    platform: "darwin",
    resetRuntimeEnv: async (app, platform) => {
      calls.push([app.name, platform]);
      return {
        targetRoot: "/Users/alice/.zenmind",
        backupPath: "/Users/alice/.zenmind-1778899101",
        copiedFiles: 2,
        skippedFiles: 0,
        sourceZipPath: "/Applications/ZenMind.app/Contents/Resources/env/env.zip"
      };
    }
  }));

  const result = await handlers["settings.resetRuntimeEnv"]({});

  assert.deepEqual(calls, [["test-app", "darwin"]]);
  assert.deepEqual(result, {
    ok: true,
    message: "运行环境已重置。旧目录已备份到：/Users/alice/.zenmind-1778899101。请重启应用。",
    runtimeRoot: "/Users/alice/.zenmind",
    backupPath: "/Users/alice/.zenmind-1778899101",
    copiedFiles: 2,
    skippedFiles: 0,
    sourceZipPath: "/Applications/ZenMind.app/Contents/Resources/env/env.zip"
  });
});

test("settings.resetRuntimeEnv returns structured failure details", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const failure = new Error("安装包内置 env.zip 不存在，无法重置运行环境。");
  failure.runtimeRoot = "/Users/alice/.zenmind";
  failure.sourceZipPath = "/Applications/ZenMind.app/Contents/Resources/env/env.zip";

  registerSettingsIpcHandlers(ipc, makeBaseOptions({
    resetRuntimeEnv: async () => {
      throw failure;
    }
  }));

  const result = await handlers["settings.resetRuntimeEnv"]({});

  assert.deepEqual(result, {
    ok: false,
    message: "安装包内置 env.zip 不存在，无法重置运行环境。",
    runtimeRoot: "/Users/alice/.zenmind",
    backupPath: undefined,
    copiedFiles: 0,
    skippedFiles: 0,
    sourceZipPath: "/Applications/ZenMind.app/Contents/Resources/env/env.zip"
  });
});

test("settings.setNativeThemeSource maps dark, system, and other values to light", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const nativeTheme = { themeSource: "light" };

  registerSettingsIpcHandlers(ipc, makeBaseOptions({ nativeTheme }));

  assert.deepEqual(await handlers["settings.setNativeThemeSource"]({}, "dark"), {
    ok: true,
    themeSource: "dark"
  });
  assert.equal(nativeTheme.themeSource, "dark");

  assert.deepEqual(await handlers["settings.setNativeThemeSource"]({}, "system"), {
    ok: true,
    themeSource: "system"
  });
  assert.equal(nativeTheme.themeSource, "system");

  assert.deepEqual(await handlers["settings.setNativeThemeSource"]({}, "sepia"), {
    ok: true,
    themeSource: "light"
  });
  assert.equal(nativeTheme.themeSource, "light");
});

test("settings.getLocale returns initialized main locale settings", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const localeSettings = { locale: "zh-CN", source: "system" };

  registerSettingsIpcHandlers(ipc, makeBaseOptions({
    initializeMainI18n: (app) => {
      assert.equal(app.name, "test-app");
      return localeSettings;
    }
  }));

  assert.deepEqual(await handlers["settings.getLocale"]({}), localeSettings);
});

test("settings.setLocale saves supported locales and notifies shell surfaces", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];
  const nextSettings = { locale: "zh-CN", source: "stored" };

  registerSettingsIpcHandlers(ipc, makeBaseOptions({
    setMainLocale: (app, locale) => {
      assert.equal(app.name, "test-app");
      calls.push(["set", locale]);
      return nextSettings;
    },
    buildApplicationMenu: () => calls.push("menu"),
    refreshTrayContextMenu: () => calls.push("tray"),
    emitLocaleChanged: (settings) => calls.push(["emit", settings])
  }));

  const result = await handlers["settings.setLocale"]({}, "zh-CN");

  assert.deepEqual(result, nextSettings);
  assert.deepEqual(calls, [
    ["set", "zh-CN"],
    "menu",
    "tray",
    ["emit", nextSettings]
  ]);
});

test("settings.setLocale ignores unsupported locales and returns current locale", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const currentSettings = { locale: "en-US", source: "stored" };
  let saved = false;

  registerSettingsIpcHandlers(ipc, makeBaseOptions({
    initializeMainI18n: () => currentSettings,
    setMainLocale: () => {
      saved = true;
      return { locale: "zh-CN", source: "stored" };
    }
  }));

  const result = await handlers["settings.setLocale"]({}, "fr-FR");

  assert.deepEqual(result, currentSettings);
  assert.equal(saved, false);
});
