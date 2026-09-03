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

function readWorkPanelHostSource() {
  return fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "work-panel", "WorkPanelHost.tsx"),
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
    serviceWebviewSurface.indexOf("const handleDidFailLoad = (event: Event) =>"),
  );

  assert.match(serviceWebviewSurface, /function isServiceWebviewRouteSyncTarget/);
  assert.match(routeSyncBlock, /pathname === "\/api"/);
  assert.match(routeSyncBlock, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(routeSyncBlock, /pathname === "\/ws"/);
  assert.match(routeSyncBlock, /pathname === "\/runtime-config\.js"/);
  assert.match(navigationHandlerBlock, /readEventBoolean\(event, "isMainFrame"\) !== false/);
  assert.match(navigationHandlerBlock, /isServiceWebviewRouteSyncTarget\(nextUrl, context\.webviewSrcUrl\)/);
  assert.match(
    navigationHandlerBlock,
    /!mainChatNavigation[\s\S]*?context\.sendServiceRouteToWebview\(resolvedUrl, "navigation"\)/u,
  );
});

test("agent chat receives changed business routes and host params without replaying semantic no-ops", () => {
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
  assert.match(routeDeliveryBlock, /Main Chat route commands are owned by the READY\/APPLIED coordinator/u);
  assert.match(routeDeliveryBlock, /function sendPendingMainChatRoute/u);
  assert.match(routeDeliveryBlock, /serviceRouteCommandRevisionRef\.current \+ 1/u);
  assert.match(routeDeliveryBlock, /serviceRouteCommandRevisionRef\.current \+= 1/u);
  assert.match(routeDeliveryBlock, /routeRevision:\s*pending\.revision/u);
  assert.doesNotMatch(routeDeliveryBlock, /routeRevision:\s*null/u);
  assert.match(contextBridgeBlock, /isAgentWebclientChatSurface\(service\?\.id, surfaceId\)/);
  assert.doesNotMatch(serviceWebviewSurface, /ChatRouteMessage/);
});

test("agent chat suppresses host route echoes and semantic no-op navigations", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const navigationHandlerBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const syncNavigationRoute = (event: Event) =>"),
    serviceWebviewSurface.indexOf("const handleDidFailLoad = (event: Event) =>"),
  );

  assert.match(
    navigationHandlerBlock,
    /isMainChatGuestAtRoute\(lastHostAppliedChatRouteRef\.current, resolvedUrl\)/u,
  );
  assert.match(
    navigationHandlerBlock,
    /pendingRouteEcho \|\| isHostRouteEcho[\s\S]*?resolveAgentWebclientDesktopAgentSwitchTarget/u,
  );
  assert.match(
    navigationHandlerBlock,
    /areAgentWebclientChatBusinessRoutesEquivalent\([\s\S]*?context\.currentRoute,[\s\S]*?nextChatRoute/u,
  );
  assert.match(
    navigationHandlerBlock,
    /!isHostRouteEcho[\s\S]*?!isSameDesktopBusinessRoute[\s\S]*?context\.navigate\(nextChatRoute, \{ replace: true \}\)/u,
  );
});

test("active Main Chat turns a bare different-Agent navigation into an ownerless new Chat route", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const navigationHandlerBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const syncNavigationRoute = (event: Event) =>"),
    serviceWebviewSurface.indexOf("const handleDidFailLoad = (event: Event) =>"),
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
    /context\.navigate\(createAgentWebclientAgentPath\(switchedAgentKey, params\), \{[\s\S]*?replace: true/u,
  );
  assert.doesNotMatch(
    navigationHandlerBlock.slice(switchIndex, canonicalIndex),
    /setWebviewRenderKey|sendLiveSurfaceLifecycleToWebview/u,
  );
});

