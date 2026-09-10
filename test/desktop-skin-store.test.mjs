import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDesktopSkinStore } = require("../dist-electron/main/modules/settings/appearance-store.js");
const { inspectBackgroundImage, MAX_BACKGROUND_INPUT_BYTES } = require("../dist-electron/main/modules/settings/appearance-images.js");
const { readDesktopProfileFromRoot, updateDesktopProfileInRoot } = require("../dist-electron/main/infrastructure/filesystem/profile-store.js");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=", "base64");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-skin-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config"), assetsRoot = path.join(root, "assets");
  const options = { configRoot, assetsRoot, normalizeImage: () => ({ data: png, width: 1, height: 1 }) };
  const store = createDesktopSkinStore(options);
  const source = path.join(root, "my-wallpaper.png");
  fs.writeFileSync(source, png);
  return { root, configRoot, assetsRoot, source, options, store };
}

test("legacy and malformed profile skin fields normalize without rewriting or losing preferences", (t) => {
  const h = setup(t);
  fs.mkdirSync(h.configRoot);
  const file = path.join(h.configRoot, "profile.json");
  const raw = JSON.stringify({ appearance: { theme: "dark", locale: "en-US", skinId: "../../remote.css", background: { id: "../../secret", name: "x", width: 1, height: 1 } } });
  fs.writeFileSync(file, raw);
  assert.deepEqual(h.store.read(), { skinId: "default", background: null, backgroundDataUrl: null, packageApiVersion: 1 });
  assert.equal(fs.readFileSync(file, "utf8"), raw);
  h.store.setSkin("mist");
  const profile = readDesktopProfileFromRoot(h.configRoot);
  assert.equal(profile.appearance.theme, "dark");
  assert.equal(profile.appearance.locale, "en-US");
  assert.throws(() => h.store.setSkin("unknown"), /Unknown/);
  assert.equal(h.store.read().skinId, "mist");
  for (const skinId of ["ocean", "violet"]) {
    h.store.setSkin(skinId);
    assert.equal(createDesktopSkinStore(h.options).read().skinId, skinId);
    assert.equal(readDesktopProfileFromRoot(h.configRoot).appearance.theme, "dark");
  }
});

test("imported background survives source removal and restart; other profile saves retain skin fields", (t) => {
  const h = setup(t);
  h.store.setSkin("mist");
  const saved = h.store.importFile(h.source);
  assert.match(saved.background.id, /^[a-f0-9]{32}$/);
  assert.equal(saved.background.name, "my-wallpaper.png");
  assert.equal(saved.backgroundDataUrl, `data:image/png;base64,${png.toString("base64")}`);
  fs.unlinkSync(h.source);
  updateDesktopProfileInRoot(h.configRoot, { appearance: { theme: "system", locale: "zh-CN" }, general: { deviceName: "My computer" } });
  const restarted = createDesktopSkinStore(h.options).read();
  assert.deepEqual(restarted, saved);
  const serialized = fs.readFileSync(path.join(h.configRoot, "profile.json"), "utf8");
  assert(!serialized.includes("base64"));
  assert(!serialized.includes(h.root));
});

test("replacement and reset clean only the formerly selected owned asset", (t) => {
  const h = setup(t);
  const first = h.store.importFile(h.source);
  h.store.setSkin("mist");
  const second = h.store.importFile(h.source);
  assert.notEqual(first.background.id, second.background.id);
  assert.deepEqual(fs.readdirSync(h.assetsRoot), [`${second.background.id}.png`]);
  assert(fs.existsSync(h.source));
  assert.equal(h.store.resetBackground().skinId, "mist");
  assert.deepEqual(fs.readdirSync(h.assetsRoot), []);
  assert.equal(h.store.read().background, null);
});

test("invalid files, oversized files and symlinks cannot replace a saved image", (t) => {
  const h = setup(t);
  const saved = h.store.importFile(h.source);
  const invalid = path.join(h.root, "not-an-image.png");
  fs.writeFileSync(invalid, '<svg onload="alert(1)"></svg>');
  assert.throws(() => h.store.importFile(invalid), /invalidImage/);
  const big = path.join(h.root, "big.jpg");
  fs.closeSync(fs.openSync(big, "w")); fs.truncateSync(big, MAX_BACKGROUND_INPUT_BYTES + 1);
  assert.throws(() => h.store.importFile(big), /imageTooLarge/);
  const link = path.join(h.root, "link.png"); fs.symlinkSync(h.source, link);
  assert.throws(() => h.store.importFile(link), /invalidImage/);
  assert.deepEqual(h.store.read(), saved);
  assert.equal(fs.readdirSync(h.assetsRoot).length, 1);
});

test("missing, corrupt and symlinked owned assets fall back without discarding the saved reference", (t) => {
  const h = setup(t), saved = h.store.importFile(h.source);
  const file = path.join(h.assetsRoot, `${saved.background.id}.png`);
  fs.writeFileSync(file, "corrupt");
  assert.equal(h.store.read().backgroundDataUrl, null);
  fs.unlinkSync(file);
  assert.deepEqual(h.store.read().background, saved.background);
  fs.symlinkSync(h.source, file);
  assert.equal(h.store.read().backgroundDataUrl, null);
});

