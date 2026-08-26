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
const {
  createSurfaceIdentity,
  createWebEntrySurfaceIdentity
} = require("../dist-electron/shared/surface-identity.js");

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
    surfaceId: "site:target",
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
  assert.equal(error.details.surfaceId, "site:target");
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
    id: "site:slow",
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
  assert.equal(error.details.surfaceId, "site:slow");
  assert.equal(error.details.webContentsId, 42);
  assert.equal(error.details.url, "https://example.test/live");
  assert.deepEqual(error.details.paramKeys, ["expression", "returnByValue"]);
  assert.equal(hanging.attached, false);
});

test("embedded cdp Page.reload uses guest reload APIs without attaching the debugger", async () => {
  const { logger, events } = createLoggerSink();
  const calls = [];
  let attached = false;
  const tab = {
    tabId: "reload-tab",
    currentUrl: "https://example.test/reload",
    title: "Reload",
    webContentsId: 43
  };
  const surface = {
    id: "site:reload",
    surfaceId: "site:reload",
    surfaceRole: "website",
    surfaceLevel: "root",
    interaction: "interactive",
    label: "Reload",
    url: "https://example.test/reload",
    surfaceKind: "website",
    open: true,
    active: true,
    tabs: [tab],
    activeTabId: tab.tabId
  };
  const contents = {
    id: tab.webContentsId,
    isDestroyed: () => false,
    getURL: () => tab.currentUrl,
    getTitle: () => tab.title,
    reload: () => calls.push("reload"),
    reloadIgnoringCache: () => calls.push("reloadIgnoringCache"),
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
        calls.push("attach");
      },
      detach: () => {
        attached = false;
        calls.push("detach");
      },
      sendCommand: async () => {
        calls.push("sendCommand");
        return {};
      }
    }
  };
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => [surface],
    resolveWebContents: () => contents,
    logger
  });
  const targetId = gatewayInternals.stableTargetId(surface, tab);

  const normal = await gateway.executeCommand({
    method: "Page.reload",
    params: { ignoreCache: false },
    targetId
  });
  assert.deepEqual(normal.result, {});
  assert.deepEqual(calls, ["reload"]);
  assert.equal(attached, false);

  const connection = { sendJSON() {} };
  const ignoredCache = await gateway.handleWebContentsCommand(
    connection,
    { surface, tab, targetId },
    "Page.reload",
    { ignoreCache: true }
  );
  assert.deepEqual(ignoredCache, {});
  assert.deepEqual(calls, ["reload", "reloadIgnoringCache"]);
  assert.equal(attached, false);
  assert.equal(events.filter((event) => event.args[0] === "[desktop-cdp] host-command start").length, 2);
  assert.equal(events.filter((event) => event.args[0] === "[desktop-cdp] host-command success").length, 2);

  await assert.rejects(
    gateway.executeCommand({
      method: "Page.reload",
      params: { ignoreCache: "false" },
      targetId
    }),
    (error) => error?.code === "invalid_args" && /must be a boolean/u.test(error.message)
  );
  await assert.rejects(
    gateway.executeCommand({
      method: "Page.reload",
      params: { loaderId: "unsupported" },
      targetId
    }),
    (error) => error?.code === "invalid_args" && /only accepts/u.test(error.message)
  );
  assert.deepEqual(calls, ["reload", "reloadIgnoringCache"]);
});

test("embedded cdp target ids survive guest replacement but change with a new surface generation", () => {
  const tab = {
    tabId: "stable-tab",
    currentUrl: "https://example.test/",
    title: "Stable",
    webContentsId: 41
  };
  const surface = {
    id: "site:stable",
    targetGeneration: "surface-generation-1",
    label: "Stable",
    url: "https://example.test/",
    surfaceKind: "website",
    open: true
  };
  const firstTargetId = gatewayInternals.stableTargetId(surface, tab);
  const replacementTargetId = gatewayInternals.stableTargetId(surface, {
    ...tab,
    webContentsId: 42
  });
  const rebuiltTargetId = gatewayInternals.stableTargetId({
    ...surface,
    targetGeneration: "surface-generation-2"
  }, tab);

  assert.equal(replacementTargetId, firstTargetId);
  assert.notEqual(rebuiltTargetId, firstTargetId);
});

