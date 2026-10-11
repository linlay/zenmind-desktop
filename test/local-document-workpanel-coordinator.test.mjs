import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import { build } from "esbuild";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const require = createRequire(import.meta.url);
const brand = runtimeBrandPayload(loadBrandConfig(process.cwd(), resolveBrandId()));
const built = await build({
  stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    export * from './src/renderer/work-panel/useLocalDocumentsWorkPanel';
    export { EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand } from './src/shared/work-panel';
    export { CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL } from './src/shared/chat-work-panel';
    export { createAgentWebclientRoute } from './src/shared/agent-webclient-routes';
    export { localDocumentOwnerKey } from './src/shared/local-document';
    export { createCanonicalAgentChatRoute } from './src/shared/canonical-chat-sync';
    export { createMainWindowActivationController } from './src/main/modules/shell/main-window-activation';
  ` },
  bundle: true, platform: "node", format: "cjs", write: false,
  define: { __DESKTOP_APP_BRAND__: JSON.stringify(brand) },
  plugins: [{ name: "hook-scheduler", setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents:
      "export const useRef=v=>globalThis.coordinatorHooks.useRef(v); export const useEffect=(f,d)=>globalThis.coordinatorHooks.useEffect(f,d);" }));
  } }],
});
const module = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(module, module.exports, require);
const { useLocalDocumentsWorkPanel, EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand, CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL, createAgentWebclientRoute,
  localDocumentRoute, localDocumentOwnerKey, localDocumentWorkPanelOwnerForRoute, createMainWindowActivationController } = module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function installRealCanonicalAckEffect(context) {
  const ts = require("typescript");
  const source = ts.createSourceFile("ServiceWebviewSurface.tsx", readFileSync(new URL("../src/renderer/service-webview/ServiceWebviewSurface.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" &&
        node.arguments[0]?.getText(source).includes("canonicalChatSync.onRequest")) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(effect, "execute the real canonical ACK effect");
  const declarations = Object.keys(context).join(",");
  const { outputText } = ts.transpileModule(`const {${declarations}} = context; const effect = ${effect.getText(source)}; effect();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  new Function("context", outputText)(context);
}

function runRealSystemDocumentCloseEffect(state, previousSystemDocumentIdsRef) {
  const ts = require("typescript");
  const source = ts.createSourceFile("WorkPanelHost.tsx", readFileSync(new URL("../src/renderer/work-panel/WorkPanelHost.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" &&
        node.arguments[0]?.getText(source).includes("previousSystemDocumentIdsRef.current = nextDocumentIds")) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(effect, "execute the real Host removal-to-Main close effect");
  const { outputText } = ts.transpileModule(`const {state, previousSystemDocumentIdsRef} = context; (${effect.getText(source)})();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  new Function("context", outputText)({ state, previousSystemDocumentIdsRef });
}

function documentItem(index, handle = index, version = 0, ownerChatId = "chat-edit", fileName = `文件${index}.html`) {
  const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  return {
    documentId: uuid(index), fileName, kind: /\.(?:md|markdown)$/i.test(fileName) ? "markdown" : "html", ownerChatId, agentKey: "main",
    url: `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}://${uuid(handle)}/${encodeURIComponent(fileName)}`,
    partition: `local-document-${uuid(handle)}`, version,
  };
}

function draftDocument(index, newChat = "1791600000001", fileName = `文件${index}.html`) {
  return { ...documentItem(index, index, 0, "", fileName), newChat };
}

function harness(t, documents = [documentItem(1)]) {
  const previousWindow = globalThis.window;
  const slots = []; let cursor = 0; let effects = [];
  const calls = { bind: [], navigate: [], commands: [], commits: [], errors: 0 };
  const route = localDocumentRoute(documents.at(-1));
  const stateRef = { current: structuredClone(EMPTY_WORK_PANEL_STATE) };
  const options = {
    state: { revision: 1, openRevision: 1, documents, activeDocumentId: documents.at(-1).documentId },
    currentRoute: "/other", committed: null, committedRoute: "", workPanelStateRef: stateRef,
    commitState: state => { calls.commits.push(state); stateRef.current = state; },
    dispatchCommand: command => { calls.commands.push(command); const result = reduceWorkPanelCommand(stateRef.current, command); stateRef.current = result.nextState; return result; },
    navigate: target => calls.navigate.push(target), onError: () => calls.errors++,
  };
  const api = {
    bind: async request => { calls.bind.push(request); return { ok: true, document: options.state.documents.find(item => item.documentId === request.documentId) }; },
  };
  globalThis.window = { electronAPI: { localDocuments: api } };
  globalThis.coordinatorHooks = {
    useRef(value) { const slot = cursor++; return slots[slot] ??= { current: value }; },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
    },
  };
  const render = changes => {
    Object.assign(options, changes); cursor = 0; effects = [];
    useLocalDocumentsWorkPanel(options);
    for (const effect of effects) effect();
  };
  const ready = (document = documents.at(-1)) => {
    const target = localDocumentRoute(document);
    render({ currentRoute: target, committedRoute: target,
      committed: { registrationId: "main-registration", webContentsId: 42, revision: 1,
        identity: document.ownerChatId
          ? { kind: "canonical", agentKey: document.agentKey, chatId: document.ownerChatId }
          : { kind: "new", agentKey: document.agentKey, newChat: document.newChat } } });
  };
  t.after(() => { slots.forEach(slot => slot?.cleanup?.()); globalThis.window = previousWindow; delete globalThis.coordinatorHooks; });
  return { calls, api, route, stateRef, options, render, ready };
}

test("OS open waits for the canonical Chat and shows its files without preparing or inserting a prompt", async t => {
  const fixture = harness(t, [documentItem(1), documentItem(2)]);
  fixture.render(); await tick();
  assert.deepEqual(fixture.calls.navigate, []); assert.equal(fixture.calls.bind.length, 0);
  fixture.ready(); await tick();
  assert.equal(fixture.calls.bind.length, 2);
  assert.ok(fixture.calls.bind.every(call => call.ownerChatId === "chat-edit" && call.rendererGeneration));
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.equal(workspace.items.length, 2);
  assert.equal(workspace.items.find(item => item.itemId === workspace.activeItemId).descriptor.context.documentId, documentItem(2).documentId);
  assert.deepEqual(fixture.stateRef.current.visibleOwnerChatIds, ["chat-edit"]);
  fixture.render({ state: { ...fixture.options.state, revision: 2, openRevision: 2 } }); await tick();
  assert.equal(fixture.calls.bind.length, 2);
});

test("renderer bootstrap restores the current Chat without replaying the last global OS-open navigation", async t => {
  const first = documentItem(1, 1, 0, "chat-a");
  const second = documentItem(2, 2, 0, "chat-a", "恢复.md");
  const other = documentItem(3, 3, 0, "chat-b");
  const fixture = harness(t, [first, second, other]);
  fixture.render({ currentRoute: localDocumentRoute(first), committedRoute: localDocumentRoute(first),
    committed: { registrationId: "main-a", webContentsId: 42, revision: 10,
      identity: { kind: "canonical", agentKey: first.agentKey, chatId: first.ownerChatId } },
    state: { revision: 20, openRevision: 8, documents: [first, second, other], activeDocumentId: other.documentId } });
  await tick();
  assert.deepEqual(fixture.calls.navigate, [], "restored global state has no navigation authority");
  assert.equal(fixture.options.currentRoute, localDocumentRoute(first));
  assert.deepEqual(fixture.calls.bind.map(request => request.documentId), [first.documentId, second.documentId]);
  assert.deepEqual(fixture.stateRef.current.workspaces.map(workspace => workspace.ownerChatId), [first.ownerChatId]);
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.equal(workspace.items.length, 2);
  assert.equal(workspace.items.find(item => item.itemId === workspace.activeItemId).descriptor.context.documentId, second.documentId);
});

for (const platform of ["darwin", "win32"]) test(`${platform}: Main queues cold-launch navigation and file presentation waits for its committed target`, async t => {
  const documents = [draftDocument(1), draftDocument(2, "1791600000001", "冷启动.md")];
  const fixture = harness(t, documents);
  const contents = new EventEmitter();
  contents.isLoadingMainFrame = () => true;
  const navigations = [];
  contents.send = (channel, target) => {
    assert.equal(channel, "app.navigate");
    navigations.push(target);
    fixture.render({ currentRoute: target });
  };
  const target = { webContents: contents, isDestroyed: () => false, isFullScreen: () => false,
    isMinimized: () => false, show() {}, focus() {} };
  const activation = createMainWindowActivationController({ platform,
    lifecycle: { getWindowForActivation: () => target, normalizeBeforeShow() {} }, ensureDockIdentity() {} });
  fixture.render();
  activation.showMainWindow(fixture.route);
  await tick();
  assert.deepEqual(navigations, []); assert.deepEqual(fixture.calls.navigate, []); assert.equal(fixture.calls.bind.length, 0);
  contents.emit("did-finish-load");
  await tick();
  assert.deepEqual(navigations, [fixture.route]); assert.equal(fixture.calls.bind.length, 0, "Main route alone is not a committed guest");
  fixture.ready(); await tick();
  assert.deepEqual(fixture.stateRef.current.workspaces[0].items.map(item => item.descriptor.context.documentId), documents.map(document => document.documentId));
  assert.deepEqual(fixture.calls.navigate, []);
});

function closePresentedDocument(fixture, document) {
  const workspace = fixture.stateRef.current.workspaces.find(item => item.ownerChatId === localDocumentOwnerKey(document));
  const item = workspace.items.find(candidate => candidate.descriptor.context.documentId === document.documentId);
  const closed = reduceWorkPanelCommand(fixture.stateRef.current,
    { type: "closeItem", ownerChatId: workspace.ownerChatId, itemId: item.itemId, force: true });
  assert.equal(closed.ok, true);
  fixture.stateRef.current = closed.nextState;
  return closed.nextState;
}

test("a watcher snapshot queued before Main closes a UI tab cannot recreate the removed preview", async t => {
  const first = documentItem(1); const second = documentItem(2);
  const fixture = harness(t, [first, second]); fixture.render(); fixture.ready(); await tick();
  const closing = deferred(); const closeCalls = [];
  fixture.api.close = documentId => { closeCalls.push(documentId); return closing.promise; };
  const previousDocumentIds = { current: new Set() };
  runRealSystemDocumentCloseEffect(fixture.stateRef.current, previousDocumentIds);
  closePresentedDocument(fixture, second);
  runRealSystemDocumentCloseEffect(fixture.stateRef.current, previousDocumentIds);
  assert.deepEqual(closeCalls, [second.documentId]);
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents: [{ ...first, version: 1 }, second] } });
  await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.deepEqual(workspace.items.map(item => item.descriptor.context.documentId), [first.documentId]);
  assert.equal(workspace.items[0].descriptor.context.version, 1);
  assert.equal(fixture.calls.bind.length, 2); assert.equal(fixture.calls.errors, 0);
  fixture.ready(); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0].items.length, 1, "revisiting the same committed owner does not restore a pending close");
  closing.resolve({ ok: true });
});

