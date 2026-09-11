import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual host handler, not a second implementation of its guards.
const source = fs.readFileSync("src/renderer/service-webview/ServiceWebviewSurface.tsx", "utf8");
const handlerSource = source.slice(source.indexOf("  function settleMainChatRouterApplied("), source.indexOf("  function handleMainChatRouterReady("));
const javascript = ts.transpileModule(handlerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  const pending = { id: 1, revision: 12, targetRouterLocation: "/agent/demo?chatId=B", targetUrl: "http://localhost/agent/demo?chatId=B", webContentsId: 7, documentGeneration: 3, phase: "waiting-applied", watchdogId: 91, startedAt: Date.now() };
  const diagnostics = [], cleared = [];
  const context = {
    mainChatSurface: true, active: true,
    pendingMainChatRouteTransitionRef: { current: pending },
    webviewRef: { current: {} }, readWebviewContentsId: () => 7,
    mainChatRouterReadyRef: { current: { ready: true, webContentsId: 7, documentGeneration: 3 } },
    webviewDocumentGenerationRef: { current: 3 }, mainChatRouteStateRef: { current: { revision: 12 } },
    lastMainChatRouterAcknowledgementRef: { current: null }, readCurrentWebviewUrl: () => pending.targetUrl,
    reportServiceWebviewDiagnostic: (stage, detail) => diagnostics.push({ stage, detail }),
    window: { clearTimeout: id => cleared.push(id) }, Date,
  };
  const handler = vm.runInNewContext(`${javascript};settleMainChatRouterApplied`, context);
  return { context, pending, diagnostics, cleared, apply: status => handler({ type: "desktopRouteApplied", routeRevision: 12, routerLocation: pending.targetRouterLocation, ...status }) };
}

test("exact APPLIED settles only routing, without requiring physical navigation", () => {
  const f = fixture();
  f.context.readCurrentWebviewUrl = () => "http://localhost/agent/demo?chatId=A";
  f.apply();
  assert.equal(f.context.pendingMainChatRouteTransitionRef.current, null);
  assert.deepEqual(f.cleared, [91]);
  assert.equal(f.diagnostics.at(-1).detail.completionScope, "router-only");
});
test("late APPLIED cannot clear a newer route, inactive surface, or recreated document watchdog", () => {
  for (const invalidate of [
    f => { f.context.webviewDocumentGenerationRef.current = 4; },
    f => { f.context.mainChatRouteStateRef.current.revision = 13; },
    f => { f.context.readWebviewContentsId = () => 8; },
    f => { f.context.active = false; },
    f => { f.pending.phase = "waiting-ready"; },
    f => { f.pending.targetRouterLocation = "/agent/demo?chatId=C"; },
  ]) {
    const f = fixture(); invalidate(f);
    f.apply({ routerLocation: "/agent/demo?chatId=B" });
    assert.equal(f.context.pendingMainChatRouteTransitionRef.current, f.pending);
    assert.deepEqual(f.cleared, []);
    assert.equal(f.diagnostics.at(-1).stage, "main-chat-router-applied-rejected");
  }
});

test("document navigation invalidates old READY/APPLIED before the next dom-ready, but not in-page promotion", () => {
  const start = source.slice(source.indexOf("    const handleDidStartNavigation ="), source.indexOf("    const handleDomReady ="));
  for (const event of [{ isMainFrame: true, isInPlace: false }, { isMainFrame: true, isInPlace: true }, { isMainFrame: false, isInPlace: false }]) {
    const f = fixture();
    Object.assign(f.context, {
      readEventBoolean: (event, key) => event[key], targetWebview: {},
      webviewDomReadyRef: { current: { ready: true } },
      canonicalChatPromotionGuardRef: { current: {} },
      webviewEventContextRef: { current: { reportDiagnostic() {} } },
    });
    const run = vm.runInNewContext(ts.transpileModule(start, {}).outputText + ";handleDidStartNavigation", f.context);
    run(event);
    const replacing = event.isMainFrame && !event.isInPlace;
    assert.equal(f.context.webviewDocumentGenerationRef.current, replacing ? 4 : 3);
    assert.equal(f.context.webviewDomReadyRef.current.ready, !replacing);
    if (replacing) {
      f.apply();
      assert.equal(f.context.pendingMainChatRouteTransitionRef.current, f.pending);
      assert.equal(f.context.canonicalChatPromotionGuardRef.current, null);
    }
  }
});

test("a late guest navigation cannot publish its URL or replace a pending Desktop target", () => {
  const navigation = source.slice(source.indexOf("    const syncNavigationRoute ="), source.indexOf("    const handleDidNavigate ="));
  for (const mismatch of ["target", "revision", "document", "guest"]) {
    const calls = [];
    const targetUrl = "http://localhost/agent/demo?chatId=C";
    const pending = { revision: 12, targetUrl, documentGeneration: 3, webContentsId: 7 };
    const context = {
      readEventString: (event, key) => event[key], readEventBoolean: (event, key) => event[key],
      resolveServiceWebviewCurrentUrl: url => url, isAgentWebclientChatSurface: () => true,
      webviewEventContextRef: { current: { serviceId: "agent-webclient", surfaceId: "main", reportDiagnostic() {}, refreshCurrentPageSnapshotTarget() {}, updateWebviewCurrentUrl: () => calls.push("url"), navigate: () => calls.push("navigate") } },
      pendingDirectRouteTransitionRef: { current: null }, pendingMainChatRouteTransitionRef: { current: pending },
      mainChatRouteStateRef: { current: { revision: mismatch === "revision" ? 13 : 12 } },
      webviewDocumentGenerationRef: { current: mismatch === "document" ? 4 : 3 },
      readWebviewContentsId: () => mismatch === "guest" ? 8 : 7, targetWebview: {},
      isMainChatGuestAtRoute: (a, b) => a === b,
    };
    const run = vm.runInNewContext(ts.transpileModule(navigation, {}).outputText + ";syncNavigationRoute", context);
    run({ url: mismatch === "target" ? "http://localhost/agent/demo?chatId=B" : targetUrl, isMainFrame: true });
    assert.deepEqual(calls, []);
  }
});

test("canonical promotion protection expires on another revision even if the route returns to the same target", () => {
  const protection = source.slice(source.indexOf("  function shouldProtectCanonicalChatGuest("), source.indexOf("  function isMainChatGuestAtRoute("));
  for (const revision of [12, 14]) {
    const context = {
      active: true, canonicalChatPromotionGuardRef: { current: { routeRevision: 12, documentGeneration: 3, targetRoute: "/agent/demo?chatId=B", request: {} } },
      webviewDocumentGenerationRef: { current: 3 }, mainChatRouteStateRef: { current: { revision } },
      currentRouteWithHashRef: { current: "/agent/demo?chatId=B" }, surfaceRegistrationIdRef: { current: "registration" },
      readWebviewContentsId: () => 7, webviewRef: { current: {} }, readCurrentPromotionGuestUrl: () => "http://localhost/agent/demo?newChat=1788739200001",
      classifyCanonicalChatPromotionGuard: () => "protecting", settleCanonicalChatPromotionGuard() {},
    };
    const run = vm.runInNewContext(ts.transpileModule(protection, {}).outputText + ";shouldProtectCanonicalChatGuest", context);
    assert.equal(run("/agent/demo?chatId=B"), revision === 12);
  }
});
