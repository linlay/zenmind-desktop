import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main/modules/assistant/copilot/screenshot.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function setup({
  platform = "win32", mainAvailable = true, mainVisible = true, mainDestroyed = false,
  externalX = -2560, externalY = -200, mainOnLaptop = false,
  singleDisplay = false, deferredLoads = false, failLoadId, failConstructorId,
  sourceMode = "identified", sameSize = false,
  sourceError, screenPermission = "granted", emptyThumbnailId
} = {}) {
  const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 };
  const external = sameSize
    ? { ...laptop, id: 2, bounds: { ...laptop.bounds, x: externalX, y: externalY } }
    : { id: 2, bounds: { x: externalX, y: externalY, width: 2560, height: 1440 }, size: { width: 2560, height: 1440 }, scaleFactor: 1.5 };
  const displays = singleDisplay ? [laptop] : [laptop, external];
  const windows = [];
  const captures = [];
  const crops = [];
  const matched = [];
  const loads = [];
  const windowCaptures = [];
  const diagnostics = [];
  const mainBounds = mainOnLaptop || singleDisplay
    ? { x: 100, y: 100, width: 800, height: 600 }
    : { x: externalX + 100, y: externalY + 100, width: 1800, height: 1000 };
  function image(width, height, displayId, empty = false) {
    return {
      isEmpty: () => empty,
      getSize: () => empty ? { width: 0, height: 0 } : { width, height },
      toPNG: () => empty ? Buffer.alloc(0) : Buffer.from(`display:${displayId};${width}x${height}`),
      crop: (rect) => { crops.push({ displayId, ...rect }); return image(rect.width, rect.height, displayId, empty); }
    };
  }
  class Overlay extends EventEmitter {
    constructor(options) {
      super();
      if (options.x === external.bounds.x && failConstructorId === external.id) {
        throw new Error("native window creation failed");
      }
      this.options = options;
      this.display = displays.find((display) => display.bounds.x === options.x && display.bounds.y === options.y);
      // Model the native constructor clamping a large secondary window to the laptop size.
      this.bounds = { x: options.x, y: options.y, width: laptop.bounds.width, height: laptop.bounds.height };
      this.webContents = new EventEmitter();
      this.destroyed = false;
      this.showCount = 0;
      this.focusCount = 0;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop(...args) { this.alwaysOnTop = args; }
    setVisibleOnAllWorkspaces(...args) { this.workspaces = args; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    getBounds() { return this.bounds; }
    loadURL(url) {
      this.html = decodeURIComponent(url.split(",").slice(1).join(","));
      if (deferredLoads) return new Promise((resolve, reject) => loads.push({ resolve, reject, window: this }));
      return this.display.id === failLoadId ? Promise.reject(new Error("overlay load failed")) : Promise.resolve();
    }
    showInactive() { this.visible = true; this.showCount++; }
    hide() { this.visible = false; }
    moveTop() {}
    focus() { this.focusCount++; }
    close() { this.visible = false; this.destroyed = true; this.emit("closed"); }
    destroy() { this.close(); }
    finish(rect) {
      const base = this.html.match(/const doneUrl=("[^"]+");/)[1];
      const query = new URLSearchParams({ action: rect ? "select" : "cancel" });
      if (rect) query.set("rect", JSON.stringify(rect));
      return this.navigate(`${JSON.parse(base)}?${query}`);
    }
    navigate(url) {
      let prevented = false;
      this.webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, url);
      return prevented;
    }
  }
  const mainWindow = {
    isDestroyed: () => mainDestroyed,
    isVisible: () => mainVisible,
    getBounds: () => mainBounds,
    getContentBounds: () => mainBounds,
    webContents: {
      isDestroyed: () => false,
      capturePage: async (rect) => {
        windowCaptures.push(rect);
        return image(rect?.width ?? mainBounds.width, rect?.height ?? mainBounds.height, "window");
      }
    }
  };
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => displays,
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => laptop,
    getDisplayMatching: (bounds) => { matched.push(bounds); return mainOnLaptop || singleDisplay ? laptop : external; }
  });
  const electron = {
    BrowserWindow: Overlay,
    screen,
    systemPreferences: { getMediaAccessStatus: () => screenPermission },
    desktopCapturer: {
      getSources: async (options) => {
        captures.push(options);
        if (sourceError !== undefined) throw sourceError;
        if (sourceMode === "empty") return [];
        const sourceDisplays = sourceMode === "wrong-monitor" ? [laptop] : [external, laptop];
        return sourceDisplays.map((display) => ({
          display_id: sourceMode === "unidentified" ? "" : String(display.id),
          thumbnail: image(display.size.width * display.scaleFactor, display.size.height * display.scaleFactor, display.id, display.id === emptyThumbnailId)
        }));
      }
    }
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", "console", compiled)(module, module.exports, (id) => {
    if (id === "electron") return electron;
    if (id.endsWith("/brand")) return { PRODUCT_NAME: "Test" };
    if (id.endsWith("/main-i18n")) return { t: (key) => key };
    if (id.endsWith("/attachment-store")) return {
      createAssistantAttachmentFromImageBuffer: async (_app, _chatId, attachment) => ({ ok: true, attachments: [attachment] })
    };
    throw new Error(`Unexpected import: ${id}`);
  }, { warn: (...args) => diagnostics.push(args) });
  return {
    ...module.exports, windows, captures, crops, matched, mainBounds, laptop, external, displays, screen, loads, windowCaptures, diagnostics,
    options: {
      platform, getMainWindow: () => mainAvailable ? mainWindow : null,
      delay: async () => assert.ok(windows.every((window) => window.destroyed && !window.visible), "capture starts after every overlay is closed"),
      app: {}, chatId: "test"
    }
  };
}

