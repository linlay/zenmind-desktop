import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const registry = require("../dist-electron/main/modules/services/service-registry.js");
const bridge = require("../dist-electron/main/modules/plugins/bridge.js");
const {
  createPluginShareReceivers,
} = require("../dist-electron/main/modules/plugins/share-receiver.js");
const {
  createWebappShareReceivers,
} = require("../dist-electron/main/modules/webs/webapps/share-receiver.js");
const {
  createShareReceiverRouter,
} = require("../dist-electron/main/modules/shares/receiver.js");
const {
  parseWebappManifest,
} = require("../dist-electron/shared/webapp-manifest.js");
const {
  getWebappAllowedActions,
} = require("../dist-electron/main/modules/webs/webapps/capability-policy.js");
const capability = { protocolVersion: 1, contextVersions: [1, 3] };
const plugin = (id = "sample-plugin") => ({
  pluginApiVersion: 1,
  id,
  name: "Synthetic sample",
  version: "1.0.0",
  description: "Synthetic only",
  lifecycle: { start: ["node", "sample.cjs"], stop: ["node", "stop.cjs"] },
  shareReceiver: capability,
  hooks: { subscribe: ["share.receive"] },
  bridge: { requests: ["share.ready", "share.ack", "share.release"] },
});
const manifest = () => ({
  schemaVersion: 2,
  id: "webapp-0000000000000001",
  key: "sample-webapp",
  label: "Synthetic sample",
  version: "1.0.0",
  target: "any",
  shareReceiver: capability,
  frontend: { root: "frontend", index: "index.html" },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const description = (id, receiverId) => ({
  protocolVersion: 1,
  id,
  kind: "sample",
  title: "Frozen sample",
  actions: ["desktop"],
  desktop: {
    receiverId,
    contextVersion: 1,
    context: { documentId: id, version: "frozen" },
  },
});
function rootFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extension-share-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    app: {
      getPath: (name) => path.join(root, name),
      getVersion: () => "1.0.0",
    },
  };
}
async function peer(t, app, service, hello = {}) {
  const env = bridge.getPluginBridgeEnv(app, service);
  const socket = net.connect(env.DESKTOP_PLUGIN_BRIDGE_PATH);
  let buffer = "";
  const events = [],
    responses = new Map(),
    waiting = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      if (value.type === "response") {
        responses.get(value.id)?.(value);
        responses.delete(value.id);
      } else {
        events.push(value);
        for (const resolve of waiting.splice(0)) resolve();
      }
    }
  });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write(
    JSON.stringify({
      type: "hello",
      pluginId: service.id,
      token: env.DESKTOP_PLUGIN_BRIDGE_TOKEN,
      protocolVersion: 1,
      ...hello,
    }) + "\n",
  );
  let serial = 0;
  return {
    socket,
    events,
    async request(method, params) {
      const id = String(++serial);
      const result = new Promise((resolve) => responses.set(id, resolve));
      socket.write(
        JSON.stringify({ type: "request", id, method, params }) + "\n",
      );
      return Promise.race([
        result,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(Error("fixture response timeout")),
            2000,
          );
          timer.unref();
        }),
      ]);
    },
    async nextShare() {
      for (let attempt = 0; attempt < 20; attempt++) {
        const event = events.find((event) => event.name === "share.receive");
        if (event) return event.data;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("share event missing");
    },
  };
}
function pluginFixture(t) {
  const { app } = rootFixture(t);
  fs.mkdirSync(app.getPath("temp"), { recursive: true });
  registry.clearServices();
  t.after(() => {
    bridge.stopPluginBridgeServers();
    registry.clearServices();
  });
  const service = registry.registerService(plugin());
  let state = {
    id: service.id,
    installed: true,
    serviceMode: "service",
    status: "running",
    version: service.version,
    healthMeta: { webUrl: "", port: null },
  };
  let starts = 0;
  const router = createShareReceiverRouter({
    timeoutMs: 2000,
    resolve: async (id) => description(id, "plugin." + service.id),
  });
  t.after(() => router.dispose());
  const adapter = createPluginShareReceivers({
    shares: { registerReceiver: router.register },
    getService: registry.getService,
    getState: async () => state,
    start: async () => {
      starts++;
      state = { ...state, status: "running" };
      return { ok: true, service: state };
    },
    onError: () => assert.fail("registration failed"),
  });
  adapter.sync(registry.getAllServices());
  t.after(() => adapter.dispose());
  return {
    app,
    service,
    router,
    adapter,
    get starts() {
      return starts;
    },
    setState(value) {
      state = { ...state, ...value };
      bridge.publishPluginBridgeServiceState(state);
    },
  };
}

