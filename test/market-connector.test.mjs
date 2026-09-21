import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeCatalog, marketRoute, upsertInstalledRecord, readInstalledRecords } = require("../dist-electron/main/modules/marketplace/common.js");
const { listMarketItems, installMarketItem, uninstallMarketItem } = require("../dist-electron/main/modules/marketplace/runtime.js");

const asset = {
  url: "https://market.example.test/connector/wecom-cli-connector/1.0.0/connector.zip",
  archiveType: "zip", sizeBytes: 392151, role: "primary"
};
const connector = {
  id: "wecom-cli-connector", type: "connector", name: "企业微信", version: "1.0.0",
  description: "通过企业微信官方 CLI 管理消息、文档、日程和通讯录。", tags: null,
  author: "Market publisher", downloadCount: 1,
  assets: { universal: asset },
  metadata: { connectorPrimaryType: "cli", connectorCapabilities: '["cli","skill"]', connectorSkillNames: '["wecomcli-calendar"]' }
};

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "market-connector-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { getPath: (name) => name === "appData" ? path.join(home, "Library", "Application Support") : home };
}

test("connector catalog preserves the backend type, nullable tags and extracted capabilities", () => {
  const result = normalizeCatalog({ items: [connector, { ...connector, id: "unknown", type: "unknown" }] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].type, "connector");
  assert.equal(result.items[0].name, "企业微信");
  assert.deepEqual(result.items[0].tags, []);
  assert.deepEqual(result.items[0].metadata, connector.metadata);
  assert.equal(marketRoute(result.items[0].type), "connectors");
});

test("connector section reads public catalog without mixing old MCP install records", async (t) => {
  const app = fixture(t);
  upsertInstalledRecord(app, { id: "flowcenter", type: "mcp", version: "1.0.0", source: "cloud", installedAt: "2026-09-01T00:00:00.000Z" });
  const requests = [];
  const result = await listMarketItems(app, {
    apiBaseUrl: "https://market.example.test/api/v1", marketEnabled: true, sections: ["connectors"],
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ items: [connector, { ...connector, id: "legacy", type: "mcp" }] }), { status: 200 });
    }
  });
  assert.deepEqual(result.items.map(({ id, type, name, state }) => ({ id, type, name, state })), [
    { id: "wecom-cli-connector", type: "connector", name: "企业微信", state: "not-installed" }
  ]);
  assert.equal(result.items[0].marketplaceAvailable, true);
  assert.equal(result.items[0].mcpRuntimeStatus, undefined);
  assert.equal(result.connectorOffline, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://market.example.test/api/v1/desktop/catalog");
  for (const header of ["Authorization", "Cookie", "X-Desktop-Device-Id"]) assert.equal(requests[0].headers.has(header), false);
  const empty = await listMarketItems(app, { catalog: { items: [] }, sections: ["connectors"] });
  assert.deepEqual(empty.items, []);
  assert.equal(readInstalledRecords(app)[0].id, "flowcenter");
});

test("foreign-platform connectors remain visible with incompatible status", async (t) => {
  const app = fixture(t);
  const foreignPlatform = process.platform === "win32" ? "darwin-arm64" : "windows-amd64";
  const result = await listMarketItems(app, {
    catalog: { items: [{ ...connector, assets: { [foreignPlatform]: { ...asset, platform: foreignPlatform } } }] },
    sections: ["connectors"]
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, connector.id);
  assert.equal(result.items[0].state, "incompatible");
  assert.ok(result.items[0].message);
});

test("connector actions cannot fall through to legacy MCP or skill installers", async (t) => {
  const app = fixture(t);
  const options = { catalog: { items: [connector] }, sections: ["connectors"] };
  for (const action of [installMarketItem, uninstallMarketItem]) {
    await assert.rejects(action(app, connector.id, options), /暂不可用|unavailable/i);
  }
  assert.deepEqual(readInstalledRecords(app), []);
});

test("connector catalog failures have their own section status", async (t) => {
  const app = fixture(t);
  const result = await listMarketItems(app, {
    apiBaseUrl: "https://market.example.test/api/v1", marketEnabled: true, sections: ["connectors"],
    fetchImpl: async () => new Response("temporarily unavailable", { status: 503 })
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.connectorOffline, true);
  assert.match(result.connectorMessage, /503/);
  assert.equal(result.mcpOffline, false);
});


test("Mac connectors accept darwin family assets while preserving the server platform key", () => {
  const {selectAsset}=require("../dist-electron/main/modules/marketplace/common.js");
  const intel={...asset,platform:"darwin-amd64"},arm={...asset,platform:"darwin-arm64"};
  const item={type:"connector",assets:{"darwin-amd64":intel}};
  assert.equal(selectAsset(item,"darwin","arm64").key,"darwin-amd64");
  assert.equal(selectAsset({...item,assets:{...item.assets,"darwin-arm64":arm}},"darwin","arm64").key,"darwin-arm64");
  assert.equal(selectAsset({...item,assets:{...item.assets,universal:asset}},"darwin","arm64").key,"universal");
  assert.equal(selectAsset(item,"win32","x64"),null);
  assert.equal(selectAsset(item,"linux","arm64"),null);
  assert.equal(selectAsset({...item,type:"plugin"},"darwin","arm64"),null);
  assert.equal(selectAsset({...item,assets:{darwin:asset}},"darwin","arm64").key,"darwin");
});