test("embedded cdp Target.closeTarget delegates the current tab to the host transaction", async () => {
  const tab = {
    tabId: "close-tab",
    currentUrl: "https://example.test/close",
    title: "Close",
    webContentsId: 71
  };
  const surface = {
    id: "site:close",
    targetGeneration: "close-generation",
    label: "Close",
    url: "https://example.test/",
    surfaceKind: "website",
    open: true,
    active: true,
    tabs: [tab],
    activeTabId: tab.tabId
  };
  const closeCalls = [];
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => [surface],
    resolveWebContents: () => null,
    closeTarget: async (resolvedSurface, resolvedTab) => {
      closeCalls.push({ surfaceId: resolvedSurface.id, tabId: resolvedTab.tabId });
    }
  });
  const targetId = gatewayInternals.stableTargetId(surface, tab);
  const response = await gateway.executeCommand({
    method: "Target.closeTarget",
    targetId
  });

  assert.deepEqual(response.result, { success: true });
  assert.equal(response.targetId, targetId);
  assert.equal(response.surfaceId, surface.id);
  assert.deepEqual(closeCalls, [{ surfaceId: surface.id, tabId: tab.tabId }]);

  const websocketResponses = [];
  const connection = { sendJSON: (payload) => websocketResponses.push(payload) };
  await gateway.handleTextMessage(connection, targetId, JSON.stringify({
    id: 9,
    method: "Target.closeTarget",
    params: { targetId }
  }));
  assert.deepEqual(websocketResponses, [{ id: 9, result: { success: true } }]);
  assert.deepEqual(closeCalls, [
    { surfaceId: surface.id, tabId: tab.tabId },
    { surfaceId: surface.id, tabId: tab.tabId }
  ]);

  await gateway.handleTextMessage(connection, targetId, JSON.stringify({
    id: 10,
    method: "Target.closeTarget",
    params: { targetId: "desktop-conflict" }
  }));
  assert.equal(websocketResponses[1].id, 10);
  assert.equal(websocketResponses[1].error.code, -32602);
  assert.equal(websocketResponses[1].error.data.code, "invalid_args");
});

test("embedded cdp debugger session rebinds when a stable target gets replacement contents", () => {
  function createContents(id) {
    let attached = false;
    const listeners = new Set();
    return {
      id,
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        detach: () => { attached = false; },
        on: (_event, listener) => listeners.add(listener),
        off: (_event, listener) => listeners.delete(listener)
      },
      get attached() {
        return attached;
      },
      get listenerCount() {
        return listeners.size;
      }
    };
  }
  const first = createContents(81);
  const second = createContents(82);
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => [],
    resolveWebContents: () => null
  });
  const connection = { sendJSON() {} };

  gateway.ensureDebuggerSession(connection, "desktop-stable", first);
  gateway.ensureDebuggerSession(connection, "desktop-stable", second);

  assert.equal(first.attached, false);
  assert.equal(first.listenerCount, 0);
  assert.equal(second.attached, true);
  assert.equal(second.listenerCount, 1);
  gateway.releaseConnection(connection);
  assert.equal(second.attached, false);
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
      id: "site:background",
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
      id: "site:current",
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
    ["site:current", "site:current"]
  );
  assert.deepEqual(response.result.targetInfos.map((target) => target.tabId), ["current-tab-1", "current-tab-2"]);
  assert.equal(new Set(response.result.targetInfos.map((target) => target.targetId)).size, 2);
  assert.equal(response.result.currentTargetInfo.surfaceId, "site:current");
  assert.equal(response.result.currentTargetInfo.tabId, "current-tab-2");
  assert.equal(response.result.currentTargetId, response.result.currentTargetInfo.targetId);
  assert.equal(response.result.currentSurfaceId, "site:current");
  assert.equal(response.result.activeTabId, "current-tab-2");
  assert.equal(response.surfaceId, "site:current");
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

