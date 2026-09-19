import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// Execute the real host render, with effects and native surfaces stubbed out.
// Inspect guest-bearing item subtrees, not tab labels (which stay mounted).
function loadHost() {
  const source = fs.readFileSync(new URL("../src/renderer/work-panel/WorkPanelHost.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const noop = () => undefined;
  const stubs = new Proxy({}, { get: () => noop });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: module.exports, module,
    crypto: { randomUUID: () => "test-generation" },
    document: { documentElement: { dataset: { theme: "light" } } },
    require: (id) => {
      if (id === "react/jsx-runtime") return require(id);
      if (id === "react") return {
        lazy: () => "test-surface", Suspense: "test-suspense",
        useState: (value) => [typeof value === "function" ? value() : value, noop],
        useRef: (current) => ({ current }), useCallback: (value) => value,
        useEffect: noop, useLayoutEffect: noop,
      };
      if (id === "antd") return { Button: "button", Modal: { useModal: () => [{}, null] } };
      if (id.endsWith("/useI18n")) return { useI18n: () => ({ t: (key) => key }) };
      return stubs;
    },
  });
  return module.exports.WorkPanelHost;
}

const Host = loadHost();
function mountedItems(activeChatId, activeItemId, isMac) {
  const items = ["overview", "debug", "file"].map((module) => ({
    itemId: module, stableKey: module, title: module,
    descriptor: { kind: "webclient", module, route: "/test", context: { path: "draft.md" } },
  }));
  const tree = Host({
    activeChatId, isMac, isWindows: !isMac, fullscreenOwnerChatId: null,
    state: { workspaces: [{ workspaceId: "workspace-a", ownerChatId: "a", activeItemId, items }],
      review: { activeItemIdsByOwnerChatId: {} } },
    launcher: { webapps: [] }, dispatchCommand: () => {}, onFullscreenChange: async () => true,
  });
  const found = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node?.props) return;
    if (node.props["data-work-panel-item"]) found.push(node.props["data-work-panel-item"]);
    visit(node.props.children);
  }
  visit(tree);
  return found;
}

for (const isMac of [true, false]) {
  test(`${isMac ? "macOS" : "Windows"}: hidden observers unmount and reactivation recreates their subtree while documents stay`, () => {
    assert.deepEqual(mountedItems("a", "overview", isMac), ["overview", "file"]);
    assert.deepEqual(mountedItems(null, "overview", isMac), ["file"]);
    assert.deepEqual(mountedItems("b", "overview", isMac), ["file"]);
    assert.deepEqual(mountedItems("a", "overview", isMac), ["overview", "file"]);
    assert.deepEqual(mountedItems("a", "debug", isMac), ["debug", "file"]);
    assert.deepEqual(mountedItems("a", "file", isMac), ["file"]);
  });
}
