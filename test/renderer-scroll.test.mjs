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
  const dragRegionRule = readRule(".app-main-drag-region");

  assert.match(dragRegionRule, /app-region:\s*drag;/);
  assert.match(dragRegionRule, /-webkit-app-region:\s*drag;/);
});

test("settings mode close button is excluded from the window drag region", () => {
  const closeButtonRule = readRule(".settings-mode-close-button");
  const closeButtonIconRule = readRule(".settings-mode-close-button span");
  const settingsDragRegionRule = readRule(".app-shell.is-settings-route .app-window-drag-region");

  assert.match(closeButtonRule, /app-region:\s*no-drag;/);
  assert.match(closeButtonRule, /-webkit-app-region:\s*no-drag;/);
  assert.match(closeButtonIconRule, /pointer-events:\s*none;/);
  assert.match(closeButtonIconRule, /app-region:\s*no-drag;/);
  assert.match(closeButtonIconRule, /-webkit-app-region:\s*no-drag;/);
  assert.match(settingsDragRegionRule, /left:\s*calc\(var\(--app-sidebar-width,\s*160px\)\s*\+\s*96px\);/);
});

test("mac sidebar drag strip leaves the traffic-light controls clickable", () => {
  const dragRegionRule = readRule(".app-shell.is-mac-platform .app-sidebar-drag-region");

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
