import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  EmbeddedCdpGateway,
  __testInternals: gatewayInternals
} = require("../dist-electron/main/embedded-cdp-gateway.js");
const {
  DESKTOP_CDP_TARGET_TIMEOUT_CODE,
  sendDesktopCdpCommand,
  isDesktopCdpTimeoutError
} = require("../dist-electron/main/desktop-cdp-debugger.js");
const {
  createBrowserSurfaceRegistry
} = require("../dist-electron/main/browser-surface-registry.js");

function createLoggerSink() {
  const events = [];
  return {
    events,
    logger: {
      debug: (...args) => events.push({ level: "debug", args }),
      warn: (...args) => events.push({ level: "warn", args })
    }
  };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected promise to reject");
}

function createHangingDebugger() {
  let attached = false;
  return {
    get attached() {
      return attached;
    },
    debuggerRef: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      detach: () => {
        attached = false;
      },
      sendCommand: () => new Promise(() => {})
    }
  };
}

test("desktop cdp helper times out with sanitized debug details", async () => {
  const { logger, events } = createLoggerSink();
  const { debuggerRef } = createHangingDebugger();

  const error = await captureRejection(sendDesktopCdpCommand(debuggerRef, "Runtime.evaluate", {
    expression: "window.__super_secret_script_value",
    returnByValue: true
  }, {
    targetId: "desktop-target",
    surfaceId: "website:target",
    webContentsId: 99,
    url: "https://example.test/path?token=super-secret#hash",
    title: "Example Page",
    timeoutMs: 15,
    logger
  }));

  assert.equal(isDesktopCdpTimeoutError(error), true);
  assert.equal(error.code, DESKTOP_CDP_TARGET_TIMEOUT_CODE);
  assert.equal(error.details.method, "Runtime.evaluate");
  assert.equal(error.details.targetId, "desktop-target");
  assert.equal(error.details.surfaceId, "website:target");
  assert.equal(error.details.webContentsId, 99);
  assert.equal(error.details.url, "https://example.test/path");
  assert.deepEqual(error.details.paramKeys, ["expression", "returnByValue"]);
  assert.equal(typeof error.details.timeoutMs, "number");
  assert.equal(events.some((event) => event.level === "debug" && event.args[0] === "[desktop-cdp] start"), true);
  assert.equal(events.some((event) => event.level === "warn" && event.args[0] === "[desktop-cdp] timeout"), true);
  const loggedText = JSON.stringify(events);
  assert.doesNotMatch(loggedText, /super_secret_script_value/u);
  assert.doesNotMatch(loggedText, /super-secret/u);
});

test("embedded cdp gateway command execution times out instead of hanging", async () => {
  const { logger } = createLoggerSink();
  const hanging = createHangingDebugger();
  const tab = {
    tabId: "slow-tab",
    currentUrl: "https://example.test/slow?token=secret",
    title: "Slow Page",
    webContentsId: 42
  };
  const surface = {
    id: "website:slow",
    label: "Slow Page",
    url: "https://example.test/slow?token=secret",
    surfaceKind: "website",
    open: true,
    active: true,
    tabs: [tab],
    activeTabId: tab.tabId
  };
  const contents = {
    id: 42,
    debugger: hanging.debuggerRef,
    isDestroyed: () => false,
    getURL: () => "https://example.test/live?token=secret#hash",
    getTitle: () => "Live Slow Page"
  };
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => [surface],
    resolveWebContents: () => contents,
    commandTimeoutMs: 15,
    logger
  });

  const error = await captureRejection(gateway.executeCommand({
    method: "Runtime.evaluate",
    params: {
      expression: "window.__secret_should_not_log",
      returnByValue: true
    },
    targetId: gatewayInternals.stableTargetId(surface, tab)
  }));

  assert.equal(isDesktopCdpTimeoutError(error), true);
  assert.equal(error.code, DESKTOP_CDP_TARGET_TIMEOUT_CODE);
  assert.equal(error.details.surfaceId, "website:slow");
  assert.equal(error.details.webContentsId, 42);
  assert.equal(error.details.url, "https://example.test/live");
  assert.deepEqual(error.details.paramKeys, ["expression", "returnByValue"]);
  assert.equal(hanging.attached, false);
});

