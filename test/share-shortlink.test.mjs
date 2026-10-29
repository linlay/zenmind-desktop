import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
const { readDesktopShareShortlink, isDesktopOpenDeepLink } = await import("../dist-electron/main/app/deep-link.js");
const { registerMainAppEvents } = await import("../dist-electron/main/app/app-events.js");
const { DESKTOP_OPEN_PROTOCOL_SCHEME: scheme } = await import("../dist-electron/shared/brand.js");
const link = id => scheme + "://share/" + id + "?action=desktop";
const tick = () => new Promise(resolve => setImmediate(resolve));

test("branded shortlinks accept only an opaque ID and desktop action", () => {
  assert.deepEqual(readDesktopShareShortlink(link("share_1-a")), { shareId: "share_1-a", action: "desktop" });
  for (const bad of [
    " " + link("one"), link("one") + " ", link("one") + "\n", link("one") + "\r\n", link("../path"), link("%61"), link("x".repeat(81)),
    link("one") + "#fragment", link("one") + "&action=desktop", link("one") + "&receiverId=arbitrary",
    link("one") + "&contextVersion=7", link("one") + "&url=https://attacker.test", link("one") + "&token=secret",
    link("one").replace("desktop", "download"), link("one").replace("://share/", "://user@share/"),
    link("one").replace("://share/", "://share:123/"), link("one").toUpperCase(), "https://share/one?action=desktop",
    scheme + "://share?batch=bb9e2948-a17a-4ca3-a4c1-8f21ba90b351", scheme + "://open",
  ]) assert.equal(readDesktopShareShortlink(bad), null, bad);
  assert.equal(isDesktopOpenDeepLink(scheme + "://open"), true);
  assert.equal(isDesktopOpenDeepLink(link("one")), false);
});

function fixture(platform, argv = ["desktop"], onReady = async () => {}) {
  const app = new EventEmitter(); app.whenReady = () => Promise.resolve();
  const opened = [], shown = [];
  registerMainAppEvents({ app, platform, gotSingleInstanceLock: true, state: {}, initialCommandLine: argv,
    installerShutdownArgs: new Set(["--shutdown-test"]), globalShortcut: { unregister() {} }, onReady,
    showMainWindow: route => shown.push(route), openLocalDocument() {}, openShareShortlink: id => { opened.push(id); return new Promise(() => {}); }, isNativeDialogOpen: () => false,
  });
  return { app, opened, shown };
}
const emitURL = (app, url) => { let prevented = false; app.emit("open-url", { preventDefault() { prevented = true; } }, url); return prevented; };

for (const platform of ["darwin", "win32"]) test(`${platform}: cold argv holds only the final pending share and never waits for the handoff at startup`, async () => {
  let finish; const f = fixture(platform, ["desktop", link("initial")], () => new Promise(resolve => { finish = resolve; }));
  await tick();
  if (platform === "darwin") { assert.equal(emitURL(f.app, link("second")), true); emitURL(f.app, link("last")); }
  else { f.app.emit("second-instance", {}, ["desktop", link("second")], "C:\\work"); f.app.emit("second-instance", {}, ["desktop", link("last")], "C:\\work"); }
  assert.deepEqual(f.opened, []); finish(); await tick(); await tick(); assert.deepEqual(f.opened, ["last"]);
  f.app.emit("activate"); assert.deepEqual(f.shown, [undefined]);
});

test("macOS open-url and second-instance use the same shortlink entry; Windows has no open-url handler", async () => {
  const mac = fixture("darwin"), win = fixture("win32"); await tick();
  assert.equal(emitURL(mac.app, link("url")), true); assert.equal(emitURL(win.app, link("ignored")), false);
  mac.app.emit("second-instance", {}, ["desktop", link("mac-instance")], "/tmp");
  win.app.emit("second-instance", {}, ["desktop", link("win-instance")], "C:\\work");
  await tick(); assert.deepEqual(mac.opened, ["url", "mac-instance"]); assert.deepEqual(win.opened, ["win-instance"]);
});

for (const platform of ["darwin", "win32"]) test(`${platform}: ordinary startup and fixed open do not invoke share resolution`, async () => {
  const normal = fixture(platform); await tick(); assert.deepEqual(normal.opened, []);
  const open = fixture(platform, ["desktop", scheme + "://open"]); await tick(); assert.deepEqual(open.opened, []); assert.deepEqual(open.shown, ["/"]);
});

test("other platforms and installer shutdown never consume cold shortlinks", async () => {
  const linux = fixture("linux", ["desktop", link("one")]);
  const shutdown = fixture("win32", ["desktop", "--shutdown-test", link("one")]);
  await tick(); assert.deepEqual(linux.opened, []); assert.deepEqual(shutdown.opened, []);
});

test("trusted public origin remains available with Tunnel disabled and enforces packaged HTTPS", async t => {
  const fs = await import("node:fs"); const path = await import("node:path"); const os = await import("node:os");
  const { APP_BRAND } = await import("../dist-electron/shared/brand.js");
  const { resolveShareOrigin } = await import("../dist-electron/main/modules/shares/target.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "share-read-origin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { isPackaged: false, getPath: name => name === "home" ? path.join(root, "home") : path.join(root, "app-data") };
  const config = path.join(app.getPath("home"), APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir, "config", "desktop", "tunnel-hub.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const configure = relayUrl => fs.writeFileSync(config, JSON.stringify({ enabled: false, relayUrl, deviceId: "share-read-test", tlsInsecureSkipVerify: false, reconnectSeconds: 3 }));
  configure("wss://trusted.example.test/tunnel");
  assert.deepEqual(resolveShareOrigin(app), { ok: true, origin: "https://trusted.example.test" });
  assert.equal(resolveShareOrigin(app, true).ok, false);
  configure("ws://127.0.0.1:18181/tunnel"); assert.equal(resolveShareOrigin(app).ok, true);
  app.isPackaged = true; assert.equal(resolveShareOrigin(app).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(config)).enabled, false);
});

for (const platform of ["darwin", "win32"]) test(`${platform}: initial shortlink reaches the receiver exactly once after ready`, async () => {
  const f = fixture(platform, ["desktop", link("cold-start")]);
  await tick(); await tick(); assert.deepEqual(f.opened, ["cold-start"]);
});
