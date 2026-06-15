import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const {
  loadInstalledPlugins,
  getPluginInstallDir
} = require("../dist-electron/main/plugin-loader.js");
const {
  getService,
  registerPlugin,
  __testInternals: registryInternals
} = require("../dist-electron/main/services/service-registry.js");
const {
  __testInternals: bridgeInternals
} = require("../dist-electron/main/plugin-bridge.js");
const {
  configurePluginResources,
  initializePluginResourceState,
  retryPendingPluginResourceSync,
  stopPluginResources,
  syncPluginResources,
  __testInternals: resourceInternals
} = require("../dist-electron/main/plugin-resources.js");
const {
  __testInternals: desktopEffectsInternals
} = require("../dist-electron/main/plugin-desktop-effects.js");
const {
  readPluginSettingsSnapshot,
  writePluginSettingsValues,
  getPluginSettingsPath,
  openPluginSettingsPage
} = require("../dist-electron/main/plugin-settings.js");
const {
  refreshPluginGlobalShortcuts,
  getPluginGlobalShortcutStatuses,
  unregisterPluginGlobalShortcuts
} = require("../dist-electron/main/plugin-global-shortcuts.js");
const {
  stopAllStaticSiteHosts
} = require("../dist-electron/main/static-site-host-manager.js");
const {
  getDesktopPetSettingsPath,
  getDesktopPetsDataRoot
} = require("../dist-electron/main/user-paths.js");

function createApp(root) {
  return {
    getPath(name) {
      if (name === "home") return path.join(root, "home");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "temp") return path.join(root, "tmp");
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, "utf8"));
}

function writePluginManifest(targetDir, manifest) {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("plugin manifest v2 registers from plugin directory without kind", () => {
  registryInternals.clearServices();
  const service = registerPlugin({
    pluginApiVersion: 1,
    id: "proxy-acp-codex",
    name: "Codex ACP Proxy",
    version: "v0.1.0",
    description: "Codex proxy",
    lifecycle: {
      deploy: "deploy.sh",
      start: ["start.sh", "--daemon"],
      stop: "stop.sh"
    },
    runtime: {
      pidRelativePath: "run/proxy-acp-codex.pid",
      logRelativePath: "run/proxy-acp-codex.log",
      requiredPaths: ["manifest.json"]
    },
    service: {
      web: {
        healthPath: "/healthz",
        portEnvKey: "PROXY_ACP_PORT",
        defaultPort: 17071
      },
      ui: "none"
    },
    hooks: {
      subscribe: ["desktop.ready", "service.statusChanged:agent-platform"]
    },
    bridge: {
      requests: ["service.getStatus", "agentPlatform.upsertAcpProxy"]
    }
  });

  assert.equal(service.kind, "plugin");
  assert.equal(service.pluginApiVersion, 1);
  assert.deepEqual(service.startCommand, ["./start.sh", "--daemon"]);
  assert.deepEqual(service.stopCommand, ["./stop.sh"]);
  assert.equal(service.deployCommand?.[0], "./deploy.sh");
  assert.equal(service.frontendMode, "none");
  assert.equal(service.web.routePath, "/healthz");
  assert.equal(service.web.portEnvKey, "PROXY_ACP_PORT");
  assert.equal(service.web.defaultPort, 17071);
  assert.deepEqual(service.hooks.subscribe, ["desktop.ready", "service.statusChanged:agent-platform"]);
  assert.deepEqual(service.bridge.requests, ["service.getStatus", "agentPlatform.upsertAcpProxy"]);
});

test("installed plugin loader skips invalid legacy manifests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-installed-plugin-loader-"));
  const app = createApp(root);
  const originalWarn = console.warn;
  const warnings = [];
  try {
    registryInternals.clearServices();
    console.warn = (...args) => {
      warnings.push(args.map(String).join(" "));
    };

    writePluginManifest(getPluginInstallDir(app, "legacy-plugin", "v0.1.0"), {
      kind: "plugin",
      id: "legacy-plugin",
      name: "Legacy Plugin",
      version: "v0.1.0",
      description: "legacy",
      frontend: { mode: "none" },
      scripts: { start: "start.sh", stop: "stop.sh" }
    });

    writePluginManifest(getPluginInstallDir(app, "valid-plugin", "v0.1.0"), {
      pluginApiVersion: 1,
      id: "valid-plugin",
      name: "Valid Plugin",
      version: "v0.1.0",
      description: "valid",
      lifecycle: {
        start: "start.sh",
        stop: "stop.sh"
      },
      runtime: {
        requiredPaths: ["manifest.json"]
      },
      service: {
        ui: "none",
        web: {
          healthPath: "/healthz",
          portEnvKey: "VALID_PLUGIN_PORT",
          defaultPort: 18080
        }
      }
    });

    assert.doesNotThrow(() => loadInstalledPlugins(app));
    assert.equal(getService("valid-plugin").kind, "plugin");
    assert.throws(() => getService("legacy-plugin"), /unknown service id/u);
    assert.match(warnings.join("\n"), /Skipping invalid installed plugin manifest/u);
  } finally {
    console.warn = originalWarn;
    registryInternals.clearServices();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin manifest rejects legacy public fields", () => {
  const baseManifest = {
    pluginApiVersion: 1,
    id: "strict-plugin",
    name: "Strict Plugin",
    version: "v1",
    description: "strict",
    lifecycle: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    },
    service: {
      ui: "none",
      web: {
        healthPath: "/healthz",
        portEnvKey: "PORT",
        defaultPort: 9000
      }
    }
  };

  for (const [field, value] of Object.entries({
    kind: "plugin",
    scripts: { start: "start.sh", stop: "stop.sh" },
    frontend: { mode: "embedded" },
    web: { routePath: "/", portEnvKey: "PORT", defaultPort: 9000 }
  })) {
    registryInternals.clearServices();
    assert.throws(
      () => registerPlugin({ ...baseManifest, [field]: value }),
      new RegExp(`plugin manifest field "${field}" is not supported`, "u")
    );
  }
});

