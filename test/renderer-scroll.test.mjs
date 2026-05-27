import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const stylesPath = path.resolve(import.meta.dirname, "../src/renderer/styles.css");

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
  const styles = readStyles();
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
});

test("task board columns and cards adapt to the available board width", () => {
  const pageRule = readRule(".task-board-page");
  const columnsRule = readRule(".task-board-columns");
  const columnRule = readRule(".task-board-column");
  const cardRule = readRule(".task-board-card");
  const styles = readStyles();

  assert.match(pageRule, /--task-board-column-gap:\s*16px;/);
  assert.match(pageRule, /--task-board-column-min-width:\s*260px;/);
  assert.match(pageRule, /--task-board-column-fit-width:\s*calc\(\(100% - 32px\) \/ 3\);/);
  assert.match(
    pageRule,
    /--task-board-column-width:\s*max\(\s*calc\(\(100% - 48px\) \/ 4\),\s*min\(var\(--task-board-column-min-width\), var\(--task-board-column-fit-width\)\)\s*\);/
  );
  assert.match(
    pageRule,
    /--task-board-columns-total-width:\s*calc\(\s*var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+ var\(--task-board-column-width\) \+\s*var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\) \+ var\(--task-board-column-gap\)\s*\);/
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
  assert.doesNotMatch(readRule(".task-board-column.is-completed"), /margin-left:/);
  assert.match(columnRule, /flex:\s*0\s+0\s+var\(--task-board-column-width\);/);
  assert.match(columnRule, /width:\s*var\(--task-board-column-width\);/);
  assert.match(columnRule, /min-width:\s*var\(--task-board-column-width\);/);
  assert.match(columnRule, /max-width:\s*var\(--task-board-column-width\);/);
  assert.match(cardRule, /width:\s*100%;/);
  assert.match(cardRule, /min-width:\s*0;/);
});

test("task board cards keep vertical pan gestures available inside scrollable columns", () => {
  const cardRule = readRule(".task-board-card");
  const lockedCardRule = readRule(".task-board-card.is-drag-locked");

  assert.match(cardRule, /touch-action:\s*pan-y;/);
  assert.doesNotMatch(cardRule, /touch-action:\s*none;/);
  assert.match(lockedCardRule, /touch-action:\s*auto;/);
});
