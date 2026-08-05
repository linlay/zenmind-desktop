import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("running WebApps show a green status dot in the existing action slot", () => {
  const appShell = readSource("src", "renderer", "app-shell", "AppShell.tsx");
  const appSidebar = readSource(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx",
  );
  const navigationCss = readSource(
    "src",
    "renderer",
    "styles",
    "navigation.css",
  );

  assert.match(appShell, /const webRunningEntryKeys = useMemo\(/);
  assert.match(
    appShell,
    /item\.kind === "webapp" &&\s*webappRuntimeById\[item\.id\]\?\.status === "running"/,
  );
  assert.match(appShell, /webRunningEntryKeys=\{webRunningEntryKeys\}/);
  assert.match(
    appSidebar,
    /webRunningEntryKeys\.includes\(webItem\.entryKey\)/,
  );
  assert.match(
    appSidebar,
    /className="sidebar-website-status-dot sidebar-webapp-status-dot"/,
  );
  assert.match(appSidebar, /<SidebarActionIcon kind="more_actions" \/>/);
  assert.match(
    navigationCss,
    /\.sidebar-webapp-status-dot\s*\{[\s\S]*?top:\s*9px;[\s\S]*?left:\s*9px;/u,
  );
  assert.match(
    navigationCss,
    /\.sidebar-website-child-action\s*\{[\s\S]*?opacity:\s*0;/u,
  );
  assert.match(
    navigationCss,
    /\.sidebar-website-child-row:hover \.sidebar-website-child-action[\s\S]*?opacity:\s*1;/u,
  );
});
