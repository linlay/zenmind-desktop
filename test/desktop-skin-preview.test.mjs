import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import JSZip from "jszip";
import { createCanvas } from "@napi-rs/canvas";

const require = createRequire(import.meta.url);
const { createDesktopSkinStore } = require("../dist-electron/main/modules/settings/appearance-store.js");
const { createAppearanceRuntime } = require("../dist-electron/main/modules/settings/appearance-runtime.js");
const { inspectBackgroundImage, MAX_BACKGROUND_STORED_BYTES } = require("../dist-electron/main/modules/settings/appearance-images.js");
const { updateDesktopProfileInRoot, readDesktopProfileFromRoot } = require("../dist-electron/main/infrastructure/filesystem/profile-store.js");

function png(color) {
  const canvas = createCanvas(12, 8), context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(0, 0, 12, 8);
  return canvas.toBuffer("image/png");
}
const light = png("#b3461d"), dark = png("#192a67");

async function setup(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-skin-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config"), assetsRoot = path.join(root, "assets");
  let decodes = 0;
  const options = { configRoot, assetsRoot,
    normalizeImage: data => ({ data, ...inspectBackgroundImage(data) }),
    makePreview: data => { decodes++; return extra.makePreview ? extra.makePreview(data) : data; } };
  const store = createDesktopSkinStore(options);
  updateDesktopProfileInRoot(configRoot, { appearance: { theme: "dark", skinId: "mist" }, general: { deviceName: "Preview test" } });
  const manifest = { schemaVersion: "1.1", id: "local.preview", name: "Local preview", version: "1.0.0",
    variants: {
      light: { tokens: { "--accent": "#112233" }, background: { path: "light.png", position: "right top" },
        visuals: { images: { "chat.send": "light.png" }, styles: { unread: "#c33170" } } },
      dark: { tokens: { "--accent": "#445566" }, background: { path: "dark.png", position: "left bottom" } }
    } };
  const zip = new JSZip(); zip.file("skin.json", JSON.stringify(manifest)); zip.file("light.png", light); zip.file("dark.png", dark);
  const source = path.join(root, "preview.skin.zip"); fs.writeFileSync(source, await zip.generateAsync({ type: "nodebuffer" }));
  const { importedSkinId: id } = await store.importPackage(source);
  const directory = path.join(assetsRoot, "skins", id.slice(5)), manifestPath = path.join(directory, "skin.json");
  const stored = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const profile = fs.readFileSync(path.join(configRoot, "profile.json"));
  return { root, configRoot, assetsRoot, store, options, id, directory, manifestPath, stored, profile,
    imagePath: mode => path.join(directory, stored.variants[mode].background.path), get decodes() { return decodes; } };
}

test("unselected package previews return each mode's own bounded background and tokens without changing profile", async t => {
  const h = await setup(t), before = h.decodes;
  const a = h.store.readPackagePreview(h.id, "light"), b = h.store.readPackagePreview(h.id, "dark");
  assert.equal(a.tokens["--accent"], "#112233"); assert.equal(b.tokens["--accent"], "#445566");
  assert.equal(a.tokens["--accent-rgb"], "17, 34, 51");
  assert.equal(a.background.imageUrl, `data:image/png;base64,${light.toString("base64")}`);
  assert.equal(b.background.imageUrl, `data:image/png;base64,${dark.toString("base64")}`);
  assert.equal(a.background.position, "right top"); assert.equal(b.background.position, "left bottom");
  assert.deepEqual(Object.keys(a).sort(), ["background", "tokens"]);
  assert.equal(a.visuals, undefined); assert.equal(JSON.stringify(a).includes(h.root), false);
  assert.equal(JSON.stringify(a).includes("image-0.png"), false);
  assert.equal(h.decodes - before, 2);
  for (let count = 0; count < 10; count++) {
    assert.deepEqual(h.store.readPackagePreview(h.id, "light"), a);
    assert.deepEqual(h.store.readPackagePreview(h.id, "dark"), b);
  }
  assert.equal(h.decodes - before, 2, "repeated card previews reuse decoded thumbnails");
  a.tokens["--accent"] = "#ffffff";
  assert.equal(h.store.readPackagePreview(h.id, "light").tokens["--accent"], "#112233");
  assert.deepEqual(fs.readFileSync(path.join(h.configRoot, "profile.json")), h.profile);
  assert.equal(readDesktopProfileFromRoot(h.configRoot).appearance.theme, "dark");
  assert.equal(h.store.read().skinId, "mist");
});

