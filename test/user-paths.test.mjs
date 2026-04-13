import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  getCredentialsRoot,
  getDataRoot,
  getPluginsRoot,
  getServicesRoot,
  loadUserPaths,
  migrateDataRoot,
  saveDataRoot
} = require("../dist-electron/main/user-paths.js");

function createApp(userDataRoot) {
  return {
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

test("loadUserPaths falls back to userData when config file is absent", (t) => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-default-"));
  const app = createApp(userDataRoot);

  t.after(() => {
    __testInternals.resetState();
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  });

  const loaded = loadUserPaths(app);

  assert.deepEqual(loaded, {
    configured: false,
    dataRoot: path.resolve(userDataRoot)
  });
  assert.equal(getDataRoot(app), path.resolve(userDataRoot));
});

test("saveDataRoot persists config and exposes managed subdirectories", (t) => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-save-"));
  const dataRoot = path.join(userDataRoot, "custom-data");
  const app = createApp(userDataRoot);

  t.after(() => {
    __testInternals.resetState();
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  });

  const savedRoot = saveDataRoot(app, dataRoot);
  const configPath = __testInternals.getConfigPath(app);

  assert.equal(savedRoot, path.resolve(dataRoot));
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
    dataRoot: path.resolve(dataRoot)
  });
  assert.equal(getServicesRoot(app), path.join(path.resolve(dataRoot), "services"));
  assert.equal(getPluginsRoot(app), path.join(path.resolve(dataRoot), "plugins"));
  assert.equal(getCredentialsRoot(app), path.join(path.resolve(dataRoot), "credentials"));
  assert.equal(fs.existsSync(getServicesRoot(app)), true);
  assert.equal(fs.existsSync(getPluginsRoot(app)), true);
  assert.equal(fs.existsSync(getCredentialsRoot(app)), true);
});

test("migrateDataRoot copies managed data and cleans old directories", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-migrate-"));
  const oldUserDataRoot = path.join(tempRoot, "user-data");
  const oldDataRoot = path.join(tempRoot, "data-a");
  const newDataRoot = path.join(tempRoot, "data-b");
  const app = createApp(oldUserDataRoot);

  t.after(() => {
    __testInternals.resetState();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  saveDataRoot(app, oldDataRoot);
  fs.mkdirSync(path.join(oldDataRoot, "services", "svc"), { recursive: true });
  fs.mkdirSync(path.join(oldDataRoot, "plugins", "plugin-a"), { recursive: true });
  fs.mkdirSync(path.join(oldDataRoot, "credentials"), { recursive: true });
  fs.writeFileSync(path.join(oldDataRoot, "services", "svc", "manifest.json"), "{\"id\":\"svc\"}\n", "utf8");
  fs.writeFileSync(path.join(oldDataRoot, "plugins", "plugin-a", "manifest.json"), "{\"id\":\"plugin-a\"}\n", "utf8");
  fs.writeFileSync(path.join(oldDataRoot, "credentials", "key.pem"), "secret\n", "utf8");

  await migrateDataRoot(app, oldDataRoot, newDataRoot);

  assert.equal(getDataRoot(app), path.resolve(newDataRoot));
  assert.equal(fs.existsSync(path.join(newDataRoot, "services", "svc", "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(newDataRoot, "plugins", "plugin-a", "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(newDataRoot, "credentials", "key.pem")), true);
  assert.equal(fs.existsSync(path.join(oldDataRoot, "services")), false);
  assert.equal(fs.existsSync(path.join(oldDataRoot, "plugins")), false);
  assert.equal(fs.existsSync(path.join(oldDataRoot, "credentials")), false);
});

test("migrateDataRoot keeps old data when target already contains managed files", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-paths-conflict-"));
  const oldUserDataRoot = path.join(tempRoot, "user-data");
  const oldDataRoot = path.join(tempRoot, "data-a");
  const newDataRoot = path.join(tempRoot, "data-b");
  const app = createApp(oldUserDataRoot);

  t.after(() => {
    __testInternals.resetState();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  saveDataRoot(app, oldDataRoot);
  fs.mkdirSync(path.join(oldDataRoot, "services", "svc"), { recursive: true });
  fs.writeFileSync(path.join(oldDataRoot, "services", "svc", "manifest.json"), "{\"id\":\"svc\"}\n", "utf8");
  fs.mkdirSync(path.join(newDataRoot, "services"), { recursive: true });
  fs.writeFileSync(path.join(newDataRoot, "services", "occupied.txt"), "busy\n", "utf8");

  await assert.rejects(() => migrateDataRoot(app, oldDataRoot, newDataRoot), /目标目录已包含现有 services 数据/);
  assert.equal(fs.existsSync(path.join(oldDataRoot, "services", "svc", "manifest.json")), true);
  assert.equal(getDataRoot(app), path.resolve(oldDataRoot));
});
