import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), ts = require("typescript");
const { resolveChatWorkPanelLocalResourcePath } = require("../dist-electron/shared/chat-work-panel-tab-context-menu.js");
const source = ts.createSourceFile("host.tsx", fs.readFileSync(new URL("../src/renderer/work-panel/WorkPanelHost.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "workPanelDocumentPath");
const readPath = vm.runInNewContext(ts.transpileModule(`(${declaration.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { resolveChatWorkPanelLocalResourcePath });

test("HTML, MP4 and native images use the same artifact display URI for tooltips and copy path", () => {
  const relativePath = "artifacts/run/中文 视频.mp4", displayUrl = `artifact:///${relativePath}`;
  assert.equal(readPath("chat", { descriptor: { kind: "webclient", module: "artifact", context: { relativePath }, route: "" } }), displayUrl);
  assert.equal(readPath("chat", { descriptor: { kind: "webclient", module: "artifact", context: {}, route: "/resource-viewer/agent?" + new URLSearchParams({ chatId: "chat", file: `@chat/${relativePath}` }) } }), displayUrl);
  assert.equal(readPath("chat", { descriptor: { kind: "native", surfaceKey: "document-html", context: { displayUrl: "artifact:///artifacts/run/报告.html" } } }), "artifact:///artifacts/run/报告.html");
  assert.equal(readPath("chat", { descriptor: { kind: "native", surfaceKey: "resource-image", context: { profile: "artifact", relativePath: "artifacts/run/图片.png" } } }), "artifact:///artifacts/run/图片.png");
  assert.equal(readPath("chat", { descriptor: { kind: "webclient", module: "reference", context: { relativePath: "附件.mp4" }, route: "" } }), "reference:///附件.mp4");
  assert.equal(readPath("chat", { descriptor: { kind: "webclient", module: "artifact", context: {}, route: "/resource-viewer/agent?chatId=other&file=artifacts/x.mp4" } }), "");
});