test("closing a displayed tab rejects its late replacement binding before effect cleanup", async t => {
  const first = documentItem(1); const second = documentItem(2); const renewed = documentItem(2, 5, 1);
  const fixture = harness(t, [first, second]); fixture.render(); fixture.ready(); await tick();
  const pending = deferred();
  fixture.api.bind = request => { fixture.calls.bind.push(request); return pending.promise; };
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents: [first, renewed] } }); await tick();
  const closed = closePresentedDocument(fixture, second);
  // User close commits synchronously; a previous bind can resolve before React cleanup.
  pending.resolve({ ok: true, document: renewed }); await tick();
  assert.equal(fixture.stateRef.current, closed);
  assert.deepEqual(fixture.stateRef.current.workspaces[0].items.map(item => item.descriptor.context.documentId), [first.documentId]);
  assert.equal(fixture.calls.errors, 0);
});

test("pending UI closes do not prevent coalesced new files from being appended and selected", async t => {
  const first = documentItem(1); const closed = documentItem(2);
  const third = documentItem(3); const fourth = documentItem(4, 4, 0, first.ownerChatId, "新增.md");
  const fixture = harness(t, [first, closed]); fixture.render(); fixture.ready(); await tick();
  closePresentedDocument(fixture, closed);
  fixture.render({ state: { revision: 4, openRevision: 4, documents: [first, closed, third, fourth], activeDocumentId: fourth.documentId } });
  await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.deepEqual(workspace.items.map(item => item.descriptor.context.documentId), [first.documentId, third.documentId, fourth.documentId]);
  assert.equal(workspace.items.find(item => item.itemId === workspace.activeItemId).descriptor.context.documentId, fourth.documentId);
  assert.equal(fixture.calls.bind.filter(request => request.documentId === closed.documentId).length, 1);
});

