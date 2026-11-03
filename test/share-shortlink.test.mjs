import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
const { dispatchDesktopBusinessLink } = await import("../dist-electron/main/app/business-link.js");
const { registerMainAppEvents } = await import("../dist-electron/main/app/app-events.js");
const { DESKTOP_OPEN_PROTOCOL_SCHEME: scheme } = await import("../dist-electron/shared/brand.js");
const link = id => scheme + "://share/open?url=https%3A%2F%2Fshare.example.test%2Fshare%2F" + id + "&v=1";
const tick = () => new Promise(resolve => setImmediate(resolve));

test("business links dispatch by exact route and reject malformed input", async () => {
  const seen = [];
  const routes = new Map([["test/open", params => seen.push([...params])]]);
  const valid = scheme + "://test/open?v=1&name=a%2Bb";
  await dispatchDesktopBusinessLink(valid, routes);
  assert.deepEqual(seen, [[["name", "a+b"]]]);
  for (const bad of [
    valid.replace(scheme, "wrong"), valid.replace("/open", "/install"), valid.replace("v=1", "v=2"),
    valid + "&%76=1", valid + "&name=b", valid + "#", valid + "\n", valid + "&invalid=%FF",
    valid.replace("://test", "://user@test"), valid.replace("://test", "://test:80"),
    valid.replace("/open", "/x/../open"), valid.replace("/open", "/%6fpen"), valid.replace("/open", "/open/"),
  ]) await assert.rejects(dispatchDesktopBusinessLink(bad, routes));
  assert.equal(seen.length, 1);
});

function fixture(platform, argv = ["desktop"], onReady = async () => {}) {
  const app = new EventEmitter(); app.whenReady = () => Promise.resolve();
  const opened = [], shown = [];
  registerMainAppEvents({ app, platform, gotSingleInstanceLock: true, state: {}, initialCommandLine: argv,
    installerShutdownArgs: new Set(["--shutdown-test"]), globalShortcut: { unregister() {} }, onReady,
    showMainWindow: route => shown.push(route), openLocalDocument() {}, openBusinessLink: url => { opened.push(url); return new Promise(() => {}); }, isNativeDialogOpen: () => false,
  });
  return { app, opened, shown };
}
const emitURL = (app, url) => { let prevented = false; app.emit("open-url", { preventDefault() { prevented = true; } }, url); return prevented; };

for (const platform of ["darwin", "win32"]) test(`${platform}: cold argv holds only the final pending share and never waits for the handoff at startup`, async () => {
  let finish; const f = fixture(platform, ["desktop", link("initial")], () => new Promise(resolve => { finish = resolve; }));
  await tick();
  if (platform === "darwin") { assert.equal(emitURL(f.app, link("second")), true); emitURL(f.app, link("last")); }
  else { f.app.emit("second-instance", {}, ["desktop", link("second")], "C:\\work"); f.app.emit("second-instance", {}, ["desktop", link("last")], "C:\\work"); }
  assert.deepEqual(f.opened, []); finish(); await tick(); await tick(); assert.deepEqual(f.opened, [link("last")]);
  f.app.emit("activate"); assert.deepEqual(f.shown, [undefined]);
});

test("macOS open-url and second-instance use the same shortlink entry; Windows has no open-url handler", async () => {
  const mac = fixture("darwin"), win = fixture("win32"); await tick();
  assert.equal(emitURL(mac.app, link("url")), true); assert.equal(emitURL(win.app, link("ignored")), false);
  mac.app.emit("second-instance", {}, ["desktop", link("mac-instance")], "/tmp");
  win.app.emit("second-instance", {}, ["desktop", link("win-instance")], "C:\\work");
  await tick(); assert.deepEqual(mac.opened, [link("url"), link("mac-instance")]); assert.deepEqual(win.opened, [link("win-instance")]);
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
  await tick(); await tick(); assert.deepEqual(f.opened, [link("cold-start")]);
});


test("share handoff uses the linked HTTPS origin for both anonymous reads and rejects revocation", async () => {
  const { createShareFacade } = await import("../dist-electron/main/modules/shares/facade.js");
  const requests = [];
  let delivered = 0;
  let revoked = false;
  const facade = createShareFacade({
    app: { getPath() { assert.fail("handoff must not read local Hub configuration"); } },
    readToken() { assert.fail("public handoff must not request credentials"); },
    async fetchImpl(url, init) {
      requests.push(url);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "manual");
      assert.deepEqual([...new Headers(init.headers)], []);
      if (revoked) return new Response(null, { status: 404 });
      return Response.json({ protocolVersion: 1, id: "one", kind: "test", title: "Example", actions: ["desktop"],
        desktop: { receiverId: "test.receiver", contextVersion: 1, context: {} } });
    },
  });
  let revokeOnReady = false;
  facade.registerReceiver({
    receiverId: "test.receiver", owner: { type: "builtin", id: "test" }, contextVersions: [1],
    async activate() {
      revoked = revokeOnReady;
      return { generation: "ready", isCurrent: () => true, async receive() { delivered++; return { status: "received" }; } };
    },
  });
  const address = "https://share.example.test/share/one";
  const params = new Map([["url", address]]);
  const expected = [address + "?action=resolve", address + "?action=resolve"];
  const routes = new Map([["share/open", async params => {
    assert.deepEqual(await facade.receivePublicLink(params), { status: "received" });
  }]]);
  await dispatchDesktopBusinessLink(link("one"), routes);
  assert.deepEqual(requests, expected);
  requests.length = 0;
  revokeOnReady = true;
  assert.deepEqual(await facade.receivePublicLink(params), { status: "unavailable" });
  assert.deepEqual(requests, expected);
  assert.equal(delivered, 1);
  for (const invalid of [new Map(), new Map([["url", " "]]), new Map([...params, ["token", "secret"]])]) {
    assert.throws(() => facade.receivePublicLink(invalid), /parameters/);
  }
  for (const bad of [address + "?", address + "#", address + "/", address.replace("/share/", "/other/"),
    address.replace("https:", "http:"), address.replace("://", "://user@"), address.replace("/one", "/%6Fne"),
    address.replace("share.example.test", "localhost")]) assert.throws(() => facade.receivePublicLink(new Map([["url", bad]])));
  facade.dispose();
});
