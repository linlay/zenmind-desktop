import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { initializeElectronProfile } = require("../dist-electron/main/app/bootstrap/electron-profile.js");
const { desktopDataRootExists } = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

test("macOS profile initialization pins both paths without changing the first-install snapshot", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-electron-profile-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = {};
  const app = { isReady: () => false, getPath: () => home, setPath: (key, value) => {
    assert.equal(fs.statSync(value).isDirectory(), true);
    paths[key] = value;
  } };
  const firstInstall = !desktopDataRootExists(app, "darwin");
  initializeElectronProfile(app, "darwin");
  const expected = path.join(home, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir, "state", "chromium");
  assert.deepEqual(paths, { userData: expected, sessionData: expected });
  assert.equal(firstInstall, true);
  assert.equal(desktopDataRootExists(app, "darwin"), true);
  const marker = path.join(expected, "existing-profile.txt");
  fs.writeFileSync(marker, "preserved");
  initializeElectronProfile(app, "darwin");
  assert.equal(fs.readFileSync(marker, "utf8"), "preserved");
});

test("Windows profile initialization uses the registered data root and Windows separators", (t) => {
  const root = `D:\\Desktop Data\\${APP_BRAND.paths.runtimeRootDirName}`;
  const created = [];
  const paths = {};
  t.mock.method(childProcess, "execFileSync", () => Buffer.from(Buffer.from(root).toString("base64")));
  t.mock.method(fs, "mkdirSync", (directory) => { created.push(directory); });
  t.mock.method(fs, "existsSync", () => assert.fail("profile initialization only creates its current directory"));
  initializeElectronProfile({
    isReady: () => false,
    getPath: () => "C:\\Users\\tester",
    setPath: (key, value) => { paths[key] = value; }
  }, "win32");
  const expected = path.win32.join(root, APP_BRAND.paths.desktopDataSubdir, "state", "chromium");
  assert.deepEqual(paths, { userData: expected, sessionData: expected });
  assert.ok(created.includes(expected));
});

test("profile paths cannot be relocated after Electron is ready", () => {
  assert.throws(() => initializeElectronProfile({
    isReady: () => true,
    getPath: () => assert.fail("late initialization must not touch disk"),
    setPath: () => assert.fail("late initialization must not change paths")
  }), /before app ready/u);
});

test("runtime configures the profile after snapshots and single-instance handling, before ready", () => {
  const source = fs.readFileSync(new URL("../src/main/app/runtime.ts", import.meta.url), "utf8");
  const initializeIndex = source.indexOf("initializeElectronProfile(app, startupPlatform);");
  for (const statement of [
    "const isFirstDesktopInstall =", "const runtimeRootExistedAtStartup =",
    "const runtimeEnvExistedAtStartup =", "const envZipConflictNeedsDecision =",
    "const gotSingleInstanceLock =", "if (!gotSingleInstanceLock)"
  ]) {
    const index = source.indexOf(statement);
    assert.ok(index >= 0 && index < initializeIndex, statement);
  }
  assert.ok(initializeIndex < source.indexOf("const desktopSsoController ="));
  const ready = fs.readFileSync(new URL("../src/main/app/lifecycle/app-ready.ts", import.meta.url), "utf8");
  assert.ok(ready.indexOf("await dependencies.startupEnvironmentRuntime.prepareStartupRuntimeEnvironment()") <
    ready.indexOf("registerDesktopSsoAvatarProtocol(app,"));
});
