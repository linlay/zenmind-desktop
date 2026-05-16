import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getPluginInstallDir, installPluginFromArchive, loadInstalledPlugins, uninstallPlugin } = require("../dist-electron/main/plugin-loader.js");
const {
  __testInternals: serviceManagerInternals,
  getInstallDir,
  getServiceState
} = require("../dist-electron/main/service-manager.js");
const {
  __testInternals: registryInternals,
  getService,
  registerPlugin
} = require("../dist-electron/main/service-registry.js");

function createApp(userDataRoot) {
  const tempRoot = path.dirname(userDataRoot);
  const homePath = path.join(tempRoot, "home");
  const appDataPath = path.join(tempRoot, "app-data");
  return {
    isPackaged: false,
    getPath(name) {
      switch (name) {
        case "home":
          return homePath;
        case "appData":
          return appDataPath;
        case "userData":
          return userDataRoot;
        default:
          assert.fail(`unexpected app.getPath(${name})`);
      }
    }
  };
}

function getLayeredDesktopRoot(userDataRoot) {
  return path.join(path.dirname(userDataRoot), "home", ".zenmind", ".desktop");
}

function getApplicationSupportRoot(userDataRoot) {
  return path.join(path.dirname(userDataRoot), "app-data", "ZenMind");
}

function getLayeredPluginConfigDir(userDataRoot, pluginId) {
  return path.join(getLayeredDesktopRoot(userDataRoot), "config", "plugins", pluginId);
}

