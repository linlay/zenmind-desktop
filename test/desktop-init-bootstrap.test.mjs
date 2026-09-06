import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  applyDesktopInitBootstrap,
  applyDesktopInitVersionUpgrade,
  resolveDesktopInitPath
} = require("../dist-electron/main/app/bootstrap/desktop-init.js");
const {
  getAssistantSettingsFromRoot
} = require("../dist-electron/main/modules/assistant/settings-store.js");

const { registerServicesIpcHandlers } = require("../dist-electron/main/modules/services/ipc.js");
const { getArchiveExtensions } = require("../dist-electron/main/infrastructure/electron/platform-adapter.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const { DEFAULT_DESKTOP_PET_SELECTED_ID } = require("../dist-electron/shared/desktop-pet.js");

const RUNTIME_ROOT_DIR_NAME = APP_BRAND.paths.runtimeRootDirName;
const OPS_CONSOLE_WEBAPP_ID = "webapp-0000000000000001";
const OTHER_CONSOLE_WEBAPP_ID = "webapp-0000000000000002";
const OPS_WIN_WEBAPP_ID = "webapp-0000000000000003";
const LINKED_WEBAPP_ID = "webapp-0000000000000004";

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
  return path.join(desktopRoot(homePath, "darwin"), "config", "desktop", "sso.json");
}

function runtimeRoot(homePath) {
  return path.join(homePath, RUNTIME_ROOT_DIR_NAME);
}

function runtimeRootForPlatform(homePath, platform = "darwin") {
  return runtimeRoot(homePath);
}

function desktopRoot(homePath, platform = "darwin") {
  return path.join(runtimeRootForPlatform(homePath, platform), ".desktop");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").trim();
}

function writeBootstrapWebappSeed(app, platform, id, manifest = {}) {
  const initPath = resolveDesktopInitPath(app, platform);
  const webappDir = path.join(path.dirname(initPath), "desktop-init", "sites", id);
  fs.mkdirSync(path.join(webappDir, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(webappDir, "frontend", "index.html"), "<!doctype html><title>seed</title>", "utf8");
  fs.writeFileSync(path.join(webappDir, "webapp.json"), `${JSON.stringify({
    schemaVersion: 2,
    id,
    key: `seed-${id.slice("webapp-".length)}`,
    label: id,
    version: "1.0.0",
    target: "any",
    appConfig: {},
    frontend: {
      root: "frontend",
      index: "index.html",
      routeConfig: {
        backendPrefixes: [],
        navigationFallback: "index.html"
      }
    },
    desktopBridge: { version: 1 },
    ...manifest
  }, null, 2)}\n`, "utf8");
  return webappDir;
}

test("archive import filters follow internal service package platform formats", () => {
  assert.deepEqual(getArchiveExtensions("darwin"), ["gz", "tgz"]);
  assert.deepEqual(getArchiveExtensions("linux"), ["gz", "tgz"]);
  assert.deepEqual(getArchiveExtensions("win32"), ["zip"]);
});

test("assistant settings accept an omitted bootstrap chat id", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-assistant-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "assistant.json"), JSON.stringify({
    schemaVersion: 1,
    defaultChatAgentKey: "zenmi",
    bootstrapAgentKey: "bootstrap"
  }), "utf8");

  const settings = getAssistantSettingsFromRoot(root);
  assert.equal(settings.bootstrapAgentKey, "bootstrap");
  assert.equal(settings.bootstrapChatId, "");
});

test("assistant settings ignore the retired default agent alias", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-assistant-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "assistant.json"), JSON.stringify({
    schemaVersion: 1,
    defaultAgentKey: "legacy-chat-agent"
  }), "utf8");

  assert.equal(getAssistantSettingsFromRoot(root).chatDefaultAgentKey, "");
});

