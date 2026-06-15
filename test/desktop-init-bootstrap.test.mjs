import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  applyDesktopInitBootstrap,
  applyDesktopInitSsoDefaults,
  resolveDesktopBootstrapStatePath,
  resolveDesktopInitPath
} = require("../dist-electron/main/desktop-init-bootstrap.js");

const { registerServicesIpcHandlers } = require("../dist-electron/main/ipc/services-handlers.js");
const { getArchiveExtensions } = require("../dist-electron/main/platform-adapter.js");

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

function writeDesktopInit(app, platform, value) {
  const initPath = resolveDesktopInitPath(app, platform);
  fs.mkdirSync(path.dirname(initPath), { recursive: true });
  fs.writeFileSync(initPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return initPath;
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

test("archive import filters follow internal service package platform formats", () => {
  assert.deepEqual(getArchiveExtensions("darwin"), ["gz", "tgz"]);
  assert.deepEqual(getArchiveExtensions("linux"), ["gz", "tgz"]);
  assert.deepEqual(getArchiveExtensions("win32"), ["zip"]);
});

test("desktop-init bootstrap applies once into canonical desktop files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const initPath = writeDesktopInit(app, "darwin", {
    profile: {
      appearance: {
        theme: "dark",
        locale: "en-US"
      },
      navigation: {
        mainOrder: [],
        websiteOrder: []
      }
    },
    assistant: {
      defaultAgentKey: "desktopAssistant",
      bootstrapAgentKey: "zenmi"
    },
    kanban: {
      enabled: false,
      serverUrl: "https://kanban.example.test"
    },
    pet: {
      enabled: false,
      selectedPetId: "builtin:zenmi"
    },
    market: {
      enabled: true,
      apiBaseUrl: "https://market.example.test/api/v1"
    },
    sso: {
      enabled: true,
      identityProviderHost: "business.example.com"
    },
    webs: [
      {
        id: "docs",
        label: "Docs",
        url: "https://docs.example.com/",
        agentKey: "desktopAssistant"
      }
    ],
  });

  const first = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(first.applied, true);

  const desktopRoot = path.join(homePath, ".zenmind", ".desktop");
  const profile = readJson(path.join(desktopRoot, "config", "desktop", "profile.json"));
  const kanban = readJson(path.join(desktopRoot, "config", "desktop", "kanban.json"));
  const pet = readJson(path.join(desktopRoot, "config", "desktop", "pet.json"));
  const market = readJson(path.join(desktopRoot, "config", "desktop", "market.json"));
  const sso = readJson(path.join(desktopRoot, "config", "desktop", "sso.json"));
  const website = readJson(path.join(desktopRoot, "data", "webs", "websites", "docs", "website.json"));
  const bootstrap = readJson(resolveDesktopBootstrapStatePath(app));

  assert.equal(profile.appearance.theme, "dark");
  assert.equal(profile.appearance.locale, "en-US");
  assert.equal(profile.assistant.desktopHelperAgentKey, "desktopAssistant");
  assert.equal(profile.assistant.quickAssistant.enabled, true);
  assert.equal(profile.assistant.quickAssistant.agentKey, "desktopAssistant");
  assert.equal("kanban" in profile.navigation, false);
  assert.equal(kanban.enabled, false);
  assert.deepEqual(kanban.cloud, {
    serverUrl: "https://kanban.example.test",
    token: "",
    selectedProjectId: "default",
    remoteControlEnabled: false,
    deviceAlias: ""
  });
  assert.equal("bootstrapAssistant" in profile, false);
  assert.equal(pet.enabled, false);
  assert.equal(pet.selectedPetId, "builtin:zenmi");
  assert.equal("boundAgentKey" in pet, false);
  assert.equal(market.enabled, true);
  assert.equal(market.apiBaseUrl, "https://market.example.test/api/v1");
  assert.equal(fs.existsSync(path.join(desktopRoot, "config", "marketplace", "settings.json")), false);
  assert.equal(sso.enabled, true);
  assert.equal(website.id, "docs");
  assert.equal(website.kind, "website");
  assert.equal(website.agentKey, "desktopAssistant");
  assert.equal(bootstrap.applied.assistant, "recorded");
  assert.equal(bootstrap.assistant.defaultAgentKey, "desktopAssistant");
  assert.equal(bootstrap.assistant.bootstrapAgentKey, "zenmi");
  assert.equal("bootstrapAssistant" in bootstrap, false);
  assert.equal(fs.existsSync(initPath), false);

  fs.writeFileSync(initPath, JSON.stringify({
    profile: {
      appearance: {
        theme: "light",
        locale: "zh-CN"
      }
    }
  }), "utf8");

  const second = applyDesktopInitBootstrap(app, "darwin");
  const profileAfterSecondRun = readJson(path.join(desktopRoot, "config", "desktop", "profile.json"));
  assert.equal(second.applied, false);
  assert.equal(second.reason, "already-applied");
  assert.equal(profileAfterSecondRun.appearance.theme, "dark");
  assert.equal(profileAfterSecondRun.appearance.locale, "en-US");
  assert.equal("kanban" in profileAfterSecondRun.navigation, false);
});

