import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const {
  registerPlugin,
  __testInternals: registryInternals
} = require("../dist-electron/main/services/service-registry.js");
const {
  __testInternals: bridgeInternals
} = require("../dist-electron/main/plugin-bridge.js");
const {
  configurePluginResources,
  syncPluginResources,
  __testInternals: resourceInternals
} = require("../dist-electron/main/plugin-resources.js");
const {
  __testInternals: desktopEffectsInternals
} = require("../dist-electron/main/plugin-desktop-effects.js");
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
      subscribe: ["desktop.ready", "plugin.actionInvoked:run-system-update"]
    },
    bridge: {
      requests: ["service.getStatus", "desktopOverlay.showSystemUpdate"]
    }
  };

  assert.equal(bridgeInternals.isHookSubscribed(service, "desktop.ready"), true);
  assert.equal(bridgeInternals.isHookSubscribed(service, "plugin.actionInvoked:run-system-update"), true);
  assert.equal(bridgeInternals.isHookSubscribed(service, "agentPlatform.ready"), false);
  assert.equal(bridgeInternals.isRequestAllowed(service, "service.getStatus"), true);
  assert.equal(bridgeInternals.isRequestAllowed(service, "desktopOverlay.showSystemUpdate"), true);
  assert.equal(bridgeInternals.isRequestAllowed(service, "agentPlatform.upsertAcpProxy"), false);
  assert.equal(bridgeInternals.isRequestAllowed(service, "desktopPet.runBanner"), false);
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
    assert.equal(builtin.label, "小宅");
    assert.match(builtin.url, /^file:\/\//u);
    assert.equal(fs.existsSync(new URL(builtin.url)), true);

    const settingsPath = getDesktopPetSettingsPath(app);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      selectedPetId: "user:desk-cat",
      lastVisible: true
    }, null, 2)}\n`, "utf8");
    const petRoot = path.join(getDesktopPetsDataRoot(app), "desk-cat");
    fs.mkdirSync(petRoot, { recursive: true });
    fs.writeFileSync(path.join(petRoot, "pet.json"), `${JSON.stringify({
      id: "desk-cat",
      displayName: "Desk Cat"
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(petRoot, "pet-idle.png"), "fake png", "utf8");

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
