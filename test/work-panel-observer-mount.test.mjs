import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sharedModules = new Map();

function loadSharedSource(name) {
  if (sharedModules.has(name)) return sharedModules.get(name);
  const source = fs.readFileSync(new URL(`../src/shared/${name}.ts`, import.meta.url), "utf8");
  const module = { exports: {} };
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } });
  vm.runInNewContext(outputText, {
    exports: module.exports, module, URL, URLSearchParams,
    require: id => loadSharedSource(id.replace(/^\.\//u, "")),
  });
  sharedModules.set(name, module.exports);
  return module.exports;
}

// Execute the real host render, with effects and native surfaces stubbed out.
// Inspect guest-bearing item subtrees, not tab labels (which stay mounted).
function loadHost(onProvider = () => {}, stateful = false, electronAPI = {}) {
  const slots = [];
  let cursor = 0;
  let uuid = 0;
  let selectedNewTabs = {};
  const setSelectedNewTabs = update => {
    selectedNewTabs = typeof update === "function" ? update(selectedNewTabs) : update;
  };
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
    window: { electronAPI: { webs: { webapps: { listOpenWindows: async () => [] } }, ...electronAPI } },
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
        useRef: (current) => {
          if (!stateful) return { current };
          const index = cursor++;
          if (!(index in slots)) slots[index] = { current };
          return slots[index];
        }, useCallback: (value) => value,
        useEffect: (effect) => { if (effect.toString().includes("registerDesktopActionProviderForScope")) effect(); }, useLayoutEffect: noop,
      };
      if (id === "antd") return { Button: "button", Modal: { useModal: () => [{}, null] } };
      if (id.endsWith("/useI18n")) return { useI18n: () => ({ t: (key) => key }) };
      if (id.endsWith("/agent-webclient-routes")) return loadSharedSource("agent-webclient-routes");
      if (id.endsWith("/new-tab-selection")) return loadSharedSource("../renderer/work-panel/new-tab-selection");
      if (id.endsWith("/work-panel")) return { isLocalDocumentDraftOwnerKey: (value) => /^file-draft:[^:]+:[1-9]\d{12}$/u.test(value) };
      if (id.endsWith("/desktopActionRegistry")) return { registerDesktopActionProviderForScope: (_scope, provider) => { onProvider(provider); return noop; } };
      return stubs;
    },
  });
  return props => {
    cursor = 0;
    return module.exports.WorkPanelHost({ selectedNewTabs, setSelectedNewTabs, ...props });
  };
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

