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

test("passive route synchronization preserves publication while offline without starting Tunnel", async t => {
  const f = publicationFixture(t);
  f.disconnect();
  const item = f.items[0];
  const stateFile = path.join(getDesktopWebappStateRoot(f.app, item.id), "publish.json");
  const before = fs.readFileSync(stateFile, "utf8");
  const state = await syncPublishedWebappRoute(f.app, item, { id: item.id, status: "running", webUrl: "http://127.0.0.1:51001/" }, f.ports);
  assert.equal(state, null, "skipped synchronization must not emit route-synced");
  assert.equal(f.starts(), 0);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.readFileSync(stateFile, "utf8"), before);
});

test("restoring published apps stops after a disconnect without starting the next app or Tunnel", async t => {
  const f = publicationFixture(t);
  let appStarts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    f.disconnect();
    return { ok: true, text: async () => JSON.stringify({ routeId: "same-route", publicHost: "same-wa.example.test" }) };
  });
  const secondStateFile = path.join(getDesktopWebappStateRoot(f.app, f.items[1].id), "publish.json");
  const before = fs.readFileSync(secondStateFile, "utf8");
  const queried = [];
  await restorePublishedWebapps(f.app, f.ports, {
    getStatus: (_app, id) => { queried.push(id); return { id, status: "running", webUrl: "http://127.0.0.1:51001/" }; },
    start: async () => { appStarts++; }
  });
  assert.equal(queried.length, 1);
  assert.equal(appStarts, 0);
  assert.equal(f.starts(), 0);
  assert.equal(fs.readFileSync(secondStateFile, "utf8"), before);
});

test("connected restore synchronizes running apps and preserves stopped-app recovery", async t => {
  const f = publicationFixture(t);
  const started = [];
  await restorePublishedWebapps(f.app, f.ports, {
    getStatus: (_app, id) => ({ id, status: id === f.items[0].id ? "running" : "stopped", webUrl: "http://127.0.0.1:51001/" }),
    start: async (_app, id) => { started.push(id); }
  });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(started, [f.items[1].id]);
  assert.equal(f.starts(), 0);
});

test("explicit publishing can connect Tunnel before registering the route", async t => {
  const f = publicationFixture(t);
  f.disconnect();
  const item = f.items[0];
  const result = await publishWebapp(f.app, item.id, { id: item.id, status: "running", webUrl: "http://127.0.0.1:51001/" }, f.ports);
  assert.equal(result.ok, true);
  assert.equal(f.starts(), 1);
  assert.equal(f.requests.length, 1);
  assert.equal(result.state.id, item.id);
  assert.equal(result.state.routeId, "same-route");
});