test("desktop-init bootstrap applies into canonical desktop files and rereads explicit init", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const initPath = writeDesktopInit(app, "darwin", {
    profile: {
      general: {
        desktopActionConfirmationEnabled: false
      },
      appearance: {
        theme: "dark",
        locale: "en-US"
      },
      navigation: {
        mainOrder: [],
        webOrder: []
      }
    },
    assistant: {
      defaultChatAgentKey: "zenmi",
      bootstrapAgentKey: "zenmi",
      bootstrapChatId: "00000000-0000-4000-8000-000000000001"
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
    webs: {
      items: [{
        kind: "website",
        id: "docs",
        label: "Docs",
        url: "https://docs.example.com/",
        copilotAgentKey: "desktopAssistant"
      }]
    },
    desktopActionBridge: {
      port: 17988
    },
    enterpriseIm: {
      enabled: true,
      baseUrl: "https://im.example.test/api/"
    },
    help: {
      url: "https://www.zenmind.cc/help/"
    },
    services: {
      "agent-container-hub": {
        defaultPort: 7909
      },
      "identity-center": {
        defaultPort: 7906
      },
      "agent-platform": {
        defaultPort: 7908,
        lifecycleArgs: {
          deploy: [
            "--ai-vision-general-model-key", "explicit-vision-general",
            "--ai-vision-ocr-model-key", "explicit-vision-ocr",
            "--ai-web-fetch-model-key", "explicit-web-fetch",
            "--coder-model-key", "explicit-coder-model",
            "--coder-reasoning-effort", "HIGH",
            "--platform-deploy"
          ],
          start: ["--platform-start", "alpha"],
          stop: ["--platform-stop"]
        },
        platforms: {
          darwin: {
            defaultPort: 7918,
            lifecycleArgs: {
              deploy: ["--platform-deploy-darwin"],
              start: ["--platform-start-darwin", ""],
              stop: [123, "--platform-stop-darwin"]
            }
          },
          win32: {
            lifecycleArgs: {
              start: ["-PlatformStartWindows"]
            }
          }
        }
      },
      "agent-webclient": {
        defaultPort: "7910",
        lifecycleArgs: {
          deploy: ["--webclient-deploy"],
          start: ["--base-url", "http://127.0.0.1:7908"],
          stop: ["--ignored-webclient-stop"]
        }
      },
      "unknown-service": {
        defaultPort: 7901,
        lifecycleArgs: {
          start: ["--ignored"]
        }
      },
      "agent-container-hub-invalid": {
        defaultPort: 0
      }
    }
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
  const desktopActionBridge = readJson(path.join(desktop, "config", "desktop", "desktop-action-bridge.json"));
  const enterpriseIm = readJson(path.join(desktop, "config", "desktop", "enterprise-im.json"));
  const help = readJson(path.join(desktop, "config", "desktop", "help.json"));
  const serviceLifecycleArgs = readJson(path.join(desktop, "config", "desktop", "service-lifecycle-args.json"));
  const servicePortDefaults = readJson(path.join(desktop, "config", "desktop", "service-port-defaults.json"));
  const website = readJson(path.join(desktop, "data", "webs", "websites", "docs", "website.json"));
  const bootstrapState = readJson(path.join(desktop, "state", "desktop", "bootstrap.json"));

  assert.equal(profile.appearance.theme, "dark");
  assert.equal(profile.appearance.locale, "en-US");
  assert.equal(profile.general.desktopActionConfirmationEnabled, false);
  assert.equal(profile.assistant.copilot.agentKey, "desktopAssistant");
  assert.equal(assistantConfig.defaultChatAgentKey, "zenmi");
  assert.equal(assistantConfig.bootstrapAgentKey, "zenmi");
  assert.equal(assistantConfig.bootstrapChatId, "00000000-0000-4000-8000-000000000001");
  const publicAssistantSettings = getAssistantSettingsFromRoot(path.join(desktop, "config", "desktop"));
  assert.equal(publicAssistantSettings.bootstrapChatId, "00000000-0000-4000-8000-000000000001");
  assert.equal("desktopHelperAgentKey" in profile.assistant, false);
  assert.equal("kanban" in profile.navigation, false);
  assert.equal(kanban.enabled, false);
  assert.deepEqual(kanban.cloud, {
    serverUrl: "https://kanban.example.test",
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
  assert.deepEqual(desktopActionBridge, {
    schemaVersion: 1,
    port: 17988
  });
  assert.deepEqual(enterpriseIm, {
    schemaVersion: 1,
    enabled: true,
    baseUrl: "https://im.example.test/api"
  });
  assert.deepEqual(help, {
    schemaVersion: 1,
    url: "https://www.zenmind.cc/help/"
  });
  assert.deepEqual(serviceLifecycleArgs, {
    schemaVersion: 1,
    services: {
      "agent-platform": {
        lifecycleArgs: {
          deploy: [
            "--ai-vision-general-model-key", "explicit-vision-general",
            "--ai-vision-ocr-model-key", "explicit-vision-ocr",
            "--ai-web-fetch-model-key", "explicit-web-fetch",
            "--coder-model-key", "explicit-coder-model",
            "--coder-reasoning-effort", "HIGH"
          ]
        }
      },
      "agent-webclient": {
        lifecycleArgs: {
          start: ["--base-url", "http://127.0.0.1:7908"]
        }
      }
    }
  });
  assert.deepEqual(servicePortDefaults, {
    schemaVersion: 1,
    services: {
      "agent-container-hub": {
        defaultPort: 7909
      },
      "identity-center": {
        defaultPort: 7906
      },
      "agent-platform": {
        defaultPort: 7918
      },
      "agent-webclient": {
        defaultPort: 7910
      }
    }
  });
  assert.equal(website.id, "docs");
  assert.equal(website.kind, "website");
  assert.equal(website.copilotAgentKey, "desktopAssistant");
  assert.equal("agentKey" in website, false);
  assert.equal(website.schemaVersion, 2);
  assert.equal(bootstrapState.schemaVersion, 2);
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
  assert.equal(bootstrapState.appliedResult.desktopActionBridge, "applied");
  assert.equal(bootstrapState.appliedResult.enterpriseIm, "applied");
  assert.equal(bootstrapState.appliedResult.help, "applied");
  assert.equal(bootstrapState.appliedResult.services, "applied");
  assert.equal(bootstrapState.websReport.mode, "initialize");
  assert.deepEqual(bootstrapState.websReport.items.map(({ entryKey, status }) => ({ entryKey, status })), [
    { entryKey: "website:docs", status: "installed" }
  ]);
  assert.deepEqual(bootstrapState.failedSections, []);
  assert.deepEqual(bootstrapState.errors, {});
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
  assert.equal(profileAfterSecondRun.general.desktopActionConfirmationEnabled, false);
  assert.equal("kanban" in profileAfterSecondRun.navigation, false);
});

test("desktop-init rejects an insecure remote enterprise IM server without replacing canonical config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-im-server-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    enterpriseIm: {
      enabled: true,
      baseUrl: "http://im.example.test"
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const enterpriseImPath = path.join(
    desktopRoot(homePath),
    "config",
    "desktop",
    "enterprise-im.json"
  );

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.enterpriseIm, "failed");
  assert.deepEqual(result.failedSections, ["enterpriseIm"]);
  assert.match(result.errors.enterpriseIm, /loopback HTTP or remote HTTPS/u);
  assert.equal(fs.existsSync(enterpriseImPath), false);
});

test("desktop-init requires an explicit enterprise IM enabled flag", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-enterprise-im-enabled-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const enterpriseImPath = path.join(
    desktopRoot(homePath),
    "config",
    "desktop",
    "enterprise-im.json"
  );
  fs.mkdirSync(path.dirname(enterpriseImPath), { recursive: true });
  fs.writeFileSync(enterpriseImPath, `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    baseUrl: "https://existing-im.example.test"
  }, null, 2)}\n`, "utf8");
  writeDesktopInit(app, "darwin", {
    enterpriseIm: {
      baseUrl: "https://replacement-im.example.test"
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");

  assert.equal(result.appliedResult.enterpriseIm, "failed");
  assert.match(result.errors.enterpriseIm, /enabled must be boolean/u);
  assert.deepEqual(readJson(enterpriseImPath), {
    schemaVersion: 1,
    enabled: true,
    baseUrl: "https://existing-im.example.test"
  });
});

test("desktop-init ignores retired imServer and overwrites canonical enterprise IM on reapply", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-enterprise-im-reapply-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const enterpriseImPath = path.join(
    desktopRoot(homePath),
    "config",
    "desktop",
    "enterprise-im.json"
  );
  writeDesktopInit(app, "darwin", {
    imServer: {
      baseUrl: "https://legacy-im.example.test"
    }
  });
  const legacy = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(legacy.appliedResult.enterpriseIm, "absent");
  assert.equal(fs.existsSync(enterpriseImPath), false);

  writeDesktopInit(app, "darwin", {
    enterpriseIm: {
      enabled: true,
      baseUrl: "https://first-im.example.test"
    }
  });
  applyDesktopInitBootstrap(app, "darwin");
  writeDesktopInit(app, "darwin", {
    enterpriseIm: {
      enabled: false,
      baseUrl: "https://second-im.example.test/api/"
    }
  });
  const reapplied = applyDesktopInitBootstrap(app, "darwin");

  assert.equal(reapplied.appliedResult.enterpriseIm, "applied");
  assert.deepEqual(readJson(enterpriseImPath), {
    schemaVersion: 1,
    enabled: false,
    baseUrl: "https://second-im.example.test/api"
  });
});

test("desktop-init rejects an insecure Help URL without replacing canonical config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-help-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const helpPath = path.join(
    desktopRoot(homePath),
    "config",
    "desktop",
    "help.json"
  );
  fs.mkdirSync(path.dirname(helpPath), { recursive: true });
  fs.writeFileSync(helpPath, `${JSON.stringify({
    schemaVersion: 1,
    url: "https://www.zenmind.cc/help/"
  }, null, 2)}\n`, "utf8");
  writeDesktopInit(app, "darwin", {
    help: {
      url: "http://help.example.test/"
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.help, "failed");
  assert.deepEqual(result.failedSections, ["help"]);
  assert.match(result.errors.help, /loopback HTTP or remote HTTPS/u);
  assert.deepEqual(readJson(helpPath), {
    schemaVersion: 1,
    url: "https://www.zenmind.cc/help/"
  });
});

test("desktop-init v2 installs mixed Sites once, keeps declared order, and later preserves user changes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-sites-seed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const init = {
    schemaVersion: 2,
    webs: {
      items: [
        {
          kind: "website",
          id: "docs",
          label: "Docs",
          url: "https://docs.example.com/",
          copilotAgentKey: "desktopAssistant"
        },
        {
          kind: "webapp",
          id: OPS_CONSOLE_WEBAPP_ID
        },
        {
          kind: "website",
          id: "portal",
          label: "Portal",
          url: "https://portal.example.com/"
        }
      ]
    }
  };
  const initPath = writeDesktopInit(app, "darwin", init);
  writeBootstrapWebappSeed(app, "darwin", OPS_CONSOLE_WEBAPP_ID, {
    appConfig: { seeded: true }
  });

  const first = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(first.appliedResult.webs, "applied");
  assert.equal(first.websReport.mode, "initialize");
  assert.deepEqual(first.websReport.items.map(({ entryKey, status }) => ({ entryKey, status })), [
    { entryKey: `webapp:${OPS_CONSOLE_WEBAPP_ID}`, status: "installed" },
    { entryKey: "website:docs", status: "installed" },
    { entryKey: "website:portal", status: "installed" }
  ]);

  const desktop = desktopRoot(homePath);
  const docsPath = path.join(desktop, "data", "webs", "websites", "docs", "website.json");
  const portalDir = path.join(desktop, "data", "webs", "websites", "portal");
  const webappPath = path.join(desktop, "data", "webs", "webapps", OPS_CONSOLE_WEBAPP_ID, "webapp.json");
  const orderPath = path.join(desktop, "config", "webs", "order.json");
  const docs = readJson(docsPath);
  const portal = readJson(path.join(portalDir, "website.json"));
  const webapp = readJson(webappPath);
  assert.equal(docs.schemaVersion, 2);
  assert.equal(docs.copilotAgentKey, "desktopAssistant");
  assert.equal("agentKey" in docs, false);
  assert.equal("copilotAgentKey" in portal, false);
  assert.equal(webapp.schemaVersion, 2);
  assert.deepEqual(webapp.appConfig, { seeded: true });
  assert.deepEqual(webapp.desktopBridge, { version: 1 });
  assert.deepEqual(readJson(orderPath).entryKeys, [
    "website:docs",
    `webapp:${OPS_CONSOLE_WEBAPP_ID}`,
    "website:portal"
  ]);
  assert.equal(fs.existsSync(path.join(path.dirname(initPath), "desktop-init", "sites")), false);

  fs.writeFileSync(docsPath, `${JSON.stringify({ ...docs, label: "User Docs" }, null, 2)}\n`, "utf8");
  fs.rmSync(portalDir, { recursive: true, force: true });
  const userOrder = {
    schemaVersion: 1,
    entryKeys: [`webapp:${OPS_CONSOLE_WEBAPP_ID}`, "website:docs"]
  };
  fs.writeFileSync(orderPath, `${JSON.stringify(userOrder, null, 2)}\n`, "utf8");
  writeDesktopInit(app, "darwin", init);
  const staleStaging = path.join(path.dirname(initPath), "desktop-init", "sites", OPS_CONSOLE_WEBAPP_ID);
  fs.mkdirSync(staleStaging, { recursive: true });
  fs.writeFileSync(path.join(staleStaging, "webapp.json"), "not valid json", "utf8");

  const second = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(second.appliedResult.webs, "preserved");
  assert.equal(second.websReport.mode, "preserve");
  assert.equal(readJson(docsPath).label, "User Docs");
  assert.equal(fs.existsSync(portalDir), false);
  assert.deepEqual(readJson(orderPath), userOrder);
  assert.equal(fs.existsSync(path.join(path.dirname(initPath), "desktop-init", "sites")), false);
});

test("desktop-init Sites validation rejects the whole seed before writing any Site", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-sites-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    schemaVersion: 2,
    webs: {
      items: [
        { kind: "website", id: "first", label: "First", url: "https://same.example.com/" },
        { kind: "website", id: "second", label: "Second", url: "https://same.example.com" }
      ]
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.webs, "failed");
  assert.match(result.errors.webs, /Duplicate Website URL/);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "data", "webs", "websites", "first")), false);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "data", "webs", "websites", "second")), false);
});

