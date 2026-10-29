import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const { PRODUCT_NAME } = require("../dist-electron/shared/brand.js");
const { prepareMarketShare } = require("../dist-electron/main/modules/marketplace/share-publish.js");
const { readMarketShareContext } = require("../dist-electron/shared/market-share.js");
const { installMarketItem } = require("../dist-electron/main/modules/marketplace/runtime.js");
const { configureConnectorMarketPlatformCaller } = require("../dist-electron/main/modules/marketplace/connector-market.js");
const { readInstalledRecords } = require("../dist-electron/main/modules/marketplace/common.js");
const { normalizeCatalog } = require("../dist-electron/main/modules/marketplace/catalog-normalization.js");
const { resolveMarketAsset } = require("../dist-electron/main/modules/marketplace/catalog-client.js");
const item = { id: "frozen-connector", type: "connector", name: "Frozen connector", version: "1.2.3", description: "Frozen description", author: "Publisher", tags: ["mcp"],
  assets: { universal: { url: "https://private.example.test/archive.zip?token=never-publish", archiveType: "zip", role: "primary", sizeBytes: 1, sha256: "a".repeat(64) } },
  metadata: { privatePath: "/private/never-publish", credential: "never-publish-secret" }, readme: "private URL: never-publish-readme" };
const context = () => ({ itemId: item.id, resourceType: "connector", resourceVersion: item.version, display: { name: item.name, description: item.description, author: item.author, tags: item.tags } });
function appFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "market-share-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { getPath: name => name === "appData" ? path.join(root, "app-data") : root, getVersion: () => "1.0.0" };
}

