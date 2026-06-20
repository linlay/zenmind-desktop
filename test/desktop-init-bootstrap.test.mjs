import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  applyDesktopInitBootstrap,
  resolveDesktopInitPath
} = require("../dist-electron/main/desktop-init-bootstrap.js");

const { registerServicesIpcHandlers } = require("../dist-electron/main/ipc/services-handlers.js");
const { getArchiveExtensions } = require("../dist-electron/main/platform-adapter.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const { DEFAULT_DESKTOP_PET_SELECTED_ID } = require("../dist-electron/shared/desktop-pet.js");

const RUNTIME_ROOT_DIR_NAME = APP_BRAND.paths.runtimeRootDirName;

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
  return path.join(desktopRoot(homePath), "config", "desktop", "sso.json");
}

function runtimeRoot(homePath) {
  return path.join(homePath, RUNTIME_ROOT_DIR_NAME);
}

function desktopRoot(homePath) {
  return path.join(runtimeRoot(homePath), ".desktop");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").trim();
}

test("archive import filters follow internal service package platform formats", () => {
  assert.deepEqual(getArchiveExtensions("darwin"), ["gz", "tgz"]);
  assert.deepEqual(getArchiveExtensions("linux"), ["gz", "tgz"]);
  assert.deepEqual(getArchiveExtensions("win32"), ["zip"]);
});

test("desktop-init bootstrap applies into canonical desktop files and rereads explicit init", (t) => {
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
      selectedPetId: DEFAULT_DESKTOP_PET_SELECTED_ID
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

  const desktop = desktopRoot(homePath);
  const profile = readJson(path.join(desktop, "config", "desktop", "profile.json"));
  const assistantConfig = readJson(path.join(desktop, "config", "desktop", "assistant.json"));
  const kanban = readJson(path.join(desktop, "config", "desktop", "kanban.json"));
  const pet = readJson(path.join(desktop, "config", "desktop", "pet.json"));
  const market = readJson(path.join(desktop, "config", "desktop", "market.json"));
  const sso = readJson(path.join(desktop, "config", "desktop", "sso.json"));
  const website = readJson(path.join(desktop, "data", "webs", "websites", "docs", "website.json"));
  const bootstrapState = readJson(path.join(desktop, "state", "desktop", "bootstrap.json"));

  assert.equal(profile.appearance.theme, "dark");
  assert.equal(profile.appearance.locale, "en-US");
  assert.equal(profile.assistant.copilot.agentKey, "desktopAssistant");
  assert.equal(profile.assistant.quick.enabled, true);
  assert.equal(profile.assistant.quick.agentKey, "desktopAssistant");
  assert.equal(assistantConfig.defaultAgentKey, "desktopAssistant");
  assert.equal(assistantConfig.bootstrapAgentKey, "zenmi");
  assert.equal("desktopHelperAgentKey" in profile.assistant, false);
  assert.equal("quickAssistant" in profile.assistant, false);
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
  assert.equal(pet.selectedPetId, DEFAULT_DESKTOP_PET_SELECTED_ID);
  assert.equal("lastVisible" in pet, false);
  assert.equal("boundAgentKey" in pet, false);
  assert.equal(market.enabled, true);
  assert.equal(market.apiBaseUrl, "https://market.example.test/api/v1");
  assert.equal(fs.existsSync(path.join(desktop, "config", "marketplace", "settings.json")), false);
  assert.equal(sso.enabled, true);
  assert.equal(website.id, "docs");
  assert.equal(website.kind, "website");
  assert.equal(website.agentKey, "desktopAssistant");
  assert.equal(bootstrapState.schemaVersion, 1);
  assert.equal(bootstrapState.sourcePath, initPath);
  assert.equal(bootstrapState.consumed, true);
  assert.equal(bootstrapState.appliedResult.profile, "applied");
  assert.equal(bootstrapState.appliedResult.kanban, "applied");
  assert.equal(bootstrapState.appliedResult.pet, "applied");
  assert.equal(bootstrapState.appliedResult.market, "applied");
  assert.equal(bootstrapState.appliedResult.sso, "applied");
  assert.equal(bootstrapState.appliedResult.tunnelHub, "absent");
  assert.equal(bootstrapState.appliedResult.webs, "applied");
  assert.equal(bootstrapState.appliedResult.assistant, "recorded");
  assert.match(bootstrapState.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
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
  const profileAfterSecondRun = readJson(path.join(desktop, "config", "desktop", "profile.json"));
  assert.equal(second.applied, true);
  assert.equal(second.appliedResult.profile, "applied");
  assert.equal(profileAfterSecondRun.appearance.theme, "light");
  assert.equal(profileAfterSecondRun.appearance.locale, "zh-CN");
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
  const profilePath = path.join(desktopRoot(homePath), "config", "desktop", "profile.json");

  assert.equal(result.applied, false);
  assert.equal(result.reason, "missing");
  assert.equal(fs.existsSync(profilePath), false);
  assert.equal(fs.existsSync(legacyPath), true);
});

test("desktop-init bootstrap does not block startup on invalid JSON", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = originalWarn;
  });

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const initPath = resolveDesktopInitPath(app, "darwin");
  fs.mkdirSync(path.dirname(initPath), { recursive: true });
  fs.writeFileSync(initPath, "{", "utf8");

  const result = applyDesktopInitBootstrap(app, "darwin");

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.reason, "invalid");
  assert.equal(warnings.length, 1);
  assert.equal(fs.existsSync(initPath), true);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "state", "desktop", "bootstrap.json")), false);
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

  const desktopConfigRoot = path.join(desktopRoot(homePath), "config", "desktop");
  const profile = readJson(path.join(desktopConfigRoot, "profile.json"));
  const kanban = readJson(path.join(desktopConfigRoot, "kanban.json"));
  assert.equal("kanban" in profile.navigation, false);
  assert.equal(kanban.enabled, false);
  assert.equal(result.appliedResult.kanban, "applied");
});