test("resource plugin manifest does not require lifecycle commands", () => {
  registryInternals.clearServices();
  const service = registerPlugin({
    pluginApiVersion: 1,
    id: "happy-agent",
    name: "Happy Agent",
    version: "v0.1.0",
    description: "Happy agent resource plugin",
    runtime: {
      requiredPaths: ["manifest.json"]
    },
    resources: {
      agents: [{
        key: "happy-agent",
        definition: {
          name: "Happy Agent"
        }
      }],
      automations: [{
        id: "happy-agent-happy-story",
        name: "Happy Agent 开心故事",
        cron: "*/2 * * * *",
        agentKey: "happy-agent",
        zoneId: "Asia/Shanghai",
        query: {
          message: "给我讲一个简短、开心、温暖的小故事。"
        }
      }]
    }
  });

  assert.equal(service.kind, "plugin");
  assert.equal(service.serviceMode, "resource");
  assert.deepEqual(service.startCommand, []);
  assert.deepEqual(service.stopCommand, []);
  assert.equal(service.resources.agents[0].key, "happy-agent");
  assert.equal(service.resources.automations[0].id, "happy-agent-happy-story");
});

test("plugin bridge path generation is platform explicit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-bridge-path-"));
  try {
    const app = createApp(root);
    const darwinPath = bridgeInternals.createPluginBridgePath(app, "proxy-acp-codex", {
      platform: "darwin",
      instanceId: "abc"
    });
    const windowsPath = bridgeInternals.createPluginBridgePath(app, "proxy-acp-codex", {
      platform: "win32",
      instanceId: "abc"
    });

    assert.equal(path.dirname(darwinPath), path.join(root, "tmp"));
    assert.match(path.basename(darwinPath), /^zm-pb-[a-f0-9]{12}-abc\.sock$/u);
    assert.match(windowsPath, /^\\\\\.\\pipe\\ZenMind\.PluginBridge\.[a-f0-9]{12}\.abc$/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin bridge filters hooks and requests by manifest declarations", () => {
  const service = {
    hooks: {
      subscribe: ["desktop.ready", "assistant.activeTasksChanged", "plugin.actionInvoked:run-system-update"]
    },
    bridge: {
      requests: [
        "service.getStatus",
        "desktopOverlay.showSystemUpdate",
        "assistantRuns.getActiveTasks",
        "desktopActivityIsland.update",
        "desktopClipboard.readText"
      ]
    }
  };

  assert.equal(bridgeInternals.isHookSubscribed(service, "desktop.ready"), true);
  assert.equal(bridgeInternals.isHookSubscribed(service, "assistant.activeTasksChanged"), true);
  assert.equal(bridgeInternals.isHookSubscribed(service, "plugin.actionInvoked:run-system-update"), true);
  assert.equal(bridgeInternals.isHookSubscribed(service, "agentPlatform.ready"), false);
  assert.equal(bridgeInternals.isRequestAllowed(service, "service.getStatus"), true);
  assert.equal(bridgeInternals.isRequestAllowed(service, "desktopOverlay.showSystemUpdate"), true);
  assert.equal(bridgeInternals.isRequestAllowed(service, "assistantRuns.getActiveTasks"), true);
  assert.equal(bridgeInternals.isRequestAllowed(service, "desktopActivityIsland.update"), true);
  assert.equal(bridgeInternals.isRequestAllowed(service, "desktopClipboard.readText"), true);
  assert.equal(bridgeInternals.isRequestAllowed(service, "agentPlatform.upsertAcpProxy"), false);
  assert.equal(bridgeInternals.isRequestAllowed(service, "desktopPet.runBanner"), false);
  assert.equal(bridgeInternals.isRequestAllowed(service, "desktopClipboard.writeText"), false);
});