test("a fresh explicit OS reopen rebinds and selects a closed document still present in Main's snapshot", async t => {
  const first = documentItem(1); const second = documentItem(2);
  const fixture = harness(t, [first, second]); fixture.render(); fixture.ready(); await tick();
  closePresentedDocument(fixture, second);
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents: [first, second] } }); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0].items.length, 1);
  fixture.render({ state: { ...fixture.options.state, revision: 3, openRevision: 2, activeDocumentId: second.documentId } }); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.equal(workspace.items.length, 2);
  assert.equal(workspace.items.find(item => item.itemId === workspace.activeItemId).descriptor.context.documentId, second.documentId);
  assert.equal(fixture.calls.bind.filter(request => request.documentId === second.documentId).length, 2);
  assert.deepEqual(fixture.calls.navigate, []);
});

test("Main close acknowledgement clears the removed identity so a new OS-open document with the same filename is independent", async t => {
  const first = documentItem(1); const second = documentItem(2);
  const replacement = documentItem(3, 3, 0, first.ownerChatId, second.fileName);
  const fixture = harness(t, [first, second]); fixture.render(); fixture.ready(); await tick();
  closePresentedDocument(fixture, second);
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents: [first], activeDocumentId: first.documentId } }); await tick();
  fixture.render({ state: { revision: 3, openRevision: 2, documents: [first, replacement], activeDocumentId: replacement.documentId } }); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.deepEqual(workspace.items.map(item => item.descriptor.context.documentId), [first.documentId, replacement.documentId]);
  assert.equal(workspace.items.find(item => item.itemId === workspace.activeItemId).descriptor.context.documentId, replacement.documentId);
  assert.equal(fixture.calls.errors, 0);
});

test("a trusted newChat previews several files without a canonical Chat ID or composer context", async t => {
  const first = draftDocument(1); const second = draftDocument(2, first.newChat, "说明.md");
  const fixture = harness(t, [first, second]); fixture.render(); await tick();
  assert.deepEqual(fixture.calls.bind, []);
  assert.equal(new URL(fixture.route, "http://desktop.local").searchParams.has("chatId"), false);
  fixture.ready(second); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.equal(workspace.ownerChatId, localDocumentOwnerKey(first));
  assert.equal(workspace.items.length, 2);
  assert.ok(workspace.items.every(item => item.descriptor.context.ownerChatId === ""));
  assert.ok(fixture.calls.bind.every(request => request.ownerChatId === "" && request.newChat === first.newChat));
  assert.equal(localDocumentWorkPanelOwnerForRoute(fixture.stateRef.current, fixture.route), workspace.ownerChatId);
});

