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

function setup() {
  const navigated = [], captured = {};
  const runtime = { getConnectorId: () => "wecom-cli-connector", flow: null, busy: false, error: "" };
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(code, { module, exports: module.exports, URLSearchParams, Date,
    require: name => {
      if (name === "react") return { useState: value => [value, () => {}] };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react-router-dom") return { useNavigate: () => route => navigated.push(route) };
      if (name.endsWith("agent-webclient-routes")) return routes;
      if (name.endsWith("useI18n")) return { useI18n: () => ({ t: key => key }) };
      if (name === "./useMarketConnectorFlow") return { useMarketConnectorFlow: (_, onChat) => { captured.onChat = onChat; return runtime; } };
      if (name === "./marketPageModel") return { getMarketTabDefinitions: () => [], matchesMarketItemQuery: () => true };
      if (name === "./connectorFlow") return { connectorIsUsable: () => true };
      const symbol = name.split("/").at(-1);
      return new Proxy({}, { get: (_, key) => key === "__esModule" ? false : key === "default" ? symbol : String(key) });
    } });
  const tree = module.exports.ConnectorMarketplace({ items: [], loading: false, feedback: null,
    onTabChange() {}, onManage() {} });
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

test("market configuration targets the runtime package alias rather than the distribution ID", () => {
  const { detail, navigated } = setup();
  assert.ok(detail);
  detail.props.onConfigure({ id: "market-wecom", connectorId: "market-wecom", name: "企业微信" });
  assert.deepEqual(navigated, ["/connectors/wecom-cli-connector"]);
});