test("embedded cdp current target excludes active child surfaces and is registration-order independent", async () => {
  const websiteTab = {
    tabId: "website-tab",
    currentUrl: "https://website.example/",
    title: "Website",
    webContentsId: 601
  };
  const dockTab = {
    tabId: "copilot-dock",
    currentUrl: "http://127.0.0.1:7079/copilot/helper",
    title: "Copilot",
    webContentsId: 602
  };
  const website = {
    id: "site:website",
    surfaceId: "site:website",
    surfaceRole: "website",
    surfaceLevel: "root",
    interaction: "interactive",
    label: "Website",
    url: websiteTab.currentUrl,
    surfaceKind: "website",
    open: true,
    active: true,
    tabs: [websiteTab],
    activeTabId: websiteTab.tabId
  };
  const dock = {
    id: "copilot-dock",
    surfaceId: "copilot-dock",
    surfaceRole: "copilot-dock",
    surfaceLevel: "child",
    parentSurfaceId: website.id,
    interaction: "interactive",
    label: "Copilot",
    url: dockTab.currentUrl,
    surfaceKind: "service",
    open: true,
    active: true,
    tabs: [dockTab],
    activeTabId: dockTab.tabId
  };
  let surfaces = [dock, website];
  const resolvedWebContentsIds = [];
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => surfaces,
    resolveWebContents: (_surface, tab) => {
      resolvedWebContentsIds.push(tab.webContentsId);
      return null;
    }
  });

  for (const ordered of [[dock, website], [website, dock]]) {
    surfaces = ordered;
    const response = await gateway.executeCommand({ method: "Target.getTargets" });
    assert.deepEqual(response.result.targetInfos.map((target) => target.surfaceId), [website.id]);
    assert.equal(response.result.currentSurfaceId, website.id);
    assert.deepEqual((await gateway.listTargets()).map((target) => target.surfaceId), [website.id]);
  }

  await assert.rejects(
    gateway.executeCommand({
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
      targetId: gatewayInternals.stableTargetId(dock, dockTab)
    }),
    (error) => error?.code === "target_not_in_current_surface"
  );
  assert.deepEqual(resolvedWebContentsIds, []);
});

test("embedded cdp current target fails closed when multiple public root surfaces are active", async () => {
  const createActiveSurface = (suffix, webContentsId) => {
    const tab = {
      tabId: `tab-${suffix}`,
      currentUrl: `https://${suffix}.example/`,
      title: suffix,
      webContentsId
    };
    return {
      id: `site:${suffix}`,
      surfaceId: `site:${suffix}`,
      surfaceRole: "website",
      surfaceLevel: "root",
      interaction: "interactive",
      label: suffix,
      url: tab.currentUrl,
      surfaceKind: "website",
      open: true,
      active: true,
      tabs: [tab],
      activeTabId: tab.tabId
    };
  };
  const first = createActiveSurface("first", 611);
  const second = createActiveSurface("second", 612);
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => [first, second],
    resolveWebContents: () => null
  });

  const response = await gateway.executeCommand({ method: "Target.getCurrentTarget" });
  assert.equal(response.result.currentTargetId, null);
  assert.equal(response.result.currentSurfaceId, null);
  assert.deepEqual(await gateway.listTargets(), []);
  await assert.rejects(
    gateway.executeCommand({
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
      targetId: gatewayInternals.stableTargetId(first, first.tabs[0])
    }),
    (error) => error?.code === "target_not_in_current_surface"
  );
});

