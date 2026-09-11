import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");
const source = fs.readFileSync("src/renderer/components/Popover/index.tsx", "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
} });
const mod = { exports: {} };
// Exercise render gating without a DOM; positioning and input are covered by manual QA.
new Function("require", "module", "exports", outputText)((id) => {
  if (id === "react") return { ...React, useLayoutEffect() {} };
  if (id === "react-dom") return { createPortal: (children) => children };
  if (id.endsWith(".css")) return {};
  return require(id);
}, mod, mod.exports);
const { Popover } = mod.exports;

test("closed popover does not construct content; opening uses current content", (t) => {
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
  let calls = 0;
  let title = "first";
  const content = () => { calls++; return React.createElement("span", null, title); };
  const render = (open) => renderToStaticMarkup(React.createElement(Popover, { open, content }, React.createElement("button", null, "trigger")));
  render(false);
  assert.equal(calls, 0);
  assert.match(render(true), /first/);
  title = "updated";
  assert.match(render(true), /updated/);
  render(false);
  assert.equal(calls, 2);
});