test("real promotion ACK can precede host registration and Main publication without replacing file parents or binding canonical too early", async t => {
  const first = draftDocument(1); const second = draftDocument(2);
  const fixture = harness(t, [first, second]); fixture.render(); fixture.ready(second); await tick();
  const original = fixture.stateRef.current.workspaces[0];
  let listener; let scheduledRoute; const acknowledgements = [];
  globalThis.window.electronAPI.canonicalChatSync = {
    onRequest(handler) { listener = handler; return () => {}; }, respond(result) { acknowledgements.push(result); },
  };
  const guard = { current: null };
  installRealCanonicalAckEffect({
    isAgentWebclientChatSurface: () => true, serviceId: "agent-webclient", surfaceId: "main-chat", active: true,
    readWebviewContentsId: webview => webview?.getWebContentsId(), webviewRef: { current: { getWebContentsId: () => 42 } },
    surfaceRegistrationIdRef: { current: "main-registration" }, mainChatRouteStateRef: { current: { revision: 7 } }, mainChatRouteRevision: 7,
    currentRouteWithHashRef: { current: fixture.route }, currentRouteWithHash: fixture.route, MAIN_CHAT_SURFACE_ID: "main-chat",
    createCanonicalAgentChatRoute: module.exports.createCanonicalAgentChatRoute, ownerChatId: undefined,
    pendingMainChatRouteTransitionRef: { current: null }, canonicalChatPromotionGuardRef: guard,
    webviewDocumentGenerationRef: { current: 3 }, surfaceRegistrationRetryRef: { current: 0 },
    reportServiceWebviewDiagnostic: () => {}, navigate(route) { scheduledRoute = route; },
  });
  listener({ requestId: "promotion", sourceId: "source", surfaceId: "main-chat", registrationId: "main-registration", guestWebContentsId: 42,
    agentKey: first.agentKey, newChat: first.newChat, chatId: "real-chat" });
  assert.deepEqual(acknowledgements, [{ requestId: "promotion", ok: true }]);
  assert.equal(guard.current.routeRevision, 8); assert.equal(fixture.calls.bind.length, 2);
  assert.equal(fixture.stateRef.current.workspaces[0], original, "ACK does not publish or invent canonical file ownership");

  // The host route commits before either the guest URL or the real Main file publication.
  fixture.render({ currentRoute: scheduledRoute, committedRoute: "", committed: null }); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0], original, "a temporary hidden pane does not close or replace its guest parent");
  const documents = [first, second].map(({ newChat, ...document }) => ({ ...document, ownerChatId: "real-chat" }));
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents } }); await tick();
  const adopted = fixture.stateRef.current.workspaces[0];
  assert.equal(adopted.workspaceId, original.workspaceId); assert.equal(adopted.ownerChatId, "real-chat");
  assert.deepEqual(adopted.items.map(item => item.itemId), original.items.map(item => item.itemId));
  assert.equal(fixture.calls.bind.length, 2, "publication still does not pretend the guest already committed its canonical URL");
  // Only normal chat.start handling makes the existing guest canonical and enables presentation ACK.
  fixture.ready(documents[1]); await tick();
  assert.equal(fixture.calls.bind.length, 4);
  assert.ok(fixture.calls.bind.slice(2).every(request => request.ownerChatId === "real-chat" && !Object.hasOwn(request, "newChat")));
});

test("promotion adopts all existing tabs before canonical bind and keeps guest parents, selection and hidden state", async t => {
  const first = draftDocument(1); const second = draftDocument(2);
  const fixture = harness(t, [first, second]); fixture.render(); fixture.ready(second); await tick();
  const draft = fixture.stateRef.current.workspaces[0];
  fixture.options.dispatchCommand({ type: "activateItem", ownerChatId: draft.ownerChatId, itemId: draft.items[0].itemId });
  fixture.stateRef.current = { ...fixture.stateRef.current, visibleOwnerChatIds: [] };
  const promotionCommitStart = fixture.calls.commits.length;
  const canonical = [first, second].map(({ newChat, ...document }) => ({ ...document, ownerChatId: "real-chat" }));
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents: canonical } }); await tick();
  const adopted = fixture.stateRef.current.workspaces[0];
  assert.equal(adopted.ownerChatId, "real-chat"); assert.equal(adopted.workspaceId, draft.workspaceId);
  assert.equal(adopted.activeItemId, draft.items[0].itemId);
  assert.deepEqual(adopted.items.map(item => item.itemId), draft.items.map(item => item.itemId));
  assert.deepEqual(adopted.items.map(item => item.descriptor.context.partition), draft.items.map(item => item.descriptor.context.partition));
  assert.deepEqual(fixture.stateRef.current.visibleOwnerChatIds, []);
  assert.equal(fixture.calls.bind.length, 2, "promotion does not wait for presentation before the guest receives its Query events");
  assert.equal(localDocumentWorkPanelOwnerForRoute(fixture.stateRef.current, fixture.route), "real-chat", "the draft route still shows its adopted parent during handoff");
  fixture.api.bind = async request => {
    fixture.calls.bind.push(request);
    assert.equal(fixture.stateRef.current.workspaces[0].ownerChatId, "real-chat", "adoption precedes presentation ACK");
    assert.equal(fixture.stateRef.current.workspaces[0].workspaceId, draft.workspaceId);
    return { ok: true, document: canonical.find(item => item.documentId === request.documentId) };
  };
  fixture.ready(canonical[1]); await tick();
  assert.equal(fixture.calls.bind.length, 4, "same URL/session still rebinds its newly canonical owner");
  assert.ok(fixture.calls.bind.slice(2).every(request => request.ownerChatId === "real-chat" && !Object.hasOwn(request, "newChat")));
  assert.equal(fixture.stateRef.current.workspaces[0].activeItemId, draft.items[0].itemId);
  assert.deepEqual(fixture.stateRef.current.visibleOwnerChatIds, []);
  assert.ok(fixture.calls.commits.slice(promotionCommitStart).every(state => state.workspaces.flatMap(workspace => workspace.items).length === 2), "no close-and-reopen state can release a Main document");
});

