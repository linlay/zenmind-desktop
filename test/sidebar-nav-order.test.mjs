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
} = mod.exports;

test("Chats defaults after Automations and is inserted for saved legacy orders", () => {
  const availableItems = createDefaultSidebarNavOrderItems({
    kanbanEnabled: true,
    serviceItems: [],
    experimentalItems: [],
    webItems: [],
  });

  assert.deepEqual(
    availableItems.map((item) => item.key),
    ["kanban", "schedules", "chats", "group:assistants", "group:webs"],
  );
  assert.deepEqual(
    normalizeSidebarNavOrder(
      ["kanban", "schedules", "group:assistants", "group:webs"],
      availableItems,
    ),
    ["kanban", "schedules", "chats", "group:assistants", "group:webs"],
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
    ["kanban", "schedules", "group:assistants", "chats", "group:webs"],
  );
});
