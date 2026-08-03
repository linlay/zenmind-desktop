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

test("agent chat mirrors its business URL and only receives changed host params", () => {
  const pluginPage = readPluginPageSource();
  const routeDeliveryBlock = pluginPage.slice(
    pluginPage.indexOf("function sendPluginRouteToWebview"),
    pluginPage.indexOf("function requestDirectWebviewRouteLoad"),
  );
  const contextBridgeStart = pluginPage.lastIndexOf(
    "useEffect(() => {",
    pluginPage.indexOf("const postDesktopContextChanged"),
  );
  const contextBridgeBlock = pluginPage.slice(
    contextBridgeStart,
    pluginPage.indexOf("useEffect(() => {", contextBridgeStart + 1),
  );

  assert.match(pluginPage, /function isAgentWebclientChatSurface/);
  assert.match(pluginPage, /resolveAgentWebclientDesktopChatRouteFromUrl/);
  assert.match(pluginPage, /lastHostAppliedChatRouteRef/);
  assert.match(routeDeliveryBlock, /!areAgentWebclientChatNavigationUrlsEquivalent\(currentUrl, targetUrl\)/);
  assert.match(routeDeliveryBlock, /areAgentWebclientHostRouteParamsEqual\(currentUrl, targetUrl\)/);
  assert.match(contextBridgeBlock, /isAgentWebclientChatSurface\(service\?\.id, surfaceId\)/);
  assert.doesNotMatch(pluginPage, /ChatRouteMessage/);
});

test("agent chat suppresses host route echoes and semantic no-op navigations", () => {
  const pluginPage = readPluginPageSource();
  const navigationHandlerBlock = pluginPage.slice(
    pluginPage.indexOf("const syncNavigationRoute = (event: Event) =>"),
    pluginPage.indexOf("const handleDidFailLoad = () =>"),
  );

  assert.match(
    navigationHandlerBlock,
    /areAgentWebclientChatNavigationUrlsEquivalent\([\s\S]*?lastHostAppliedChatRouteRef\.current[\s\S]*?resolvedUrl/u,
  );
  assert.match(
    navigationHandlerBlock,
    /areAgentWebclientChatBusinessRoutesEquivalent\(currentRoute, nextChatRoute\)/u,
  );
  assert.match(
    navigationHandlerBlock,
    /!isHostRouteEcho[\s\S]*?!isSameDesktopBusinessRoute[\s\S]*?navigate\(nextChatRoute, \{ replace: true \}\)/u,
  );
});

test("inactive agent webclient surfaces cannot take ownership of the Desktop route", () => {
  const pluginPage = readPluginPageSource();
  const navigationHandlerBlock = pluginPage.slice(
    pluginPage.indexOf("const syncNavigationRoute = (event: Event) =>"),
    pluginPage.indexOf("const handleDidFailLoad = () =>"),
  );

  assert.match(
    navigationHandlerBlock,
    /const canSyncDesktopRoute = active !== false;/,
  );
  assert.match(
    navigationHandlerBlock,
    /canSyncDesktopRoute\s*&&\s*isAgentWebclientChatSurface\(service\?\.id, surfaceId\)/,
  );
  assert.match(
    navigationHandlerBlock,
    /canSyncDesktopRoute\s*&&\s*isAgentWebclientManagementSurface\(service\?\.id, surfaceId\)/,
  );
  assert.ok(
    navigationHandlerBlock.indexOf("updateWebviewCurrentUrl(resolvedUrl)") <
      navigationHandlerBlock.indexOf("const canSyncDesktopRoute = active !== false"),
    "inactive surfaces should still record their current WebView URL",
  );
  assert.match(
    navigationHandlerBlock,
    /sendPluginRouteToWebview\(resolvedUrl, "navigation"\)/,
  );
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

test("main chat direct route loading uses business-route URL comparison", () => {
  const pluginPage = readPluginPageSource();
  const directRouteLoadBlock = pluginPage.slice(
    pluginPage.indexOf("function requestDirectWebviewRouteLoad"),
    pluginPage.indexOf("async function injectAgentWebclientAccessToken"),
  );

  assert.match(pluginPage, /areAgentWebclientChatNavigationUrlsEquivalent/);
  assert.match(
    directRouteLoadBlock,
    /areAgentWebclientChatNavigationUrlsEquivalent\(currentUrl, embeddedUrl\)/,
  );
});

test("main chat synchronizes changed host params without replaying its business route", () => {
  const pluginPage = readPluginPageSource();
  const routeDispatchBlock = pluginPage.slice(
    pluginPage.indexOf("function sendPluginRouteToWebview"),
    pluginPage.indexOf("function requestDirectWebviewRouteLoad"),
  );

  assert.match(
    routeDispatchBlock,
    /areAgentWebclientChatNavigationUrlsEquivalent\(currentUrl, targetUrl\)/,
  );
  assert.match(
    routeDispatchBlock,
    /areAgentWebclientHostRouteParamsEqual\(currentUrl, targetUrl\)/,
  );
  assert.match(
    pluginPage,
    /sendPluginRouteToWebview\(embeddedUrl, "route-sync"\);/,
  );
});
