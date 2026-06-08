import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const stylesPath = path.resolve(import.meta.dirname, "../src/renderer/styles.css");
const projectRoot = path.resolve(import.meta.dirname, "..");

function readSourceFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

function readCssWithImports(filePath, visited = new Set()) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(import.meta.dirname, "..", filePath);
  if (visited.has(absolutePath)) {
    return "";
  }
  visited.add(absolutePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  return content.replace(/@import\s+["']([^"']+)["'];/g, (_match, importPath) =>
    readCssWithImports(path.resolve(path.dirname(absolutePath), importPath), visited)
  );
}

function readStyles() {
  return readCssWithImports(stylesPath);
}

function readRules(selector) {
  const styles = readStyles().replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = styles.matchAll(/(?<selectors>[^{}]+)\{(?<body>[^}]+)\}/g);
  const matches = [];

  for (const rule of rules) {
    const selectors = rule.groups?.selectors
      .split(",")
      .map((value) => value.trim());
    if (selectors?.includes(selector)) {
      matches.push(rule.groups?.body ?? "");
    }
  }

  return matches;
}

function readRule(selector) {
  const matches = readRules(selector);
  if (matches.length > 0) {
    return matches[0];
  }
  assert.fail(`missing CSS rule for ${selector}`);
}

test("main content scroll container is not a window drag region", () => {
  const styles = readStyles();
  const match = styles.match(/^\.app-main\s*\{(?<body>[\s\S]*?)^\}/m);
  const appMainRule = match?.groups?.body;

  assert.ok(appMainRule, "missing scrollable .app-main rule");
  assert.match(appMainRule, /overflow:\s*auto;/);
  assert.doesNotMatch(appMainRule, /(?:-webkit-)?app-region:\s*drag;/);
});

test("main content keeps a dedicated titlebar drag strip", () => {
  const styles = readStyles();
  const dragRegionRule = styles.match(
    /\.app-main-drag-region\s*\{[\s\S]*?app-region:\s*drag;[\s\S]*?-webkit-app-region:\s*drag;[\s\S]*?\}/
  )?.[0];

  assert.ok(dragRegionRule, "missing draggable .app-main-drag-region rule");
  assert.match(dragRegionRule, /app-region:\s*drag;/);
  assert.match(dragRegionRule, /-webkit-app-region:\s*drag;/);
});