test("preview cache observes changed or missing assets and drops corrupt images without losing tokens", async t => {
  const h = await setup(t);
  assert.ok(h.store.readPackagePreview(h.id, "light").background);
  const image = h.imagePath("light"), decodes = h.decodes;
  fs.writeFileSync(image, dark);
  const future = new Date(Date.now() + 2000); fs.utimesSync(image, future, future);
  assert.equal(h.store.readPackagePreview(h.id, "light").background.imageUrl, `data:image/png;base64,${dark.toString("base64")}`);
  assert.equal(h.decodes, decodes + 1);
  fs.writeFileSync(image, "corrupt image");
  const corrupt = h.store.readPackagePreview(h.id, "light");
  assert.equal(corrupt.background, null); assert.equal(corrupt.tokens["--accent"], "#112233");
  fs.unlinkSync(image); assert.equal(h.store.readPackagePreview(h.id, "light").background, null);
  const outside = path.join(h.root, "outside.png"); fs.writeFileSync(outside, light); fs.symlinkSync(outside, image);
  assert.equal(h.store.readPackagePreview(h.id, "light").background, null);
});

test("preview bounds input and output sizes and safely handles decoder failures", async t => {
  const large = await setup(t);
  fs.truncateSync(large.imagePath("light"), MAX_BACKGROUND_STORED_BYTES + 1);
  const before = large.decodes;
  assert.equal(large.store.readPackagePreview(large.id, "light").background, null);
  assert.equal(large.decodes, before, "oversized source must be rejected before decoding");
  for (const makePreview of [() => Buffer.alloc(128 * 1024 + 1), () => { throw new Error("decode failed"); }]) {
    // Installation also creates a general thumbnail, so only activate the
    // failing decoder after the valid immutable package has been installed.
    let failing = false;
    const h = await setup(t, { makePreview: bytes => failing ? makePreview(bytes) : bytes }); failing = true;
    assert.equal(h.store.readPackagePreview(h.id, "dark").background, null);
  }
});

test("invalid IDs, modes, manifests and missing packages never escape or repair package state", async t => {
  const h = await setup(t);
  for (const id of [null, undefined, "default", "local.preview", "pack:../../secret", `pack:${"F".repeat(32)}`, `pack:${"f".repeat(32)}`])
    assert.equal(h.store.readPackagePreview(id, "light"), null);
  for (const mode of [undefined, null, "system", "Light", {}, []]) assert.equal(h.store.readPackagePreview(h.id, mode), null);
  const noBackground = structuredClone(h.stored); delete noBackground.variants.dark.background;
  fs.writeFileSync(h.manifestPath, JSON.stringify(noBackground));
  assert.deepEqual(h.store.readPackagePreview(h.id, "dark"), { tokens: { "--accent": "#445566", "--accent-rgb": "68, 85, 102" }, background: null });
  for (const file of ["../outside.png", "nested/image.png", "/tmp/outside.png"]) {
    const altered = structuredClone(h.stored); altered.variants.light.background.path = file;
    fs.writeFileSync(h.manifestPath, JSON.stringify(altered)); assert.equal(h.store.readPackagePreview(h.id, "light"), null);
  }
  fs.writeFileSync(h.manifestPath, "{broken"); assert.equal(h.store.readPackagePreview(h.id, "light"), null);
  const tombstone = path.join(h.assetsRoot, "skins", `.remove-${h.id.slice(5)}`);
  fs.renameSync(h.directory, tombstone);
  assert.equal(h.store.readPackagePreview(h.id, "light"), null);
  assert.ok(fs.existsSync(tombstone), "a read-only preview must not recover or clean removal transactions");
  assert.deepEqual(fs.readFileSync(path.join(h.configRoot, "profile.json")), h.profile);
});

test("preview IPC uses the owner/frame fence and shared queue without publishing configuration changes", async t => {
  const h = await setup(t), electronPath = require.resolve("electron"), previous = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { dialog: {}, nativeImage: {} } };
  t.after(() => { if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath]; });
  const { registerAppearanceIpcHandlers } = require("../dist-electron/main/modules/settings/appearance-ipc.js");
  const owner = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {} } };
  let changes = 0;
  const runtime = createAppearanceRuntime(() => h.store, () => { changes++; });
  const handlers = new Map();
  registerAppearanceIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) },
    { app: {}, platform: "darwin", getMainWindow: () => owner, runtime });
  const invoke = handlers.get("settings.getDesktopSkinPreview");
  const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
  assert.throws(() => invoke({ ...event, sender: {} }, h.id, "light"), /main window/);
  assert.throws(() => invoke({ ...event, senderFrame: {} }, h.id, "light"), /main window/);
  assert.equal((await invoke(event, h.id, "dark")).tokens["--accent"], "#445566");
  assert.equal(await invoke(event, h.id, "system"), null);
  let release;
  const barrier = runtime.run(() => new Promise(resolve => { release = resolve; }));
  await new Promise(setImmediate);
  const pending = invoke(event, h.id, "light");
  owner.webContents.mainFrame = {};
  release(); await barrier;
  await assert.rejects(pending, /main window/);
  event.senderFrame = owner.webContents.mainFrame;
  assert.ok(await invoke(event, h.id, "light"));
  assert.equal(changes, 0, "previews must not emit desktop config changes");
  assert.deepEqual(fs.readFileSync(path.join(h.configRoot, "profile.json")), h.profile);
});