test("another newChat nonce cannot attach the draft's files", async t => {
  const document = draftDocument(1);
  const fixture = harness(t, [document]); fixture.render();
  const other = { ...document, newChat: "1791600000002" };
  fixture.ready(other); await tick();
  assert.equal(fixture.calls.bind.length, 0); assert.deepEqual(fixture.stateRef.current.workspaces, []);
  fixture.ready(document); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0].items.length, 1);
});

test("a first Query that promotes before the initial draft bind still opens and selects the original file", async t => {
  const document = draftDocument(1); const pending = deferred();
  const fixture = harness(t, [document]); fixture.api.bind = () => pending.promise;
  fixture.render(); fixture.ready(document); await tick();
  assert.deepEqual(fixture.stateRef.current.workspaces, []);
  const { newChat, ...original } = document;
  const promoted = { ...original, ownerChatId: "real-chat" };
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents: [promoted] } });
  fixture.api.bind = async request => { fixture.calls.bind.push(request); return { ok: true, document: promoted }; };
  fixture.ready(promoted); await tick();
  pending.resolve({ ok: true, document }); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.equal(workspace.ownerChatId, "real-chat"); assert.equal(workspace.items.length, 1);
  assert.equal(workspace.activeItemId, workspace.items[0].itemId);
  assert.equal(workspace.items[0].descriptor.context.url, document.url);
  assert.deepEqual(fixture.stateRef.current.visibleOwnerChatIds, ["real-chat"]);
});

test("coalesced opens append every HTML/Markdown tab to one committed file Chat and activate only the last", async t => {
  const first = documentItem(1, 1, 0, "file-chat", "第一页.html");
  const second = documentItem(2, 2, 0, "file-chat", "第二份文档.md");
  const third = documentItem(3, 3, 0, "file-chat", "第三页.htm");
  const fixture = harness(t, [first, second, third]);
  fixture.render({ state: { revision: 3, openRevision: 3, documents: [first, second, third], activeDocumentId: third.documentId } });
  assert.deepEqual(fixture.calls.bind, [], "no file attaches before canonical Chat registration");
  fixture.ready(third); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.deepEqual(workspace.items.map(item => item.descriptor.context.documentId), [first.documentId, second.documentId, third.documentId]);
  assert.equal(workspace.items[1].descriptor.context.kind, "markdown");
  assert.equal(workspace.items.find(item => item.itemId === workspace.activeItemId).descriptor.context.documentId, third.documentId);
  assert.deepEqual(fixture.calls.commands.map(command => command.descriptor.context.documentId), [third.documentId]);
  assert.deepEqual(fixture.calls.navigate, []);
  assert.deepEqual(fixture.stateRef.current.visibleOwnerChatIds, ["file-chat"]);
});

test("later Finder opens append to the active file Chat without navigating or replacing existing guest descriptors", async t => {
  const first = documentItem(1);
  const second = documentItem(2, 2, 0, first.ownerChatId, "下一份.md");
  const third = documentItem(3);
  const fixture = harness(t, [first]); fixture.render(); fixture.ready(first); await tick();
  const original = fixture.stateRef.current.workspaces[0].items[0];
  fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } }); await tick();
  const secondTab = fixture.stateRef.current.workspaces[0].items[1];
  assert.equal(fixture.stateRef.current.workspaces[0].items[0], original);
  fixture.render({ state: { revision: 3, openRevision: 3, documents: [first, second, third], activeDocumentId: third.documentId } }); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.equal(fixture.stateRef.current.workspaces.length, 1);
  assert.deepEqual(workspace.items.map(item => item.descriptor.context.documentId), [first.documentId, second.documentId, third.documentId]);
  assert.equal(workspace.items[0], original); assert.equal(workspace.items[1], secondTab);
  assert.equal(workspace.items.find(item => item.itemId === workspace.activeItemId).descriptor.context.documentId, third.documentId);
  assert.deepEqual(fixture.calls.bind.map(call => call.documentId), [first.documentId, second.documentId, third.documentId]);
  assert.deepEqual(fixture.calls.navigate, [], "adding files never re-navigates the committed file Chat");
});

test("coalesced later opens preserve old tabs and only dispatch activation for the last new file", async t => {
  const first = documentItem(1); const second = documentItem(2); const third = documentItem(3);
  const fixture = harness(t, [first]); fixture.render(); fixture.ready(first); await tick();
  const original = fixture.stateRef.current.workspaces[0].items[0];
  fixture.render({ state: { revision: 3, openRevision: 3, documents: [first, second, third], activeDocumentId: third.documentId } }); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.equal(workspace.items[0], original);
  assert.equal(workspace.items.length, 3);
  assert.deepEqual(fixture.calls.commands.map(command => command.descriptor.context.documentId), [first.documentId, third.documentId]);
  assert.equal(workspace.items.find(item => item.itemId === workspace.activeItemId).descriptor.context.documentId, third.documentId);
  assert.equal(fixture.calls.navigate.length, 0);
});