test("desktop-init rejects a WebApp whose manifest id differs from its declared id", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-sites-id-mismatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    schemaVersion: 2,
    webs: { items: [{ kind: "webapp", id: OPS_CONSOLE_WEBAPP_ID }] }
  });
  writeBootstrapWebappSeed(app, "darwin", OPS_CONSOLE_WEBAPP_ID, { id: OTHER_CONSOLE_WEBAPP_ID });

  const result = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(result.appliedResult.webs, "failed");
  assert.match(result.errors.webs, /manifest id must match/);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "data", "webs", "webapps", OPS_CONSOLE_WEBAPP_ID)), false);
});

test("desktop-init rejects an oversized Website seed without installing the earlier entries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-sites-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    schemaVersion: 2,
    webs: {
      items: Array.from({ length: 15 }, (_, index) => ({
        kind: "website",
        id: `site-${index + 1}`,
        label: `Site ${index + 1}`,
        url: `https://site-${index + 1}.example.com/`
      }))
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(result.appliedResult.webs, "failed");
  assert.match(result.errors.webs, /14 Website limit/);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "data", "webs", "websites", "site-1")), false);
});

test("desktop-init mixed Sites uses the explicit Windows path branch", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-sites-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "win32", {
    schemaVersion: 2,
    webs: {
      items: [
        { kind: "webapp", id: OPS_WIN_WEBAPP_ID },
        { kind: "website", id: "docs-win", label: "Docs", url: "https://docs-win.example.com/" }
      ]
    }
  });
  writeBootstrapWebappSeed(app, "win32", OPS_WIN_WEBAPP_ID);

  const result = applyDesktopInitBootstrap(app, "win32");
  assert.equal(result.appliedResult.webs, "applied");
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "data", "webs", "webapps", OPS_WIN_WEBAPP_ID, "webapp.json")), true);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "data", "webs", "websites", "docs-win", "website.json")), true);
  assert.deepEqual(
    readJson(path.join(desktopRoot(homePath), "config", "webs", "order.json")).entryKeys,
    [`webapp:${OPS_WIN_WEBAPP_ID}`, "website:docs-win"]
  );
});

