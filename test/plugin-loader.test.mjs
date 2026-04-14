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
  __testInternals: registryInternals,
  getService,
  registerPlugin
} = require("../dist-electron/main/service-registry.js");

function createApp(userDataRoot) {
  return {
    isPackaged: false,
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

test("installPluginFromArchive installs a tar.gz bundle and registers the plugin", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-install-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const fixtureRoot = path.join(tempRoot, "fixture-root");
  const bundleRoot = path.join(fixtureRoot, "test-plugin");
  const archivePath = path.join(tempRoot, "test-plugin-v1.0.0.tar.gz");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(bundleRoot, "run"), { recursive: true });
  fs.writeFileSync(
    path.join(bundleRoot, "manifest.json"),
    `${JSON.stringify(
      {
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
          requiredPaths: ["manifest.json", "start.sh", "stop.sh", "run"]
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
  fs.writeFileSync(path.join(bundleRoot, "start.sh"), "#!/usr/bin/env bash\necho start\n", "utf8");
  fs.writeFileSync(path.join(bundleRoot, "stop.sh"), "#!/usr/bin/env bash\necho stop\n", "utf8");
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, "test-plugin"]);

  const result = await installPluginFromArchive(app, archivePath);
  const installDir = getPluginInstallDir(app, "test-plugin");

  assert.equal(result.ok, true);
  assert.equal(result.message, "插件 Test Plugin 已安装。");
  assert.equal(result.serviceId, "test-plugin");
  assert.equal(fs.existsSync(path.join(installDir, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(installDir, "start.sh")), true);
  assert.equal(fs.existsSync(path.join(installDir, "stop.sh")), true);
  assert.equal(getService("test-plugin").name, "Test Plugin");
});

test("installPluginFromArchive rejects builtin bundles with a helpful message", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-builtin-reject-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const fixtureRoot = path.join(tempRoot, "fixture-root");
  const bundleRoot = path.join(fixtureRoot, "builtin-service");
  const archivePath = path.join(tempRoot, "builtin-service-v1.0.0.tar.gz");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(bundleRoot, "run"), { recursive: true });
  fs.writeFileSync(
    path.join(bundleRoot, "manifest.json"),
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
          requiredPaths: ["manifest.json", "start.sh", "stop.sh", "run"]
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
  fs.writeFileSync(path.join(bundleRoot, "start.sh"), "#!/usr/bin/env bash\necho start\n", "utf8");
  fs.writeFileSync(path.join(bundleRoot, "stop.sh"), "#!/usr/bin/env bash\necho stop\n", "utf8");
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, "builtin-service"]);

  const result = await installPluginFromArchive(app, archivePath);

  assert.equal(result.ok, false);
  assert.match(result.message, /是内置服务/);
  assert.equal(result.serviceId, "builtin-service");
  assert.equal(fs.existsSync(getPluginInstallDir(app, "builtin-service")), false);
  assert.throws(() => getService("builtin-service"), /unknown service id: builtin-service/);
});

test("loadInstalledPlugins ignores builtin bundles accidentally left in the plugins directory", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-load-ignore-builtin-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const pluginDir = path.join(userDataRoot, "plugins", "builtin-service");
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
  const stopScriptPath = path.join(installDir, "stop.sh");
  fs.mkdirSync(path.join(installDir, "run"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "manifest.json"), "{\"id\":\"test-plugin\"}\n", "utf8");
  fs.writeFileSync(path.join(installDir, ".env"), "PORT=9300\n", "utf8");
  fs.writeFileSync(path.join(installDir, "start.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  fs.writeFileSync(
    stopScriptPath,
    `#!/usr/bin/env bash
rm -f run/test-plugin.pid
printf stopped > ${JSON.stringify(stopMarkerPath)}
`,
    "utf8"
  );
  fs.writeFileSync(path.join(installDir, "run", "test-plugin.pid"), `${process.pid}\n`, "utf8");
  fs.chmodSync(path.join(installDir, "start.sh"), 0o755);
  fs.chmodSync(stopScriptPath, 0o755);

  const result = await uninstallPlugin(app, "test-plugin");

  assert.equal(result.ok, true);
  assert.equal(result.message, "插件 Test Plugin 已卸载。");
  assert.equal(fs.existsSync(stopMarkerPath), true);
  assert.equal(fs.existsSync(installDir), false);
  assert.throws(() => getService("test-plugin"), /unknown service id: test-plugin/);
});
