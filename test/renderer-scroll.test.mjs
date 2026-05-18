import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const stylesPath = path.resolve(import.meta.dirname, "../src/renderer/styles.css");

function readRules(selector) {
  const styles = fs.readFileSync(stylesPath, "utf8");
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
  const styles = fs.readFileSync(stylesPath, "utf8");
  const match = styles.match(/^\.app-main\s*\{(?<body>[\s\S]*?)^\}/m);
  const appMainRule = match?.groups?.body;

  assert.ok(appMainRule, "missing scrollable .app-main rule");
  assert.match(appMainRule, /overflow:\s*auto;/);
  assert.doesNotMatch(appMainRule, /(?:-webkit-)?app-region:\s*drag;/);
});

test("main content keeps a dedicated titlebar drag strip", () => {
  const styles = fs.readFileSync(stylesPath, "utf8");
  const dragRegionRule = styles.match(
    /\.app-main-drag-region\s*\{[\s\S]*?app-region:\s*drag;[\s\S]*?-webkit-app-region:\s*drag;[\s\S]*?\}/
  )?.[0];

  assert.ok(dragRegionRule, "missing draggable .app-main-drag-region rule");
  assert.match(dragRegionRule, /app-region:\s*drag;/);
  assert.match(dragRegionRule, /-webkit-app-region:\s*drag;/);
});

test("settings page no longer reserves a dedicated drag-region override", () => {
  const styles = fs.readFileSync(stylesPath, "utf8");

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
