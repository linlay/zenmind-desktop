import test from "node:test";
import assert from "node:assert/strict";

const {
  getMainPreloadPath,
  getServiceWebviewPreloadPath
} = await import("../dist-electron/main/electron-bundle-paths.js");

test("preload paths stay inside dist-electron for packaged macOS asar apps", () => {
  const mainProcessDir = "/Applications/ZenMind.app/Contents/Resources/app.asar/dist-electron";

  assert.equal(
    getMainPreloadPath(mainProcessDir, "darwin"),
    "/Applications/ZenMind.app/Contents/Resources/app.asar/dist-electron/preload/index.js"
  );
  assert.equal(
    getServiceWebviewPreloadPath(mainProcessDir, "darwin"),
    "/Applications/ZenMind.app/Contents/Resources/app.asar/dist-electron/preload/service-webview.js"
  );
});

test("preload paths stay inside dist-electron for packaged Windows asar apps", () => {
  const mainProcessDir = "C:\\Program Files\\ZenMind\\resources\\app.asar\\dist-electron";

  assert.equal(
    getMainPreloadPath(mainProcessDir, "win32"),
    "C:\\Program Files\\ZenMind\\resources\\app.asar\\dist-electron\\preload\\index.js"
  );
  assert.equal(
    getServiceWebviewPreloadPath(mainProcessDir, "win32"),
    "C:\\Program Files\\ZenMind\\resources\\app.asar\\dist-electron\\preload\\service-webview.js"
  );
});
