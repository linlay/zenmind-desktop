import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  applyDesktopDefaultBootstrap,
  applyDesktopDefaultSsoDefaults,
  resolveDesktopBootstrapStatePath,
  resolveDesktopDefaultPath
} = require("../dist-electron/main/desktop-default-bootstrap.js");

const { registerServicesIpcHandlers } = require("../dist-electron/main/ipc/services-handlers.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "app-data");
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

function writeDesktopDefault(app, platform, value) {
  const defaultPath = resolveDesktopDefaultPath(app, platform);
  fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
  fs.writeFileSync(defaultPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return defaultPath;
}

function canonicalSsoPath(homePath) {
  return path.join(homePath, ".zenmind", ".desktop", "config", "desktop", "sso.json");
}

function runtimeRoot(homePath) {
  return path.join(homePath, ".zenmind");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("desktop-default SSO helper writes canonical macOS config without bootstrap state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-default-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopDefault(app, "darwin", {
    sso: {
      enabled: true,
      provider: "google",
      authMode: "server",
      serverAuthorizeUrl: "https://www.zenmind.cc/api/auth/google/desktop/start",
      webSessionExchange: {
        url: "https://www.zenmind.cc/api/auth/desktop-sso/session"
      }
    }
  });

  const result = applyDesktopDefaultSsoDefaults(app, "darwin");
  const ssoPath = canonicalSsoPath(homePath);

  assert.equal(result, "applied");
  assert.equal(readJson(ssoPath).authMode, "server");
  assert.equal(fs.statSync(ssoPath).mode & 0o777, 0o600);
});

test("desktop-default SSO helper uses explicit Windows path branches", () => {
  const app = createApp("C:\\Users\\tester");

  assert.equal(
    resolveDesktopDefaultPath(app, "win32"),
    "C:\\Users\\tester\\.zenmind\\desktop-default.json"
  );
});

test("desktop-default SSO helper does not overwrite existing SSO configs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-default-sso-existing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases = [
    {
      name: "canonical",
      existingPath: (homePath) => canonicalSsoPath(homePath),
      expectCanonicalCreated: true
    },
    {
      name: "legacy",
      existingPath: (homePath) => path.join(runtimeRoot(homePath), "desktop-sso.json"),
      expectCanonicalCreated: false
    },
    {
      name: "root",
      existingPath: (homePath) => path.join(runtimeRoot(homePath), "sso.json"),
      expectCanonicalCreated: false
    }
  ];

  for (const item of cases) {
    const homePath = path.join(root, item.name);
    const app = createApp(homePath);
    writeDesktopDefault(app, "darwin", {
      sso: {
        enabled: true,
        provider: "google",
        authMode: "server"
      }
    });
    const existingPath = item.existingPath(homePath);
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, `${JSON.stringify({ enabled: true, marker: item.name })}\n`, "utf8");

    const result = applyDesktopDefaultSsoDefaults(app, "darwin");

    assert.equal(result, "skipped", item.name);
    assert.equal(readJson(existingPath).marker, item.name);
    assert.equal(fs.existsSync(canonicalSsoPath(homePath)), item.expectCanonicalCreated);
  }
});

test("desktop-default SSO helper fills missing SSO even after bootstrap was marked applied", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-default-sso-after-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopDefault(app, "darwin", {
    profile: {
      appearance: {
        theme: "dark",
        locale: "en-US"
      }
    },
    sso: {
      enabled: true,
      provider: "google",
      authMode: "server"
    }
  });
  const bootstrapPath = resolveDesktopBootstrapStatePath(app);
  fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
  fs.writeFileSync(bootstrapPath, `${JSON.stringify({ schemaVersion: 1 })}\n`, "utf8");

  const fullBootstrap = applyDesktopDefaultBootstrap(app, "darwin");
  const ssoResult = applyDesktopDefaultSsoDefaults(app, "darwin");

  assert.equal(fullBootstrap.applied, false);
  assert.equal(fullBootstrap.reason, "already-applied");
  assert.equal(ssoResult, "applied");
  assert.equal(readJson(canonicalSsoPath(homePath)).provider, "google");
});

test("manual env.zip import applies desktop-default SSO before startup preparation", async () => {
  const handlers = new Map();
  const calls = [];
  const app = createApp("/tmp/zenmind-services-home");

  registerServicesIpcHandlers({
    handle(name, handler) {
      handlers.set(name, handler);
    }
  }, {
    app,
    shell: {
      showItemInFolder: () => undefined,
      openPath: async () => ""
    },
    platform: "darwin",
    listServices: async () => [],
    getServiceState: async () => ({}),
    installBuiltinService: async () => ({}),
    initializeService: async () => ({}),
    startService: async () => ({}),
    stopService: async () => ({}),
    restartService: async () => ({}),
    readServiceConfig: async () => ({}),
    writeServiceConfig: async () => ({}),
    importServiceFile: async () => ({}),
    getServiceLogsMeta: async () => ({}),
    watchServiceLog: () => () => undefined,
    readServiceLog: async () => ({}),
    runServiceMutation: async (task) => task(),
    handleServiceStart: async () => ({}),
    showFileDialog: async () => ({ canceled: false, filePaths: ["/tmp/env.zip"] }),
    showArchiveDialog: async () => ({}),
    openLogViewerWindow: async () => ({}),
    closeLogViewerWindow: () => undefined,
    minimizeLogViewerWindow: () => undefined,
    maximizeLogViewerWindow: () => undefined,
    openAgentPlatformMonitorWindow: async () => ({}),
    revealPathInFileManager: async () => ({}),
    getServiceWebviewPreloadPath: () => "",
    getServiceWebviewPreloadUrl: () => "",
    logStreamSubscriptions: new Map(),
    importEnvZipToRuntime: async (_app, zipPath, platform) => {
      calls.push(["import", zipPath, platform]);
      return { copiedFiles: 1, skippedFiles: 0 };
    },
    applyDesktopDefaultSsoDefaults: (_app, platform) => {
      calls.push(["sso", platform]);
      return "applied";
    },
    loadBuiltinServices: () => calls.push(["loadBuiltin"]),
    loadInstalledPlugins: () => calls.push(["loadPlugins"]),
    notifyServicesChanged: () => undefined,
    runStartupPreparation: async () => {
      calls.push(["startup"]);
      return { mode: "bootstrap", failures: [] };
    },
    startupRestoreController: {
      getState: () => ({}),
      beginSession: () => undefined,
      updateService: () => undefined,
      finishSession: () => undefined,
      failCurrentSession: () => undefined,
      setEnvImportRequired: () => undefined
    }
  });

  const result = await handlers.get("services.importEnvZip")();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.slice(0, 4), [
    ["import", "/tmp/env.zip", "darwin"],
    ["sso", "darwin"],
    ["loadBuiltin"],
    ["loadPlugins"]
  ]);
});
