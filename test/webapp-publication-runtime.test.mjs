import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { __testInternals: { stableWebappName } } = require("../dist-electron/main/modules/webs/webapps/publisher.js");

const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const { getDesktopWebappStateRoot } = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");
const { restorePublishedWebapps } = require("../dist-electron/main/modules/webs/webapps/publication-runtime.js");
const { publishWebapp, syncPublishedWebappRoute } = require("../dist-electron/main/modules/webs/webapps/publisher.js");

test("published WebApp names preserve canonical IDs and distinguish legacy identities", () => {
  const canonicalId = "webapp-0123456789abcdef";
  assert.equal(stableWebappName(canonicalId), canonicalId);
  const ids = ["legacy-notes", "Legacy Notes", "legacy_notes", "便签工具", "Legacy Notes # %2F"];
  const names = ids.map(stableWebappName);
  assert.equal(new Set(names).size, ids.length);
  for (const [index, name] of names.entries()) {
    assert.equal(stableWebappName(ids[index]), name);
    assert.ok(name.length <= 63);
    assert.match(name, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
  }
});

function publicationFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-publication-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const app = { getPath: name => name === "home" ? home : path.join(home, name), getAppPath: () => process.cwd() };
  let connected = true;
  let starts = 0;
  const requests = [];
  const ports = {
    readInstalledRecords: () => [],
    readTunnelHubSettings: () => ({ enabled: true, relayUrl: "wss://relay.example.test/tunnel", deviceId: "test-desktop" }),
    readTunnelHubRegistrationBearerToken: () => "synthetic-token",
    deriveTunnelHubRegistrationApiOrigin: () => "https://relay.example.test",
    getTunnelHubRuntimeStatus: () => ({ connected }),
    startTunnelHubRuntime: async () => { starts++; connected = true; return { ok: true, status: { connected } }; }
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, text: async () => JSON.stringify({ routeId: "same-route", publicHost: "same-wa.example.test", active: true }) };
  });
  const items = [1, 2].map(index => {
    const id = `webapp-${String(index).padStart(16, "0")}`;
    const item = { schemaVersion: 2, id, key: `demo-${index}`, label: `Demo ${index}`, version: "1.0.0", target: "any", frontend: { root: "frontend", index: "index.html" } };
    const dir = path.join(home, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir, "data", "webs", "webapps", id);
    fs.mkdirSync(path.join(dir, "frontend"), { recursive: true });
    fs.writeFileSync(path.join(dir, "frontend", "index.html"), "<!doctype html><title>Demo</title>");
    fs.writeFileSync(path.join(dir, "webapp.json"), JSON.stringify(item));
    const stateRoot = getDesktopWebappStateRoot(app, id);
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "publish.json"), JSON.stringify({ id, provider: "tunnel", status: "published", active: true, publicHost: "same-wa.example.test", url: "https://same-wa.example.test", routeId: "same-route" }));
    return item;
  });
  return { app, ports, items, requests, starts: () => starts, disconnect: () => { connected = false; } };
}

test("publication recovery uses the live connection; only explicit publishing can connect", async t => {
  const f = publicationFixture(t), item = f.items[0], queried = [], started = [];
  const runtime = {
    getStatus: (_app, id) => { queried.push(id); return { id, status: id === item.id ? "running" : "stopped", webUrl: "http://127.0.0.1:51001/" }; },
    start: async (_app, id) => { started.push(id); }
  };
  const file = path.join(getDesktopWebappStateRoot(f.app, item.id), "publish.json");
  const before = fs.readFileSync(file, "utf8");
  f.disconnect();
  assert.equal(await syncPublishedWebappRoute(f.app, item, runtime.getStatus(f.app, item.id), f.ports), null);
  queried.length = 0;
  await restorePublishedWebapps(f.app, f.ports, runtime);
  assert.deepEqual(queried, []);
  assert.equal(f.requests.length, 0);
  assert.equal(f.starts(), 0);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const published = await publishWebapp(f.app, item.id, runtime.getStatus(f.app, item.id), f.ports);
  assert.equal(published.ok, true);
  assert.equal(published.state.routeId, "same-route");
  assert.equal(f.starts(), 1);
  f.requests.length = 0;
  await restorePublishedWebapps(f.app, f.ports, runtime);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(started, [f.items[1].id]);
  queried.length = started.length = 0;
  t.mock.method(globalThis, "fetch", async () => {
    f.disconnect();
    return { ok: true, text: async () => JSON.stringify({ routeId: "same-route", publicHost: "same-wa.example.test" }) };
  });
  await restorePublishedWebapps(f.app, f.ports, runtime);
  assert.deepEqual(queried, [item.id]);
  assert.deepEqual(started, []);
  assert.equal(f.starts(), 1);
});

test("webs.list reads current runtime and global publish information in one IPC response", t => {
  const f = publicationFixture(t);
  const { createWebsFacade } = require("../dist-electron/main/modules/webs/facade.js");
  const { registerWebIpcHandlers } = require("../dist-electron/main/modules/webs/ipc.js");
  const facade = createWebsFacade(f.ports), handlers = new Map();
  let status = "running";
  t.mock.method(facade.webappRuntime, "getStatus", (_app, id) => ({ id, status }));
  registerWebIpcHandlers({ handle: (name, handler) => handlers.set(name, handler) }, { app: f.app, websFacade: facade });
  const read = handlers.get("webs.list");
  const initial = read();
  assert.equal(initial.webappRuntimeStates[f.items[0].id].status, "running");
  assert.equal(initial.webappPublishInfo.tunnelConnected, true);
  status = "error";
  f.disconnect();
  const refreshed = read();
  assert.equal(refreshed.webappRuntimeStates[f.items[0].id].status, "error");
  assert.equal(refreshed.webappPublishInfo.tunnelConnected, false);
  t.mock.method(facade.webappRuntime, "getStatus", () => { throw new Error("unreadable runtime"); });
  assert.equal(read().items.length, 2);
  assert.deepEqual(read().webappRuntimeStates, {});
});
