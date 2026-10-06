import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createTranslator } from "../dist-electron/shared/i18n/index.js";
const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const templates = [];
const Menu = {
  setApplicationMenu() {},
  buildFromTemplate(template) {
    templates.push(template);
    return { popup: ({ callback }) => callback() };
  }
};
let buildApplicationMenu, popupWindowsApplicationMenu;
try {
  Module._load = function (request, parent, isMain) {
    return request === "electron" ? { Menu } : originalLoad.call(this, request, parent, isMain);
  };
  ({ buildApplicationMenu, popupWindowsApplicationMenu } = require("../dist-electron/main/modules/shell/app-menu.js"));
} finally {
  Module._load = originalLoad;
}
const noop = () => {};
function build(platform, helpEnabled, t = (key) => key, toggleDesktopDevTools = noop) {
  templates.length = 0;
  buildApplicationMenu({ platform, helpEnabled, appName: "Test", t,
    openSettings: noop, openHelp: noop, toggleDesktopDevTools, requestCloseWindow: noop,
    requestQuit: noop, quitWithoutConfirmation: noop });
}
test("Windows removes unavailable Help including stale popup registrations and retains local About", async () => {
  const window = { getContentSize: () => [800, 600] };
  build("win32", true);
  assert.equal(await popupWindowsApplicationMenu(window, { menu: "help", x: 10, y: 10 }), true);
  assert(templates.flat().some(item => item.label === "nav.help"));
  build("win32", false);
  assert.equal(await popupWindowsApplicationMenu(window, { menu: "help", x: 10, y: 10 }), false);
  assert(!templates.flat().some(item => item.label === "nav.help"));
  assert(templates[0].some(item => item.role === "about"));
  for (const menu of ["file", "edit", "view"]) {
    assert.equal(await popupWindowsApplicationMenu(window, { menu, x: 10, y: 10 }), true);
  }
});

test("macOS menus consistently follow the application locale when rebuilt", () => {
  for (const locale of ["en-US", "zh-CN", "en-US"]) {
    const t = createTranslator(locale);
    build("darwin", false, t);
    const menu = templates[0];
    const view = menu.find(item => item.label === t("menu.view"));
    const window = menu.find(item => item.label === t("menu.window"));
    assert(view && window);
    assert.equal(window.submenu[0].label, t("menu.closeWindow"));
    assert.equal(window.submenu.find(item => item.role === "minimize").label, t("menu.minimize"));
    assert.equal(window.submenu.find(item => item.role === "zoom").label, t("menu.zoomWindow"));
    function inspect(items) {
      for (const item of items) {
        if (item.type !== "separator") assert(item.label, `missing localized label: ${item.role}`);
        assert.notEqual(item.role, "viewMenu", "avoid automatically generated View submenu");
        assert.notEqual(item.role, "togglefullscreen", "avoid the duplicate AppKit fullscreen selector");
        if (Array.isArray(item.submenu)) inspect(item.submenu);
      }
    }
    inspect(menu);
    const fullscreens = view.submenu.filter(item => item.id === "desktop-window-fullscreen");
    assert.equal(fullscreens.length, 1);
    assert.equal(fullscreens[0].label, t("menu.toggleFullscreen"));
    assert.equal(fullscreens[0].accelerator, "Control+Command+F");
    let fullscreen = false;
    const focused = { isDestroyed: () => false, isFullScreen: () => fullscreen,
      setFullScreen: enabled => { fullscreen = enabled; } };
    fullscreens[0].click(null, focused);
    assert.equal(fullscreen, true);
    fullscreens[0].click(null, focused);
    assert.equal(fullscreen, false);
    fullscreens[0].click(null, undefined);
    fullscreens[0].click(null, { isDestroyed: () => true });
  }
});
test("macOS retains its local native app menu without adding an unconfigured Help entry", () => {
  build("darwin", false);
  assert(templates[0][0].submenu.some(item => item.role === "about"));
  assert(!templates[0].some(item => item.label === "nav.help"));
});

test("Desktop DevTools menu preserves platform shortcuts and ignores focused guest", () => {
  for (const platform of ["darwin", "win32"]) {
    let toggles = 0;
    build(platform, false, key => key, () => { toggles += 1; });
    const items = platform === "darwin"
      ? templates[0].find(item => item.label === "menu.view").submenu
      : templates[2];
    const item = items.find(item => item.label === "menu.devTools");
    assert.equal(item.role, undefined);
    assert.equal(item.accelerator, platform === "darwin" ? "Alt+Command+I" : "Control+Shift+I");
    item.click(null, { webContents: { toggleDevTools() { assert.fail("must not inspect focused guest"); } } });
    assert.equal(toggles, 1);
  }
});
