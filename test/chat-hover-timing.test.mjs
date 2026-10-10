import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");
const { createTranslator } = require("../dist-electron/shared/i18n/index.js");
const t = createTranslator("zh-CN");
const source = fs.readFileSync("src/renderer/app-shell/navigation/ChatHoverTiming.tsx", "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} });
const mod = { exports: {} };
new Function("require", "module", "exports", outputText)((id) => {
  if (id.endsWith("/time-contract")) return require("../dist-electron/shared/time-contract.js");
  if (id.endsWith("/useI18n")) return { useI18n: () => ({ t }) };
  return require(id);
}, mod, mod.exports);
const { ChatHoverTiming, formatChatRelativeTime } = mod.exports;
const at = 1_791_638_173_281;

test("relative Chat age uses creation time and clamps future clock skew", () => {
  assert.equal(formatChatRelativeTime(at, at + 59_999, t), "刚刚");
  assert.equal(formatChatRelativeTime(at, at + 22 * 60_000, t), "22 分钟以前");
  assert.equal(formatChatRelativeTime(at, at + 3 * 3_600_000, t), "3 小时以前");
  assert.equal(formatChatRelativeTime(at, at + 2 * 86_400_000, t), "2 天以前");
  assert.equal(formatChatRelativeTime(at, at - 5000, t), "刚刚");
});

test("English relative Chat age uses singular units at each boundary", () => {
  const en = createTranslator("en-US");
  for (const [duration, expected] of [[60_000, "1 minute ago"], [3_600_000, "1 hour ago"], [86_400_000, "1 day ago"], [365 * 86_400_000, "1 year ago"], [22 * 60_000, "22 minutes ago"]]) {
    assert.equal(formatChatRelativeTime(at, at + duration, en), expected);
  }
});

test("hover timing renders the absolute creation time with relative age", () => {
  const chat = { createdAt: at, updatedAt: at + 999_999 };
  const render = (value) => renderToStaticMarkup(React.createElement(ChatHoverTiming, { chat: value }));
  const html = render(chat);
  assert.ok(html.includes("提问于："));
  assert.match(html, /（\d+ .*以前）|（刚刚）/);
  assert.ok(!html.includes("上次运行"));
});
