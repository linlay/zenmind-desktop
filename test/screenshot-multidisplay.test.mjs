import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main/modules/assistant/copilot/screenshot.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function setup({ platform = "win32", mainAvailable = true, externalX = -2560 } = {}) {
  const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 };
  const external = { id: 2, bounds: { x: externalX, y: -200, width: 2560, height: 1440 }, size: { width: 2560, height: 1440 }, scaleFactor: 1.5 };
  const windows = [];
  const captures = [];
  const crops = [];
  const matched = [];
  const mainBounds = { x: externalX + 100, y: 0, width: 1800, height: 1000 };
  const mainWindow = { isDestroyed: () => false, isVisible: () => true, getBounds: () => mainBounds };
  function image(width, height, displayId) {
    return {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toPNG: () => Buffer.from(`display:${displayId};${width}x${height}`),
      crop: (rect) => { crops.push({ displayId, ...rect }); return image(rect.width, rect.height, displayId); }
    };
  }
  class Overlay extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      // Model the native constructor clamping a large secondary window to the laptop size.
      this.bounds = { x: options.x, y: options.y, width: laptop.bounds.width, height: laptop.bounds.height };
      this.webContents = new EventEmitter();
      this.destroyed = false;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBounds(bounds) { this.bounds = { ...bounds }; }
    getBounds() { return this.bounds; }
    loadURL(url) { this.html = decodeURIComponent(url.split(",").slice(1).join(",")); return Promise.resolve(); }
    show() { this.visible = true; }
    moveTop() {}
    focus() {}
    close() { this.destroyed = true; this.emit("closed"); }
    finish(rect) {
      const base = this.html.match(/const doneUrl=("[^"]+");/)[1];
      const query = new URLSearchParams({ action: rect ? "select" : "cancel" });
      if (rect) query.set("rect", JSON.stringify(rect));
      this.webContents.emit("will-navigate", { preventDefault() {} }, `${JSON.parse(base)}?${query}`);
    }
  }
  const electron = {
    BrowserWindow: Overlay,
    screen: {
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      getDisplayNearestPoint: () => laptop,
      getDisplayMatching: (bounds) => { matched.push(bounds); return external; }
    },
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    desktopCapturer: {
      getSources: async (options) => {
        captures.push(options);
        return [laptop, external].map((display) => ({
          display_id: String(display.id),
          thumbnail: image(display.size.width * display.scaleFactor, display.size.height * display.scaleFactor, display.id)
        }));
      }
    }
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", compiled)(module, module.exports, (id) => {
    if (id === "electron") return electron;
    if (id.endsWith("/brand")) return { PRODUCT_NAME: "Test" };
    if (id.endsWith("/main-i18n")) return { t: (key) => key };
    if (id.endsWith("/attachment-store")) return {
      createAssistantAttachmentFromImageBuffer: async (_app, _chatId, attachment) => ({ ok: true, attachments: [attachment] })
    };
    throw new Error(`Unexpected import: ${id}`);
  });
  return {
    ...module.exports, windows, captures, crops, matched, mainBounds, laptop, external,
    options: { platform, getMainWindow: () => mainAvailable ? mainWindow : null, delay: async () => {}, app: {}, chatId: "test" }
  };
}

for (const platform of ["win32", "darwin"]) {
  for (const entry of ["captureScreenshotForBridge", "captureAssistantScreenshot"]) {
    test(`${platform} ${entry}: application display fills overlay and crops beyond laptop edges`, async () => {
      const h = setup({ platform });
      const pending = h[entry](h.options);
      await new Promise(setImmediate);
      const overlay = h.windows[0];
      assert.deepEqual(h.matched, [h.mainBounds], "choose the application's monitor even when cursor is on laptop");
      assert.equal(overlay.visible, true);
      assert.deepEqual(overlay.bounds, h.external.bounds, "repair constructor-clamped overlay bounds using target display DIP");
      overlay.finish({ x: 2000, y: 1100, width: 400, height: 200 });
      const result = await pending;
      assert.equal(result.ok, true);
      assert.deepEqual(h.captures[0].thumbnailSize, { width: 3840, height: 2160 });
      assert.deepEqual(h.crops, [{ displayId: 2, x: 3000, y: 1650, width: 600, height: 300 }]);
      assert.equal(overlay.destroyed, true);
    });
  }
  test(`${platform}: desktop capture follows application on right-hand external display`, async () => {
    const h = setup({ platform, externalX: 1440 });
    const result = await h.captureScreenshotForBridge(h.options, "desktop");
    assert.equal(result.ok, true);
    assert.deepEqual([result.width, result.height], [3840, 2160]);
    assert.equal(Buffer.from(result.dataBase64, "base64").toString(), "display:2;3840x2160");
    assert.equal(h.windows.length, 0);
  });
  test(`${platform}: missing main window falls back to cursor display and cancellation captures nothing`, async () => {
    const h = setup({ platform, mainAvailable: false });
    const pending = h.captureScreenshotForBridge(h.options);
    await new Promise(setImmediate);
    assert.deepEqual(h.windows[0].bounds, h.laptop.bounds);
    h.windows[0].finish(null);
    assert.equal((await pending).cancelled, true);
    assert.equal(h.captures.length, 0);
  });
}
