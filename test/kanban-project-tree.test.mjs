import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadKanbanProjectTreeModule() {
  const sourcePath = path.resolve("src/renderer/pages/kanban/kanbanProjectTree.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports }, { filename: sourcePath });
  return module.exports;
}

function project(overrides = {}) {
  const now = "2026-06-17T08:00:00.000Z";
  return {
    id: "project-a",
    parentId: null,
    slug: "project-a",
    key: "PROJECT_A",
    name: "Project A",
    description: "",
    path: "project-a",
    depth: 0,
    position: 1,
    visibility: "workspace",
    defaultWorkflowId: "workflow-standard-requirement",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("flattenKanbanProjectTree omits aggregate default root from selectable tree", () => {
  const { flattenKanbanProjectTree } = loadKanbanProjectTreeModule();
  const items = flattenKanbanProjectTree([
    project({
      id: "default",
      parentId: null,
      slug: "default",
      key: "DEFAULT",
      name: "All Projects",
      path: "default",
      depth: 0,
      position: 0
    }),
    project({
      id: "finance",
      parentId: "default",
      slug: "finance",
      name: "财务对账系统",
      path: "财务对账系统",
      depth: 1,
      position: 1
    })
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].project.id, "finance");
  assert.equal(items[0].level, 0);
});

test("flattenKanbanProjectTree keeps non-aggregate roots at level zero", () => {
  const { flattenKanbanProjectTree } = loadKanbanProjectTreeModule();
  const items = flattenKanbanProjectTree([
    project({ id: "alpha", name: "Alpha", path: "alpha" }),
    project({
      id: "beta",
      parentId: "alpha",
      name: "Beta",
      path: "alpha/beta",
      depth: 1,
      position: 2
    })
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].project.id, "alpha");
  assert.equal(items[0].level, 0);
  assert.equal(items[1].project.id, "beta");
  assert.equal(items[1].level, 1);
});
