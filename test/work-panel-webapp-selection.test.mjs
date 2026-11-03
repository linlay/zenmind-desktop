import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function loadRenderer(relativePath) {
  const source = fs.readFileSync(new URL(`../src/renderer/${relativePath}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: module.exports, module,
    require: id => {
      if (id === "react/jsx-runtime") return require(id);
      if (id === "react") return { lazy: () => "guest", Suspense: "suspense" };
      return {};
    },
  });
  return module.exports;
}

const { resolveWorkPanelActiveItemId } = loadRenderer("work-panel/new-tab-selection.ts");
const { CanonicalWebappSurfaceHost } = loadRenderer("app-shell/embedded-surfaces/EmbeddedSurfaceHosts.tsx");
const workspace = { ownerChatId: "chat-a", activeItemId: "app-item" };

test("launcher selection overrides only its own workspace and matching content anchor", () => {
  assert.equal(resolveWorkPanelActiveItemId(workspace, {}), "app-item");
  assert.equal(resolveWorkPanelActiveItemId(workspace, { "chat-a": { id: "new", anchor: "app-item" } }), null);
  assert.equal(resolveWorkPanelActiveItemId(workspace, { "chat-a": { id: "stale", anchor: "previous-item" } }), "app-item");
  assert.equal(resolveWorkPanelActiveItemId(workspace, { "chat-b": { id: "new", anchor: "app-item" } }), "app-item");
  assert.equal(resolveWorkPanelActiveItemId(undefined, {}), null);
});

function surfaces(props = {}) {
  const tree = CanonicalWebappSurfaceHost({
    activeEntryKey: "webapp:main",
    itemMap: new Map([
      ["webapp:panel", { id: "panel", kind: "webapp", label: "Panel app", url: "http://127.0.0.1:3000/" }],
      ["webapp:other", { id: "other", kind: "webapp", label: "Other Chat app", url: "http://127.0.0.1:3001/" }],
      ["webapp:main", { id: "main", kind: "webapp", label: "Main app", url: "http://127.0.0.1:3002/" }],
    ]),
    mountedEntryKeys: ["webapp:panel", "webapp:other", "webapp:main"],
    presentations: {
      panel: { scope: "workpanel", ownerChatId: "chat-a", itemId: "app-item" },
      other: { scope: "workpanel", ownerChatId: "chat-b", itemId: "app-item" },
      main: { scope: "main-workspace" },
    },
    activeWorkPanelChatId: "chat-a", workPanelVisible: true, activeWorkPanelItemId: "app-item",
    ...props,
  });
  return tree.props.children.props.children;
}

test("canonical WebApp visibility follows effective content selection without replacing its guest key", () => {
  const active = surfaces();
  const launcher = surfaces({ activeWorkPanelItemId: resolveWorkPanelActiveItemId(workspace, {
    "chat-a": { id: "new", anchor: "app-item" },
  }) });
  const restored = surfaces({ activeWorkPanelItemId: resolveWorkPanelActiveItemId(workspace, {}) });
  assert.equal(active[0].props.active, true);
  assert.equal(launcher[0].props.active, false, "a selected launcher must deactivate the overlay, not merely hide a tab label");
  assert.equal(restored[0].props.active, true);
  assert.equal(active[0].key, launcher[0].key);
  assert.equal(launcher[0].key, restored[0].key);
  assert.equal(launcher[1].props.active, false, "same item ID in another Chat cannot activate its WebApp");
  assert.equal(launcher[2].props.active, true, "main-workspace presentation keeps its independent route selection");
  assert.equal(surfaces({ workPanelVisible: false })[0].props.active, false);
  assert.equal(surfaces({ activeWorkPanelItemId: "file-item" })[0].props.active, false);
});
