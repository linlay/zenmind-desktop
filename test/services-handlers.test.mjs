import test from "node:test";
import assert from "node:assert/strict";

const { registerServicesIpcHandlers } = await import("../dist-electron/main/ipc/services-handlers.js");

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeMockIpcMain() {
  const handlers = {};
  return {
    ipc: {
      handle(channel, callback) { handlers[channel] = callback; }
    },
    handlers
  };
}

function makeBaseOptions(overrides = {}) {
  return {
    app: {},
    shell: {
      showItemInFolder: () => {},
      openPath: async () => ""
    },
    platform: "linux",
    listServices: async () => [],
    getServiceState: async () => ({ status: "stopped", kind: "builtin", healthMeta: { port: null } }),
    installBuiltinService: async () => {},
    initializeService: async () => ({ ok: true }),
    startService: async () => ({ ok: true }),
    stopService: async () => ({ ok: true }),
    restartService: async () => ({ ok: true }),
    readServiceConfig: async () => ({ ok: true, content: "" }),
    writeServiceConfig: async () => ({ ok: true }),
    importServiceFile: async () => ({ ok: true }),
    getServiceLogsMeta: async () => ({ ok: true, logs: [] }),
    watchServiceLog: () => () => {},
    readServiceLog: async () => ({ ok: true, content: "" }),
    runServiceMutation: async (task) => task(),
    handleServiceStart: async () => ({ ok: true }),
    showFileDialog: async () => ({ canceled: true, filePaths: [] }),
    showArchiveDialog: async () => ({ canceled: true, filePaths: [] }),
    openLogViewerWindow: async () => ({ ok: true }),
    closeLogViewerWindow: () => {},
    minimizeLogViewerWindow: () => {},
    maximizeLogViewerWindow: () => {},
    revealPathInFileManager: async () => ({ ok: true }),
    getServiceWebviewPreloadPath: () => "/preload/service-webview.js",
    getServiceWebviewPreloadUrl: () => "file:///preload/service-webview.js",
    logStreamSubscriptions: new Map(),
    getArchiveExtensions: (platform) => platform === "win32" ? ["zip"] : ["gz", "tgz"],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. Tracer bullet — services.list
// ---------------------------------------------------------------------------
test("services.list returns service list", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const serviceList = [{ id: "agent-platform", status: "running" }];

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    listServices: async () => serviceList
  }));

  assert.ok(handlers["services.list"], "Should register services.list");
  const result = await handlers["services.list"]({});
  assert.deepEqual(result, serviceList);
});

// ---------------------------------------------------------------------------
// 2. services.getStartupRestoreState
// ---------------------------------------------------------------------------
test("services.getStartupRestoreState returns state from controller", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const state = { phase: "done", services: [] };

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    startupRestoreController: { getState: () => state }
  }));

  assert.ok(handlers["services.getStartupRestoreState"], "Should register handler");
  const result = await handlers["services.getStartupRestoreState"]({});
  assert.deepEqual(result, state);
});

// ---------------------------------------------------------------------------
// 3. services.getStatus — delegates to getServiceState
// ---------------------------------------------------------------------------
test("services.getStatus returns service state", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const serviceState = { status: "running", kind: "builtin" };

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    getServiceState: async (app, id) => {
      assert.equal(id, "agent-platform");
      return serviceState;
    }
  }));

  const result = await handlers["services.getStatus"]({}, "agent-platform");
  assert.deepEqual(result, serviceState);
});

// ---------------------------------------------------------------------------
// 4. services.start — delegates to runServiceMutation + handleServiceStart
// ---------------------------------------------------------------------------
test("services.start calls handleServiceStart via runServiceMutation", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let startedServiceId = null;

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    runServiceMutation: async (task) => task(),
    handleServiceStart: async (serviceId) => {
      startedServiceId = serviceId;
      return { ok: true };
    }
  }));

  const result = await handlers["services.start"]({}, "my-service");
  assert.equal(startedServiceId, "my-service");
  assert.deepEqual(result, { ok: true });
});

// ---------------------------------------------------------------------------
// 5. services.stop / services.restart
// ---------------------------------------------------------------------------
test("services.stop delegates to stopService", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let stoppedId = null;

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    runServiceMutation: async (task) => task(),
    stopService: async (app, id) => { stoppedId = id; return { ok: true }; }
  }));

  const result = await handlers["services.stop"]({}, "svc-1");
  assert.equal(stoppedId, "svc-1");
  assert.deepEqual(result, { ok: true });
});

