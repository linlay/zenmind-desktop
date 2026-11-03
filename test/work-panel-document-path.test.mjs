import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), ts = require("typescript");
const {
  resolveChatWorkPanelLocalResourcePath,
  resolveChatWorkPanelLocalResourceProfile,
} = require("../dist-electron/shared/chat-work-panel-tab-context-menu.js");
const { formatWorkPanelFileAddress } = require("../dist-electron/shared/work-panel-file-address.js");
const source = ts.createSourceFile("host.tsx", fs.readFileSync(new URL("../src/renderer/work-panel/WorkPanelHost.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ["localResourceProfile", "workPanelDocumentPath"].map((name) =>
  source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source));
const readPath = vm.runInNewContext(
  ts.transpileModule(`${declarations.join("\n")}\nworkPanelDocumentPath;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  { resolveChatWorkPanelLocalResourcePath, resolveChatWorkPanelLocalResourceProfile, formatWorkPanelFileAddress },
);
const route = (file, chatId = "chat") => "/resource-viewer/agent?" + new URLSearchParams({ chatId, file });
const webclient = (module, context, file, chatId) => ({ descriptor: { kind: "webclient", module, context, route: route(file, chatId) } });

test("tooltips and copy path use the @chat/ or @workspace/ address that Markdown accepts", () => {
  const relativePath = "artifacts/run/中文 视频 100%.mp4";
  assert.equal(readPath("chat", webclient("artifact", { artifactId: "artifact-1" }, `@chat/${relativePath}`)), `@chat/${relativePath}`);
  assert.equal(readPath("chat", webclient("reference", { referenceId: "reference-1" }, "@chat/references/附件.pdf")), "@chat/references/附件.pdf");
  // A generic Chat file opened through the artifact module keeps its real root.
  assert.equal(readPath("chat", webclient("artifact", { artifactId: "resource:9:abc" }, "@chat/附件 a%20b.mp4")), "@chat/附件 a%20b.mp4");
  assert.equal(readPath("chat", { descriptor: { kind: "native", surfaceKey: "document-html", context: { displayUrl: "@chat/artifacts/run/报告.html" } } }), "@chat/artifacts/run/报告.html");
  assert.equal(readPath("chat", { descriptor: { kind: "native", surfaceKey: "resource-image", context: { profile: "artifact", relativePath: "artifacts/run/图片.png" } } }), "@chat/artifacts/run/图片.png");
  assert.equal(readPath("chat", { descriptor: { kind: "native", surfaceKey: "document-image", context: { profile: "workspace-file", relativePath: "docs/图片.png" } } }), "@workspace/docs/图片.png");
  assert.equal(readPath("chat", { descriptor: { kind: "webclient", module: "file", context: { path: "src/app.ts" }, route: "" } }), "@workspace/src/app.ts");
  assert.equal(readPath("chat", { descriptor: { kind: "local-file", workspaceRelativePath: "docs/说明.md" } }), "@workspace/docs/说明.md");
});

test("no address is shown for a path whose root is not confirmed", () => {
  for (const path of ["/Users/demo/project/src/app.ts", "C:\\project\\src\\app.ts"]) {
    assert.equal(readPath("chat", { descriptor: { kind: "webclient", module: "file", context: { path }, route: "" } }), "");
  }
  assert.equal(readPath("chat", { descriptor: { kind: "local-file" } }), "");
  assert.equal(readPath("chat", webclient("artifact", { artifactId: "artifact-1" }, "artifacts/run/x.mp4")), "");
  assert.equal(readPath("chat", webclient("artifact", { artifactId: "artifact-1" }, "@chat/artifacts/run/x.mp4", "other")), "");
});
