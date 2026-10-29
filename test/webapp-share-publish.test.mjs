import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const {
  getWebappDir,
  readInstalledWebappItems,
} = require("../dist-electron/main/modules/webs/webapps/store.js");
const {
  getDesktopWebappStateRoot,
} = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");
const {
  createPublishedWebappShare,
  preparePublishedWebappShare,
} = require("../dist-electron/main/modules/webs/webapps/share-publish.js");
const {
  readPublishedWebappBinding,
} = require("../dist-electron/main/modules/webs/webapps/publisher.js");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-share-publish-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = {
    getPath: (name) => path.join(root, name),
    getVersion: () => "1.0.0",
  };
  const id = "webapp-0000000000000001";
  const webappDir = getWebappDir(app, id);
  fs.mkdirSync(path.join(webappDir, "frontend"), { recursive: true });
  fs.writeFileSync(
    path.join(webappDir, "frontend/index.html"),
    "<h1>Private running app</h1>",
  );
  fs.writeFileSync(
    path.join(webappDir, "webapp.json"),
    JSON.stringify({
      schemaVersion: 2,
      id,
      key: "sample-service",
      label: "Frozen service",
      version: "1.2.3",
      target: "any",
      appConfig: { privateBusinessData: "never-publish-private-data" },
      frontend: { root: "frontend", index: "index.html" },
    }),
  );
  const item = readInstalledWebappItems(app)[0];
  assert.ok(item);
  const statePath = path.join(
    getDesktopWebappStateRoot(app, id),
    "publish.json",
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const state = {
    id,
    provider: "tunnel",
    status: "published",
    name: id,
    routeId: "route-one",
    publicHost: "abcdefghijk23-wa.example.test",
    url: "https://abcdefghijk23-wa.example.test/",
    targetUrl: "http://127.0.0.1:4001/private-local-path",
    active: true,
    updatedAt: new Date().toISOString(),
  };
  const writeState = (value) =>
    fs.writeFileSync(statePath, JSON.stringify(value));
  writeState(state);
  const ports = {
    readTunnelHubSettings: () => ({
      enabled: true,
      relayUrl: "wss://hub.example.test/tunnel",
      deviceId: "synthetic-device",
    }),
    readTunnelHubRegistrationBearerToken: () => "synthetic-token",
    deriveTunnelHubRegistrationApiOrigin: () => "https://hub.example.test",
    startTunnelHubRuntime: () => assert.fail("share started Tunnel"),
    saveTunnelHubSettings: () => assert.fail("share changed settings"),
  };
  const binding = {
    webAppId: "webapp_database_id",
    deviceId: "synthetic-device",
    name: id,
    routeId: "route-one",
    active: true,
    targetUrl: state.targetUrl,
    publicUrl: state.url,
  };
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));
  return { app, id, item, state, ports, binding, writeState };
}
const response = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

test("WebApp publication sharing reads the exact existing binding and freezes display facts through the public publish port", async (t) => {
  const f = fixture(t);
  let reads = 0,
    uploads = 0;
  globalThis.fetch = async (url, init) => {
    reads++;
    assert.equal(
      url,
      "https://hub.example.test/api/desktop/devices/synthetic-device/webapps/" +
        f.id,
    );
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.deepEqual(init.headers, { Authorization: "Bearer synthetic-token" });
    assert.equal(init.body, undefined);
    return response(f.binding);
  };
  const shares = {
    publish: async (prepare) => {
      const prepared = await prepare({
        maxManifestBytes: 8192,
        maxResourceBytes: 64 * 1024,
      });
      assert.equal("ok" in prepared, false);
      uploads++;
      const envelope = JSON.parse(Buffer.from(prepared.manifest));
      assert.deepEqual(envelope.service, {
        type: "webapp",
        webAppId: f.binding.webAppId,
      });
      assert.equal(envelope.kind, "webapp-service");
      assert.equal(envelope.desktop, undefined);
      assert.equal(envelope.title, "Frozen service");
      for (const resource of prepared.resources) {
        const metadata = envelope.resources.find(
          (item) => item.id === resource.id,
        );
        assert.equal(
          metadata.sha256,
          createHash("sha256").update(resource.bytes).digest("hex"),
        );
        assert.equal(metadata.size, resource.bytes.length);
        assert.doesNotMatch(
          Buffer.from(resource.bytes).toString(),
          /never-publish|private-local-path|synthetic-token|webapp_database_id/,
        );
      }
      const frozen = JSON.parse(
        Buffer.from(
          prepared.resources.find((item) => item.name === "data.json").bytes,
        ),
      );
      assert.equal(frozen.context.resourceVersion, "1.2.3");
      f.item.label = "Later label";
      assert.equal(frozen.context.display.name, "Frozen service");
      return { ok: true, record: { id: "share-one" } };
    },
  };
  assert.equal(
    (await createPublishedWebappShare(f.app, shares, f.id, f.ports)).ok,
    true,
  );
  assert.equal(reads, 1);
  assert.equal(uploads, 1);
});

