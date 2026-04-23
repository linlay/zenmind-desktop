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
  getPluginsRoot,
  getServicesRoot
} = require("../dist-electron/main/user-paths.js");

function createApp(userDataRoot, { isPackaged = false } = {}) {
  return {
    isPackaged,
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

test("getDataRoot falls back to userData when app is not packaged", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-default-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(getDataRoot(app), path.resolve(userDataRoot));
  assert.equal(fs.existsSync(userDataRoot), true);
});

test("ensureDataRoot creates managed subdirectories under the current data root", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-managed-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const dataRoot = ensureDataRoot(app);

  assert.equal(dataRoot, path.resolve(userDataRoot));
  for (const dirName of __testInternals.MANAGED_DATA_DIRS) {
    assert.equal(fs.existsSync(path.join(dataRoot, dirName)), true);
  }
});

test("packaged Windows builds use the installation directory data folder", () => {
  const dataRoot = __testInternals.resolveDefaultDataRoot({
    platform: "win32",
    isPackaged: true,
    userDataPath: String.raw`C:\Users\alice\AppData\Roaming\zenmind-desktop`,
    execPath: String.raw`D:\国泰君安期货\国泰君安期货.exe`
  });

  assert.equal(dataRoot, String.raw`D:\国泰君安期货\data`);
});

test("managed directory helpers join from the computed data root", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-helpers-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const expectedRoot = path.resolve(userDataRoot);

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(getServicesRoot(app), path.join(expectedRoot, "services"));
  assert.equal(getPluginsRoot(app), path.join(expectedRoot, "plugins"));
  assert.equal(getCredentialsRoot(app), path.join(expectedRoot, "credentials"));
});
