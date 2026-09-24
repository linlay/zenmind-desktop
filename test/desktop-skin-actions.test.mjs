import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import JSZip from "jszip";
const require = createRequire(import.meta.url);
const { createDesktopSkinStore } = require("../dist-electron/main/modules/settings/appearance-store.js");
const { createAppearanceRuntime } = require("../dist-electron/main/modules/settings/appearance-runtime.js");
const { isDesktopSkinArchivePath } = require("../dist-electron/main/modules/desktop-actions/skin-actions.js");
const { handleActionCall } = require("../dist-electron/main/modules/desktop-actions/action-handlers.js");
const { updateDesktopProfileInRoot } = require("../dist-electron/main/infrastructure/filesystem/profile-store.js");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=", "base64");

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skin-actions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config");
  const store = createDesktopSkinStore({ configRoot, assetsRoot: path.join(root, "assets"), normalizeImage: () => ({ data: png, width: 1, height: 1 }) });
  let changes = 0;
  const runtime = createAppearanceRuntime(() => store, () => { changes++; });
  const options = { app: { getPath: () => root }, platform: "darwin", appearanceRuntime: runtime, getMainWindow: () => null, getCurrentPageSnapshot: () => null };
  const call = (name, args, kind = "agentPlatform") => handleActionCall(options, { action: `desktop.skin.${name}`, args, permissionMode: "full_access" }, { kind });
  const source = path.join(root, "敦煌 skin.zip");
  async function write(version = "1.0.0") {
    const zip = new JSZip();
    zip.file("skin.json", JSON.stringify({ schemaVersion: "1.1", id: "test.dunhuang", name: "敦煌", version,
      variants: { light: { tokens: { "--accent": "#123456" } }, dark: { tokens: { "--accent": "#abcdef" } } } }));
    fs.writeFileSync(source, await zip.generateAsync({ type: "nodebuffer" }));
  }
  await write();
  return { root, configRoot, store, runtime, options, source, call, write, changes: () => changes };
}

test("skin actions import inactive, expose minimal DTOs, retain/reset background and remove active skin", async t => {
  const h = await setup(t);
  assert.equal((await h.call("list")).result.skins.length, 4);
  await h.call("set", { skinId: "mist" });
  const imported = await h.call("import", { filePath: h.source });
  assert.equal(imported.ok, true);
  const skinId = imported.result.skinId;
  assert.match(skinId, /^pack:[a-f0-9]{32}$/);
  assert.deepEqual(Object.keys(imported.result).sort(), ["available", "name", "skinId", "source", "version"]);
  assert.equal((await h.call("get")).result.activeSkinId, "mist");
  assert.equal((await h.call("import", { filePath: h.source })).error.code, "packageExists");
  await h.write("2.0.0");
  assert.equal((await h.call("import", { filePath: h.source })).ok, true);
  const background = path.join(h.root, "background.png"); fs.writeFileSync(background, png);
  await h.runtime.run(store => store.importFile(background), true);
  assert.deepEqual((await h.call("set", { skinId, keepBackground: true })).result.customBackground, { configured: true, available: true });
  assert.deepEqual((await h.call("set", { skinId })).result.customBackground, { configured: false, available: false });
  assert.deepEqual((await h.call("remove", { skinId })).result, { skinId, activeSkinId: "default" });
  assert.equal((await h.call("set", { skinId })).error.code, "skin_not_found");
  const listed = await h.call("list");
  assert.equal(listed.result.skins.length, 5);
  assert(!JSON.stringify(listed).includes(h.root));
  assert(!JSON.stringify(listed).includes("data:image"));
  assert(h.changes() >= 6);
  updateDesktopProfileInRoot(h.configRoot, { appearance: { skinId } });
  assert.deepEqual((await h.call("get")).result, { skinId, activeSkinId: "default", available: false, customBackground: { configured: false, available: false } });
});