test("services.restart delegates to restartService", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let restartedId = null;

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    runServiceMutation: async (task) => task(),
    restartService: async (app, id) => { restartedId = id; return { ok: true }; }
  }));

  await handlers["services.restart"]({}, "svc-1");
  assert.equal(restartedId, "svc-1");
});

// ---------------------------------------------------------------------------
// 6. services.readConfig / services.writeConfig
// ---------------------------------------------------------------------------
test("services.readConfig returns config content", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    readServiceConfig: async (app, id, key) => ({ ok: true, content: `value-of-${key}` })
  }));

  const result = await handlers["services.readConfig"]({}, "svc-1", "my-key");
  assert.deepEqual(result, { ok: true, content: "value-of-my-key" });
});

test("services.writeConfig runs through runServiceMutation", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let written = null;

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    runServiceMutation: async (task) => task(),
    writeServiceConfig: async (app, id, key, content) => {
      written = { id, key, content };
      return { ok: true };
    }
  }));

  await handlers["services.writeConfig"]({}, "svc-1", "port", "9000");
  assert.deepEqual(written, { id: "svc-1", key: "port", content: "9000" });
});

// ---------------------------------------------------------------------------
// 7. services.importFile — canceled dialog returns ok:false
// ---------------------------------------------------------------------------
test("services.importFile returns ok:false when dialog is canceled", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const serviceState = { status: "stopped" };

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    runServiceMutation: async (task) => task(),
    showFileDialog: async () => ({ canceled: true, filePaths: [] }),
    getServiceState: async () => serviceState
  }));

  const result = await handlers["services.importFile"]({}, "svc-1", "config.yaml");
  assert.equal(result.ok, false);
  assert.ok(result.message.includes("取消"));
});

test("services.importFile imports file when dialog confirmed", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let importedArgs = null;

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    runServiceMutation: async (task) => task(),
    showFileDialog: async () => ({ canceled: false, filePaths: ["/tmp/config.yaml"] }),
    importServiceFile: async (app, id, key, filePath) => {
      importedArgs = { id, key, filePath };
      return { ok: true };
    }
  }));

  const result = await handlers["services.importFile"]({}, "svc-1", "config.yaml");
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(importedArgs, { id: "svc-1", key: "config.yaml", filePath: "/tmp/config.yaml" });
});

// ---------------------------------------------------------------------------
// 8. services.getLogsMeta
// ---------------------------------------------------------------------------
test("services.getLogsMeta delegates to getServiceLogsMeta", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const logsMeta = { ok: true, logs: [{ name: "main.log", size: 1024 }] };

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    getServiceLogsMeta: async (app, id) => logsMeta
  }));

  const result = await handlers["services.getLogsMeta"]({}, "svc-1");
  assert.deepEqual(result, logsMeta);
});

// ---------------------------------------------------------------------------
// 9. services.openLogViewer — validates serviceId
// ---------------------------------------------------------------------------
test("services.openLogViewer throws when serviceId is missing", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerServicesIpcHandlers(ipc, makeBaseOptions());

  await assert.rejects(
    () => handlers["services.openLogViewer"]({}, { serviceId: "", target: "main", title: "Logs" }),
    (err) => err instanceof Error && err.message.includes("缺少日志服务标识")
  );
});

test("services.openLogViewer delegates to openLogViewerWindow", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let openedRequest = null;

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    openLogViewerWindow: async (req) => {
      openedRequest = req;
      return { ok: true };
    }
  }));

  await handlers["services.openLogViewer"]({}, {
    serviceId: "agent-platform",
    target: "error",
    title: "Agent Logs"
  });

  assert.deepEqual(openedRequest, { serviceId: "agent-platform", target: "error", title: "Agent Logs" });
});

// ---------------------------------------------------------------------------
// 10. services.closeLogViewer / minimize / maximize
// ---------------------------------------------------------------------------
test("services.closeLogViewer / minimizeLogViewer / maximizeLogViewer delegate correctly", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let closed = false;
  let minimized = false;
  let maximized = false;

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    closeLogViewerWindow: () => { closed = true; },
    minimizeLogViewerWindow: () => { minimized = true; },
    maximizeLogViewerWindow: () => { maximized = true; }
  }));

  await handlers["services.closeLogViewer"]({});
  await handlers["services.minimizeLogViewer"]({});
  await handlers["services.maximizeLogViewer"]({});

  assert.equal(closed, true);
  assert.equal(minimized, true);
  assert.equal(maximized, true);
});

