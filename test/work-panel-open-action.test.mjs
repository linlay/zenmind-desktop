import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand } from "../dist-electron/shared/work-panel.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = fs.readFileSync(new URL("../src/renderer/work-panel/WorkPanelHost.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("WorkPanelHost.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let provider;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "registerDesktopActionProviderForScope" && node.arguments[0]?.getText(ast) === '"global"') {
    provider = node.arguments[1].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(provider, "real WorkPanel action provider exists");
const { outputText } = ts.transpileModule(`const provider = ${provider};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});

// Dispatch commits immediately; React has not rendered new props yet. Execute
// the real provider against the real reducer to reproduce that timing window.
function harness({ existing = false, loading = true, close = false, timeout = false } = {}) {
  let committed = structuredClone(EMPTY_WORK_PANEL_STATE);
  if (existing) committed = reduceWorkPanelCommand(committed, {
    type: "openItem", ownerChatId: "chat-a",
    descriptor: existing === "workspace"
      ? { kind: "webclient", module: "overview", route: "/overview", context: { chatId: "chat-a", agentKey: "agent-a" } }
      : { kind: "web", url: "https://www.google.com/" },
  }).nextState;
  const stateRef = { current: committed };
  let ticks = 0;
  let now = 0;
  const dispatches = [];
  const context = vm.createContext({
    stateRef,
    dispatchCommand: (command) => {
      dispatches.push(command);
      const result = reduceWorkPanelCommand(committed, command);
      committed = result.nextState;
      return result;
    },
    normalizeWorkPanelWebUrl: (url) => new URL(url).href,
    createAgentWebclientOverviewPath: () => "/overview",
    t: (key) => key,
    actionError: (code, message) => ({ ok: false, error: { code, message } }),
    itemRuntimeKey: (owner, item) => `${owner}:${item}`,
    webControllers: { current: { get: () => ticks && !timeout ? {
      getState: async () => ({ containerId: "container-a", activeTabId: "tab-a",
        tabs: [{ tabId: "tab-a", surfaceId: "page:a", isLoading: loading }] }),
    } : undefined } },
    Date: { now: () => now },
    window: { setTimeout: (resolve) => {
      ticks++;
      now += timeout ? 8_001 : 50;
      if (close) committed = reduceWorkPanelCommand(committed, {
        type: "closeWorkspace", ownerChatId: "chat-a", force: true,
      }).nextState;
      stateRef.current = committed;
      resolve();
    } },
  });
  vm.runInContext(`${outputText}\nglobalThis.invoke = provider;`, context);
  return {
    invoke: () => context.invoke({ action: "desktop.workpanel.openWeb",
      source: { chatId: "chat-a", agentKey: "agent-a" }, args: { url: "https://www.google.com/" } }),
    dispatches,
    ticks: () => ticks,
    webItems: () => committed.workspaces.flatMap((workspace) => workspace.items.filter((item) => item.descriptor.kind === "web")),
  };
}

test("opening in a new workspace survives delayed React state and controller registration", async () => {
  const { invoke } = harness();
  const result = await invoke();
  assert.equal(result.ok, true);
  assert.equal(result.result.surfaceId, "page:a");
  assert.equal(result.result.status, "loading");
  assert.equal("nextState" in result.result, false);
});

test("opening an existing page reuses its item and returns ready", async () => {
  const { invoke, dispatches, webItems } = harness({ existing: true, loading: false });
  const result = await invoke();
  assert.equal(result.ok, true);
  assert.equal(result.result.status, "ready");
  assert.equal(dispatches.length, 1);
  assert.equal(webItems().length, 1);
});

test("opening a new page in an existing workspace reads the committed item", async () => {
  const result = await harness({ existing: "workspace" }).invoke();
  assert.equal(result.ok, true);
  assert.equal(result.result.surfaceId, "page:a");
});

test("an actual close while waiting still fails", async () => {
  const { invoke, ticks } = harness({ close: true });
  const result = await invoke();
  assert.equal(ticks(), 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "surface_not_found");
});

test("controller registration timeout retains its specific recovery error", async () => {
  const result = await harness({ timeout: true }).invoke();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "surface_not_ready");
});
