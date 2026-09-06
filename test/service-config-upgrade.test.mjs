import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  completeDesktopServiceConfigUpgrade,
  prepareDesktopServiceConfigUpgrade,
  recordDesktopServiceConfigCoreHealthFailure
} = require("../dist-electron/main/modules/services/manager/desktop-config-upgrade.js");
const {
  __testInternals: serviceManagerInternals
} = require("../dist-electron/main/modules/services/manager/index.js");
const { getDataRoot } = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");

const CURRENT_PORTS = {
  "agent-container-hub": 7079,
  "identity-center": 7076,
  "agent-platform": 7078,
  "agent-webclient": 7080
};

function createTestApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-service-config-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    app: {
      getPath(name) {
        if (name === "home") return path.join(root, "home");
        if (name === "appData") return path.join(root, "app-data");
        if (name === "userData") return path.join(root, "user-data");
        return root;
      }
    }
  };
}

function callbacks(overrides = {}) {
  return {
    currentDesktopDefaultPorts: CURRENT_PORTS,
    prepareDesktopConfiguration: async ({ apply }) => ({
      sourceZipPath: "/validated/env.zip",
      previousSourceZipPath: "/validated/previous-env.zip",
      sha256: "a".repeat(64),
      size: 1024,
      apply
    }),
    stopService: async () => {},
    installCurrentService: async () => {},
    resetServiceConfig: async () => {},
    ...overrides
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("fresh install writes the Desktop version only after core health succeeds", async (t) => {
  const { app } = createTestApp(t);
  const calls = [];
  const prepared = await prepareDesktopServiceConfigUpgrade(app, "0.3.27", callbacks({
    isFirstDesktopInstall: true,
    stopService: async (serviceId) => calls.push(["stop", serviceId]),
    installCurrentService: async (serviceId) => calls.push(["install", serviceId]),
    resetServiceConfig: async (serviceId) => calls.push(["reset", serviceId])
  }));

  assert.equal(prepared.mode, "fresh-install");
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(__testInternals.getVersionStatePath(app, process.platform)), false);
  assert.equal(fs.existsSync(__testInternals.getUpgradeJournalPath(app, process.platform)), true);
  assert.equal(fs.existsSync(__testInternals.getServiceBackupsRoot(app, process.platform)), false);

  completeDesktopServiceConfigUpgrade(app, "v0.3.27");
  assert.equal(__testInternals.readVersionState(app, process.platform).desktopVersion, "v0.3.27");
  assert.equal(fs.existsSync(__testInternals.getUpgradeJournalPath(app, process.platform)), false);
});

test("legacy config is reset in fixed order and Desktop-owned config is strictly normalized", async (t) => {
  const { app } = createTestApp(t);
  const desktopRoot = getDataRoot(app);
  fs.mkdirSync(path.join(desktopRoot, "config", "services", "identity-center"), { recursive: true });
  fs.writeFileSync(
    path.join(desktopRoot, "config", "services", "identity-center", ".env"),
    "SERVER_PORT=99999\n",
    "utf8"
  );
  writeJson(path.join(desktopRoot, "config", "desktop", "service-port-defaults.json"), {
    schemaVersion: 1,
    services: {
      "agent-platform": { defaultPort: 99999 },
      "identity-center": { defaultPort: 19076 },
      unknown: { defaultPort: 19000 }
    }
  });
  writeJson(path.join(desktopRoot, "config", "desktop", "service-lifecycle-args.json"), {
    schemaVersion: 1,
    services: {
      "identity-center": {
        lifecycleArgs: {
          deploy: ["--unknown", "old", "--auth-issuer", "https://issuer.example.test"],
          start: ["--daemon"]
        }
      },
      "agent-platform": {
        lifecycleArgs: {
          deploy: [
            "--runtime-dir", "/old/runtime",
            "--coder-model-key", "coder-current",
            "--coder-reasoning-effort", "low",
            "--unknown", "old"
          ],
          stop: ["--force"]
        }
      },
      "agent-webclient": {
        lifecycleArgs: {
          start: ["--base-url", "not-a-url", "--unknown", "old"]
        }
      }
    }
  });

  const calls = [];
  const prepared = await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", callbacks({
    isFirstDesktopInstall: false,
    stopService: async (serviceId) => calls.push(["stop", serviceId]),
    installCurrentService: async (serviceId) => calls.push(["install", serviceId]),
    resetServiceConfig: async (serviceId, context) => calls.push(["reset", serviceId, context])
  }));

  assert.equal(prepared.mode, "version-change");
  assert.equal(prepared.journal.fromVersion, "legacy");
  assert.deepEqual(
    calls.map((call) => call.slice(0, 2)),
    [
      ["stop", "agent-container-hub"], ["install", "agent-container-hub"], ["reset", "agent-container-hub"],
      ["stop", "identity-center"], ["install", "identity-center"], ["reset", "identity-center"],
      ["stop", "agent-platform"], ["install", "agent-platform"], ["reset", "agent-platform"],
      ["stop", "agent-webclient"], ["install", "agent-webclient"], ["reset", "agent-webclient"]
    ]
  );
  for (const call of calls.filter((item) => item[0] === "reset")) {
    assert.equal(path.isAbsolute(call[2].backupDir), true);
    assert.equal(call[2].fromVersion, "legacy");
    assert.equal(call[2].toVersion, "v0.3.27");
    assert.equal(call[2].runtimeResourceSource, "/validated/env.zip");
    assert.equal(call[2].runtimeResourceMode, "version-change");
  }

  const ports = JSON.parse(fs.readFileSync(
    path.join(desktopRoot, "config", "desktop", "service-port-defaults.json"),
    "utf8"
  ));
  assert.deepEqual(ports, {
    schemaVersion: 1,
    services: {
      "agent-container-hub": { defaultPort: 7079 },
      "agent-platform": { defaultPort: 7078 },
      "agent-webclient": { defaultPort: 7080 },
      "identity-center": { defaultPort: 19076 }
    }
  });
  const lifecycle = JSON.parse(fs.readFileSync(
    path.join(desktopRoot, "config", "desktop", "service-lifecycle-args.json"),
    "utf8"
  ));
  assert.deepEqual(lifecycle, {
    schemaVersion: 1,
    services: {
      "identity-center": {
        lifecycleArgs: { deploy: ["--auth-issuer", "https://issuer.example.test"] }
      },
      "agent-platform": {
        lifecycleArgs: {
          deploy: [
            "--coder-model-key", "coder-current",
            "--coder-reasoning-effort", "LOW"
          ]
        }
      },
      "agent-webclient": {
        lifecycleArgs: { start: ["--base-url", "http://127.0.0.1:7078"] }
      }
    }
  });
});

