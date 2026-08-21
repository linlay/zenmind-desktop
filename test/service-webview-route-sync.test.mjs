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

test("active Main Chat turns a bare different-Agent navigation into an ownerless new Chat route", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const navigationHandlerBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const syncNavigationRoute = (event: Event) =>"),
    serviceWebviewSurface.indexOf("const handleDidFailLoad = () =>"),
  );
  const switchIndex = navigationHandlerBlock.indexOf(
    "resolveAgentWebclientDesktopAgentSwitchTarget(",
  );
  const canonicalIndex = navigationHandlerBlock.indexOf(
    "resolveAgentWebclientDesktopChatRouteFromUrl(",
  );

  assert.ok(switchIndex >= 0 && switchIndex < canonicalIndex);
  assert.match(
    navigationHandlerBlock,
    /Math\.max\([\s\S]*?Date\.now\(\)[\s\S]*?lastAgentSwitchNewChatTimestampRef\.current \+ 1/u,
  );
  assert.match(navigationHandlerBlock, /\/\^\[1-9\]\\d\{12\}\$\/u/u);
  assert.match(
    navigationHandlerBlock,
    /navigate\(createAgentWebclientAgentPath\(switchedAgentKey, params\), \{[\s\S]*?replace: true/u,
  );
  assert.doesNotMatch(
    navigationHandlerBlock.slice(switchIndex, canonicalIndex),
    /setWebviewRenderKey|sendLiveSurfaceLifecycleToWebview/u,
  );
});

test("new Chat route ownership comes from chat.start canonical synchronization", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const navigationHandlerBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const syncNavigationRoute = (event: Event) =>"),
    serviceWebviewSurface.indexOf("const handleDidFailLoad = () =>"),
  );
  const registrationBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const registration: EmbeddedCdpSurfaceRegistration"),
    serviceWebviewSurface.indexOf("useEffect(() => {", serviceWebviewSurface.indexOf("const registration: EmbeddedCdpSurfaceRegistration")),
  );

  assert.match(serviceWebviewSurface, /canonicalChatSync\.onRequest/);
  assert.match(serviceWebviewSurface, /if \(request\.surfaceId !== surfaceId\) return;/);
  assert.match(serviceWebviewSurface, /createCanonicalAgentChatRoute\(currentRouteWithHash, request\)/);
  assert.match(navigationHandlerBlock, /readAgentWebclientAgentRouteKey\(nextChatRoute\)/);
  assert.match(
    navigationHandlerBlock,
    /readAgentWebclientAgentRouteKey\(nextChatRoute\) ===\s*newChatBootstrapSource\.agentKey/u,
  );
  assert.match(navigationHandlerBlock, /newChatBootstrapOwnsPromotion/);
  assert.match(navigationHandlerBlock, /!newChatBootstrapOwnsPromotion/);
  assert.match(registrationBlock, /ownerChatId\?\.trim\(\) === pending\.request\.chatId/);
  assert.match(registrationBlock, /canonicalChatSync\.respond\(\{[\s\S]*?ok: true/u);
});

test("resend prepares an ownerless new Chat surface before acknowledging the guest", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const bridgeContracts = fs.readFileSync(
    path.join(projectRoot, "src", "shared", "service-webview-bridge.ts"),
    "utf8",
  );
  const bridgeHost = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "services", "serviceWebviewBridgeHost.ts"),
    "utf8",
  );
  const registrationBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const registration: EmbeddedCdpSurfaceRegistration"),
    serviceWebviewSurface.indexOf("useEffect(() => {", serviceWebviewSurface.indexOf("const registration: EmbeddedCdpSurfaceRegistration")),
  );

  assert.match(
    bridgeContracts,
    /desktop:agent-webclient:new-chat:prepare/u,
  );
  assert.match(
    bridgeContracts,
    /desktop:agent-webclient:new-chat:prepared/u,
  );
  assert.match(
    bridgeHost,
    /context\.serviceId !== "agent-webclient"[\s\S]*?!context\.prepareAgentWebclientNewChat/u,
  );
  assert.match(
    serviceWebviewSurface,
    /surfaceId !== MAIN_CHAT_SURFACE_ID[\s\S]*?ownerChatId\?\.trim\(\) !== normalizedRequest\.sourceChatId/u,
  );
  assert.match(
    registrationBlock,
    /currentRouteWithHash === pendingPreparation\.targetRoute[\s\S]*?!registration\.ownerChatId\?\.trim\(\)[\s\S]*?finishNewChatPreparation\(pendingPreparation, \{ ok: true \}\)/u,
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

test("global search and sidebar new Chat navigation restore focus to the active main chat webview once", () => {
  const appShell = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "AppShell.tsx"),
    "utf8",
  );
  const appSidebar = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
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
  const focusedChatNavigationBlock = appShell.slice(
    appShell.indexOf("function requestNavigationWithAgentChatFocus"),
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
  assert.match(focusedChatNavigationBlock, /isSingleAgentWebclientRoute\(resolveNavigationPathname\(targetRoute\)\)/);
  assert.match(focusedChatNavigationBlock, /agentChatFocusRequestIdRef\.current \+= 1/);
  assert.match(focusedChatNavigationBlock, /sourceRoute: currentRoute/);
  assert.match(focusedChatNavigationBlock, /targetRoute/);
  assert.match(focusedChatNavigationBlock, /return requestSidebarNavigation\(targetPath\)/);
  assert.match(appShell, /onNavigate=\{requestNavigationWithAgentChatFocus\}/);
  assert.match(appShell, /onRequestAgentChatNavigate=\{requestNavigationWithAgentChatFocus\}/);
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

  const sidebarNavigationBlock = appSidebar.slice(
    appSidebar.indexOf("function requestNavigate"),
    appSidebar.indexOf("function getSidebarRovingItemProps"),
  );
  const projectNewChatBlock = appSidebar.slice(
    appSidebar.indexOf("function handleAssistantNewChat"),
    appSidebar.indexOf("function startChatsNewChat"),
  );
  const chatsNewChatBlock = appSidebar.slice(
    appSidebar.indexOf("function startChatsNewChat"),
    appSidebar.indexOf("function focusChatsDefaultAgentMenuItem"),
  );
  assert.match(
    sidebarNavigationBlock,
    /options\.focusAgentChat\s*\? onRequestAgentChatNavigate \?\? onRequestNavigate\s*:\s*onRequestNavigate/,
  );
  assert.match(projectNewChatBlock, /retriggerAgentRoute:\s*true,\s*focusAgentChat:\s*true/);
  assert.match(chatsNewChatBlock, /retriggerAgentRoute:\s*true,\s*focusAgentChat:\s*true/);
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
  assert.match(
    directRouteLoadBlock,
    /lastDirectWebviewRouteRef\.current !== embeddedUrl[\s\S]*?direct-route-client-navigation-stale/u,
  );
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
