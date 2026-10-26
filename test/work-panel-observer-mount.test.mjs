import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// Execute the real host render, with effects and native surfaces stubbed out.
// Inspect guest-bearing item subtrees, not tab labels (which stay mounted).
function loadHost(onProvider = () => {}, stateful = false) {
  const slots = [];
  let cursor = 0;
  let uuid = 0;
  const source = fs.readFileSync(new URL("../src/renderer/work-panel/WorkPanelHost.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const noop = () => undefined;
  const stubs = new Proxy({}, { get: () => noop });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: module.exports, module,
    crypto: { randomUUID: () => `test-generation-${++uuid}` },
    document: { documentElement: { dataset: { theme: "light" } } },
    window: { electronAPI: { webs: { webapps: { listOpenWindows: async () => [] } } } },
    require: (id) => {
      if (id === "react/jsx-runtime") return require(id);
      if (id === "react") return {
        lazy: () => "test-surface", Suspense: "test-suspense",
        useState: (value) => {
          if (!stateful) return [typeof value === "function" ? value() : value, noop];
          const index = cursor++;
          if (!(index in slots)) slots[index] = typeof value === "function" ? value() : value;
          return [slots[index], update => { slots[index] = typeof update === "function" ? update(slots[index]) : update; }];
        },
        useRef: (current) => ({ current }), useCallback: (value) => value,
        useEffect: (effect) => { if (effect.toString().includes("registerDesktopActionProviderForScope")) effect(); }, useLayoutEffect: noop,
      };
      if (id === "antd") return { Button: "button", Modal: { useModal: () => [{}, null] } };
      if (id.endsWith("/useI18n")) return { useI18n: () => ({ t: (key) => key }) };
      if (id.endsWith("/work-panel")) return { isLocalDocumentDraftOwnerKey: (value) => /^file-draft:[^:]+:[1-9]\d{12}$/u.test(value) };
      if (id.endsWith("/desktopActionRegistry")) return { registerDesktopActionProviderForScope: (_scope, provider) => { onProvider(provider); return noop; } };
      return stubs;
    },
  });
  return (...args) => { cursor = 0; return module.exports.WorkPanelHost(...args); };
}

function findNodes(tree, predicate) {
  const found = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node?.props) return;
    if (predicate(node)) found.push(node);
    visit(node.props.children);
  };
  visit(tree);
  return found;
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

  test(`${isMac ? "macOS" : "Windows"}: file draft displays native previews without mounting backend Chat observers`, () => {
    const ownerKey = "file-draft:main:1791600000001";
    const items = [
      { itemId: "file-1", title: "one.html", descriptor: { kind: "native", surfaceKey: "local-document", context: { documentId: "doc-1" } } },
      { itemId: "overview", title: "overview", descriptor: { kind: "webclient", module: "overview", route: "/must-not-mount", context: {} } },
    ];
    const tree = Host({ activeChatId: null, activeOwnerKey: ownerKey, isMac, isWindows: !isMac, fullscreenOwnerChatId: null,
      state: { workspaces: [{ workspaceId: "stable-file-parent", ownerChatId: ownerKey, activeItemId: "file-1", items }], review: { activeItemIdsByOwnerChatId: {} } },
      launcher: { webapps: [] }, dispatchCommand: () => {}, onFullscreenChange: async () => true });
    const panels = findNodes(tree, node => node.props["data-work-panel-chat"]);
    assert.equal(panels[0].props.hidden, false);
    assert.equal(panels[0].key, "stable-file-parent");
    assert.deepEqual(findNodes(tree, node => node.props["data-work-panel-item"]).map(node => node.props["data-work-panel-item"]), ["file-1"]);
  });
}