test("desktop-init rejects symbolic links inside a WebApp seed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-sites-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    schemaVersion: 2,
    webs: { items: [{ kind: "webapp", id: LINKED_WEBAPP_ID }] }
  });
  const seedDir = writeBootstrapWebappSeed(app, "darwin", LINKED_WEBAPP_ID);
  const outsideFile = path.join(root, "outside.html");
  fs.writeFileSync(outsideFile, "outside", "utf8");
  fs.rmSync(path.join(seedDir, "frontend", "index.html"));
  fs.symlinkSync(outsideFile, path.join(seedDir, "frontend", "index.html"));

  const result = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(result.appliedResult.webs, "failed");
  assert.match(result.errors.webs, /symbolic links/);
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "data", "webs", "webapps", LINKED_WEBAPP_ID)), false);
});

test("desktop-init bootstrap ignores the retired Chat default agent field", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-chat-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    assistant: {
      defaultAgentKey: "zenmi",
    },
  });

  applyDesktopInitBootstrap(app, "darwin");

  const assistantConfigPath = path.join(desktopRoot(homePath), "config", "desktop", "assistant.json");
  assert.equal(fs.existsSync(assistantConfigPath), false);
});

test("desktop-init bootstrap ignores retired profile, Kanban, and Website shapes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-retired-inputs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    profile: {
      assistant: {
        desktopHelperAgentKey: "legacy-helper"
      },
      navigation: {
        websiteOrder: ["legacy-site"],
        kanban: {
          enabled: false
        }
      }
    },
    websites: [{
      id: "top-level-site",
      label: "Top-level site",
      url: "https://top-level.example.test/"
    }],
    webs: {
      websites: [{
        id: "nested-site",
        label: "Nested site",
        url: "https://nested.example.test/",
        agentKey: "legacy-helper"
      }]
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const desktop = desktopRoot(homePath);
  const profile = readJson(path.join(desktop, "config", "desktop", "profile.json"));

  assert.equal(profile.assistant.copilot.agentKey, "desktopAssistant");
  assert.deepEqual(profile.navigation.webOrder, []);
  assert.equal(result.appliedResult.kanban, "absent");
  assert.equal(result.appliedResult.webs, "absent");
  assert.equal(fs.existsSync(path.join(desktop, "config", "desktop", "kanban.json")), false);
  assert.equal(fs.existsSync(path.join(desktop, "data", "webs", "websites", "top-level-site")), false);
  assert.equal(fs.existsSync(path.join(desktop, "data", "webs", "websites", "nested-site")), false);
});