test("unpublished and missing applications cannot open Tunnel, update a route or upload a share", async (t) => {
  const f = fixture(t);
  globalThis.fetch = () => assert.fail("unpublished app reached HTTP");
  f.writeState({ ...f.state, active: false });
  await assert.rejects(
    readPublishedWebappBinding(f.app, f.item, f.ports),
    /未发布|not published/,
  );
  let uploads = 0;
  const shares = {
    publish: async (prepare) => {
      uploads++;
      return prepare({ maxManifestBytes: 8192, maxResourceBytes: 8192 });
    },
  };
  assert.equal(
    (await createPublishedWebappShare(f.app, shares, "missing-app", f.ports))
      .ok,
    false,
  );
  assert.equal(
    (await createPublishedWebappShare(f.app, shares, { id: f.id }, f.ports)).ok,
    false,
  );
  assert.equal(uploads, 1);
});

test("unproven owner/device/name/route, inactive or malformed responses fail without exposing response content", async (t) => {
  const f = fixture(t);
  for (const changed of [
    { ...f.binding, deviceId: "another-device" },
    { ...f.binding, name: "another-app" },
    { ...f.binding, routeId: "another-route" },
    { ...f.binding, active: false },
    { ...f.binding, webAppId: "https://attacker.invalid" },
  ]) {
    globalThis.fetch = async () => response(changed);
    await assert.rejects(
      readPublishedWebappBinding(f.app, f.item, f.ports),
      /发布|publication/,
    );
  }
  globalThis.fetch = async () => new Response("never-publish-secret MALFORMED");
  await assert.rejects(
    readPublishedWebappBinding(f.app, f.item, f.ports),
    (error) => !/never-publish/.test(error.message),
  );
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ...f.binding, large: "x".repeat(65536) }));
  await assert.rejects(readPublishedWebappBinding(f.app, f.item, f.ports));
  globalThis.fetch = async () =>
    new Response("never-publish-secret", { status: 404 });
  await assert.rejects(
    readPublishedWebappBinding(f.app, f.item, f.ports),
    (error) => !/never-publish/.test(error.message),
  );
});

test("publication quota failure happens before the public upload and never includes private application configuration", async (t) => {
  const f = fixture(t);
  globalThis.fetch = async () => response(f.binding);
  for (const limits of [
    { maxManifestBytes: 1, maxResourceBytes: 8192 },
    { maxManifestBytes: 8192, maxResourceBytes: 1 },
  ]) {
    const shares = {
      publish: async (prepare) => {
        const value = await prepare(limits);
        assert.equal(value.ok, false);
        return value;
      },
    };
    assert.equal(
      (await createPublishedWebappShare(f.app, shares, f.id, f.ports)).ok,
      false,
    );
  }
  const prepared = preparePublishedWebappShare(
    { ...f.item, label: "bad\nlabel" },
    f.binding.webAppId,
  );
  assert.equal(JSON.parse(Buffer.from(prepared.manifest)).title, f.item.key);
});

test("WebApp share IPC is restricted to the actual Main frame and rechecks it after publication", async () => {
  const file = new URL(
      "../dist-electron/main/modules/webs/ipc.js",
      import.meta.url,
    ),
    localRequire = createRequire(file),
    module = { exports: {} };
  new Function("require", "module", "exports", fs.readFileSync(file, "utf8"))(
    (name) =>
      name === "electron"
        ? { BrowserWindow: { fromWebContents: () => null } }
        : localRequire(name),
    module,
    module.exports,
  );
  const handlers = new Map();
  const frame = {};
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  let calls = 0,
    finish;
  module.exports.registerWebIpcHandlers(
    { handle: (name, handler) => handlers.set(name, handler) },
    {
      app: {},
      getMainWindow: () => window,
      websFacade: {
        sharePublishedWebapp: async () => {
          calls++;
          return new Promise((resolve) => (finish = resolve));
        },
      },
      getDataRoot: () => "synthetic",
      showFileDialog: async () => {},
      showSaveDialog: async () => {},
    },
  );
  const share = handlers.get("webs.webapps.share");
  await assert.rejects(share({ sender: {}, senderFrame: frame }, "app"));
  await assert.rejects(share({ sender: contents, senderFrame: {} }, "app"));
  assert.equal(calls, 0);
  const pending = share({ sender: contents, senderFrame: frame }, "app");
  contents.mainFrame = {};
  finish({ ok: true });
  await assert.rejects(pending, /sender/);
  assert.equal(calls, 1);
});