test("optional manifests bind receiver ownership and reject unsupported declarations; old packages add no methods", () => {
  registry.clearServices();
  const old = plugin();
  delete old.shareReceiver;
  delete old.hooks;
  delete old.bridge;
  assert.equal(registry.registerService(old).shareReceiver, undefined);
  for (const shareReceiver of [
    { ...capability, receiverId: "builtin.market" },
    { ...capability, owner: "other" },
    { protocolVersion: 2, contextVersions: [1] },
    { protocolVersion: 1, contextVersions: [1, 1] },
  ])
    assert.throws(() =>
      registry.registerService({ ...plugin(), shareReceiver }),
    );
  assert.throws(() =>
    registry.registerService({ ...plugin(), bridge: { requests: [] } }),
  );
  const web = parseWebappManifest(manifest());
  assert.deepEqual(web.shareReceiver, capability);
  for (const shareReceiver of [
    { ...capability, receiverId: "builtin.market" },
    { ...capability, owner: "other" },
    { protocolVersion: 2, contextVersions: [1] },
    { protocolVersion: 1, contextVersions: [1, 1] },
  ])
    assert.throws(() => parseWebappManifest({ ...manifest(), shareReceiver }));
  assert.ok(
    getWebappAllowedActions(web, "localPageGateway").includes(
      "desktop.share.receive",
    ),
  );
  assert.ok(
    !getWebappAllowedActions(web, "backendActionToken").includes(
      "desktop.share.receive",
    ),
  );
  const { shareReceiver, ...legacy } = web;
  assert.ok(
    !getWebappAllowedActions(legacy, "localPageGateway").includes(
      "desktop.share.receive",
    ),
  );
  registry.clearServices();
});

