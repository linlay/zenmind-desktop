import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");

// Execute the real handle effects, including their cleanup, as React does when
// Fast Refresh replays effects but preserves the workspace and useRef state.
test("HTML handles survive effect replay and release only when their tabs disappear", async () => {
  const sourceText = fs.readFileSync(new URL("../src/renderer/work-panel/WorkPanelHost.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("host.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" &&
      node.arguments[0]?.getText(source).includes("previousDocumentHtmlHandlesRef")) callbacks.push(node.arguments[0].getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callbacks.length > 0);
  const releases = [];
  const context = vm.createContext({
    state: { workspaces: [{ ownerChatId: "chat", items: [{ descriptor: { kind: "native", surfaceKey: "document-html", context: { handleId: "html-handle" } } }] }] },
    previousDocumentHtmlHandlesRef: { current: new Map() },
    rendererGenerationRef: { current: "renderer-generation" },
    window: { electronAPI: { chatWorkPanel: { documentHtml: { release: async request => releases.push(request) } } } },
  });
  const effects = callbacks.map(callback => vm.runInContext(ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context));
  const cleanup = effects.map(effect => effect());
  for (const release of cleanup) release?.();
  effects.forEach(effect => effect());
  assert.equal(releases.length, 0, "effect cleanup must not revoke a visible HTML handle");
  context.state.workspaces = [];
  effects.forEach(effect => effect());
  assert.equal(releases.length, 1, "closing the tab still revokes its handle");
  assert.equal(releases[0].handleIds[0], "html-handle");
  assert.equal(releases[0].ownerChatId, "chat");
  assert.equal(releases[0].rendererGeneration, "renderer-generation");
  effects.forEach(effect => effect());
  assert.equal(releases.length, 1);
});