test("settings page no longer reserves a dedicated drag-region override", () => {
  const styles = readStyles();

  assert.doesNotMatch(styles, /\.settings-mode-close-button\s*\{/);
  assert.doesNotMatch(styles, /\.app-shell\.is-settings-route\s+\.app-window-drag-region\s*\{/);
});

test("mac sidebar drag strip leaves the traffic-light controls clickable", () => {
  const dragRegionRule = readRule(".app-shell.is-mac-platform .sidebar-chrome-drag-region");

  assert.match(dragRegionRule, /left:\s*var\(--mac-traffic-light-safe-area\);/);
});

test("external webview tabs are excluded from the window drag region", () => {
  const tabStripRule = readRule(".external-webview-tab-strip");
  const tabRule = readRule(".external-webview-tab");

  assert.match(tabStripRule, /app-region:\s*no-drag;/);
  assert.match(tabStripRule, /-webkit-app-region:\s*no-drag;/);
  assert.match(tabRule, /app-region:\s*no-drag;/);
  assert.match(tabRule, /-webkit-app-region:\s*no-drag;/);
});

test("external webview new-tab button stays next to the tab strip content", () => {
  const tabStripRule = readRule(".external-webview-tab-strip");
  const tabAddRules = readRules(".external-webview-tab-add");

  assert.match(tabStripRule, /flex:\s*0\s+1\s+auto;/);
  assert.match(tabStripRule, /max-width:\s*calc\(100%\s*-\s*42px\);/);
  assert.ok(tabAddRules.some((rule) => /flex:\s*none;/.test(rule)));
});

test("external webview address bar stays readable in dark mode", () => {
  const locationRule = readRule(':root[data-theme="dark"] .external-webview-toolbar-location');
  const focusRule = readRule(':root[data-theme="dark"] .external-webview-toolbar-location:focus-within');
  const inputRule = readRule(':root[data-theme="dark"] .external-webview-toolbar-location-input');
  const placeholderRule = readRule(':root[data-theme="dark"] .external-webview-toolbar-location-input::placeholder');

  assert.match(locationRule, /background:\s*#1f2329;/);
  assert.match(locationRule, /border-color:\s*rgba\(255,\s*255,\s*255,\s*0\.14\);/);
  assert.match(locationRule, /box-shadow:\s*inset 0 1px 0 rgba\(255,\s*255,\s*255,\s*0\.04\);/);
  assert.match(focusRule, /background:\s*#262a31;/);
  assert.match(inputRule, /color:\s*#f1f3f4;/);
  assert.match(inputRule, /-webkit-text-fill-color:\s*#f1f3f4;/);
  assert.match(placeholderRule, /color:\s*#9aa0a6;/);
});

test("sidebar navigation scrolls independently so footer actions stay reachable", () => {
  const navRule = readRules(".sidebar-nav").find((rule) =>
    /overflow-y:\s*auto;/.test(rule)
  );
  const footerRule = readRules(".sidebar-footer").find((rule) =>
    /flex:\s*0\s+0\s+auto;/.test(rule)
  );
  const scrollbarRule = readRule(".sidebar-nav::-webkit-scrollbar");

  assert.ok(navRule, "missing scrollable .sidebar-nav rule");
  assert.ok(footerRule, "missing fixed .sidebar-footer rule");
  assert.match(navRule, /^\s*flex:\s*1;/m);
  assert.match(navRule, /^\s*min-height:\s*0;/m);
  assert.match(navRule, /overflow-y:\s*auto;/);
  assert.match(navRule, /overflow-x:\s*hidden;/);
  assert.match(navRule, /scrollbar-width:\s*thin;/);
  assert.match(navRule, /app-region:\s*no-drag;/);
  assert.match(navRule, /-webkit-app-region:\s*no-drag;/);
  assert.match(footerRule, /flex:\s*0\s+0\s+auto;/);
  assert.match(scrollbarRule, /width:\s*6px;/);
});

test("embedded website group scrolls after six rows without pushing footer", () => {
  const sidebarSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx"
  );
  const websiteChildrenRule = readRule(".sidebar-website-children");
  const websiteScrollbarRule = readRule(".sidebar-website-children::-webkit-scrollbar");

  assert.match(sidebarSource, /sidebar-website-children/);
  assert.match(websiteChildrenRule, /max-height:\s*calc\(\(30px \* 6\) \+ \(2px \* 5\)\);/);
  assert.match(websiteChildrenRule, /overflow-y:\s*auto;/);
  assert.match(websiteChildrenRule, /overflow-x:\s*hidden;/);
  assert.match(websiteChildrenRule, /scrollbar-width:\s*thin;/);
  assert.match(websiteScrollbarRule, /width:\s*6px;/);
});

test("task board constrains its page height so columns can scroll vertically", () => {
  const pageRule = readRule(".task-board-page");
  const columnRule = readRule(".task-board-column");
  const columnBodyRule = readRule(".task-board-column-body");

  assert.match(pageRule, /^\s*height:\s*100%;/m);
  assert.match(pageRule, /^\s*min-height:\s*0;/m);
  assert.match(pageRule, /overflow:\s*hidden;/);
  assert.match(columnRule, /min-height:\s*0;/);
  assert.match(columnBodyRule, /min-height:\s*0;/);
  assert.match(columnBodyRule, /overflow-y:\s*auto;/);
  assert.match(readRule(".task-board-column.is-completed .task-board-column-body"), /scrollbar-width:\s*thin;/);
  assert.match(readRule(".task-board-column.is-completed .task-board-column-body::-webkit-scrollbar"), /display:\s*block;/);
});

test("task board columns and cards adapt to the available board width", () => {
  const pageRule = readRule(".task-board-page");
  const columnsRule = readRule(".task-board-columns");
  const columnRule = readRule(".task-board-column");
  const cardRule = readRule(".task-board-card");
  const styles = readStyles();

  assert.match(pageRule, /--task-board-column-gap:\s*16px;/);
  assert.match(pageRule, /--task-board-column-min-width:\s*260px;/);
  assert.match(pageRule, /--task-board-column-fit-width:\s*calc\(\(100% - 48px\) \/ 4\);/);
  assert.match(
    pageRule,
    /--task-board-column-width:\s*max\(\s*calc\(\(100% - 64px\) \/ 5\),\s*min\(var\(--task-board-column-min-width\), var\(--task-board-column-fit-width\)\)\s*\);/
  );
  assert.match(
    pageRule,
    /--task-board-columns-total-width:\s*calc\(\s*var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+\s*var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\)\s*\);/
  );
  assert.match(
    pageRule,
    /--task-board-column-fold-offset:\s*max\(0px,\s*calc\(var\(--task-board-columns-total-width\) - 100%\)\);/
  );
  assert.match(columnsRule, /gap:\s*var\(--task-board-column-gap\);/);
  assert.match(columnsRule, /overflow-x:\s*hidden;/);
  assert.match(styles, /\.task-board-columns\.is-backlog-expanded \.task-board-column\.is-todo\s*\{[\s\S]*?margin-left:\s*0;/);
  assert.match(readRule(".task-board-column.is-todo"), /margin-left:\s*calc\(var\(--task-board-column-fold-offset\) \* -1\);/);
  assert.doesNotMatch(readRule(".task-board-column.is-in_progress"), /margin-left:/);
  assert.doesNotMatch(readRule(".task-board-column.is-in_review"), /margin-left:/);
  assert.doesNotMatch(readRule(".task-board-column.is-completed"), /margin-left:/);
  assert.match(columnRule, /flex:\s*0\s+0\s+var\(--task-board-column-width\);/);
  assert.match(columnRule, /width:\s*var\(--task-board-column-width\);/);
  assert.match(columnRule, /min-width:\s*var\(--task-board-column-width\);/);
  assert.match(columnRule, /max-width:\s*var\(--task-board-column-width\);/);
  assert.match(cardRule, /flex:\s*0\s+0\s+96px;/);
  assert.match(cardRule, /width:\s*100%;/);
  assert.match(cardRule, /min-width:\s*0;/);
  assert.match(cardRule, /box-shadow:\s*none;/);
  assert.match(readRule(".task-board-card:hover"), /box-shadow:\s*none;/);
});

test("task board cards keep vertical pan gestures available inside scrollable columns", () => {
  const cardRule = readRule(".task-board-card");
  const lockedCardRule = readRule(".task-board-card.is-drag-locked");

  assert.match(cardRule, /touch-action:\s*pan-y;/);
  assert.doesNotMatch(cardRule, /touch-action:\s*none;/);
  assert.match(lockedCardRule, /touch-action:\s*auto;/);
});
