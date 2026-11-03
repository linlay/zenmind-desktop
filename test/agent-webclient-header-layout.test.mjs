import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: { contents: `export * from './src/shared/contracts/agent-webclient-bridge';
    export * from './src/renderer/service-webview/headerLayoutHost';
    export * from './src/shared/auth-bridge';
    export * from './src/shared/agent-webclient-routes';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "esm"
});
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const { AGENT_WEBCLIENT_HEADER_LAYOUT_REQUEST_CHANNEL: requestChannel,
  AGENT_WEBCLIENT_HEADER_LAYOUT_SNAPSHOT_CHANNEL: snapshotChannel,
  AGENT_WEBCLIENT_HEADER_LAYOUT_GLOBAL: globalName,
  createWebclientHeaderLayoutHost, parseAgentWebclientHeaderLayoutSnapshot: parse,
  readAgentWebclientHeaderLayoutBootstrap: bootstrap } = api;
const snapshot = (revision, collapsed = true, inset = collapsed ? 128 : 0) =>
  ({ schemaVersion: "1.0", revision, sidebarCollapsed: collapsed, headerLeftInset: inset });
const documentId = "12345678-1234-1234-1234-123456789abc";

test("header layout is bounded presentation data and cannot change business navigation identity", () => {
  assert.deepEqual(parse(snapshot(1)), snapshot(1));
  for (const change of [{ revision: -1 }, { revision: 0.5 }, { headerLeftInset: 257 }, { headerLeftInset: -1 },
    { headerLeftInset: "128" }, { sidebarCollapsed: false }, { schemaVersion: "2.0" }, { route: "/agent/other" }]) {
    assert.equal(parse({ ...snapshot(1), ...change }), null);
  }
  assert.deepEqual(bootstrap("?desktopSidebarCollapsed=1&desktopHeaderLeftInset=128"), { sidebarCollapsed: true, headerLeftInset: 128 });
  for (const query of ["", "desktopSidebarCollapsed=true&desktopHeaderLeftInset=128",
    "desktopSidebarCollapsed=0&desktopHeaderLeftInset=128", "desktopSidebarCollapsed=1&desktopHeaderLeftInset=999",
    "desktopSidebarCollapsed=1&desktopSidebarCollapsed=0&desktopHeaderLeftInset=128"]) assert.equal(bootstrap(query), null);
  const plain = "http://127.0.0.1:1234/agent/a?chatId=c";
  const embedded = api.buildServiceWebviewUrl("agent-webclient", plain, { embedPath: "/agent/a?chatId=c",
    headerLayout: { sidebarCollapsed: true, headerLeftInset: 128 } });
  assert.equal(new URL(embedded).searchParams.get("desktopHeaderLeftInset"), "128");
  assert.equal(api.areAgentWebclientChatNavigationUrlsEquivalent(plain, embedded), true);
  assert.equal(new URL(api.buildServiceWebviewUrl("agent-webclient", plain, { embedPath: "/skills",
    headerLayout: { sidebarCollapsed: true, headerLeftInset: 128 } })).searchParams.has("desktopHeaderLeftInset"), false);
});

class Guest extends EventTarget {
  url = "http://127.0.0.1:1234/agent/a?chatId=c";
  sent = [];
  getURL() { return this.url; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  request(origin = "http://127.0.0.1:1234", id = documentId) {
    this.dispatchEvent(Object.assign(new Event("ipc-message"), {
      channel: requestChannel, args: [{ version: "1.0", documentId: id, origin }]
    }));
  }
}

test("host only updates its current trusted document and retains revisions across relay recreation", () => {
  const guest = new Guest();
  const trustedUrl = guest.url;
  let current = true;
  let layout = { sidebarCollapsed: true, headerLeftInset: 128 };
  const options = { webview: guest, trustedUrl: () => trustedUrl, isCurrentGuest: () => current,
    read: () => layout, revisionState: { revision: 0, signature: "" } };
  const host = createWebclientHeaderLayoutHost(options);
  assert.equal(guest.sent.at(-1).channel, requestChannel);
  guest.sent = [];
  guest.request("https://untrusted.test");
  guest.request(undefined, "forged-document");
  assert.equal(guest.sent.length, 0);
  guest.request();
  assert.deepEqual(guest.sent.at(-1), { channel: snapshotChannel, payload: { documentId, snapshot: snapshot(1) } });
  layout = { sidebarCollapsed: false, headerLeftInset: 0 };
  host.refresh();
  assert.deepEqual(guest.sent.at(-1).payload.snapshot, snapshot(2, false));
  current = false;
  const sent = guest.sent.length;
  host.refresh();
  assert.equal(guest.sent.length, sent);
  current = true;
  guest.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: true, isInPlace: false }));
  host.refresh();
  assert.equal(guest.sent.at(-1).channel, requestChannel, "new documents must handshake");
  host.dispose();
  const nextHost = createWebclientHeaderLayoutHost(options);
  guest.request();
  assert.equal(guest.sent.at(-1).payload.snapshot.revision, 2);
  nextHost.dispose();
  guest.url = "https://untrusted.test/agent/a";
  const count = guest.sent.length;
  const foreignHost = createWebclientHeaderLayoutHost(options);
  guest.request("https://untrusted.test");
  assert.equal(guest.sent.length, count, "navigation away from the trusted origin revokes layout delivery");
  foreignHost.dispose();
});

test("preload exposes only a read-only, document-scoped layout subscription and rejects stale delivery", async () => {
  const { outputFiles } = await build({ entryPoints: ["src/preload/service-webview-header-layout.ts"],
    bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"] });
  const handlers = new Map();
  const page = new EventTarget();
  page.location = { search: "?desktopSidebarCollapsed=1&desktopHeaderLeftInset=128", origin: "http://127.0.0.1:1234" };
  let exposed;
  let requests = 0;
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, process: { isMainFrame: true }, window: page,
    URLSearchParams, crypto: { randomUUID: () => documentId }, require(name) {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, globalName); exposed = value; } },
        ipcRenderer: { on(channel, listener) { handlers.set(channel, listener); },
          sendToHost(channel, envelope) { assert.equal(channel, requestChannel); assert.equal(envelope.documentId, documentId); requests++; } } };
    } });
  module.exports.installServiceWebviewHeaderLayout();
  handlers.get(requestChannel)();
  assert.equal(requests, 0, "unused bridges do not negotiate");
  assert.equal(Object.isFrozen(exposed), true);
  assert.equal(exposed.getSnapshot().headerLeftInset, 128);
  const received = [];
  exposed.subscribe(() => { throw new Error("consumer failure"); });
  const unsubscribe = exposed.subscribe(value => received.push(value));
  const deliver = (value, id = documentId) => handlers.get(snapshotChannel)(null, { documentId: id, snapshot: value });
  deliver(snapshot(5));
  deliver(snapshot(6, false), "previous-document");
  deliver(snapshot(4, false));
  deliver(snapshot(5, false));
  deliver({ ...snapshot(6), headerLeftInset: 999 });
  assert.equal(received.length, 1);
  deliver(snapshot(6, false));
  assert.equal(received.at(-1).headerLeftInset, 0);
  deliver(null);
  assert.equal(received.at(-1), null);
  unsubscribe();
  page.dispatchEvent(new Event("pagehide"));
  deliver(snapshot(7));
  assert.equal(received.length, 3);
});
