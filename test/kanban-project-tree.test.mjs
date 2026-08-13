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

test("matchesKanbanProjectSelection keeps local issues separate from cloud projects", () => {
  const { matchesKanbanProjectSelection } = loadKanbanProjectTreeModule();
  const cloudProjectIds = new Set(["cloud-project"]);
  const localIssue = { projectId: "cloud-project", syncMode: "local" };
  const cloudIssue = { projectId: "cloud-project", syncMode: "cloud" };

  assert.equal(matchesKanbanProjectSelection(localIssue, null, false), true);
  assert.equal(matchesKanbanProjectSelection(cloudIssue, null, false), true);
  assert.equal(matchesKanbanProjectSelection(localIssue, null, true), true);
  assert.equal(matchesKanbanProjectSelection(cloudIssue, null, true), false);
  assert.equal(matchesKanbanProjectSelection(localIssue, cloudProjectIds, false), false);
  assert.equal(matchesKanbanProjectSelection(cloudIssue, cloudProjectIds, false), true);
  assert.equal(matchesKanbanProjectSelection(localIssue, cloudProjectIds, true), true);
  assert.equal(matchesKanbanProjectSelection(cloudIssue, cloudProjectIds, true), true);
});

test("selected descendants mark unselected project ancestors as partial", () => {
  const { getKanbanPartiallySelectedProjectIds } = loadKanbanProjectTreeModule();
  const projects = [
    project({ id: "default", parentId: null }),
    project({ id: "commerce", parentId: "default" }),
    project({ id: "backend", parentId: "commerce" }),
    project({ id: "orders", parentId: "backend" }),
    project({ id: "payments", parentId: "backend" })
  ];

  assert.deepEqual(
    [...getKanbanPartiallySelectedProjectIds(projects, ["orders"])].sort(),
    ["backend", "commerce"]
  );
  assert.deepEqual(
    [...getKanbanPartiallySelectedProjectIds(projects, ["backend", "orders"])].sort(),
    ["commerce"]
  );
  assert.deepEqual(
    [...getKanbanPartiallySelectedProjectIds(projects, [])],
    []
  );
});

test("project tree selection cascades down and recalculates ancestors", () => {
  const { toggleKanbanProjectTreeSelection } = loadKanbanProjectTreeModule();
  const projects = [
    project({ id: "default", parentId: null }),
    project({ id: "commerce", parentId: "default" }),
    project({ id: "backend", parentId: "commerce" }),
    project({ id: "orders", parentId: "backend" }),
    project({ id: "payments", parentId: "backend" }),
    project({ id: "storefront", parentId: "commerce" })
  ];

  const selectedCommerce = toggleKanbanProjectTreeSelection(projects, [], "commerce");
  assert.deepEqual(selectedCommerce, ["commerce", "backend", "orders", "payments", "storefront"]);

  const deselectedOrders = toggleKanbanProjectTreeSelection(projects, selectedCommerce, "orders");
  assert.deepEqual(deselectedOrders, ["payments", "storefront"]);

  const reselectedOrders = toggleKanbanProjectTreeSelection(projects, deselectedOrders, "orders");
  assert.deepEqual(reselectedOrders, ["commerce", "backend", "orders", "payments", "storefront"]);

  const clearedCommerce = toggleKanbanProjectTreeSelection(projects, reselectedOrders, "commerce");
  assert.deepEqual(clearedCommerce, []);
});