test("desktop-init bootstrap ignores the retired Website array form", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-retired-web-array-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    webs: [{
      id: "array-site",
      label: "Array site",
      url: "https://array.example.test/"
    }]
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  assert.equal(result.appliedResult.webs, "absent");
  assert.equal(
    fs.existsSync(path.join(desktopRoot(homePath), "data", "webs", "websites", "array-site")),
    false
  );
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

test("desktop-init bootstrap ignores retired navigation kanban defaults", (t) => {
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
  const kanbanPath = path.join(desktopConfigRoot, "kanban.json");
  assert.equal("kanban" in profile.navigation, false);
  assert.equal(fs.existsSync(kanbanPath), false);
  assert.equal(result.appliedResult.kanban, "absent");
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

test("desktop-init bootstrap filters disabled placeholder services without blocking SSO", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-placeholders-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    kanban: {
      enabled: false,
      cloud: {
        serverUrl: "https://",
        selectedProjectId: "default",
        remoteControlEnabled: true
      }
    },
    market: {
      enabled: false,
      apiBaseUrl: "https://"
    },
    sso: {
      enabled: true,
      providerLabel: "ZenMind",
      issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
      authorizeUrl: "https://auth.zenmind.cc/o/authorize/",
      tokenUrl: "https://auth.zenmind.cc/application/o/token/",
      clientId: "zenmind-desktop",
      wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration"
    },
    tunnelHub: {
      enabled: false,
      relayUrl: "wss://",
      reconnectSeconds: 3
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const desktop = desktopRoot(homePath);
  const sso = readJson(canonicalSsoPath(homePath));
  const kanban = readJson(path.join(desktop, "config", "desktop", "kanban.json"));
  const tunnelHub = readJson(path.join(desktop, "config", "desktop", "tunnel-hub.json"));
  const bootstrapState = readJson(path.join(desktop, "state", "desktop", "bootstrap.json"));

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.market, "absent");
  assert.equal(result.appliedResult.sso, "applied");
  assert.equal(result.appliedResult.tunnelHub, "applied");
  assert.equal(sso.enabled, true);
  assert.equal(sso.providerLabel, "ZenMind");
  assert.equal(kanban.enabled, false);
  assert.equal(kanban.cloud.serverUrl, "");
  assert.equal(tunnelHub.enabled, false);
  assert.equal(tunnelHub.relayUrl, "");
  assert.equal(fs.existsSync(path.join(desktop, "config", "desktop", "market.json")), false);
  assert.deepEqual(result.failedSections, []);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(bootstrapState.failedSections, []);
  assert.deepEqual(bootstrapState.errors, {});
});

test("desktop-init bootstrap isolates enabled market URL failures from SSO", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-market-failed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = originalWarn;
  });

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const initPath = writeDesktopInit(app, "darwin", {
    market: {
      enabled: true,
      apiBaseUrl: "https://"
    },
    sso: {
      enabled: true,
      provider: "google",
      authMode: "server"
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const bootstrapState = readJson(path.join(desktopRoot(homePath), "state", "desktop", "bootstrap.json"));

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.market, "failed");
  assert.equal(result.appliedResult.sso, "applied");
  assert.deepEqual(result.failedSections, ["market"]);
  assert.match(result.errors.market, /Market API address|API 地址|valid http or https URL/u);
  assert.equal(readJson(canonicalSsoPath(homePath)).provider, "google");
  assert.equal(fs.existsSync(path.join(desktopRoot(homePath), "config", "desktop", "market.json")), false);
  assert.equal(fs.existsSync(initPath), false);
  assert.deepEqual(bootstrapState.failedSections, ["market"]);
  assert.match(bootstrapState.errors.market, /Market API address|API 地址|valid http or https URL/u);
  assert.equal(warnings.length, 1);
});

test("desktop-init bootstrap isolates enabled Tunnel Hub relay failures", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-tunnel-failed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = originalWarn;
  });

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    profile: {
      appearance: {
        theme: "dark",
        locale: "en-US"
      }
    },
    tunnelHub: {
      enabled: true,
      relayUrl: "wss://"
    },
    sso: {
      enabled: true,
      provider: "google",
      authMode: "server"
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const desktop = desktopRoot(homePath);
  const bootstrapState = readJson(path.join(desktop, "state", "desktop", "bootstrap.json"));

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.profile, "applied");
  assert.equal(result.appliedResult.tunnelHub, "failed");
  assert.equal(result.appliedResult.sso, "applied");
  assert.deepEqual(result.failedSections, ["tunnelHub"]);
  assert.match(result.errors.tunnelHub, /Tunnel Hub relay URL is invalid/u);
  assert.equal(readJson(path.join(desktop, "config", "desktop", "profile.json")).appearance.theme, "dark");
  assert.equal(readJson(canonicalSsoPath(homePath)).provider, "google");
  assert.equal(fs.existsSync(path.join(desktop, "config", "desktop", "tunnel-hub.json")), false);
  assert.deepEqual(bootstrapState.failedSections, ["tunnelHub"]);
  assert.match(bootstrapState.errors.tunnelHub, /Tunnel Hub relay URL is invalid/u);
  assert.equal(warnings.length, 1);
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
      tlsInsecureSkipVerify: true
    }
  });

  const result = applyDesktopInitBootstrap(app, "darwin");
  const desktop = desktopRoot(homePath);
  const tunnelSettingsPath = path.join(desktop, "config", "desktop", "tunnel-hub.json");
  const tokenPath = path.join(desktop, "secrets", "tunnel-hub-token");
  const registrationTokenPath = path.join(desktop, "secrets", "tunnel-hub-registration-token");
  const deviceSecretPath = path.join(desktop, "secrets", "tunnel-hub-device-secret");
  const tunnelSettings = readJson(tunnelSettingsPath);
  const bootstrapState = readJson(path.join(desktop, "state", "desktop", "bootstrap.json"));

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.tunnelHub, "applied");
  assert.deepEqual(tunnelSettings, {
    enabled: false,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    publicHost: "",
    lastRegisteredAt: "",
    tlsInsecureSkipVerify: false,
    reconnectSeconds: 3
  });
  assert.equal("relayToken" in tunnelSettings, false);
  assert.equal("registrationToken" in tunnelSettings, false);
  assert.equal("deviceSecret" in tunnelSettings, false);
  assert.equal(fs.existsSync(tokenPath), false);
  assert.equal(fs.existsSync(registrationTokenPath), false);
  assert.equal(fs.existsSync(deviceSecretPath), false);
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
        webOrder: [],
        desktopCopilotPages: {}
      }
    },
    assistant: {
      defaultChatAgentKey: "cutej",
      bootstrapAgentKey: "bootstrap",
      bootstrapChatId: "00000000-0000-4000-8000-000000000001"
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
  assert.equal(profile.assistant.copilot.agentKey, "desktopAssistant");
  assert.deepEqual(profile.navigation.mainOrder, []);
  assert.deepEqual(profile.navigation.webOrder, []);
  assert.equal(profile.navigation.desktopCopilotPages.controlCenter.agentKey, "desktopAssistant");
  assert.equal(assistantConfig.defaultChatAgentKey, "cutej");
  assert.equal(assistantConfig.bootstrapAgentKey, "bootstrap");
  assert.equal(assistantConfig.bootstrapChatId, "00000000-0000-4000-8000-000000000001");
  assert.equal(kanban.enabled, false);
  assert.equal(kanban.cloud.serverUrl, "https://kanban.example.test");
  assert.equal("selectedProjectId" in kanban.cloud, false);
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
      avatarCache: {
        enabled: true,
        trustedOrigin: "https://www.zenmind.cc"
      },
      userInfo: {
        url: "https://auth.zenmind.cc/application/o/userinfo/",
        authMode: "bearer",
        required: false,
        subPath: "sub",
        namePath: "name",
        emailPath: "email",
        avatarUrlPath: "picture"
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
    avatarCache: {
      enabled: true,
      trustedOrigin: "https://www.zenmind.cc"
    },
    userInfo: {
      url: "https://auth.zenmind.cc/application/o/userinfo/",
      authMode: "bearer",
      required: false,
      subPath: "sub",
      namePath: "name",
      emailPath: "email",
      avatarUrlPath: "picture"
    }
  });
  assert.equal(sso.userInfo.url, "https://auth.zenmind.cc/application/o/userinfo/");
  assert.equal("siteTokenBridge" in sso, false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(ssoPath).mode & 0o777, 0o600);
  }
  assert.equal(bootstrapState.appliedResult.sso, "applied");
});