test("embedded cdp target queries return an explicit empty current state without first-item fallback", async () => {
  const backgroundTab = {
    tabId: "background-tab",
    currentUrl: "https://background.example/",
    title: "Background",
    webContentsId: 501
  };
  const backgroundSurface = {
    id: "site:background",
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
      id: "site:closed",
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
      id: "site:current",
      label: "Current",
      url: "https://example.test/",
      surfaceKind: "website",
      open: true,
      active: true,
      tabs: currentTabs,
      activeTabId: "tab-active"
    },
    {
      id: "site:background",
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
  assert.equal(result.surfaceId, "site:current");
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

test("embedded cdp authorizes chat-owned Work Panel targets without changing current target discovery", async () => {
  const sentCommands = [];
  const createContents = (id) => {
    let attached = false;
    return {
      id,
      isDestroyed: () => false,
      getURL: () => `https://work.example/${id}`,
      getTitle: () => `Work ${id}`,
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        detach: () => { attached = false; },
        sendCommand: async (method, params) => {
          sentCommands.push({ id, method, params });
          return { value: id };
        }
      }
    };
  };
  const currentTab = { tabId: "current-tab", currentUrl: "https://current.example/", title: "Current", webContentsId: 501 };
  const ownedTab = { tabId: "owned-tab", currentUrl: "https://work.example/owned", title: "Owned", webContentsId: 502 };
  const otherTab = { tabId: "other-tab", currentUrl: "https://work.example/other", title: "Other", webContentsId: 503 };
  const surfaces = [
    {
      id: "site:current",
      targetGeneration: "current-1",
      label: "Current",
      url: currentTab.currentUrl,
      surfaceKind: "website",
      open: true,
      active: true,
      tabs: [currentTab],
      activeTabId: currentTab.tabId
    },
    {
      id: "web:owned",
      targetGeneration: "owned-1",
      label: "Work Panel",
      url: ownedTab.currentUrl,
      surfaceKind: "chat-work-panel",
      ownerChatId: "chat-owned",
      open: true,
      active: false,
      tabs: [ownedTab],
      activeTabId: ownedTab.tabId
    },
    {
      id: "web:other",
      targetGeneration: "other-1",
      label: "Work Panel",
      url: otherTab.currentUrl,
      surfaceKind: "chat-work-panel",
      ownerChatId: "chat-other",
      open: true,
      active: false,
      tabs: [otherTab],
      activeTabId: otherTab.tabId
    }
  ];
  const contents = new Map([501, 502, 503].map((id) => [id, createContents(id)]));
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => surfaces,
    resolveWebContents: (_surface, tab) => contents.get(tab.webContentsId) ?? null
  });

  const targets = await gateway.executeCommand({ method: "Target.getTargets" });
  assert.deepEqual(targets.result.targetInfos.map((target) => target.surfaceId), ["site:current"]);

  const ownedTargetId = gatewayInternals.stableTargetId(surfaces[1], ownedTab);
  const result = await gateway.executeCommand({
    method: "Runtime.evaluate",
    params: { expression: "document.title" },
    targetId: ownedTargetId,
    source: { chatId: "chat-owned" }
  });
  assert.equal(result.surfaceId, "web:owned");
  assert.equal(sentCommands.at(-1).id, 502);

  await assert.rejects(
    gateway.executeCommand({
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
      targetId: gatewayInternals.stableTargetId(surfaces[2], otherTab),
      source: { chatId: "chat-owned" }
    }),
    (error) => error?.code === "target_not_owned_by_chat"
  );

  await assert.rejects(
    gateway.executeCommand({
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
      targetId: "desktop-stale-work-panel-target",
      source: { chatId: "chat-owned" }
    }),
    (error) => error?.code === "target_not_found"
  );
});

