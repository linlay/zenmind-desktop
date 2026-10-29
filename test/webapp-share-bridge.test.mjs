import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  createWebsFacade,
} = require("../dist-electron/main/modules/webs/index.js");
const {
  getWebappDir,
} = require("../dist-electron/main/modules/webs/webapps/store.js");
const {
  createShareReceiverRouter,
} = require("../dist-electron/main/modules/shares/receiver.js");
const {
  WEBAPP_BRIDGE_MODULE_SOURCE,
} = require("../dist-electron/main/modules/webs/webapps/bridge-module.js");
const {
  issueWebappActionToken,
  invalidateWebappActionTokens,
} = require("../dist-electron/main/modules/webs/webapps/action-tokens.js");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only the configured listener port is substituted with 0. Authorization,
// gateway forwarding, page scope, dispatch and SDK are production code.
function actionServer() {
  const file = new URL(
    "../dist-electron/main/modules/desktop-actions/action-http-server.js",
    import.meta.url,
  );
  const localRequire = createRequire(file),
    module = { exports: {} };
  new Function("require", "module", "exports", fs.readFileSync(file, "utf8"))(
    (name) =>
      name === "./settings"
        ? { getConfiguredDesktopActionBridgePort: () => 0 }
        : localRequire(name),
    module,
    module.exports,
  );
  return module.exports;
}

test("installed static WebApp receives through its real gateway, page token, HTTP Bridge and generated SDK", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-share-bridge-"));
  const app = {
    getPath: (name) => path.join(root, name),
    getVersion: () => "1.0.0",
  };
  const id = "webapp-0000000000000001",
    capability = { protocolVersion: 1, contextVersions: [1] };
  const webappDir = getWebappDir(app, id);
  fs.mkdirSync(path.join(webappDir, "frontend"), { recursive: true });
  fs.writeFileSync(
    path.join(webappDir, "webapp.json"),
    JSON.stringify({
      schemaVersion: 2,
      id,
      key: "sample-receiver",
      label: "Synthetic receiver",
      version: "1.0.0",
      target: "any",
      shareReceiver: capability,
      frontend: { root: "frontend", index: "index.html" },
    }),
  );
  fs.writeFileSync(
    path.join(webappDir, "frontend/index.html"),
    "<!doctype html><title>Share receiver fixture</title><p>Sample only</p>",
  );
  const httpBridge = actionServer();
  let port = 0;
  const facade = createWebsFacade({
    getDesktopDeviceId: () => "synthetic-device",
    getConfiguredDesktopActionBridgePort: () => port,
    readInstalledRecords: () => [],
  });
  const server = httpBridge.startDesktopActionBridge({ app, webs: facade });
  await once(server, "listening");
  port = server.address().port;
  const nativeFetch = globalThis.fetch;
  let stop,
    origin = "",
    opens = 0;
  let router;
  t.after(async () => {
    stop?.();
    globalThis.fetch = nativeFetch;
    facade.disposeShareReceivers();
    router?.dispose();
    await facade.webappRuntime.stopAll(app);
    httpBridge.stopDesktopActionBridge();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    invalidateWebappActionTokens();
    fs.rmSync(root, { recursive: true, force: true });
  });
  router = createShareReceiverRouter({
    timeoutMs: 4000,
    resolve: async (shareId) => ({
      protocolVersion: 1,
      id: shareId,
      kind: "sample",
      title: "Frozen document",
      actions: ["desktop"],
      desktop: {
        receiverId: "webapp." + id,
        contextVersion: 1,
        context: { documentId: shareId, version: "frozen" },
      },
    }),
  });
  facade.configureShares(
    app,
    { registerReceiver: router.register },
    async () => {
      opens++;
      const result = await facade.webappRuntime.start(app, id);
      assert.equal(result.ok, true);
      origin = result.state.webUrl.replace(/\/$/u, "");
    },
  );
  const first = router.receive("first");
  for (let i = 0; i < 100 && !origin; i++) await delay(5);
  assert.ok(origin);
  assert.equal((await nativeFetch(origin)).status, 200);
  const sdk = await import(
    "data:text/javascript;base64," +
      Buffer.from(WEBAPP_BRIDGE_MODULE_SOURCE).toString("base64")
  );
  const sdkResponse = await nativeFetch(origin + "/__desktop/bridge.js");
  assert.equal(await sdkResponse.text(), WEBAPP_BRIDGE_MODULE_SOURCE);
  globalThis.fetch = (url, init = {}) =>
    nativeFetch(
      typeof url === "string" && url.startsWith("/") ? origin + url : url,
      {
        ...init,
        headers: {
          ...init.headers,
          ...(typeof url === "string" && url.startsWith("/")
            ? { Origin: origin }
            : {}),
        },
      },
    );
  const received = [];
  let releaseThird;
  const thirdReady = new Promise((resolve) => (releaseThird = resolve));
  let enteredThird;
  const entered = new Promise((resolve) => (enteredThird = resolve));
  stop = sdk.desktop.share.onReceive(async (request) => {
    received.push(request);
    if (request.shareId === "third") {
      enteredThird();
      await thirdReady;
    }
    return "received";
  });
  assert.equal((await first).status, "received");
  const firstPort = facade.webappRuntime.getStatus(app, id).frontendPort;
  assert.equal((await router.receive("second")).status, "received");
  assert.equal(facade.webappRuntime.getStatus(app, id).frontendPort, firstPort);
  assert.equal(opens, 2);
  assert.deepEqual(
    received.map((request) => [
      request.shareId,
      request.receiverId,
      request.context.documentId,
    ]),
    [
      ["first", "webapp." + id, "first"],
      ["second", "webapp." + id, "second"],
    ],
  );
  const call = (url, headers = {}) =>
    nativeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        action: "desktop.share.receive",
        args: { instanceId: "00000000-0000-4000-8000-000000000001" },
      }),
    });
  assert.equal((await call(origin + "/__desktop/actions/call")).status, 403);
  assert.equal(
    (
      await call(origin + "/__desktop/actions/call", {
        Origin: "https://attacker.invalid",
      })
    ).status,
    403,
  );
  const item = facade.webappManager.listInstalled(app)[0];
  const backendToken = issueWebappActionToken(item, "backendActionToken");
  assert.equal(
    (
      await call("http://127.0.0.1:" + port + "/webapps/pages/actions/call", {
        Authorization: "Bearer " + backendToken,
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("http://127.0.0.1:" + port + "/actions/call")).status,
    400,
  );
  const third = router.receive("third");
  await entered;
  invalidateWebappActionTokens();
  assert.equal((await third).status, "unavailable");
  releaseThird();
  await tick();
  stop();
  assert.equal(received.length, 3);
});
