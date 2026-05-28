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

test("settings.setNativeThemeSource maps dark to dark and other values to light", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const nativeTheme = { themeSource: "system" };

  registerSettingsIpcHandlers(ipc, makeBaseOptions({ nativeTheme }));

  assert.deepEqual(await handlers["settings.setNativeThemeSource"]({}, "dark"), {
    ok: true,
    themeSource: "dark"
  });
  assert.equal(nativeTheme.themeSource, "dark");

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