test("global desktop WorkPanel actions reject local draft keys and resolve only the canonical source workspace", async () => {
  let provider;
  const ActionHost = loadHost(value => { provider = value; });
  const draftOwner = "file-draft:main:1791600000001";
  const draft = { workspaceId: "draft-parent", ownerChatId: draftOwner, activeItemId: null, items: [] };
  const canonical = { workspaceId: "real-parent", ownerChatId: "real-chat", activeItemId: null, items: [] };
  ActionHost({ activeChatId: null, activeOwnerKey: draftOwner, isMac: true, isWindows: false, fullscreenOwnerChatId: null,
    state: { workspaces: [draft, canonical], review: { activeItemIdsByOwnerChatId: {} } }, launcher: { webapps: [] },
    dispatchCommand: () => { throw Error("read-only state must not dispatch or create an Overview"); }, onFullscreenChange: async () => true });
  for (const action of ["desktop.workpanel.getState", "desktop.workpanel.openOverview", "desktop.workpanel.closeWorkpanel"]) {
    const result = await provider({ action, source: { chatId: draftOwner, agentKey: "main" }, args: {} });
    assert.equal(result.ok, false); assert.equal(result.error.code, "source_chat_required");
  }
  const result = await provider({ action: "desktop.workpanel.getState", source: { chatId: "real-chat", agentKey: "main" }, args: {} });
  assert.equal(result.ok, true); assert.equal(result.result.state, canonical);
});

for (const isMac of [true, false]) {
  test(`${isMac ? "macOS" : "Windows"}: launcher URL drafts survive tab and Chat switching independently`, () => {
    const StatefulHost = loadHost(() => {}, true);
    const commands = [];
    let openSucceeded = false;
    const props = {
      activeChatId: "a", isMac, isWindows: !isMac, fullscreenOwnerChatId: null,
      state: { workspaces: [{ workspaceId: "workspace-a", ownerChatId: "a", activeItemId: "overview", items: [
        { itemId: "overview", title: "Overview", descriptor: { kind: "webclient", module: "overview", route: "/overview", context: {} } },
      ] }], review: { activeItemIdsByOwnerChatId: {} } },
      launcher: { webapps: [] }, dispatchCommand: command => { commands.push(command); return { ok: openSucceeded }; }, onFullscreenChange: async () => true,
    };
    const render = () => StatefulHost(props);
    const launcher = tree => findNodes(tree, node => typeof node.props.onUrlDraftChange === "function")[0];
    const add = tree => findNodes(tree, node => node.props.className === "chat-work-panel-add-button")[0].props.onClick();
    add(render());
    launcher(render()).props.onUrlDraftChange("first.example/path");
    add(render());
    assert.equal(launcher(render()).props.urlDraft, "");
    launcher(render()).props.onUrlDraftChange("second.example/path");
    const tabs = findNodes(render(), node => node.props.title === "chatWorkPanel.newTab.title" && node.props.onActivate);
    tabs[0].props.onActivate();
    assert.equal(launcher(render()).props.urlDraft, "first.example/path");
    findNodes(render(), node => node.props.title === "Overview" && node.props.onActivate)[0].props.onActivate();
    assert.equal(launcher(render()), undefined);
    tabs[0].props.onActivate();
    assert.equal(launcher(render()).props.urlDraft, "first.example/path");
    props.activeChatId = "b";
    assert.equal(launcher(render()), undefined);
    props.activeChatId = "a";
    assert.equal(launcher(render()).props.urlDraft, "first.example/path");
    tabs[1].props.onActivate();
    assert.equal(launcher(render()).props.urlDraft, "second.example/path");
    assert.equal(tabs[1].props.closeShortcut, isMac ? "⌘W" : "Ctrl+W");
    tabs[1].props.onClose();
    assert.equal(launcher(render()), undefined);
    tabs[0].props.onActivate();
    assert.equal(launcher(render()).props.urlDraft, "first.example/path");
    launcher(render()).props.onOpenWeb("https://example.com/");
    assert.equal(launcher(render()).props.urlDraft, "first.example/path", "failed opens retain the launcher draft");
    openSucceeded = true;
    launcher(render()).props.onOpenWeb("https://example.com/");
    const opened = commands.at(-1);
    assert.equal(opened.webInstanceId, tabs[0].key);
    assert.equal(opened.descriptor.url, "https://example.com/");
    assert.equal(launcher(render()), undefined);
  });
}
