import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const jsx = require("react/jsx-runtime");

function harness(api) {
  const previous = globalThis.window;
  globalThis.window = { electronAPI: api, setTimeout: () => 1, clearTimeout() {} };
  const hooks = []; let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === "function" ? initial() : initial }; return [hooks[i].value, next => { hooks[i].value = typeof next === "function" ? next(hooks[i].value) : next; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useCallback(fn, deps) { const i = cursor++; const old = hooks[i]; if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return old.value; hooks[i] = { deps, value: fn }; return fn; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const i = cursor++; const old = hooks[i]; if (old && deps?.every((d, j) => Object.is(d, old.deps?.[j]))) return; old?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; },
  };
  const t = key => key;
  const source = fs.readFileSync(new URL("../src/renderer/pages/share-management/ShareManagementPage.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => name === "react" ? react : name === "react/jsx-runtime" ? jsx : name === "@ant-design/icons" ? new Proxy({}, { get: () => () => null }) : name.endsWith("useI18n") ? { useI18n: () => ({ t }) } : name.endsWith("time-contract") ? { formatEpochMillis: String } : assert.fail(name), module, module.exports);
  function render() { cursor = 0; return module.exports.ShareManagementPage({ tunnelHubEnabled: true, onOpenTunnelSettings() {}, onOpenChat() { assert.fail("missing source must not navigate"); } }); }
  function nodes(root) {
    if (!root || typeof root !== "object") return [];
    if (Array.isArray(root)) return root.flatMap(nodes);
    if (typeof root.type === "function") return nodes(root.type(root.props));
    return [root, ...nodes(root.props?.children)];
  }
  return { render, nodes, cleanup() { for (const hook of hooks) hook?.cleanup?.(); globalThis.window = previous; } };
}
const conversation = { id: "chat-share", kind: "conversation", title: "Frozen chat", source: { module: "conversation", id: "missing-local-chat" }, url: "https://hub.test/share/chat-share", createdAt: 2, lastAccessedAt: null };
const market = { id: "market-share", kind: "market-item", title: "Frozen market", source: { module: "marketplace", id: "item" }, url: "https://hub.test/share/market-share", createdAt: 1, lastAccessedAt: null };

test("mixed shares remain manageable without local chat history and use frozen titles", async () => {
  const copied = []; const revoked = []; let sourceLookups = 0;
  const page = harness({
    shares: { list: async () => ({ ok: true, records: [conversation, market] }), revoke: async id => { revoked.push(id); return { ok: true }; } },
    assistant: { listHistoryChats() { assert.fail("must not scan chat history"); }, getChatInfo: async () => { sourceLookups++; return null; } },
    clipboard: { writeText: async url => { copied.push(url); return { ok: true }; } },
  });
  try {
    page.render(); await new Promise(resolve => setImmediate(resolve));
    let nodes = page.nodes(page.render());
    assert.ok(nodes.some(node => node.type === "strong" && node.props.children === "Frozen chat"));
    assert.ok(nodes.some(node => node.type === "strong" && node.props.children === "Frozen market"));
    assert.equal(sourceLookups, 0);
    await nodes.find(node => node.type === "button" && node.props.className?.includes("open-chat-button")).props.onClick();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(sourceLookups, 1);
    nodes = page.nodes(page.render());
    await nodes.find(node => node.type === "button" && node.props["aria-live"] === "polite").props.onClick();
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(copied, [conversation.url]);
    nodes.find(node => node.key === market.id).props.onClick();
    nodes = page.nodes(page.render());
    assert.equal(nodes.some(node => node.props?.className?.includes("open-chat-button")), false);
    nodes.find(node => node.type === "button" && node.props.className === "share-management-button is-danger").props.onClick();
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(revoked, [market.id]);
    nodes = page.nodes(page.render());
    assert.equal(nodes.some(node => node.type === "strong" && node.props.children === "Frozen market"), false);
    assert.equal(nodes.some(node => node.props?.children === "sidebar.chat.shareExpiry"), false);
  } finally { page.cleanup(); }
});

test("refresh during a pending revoke does not retain a spinner or restore the revoked share", async () => {
  let finishRevoke; let finishRefresh; let loads = 0;
  const page = harness({ shares: {
    list: () => ++loads === 1 ? Promise.resolve({ ok: true, records: [conversation] }) : new Promise(resolve => { finishRefresh = resolve; }),
    revoke: () => new Promise(resolve => { finishRevoke = resolve; }),
  } });
  try {
    page.render(); await new Promise(resolve => setImmediate(resolve));
    let nodes = page.nodes(page.render());
    nodes.find(node => node.props?.className === "share-management-button is-danger").props.onClick();
    nodes = page.nodes(page.render());
    nodes.find(node => node.type === "button" && node.props.children === "common.refresh").props.onClick();
    finishRefresh({ ok: true, records: [conversation] }); await new Promise(resolve => setImmediate(resolve));
    finishRevoke({ ok: true }); await new Promise(resolve => setImmediate(resolve));
    nodes = page.nodes(page.render());
    assert.equal(nodes.some(node => node.props?.className === "share-management-button is-danger"), false);
    assert.ok(nodes.some(node => node.props?.children === "shareManagement.emptyTitle"));
  } finally { page.cleanup(); }
});
