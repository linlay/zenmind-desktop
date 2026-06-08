import test from "node:test";
import assert from "node:assert/strict";

const { registerMarketplaceIpcHandlers } = await import("../dist-electron/main/ipc/marketplace-handlers.js");

function makeMockIpcMain() {
  const handlers = {};
  return {
    ipc: {
      handle(channel, callback) {
        handlers[channel] = callback;
      }
    },
    handlers
  };
}

function makeBaseOptions(overrides = {}) {
  return {
    app: {
      name: "test-app",
      getPath(name) {
        return name === "desktop" ? "C:/Users/me/Desktop" : "C:/Users/me";
      }
    },
    platform: "win32",
    mainWindow: { id: 1 },
    t: (key) => key,
    runServiceMutation: async (task) => task(),
    showArchiveDialog: async () => ({ canceled: true, filePaths: [] }),
    showFileDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: "" }),
    clearSessionCache: async () => {},
    installPluginFromArchive: async () => ({ ok: true }),
    handlePluginUninstall: async () => ({ ok: true }),
    getMarketSettings: () => ({ catalogUrl: "https://catalog.example.test" }),
    saveMarketSettings: (_app, input) => ({ ok: true, settings: input }),
    listMarketItems: () => ({ ok: true, items: [] }),
    refreshMarketCatalog: async () => ({ ok: true, items: [] }),
    installMarketItem: async () => ({ ok: true }),
    updateMarketItem: async () => ({ ok: true }),
    uninstallMarketItem: async () => ({ ok: true }),
    buildSandboxImage: async () => ({ ok: true }),
    deleteSandboxImage: async () => ({ ok: true }),
    exportSandboxImageToPath: async () => ({ ok: true }),
    importSandboxImageFromPath: async () => ({ ok: true }),
    importSkillFromPath: async () => ({ ok: true }),
    importSkillFromCommand: async () => ({ ok: true }),
    getPanAuthStatus: () => ({ configured: false, message: "missing" }),
    importPanPrivateKey: () => ({ configured: true, message: "imported" }),
    now: () => 123,
    random: () => 0.5,
    ...overrides
  };
}

test("plugins.install returns canceled result when no archive is selected", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let installCalled = false;

  registerMarketplaceIpcHandlers(ipc, makeBaseOptions({
    installPluginFromArchive: async () => {
      installCalled = true;
      return { ok: true };
    }
  }));

  const result = await handlers["plugins.install"]({});

  assert.equal(result.ok, false);
  assert.equal(installCalled, false);
});

test("plugins.install installs selected archive through mutation queue and clears cache on success", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];

  registerMarketplaceIpcHandlers(ipc, makeBaseOptions({
    runServiceMutation: async (task) => {
      calls.push("mutation");
      return task();
    },
    showArchiveDialog: async (title) => {
      calls.push(["dialog", title]);
      return { canceled: false, filePaths: ["C:/plugin.zip"] };
    },
    installPluginFromArchive: async (app, archivePath) => {
      calls.push(["install", app.name, archivePath]);
      return { ok: true, serviceId: "plugin-a" };
    },
    clearSessionCache: async () => {
      calls.push("cache");
    }
  }));

  const result = await handlers["plugins.install"]({});

  assert.deepEqual(result, { ok: true, serviceId: "plugin-a" });
  assert.deepEqual(calls, [
    "mutation",
    ["dialog", "选择插件包 (.zip)"],
    ["install", "test-app", "C:/plugin.zip"],
    "cache"
  ]);
});

test("market.list and market.refresh forward section options", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];

  registerMarketplaceIpcHandlers(ipc, makeBaseOptions({
    listMarketItems: async (app, options) => {
      calls.push(["list", app.name, options]);
      return { ok: true, items: [] };
    },
    refreshMarketCatalog: async (app, options) => {
      calls.push(["refresh", app.name, options]);
      return { ok: true, items: [] };
    }
  }));

  const listOptions = { sections: ["plugins"] };
  const refreshOptions = { sections: ["sandboxImages"] };
  await handlers["market.list"]({}, listOptions);
  await handlers["market.refresh"]({}, refreshOptions);

  assert.deepEqual(calls, [
    ["list", "test-app", listOptions],
    ["refresh", "test-app", refreshOptions]
  ]);
});

test("market.install clears session cache only after successful install", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];

  registerMarketplaceIpcHandlers(ipc, makeBaseOptions({
    installMarketItem: async (_app, itemId) => {
      calls.push(["install", itemId]);
      return { ok: true, itemId };
    },
    clearSessionCache: async () => {
      calls.push("cache");
    }
  }));

  const result = await handlers["market.install"]({}, "item-1");

  assert.deepEqual(result, { ok: true, itemId: "item-1" });
  assert.deepEqual(calls, [["install", "item-1"], "cache"]);
});

test("market.exportSandboxImage returns canceled result without exporting", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let exported = false;

  registerMarketplaceIpcHandlers(ipc, makeBaseOptions({
    showSaveDialog: async (options) => {
      assert.match(options.defaultPath, /agent_image\.tar$/);
      return { canceled: true, filePath: "" };
    },
    exportSandboxImageToPath: async () => {
      exported = true;
      return { ok: true };
    }
  }));

  const result = await handlers["market.exportSandboxImage"]({}, "agent/image");

  assert.equal(result.ok, false);
  assert.equal(result.itemId, "agent/image");
  assert.equal(result.type, "sandbox-image");
  assert.equal(exported, false);
});

test("market.importSandboxImage emits import progress with generated task id", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const sent = [];

  registerMarketplaceIpcHandlers(ipc, makeBaseOptions({
    showFileDialog: async () => ({ canceled: false, filePaths: ["C:/image.tar"] }),
    importSandboxImageFromPath: async (_app, archivePath, options) => {
      assert.equal(archivePath, "C:/image.tar");
      options.onProgress({ state: "running", message: "loading" });
      return { ok: true, taskId: options.taskId };
    }
  }));

  const result = await handlers["market.importSandboxImage"]({
    sender: {
      send(channel, payload) {
        sent.push([channel, payload]);
      }
    }
  });

  assert.equal(result.ok, true);
  assert.match(result.taskId, /^sandbox-import-123-/);
  assert.deepEqual(sent, [[
    "market.sandboxImageImportProgress",
    { taskId: result.taskId, state: "running", message: "loading" }
  ]]);
});

test("panAuth.importPrivateKey returns current status when dialog is canceled", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const status = { configured: false, message: "missing key" };

  registerMarketplaceIpcHandlers(ipc, makeBaseOptions({
    getPanAuthStatus: () => status
  }));

  const result = await handlers["panAuth.importPrivateKey"]({});

  assert.equal(result.ok, false);
  assert.equal(result.status, status);
});

test("panAuth.importPrivateKey imports selected key and returns updated status", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerMarketplaceIpcHandlers(ipc, makeBaseOptions({
    showFileDialog: async () => ({ canceled: false, filePaths: ["C:/app-private.pem"] }),
    importPanPrivateKey: (app, keyPath) => {
      assert.equal(app.name, "test-app");
      assert.equal(keyPath, "C:/app-private.pem");
      return { configured: true, message: "ready" };
    }
  }));

  const result = await handlers["panAuth.importPrivateKey"]({});

  assert.deepEqual(result, {
    ok: true,
    message: "ready",
    status: { configured: true, message: "ready" }
  });
});
