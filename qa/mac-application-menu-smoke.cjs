// Run with Electron after build:main:types. Reads real AppKit menus, including
// system-injected entries that Electron's JavaScript Menu.items does not expose.
const { app, BrowserWindow, Menu } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildApplicationMenu } = require("../dist-electron/main/modules/shell/app-menu.js");
const { createTranslator } = require("../dist-electron/shared/i18n/index.js");
if (process.platform !== "darwin") throw new Error("This native menu check requires macOS");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-menu-smoke-"));
app.setPath("userData", profile);
app.on("quit", () => fs.rmSync(profile, { recursive: true, force: true }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const objc = require("koffi").load("/usr/lib/libobjc.A.dylib");
const cls = objc.func("void *objc_getClass(const char *)");
const sel = objc.func("void *sel_registerName(const char *)");
const pointer = objc.func("void *objc_msgSend(void *, void *)");
const at = objc.func("void *objc_msgSend(void *, void *, long)");
const count = objc.func("long objc_msgSend(void *, void *)");
const boolean = objc.func("bool objc_msgSend(void *, void *)");
const string = objc.func("const char *objc_msgSend(void *, void *)");
const call = objc.func("void objc_msgSend(void *, void *)");
const title = item => string(pointer(item, sel("title")), sel("UTF8String"));
function readMenu(menu, open = false) {
  if (open) {
    call(menu, sel("update"));
  }
  const items = [];
  for (let i = 0; i < count(menu, sel("numberOfItems")); i++) {
    const item = at(menu, sel("itemAtIndex:"), i);
    if (!boolean(item, sel("isHidden"))) items.push(title(item));
  }
  return items;
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,Menu%20regression");
  for (const locale of ["en-US", "zh-CN", "en-US"]) {
    const t = createTranslator(locale);
    buildApplicationMenu({ appName: "Menu QA", platform: "darwin", t,
      openSettings() {}, openHelp() {}, requestCloseWindow() {}, requestQuit() {}, quitWithoutConfirmation() {} });
    await delay(150);
    console.log("Reading native menu", locale);
    const menu = pointer(pointer(cls("NSApplication"), sel("sharedApplication")), sel("mainMenu"));
    const result = {};
    for (let i = 0; i < count(menu, sel("numberOfItems")); i++) {
      const item = at(menu, sel("itemAtIndex:"), i);
      if (![t("menu.view"), t("menu.window"), t("menu.edit")].includes(title(item))) continue;
      result[title(item)] = readMenu(pointer(item, sel("submenu")), true).filter(Boolean);
    }
    const view = result[t("menu.view")];
    assert(view, "localized View menu exists");
    assert.deepEqual(view, [t("webviewContextMenu.page.reload"), t("menu.forceReload"), t("menu.devTools"),
      t("menu.resetZoom"), t("menu.zoomIn"), t("menu.zoomOut"), t("menu.toggleFullscreen")]);
    assert.deepEqual(result[t("menu.window")], [t("menu.closeWindow"), t("menu.minimize"), t("menu.zoomWindow"), t("menu.bringAllToFront")]);
    const fullscreen = Menu.getApplicationMenu().getMenuItemById("desktop-window-fullscreen");
    assert(fullscreen);
    fullscreen.click(fullscreen, win, {});
    for (let i = 0; i < 60 && !win.isFullScreen(); i++) await delay(50);
    assert.equal(win.isFullScreen(), true);
    fullscreen.click(fullscreen, win, {});
    for (let i = 0; i < 60 && win.isFullScreen(); i++) await delay(50);
    assert.equal(win.isFullScreen(), false);
    console.log(locale, JSON.stringify(result));
  }
  win.destroy();
  console.log("PASS: native menus use the selected language, one fullscreen item, fullscreen enter/exit");
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
