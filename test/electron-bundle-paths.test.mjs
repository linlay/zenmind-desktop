import test from "node:test";
import assert from "node:assert/strict";

const {
  getMainPreloadPath,
  getServiceWebviewPreloadPath,
  resolveElectronBundleRootFromRuntimeDir
} = await import("../dist-electron/main/infrastructure/electron/bundle-paths.js");

test("runtime module dirs resolve back to the dist-electron bundle root on macOS", () => {
  const runtimeModuleDir = "/Applications/ZenMind.app/Contents/Resources/app.asar/dist-electron/main/app";
  const bundledRuntimeModuleDir = "/Applications/ZenMind.app/Contents/Resources/app.asar/dist-electron/main";

  assert.equal(
    resolveElectronBundleRootFromRuntimeDir(runtimeModuleDir, "darwin"),
    "/Applications/ZenMind.app/Contents/Resources/app.asar/dist-electron"
  );
  assert.equal(
    resolveElectronBundleRootFromRuntimeDir(bundledRuntimeModuleDir, "darwin"),
    "/Applications/ZenMind.app/Contents/Resources/app.asar/dist-electron"
  );
});

test("runtime module dirs resolve back to the dist-electron bundle root on Windows", () => {
  const runtimeModuleDir = "C:\\Program Files\\ZenMind\\resources\\app.asar\\dist-electron\\main\\app";
  const bundledRuntimeModuleDir = "C:\\Program Files\\ZenMind\\resources\\app.asar\\dist-electron\\main";

  assert.equal(
    resolveElectronBundleRootFromRuntimeDir(runtimeModuleDir, "win32"),
    "C:\\Program Files\\ZenMind\\resources\\app.asar\\dist-electron"
  );
  assert.equal(
    resolveElectronBundleRootFromRuntimeDir(bundledRuntimeModuleDir, "win32"),
    "C:\\Program Files\\ZenMind\\resources\\app.asar\\dist-electron"
  );
});

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
