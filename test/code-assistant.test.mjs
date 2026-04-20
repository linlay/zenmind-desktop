import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CLAUDE_CODE_RELAY_PLUGIN_ID,
  __testInternals,
  ensureCodeAssistantReady,
  ensureManagedClaudeCodeRelayPlugin,
  setCodeAssistantFullAccessGranted,
  syncManagedCodeAssistantAgentDefinition
} = require("../dist-electron/main/code-assistant.js");
const { loadInstalledPlugins } = require("../dist-electron/main/plugin-loader.js");
const {
  __testInternals: registryInternals,
  getService
} = require("../dist-electron/main/service-registry.js");
const {
  getServiceState,
  initializeService
} = require("../dist-electron/main/service-manager.js");

function createApp(userDataRoot) {
  return {
    isPackaged: false,
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

function createBundledRuntimeFixture(tempRoot) {
  const runtimeRoot = path.join(tempRoot, "bundled-runtime");
  const claudeRoot = path.join(runtimeRoot, "claude-code-guotai");
  const bunPath = path.join(runtimeRoot, "bun", process.platform === "win32" ? "bun.exe" : "bun");

  fs.mkdirSync(path.join(claudeRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.dirname(bunPath), { recursive: true });
  fs.writeFileSync(path.join(claudeRoot, "dist", "cli.js"), "console.log('cli');\n", "utf8");
  fs.writeFileSync(
    path.join(claudeRoot, "dist", "chunk-relay.js"),
    "async function startRelayServer() { return { cliSdkUrl: 'ws://127.0.0.1:3210/ws/cli?token=test' }; }\nexport { startRelayServer };\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(runtimeRoot, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: "2026-04-18T00:00:00.000Z",
        platform: {
          os: process.platform,
          arch: process.arch
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(bunPath, "bun-binary\n", "utf8");
  if (process.platform !== "win32") {
    fs.chmodSync(bunPath, 0o755);
  }

  return runtimeRoot;
}

function createServiceState(overrides = {}) {
  return {
    id: CLAUDE_CODE_RELAY_PLUGIN_ID,
    name: "代码助手",
    kind: "plugin",
    version: "local-dev-v1",
    description: "fixture",
    installDir: "",
    installed: true,
    status: "stopped",
    statusLabel: "已停止",
    message: "fixture",
    frontendMode: "none",
    configFiles: [],
    healthMeta: {
      pid: null,
      pidFilePath: "",
      logFilePath: "",
      errorLogFilePath: "",
      webUrl: "http://127.0.0.1:3210",
      port: 3210,
      prerequisites: []
    },
    ...overrides
  };
}

test("ensureManagedClaudeCodeRelayPlugin bootstraps a managed plugin and marks it auto-start", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-code-assistant-bootstrap-"));
  const app = createApp(path.join(tempRoot, "user-data"));
  const bundledRuntimeRoot = createBundledRuntimeFixture(tempRoot);
  const previousRuntimeRoot = process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT;
  process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT = bundledRuntimeRoot;

  registryInternals.clearServices();
  t.after(() => {
    if (previousRuntimeRoot) {
      process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT = previousRuntimeRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT;
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  ensureManagedClaudeCodeRelayPlugin(app);
  loadInstalledPlugins(app);

  const installDir = __testInternals.getPluginRoot(app);
  const definition = getService(CLAUDE_CODE_RELAY_PLUGIN_ID);
  const initResult = await initializeService(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  const state = await getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  const relayScript = fs.readFileSync(path.join(installDir, "run-relay.mjs"), "utf8");
  const startScript = fs.readFileSync(path.join(installDir, "start.sh"), "utf8");
  const configTemplate = JSON.parse(
    fs.readFileSync(path.join(installDir, "managed-config.template.json"), "utf8")
  );

  assert.equal(fs.existsSync(path.join(installDir, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(installDir, "run-relay.mjs")), true);
  assert.equal(fs.existsSync(path.join(installDir, "managed-config.template.json")), true);
  assert.equal(fs.existsSync(path.join(installDir, "runtime", "claude-code-guotai", "dist", "cli.js")), true);
  assert.equal(fs.existsSync(path.join(installDir, "runtime", "bun", process.platform === "win32" ? "bun.exe" : "bun")), true);
  assert.equal(definition.desktop.autoStart, true);
  assert.match(relayScript, /desktopOnly:\s*true/);
  assert.match(relayScript, /showQR:\s*false/);
  assert.match(relayScript, /relay-entry\.mjs/);
  assert.match(relayScript, /fileURLToPath/);
  assert.match(relayScript, /path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(relayScript, /settings\.json/);
  assert.match(relayScript, /ANTHROPIC_BASE_URL/);
  assert.match(relayScript, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(relayScript, /ANTHROPIC_API_KEY/);
  assert.match(relayScript, /process\.env\.ANTHROPIC_AUTH_TOKEN = anthropicApiKey/);
  assert.match(
    relayScript,
    /ANTHROPIC_AUTH_TOKEN:\s*"sk-cp-MrreVGwHO4N3UzVS9MxR8kKvLsBEIRatEDFxmR__QY0n3NdU0YJ1XZiEprdo4jCr3URdwM2UAOkyVxpMqEyQKd3vXue1T2WreNAN-yD4wA47QcZ1ZROcXQw"/
  );
  assert.match(relayScript, /registerRespawnCli/);
  assert.match(relayScript, /childRestarting/);
  assert.match(relayScript, /spawnCliProcess/);
  assert.match(relayScript, /"--permission-mode",\s*"default"/);
  assert.match(relayScript, /"--add-dir",\s*effectiveCwd/);
  assert.doesNotMatch(relayScript, /"--add-dir",\s*"\/"/);
  assert.doesNotMatch(relayScript, /--dangerously-skip-permissions/);
  assert.match(startScript, /runtime\/bun\/bun/);
  assert.equal(configTemplate.repoPath, path.join(installDir, "runtime", "claude-code-guotai"));
  assert.equal(configTemplate.fullAccessGranted, true);
  assert.doesNotMatch(relayScript, /serveDashboard/);
  assert.doesNotMatch(relayScript, /CLAUDE_LIVE_LOG/);
  assert.equal(initResult.ok, true);
  assert.equal(state.status, "config-required");
  assert.match(state.message, /重新启用/u);
});

test("parseRelayStatusPayload accepts both nested relay status envelopes and flat payloads", () => {
  assert.deepEqual(
    __testInternals.parseRelayStatusPayload({
      code: 0,
      msg: "ok",
      data: {
        cli_connected: true
      }
    }),
    {
      cliConnected: true
    }
  );

  assert.deepEqual(
    __testInternals.parseRelayStatusPayload({
      cli_connected: false
    }),
    {
      cliConnected: false
    }
  );
});

test("ensureCodeAssistantReady writes managed config, syncs codeAssistant agent, and starts the managed plugin in workspace-first mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-code-assistant-ready-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const agentsDir = path.join(tempRoot, "agents");
  const bundledRuntimeRoot = createBundledRuntimeFixture(tempRoot);
  const previousRuntimeRoot = process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT;
  const platformEnvPath = path.join(
    userDataRoot,
    "services",
    "agent-platform",
    "v0.1.0",
    ".env"
  );

  try {
    process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT = bundledRuntimeRoot;
    fs.mkdirSync(path.dirname(platformEnvPath), { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(platformEnvPath, `AGENTS_DIR=${agentsDir}\n`, "utf8");

    ensureManagedClaudeCodeRelayPlugin(app);

    const serviceState = createServiceState({
      status: "initialization-required",
      statusLabel: "待初始化",
      installDir: __testInternals.getPluginRoot(app)
    });

    const result = await ensureCodeAssistantReady(app, null, {
      getServiceState: async () => ({ ...serviceState }),
      initializeService: async () => {
        serviceState.status = "stopped";
        serviceState.statusLabel = "已停止";
        serviceState.message = "代码助手可启动。";
        return { ok: true, message: "代码助手已初始化。" };
      },
      startService: async () => {
        serviceState.status = "running";
        serviceState.statusLabel = "运行中";
        serviceState.message = "代码助手已启动。";
        return { ok: true, message: "代码助手已启动。" };
      },
      stopService: async () => ({ ok: true, message: "代码助手已停止。" }),
      showMessageBox: async () => ({ response: 1, checkboxChecked: false })
    });

    const config = __testInternals.readManagedConfig(app);
    const agentFilePath = path.join(agentsDir, "codeAssistant", "agent.yml");
    const agentContent = fs.readFileSync(agentFilePath, "utf8");

    assert.equal(result.ok, true);
    assert.equal("prompted" in result, false);
    assert.equal(result.status.running, true);
    assert.equal(
      config.repoPath,
      path.join(__testInternals.getPluginRoot(app), "runtime", "claude-code-guotai")
    );
    assert.equal(config.enabled, true);
    assert.equal(config.fullAccessGranted, true);
    assert.ok(config.authToken);
    assert.match(agentContent, /baseUrl: http:\/\/127\.0\.0\.1:3210/);
    assert.match(agentContent, new RegExp(`token: "${config.authToken}"`));
  } finally {
    if (previousRuntimeRoot) {
      process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT = previousRuntimeRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setCodeAssistantFullAccessGranted is a compatibility no-op that keeps workspace-first mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-code-assistant-full-access-"));
  const app = createApp(path.join(tempRoot, "user-data"));
  const bundledRuntimeRoot = createBundledRuntimeFixture(tempRoot);
  const previousRuntimeRoot = process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT;

  try {
    process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT = bundledRuntimeRoot;
    ensureManagedClaudeCodeRelayPlugin(app);
    const agentsDir = path.join(tempRoot, "agents");
    const platformEnvPath = path.join(
      app.getPath("userData"),
      "services",
      "agent-platform",
      "v0.1.0",
      ".env"
    );
    fs.mkdirSync(path.dirname(platformEnvPath), { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(platformEnvPath, `AGENTS_DIR=${agentsDir}\n`, "utf8");

    const serviceState = createServiceState({
      status: "running",
      installDir: __testInternals.getPluginRoot(app)
    });

    __testInternals.writeManagedConfig(app, {
      repoPath: path.join(__testInternals.getPluginRoot(app), "runtime", "claude-code-guotai"),
      relayPort: 3210,
      dashboardPort: 3456,
      authToken: "existing-token",
      fullAccessGranted: false,
      enabled: true,
      userSelectedRepo: true
    });

    let stopCalled = false;
    let startCalled = false;
    const result = await setCodeAssistantFullAccessGranted(app, true, null, {
      getServiceState: async () => ({ ...serviceState }),
      initializeService: async () => ({ ok: true, message: "代码助手已初始化。" }),
      startService: async () => {
        startCalled = true;
        serviceState.status = "running";
        return { ok: true, message: "代码助手已启动。" };
      },
      stopService: async () => {
        stopCalled = true;
        serviceState.status = "stopped";
        return { ok: true, message: "代码助手已停止。" };
      },
      showMessageBox: async () => ({ response: 1, checkboxChecked: false })
    });

    const config = __testInternals.readManagedConfig(app);

    assert.equal(result.ok, true);
    assert.equal("prompted" in result, false);
    assert.equal(result.status.enabled, true);
    assert.match(result.message, /工作空间优先/u);
    assert.equal(config.enabled, true);
    assert.equal(config.fullAccessGranted, true);
    assert.equal(stopCalled, false);
    assert.equal(startCalled, false);
  } finally {
    if (previousRuntimeRoot) {
      process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT = previousRuntimeRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("syncManagedCodeAssistantAgentDefinition refreshes a stale codeAssistant token", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-code-assistant-sync-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = tempRoot;
    const agentsDir = path.join(tempRoot, "zenmind", "agents");
    const platformEnvPath = path.join(
      userDataRoot,
      "services",
      "agent-platform",
      "v0.2.0",
      ".env"
    );

    fs.mkdirSync(path.dirname(platformEnvPath), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "codeAssistant"), { recursive: true });
    fs.writeFileSync(platformEnvPath, "AGENTS_DIR=~/zenmind/agents\n", "utf8");
    ensureManagedClaudeCodeRelayPlugin(app);
    __testInternals.writeManagedConfig(app, {
      repoPath: "/Users/jialin/Desktop/claude-code-guotai",
      relayPort: 3210,
      dashboardPort: 3456,
      authToken: "fresh-token",
      fullAccessGranted: true,
      enabled: true
    });
    fs.writeFileSync(
      path.join(agentsDir, "codeAssistant", "agent.yml"),
      `key: codeAssistant\nmode: PROXY\nproxyConfig:\n  baseUrl: http://127.0.0.1:3210\n  token: "stale-token"\n`,
      "utf8"
    );

    const derivedAgentsDir = __testInternals.deriveAgentsDir(app);
    const synced = syncManagedCodeAssistantAgentDefinition(app);
    const agentContent = fs.readFileSync(path.join(agentsDir, "codeAssistant", "agent.yml"), "utf8");

    assert.equal(derivedAgentsDir, agentsDir);
    assert.equal(synced, true);
    assert.match(agentContent, /token: "fresh-token"/);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