test("browser surface registry uses explicit guest registrations for complete surface tab state", () => {
  const docsIdentity = createWebEntrySurfaceIdentity("website", "website:docs");
  const appIdentity = createWebEntrySurfaceIdentity("webapp", "webapp:app");
  let currentPageSnapshot = {
    pageKind: "webview",
    surfaceId: docsIdentity.surfaceId,
    webContentsId: 101,
    pageContext: {
      browserTarget: {
        kind: "webview",
        surfaceId: docsIdentity.surfaceId,
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

  assert.deepEqual(
    registry.registerSurface({}, 7),
    { ok: false, reason: "invalid_registration" }
  );
  const mainChatIdentity = createSurfaceIdentity("main-chat", "", {
    ownerChatId: "chat-a"
  });
  const mainChatRegistration = {
    registrationId: "main-chat-generation",
    ...mainChatIdentity,
    surfaceKind: "service",
    surfaceType: "agent-chat",
    serviceId: "agent-webclient",
    pageRoute: "/agent/agent-a",
    pageRouteIdentity: "/agent/agent-a?chatId=chat-a",
    ownerChatId: "chat-a",
    label: "Main Chat",
    url: "http://127.0.0.1:7079/agent/agent-a?chatId=chat-a",
    active: false,
    tabs: [{
      tabId: mainChatIdentity.surfaceId,
      currentUrl: "http://127.0.0.1:7079/agent/agent-b?chatId=chat-a",
      title: "Main Chat",
      webContentsId: 103,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }],
    activeTabId: mainChatIdentity.surfaceId
  };
  assert.deepEqual(registry.registerSurface(mainChatRegistration, 7), { ok: true });
  assert.deepEqual(
    registry.registerSurface(mainChatRegistration, 8),
    { ok: false, reason: "ownership_conflict" }
  );
  assert.equal(registry.unregisterSurface({
    registrationId: mainChatRegistration.registrationId,
    surfaceId: mainChatIdentity.surfaceId
  }, 7), true);
  assert.deepEqual(
    registry.registerSurface({ ...mainChatRegistration, active: true }, 7),
    { ok: false, reason: "route_not_aligned" }
  );

  assert.equal(registry.listBrowserSurfaces().find((surface) => surface.id === docsIdentity.surfaceId).open, false);
  assert.deepEqual(registry.registerSurface({
    registrationId: "docs-registration",
    ...docsIdentity,
    surfaceIdentityKey: "website:docs",
    surfaceKind: "website",
    pageRoute: "/webs/website:docs",
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
  }, 7), { ok: true });
  assert.deepEqual(registry.registerSurface({
    registrationId: "app-registration",
    ...appIdentity,
    surfaceIdentityKey: "webapp:app",
    surfaceKind: "webapp",
    pageRoute: "/webs/webapp:app",
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
  }, 7), { ok: true });

  const surfaces = registry.listBrowserSurfaces();
  const registeredSurfaces = registry.listRegisteredSurfaces();
  const docs = surfaces.find((surface) => surface.id === docsIdentity.surfaceId);
  const app = surfaces.find((surface) => surface.id === appIdentity.surfaceId);
  assert.equal(docs.open, true);
  assert.equal(docs.active, true);
  assert.equal(docs.currentUrl, "https://redirected.example/live");
  assert.equal(docs.title, "Redirected Docs");
  assert.equal(docs.webContentsId, 101);
  assert.equal(docs.activeTabId, "docs-tab-active");
  assert.deepEqual(docs.tabs.map((tab) => tab.tabId), ["docs-tab-active", "docs-tab-background"]);
  assert.equal(app.open, true);
  assert.equal(app.active, false);
  assert.deepEqual(
    registeredSurfaces.map((surface) => surface.surfaceId).sort(),
    [appIdentity.surfaceId, docsIdentity.surfaceId].sort()
  );
  assert.equal(registeredSurfaces.find((surface) => surface.surfaceId === docsIdentity.surfaceId).entryKey, "website:docs");
  assert.equal(registry.findRegisteredSurfaceWebContents("website:docs"), docsContents);
  assert.equal(registry.findRegisteredSurfaceWebContents("website:docs", "docs-tab-background"), docsBackgroundContents);

  assert.equal(registry.unregisterSurface({
    registrationId: "wrong-registration",
    surfaceId: "website:docs"
  }, 7), false);
  docsContents.destroyed = true;
  const docsWithoutActiveGuest = registry.listBrowserSurfaces().find((surface) => surface.id === docsIdentity.surfaceId);
  assert.equal(docsWithoutActiveGuest.open, true);
  assert.equal(docsWithoutActiveGuest.activeTabId, "docs-tab-background");
  assert.equal(docsWithoutActiveGuest.targetGeneration, "docs-registration");
  assert.deepEqual(docsWithoutActiveGuest.tabs.map((tab) => tab.tabId), ["docs-tab-background"]);
  docsBackgroundContents.destroyed = true;
  assert.equal(registry.listBrowserSurfaces().find((surface) => surface.id === docsIdentity.surfaceId).open, false);

  currentPageSnapshot = null;
  registry.unregisterSurfacesForOwner(7);
  assert.equal(registry.listBrowserSurfaces().find((surface) => surface.id === appIdentity.surfaceId).open, false);
});

test("browser surface registry keeps Copilot Dock live-active while excluding it from public CDP current", () => {
  const websiteIdentity = createWebEntrySurfaceIdentity("website", "website:current");
  const dockIdentity = createSurfaceIdentity("copilot-dock", "", {
    parentSurfaceId: websiteIdentity.surfaceId
  });
  const currentPageSnapshot = {
    pageKind: "webview",
    surfaceId: websiteIdentity.surfaceId,
    webContentsId: 701,
    pageContext: {
      browserTarget: {
        kind: "webview",
        surfaceId: websiteIdentity.surfaceId,
        currentUrl: "https://current.example/live"
      }
    }
  };
  const createContents = (id, url, title) => ({
    id,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => url,
    getTitle: () => title
  });
  const contentsById = new Map([
    [701, createContents(701, "https://current.example/live", "Current Website")],
    [702, createContents(702, "http://127.0.0.1:7079/copilot/helper", "Copilot")]
  ]);
  const registry = createBrowserSurfaceRegistry({
    webContents: {
      getAllWebContents: () => [...contentsById.values()],
      fromId: (id) => contentsById.get(id)
    },
    listWebEntries: () => ({
      items: [{
        id: "current",
        entryKey: "website:current",
        kind: "website",
        label: "Current Website",
        url: "https://current.example/"
      }]
    }),
    getCurrentPageSnapshot: () => currentPageSnapshot
  });

  assert.deepEqual(registry.registerSurface({
    registrationId: "website-generation",
    ...websiteIdentity,
    surfaceIdentityKey: "website:current",
    surfaceKind: "website",
    surfaceType: "website",
    pageRoute: "/webs/website:current",
    label: "Current Website",
    url: "https://current.example/",
    active: true,
    tabs: [{
      tabId: "website-tab",
      currentUrl: "https://current.example/live",
      title: "Current Website",
      webContentsId: 701,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }],
    activeTabId: "website-tab"
  }, 7), { ok: true });
  assert.deepEqual(registry.registerSurface({
    registrationId: "dock-generation",
    ...dockIdentity,
    surfaceKind: "service",
    surfaceType: "agent-copilot",
    serviceId: "agent-webclient",
    label: "Copilot",
    url: "http://127.0.0.1:7079/copilot/helper",
    active: true,
    tabs: [{
      tabId: "copilot-dock",
      currentUrl: "http://127.0.0.1:7079/copilot/helper",
      title: "Copilot",
      webContentsId: 702,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }],
    activeTabId: "copilot-dock"
  }, 7), { ok: true });

  assert.equal(registry.resolveWebviewSurfaceTarget(702).active, true);
  const exported = registry.listRegisteredSurfaces();
  assert.equal(exported.find((surface) => surface.surfaceId === websiteIdentity.surfaceId).active, true);
  assert.equal(exported.find((surface) => surface.surfaceId === dockIdentity.surfaceId).active, false);
});

test("current page cdp inspector uses the shared command helper", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "main", "current-page-cdp-inspector.ts"), "utf8");

  assert.match(source, /sendDesktopCdpCommand/u);
});