function assertCleanedUp(h) {
  assert.ok(h.windows.every((window) => window.destroyed && !window.visible));
  assert.ok(h.windows.every((window) => window.webContents.listenerCount("will-navigate") === 0));
  assert.equal(h.screen.listenerCount("display-removed"), 0);
  assert.equal(h.screen.listenerCount("display-metrics-changed"), 0);
}

function assertNoCapturedImage(result) {
  assert.equal(result.ok, false);
  assert.equal(result.dataBase64, undefined);
  assert.deepEqual(result.attachments ?? [], []);
  assert.equal(result.width, undefined);
  assert.equal(result.height, undefined);
}

const nativeFailures = [
  ["string", () => "Failed to get sources."],
  ["Error", () => new Error("Failed to get sources.")]
];

for (const platform of ["win32", "darwin"]) {
  for (const entry of ["captureScreenshotForBridge", "captureAssistantScreenshot"]) {
    test(`${platform} ${entry}: application display fills overlay and crops beyond laptop edges`, async () => {
      const h = setup({ platform });
      const pending = h[entry](h.options);
      await new Promise(setImmediate);
      const overlay = h.windows.find((window) => window.display.id === 2);
      assert.deepEqual(h.matched, [h.mainBounds], "choose the application's monitor even when cursor is on laptop");
      assert.equal(h.windows.length, 2, "every monitor has an overlay");
      for (const window of h.windows) {
        assert.equal(window.visible, true);
        assert.deepEqual(window.bounds, window.display.bounds);
        assert.equal(window.focusCount, window.display.id === 2 ? 1 : 0);
        assert.deepEqual(window.alwaysOnTop, [true, "screen-saver"]);
        if (platform === "darwin") {
          assert.equal(window.options.acceptFirstMouse, true);
          assert.equal(window.options.enableLargerThanScreen, true);
          assert.equal(window.options.roundedCorners, false);
          assert.deepEqual(window.workspaces, [true, { visibleOnFullScreen: true, skipTransformProcessType: true }]);
        } else {
          assert.equal(window.options.acceptFirstMouse, undefined);
        }
      }
      assert.deepEqual(overlay.bounds, h.external.bounds, "repair constructor-clamped overlay bounds using target display DIP");
      overlay.finish({ x: 2000, y: 1100, width: 400, height: 200 });
      const result = await pending;
      assert.equal(result.ok, true);
      assert.deepEqual(h.captures[0].thumbnailSize, { width: 3840, height: 2160 });
      assert.deepEqual(h.crops, [{ displayId: 2, x: 3000, y: 1650, width: 600, height: 300 }]);
      assertCleanedUp(h);
    });
    test(`${platform} ${entry}: selecting the other monitor captures that monitor with its own scale`, async () => {
      const h = setup({ platform });
      const pending = h[entry](h.options);
      await new Promise(setImmediate);
      const other = h.windows.find((window) => window.display.id === 1);
      assert.equal(other.focusCount, 0);
      other.finish({ x: 100, y: 200, width: 300, height: 250 });
      const result = await pending;
      assert.equal(result.ok, true);
      assert.deepEqual(h.captures[0].thumbnailSize, { width: 2880, height: 1800 });
      assert.deepEqual(h.crops, [{ displayId: 1, x: 200, y: 400, width: 600, height: 500 }]);
      assert.equal(h.captures.length, 1);
      assertCleanedUp(h);
    });
    for (const [kind, createFailure] of nativeFailures) {
      test(`${platform} ${entry}: native ${kind} rejection on the other monitor returns a readable failure without another-screen fallback`, async () => {
        const failure = createFailure();
        const h = setup({ platform, mainOnLaptop: true, sourceError: failure });
        const pending = h[entry](h.options);
        await new Promise(setImmediate);
        h.windows.find((window) => window.display.id === 2).finish({ x: 100, y: 200, width: 300, height: 250 });
        const result = await pending;
        assertNoCapturedImage(result);
        assert.equal(result.message, platform === "darwin" ? "screenshot.captureFailedMac" : "screenshot.captureFailedWindows");
        assert.equal(h.crops.length, 0);
        assert.equal(h.windowCaptures.length, 0);
        assert.ok(h.captures.length > 0);
        assert.ok(h.captures.every((request) => request.thumbnailSize.width === 3840 && request.thumbnailSize.height === 2160));
        assert.ok(h.diagnostics.some((args) => args.includes(failure)), "retain the native failure for diagnostics");
        assertCleanedUp(h);
      });
    }
    test(`${platform} ${entry}: enumeration failure can capture a complete selection inside the app on a negative-coordinate monitor`, async () => {
      const h = setup({ platform, sourceError: new Error("Failed to get sources.") });
      const pending = h[entry](h.options);
      await new Promise(setImmediate);
      h.windows.find((window) => window.display.id === 2).finish({ x: 200, y: 250, width: 300, height: 250 });
      const result = await pending;
      assert.equal(result.ok, true);
      assert.deepEqual(h.windowCaptures, [{ x: 100, y: 150, width: 300, height: 250 }]);
      const png = entry === "captureScreenshotForBridge"
        ? Buffer.from(result.dataBase64, "base64")
        : result.attachments[0].buffer;
      assert.equal(png.toString(), "display:window;300x250");
      assert.equal(h.crops.length, 0);
      assertCleanedUp(h);
    });
    test(`${platform} ${entry}: a complete fractional-DIP selection falls back without false truncation`, async () => {
      const h = setup({ platform, sourceError: "Failed to get sources." });
      const pending = h[entry](h.options);
      await new Promise(setImmediate);
      h.windows.find((window) => window.display.id === 2).finish({ x: 200.3, y: 250.3, width: 300.2, height: 250.2 });
      const result = await pending;
      assert.equal(result.ok, true);
      assert.deepEqual(h.windowCaptures, [{ x: 100, y: 150, width: 300, height: 250 }]);
      const png = entry === "captureScreenshotForBridge"
        ? Buffer.from(result.dataBase64, "base64")
        : result.attachments[0].buffer;
      assert.equal(png.toString(), "display:window;300x250");
      assert.equal(h.crops.length, 0);
      assertCleanedUp(h);
    });
    for (const [edge, rect] of [
      ["left", { x: 50, y: 250, width: 300, height: 250 }],
      ["top", { x: 200, y: 50, width: 300, height: 250 }]
    ]) {
      test(`${platform} ${entry}: failed screen capture does not return a truncated app image across its ${edge} edge`, async () => {
        const h = setup({ platform, sourceError: "Failed to get sources." });
        const pending = h[entry](h.options);
        await new Promise(setImmediate);
        h.windows.find((window) => window.display.id === 2).finish(rect);
        const result = await pending;
        assertNoCapturedImage(result);
        assert.equal(result.message, platform === "darwin" ? "screenshot.captureFailedMac" : "screenshot.captureFailedWindows");
        assert.equal(h.windowCaptures.length, 0, "partial overlap must not invoke capturePage");
        assert.equal(h.crops.length, 0);
        assertCleanedUp(h);
      });
    }
  }
  for (const [kind, createFailure] of nativeFailures) {
    test(`${platform}: desktop mode translates native ${kind} rejection without falling back to the app window`, async () => {
      const h = setup({ platform, sourceError: createFailure() });
      const result = await h.captureScreenshotForBridge(h.options, "desktop");
      assertNoCapturedImage(result);
      assert.equal(result.message, platform === "darwin" ? "screenshot.captureFailedMac" : "screenshot.captureFailedWindows");
      assert.equal(h.windows.length, 0);
      assert.equal(h.windowCaptures.length, 0);
      assert.equal(h.crops.length, 0);
      assertCleanedUp(h);
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
  test(`${platform}: unavailable main window focuses cursor display and cancellation closes every monitor`, async () => {
    const h = setup({ platform, mainAvailable: false });
    const pending = h.captureScreenshotForBridge(h.options);
    await new Promise(setImmediate);
    assert.deepEqual(h.windows[0].bounds, h.laptop.bounds);
    h.windows[0].finish(null);
    assert.equal((await pending).cancelled, true);
    assert.equal(h.captures.length, 0);
    assert.equal(h.windows[0].focusCount, 1);
    assertCleanedUp(h);
  });
  test(`${platform}: main window on laptop can select an external monitor above it`, async () => {
    const h = setup({ platform, mainOnLaptop: true, externalX: 0, externalY: -1440 });
    const pending = h.captureScreenshotForBridge(h.options);
    await new Promise(setImmediate);
    h.windows.find((window) => window.display.id === 2).finish({ x: 2000, y: 1100, width: 400, height: 200 });
    assert.equal((await pending).ok, true);
    assert.deepEqual(h.crops, [{ displayId: 2, x: 3000, y: 1650, width: 600, height: 300 }]);
    assertCleanedUp(h);
  });
  test(`${platform}: closing either overlay cancels the whole session without capturing`, async () => {
    const h = setup({ platform });
    const pending = h.captureScreenshotForBridge(h.options);
    await new Promise(setImmediate);
    h.windows[1].close();
    assert.equal((await pending).cancelled, true);
    assert.equal(h.captures.length, 0);
    assertCleanedUp(h);
  });
  test(`${platform}: a failed overlay load cancels every monitor`, async () => {
    const h = setup({ platform, failLoadId: 2 });
    assert.equal((await h.captureScreenshotForBridge(h.options)).cancelled, true);
    assert.equal(h.captures.length, 0);
    assert.ok(h.windows.every((window) => window.showCount === 0));
    assertCleanedUp(h);
  });
  test(`${platform}: cancellation before loading finishes never reopens overlays`, async () => {
    const h = setup({ platform, deferredLoads: true });
    const pending = h.captureScreenshotForBridge(h.options);
    h.windows[1].finish(null);
    assert.equal((await pending).cancelled, true);
    for (const load of h.loads) load.resolve();
    await new Promise(setImmediate);
    assert.ok(h.windows.every((window) => window.showCount === 0));
    assertCleanedUp(h);
  });
  test(`${platform}: every overlay loads before they appear, with only one initial focus`, async () => {
    const h = setup({ platform, deferredLoads: true });
    const pending = h.captureScreenshotForBridge(h.options);
    h.loads[1].resolve();
    await new Promise(setImmediate);
    assert.ok(h.windows.every((window) => window.showCount === 0));
    h.loads[0].resolve();
    await new Promise(setImmediate);
    assert.ok(h.windows.every((window) => window.showCount === 1));
    assert.deepEqual(h.windows.map((window) => window.focusCount), [0, 1]);
    h.windows[0].finish(null);
    await pending;
    assertCleanedUp(h);
  });
  test(`${platform}: native creation failure cleans up the already-created overlay`, async () => {
    const h = setup({ platform, failConstructorId: 2, deferredLoads: true });
    assert.equal((await h.captureScreenshotForBridge(h.options)).cancelled, true);
    h.loads[0].reject(new Error("late failed load"));
    await new Promise(setImmediate);
    assertCleanedUp(h);
  });
  for (const event of ["display-removed", "display-metrics-changed"]) {
    test(`${platform}: ${event} cancels stale display selection and removes screen listeners`, async () => {
      const h = setup({ platform });
      const pending = h.captureScreenshotForBridge(h.options);
      await new Promise(setImmediate);
      h.screen.emit(event, {}, h.external, ["bounds", "scaleFactor"]);
      assert.equal((await pending).cancelled, true);
      assert.equal(h.captures.length, 0);
      assertCleanedUp(h);
    });
  }
  test(`${platform}: a second monitor's late selection cannot replace the first result`, async () => {
    const h = setup({ platform });
    const pending = h.captureScreenshotForBridge(h.options);
    await new Promise(setImmediate);
    assert.equal(h.windows[0].finish({ x: 100, y: 200, width: 300, height: 250 }), true);
    assert.equal(h.windows[1].finish({ x: 2000, y: 1100, width: 400, height: 200 }), false);
    assert.equal((await pending).ok, true);
    assert.equal(h.captures.length, 1);
    assert.equal(h.crops[0].displayId, 1);
    assertCleanedUp(h);
  });
  test(`${platform}: same-size monitors with reversed sources still use the selected display ID`, async () => {
    const h = setup({ platform, sameSize: true });
    const pending = h.captureScreenshotForBridge(h.options);
    await new Promise(setImmediate);
    h.windows[0].finish({ x: 100, y: 200, width: 300, height: 250 });
    assert.equal((await pending).ok, true);
    assert.deepEqual(h.crops, [{ displayId: 1, x: 200, y: 400, width: 600, height: 500 }]);
    assertCleanedUp(h);
  });
  for (const sourceMode of ["wrong-monitor", "unidentified"]) {
    test(`${platform}: ${sourceMode} ambiguous sources never capture a different monitor`, async () => {
      const h = setup({ platform, sameSize: true, mainOnLaptop: true, sourceMode });
      const pending = h.captureScreenshotForBridge(h.options);
      await new Promise(setImmediate);
      h.windows[1].finish({ x: 100, y: 200, width: 300, height: 250 });
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.message, platform === "darwin" ? "screenshot.captureFailedMac" : "screenshot.noSourceWindows");
      assert.equal(h.crops.length, 0);
      assert.equal(h.windowCaptures.length, 0, "do not fall back to a CuteJ window on the other monitor");
      assertCleanedUp(h);
    });
  }
  test(`${platform}: a unique source without display ID retains size-based compatibility`, async () => {
    const h = setup({ platform, sourceMode: "unidentified" });
    const pending = h.captureScreenshotForBridge(h.options);
    await new Promise(setImmediate);
    h.windows[1].finish({ x: 2000, y: 1100, width: 400, height: 200 });
    assert.equal((await pending).ok, true);
    assert.equal(h.crops[0].displayId, 2);
    assertCleanedUp(h);
  });
  test(`${platform}: single-display selection still works`, async () => {
    const h = setup({ platform, singleDisplay: true });
    const pending = h.captureScreenshotForBridge(h.options);
    await new Promise(setImmediate);
    assert.equal(h.windows.length, 1);
    h.windows[0].finish({ x: 100, y: 200, width: 300, height: 250 });
    assert.equal((await pending).ok, true);
    assert.equal(h.crops[0].displayId, 1);
    assertCleanedUp(h);
  });
  test(`${platform}: application-window mode creates no display overlay and captures only the app`, async () => {
    const h = setup({ platform });
    const result = await h.captureScreenshotForBridge(h.options, "window");
    assert.equal(result.ok, true);
    assert.equal(Buffer.from(result.dataBase64, "base64").toString(), "display:window;1800x1000");
    assert.equal(h.windows.length, 0);
    assert.equal(h.captures.length, 0);
    assert.equal(h.windowCaptures.length, 1);
  });
}

for (const [unavailable, captureOptions] of [
  ["empty source list", { sourceMode: "empty" }],
  ["empty selected thumbnail", { emptyThumbnailId: 2 }]
]) {
  for (const entry of ["captureScreenshotForBridge", "captureAssistantScreenshot"]) {
    test(`macOS ${entry}: granted permission with ${unavailable} reports capture failure without changing monitors`, async () => {
      const h = setup({ platform: "darwin", mainOnLaptop: true, screenPermission: "granted", ...captureOptions });
      const pending = h[entry](h.options);
      await new Promise(setImmediate);
      h.windows.find((window) => window.display.id === 2).finish({ x: 100, y: 200, width: 300, height: 250 });
      const result = await pending;
      assertNoCapturedImage(result);
      assert.equal(result.message, "screenshot.captureFailedMac");
      assert.ok(h.captures.length > 0, "granted permission must reach native source enumeration");
      assert.equal(h.crops.length, 0);
      assert.equal(h.windowCaptures.length, 0);
      assertCleanedUp(h);
    });
  }
  test(`macOS desktop mode: granted permission with ${unavailable} reports capture failure`, async () => {
    const h = setup({ platform: "darwin", screenPermission: "granted", ...captureOptions });
    const result = await h.captureScreenshotForBridge(h.options, "desktop");
    assertNoCapturedImage(result);
    assert.equal(result.message, "screenshot.captureFailedMac");
    assert.ok(h.captures.length > 0);
    assert.equal(h.windows.length, 0);
    assert.equal(h.windowCaptures.length, 0);
    assert.equal(h.crops.length, 0);
    assertCleanedUp(h);
  });
}

for (const entry of ["captureScreenshotForBridge", "captureAssistantScreenshot"]) {
  test(`macOS ${entry}: denied screen access explains permission failure on the other monitor`, async () => {
    const h = setup({ platform: "darwin", mainOnLaptop: true, sourceError: "Failed to get sources.", screenPermission: "denied" });
    const pending = h[entry](h.options);
    await new Promise(setImmediate);
    h.windows.find((window) => window.display.id === 2).finish({ x: 100, y: 200, width: 300, height: 250 });
    const result = await pending;
    assertNoCapturedImage(result);
    assert.equal(result.message, "screenshot.permissionDeniedMac");
    assert.equal(h.windowCaptures.length, 0);
    assertCleanedUp(h);
  });
  test(`macOS ${entry}: restricted screen access fails before opening selectors or reading images`, async () => {
    const h = setup({ platform: "darwin", screenPermission: "restricted" });
    const result = await h[entry](h.options);
    assertNoCapturedImage(result);
    assert.equal(result.message, "screenshot.permissionDeniedMac");
    assert.equal(h.windows.length, 0);
    assert.equal(h.captures.length, 0);
    assert.equal(h.windowCaptures.length, 0);
    assertCleanedUp(h);
  });
}

test("macOS desktop mode uses the permission explanation after a denied native enumeration", async () => {
  const h = setup({ platform: "darwin", screenPermission: "denied", sourceError: new Error("Failed to get sources.") });
  const result = await h.captureScreenshotForBridge(h.options, "desktop");
  assertNoCapturedImage(result);
  assert.equal(result.message, "screenshot.permissionDeniedMac");
  assert.equal(h.windows.length, 0);
  assert.equal(h.windowCaptures.length, 0);
});

test("macOS app-window mode remains available when screen-recording permission is denied", async () => {
  const h = setup({ platform: "darwin", screenPermission: "denied", sourceError: new Error("Failed to get sources.") });
  const result = await h.captureScreenshotForBridge(h.options, "window");
  assert.equal(result.ok, true);
  assert.equal(Buffer.from(result.dataBase64, "base64").toString(), "display:window;1800x1000");
  assert.equal(h.captures.length, 0);
  assert.equal(h.windows.length, 0);
  assert.equal(h.windowCaptures.length, 1);
});
