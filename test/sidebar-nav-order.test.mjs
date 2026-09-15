import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = process.cwd();
const sourcePath = path.join(
  projectRoot,
  "src",
  "renderer",
  "app-shell",
  "navigation",
  "sidebarNavOrder.ts",
);
const source = fs.readFileSync(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
});
const mod = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", outputText)(
  mod.exports,
  require,
  mod,
  sourcePath,
  path.dirname(sourcePath),
);

const {
  createDefaultSidebarNavOrderItems,
  normalizeSidebarNavOrder,
  partitionSidebarWebItems,
  moveSidebarNavItem,
} = mod.exports;

test("default order is stable and missing items append after valid saved entries", () => {
  const availableItems = createDefaultSidebarNavOrderItems({
    kanbanEnabled: true,
    serviceItems: [],
    experimentalItems: [],
    webItems: [],
  });

  assert.deepEqual(
    availableItems.map((item) => item.key),
    ["kanban", "schedules", "new-chat", "chats", "group:assistants", "group:webs"],
  );
  assert.deepEqual(
    normalizeSidebarNavOrder(
      ["kanban", "schedules", "group:assistants", "group:webs"],
      availableItems,
    ),
    ["kanban", "schedules", "group:assistants", "group:webs", "new-chat", "chats"],
  );
});

test("Chats keeps an explicit saved navigation position", () => {
  const availableItems = createDefaultSidebarNavOrderItems({
    kanbanEnabled: true,
    serviceItems: [],
    experimentalItems: [],
    webItems: [],
  });

  assert.deepEqual(
    normalizeSidebarNavOrder(
      ["kanban", "schedules", "group:assistants", "chats", "group:webs"],
      availableItems,
    ),
    ["kanban", "schedules", "group:assistants", "chats", "group:webs", "new-chat"],
  );
});


test("website and webapp pins preserve pin order and restore the original Sites order", () => {
  const site = { orderKey: "website:docs" };
  const app = { orderKey: "webapp:editor" };
  const other = { orderKey: "website:news" };
  const items = [site, other, app];
  const pins = ["webapp:editor", "website:missing", "website:docs", "webapp:editor"];
  assert.deepEqual(partitionSidebarWebItems(items, pins), {
    pinned: [app, site], unpinned: [other]
  });
  assert.deepEqual(partitionSidebarWebItems(items, ["website:docs"]), {
    pinned: [site], unpinned: [other, app]
  });
  assert.deepEqual(partitionSidebarWebItems(items, []), { pinned: [], unpinned: items });
  assert.deepEqual(items, [site, other, app]);
});

test("mixed navigation order preserves moved Kanban, independent New Chat and web pins", () => {
  const items = [
    { key: "webapp:editor", label: "Editor" },
    { key: "website:docs", label: "Docs" },
    ...createDefaultSidebarNavOrderItems({ serviceItems: [], experimentalItems: [], webItems: [] }),
  ];
  const initial = normalizeSidebarNavOrder(undefined, items);
  assert.deepEqual(initial.slice(0, 5), ["webapp:editor", "website:docs", "kanban", "schedules", "new-chat"]);
  const moved = moveSidebarNavItem(initial, "new-chat", "webapp:editor", false);
  const mixed = moveSidebarNavItem(moved, "kanban", "schedules", true);
  assert.deepEqual(mixed.slice(0, 5), ["new-chat", "webapp:editor", "website:docs", "schedules", "kanban"]);
  assert.deepEqual(normalizeSidebarNavOrder([...mixed, "kanban", "website:deleted"], items), mixed);
  assert.deepEqual(normalizeSidebarNavOrder(mixed, items.filter((item) => item.key !== "webapp:editor")), mixed.filter((key) => key !== "webapp:editor"));
  assert.deepEqual(moveSidebarNavItem(mixed, "website:missing", "kanban", false), mixed);
  assert.deepEqual(moveSidebarNavItem(mixed, "kanban", "kanban", true), mixed);
});

test("newly available entries append uniformly, including pins and chat entries", () => {
  const items = ["website:docs", "new-chat", "chats", "schedules"].map((key) => ({ key, label: key }));
  assert.deepEqual(normalizeSidebarNavOrder(["schedules", "schedules", null, "removed"], items),
    ["schedules", "website:docs", "new-chat", "chats"]);
  assert.deepEqual(normalizeSidebarNavOrder(null, items), items.map(({ key }) => key));
});
