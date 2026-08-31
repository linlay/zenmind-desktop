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
  "capabilityNavigation.ts",
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
  CAPABILITY_NAVIGATION_ITEMS,
  getCapabilityNavigationItem,
  isCapabilityNavigationRoute,
  resolveSidebarMode,
} = mod.exports;

test("capability navigation keeps the agreed item order", () => {
  assert.deepEqual(
    CAPABILITY_NAVIGATION_ITEMS.map((item) => item.id),
    ["agents", "skills", "market", "mcp-servers", "registries", "archives", "help"],
  );
  assert.deepEqual(
    CAPABILITY_NAVIGATION_ITEMS.map((item) => item.to),
    ["/agents", "/skills", "/market", "/mcp-servers", "/registries", "/archives", "/help"],
  );
});

test("capability routes select their root item and keep supported details active", () => {
  const cases = [
    ["/agents", "agents"],
    ["/agents/demo-agent", "agents"],
    ["/agents/%E4%B8%AD%E6%96%87?tab=profile", "agents"],
    ["/skills", "skills"],
    ["/skills/demo-skill?tab=files", "skills"],
    ["/market", "market"],
    ["/mcp-servers", "mcp-servers"],
    ["/registries", "registries"],
    ["/archives", "archives"],
    ["/help", "help"],
  ];

  for (const [route, expectedId] of cases) {
    assert.equal(getCapabilityNavigationItem(route)?.id, expectedId);
    assert.equal(isCapabilityNavigationRoute(route), true);
    assert.equal(resolveSidebarMode(route), "capabilities");
  }
});

test("primary and settings routes do not enter capability mode", () => {
  for (const route of [
    "/agent/demo-agent",
    "/automations",
    "/memory",
    "/help/topic",
    "/agentship",
    "/skills-center",
    "/archives/old-chat",
  ]) {
    assert.equal(getCapabilityNavigationItem(route), null);
    assert.equal(resolveSidebarMode(route), "primary");
  }

  assert.equal(resolveSidebarMode("/settings"), "settings");
  assert.equal(resolveSidebarMode("/settings/general"), "settings");
});

test("the app shell renders capability routes as a fixed secondary sidebar", () => {
  const appShellSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "AppShell.tsx"),
    "utf8",
  );
  const sidebarSource = fs.readFileSync(
    path.join(
      projectRoot,
      "src",
      "renderer",
      "app-shell",
      "navigation",
      "AppSidebar.tsx",
    ),
    "utf8",
  );

  assert.match(
    appShellSource,
    /const sidebarMode = resolveSidebarMode\(location\.pathname\);/u,
  );
  assert.match(
    appShellSource,
    /isSecondarySidebarMode\s*\?\s*SETTINGS_SIDEBAR_WIDTH/u,
  );
  assert.match(
    appShellSource,
    /onExitSecondarySidebarMode=\{handleExitSecondarySidebarMode\}/u,
  );
  assert.match(sidebarSource, /function renderCapabilitiesNav\(\)/u);
  assert.match(
    sidebarSource,
    /isCapabilitiesMode[\s\S]*?renderCapabilitiesNav\(\)/u,
  );
});

test("the account menu keeps Market as an entry into the capability subpage", () => {
  const sidebarSource = fs.readFileSync(
    path.join(
      projectRoot,
      "src",
      "renderer",
      "app-shell",
      "navigation",
      "AppSidebar.tsx",
    ),
    "utf8",
  );
  const menuStart = sidebarSource.indexOf("const fixedToolRowsBase");
  const menuEnd = sidebarSource.indexOf("type AccountMenuAvatarProps", menuStart);
  const legacyMenu = sidebarSource.slice(menuStart, menuEnd);

  assert.match(legacyMenu, /to:\s*"\/market"/u);
  assert.equal(getCapabilityNavigationItem("/market")?.id, "market");
  assert.equal(resolveSidebarMode("/market"), "capabilities");
});