test("failed deploy resumes without rerunning completed service resets", async (t) => {
  const { app } = createTestApp(t);
  const desktopRoot = getDataRoot(app);
  fs.mkdirSync(path.join(desktopRoot, "config", "services", "agent-container-hub"), { recursive: true });
  fs.writeFileSync(path.join(desktopRoot, "config", "services", "agent-container-hub", ".env"), "ENGINE=local\n", "utf8");
  let failIdentity = true;
  const resetCalls = [];
  const preparationContexts = [];
  const upgradeCallbacks = callbacks({
    prepareDesktopConfiguration: async (context) => {
      preparationContexts.push(context);
      return {
        sourceZipPath: "/validated/env.zip",
        previousSourceZipPath: "/validated/previous-env.zip",
        sha256: "a".repeat(64),
        size: 1024
      };
    },
    resetServiceConfig: async (serviceId) => {
      resetCalls.push(serviceId);
      if (serviceId === "identity-center" && failIdentity) {
        throw new Error("injected deploy failure");
      }
    }
  });

  const failed = await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", upgradeCallbacks);
  assert.deepEqual(failed.failures, ["identity-center: injected deploy failure"]);
  assert.equal(__testInternals.readVersionState(app, process.platform), null);
  assert.equal(failed.journal.services["agent-container-hub"].status, "succeeded");
  assert.equal(failed.journal.services["identity-center"].status, "failed");

  failIdentity = false;
  resetCalls.length = 0;
  const resumed = await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", upgradeCallbacks);
  assert.deepEqual(resumed.failures, []);
  assert.deepEqual(resetCalls, ["identity-center", "agent-platform", "agent-webclient"]);
  assert.equal(preparationContexts[0].sourceZipPath, undefined);
  assert.equal(preparationContexts[0].expectedSha256, undefined);
  assert.match(preparationContexts[0].inputDir, /input$/u);
  assert.equal(preparationContexts[1].sourceZipPath, "/validated/env.zip");
  assert.equal(preparationContexts[1].expectedSha256, "a".repeat(64));
  assert.equal(preparationContexts[1].apply, false);

  recordDesktopServiceConfigCoreHealthFailure(app, "v0.3.27", ["agent-platform: injected health failure"]);
  resetCalls.length = 0;
  const healthRetry = await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", upgradeCallbacks);
  assert.deepEqual(healthRetry.failures, []);
  assert.deepEqual(resetCalls, ["agent-platform"]);

  const backupRoot = healthRetry.journal.backupRoot;
  const olderBackup = path.join(path.dirname(backupRoot), "v0.3.25-to-v0.3.26");
  fs.mkdirSync(olderBackup, { recursive: true });
  fs.mkdirSync(path.join(backupRoot, "identity-center.failed"), { recursive: true });
  completeDesktopServiceConfigUpgrade(app, "v0.3.27");
  assert.equal(fs.existsSync(olderBackup), false);
  assert.equal(fs.existsSync(path.join(backupRoot, "identity-center.failed")), false);
  assert.equal(fs.existsSync(backupRoot), true);
});

