import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
const jsx = require("react/jsx-runtime");
const t = (key, params) => params ? key + " " + Object.values(params).join(" ") : key;
function unit(name, dependencies = {}) {
  const source = fs.readFileSync(new URL("../src/renderer/pages/functional-market/" + name, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(specifier => {
    if (specifier in dependencies) return dependencies[specifier];
    if (specifier === "react/jsx-runtime") return jsx;
    if (specifier === "antd") return { Alert: "Alert", Modal: "Modal", Tag: "Tag", Button: "Button" };
    if (specifier.endsWith("useI18n")) return { useI18n: () => ({ t }) };
    if (specifier.endsWith(".css")) return {};
    if (specifier === "@ant-design/icons") return new Proxy({}, { get: () => () => null });
    assert.fail(specifier);
  }, module, module.exports);
  return module.exports;
}
function nodes(root) {
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (typeof root.type === "function") return nodes(root.type(root.props));
  return [root, ...nodes(root.props?.children)];
}
const context = { itemId: "office", resourceType: "connector", resourceVersion: "1.2.3", display: { name: "Frozen office", description: "Frozen details", author: "Publisher", tags: ["mcp"] } };
const current = { id: "office", type: "connector", version: "1.2.3", name: "Current title", description: "Current details", author: "Publisher", tags: [], source: "cloud", marketplaceAvailable: true, state: "update-available", installedVersion: "1.0.0" };

test("current and historical catalog contracts select only the exact visible version, preserving frozen display", () => {
  const { sharedMarketItem } = unit("marketShareSelection.ts");
  const matched = sharedMarketItem([current], context);
  assert.equal(matched.name, "Frozen office"); assert.equal(matched.description, "Frozen details");
  assert.equal(matched.version, context.resourceVersion); assert.equal(matched.state, "update-available");
  assert.equal(current.name, "Current title");
  for (const changed of [{ version: "2.0.0" }, { id: "other" }, { type: "mcp" }, { source: "local" }, { marketplaceAvailable: false }]) {
    assert.equal(sharedMarketItem([{ ...current, ...changed }], context), null);
  }
  assert.equal(sharedMarketItem([], context), null);
  assert.equal(sharedMarketItem([{ ...current, version: "2.0.0" }, current], context).version, "1.2.3");
});

test("unavailable-version details show frozen and current versions separately without business actions", () => {
  const { MarketSharedDetailDialog } = unit("MarketSharedDetailDialog.tsx");
  const tree = MarketSharedDetailDialog({ context, loading: false, currentVersion: "2.0.0", onClose() {} });
  const all = nodes(tree);
  assert.equal(tree.props.footer, null); assert.equal(all.some(node => node.type === "Button"), false);
  assert.ok(all.some(node => node.type === "Alert" && node.props.message === "market.share.unavailable"));
  assert.ok(all.some(node => node.props?.children === "market.share.currentVersion 2.0.0"));
  assert.ok(all.some(node => node.props?.children === "Frozen details"));
});

test("received details cannot run a different installed version; exact-version update remains in the original flow", () => {
  const flow = unit("connectorFlow.ts");
  const { ConnectorDetailDialog } = unit("ConnectorDetailDialog.tsx", {
    "./ConnectorIcon": { ConnectorIcon: () => null }, "./connectorFlow": flow,
    "./connectorPresentation": { connectorPresentation: () => ({ labelKey: "state", tone: "success", tagColor: "success" }) },
    "react-markdown": () => null, "remark-gfm": () => null,
    "../../components/BrandMark": { BrandMark: () => null }, "../../../shared/brand": { PRODUCT_NAME: "Test" },
  });
  let starts = 0, updates = 0, shares = 0;
  const connection = { connectorId: "office", configured: false, configurationRequired: false, readiness: "no_auth", authentication: { status: "no_auth" }, capabilities: { authMode: "none", canConnect: false, canCheck: false } };
  const runtime = { busy: false, loading: false, stateError: "", flow: null, getConnection: () => connection, isInstalled: () => true, getError: () => "", start: () => starts++, mutate: () => updates++ };
  const props = { item: current, runtime, sharedVersion: "1.2.3", onClose() {}, onDisconnect() {}, onConfigure() {}, onShare() { shares++; } };
  let all = nodes(ConnectorDetailDialog(props));
  const toolbar = all.find(node => node.props?.className === "connector-detail-toolbar");
  assert.ok(nodes(toolbar).some(node => node.props?.className === "connector-detail-version" && node.props.children === "market.share.version 1.2.3"));
  const share = nodes(toolbar).find(node => node.type === "Button" && node.props["aria-label"] === "market.share.action");
  assert.equal(share.props.disabled, false); share.props.onClick(); assert.equal(shares, 1);
  assert.equal(nodes(all.find(node => node.type === "header")).some(node => node === share), false);
  const regular = nodes(ConnectorDetailDialog({ ...props, sharedVersion: undefined }));
  assert.ok(regular.some(node => node.props?.className === "connector-detail-version" && node.props.children === "v1.2.3"));
  const busy = nodes(ConnectorDetailDialog({ ...props, runtime: { ...runtime, busy: true } }));
  assert.equal(busy.find(node => node.type === "Button" && node.props["aria-label"] === "market.share.action").props.disabled, true);
  const primary = all.find(node => node.type === "Button" && node.props.type === "primary");
  assert.equal(primary.props.disabled, true); assert.equal(starts, 0); assert.equal(updates, 0);
  const update = all.find(node => node.type === "Button" && Array.isArray(node.props.children) && node.props.children.includes("market.action.update"));
  assert.equal(update.props.disabled, false); update.props.onClick(); assert.equal(updates, 1);
  all = nodes(ConnectorDetailDialog({ ...props, item: { ...current, installedVersion: "1.2.3", state: "installed" } }));
  assert.equal(all.find(node => node.type === "Button" && node.props.type === "primary").props.disabled, false);
});
