import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const resourceActions = require("../dist-electron/shared/chat-work-panel-tab-context-menu.js");
const { formatWorkPanelFileAddress } = require("../dist-electron/shared/work-panel-file-address.js");
const source = fs.readFileSync(new URL("../src/renderer/work-panel/WorkPanelHost.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("WorkPanelHost.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set([
  "localResourceProfile", "matchesLocalResourceIdentity", "tabContextMenuProfile", "workPanelDocumentPath",
  "handleLocalResourceAction", "handleTabContextMenu",
]);
const declarations = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) {
    declarations.push(node.getText(ast));
  }
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) {
    declarations.push(`const ${node.name.getText(ast)} = ${node.initializer.getText(ast)};`);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.length, names.size, "exercise the real WorkPanel file-action handlers");
const { outputText } = ts.transpileModule(`${declarations.join("\n")}\nglobalThis.handlers = { handleTabContextMenu, matchesLocalResourceIdentity };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});

function harness({ actionId = "reveal-resource", outcome = { ok: true }, source = "generic", removeDuringMenu = false } = {}) {
  const filename = "chrome-download-8ca640016a93003d4253272a-browser-review-report.txt";
  const relativePath = source === "artifact" ? "artifacts/run-1/末位.md" : filename;
  const resourceId = source === "generic" ? "resource:80:1abc" : source === "artifact" ? "artifact-qa" : "reference-qa";
  const profile = source === "reference" ? "reference" : "artifact";
  const query = new URLSearchParams({ chatId: "chat-qa", file: `@chat/${relativePath}` });
  if (source !== "generic") {
    query.set("sourceKind", profile);
    query.set("resourceId", resourceId);
    query.set("relativePath", relativePath);
  }
  const item = {
    itemId: "item-qa", stableKey: "source-qa", title: filename, closable: true, pinned: false,
    descriptor: {
      kind: "webclient", module: profile, route: `/resource-viewer/agent-qa?${query}`,
      context: { agentKey: "agent-qa", chatId: "chat-qa", [profile === "artifact" ? "artifactId" : "referenceId"]: resourceId },
    },
  };
  const workspace = { ownerChatId: "chat-qa", items: [item] };
  const calls = [], errors = [], menus = [];
  const fileAction = async (action, request) => {
    calls.push({ action, ...request });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const context = vm.createContext({
    ...resourceActions,
    formatWorkPanelFileAddress,
    stateRef: { current: { workspaces: [workspace], review: { activeItemIdsByOwnerChatId: {} } } },
    reviewSourceForItem: () => null, resourceReviewCapabilities: {}, itemRuntimeKey: () => "qa",
    fullscreenOwnerChatId: null, nativeHtmlControllers: { current: new Map() },
    t: (key) => key, modal: { error: ({ content }) => errors.push(content) }, console: { warn() {} },
    window: { electronAPI: { chatWorkPanelTabContextMenu: {
      popup: async (request) => {
        menus.push(request);
        if (removeDuringMenu) workspace.items = [];
        return { actionId };
      },
      revealLocalResource: (request) => fileAction("reveal", request),
      openLocalResource: (request) => fileAction("open-default", request),
    } } },
  });
  vm.runInContext(outputText, context);
  return {
    calls, errors, menus, relativePath,
    invoke: () => context.handlers.handleTabContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 }, "chat-qa", item),
    matches: (identity) => context.handlers.matchesLocalResourceIdentity("chat-qa", item, identity),
  };
}

for (const actionId of ["reveal-resource", "open-resource-default-app"]) {
  test(`WorkPanel ${actionId} uses the same validated source for generic downloads and typed files`, async () => {
    for (const source of ["generic", "reference", "artifact"]) {
      const result = harness({ actionId, source });
      await result.invoke();
      const expectedProfile = source === "artifact" ? "artifact" : "reference";
      assert.equal(result.menus[0].profile, expectedProfile);
      assert.equal(result.menus[0].documentPathAvailable, true);
      assert.deepEqual(result.calls, [{
        action: actionId === "reveal-resource" ? "reveal" : "open-default",
        ownerChatId: "chat-qa", profile: expectedProfile, relativePath: result.relativePath,
      }]);
      assert.deepEqual(result.errors, []);
    }
  });

  test(`WorkPanel ${actionId} reports file and IPC failures`, async () => {
    for (const outcome of [
      { ok: false, code: "not_found", message: "文件不存在" },
      { ok: false, code: "path_outside_chat" },
      new Error("IPC unavailable"),
    ]) {
      const result = harness({ actionId, outcome });
      await result.invoke();
      assert.equal(result.calls.length, 1);
      assert.deepEqual(result.errors, [outcome.message === "文件不存在" ? "文件不存在" : "chatWorkPanel.resourceActions.failed"]);
    }
  });
}

test("WorkPanel validates current-resource bridge identities against the corrected profile", () => {
  const result = harness();
  const identity = { chatId: "chat-qa", profile: "reference", relativePath: result.relativePath };
  assert.equal(result.matches(identity), true);
  assert.equal(result.matches({ ...identity, profile: "artifact" }), false);
  assert.equal(result.matches({ ...identity, chatId: "another-chat" }), false);
  assert.equal(result.matches({ ...identity, relativePath: "another-file.txt" }), false);
});

test("closing a file while its native menu is open prevents a stale system action", async () => {
  const result = harness({ removeDuringMenu: true });
  await result.invoke();
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.errors, []);
});
