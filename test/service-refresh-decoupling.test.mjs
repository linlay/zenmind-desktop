import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  computeAssetSignature,
  isInstallHealthy,
  listMissingBundleDirectoryEntries,
  listMissingRuntimeFiles
} = require("../dist-electron/main/modules/services/manager/bundle-assets.js");
const envNormalization = require("../dist-electron/main/modules/services/manager/env-normalization.js");
const { isAssetNewerThanInstall } = require("../dist-electron/main/modules/services/manager/execution-layout.js");
const { writeInitializationState } = require("../dist-electron/main/modules/services/manager/state-files.js");

function createTempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("asset refresh follows initialization and bundle signatures, not service-owned config", (t) => {
  const root = createTempDir(t, "zenmind-asset-refresh-");
  const assetPath = path.join(root, "bundle.zip");
  const installDir = path.join(root, "installed");
  writeText(assetPath, "bundle-v1");
  assert.equal(isAssetNewerThanInstall(assetPath, installDir), true);
  writeInitializationState(installDir, {
    version: "1.0.0", status: "succeeded", updatedAt: new Date().toISOString(),
    assetSignature: computeAssetSignature(assetPath)
  });
  assert.equal(isAssetNewerThanInstall(assetPath, installDir), false);
  writeText(path.join(installDir, ".env"), "SERVICE_PRIVATE_SETTING=custom\n");
  writeText(path.join(installDir, "configs", "runtime.yml"), "privateKey: custom\n");
  assert.equal(isAssetNewerThanInstall(assetPath, installDir), false);
  writeText(assetPath, "bundle-v2-updated");
  assert.equal(isAssetNewerThanInstall(assetPath, installDir), true);
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
