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