test("desktop-init bootstrap ignores legacy desktop-default file names", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-old-name-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const legacyPath = path.join(runtimeRoot(homePath), "desktop-default.json");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, `${JSON.stringify({
    profile: {
      appearance: {
        theme: "dark",
        locale: "en-US"
      }
    }
  }, null, 2)}\n`, "utf8");

  const result = applyDesktopInitBootstrap(app, "darwin");
  const profilePath = path.join(homePath, ".zenmind", ".desktop", "config", "desktop", "profile.json");

  assert.equal(result.applied, false);
  assert.equal(result.reason, "missing");
  assert.equal(fs.existsSync(profilePath), false);
  assert.equal(fs.existsSync(legacyPath), true);
});

test("desktop-init bootstrap migrates legacy navigation kanban fallback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-kanban-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    profile: {
      appearance: {
        theme: "system",
        locale: "zh-CN"
      },
      navigation: {
        kanban: {
          enabled: false
        }
      }
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(result.applied, true);

  const desktopConfigRoot = path.join(homePath, ".zenmind", ".desktop", "config", "desktop");
  const profile = readJson(path.join(desktopConfigRoot, "profile.json"));
  const kanban = readJson(path.join(desktopConfigRoot, "kanban.json"));
  assert.equal("kanban" in profile.navigation, false);
  assert.equal(kanban.enabled, false);
  assert.equal(result.appliedResult.kanban, "applied");
});

test("desktop-init bootstrap skips market settings without a market API", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-market-disabled-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    market: {
      enabled: false
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(result.applied, true);

  const marketPath = path.join(homePath, ".zenmind", ".desktop", "config", "desktop", "market.json");
  const legacyMarketPath = path.join(homePath, ".zenmind", ".desktop", "config", "marketplace", "settings.json");
  assert.equal(result.appliedResult.market, "absent");
  assert.equal(fs.existsSync(marketPath), false);
  assert.equal(fs.existsSync(legacyMarketPath), false);
});

test("desktop-init bootstrap does not overwrite existing desktop market settings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-market-existing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const marketPath = path.join(homePath, ".zenmind", ".desktop", "config", "desktop", "market.json");
  fs.mkdirSync(path.dirname(marketPath), { recursive: true });
  fs.writeFileSync(marketPath, `${JSON.stringify({
    enabled: false,
    apiBaseUrl: "https://existing.example.test/api/v1"
  }, null, 2)}\n`, "utf8");
  writeDesktopInit(app, "darwin", {
    market: {
      enabled: true,
      apiBaseUrl: "https://market.example.test/api/v1"
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const market = readJson(marketPath);

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.market, "skipped");
  assert.equal(market.enabled, false);
  assert.equal(market.apiBaseUrl, "https://existing.example.test/api/v1");
});

test("desktop-init SSO helper writes canonical macOS config without bootstrap state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
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

  const result = applyDesktopInitSsoDefaults(app, "darwin");
  const ssoPath = canonicalSsoPath(homePath);

  assert.equal(result, "applied");
  assert.equal(readJson(ssoPath).authMode, "server");
  assert.equal(fs.statSync(ssoPath).mode & 0o777, 0o600);
});

test("desktop-init SSO helper uses explicit Windows path branches", () => {
  const app = createApp("C:\\Users\\tester");

  assert.equal(
    resolveDesktopInitPath(app, "win32"),
    "C:\\Users\\tester\\.zenmind\\desktop-init.json"
  );
});

test("desktop-init SSO helper does not overwrite existing SSO configs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-sso-existing-"));
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
    writeDesktopInit(app, "darwin", {
      sso: {
        enabled: true,
        provider: "google",
        authMode: "server"
      }
    });
    const existingPath = item.existingPath(homePath);
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, `${JSON.stringify({ enabled: true, marker: item.name })}\n`, "utf8");

    const result = applyDesktopInitSsoDefaults(app, "darwin");

    assert.equal(result, "skipped", item.name);
    assert.equal(readJson(existingPath).marker, item.name);
    assert.equal(fs.existsSync(canonicalSsoPath(homePath)), item.expectCanonicalCreated);
  }
});

test("desktop-init SSO helper fills missing SSO even after bootstrap was marked applied", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-sso-after-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    profile: {
      appearance: {
        theme: "dark",
        locale: "en-US"
      }
    },
    market: {
      apiBaseUrl: "https://market.example.test/api/v1"
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

  const fullBootstrap = applyDesktopInitBootstrap(app, "darwin");
  const ssoResult = applyDesktopInitSsoDefaults(app, "darwin");

  assert.equal(fullBootstrap.applied, false);
  assert.equal(fullBootstrap.reason, "already-applied");
  assert.equal(ssoResult, "applied");
  assert.equal(readJson(canonicalSsoPath(homePath)).provider, "google");
  assert.equal(fs.existsSync(resolveDesktopInitPath(app, "darwin")), false);
});

test("manual env.zip import applies desktop-init bootstrap and SSO before startup preparation", async () => {
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
    applyDesktopInitBootstrap: (_app, platform) => {
      calls.push(["bootstrap", platform]);
      return { ok: true, applied: true };
    },
    applyDesktopInitSsoDefaults: (_app, platform) => {
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
  assert.deepEqual(calls.slice(0, 5), [
    ["import", "/tmp/env.zip", "darwin"],
    ["bootstrap", "darwin"],
    ["sso", "darwin"],
    ["loadBuiltin"],
    ["loadPlugins"]
  ]);
});