test("desktop-init bootstrap leaves market absent without a market API", (t) => {
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

  const marketPath = path.join(desktopRoot(homePath), "config", "desktop", "market.json");
  const legacyMarketPath = path.join(desktopRoot(homePath), "config", "marketplace", "settings.json");
  assert.equal(result.appliedResult.market, "absent");
  assert.equal(fs.existsSync(marketPath), false);
  assert.equal(fs.existsSync(legacyMarketPath), false);
});

test("desktop-init bootstrap applies Tunnel Hub defaults without auto enabling", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-tunnel-hub-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    tunnelHub: {
      relayUrl: "wss://relay.example.test/tunnel",
      deviceId: "mac-mini-office",
      relayToken: "init-relay-token",
      registrationToken: "init-registration-token",
      tlsInsecureSkipVerify: false
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const desktop = desktopRoot(homePath);
  const tunnelSettingsPath = path.join(desktop, "config", "desktop", "tunnel-hub.json");
  const tokenPath = path.join(desktop, "secrets", "tunnel-hub-token");
  const registrationTokenPath = path.join(desktop, "secrets", "tunnel-hub-registration-token");
  const tunnelSettings = readJson(tunnelSettingsPath);
  const bootstrapState = readJson(path.join(desktop, "state", "desktop", "bootstrap.json"));

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.tunnelHub, "applied");
  assert.deepEqual(tunnelSettings, {
    enabled: false,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    publicHost: "",
    publicUrl: "",
    webSocketUrl: "",
    targetUrl: "",
    lastRegisteredAt: "",
    rotateRelayToken: false,
    tlsInsecureSkipVerify: false,
    reconnectSeconds: 3
  });
  assert.equal("relayToken" in tunnelSettings, false);
  assert.equal("registrationToken" in tunnelSettings, false);
  assert.equal("deviceSecret" in tunnelSettings, false);
  assert.equal(readText(tokenPath), "init-relay-token");
  assert.equal(readText(registrationTokenPath), "init-registration-token");
  assert.equal(bootstrapState.appliedResult.tunnelHub, "applied");
});