test("strict arguments, missing/corrupt archives and unauthorized callers cannot mutate skins", async t => {
  const h = await setup(t);
  for (const [name, args] of [["get", { extra: true }], ["list", []], ["import", {}], ["import", { filePath: "relative.zip" }], ["set", { skinId: "mist", keepBackground: "yes" }], ["set", { skinId: "unknown" }], ["remove", { skinId: "default" }]]) {
    assert.equal((await h.call(name, args)).error.code, "invalid_args");
  }
  for (const kind of ["webappPage", "webappBackend", "agentWebclientWorkPanel"]) {
    assert.equal((await h.call("import", { filePath: h.source }, kind)).error.code, "forbidden");
  }
  assert.equal((await h.call("import", { filePath: path.join(h.root, "missing.zip") })).error.code, "file_not_found");
  fs.writeFileSync(h.source, "bad zip");
  assert.equal((await h.call("import", { filePath: h.source })).error.code, "invalidPackage");
  assert.equal((await h.call("list")).result.skins.length, 4);
  assert.equal((await h.call("set", { skinId: "ocean" })).ok, true);
});

test("skin paths explicitly handle macOS and Windows without URI or relative fallbacks", () => {
  assert(isDesktopSkinArchivePath("/Users/name/敦煌 skin.zip", "darwin"));
  assert(isDesktopSkinArchivePath("C:\\Users\\name\\敦煌 skin.ZIP", "win32"));
  assert(isDesktopSkinArchivePath("D:/skins/test.zip", "win32"));
  for (const value of ["~/skin.zip", "@workspace/skin.zip", "file:///tmp/skin.zip", "https://example.com/skin.zip", "test.zip", "/tmp/a.zip\0"]) {
    assert.equal(isDesktopSkinArchivePath(value, "darwin"), false);
    assert.equal(isDesktopSkinArchivePath(value, "win32"), false);
  }
  for (const value of ["C:skin.zip", "\\skins\\a.zip", "\\\\host\\share\\a.zip", "\\\\?\\C:\\a.zip", "C:\\a:stream.zip", "/tmp/a.zip"]) assert.equal(isDesktopSkinArchivePath(value, "win32"), false);
  assert.equal(isDesktopSkinArchivePath("C:\\skins\\a.zip", "darwin"), false);
});

test("UI and action reads/writes serialize behind a pending operation and recover from rejection", async t => {
  const h = await setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = h.runtime.run(async store => { await gate; store.setSkin("mist"); }, true);
  let finished = false;
  const action = h.call("set", { skinId: "violet" }).then(value => { finished = true; return value; });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  release(); await pending; assert.equal((await action).result.activeSkinId, "violet");
  await assert.rejects(h.runtime.run(() => { throw new Error("failed operation"); }, true));
  assert.equal((await h.call("get")).result.activeSkinId, "violet");
  const committed = createAppearanceRuntime(() => h.store, () => { throw new Error("window closed"); });
  await committed.run(store => store.setSkin("ocean"), true);
  assert.equal(h.store.read().skinId, "ocean");
});

test("skin mutations use existing confirmation and denial leaves state and notifications unchanged", async t => {
  const h = await setup(t);
  let confirmations = 0;
  h.options.getMainWindow = () => ({ isDestroyed: () => false });
  h.options.confirmRendererAction = async request => {
    confirmations++;
    return { requestId: request.requestId, decision: "cancel" };
  };
  const skinId = (await h.call("import", { filePath: h.source })).result.skinId;
  const before = h.changes();
  for (const [name, args] of [["import", { filePath: h.source }], ["set", { skinId }], ["remove", { skinId }]]) {
    const response = await handleActionCall(h.options, { action: `desktop.skin.${name}`, args }, { kind: "agentPlatform" });
    assert.equal(response.error.code, "user_cancelled");
  }
  assert.equal(confirmations, 3);
  assert.equal(h.changes(), before);
  assert.equal((await h.call("get")).result.activeSkinId, "default");
  assert.equal((await h.call("list")).result.skins.length, 5);
  assert.equal(confirmations, 3);
  assert.equal((await h.call("set", { skinId: `pack:${"0".repeat(32)}` })).error.code, "skin_not_found");
  assert.equal(h.changes(), before);
});
