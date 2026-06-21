import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  agentPlatformInstallNeedsRefresh,
  agentWebclientInstallNeedsRefresh,
  serviceInstallNeedsRefresh,
  identityCenterInstallNeedsRefresh
} = require("../dist-electron/main/services/manager/install-refresh.js");
const {
  isInstallHealthy,
  listMissingBundleDirectoryEntries,
  listMissingRuntimeFiles
} = require("../dist-electron/main/services/manager/bundle-assets.js");
const envNormalization = require("../dist-electron/main/services/manager/env-normalization.js");
const {
  normalizeAgentPlatformEnvContentForRuntime
} = envNormalization;

function createTempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("agent-platform refresh ignores optional config key names", (t) => {
  const installDir = createTempDir(t, "zenmind-platform-refresh-");
  writeJson(path.join(installDir, "manifest.json"), {
    id: "agent-platform",
    runtime: {
      pidRelativePath: "run/agent-platform.pid",
      logRelativePath: "run/agent-platform.log"
    },
    configFiles: [
      { key: "env", relativePath: ".env" },
      { key: "runtime", relativePath: "configs/runtime.yml" },
      { key: "tools", relativePath: "configs/tools.yml" },
      { key: "ai-tools", relativePath: "configs/ai-tools.yml" }
    ]
  });

  assert.equal(agentPlatformInstallNeedsRefresh(installDir), false);
  assert.equal(serviceInstallNeedsRefresh({ id: "agent-platform" }, installDir), false);
});

test("agent-webclient refresh ignores stale backend marker files", (t) => {
  const installDir = createTempDir(t, "zenmind-webclient-refresh-");
  writeJson(path.join(installDir, "manifest.json"), {
    id: "agent-webclient",
    frontend: { hostManaged: false },
    backend: { entry: "backend/server.cjs" },
    runtime: { requiredPaths: ["backend/server.cjs", "backend/package.json"] }
  });
  writeText(path.join(installDir, "backend", "server.cjs"), "console.log('legacy');\n");
  writeText(path.join(installDir, "backend", "package.json"), "{}\n");
  writeText(
    path.join(installDir, "scripts", "program-common.sh"),
    "BACKEND_ENTRY=backend/server.cjs\nBACKEND_NODE_MODULES_DIR=backend/node_modules\n"
  );

  assert.equal(agentWebclientInstallNeedsRefresh(installDir), false);
  assert.equal(serviceInstallNeedsRefresh({ id: "agent-webclient" }, installDir), false);
});

test("identity-center refresh ignores frontend route and launcher internals", (t) => {
  const installDir = createTempDir(t, "identity-center-refresh-");
  writeJson(path.join(installDir, "manifest.json"), {
    id: "identity-center",
    frontend: { entry: "/" },
    web: { routePath: "/" }
  });
  writeText(path.join(installDir, ".env.example"), "SERVER_PORT=9000\n");
  writeText(path.join(installDir, ".env"), "SERVER_PORT=9000\n");
  writeText(path.join(installDir, "frontend", "dist", "index.html"), "<script src=\"/assets/main.js\"></script>\n");
  writeText(path.join(installDir, "scripts", "program-common.sh"), "nohup \"$NODE_CMD\" server.js\n");

  assert.equal(identityCenterInstallNeedsRefresh(installDir), false);
  assert.equal(serviceInstallNeedsRefresh({ id: "identity-center" }, installDir), false);
});

test("runtime.requiredPaths still drives generic install health", (t) => {
  const installDir = createTempDir(t, "zenmind-runtime-health-");
  const service = {
    runtime: {
      requiredPaths: ["backend/agent-platform", "start.sh"]
    }
  };
  writeText(path.join(installDir, "start.sh"), "#!/usr/bin/env bash\n");

  assert.deepEqual(listMissingRuntimeFiles(service, installDir), ["backend/agent-platform"]);
  assert.equal(isInstallHealthy(service, installDir), false);
});