test("market freezes a verified connector version, display-only data and two isolated preview resources", () => {
  const source = { ...item };
  const prepared = prepareMarketShare({ items: [source] }, item.id, item.version);
  const manifest = JSON.parse(prepared.manifest);
  assert.equal(manifest.kind, "market-resource"); assert.equal(manifest.protocolVersion, 1); assert.equal(manifest.content.version, 1);
  assert.equal(manifest.title, `${item.name}连接器 · ${PRODUCT_NAME}`);
  assert.deepEqual(manifest.desktop, { receiverId: "builtin.market", contextVersion: 1, context: context() });
  assert.deepEqual(manifest.source, { module: "marketplace", id: item.id });
  assert.equal(manifest.content.resourceId, manifest.resources.find(resource => resource.path === "data.json").id);
  for (const resource of manifest.resources) {
    const bytes = prepared.resources.find(value => value.id === resource.id).bytes;
    assert.equal(resource.size, bytes.length); assert.equal(resource.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.doesNotMatch(bytes.toString(), /never-publish|\/private\//);
  }
  assert.doesNotMatch(prepared.manifest.toString(), /never-publish|\/private\//);
  const frozen = prepared.resources.find(value => value.name === "data.json").bytes.toString();
  source.description = "Later source edit";
  assert.equal(JSON.parse(frozen).context.display.description, "Frozen description");
});

test("missing versions, a different requested version and legacy MCP types never become a new share", () => {
  const { version, ...missing } = item;
  for (const raw of [{ items: [missing] }, { items: [{ ...item, type: "mcp" }] }, { items: [] }]) assert.throws(() => prepareMarketShare(raw, item.id, "1.2.3"));
  assert.throws(() => prepareMarketShare({ items: [item] }, item.id, "2.0.0"), /变化|changed/);
  assert.equal(readMarketShareContext({ ...context(), action: "install" }), null);
  assert.equal(readMarketShareContext({ ...context(), resourceType: "mcp" }), null);
  assert.equal(readMarketShareContext({ ...context(), resourceVersion: "1.2.3\n" }), null);
});

test("business preview never interpolates display text into executable HTML", () => {
  const name = "</script><script>window.parent.hostProbe=true</script>";
  const prepared = prepareMarketShare({ items: [{ ...item, name }] }, item.id, item.version);
  const page = prepared.resources.find(value => value.name === "index.html").bytes.toString();
  const data = JSON.parse(prepared.resources.find(value => value.name === "data.json").bytes);
  assert.equal(data.context.display.name, name); assert.doesNotMatch(page, /hostProbe/);
  assert.match(page, /textContent/); assert.match(page, /credentials:'omit'/);
});

test("source publication accepts only the item/version selector and checks quotas before upload", async () => {
  const file = new URL("../dist-electron/main/modules/marketplace/share-publish.js", import.meta.url); const localRequire = createRequire(file);
  const module = { exports: {} }; let reads = 0, prepares = 0;
  new Function("require", "module", "exports", fs.readFileSync(file, "utf8"))(name => {
    if (name === "./market-settings") return { getMarketplaceCatalogUrl: () => "https://market.example.test/api/v1/desktop/catalog" };
    if (name === "./market-http") return { requestVisibleMarketJson: async () => { reads++; return { items: [item] }; } };
    return localRequire(name);
  }, module, module.exports);
  const publisher = { publish: async prepare => { prepares++; return prepare({ maxManifestBytes: 1 << 20, maxResourceBytes: 1 }); } };
  for (const input of [item.id, {}, { itemId: item.id, resourceVersion: item.version, owner: "other" }, { itemId: "../path", resourceVersion: item.version }]) assert.equal((await module.exports.createMarketShare({}, publisher, input)).ok, false);
  assert.equal(prepares, 0); assert.equal(reads, 0);
  const rejected = await module.exports.createMarketShare({}, publisher, { itemId: item.id, resourceVersion: item.version });
  assert.equal(rejected.ok, false); assert.match(rejected.message, /额度|limit/); assert.equal(reads, 1);
});

test("the original installer refuses a stale expected version before any download or Platform call", async t => {
  const app = appFixture(t); let platformCalls = 0, downloads = 0;
  configureConnectorMarketPlatformCaller(async () => { platformCalls++; assert.fail("stale version must not install"); });
  t.after(() => configureConnectorMarketPlatformCaller(null));
  await assert.rejects(installMarketItem(app, item.id, { catalog: { items: [{ ...item, version: "2.0.0" }] }, expectedVersion: item.version,
    fetchImpl: async () => { downloads++; assert.fail("stale version must not download"); } }), /变化|changed/);
  assert.equal(platformCalls, 0); assert.equal(downloads, 0); assert.deepEqual(readInstalledRecords(app), []);
});

test("the original connector installer retains its transaction when the expected version matches", async t => {
  const app = appFixture(t), bytes = Buffer.from("synthetic connector ZIP transport");
  const catalogItem = { ...item, metadata: { connectorId: "example.office" }, assets: { universal: { ...item.assets.universal, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } };
  let imported = 0;
  configureConnectorMarketPlatformCaller(async endpoint => endpoint === "/api/admin/connectors" ? { connectors: [] } : (++imported, { installed: true, id: "example.office", version: item.version }));
  t.after(() => configureConnectorMarketPlatformCaller(null));
  const result = await installMarketItem(app, item.id, { catalog: { items: [catalogItem] }, expectedVersion: item.version, fetchImpl: async () => new Response(bytes) });
  assert.equal(result.ok, true); assert.equal(imported, 1); assert.equal(readInstalledRecords(app)[0].version, item.version);
});

test("controlled Market resolve accepts an exact historical version and refuses a latest-version substitution", async t => {
  const app = appFixture(t), normalized = normalizeCatalog({ items: [item] }).items[0];
  for (const serverVersion of [item.version, "2.0.0"]) {
    const requests = [];
    const options = { apiBaseUrl: "https://market.example.test/api/v1", readMarketViewer: () => "test-user", issueMarketAccessToken: async () => "synthetic-test-token",
      fetchImpl: async (value, init) => {
        const url = new URL(String(value)); requests.push(url);
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-test-token");
        if (url.pathname.endsWith("/auth/me")) return new Response(JSON.stringify({ user: { id: "test-user" } }));
        assert.equal(url.pathname, "/api/v1/connectors/" + item.id + "/resolve"); assert.equal(url.searchParams.get("version"), item.version);
        return new Response(JSON.stringify({ item: { id: item.id, type: "connector" }, version: serverVersion, platform: "universal", asset: item.assets.universal }));
      } };
    if (serverVersion === item.version) {
      const resolved = await resolveMarketAsset(app, normalized, options);
      assert.equal(resolved.item.version, item.version); assert.equal(resolved.asset.sha256, "a".repeat(64));
      assert.equal(resolved.downloadUrl, "https://market.example.test/api/v1/connectors/" + item.id + "/download?version=1.2.3&platform=universal");
    } else await assert.rejects(resolveMarketAsset(app, normalized, options), /不匹配|does not match/);
    assert.equal(requests.length, 2); assert.equal(requests.some(url => url.pathname.includes("download")), false);
  }
});