test("desktop-init bootstrap uses explicit Windows path branches", () => {
  const app = createApp("C:\\Users\\tester");

  assert.equal(
    resolveDesktopInitPath(app, "win32"),
    path.win32.join("C:\\Users\\tester", APP_BRAND.paths.runtimeRootDirName, "desktop-init.json")
  );
});

test("desktop-init bootstrap applies Windows service lifecycle args branch", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-service-args-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeDesktopInit(app, "win32", {
    desktopActionBridge: {
      port: 17988,
      platforms: {
        darwin: {
          port: 17989
        },
        win32: {
          port: 17990
        }
      }
    },
    services: {
      "identity-center": {
        defaultPort: 7906,
        lifecycleArgs: {
          deploy: ["--auth-issuer", "https://zenmind.cc"],
          start: ["--identity-start"]
        },
        platforms: {
          darwin: {
            lifecycleArgs: {
              start: ["--identity-start-darwin"]
            }
          },
          win32: {
            defaultPort: 7907,
            lifecycleArgs: {
              start: ["-IdentityStartWindows"]
            }
          }
        }
      },
      "agent-webclient": {
        defaultPort: 70000,
        lifecycleArgs: {
          start: ["--base-url", "http://127.0.0.1:7078"]
        }
      }
    }
  });

  const result = applyDesktopInitBootstrap(app, "win32");
  const desktopActionBridge = readJson(path.join(desktopRoot(homePath, "win32"), "config", "desktop", "desktop-action-bridge.json"));
  const serviceLifecycleArgs = readJson(path.join(desktopRoot(homePath, "win32"), "config", "desktop", "service-lifecycle-args.json"));
  const servicePortDefaults = readJson(path.join(desktopRoot(homePath, "win32"), "config", "desktop", "service-port-defaults.json"));

  assert.equal(result.applied, true);
  assert.equal(result.appliedResult.desktopActionBridge, "applied");
  assert.equal(result.appliedResult.services, "applied");
  assert.deepEqual(desktopActionBridge, {
    schemaVersion: 1,
    port: 17990
  });
  assert.deepEqual(serviceLifecycleArgs, {
    schemaVersion: 1,
    services: {
      "identity-center": {
        lifecycleArgs: {
          deploy: ["--auth-issuer", "https://zenmind.cc"]
        }
      },
      "agent-webclient": {
        lifecycleArgs: {
          start: ["--base-url", "http://127.0.0.1:7078"]
        }
      }
    }
  });
  assert.deepEqual(servicePortDefaults, {
    schemaVersion: 1,
    services: {
      "identity-center": {
        defaultPort: 7907
      }
    }
  });
});