test("embedded cdp target queries expose every live tab from the current surface only", async () => {
  const currentTabs = [
    {
      tabId: "current-tab-1",
      currentUrl: "https://current.example/page-1",
      title: "Current tab 1",
      webContentsId: 201
    },
    {
      tabId: "current-tab-2",
      currentUrl: "https://current.example/page-2",
      title: "Current tab 2",
      webContentsId: 202
    }
  ];
  const surfaces = [
    {
      id: "chrome",
      label: "Chrome",
      url: "https://www.google.com/",
      surfaceKind: "browser",
      open: true,
      active: false,
      tabs: [{
        tabId: "browser-tab",
        currentUrl: "https://www.google.com/",
        title: "Google",
        webContentsId: 101
      }],
      activeTabId: "browser-tab"
    },
    {
      id: "website:background",
      label: "Background",
      url: "https://background.example/",
      surfaceKind: "website",
      open: true,
      active: false,
      tabs: [{
        tabId: "background-tab",
        currentUrl: "https://background.example/live",
        title: "Background",
        webContentsId: 102
      }],
      activeTabId: "background-tab"
    },
    {
      id: "website:current",
      label: "Current Site",
      url: "https://current.example/",
      surfaceKind: "website",
      open: true,
      active: true,
      tabs: currentTabs,
      activeTabId: "current-tab-2"
    }
  ];
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => surfaces,
    resolveWebContents: () => null
  });

  const response = await gateway.executeCommand({ method: "Target.getTargets" });
  assert.deepEqual(
    response.result.targetInfos.map((target) => target.surfaceId),
    ["website:current", "website:current"]
  );
  assert.deepEqual(response.result.targetInfos.map((target) => target.tabId), ["current-tab-1", "current-tab-2"]);
  assert.equal(new Set(response.result.targetInfos.map((target) => target.targetId)).size, 2);
  assert.equal(response.result.currentTargetInfo.surfaceId, "website:current");
  assert.equal(response.result.currentTargetInfo.tabId, "current-tab-2");
  assert.equal(response.result.currentTargetId, response.result.currentTargetInfo.targetId);
  assert.equal(response.result.currentSurfaceId, "website:current");
  assert.equal(response.result.activeTabId, "current-tab-2");
  assert.equal(response.surfaceId, "website:current");
  assert.equal(response.result.targetInfos.filter((target) => target.current).length, 1);

  const currentResponse = await gateway.executeCommand({ method: "Target.getCurrentTarget" });
  assert.equal(currentResponse.result.targetInfo.tabId, "current-tab-2");
  assert.equal(currentResponse.result.currentTargetId, response.result.currentTargetId);
  assert.equal(currentResponse.result.activeTabId, "current-tab-2");

  await assert.rejects(
    gateway.executeCommand({
      method: "Target.getTargets",
      params: { scope: "all" }
    }),
    (error) => error?.code === "invalid_args" && /does not accept params/u.test(error.message)
  );

  surfaces[2].activeTabId = null;
  const attachingActiveTabResponse = await gateway.executeCommand({ method: "Target.getTargets" });
  assert.equal(attachingActiveTabResponse.result.targetInfos.length, 2);
  assert.equal(attachingActiveTabResponse.result.currentTargetInfo, null);
  assert.equal(attachingActiveTabResponse.result.currentTargetId, null);
  assert.equal(attachingActiveTabResponse.result.activeTabId, null);
});

test("embedded cdp target queries return an explicit empty current state without first-item fallback", async () => {
  const backgroundTab = {
    tabId: "background-tab",
    currentUrl: "https://background.example/",
    title: "Background",
    webContentsId: 501
  };
  const backgroundSurface = {
    id: "website:background",
    label: "Background",
    url: "https://background.example/",
    surfaceKind: "website",
    open: true,
    active: false,
    tabs: [backgroundTab],
    activeTabId: backgroundTab.tabId
  };
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => [backgroundSurface],
    resolveWebContents: () => null
  });

  const targetsResponse = await gateway.executeCommand({ method: "Target.getTargets" });
  assert.equal(targetsResponse.result.targetInfos.length, 0);
  assert.equal(targetsResponse.result.currentTargetInfo, null);
  assert.equal(targetsResponse.result.currentTargetId, null);
  assert.equal(targetsResponse.result.currentSurfaceId, null);
  assert.equal(Object.hasOwn(targetsResponse, "targetId"), false);
  assert.equal(Object.hasOwn(targetsResponse, "surfaceId"), false);

  const currentResponse = await gateway.executeCommand({ method: "Target.getCurrentTarget" });
  assert.equal(currentResponse.result.targetInfo, null);
  assert.equal(currentResponse.result.currentTargetId, null);
  assert.equal(currentResponse.result.currentSurfaceId, null);

  await assert.rejects(
    gateway.executeCommand({
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
      targetId: gatewayInternals.stableTargetId(backgroundSurface, backgroundTab)
    }),
    (error) => error?.code === "target_not_in_current_surface"
  );

  const emptyGateway = new EmbeddedCdpGateway({
    getSurfaces: () => [{
      id: "website:closed",
      label: "Closed",
      url: "https://closed.example/",
      surfaceKind: "website",
      open: false,
      active: false
    }],
    resolveWebContents: () => null
  });
  const emptyResponse = await emptyGateway.executeCommand({ method: "Target.getTargets" });
  assert.deepEqual(emptyResponse.result.targetInfos, []);
  assert.equal(emptyResponse.result.currentTargetInfo, null);

});