function createLauncherScene(isMac, { electronAPI, launcher: launcherOverrides, ownerChatId = "a" } = {}) {
  const StatefulHost = loadHost(() => {}, true, electronAPI);
  const commands = [];
  const props = {
    activeChatId: ownerChatId, isMac, isWindows: !isMac, fullscreenOwnerChatId: null,
    selectedNewTabs: {},
    setSelectedNewTabs: update => {
      props.selectedNewTabs = typeof update === "function" ? update(props.selectedNewTabs) : update;
    },
    state: { workspaces: [ownerChatId, "b"].map(owner => ({
      workspaceId: `workspace-${owner}`, ownerChatId: owner, activeItemId: "overview", items: [
        { itemId: "overview", title: "Overview", descriptor: { kind: "webclient", module: "overview", route: "/overview", context: {} } },
      ],
    })), review: { activeItemIdsByOwnerChatId: {} } },
    launcher: { agentKey: "main", projectVisible: true, projectEnabled: true, webapps: [],
      onOpenWebapp: async () => true, onFocusWebappWindow: async () => true, ...launcherOverrides },
    dispatchCommand: command => { commands.push(command); return { ok: true }; },
    onFullscreenChange: async () => true,
  };
  const render = () => StatefulHost(props);
  const panel = owner => findNodes(render(), node => node.props["data-work-panel-chat"] === owner)[0];
  const tabs = (owner = props.activeChatId) => findNodes(panel(owner), node => node.props.title === "chatWorkPanel.newTab.title" && node.props.onActivate);
  const launcher = () => findNodes(render(), node => typeof node.props.onUrlDraftChange === "function")[0];
  const add = (draft = "") => {
    findNodes(panel(props.activeChatId), node => node.props.className === "chat-work-panel-add-button")[0].props.onClick();
    launcher().props.onUrlDraftChange(draft);
    return launcher().key;
  };
  const select = (id, owner = props.activeChatId) => {
    tabs(owner).find(tab => tab.key === id).props.onActivate();
    render();
  };
  return { props, commands, render, launcher, add, select, tabKeys: owner => tabs(owner).map(tab => tab.key) };
}

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve));

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

  test(`${isMac ? "macOS" : "Windows"}: side chat and project consume only the successful originating launcher`, () => {
    for (const [action, module, route] of [["onOpenSideChat", "btw", "/btw/a"], ["onOpenProject", "project", "/project/main?chatId=a"]]) {
      const scene = createLauncherScene(isMac);
      const first = scene.add("first.example/path");
      const second = scene.add("second.example/path");
      scene.select(first);
      scene.props.dispatchCommand = () => ({ ok: false });
      scene.launcher().props[action]();
      assert.deepEqual(scene.tabKeys(), [first, second], `${module}: rejected open keeps both launchers`);
      assert.equal(scene.launcher().props.urlDraft, "first.example/path");
      scene.props.dispatchCommand = command => { scene.commands.push(command); return { ok: true }; };
      scene.launcher().props[action]();
      assert.deepEqual(scene.tabKeys(), [second], `${module}: successful open removes the originating tab`);
      assert.equal(scene.launcher(), undefined);
      assert.equal(scene.commands[0].ownerChatId, "a");
      assert.equal(scene.commands[0].descriptor.module, module);
      assert.equal(scene.commands[0].descriptor.route, route);
      scene.select(second);
      assert.equal(scene.launcher().props.urlDraft, "second.example/path");
    }
    for (const [action, guard] of [["onOpenProject", { projectEnabled: false }], ["onOpenProject", { agentKey: "" }], ["onOpenSideChat", { agentKey: "" }]]) {
      const scene = createLauncherScene(isMac, { launcher: guard });
      const id = scene.add("keep.example");
      scene.launcher().props[action]();
      assert.deepEqual(scene.tabKeys(), [id]);
      assert.equal(scene.launcher().props.urlDraft, "keep.example");
      assert.equal(scene.commands.length, 0, "unavailable tools cannot consume a launcher");
    }
  });

  test(`${isMac ? "macOS" : "Windows"}: file cancellation, empty selections, failures and rejected opens retain the launcher`, async () => {
    const file = { handleId: "file-handle", fileName: "notes.md", previewKind: "text" };
    for (const [result, dispatchOk] of [[{ ok: false, files: [] }, true], [{ ok: true, files: [] }, true], [{ ok: true, files: [file] }, false]]) {
      const scene = createLauncherScene(isMac, { electronAPI: { chatWorkPanel: { localFiles: { select: async () => result } } } });
      const id = scene.add("keep.example");
      scene.props.dispatchCommand = () => ({ ok: dispatchOk });
      await scene.launcher().props.onOpenFiles();
      assert.deepEqual(scene.tabKeys(), [id]);
      assert.equal(scene.launcher().props.urlDraft, "keep.example");
    }
    const scene = createLauncherScene(isMac, { electronAPI: { chatWorkPanel: { localFiles: { select: async () => { throw new Error("picker failed"); } } } } });
    const id = scene.add("keep.example");
    await assert.rejects(scene.launcher().props.onOpenFiles(), /picker failed/u);
    assert.deepEqual(scene.tabKeys(), [id]);
    assert.equal(scene.launcher().props.urlDraft, "keep.example");
  });

  test(`${isMac ? "macOS" : "Windows"}: delayed file selection removes its source without touching a newer launcher or Chat`, async () => {
    const selection = deferred();
    const scene = createLauncherScene(isMac, { electronAPI: { chatWorkPanel: { localFiles: { select: () => selection.promise } } } });
    const first = scene.add("first.example");
    const pending = scene.launcher().props.onOpenFiles();
    const second = scene.add("second.example");
    scene.props.activeChatId = "b";
    const otherChat = scene.add("other-chat.example");
    selection.resolve({ ok: true, files: [
      { handleId: "one", fileName: "one.md", previewKind: "text" },
      { handleId: "two", fileName: "two.html", previewKind: "html" },
    ] });
    await pending;
    assert.deepEqual(scene.tabKeys("a"), [second]);
    assert.ok(!scene.tabKeys("a").includes(first));
    assert.deepEqual(scene.tabKeys("b"), [otherChat]);
    assert.equal(scene.launcher().props.urlDraft, "other-chat.example");
    assert.deepEqual(scene.commands.map(command => command.ownerChatId), ["a", "a"]);
    assert.deepEqual(scene.commands.map(command => command.descriptor.handleId), ["one", "two"]);
    scene.props.activeChatId = "a";
    assert.equal(scene.launcher().props.urlDraft, "second.example");
  });

  test(`${isMac ? "macOS" : "Windows"}: local document selection consumes a launcher only when a document actually opens`, async () => {
    for (const [ok, before, after, consumed] of [[true, 4, 4, false], [false, 4, 5, false], [true, 4, 5, true]]) {
      const revisions = [before, after];
      const scene = createLauncherScene(isMac, { ownerChatId: "file-draft:main:1791600000001", electronAPI: { localDocuments: {
        getState: async () => ({ openRevision: revisions.shift() }), select: async () => ({ ok }),
      } } });
      const id = scene.add("local-draft");
      await scene.launcher().props.onOpenFiles();
      assert.deepEqual(scene.tabKeys(), consumed ? [] : [id]);
      if (!consumed) assert.equal(scene.launcher().props.urlDraft, "local-draft");
    }
  });

  test(`${isMac ? "macOS" : "Windows"}: WebApp open and existing-window focus consume launchers only on success`, async () => {
    for (const floating of [false, true]) {
      for (const result of [false, true, "reject"]) {
        const calls = [];
        const open = async (...args) => {
          calls.push(args);
          if (result === "reject") throw new Error("WebApp failed");
          return result;
        };
        const scene = createLauncherScene(isMac, { electronAPI: { webs: { webapps: { listOpenWindows: async () => floating ? ["docs"] : [] } } }, launcher: {
          onOpenWebapp: (...args) => { assert.equal(floating, false); return open(...args); },
          onFocusWebappWindow: (...args) => { assert.equal(floating, true); return open(...args); },
        } });
        const id = scene.add("keep.example");
        await flushAsync();
        scene.launcher().props.onOpenWebapp({ id: "docs", label: "Docs" });
        await flushAsync();
        assert.deepEqual(scene.tabKeys(), result === true ? [] : [id]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], floating ? "docs" : "a");
        if (result !== true) assert.equal(scene.launcher().props.urlDraft, "keep.example");
      }
    }
  });

  test(`${isMac ? "macOS" : "Windows"}: delayed WebApp success preserves the newly selected launcher and its draft`, async () => {
    const opening = deferred();
    const scene = createLauncherScene(isMac, { launcher: { onOpenWebapp: () => opening.promise } });
    const first = scene.add("first.example");
    scene.launcher().props.onOpenWebapp({ id: "docs", label: "Docs" });
    const second = scene.add("second.example");
    opening.resolve(true);
    await flushAsync();
    assert.deepEqual(scene.tabKeys(), [second]);
    assert.ok(!scene.tabKeys().includes(first));
    assert.equal(scene.launcher().props.urlDraft, "second.example");
  });

  test(`${isMac ? "macOS" : "Windows"}: shared launcher selection hides and restores an active WebApp item`, () => {
    const { isWorkPanelNewTabActive } = loadSharedSource("../renderer/work-panel/new-tab-selection");
    const scene = createLauncherScene(isMac);
    const workspace = scene.props.state.workspaces[0];
    workspace.items.push({ itemId: "webapp", stableKey: "webapp-docs", title: "Docs",
      descriptor: { kind: "webapp-ref", webappId: "docs", title: "Docs" } });
    workspace.activeItemId = "webapp";
    const assertWebappVisible = expected => {
      const tree = scene.render();
      const body = findNodes(tree, node => node.props["data-work-panel-owner"] === "a" && node.props["data-work-panel-item"] === "webapp")[0];
      const tab = findNodes(tree, node => node.props.title === "Docs" && node.props.onActivate)[0];
      assert.equal(body.props["data-work-panel-active"], String(expected));
      assert.equal(body.props.hidden, !expected);
      assert.equal(tab.props.active, expected);
      assert.equal(isWorkPanelNewTabActive(scene.props.selectedNewTabs.a, workspace.activeItemId), !expected);
    };
    assertWebappVisible(true);
    const first = scene.add("first.example");
    assert.equal(scene.props.selectedNewTabs.a.id, first, "the parent receives the launcher identity");
    assert.equal(scene.props.selectedNewTabs.a.anchor, "webapp");
    assertWebappVisible(false);
    assert.equal(scene.launcher().key, first);
    const second = scene.add("second.example");
    assert.equal(scene.props.selectedNewTabs.a.id, second);
    findNodes(scene.render(), node => node.key === first && node.props.onClose)[0].props.onClose();
    assert.equal(scene.props.selectedNewTabs.a.id, second, "closing another launcher preserves the shared selection");
    assertWebappVisible(false);
    findNodes(scene.render(), node => node.props.title === "Docs" && node.props.onActivate)[0].props.onActivate();
    assert.equal(scene.props.selectedNewTabs.a, undefined);
    assert.equal(scene.launcher(), undefined);
    assertWebappVisible(true);
    scene.select(second);
    assert.equal(scene.props.selectedNewTabs.a.id, second);
    assert.equal(scene.launcher().props.urlDraft, "second.example");
    assertWebappVisible(false);
    findNodes(scene.render(), node => node.key === second && node.props.onClose)[0].props.onClose();
    assert.equal(scene.props.selectedNewTabs.a, undefined);
    assert.equal(scene.launcher(), undefined);
    assertWebappVisible(true);
    assert.deepEqual(scene.tabKeys(), []);
  });
}
