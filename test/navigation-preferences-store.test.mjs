import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { readDesktopProfileFromRoot, updateDesktopProfileInRoot } = require("../dist-electron/main/infrastructure/filesystem/profile-store.js");
const { getDesktopConfigRoot } = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");
const { readNavigationOrder, writeNavigationOrder, getNavigationOrderPath } = require("../dist-electron/main/modules/settings/navigation-order-store.js");
const { readWebPinnedKeys, writeWebPinnedKeys, getWebPinnedPath } = require("../dist-electron/main/modules/webs/pinned-store.js");
const { readWebOrderKeys, writeWebOrderKeys, getWebOrderPath } = require("../dist-electron/main/modules/webs/order-store.js");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
function setup(t, platform) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "navigation-files-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const app = { getPath: (name) => name === "home" ? home : path.join(home, name) };
  const root = getDesktopConfigRoot(app, platform);
  return { app, root, profile: path.join(root, "profile.json"), main: getNavigationOrderPath(app, platform), pins: getWebPinnedPath(app, platform), sites: getWebOrderPath(app, platform) };
}
for (const platform of ["darwin", "win32"]) {
  test(`navigation files are independent of profile on ${platform}`, (t) => {
    const { app, root, profile, main, pins, sites } = setup(t, platform);
    updateDesktopProfileInRoot(root, { general: { deviceName: "Test" } });
    const saved = read(profile);
    writeNavigationOrder(app, ["new-chat", "webapp:editor", "kanban", "kanban"], platform);
    writeWebPinnedKeys(app, ["webapp:editor", "webapp:editor", "chats", "website:"], platform);
    writeWebOrderKeys(app, ["website:docs", "webapp:editor"], platform);
    assert.deepEqual(read(main), { schemaVersion: 1, entryKeys: ["new-chat", "webapp:editor", "kanban"] });
    assert.deepEqual(read(pins), { schemaVersion: 1, entryKeys: ["webapp:editor"] });
    assert.deepEqual(read(sites).entryKeys, ["website:docs", "webapp:editor"]);
    assert.deepEqual(read(profile), saved);
    const before = [main, pins, sites].map((file) => fs.readFileSync(file, "utf8"));
    updateDesktopProfileInRoot(root, { appearance: { theme: "dark" } });
    assert.deepEqual([main, pins, sites].map((file) => fs.readFileSync(file, "utf8")), before);
    writeWebPinnedKeys(app, [], platform);
    assert.deepEqual(readNavigationOrder(app, platform), ["new-chat", "webapp:editor", "kanban"]);
    assert.deepEqual(readWebPinnedKeys(app, platform), []);
    assert.deepEqual(readWebOrderKeys(app, [], platform), ["website:docs", "webapp:editor"]);
  });
  test(`missing files never import retired profile fields on ${platform}`, (t) => {
    const { app, root, profile, main, pins, sites } = setup(t, platform);
    const retired = { navigation: { mainOrder: ["kanban"], webOrder: ["website:docs"], pinnedWebEntryKeys: ["website:docs"] } };
    write(profile, retired);
    readDesktopProfileFromRoot(root);
    assert.deepEqual(readNavigationOrder(app, platform), []);
    assert.deepEqual(readWebPinnedKeys(app, platform), []);
    assert.deepEqual(readWebOrderKeys(app, [], platform), []);
    assert.deepEqual(read(profile), retired);
    for (const file of [main, pins, sites]) assert.equal(fs.existsSync(file), false);
  });
  test(`failed saves preserve confirmed navigation on ${platform}`, (t) => {
    const { app, root, main } = setup(t, platform);
    writeNavigationOrder(app, ["new-chat", "kanban"], platform);
    const confirmed = fs.readFileSync(main, "utf8");
    const failure = t.mock.method(fs, "renameSync", () => { throw new Error("write blocked"); });
    assert.throws(() => writeNavigationOrder(app, ["schedules"], platform), /write blocked/);
    assert.equal(fs.readFileSync(main, "utf8"), confirmed);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
    failure.mock.restore();
  });
}
test("navigation accepts only the dedicated schema", (t) => {
  const { app, main } = setup(t, "darwin");
  for (const invalid of [[], { ids: ["kanban"] }, { schemaVersion: 2, entryKeys: [] }]) {
    write(main, invalid);
    assert.throws(() => readNavigationOrder(app, "darwin"), /Unsupported|Invalid/);
  }
});