test("any Desktop VERSION string change, including downgrade, starts a new reset transaction", async (t) => {
  const { app } = createTestApp(t);
  await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", callbacks({
    isFirstDesktopInstall: true
  }));
  completeDesktopServiceConfigUpgrade(app, "v0.3.27");

  const resetCalls = [];
  const downgraded = await prepareDesktopServiceConfigUpgrade(app, "v0.3.26", callbacks({
    resetServiceConfig: async (serviceId) => resetCalls.push(serviceId)
  }));
  assert.equal(downgraded.mode, "version-change");
  assert.equal(downgraded.journal.fromVersion, "v0.3.27");
  assert.equal(downgraded.journal.toVersion, "v0.3.26");
  assert.deepEqual(resetCalls, [
    "agent-container-hub",
    "identity-center",
    "agent-platform",
    "agent-webclient"
  ]);
});

test("a version change supersedes an unfinished transaction for another Desktop version", async (t) => {
  const { app } = createTestApp(t);
  await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", callbacks({
    isFirstDesktopInstall: true
  }));
  completeDesktopServiceConfigUpgrade(app, "v0.3.27");

  const failedUpgrade = await prepareDesktopServiceConfigUpgrade(app, "v0.3.28", callbacks({
    resetServiceConfig: async (serviceId) => {
      if (serviceId === "identity-center") {
        throw new Error("injected deploy failure");
      }
    }
  }));
  assert.deepEqual(failedUpgrade.failures, ["identity-center: injected deploy failure"]);

  const resetCalls = [];
  const downgraded = await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", callbacks({
    resetServiceConfig: async (serviceId) => resetCalls.push(serviceId)
  }));
  assert.equal(downgraded.mode, "version-change");
  assert.equal(downgraded.journal.fromVersion, "v0.3.28");
  assert.equal(downgraded.journal.toVersion, "v0.3.27");
  assert.deepEqual(resetCalls, [
    "agent-container-hub",
    "identity-center",
    "agent-platform",
    "agent-webclient"
  ]);
});

test("Desktop reset deploy flags use the unified service interface", () => {
  assert.deepEqual(
    serviceManagerInternals.appendDesktopConfigResetDeployArgs(["deploy.sh", "--output-dir", "/config"], {
      backupDir: "/config-backups/v1-to-v2/identity-center",
      fromVersion: "v1",
      toVersion: "v2"
    }),
    [
      "deploy.sh", "--output-dir", "/config",
      "--desktop-config-reset",
      "--desktop-config-backup-dir", "/config-backups/v1-to-v2/identity-center",
      "--desktop-version-from", "v1",
      "--desktop-version-to", "v2"
    ]
  );
  assert.deepEqual(
    serviceManagerInternals.appendAgentPlatformRuntimeResourceDeployArgs(
      ["deploy.sh", "--desktop-version-from", "v1", "--desktop-version-to", "v2"],
      { desktop: { runtimeResources: "v1" } },
      {
        backupDir: "/backup",
        fromVersion: "v1",
        toVersion: "v2",
        runtimeResourceSource: "/validated/env.zip",
        runtimeResourcePreviousSource: "/validated/previous.zip",
        runtimeResourceMode: "version-change"
      },
      "desktop-device-123"
    ),
    [
      "deploy.sh", "--desktop-version-from", "v1", "--desktop-version-to", "v2",
      "--runtime-resource-source", "/validated/env.zip",
      "--runtime-resource-previous-source", "/validated/previous.zip",
      "--runtime-resource-mode", "version-change",
      "--desktop-device-id", "desktop-device-123"
    ]
  );
  assert.throws(
    () => serviceManagerInternals.appendAgentPlatformRuntimeResourceDeployArgs(
      ["deploy.sh"],
      { desktop: {} },
      {
        backupDir: "/backup",
        fromVersion: "v1",
        toVersion: "v2",
        runtimeResourceSource: "/validated/env.zip"
      },
      "desktop-device-123"
    ),
    /runtimeResources=v1/u
  );
});

