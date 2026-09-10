import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import JSZip from "jszip";
const require = createRequire(import.meta.url);
const { createDesktopSkinStore } = require("../dist-electron/main/modules/settings/appearance-store.js");
const { parseSkinPackageManifest, SKIN_PACKAGE_LIMITS } = require("../dist-electron/shared/desktop-skin-package.js");
const { updateDesktopProfileInRoot } = require("../dist-electron/main/infrastructure/filesystem/profile-store.js");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=", "base64");
const manifest = () => ({ schemaVersion: 1, id: "forest.lake", name: "山湖", version: "1.0.0", author: "测试作者",
  variants: {
    light: { tokens: { "--accent": "#287653", "--control-primary-active": "#194d35", "--control-radius": "12px" }, background: { path: "assets/lake.png", position: "50% 40%" } },
    dark: { tokens: { "--accent": "#83c79a" }, background: { path: "assets/lake.png" } }
  } });
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skin-package-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { configRoot: path.join(root, "config"), assetsRoot: path.join(root, "assets"), normalizeImage: () => ({ data: png, width: 1, height: 1 }) };
  const store = createDesktopSkinStore(options);
  const source = path.join(root, "皮肤 包.zip");
  async function write(value = manifest(), edit = () => {}, prefix = "") {
    const zip = new JSZip();
    zip.file(prefix + "skin.json", JSON.stringify(value));
    zip.file(prefix + "assets/lake.png", png);
    edit(zip);
    fs.writeFileSync(source, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" }));
  }
  return { root, source, options, store, write };
}
test("ZIP installs inactive, resolves both variants, persists across source removal and reload", async (t) => {
  const h = setup(t); await h.write();
  h.store.setSkin("mist");
  const { settings, importedSkinId } = await h.store.importPackage(h.source);
  assert.equal(settings.skinId, "mist");
  assert.equal(settings.installedSkins[0].name, "山湖");
  assert.match(importedSkinId, /^pack:[a-f0-9]{32}$/);
  const applied = h.store.setSkin(importedSkinId);
  assert.equal(applied.installedSkin.tokens.light["--accent-rgb"], "40, 118, 83");
  assert.equal(applied.installedSkin.backgrounds.light.position, "50% 40%");
  assert.match(applied.installedSkin.backgrounds.dark.imageUrl, /^data:image\/png;base64,/);
  fs.unlinkSync(h.source);
  updateDesktopProfileInRoot(h.options.configRoot, { appearance: { theme: "dark", locale: "en-US" } });
  assert.deepEqual(createDesktopSkinStore(h.options).read(), applied);
  const profile = fs.readFileSync(path.join(h.options.configRoot, "profile.json"), "utf8");
  assert(!profile.includes("base64") && !profile.includes(h.root));
});
test("same id/version is rejected, newer versions coexist, and wrapped Finder ZIPs work", async (t) => {
  const h = setup(t); await h.write(manifest(), (zip) => { zip.file("__MACOSX/._skin.json", "metadata"); zip.file("森林/.DS_Store", "metadata"); }, "森林/");
  const first = await h.store.importPackage(h.source);
  await assert.rejects(h.store.importPackage(h.source), /packageExists/);
  await h.write({ ...manifest(), version: "1.1.0" });
  const second = await h.store.importPackage(h.source);
  assert.notEqual(first.importedSkinId, second.importedSkinId);
  assert.equal(second.settings.installedSkins.length, 2);
});
test("package selection optionally retains a custom image; removing active skin falls back", async (t) => {
  const h = setup(t); await h.write();
  const { importedSkinId } = await h.store.importPackage(h.source);
  const original = path.join(h.root, "mine.png"); fs.writeFileSync(original, png);
  const background = h.store.importFile(original).background;
  assert.deepEqual(h.store.setSkin(importedSkinId, { keepBackground: true }).background, background);
  assert.equal(h.store.setSkin(importedSkinId).background, null);
  assert(!fs.existsSync(path.join(h.options.assetsRoot, background.id + ".png")));
  const removed = h.store.removePackage(importedSkinId);
  assert.equal(removed.skinId, "default");
  assert.equal(removed.installedSkins, undefined);
  assert.throws(() => h.store.setSkin(importedSkinId), /Unknown/);
});
test("manifest rejects executable CSS, unknown fields, unsafe paths and unsupported versions", () => {
  for (const tokens of [{ "--accent": "url(https://example.test/x)" }, { "--ink": "var(--other)" }, { "--accent": "rgb(999,0,0)" },
    { "--control-radius": "99px" }, { "--layout-width": "100px" }, { "--accent-rgb": "1,2,3" }, { "__proto__": null }]) {
    if (!Object.keys(tokens).length) continue;
    const value = manifest(); value.variants.light.tokens = tokens;
    assert.throws(() => parseSkinPackageManifest(value), /invalidPackage/);
  }
  for (const asset of ["../x.png", "/x.png", "C:/x.png", "assets/CON.png", "assets/x.png:stream", "assets\\x.png", "http://x.png", "assets/x.svg"]) {
    const value = manifest(); value.variants.light.background.path = asset;
    assert.throws(() => parseSkinPackageManifest(value), /invalidPackage/);
  }
  assert.throws(() => parseSkinPackageManifest({ ...manifest(), script: "x.js" }), /invalidPackage/);
  assert.throws(() => parseSkinPackageManifest({ ...manifest(), schemaVersion: 2 }), /unsupportedPackageVersion/);
});
test("archive rejects traversal, case collisions, symlinks, scripts and missing resources", async (t) => {
  const h = setup(t);
  for (const edit of [
    (zip) => zip.file("../escape.png", png),
    (zip) => zip.file("ASSETS/LAKE.PNG", png),
    (zip) => zip.file("assets/lake.png", "../outside", { unixPermissions: 0o120777 }),
    (zip) => zip.file("evil.js", "alert(1)"),
    (zip) => zip.remove("assets/lake.png")
  ]) {
    await h.write(manifest(), edit);
    await assert.rejects(h.store.importPackage(h.source), /invalidPackage/);
    assert.equal(h.store.read().installedSkins, undefined);
  }
});
test("CRC failure, declared expansion bombs, oversized input and entry limits are rejected", async (t) => {
  const h = setup(t); await h.write();
  let data = fs.readFileSync(h.source), central = data.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  data.writeUInt32LE(123, central + 16); fs.writeFileSync(h.source, data);
  await assert.rejects(h.store.importPackage(h.source), /invalidPackage/);
  await h.write(); data = fs.readFileSync(h.source); central = data.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  data.writeUInt32LE(100_000_000, central + 24); fs.writeFileSync(h.source, data);
  await assert.rejects(h.store.importPackage(h.source), /packageTooLarge/);
  fs.truncateSync(h.source, SKIN_PACKAGE_LIMITS.archiveBytes + 1);
  await assert.rejects(h.store.importPackage(h.source), /packageTooLarge/);
  await h.write(manifest(), (zip) => { for (let i = 0; i < 70; i++) zip.file(`x${i}.png`, png); });
  await assert.rejects(h.store.importPackage(h.source), /packageTooLarge/);
});
test("owner loss and failed publish do not install a partial package or change selection", async (t) => {
  const h = setup(t); await h.write(); h.store.setSkin("mist");
  await assert.rejects(h.store.importPackage(h.source, () => { throw new Error("owner lost"); }), /owner lost/);
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("disk unavailable"); });
  await assert.rejects(h.store.importPackage(h.source), /disk unavailable/);
  rename.mock.restore();
  assert.equal(h.store.read().skinId, "mist");
  assert.deepEqual(fs.readdirSync(path.join(h.options.assetsRoot, "skins")), []);
});
test("failed selection/deletion restores package and profile, interrupted deletion recovers", async (t) => {
  const h = setup(t); await h.write();
  const { importedSkinId: id } = await h.store.importPackage(h.source);
  const rename = fs.renameSync;
  const failProfile = t.mock.method(fs, "renameSync", (from, to) => { if (to.endsWith("profile.json")) throw new Error("profile failed"); return rename(from, to); });
  assert.throws(() => h.store.setSkin(id), /profile failed/);
  failProfile.mock.restore();
  h.store.setSkin(id);
  const failDelete = t.mock.method(fs, "renameSync", (from, to) => { if (to.endsWith("profile.json")) throw new Error("profile failed"); return rename(from, to); });
  assert.throws(() => h.store.removePackage(id), /profile failed/);
  failDelete.mock.restore();
  assert.equal(h.store.read().installedSkin.id, id);
  const root = path.join(h.options.assetsRoot, "skins"), dir = path.join(root, id.slice(5)), tombstone = path.join(root, ".remove-" + id.slice(5));
  fs.renameSync(dir, tombstone);
  assert.equal(createDesktopSkinStore(h.options).read().installedSkin.id, id);
  fs.renameSync(dir, tombstone); updateDesktopProfileInRoot(h.options.configRoot, { appearance: { skinId: "default" } });
  assert.equal(createDesktopSkinStore(h.options).read().installedSkins, undefined);
  assert(!fs.existsSync(tombstone));
});
test("missing or altered installed resources never resolve outside the owned package", async (t) => {
  const h = setup(t); await h.write();
  const { importedSkinId: id } = await h.store.importPackage(h.source); h.store.setSkin(id);
  const dir = path.join(h.options.assetsRoot, "skins", id.slice(5));
  fs.unlinkSync(path.join(dir, "image-0.png"));
  assert.deepEqual(h.store.read().installedSkin.backgrounds, {});
  fs.writeFileSync(path.join(dir, "skin.json"), JSON.stringify({ ...manifest(), variants: {
    ...manifest().variants, light: { tokens: {}, background: { path: "link/secret.png" } }
  } }));
  const missing = h.store.read();
  assert.equal(missing.skinId, id); assert.equal(missing.installedSkin, null);
  h.store.setSkin("default");
  assert.equal(h.store.read().skinId, "default");
});