test("plugin desktop effects normalize activity island input and local palette URLs", () => {
  const tasks = desktopEffectsInternals.normalizeActivityIslandTasks([
    {
      title: "  ",
      preview: " 正在读取文件 ",
      agentDisplayName: " Codex ",
      status: "awaiting"
    },
    {
      title: "实现插件",
      agentDisplayName: "",
      status: "running"
    }
  ]);

  assert.deepEqual(tasks, [
    {
      title: "正在读取文件",
      agentDisplayName: "Codex",
      preview: "正在读取文件",
      status: "awaiting"
    },
    {
      title: "实现插件",
      agentDisplayName: "Agent",
      preview: "",
      status: "running"
    }
  ]);
  assert.match(
    desktopEffectsInternals.getActivityIslandHtml({ tasks, runningTaskCount: 4 }),
    /还有 2 个任务/u
  );
  assert.equal(
    desktopEffectsInternals.normalizeLocalHttpUrl("http://127.0.0.1:1234/palette"),
    "http://127.0.0.1:1234/palette"
  );
  assert.throws(
    () => desktopEffectsInternals.normalizeLocalHttpUrl("https://example.com"),
    /must use http/u
  );
});

test("plugin desktop actions normalize for control center", () => {
  registryInternals.clearServices();
  const service = registerPlugin({
    pluginApiVersion: 1,
    id: "system-update",
    name: "系统升级提示",
    version: "v0.1.0",
    description: "system update overlay",
    lifecycle: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    },
    hooks: {
      subscribe: ["plugin.actionInvoked:run-system-update"]
    },
    bridge: {
      requests: ["desktopOverlay.showSystemUpdate"]
    },
    desktop: {
      actions: [{
        id: "run-system-update",
        label: "运行",
        icon: "play",
        placement: "controlCenter",
        requiresRunning: true
      }]
    }
  });

  assert.equal(service.desktop.actions.length, 1);
  assert.deepEqual(service.desktop.actions[0], {
    id: "run-system-update",
    label: "运行",
    icon: "play",
    placement: "controlCenter",
    requiresRunning: true
  });
});

