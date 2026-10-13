import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const root = process.cwd();
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");
const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadSource(filename, dependencies = {}) {
  const compiled = ts.transpileModule(read(filename), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}

const contract = loadSource("src/shared/selection-explain-window.ts");
const identities = loadSource("src/shared/surface-identity.ts");

function createController({ platform = "win32", dark = false, anchor = true, loadFails = false } = {}) {
  const created = [], handlers = new Map(), errors = [], displayQueries = [];
  const nativeTheme = { shouldUseDarkColors: dark };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.minimized = false;
      this.positions = [];
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), {
        id: 100 + created.length,
        isLoadingMainFrame: () => false,
        setWindowOpenHandler: (handler) => { this.openHandler = handler; },
        send: (...args) => this.sent.push(args)
      });
      created.push(this);
    }
    isDestroyed() { return this.destroyed === true; }
    getBounds() { return { x: this.options.x, y: this.options.y, width: this.options.width, height: this.options.height }; }
    setPosition(...args) { this.positions.push(args); }
    setMenuBarVisibility(value) { this.menuVisible = value; }
    isMinimized() { return this.minimized; }
    minimize() { this.minimized = true; }
    restore() { this.minimized = false; this.restored = true; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    moveTop() { this.raised = true; }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
  }
  const electron = {
    BrowserWindow: Window, nativeTheme,
    ipcMain: { removeHandler: (name) => handlers.delete(name), handle: (name, handler) => handlers.set(name, handler) },
    screen: {
      getDisplayMatching: (bounds) => { displayQueries.push(["anchor", bounds]); return { workArea: { x: 0, y: 0, width: 1800, height: 1100 } }; },
      getCursorScreenPoint: () => ({ x: -500, y: 200 }),
      getDisplayNearestPoint: (point) => { displayQueries.push(["cursor", point]); return { workArea: { x: -1600, y: 0, width: 1600, height: 900 } }; }
    }
  };
  const source = loadSource("src/main/modules/shell/selection-explain-window.ts", {
    electron, "../../../shared/selection-explain-window": contract
  });
  const controller = new source.SelectionExplainWindowController({
    platform, preloadPath: "/preview/preload.js", routePath: "/selection-explain", title: "Explain",
    getAnchorWindow: () => anchor ? { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 80, width: 1200, height: 900 }) } : null,
    configureWindow: (target) => { target.configured = true; },
    loadRendererRoute: async (target, route) => { target.route = route; if (loadFails) throw new Error("load failed"); },
    onRendererError: (...args) => errors.push(args)
  });
  return { controller, created, nativeTheme, errors, displayQueries, call: (channel, id) => handlers.get(channel)({ sender: { id } }) };
}

test("macOS uses native hidden-inset chrome and positions the explanation beside its owner", async () => {
  const harness = createController({ platform: "darwin" });
  await harness.controller.update({ requestId: "request-1", status: "pending" });
  const window = harness.created[0];
  assert.equal(window.options.frame, true);
  assert.equal(window.options.titleBarStyle, "hiddenInset");
  assert.deepEqual(window.options.trafficLightPosition, { x: 14, y: 15 });
  assert.deepEqual(window.positions.at(-1), [520, 240, false]);
  assert.equal(window.options.modal, false);
  assert.equal(window.options.alwaysOnTop, undefined);
  assert.equal(window.options.parent, undefined);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.configured && window.visible && window.focused, true);
  assert.deepEqual(window.openHandler({}), { action: "deny" });
  window.emit("ready-to-show");
  window.webContents.emit("did-finish-load");
  assert.ok(window.sent.every(([channel, state]) => channel === contract.SELECTION_EXPLAIN_WINDOW_STATE_CHANNEL && state.requestId === "request-1"));
});

test("Windows retains frameless controls and new windows use the current native theme background", async () => {
  const harness = createController({ platform: "win32", dark: true });
  await harness.controller.update({ requestId: "dark", status: "pending" });
  const darkWindow = harness.created[0];
  assert.equal(darkWindow.options.frame, false);
  assert.equal(darkWindow.options.autoHideMenuBar, true);
  assert.equal(darkWindow.options.titleBarStyle, undefined);
  assert.equal(darkWindow.options.trafficLightPosition, undefined);
  assert.equal(darkWindow.options.backgroundColor, "#181818");
  assert.deepEqual(darkWindow.positions.at(-1), [524, 244, false]);
  assert.equal(darkWindow.menuVisible, false);
  harness.controller.close();
  harness.nativeTheme.shouldUseDarkColors = false;
  await harness.controller.update({ requestId: "light", status: "pending" });
  assert.equal(harness.created[1].options.backgroundColor, "#ffffff");
});

