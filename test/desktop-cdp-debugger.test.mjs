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
  const surface = {
    id: "website:slow",
    label: "Slow Page",
    url: "https://example.test/slow?token=secret",
    active: true
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
    targetId: gatewayInternals.stableTargetId(surface)
  }));

  assert.equal(isDesktopCdpTimeoutError(error), true);
  assert.equal(error.code, DESKTOP_CDP_TARGET_TIMEOUT_CODE);
  assert.equal(error.details.surfaceId, "website:slow");
  assert.equal(error.details.webContentsId, 42);
  assert.equal(error.details.url, "https://example.test/live");
  assert.deepEqual(error.details.paramKeys, ["expression", "returnByValue"]);
  assert.equal(hanging.attached, false);
});

test("embedded cdp target queries default to open sites and expose the current target directly", async () => {
  const surfaces = [
    {
      id: "chrome",
      label: "Chrome",
      url: "https://www.google.com/",
      currentUrl: "https://www.google.com/",
      surfaceKind: "browser",
      open: true,
      active: false
    },
    {
      id: "website:background",
      label: "Background",
      url: "https://background.example/",
      currentUrl: "https://background.example/live",
      surfaceKind: "website",
      open: true,
      active: false
    },
    {
      id: "website:current",
      label: "Current Site",
      url: "https://current.example/",
      currentUrl: "https://current.example/page",
      surfaceKind: "website",
      open: true,
      active: true
    },
    {
      id: "webapp:open",
      label: "Open App",
      url: "http://127.0.0.1:19001/",
      surfaceKind: "webapp",
      open: true,
      active: false
    },
    {
      id: "website:closed",
      label: "Closed Site",
      url: "https://closed.example/",
      surfaceKind: "website",
      open: false,
      active: false
    },
    {
      id: "identity-center",
      label: "Identity",
      url: "http://127.0.0.1:17080/",
      surfaceKind: "service",
      open: true,
      active: false
    }
  ];
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => surfaces,
    resolveWebContents: () => null
  });

  const response = await gateway.executeCommand({ method: "Target.getTargets" });
  assert.deepEqual(
    response.result.targetInfos.map((target) => target.surfaceId),
    ["website:background", "website:current", "webapp:open"]
  );
  assert.equal(response.result.currentTargetInfo.surfaceId, "website:current");
  assert.deepEqual(
    response.result.currentTargetInfo,
    response.result.targetInfos.find((target) => target.surfaceId === "website:current")
  );
  assert.equal(response.result.currentTargetId, response.result.currentTargetInfo.targetId);
  assert.equal(response.result.currentSurfaceId, "website:current");
  assert.equal(response.surfaceId, "website:current");
  assert.equal(response.result.targetInfos.filter((target) => target.current).length, 1);
  assert.equal(response.result.targetInfos.every((target) => target.open), true);

  const allResponse = await gateway.executeCommand({
    method: "Target.getTargets",
    params: { scope: "all" }
  });
  assert.equal(allResponse.result.targetInfos.length, surfaces.length);
  assert.deepEqual(
    allResponse.result.targetInfos.map((target) => target.surfaceKind),
    ["browser", "website", "website", "webapp", "website", "service"]
  );
  assert.equal(
    allResponse.result.targetInfos.find((target) => target.surfaceId === "website:closed").open,
    false
  );
});

test("embedded cdp target queries return an explicit empty current state without first-item fallback", async () => {
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => [{
      id: "website:background",
      label: "Background",
      url: "https://background.example/",
      surfaceKind: "website",
      open: true,
      active: false
    }],
    resolveWebContents: () => null
  });

  const targetsResponse = await gateway.executeCommand({ method: "Target.getTargets" });
  assert.equal(targetsResponse.result.targetInfos.length, 1);
  assert.equal(targetsResponse.result.currentTargetInfo, null);
  assert.equal(targetsResponse.result.currentTargetId, null);
  assert.equal(targetsResponse.result.currentSurfaceId, null);
  assert.equal(Object.hasOwn(targetsResponse, "targetId"), false);
  assert.equal(Object.hasOwn(targetsResponse, "surfaceId"), false);

  const currentResponse = await gateway.executeCommand({ method: "Target.getCurrentTarget" });
  assert.equal(currentResponse.result.targetInfo, null);
  assert.equal(currentResponse.result.currentTargetId, null);
  assert.equal(currentResponse.result.currentSurfaceId, null);

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

  await assert.rejects(
    gateway.executeCommand({
      method: "Target.getTargets",
      params: { scope: "browser" }
    }),
    (error) => error?.code === "invalid_args" && /scope/u.test(error.message)
  );
});

test("browser surface registry uses explicit guest registrations for open site state", () => {
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
  contentsById.set(docsContents.id, docsContents);
  contentsById.set(appContents.id, appContents);

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
  assert.equal(registry.registerSiteSurface({
    registrationId: "docs-registration",
    surfaceId: "website:docs",
    surfaceKind: "website",
    label: "Docs",
    url: "https://docs.example/",
    currentUrl: "https://redirected.example/live",
    title: "Redirected Docs",
    webContentsId: 101,
    active: true
  }, 7), true);
  assert.equal(registry.registerSiteSurface({
    registrationId: "app-registration",
    surfaceId: "webapp:app",
    surfaceKind: "webapp",
    label: "App",
    url: "http://127.0.0.1:19001/",
    currentUrl: "http://127.0.0.1:19001/dashboard",
    title: "Local App",
    webContentsId: 102,
    active: false
  }, 7), true);

  const surfaces = registry.listBrowserSurfaces();
  const docs = surfaces.find((surface) => surface.id === "website:docs");
  const app = surfaces.find((surface) => surface.id === "webapp:app");
  assert.equal(docs.open, true);
  assert.equal(docs.active, true);
  assert.equal(docs.currentUrl, "https://redirected.example/live");
  assert.equal(docs.title, "Redirected Docs");
  assert.equal(docs.webContentsId, 101);
  assert.equal(app.open, true);
  assert.equal(app.active, false);
  assert.equal(registry.findRegisteredSiteWebContents("website:docs"), docsContents);

  assert.equal(registry.unregisterSiteSurface({
    registrationId: "wrong-registration",
    surfaceId: "website:docs"
  }, 7), false);
  docsContents.destroyed = true;
  assert.equal(registry.listBrowserSurfaces().find((surface) => surface.id === "website:docs").open, false);

  currentPageSnapshot = null;
  registry.unregisterSiteSurfacesForOwner(7);
  assert.equal(registry.listBrowserSurfaces().find((surface) => surface.id === "webapp:app").open, false);
});

test("current page cdp inspector uses the shared command helper", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "main", "current-page-cdp-inspector.ts"), "utf8");

  assert.match(source, /sendDesktopCdpCommand/u);
});
