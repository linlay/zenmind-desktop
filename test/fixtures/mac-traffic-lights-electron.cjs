const assert = require("node:assert/strict");
const { app, BrowserWindow, nativeTheme } = require("electron");
const koffi = require("koffi");
const { attachMacTrafficLightLayout } = require("../../dist-electron/main/infrastructure/electron/mac-traffic-lights.js");
const { MAC_TRAFFIC_LIGHT_POSITION, MAC_TRAFFIC_LIGHT_LAYOUT } = require("../../dist-electron/main/modules/shell/window-model.js");
const objc = koffi.load("/usr/lib/libobjc.A.dylib");
const sel = objc.func("void *sel_registerName(const char *name)");
const object = objc.func("objc_msgSend", "void *", ["void *", "void *"]);
const button = objc.func("objc_msgSend", "void *", ["void *", "void *", "ulong"]);
const rect = koffi.struct({ x: "double", y: "double", width: "double", height: "double" });
const origin = koffi.struct({ x: "double", y: "double" });
const setOrigin = objc.func("objc_msgSend", "void", ["void *", "void *", origin]);
app.on("window-all-closed", () => {});
let frame;
if (process.arch === "arm64") {
  const read = objc.func("objc_msgSend", rect, ["void *", "void *"]);
  frame = (view) => read(view, sel("frame"));
} else if (process.arch === "x64") {
  const read = objc.func("objc_msgSend_stret", "void", [koffi.out(koffi.pointer(rect)), "void *", "void *"]);
  frame = (view) => {
    const result = { x: 0, y: 0, width: 0, height: 0 };
    read(result, view, sel("frame"));
    return result;
  };
} else throw new Error("Unsupported test architecture");
const delay = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
function transition(window, event, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 8000);
    window.once(event, () => { clearTimeout(timeout); resolve(); });
    action();
  });
}
function snapshot(window) {
  const nativeWindow = object(window.getNativeWindowHandle().readBigUInt64LE(), sel("window"));
  return [0, 1, 2].map((kind) => {
    const view = button(nativeWindow, sel("standardWindowButton:"), kind);
    assert.ok(view);
    return { view, frame: frame(view), target: object(view, sel("target")), action: object(view, sel("action")) };
  });
}

app.whenReady().then(async () => {
  app.setActivationPolicy("regular");
  const window = new BrowserWindow({ width: 700, height: 400, show: false,
    titleBarStyle: "hidden", trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
    transparent: true, vibrancy: "under-window", visualEffectState: "active" });
  await window.loadURL("data:text/html,<body style='font:16px system-ui;padding:60px'>Native traffic light layout regression</body>");
  // Run this separately in an interactive session: automation hosts can refuse
  // to miniaturize even an unmodified Electron window.
  const testMinimize = process.env.RUN_MAC_TRAFFIC_LIGHTS_MINIMIZE === "1";
  const original = snapshot(window);
  const errors = [];
  const dispose = attachMacTrafficLightLayout(window, {
    platform: "darwin", ...MAC_TRAFFIC_LIGHT_LAYOUT, onError: (error) => errors.push(String(error))
  });
  const cases = [];
  async function check(name) {
    await delay(400);
    const current = snapshot(window);
    const frames = current.map((value) => value.frame);
    for (let index = 0; index < current.length; index++) {
      assert.equal(current[index].target, original[index].target, `${name}: native target`);
      assert.equal(current[index].action, original[index].action, `${name}: native action`);
      assert.equal(frames[index].width, original[index].frame.width, `${name}: native width`);
      assert.equal(frames[index].height, original[index].frame.height, `${name}: native height`);
      assert.equal(frames[index].y, original[index].frame.y, `${name}: vertical position`);
      if (index) assert.equal(frames[index].x - frames[index - 1].x - frames[index - 1].width,
        MAC_TRAFFIC_LIGHT_LAYOUT.gap, `${name}: gap`);
    }
    assert.equal((frames[0].x + frames[2].x + frames[2].width) / 2, MAC_TRAFFIC_LIGHT_LAYOUT.centerX, `${name}: center`);
    assert.equal(errors.length, 0, errors.join("\n"));
    cases.push({ name, frames });
    console.log("MAC_TRAFFIC_LIGHTS_CASE " + name);
  }
  await check("before-show");
  window.show();
  app.focus({ steal: true });
  await check("show");
  window.setSize(850, 500);
  await check("resize");
  window.maximize();
  await check("maximize");
  window.unmaximize();
  await check("unmaximize");
  if (testMinimize) {
    await transition(window, "minimize", () => window.minimize());
    await transition(window, "restore", () => window.restore());
    await check("restore");
  }
  window.hide();
  window.show();
  await check("hide-show");
  nativeTheme.themeSource = "dark";
  await delay(300);
  await check("dark-theme");
  nativeTheme.themeSource = "light";
  await delay(300);
  await check("light-theme");
  await transition(window, "enter-full-screen", () => window.setFullScreen(true));
  await delay();
  await transition(window, "leave-full-screen", () => window.setFullScreen(false));
  await check("leave-full-screen");
  // Prove that a late AppKit reset is corrected by the deferred layout pass.
  window.emit("resize");
  for (const [index, value] of snapshot(window).entries()) {
    setOrigin(value.view, sel("setFrameOrigin:"), { x: original[index].frame.x, y: original[index].frame.y });
  }
  await check("late-native-layout");
  window.emit("resize");
  dispose();
  for (const [index, value] of snapshot(window).entries()) {
    setOrigin(value.view, sel("setFrameOrigin:"), { x: original[index].frame.x, y: original[index].frame.y });
  }
  await delay();
  assert.deepEqual(snapshot(window).map((value) => value.frame), original.map((value) => value.frame), "dispose cancels pending layout");
  attachMacTrafficLightLayout(window, { platform: "darwin", ...MAC_TRAFFIC_LIGHT_LAYOUT, onError: (error) => { throw error; } });
  window.destroy();
  await delay();
  assert.equal(window.listenerCount("resize"), 0, "closed window releases layout listeners");
  console.log("MAC_TRAFFIC_LIGHTS_OK " + JSON.stringify({ architecture: process.arch, minimizeTested: testMinimize, original: original.map((value) => value.frame), cases }));
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
