import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  ensureDataRoot,
  getCredentialsRoot,
  getDataRoot,
  getDesktopConfigRoot,
  getDesktopDataLayoutMode,
  getElectronUserDataRoot,
  getPluginsRoot,
  getServicesRoot,
  getServiceConfigRoot,
  getServiceDataRoot,
  getServiceLogsRoot,
  getServiceStateRoot
} = require("../dist-electron/main/user-paths.js");

function createApp(root, { isPackaged = false, platformRoot = root } = {}) {
  const homePath = path.join(platformRoot, "home");
  const appDataPath = path.join(platformRoot, "app-data");
  const userDataRoot = path.join(appDataPath, "zenmind-desktop");
  return {
    isPackaged,
    getPath(name) {
      switch (name) {
        case "home":
          return homePath;
        case "appData":
          return appDataPath;
        case "userData":
          return userDataRoot;
        default:
          assert.fail(`unexpected app.getPath(${name})`);
      }
    }
  };
}

test("new installs use the layered desktop root under home", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-default-"));
  const app = createApp(tempRoot);
  const expectedRoot = path.join(tempRoot, "home", ".zenmind", ".desktop");

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(getDesktopDataLayoutMode(app), "layered");
  assert.equal(getDataRoot(app), path.resolve(expectedRoot));
  assert.equal(fs.existsSync(expectedRoot), true);
  assert.equal(getElectronUserDataRoot(app), path.join(expectedRoot, "profiles", "electron"));
});

test("ensureDataRoot creates layered subdirectories under the current data root", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-managed-"));
  const app = createApp(tempRoot);
  const expectedRoot = path.join(tempRoot, "home", ".zenmind", ".desktop");

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const dataRoot = ensureDataRoot(app);

  assert.equal(dataRoot, path.resolve(expectedRoot));
  for (const dirName of __testInternals.LAYERED_DESKTOP_DIRS) {
    assert.equal(fs.existsSync(path.join(dataRoot, dirName)), true);
  }
  assert.equal(fs.existsSync(path.join(dataRoot, "programs", "services")), true);
  assert.equal(fs.existsSync(path.join(dataRoot, "config", "services")), true);
  assert.equal(fs.existsSync(path.join(dataRoot, "data", "services")), true);
  assert.equal(fs.existsSync(path.join(dataRoot, "state", "desktop")), true);
});

test("packaged Windows legacy root still resolves to the installation data folder", () => {
  const dataRoot = __testInternals.resolveLegacyDesktopRoot({
    platform: "win32",
    isPackaged: true,
    homePath: String.raw`C:\Users\alice`,
    userDataPath: String.raw`C:\Users\alice\AppData\Roaming\zenmind-desktop`,
    execPath: String.raw`D:\ZenMind\ZenMind.exe`
  });

  assert.equal(dataRoot, String.raw`D:\ZenMind\data`);
});

test("Windows new installs resolve to the layered desktop root under the user profile", () => {
  const layout = __testInternals.resolveDesktopDataLayoutFromPaths({
    platform: "win32",
    homePath: String.raw`C:\Users\alice`,
    appDataPath: String.raw`C:\Users\alice\AppData\Roaming`,
    userDataPath: String.raw`C:\Users\alice\AppData\Roaming\zenmind-desktop`,
    execPath: String.raw`D:\ZenMind\ZenMind.exe`,
    isPackaged: true
  });

  assert.equal(layout.mode, "layered");
  assert.equal(layout.root, String.raw`C:\Users\alice\.zenmind\.desktop`);
});

test("legacy data markers keep existing Application Support layout active", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-legacy-"));
  const app = createApp(tempRoot);
  const legacyRoot = path.join(tempRoot, "app-data", "zenmind-desktop");
  fs.mkdirSync(path.join(legacyRoot, "services"), { recursive: true });

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(getDesktopDataLayoutMode(app), "legacy");
  assert.equal(getDataRoot(app), legacyRoot);
  assert.equal(getServicesRoot(app), path.join(legacyRoot, "services"));
  assert.equal(getPluginsRoot(app), path.join(legacyRoot, "plugins"));
  assert.equal(getCredentialsRoot(app), path.join(legacyRoot, "credentials"));
});

test("layered root wins when both new and legacy data exist", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-helpers-"));
  const app = createApp(tempRoot);
  const expectedRoot = path.join(tempRoot, "home", ".zenmind", ".desktop");
  const legacyRoot = path.join(tempRoot, "app-data", "zenmind-desktop");
  fs.mkdirSync(expectedRoot, { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, "services"), { recursive: true });

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(getDesktopDataLayoutMode(app), "layered");
  assert.equal(getDataRoot(app), expectedRoot);
});

test("managed directory helpers join from the layered desktop root", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-layered-"));
  const app = createApp(tempRoot);
  const expectedRoot = path.join(tempRoot, "home", ".zenmind", ".desktop");

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(getServicesRoot(app), path.join(expectedRoot, "programs", "services"));
  assert.equal(getPluginsRoot(app), path.join(expectedRoot, "programs", "plugins"));
  assert.equal(getDesktopConfigRoot(app), path.join(expectedRoot, "config", "desktop"));
  assert.equal(getCredentialsRoot(app), path.join(expectedRoot, "secrets"));
  assert.equal(getServiceConfigRoot(app, "agent-platform"), path.join(expectedRoot, "config", "services", "agent-platform"));
  assert.equal(getServiceDataRoot(app, "agent-platform"), path.join(expectedRoot, "data", "services", "agent-platform"));
  assert.equal(getServiceStateRoot(app, "agent-platform"), path.join(expectedRoot, "state", "services", "agent-platform"));
  assert.equal(getServiceLogsRoot(app, "agent-platform"), path.join(expectedRoot, "logs", "services", "agent-platform"));
});