test("a rejected earlier binding cannot stop later files in the same snapshot from opening", async t => {
  const first = documentItem(1); const second = documentItem(2); const third = documentItem(3);
  const fixture = harness(t, [first, second, third]);
  fixture.api.bind = async request => {
    fixture.calls.bind.push(request);
    if (request.documentId === first.documentId) throw new Error("first preview unavailable");
    return { ok: true, document: fixture.options.state.documents.find(item => item.documentId === request.documentId) };
  };
  fixture.render(); fixture.ready(third); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.deepEqual(workspace.items.map(item => item.descriptor.context.documentId), [second.documentId, third.documentId]);
  assert.equal(workspace.items.find(item => item.itemId === workspace.activeItemId).descriptor.context.documentId, third.documentId);
  assert.deepEqual(fixture.calls.bind.map(call => call.documentId), [first.documentId, second.documentId, third.documentId]);
  assert.deepEqual(fixture.calls.commands.map(command => command.descriptor.context.documentId), [third.documentId]);
});

test("a failed selected binding reports the failure and preserves the existing active tab without activating another file", async t => {
  const first = documentItem(1); const second = documentItem(2);
  const fixture = harness(t, [first]); fixture.render(); fixture.ready(first); await tick();
  const previous = fixture.stateRef.current.workspaces[0];
  fixture.api.bind = async request => { fixture.calls.bind.push(request); return { ok: false }; };
  fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } }); await tick();
  assert.equal(fixture.calls.errors, 1);
  assert.equal(fixture.stateRef.current.workspaces[0], previous);
  assert.deepEqual(fixture.calls.commands.map(command => command.descriptor.context.documentId), [first.documentId]);
  assert.equal(fixture.calls.navigate.length, 0);
});

test("a binding acknowledgement for another document, owner or agent cannot replace an existing file tab", async t => {
  for (const [field, value] of [["documentId", documentItem(9).documentId], ["ownerChatId", "another-chat"], ["agentKey", "another-agent"]]) {
    await t.test(field, async child => {
      const first = documentItem(1); const second = documentItem(2);
      const fixture = harness(child, [first]); fixture.render(); fixture.ready(first); await tick();
      const previous = fixture.stateRef.current.workspaces[0];
      fixture.api.bind = async request => { fixture.calls.bind.push(request); return { ok: true, document: { ...second, [field]: value } }; };
      fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } }); await tick();
      assert.equal(fixture.calls.errors, 1);
      assert.equal(fixture.stateRef.current.workspaces[0], previous);
      assert.deepEqual(fixture.calls.commands.map(command => command.descriptor.context.documentId), [first.documentId]);
    });
  }
});

test("switching tabs and watching another file keep the same Chat and untouched preview descriptors", async t => {
  const first = documentItem(1); const second = documentItem(2); const third = documentItem(3);
  const fixture = harness(t, [first, second, third]); fixture.render(); fixture.ready(third); await tick();
  const before = fixture.stateRef.current.workspaces[0];
  fixture.options.dispatchCommand({ type: "activateItem", ownerChatId: first.ownerChatId, itemId: before.items[0].itemId });
  fixture.render(); await tick();
  fixture.stateRef.current = { ...fixture.stateRef.current, visibleOwnerChatIds: [] };
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents: [first, { ...second, version: 1 }, third] } }); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.equal(workspace.activeItemId, before.items[0].itemId);
  assert.equal(workspace.items[0], before.items[0]); assert.equal(workspace.items[2], before.items[2]);
  assert.equal(workspace.items[1].itemId, before.items[1].itemId);
  assert.equal(workspace.items[1].descriptor.context.partition, before.items[1].descriptor.context.partition);
  assert.equal(workspace.items[1].descriptor.context.version, 1);
  assert.deepEqual(fixture.stateRef.current.visibleOwnerChatIds, []);
  assert.equal(fixture.calls.bind.length, 3); assert.equal(fixture.calls.navigate.length, 0);
});

test("watcher changes preserve the selected tab and hidden WorkPanel without navigation or draft insertion", async t => {
  const fixture = harness(t, [documentItem(1), documentItem(2)]); fixture.render(); fixture.ready(); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  fixture.stateRef.current = { ...fixture.stateRef.current, visibleOwnerChatIds: [], workspaces: [{ ...workspace, activeItemId: workspace.items[0].itemId }] };
  fixture.render({ currentRoute: "/other", committedRoute: "", committed: null,
    state: { ...fixture.options.state, revision: 2, documents: [documentItem(1), documentItem(2, 2, 1)] } }); await tick();
  assert.deepEqual(fixture.stateRef.current.visibleOwnerChatIds, []);
  assert.equal(fixture.stateRef.current.workspaces[0].activeItemId, workspace.items[0].itemId);
  assert.equal(fixture.stateRef.current.workspaces[0].items[1].descriptor.context.version, 1);
  assert.equal(fixture.calls.navigate.length, 0);
});

