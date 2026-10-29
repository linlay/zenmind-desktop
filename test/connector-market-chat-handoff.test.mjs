import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const routes = require("../dist-electron/shared/agent-webclient-routes.js");
const source = fs.readFileSync(new URL("../src/renderer/pages/functional-market/ConnectorMarketplace.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function setup(extraProps = {}, previousDetail = null) {
  const navigated = [], captured = {};
  let stateIndex = 0;
  const runtime = { getConnectorId: () => "wecom-cli-connector", getConnection: () => null, isInstalled: () => false, flow: null, busy: false, error: "" };
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(code, { module, exports: module.exports, URLSearchParams, Date,
    require: name => {
      if (name === "react") return {
        useState: value => [stateIndex++ === 4 ? previousDetail : value, () => {}], useMemo: compute => compute(),
        useRef: value => ({ current: value }), useEffect: () => {},
      };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react-router-dom") return { useNavigate: () => route => navigated.push(route) };
      if (name.endsWith("agent-webclient-routes")) return routes;
      if (name.endsWith("useI18n")) return { useI18n: () => ({ t: key => key }) };
      if (name === "./useMarketConnectorFlow") return { useMarketConnectorFlow: (_, onChat) => { captured.onChat = onChat; return runtime; } };
      if (name === "./marketPageModel") return { getMarketTabDefinitions: () => [], matchesMarketItemQuery: () => true };
      if (name === "./connectorFlow") return { connectorIsUsable: () => true };
      if (name === "./connectorPresentation") return { connectorPresentation: () => ({ labelKey: "state", tone: "idle" }) };
      if (name === "./marketShareSelection") {
        const selection = { exports: {} };
        const selectionCode = ts.transpileModule(fs.readFileSync(new URL("../src/renderer/pages/functional-market/marketShareSelection.ts", import.meta.url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        new Function("module", "exports", selectionCode)(selection, selection.exports);
        return selection.exports;
      }
      const symbol = name.split("/").at(-1);
      return new Proxy({}, { get: (_, key) => key === "__esModule" ? false : key === "default" ? symbol : String(key) });
    } });
  const tree = module.exports.ConnectorMarketplace({ items: [], loading: false, feedback: null,
    onTabChange() {}, onManage() {}, ...extraProps });
  function find(node, type) {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean);
    if (node.type === type) return node;
    return find(node.props?.children, type);
  }
  return { navigated, onChat: captured.onChat, detail: find(tree, "ConnectorDetailDialog") };
}

test("all market connector Chat actions explicitly replace the new Chat Composer intent", () => {
  const { navigated, onChat } = setup();
  for (const draft of [undefined, "我想使用「企业微信」查询 A & B？"]) {
    onChat("cutej", draft);
    const route = new URL(navigated.at(-1), "http://desktop.invalid");
    assert.equal(route.pathname, "/agent/cutej");
    assert.match(route.searchParams.get("newChat"), /^[1-9]\d{12}$/u);
    assert.equal(route.searchParams.has("composerDraft"), true);
    assert.equal(route.searchParams.get("composerDraft"), draft ?? "");
    assert.equal(route.searchParams.has("composerSkill"), false);
  }
});

test("a new share target never exposes the previous detail while page effects are pending", () => {
  const item = { id: "new-connector", type: "connector", version: "2.0.0", source: "cloud", marketplaceAvailable: true, name: "Current name" };
  const context = { itemId: item.id, resourceType: "connector", resourceVersion: item.version,
    display: { name: "Frozen name", description: "Frozen description", author: "", tags: [] } };
  const previous = { ...item, id: "previous-connector", version: "1.0.0" };
  const { detail } = setup({ items: [item], shareTarget: { intentId: "new-intent", shareId: "new-share", context } }, previous);
  assert.equal(detail.props.item.id, item.id);
  assert.equal(detail.props.item.name, "Frozen name");
  const unavailable = setup({ items: [], shareTarget: { intentId: "new-intent", shareId: "new-share", context } }, previous);
  assert.equal(unavailable.detail.props.item, null);
});

test("market configuration targets the runtime package alias rather than the distribution ID", () => {
  const { detail, navigated } = setup();
  assert.ok(detail);
  detail.props.onConfigure({ id: "market-wecom", connectorId: "market-wecom", name: "企业微信" });
  assert.deepEqual(navigated, ["/connectors/wecom-cli-connector"]);
});
