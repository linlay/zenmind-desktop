import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readPluginPageSource() {
  return fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "plugin", "PluginPage.tsx"),
    "utf8",
  );
}

test("plugin page does not sync API resource navigations back into the embedded app router", () => {
  const pluginPage = readPluginPageSource();
  const routeSyncBlock = pluginPage.slice(
    pluginPage.indexOf("function isPluginRouteSyncTarget"),
    pluginPage.indexOf("function resolvePluginCurrentUrl"),
  );
  const navigationHandlerBlock = pluginPage.slice(
    pluginPage.indexOf("const syncNavigationRoute = (event: Event) =>"),
    pluginPage.indexOf("const handleDidFailLoad = () =>"),
  );

  assert.match(pluginPage, /function isPluginRouteSyncTarget/);
  assert.match(routeSyncBlock, /pathname === "\/api"/);
  assert.match(routeSyncBlock, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(routeSyncBlock, /pathname === "\/ws"/);
  assert.match(routeSyncBlock, /pathname === "\/runtime-config\.js"/);
  assert.match(navigationHandlerBlock, /readEventBoolean\(event, "isMainFrame"\) !== false/);
  assert.match(navigationHandlerBlock, /isPluginRouteSyncTarget\(nextUrl, webviewSrcUrl\)/);
  assert.match(navigationHandlerBlock, /sendPluginRouteToWebview\(resolvedUrl, "navigation"\)/);
});

test("plugin page reports webview breadcrumbs for post-crash diagnosis", () => {
  const pluginPage = readPluginPageSource();

  assert.match(pluginPage, /function reportPluginWebviewDiagnostic/);
  assert.match(pluginPage, /source:\s*"plugin-webview"/);
  assert.match(pluginPage, /reportPluginWebviewDiagnostic\("listeners-attached"\)/);
  assert.match(pluginPage, /reportPluginWebviewDiagnostic\("dom-ready"\)/);
  assert.match(pluginPage, /reportPluginWebviewDiagnostic\("navigation"/);
  assert.match(pluginPage, /reportPluginWebviewDiagnostic\("direct-route-load-url"/);
  assert.match(pluginPage, /reportPluginWebviewDiagnostic\("direct-route-load-failed"/);
});

test("plugin page falls back to loadURL when client-side route navigation misses the target", () => {
  const pluginPage = readPluginPageSource();
  const directRouteLoadBlock = pluginPage.slice(
    pluginPage.indexOf("function requestDirectWebviewRouteLoad"),
    pluginPage.indexOf("async function injectAgentWebclientAccessToken"),
  );

  assert.match(directRouteLoadBlock, /direct-route-client-navigation-mismatch/);
  assert.match(directRouteLoadBlock, /clientNavigationResult/);
  assert.match(directRouteLoadBlock, /resolvePluginCurrentUrl\(/);
  assert.match(directRouteLoadBlock, /targetWebview\.loadURL\(embeddedUrl\)/);
});
