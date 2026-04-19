import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  getServiceState,
  getInstallDir,
  initializeService,
  installBuiltinService,
  readServiceLog,
  readServiceConfig,
  startService,
  stopService
} = require("../dist-electron/main/service-manager.js");
const { loadBuiltinServices } = require("../dist-electron/main/builtin-loader.js");
const {
  __testInternals: registryInternals,
  getBuiltinService,
  registerPlugin
} = require("../dist-electron/main/service-registry.js");
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..", "..");

function currentManifestOs() {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return process.platform;
  }
}

function findCurrentPlatformReleaseArchive(serviceId) {
  const releaseDir = path.join(WORKSPACE_ROOT, serviceId, "dist", "release");
  const currentOs = currentManifestOs();
  const releaseCandidates = fs.existsSync(releaseDir)
    ? fs.readdirSync(releaseDir).map((entry) => path.join(releaseDir, entry))
    : [];
  const workspaceCandidates = fs
    .readdirSync(WORKSPACE_ROOT)
    .filter((entry) => entry.startsWith(`${serviceId}-`) && (entry.endsWith(".tar.gz") || entry.endsWith(".zip")))
    .map((entry) => path.join(WORKSPACE_ROOT, entry));

  return [...releaseCandidates, ...workspaceCandidates].find((archivePath) => {
    const archiveName = path.basename(archivePath);
    return archiveName.includes(`-${currentOs}-`) && (archiveName.endsWith(".tar.gz") || archiveName.endsWith(".zip"));
  });
}

function createCurrentPlatformAssetsFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtins-"));
  const assetsRoot = path.join(tempRoot, "services");
  const containerHubBundleRoot = path.join(tempRoot, "agent-container-hub");
  const containerHubAssetDir = path.join(assetsRoot, "agent-container-hub");
  const containerHubArchivePath = path.join(
    containerHubAssetDir,
    "agent-container-hub-v0.1.0-darwin-arm64.tar.gz"
  );

  writeContainerHubBundleRoot(containerHubBundleRoot);
  fs.mkdirSync(containerHubAssetDir, { recursive: true });
  execFileSync("tar", ["-czf", containerHubArchivePath, "-C", tempRoot, "agent-container-hub"]);

  for (const serviceId of ["agent-platform", "agent-webclient"]) {
    const archivePath = findCurrentPlatformReleaseArchive(serviceId);
    assert.ok(archivePath, `missing ${currentManifestOs()} release archive for ${serviceId}`);

    const targetDir = path.join(assetsRoot, serviceId);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(archivePath, path.join(targetDir, path.basename(archivePath)));
  }

  return {
    tempRoot,
    assetsRoot
  };
}

