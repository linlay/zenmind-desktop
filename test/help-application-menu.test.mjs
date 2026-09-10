import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
function build(platform, helpEnabled) {
  templates.length = 0;
  buildApplicationMenu({ platform, helpEnabled, appName: "Test", t: (key) => key,
    openSettings: noop, openHelp: noop, requestCloseWindow: noop,
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
test("macOS retains its local native app menu without adding an unconfigured Help entry", () => {
  build("darwin", false);
  assert(templates[0][0].submenu.some(item => item.role === "about"));
  assert(!templates[0].some(item => item.label === "nav.help"));
});