test("desktop-init bootstrap writes canonical SSO over an existing canonical config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-sso-existing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homePath = path.join(root, "canonical");
  const app = createApp(homePath);
  writeDesktopInit(app, "darwin", {
    sso: {
      enabled: true,
      provider: "google",
      authMode: "server"
    }
  });
  const existingPath = canonicalSsoPath(homePath);
  fs.mkdirSync(path.dirname(existingPath), { recursive: true });
  fs.writeFileSync(existingPath, `${JSON.stringify({ enabled: true, marker: "previous" })}\n`, "utf8");

  const result = applyDesktopInitBootstrap(app, "darwin");

  assert.equal(result.appliedResult.sso, "applied");
  assert.equal(readJson(existingPath).provider, "google");
  assert.equal(readJson(existingPath).authMode, "server");
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
      enabled: true,
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

test("Desktop version upgrade reapplies only Desktop-owned canonical sections", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const configRoot = path.join(desktopRoot(homePath), "config", "desktop");
  fs.mkdirSync(configRoot, { recursive: true });
  const profilePath = path.join(configRoot, "profile.json");
  fs.writeFileSync(profilePath, '{"user":"keep"}\n', "utf8");
  fs.writeFileSync(path.join(configRoot, "sso.json"), '{"old":true}\n', "utf8");
  fs.writeFileSync(path.join(configRoot, "market.json"), '{"enabled":true,"apiBaseUrl":"https://old.example"}\n', "utf8");

  applyDesktopInitVersionUpgrade(app, {
    profile: { appearance: { theme: "dark" } },
    pet: { enabled: true },
    webs: { items: [] },
    services: {
      "agent-platform": {
        defaultPort: 11949,
        lifecycleArgs: {
          deploy: ["--ai-image-generate-model-key", "th-gpt-image-2"]
        }
      },
      "agent-webclient": { defaultPort: 11950 },
      "agent-container-hub": { defaultPort: 11960 },
      "identity-center": { defaultPort: 11946 }
    }
  }, path.join(root, "backup"), "darwin");

  assert.equal(fs.readFileSync(profilePath, "utf8"), '{"user":"keep"}\n');
  assert.equal(fs.existsSync(path.join(configRoot, "sso.json")), false);
  assert.equal(fs.existsSync(path.join(configRoot, "market.json")), false);
  const lifecycle = readJson(path.join(configRoot, "service-lifecycle-args.json"));
  assert.deepEqual(
    lifecycle.services["agent-platform"].lifecycleArgs.deploy,
    ["--ai-image-generate-model-key", "th-gpt-image-2"]
  );
});