test("a renewed preview remains unmounted until bind succeeds, then preserves hidden panel state", async t => {
  const fixture = harness(t); fixture.render(); fixture.ready(); await tick();
  fixture.stateRef.current = { ...fixture.stateRef.current, visibleOwnerChatIds: [] };
  const pending = deferred(); fixture.api.bind = request => { fixture.calls.bind.push(request); return pending.promise; };
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents: [documentItem(1, 3, 1)] } }); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0].items[0].descriptor.context.partition, documentItem(1).partition);
  pending.resolve({ ok: true, document: documentItem(1, 3, 1) }); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0].items[0].descriptor.context.partition, documentItem(1, 3).partition);
  assert.deepEqual(fixture.stateRef.current.visibleOwnerChatIds, []);
});

test("a late binding cannot mount a file in a different Chat", async t => {
  const fixture = harness(t); const pending = deferred(); fixture.api.bind = () => pending.promise;
  fixture.render(); fixture.ready(); await tick();
  fixture.render({ currentRoute: "/other", committedRoute: "", committed: null });
  pending.resolve({ ok: true, document: documentItem(1) }); await tick();
  assert.equal(fixture.stateRef.current.workspaces.length, 0);
});

test("a late earlier open in the same Chat cannot replace the newer selected tab", async t => {
  const first = documentItem(1); const second = documentItem(2);
  const fixture = harness(t, [first]); const delayed = deferred(); let delayFirst = true;
  fixture.api.bind = async request => {
    fixture.calls.bind.push(request);
    if (request.documentId === first.documentId && delayFirst) { delayFirst = false; return delayed.promise; }
    return { ok: true, document: fixture.options.state.documents.find(item => item.documentId === request.documentId) };
  };
  fixture.render(); fixture.ready(first); await tick();
  fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } }); await tick();
  const newer = fixture.stateRef.current.workspaces[0];
  delayed.resolve({ ok: true, document: first }); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0], newer);
  assert.equal(newer.items.length, 2);
  assert.equal(newer.items.find(item => item.itemId === newer.activeItemId).descriptor.context.documentId, second.documentId);
  assert.deepEqual(fixture.calls.commands.map(command => command.descriptor.context.documentId), [second.documentId]);
  assert.equal(fixture.calls.navigate.length, 0);
});

test("a stale binding reply cannot restore a replaced preview session before React effect cleanup", async t => {
  const first = documentItem(1); const second = documentItem(2); const renewed = documentItem(2, 5, 1);
  const fixture = harness(t, [first]); fixture.render(); fixture.ready(first); await tick();
  const delayed = deferred(); fixture.api.bind = request => { fixture.calls.bind.push(request); return delayed.promise; };
  fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } }); await tick();
  const previous = fixture.stateRef.current.workspaces[0];
  // The live snapshot can change before the previous effect's cleanup runs.
  fixture.options.state = { revision: 3, openRevision: 2, documents: [first, renewed], activeDocumentId: renewed.documentId };
  delayed.resolve({ ok: true, document: second }); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0], previous);
  fixture.api.bind = async request => { fixture.calls.bind.push(request); return { ok: true, document: fixture.options.state.documents.find(item => item.documentId === request.documentId) }; };
  fixture.render(); await tick();
  const workspace = fixture.stateRef.current.workspaces[0];
  assert.equal(workspace.items[0], previous.items[0]);
  assert.equal(workspace.items[1].descriptor.context.partition, renewed.partition);
  assert.equal(workspace.items[1].descriptor.context.version, 1);
  assert.equal(workspace.activeItemId, workspace.items[1].itemId);
  assert.ok(fixture.calls.commits.flatMap(state => state.workspaces.flatMap(workspace => workspace.items))
    .every(item => item.descriptor.context.partition !== second.partition));
});

test("a binding reply cannot mount a document whose live owner changed before effect cleanup", async t => {
  const first = documentItem(1); const second = documentItem(2);
  const fixture = harness(t, [first]); fixture.render(); fixture.ready(first); await tick();
  const delayed = deferred(); fixture.api.bind = request => { fixture.calls.bind.push(request); return delayed.promise; };
  fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } }); await tick();
  const previous = fixture.stateRef.current.workspaces[0];
  fixture.options.state = { ...fixture.options.state, revision: 3, documents: [first, { ...second, ownerChatId: "another-chat" }] };
  delayed.resolve({ ok: true, document: second }); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0], previous);
  assert.equal(fixture.stateRef.current.workspaces.length, 1);
  assert.deepEqual(fixture.calls.commands.map(command => command.descriptor.context.documentId), [first.documentId]);
});

test("a binding reply from an earlier canonical commit cannot mount before effect cleanup", async t => {
  const document = documentItem(1);
  const fixture = harness(t, [document]); const delayed = deferred();
  fixture.api.bind = request => { fixture.calls.bind.push(request); return delayed.promise; };
  fixture.render(); fixture.ready(document); await tick();
  fixture.options.committed = { ...fixture.options.committed, revision: 2 };
  delayed.resolve({ ok: true, document }); await tick();
  assert.deepEqual(fixture.stateRef.current.workspaces, []);
  fixture.api.bind = async request => { fixture.calls.bind.push(request); return { ok: true, document }; };
  fixture.render(); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0].items[0].descriptor.context.documentId, document.documentId);
  assert.equal(fixture.calls.errors, 0);
});

test("opening and watcher refresh need only the path-free local document binding API", async t => {
  const fixture = harness(t);
  fixture.render(); fixture.ready(); await tick();
  fixture.render({ state: { ...fixture.options.state, revision: 2, documents: [documentItem(1, 1, 1)] } }); await tick();
  assert.equal(fixture.stateRef.current.workspaces[0].items[0].descriptor.context.version, 1);
  assert.equal(fixture.calls.errors, 0);
});

