import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { registerMarketBusinessLinks } = await import("../dist-electron/main/modules/marketplace/business-link.js");
const { installMarketItem } = await import("../dist-electron/main/modules/marketplace/runtime.js");
const { requestMarket } = await import("../dist-electron/main/modules/marketplace/market-http.js");
const { saveMarketSettings } = await import("../dist-electron/main/modules/marketplace/market-settings.js");
const source = "https://linked.example.test/market/api/v1";
const catalogPath = source + "/desktop/catalog";
const target = new Map([["source", source], ["resourceType", "plugin"], ["itemId", "same-id"]]);

test("market links use the same source and exact typed catalog item through detail and confirmation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "market-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  saveMarketSettings(app, { enabled: true, apiBaseUrl: "https://local.example.test/api/v1" });
  const calls = [];
  let version = "1.2.3";
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    assert.equal(url, catalogPath);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.deepEqual([...new Headers(init.headers)], []);
    return Response.json({ items: [
      { id: "same-id", type: "skill", name: "Other type", version },
      { id: "same-id", type: "plugin", name: "Exact plugin", version },
    ] });
  };
  t.after(() => { globalThis.fetch = original; });
  const handlers = new Map();
  const mainFrame = { url: "" };
  const contents = { mainFrame };
  const event = { sender: contents, senderFrame: mainFrame };
  let mode = "cancel";
  let confirms = 0;
  let installs = 0;
  const open = registerMarketBusinessLinks({
    app, ipc: { handle: (name, handler) => handlers.set(name, handler) }, getMainWindow: () => ({ webContents: contents }),
    async confirmInstall(detail, run) {
      confirms++;
      assert.deepEqual([detail.name, detail.version, detail.source], ["Exact plugin", "1.2.3", source]);
      if (mode === "cancel") return null;
      version = "2.0.0";
      return run();
    },
    install(id, options) {
      installs++;
      return installMarketItem(app, id, options);
    },
  });
  let linkId;
  const navigate = route => {
    mainFrame.url = "file:///desktop.html#" + route;
    linkId = new URL(route, "https://desktop.invalid").searchParams.get("linkTarget");
  };
  await open(target, false, navigate);
  const detail = handlers.get("market.linkDetail")(event, linkId);
  assert.deepEqual([detail.name, detail.type, detail.source, detail.install], ["Exact plugin", "plugin", source, false]);
  assert.equal(handlers.get("market.linkDetail")({ ...event, senderFrame: {} }, linkId), null);
  assert.equal(handlers.get("market.installLinkedItem")(event, linkId), null);
  for (const invalid of [
    new Map([...target, ["version", "1.0.0"]]),
    new Map([...target, ["token", "ignored"]]),
    new Map([...target, ["resourceType", "cli-tool"]]),
  ]) await assert.rejects(open(invalid, false, navigate), /Invalid market link parameters/);
  await assert.rejects(open(new Map([...target, ["resourceType", "agent"]]), true, navigate));
  await assert.rejects(open(new Map([...target, ["version", "9.0.0"]]), true, navigate));
  assert.equal(confirms, 0);

  await open(target, true, navigate);
  const action = handlers.get("market.installLinkedItem");
  const cancelled = action(event, linkId);
  assert.equal(action(event, linkId), cancelled);
  assert.equal(await cancelled, null);
  assert.equal(installs, 0);
  mode = "drift";
  await open(target, true, navigate);
  await assert.rejects(action(event, linkId));
  assert.equal(confirms, 2);
  assert.equal(installs, 1);
  assert.equal(calls.length, 6);
});

test("unknown market installation stays anonymous through catalog, resolve and rejected download", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "market-anonymous-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root, getVersion: () => "1.0.0" };
  const calls = [];
  const options = {
    apiBaseUrl: source,
    expectedType: "mcp",
    expectedVersion: "1.2.3",
    linkSource: { base: source, trusted: false, viewer: "signed-in", assertCurrent() {} },
    readMarketViewer: () => "signed-in",
    issueMarketAccessToken: () => assert.fail("unknown market must never ask for a token"),
    async fetchImpl(value, init) {
      const url = new URL(value);
      calls.push(url.pathname);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.deepEqual([...new Headers(init.headers)], []);
      const item = { id: "same-id", type: "mcp", name: "Example MCP", version: "1.2.3" };
      if (value === catalogPath) return Response.json({ items: [item] });
      assert.equal(url.searchParams.get("version"), "1.2.3");
      if (url.pathname.endsWith("/resolve")) return Response.json({ item, version: "1.2.3", platform: "universal" });
      return new Response(null, { status: 401 });
    },
  };
  await assert.rejects(installMarketItem(app, "same-id", options));
  assert.deepEqual(calls, ["/market/api/v1/desktop/catalog", "/market/api/v1/mcps/same-id/resolve", "/market/api/v1/mcps/same-id/download"]);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).filter(name => /same-id|marketplace-installed/.test(name)), []);
  await assert.rejects(requestMarket(app, source + "-other/plugins/same-id/download", {}, options), /left the linked API/);
  await assert.rejects(requestMarket(app, "https://other.example.test/market/api/v1/plugins/same-id/download", {}, options), /left the linked API/);
});

test("a brand-pinned market can install without any local market configuration", async t => {
  const { APP_BRAND } = await import("../dist-electron/shared/brand.js");
  const oldSource = APP_BRAND.marketApiBaseUrl;
  const original = globalThis.fetch;
  APP_BRAND.marketApiBaseUrl = source;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, catalogPath);
    assert.equal(init.credentials, "omit");
    return Response.json({ items: [{ id: "same-id", type: "plugin", name: "Official plugin", version: "1.2.3" }] });
  };
  t.after(() => {
    APP_BRAND.marketApiBaseUrl = oldSource;
    globalThis.fetch = original;
  });
  const handlers = new Map();
  const contents = { mainFrame: { url: "" } };
  const open = registerMarketBusinessLinks({
    app: { getPath() { assert.fail("Official source trust must not depend on local configuration"); } },
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    getMainWindow: () => ({ webContents: contents }),
    confirmInstall: (_detail, run) => run(),
    async install(id, options) {
      assert.equal(options.linkSource.trusted, true);
      assert.deepEqual([id, options.apiBaseUrl, options.expectedType, options.expectedVersion], ["same-id", source, "plugin", "1.2.3"]);
      return { ok: true, itemId: id, type: "plugin", state: "installed", message: "Fixture installed" };
    },
  });
  let linkId;
  await open(target, true, route => {
    contents.mainFrame.url = "file:///desktop.html#" + route;
    linkId = new URL(route, "https://desktop.invalid").searchParams.get("linkTarget");
  });
  const result = await handlers.get("market.installLinkedItem")({ sender: contents, senderFrame: contents.mainFrame }, linkId);
  assert.equal(result.ok, true);
});