test("new Chat canonical synchronization promotes Desktop while protecting the live guest", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const navigationHandlerBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const syncNavigationRoute = (event: Event) =>"),
    serviceWebviewSurface.indexOf("const handleDidFailLoad = (event: Event) =>"),
  );
  const canonicalSyncBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("canonicalChatSync.onRequest"),
    serviceWebviewSurface.indexOf("const requestId = Number.isSafeInteger", serviceWebviewSurface.indexOf("canonicalChatSync.onRequest")),
  );
  const routeDeliveryBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("function sendServiceRouteToWebview"),
    serviceWebviewSurface.indexOf("function handleWebviewBridgeMessage"),
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
  assert.match(canonicalSyncBlock, /canonicalChatPromotionGuardRef\.current = \{ request, targetRoute \}/u);
  assert.match(canonicalSyncBlock, /navigate\(targetRoute, \{ replace: true \}\)/u);
  assert.match(canonicalSyncBlock, /respond\(\{ requestId: request\.requestId, ok: true \}\)/u);
  assert.match(routeDeliveryBlock, /shouldProtectCanonicalChatGuest\(embeddedUrl\)/u);
  assert.match(routeDeliveryBlock, /reason: "canonical-promotion-guard"/u);
  assert.match(
    serviceWebviewSurface,
    /canonicalPromotionProtected[\s\S]*?shouldProtectCanonicalChatGuest\(desiredDesktopRoute\)[\s\S]*?const routeAligned = !mainChatSurface \|\|[\s\S]*?canonicalPromotionProtected/u,
  );
  assert.match(serviceWebviewSurface, /guest-canonical-navigation/u);
  assert.match(serviceWebviewSurface, /reason: "guest-replaced"/u);
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
    /registration\.pageRouteIdentity !== pending\.targetRoute[\s\S]*?classifyAgentWebclientNewChatRegistration/u,
  );
  assert.match(
    registrationBlock,
    /resolveAgentWebclientNewChatRegistrationOutcome\([\s\S]*?pendingRegistration\.state[\s\S]*?result\.ok/u,
  );
  assert.match(
    registrationBlock,
    /pendingRegistrationOutcome === "acknowledge"[\s\S]*?finishNewChatPreparation\(pendingRegistration\.pending, \{ ok: true \}\)/u,
  );
  assert.match(
    registrationBlock,
    /pendingRegistrationOutcome === "fail"[\s\S]*?Main Chat surface rejected its new Chat registration/u,
  );
  assert.match(
    serviceWebviewSurface,
    /new-chat-preparation-timeout[\s\S]*?new Chat surface preparation timed out/u,
  );
  assert.match(
    serviceWebviewSurface,
    /another new Chat preparation is already in progress/u,
  );
  assert.match(
    serviceWebviewSurface,
    /new-chat-preparation-identity-changed[\s\S]*?Main Chat changed before new Chat preparation completed/u,
  );
  assert.match(
    registrationBlock,
    /\.catch\(\(error\)[\s\S]*?if \(pendingRegistration\)[\s\S]*?finishNewChatPreparation/u,
  );
});

test("inactive agent webclient surfaces cannot take ownership of the Desktop route", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const navigationHandlerBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("const syncNavigationRoute = (event: Event) =>"),
    serviceWebviewSurface.indexOf("const handleDidFailLoad = (event: Event) =>"),
  );

  assert.match(
    navigationHandlerBlock,
    /const canSyncDesktopRoute = context\.ownsActiveSurface;/,
  );
  assert.match(
    navigationHandlerBlock,
    /canSyncDesktopRoute\s*&&\s*isAgentWebclientChatSurface\(context\.serviceId, context\.surfaceId\)/,
  );
  assert.match(
    navigationHandlerBlock,
    /canSyncDesktopRoute\s*&&\s*isAgentWebclientManagementSurface\(context\.serviceId, context\.surfaceId\)/,
  );
  assert.ok(
    navigationHandlerBlock.indexOf("context.updateWebviewCurrentUrl(resolvedUrl") >= 0 &&
      navigationHandlerBlock.indexOf("context.updateWebviewCurrentUrl(resolvedUrl") <
        navigationHandlerBlock.indexOf("const canSyncDesktopRoute = context.ownsActiveSurface"),
    "inactive surfaces should still record their current WebView URL",
  );
  assert.match(
    navigationHandlerBlock,
    /context\.sendServiceRouteToWebview\(resolvedUrl, "navigation"\)/,
  );
});