test("embedded cdp commands require a target from the current surface and allow inactive sibling tabs", async () => {
  const sentCommands = [];
  function createContents(id) {
    let attached = false;
    return {
      id,
      isDestroyed: () => false,
      getURL: () => `https://example.test/${id}`,
      getTitle: () => `Tab ${id}`,
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
        },
        sendCommand: async (method, params) => {
          sentCommands.push({ id, method, params });
          return { value: id };
        }
      }
    };
  }
  const currentTabs = [
    { tabId: "tab-active", currentUrl: "https://example.test/active", title: "Active", webContentsId: 301 },
    { tabId: "tab-inactive", currentUrl: "https://example.test/inactive", title: "Inactive", webContentsId: 302 }
  ];
  const backgroundTab = {
    tabId: "tab-background",
    currentUrl: "https://other.test/",
    title: "Other",
    webContentsId: 401
  };
  const surfaces = [
    {
      id: "website:current",
      label: "Current",
      url: "https://example.test/",
      surfaceKind: "website",
      open: true,
      active: true,
      tabs: currentTabs,
      activeTabId: "tab-active"
    },
    {
      id: "website:background",
      label: "Background",
      url: "https://other.test/",
      surfaceKind: "website",
      open: true,
      active: false,
      tabs: [backgroundTab],
      activeTabId: backgroundTab.tabId
    }
  ];
  const contents = new Map([[301, createContents(301)], [302, createContents(302)], [401, createContents(401)]]);
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => surfaces,
    resolveWebContents: (_surface, tab) => contents.get(tab.webContentsId) ?? null
  });

  await assert.rejects(
    gateway.executeCommand({ method: "Runtime.evaluate", params: { expression: "1+1" } }),
    (error) => error?.code === "target_required"
  );

  const inactiveTargetId = gatewayInternals.stableTargetId(surfaces[0], currentTabs[1]);
  const result = await gateway.executeCommand({
    method: "Runtime.evaluate",
    params: { expression: "1+1" },
    targetId: inactiveTargetId
  });
  assert.equal(result.targetId, inactiveTargetId);
  assert.equal(result.surfaceId, "website:current");
  assert.deepEqual(sentCommands, [{ id: 302, method: "Runtime.evaluate", params: { expression: "1+1" } }]);

  const backgroundTargetId = gatewayInternals.stableTargetId(surfaces[1], backgroundTab);
  await assert.rejects(
    gateway.executeCommand({
      method: "Runtime.evaluate",
      params: { expression: "2+2" },
      targetId: backgroundTargetId
    }),
    (error) => error?.code === "target_not_in_current_surface"
  );

  await assert.rejects(
    gateway.executeCommand({
      method: "Runtime.evaluate",
      params: { expression: "3+3" },
      targetId: "desktop-closed-target"
    }),
    (error) => error?.code === "target_not_found"
  );
});