test("Desktop configuration preflight fails before any service is stopped", async (t) => {
  const { app } = createTestApp(t);
  const calls = [];
  const result = await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", callbacks({
    prepareDesktopConfiguration: async () => {
      throw new Error("invalid desktop-init.json");
    },
    stopService: async (serviceId) => calls.push(serviceId)
  }));
  assert.deepEqual(result.failures, [
    "Desktop environment configuration failed: invalid desktop-init.json"
  ]);
  assert.deepEqual(calls, []);
  assert.equal(result.journal.desktopConfig.status, "failed");
});

test("development env input request keeps the upgrade pending without touching services", async (t) => {
  const { app } = createTestApp(t);
  const calls = [];
  const result = await prepareDesktopServiceConfigUpgrade(app, "v0.3.40", callbacks({
    prepareDesktopConfiguration: async () => ({ inputRequired: { message: "" } }),
    stopService: async (serviceId) => calls.push(["stop", serviceId]),
    installCurrentService: async (serviceId) => calls.push(["install", serviceId]),
    resetServiceConfig: async (serviceId) => calls.push(["reset", serviceId])
  }));

  assert.deepEqual(calls, []);
  assert.deepEqual(result.inputRequired, {
    kind: "env-zip",
    message: "",
    fromVersion: "legacy",
    toVersion: "v0.3.40"
  });
  assert.equal(result.journal.status, "in-progress");
  assert.equal(result.journal.desktopConfig.status, "pending");
  for (const service of Object.values(result.journal.services)) {
    assert.equal(service.status, "pending");
    assert.equal(service.attempts, 0);
  }
});

test("a previous missing bundled env failure recovers to development input request", async (t) => {
  const { app } = createTestApp(t);
  const failed = await prepareDesktopServiceConfigUpgrade(app, "v0.3.40", callbacks({
    prepareDesktopConfiguration: async () => {
      throw new Error("The bundled env.zip was not found");
    }
  }));
  assert.equal(failed.journal.desktopConfig.status, "failed");

  const recovered = await prepareDesktopServiceConfigUpgrade(app, "v0.3.40", callbacks({
    prepareDesktopConfiguration: async () => ({ inputRequired: { message: "" } })
  }));
  assert.equal(recovered.inputRequired.kind, "env-zip");
  assert.equal(recovered.journal.desktopConfig.status, "pending");
  assert.equal(recovered.journal.desktopConfig.lastError, undefined);
  assert.equal(recovered.journal.lastError, undefined);
  for (const service of Object.values(recovered.journal.services)) {
    assert.equal(service.attempts, 0);
  }
});

test("successful version commit removes the staged development env input", async (t) => {
  const { app } = createTestApp(t);
  let inputDir = "";
  const prepared = await prepareDesktopServiceConfigUpgrade(app, "v0.3.40", callbacks({
    prepareDesktopConfiguration: async (context) => {
      inputDir = context.inputDir;
      fs.mkdirSync(inputDir, { recursive: true });
      const sourceZipPath = path.join(inputDir, `env-${"b".repeat(64)}.zip`);
      fs.writeFileSync(sourceZipPath, "zip", "utf8");
      return {
        sourceZipPath,
        sha256: "b".repeat(64),
        size: 3
      };
    }
  }));
  assert.equal(prepared.failures.length, 0);
  assert.equal(fs.existsSync(inputDir), true);

  completeDesktopServiceConfigUpgrade(app, "v0.3.40");
  assert.equal(fs.existsSync(inputDir), false);
});

test("same completed Desktop version does not read env.zip or run deploy", async (t) => {
  const { app } = createTestApp(t);
  await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", callbacks({
    isFirstDesktopInstall: true
  }));
  completeDesktopServiceConfigUpgrade(app, "v0.3.27");
  let preflightCalls = 0;
  let resetCalls = 0;
  const result = await prepareDesktopServiceConfigUpgrade(app, "v0.3.27", callbacks({
    prepareDesktopConfiguration: async () => {
      preflightCalls += 1;
      throw new Error("same version must not inspect env.zip");
    },
    resetServiceConfig: async () => {
      resetCalls += 1;
    }
  }));
  assert.equal(result.mode, "none");
  assert.equal(preflightCalls, 0);
  assert.equal(resetCalls, 0);
});