test("state and window control IPC reject foreign renderers and restore the singleton", async () => {
  const harness = createController();
  await harness.controller.update({ requestId: "pending", status: "pending" });
  const window = harness.created[0], owner = window.webContents.id;
  assert.equal(harness.call(contract.SELECTION_EXPLAIN_WINDOW_GET_STATE_CHANNEL, owner + 1), null);
  assert.deepEqual(harness.call(contract.SELECTION_EXPLAIN_WINDOW_MINIMIZE_CHANNEL, owner + 1), { ok: false });
  assert.deepEqual(harness.call(contract.SELECTION_EXPLAIN_WINDOW_CLOSE_CHANNEL, owner + 1), { ok: false });
  assert.equal(window.minimized || window.destroyed === true, false);
  assert.deepEqual(harness.call(contract.SELECTION_EXPLAIN_WINDOW_MINIMIZE_CHANNEL, owner), { ok: true });
  await harness.controller.update({ requestId: "pending", status: "ready", chatId: "chat-1", runId: "run-1" });
  assert.equal(harness.created.length, 1);
  assert.equal(window.restored, true);
  assert.deepEqual(harness.call(contract.SELECTION_EXPLAIN_WINDOW_GET_STATE_CHANNEL, owner), { version: 1, requestId: "pending", status: "ready", chatId: "chat-1", runId: "run-1" });
});

test("close clears temporary state; late results cannot reopen it or replace a newer request", async () => {
  const harness = createController();
  await harness.controller.update({ requestId: "old", status: "pending" });
  const owner = harness.created[0].webContents.id;
  assert.deepEqual(harness.call(contract.SELECTION_EXPLAIN_WINDOW_CLOSE_CHANNEL, owner), { ok: true });
  assert.equal(harness.controller.getWindow(), null);
  assert.equal(harness.call(contract.SELECTION_EXPLAIN_WINDOW_GET_STATE_CHANNEL, owner), null);
  await harness.controller.update({ requestId: "old", status: "ready", chatId: "stale", runId: "stale" });
  assert.equal(harness.created.length, 1);
  await harness.controller.update({ requestId: "new", status: "pending" });
  await harness.controller.update({ requestId: "old", status: "error", code: "stale" });
  const currentOwner = harness.created[1].webContents.id;
  assert.equal(harness.call(contract.SELECTION_EXPLAIN_WINDOW_GET_STATE_CHANNEL, currentOwner).status, "pending");
  assert.deepEqual(harness.call(contract.SELECTION_EXPLAIN_WINDOW_CLOSE_CHANNEL, owner), { ok: false });
  await harness.controller.update({ requestId: "new", status: "error", code: "unavailable" });
  assert.equal(harness.call(contract.SELECTION_EXPLAIN_WINDOW_GET_STATE_CHANNEL, currentOwner).code, "unavailable");
});

test("without an owner the window uses the cursor display; load failure leaves no live window", async () => {
  const floating = createController({ anchor: false });
  await floating.controller.update({ requestId: "cursor", status: "pending" });
  assert.deepEqual(floating.created[0].positions.at(-1), [-776, 164, false]);
  assert.ok(floating.displayQueries.every(([kind]) => kind === "cursor"));
  const failed = createController({ loadFails: true });
  await failed.controller.update({ requestId: "failed", status: "pending" });
  assert.equal(failed.controller.getWindow(), null);
  assert.equal(failed.created[0].isDestroyed(), true);
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.errors[0][1].error, "load failed");
});