test("plugin manifest settings and action global shortcuts normalize", () => {
  registryInternals.clearServices();
  const service = registerPlugin({
    pluginApiVersion: 1,
    id: "settings-plugin",
    name: "Settings Plugin",
    version: "v1",
    description: "settings",
    lifecycle: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    },
    settings: {
      schemaVersion: 1,
      ui: {
        customHtmlPath: "settings/index.html"
      },
      fields: [
        {
          key: "runShortcut",
          type: "shortcut",
          label: "Run shortcut",
          defaultValueByPlatform: {
            darwin: "CommandOrControl+Shift+R",
            win32: "Control+Shift+R"
          },
          restartRequired: true
        },
        {
          key: "mode",
          type: "select",
          label: "Mode",
          defaultValue: "fast",
          options: [
            { label: "Fast", value: "fast" },
            { label: "Careful", value: "careful" }
          ]
        },
        {
          key: "timeoutMs",
          type: "duration",
          label: "Timeout",
          defaultValue: 3000,
          min: 1000,
          step: 1000
        }
      ]
    },
    desktop: {
      actions: [{
        id: "run",
        label: "Run",
        globalShortcut: {
          settingKey: "runShortcut"
        }
      }]
    }
  });

  assert.equal(service.settings.schemaVersion, 1);
  assert.equal(service.settings.ui.customHtmlPath, "settings/index.html");
  assert.equal(service.settings.fields.length, 3);
  assert.equal(service.desktop.actions[0].globalShortcut.settingKey, "runShortcut");
});

test("plugin manifest rejects action shortcut references to non-shortcut settings", () => {
  registryInternals.clearServices();
  assert.throws(
    () => registerPlugin({
      pluginApiVersion: 1,
      id: "bad-shortcut-plugin",
      name: "Bad Shortcut Plugin",
      version: "v1",
      description: "bad shortcut",
      lifecycle: {
        start: "start.sh",
        stop: "stop.sh"
      },
      runtime: {
        requiredPaths: ["manifest.json"]
      },
      settings: {
        fields: [{
          key: "label",
          type: "text",
          label: "Label"
        }]
      },
      desktop: {
        actions: [{
          id: "run",
          label: "Run",
          globalShortcut: {
            settingKey: "label"
          }
        }]
      }
    }),
    /globalShortcut\.settingKey must reference a shortcut setting field/u
  );
});