test("repeated OS activation refreshes the file without a second navigation", async t => {
  const fixture = harness(t);
  fixture.render(); fixture.ready(); await tick();
  assert.equal(fixture.calls.bind.length, 1); assert.equal(fixture.calls.errors, 0);
  fixture.render({ state: { ...fixture.options.state, revision: 2, openRevision: 2, documents: [documentItem(1, 1, 1)] } }); await tick();
});

test("sequential opens with independent owners show the last open and recover an earlier delayed binding", async t => {
  const first = documentItem(1, 1, 0, "chat-first", "同一文件.html");
  const second = documentItem(2, 2, 0, "chat-second", "同一文件.html");
  const fixture = harness(t, [first]);
  const delayed = deferred(); let delayFirst = true;
  fixture.api.bind = async request => {
    fixture.calls.bind.push(request);
    if (request.documentId === first.documentId && delayFirst) { delayFirst = false; return delayed.promise; }
    return { ok: true, document: fixture.options.state.documents.find(item => item.documentId === request.documentId) };
  };
  fixture.render(); fixture.ready(first); await tick();
  fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } });
  await tick();
  assert.deepEqual(fixture.calls.bind.map(call => call.documentId), [first.documentId], "the navigation commit does not bind its previous owner again");
  fixture.ready(second); await tick();
  delayed.resolve({ ok: true, document: first }); await tick();
  assert.deepEqual(fixture.stateRef.current.workspaces.map(item => item.ownerChatId), [second.ownerChatId]);
  assert.deepEqual(fixture.calls.navigate, []);

  fixture.ready(first); await tick();
  const recovered = fixture.stateRef.current.workspaces.find(item => item.ownerChatId === first.ownerChatId);
  assert.equal(recovered.items.find(item => item.itemId === recovered.activeItemId).descriptor.context.documentId, first.documentId);
  assert.ok(fixture.stateRef.current.visibleOwnerChatIds.includes(first.ownerChatId));
  fixture.ready(second); fixture.ready(first); await tick();
});

test("coalesced opens of the same filename keep both owner intents and independent previews", async t => {
  const first = documentItem(1, 1, 0, "chat-first", "同一文件.html");
  const second = documentItem(2, 2, 0, "chat-second", "同一文件.html");
  const fixture = harness(t, [first, second]);
  fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } });
  fixture.ready(second); await tick();
  assert.deepEqual(fixture.calls.bind.map(call => call.documentId), [second.documentId]);
  fixture.ready(first); await tick();
  const documents = fixture.stateRef.current.workspaces.flatMap(workspace => workspace.items.map(item => item.descriptor.context));
  assert.equal(documents.length, 2);
  assert.equal(new Set(documents.map(document => document.documentId)).size, 2);
  assert.equal(new Set(documents.map(document => document.partition)).size, 2);
  assert.ok(documents.every(document => document.fileName === "同一文件.html"));
  assert.equal(fixture.calls.navigate.length, 0, "a return to the earlier owner must not navigate back to the last opened Chat");
});

test("switching between file Chats restores only their own bound previews", async t => {
  const first = documentItem(1, 1, 0, "chat-first", "同一文件.html");
  const second = documentItem(2, 2, 0, "chat-second", "同一文件.html");
  const fixture = harness(t, [first]);
  fixture.render(); fixture.ready(first); await tick();
  fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } });
  fixture.ready(second); await tick();
  fixture.ready(first); await tick();
  assert.equal(fixture.stateRef.current.workspaces.length, 2);
});

test("watching and closing an earlier document do not change the newer document Chat", async t => {
  const first = documentItem(1, 1, 0, "chat-first", "同一文件.html");
  const second = documentItem(2, 2, 0, "chat-second", "同一文件.html");
  const fixture = harness(t, [first]); fixture.render(); fixture.ready(first); await tick();
  fixture.render({ state: { revision: 2, openRevision: 2, documents: [first, second], activeDocumentId: second.documentId } });
  fixture.ready(second); await tick();
  fixture.stateRef.current = { ...fixture.stateRef.current, visibleOwnerChatIds: [second.ownerChatId] };
  const newerWorkspace = fixture.stateRef.current.workspaces.find(item => item.ownerChatId === second.ownerChatId);
  fixture.render({ state: { ...fixture.options.state, revision: 3, documents: [{ ...first, version: 1 }, { ...second, version: 1 }] } }); await tick();
  assert.deepEqual(fixture.stateRef.current.visibleOwnerChatIds, [second.ownerChatId]);
  assert.equal(fixture.stateRef.current.workspaces.find(item => item.ownerChatId === second.ownerChatId).activeItemId, newerWorkspace.activeItemId);
  fixture.render({ state: { ...fixture.options.state, revision: 4, documents: [{ ...second, version: 1 }] } }); await tick();
  assert.deepEqual(fixture.stateRef.current.workspaces.map(item => item.ownerChatId), [second.ownerChatId]);
  assert.equal(fixture.stateRef.current.workspaces[0].items[0].descriptor.context.documentId, second.documentId);
  assert.equal(fixture.stateRef.current.workspaces[0].items[0].descriptor.context.partition, second.partition);
  assert.equal(fixture.calls.navigate.length, 0);
});