function rendererHarness(platform, { platformFails = false, userAgent } = {}) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const hooks = [], calls = [];
  let cursor = 0, listener, disposed = false;
  const Surface = Symbol("ServiceWebviewSurface");
  const react = {
    useState(initial) {
      const index = cursor++;
      hooks[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (value) => { hooks[index].value = value; }];
    },
    useEffect(effect) { const index = cursor++; hooks[index] ??= { cleanup: effect() }; },
    useMemo: (compute) => { cursor += 1; return compute(); },
    lazy: () => Surface, Suspense: "Suspense"
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: userAgent ?? (platform === "darwin" ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64)") }
  });
  globalThis.document = { documentElement: { dataset: { theme: "dark" } } };
  globalThis.window = { electronAPI: {
    settings: { getPlatform: async () => { if (platformFails) throw new Error("platform unavailable"); return platform; } },
    selectionExplain: {
      getState: async () => ({ version: 1, requestId: "request-1", status: "pending" }),
      onState: (callback) => { listener = callback; return () => { listener = null; }; },
      minimize: async () => { calls.push("minimize"); }, close: async () => { calls.push("close"); }
    }
  } };
  const source = loadSource("src/renderer/pages/SelectionExplainWindowPage.tsx", {
    react,
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    "../../shared/surface-identity": identities,
    "../i18n/useI18n": { useI18n: () => ({ t: (key) => key }) },
    "./SelectionExplainWindowPage.css": {}
  });
  return {
    Surface, calls,
    render: () => { cursor = 0; return source.SelectionExplainWindowPage(); },
    publish: (state) => listener(state),
    cleanup: () => {
      if (disposed) return;
      disposed = true;
      for (const hook of hooks) hook?.cleanup?.();
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
      else delete globalThis.navigator;
    }
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

test("macOS renderer preserves native controls before and after platform resolution", async (t) => {
  const harness = rendererHarness("darwin");
  t.after(harness.cleanup);
  assert.equal(nodes(harness.render()).filter((node) => node.type === "button").length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  const tree = harness.render();
  assert.ok(tree.props.className.includes("is-mac"));
  assert.equal(nodes(tree).filter((node) => node.type === "button").length, 0);
});

test("Windows renderer exposes functional custom minimize and close controls", async (t) => {
  const harness = rendererHarness("win32");
  t.after(harness.cleanup);
  assert.equal(nodes(harness.render()).filter((node) => node.type === "button").length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  const tree = harness.render();
  assert.ok(tree.props.className.includes("is-windows"));
  const buttons = nodes(tree).filter((node) => node.type === "button");
  assert.deepEqual(buttons.map((button) => button.props["aria-label"]), ["window.minimize", "common.close"]);
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(harness.calls, ["minimize", "close"]);
});

test("a rejected platform IPC leaves Windows close controls usable", async (t) => {
  const harness = rendererHarness("win32", { platformFails: true });
  t.after(harness.cleanup);
  assert.equal(nodes(harness.render()).filter((node) => node.type === "button").length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  const tree = harness.render();
  assert.ok(tree.props.className.includes("is-windows"));
  const close = nodes(tree).find((node) => node.type === "button" && node.props["aria-label"] === "common.close");
  assert.ok(close);
  close.props.onClick();
  assert.deepEqual(harness.calls, ["close"]);
});

test("a rejected platform IPC does not add duplicate custom controls on macOS", async (t) => {
  const harness = rendererHarness("darwin", { platformFails: true });
  t.after(harness.cleanup);
  assert.equal(nodes(harness.render()).filter((node) => node.type === "button").length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  const tree = harness.render();
  assert.ok(tree.props.className.includes("is-mac"));
  assert.equal(nodes(tree).filter((node) => node.type === "button").length, 0);
});

test("the trusted platform result replaces the initial user-agent platform", async (t) => {
  const harness = rendererHarness("win32", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
  t.after(harness.cleanup);
  assert.equal(nodes(harness.render()).filter((node) => node.type === "button").length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  const tree = harness.render();
  assert.ok(tree.props.className.includes("is-windows"));
  assert.equal(nodes(tree).filter((node) => node.type === "button").length, 2);
});

test("renderer state transitions expose encoded Chat and Run identities without selected text", async (t) => {
  const harness = rendererHarness("win32");
  t.after(harness.cleanup);
  harness.render();
  await new Promise((resolve) => setImmediate(resolve));
  harness.publish({ version: 1, requestId: "request-1", status: "error", code: "backend_unavailable" });
  assert.equal(nodes(harness.render()).find((node) => node.props?.role === "alert").props.children[1].props.children, "backend_unavailable");
  harness.publish({ version: 1, requestId: "request-2", status: "ready", chatId: "chat/one", runId: "run?two" });
  const surface = nodes(harness.render()).find((node) => node.type === harness.Surface);
  assert.equal(surface.props.embedPath, "/explain/chat%2Fone?runId=run%3Ftwo");
  assert.equal(surface.props.ownerChatId, "chat/one");
  assert.equal(surface.props.surfaceIdentity.surfaceRole, "selection-explain");
  assert.equal(surface.props.surfaceIdentity.ownerChatId, "chat/one");
  assert.equal(surface.props.hostTheme, "dark");
  assert.doesNotMatch(read("src/shared/selection-explain-window.ts"), /selectedText|\btext:\s*string|prompt/u);
});

test("selection explanation surface uses an isolated BTW root role", () => {
  const identities = read("src", "shared", "surface-identity.ts");
  const handler = ["frame-port/surface-authorization.ts", "frame-port/request-dispatch.ts"].map((filename) =>
    read("src", "main", "modules", "agent-platform", filename)
  ).join("\n");
  const broker = ["realtime-broker.ts", "root-observers.ts"].map((filename) =>
    read("src", "main", "modules", "agent-platform", "realtime", filename)
  ).join("\n");
  assert.match(identities, /"selection-explain"/u);
  assert.match(handler, /return "selection_explain" as const/u);
  assert.match(handler, /context\.kind === "agent-selection-explain"/u);
  assert.match(broker, /auxiliaryRootObservers/u);
  assert.match(broker, /input\.kind === "selection_explain"/u);
});