function createApp(userDataRoot) {
  return {
    isPackaged: false,
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

function loadBuiltinsForTest(userDataRoot, assetsRoot) {
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  const generatedAssets = assetsRoot ? null : createCurrentPlatformAssetsFixture();
  process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot ?? generatedAssets.assetsRoot;

  registryInternals.clearServices();
  const app = createApp(userDataRoot);
  loadBuiltinServices(app);

  return {
    app,
    restore() {
      registryInternals.clearServices();
      if (previousAssetsRoot) {
        process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
      } else {
        delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
      }
      if (generatedAssets) {
        fs.rmSync(generatedAssets.tempRoot, { recursive: true, force: true });
      }
    }
  };
}

function writeContainerHubBundleRoot(bundleRoot, options = {}) {
  const startScriptContent = options.startScriptContent ?? "#!/usr/bin/env bash\necho start\n";

  fs.mkdirSync(path.join(bundleRoot, "backend"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "configs", "environments"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "data", "rootfs"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "data", "builds"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "backend", "agent-container-hub"), "binary", "utf8");
  fs.writeFileSync(path.join(bundleRoot, "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n", "utf8");
  fs.writeFileSync(path.join(bundleRoot, "start.sh"), startScriptContent, "utf8");
  fs.writeFileSync(path.join(bundleRoot, "stop.sh"), "#!/usr/bin/env bash\necho stop\n", "utf8");
  fs.writeFileSync(path.join(bundleRoot, "scripts", "program-common.sh"), "#!/usr/bin/env bash\n", "utf8");
  fs.writeFileSync(path.join(bundleRoot, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(
    path.join(bundleRoot, "manifest.json"),
    `${JSON.stringify(
      {
        id: "agent-container-hub",
        name: "Container Hub",
        kind: "builtin",
        version: "v0.1.0",
        description: "fixture",
        frontend: {
          mode: "embedded",
          entry: "/",
          assetsPrefix: "/ui/",
          directAccess: true,
          hostManaged: false
        },
        api: {
          enabled: true
        },
        backend: {
          entry: "backend/agent-container-hub"
        },
        scripts: {
          start: ["start.sh", "--daemon"],
          stop: "stop.sh",
          deploy: "deploy.sh"
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
          pidRelativePath: "run/agent-container-hub.pid",
          logRelativePath: "run/agent-container-hub.log",
          errorLogRelativePath: "run/agent-container-hub.stderr.log",
          requiredPaths: [
            "backend/agent-container-hub",
            "start.sh",
            "stop.sh",
            "deploy.sh",
            "scripts/program-common.sh",
            ".env.example",
            "manifest.json",
            "configs/environments"
          ]
        },
        web: {
          routePath: "/",
          portEnvKey: "BIND_ADDR",
          defaultPort: 11960
        },
        desktop: {
          assetFileName: "agent-container-hub-v0.1.0-darwin-arm64.tar.gz",
          bundleTopLevelDir: "agent-container-hub"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(bundleRoot, "configs", "environments", "example.yml"),
    "name: example\n",
    "utf8"
  );
}

function createContainerHubBundleFixture(tempRoot, options = {}) {
  const assetsRoot = path.join(tempRoot, "assets");
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "services", "agent-container-hub", "v0.1.0");
  const tarFixtureRoot = path.join(tempRoot, "bundle-root");
  const tarBundleRoot = path.join(tarFixtureRoot, "agent-container-hub");
  const serviceAssetDir = path.join(assetsRoot, "agent-container-hub");
  const tarPath = path.join(serviceAssetDir, "agent-container-hub-v0.1.0-darwin-arm64.tar.gz");

  writeContainerHubBundleRoot(tarBundleRoot, options);
  fs.mkdirSync(serviceAssetDir, { recursive: true });
  execFileSync("tar", ["-czf", tarPath, "-C", tarFixtureRoot, "agent-container-hub"]);

  return {
    assetsRoot,
    userDataRoot,
    installDir,
    tarBundleRoot
  };
}

function writePluginInstallRoot(installDir, options = {}) {
  const pluginId = options.id ?? "test-plugin";
  const pluginName = options.name ?? "Test Plugin";
  const version = options.version ?? "v1.0.0";
  const errorLogRelativePath = options.errorLogRelativePath ?? null;
  const defaultPort = options.defaultPort ?? 9300;
  const deployScriptContent =
    options.deployScriptContent === undefined
      ? "#!/usr/bin/env bash\nprintf deployed > run/deploy-marker.txt\n"
      : options.deployScriptContent;
  const requiredPaths = ["manifest.json", "start.sh", "stop.sh", ".env.example"];

  fs.mkdirSync(path.join(installDir, "run"), { recursive: true });
  fs.writeFileSync(path.join(installDir, ".env.example"), `PORT=${defaultPort}\n`, "utf8");
  fs.writeFileSync(path.join(installDir, "start.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  fs.writeFileSync(path.join(installDir, "stop.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");

  const scripts = {
    start: "start.sh",
    stop: "stop.sh"
  };
  if (deployScriptContent !== false) {
    fs.writeFileSync(path.join(installDir, "deploy.sh"), deployScriptContent, "utf8");
    requiredPaths.push("deploy.sh");
    scripts.deploy = "deploy.sh";
  }

  fs.writeFileSync(
    path.join(installDir, "manifest.json"),
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
        scripts,
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
          ...(errorLogRelativePath ? { errorLogRelativePath } : {}),
          requiredPaths
        },
        web: {
          routePath: "",
          portEnvKey: "PORT",
          defaultPort
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  for (const scriptName of ["start.sh", "stop.sh", "deploy.sh"]) {
    const scriptPath = path.join(installDir, scriptName);
    if (fs.existsSync(scriptPath)) {
      fs.chmodSync(scriptPath, 0o755);
    }
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, "manifest.json"), "utf8"));
  registerPlugin(manifest);
  return manifest;
}

function writeManagedBuiltinBundleRoot(bundleRoot, options = {}) {
  const serviceId = options.id ?? "managed-builtin";
  const serviceName = options.name ?? "Managed Builtin";
  const version = options.version ?? "v0.1.0";
  const defaultPort = options.defaultPort ?? 9400;
  const portEnvKey = options.portEnvKey ?? "PORT";
  const routePath = options.routePath ?? "/";
  const pidFileName = options.pidFileName ?? `${serviceId}.pid`;
  const envExampleContent = options.envExampleContent ?? `${portEnvKey}=${defaultPort}\n`;
  const failAfterSpawn = options.failAfterSpawn === true;
  const listenOnPort = options.listenOnPort === true;

  fs.mkdirSync(path.join(bundleRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, ".env.example"), envExampleContent, "utf8");
  fs.writeFileSync(
    path.join(bundleRoot, "scripts", "daemon.js"),
    listenOnPort
      ? [
          "const http = require('node:http');",
          `const port = ${JSON.stringify(defaultPort)};`,
          "const server = http.createServer((_, res) => {",
          "  res.writeHead(200, { 'content-type': 'text/plain' });",
          "  res.end('ok');",
          "});",
          "server.listen(port, '127.0.0.1');"
        ].join("\n") + "\n"
      : "setInterval(() => {}, 1000);\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(bundleRoot, "scripts", "start.js"),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { spawn } = require('node:child_process');",
      "const runDir = path.join(process.cwd(), 'run');",
      "fs.mkdirSync(runDir, { recursive: true });",
      "const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'daemon.js')], {",
      "  detached: true,",
      "  stdio: 'ignore'",
      "});",
      "child.unref();",
      `fs.writeFileSync(path.join(runDir, '${pidFileName}'), String(child.pid), 'utf8');`,
      ...(failAfterSpawn ? ["process.stderr.write('backend failed to start after spawn\\n');", "process.exit(1);"] : [])
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(bundleRoot, "scripts", "stop.js"),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const pidPath = path.join(process.cwd(), 'run', '${pidFileName}');`,
      "if (!fs.existsSync(pidPath)) {",
      "  process.exit(0);",
      "}",
      "try {",
      "  process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 'SIGTERM');",
      "} catch {}",
      "fs.rmSync(pidPath, { force: true });"
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(bundleRoot, "manifest.json"),
    `${JSON.stringify(
      {
        id: serviceId,
        name: serviceName,
        kind: "builtin",
        version,
        description: "managed builtin fixture",
        frontend: {
          mode: "none"
        },
        scripts: {
          start: [process.execPath, "scripts/start.js"],
          stop: [process.execPath, "scripts/stop.js"]
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
          pidRelativePath: `run/${pidFileName}`,
          logRelativePath: `run/${serviceId}.log`,
          requiredPaths: [
            "manifest.json",
            ".env.example",
            "scripts/daemon.js",
            "scripts/start.js",
            "scripts/stop.js"
          ]
        },
        web: {
          routePath,
          portEnvKey,
          defaultPort
        },
        desktop: {
          assetFileName: `${serviceId}-${version}-darwin-arm64.tar.gz`,
          bundleTopLevelDir: serviceId
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function createManagedBuiltinBundleFixture(tempRoot, options = {}) {
  const serviceId = options.id ?? "managed-builtin";
  const version = options.version ?? "v0.1.0";
  const assetsRoot = path.join(tempRoot, "assets");
  const userDataRoot = path.join(tempRoot, "user-data");
  const bundleRoot = path.join(tempRoot, serviceId);
  const assetDir = path.join(assetsRoot, serviceId);
  const archivePath = path.join(assetDir, `${serviceId}-${version}-darwin-arm64.tar.gz`);
  const installDir = path.join(userDataRoot, "services", serviceId, version);

  writeManagedBuiltinBundleRoot(bundleRoot, options);
  fs.mkdirSync(assetDir, { recursive: true });
  execFileSync("tar", ["-czf", archivePath, "-C", tempRoot, serviceId]);

  const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, "manifest.json"), "utf8"));
  registerPlugin(manifest);

  return {
    assetsRoot,
    userDataRoot,
    installDir,
    manifest
  };
}

test("parseEnvFileContent keeps key values and strips quotes", () => {
  const env = __testInternals.parseEnvFileContent(`
# comment
API_PORT=8088
WEB_SESSION_SECRET='top-secret'
`);

  assert.equal(env.get("API_PORT"), "8088");
  assert.equal(env.get("WEB_SESSION_SECRET"), "top-secret");
});

test("service install dir follows userData/services/<id>/<version>", () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-service-dir-"));
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const installDir = getInstallDir(app, getBuiltinService("agent-platform"));
  assert.equal(
    installDir,
    path.join(userDataRoot, "services", "agent-platform", "v0.1.0")
  );
  restore();
});

test("parsePort understands bind addr for container hub and server port for agent platform", () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-service-port-"));
  const { restore } = loadBuiltinsForTest(userDataRoot);
  const hubPort = __testInternals.parsePort(
    getBuiltinService("agent-container-hub"),
    new Map([["BIND_ADDR", "127.0.0.1:11960"]])
  );
  const platformPort = __testInternals.parsePort(
    getBuiltinService("agent-platform"),
    new Map([["SERVER_PORT", "8123"]])
  );

  assert.equal(hubPort, 11960);
  assert.equal(platformPort, 8123);
  restore();
});

test("fixShellScriptPermissions marks shell scripts executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-shell-perm-"));
  const shellPath = path.join(root, "nested", "start.sh");
  const textPath = path.join(root, "nested", "notes.txt");

  fs.mkdirSync(path.dirname(shellPath), { recursive: true });
  fs.writeFileSync(shellPath, "#!/usr/bin/env bash\necho hi\n", "utf8");
  fs.writeFileSync(textPath, "plain text\n", "utf8");
  fs.chmodSync(shellPath, 0o644);
  fs.chmodSync(textPath, 0o644);

  __testInternals.fixShellScriptPermissions(root);

  assert.equal(fs.statSync(shellPath).mode & 0o777, 0o755);
  assert.equal(fs.statSync(textPath).mode & 0o777, 0o644);
});

test("listMissingRuntimeFiles detects damaged install directories", () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-damaged-registry-"));
  const { restore } = loadBuiltinsForTest(userDataRoot);
  const service = getBuiltinService("agent-container-hub");
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-damaged-install-"));

  fs.writeFileSync(path.join(installRoot, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");

  const missingFiles = __testInternals.listMissingRuntimeFiles(service, installRoot);
  assert.ok(missingFiles.includes("start.sh"));
  assert.ok(missingFiles.includes("backend/agent-container-hub"));
  assert.ok(missingFiles.includes("manifest.json"));
  assert.equal(__testInternals.isInstallHealthy(service, installRoot), false);
  restore();
});

test("installBuiltinService repairs damaged install and preserves env", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-repair-install-"));
  const envContent = "BIND_ADDR=127.0.0.1:12000\n";
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);

  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, ".env"), envContent, "utf8");
  fs.writeFileSync(path.join(installDir, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(path.join(installDir, "README.txt"), "broken\n", "utf8");
  fs.mkdirSync(path.join(installDir, "configs"), { recursive: true });

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);

  assert.equal(fs.readFileSync(path.join(installDir, ".env"), "utf8"), envContent);
  assert.ok(fs.existsSync(path.join(installDir, "start.sh")));
  assert.ok(fs.existsSync(path.join(installDir, "stop.sh")));
  assert.ok(fs.existsSync(path.join(installDir, "backend", "agent-container-hub")));
  assert.ok(fs.existsSync(path.join(installDir, "manifest.json")));
  assert.equal(__testInternals.isInstallHealthy(service, installDir), true);
  assert.notEqual((await getServiceState(app, service.id)).status, "initialization-required");
  assert.equal(__testInternals.readInitializationState(installDir)?.status, "succeeded");

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("getServiceState exposes runtime error log path when manifest defines it", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-error-log-state-"));
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);
  const state = await getServiceState(app, service.id);

  assert.equal(state.healthMeta.logFilePath, path.join(installDir, "run", "agent-container-hub.log"));
  assert.equal(state.healthMeta.errorLogFilePath, path.join(installDir, "run", "agent-container-hub.stderr.log"));

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("readServiceLog returns main log tail metadata and content", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-read-main-log-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);
  const logContent = "line one\nline two\n";

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.writeFileSync(path.join(installDir, "run", "test-plugin.log"), logContent, "utf8");

  const result = await readServiceLog(app, "test-plugin", "main");

  assert.equal(result.ok, true);
  assert.equal(result.path, path.join(installDir, "run", "test-plugin.log"));
  assert.equal(result.exists, true);
  assert.equal(result.content, logContent);
  assert.equal(result.truncated, false);
  assert.equal(result.startOffset, 0);
  assert.equal(result.endOffset, Buffer.byteLength(logContent));
  assert.equal(result.hasPrevious, false);
  assert.equal(result.resetRequired, false);
  assert.equal(result.totalBytes, Buffer.byteLength(logContent));

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("readServiceLog returns missing metadata for absent error log file", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-read-missing-error-log-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);
  const errorLogPath = path.join(installDir, "run", "test-plugin.stderr.log");

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false,
    errorLogRelativePath: "run/test-plugin.stderr.log"
  });

  const result = await readServiceLog(app, "test-plugin", "error");

  assert.equal(result.ok, true);
  assert.equal(result.path, errorLogPath);
  assert.equal(result.exists, false);
  assert.equal(result.content, "");
  assert.equal(result.truncated, false);
  assert.equal(result.startOffset, 0);
  assert.equal(result.endOffset, 0);
  assert.equal(result.hasPrevious, false);
  assert.equal(result.resetRequired, false);
  assert.equal(result.totalBytes, 0);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("readServiceLog paginates older chunks by beforeOffset without overlap", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-read-paginated-log-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);
  const logContent = "aaaa\nbbbb\ncccc\ndddd\neeee\n";

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.writeFileSync(path.join(installDir, "run", "test-plugin.log"), logContent, "utf8");

  const latestPage = await readServiceLog(app, "test-plugin", "main", { limitBytes: 10 });
  const previousPage = await readServiceLog(app, "test-plugin", "main", {
    beforeOffset: latestPage.startOffset,
    limitBytes: 10
  });

  assert.equal(latestPage.endOffset, Buffer.byteLength(logContent));
  assert.equal(latestPage.content, "dddd\neeee\n");
  assert.equal(latestPage.hasPrevious, true);
  assert.equal(previousPage.endOffset, latestPage.startOffset);
  assert.equal(previousPage.content, "bbbb\ncccc\n");
  assert.equal(previousPage.hasPrevious, true);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("readServiceLog reads only the configured tail window for large files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-read-large-log-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);
  const windowBytes = __testInternals.LOG_READ_WINDOW_BYTES;
  const largeLogContent = "0123456789abcdef".repeat(Math.ceil((windowBytes + 96) / 16));
  const expectedContent = largeLogContent.slice(largeLogContent.length - windowBytes);

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.writeFileSync(path.join(installDir, "run", "test-plugin.log"), largeLogContent, "utf8");

  const result = await readServiceLog(app, "test-plugin", "main");

  assert.equal(result.ok, true);
  assert.equal(result.exists, true);
  assert.equal(result.truncated, true);
  assert.equal(result.startOffset, largeLogContent.length - windowBytes);
  assert.equal(result.endOffset, largeLogContent.length);
  assert.equal(result.hasPrevious, true);
  assert.equal(result.resetRequired, false);
  assert.equal(result.totalBytes, largeLogContent.length);
  assert.equal(result.content, expectedContent);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("readServiceLog resets to latest chunk when beforeOffset exceeds current file size", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-read-rotated-log-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);
  const logContent = "new-tail\n";

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.writeFileSync(path.join(installDir, "run", "test-plugin.log"), logContent, "utf8");

  const result = await readServiceLog(app, "test-plugin", "main", {
    beforeOffset: 1024,
    limitBytes: 32
  });

  assert.equal(result.content, logContent);
  assert.equal(result.startOffset, 0);
  assert.equal(result.endOffset, Buffer.byteLength(logContent));
  assert.equal(result.hasPrevious, false);
  assert.equal(result.resetRequired, true);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("readServiceLog aligns non-zero chunk starts to the next full log line", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-read-aligned-log-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);
  const firstLine = "very-long-first-line-without-break-until-here\n";
  const secondLine = "second-line\n";
  const logContent = `${firstLine}${secondLine}`;

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.writeFileSync(path.join(installDir, "run", "test-plugin.log"), logContent, "utf8");

  const result = await readServiceLog(app, "test-plugin", "main", {
    limitBytes: secondLine.length + 8
  });

  assert.equal(result.startOffset, firstLine.length);
  assert.equal(result.endOffset, Buffer.byteLength(logContent));
  assert.equal(result.content, secondLine);
  assert.equal(result.hasPrevious, true);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("getServiceState treats a listening service port as running even when the pid file is missing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-port-running-state-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);
  const port = 19300;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    defaultPort: port
  });
  await initializeService(app, "test-plugin");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const state = await getServiceState(app, "test-plugin");

  assert.equal(state.status, "running");
  assert.equal(state.healthMeta.pid, null);
  assert.match(state.message, /服务端口正在监听/u);

  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("decodePowerShellCapturePayload restores UTF-8 error text", () => {
  const payload = Buffer.from(
    JSON.stringify({
      stdout: "",
      stderr: "Start-Process : 无法启动，因为 stdout 和 stderr 不能指向同一个文件。",
      hadError: true,
      exitCode: 1
    }),
    "utf8"
  ).toString("base64");

  const decoded = __testInternals.decodePowerShellCapturePayload(payload);

  assert.deepEqual(decoded, {
    stdout: "",
    stderr: "Start-Process : 无法启动，因为 stdout 和 stderr 不能指向同一个文件。",
    hadError: true,
    exitCode: 1
  });
});

test("installBuiltinService force reinstalls healthy install and preserves env", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-force-install-"));
  const archiveStartScript = "#!/usr/bin/env bash\necho archived start\n";
  const existingStartScript = "#!/usr/bin/env bash\necho existing start\n";
  const envContent = "BIND_ADDR=127.0.0.1:12000\n";
  const { assetsRoot, userDataRoot, installDir, tarBundleRoot } = createContainerHubBundleFixture(tempRoot, {
    startScriptContent: archiveStartScript
  });

  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  fs.cpSync(tarBundleRoot, installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, ".env"), envContent, "utf8");
  fs.writeFileSync(path.join(installDir, "start.sh"), existingStartScript, "utf8");
  fs.writeFileSync(path.join(installDir, "README.txt"), "stale\n", "utf8");

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  assert.equal(__testInternals.isInstallHealthy(service, installDir), true);

  await installBuiltinService(app, service.id, { force: true });

  assert.equal(fs.readFileSync(path.join(installDir, ".env"), "utf8"), envContent);
  assert.equal(fs.readFileSync(path.join(installDir, "start.sh"), "utf8"), archiveStartScript);
  assert.equal(fs.existsSync(path.join(installDir, "README.txt")), false);
  assert.equal(__testInternals.isInstallHealthy(service, installDir), true);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("installBuiltinService installs from selected archive when archivePath is provided", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-selected-archive-install-"));
  const builtinArchiveStartScript = "#!/usr/bin/env bash\necho builtin start\n";
  const selectedArchiveStartScript = "#!/usr/bin/env bash\necho selected start\n";
  const builtinFixture = createContainerHubBundleFixture(path.join(tempRoot, "builtin"), {
    startScriptContent: builtinArchiveStartScript
  });
  const selectedArchiveRoot = path.join(tempRoot, "selected-root");
  const selectedBundleRoot = path.join(selectedArchiveRoot, "agent-container-hub");
  const selectedArchivePath = path.join(tempRoot, "agent-container-hub-selected.tar.gz");

  writeContainerHubBundleRoot(selectedBundleRoot, {
    startScriptContent: selectedArchiveStartScript
  });
  execFileSync("tar", ["-czf", selectedArchivePath, "-C", selectedArchiveRoot, "agent-container-hub"]);

  const { app, restore } = loadBuiltinsForTest(builtinFixture.userDataRoot, builtinFixture.assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id, {
    force: true,
    archivePath: selectedArchivePath
  });

  assert.equal(
    fs.readFileSync(path.join(builtinFixture.installDir, "start.sh"), "utf8"),
    selectedArchiveStartScript
  );

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("initializeService copies template, runs deploy hook, and records success state", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-init-success-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  writePluginInstallRoot(installDir);

  const before = await getServiceState(app, "test-plugin");
  assert.equal(before.status, "initialization-required");

  const result = await initializeService(app, "test-plugin");

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(installDir, ".env"), "utf8"), "PORT=9300\n");
  assert.equal(fs.readFileSync(path.join(installDir, "run", "deploy-marker.txt"), "utf8"), "deployed");
  const initializationState = __testInternals.readInitializationState(installDir);
  assert.ok(initializationState);
  assert.deepEqual(initializationState, {
    version: "v1.0.0",
    status: "succeeded",
    updatedAt: initializationState.updatedAt
  });

  const state = await getServiceState(app, "test-plugin");
  assert.equal(state.status, "stopped");

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("initializeService records failed state and surfaces initialization error", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-init-failure-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: "#!/usr/bin/env bash\necho deploy failed >&2\nexit 1\n"
  });

  const result = await initializeService(app, "test-plugin");
  assert.equal(result.ok, false);
  assert.equal(__testInternals.readInitializationState(installDir)?.status, "failed");

  const state = await getServiceState(app, "test-plugin");
  assert.equal(state.status, "error");
  assert.match(state.message, /初始化失败/u);
  assert.match(state.message, /deploy failed/u);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("readServiceConfig returns template content without creating target file", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-config-template-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });

  const result = await readServiceConfig(app, "test-plugin", "env");
  assert.equal(result.exists, false);
  assert.equal(result.source, "template");
  assert.equal(result.content, "PORT=9300\n");
  assert.equal(fs.existsSync(path.join(installDir, ".env")), false);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("startService rejects services that still require initialization", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-init-required-start-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });

  const result = await startService(app, "test-plugin");
  assert.equal(result.ok, false);
  assert.equal(result.service.status, "initialization-required");
  assert.match(result.message, /请先完成初始化/u);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("startService auto-installs and initializes builtin services", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-auto-start-"));
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;

  registryInternals.clearServices();

  try {
    const fixture = createManagedBuiltinBundleFixture(tempRoot, {
      id: "managed-builtin",
      name: "Managed Builtin",
      defaultPort: 19400
    });
    process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = fixture.assetsRoot;

    const app = createApp(fixture.userDataRoot);
    const result = await startService(app, fixture.manifest.id);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(fixture.installDir, ".env")), true);
    assert.equal(__testInternals.readInitializationState(fixture.installDir)?.status, "succeeded");

    const state = await getServiceState(app, fixture.manifest.id);
    assert.equal(state.status, "running");

    await stopService(app, fixture.manifest.id);
  } finally {
    registryInternals.clearServices();
    if (previousAssetsRoot) {
      process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startService treats already-running services as success even when start command exits non-zero", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-recover-running-"));
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;

  registryInternals.clearServices();

  try {
    const fixture = createManagedBuiltinBundleFixture(tempRoot, {
      id: "managed-builtin",
      name: "Managed Builtin",
      defaultPort: 19410,
      failAfterSpawn: true
    });
    process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = fixture.assetsRoot;

    const app = createApp(fixture.userDataRoot);
    const result = await startService(app, fixture.manifest.id);
    assert.equal(result.ok, true);
    assert.equal(result.service.status, "running");

    await stopService(app, fixture.manifest.id);
  } finally {
    registryInternals.clearServices();
    if (previousAssetsRoot) {
      process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startService does not relaunch a service when its port is already listening but the pid file is missing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-port-recover-"));
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  const port = 20000 + Math.floor(Math.random() * 10000);

  registryInternals.clearServices();

  try {
    const fixture = createManagedBuiltinBundleFixture(tempRoot, {
      id: "managed-builtin",
      name: "Managed Builtin",
      defaultPort: port,
      listenOnPort: true
    });
    process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = fixture.assetsRoot;

    const app = createApp(fixture.userDataRoot);
    const firstStart = await startService(app, fixture.manifest.id);
    assert.equal(firstStart.ok, true);

    const pidFilePath = path.join(fixture.installDir, "run", "managed-builtin.pid");
    assert.equal(fs.existsSync(pidFilePath), true);
    const originalPid = Number(fs.readFileSync(pidFilePath, "utf8"));
    fs.rmSync(pidFilePath, { force: true });

    let recoveredState = await getServiceState(app, fixture.manifest.id);
    for (let attempt = 0; attempt < 5 && recoveredState.status !== "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      recoveredState = await getServiceState(app, fixture.manifest.id);
    }
    assert.equal(recoveredState.status, "running");

    const secondStart = await startService(app, fixture.manifest.id);
    assert.equal(secondStart.ok, true);
    assert.equal(secondStart.service.status, "running");
    assert.match(secondStart.message, /已在运行/u);

    try {
      process.kill(originalPid, "SIGTERM");
    } catch {
      // Ignore already-stopped children during test cleanup.
    }
  } finally {
    registryInternals.clearServices();
    if (previousAssetsRoot) {
      process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startService on agent-webclient auto-starts agent-platform without requiring container hub", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-webclient-deps-"));
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;

  registryInternals.clearServices();

  try {
    const hubFixture = createManagedBuiltinBundleFixture(tempRoot, {
      id: "agent-container-hub",
      name: "Container Hub",
      defaultPort: 11960,
      portEnvKey: "BIND_ADDR"
    });
    const platformFixture = createManagedBuiltinBundleFixture(tempRoot, {
      id: "agent-platform",
      name: "智能体平台",
      defaultPort: 12949,
      portEnvKey: "SERVER_PORT",
      routePath: "/agent/"
    });
    const webclientFixture = createManagedBuiltinBundleFixture(tempRoot, {
      id: "agent-webclient",
      name: "小宅助理",
      defaultPort: 11948,
      envExampleContent: "BASE_URL=http://localhost:11949\nPORT=11948\n"
    });
    process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = hubFixture.assetsRoot;

    const app = createApp(platformFixture.userDataRoot);
    const result = await startService(app, "agent-webclient");
    assert.equal(result.ok, true);

    const hubState = await getServiceState(app, "agent-container-hub");
    const platformState = await getServiceState(app, "agent-platform");
    const webclientState = await getServiceState(app, "agent-webclient");
    assert.notEqual(hubState.status, "running");
    assert.equal(platformState.status, "running");
    assert.equal(webclientState.status, "running");

    const webclientEnv = fs.readFileSync(path.join(webclientFixture.installDir, ".env"), "utf8");
    assert.match(webclientEnv, /BASE_URL=http:\/\/127\.0\.0\.1:12949/);

    await stopService(app, "agent-webclient");
    await stopService(app, "agent-platform");
  } finally {
    registryInternals.clearServices();
    if (previousAssetsRoot) {
      process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ensurePreStartRequirements injects container hub url and auth public key for agent platform", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-prestart-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const hubService = getBuiltinService("agent-container-hub");
  const platformService = getBuiltinService("agent-platform");
  const hubInstallDir = path.join(userDataRoot, "services", hubService.id, hubService.version);
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);

  fs.mkdirSync(hubInstallDir, { recursive: true });
  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.writeFileSync(path.join(hubInstallDir, ".env"), "BIND_ADDR=0.0.0.0:12960\n", "utf8");
  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    "HOST_PORT=11949\nAGENT_CONTAINER_HUB_BASE_URL=http://host.docker.internal:11960\nAGENT_AUTH_ENABLED=false\n",
    "utf8"
  );

  await __testInternals.ensurePreStartRequirements(app, platformService);

  const envContent = fs.readFileSync(path.join(platformInstallDir, ".env"), "utf8");
  assert.match(envContent, /AGENT_CONTAINER_HUB_BASE_URL=http:\/\/127\.0\.0\.1:12960/);
  assert.match(envContent, /SERVER_PORT=11949/);
  assert.match(envContent, /AGENT_WS_ENABLED=true/);
  assert.match(envContent, /AGENT_AUTH_ENABLED=true/);
  assert.match(envContent, /AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE=configs\/local-public-key\.pem/);

  const publicKeyPath = path.join(platformInstallDir, "configs", "local-public-key.pem");
  assert.ok(fs.existsSync(publicKeyPath));
  assert.match(fs.readFileSync(publicKeyPath, "utf8"), /BEGIN PUBLIC KEY/);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements rewrites agent-webclient default BASE_URL to local agent-platform", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-webclient-prestart-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const platformService = getBuiltinService("agent-platform");
  const webclientService = getBuiltinService("agent-webclient");
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);
  const webclientInstallDir = path.join(userDataRoot, "services", webclientService.id, webclientService.version);

  fs.mkdirSync(path.join(platformInstallDir, "run"), { recursive: true });
  fs.mkdirSync(webclientInstallDir, { recursive: true });
  fs.writeFileSync(path.join(platformInstallDir, ".env"), "SERVER_PORT=12949\n", "utf8");
  fs.writeFileSync(
    path.join(webclientInstallDir, ".env"),
    "BASE_URL=http://localhost:11949\n",
    "utf8"
  );

  await __testInternals.ensurePreStartRequirements(app, webclientService);

  const envContent = fs.readFileSync(path.join(webclientInstallDir, ".env"), "utf8");
  assert.match(envContent, /BASE_URL=http:\/\/127\.0\.0\.1:12949/);
  assert.match(envContent, /PORT=11948/);
  assert.match(envContent, new RegExp(`NODE_BIN=${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