test("global search and sidebar Chat navigation restore focus to the active main chat webview once", () => {
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
  const openChatBlock = appSidebar.slice(
    appSidebar.indexOf("async function handleAssistantOpenChat"),
    appSidebar.indexOf("function handleAssistantOpenChatMenu"),
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
  assert.match(openChatBlock, /retriggerAgentRoute:\s*true,\s*focusAgentChat:\s*true/);
});

test("service webview diagnostics suppress normal production lifecycle and aggregate dev breadcrumbs", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();

  assert.match(serviceWebviewSurface, /function reportServiceWebviewDiagnostic/);
  assert.match(serviceWebviewSurface, /source:\s*"service-webview"/);
  assert.match(
    serviceWebviewSurface,
    /level === "debug" && !import\.meta\.env\.DEV[\s\S]*?return;/u,
  );
  assert.match(serviceWebviewSurface, /resolveServiceWebviewDiagnosticLevel/u);
  assert.match(serviceWebviewSurface, /SERVICE_WEBVIEW_DIAGNOSTIC_AGGREGATION_MS/u);
  assert.match(serviceWebviewSurface, /repeatCount:\s*currentBucket\.count/u);
  assert.match(serviceWebviewSurface, /reportDiagnostic\("listeners-attached"\)/);
  assert.match(serviceWebviewSurface, /reportDiagnostic\("dom-ready", \{ documentGeneration \}\)/);
  assert.match(serviceWebviewSurface, /reportDiagnostic\("navigation"/);
  assert.match(serviceWebviewSurface, /reportServiceWebviewDiagnostic\("direct-route-load-url"/);
  assert.match(serviceWebviewSurface, /reportServiceWebviewDiagnostic\("direct-route-load-failed"/);
});

test("WorkPanel ignores duplicate review capability and ready snapshots", () => {
  const source = readWorkPanelHostSource();
  const handler = source.slice(
    source.indexOf("const handleReviewIpcMessage = useCallback"),
    source.indexOf("const sendReviewStateToPreview"),
  );

  assert.match(handler, /previous\?\.kind === nextCapability\.kind/u);
  assert.match(handler, /previous\.fileName === nextCapability\.fileName/u);
  assert.match(handler, /previous\.revision === nextCapability\.revision/u);
  assert.match(handler, /previous\?\.width === nextMetadata\.width/u);
  assert.match(handler, /previous\?\.height === nextMetadata\.height/u);
  assert.match(handler, /return current;/u);
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
    /isStaleTransition\(\)[\s\S]*?direct-route-client-navigation-stale/u,
  );
  assert.match(directRouteLoadBlock, /targetWebview\.loadURL\(targetUrl\)/);
});

test("main chat uses one READY/APPLIED watchdog before a bounded loadURL fallback", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const mainChatRouteBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("function requestMainChatRouteBridgeNavigation"),
    serviceWebviewSurface.indexOf("function requestDirectWebviewRouteLoad"),
  );
  const directRouteLoadBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("function requestDirectWebviewRouteLoad"),
    serviceWebviewSurface.indexOf("function handleWebviewBridgeMessage"),
  );

  assert.match(serviceWebviewSurface, /const MAIN_CHAT_ROUTE_LOAD_FALLBACK_MS = 1_000/);
  assert.match(
    mainChatRouteBlock,
    /pending\.watchdogId = window\.setTimeout/u,
  );
  assert.doesNotMatch(mainChatRouteBlock, /retryIssued|main-chat-router-ack-retry/u);
  assert.doesNotMatch(mainChatRouteBlock, /MAIN_CHAT_ROUTE_ACK_RETRY_MS/u);
  assert.match(mainChatRouteBlock, /liveWebview\.loadURL\(pending\.targetUrl\)/);
  assert.match(mainChatRouteBlock, /main-chat-router-timeout/u);
  assert.match(mainChatRouteBlock, /pending\.fallbackIssued = true/u);
  assert.match(mainChatRouteBlock, /pending\.fallbackIssued[\s\S]*?return;/u);
  assert.doesNotMatch(
    mainChatRouteBlock,
    /if \(isMainChatGuestAtRoute\(guestUrl, pending\.targetUrl\)\) \{[\s\S]*?return;/u,
  );
  assert.match(mainChatRouteBlock, /canonicalChatPromotionGuardRef\.current/u);
  assert.doesNotMatch(mainChatRouteBlock, /executeJavaScript|history\.pushState/u);
  assert.match(
    directRouteLoadBlock,
    /isAgentWebclientChatSurface\(service\?\.id, surfaceId\)[\s\S]*?requestMainChatRouteBridgeNavigation\(\);[\s\S]*?return;/u,
  );
});