// ---------------------------------------------------------------------------
// 11. services.revealPath
// ---------------------------------------------------------------------------
test("services.revealPath delegates to revealPathInFileManager", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let revealedPath = null;

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    revealPathInFileManager: async (targetPath) => {
      revealedPath = targetPath;
      return { ok: true, path: targetPath };
    }
  }));

  const result = await handlers["services.revealPath"]({}, "/some/path");
  assert.equal(revealedPath, "/some/path");
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// 12. plugins.getServiceWebviewPreloadPath / Url
// ---------------------------------------------------------------------------
test("plugins.getServiceWebviewPreloadPath returns preload path", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    getServiceWebviewPreloadPath: () => "/custom/preload.js",
    getServiceWebviewPreloadUrl: () => "file:///custom/preload.js"
  }));

  assert.equal(await handlers["plugins.getServiceWebviewPreloadPath"]({}), "/custom/preload.js");
  assert.equal(await handlers["plugins.getServiceWebviewPreloadUrl"]({}), "file:///custom/preload.js");
});

// ---------------------------------------------------------------------------
// 13. services.watchLog.start / stop
// ---------------------------------------------------------------------------
test("services.watchLog.start registers subscription and cleans up on destroy", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const subscriptions = new Map();
  let cleanupCalled = false;
  let destroyListener = null;

  const mockSender = {
    id: 42,
    isDestroyed: () => false,
    send: () => {},
    once: (event, cb) => { destroyListener = cb; }
  };

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    logStreamSubscriptions: subscriptions,
    watchServiceLog: (app, subId, svcId, target, options, onData) => {
      return () => { cleanupCalled = true; };
    }
  }));

  const result = await handlers["services.watchLog.start"](
    { sender: mockSender },
    "sub-1",
    "svc-1",
    "main",
    {}
  );

  assert.deepEqual(result, { ok: true });
  assert.ok(subscriptions.has("sub-1"), "Should register subscription");

  // Simulate sender destruction
  destroyListener?.();
  assert.equal(cleanupCalled, true);
  assert.equal(subscriptions.has("sub-1"), false);
});

test("services.watchLog.stop removes subscription by id", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const subscriptions = new Map();
  let cleanupCalled = false;

  subscriptions.set("sub-99", {
    webContentsId: 7,
    cleanup: () => { cleanupCalled = true; }
  });

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    logStreamSubscriptions: subscriptions
  }));

  const result = await handlers["services.watchLog.stop"](
    { sender: { id: 7 } },
    "sub-99"
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(cleanupCalled, true);
  assert.equal(subscriptions.has("sub-99"), false);
});

test("services.watchLog.stop ignores subscription owned by different sender", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const subscriptions = new Map();
  let cleanupCalled = false;

  subscriptions.set("sub-99", {
    webContentsId: 7,
    cleanup: () => { cleanupCalled = true; }
  });

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    logStreamSubscriptions: subscriptions
  }));

  // Different sender id (99 vs 7)
  await handlers["services.watchLog.stop"]({ sender: { id: 99 } }, "sub-99");
  assert.equal(cleanupCalled, false);
  assert.equal(subscriptions.has("sub-99"), true);
});

// ---------------------------------------------------------------------------
// 14. services.installBuiltinFromBundle — running service guard
// ---------------------------------------------------------------------------
test("services.installBuiltinFromBundle returns ok:false when service is running", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    runServiceMutation: async (task) => task(),
    getServiceState: async () => ({ kind: "builtin", status: "running" })
  }));

  const result = await handlers["services.installBuiltinFromBundle"]({}, "agent-platform");
  assert.equal(result.ok, false);
  assert.ok(result.message.includes("运行中"));
});

test("services.installBuiltinFromBundle installs when service is stopped", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let installed = false;
  let cacheCleared = false;

  registerServicesIpcHandlers(ipc, makeBaseOptions({
    runServiceMutation: async (task) => task(),
    getServiceState: async () => ({ kind: "builtin", status: "stopped" }),
    installBuiltinService: async () => { installed = true; },
    clearSessionCache: async () => { cacheCleared = true; }
  }));

  const result = await handlers["services.installBuiltinFromBundle"]({}, "agent-platform");
  assert.equal(installed, true);
  assert.equal(cacheCleared, true);
  assert.equal(result.ok, true);
});