test("failed atomic profile replace preserves confirmed profile and removes the new asset", (t) => {
  const h = setup(t), saved = h.store.importFile(h.source);
  const before = fs.readFileSync(path.join(h.configRoot, "profile.json"), "utf8");
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("disk unavailable"); });
  assert.throws(() => h.store.importFile(h.source), /disk unavailable/);
  assert.throws(() => h.store.setSkin("mist"), /disk unavailable/);
  assert.throws(() => h.store.resetBackground(), /disk unavailable/);
  rename.mock.restore();
  assert.equal(fs.readFileSync(path.join(h.configRoot, "profile.json"), "utf8"), before);
  assert.deepEqual(h.store.read(), saved);
  assert.deepEqual(fs.readdirSync(h.assetsRoot), [`${saved.background.id}.png`]);
  assert.deepEqual(fs.readdirSync(h.configRoot), ["profile.json"]);
});

test("PNG/JPEG dimensions are bounded before decode, including malformed segment lengths", () => {
  assert.deepEqual(inspectBackgroundImage(png), { width: 1, height: 1 });
  const huge = Buffer.from(png); huge.writeUInt32BE(32000, 16);
  assert.throws(() => inspectBackgroundImage(huge), /imageTooLarge/);
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xe1,0,4,0,0,0xff,0xc2,0,8,8,0,40,0,80,1,0xff,0xd9]);
  assert.deepEqual(inspectBackgroundImage(jpeg), { width: 80, height: 40 });
  jpeg[4] = 0xff;
  assert.throws(() => inspectBackgroundImage(jpeg), /invalidImage/);
  for (const data of [Buffer.alloc(0), Buffer.from("GIF89a"), Buffer.from([0xff,0xd8,0xff,0xff])]) {
    assert.throws(() => inspectBackgroundImage(data), /invalidImage/);
  }
});

test("appearance IPC restricts sender/frame, handles cancellation and uses explicit platform pickers", async (t) => {
  const h = setup(t);
  let selections = 0, canceled = true, selectedPath = h.source, pendingSelection = null;
  const electronPath = require.resolve("electron");
  const previous = require.cache[electronPath];
  const owner = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false } };
  const mockImage = { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
    dialog: { showOpenDialog: async (window, options) => { assert.equal(window, owner); assert.deepEqual(options.properties, ["openFile"]); selections++; if (pendingSelection) await pendingSelection; return { canceled, filePaths: [selectedPath] }; } },
    nativeImage: { createFromBuffer: () => mockImage }
  } };
  t.after(() => { if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath]; });
  const { registerAppearanceIpcHandlers, getBackgroundDialogOptions } = require("../dist-electron/main/modules/settings/appearance-ipc.js");
  assert.deepEqual(getBackgroundDialogOptions("win32").properties, ["openFile", "dontAddToRecent"]);
  assert.deepEqual(getBackgroundDialogOptions("darwin").properties, ["openFile"]);
  const handlers = new Map();
  const app = { getPath: (key) => key === "home" ? h.root : path.join(h.root, "app-data") };
  registerAppearanceIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, { app, platform: "darwin", getMainWindow: () => owner });
  const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
  for (const handler of handlers.values()) {
    assert.throws(() => handler({ sender: {}, senderFrame: event.senderFrame }), /main window/);
    assert.throws(() => handler({ ...event, senderFrame: {} }), /main window/);
  }
  const invoke = (name, ...args) => handlers.get(`settings.${name}`)(event, ...args);
  assert.equal((await invoke("getDesktopSkin")).settings.skinId, "default");
  assert.equal((await invoke("importDesktopBackground")).cancelled, true);
  assert.equal(selections, 1);
  canceled = false;
  const imported = await invoke("importDesktopBackground");
  assert.equal(imported.ok, true);
  await invoke("setDesktopSkin", "mist");
  assert.deepEqual((await invoke("getDesktopSkin")).settings.background, imported.settings.background);
  selectedPath = path.join(h.root, "bad.png"); fs.writeFileSync(selectedPath, "invalid");
  assert.deepEqual(await invoke("importDesktopBackground"), { ok: false, error: "invalidImage" });
  assert.equal((await invoke("resetDesktopBackground")).settings.background, null);
  // An owner frame replaced while the native dialog is open cannot commit the
  // selected file; the next valid caller must still be able to use the queue.
  let closePicker;
  pendingSelection = new Promise((resolve) => { closePicker = resolve; });
  selectedPath = h.source;
  const pendingImport = invoke("importDesktopBackground");
  await new Promise(setImmediate);
  owner.webContents.mainFrame = {};
  closePicker();
  assert.deepEqual(await pendingImport, { ok: false, error: "storageFailed" });
  event.senderFrame = owner.webContents.mainFrame;
  assert.equal((await invoke("getDesktopSkin")).settings.background, null);
});
