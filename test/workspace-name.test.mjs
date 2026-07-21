import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const typescript = require("typescript");
const projectRoot = process.cwd();

function loadWorkspaceNameModule() {
  const sourcePath = path.join(
    projectRoot,
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "workspaceName.ts",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  }).outputText;
  const mod = { exports: {} };
  new Function("exports", "module", output)(mod.exports, mod);
  return mod.exports;
}

const { getAssistantWorkspaceName } = loadWorkspaceNameModule();

test("assistant workspace name hides POSIX and Windows root directories", () => {
  assert.equal(getAssistantWorkspaceName("/", true), "");
  assert.equal(getAssistantWorkspaceName("C:\\", true), "");
  assert.equal(getAssistantWorkspaceName("C:/", true), "");
  assert.equal(getAssistantWorkspaceName("C:", true), "");
});

test("assistant workspace name keeps ordinary directory basenames", () => {
  assert.equal(
    getAssistantWorkspaceName("/Users/a/demo/", true),
    "demo",
  );
  assert.equal(
    getAssistantWorkspaceName("C:\\Users\\a\\demo\\", true),
    "demo",
  );
});

test("assistant workspace name hides missing, chat, and nonexistent workspaces", () => {
  assert.equal(getAssistantWorkspaceName(undefined, true), "");
  assert.equal(getAssistantWorkspaceName("   ", true), "");
  assert.equal(getAssistantWorkspaceName("@chat", true), "");
  assert.equal(getAssistantWorkspaceName("C:\\Users\\a\\demo", false), "");
});
