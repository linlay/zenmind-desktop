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

test("legacy plugin manifest still normalizes scripts frontend and web", () => {
  registryInternals.clearServices();
  const service = registerPlugin({
    kind: "plugin",
    id: "legacy-proxy",
    name: "Legacy Proxy",
    version: "v1",
    description: "legacy",
    frontend: {
      mode: "embedded"
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      pidRelativePath: "run/legacy.pid",
      logRelativePath: "run/legacy.log"
    },
    web: {
      routePath: "/",
      portEnvKey: "PORT",
      defaultPort: 9000
    }
  });

  assert.equal(service.kind, "plugin");
  assert.equal(service.frontendMode, "embedded");
  assert.deepEqual(service.startCommand, ["./start.sh"]);
  assert.deepEqual(service.stopCommand, ["./stop.sh"]);
  assert.equal(service.web.routePath, "/");
  assert.deepEqual(service.hooks.subscribe, []);
  assert.deepEqual(service.bridge.requests, []);
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
      subscribe: ["desktop.ready"]
    },
    bridge: {
      requests: ["service.getStatus"]
    }
  };

  assert.equal(bridgeInternals.isHookSubscribed(service, "desktop.ready"), true);
  assert.equal(bridgeInternals.isHookSubscribed(service, "agentPlatform.ready"), false);
  assert.equal(bridgeInternals.isRequestAllowed(service, "service.getStatus"), true);
  assert.equal(bridgeInternals.isRequestAllowed(service, "agentPlatform.upsertAcpProxy"), false);
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