test("service webview listeners stay bound across route and active-state changes", () => {
  const source = readServiceWebviewSurfaceSource();
  const listenerEffectStart = source.indexOf("const handleDomReady = () =>");
  const listenerEffectEnd = source.indexOf("useEffect(() => {", listenerEffectStart);
  const listenerEffect = source.slice(listenerEffectStart, listenerEffectEnd);

  assert.match(source, /webviewEventContextRef\.current = \{/u);
  assert.match(listenerEffect, /\}, \[bridgeReady, serviceWebviewPreloadUrl, webviewRenderKey\]\);/u);
  assert.doesNotMatch(
    listenerEffect.slice(listenerEffect.lastIndexOf("}, [")),
    /embeddedUrl|currentRoute|ownsActiveSurface|ownerChatId/u,
  );
});

test("main Chat queues the latest route until Router READY and binds it to the document generation", () => {
  const source = readServiceWebviewSurfaceSource();
  const registrationBlock = source.slice(
    source.indexOf("const observedMainChatIdentity"),
    source.indexOf("const readPendingNewChatRegistration"),
  );
  const directRouteBlock = source.slice(
    source.indexOf("function requestMainChatRouteBridgeNavigation"),
    source.indexOf("function requestDirectWebviewRouteLoad"),
  );

  assert.match(registrationBlock, /const registrationActive = ownsActiveSurface && routeAligned/u);
  assert.match(registrationBlock, /canCommitMainChatIdentity\(/u);
  assert.match(
    registrationBlock,
    /isAgentWebclientMainChatRouteAligned\([\s\S]*?desiredDesktopRoute,[\s\S]*?currentUrl,[\s\S]*?embeddedUrl/u,
  );
  assert.match(registrationBlock, /preserveRegisteredIdentity/u);
  assert.match(source, /result\.reason === "route_not_aligned"[\s\S]*?return;/u);
  assert.match(source, /\[50, 150, 300, 500\]/u);
  assert.match(source, /isDesiredMainChatRouteObserved\(\)/u);
  assert.match(source, /isAgentWebclientMainChatRouteAligned\([\s\S]{0,240}mainChatIdentitiesEqual\(/u);
  assert.match(source, /main-chat-identity-convergence-timeout/u);
  assert.match(source, /attempt <= 2[\s\S]*?attempt === 1 \? 100 : 300/u);
  assert.match(directRouteBlock, /routeTransitionSequenceRef\.current \+ 1/u);
  assert.match(directRouteBlock, /phase:\s*"waiting-ready"/u);
  assert.match(directRouteBlock, /pendingMainChatRouteTransitionRef\.current/u);
  assert.match(directRouteBlock, /liveWebContentsId !== pending\.webContentsId/u);
  assert.match(source, /webviewDocumentGenerationRef\.current \+= 1/u);
  assert.match(source, /mainChatRouterReadyRef\.current = \{[\s\S]*?ready: false/u);
  assert.match(source, /pending\.documentGeneration = documentGeneration/u);
  assert.match(source, /pending\.phase = "waiting-ready"/u);
  assert.match(source, /mainChatNavigation && isMainFrame[\s\S]*?refreshCurrentPageSnapshotTarget\(\)/u);
  assert.doesNotMatch(source, /observeMainChatRoutePhysicalUrl/u);
  assert.doesNotMatch(source, /settleMainChatRouteFallback/u);
});

test("main chat routes every changed business or host target through the WebClient bridge", () => {
  const serviceWebviewSurface = readServiceWebviewSurfaceSource();
  const routeDispatchBlock = serviceWebviewSurface.slice(
    serviceWebviewSurface.indexOf("function sendServiceRouteToWebview"),
    serviceWebviewSurface.indexOf("function requestDirectWebviewRouteLoad"),
  );

  assert.match(
    routeDispatchBlock,
    /acknowledged\.revision === mainChatRouteRevision/u,
  );
  assert.match(
    routeDispatchBlock,
    /!routerReady\.ready/u,
  );
  assert.match(routeDispatchBlock, /routerReady\.documentGeneration !== pending\.documentGeneration/u);
  assert.doesNotMatch(
    routeDispatchBlock,
    /lastMainChatRouterAcknowledgementRef\.current = \{/u,
  );
  assert.match(
    serviceWebviewSurface,
    /requestMainChatRouteBridgeNavigation\(\);/,
  );
  assert.doesNotMatch(
    routeDispatchBlock,
    /if \(guestAlreadyAtTarget\) \{[\s\S]*?chat-route-bridge-skipped/u,
  );
  assert.match(routeDispatchBlock, /routeRevision:\s*pending\.revision/u);
  assert.match(routeDispatchBlock, /chat-route-bridge-queued/u);
});

test("main Chat settles route delivery only from an exact Router APPLIED status", () => {
  const source = readServiceWebviewSurfaceSource();
  const ackBlock = source.slice(
    source.indexOf("function settleMainChatRouterApplied"),
    source.indexOf("function readObservedMainChatIdentity"),
  );
  const ipcBlock = source.slice(
    source.indexOf("function handleWebviewBridgeMessage"),
    source.indexOf("function webviewLoadedChromeErrorPage"),
  );

  assert.match(ackBlock, /pending\.webContentsId !== webContentsId/u);
  assert.match(ackBlock, /pending\.documentGeneration !== routerReady\.documentGeneration/u);
  assert.match(ackBlock, /pending\.revision !== status\.routeRevision/u);
  assert.match(ackBlock, /pending\.targetRouterLocation !== status\.routerLocation/u);
  assert.match(ackBlock, /pendingMainChatRouteTransitionRef\.current = null/u);
  assert.match(ackBlock, /lastMainChatRouterAcknowledgementRef\.current = \{/u);
  assert.match(ackBlock, /main-chat-router-applied-accepted/u);
  assert.match(ackBlock, /desiredToReadyMs/u);
  assert.match(ackBlock, /sentToAppliedMs/u);
  assert.match(ackBlock, /totalElapsedMs/u);
  assert.match(ipcBlock, /SERVICE_WEBVIEW_BRIDGE_ROUTE_STATUS_CHANNEL/u);
  assert.match(ipcBlock, /isServiceWebviewRouteStatus\(payload\)/u);
  assert.match(ipcBlock, /if \(!mainChatSurface\) return;/u);
  assert.match(ipcBlock, /handleMainChatRouterReady\(payload\)/u);
  assert.match(ipcBlock, /settleMainChatRouterApplied\(payload\)/u);
});
