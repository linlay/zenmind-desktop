import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const source = fs.readFileSync("src/renderer/pages/kanban/CollapsibleIssueProperties.tsx", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
} }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, require: createRequire(import.meta.url) });
const { isEmptyIssuePropertyValue: isEmpty, CollapsibleIssueProperties } = module.exports;

test("empty property detection preserves zero, false and literal placeholder-like data", () => {
  for (const value of [null, undefined, "", "  \n", [], ["", null], {}]) assert.equal(isEmpty(value), true);
  for (const value of [0, false, "—", "未设置", [0], [false], { enabled: false }, "value"]) assert.equal(isEmpty(value), false);
});

function Property({ label }) { return React.createElement("div", null, label); }
function renderProperties(editing, includeEmpty = true) {
  return renderToStaticMarkup(React.createElement(CollapsibleIssueProperties, {
    editing, t: (key, params) => `${key}:${params.count}`
  }, [
    React.createElement(Property, { key: "zero", empty: isEmpty(0), label: "ZERO_VALUE" }),
    React.createElement(Property, { key: "false", empty: isEmpty(false), label: "FALSE_VALUE" }),
    includeEmpty && React.createElement(Property, { key: "missing", empty: true, label: "MISSING_VALUE" }),
    [includeEmpty && React.createElement(Property, { key: "custom", empty: true, label: "EMPTY_CUSTOM" })]
  ]));
}

test("basic properties initially hide empty rows and count nested custom properties", () => {
  const html = renderProperties(false);
  assert.match(html, /ZERO_VALUE/);
  assert.match(html, /FALSE_VALUE/);
  assert.doesNotMatch(html, /MISSING_VALUE|EMPTY_CUSTOM/);
  assert.match(html, /kanban.detail.expandEmptyProperties:2/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls=/);
});

test("editing exposes all properties without a collapse control", () => {
  const html = renderProperties(true);
  assert.match(html, /MISSING_VALUE/);
  assert.match(html, /EMPTY_CUSTOM/);
  assert.doesNotMatch(html, /<button/);
});

test("no empty properties means no empty-property control", () => {
  assert.doesNotMatch(renderProperties(false, false), /<button/);
});

test("zero effort is displayed as zero hours rather than an unset placeholder", () => {
  const detail = fs.readFileSync("src/renderer/pages/kanban/KanbanIssueDetailDialog.tsx", "utf8");
  const formatterSource = detail.slice(detail.indexOf("function formatEffort("), detail.indexOf("function issueExternalId("));
  const formatterJs = ts.transpileModule(formatterSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const formatEffort = vm.runInNewContext(`${formatterJs}; formatEffort;`);
  const t = (key, params) => params ? `${key}:${params.value}` : key;
  assert.equal(formatEffort(0, t), "kanban.detail.hours:0");
  assert.equal(formatEffort(3600, t), "kanban.detail.hours:1");
  assert.equal(formatEffort(null, t), "kanban.detail.notSet");
});
