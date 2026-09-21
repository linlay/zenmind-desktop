import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function createWindow(platform, focusable) {
  let options;
  class FakeWindow {
    constructor(input) { options = input; }
    isDestroyed() { return false; }
    setAlwaysOnTop() {}
    on() {}
  }
  const context = {
    exports: {},
    require: (name) => name === "electron" ? { BrowserWindow: FakeWindow } : { PRODUCT_NAME: "Test" }
  };
  vm.runInNewContext(fs.readFileSync("dist-electron/main/modules/pet/window.js", "utf8"), context);
  context.exports.createDesktopPetBrowserWindow({ platform, focusable, bounds: {x:0,y:0,width:300,height:200}, preloadPath: "test", onClosed() {} });
  return options;
}

test("macOS reply window accepts keyboard focus while the sprite stays non-activating", () => {
  const editor = createWindow("darwin", true);
  assert.equal(editor.focusable, true);
  assert.equal(editor.type, undefined);
  assert.equal(editor.acceptFirstMouse, true);
  assert.equal(editor.show, false, "opening a panel must not auto-focus it");
  const sprite = createWindow("darwin", false);
  assert.equal(sprite.focusable, false);
  assert.equal(sprite.type, "panel");
});

test("Windows reply window remains focusable with explicit frameless configuration", () => {
  const editor = createWindow("win32", true);
  assert.equal(editor.focusable, true);
  assert.equal(editor.thickFrame, false);
  assert.equal(editor.type, undefined);
  assert.equal(editor.acceptFirstMouse, undefined);
  assert.equal(createWindow("win32", false).focusable, false);
});
