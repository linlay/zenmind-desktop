import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readServiceWebviewSurfaceSource() {
  return fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "service-webview", "ServiceWebviewSurface.tsx"),
    "utf8",
  );
}

test("generic service webview modules reject legacy plugin surface names", () => {
  const genericModulePaths = [
    ["src", "renderer", "service-webview", "ServiceWebviewSurface.tsx"],
    ["src", "renderer", "app-shell", "embedded-surfaces", "EmbeddedSurfaceHosts.tsx"],
    ["src", "renderer", "services", "serviceSurfaceWebviewRefs.ts"],
    ["src", "shared", "auth-bridge.ts"],
    ["src", "preload", "index.ts"],
    ["src", "main", "ipc", "services-handlers.ts"],
  ];
  const source = genericModulePaths
    .map((segments) => fs.readFileSync(path.join(projectRoot, ...segments), "utf8"))
    .join("\n");

  assert.doesNotMatch(source, /PluginPage|PluginSurface|pluginPage\.|plugin-webview/);
  assert.doesNotMatch(source, /plugins\.getServiceWebviewPreload(?:Path|Url)/);
});

test("service webview surface labels real plugins separately from built-in services", () => {
  const surfaceSource = readServiceWebviewSurfaceSource();
  const dictionaries = ["enUS.ts", "zhCN.ts"]
    .map((filename) => fs.readFileSync(
      path.join(projectRoot, "src", "shared", "i18n", "dictionaries", filename),
      "utf8",
    ))
    .join("\n");

  assert.match(surfaceSource, /service\?\.kind === "plugin"/);
  assert.match(surfaceSource, /t\("serviceWebview\.kind\.plugin"\)/);
  assert.match(surfaceSource, /t\("serviceWebview\.kind\.service"\)/);
  assert.match(dictionaries, /"serviceWebview\.kind\.plugin": "PLUGIN"/);
  assert.match(dictionaries, /"serviceWebview\.kind\.service": "SERVICE"/);
});

test("Agent WebClient surface classification uses structured role instead of route contents", () => {
  const surfaceSource = readServiceWebviewSurfaceSource();
  const classifier = surfaceSource.slice(
    surfaceSource.indexOf("function resolveContextMenuSurfaceType"),
    surfaceSource.indexOf("function isAgentWebclientChatSurface"),
  );

  assert.match(classifier, /surfaceRole: SurfaceIdentity\["surfaceRole"\]/u);
  assert.match(classifier, /resolveAgentWebclientWebviewSurfaceType\(surfaceRole\)/u);
  assert.doesNotMatch(classifier, /embedPath|surfaceId|\/project\/iu/u);
  assert.match(
    surfaceSource,
    /surfaceType: resolveContextMenuSurfaceType\(serviceId, surfaceIdentity\.surfaceRole\)/u,
  );
});

test("service webview surface does not sync API resource navigations back into the embedded app router", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const routeSyncBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("function isServiceWebviewRouteSyncTarget"),
    serviceWebviewSurface.indexOf("function resolveServiceWebviewCurrentUrl"),
  );
  const navigationHandlerBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const syncNavigationRoute = (event: Event) =>"),
    serviceWebviewSurface.indexOf("const handleDidFailLoad = () =>"),
  );

  assert.match(serviceWebviewSurface, /function isServiceWebviewRouteSyncTarget/);
  assert.match(routeSyncBlock, /pathname === "\/api"/);
  assert.match(routeSyncBlock, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(routeSyncBlock, /pathname === "\/ws"/);
  assert.match(routeSyncBlock, /pathname === "\/runtime-config\.js"/);
  assert.match(navigationHandlerBlock, /readEventBoolean\(event, "isMainFrame"\) !== false/);
  assert.match(navigationHandlerBlock, /isServiceWebviewRouteSyncTarget\(nextUrl, webviewSrcUrl\)/);
  assert.match(navigationHandlerBlock, /sendServiceRouteToWebview\(resolvedUrl, "navigation"\)/);
});