test("desktop-init bootstrap applies defaults over pre-created desktop config files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-market-existing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const desktopConfigRoot = path.join(desktopRoot(homePath), "config", "desktop");
  const profilePath = path.join(desktopConfigRoot, "profile.json");
  const kanbanPath = path.join(desktopConfigRoot, "kanban.json");
  const petPath = path.join(desktopConfigRoot, "pet.json");
  const marketPath = path.join(desktopConfigRoot, "market.json");
  fs.mkdirSync(desktopConfigRoot, { recursive: true });
  fs.writeFileSync(profilePath, `${JSON.stringify({
    schemaVersion: 1,
    appearance: {
      theme: "light",
      locale: "en-US"
    },
    assistant: {
      copilot: {
        agentKey: "desktopAssistant"
      },
      quick: {
        enabled: true,
        agentKey: "desktopAssistant"
      }
    },
    navigation: {
      mainOrder: ["schedules"],
      webOrder: ["old-site"],
      desktopCopilotPages: {}
    }
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(kanbanPath, `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    cloud: {
      serverUrl: "https://existing-kanban.example.test",
      token: "",
      selectedProjectId: "default",
      remoteControlEnabled: true,
      deviceAlias: ""
    }
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(petPath, `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    selectedPetId: "builtin:old"
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(marketPath, `${JSON.stringify({
    enabled: false,
    apiBaseUrl: "https://existing.example.test/api/v1"
  }, null, 2)}\n`, "utf8");
  writeDesktopInit(app, "darwin", {
    profile: {
      appearance: {
        theme: "system",
        locale: "zh-CN"
      },
      navigation: {
        mainOrder: [],
        websiteOrder: [],
        desktopCopilotPages: {}
      }
    },
    assistant: {
      defaultAgentKey: "cutej",
      bootstrapAgentKey: "bootstrap"
    },
    kanban: {
      enabled: false,
      serverUrl: "https://kanban.example.test"
    },
    pet: {
      enabled: false,
      selectedPetId: DEFAULT_DESKTOP_PET_SELECTED_ID
    },
    market: {
      enabled: true,
      apiBaseUrl: "https://market.example.test/api/v1"
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const profile = readJson(profilePath);
  const assistantConfig = readJson(path.join(desktopConfigRoot, "assistant.json"));
  const kanban = readJson(kanbanPath);
  const pet = readJson(petPath);
  const market = readJson(marketPath);

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.profile, "applied");
  assert.equal(result.appliedResult.kanban, "applied");
  assert.equal(result.appliedResult.pet, "applied");
  assert.equal(result.appliedResult.market, "applied");
  assert.equal(profile.appearance.theme, "system");
  assert.equal(profile.appearance.locale, "zh-CN");
  assert.equal(profile.assistant.copilot.agentKey, "cutej");
  assert.equal(profile.assistant.quick.agentKey, "cutej");
  assert.deepEqual(profile.navigation.mainOrder, []);
  assert.deepEqual(profile.navigation.webOrder, []);
  assert.equal(profile.navigation.desktopCopilotPages.controlCenter.agentKey, "cutej");
  assert.equal(assistantConfig.defaultAgentKey, "cutej");
  assert.equal(assistantConfig.bootstrapAgentKey, "bootstrap");
  assert.equal(kanban.enabled, false);
  assert.equal(kanban.cloud.serverUrl, "https://kanban.example.test");
  assert.equal(pet.enabled, false);
  assert.equal(pet.selectedPetId, DEFAULT_DESKTOP_PET_SELECTED_ID);
  assert.equal(market.enabled, true);
  assert.equal(market.apiBaseUrl, "https://market.example.test/api/v1");
});

test("desktop-init bootstrap writes canonical macOS SSO config and state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    sso: {
      enabled: true,
      providerLabel: "ZenMind",
      browserMode: "system",
      issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
      authorizeUrl: "https://auth.zenmind.cc/o/authorize/",
      tokenUrl: "https://auth.zenmind.cc/application/o/token/",
      clientId: "zenmind-desktop",
      wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration",
      logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/",
      userInfo: {
        url: "https://auth.zenmind.cc/application/o/userinfo/"
      },
      siteTokenBridge: {
        startUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
        exchangeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/session"
      }
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const ssoPath = canonicalSsoPath(homePath);
  const bootstrapState = readJson(path.join(desktopRoot(homePath), "state", "desktop", "bootstrap.json"));

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.sso, "applied");
  const sso = readJson(ssoPath);
  assert.deepEqual(sso, {
    enabled: true,
    providerLabel: "ZenMind",
    browserMode: "system",
    issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
    authorizeUrl: "https://auth.zenmind.cc/o/authorize/",
    tokenUrl: "https://auth.zenmind.cc/application/o/token/",
    clientId: "zenmind-desktop",
    wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/",
    userInfo: {
      url: "https://auth.zenmind.cc/application/o/userinfo/"
    },
    siteTokenBridge: {
      startUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
      exchangeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/session"
    }
  });
  assert.equal(sso.userInfo.url, "https://auth.zenmind.cc/application/o/userinfo/");
  assert.equal(sso.siteTokenBridge.startUrl, "https://www.zenmind.cc/api/auth/desktop-sso/start");
  assert.equal(fs.statSync(ssoPath).mode & 0o777, 0o600);
  assert.equal(bootstrapState.appliedResult.sso, "applied");
});

test("desktop-init bootstrap uses explicit Windows path branches", () => {
  const app = createApp("C:\\Users\\tester");

  assert.equal(
    resolveDesktopInitPath(app, "win32"),
    path.win32.join("C:\\Users\\tester", RUNTIME_ROOT_DIR_NAME, "desktop-init.json")
  );
});

test("desktop-init bootstrap writes canonical SSO even when old configs exist", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-sso-existing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases = [
    {
      name: "canonical",
      existingPath: (homePath) => canonicalSsoPath(homePath)
    },
    {
      name: "legacy",
      existingPath: (homePath) => path.join(runtimeRoot(homePath), "desktop-sso.json")
    },
    {
      name: "root",
      existingPath: (homePath) => path.join(runtimeRoot(homePath), "sso.json")
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

    const result = applyDesktopInitBootstrap(app, "darwin");

    assert.equal(result.appliedResult.sso, "applied", item.name);
    assert.equal(readJson(canonicalSsoPath(homePath)).provider, "google");
    assert.equal(readJson(canonicalSsoPath(homePath)).authMode, "server");
    if (existingPath !== canonicalSsoPath(homePath)) {
      assert.equal(readJson(existingPath).marker, item.name);
    }
  }
});

test("desktop-init bootstrap reads profile market and SSO from one init", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-sso-profile-market-"));
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

  const fullBootstrap = applyDesktopInitBootstrap(app, "darwin");

  assert.equal(fullBootstrap.applied, true);
  assert.equal(fullBootstrap.appliedResult.profile, "applied");
  assert.equal(fullBootstrap.appliedResult.market, "applied");
  assert.equal(fullBootstrap.appliedResult.sso, "applied");
  assert.equal(readJson(path.join(homePath, RUNTIME_ROOT_DIR_NAME, ".desktop", "config", "desktop", "profile.json")).appearance.locale, "en-US");
  assert.equal(readJson(canonicalSsoPath(homePath)).provider, "google");
  assert.equal(fs.existsSync(resolveDesktopInitPath(app, "darwin")), false);
});

test("manual env.zip import applies desktop-init bootstrap and refreshes config before startup preparation", async () => {
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
    refreshDesktopRuntimeConfigFromCanonicalFiles: (reason) => {
      calls.push(["refreshConfig", reason]);
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
    ["refreshConfig", "manual-env-import"],
    ["loadBuiltin"],
    ["loadPlugins"]
  ]);
});
