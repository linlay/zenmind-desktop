import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
const { registerMainAppEvents } = await import("../dist-electron/main/app/app-events.js");
const { readDesktopShareDeepLink, readDesktopShareOpenRequest } = await import("../dist-electron/main/app/deep-link.js");
const { NATIVE_SHARE_PROTOCOL_SCHEME: scheme, NATIVE_SHARE_PROTOCOL_HOST: host } = await import("../dist-electron/shared/native-share.js");
const { isNativeShareTargetRoute, registerNativeShareIpc } = await import("../dist-electron/main/app/assembly/native-share.js");
const batchId = "bb9e2948-a17a-4ca3-a4c1-8f21ba90b351";
const link = `${scheme}://${host}?batch=${batchId}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(platform, gate = Promise.resolve()) {
  const app = new EventEmitter(); app.whenReady = () => gate;
  const opened = [], shown = [];
  registerMainAppEvents({ app, platform, gotSingleInstanceLock: true, state: {}, initialCommandLine: ["desktop"],
    installerShutdownArgs: new Set(), globalShortcut: { unregister() {} }, onReady() {},
    showMainWindow(route) { shown.push(route); }, openNativeShare(id) { opened.push(id); },
    isNativeDialogOpen: () => false,
  });
  return { app, opened, shown };
}
function emit(app, url) {
  let prevented = false;
  app.emit("open-url", { preventDefault() { prevented = true; } }, url);
  return prevented;
}
test("share deep links carry only a canonical opaque batch; paths and extra authority are rejected", () => {
  assert.equal(readDesktopShareDeepLink(link), batchId);
  for (const invalid of [` ${link}`, `${link}&file=/private/file`, `${link}#fragment`, link.replace(batchId, "../../private"),
    link.replace(batchId, batchId.toUpperCase()), link.replace(`//${host}`, `//user@${host}`), "file:///private/chat.zip",
    `cutej://share?batch=${batchId}`, `zenmind://share?batch=${batchId}`]) {
    assert.equal(readDesktopShareDeepLink(invalid), null, invalid);
  }
});
test("loopback transfer capabilities accept a fixed port and ticket without arbitrary network targets", () => {
  const ticket = "A".repeat(43);
  const transferLink = `${link}&port=32123&ticket=${ticket}`;
  assert.deepEqual(readDesktopShareOpenRequest(transferLink), { batchId, transfer: { batchId, port: 32123, ticket } });
  for (const invalid of [
    `${link}&port=0&ticket=${ticket}`, `${link}&port=65536&ticket=${ticket}`,
    `${transferLink}&host=external.test`, `${link}&port=32123&ticket=${ticket}=`,
    `${link}&ticket=${ticket}&port=32123`, `${link}&port=32123&ticket=short`,
  ]) assert.equal(readDesktopShareOpenRequest(invalid), null, invalid);
});
test("a cold macOS share queues and deduplicates until Desktop initialization has finished", async () => {
  let ready; const f = fixture("darwin", new Promise(resolve => { ready = resolve; }));
  assert.equal(emit(f.app, link), true); emit(f.app, link);
  assert.deepEqual(f.opened, []); ready(); await tick(); await tick();
  assert.deepEqual(f.opened, [batchId]); assert.deepEqual(f.shown, []);
});
test("a warm macOS share opens its draft and Windows never consumes this platform entry", async () => {
  const mac = fixture("darwin"); const win = fixture("win32"); await tick();
  assert.equal(emit(mac.app, link), true); assert.equal(emit(win.app, link), false); await tick();
  assert.deepEqual(mac.opened, [batchId]); assert.deepEqual(win.opened, []);
});
test("only the exact share draft route owns the file batch, on both Desktop hash and guest routes", () => {
  const target = { batchId, newChat: "1791788400000", agentKey: "cutej" };
  const route = `/agent/cutej?newChat=${target.newChat}&shareBatch=${batchId}`;
  assert.equal(isNativeShareTargetRoute(`http://localhost:5173/#${route}`, target), true);
  assert.equal(isNativeShareTargetRoute(`http://localhost:17080${route}&theme=light`, target), true);
  for (const invalid of [route.replace("cutej", "other"), `${route}&shareBatch=${batchId}`, `${route}&chatId=old`, route.replace(target.newChat, "1791788400001")])
    assert.equal(isNativeShareTargetRoute(invalid, target), false);
});
test("native share IPC rejects guests, child frames, destroyed owners and other platforms before file access", async () => {
  const frame = {}, main = { mainFrame: frame, isDestroyed: () => false }; const window = { webContents: main, isDestroyed: () => false };
  let handler, calls = 0;
  const ports = { platform: "darwin", ipcMain: { handle(_channel, callback) { handler = callback; } }, getMainWindow: () => window,
    async read() { calls++; return { ok: true, completed: true }; } };
  registerNativeShareIpc(ports);
  assert.equal((await handler({ sender: {}, senderFrame: frame }, {})).ok, false);
  assert.equal((await handler({ sender: main, senderFrame: {} }, {})).ok, false);
  assert.equal(calls, 0);
  assert.equal((await handler({ sender: main, senderFrame: frame }, {})).ok, true);
  assert.equal(calls, 1);
  ports.platform = "win32";
  assert.equal((await handler({ sender: main, senderFrame: frame }, {})).ok, false);
  assert.equal(calls, 1);
});