test("agent chat mirrors its business URL and only receives changed host params", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const routeDeliveryBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("function sendServiceRouteToWebview"),
    serviceWebviewSurface.indexOf("function requestDirectWebviewRouteLoad"),
  );
  const contextBridgeStart = serviceWebviewSurface.lastIndexOf(
    "useEffect(() => {",
    serviceWebviewSurface.indexOf("const postDesktopContextChanged"),
  );
  const contextBridgeBlock = serviceWebviewSurface.slice(
    contextBridgeStart,
    serviceWebviewSurface.indexOf("useEffect(() => {", contextBridgeStart + 1),
  );

  assert.match(serviceWebviewSurface, /function isAgentWebclientChatSurface/);
  assert.match(serviceWebviewSurface, /resolveAgentWebclientDesktopChatRouteFromUrl/);
  assert.match(serviceWebviewSurface, /lastHostAppliedChatRouteRef/);
  assert.match(routeDeliveryBlock, /!areAgentWebclientChatNavigationUrlsEquivalent\(currentUrl, targetUrl\)/);
  assert.match(routeDeliveryBlock, /areAgentWebclientHostRouteParamsEqual\(currentUrl, targetUrl\)/);
  assert.match(contextBridgeBlock, /isAgentWebclientChatSurface\(service\?\.id, surfaceId\)/);
  assert.doesNotMatch(serviceWebviewSurface, /ChatRouteMessage/);
});

test("agent chat suppresses host route echoes and semantic no-op navigations", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const navigationHandlerBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const syncNavigationRoute = (event: Event) =>"),
    serviceWebviewSurface.indexOf("const handleDidFailLoad = () =>"),
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
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const navigationHandlerBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const syncNavigationRoute = (event: Event) =>"),
    serviceWebviewSurface.indexOf("const handleDidFailLoad = () =>"),
  );

  assert.match(
    navigationHandlerBlock,
    /const canSyncDesktopRoute = ownsActiveSurface;/,
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
    navigationHandlerBlock.indexOf("updateWebviewCurrentUrl(resolvedUrl") >= 0 &&
      navigationHandlerBlock.indexOf("updateWebviewCurrentUrl(resolvedUrl") <
        navigationHandlerBlock.indexOf("const canSyncDesktopRoute = ownsActiveSurface"),
    "inactive surfaces should still record their current WebView URL",
  );
  assert.match(
    navigationHandlerBlock,
    /sendServiceRouteToWebview\(resolvedUrl, "navigation"\)/,
  );
});

test("global search chat navigation restores focus to the active main chat webview once", () => {
  const appShell = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "AppShell.tsx"),
    "utf8",
  );
  const surfaceHosts = fs.readFileSync(
    path.join(
      projectRoot,
      "src",
      "renderer",
      "app-shell",
      "embedded-surfaces",
      "EmbeddedSurfaceHosts.tsx",
    ),
    "utf8",
  );
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const globalSearchNavigationBlock = appShell.slice(
    appShell.indexOf("function requestGlobalSearchNavigation"),
    appShell.indexOf("function navigateWithSidebarHistory"),
  );
  const chatSurfaceBlock = surfaceHosts.slice(
    surfaceHosts.indexOf("{shouldRenderAgentChatSurface ? ("),
    surfaceHosts.indexOf("{shouldRenderCopilotSurface ? ("),
  );
  const nonChatSurfaceBlock = surfaceHosts.slice(
    surfaceHosts.indexOf("{shouldRenderCopilotSurface ? ("),
    surfaceHosts.indexOf("</EmbeddedSurfaceSuspense>"),
  );
  const focusEffectBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const requestId = Number.isSafeInteger(focusRequestId)"),
    serviceWebviewSurface.indexOf("const webUrl = service?.healthMeta.webUrl"),
  );

  assert.match(appShell, /const activeAgentChatFocusRequestId =\s*!globalSearchOpen/);
  assert.match(appShell, /pendingAgentChatFocusRequest\?\.targetRoute === currentRoute/);
  assert.match(globalSearchNavigationBlock, /isSingleAgentWebclientRoute\(resolveNavigationPathname\(targetRoute\)\)/);
  assert.match(globalSearchNavigationBlock, /agentChatFocusRequestIdRef\.current \+= 1/);
  assert.match(globalSearchNavigationBlock, /sourceRoute: currentRoute/);
  assert.match(globalSearchNavigationBlock, /targetRoute/);
  assert.match(globalSearchNavigationBlock, /return requestSidebarNavigation\(targetPath\)/);
  assert.match(appShell, /onNavigate=\{requestGlobalSearchNavigation\}/);
  assert.match(appShell, /currentRoute === pendingAgentChatFocusRequest\.sourceRoute/);
  assert.match(appShell, /currentRoute === pendingAgentChatFocusRequest\.targetRoute/);
  assert.match(appShell, /current\?\.id === pendingAgentChatFocusRequest\.id \? null : current/);

  assert.match(chatSurfaceBlock, /focusRequestId=\{agentChatFocusRequestId\}/);
  assert.match(chatSurfaceBlock, /onFocusRequestHandled=\{onAgentChatFocusRequestHandled\}/);
  assert.doesNotMatch(nonChatSurfaceBlock, /focusRequestId=/);
  assert.doesNotMatch(nonChatSurfaceBlock, /onFocusRequestHandled=/);

  assert.match(focusEffectBlock, /requestId === lastHandledFocusRequestIdRef\.current/);
  assert.match(focusEffectBlock, /active !== true/);
  assert.match(focusEffectBlock, /isAgentWebclientChatSurface\(serviceId, surfaceId\)/);
  assert.match(focusEffectBlock, /if \(!targetWebview\) \{\s*return;/);
  assert.match(focusEffectBlock, /targetWebview\.focus\(\)/);
  assert.match(focusEffectBlock, /lastHandledFocusRequestIdRef\.current = requestId/);
  assert.match(focusEffectBlock, /onFocusRequestHandled\?\.\(requestId\)/);
  assert.match(
    focusEffectBlock,
    /\[active, focusRequestId, onFocusRequestHandled, serviceId, surfaceId, webviewSnapshotNonce\]/,
  );
});

