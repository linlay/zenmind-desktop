import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { readNavigationPreferences, saveNavigationPreferences, setWebEntryPinned, setNavigationPreferencesChangedListener } = require("../dist-electron/main/modules/settings/navigation-preferences.js");
const { getWebPinnedPath } = require("../dist-electron/main/modules/webs/pinned-store.js");

const keys = ["website:docs", "webapp:webapp-0123456789abcdef"];
function setup(t, platform) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "site-pinning-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const app = { getPath: (name) => name === "home" ? home : path.join(home, name) };
  const notifications = [];
  setNavigationPreferencesChangedListener(app, (snapshot) => notifications.push(snapshot), platform);
  saveNavigationPreferences(app, { mainOrder: ["kanban", "new-chat"], webOrder: keys }, platform);
  notifications.length = 0;
  return { app, notifications };
}

for (const platform of ["darwin", "win32"]) {
  test(`pinning persists mixed navigation and preserves Sites order on ${platform}`, (t) => {
    const { app, notifications } = setup(t, platform);
    const pin = (entryKey, pinned) => setWebEntryPinned(app, { entryKey, pinned }, keys, platform);
    const first = pin(keys[0], true);
    assert.deepEqual(first.mainOrder, [keys[0], "kanban", "new-chat"]);
    const second = pin(keys[1], true);
    assert.deepEqual(second.pinnedWebEntryKeys, [keys[1], keys[0]]);
    assert.deepEqual(second.mainOrder, [keys[1], keys[0], "kanban", "new-chat"]);
    assert.deepEqual(readNavigationPreferences(app, platform), second);
    assert.deepEqual(pin(keys[0], true), second, "repeated pin must not move the existing entry");
    assert.equal(notifications.length, 2);
    const unpinned = pin(keys[1], false);
    assert.deepEqual(unpinned.mainOrder, [keys[0], "kanban", "new-chat"]);
    assert.deepEqual(unpinned.webOrder, keys);
    assert.deepEqual(unpinned.pinnedWebEntryKeys, [keys[0]]);
    assert.deepEqual(pin(keys[1], false), unpinned);
    assert.equal(notifications.length, 3);
  });

  test(`stale UI ordering cannot overwrite a new Agent pin on ${platform}`, (t) => {
    const { app } = setup(t, platform);
    const displayed = readNavigationPreferences(app, platform);
    const pinned = setWebEntryPinned(app, { entryKey: keys[1], pinned: true }, keys, platform);
    assert.throws(() => saveNavigationPreferences(app, { mainOrder: ["new-chat", "kanban"], expectedRevision: displayed.revision }, platform),
      (error) => error.code === "navigation_conflict");
    assert.deepEqual(readNavigationPreferences(app, platform), pinned);
    const reordered = saveNavigationPreferences(app, { mainOrder: ["new-chat", keys[1], "kanban"], expectedRevision: pinned.revision }, platform);
    assert.deepEqual(reordered.pinnedWebEntryKeys, [keys[1]]);
    assert.deepEqual(reordered.webOrder, keys);
  });

  test(`failed pin commit restores main navigation on ${platform}`, (t) => {
    const { app, notifications } = setup(t, platform);
    const before = readNavigationPreferences(app, platform);
    const rename = fs.renameSync;
    const failure = t.mock.method(fs, "renameSync", (source, target) => {
      if (target === getWebPinnedPath(app, platform)) throw new Error("pin write blocked");
      return rename(source, target);
    });
    assert.throws(() => setWebEntryPinned(app, { entryKey: keys[0], pinned: true }, keys, platform),
      (error) => error.code === "navigation_write_failed" && error.executionState === "rolled_back");
    failure.mock.restore();
    assert.deepEqual(readNavigationPreferences(app, platform), before);
    assert.equal(notifications.length, 0);
  });
}

test("pin input and missing targets cannot change navigation", (t) => {
  const { app } = setup(t, "darwin");
  const before = readNavigationPreferences(app, "darwin");
  for (const input of [{ entryKey: keys[0], pinned: "true" }, { entryKey: "personal-workbench", pinned: true }, { entryKey: keys[0], pinned: true, source: {} }]) {
    assert.throws(() => setWebEntryPinned(app, input, keys, "darwin"), (error) => error.code === "invalid_args");
  }
  assert.throws(() => setWebEntryPinned(app, { entryKey: "website:missing", pinned: true }, keys, "darwin"),
    (error) => error.code === "site_not_found" && error.executionState === "not_started");
  assert.deepEqual(readNavigationPreferences(app, "darwin"), before);
});


test("a cleanup error after file replacement still restores both navigation files", (t) => {
  const { app, notifications } = setup(t, "darwin");
  const before = readNavigationPreferences(app, "darwin");
  const remove = fs.rmSync;
  let failed = false;
  const failure = t.mock.method(fs, "rmSync", (file, options) => {
    if (!failed && String(file).startsWith(getWebPinnedPath(app, "darwin") + ".")) {
      failed = true;
      throw new Error("cleanup failed after commit");
    }
    return remove(file, options);
  });
  assert.throws(() => setWebEntryPinned(app, { entryKey: keys[0], pinned: true }, keys, "darwin"),
    (error) => error.executionState === "rolled_back");
  failure.mock.restore();
  assert.equal(failed, true);
  assert.deepEqual(readNavigationPreferences(app, "darwin"), before);
  assert.equal(notifications.length, 0);
});

test("UI IPC and Action port share the same persisted Website pin", async (t) => {
  const { app } = setup(t, "darwin");
  const { registerSettingsIpcHandlers } = require("../dist-electron/main/modules/settings/ipc.js");
  const { writeWebsiteItem } = require("../dist-electron/main/modules/webs/websites/store.js");
  const { listWebEntries } = require("../dist-electron/main/modules/webs/ipc.js");
  const { setSitePinned } = require("../dist-electron/main/modules/settings/navigation-preferences.js");
  writeWebsiteItem(app, { id: "docs", entryKey: keys[0], kind: "website", label: "Docs", url: "https://example.test", createdAt: 1, updatedAt: 1 }, "darwin");
  const handlers = new Map();
  const notifications = [];
  registerSettingsIpcHandlers({ handle: (key, callback) => handlers.set(key, callback) }, {
    app, platform: "darwin", nativeTheme: { themeSource: "system" },
    initializeMainI18n: () => ({}), isSupportedLocale: () => true, setMainLocale: () => ({}),
    buildApplicationMenu() {}, refreshTrayContextMenu() {}, emitLocaleChanged() {},
    onNavigationPreferencesChanged: (snapshot) => notifications.push(snapshot)
  });
  const pinned = await handlers.get("settings.setWebEntryPinned")({}, { entryKey: keys[0], pinned: true });
  assert.deepEqual(pinned.pinnedWebEntryKeys, [keys[0]]);
  assert.equal(notifications.length, 1);
  const unpinned = setSitePinned(app, { entryKey: keys[0], pinned: false },
    listWebEntries(app).items.map((item) => item.entryKey), "darwin");
  assert.deepEqual(unpinned, { ok: true, result: { entryKey: keys[0], pinned: false } });
  assert.deepEqual((await handlers.get("settings.getNavigationPreferences")()).pinnedWebEntryKeys, []);
  assert.equal(notifications.length, 2);
});