test("invalid version-upgrade desktop-init fails before clearing canonical config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-init-upgrade-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const ssoPath = canonicalSsoPath(homePath);
  fs.mkdirSync(path.dirname(ssoPath), { recursive: true });
  fs.writeFileSync(ssoPath, '{"old":true}\n', "utf8");
  assert.throws(
    () => applyDesktopInitVersionUpgrade(app, {
      sso: { enabled: true },
      help: { url: "http://remote-insecure.example/help" }
    }, path.join(root, "backup"), "darwin"),
    /Help URL/u
  );
  assert.equal(fs.readFileSync(ssoPath, "utf8"), '{"old":true}\n');
});

test("manual env.zip import applies desktop-init bootstrap and refreshes config before startup preparation", async () => {
  const handlers = new Map();
  const calls = [];
  let existingRuntime = false;
  let startupState = {};
  let startupOptions = null;
  let resumedStartupCount = 0;
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
    importEnvZipIntoExistingRuntime: async (_app, zipPath, desktopVersion, platform) => {
      calls.push(["platform-import", zipPath, desktopVersion, platform]);
      return { copiedFiles: 2, skippedFiles: 3 };
    },
    runtimeEnvExists: () => existingRuntime,
    desktopVersion: "2.0.0",
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
    onStartupPreparationSucceeded: () => {
      resumedStartupCount += 1;
    },
    runStartupPreparation: async (_app, options) => {
      startupOptions = options;
      calls.push(["startup"]);
      return { mode: "bootstrap", failures: [] };
    },
    startupRestoreController: {
      getState: () => startupState,
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumedStartupCount, 0);

  calls.length = 0;
  existingRuntime = true;
  const existingResult = await handlers.get("services.importEnvZip")();

  assert.deepEqual(existingResult, { ok: true });
  assert.deepEqual(calls.slice(0, 4), [
    ["platform-import", "/tmp/env.zip", "2.0.0", "darwin"],
    ["refreshConfig", "manual-env-import"],
    ["loadBuiltin"],
    ["loadPlugins"]
  ]);
  assert.equal(calls.some(([name]) => name === "bootstrap"), false);
  assert.equal(calls.some(([name]) => name === "import"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumedStartupCount, 0);

  calls.length = 0;
  startupOptions = null;
  app.isPackaged = false;
  startupState = {
    phase: "env-import-required",
    envImportRequest: {
      reason: "desktop-version-change",
      fromVersion: "v1.0.0",
      toVersion: "v2.0.0"
    }
  };
  const versionChangeResult = await handlers.get("services.importEnvZip")();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(versionChangeResult, { ok: true, message: "" });
  assert.equal(startupOptions.desktopVersionUpgradeEnvZipPath, "/tmp/env.zip");
  assert.equal(calls.some(([name]) => name === "platform-import"), false);
  assert.equal(calls.some(([name]) => name === "import"), false);
  assert.equal(resumedStartupCount, 1);
});