function writePluginBundleRoot(bundleRoot, options = {}) {
  const pluginId = options.id ?? "test-plugin";
  const pluginName = options.name ?? "Test Plugin";
  const version = options.version ?? "v1.0.0";
  const startScriptContent = options.startScriptContent ?? "#!/usr/bin/env bash\necho start\n";
  const stopScriptContent = options.stopScriptContent ?? "#!/usr/bin/env bash\necho stop\n";

  fs.mkdirSync(path.join(bundleRoot, "run"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, ".env.example"), "PORT=9300\n", "utf8");
  fs.writeFileSync(
    path.join(bundleRoot, "manifest.json"),
    `${JSON.stringify(
      {
        id: pluginId,
        name: pluginName,
        kind: "plugin",
        version,
        description: "fixture plugin",
        frontend: {
          mode: "none"
        },
        scripts: {
          start: "start.sh",
          stop: "stop.sh"
        },
        configFiles: [
          {
            key: "env",
            label: ".env",
            relativePath: ".env",
            templateRelativePath: ".env.example",
            required: true
          }
        ],
        runtime: {
          pidRelativePath: "run/test-plugin.pid",
          logRelativePath: "run/test-plugin.log",
          requiredPaths: ["manifest.json", "start.sh", "stop.sh", ".env.example", "run"]
        },
        web: {
          routePath: "",
          portEnvKey: "PORT",
          defaultPort: 9300
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(bundleRoot, "start.sh"), startScriptContent, "utf8");
  fs.writeFileSync(path.join(bundleRoot, "stop.sh"), stopScriptContent, "utf8");
}

function createPluginArchiveFixture(tempRoot, options = {}) {
  const pluginId = options.id ?? "test-plugin";
  const suffix = options.suffix ?? "bundle";
  const fixtureRoot = path.join(tempRoot, `fixture-${suffix}`);
  const bundleRoot = path.join(fixtureRoot, pluginId);
  const archivePath = path.join(tempRoot, `${pluginId}-${suffix}.tar.gz`);

  writePluginBundleRoot(bundleRoot, options);
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, pluginId]);

  return {
    archivePath,
    bundleRoot
  };
}

function writeBuiltinBundleRoot(bundleRoot, options = {}) {
  const serviceId = options.id ?? "builtin-service";
  const serviceName = options.name ?? "Builtin Service";
  const version = options.version ?? "v1.0.0";
  const startScriptContent = options.startScriptContent ?? "#!/usr/bin/env bash\necho start\n";
  const stopScriptContent = options.stopScriptContent ?? "#!/usr/bin/env bash\necho stop\n";
  const deployScriptContent = options.deployScriptContent ?? [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'config_dir="${SERVICE_CONFIG_DIR:-$PWD}"',
    'mkdir -p "$config_dir"',
    'if [ ! -f "$config_dir/.env" ]; then cp .env.example "$config_dir/.env"; fi'
  ].join("\n") + "\n";

  fs.mkdirSync(path.join(bundleRoot, "run"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, ".env.example"), "PORT=9300\n", "utf8");
  fs.writeFileSync(
    path.join(bundleRoot, "manifest.json"),
    `${JSON.stringify(
      {
        id: serviceId,
        name: serviceName,
        kind: "builtin",
        version,
        description: "fixture builtin",
        frontend: {
          mode: "none"
        },
        scripts: {
          deploy: "deploy.sh",
          start: "start.sh",
          stop: "stop.sh"
        },
        configFiles: [
          {
            key: "env",
            label: ".env",
            relativePath: ".env",
            templateRelativePath: ".env.example",
            required: true
          }
        ],
        runtime: {
          pidRelativePath: `run/${serviceId}.pid`,
          logRelativePath: `run/${serviceId}.log`,
          requiredPaths: ["manifest.json", "deploy.sh", "start.sh", "stop.sh", ".env.example", "run"]
        },
        web: {
          routePath: "",
          portEnvKey: "PORT",
          defaultPort: 9300
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(bundleRoot, "deploy.sh"), deployScriptContent, "utf8");
  fs.writeFileSync(path.join(bundleRoot, "start.sh"), startScriptContent, "utf8");
  fs.writeFileSync(path.join(bundleRoot, "stop.sh"), stopScriptContent, "utf8");
  fs.chmodSync(path.join(bundleRoot, "deploy.sh"), 0o755);
}

function createBuiltinArchiveFixture(tempRoot, options = {}) {
  const serviceId = options.id ?? "builtin-service";
  const suffix = options.suffix ?? "bundle";
  const fixtureRoot = path.join(tempRoot, `fixture-${suffix}`);
  const bundleRoot = path.join(fixtureRoot, serviceId);
  const archivePath = path.join(tempRoot, `${serviceId}-${suffix}.tar.gz`);

  writeBuiltinBundleRoot(bundleRoot, options);
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, serviceId]);

  return {
    archivePath,
    bundleRoot
  };
}

test("installPluginFromArchive installs a tar.gz bundle and registers the plugin", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-install-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const { archivePath } = createPluginArchiveFixture(tempRoot, { suffix: "initial" });

  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const result = await installPluginFromArchive(app, archivePath);
  const installDir = getPluginInstallDir(app, "test-plugin");
  const state = await getServiceState(app, "test-plugin");

  assert.equal(result.ok, true);
  assert.equal(result.message, "插件 Test Plugin 已导入，请完成初始化。");
  assert.equal(result.serviceId, "test-plugin");
  assert.equal(fs.existsSync(path.join(installDir, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(installDir, "start.sh")), true);
  assert.equal(fs.existsSync(path.join(installDir, "stop.sh")), true);
  assert.equal(fs.existsSync(serviceManagerInternals.getInitializationStatePath(installDir)), false);
  assert.equal(state.status, "initialization-required");
  assert.equal(getService("test-plugin").name, "Test Plugin");
});

test("installPluginFromArchive installs builtin bundles via the services path and registers them", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-builtin-install-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const { archivePath } = createBuiltinArchiveFixture(tempRoot, { suffix: "import" });

  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const result = await installPluginFromArchive(app, archivePath);
  const definition = getService("builtin-service");
  const installDir = getInstallDir(app, definition);
  const state = await getServiceState(app, "builtin-service");

  assert.equal(result.ok, true);
  assert.equal(result.message, "内置服务 Builtin Service 已安装。");
  assert.equal(result.serviceId, "builtin-service");
  assert.equal(definition.kind, "builtin");
  assert.equal(definition.desktop.assetFileName, path.basename(archivePath));
  assert.equal(installDir, path.join(getApplicationSupportRoot(userDataRoot), "services", "builtin-service", "v1.0.0"));
  assert.equal(state.installDir, installDir);
  assert.equal(state.installed, true);
  assert.equal(state.status, "stopped");
  assert.equal(fs.existsSync(path.join(installDir, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(installDir, "start.sh")), true);
  assert.equal(fs.existsSync(path.join(installDir, "stop.sh")), true);
  assert.equal(fs.existsSync(getPluginInstallDir(app, "builtin-service")), false);
});

test("installPluginFromArchive preserves config and clears previous initialization state on reimport", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-reimport-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const firstArchive = createPluginArchiveFixture(tempRoot, { suffix: "first" }).archivePath;
  const secondArchive = createPluginArchiveFixture(tempRoot, {
    suffix: "second",
    startScriptContent: "#!/usr/bin/env bash\necho second start\n"
  }).archivePath;

  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await installPluginFromArchive(app, firstArchive);
  const installDir = getPluginInstallDir(app, "test-plugin");
  const configDir = getLayeredPluginConfigDir(userDataRoot, "test-plugin");
  const initStatePath = path.join(getLayeredDesktopRoot(userDataRoot), "state", "plugins", "test-plugin", "init-state.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, ".env"), "PORT=9500\n", "utf8");
  fs.mkdirSync(path.dirname(initStatePath), { recursive: true });
  fs.writeFileSync(
    initStatePath,
    `${JSON.stringify({ version: "v1.0.0", status: "succeeded", updatedAt: "2026-04-14T00:00:00.000Z" })}\n`,
    "utf8"
  );

  await installPluginFromArchive(app, secondArchive);

  assert.equal(fs.readFileSync(path.join(configDir, ".env"), "utf8"), "PORT=9500\n");
  assert.equal(fs.existsSync(initStatePath), false);
  assert.equal((await getServiceState(app, "test-plugin")).status, "initialization-required");
});

test("loadInstalledPlugins ignores builtin bundles accidentally left in the plugins directory", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-load-ignore-builtin-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const pluginDir = path.join(getApplicationSupportRoot(userDataRoot), "plugins", "builtin-service", "v1.0.0");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "manifest.json"),
    `${JSON.stringify(
      {
        id: "builtin-service",
        name: "Builtin Service",
        kind: "builtin",
        version: "v1.0.0",
        description: "fixture builtin",
        frontend: {
          mode: "none"
        },
        scripts: {
          start: "start.sh",
          stop: "stop.sh"
        },
        runtime: {
          pidRelativePath: "run/builtin-service.pid",
          logRelativePath: "run/builtin-service.log",
          requiredPaths: ["manifest.json"]
        },
        web: {
          routePath: "",
          portEnvKey: "PORT",
          defaultPort: 9300
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  loadInstalledPlugins(app);

  assert.throws(() => getService("builtin-service"), /unknown service id: builtin-service/);
});

test("uninstallPlugin stops a running plugin before deleting its install dir", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-uninstall-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const stopMarkerPath = path.join(tempRoot, "stop-called.txt");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  registerPlugin({
    id: "test-plugin",
    name: "Test Plugin",
    kind: "plugin",
    version: "v1.0.0",
    description: "fixture plugin",
    frontend: {
      mode: "none"
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      pidRelativePath: "run/test-plugin.pid",
      logRelativePath: "run/test-plugin.log",
      requiredPaths: ["manifest.json", "start.sh", "stop.sh"]
    },
    web: {
      routePath: "",
      portEnvKey: "PORT",
      defaultPort: 9300
    }
  });

  const installDir = getPluginInstallDir(app, "test-plugin");
  const configDir = getLayeredPluginConfigDir(userDataRoot, "test-plugin");
  const stateDir = path.join(getLayeredDesktopRoot(userDataRoot), "state", "plugins", "test-plugin");
  const stopScriptPath = path.join(installDir, "stop.sh");
  fs.mkdirSync(path.join(stateDir, "pid"), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "manifest.json"), "{\"id\":\"test-plugin\"}\n", "utf8");
  fs.writeFileSync(path.join(configDir, ".env"), "PORT=9300\n", "utf8");
  fs.writeFileSync(path.join(installDir, "start.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  fs.writeFileSync(
    stopScriptPath,
    `#!/usr/bin/env bash
rm -f "$SERVICE_STATE_DIR/pid/test-plugin.pid"
printf stopped > ${JSON.stringify(stopMarkerPath)}
`,
    "utf8"
  );
  fs.writeFileSync(path.join(stateDir, "pid", "test-plugin.pid"), `${process.pid}\n`, "utf8");
  const initStatePath = path.join(stateDir, "init-state.json");
  fs.mkdirSync(path.dirname(initStatePath), { recursive: true });
  fs.writeFileSync(
    initStatePath,
    `${JSON.stringify({ version: "v1.0.0", status: "succeeded", updatedAt: "2026-04-14T00:00:00.000Z" })}\n`,
    "utf8"
  );
  fs.chmodSync(path.join(installDir, "start.sh"), 0o755);
  fs.chmodSync(stopScriptPath, 0o755);

  const result = await uninstallPlugin(app, "test-plugin");

  assert.equal(result.ok, true);
  assert.equal(result.message, "插件 Test Plugin 已卸载。");
  assert.equal(fs.existsSync(stopMarkerPath), true);
  assert.equal(fs.existsSync(installDir), false);
  assert.throws(() => getService("test-plugin"), /unknown service id: test-plugin/);
});