test("agent-platform runtime directory is repairable when app packaging drops empty dirs", (t) => {
  const installDir = createTempDir(t, "zenmind-platform-runtime-dir-health-");
  const service = {
    id: "agent-platform",
    runtime: {
      requiredPaths: ["backend/agent-platform", "start.sh", "runtime"]
    }
  };
  writeText(path.join(installDir, "backend", "agent-platform"), "binary\n");
  writeText(path.join(installDir, "start.sh"), "#!/usr/bin/env bash\n");

  assert.equal(fs.existsSync(path.join(installDir, "runtime")), false);
  assert.deepEqual(listMissingRuntimeFiles(service, installDir), []);
  assert.equal(isInstallHealthy(service, installDir), true);
});

test("agent-platform bundled directory tolerates missing empty runtime dir only", (t) => {
  const bundleDir = createTempDir(t, "zenmind-platform-bundle-dir-health-");
  const service = {
    id: "agent-platform",
    desktop: {
      bundleTopLevelDir: "agent-platform"
    },
    runtime: {
      requiredPaths: ["backend/agent-platform", "configs", "runtime"]
    }
  };
  writeText(path.join(bundleDir, "backend", "agent-platform"), "binary\n");
  fs.mkdirSync(path.join(bundleDir, "configs"), { recursive: true });

  assert.equal(fs.existsSync(path.join(bundleDir, "runtime")), false);
  assert.deepEqual(listMissingBundleDirectoryEntries(service, bundleDir), []);
  fs.rmSync(path.join(bundleDir, "backend"), { recursive: true, force: true });
  assert.deepEqual(listMissingBundleDirectoryEntries(service, bundleDir), ["backend/agent-platform"]);
});

test("agent-platform env normalization keeps only Desktop-owned cleanup", () => {
  const output = normalizeAgentPlatformEnvContentForRuntime([
    "RUNTIME_DIR=/legacy/runtime",
    "AGENTS_DIR=/legacy/agents",
    "LOCAL_CLI_ACP_RELAY_PORT=3220",
    "AGENT_WS_ENABLED=true",
    "GATEWAY_USER_ID=user-1",
    "PROVIDER_APIKEY_KEY_PART=0.1.0",
    "CUSTOM=value",
    ""
  ].join("\n"));

  assert.match(output, /^RUNTIME_DIR=\/legacy\/runtime$/m);
  assert.doesNotMatch(output, /^AGENTS_DIR=/m);
  assert.doesNotMatch(output, /^LOCAL_CLI_ACP_RELAY_PORT=/m);
  assert.doesNotMatch(output, /^AGENT_WS_ENABLED=/m);
  assert.match(output, /^GATEWAY_USER_ID=user-1$/m);
  assert.match(output, /^PROVIDER_APIKEY_KEY_PART=0.1.0$/m);
  assert.match(output, /^CUSTOM=value$/m);
});

test("agent-platform YAML migration helpers are no longer exported by Desktop", () => {
  assert.equal("normalizeAgentPlatformDeprecatedConfigFiles" in envNormalization, false);
  assert.equal("normalizeAgentPlatformBashConfigContent" in envNormalization, false);
  assert.equal("normalizeAgentPlatformFileToolsConfigContent" in envNormalization, false);
  assert.equal("normalizeAgentPlatformDurationConfigContent" in envNormalization, false);
});

test("agent-platform provider registry is not used to infer provider key env", (t) => {
  const root = createTempDir(t, "desktop-provider-registry-");
  writeText(path.join(root, "registries", "providers", "openai.yml"), "apiKey: AES(ciphertext)\n");

  const output = normalizeAgentPlatformEnvContentForRuntime([
    `REGISTRIES_DIR=${path.join(root, "registries")}`,
    "CUSTOM=value",
    ""
  ].join("\n"));

  assert.doesNotMatch(output, /^PROVIDER_APIKEY_KEY_PART=/m);
  assert.match(output, /^CUSTOM=value$/m);
});