test("plugin settings store merges defaults, validates writes, and preserves corrupt files", () => {
  registryInternals.clearServices();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-settings-"));
  try {
    const app = createApp(root);
    const service = registerPlugin({
      pluginApiVersion: 1,
      id: "settings-store-plugin",
      name: "Settings Store Plugin",
      version: "v1",
      description: "settings store",
      lifecycle: {
        start: "start.sh",
        stop: "stop.sh"
      },
      runtime: {
        requiredPaths: ["manifest.json"]
      },
      settings: {
        fields: [
          { key: "title", type: "text", label: "Title", defaultValue: "Hello" },
          { key: "count", type: "number", label: "Count", defaultValue: 2, min: 1, max: 5 },
          { key: "enabled", type: "boolean", label: "Enabled", defaultValue: true },
          { key: "tags", type: "multiselect", label: "Tags", options: [{ label: "A", value: "a" }] }
        ]
      }
    });

    const initial = readPluginSettingsSnapshot(app, service.id);
    assert.deepEqual(initial.values, { title: "Hello", count: 2, enabled: true });

    const written = writePluginSettingsValues(app, service.id, {
      title: "Updated",
      count: 4,
      enabled: false,
      tags: ["a"],
      unknown: "ignored"
    });
    assert.deepEqual(written.values, { title: "Updated", count: 4, enabled: false, tags: ["a"] });
    assert.deepEqual(written.changedKeys.sort(), ["count", "enabled", "tags", "title"]);

    assert.throws(
      () => writePluginSettingsValues(app, service.id, { count: 9 }),
      /less than or equal to 5/u
    );

    const settingsPath = getPluginSettingsPath(app, service);
    fs.writeFileSync(settingsPath, "{ bad json", "utf8");
    assert.throws(
      () => readPluginSettingsSnapshot(app, service.id),
      /JSON|Unexpected|Expected/u
    );
    assert.equal(fs.readFileSync(settingsPath, "utf8"), "{ bad json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin custom settings page is served from loopback and rejects escaping paths", async () => {
  registryInternals.clearServices();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-settings-page-"));
  try {
    const app = createApp(root);
    const service = registerPlugin({
      pluginApiVersion: 1,
      id: "settings-page-plugin",
      name: "Settings Page Plugin",
      version: "v1",
      description: "settings page",
      lifecycle: {
        start: "start.sh",
        stop: "stop.sh"
      },
      runtime: {
        requiredPaths: ["manifest.json"]
      },
      settings: {
        ui: {
          customHtmlPath: "settings/index.html"
        }
      }
    });
    const installDir = path.join(root, "app-data", "ZenMind", "plugins", service.id, service.version);
    fs.mkdirSync(path.join(installDir, "settings"), { recursive: true });
    fs.writeFileSync(path.join(installDir, "settings", "index.html"), "<!doctype html><title>Settings</title>", "utf8");

    const result = await openPluginSettingsPage(app, service.id);
    assert.equal(result.ok, true);
    assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\//u);

    registryInternals.clearServices();
    registerPlugin({
      pluginApiVersion: 1,
      id: "settings-page-plugin",
      name: "Settings Page Plugin",
      version: "v1",
      description: "settings page",
      lifecycle: {
        start: "start.sh",
        stop: "stop.sh"
      },
      runtime: {
        requiredPaths: ["manifest.json"]
      },
      settings: {
        ui: {
          customHtmlPath: "../outside.html"
        }
      }
    });
    await assert.rejects(
      () => openPluginSettingsPage(app, service.id),
      /customHtmlPath must be a visible relative path/u
    );
  } finally {
    await stopAllStaticSiteHosts();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin global shortcuts register enabled shortcuts and disable conflicts", () => {
  registryInternals.clearServices();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-shortcuts-"));
  const app = createApp(root);
  const registered = new Set();
  const globalShortcut = {
    register(accelerator, callback) {
      if (registered.has(accelerator)) {
        return false;
      }
      registered.add(accelerator);
      this.callbacks.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      registered.delete(accelerator);
      this.callbacks.delete(accelerator);
    },
    callbacks: new Map()
  };
  try {
    const baseManifest = {
      pluginApiVersion: 1,
      version: "v1",
      description: "shortcut",
      lifecycle: {
        start: "start.sh",
        stop: "stop.sh"
      },
      runtime: {
        requiredPaths: ["manifest.json"]
      },
      settings: {
        fields: [{
          key: "runShortcut",
          type: "shortcut",
          label: "Run Shortcut",
          defaultValueByPlatform: {
            darwin: "CommandOrControl+Shift+P",
            win32: "Control+Shift+P"
          }
        }]
      },
      desktop: {
        actions: [{
          id: "run",
          label: "Run",
          globalShortcut: {
            settingKey: "runShortcut"
          }
        }]
      }
    };
    registerPlugin({ ...baseManifest, id: "shortcut-one", name: "Shortcut One" });
    registerPlugin({ ...baseManifest, id: "shortcut-two", name: "Shortcut Two" });

    refreshPluginGlobalShortcuts({
      app,
      globalShortcut,
      platform: "darwin",
      invokePluginAction: () => undefined
    });

    const statuses = getPluginGlobalShortcutStatuses().sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    assert.equal(statuses.length, 2);
    assert.equal(statuses[0].enabled, false);
    assert.equal(statuses[0].reason, "conflict");
    assert.equal(statuses[1].enabled, false);
    assert.equal(statuses[1].reason, "conflict");
    assert.equal(registered.size, 0);
  } finally {
    unregisterPluginGlobalShortcuts(globalShortcut);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin resource payload normalization is stable", () => {
  const agent = resourceInternals.normalizeAgentPayload({
    key: "happy-agent",
    definition: {
      name: "Happy Agent"
    }
  });
  assert.equal(agent.key, "happy-agent");
  assert.equal(agent.definition.key, "happy-agent");
  assert.equal(agent.definition.name, "Happy Agent");

  const automation = resourceInternals.normalizeAutomationPayload({
    id: "happy-agent-happy-story",
    name: "Happy Agent 开心故事",
    cron: "*/2 * * * *",
    agentKey: "happy-agent",
    enabled: true,
    zoneId: "Asia/Shanghai",
    query: {
      message: "给我讲一个简短、开心、温暖的小故事。"
    }
  });
  assert.equal(automation.id, "happy-agent-happy-story");
  assert.equal(automation.enabled, true);
  assert.equal(automation.zoneId, "Asia/Shanghai");
  assert.equal(automation.query.message, "给我讲一个简短、开心、温暖的小故事。");
});

test("plugin webapp resources do not overwrite unowned webapps", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-resource-webapp-"));
  try {
    const app = createApp(root);
    const pluginDir = path.join(root, "plugin");
    const sourceDir = path.join(pluginDir, "webapp", "calendar");
    fs.mkdirSync(path.join(sourceDir, "frontend"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "backend"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "webapp.json"), JSON.stringify({
      id: "calendar",
      kind: "webapp",
      label: "日历",
      frontend: { root: "frontend", index: "index.html" },
      backend: { runtime: "node", entry: "backend/server.mjs" }
    }), "utf8");
    fs.writeFileSync(path.join(sourceDir, "frontend", "index.html"), "<!doctype html>\n", "utf8");
    fs.writeFileSync(path.join(sourceDir, "backend", "server.mjs"), "console.log('calendar')\n", "utf8");

    const userWebappDir = path.join(root, "home", ".zenmind", ".desktop", "data", "webs", "webapps", "calendar");
    fs.mkdirSync(userWebappDir, { recursive: true });
    fs.writeFileSync(path.join(userWebappDir, "webapp.json"), "{\"id\":\"calendar\",\"label\":\"User Calendar\"}\n", "utf8");

    await assert.rejects(
      () => syncPluginResources(app, {
        kind: "plugin",
        id: "calendar",
        resources: {
          webapps: [{ id: "calendar", source: "webapp/calendar" }],
          agents: [],
          automations: []
        }
      }, pluginDir),
      /already exists and is not owned by plugin/u
    );
    assert.match(fs.readFileSync(path.join(userWebappDir, "webapp.json"), "utf8"), /User Calendar/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin agent and automation resources use current admin routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-resource-admin-routes-"));
  try {
    const app = createApp(root);
    const calls = [];
    configurePluginResources({
      callAgentPlatform: async (_app, endpoint, options) => {
        calls.push({ endpoint, body: options?.body });
        return { ok: true };
      }
    });
    await syncPluginResources(app, {
      kind: "plugin",
      id: "happy-agent",
      resources: {
        webapps: [],
        agents: [{ key: "happy-agent", definition: { name: "Happy Agent" } }],
        automations: [{
          id: "happy-agent-happy-story",
          name: "Happy Agent 开心故事",
          cron: "*/2 * * * *",
          agentKey: "happy-agent",
          query: { message: "给我讲一个简短、开心、温暖的小故事。" }
        }]
      }
    }, root);

    assert.deepEqual(calls.map((call) => call.endpoint), [
      "/api/admin/agents/create",
      "/api/admin/automations/create"
    ]);
    const ownershipPath = path.join(
      root,
      "home",
      ".zenmind",
      ".desktop",
      "state",
      "plugins",
      "happy-agent",
      "plugin-resources.json"
    );
    const ownership = JSON.parse(fs.readFileSync(ownershipPath, "utf8"));
    assert.equal(ownership.pendingAgentPlatformSync, false);
    assert.equal(Boolean(ownership.agents?.["happy-agent"]), true);
    assert.equal(Boolean(ownership.automations?.["happy-agent-happy-story"]), true);
  } finally {
    configurePluginResources({ callAgentPlatform: null });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resource plugin state defaults stopped and migrates legacy ownership to running", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-resource-desired-"));
  try {
    const app = createApp(root);
    const calendarService = {
      kind: "plugin",
      id: "calendar",
      resources: {
        webapps: [{ id: "calendar", source: "webapp/calendar" }],
        agents: [],
        automations: []
      }
    };
    assert.equal(initializePluginResourceState(app, calendarService), "stopped");
    assert.equal(resourceInternals.readPluginResourceDesiredStatus(app, calendarService), "stopped");

    const happyService = {
      kind: "plugin",
      id: "happy-agent",
      resources: {
        webapps: [],
        agents: [{ key: "happy-agent", definition: { name: "Happy Agent" } }],
        automations: []
      }
    };
    resourceInternals.writeOwnership(app, "happy-agent", {
      agents: { "happy-agent": { updatedAt: "2026-06-13T00:00:00.000Z" } }
    });
    assert.equal(initializePluginResourceState(app, happyService), "running");
    const ownership = resourceInternals.readOwnership(app, "happy-agent");
    assert.equal(ownership.desiredStatus, "running");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stopped resource plugin records pending agent-platform removal and retries on ready", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-resource-remove-"));
  try {
    registryInternals.clearServices();
    const app = createApp(root);
    const service = registerPlugin({
      pluginApiVersion: 1,
      id: "happy-agent",
      name: "Happy Agent",
      version: "v0.1.0",
      description: "Happy resource",
      runtime: { requiredPaths: ["manifest.json"] },
      resources: {
        agents: [{ key: "happy-agent", definition: { name: "Happy Agent" } }],
        automations: [{
          id: "happy-agent-happy-story",
          name: "Happy Agent 开心故事",
          cron: "*/2 * * * *",
          agentKey: "happy-agent",
          query: { message: "开心故事" }
        }]
      }
    });
    resourceInternals.writeOwnership(app, "happy-agent", {
      desiredStatus: "running",
      agents: { "happy-agent": { updatedAt: "2026-06-13T00:00:00.000Z" } },
      automations: { "happy-agent-happy-story": { updatedAt: "2026-06-13T00:00:00.000Z" } }
    });

    configurePluginResources({ callAgentPlatform: null });
    await stopPluginResources(app, service);
    let ownership = resourceInternals.readOwnership(app, "happy-agent");
    assert.equal(ownership.desiredStatus, "stopped");
    assert.equal(ownership.pendingAgentPlatformRemoval, true);
    assert.equal(Boolean(ownership.agents?.["happy-agent"]), true);

    const calls = [];
    configurePluginResources({
      callAgentPlatform: async (_app, endpoint, options) => {
        calls.push({ endpoint, body: options?.body });
        return { ok: true };
      }
    });
    await retryPendingPluginResourceSync(app);

    assert.deepEqual(calls.map((call) => call.endpoint), [
      "/api/admin/automations/delete",
      "/api/admin/agents/delete"
    ]);
    ownership = resourceInternals.readOwnership(app, "happy-agent");
    assert.equal(ownership.pendingAgentPlatformRemoval, false);
    assert.equal(ownership.pendingAgentPlatformSync, false);
    assert.equal(ownership.desiredStatus, "stopped");
  } finally {
    configurePluginResources({ callAgentPlatform: null });
    registryInternals.clearServices();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin agent resources only update owned agent-platform records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-resource-agent-"));
  try {
    const app = createApp(root);
    const calls = [];
    configurePluginResources({
      callAgentPlatform: async (_app, endpoint, options) => {
        calls.push({ endpoint, body: options?.body });
        if (endpoint.endsWith("/create")) {
          throw new Error("already exists");
        }
        return { ok: true };
      }
    });
    await syncPluginResources(app, {
      kind: "plugin",
      id: "happy-agent",
      resources: {
        webapps: [],
        agents: [{ key: "happy-agent", definition: { name: "Happy Agent" } }],
        automations: []
      }
    }, root);
    assert.deepEqual(calls.map((call) => call.endpoint), ["/api/admin/agents/create"]);

    const ownershipPath = path.join(
      root,
      "home",
      ".zenmind",
      ".desktop",
      "state",
      "plugins",
      "happy-agent",
      "plugin-resources.json"
    );
    const ownership = JSON.parse(fs.readFileSync(ownershipPath, "utf8"));
    assert.equal(ownership.pendingAgentPlatformSync, true);
    assert.equal(ownership.agents?.["happy-agent"], undefined);
  } finally {
    configurePluginResources({ callAgentPlatform: null });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop pet banner resolves builtin and user pet assets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-pet-banner-"));
  try {
    const app = createApp(root);
    const builtin = desktopEffectsInternals.resolveDesktopPetBannerAsset(app, "default");
    assert.equal(builtin.source, "builtin");
    assert.equal(builtin.label, "小禅");
    assert.match(builtin.url, /^file:\/\//u);
    assert.equal(fs.existsSync(new URL(builtin.url)), true);

    const settingsPath = getDesktopPetSettingsPath(app);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      selectedPetId: "user:desk-cat"
    }, null, 2)}\n`, "utf8");
    const petRoot = path.join(getDesktopPetsDataRoot(app), "desk-cat");
    fs.mkdirSync(petRoot, { recursive: true });
    fs.writeFileSync(path.join(petRoot, "pet.json"), `${JSON.stringify({
      id: "desk-cat",
      displayName: "Desk Cat",
      preview: "idle.png"
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(petRoot, "idle.png"), "fake png", "utf8");

    const userPet = desktopEffectsInternals.resolveDesktopPetBannerAsset(app, "current");
    assert.equal(userPet.source, "user");
    assert.equal(userPet.label, "Desk Cat");
    assert.equal(fs.readFileSync(new URL(userPet.url), "utf8"), "fake png");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agentPlatform ACP proxy bridge request preserves YAML and ownership", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-bridge-yaml-"));
  try {
    const app = createApp(root);
    const configPath = path.join(
      root,
      "home",
      ".zenmind",
      ".desktop",
      "config",
      "services",
      "agent-platform",
      "configs",
      "coder-settings.yml"
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "acp-proxies:\n  existing:\n    base-url: http://127.0.0.1:18080\n", "utf8");

    const upsertResult = bridgeInternals.upsertAgentPlatformAcpProxy(app, "proxy-acp-codex", {
      proxyId: "codex",
      baseUrl: "http://127.0.0.1:17071",
      timeoutMs: 300000
    });
    assert.equal(upsertResult.changed, true);

    const afterUpsert = readYaml(configPath);
    assert.equal(afterUpsert["acp-proxies"].existing["base-url"], "http://127.0.0.1:18080");
    assert.equal(afterUpsert["acp-proxies"].codex["base-url"], "http://127.0.0.1:17071");
    assert.equal(afterUpsert["acp-proxies"].codex["timeout-ms"], 300000);

    const deniedRemove = bridgeInternals.removeAgentPlatformAcpProxy(app, "other-plugin", {
      proxyId: "codex"
    });
    assert.equal(deniedRemove.changed, false);
    assert.ok(readYaml(configPath)["acp-proxies"].codex);

    const removeResult = bridgeInternals.removeAgentPlatformAcpProxy(app, "proxy-acp-codex", {
      proxyId: "codex"
    });
    assert.equal(removeResult.changed, true);
    const afterRemove = readYaml(configPath);
    assert.equal(afterRemove["acp-proxies"].codex, undefined);
    assert.ok(afterRemove["acp-proxies"].existing);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