test("browser surface registry uses explicit guest registrations for complete surface tab state", () => {
  let currentPageSnapshot = {
    pageKind: "webview",
    surfaceId: "website:docs",
    webContentsId: 101,
    pageContext: {
      browserTarget: {
        kind: "webview",
        surfaceId: "website:docs",
        currentUrl: "https://redirected.example/live"
      }
    }
  };
  const contentsById = new Map();
  const docsContents = {
    id: 101,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getType: () => "webview",
    getURL: () => "https://redirected.example/live",
    getTitle: () => "Redirected Docs"
  };
  const appContents = {
    id: 102,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getType: () => "webview",
    getURL: () => "http://127.0.0.1:19001/dashboard",
    getTitle: () => "Local App"
  };
  const docsBackgroundContents = {
    id: 103,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getType: () => "webview",
    getURL: () => "https://redirected.example/background",
    getTitle: () => "Background Docs"
  };
  contentsById.set(docsContents.id, docsContents);
  contentsById.set(appContents.id, appContents);
  contentsById.set(docsBackgroundContents.id, docsBackgroundContents);

  const registry = createBrowserSurfaceRegistry({
    webContents: {
      getAllWebContents: () => [...contentsById.values()],
      fromId: (id) => contentsById.get(id)
    },
    listWebEntries: () => ({
      items: [
        {
          id: "docs",
          entryKey: "website:docs",
          kind: "website",
          label: "Docs",
          url: "https://docs.example/"
        },
        {
          id: "app",
          entryKey: "webapp:app",
          kind: "webapp",
          label: "App",
          url: "http://127.0.0.1:19001/"
        }
      ]
    }),
    getCurrentPageSnapshot: () => currentPageSnapshot
  });

  assert.equal(registry.listBrowserSurfaces().find((surface) => surface.id === "website:docs").open, false);
  assert.equal(registry.registerSurface({
    registrationId: "docs-registration",
    surfaceId: "website:docs",
    surfaceKind: "website",
    label: "Docs",
    url: "https://docs.example/",
    active: true,
    tabs: [
      {
        tabId: "docs-tab-active",
        currentUrl: "https://redirected.example/live",
        title: "Redirected Docs",
        webContentsId: 101,
        canGoBack: true,
        canGoForward: false,
        isLoading: false
      },
      {
        tabId: "docs-tab-background",
        currentUrl: "https://redirected.example/background",
        title: "Background Docs",
        webContentsId: 103,
        canGoBack: false,
        canGoForward: false,
        isLoading: true
      }
    ],
    activeTabId: "docs-tab-active"
  }, 7), true);
  assert.equal(registry.registerSurface({
    registrationId: "app-registration",
    surfaceId: "webapp:app",
    surfaceKind: "webapp",
    label: "App",
    url: "http://127.0.0.1:19001/",
    active: false,
    tabs: [{
      tabId: "app-tab",
      currentUrl: "http://127.0.0.1:19001/dashboard",
      title: "Local App",
      webContentsId: 102,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }],
    activeTabId: "app-tab"
  }, 7), true);

  const surfaces = registry.listBrowserSurfaces();
  const docs = surfaces.find((surface) => surface.id === "website:docs");
  const app = surfaces.find((surface) => surface.id === "webapp:app");
  assert.equal(docs.open, true);
  assert.equal(docs.active, true);
  assert.equal(docs.currentUrl, "https://redirected.example/live");
  assert.equal(docs.title, "Redirected Docs");
  assert.equal(docs.webContentsId, 101);
  assert.equal(docs.activeTabId, "docs-tab-active");
  assert.deepEqual(docs.tabs.map((tab) => tab.tabId), ["docs-tab-active", "docs-tab-background"]);
  assert.equal(app.open, true);
  assert.equal(app.active, false);
  assert.equal(registry.findRegisteredSurfaceWebContents("website:docs"), docsContents);
  assert.equal(registry.findRegisteredSurfaceWebContents("website:docs", "docs-tab-background"), docsBackgroundContents);

  assert.equal(registry.unregisterSurface({
    registrationId: "wrong-registration",
    surfaceId: "website:docs"
  }, 7), false);
  docsContents.destroyed = true;
  const docsWithoutActiveGuest = registry.listBrowserSurfaces().find((surface) => surface.id === "website:docs");
  assert.equal(docsWithoutActiveGuest.open, true);
  assert.equal(docsWithoutActiveGuest.activeTabId, null);
  assert.deepEqual(docsWithoutActiveGuest.tabs.map((tab) => tab.tabId), ["docs-tab-background"]);
  docsBackgroundContents.destroyed = true;
  assert.equal(registry.listBrowserSurfaces().find((surface) => surface.id === "website:docs").open, false);

  currentPageSnapshot = null;
  registry.unregisterSurfacesForOwner(7);
  assert.equal(registry.listBrowserSurfaces().find((surface) => surface.id === "webapp:app").open, false);
});

test("current page cdp inspector uses the shared command helper", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "main", "current-page-cdp-inspector.ts"), "utf8");

  assert.match(source, /sendDesktopCdpCommand/u);
});
