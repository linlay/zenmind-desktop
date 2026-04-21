import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  addCustomSidebarItem,
  listCustomSidebarItems,
  removeCustomSidebarItem,
  __testInternals
} = require("../dist-electron/main/custom-sidebar-store.js");
const { saveDataRoot, __testInternals: userPathTestInternals } = require("../dist-electron/main/user-paths.js");

function createApp(userDataRoot) {
  return {
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

test("custom sidebar items persist locally with normalized URLs", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp(userDataRoot);

  t.after(() => {
    userPathTestInternals.resetState();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  saveDataRoot(app, dataRoot);

  const added = addCustomSidebarItem(app, {
    label: "百度",
    url: "www.baidu.com"
  });

  assert.equal(added.ok, true);
  assert.equal(added.item?.label, "百度");
  assert.equal(added.item?.url, "https://www.baidu.com/");
  assert.equal(added.item?.iconId, "desktop-01");
  assert.equal(added.items.length, 1);
  assert.equal(fs.existsSync(__testInternals.getCustomSidebarPath(app)), true);

  const loaded = listCustomSidebarItems(app);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.items, added.items);
});

test("custom sidebar rejects duplicates and deletes only custom items", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-delete-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp(userDataRoot);

  t.after(() => {
    userPathTestInternals.resetState();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  saveDataRoot(app, dataRoot);

  const added = addCustomSidebarItem(app, {
    url: "https://www.baidu.com"
  });
  assert.equal(added.ok, true);
  assert.equal(added.item?.label, "百度");
  assert.equal(added.item?.iconId, "desktop-01");

  const duplicate = addCustomSidebarItem(app, {
    label: "重复百度",
    url: "www.baidu.com"
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /已经在侧边栏/);
  assert.equal(duplicate.items.length, 1);

  const removed = removeCustomSidebarItem(app, added.item.id);
  assert.equal(removed.ok, true);
  assert.equal(removed.items.length, 0);
});

test("custom sidebar assigns icon library entries without repeating current items", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-icons-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp(userDataRoot);

  t.after(() => {
    userPathTestInternals.resetState();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  saveDataRoot(app, dataRoot);

  const first = addCustomSidebarItem(app, {
    label: "Google",
    url: "www.google.com"
  });
  const second = addCustomSidebarItem(app, {
    label: "百度",
    url: "www.baidu.com"
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.item?.iconId, "desktop-01");
  assert.equal(second.item?.iconId, "desktop-02");
  assert.equal(new Set(second.items.map((item) => item.iconId)).size, second.items.length);

  const removed = removeCustomSidebarItem(app, first.item.id);
  assert.equal(removed.ok, true);

  const reused = addCustomSidebarItem(app, {
    label: "GitHub",
    url: "github.com"
  });
  assert.equal(reused.ok, true);
  assert.equal(reused.item?.iconId, "desktop-01");
  assert.equal(new Set(reused.items.map((item) => item.iconId)).size, reused.items.length);
});