test("real authenticated Plugin Bridge delivers only to its ready connection and accepts its exact acknowledgement", async (t) => {
  const fixture = pluginFixture(t);
  const client = await peer(t, fixture.app, fixture.service);
  const ready = await client.request("share.ready", { protocolVersion: 1 });
  assert.equal(ready.ok, true);
  const opening = fixture.router.receive("plugin-first");
  const delivery = await client.nextShare();
  assert.equal(delivery.request.context.documentId, "plugin-first");
  const stranger = await peer(t, fixture.app, fixture.service);
  assert.equal(
    (
      await stranger.request("share.ack", {
        generation: delivery.generation,
        intentId: delivery.request.intentId,
        status: "received",
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await client.request("share.ack", {
        generation: delivery.generation,
        intentId: delivery.request.intentId,
        status: "received",
      })
    ).ok,
    true,
  );
  assert.equal((await opening).status, "received");
  assert.equal(fixture.starts, 0);
  assert.match(
    bridge.createPluginBridgePath(fixture.app, fixture.service.id, {
      platform: "win32",
      instanceId: "fixture",
    }),
    /^\\\\\.\\pipe\\/,
  );
});

test("plugin activation uses the original lifecycle; stopping, disconnecting and uninstall invalidate old endpoints", async (t) => {
  const fixture = pluginFixture(t);
  fixture.setState({ status: "stopped" });
  const client = await peer(t, fixture.app, fixture.service);
  await client.request("share.ready", { protocolVersion: 1 });
  const opening = fixture.router.receive("will-stop");
  await client.nextShare();
  assert.equal(fixture.starts, 1);
  fixture.setState({ status: "stopped" });
  assert.equal((await opening).status, "unavailable");
  fixture.setState({ status: "running" });
  const next = await peer(t, fixture.app, fixture.service);
  await next.request("share.ready", { protocolVersion: 1 });
  const disconnected = fixture.router.receive("will-disconnect");
  await next.nextShare();
  next.socket.destroy();
  assert.equal((await disconnected).status, "unavailable");
  const pending = fixture.router.receive("will-uninstall");
  await tick();
  registry.unregisterService(fixture.service.id);
  fixture.adapter.sync(registry.getAllServices());
  assert.equal((await pending).status, "unavailable");
  assert.equal((await fixture.router.receive("absent")).status, "unsupported");
});

function webFixture(t) {
  let listingFailure = false;
  const errors = [];
  let items = [
    {
      ...parseWebappManifest(manifest()),
      kind: "webapp",
      installPath: "synthetic-package",
    },
  ];
  const controller = new AbortController();
  const id = items[0].id;
  let status = "running",
    opens = 0;
  const router = createShareReceiverRouter({
    timeoutMs: 2000,
    resolve: async (shareId) => description(shareId, "webapp." + id),
  });
  t.after(() => router.dispose());
  const adapter = createWebappShareReceivers({
    shares: { registerReceiver: router.register },
    listInstalled: () => {
      if (listingFailure) throw new Error("fixture read failure");
      return items;
    },
    getState: () => ({ status }),
    open: async () => {
      opens++;
    },
    onError: (id) => errors.push(id),
  });
  adapter.sync();
  t.after(() => adapter.dispose());
  const instanceId = "00000000-0000-4000-8000-000000000001";
  return {
    id,
    router,
    adapter,
    controller,
    instanceId,
    get opens() {
      return opens;
    },
    poll: () =>
      adapter.handle(
        id,
        "desktop.share.receive",
        { instanceId },
        controller.signal,
      ),
    remove() {
      items = [];
      adapter.sync();
    },
    failListing() {
      listingFailure = true;
      adapter.sync();
    },
    get errors() {
      return errors.length;
    },
    upgrade() {
      items = [{ ...items[0], version: "2.0.0" }];
      adapter.sync();
    },
  };
}

test("WebApp page grant and instance receive and acknowledge an exact handoff; other owners cannot steal it", async (t) => {
  const fixture = webFixture(t);
  const opening = fixture.router.receive("web-first");
  await tick();
  assert.equal(
    fixture.adapter.handle(
      "other-app",
      "desktop.share.receive",
      { instanceId: fixture.instanceId },
      fixture.controller.signal,
    ),
    null,
  );
  assert.equal(fixture.poll(), null);
  await tick();
  const delivery = fixture.poll();
  assert.equal(delivery.request.context.documentId, "web-first");
  assert.equal(
    fixture.adapter.handle(
      fixture.id,
      "desktop.share.ack",
      {
        instanceId: fixture.instanceId,
        generation: delivery.generation,
        intentId: delivery.request.intentId,
        status: "received",
      },
      new AbortController().signal,
    ),
    null,
  );
  assert.deepEqual(
    fixture.adapter.handle(
      fixture.id,
      "desktop.share.ack",
      {
        instanceId: fixture.instanceId,
        generation: delivery.generation,
        intentId: delivery.request.intentId,
        status: "received",
      },
      fixture.controller.signal,
    ),
    { acknowledged: true },
  );
  assert.equal((await opening).status, "received");
  assert.equal(fixture.opens, 1);
});
for (const reason of [
  "identity",
  "replacement",
  "upgrade",
  "uninstall",
  "catalog",
])
  test(`WebApp ${reason} ends the current handoff without delivering into a new instance`, async (t) => {
    const fixture = webFixture(t);
    const opening = fixture.router.receive("web-old");
    await tick();
    fixture.poll();
    await tick();
    const delivery = fixture.poll();
    assert.ok(delivery);
    if (reason === "identity") fixture.controller.abort();
    if (reason === "replacement")
      fixture.adapter.handle(
        fixture.id,
        "desktop.share.receive",
        { instanceId: "00000000-0000-4000-8000-000000000002" },
        fixture.controller.signal,
      );
    if (reason === "upgrade") fixture.upgrade();
    if (reason === "uninstall") fixture.remove();
    if (reason === "catalog") {
      fixture.failListing();
      assert.equal(fixture.errors, 1);
    }
    assert.equal((await opening).status, "unavailable");
    assert.equal(
      fixture.adapter.handle(
        fixture.id,
        "desktop.share.ack",
        {
          instanceId: fixture.instanceId,
          generation: delivery.generation,
          intentId: delivery.request.intentId,
          status: "received",
        },
        new AbortController().signal,
      ),
      null,
    );
  });

for (const status of [
  "not-installed",
  "initialization-required",
  "config-required",
  "dependency-missing",
])
  test(`plugin ${status} ends without starting or searching for another receiver`, async (t) => {
    const fixture = pluginFixture(t);
    fixture.setState({ status, installed: status !== "not-installed" });
    assert.equal(
      (await fixture.router.receive("unavailable")).status,
      "unavailable",
    );
    assert.equal(fixture.starts, 0);
  });

test("plugin version replacement cancels a delivery and only its new registration accepts future opens", async (t) => {
  const fixture = pluginFixture(t);
  const client = await peer(t, fixture.app, fixture.service);
  await client.request("share.ready", { protocolVersion: 1 });
  const opening = fixture.router.receive("old-version");
  await client.nextShare();
  registry.registerService({ ...plugin(), version: "2.0.0" });
  fixture.adapter.sync(registry.getAllServices());
  assert.equal((await opening).status, "unavailable");
  const replacement = registry.getService(fixture.service.id);
  const next = await peer(t, fixture.app, replacement);
  await next.request("share.ready", { protocolVersion: 1 });
  const current = fixture.router.receive("new-version");
  const delivery = await next.nextShare();
  await next.request("share.ack", {
    generation: delivery.generation,
    intentId: delivery.request.intentId,
    status: "received",
  });
  assert.equal((await current).status, "received");
});
