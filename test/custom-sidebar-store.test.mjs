import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  addCustomSidebarItem,
  exportCustomSidebarItems,
  importCustomSidebarItems,
  listCustomSidebarItems,
  removeCustomSidebarItem,
  updateCustomSidebarItem,
  __testInternals
} = require("../dist-electron/main/custom-sidebar-store.js");

function createApp(userDataRoot) {
  const tempRoot = path.dirname(userDataRoot);
  const homePath = path.join(tempRoot, "home");
  const appDataPath = path.join(tempRoot, "app-data");
  return {
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

test("custom sidebar items persist locally with normalized URLs", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

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

test("custom sidebar items can store and update associated agent keys", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-agent-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const added = addCustomSidebarItem(app, {
    label: "Docs",
    url: "docs.example.com",
    agentKey: " agent-docs "
  });

  assert.equal(added.ok, true);
  assert.equal(added.item?.agentKey, "agent-docs");

  const updated = updateCustomSidebarItem(app, added.item.id, {
    agentKey: "agent-research"
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.item?.agentKey, "agent-research");
  assert.equal(listCustomSidebarItems(app).items[0].agentKey, "agent-research");

  const cleared = updateCustomSidebarItem(app, added.item.id, {
    agentKey: ""
  });

  assert.equal(cleared.ok, true);
  assert.ok(cleared.item);
  assert.equal("agentKey" in cleared.item, false);
});

test("custom sidebar rejects duplicates and deletes only custom items", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-delete-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

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
  assert.match(duplicate.message, /已经是内嵌网站/);
  assert.equal(duplicate.items.length, 1);

  const removed = removeCustomSidebarItem(app, added.item.id);
  assert.equal(removed.ok, true);
  assert.equal(removed.items.length, 0);
});

test("custom sidebar assigns icon library entries without repeating current items", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-icons-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

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

test("custom sidebar export and import preserve items across machines", (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-export-source-"));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-export-target-"));
  const sourceApp = createApp(path.join(sourceRoot, "user-data"));
  const targetApp = createApp(path.join(targetRoot, "user-data"));

  t.after(() => {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  });

  addCustomSidebarItem(sourceApp, {
    label: "百度",
    url: "www.baidu.com",
    agentKey: "agent-baidu"
  });
  addCustomSidebarItem(sourceApp, {
    label: "GitHub",
    url: "github.com"
  });

  const exported = exportCustomSidebarItems(sourceApp);
  const imported = importCustomSidebarItems(targetApp, exported);

  assert.equal(imported.ok, true);
  assert.equal(imported.items.length, 2);
  assert.deepEqual(
    imported.items.map((item) => item.url),
    ["https://www.baidu.com/", "https://github.com/"]
  );
  assert.equal(imported.items[0].agentKey, "agent-baidu");
});

test("custom sidebar import merges new items and skips existing URLs", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-custom-sidebar-import-"));
  const app = createApp(path.join(tempRoot, "user-data"));

  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  addCustomSidebarItem(app, {
    label: "百度",
    url: "www.baidu.com"
  });

  const imported = importCustomSidebarItems(
    app,
    JSON.stringify({
      items: [
        { id: "a", label: "百度", url: "https://www.baidu.com/" },
        { id: "b", label: "GitHub", url: "github.com", agentKey: 123 }
      ]
    })
  );

  assert.equal(imported.ok, true);
  assert.equal(imported.items.length, 2);
  assert.deepEqual(
    imported.items.map((item) => item.url),
    ["https://www.baidu.com/", "https://github.com/"]
  );
  assert.equal(imported.items[1].agentKey, undefined);
});