test("service webview surface reports webview breadcrumbs for post-crash diagnosis", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();

  assert.match(serviceWebviewSurface, /function reportServiceWebviewDiagnostic/);
  assert.match(serviceWebviewSurface, /source:\s*"service-webview"/);
  assert.match(serviceWebviewSurface, /reportServiceWebviewDiagnostic\("listeners-attached"\)/);
  assert.match(serviceWebviewSurface, /reportServiceWebviewDiagnostic\("dom-ready"\)/);
  assert.match(serviceWebviewSurface, /reportServiceWebviewDiagnostic\("navigation"/);
  assert.match(serviceWebviewSurface, /reportServiceWebviewDiagnostic\("direct-route-load-url"/);
  assert.match(serviceWebviewSurface, /reportServiceWebviewDiagnostic\("direct-route-load-failed"/);
});

test("service webview surface falls back to loadURL when client-side route navigation misses the target", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const directRouteLoadBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("function requestDirectWebviewRouteLoad"),
    serviceWebviewSurface.indexOf("async function injectAgentWebclientAccessToken"),
  );

  assert.match(directRouteLoadBlock, /direct-route-client-navigation-mismatch/);
  assert.match(directRouteLoadBlock, /clientNavigationResult/);
  assert.match(directRouteLoadBlock, /resolveServiceWebviewCurrentUrl\(/);
  assert.match(directRouteLoadBlock, /targetWebview\.loadURL\(embeddedUrl\)/);
});

test("main chat direct route loading uses business-route URL comparison", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const directRouteLoadBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("function requestDirectWebviewRouteLoad"),
    serviceWebviewSurface.indexOf("async function injectAgentWebclientAccessToken"),
  );

  assert.match(serviceWebviewSurface, /areAgentWebclientChatNavigationUrlsEquivalent/);
  assert.match(
    directRouteLoadBlock,
    /areAgentWebclientChatNavigationUrlsEquivalent\(currentUrl, embeddedUrl\)/,
  );
});

test("main chat synchronizes changed host params without replaying its business route", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const routeDispatchBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("function sendServiceRouteToWebview"),
    serviceWebviewSurface.indexOf("function requestDirectWebviewRouteLoad"),
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
    serviceWebviewSurface,
    /sendServiceRouteToWebview\(embeddedUrl, "route-sync"\);/,
  );
});
