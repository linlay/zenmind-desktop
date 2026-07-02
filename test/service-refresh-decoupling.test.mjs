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

test("agent-platform runtime directory is required when manifest declares it", (t) => {
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
  assert.deepEqual(listMissingRuntimeFiles(service, installDir), ["runtime"]);
  assert.equal(isInstallHealthy(service, installDir), false);
});

test("agent-platform bundled directory requires manifest runtime dir", (t) => {
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
  assert.deepEqual(listMissingBundleDirectoryEntries(service, bundleDir), ["runtime"]);
  fs.rmSync(path.join(bundleDir, "backend"), { recursive: true, force: true });
  assert.deepEqual(listMissingBundleDirectoryEntries(service, bundleDir), ["backend/agent-platform", "runtime"]);
});

test("agent-platform config and env migration helpers are no longer exported by Desktop", () => {
  assert.equal("normalizeAgentPlatformEnvContentForRuntime" in envNormalization, false);
  assert.equal("normalizeAgentPlatformDeprecatedConfigFiles" in envNormalization, false);
  assert.equal("normalizeAgentPlatformBashConfigContent" in envNormalization, false);
  assert.equal("normalizeAgentPlatformFileToolsConfigContent" in envNormalization, false);
  assert.equal("normalizeAgentPlatformDurationConfigContent" in envNormalization, false);
});
