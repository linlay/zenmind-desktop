import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
  const {
    __testInternals,
    forceCleanupManagedProcesses,
    getServiceState,
    getInstallDir,
    initializeService,
    installBuiltinService,
    readServiceLog,
    readServiceConfig,
    runStartupPreparation,
    restoreRunningServices,
    startService,
    stopService,
    stopRunningServicesForShutdown,
    writeServiceConfig
} = require("../dist-electron/main/service-manager.js");
const { loadBuiltinServices } = require("../dist-electron/main/builtin-loader.js");
const {
  __testInternals: registryInternals,
  getBuiltinService,
  getService,
  registerPlugin
} = require("../dist-electron/main/service-registry.js");
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..", "..");

function getAvailableLocalPort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Failed to allocate a local test port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

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
  const currentOs = currentManifestOs();
  const candidateDirs = [
    path.join(WORKSPACE_ROOT, serviceId, "dist", "release"),
    path.join(WORKSPACE_ROOT, serviceId),
    path.join(WORKSPACE_ROOT, "zenmind-dist", serviceId)
  ];
  const candidates = [];

  for (const dirPath of candidateDirs) {
    if (!fs.existsSync(dirPath)) {
      continue;
    }
    for (const entry of fs.readdirSync(dirPath)) {
      candidates.push(path.join(dirPath, entry));
    }
  }

  const workspaceCandidates = fs
    .readdirSync(WORKSPACE_ROOT)
    .filter((entry) => entry.startsWith(`${serviceId}-`) && (entry.endsWith(".tar.gz") || entry.endsWith(".zip")))
    .map((entry) => path.join(WORKSPACE_ROOT, entry));

  return [...candidates, ...workspaceCandidates].find((archivePath) => {
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

function createBuiltinRestoreFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-restore-"));
  const assetsRoot = path.join(tempRoot, "assets");
  const bundleRoot = path.join(tempRoot, "custom-builtin");
  const serviceDir = path.join(assetsRoot, "custom-builtin");
  const isWindows = process.platform === "win32";
  const archiveFileName = isWindows ? "custom-builtin-v1.0.0-windows-amd64.zip" : "custom-builtin-v1.0.0-darwin-arm64.tar.gz";
  const archivePath = path.join(serviceDir, archiveFileName);

  fs.mkdirSync(path.join(bundleRoot, "run"), { recursive: true });
  fs.mkdirSync(serviceDir, { recursive: true });

  if (isWindows) {
    fs.mkdirSync(path.join(bundleRoot, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(bundleRoot, "start.ps1"),
      [
        "$runDir = Join-Path $PSScriptRoot 'run'",
        "New-Item -ItemType Directory -Path $runDir -Force | Out-Null",
        "Set-Content -LiteralPath (Join-Path $runDir 'started.txt') -Value 'started'"
      ].join("\r\n"),
      "utf8"
    );
    fs.writeFileSync(path.join(bundleRoot, "stop.ps1"), "exit 0\r\n", "utf8");
    fs.writeFileSync(path.join(bundleRoot, "scripts", "program-common.ps1"), "# fixture\r\n", "utf8");
    fs.writeFileSync(path.join(bundleRoot, ".env.example"), "PORT=0\r\n", "utf8");
    fs.writeFileSync(
      path.join(bundleRoot, "manifest.json"),
      `${JSON.stringify({
        id: "custom-builtin",
        name: "Custom Builtin",
        kind: "builtin",
        version: "v1.0.0",
        description: "fixture builtin",
        platform: {
          os: "windows",
          arch: "amd64"
        },
        frontend: {
          mode: "none"
        },
        scripts: {
          start: "start.ps1",
          stop: "stop.ps1"
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
          pidRelativePath: "run/custom-builtin.pid",
          logRelativePath: "run/custom-builtin.log",
          requiredPaths: [
            "start.ps1",
            "stop.ps1",
            "scripts/program-common.ps1",
            ".env.example",
            "manifest.json"
          ]
        },
        web: {
          routePath: "",
          portEnvKey: "PORT",
          defaultPort: 0
        },
        desktop: {
          assetFileName: archiveFileName,
          bundleTopLevelDir: "custom-builtin"
        }
      }, null, 2)}\n`,
      "utf8"
    );
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -Path 'custom-builtin' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`
      ],
      { cwd: tempRoot }
    );
  } else {
    fs.mkdirSync(path.join(bundleRoot, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(bundleRoot, "start.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "mkdir -p run",
        "printf started > run/started.txt"
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(path.join(bundleRoot, "stop.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    fs.writeFileSync(path.join(bundleRoot, "scripts", "program-common.sh"), "#!/usr/bin/env bash\n", "utf8");
    fs.writeFileSync(path.join(bundleRoot, ".env.example"), "PORT=0\n", "utf8");
    fs.writeFileSync(
      path.join(bundleRoot, "manifest.json"),
      `${JSON.stringify({
        id: "custom-builtin",
        name: "Custom Builtin",
        kind: "builtin",
        version: "v1.0.0",
        description: "fixture builtin",
        platform: {
          os: process.platform === "darwin" ? "darwin" : "linux",
          arch: process.arch === "x64" ? "amd64" : process.arch
        },
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
          pidRelativePath: "run/custom-builtin.pid",
          logRelativePath: "run/custom-builtin.log",
          requiredPaths: [
            "start.sh",
            "stop.sh",
            "scripts/program-common.sh",
            ".env.example",
            "manifest.json"
          ]
        },
        web: {
          routePath: "",
          portEnvKey: "PORT",
          defaultPort: 0
        },
        desktop: {
          assetFileName: archiveFileName,
          bundleTopLevelDir: "custom-builtin"
        }
      }, null, 2)}\n`,
      "utf8"
    );
    fs.chmodSync(path.join(bundleRoot, "start.sh"), 0o755);
    fs.chmodSync(path.join(bundleRoot, "stop.sh"), 0o755);
    fs.chmodSync(path.join(bundleRoot, "scripts", "program-common.sh"), 0o755);
    execFileSync("tar", ["-czf", archivePath, "-C", tempRoot, "custom-builtin"]);
  }

  return {
    tempRoot,
    assetsRoot
  };
}

function createStartupCoreAssetsFixture(options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-startup-core-assets-"));
  const assetsRoot = path.join(tempRoot, "assets");
  const isWindows = process.platform === "win32";
  const portBase = 28000 + Math.floor(Math.random() * 2000);
  const services = [
    {
      id: "zenmind-app-server",
      name: "认证服务",
      frontend: { mode: "standalone", entry: "/admin/" },
      web: { routePath: "/admin/", portEnvKey: "SERVER_PORT", defaultPort: portBase + 2 },
      envExample: `SERVER_PORT=${portBase + 2}\nFRONTEND_DIST_DIR=./frontend/dist\n`,
      extraPaths: [["frontend", "dist"], ["scripts"]]
    },
    {
      id: "agent-platform",
      name: "智能体平台",
      frontend: { mode: "none" },
      web: { routePath: "", portEnvKey: "SERVER_PORT", defaultPort: portBase + 1 },
      envExample: `SERVER_PORT=${portBase + 1}\n`,
      extraPaths: [["configs"], ["runtime"], ["scripts"]]
    },
    {
      id: "agent-webclient",
      name: "智能助理",
      frontend: { mode: "standalone", entry: "/" },
      web: { routePath: "/", portEnvKey: "PORT", defaultPort: portBase },
      envExample: `PORT=${portBase}\n`,
      extraPaths: [["backend"], ["frontend", "dist"], ["scripts"]]
    }
  ];

  for (const service of services) {
    const bundleRoot = path.join(tempRoot, service.id);
    const assetDir = path.join(assetsRoot, service.id);
    const archiveFileName = isWindows
      ? `${service.id}-v1.0.0-windows-amd64.zip`
      : `${service.id}-v1.0.0-darwin-arm64.tar.gz`;
    const archivePath = path.join(assetDir, archiveFileName);

    for (const segments of service.extraPaths) {
      fs.mkdirSync(path.join(bundleRoot, ...segments), { recursive: true });
    }
    fs.mkdirSync(path.join(bundleRoot, "run"), { recursive: true });
    fs.mkdirSync(assetDir, { recursive: true });

    if (service.id === "agent-webclient") {
      fs.writeFileSync(
        path.join(bundleRoot, "backend", "server.cjs"),
        [
          "const http = require('http');",
          "const { createProxyMiddleware } = require('http-proxy-middleware');",
          "const server = http.createServer();",
          "function createWebSocketProxy() {",
          "  const proxy = createProxyMiddleware({ target: 'http://127.0.0.1:11949', ws: true });",
          "  return { ws(req, socket, head) { proxy.upgrade(req, socket, head); } };",
          "}",
          "server.on('upgrade', () => {});",
          "module.exports = { createWebSocketProxy };"
        ].join("\n") + "\n",
        "utf8"
      );
      fs.writeFileSync(path.join(bundleRoot, "frontend", "dist", "index.html"), "<html></html>\n", "utf8");
    }
    if (service.id === "zenmind-app-server") {
      fs.writeFileSync(
        path.join(bundleRoot, "frontend", "dist", "index.html"),
        [
          "<!doctype html>",
          "<html>",
          "<head>",
          "  <script type=\"module\" src=\"/admin/assets/index.js\"></script>",
          "  <link rel=\"stylesheet\" href=\"/admin/assets/index.css\">",
          "</head>",
          "<body></body>",
          "</html>"
        ].join("\n") + "\n",
        "utf8"
      );
    }

    const pidRelativePath = path.join("run", `${service.id}.pid`);
    const startFileName = isWindows ? "start.ps1" : "start.sh";
    const stopFileName = isWindows ? "stop.ps1" : "stop.sh";
    const programCommonName = isWindows ? "program-common.ps1" : "program-common.sh";

    if (isWindows) {
      fs.writeFileSync(
        path.join(bundleRoot, startFileName),
        [
          "$runDir = Join-Path $PSScriptRoot 'run'",
          "New-Item -ItemType Directory -Path $runDir -Force | Out-Null",
          options.failOnStartServiceId === service.id
            ? "throw 'fixture start failure'"
            : [
                "$pidDir = if ($env:ZENMIND_SERVICE_STATE_DIR) { Join-Path $env:ZENMIND_SERVICE_STATE_DIR 'pid' } else { $runDir }",
                "New-Item -ItemType Directory -Path $pidDir -Force | Out-Null",
                "if ($env:NODE_BIN) { $env:NODE_BIN | Set-Content -LiteralPath (Join-Path $runDir 'node-bin.txt') }",
                "$proc = Start-Process -FilePath powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','Start-Sleep -Seconds 300' -WindowStyle Hidden -PassThru",
                `$proc.Id | Set-Content -LiteralPath (Join-Path $pidDir '${service.id}.pid')`,
                "Set-Content -LiteralPath (Join-Path $runDir 'started.txt') -Value 'started'"
              ].join("\r\n")
        ].join("\r\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(bundleRoot, stopFileName),
        [
          `$pidFile = if ($env:ZENMIND_SERVICE_STATE_DIR) { Join-Path (Join-Path $env:ZENMIND_SERVICE_STATE_DIR 'pid') '${service.id}.pid' } else { Join-Path $PSScriptRoot '${pidRelativePath.replace(/\\/g, "/")}' }`,
          "if (Test-Path -LiteralPath $pidFile) {",
          "  $pidValue = (Get-Content -LiteralPath $pidFile -Raw).Trim()",
          "  if ($pidValue) { Stop-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue }",
          "  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue",
          "}"
        ].join("\r\n"),
        "utf8"
      );
      fs.writeFileSync(path.join(bundleRoot, "scripts", programCommonName), "# fixture\r\n", "utf8");
    } else {
      fs.writeFileSync(
        path.join(bundleRoot, startFileName),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "mkdir -p run",
          'pid_dir="${ZENMIND_SERVICE_STATE_DIR:-$PWD/run}/pid"',
          'if [ -z "${ZENMIND_SERVICE_STATE_DIR:-}" ]; then pid_dir="$PWD/run"; fi',
          'mkdir -p "$pid_dir"',
          options.failOnStartServiceId === service.id
            ? "echo fixture start failure >&2\nexit 1"
            : [
                `node -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 &`,
                'if [ -n "${NODE_BIN:-}" ]; then printf "%s" "$NODE_BIN" > run/node-bin.txt; fi',
                `echo $! > "$pid_dir/${service.id}.pid"`,
                "printf started > run/started.txt"
              ].join("\n")
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(bundleRoot, stopFileName),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'pid_dir="${ZENMIND_SERVICE_STATE_DIR:-$PWD/run}/pid"',
          'if [ -z "${ZENMIND_SERVICE_STATE_DIR:-}" ]; then pid_dir="$PWD/run"; fi',
          `pid_file="$pid_dir/${service.id}.pid"`,
          'if [ -f "$pid_file" ]; then',
          '  kill "$(cat "$pid_file")" >/dev/null 2>&1 || true',
          '  rm -f "$pid_file"',
          "fi"
        ].join("\n"),
        "utf8"
      );
      const programCommonContent = service.id === "zenmind-app-server"
        ? [
            "#!/usr/bin/env bash",
            'FRONTEND_DIST_DIR="${FRONTEND_DIST_DIR:-./frontend/dist}"',
            'nohup "$BACKEND_BIN" >/dev/null 2>&1 &'
          ].join("\n") + "\n"
        : service.id === "agent-webclient"
          ? [
              "#!/usr/bin/env bash",
              'BACKEND_ENTRY="$BUNDLE_ROOT/backend/server.cjs"'
            ].join("\n") + "\n"
        : "#!/usr/bin/env bash\n";
      fs.writeFileSync(path.join(bundleRoot, "scripts", programCommonName), programCommonContent, "utf8");
      fs.chmodSync(path.join(bundleRoot, startFileName), 0o755);
      fs.chmodSync(path.join(bundleRoot, stopFileName), 0o755);
      fs.chmodSync(path.join(bundleRoot, "scripts", programCommonName), 0o755);
    }

    fs.writeFileSync(path.join(bundleRoot, ".env.example"), service.envExample, "utf8");
    fs.writeFileSync(
      path.join(bundleRoot, "manifest.json"),
      `${JSON.stringify({
        id: service.id,
        name: service.name,
        kind: "builtin",
        version: "v1.0.0",
        description: "fixture",
        frontend: service.frontend,
        ...(service.id === "agent-webclient"
          ? {
              backend: {
                entry: "backend/server.cjs"
              }
            }
          : {}),
        scripts: {
          start: startFileName,
          stop: stopFileName
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
          pidRelativePath,
          requiredPaths: [
            startFileName,
            stopFileName,
            path.join("scripts", programCommonName),
            ".env.example",
            "manifest.json",
            ...(service.id === "agent-platform" ? ["configs", "runtime"] : []),
            ...(service.id === "agent-webclient" ? [path.join("backend", "server.cjs"), path.join("frontend", "dist", "index.html")] : []),
            ...(service.id === "zenmind-app-server" ? [path.join("frontend", "dist", "index.html")] : [])
          ]
        },
        web: service.web,
        desktop: {
          assetFileName: archiveFileName,
          bundleTopLevelDir: service.id
        }
      }, null, 2)}\n`,
      "utf8"
    );

    if (isWindows) {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Compress-Archive -Path '${service.id}' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`
        ],
        { cwd: tempRoot }
      );
    } else {
      execFileSync("tar", ["-czf", archivePath, "-C", tempRoot, service.id]);
    }
  }

  addContainerHubAssetToFixture({ tempRoot, assetsRoot });

  return {
    tempRoot,
    assetsRoot
  };
}

async function stopStartupCoreProcesses(app) {
  for (const serviceId of ["zenmind-app-server", "agent-platform", "agent-webclient"]) {
    try {
      const state = await getServiceState(app, serviceId);
      if (state.status === "running") {
        const pid = state.healthMeta.pid;
        if (pid) {
          try {
            process.kill(pid);
          } catch {
            // Process may already be gone during fixture cleanup.
          }
        }
      }
    } catch {
      // Ignore cleanup failures for synthetic fixtures.
    }
  }
}

function isPidRunning(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid) {
  for (let i = 0; i < 20; i += 1) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForLogStreamEvent(events, predicate) {
  for (let i = 0; i < 30; i += 1) {
    const event = events.find(predicate);
    if (event) {
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function getTestDesktopRoot(userDataRoot) {
  return path.join(getTestHomeRoot(userDataRoot), ".zenmind", ".desktop");
}

function getTestHomeRoot(userDataRoot) {
  return path.basename(userDataRoot) === "user-data"
    ? path.join(path.dirname(userDataRoot), "home")
    : path.join(userDataRoot, "home");
}

function getTestProgramsRoot(userDataRoot) {
  return path.join(userDataRoot, "app-data", "ZenMind");
}

function getTestServiceProgramDir(userDataRoot, serviceId, version) {
  return path.join(getTestProgramsRoot(userDataRoot), "services", serviceId, version);
}

function getTestPluginProgramDir(userDataRoot, pluginId, version = "v1.0.0") {
  return path.join(getTestProgramsRoot(userDataRoot), "plugins", pluginId, version);
}

function getTestConfigDir(userDataRoot, serviceId, kind = "services") {
  return path.join(getTestDesktopRoot(userDataRoot), "config", kind, serviceId);
}

function getTestDataDir(userDataRoot, serviceId, kind = "services") {
  return path.join(getTestDesktopRoot(userDataRoot), "data", kind, serviceId);
}

function getTestStateDir(userDataRoot, serviceId, kind = "services") {
  return path.join(getTestDesktopRoot(userDataRoot), "state", kind, serviceId);
}

function getTestLogDir(userDataRoot, serviceId, kind = "services") {
  return path.join(getTestDesktopRoot(userDataRoot), "logs", kind, serviceId);
}

function getTestEnvPath(userDataRoot, serviceId, kind = "services") {
  return path.join(getTestConfigDir(userDataRoot, serviceId, kind), ".env");
}

function getTestInitializationStatePath(userDataRoot, serviceId, kind = "services") {
  return path.join(getTestStateDir(userDataRoot, serviceId, kind), "init-state.json");
}

function getTestPidPath(userDataRoot, serviceId, fileName, kind = "services") {
  return path.join(getTestStateDir(userDataRoot, serviceId, kind), "pid", fileName);
}

function markInstallInitialized(installDir, version = "v1.0.0") {
  const initStatePath = __testInternals.getInitializationStatePath(installDir);
  markInitializationState(initStatePath, version);
}

function markInitializationState(initStatePath, version = "v1.0.0") {
  fs.mkdirSync(path.dirname(initStatePath), { recursive: true });
  fs.writeFileSync(
    initStatePath,
    `${JSON.stringify({
      version,
      status: "succeeded",
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
}

function readInitializationStatePath(initStatePath) {
  return JSON.parse(fs.readFileSync(initStatePath, "utf8"));
}

function writeTestEnv(userDataRoot, serviceId, content, kind = "services") {
  const envPath = getTestEnvPath(userDataRoot, serviceId, kind);
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content, "utf8");
  return envPath;
}

function writeExecutableFile(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function prepareRunningPluginFixture(userDataRoot, options = {}) {
  const pluginId = options.id ?? "test-plugin";
  const installDir = getTestPluginProgramDir(userDataRoot, pluginId);
  writePluginInstallRoot(installDir, {
    id: pluginId,
    name: options.name ?? pluginId,
    port: options.port ?? 0,
    deployScriptContent: false
  });
  const envPath = getTestEnvPath(userDataRoot, pluginId, "plugins");
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.copyFileSync(path.join(installDir, ".env.example"), envPath);
  markInitializationState(getTestInitializationStatePath(userDataRoot, pluginId, "plugins"));

  if (options.stopScriptContent) {
    writeExecutableFile(path.join(installDir, "stop.sh"), options.stopScriptContent);
  }

  const workerPath = path.join(installDir, `${pluginId}-worker.mjs`);
  fs.writeFileSync(workerPath, "setInterval(() => {}, 1000);\n", "utf8");
  const startResult = spawnSync(
    "sh",
    ["-c", 'nohup "$1" "$2" >/dev/null 2>&1 & echo $!', "zenmind-fixture", process.execPath, workerPath],
    {
      cwd: installDir,
      encoding: "utf8"
    }
  );
  assert.equal(startResult.status, 0, startResult.stderr || startResult.stdout);
  const pid = Number.parseInt(startResult.stdout.trim(), 10);
  assert.ok(Number.isFinite(pid) && pid > 0, `expected fixture pid, got ${startResult.stdout}`);
  const pidPath = getTestPidPath(userDataRoot, pluginId, "test-plugin.pid", "plugins");
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, `${pid}\n`, "utf8");
  fs.mkdirSync(path.join(installDir, "run"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "run", "test-plugin.pid"), `${pid}\n`, "utf8");

  return {
    child: { pid },
    installDir,
    pluginId
  };
}

function createApp(userDataRoot, options = {}) {
  const {
    isPackaged = false,
    homePath = getTestHomeRoot(userDataRoot),
    appDataPath = path.join(userDataRoot, "app-data"),
    desktopPath = path.join(homePath, "Desktop")
  } = options;
  return {
    isPackaged,
    getPath(name) {
      switch (name) {
        case "userData":
          return userDataRoot;
        case "appData":
          return appDataPath;
        case "home":
          return homePath;
        case "desktop":
          return desktopPath;
        default:
          assert.fail(`unexpected app.getPath(${name})`);
      }
    }
  };
}

function loadBuiltinsForTest(userDataRoot, assetsRoot, appOptions = {}) {
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  const generatedAssets = assetsRoot ? null : createCurrentPlatformAssetsFixture();
  process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot ?? generatedAssets.assetsRoot;

  registryInternals.clearServices();
  const app = createApp(userDataRoot, appOptions);
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
  const bindAddr = options.bindAddr ?? "127.0.0.1:11960";
  const defaultPort = Number(String(bindAddr).match(/:(\d+)$/u)?.[1] || 11960);
  const assetFileName = options.assetFileName ?? "agent-container-hub-v0.1.0-darwin-arm64.tar.gz";

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
  fs.writeFileSync(path.join(bundleRoot, ".env.example"), `BIND_ADDR=${bindAddr}\n`, "utf8");
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
          defaultPort
        },
        desktop: {
          assetFileName,
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
  const installDir = getTestServiceProgramDir(userDataRoot, "agent-container-hub", "v0.1.0");
  const tarFixtureRoot = path.join(tempRoot, "bundle-root");
  const tarBundleRoot = path.join(tarFixtureRoot, "agent-container-hub");
  const serviceAssetDir = path.join(assetsRoot, "agent-container-hub");
  const archiveFileName = process.platform === "win32"
    ? "agent-container-hub-v0.1.0-windows-amd64.zip"
    : "agent-container-hub-v0.1.0-darwin-arm64.tar.gz";
  const tarPath = path.join(serviceAssetDir, archiveFileName);

  writeContainerHubBundleRoot(tarBundleRoot, { ...options, assetFileName: archiveFileName });
  fs.mkdirSync(serviceAssetDir, { recursive: true });
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -Path 'agent-container-hub' -DestinationPath '${tarPath.replace(/'/g, "''")}' -Force`
      ],
      { cwd: tarFixtureRoot }
    );
  } else {
    execFileSync("tar", ["-czf", tarPath, "-C", tarFixtureRoot, "agent-container-hub"]);
  }

  return {
    assetsRoot,
    userDataRoot,
    installDir,
    tarBundleRoot
  };
}

function addContainerHubAssetToFixture(fixture, options = {}) {
  const tarFixtureRoot = path.join(fixture.tempRoot, "agent-container-hub-asset-root");
  const tarBundleRoot = path.join(tarFixtureRoot, "agent-container-hub");
  const serviceAssetDir = path.join(fixture.assetsRoot, "agent-container-hub");
  const archiveFileName = process.platform === "win32"
    ? "agent-container-hub-v0.1.0-windows-amd64.zip"
    : "agent-container-hub-v0.1.0-darwin-arm64.tar.gz";
  const tarPath = path.join(serviceAssetDir, archiveFileName);

  writeContainerHubBundleRoot(tarBundleRoot, { ...options, assetFileName: archiveFileName });
  fs.mkdirSync(serviceAssetDir, { recursive: true });
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -Path 'agent-container-hub' -DestinationPath '${tarPath.replace(/'/g, "''")}' -Force`
      ],
      { cwd: tarFixtureRoot }
    );
  } else {
    execFileSync("tar", ["-czf", tarPath, "-C", tarFixtureRoot, "agent-container-hub"]);
  }

  return {
    tarPath,
    tarBundleRoot
  };
}

function writePluginInstallRoot(installDir, options = {}) {
  const pluginId = options.id ?? "test-plugin";
  const pluginName = options.name ?? "Test Plugin";
  const version = options.version ?? "v1.0.0";
  const port = options.port ?? 9300;
  const errorLogRelativePath = options.errorLogRelativePath ?? null;
  const deployScriptContent =
    options.deployScriptContent === undefined
      ? "#!/usr/bin/env bash\nprintf deployed > run/deploy-marker.txt\n"
      : options.deployScriptContent;
  const requiredPaths = ["manifest.json", "start.sh", "stop.sh", ".env.example"];

  fs.mkdirSync(path.join(installDir, "run"), { recursive: true });
  fs.writeFileSync(path.join(installDir, ".env.example"), `PORT=${port}\n`, "utf8");
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
          defaultPort: port
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

function createSpawnSyncResult(status) {
  return {
    status,
    stdout: "",
    stderr: ""
  };
}

function isCommandLookup(command, args, name) {
  return (
    (command === "where.exe" && args[0] === name) ||
    (command === "sh" && args[0] === "-lc" && args[1] === `command -v ${name}`)
  );
}

function withSpawnSyncMock(mockImplementation, run) {
  const previousSpawnSync = childProcess.spawnSync;
  const previousShell = process.env.SHELL;
  childProcess.spawnSync = mockImplementation;
  delete process.env.SHELL;

  try {
    return run();
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    if (previousShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previousShell;
    }
  }
}

test("parseEnvFileContent keeps key values and strips quotes", () => {
  const env = __testInternals.parseEnvFileContent(`
# comment
API_PORT=8088
WEB_SESSION_SECRET='top-secret'
NODE_BIN="/Applications/ZenMind 3.app/Contents/MacOS/ZenMind"
`);

  assert.equal(env.get("API_PORT"), "8088");
  assert.equal(env.get("WEB_SESSION_SECRET"), "top-secret");
  assert.equal(env.get("NODE_BIN"), "/Applications/ZenMind 3.app/Contents/MacOS/ZenMind");
});

test("upsertEnvFileContent replaces duplicated keys without leaving stale values behind", () => {
  const next = __testInternals.upsertEnvFileContent(
    "AGENTS_DIR=/tmp/old-agents\nOTHER_KEY=demo\nAGENTS_DIR=/tmp/older-agents\n",
    new Map([["AGENTS_DIR", "/tmp/new-agents"]])
  );

  assert.equal(next, "AGENTS_DIR=/tmp/new-agents\nOTHER_KEY=demo\n");
});

test("normalizeAgentPlatformEnvContentForSave strips legacy relay settings", () => {
  const next = __testInternals.normalizeAgentPlatformEnvContentForSave(
    [
      "HOST_PORT=11949",
      "LOCAL_CLI_ACP_RELAY_ENABLED=true",
      "LOCAL_CLI_ACP_RELAY_PORT=4555",
      "CLAUDE_CODE_ACP_COMMAND=/custom/bin/claude-code-acp",
      "CLAUDE_CODE_ACP_ARGS=--stdio"
    ].join("\n")
  );

  assert.match(next, /^HOST_PORT=11949$/m);
  assert.doesNotMatch(next, /^LOCAL_CLI_ACP_RELAY_ENABLED=/m);
  assert.doesNotMatch(next, /^LOCAL_CLI_ACP_RELAY_PORT=/m);
  assert.doesNotMatch(next, /^CLAUDE_CODE_ACP_COMMAND=/m);
  assert.doesNotMatch(next, /^CLAUDE_CODE_ACP_ARGS=/m);
});

test("normalizeAgentWebclientEnvContentForDesktop writes desktop mode and strips runtime-only keys", () => {
  const next = __testInternals.normalizeAgentWebclientEnvContentForDesktop(
    [
      "PORT=11948",
      "DESKTOP_APP=false",
      "NODE_BIN=/tmp/node",
      "NODE_ENV=production",
      "DEV_SERVER_ALLOWED_HOSTS=all",
      "BASE_URL=http://127.0.0.1:11949"
    ].join("\n")
  );

  assert.match(next, /^PORT=11948$/m);
  assert.match(next, /^DESKTOP_APP=true$/m);
  assert.match(next, /^BASE_URL=http:\/\/127\.0\.0\.1:11949$/m);
  assert.doesNotMatch(next, /^NODE_BIN=/m);
  assert.doesNotMatch(next, /^NODE_ENV=/m);
  assert.doesNotMatch(next, /^DEV_SERVER_ALLOWED_HOSTS=/m);
});

test("applyAgentPlatformWindowsHostShellDefaults injects PowerShell defaults on Windows", () => {
  const updates = new Map();
  const changed = __testInternals.applyAgentPlatformWindowsHostShellDefaults(
    new Map([["HOST_PORT", "11949"]]),
    updates,
    true
  );

  assert.equal(changed, true);
  assert.equal(updates.get("AGENT_BASH_SHELL_EXECUTABLE"), "powershell.exe");
  assert.equal(updates.get("AGENT_BASH_SHELL_ARGS"), "-NoProfile,-ExecutionPolicy,Bypass,-Command,{{command}}");
});

test("applyAgentPlatformWindowsHostShellDefaults preserves explicit host shell settings", () => {
  const updates = new Map();
  const changed = __testInternals.applyAgentPlatformWindowsHostShellDefaults(
    new Map([
      ["AGENT_BASH_SHELL_EXECUTABLE", "cmd.exe"],
      ["AGENT_BASH_SHELL_ARGS", "/d,/s,/c,{{command}}"]
    ]),
    updates,
    true
  );

  assert.equal(changed, false);
  assert.equal(updates.size, 0);
});

test("applyAgentPlatformWindowsHostShellDefaults skips non-Windows platforms", () => {
  const updates = new Map();
  const changed = __testInternals.applyAgentPlatformWindowsHostShellDefaults(new Map(), updates, false);

  assert.equal(changed, false);
  assert.equal(updates.size, 0);
});

test("normalizeAgentPlatformEnvContentForRuntime removes deprecated env keys and migrates supported replacements", () => {
  const next = __testInternals.normalizeAgentPlatformEnvContentForRuntime(
    [
      "AGENT_AUTH_ENABLED=false",
      "AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE=configs/old.pem",
      "AGENT_CONTAINER_HUB_BASE_URL=http://127.0.0.1:11960",
      "RUNTIME_DIR=/tmp/legacy-runtime",
      "GATEWAY_WS_URL=ws://127.0.0.1:17999/gw",
      "CLAUDE_CODE_ACP_ARGS=-y @zed-industries/claude-code-acp",
      "HOST_PORT=11949"
    ].join("\n")
  );

  assert.match(next, /^AUTH_ENABLED=false$/m);
  assert.match(next, /^AUTH_LOCAL_PUBLIC_KEY_FILE=configs\/old\.pem$/m);
  assert.match(next, /^CONTAINER_HUB_BASE_URL=http:\/\/127\.0\.0\.1:11960$/m);
  assert.match(next, /^AGENTS_DIR=\/tmp\/legacy-runtime\/agents$/m);
  assert.match(next, /^REGISTRIES_DIR=\/tmp\/legacy-runtime\/registries$/m);
  assert.match(next, /^CLAUDE_CODE_ACP_ARGS='-y @zed-industries\/claude-code-acp'$/m);
  assert.doesNotMatch(next, /^AGENT_AUTH_ENABLED=/m);
  assert.doesNotMatch(next, /^AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE=/m);
  assert.doesNotMatch(next, /^AGENT_CONTAINER_HUB_BASE_URL=/m);
  assert.doesNotMatch(next, /^RUNTIME_DIR=/m);
  assert.doesNotMatch(next, /^GATEWAY_WS_URL=/m);
});

test("normalizeAgentPlatformEnvContentForRuntime injects the Desktop embedded CDP gateway", () => {
  const next = __testInternals.normalizeAgentPlatformEnvContentForRuntime(
    [
      "HOST_PORT=11949",
      "CDP_HOST=localhost",
      "CDP_PORT=9222"
    ].join("\n")
  );

  assert.match(next, /^CDP_HOST=127\.0\.0\.1$/m);
  assert.match(next, /^CDP_PORT=11789$/m);
  assert.match(next, /^ZENMIND_DESKTOP_CDP_GATEWAY_URL=http:\/\/127\.0\.0\.1:11789$/m);
});

test("normalizeAgentPlatformEnvContentForRuntime removes legacy chat ticket gates and ignores placeholder image secrets", () => {
  const next = __testInternals.normalizeAgentPlatformEnvContentForRuntime(
    [
      "HOST_PORT=11949",
      "CHAT_RESOURCE_TICKET_ENABLED=true",
      "CHAT_IMAGE_TOKEN_SECRET=replace-with-your-chat-image-token-secret"
    ].join("\n")
  );

  assert.match(next, /^HOST_PORT=11949$/m);
  assert.doesNotMatch(next, /^CHAT_RESOURCE_TICKET_ENABLED=/m);
  assert.doesNotMatch(next, /^CHAT_IMAGE_TOKEN_SECRET=/m);
  assert.doesNotMatch(next, /^CHAT_RESOURCE_TICKET_SECRET=/m);
});

test("normalizeAgentPlatformEnvContentForRuntime migrates real legacy image token secrets to resource ticket config", () => {
  const next = __testInternals.normalizeAgentPlatformEnvContentForRuntime(
    [
      "HOST_PORT=11949",
      "CHAT_IMAGE_TOKEN_SECRET=my-secret",
      "CHAT_IMAGE_TOKEN_TTL_SECONDS=300"
    ].join("\n")
  );

  assert.match(next, /^CHAT_RESOURCE_TICKET_SECRET=my-secret$/m);
  assert.match(next, /^CHAT_RESOURCE_TICKET_TTL_SECONDS=300$/m);
  assert.doesNotMatch(next, /^CHAT_IMAGE_TOKEN_SECRET=/m);
  assert.doesNotMatch(next, /^CHAT_IMAGE_TOKEN_TTL_SECONDS=/m);
});

test("service install dir follows Application Support services/<id>/<version>", () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-service-dir-"));
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const service = getBuiltinService("agent-platform");
  const installDir = getInstallDir(app, service);
  assert.equal(
    installDir,
    getTestServiceProgramDir(userDataRoot, service.id, service.version)
  );
  restore();
});

test("parsePort reads Desktop core service ports from their config keys", () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-service-port-"));
  const { restore } = loadBuiltinsForTest(userDataRoot);
  const authService = registerPlugin({
    id: "zenmind-app-server",
    name: "认证服务",
    kind: "builtin",
    version: "v0.1.0",
    description: "fixture",
    frontend: {
      mode: "standalone"
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {},
    web: {
      routePath: "/admin/",
      portEnvKey: "SERVER_PORT",
      defaultPort: 18080
    }
  });
  const webclientPort = __testInternals.parsePort(
    getBuiltinService("agent-webclient"),
    new Map([["PORT", "7080"]])
  );
  const webclientBadPort = __testInternals.parsePort(
    getBuiltinService("agent-webclient"),
    new Map([["PORT", "117080"]])
  );
  const authPort = __testInternals.parsePort(
    authService,
    new Map([["SERVER_PORT", "7076"]])
  );
  const authBadPort = __testInternals.parsePort(
    authService,
    new Map([["SERVER_PORT", "117076"]])
  );
  const hubPort = __testInternals.parsePort(
    getBuiltinService("agent-container-hub"),
    new Map([["BIND_ADDR", "127.0.0.1:7079"]])
  );
  const hubBadPort = __testInternals.parsePort(
    getBuiltinService("agent-container-hub"),
    new Map([["BIND_ADDR", "127.0.0.1:117079"]])
  );
  const platformPort = __testInternals.parsePort(
    getBuiltinService("agent-platform"),
    new Map([
      ["HOST_PORT", "7078"],
      ["SERVER_PORT", "18081"]
    ])
  );
  const platformFallbackPort = __testInternals.parsePort(
    getBuiltinService("agent-platform"),
    new Map([["SERVER_PORT", "8123"]])
  );
  const platformBadPort = __testInternals.parsePort(
    getBuiltinService("agent-platform"),
    new Map([
      ["HOST_PORT", "117078"],
      ["SERVER_PORT", "117078"]
    ])
  );

  assert.equal(webclientPort, 7080);
  assert.equal(webclientBadPort, 7080);
  assert.equal(authPort, 7076);
  assert.equal(authBadPort, 7076);
  assert.equal(hubPort, 7079);
  assert.equal(hubBadPort, 7079);
  assert.equal(platformPort, 7078);
  assert.equal(platformFallbackPort, 8123);
  assert.equal(platformBadPort, 7078);
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

test("buildProcessTreePids returns descendants before the root process", () => {
  const result = __testInternals.buildProcessTreePids(10, [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 13, ppid: 10 },
    { pid: 99, ppid: 1 }
  ]);

  assert.deepEqual(result, [12, 11, 13, 10]);
});

test("process tree parsers read ps and PowerShell process tables", () => {
  assert.deepEqual(__testInternals.parseProcessTreeRowsFromPs(" 10 1\n 11 10\n"), [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 }
  ]);
  assert.deepEqual(
    __testInternals.parseProcessTreeRowsFromPowerShell(
      JSON.stringify([
        { ProcessId: 20, ParentProcessId: 1 },
        { ProcessId: 21, ParentProcessId: 20 }
      ])
    ),
    [
      { pid: 20, ppid: 1 },
      { pid: 21, ppid: 20 }
    ]
  );
});

test("collectManagedRootPids only includes pid-file processes from the service install dir", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-managed-root-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const fixturePath = path.join(installDir, "worker-fixture.mjs");
  let child = null;

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    port: 0,
    deployScriptContent: false
  });
  fs.writeFileSync(fixturePath, "setInterval(() => {}, 1000);\n", "utf8");

  try {
    child = spawn(process.execPath, [fixturePath], {
      cwd: installDir,
      stdio: "ignore"
    });
    assert.ok(child.pid, "expected fixture process to expose a pid");
    const pidPath = getTestPidPath(userDataRoot, "test-plugin", "test-plugin.pid", "plugins");
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, `${child.pid}\n`, "utf8");

    const roots = __testInternals.collectManagedRootPids(app);
    assert.equal(roots.some((root) => root.pid === child.pid && root.serviceId === "test-plugin"), true);

    fs.writeFileSync(pidPath, `${process.pid}\n`, "utf8");
    const nextRoots = __testInternals.collectManagedRootPids(app);
    assert.equal(nextRoots.some((root) => root.pid === process.pid), false);
  } finally {
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Process may already be gone when the test finishes.
      }
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("mergeCleanupTargets preserves pre-quit process tree snapshots", () => {
  const merged = __testInternals.mergeCleanupTargets(
    [
      {
        pid: 100,
        serviceId: "test-plugin",
        pidFilePaths: ["/tmp/test-plugin.pid"],
        treePids: [102, 101, 100]
      }
    ],
    []
  );

  assert.deepEqual(merged, [
    {
      pid: 100,
      serviceId: "test-plugin",
      pidFilePaths: ["/tmp/test-plugin.pid"],
      treePids: [102, 101, 100]
    }
  ]);
});

test("terminateProcessTree treats already-exited pids as cleaned up", () => {
  assert.equal(__testInternals.terminateProcessTree(99999999), true);
});

function createManagedStopState(overrides = {}) {
  return {
    mainPidFilePath: "/tmp/test-service.pid",
    managedMainPid: null,
    port: 0,
    managedPortPids: [],
    ...overrides
  };
}

test("ensureManagedServiceStoppedForPlatform forces cleanup on Windows when stop leaves the main process alive", () => {
  const snapshots = [
    createManagedStopState({ managedMainPid: 4321 }),
    createManagedStopState()
  ];
  let forceCalls = 0;

  const result = __testInternals.ensureManagedServiceStoppedForPlatform(
    { id: "test-plugin" },
    "/tmp/test-plugin",
    new Map(),
    {
      isWindows: true,
      collectState: () => snapshots.shift(),
      forceStop: () => {
        forceCalls += 1;
        return true;
      }
    }
  );

  assert.equal(forceCalls, 1);
  assert.deepEqual(result, {
    ok: true,
    forcedCleanup: true,
    message: "stop script returned but process still alive (pid=4321)"
  });
});

test("ensureManagedServiceStoppedForPlatform fails on Windows when managed port remains occupied after cleanup", () => {
  const snapshots = [
    createManagedStopState({ port: 11949, managedPortPids: [4321] }),
    createManagedStopState({ port: 11949, managedPortPids: [4321] })
  ];
  let forceCalls = 0;

  const result = __testInternals.ensureManagedServiceStoppedForPlatform(
    { id: "agent-platform" },
    "/tmp/agent-platform",
    new Map(),
    {
      isWindows: true,
      collectState: () => snapshots.shift(),
      forceStop: () => {
        forceCalls += 1;
        return false;
      }
    }
  );

  assert.equal(forceCalls, 1);
  assert.deepEqual(result, {
    ok: false,
    forcedCleanup: true,
    message: "port 11949 still occupied by managed process after cleanup"
  });
});

test("forceStopServiceInstallDir cleans managed processes for agent-platform on Windows", () => {
  const terminatedPids = [];
  const removedPidFiles = [];

  const terminated = __testInternals.forceStopServiceInstallDir(
    { id: "agent-platform" },
    "/tmp/agent-platform",
    new Map(),
    {
      isWindows: true,
      collectState: () =>
        createManagedStopState({
          mainPidFilePath: "/tmp/agent-platform.pid",
          managedMainPid: 101,
          port: 11949,
          managedPortPids: [102]
        }),
      terminateProcessTreeImpl: (pid) => {
        terminatedPids.push(pid);
        return true;
      },
      removePidFileImpl: (pidFilePath) => {
        removedPidFiles.push(pidFilePath);
      }
    }
  );

  assert.equal(terminated, true);
  assert.deepEqual(terminatedPids, [101, 102]);
  assert.deepEqual(removedPidFiles, ["/tmp/agent-platform.pid"]);
});

test("runServiceRestart does not start the service when stop fails", async () => {
  let started = false;

  await assert.rejects(
    __testInternals.runServiceRestart(
      async () => {
        throw new Error("stop failed");
      },
      async () => {
        started = true;
        return {
          ok: true,
          message: "started",
          service: null
        };
      }
    ),
    /stop failed/
  );

  assert.equal(started, false);
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
  writeTestEnv(userDataRoot, "agent-container-hub", envContent);
  fs.writeFileSync(path.join(installDir, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(path.join(installDir, "README.txt"), "broken\n", "utf8");
  fs.mkdirSync(path.join(installDir, "configs"), { recursive: true });

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);

  assert.equal(fs.readFileSync(getTestEnvPath(userDataRoot, "agent-container-hub"), "utf8"), envContent);
  assert.ok(fs.existsSync(path.join(installDir, "start.sh")));
  assert.ok(fs.existsSync(path.join(installDir, "stop.sh")));
  assert.ok(fs.existsSync(path.join(installDir, "backend", "agent-container-hub")));
  assert.ok(fs.existsSync(path.join(installDir, "manifest.json")));
  assert.equal(__testInternals.isInstallHealthy(service, installDir), true);
  assert.notEqual((await getServiceState(app, service.id)).status, "initialization-required");
  assert.equal(readInitializationStatePath(getTestInitializationStatePath(userDataRoot, service.id))?.status, "succeeded");

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("installBuiltinService migrates env from sibling version directories and removes stale versions", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sibling-install-migrate-"));
  const envContent = "BIND_ADDR=127.0.0.1:13000\n";
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);
  const siblingInstallDir = getTestServiceProgramDir(userDataRoot, "agent-container-hub", "v9.9.9");

  fs.mkdirSync(siblingInstallDir, { recursive: true });
  fs.writeFileSync(path.join(siblingInstallDir, ".env"), envContent, "utf8");
  fs.writeFileSync(path.join(siblingInstallDir, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(path.join(siblingInstallDir, "README.txt"), "stale version\n", "utf8");

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);

  assert.equal(fs.readFileSync(getTestEnvPath(userDataRoot, "agent-container-hub"), "utf8"), envContent);
  assert.equal(fs.existsSync(siblingInstallDir), false);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("installBuiltinService normalizes preserved agent-platform env from current and sibling installs", async () => {
  for (const source of ["current-version", "sibling-version"]) {
    const fixture = createStartupCoreAssetsFixture();
    const userDataRoot = path.join(fixture.tempRoot, "user-data");
    const homeRoot = path.join(fixture.tempRoot, "home");
    const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, {
      homePath: homeRoot,
      desktopPath: path.join(homeRoot, "Desktop")
    });
    const service = getBuiltinService("agent-platform");
    const installDir = getInstallDir(app, service);
    const legacyEnv = [
      "HOST_PORT=11949",
      "CHAT_RESOURCE_TICKET_ENABLED=true",
      "CHAT_IMAGE_TOKEN_SECRET=my-secret",
      "CHAT_IMAGE_TOKEN_TTL_SECONDS=300"
    ].join("\n") + "\n";

    if (source === "current-version") {
      writeTestEnv(userDataRoot, service.id, legacyEnv);
    } else {
      const sourceDir = getTestServiceProgramDir(userDataRoot, service.id, "v0.9.0");
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, ".env"), legacyEnv, "utf8");
    }

    try {
      await installBuiltinService(app, service.id);

      const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, service.id), "utf8");
      assert.match(envContent, /^CHAT_RESOURCE_TICKET_SECRET=my-secret$/m);
      assert.match(envContent, /^CHAT_RESOURCE_TICKET_TTL_SECONDS=300$/m);
      assert.doesNotMatch(envContent, /^CHAT_RESOURCE_TICKET_ENABLED=/m);
      assert.doesNotMatch(envContent, /^CHAT_IMAGE_TOKEN_SECRET=/m);
      assert.doesNotMatch(envContent, /^CHAT_IMAGE_TOKEN_TTL_SECONDS=/m);
      assert.equal(
        fs.readFileSync(path.join(getTestConfigDir(userDataRoot, service.id), ".env.legacy-backup"), "utf8"),
        legacyEnv
      );
      if (source === "sibling-version") {
        assert.equal(fs.existsSync(getTestServiceProgramDir(userDataRoot, service.id, "v0.9.0")), false);
      }
    } finally {
      restore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  }
});

test("getServiceState exposes runtime error log path when manifest defines it", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-error-log-state-"));
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);
  const state = await getServiceState(app, service.id);

  assert.equal(state.healthMeta.logFilePath, path.join(getTestLogDir(userDataRoot, service.id), "agent-container-hub.log"));
  assert.equal(state.healthMeta.errorLogFilePath, path.join(getTestLogDir(userDataRoot, service.id), "agent-container-hub.stderr.log"));

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("readServiceLog returns main log tail metadata and content", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-read-main-log-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const logPath = path.join(getTestLogDir(userDataRoot, "test-plugin", "plugins"), "test-plugin.log");
  const logContent = "line one\nline two\n";

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, logContent, "utf8");

  const result = await readServiceLog(app, "test-plugin", "main");

  assert.equal(result.ok, true);
  assert.equal(result.path, logPath);
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
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const errorLogPath = path.join(getTestLogDir(userDataRoot, "test-plugin", "plugins"), "test-plugin.stderr.log");

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
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const logPath = path.join(getTestLogDir(userDataRoot, "test-plugin", "plugins"), "test-plugin.log");
  const logContent = "aaaa\nbbbb\ncccc\ndddd\neeee\n";

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, logContent, "utf8");

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
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const logPath = path.join(getTestLogDir(userDataRoot, "test-plugin", "plugins"), "test-plugin.log");
  const windowBytes = __testInternals.LOG_READ_WINDOW_BYTES;
  const largeLogContent = "0123456789abcdef".repeat(Math.ceil((windowBytes + 96) / 16));
  const expectedContent = largeLogContent.slice(largeLogContent.length - windowBytes);

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, largeLogContent, "utf8");

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
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const logPath = path.join(getTestLogDir(userDataRoot, "test-plugin", "plugins"), "test-plugin.log");
  const logContent = "new-tail\n";

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, logContent, "utf8");

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
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const logPath = path.join(getTestLogDir(userDataRoot, "test-plugin", "plugins"), "test-plugin.log");
  const firstLine = "very-long-first-line-without-break-until-here\n";
  const secondLine = "second-line\n";
  const logContent = `${firstLine}${secondLine}`;

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, logContent, "utf8");

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

test("watchServiceLog streams appended content from the requested offset", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-watch-log-append-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const logPath = path.join(getTestLogDir(userDataRoot, "test-plugin", "plugins"), "test-plugin.log");
  const initialContent = "ready\n";
  const events = [];

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, initialContent, "utf8");

  const stopWatch = __testInternals.watchServiceLog(
    app,
    "sub-append",
    "test-plugin",
    "main",
    {
      fromOffset: Buffer.byteLength(initialContent),
      pollIntervalMs: 250
    },
    (event) => events.push(event)
  );
  fs.appendFileSync(logPath, "next\n", "utf8");

  const event = await waitForLogStreamEvent(events, (item) => item.type === "append");
  stopWatch();

  assert.ok(event);
  assert.equal(event.subscriptionId, "sub-append");
  assert.equal(event.content, "next\n");
  assert.equal(event.startOffset, Buffer.byteLength(initialContent));
  assert.equal(event.endOffset, Buffer.byteLength(`${initialContent}next\n`));
  assert.equal(event.totalBytes, Buffer.byteLength(`${initialContent}next\n`));

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("watchServiceLog streams content when a missing log file is created", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-watch-log-create-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const logPath = path.join(getTestLogDir(userDataRoot, "test-plugin", "plugins"), "test-plugin.log");
  const events = [];

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const stopWatch = __testInternals.watchServiceLog(
    app,
    "sub-create",
    "test-plugin",
    "main",
    {
      fromOffset: 0,
      pollIntervalMs: 250
    },
    (event) => events.push(event)
  );
  fs.writeFileSync(logPath, "created\n", "utf8");

  const event = await waitForLogStreamEvent(events, (item) => item.type === "append");
  stopWatch();

  assert.ok(event);
  assert.equal(event.content, "created\n");
  assert.equal(event.startOffset, 0);
  assert.equal(event.endOffset, Buffer.byteLength("created\n"));

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("watchServiceLog sends reset when a log file is truncated", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-watch-log-reset-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const logPath = path.join(getTestLogDir(userDataRoot, "test-plugin", "plugins"), "test-plugin.log");
  const initialContent = "older\ncontent\n";
  const resetContent = "new\n";
  const events = [];

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: false
  });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, initialContent, "utf8");

  const stopWatch = __testInternals.watchServiceLog(
    app,
    "sub-reset",
    "test-plugin",
    "main",
    {
      fromOffset: Buffer.byteLength(initialContent),
      pollIntervalMs: 250
    },
    (event) => events.push(event)
  );
  fs.writeFileSync(logPath, resetContent, "utf8");

  const event = await waitForLogStreamEvent(events, (item) => item.type === "reset");
  stopWatch();

  assert.ok(event);
  assert.equal(event.content, resetContent);
  assert.equal(event.startOffset, 0);
  assert.equal(event.endOffset, Buffer.byteLength(resetContent));
  assert.match(event.message, /轮转/);

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

test("containerEngineAvailable requires a reachable engine daemon", () => {
  const detected = withSpawnSyncMock((command, args = []) => {
    if (isCommandLookup(command, args, "docker")) {
      return createSpawnSyncResult(0);
    }
    if (isCommandLookup(command, args, "podman")) {
      return createSpawnSyncResult(0);
    }
    if ((command === "docker" || command === "podman") && args[0] === "info") {
      return createSpawnSyncResult(1);
    }
    assert.fail(`unexpected spawnSync call: ${command} ${args.join(" ")}`);
  }, () => __testInternals.containerEngineAvailable());

  assert.equal(detected, "");
});

test("containerEngineAvailable falls back to podman when docker daemon is unreachable", () => {
  const detected = withSpawnSyncMock((command, args = []) => {
    if (isCommandLookup(command, args, "docker")) {
      return createSpawnSyncResult(0);
    }
    if (isCommandLookup(command, args, "podman")) {
      return createSpawnSyncResult(0);
    }
    if (command === "docker" && args[0] === "info") {
      return createSpawnSyncResult(1);
    }
    if (command === "podman" && args[0] === "info") {
      return createSpawnSyncResult(0);
    }
    assert.fail(`unexpected spawnSync call: ${command} ${args.join(" ")}`);
  }, () => __testInternals.containerEngineAvailable());

  assert.equal(detected, "podman");
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
  writeTestEnv(userDataRoot, "agent-container-hub", envContent);
  fs.writeFileSync(path.join(installDir, "start.sh"), existingStartScript, "utf8");
  fs.writeFileSync(path.join(installDir, "README.txt"), "stale\n", "utf8");

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  assert.equal(__testInternals.isInstallHealthy(service, installDir), true);

  await installBuiltinService(app, service.id, { force: true });

  assert.equal(fs.readFileSync(getTestEnvPath(userDataRoot, "agent-container-hub"), "utf8"), envContent);
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
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  writePluginInstallRoot(installDir);

  const before = await getServiceState(app, "test-plugin");
  assert.equal(before.status, "initialization-required");

  const result = await initializeService(app, "test-plugin");

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(getTestEnvPath(userDataRoot, "test-plugin", "plugins"), "utf8"), "PORT=9300\n");
  assert.equal(fs.readFileSync(path.join(installDir, "run", "deploy-marker.txt"), "utf8"), "deployed");
  const initializationState = readInitializationStatePath(
    getTestInitializationStatePath(userDataRoot, "test-plugin", "plugins")
  );
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
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    deployScriptContent: "#!/usr/bin/env bash\necho deploy failed >&2\nexit 1\n"
  });

  const result = await initializeService(app, "test-plugin");
  assert.equal(result.ok, false);
  assert.equal(
    readInitializationStatePath(getTestInitializationStatePath(userDataRoot, "test-plugin", "plugins"))?.status,
    "failed"
  );

  const state = await getServiceState(app, "test-plugin");
  assert.equal(state.status, "error");
  assert.match(state.message, /初始化失败/u);
  assert.match(state.message, /deploy failed/u);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("installBuiltinService prepares agent platform desktop config during first initialization", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-first-init-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const installDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);

  try {
    await installBuiltinService(app, "agent-platform");

    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
    const configDir = getTestConfigDir(userDataRoot, platformService.id);
    const preferredRuntimeRoot = path.join(homeRoot, ".zenmind");
    assert.match(envContent, /^AUTH_ENABLED=true$/m);
    assert.match(envContent, new RegExp(`^AUTH_LOCAL_PUBLIC_KEY_FILE=${path.join(configDir, "configs", "local-public-key.pem").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(envContent, /^HOST_PORT=7078$/m);
    assert.match(envContent, /^SERVER_PORT=7078$/m);
    assert.match(
      envContent,
      new RegExp(`REGISTRIES_DIR=${path.join(preferredRuntimeRoot, "registries").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(
      envContent,
      new RegExp(`OWNER_DIR=${path.join(preferredRuntimeRoot, "owner").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(
      envContent,
      new RegExp(`AGENTS_DIR=${path.join(preferredRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(
      envContent,
      new RegExp(`TEAMS_DIR=${path.join(preferredRuntimeRoot, "teams").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(
      envContent,
      new RegExp(`ROOT_DIR=${path.join(preferredRuntimeRoot, "root").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(
      envContent,
      new RegExp(`SCHEDULES_DIR=${path.join(preferredRuntimeRoot, "schedules").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(
      envContent,
      new RegExp(`CHATS_DIR=${path.join(preferredRuntimeRoot, "chats").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(
      envContent,
      new RegExp(`MEMORY_DIR=${path.join(preferredRuntimeRoot, "memory").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(
      envContent,
      new RegExp(`SKILLS_MARKET_DIR=${path.join(preferredRuntimeRoot, "skills-market").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(
      envContent,
      new RegExp(`PAN_DIR=${path.join(preferredRuntimeRoot, "pan").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.equal(fs.existsSync(path.join(configDir, "configs", "local-public-key.pem")), true);
  } finally {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("readServiceConfig returns template content without creating target file", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-config-template-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
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

test("writeServiceConfig keeps agent platform host and server ports aligned", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-platform-config-save-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const platformService = getBuiltinService("agent-platform");

  try {
    await installBuiltinService(app, "agent-platform");
    const result = await writeServiceConfig(
      app,
      "agent-platform",
      "env",
      "HOST_PORT=7901\nSERVER_PORT=18081\nAUTH_ENABLED=true\n"
    );
    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");

    assert.equal(result.service.healthMeta.port, 7901);
    assert.equal(result.service.healthMeta.webUrl, "http://127.0.0.1:7901");
    assert.match(envContent, /^HOST_PORT=7901$/m);
    assert.match(envContent, /^SERVER_PORT=7901$/m);
  } finally {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("writeServiceConfig syncs agent webclient upstream urls after agent platform host port save", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-platform-webclient-sync-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const webclientService = getBuiltinService("agent-webclient");
  const webclientEnvPath = getTestEnvPath(userDataRoot, webclientService.id);

  try {
    await installBuiltinService(app, "agent-platform");
    await installBuiltinService(app, "agent-webclient");
    await writeServiceConfig(
      app,
      "agent-webclient",
      "env",
      [
        "PORT=7080",
        "BASE_URL=http://127.0.0.1:7078",
        "WS_BASE_URL=http://127.0.0.1:7078",
        "VOICE_BASE_URL=http://127.0.0.1:7078"
      ].join("\n") + "\n"
    );

    await writeServiceConfig(app, "agent-platform", "env", "HOST_PORT=7901\nSERVER_PORT=7901\n");
    let envContent = fs.readFileSync(webclientEnvPath, "utf8");
    assert.match(envContent, /^BASE_URL=http:\/\/127\.0\.0\.1:7901$/m);
    assert.match(envContent, /^WS_BASE_URL=http:\/\/127\.0\.0\.1:7901$/m);
    assert.match(envContent, /^VOICE_BASE_URL=http:\/\/127\.0\.0\.1:7901$/m);

    await writeServiceConfig(app, "agent-platform", "env", "HOST_PORT=7903\nSERVER_PORT=7903\n");
    envContent = fs.readFileSync(webclientEnvPath, "utf8");
    assert.match(envContent, /^BASE_URL=http:\/\/127\.0\.0\.1:7903$/m);
    assert.match(envContent, /^WS_BASE_URL=http:\/\/127\.0\.0\.1:7903$/m);
    assert.match(envContent, /^VOICE_BASE_URL=http:\/\/127\.0\.0\.1:7903$/m);

    await writeServiceConfig(
      app,
      "agent-webclient",
      "env",
      [
        "PORT=7080",
        "BASE_URL=https://platform.example.test",
        "WS_BASE_URL=http://127.0.0.1:7903",
        "VOICE_BASE_URL=http://127.0.0.1:9999"
      ].join("\n") + "\n"
    );
    await writeServiceConfig(app, "agent-platform", "env", "HOST_PORT=7904\nSERVER_PORT=7904\n");
    envContent = fs.readFileSync(webclientEnvPath, "utf8");
    assert.match(envContent, /^BASE_URL=https:\/\/platform\.example\.test$/m);
    assert.match(envContent, /^WS_BASE_URL=http:\/\/127\.0\.0\.1:7904$/m);
    assert.match(envContent, /^VOICE_BASE_URL=http:\/\/127\.0\.0\.1:9999$/m);
  } finally {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("writeServiceConfig migrates known bad core env ports without overriding custom values", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-core-config-save-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const platformService = getBuiltinService("agent-platform");
  const webclientService = getBuiltinService("agent-webclient");
	  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
	  const webclientInstallDir = getTestServiceProgramDir(userDataRoot, webclientService.id, webclientService.version);
  const platformPidPath = getTestPidPath(userDataRoot, platformService.id, "agent-platform.pid");
  const webclientPidPath = getTestPidPath(userDataRoot, webclientService.id, "agent-webclient.pid");

  try {
    await installBuiltinService(app, "agent-platform");
    await writeServiceConfig(
      app,
      "agent-platform",
      "env",
      [
        "HOST_PORT=117078",
        "SERVER_PORT=117078",
        "CONTAINER_HUB_BASE_URL=http://127.0.0.1:117079",
        "AUTH_ENABLED=false"
      ].join("\n") + "\n"
    );
    let envContent = fs.readFileSync(path.join(platformInstallDir, ".env"), "utf8");
    assert.match(envContent, /^HOST_PORT=7078$/m);
    assert.match(envContent, /^SERVER_PORT=7078$/m);
    assert.match(envContent, /^CONTAINER_HUB_BASE_URL=http:\/\/127\.0\.0\.1:7079$/m);
    assert.match(envContent, /^AUTH_ENABLED=false$/m);

    await writeServiceConfig(app, "agent-platform", "env", "HOST_PORT=7901\nSERVER_PORT=18081\n");
    envContent = fs.readFileSync(path.join(platformInstallDir, ".env"), "utf8");
    assert.match(envContent, /^HOST_PORT=7901$/m);
    assert.match(envContent, /^SERVER_PORT=7901$/m);

    await installBuiltinService(app, "agent-webclient");
    const result = await writeServiceConfig(
      app,
      "agent-webclient",
      "env",
      [
        "NODE_ENV=development",
        "PORT=7902",
        "DEV_SERVER_ALLOWED_HOSTS=all",
        "BASE_URL=https://platform.example.test",
        "WS_BASE_URL=http://127.0.0.1:117078",
        "VOICE_BASE_URL=http://localhost:11949",
        "NODE_BIN=/tmp/stale-node"
      ].join("\n") + "\n"
    );
    envContent = fs.readFileSync(path.join(webclientInstallDir, ".env"), "utf8");
    assert.equal(result.service.healthMeta.port, 7902);
    assert.match(result.message, /重启服务后生效/u);
    assert.match(envContent, /^PORT=7902$/m);
    assert.match(envContent, /^BASE_URL=https:\/\/platform\.example\.test$/m);
    assert.match(envContent, /^WS_BASE_URL=http:\/\/127\.0\.0\.1:7901$/m);
    assert.match(envContent, /^VOICE_BASE_URL=http:\/\/127\.0\.0\.1:7901$/m);
    assert.doesNotMatch(envContent, /^NODE_BIN=/m);
    assert.doesNotMatch(envContent, /^NODE_ENV=/m);
    assert.doesNotMatch(envContent, /^DEV_SERVER_ALLOWED_HOSTS=/m);
  } finally {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startService treats a matching port listener as already running and restores the pid file", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-port-detect-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
  const app = createApp(userDataRoot);
  const port = 19300 + Math.floor(Math.random() * 1000);
  const pidFilePath = getTestPidPath(userDataRoot, "test-plugin", "test-plugin.pid", "plugins");
  let child = null;

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    port,
    deployScriptContent: false
  });
  writeTestEnv(userDataRoot, "test-plugin", `PORT=${port}\n`, "plugins");
  fs.writeFileSync(
    path.join(installDir, "start.sh"),
    "#!/usr/bin/env bash\necho should-not-run >&2\nexit 1\n",
    "utf8"
  );
  fs.chmodSync(path.join(installDir, "start.sh"), 0o755);
  fs.writeFileSync(
    (() => {
      const initStatePath = getTestInitializationStatePath(userDataRoot, "test-plugin", "plugins");
      fs.mkdirSync(path.dirname(initStatePath), { recursive: true });
      return initStatePath;
    })(),
    `${JSON.stringify(
      {
        version: "v1.0.0",
        status: "succeeded",
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const serverScriptPath = path.join(installDir, "server.js");
  fs.writeFileSync(
    serverScriptPath,
    `const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(${port}, "127.0.0.1");
setInterval(() => {}, 1000);
`,
    "utf8"
  );

  try {
    child = spawn(process.execPath, [serverScriptPath], {
      cwd: installDir,
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = await getServiceState(app, "test-plugin");
      if (state.status === "running") {
        const result = await startService(app, "test-plugin");
        assert.equal(result.ok, true);
        assert.equal(result.service.status, "running");
        assert.equal(result.service.healthMeta.pid, child.pid);
        assert.equal(fs.readFileSync(pidFilePath, "utf8").trim(), String(child.pid));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.fail("service was not detected as running before timeout");
  } finally {
    if (child?.pid) {
      try {
        process.kill(child.pid);
      } catch {
        // Child may already be gone when the test finishes.
      }
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startService rejects services that still require initialization", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-init-required-start-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "test-plugin");
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

test("startService returns a port conflict error for agent-container-hub when an external process occupies the port", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-container-hub-port-conflict-"));
  const port = await getAvailableLocalPort();
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot, {
    bindAddr: `127.0.0.1:${port}`
  });
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");
  const listenerScriptPath = path.join(tempRoot, "external-listener.mjs");
  const previousSpawnSync = childProcess.spawnSync;
  let child = null;

  fs.writeFileSync(
    listenerScriptPath,
    `import http from "node:http";
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(${port}, "127.0.0.1");
setInterval(() => {}, 1000);
`,
    "utf8"
  );

  try {
    await installBuiltinService(app, service.id);
    writeTestEnv(userDataRoot, service.id, `BIND_ADDR=127.0.0.1:${port}\n`);

    child = spawn(process.execPath, [listenerScriptPath], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    childProcess.spawnSync = (command, args = [], options = {}) => {
      if (isCommandLookup(command, args, "docker")) {
        return createSpawnSyncResult(0);
      }
      if (isCommandLookup(command, args, "podman")) {
        return createSpawnSyncResult(1);
      }
      if (command === "docker" && args[0] === "info") {
        return createSpawnSyncResult(0);
      }
      return previousSpawnSync(command, args, options);
    };

    const state = await getServiceState(app, service.id);
    assert.equal(state.status, "error");
    assert.match(state.message, new RegExp(`端口 ${port} 已被其他进程占用`));

    const result = await startService(app, service.id);
    assert.equal(result.ok, false);
    assert.equal(result.service.status, "error");
    assert.match(result.message, new RegExp(`端口 ${port} 已被其他进程占用`));
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    if (child?.pid) {
      try {
        process.kill(child.pid);
      } catch {
        // Child may already be gone when the test finishes.
      }
    }
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startService verifies command success and reports delayed container hub crash", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-container-hub-start-verify-"));
  const port = await getAvailableLocalPort();
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot, {
    bindAddr: `127.0.0.1:${port}`,
    startScriptContent: [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "mkdir -p run",
      "printf '%s\\n' 999999 > run/agent-container-hub.pid",
      "printf start-ok > run/agent-container-hub.log",
      "exit 0"
    ].join("\n")
  });
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");
  const previousSpawnSync = childProcess.spawnSync;

  try {
    await installBuiltinService(app, service.id);
    const initStatePath = __testInternals.getInitializationStatePath(installDir);
    fs.mkdirSync(path.dirname(initStatePath), { recursive: true });
    fs.writeFileSync(
      initStatePath,
      `${JSON.stringify({
        version: service.version,
        status: "succeeded",
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`,
      "utf8"
    );

    childProcess.spawnSync = (command, args = [], options = {}) => {
      if (isCommandLookup(command, args, "docker")) {
        return createSpawnSyncResult(0);
      }
      if (isCommandLookup(command, args, "podman")) {
        return createSpawnSyncResult(1);
      }
      if (command === "docker" && args[0] === "info") {
        return createSpawnSyncResult(0);
      }
      return previousSpawnSync(command, args, options);
    };

    const result = await startService(app, service.id);

    assert.equal(result.ok, false);
    assert.equal(result.service.status, "stopped");
    assert.equal(result.verification.verified, false);
    assert.equal(result.verification.desired, "running");
    assert.equal(result.verification.actualStatus, "stopped");
    assert.ok(result.verification.issues.some((issue) => /复查|stopped|PID|端口|runtime-info/u.test(issue)));
    assert.match(result.message, /启动命令已执行|启动命令执行过/);
    assert.match(result.message, /复查失败|未确认启动/);
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startService verifies running container hub with port and runtime-info probe", async (t) => {
  if (process.platform === "win32") {
    t.skip("This fixture uses a POSIX shell daemon; Windows service verification is covered by process and port parser tests.");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-container-hub-start-ok-"));
  const port = await getAvailableLocalPort();
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot, {
    bindAddr: `127.0.0.1:${port}`,
    startScriptContent: [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "mkdir -p run",
      "cat > run/container-hub-fixture.js <<'NODE'",
      "const http = require('node:http');",
      `const port = ${port};`,
      "const server = http.createServer((req, res) => {",
      "  if (req.url === '/api/runtime-info') {",
      "    res.writeHead(200, { 'content-type': 'application/json' });",
      "    res.end(JSON.stringify({ engine: 'docker', ok: true }));",
      "    return;",
      "  }",
      "  res.writeHead(200, { 'content-type': 'text/html' });",
      "  res.end('<!doctype html><title>Container Hub</title>');",
      "});",
      "server.listen(port, '127.0.0.1');",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      "NODE",
      "node \"$PWD/run/container-hub-fixture.js\" > run/agent-container-hub.log 2> run/agent-container-hub.stderr.log &",
      "printf '%s\\n' \"$!\" > run/agent-container-hub.pid",
      "for attempt in $(seq 1 50); do",
      `  node -e "require('node:http').get('http://127.0.0.1:${port}/api/runtime-info', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" && exit 0`,
      "  sleep 0.05",
      "done",
      "exit 1"
    ].join("\n")
  });
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");
  const previousSpawnSync = childProcess.spawnSync;

  try {
    await installBuiltinService(app, service.id);
    const initStatePath = __testInternals.getInitializationStatePath(installDir);
    fs.mkdirSync(path.dirname(initStatePath), { recursive: true });
    fs.writeFileSync(
      initStatePath,
      `${JSON.stringify({
        version: service.version,
        status: "succeeded",
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`,
      "utf8"
    );

    childProcess.spawnSync = (command, args = [], options = {}) => {
      if (isCommandLookup(command, args, "docker")) {
        return createSpawnSyncResult(0);
      }
      if (isCommandLookup(command, args, "podman")) {
        return createSpawnSyncResult(1);
      }
      if (command === "docker" && args[0] === "info") {
        return createSpawnSyncResult(0);
      }
      return previousSpawnSync(command, args, options);
    };

    const result = await startService(app, service.id);

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.service.status, "running");
    assert.equal(result.service.healthMeta.port, port);
    assert.equal(result.verification.verified, true);
    assert.equal(result.verification.portListening, true);
    assert.equal(result.verification.httpOk, true);
    assert.equal(result.verification.runtimeInfoOk, true);
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    const pidPath = path.join(installDir, "run", "agent-container-hub.pid");
    const pid = Number(fs.existsSync(pidPath) ? fs.readFileSync(pidPath, "utf8").trim() : 0);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ensurePreStartRequirements injects container hub url, desktop runtime paths, and manifest auth defaults for agent platform", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-prestart-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const hubService = getBuiltinService("agent-container-hub");
  const platformService = getBuiltinService("agent-platform");
  const hubInstallDir = getTestServiceProgramDir(userDataRoot, hubService.id, hubService.version);
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const desktopRuntimeRoot = path.join(homeRoot, "zenmind");

  fs.mkdirSync(hubInstallDir, { recursive: true });
  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "registries"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "agents"), { recursive: true });
  writeTestEnv(userDataRoot, hubService.id, "BIND_ADDR=0.0.0.0:12960\n");
  writeTestEnv(
    userDataRoot,
    platformService.id,
    "HOST_PORT=11949\nAGENT_CONTAINER_HUB_BASE_URL=http://host.docker.internal:11960\nAGENT_AUTH_ENABLED=false\nCHAT_RESOURCE_TICKET_ENABLED=true\nCHAT_IMAGE_TOKEN_SECRET=replace-with-your-chat-image-token-secret\nGATEWAY_WS_URL=ws://10.0.0.1:8080/ws/agent\nGATEWAY_USER_ID=demo\n",
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  try {
    await __testInternals.ensurePreStartRequirements(app, platformService);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }

  const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
  assert.match(envContent, /CONTAINER_HUB_BASE_URL=http:\/\/127\.0\.0\.1:12960/);
  assert.match(envContent, /^HOST_PORT=7078$/m);
  assert.match(envContent, /^SERVER_PORT=7078$/m);
  assert.match(envContent, /^AGENT_WS_ENABLED=true$/m);
  assert.match(envContent, /^AUTH_ENABLED=true$/m);
  assert.match(envContent, new RegExp(`^AUTH_LOCAL_PUBLIC_KEY_FILE=${path.join(getTestConfigDir(userDataRoot, platformService.id), "configs", "local-public-key.pem").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(envContent, /^PROVIDER_APIKEY_KEY_PART=0\.1\.0$/m);
  assert.doesNotMatch(envContent, /^GATEWAY_WS_URL=/m);
  assert.doesNotMatch(envContent, /^GATEWAY_USER_ID=/m);
  assert.doesNotMatch(envContent, /^AGENT_CONTAINER_HUB_BASE_URL=/m);
  assert.doesNotMatch(envContent, /^AGENT_AUTH_ENABLED=/m);
  assert.doesNotMatch(envContent, /^AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE=/m);
  assert.doesNotMatch(envContent, /^CHAT_RESOURCE_TICKET_ENABLED=/m);
  assert.doesNotMatch(envContent, /^CHAT_IMAGE_TOKEN_SECRET=/m);
  assert.doesNotMatch(envContent, /^CHAT_RESOURCE_TICKET_SECRET=/m);
  assert.match(
    fs.readFileSync(path.join(getTestConfigDir(userDataRoot, platformService.id), ".env.legacy-backup"), "utf8"),
    /^CHAT_RESOURCE_TICKET_ENABLED=true$/m
  );

  assert.doesNotMatch(envContent, /^NODE_BIN=/m);
  assert.doesNotMatch(envContent, /^CLOUDFLARED_BIN=/m);
  assert.doesNotMatch(envContent, /^CLAUDE_CODE_ACP_COMMAND=/m);
  assert.doesNotMatch(envContent, /^CLAUDE_CODE_ACP_ARGS=/m);
  assert.match(
    envContent,
    new RegExp(`REGISTRIES_DIR=${path.join(desktopRuntimeRoot, "registries").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    envContent,
    new RegExp(`AGENTS_DIR=${path.join(desktopRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("startService starts agent-platform when desktop-managed container hub is unavailable", async () => {
  const fixture = createStartupCoreAssetsFixture();
  addContainerHubAssetToFixture(fixture);
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });
  const previousSpawnSync = childProcess.spawnSync;

  try {
    await installBuiltinService(app, "agent-container-hub");
    await installBuiltinService(app, "agent-platform");

    const platformService = getBuiltinService("agent-platform");
    const platformInstallDir = getInstallDir(app, platformService);
    fs.appendFileSync(
      getTestEnvPath(userDataRoot, platformService.id),
      "CONTAINER_HUB_BASE_URL=http://127.0.0.1:11960\n",
      "utf8"
    );

    childProcess.spawnSync = (command, args = [], options = {}) => {
      if (isCommandLookup(command, args, "docker") || isCommandLookup(command, args, "podman")) {
        return createSpawnSyncResult(1);
      }
      if ((command === "docker" || command === "podman") && args[0] === "info") {
        return createSpawnSyncResult(1);
      }
      return spawnSync(command, args, options);
    };

    const result = await startService(app, "agent-platform");

    assert.equal(result.ok, true, result.message);
    assert.equal(result.service.status, "running");
    assert.equal(fs.existsSync(path.join(platformInstallDir, "run", "started.txt")), true);
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("initializeService migrates legacy relay settings into the local-cli-acp-relay plugin", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-local-cli-acp-relay-migrate-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const relayInstallDir = getTestPluginProgramDir(userDataRoot, "local-cli-acp-relay");

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  writeTestEnv(
    userDataRoot,
    platformService.id,
    [
      "HOST_PORT=11949",
      "LOCAL_CLI_ACP_RELAY_ENABLED=true",
      "LOCAL_CLI_ACP_RELAY_PORT=4555",
      "LOCAL_CLI_ACP_RELAY_AUTH_TOKEN=demo-token",
      "LOCAL_CLI_ACP_DEFAULT_CWD=/tmp/workspace",
      "LOCAL_CLI_ACP_ALLOWED_CWD_ROOTS=/tmp/workspace:/tmp/shared",
      "LOCAL_CLI_ACP_HANDSHAKE_TIMEOUT_MS=30000",
      "LOCAL_CLI_ACP_RUN_TIMEOUT_MS=900000",
      "CLAUDE_CODE_ACP_COMMAND=/custom/bin/claude-code-acp",
      "CLAUDE_CODE_ACP_ARGS=--stdio"
    ].join("\n"),
  );

  writePluginInstallRoot(relayInstallDir, {
    id: "local-cli-acp-relay",
    name: "Local CLI ACP Relay",
    port: 3220,
    deployScriptContent: false
  });
  fs.writeFileSync(
    path.join(relayInstallDir, ".env.example"),
    [
      "PORT=3220",
      "AUTH_TOKEN=",
      "NODE_BIN=",
      "CLAUDE_CODE_ACP_COMMAND=",
      "CLAUDE_CODE_ACP_ARGS=",
      "DEFAULT_CWD=~/Desktop",
      "ALLOWED_CWD_ROOTS=~/Desktop",
      "HANDSHAKE_TIMEOUT_MS=60000",
      "RUN_TIMEOUT_MS=600000"
    ].join("\n") + "\n",
    "utf8"
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  try {
    const result = await initializeService(app, "local-cli-acp-relay");
    assert.equal(result.ok, true, result.message);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }

  const relayEnvContent = fs.readFileSync(getTestEnvPath(userDataRoot, "local-cli-acp-relay", "plugins"), "utf8");
  assert.match(relayEnvContent, /^PORT=4555$/m);
  assert.match(relayEnvContent, /^AUTH_TOKEN=demo-token$/m);
  assert.match(relayEnvContent, /^DEFAULT_CWD=\/tmp\/workspace$/m);
  assert.match(relayEnvContent, /^ALLOWED_CWD_ROOTS=\/tmp\/workspace:\/tmp\/shared$/m);
  assert.match(relayEnvContent, /^HANDSHAKE_TIMEOUT_MS=30000$/m);
  assert.match(relayEnvContent, /^RUN_TIMEOUT_MS=900000$/m);
  assert.match(relayEnvContent, /^CLAUDE_CODE_ACP_COMMAND=\/custom\/bin\/claude-code-acp$/m);
  assert.match(relayEnvContent, /^CLAUDE_CODE_ACP_ARGS=--stdio$/m);
  assert.match(relayEnvContent, /^NODE_BIN=$/m);

  const platformEnvContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
  assert.doesNotMatch(platformEnvContent, /^LOCAL_CLI_ACP_RELAY_/m);
  assert.doesNotMatch(platformEnvContent, /^CLAUDE_CODE_ACP_COMMAND=/m);
  assert.doesNotMatch(platformEnvContent, /^CLAUDE_CODE_ACP_ARGS=/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements preserves a custom provider api key env part", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-provider-key-part-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  writeTestEnv(
    userDataRoot,
    platformService.id,
    [
      "HOST_PORT=11949",
      "PROVIDER_APIKEY_KEY_PART=custom-key-part"
    ].join("\n"),
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  try {
    await __testInternals.ensurePreStartRequirements(app, platformService);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }

  const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
  assert.match(envContent, /^PROVIDER_APIKEY_KEY_PART=custom-key-part$/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements fills default desktop ACP command for the local-cli-acp-relay plugin", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-local-cli-acp-relay-defaults-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const relayInstallDir = getTestPluginProgramDir(userDataRoot, "local-cli-acp-relay");

  writePluginInstallRoot(relayInstallDir, {
    id: "local-cli-acp-relay",
    name: "Local CLI ACP Relay",
    port: 3220,
    deployScriptContent: false
  });
  writeTestEnv(
    userDataRoot,
    "local-cli-acp-relay",
    [
      "PORT=3220",
      "AUTH_TOKEN=",
      "NODE_BIN=",
      "CLAUDE_CODE_ACP_COMMAND=",
      "CLAUDE_CODE_ACP_ARGS=",
      "DEFAULT_CWD=",
      "ALLOWED_CWD_ROOTS=",
      "HANDSHAKE_TIMEOUT_MS=",
      "RUN_TIMEOUT_MS="
    ].join("\n") + "\n",
    "plugins"
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  try {
    await __testInternals.ensurePreStartRequirements(app, getService("local-cli-acp-relay"));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }

  const relayEnvContent = fs.readFileSync(getTestEnvPath(userDataRoot, "local-cli-acp-relay", "plugins"), "utf8");
  assert.match(relayEnvContent, /^NODE_BIN=$/m);
  const locator = process.platform === "win32" ? "where" : "which";
  const acpResult = spawnSync(locator, ["claude-code-acp"], { encoding: "utf8", timeout: 1500 });
  if (acpResult.status === 0 && !acpResult.error) {
    const resolvedAcp = acpResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean);
    if (resolvedAcp) {
      const expectedAcpLiteral = resolvedAcp.includes(" ") ? `"${resolvedAcp}"` : resolvedAcp;
      assert.match(
        relayEnvContent,
        new RegExp(`CLAUDE_CODE_ACP_COMMAND=${expectedAcpLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
      assert.match(relayEnvContent, /^CLAUDE_CODE_ACP_ARGS=""$/m);
    }
  } else {
    const npxResult = spawnSync(locator, ["npx"], { encoding: "utf8", timeout: 1500 });
    if (npxResult.status === 0 && !npxResult.error) {
      const resolvedNpx = npxResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean);
      if (resolvedNpx) {
        const expectedNpxLiteral = resolvedNpx.includes(" ") ? `"${resolvedNpx}"` : resolvedNpx;
        assert.match(
          relayEnvContent,
          new RegExp(`CLAUDE_CODE_ACP_COMMAND=${expectedNpxLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
        );
        assert.match(relayEnvContent, /^CLAUDE_CODE_ACP_ARGS='-y @zed-industries\/claude-code-acp'$/m);
      }
    }
  }
  assert.match(relayEnvContent, /^DEFAULT_CWD=.*Desktop$/m);
  assert.match(relayEnvContent, /^ALLOWED_CWD_ROOTS=.*Desktop$/m);
  assert.match(relayEnvContent, /^HANDSHAKE_TIMEOUT_MS=60000$/m);
  assert.match(relayEnvContent, /^RUN_TIMEOUT_MS=600000$/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements migrates legacy RUNTIME_DIR to supported runtime paths", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-runtime-root-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const legacyRuntimeRoot = path.join(tempRoot, "legacy-runtime");

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.mkdirSync(path.join(homeRoot, "zenmind", "registries"), { recursive: true });
  fs.mkdirSync(path.join(homeRoot, "zenmind", "agents"), { recursive: true });
  writeTestEnv(
    userDataRoot,
    platformService.id,
    `HOST_PORT=11949\nRUNTIME_DIR=${legacyRuntimeRoot}\n`,
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  try {
    await __testInternals.ensurePreStartRequirements(app, platformService);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }

  const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
  assert.doesNotMatch(envContent, /^RUNTIME_DIR=/m);
  assert.match(
    envContent,
    new RegExp(`REGISTRIES_DIR=${path.join(legacyRuntimeRoot, "registries").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    envContent,
    new RegExp(`AGENTS_DIR=${path.join(legacyRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements migrates stale legacy desktop runtime paths to the preferred existing runtime root", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-runtime-migrate-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const legacyRuntimeRoot = path.join(homeRoot, "zenmind");
  const preferredRuntimeRoot = path.join(homeRoot, ".zenmind");
  const secondaryRuntimeRoot = path.join(homeRoot, "Desktop", "zenmind-env");

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.mkdirSync(path.join(legacyRuntimeRoot, "chats"), { recursive: true });
  fs.mkdirSync(path.join(preferredRuntimeRoot, "agents", "demoAgent"), { recursive: true });
  fs.mkdirSync(path.join(preferredRuntimeRoot, "registries", "providers"), { recursive: true });
  fs.mkdirSync(path.join(preferredRuntimeRoot, "teams"), { recursive: true });
  fs.mkdirSync(path.join(preferredRuntimeRoot, "chats"), { recursive: true });
  fs.mkdirSync(path.join(secondaryRuntimeRoot, "agents", "secondaryAgent"), { recursive: true });
  fs.mkdirSync(path.join(secondaryRuntimeRoot, "registries", "providers"), { recursive: true });
  fs.mkdirSync(path.join(secondaryRuntimeRoot, "teams"), { recursive: true });
  fs.mkdirSync(path.join(secondaryRuntimeRoot, "chats"), { recursive: true });
  fs.writeFileSync(path.join(preferredRuntimeRoot, "agents", "demoAgent", "agent.yml"), "name: demo\n", "utf8");
  fs.writeFileSync(path.join(preferredRuntimeRoot, "registries", "providers", "demo.yml"), "key: demo\n", "utf8");
  fs.writeFileSync(path.join(secondaryRuntimeRoot, "agents", "secondaryAgent", "agent.yml"), "name: secondary\n", "utf8");
  fs.writeFileSync(path.join(secondaryRuntimeRoot, "registries", "providers", "secondary.yml"), "key: secondary\n", "utf8");

  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    [
      "HOST_PORT=11949",
      `REGISTRIES_DIR=${legacyRuntimeRoot}/registries`,
      `OWNER_DIR=${legacyRuntimeRoot}/owner`,
      `AGENTS_DIR=${legacyRuntimeRoot}/agents`,
      `TEAMS_DIR=${legacyRuntimeRoot}/teams`,
      `ROOT_DIR=${legacyRuntimeRoot}/root`,
      `SCHEDULES_DIR=${legacyRuntimeRoot}/schedules`,
      `CHATS_DIR=${legacyRuntimeRoot}/chats`,
      `MEMORY_DIR=${legacyRuntimeRoot}/memory`,
      `PAN_DIR=${legacyRuntimeRoot}/pan`,
      `SKILLS_MARKET_DIR=${legacyRuntimeRoot}/skills-market`
    ].join("\n"),
    "utf8"
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  try {
    await __testInternals.ensurePreStartRequirements(app, platformService);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }

  const envContent = fs.readFileSync(path.join(platformInstallDir, ".env"), "utf8");
  assert.match(
    envContent,
    new RegExp(`AGENTS_DIR=${path.join(preferredRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    envContent,
    new RegExp(`REGISTRIES_DIR=${path.join(preferredRuntimeRoot, "registries").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.doesNotMatch(
    envContent,
    new RegExp(`AGENTS_DIR=${path.join(legacyRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements uses the resolved desktop path when the runtime root lives outside ~/Desktop", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-runtime-desktop-path-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const desktopPath = path.join(homeRoot, "OneDrive", "Desktop");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const legacyRuntimeRoot = path.join(homeRoot, "zenmind");
  const desktopRuntimeRoot = path.join(desktopPath, "zenmind-env");

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.mkdirSync(path.join(legacyRuntimeRoot, "chats"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "agents", "desktopAgent"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "registries", "providers"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "teams"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "chats"), { recursive: true });
  fs.writeFileSync(path.join(desktopRuntimeRoot, "agents", "desktopAgent", "agent.yml"), "name: desktop\n", "utf8");
  fs.writeFileSync(path.join(desktopRuntimeRoot, "registries", "providers", "desktop.yml"), "key: desktop\n", "utf8");

  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    [
      "HOST_PORT=11949",
      `REGISTRIES_DIR=${legacyRuntimeRoot}/registries`,
      `OWNER_DIR=${legacyRuntimeRoot}/owner`,
      `AGENTS_DIR=${legacyRuntimeRoot}/agents`,
      `TEAMS_DIR=${legacyRuntimeRoot}/teams`,
      `ROOT_DIR=${legacyRuntimeRoot}/root`,
      `SCHEDULES_DIR=${legacyRuntimeRoot}/schedules`,
      `CHATS_DIR=${legacyRuntimeRoot}/chats`,
      `MEMORY_DIR=${legacyRuntimeRoot}/memory`,
      `PAN_DIR=${legacyRuntimeRoot}/pan`,
      `SKILLS_MARKET_DIR=${legacyRuntimeRoot}/skills-market`
    ].join("\n"),
    "utf8"
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  try {
    await __testInternals.ensurePreStartRequirements(app, platformService);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }

  const envContent = fs.readFileSync(path.join(platformInstallDir, ".env"), "utf8");
  assert.match(
    envContent,
    new RegExp(`AGENTS_DIR=${path.join(desktopRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    envContent,
    new RegExp(`REGISTRIES_DIR=${path.join(desktopRuntimeRoot, "registries").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.doesNotMatch(
    envContent,
    new RegExp(`AGENTS_DIR=${path.join(legacyRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements also detects a hidden .zenmind runtime root on the desktop", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-runtime-hidden-desktop-root-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const desktopPath = path.join(homeRoot, "OneDrive", "Desktop");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const legacyRuntimeRoot = path.join(homeRoot, "zenmind");
  const desktopRuntimeRoot = path.join(desktopPath, ".zenmind");

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.mkdirSync(path.join(legacyRuntimeRoot, "chats"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "agents", "desktopAgent"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "registries", "providers"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "teams"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "chats"), { recursive: true });
  fs.writeFileSync(path.join(desktopRuntimeRoot, "agents", "desktopAgent", "agent.yml"), "name: desktop\n", "utf8");
  fs.writeFileSync(path.join(desktopRuntimeRoot, "registries", "providers", "desktop.yml"), "key: desktop\n", "utf8");

  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    [
      "HOST_PORT=11949",
      `REGISTRIES_DIR=${legacyRuntimeRoot}/registries`,
      `OWNER_DIR=${legacyRuntimeRoot}/owner`,
      `AGENTS_DIR=${legacyRuntimeRoot}/agents`,
      `TEAMS_DIR=${legacyRuntimeRoot}/teams`,
      `ROOT_DIR=${legacyRuntimeRoot}/root`,
      `SCHEDULES_DIR=${legacyRuntimeRoot}/schedules`,
      `CHATS_DIR=${legacyRuntimeRoot}/chats`,
      `MEMORY_DIR=${legacyRuntimeRoot}/memory`,
      `PAN_DIR=${legacyRuntimeRoot}/pan`,
      `SKILLS_MARKET_DIR=${legacyRuntimeRoot}/skills-market`
    ].join("\n"),
    "utf8"
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  try {
    await __testInternals.ensurePreStartRequirements(app, platformService);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }

  const envContent = fs.readFileSync(path.join(platformInstallDir, ".env"), "utf8");
  assert.match(
    envContent,
    new RegExp(`AGENTS_DIR=${path.join(desktopRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    envContent,
    new RegExp(`REGISTRIES_DIR=${path.join(desktopRuntimeRoot, "registries").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements refreshes stale agent-webclient install and rewrites BASE_URL to local agent-platform", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-webclient-prestart-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const platformService = getBuiltinService("agent-platform");
  const webclientService = getBuiltinService("agent-webclient");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const webclientInstallDir = getTestServiceProgramDir(userDataRoot, webclientService.id, webclientService.version);

  fs.mkdirSync(path.join(platformInstallDir, "run"), { recursive: true });
  writeTestEnv(userDataRoot, platformService.id, "SERVER_PORT=12949\n");
  await installBuiltinService(app, webclientService.id);
  writeTestEnv(
    userDataRoot,
    webclientService.id,
    [
      "NODE_ENV=development",
      "DEV_SERVER_ALLOWED_HOSTS=all",
      "BASE_URL=http://localhost:11949",
      "WS_BASE_URL=http://localhost:11949",
      "VOICE_BASE_URL=http://127.0.0.1:117078",
      "NODE_BIN=/tmp/stale-node"
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(webclientInstallDir, "backend", "server.cjs"),
    [
      "const http = require('http');",
      "const https = require('https');",
      "const server = http.createServer();",
      "function createWebSocketProxy() {",
      "  return (secure ? https : http).request;",
      "}",
      "server.on('upgrade', () => {});",
      "module.exports = { createWebSocketProxy };"
    ].join("\n") + "\n",
    "utf8"
  );

  assert.equal(__testInternals.agentWebclientInstallNeedsRefresh(webclientInstallDir), true);

  await __testInternals.ensurePreStartRequirements(app, webclientService);

  const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, webclientService.id), "utf8");
  const serverContent = fs.readFileSync(path.join(webclientInstallDir, "backend", "server.cjs"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(webclientInstallDir, "manifest.json"), "utf8"));
  assert.match(envContent, /BASE_URL=http:\/\/127\.0\.0\.1:12949/);
  assert.match(envContent, /WS_BASE_URL=http:\/\/127\.0\.0\.1:12949/);
  assert.match(envContent, /VOICE_BASE_URL=http:\/\/127\.0\.0\.1:12949/);
  assert.match(envContent, /PORT=7080/);
  assert.doesNotMatch(envContent, /^NODE_BIN=/m);
  assert.doesNotMatch(envContent, /^NODE_ENV=/m);
  assert.doesNotMatch(envContent, /^DEV_SERVER_ALLOWED_HOSTS=/m);
  assert.match(envContent, /^DESKTOP_APP=true$/m);
  assert.match(serverContent, /function createWebSocketProxy\(/);
  assert.match(serverContent, /proxy\.upgrade\(req, socket, head\)/);
  assert.doesNotMatch(serverContent, /function buildUpgradeRequest\(/);
  assert.doesNotMatch(serverContent, /\(secure \? https : http\)\.request/);
  assert.equal(__testInternals.agentWebclientInstallNeedsRefresh(webclientInstallDir), false);
  assert.equal(manifest.backend.entry, "backend/server.cjs");
  assert.equal(manifest.frontend.embedPath, "/");
  assert.equal(manifest.frontend.embedParams?.desktopApp, undefined);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("startService injects core service NODE_BIN without persisting it to env", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });
  const platformService = getBuiltinService("agent-platform");
  const webclientService = getBuiltinService("agent-webclient");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const webclientInstallDir = getTestServiceProgramDir(userDataRoot, webclientService.id, webclientService.version);
  const startFileName = process.platform === "win32" ? "start.ps1" : "start.sh";
  const expectedNodeBin = __testInternals.resolveNodeBin();
  const expectedNodeBinLiteral = expectedNodeBin.includes(" ") ? `"${expectedNodeBin}"` : expectedNodeBin;

  try {
    await installBuiltinService(app, "agent-platform");
    await installBuiltinService(app, "agent-webclient");

    if (process.platform === "win32") {
      fs.writeFileSync(
        path.join(platformInstallDir, startFileName),
        [
          "$runDir = Join-Path $PSScriptRoot 'run'",
          "New-Item -ItemType Directory -Path $runDir -Force | Out-Null",
	          "if (-not $env:NODE_BIN) { throw 'missing NODE_BIN' }",
	          "$env:NODE_BIN | Set-Content -LiteralPath (Join-Path $runDir 'node-bin.txt')",
	          "$proc = Start-Process -FilePath $env:NODE_BIN -ArgumentList '-e','setInterval(() => {}, 1000)' -WindowStyle Hidden -PassThru",
	          `$proc.Id | Set-Content -LiteralPath '${platformPidPath.replace(/'/g, "''")}'`,
          "Set-Content -LiteralPath (Join-Path $runDir 'started.txt') -Value 'started'"
        ].join("\r\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(webclientInstallDir, startFileName),
        [
          "$runDir = Join-Path $PSScriptRoot 'run'",
          "New-Item -ItemType Directory -Path $runDir -Force | Out-Null",
	          "if (-not $env:NODE_BIN) { throw 'missing NODE_BIN' }",
	          "$env:NODE_BIN | Set-Content -LiteralPath (Join-Path $runDir 'node-bin.txt')",
	          "$proc = Start-Process -FilePath $env:NODE_BIN -ArgumentList '-e','setInterval(() => {}, 1000)' -WindowStyle Hidden -PassThru",
	          `$proc.Id | Set-Content -LiteralPath '${webclientPidPath.replace(/'/g, "''")}'`,
          "Set-Content -LiteralPath (Join-Path $runDir 'started.txt') -Value 'started'"
        ].join("\r\n"),
        "utf8"
      );
    } else {
      fs.writeFileSync(
        path.join(platformInstallDir, startFileName),
        [
          "#!/usr/bin/env bash",
	          "set -euo pipefail",
	          "mkdir -p run",
          'pid_dir="${ZENMIND_SERVICE_STATE_DIR:-$PWD/run}/pid"',
          'if [ -z "${ZENMIND_SERVICE_STATE_DIR:-}" ]; then pid_dir="$PWD/run"; fi',
          'mkdir -p "$pid_dir"',
	          ': "${NODE_BIN:?missing NODE_BIN}"',
	          'printf "%s" "$NODE_BIN" > run/node-bin.txt',
	          '"$NODE_BIN" -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 &',
          'echo $! > "$pid_dir/agent-platform.pid"',
          "printf started > run/started.txt"
        ].join("\n") + "\n",
        "utf8"
      );
      fs.chmodSync(path.join(platformInstallDir, startFileName), 0o755);
      fs.writeFileSync(
        path.join(webclientInstallDir, startFileName),
        [
          "#!/usr/bin/env bash",
	          "set -euo pipefail",
	          "mkdir -p run",
          'pid_dir="${ZENMIND_SERVICE_STATE_DIR:-$PWD/run}/pid"',
          'if [ -z "${ZENMIND_SERVICE_STATE_DIR:-}" ]; then pid_dir="$PWD/run"; fi',
          'mkdir -p "$pid_dir"',
	          ': "${NODE_BIN:?missing NODE_BIN}"',
	          'printf "%s" "$NODE_BIN" > run/node-bin.txt',
	          '"$NODE_BIN" -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 &',
          'echo $! > "$pid_dir/agent-webclient.pid"',
          "printf started > run/started.txt"
        ].join("\n") + "\n",
        "utf8"
      );
      fs.chmodSync(path.join(webclientInstallDir, startFileName), 0o755);
    }

    const platformResult = await startService(app, "agent-platform");
    assert.equal(platformResult.ok, true, platformResult.message);
    assert.equal(fs.readFileSync(path.join(platformInstallDir, "run", "node-bin.txt"), "utf8"), expectedNodeBin);

    const webclientResult = await startService(app, "agent-webclient");
    assert.equal(webclientResult.ok, true, webclientResult.message);
    assert.equal(fs.readFileSync(path.join(webclientInstallDir, "run", "node-bin.txt"), "utf8"), expectedNodeBin);

	    const platformEnvContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
    assert.doesNotMatch(
      platformEnvContent,
      new RegExp(`^NODE_BIN=${expectedNodeBinLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m")
    );
    assert.doesNotMatch(platformEnvContent, /^NODE_BIN=/m);
    assert.doesNotMatch(platformEnvContent, /^CLOUDFLARED_BIN=/m);

	    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, webclientService.id), "utf8");
    assert.doesNotMatch(envContent, new RegExp(`^NODE_BIN=${expectedNodeBinLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
    assert.doesNotMatch(envContent, /^NODE_BIN=/m);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("startService injects local-cli-acp-relay NODE_BIN without persisting it to env", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-relay-node-bin-start-env-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "local-cli-acp-relay");
  const app = createApp(userDataRoot);
  const expectedNodeBin = __testInternals.resolveNodeBin();
  const expectedNodeBinLiteral = expectedNodeBin.includes(" ") ? `"${expectedNodeBin}"` : expectedNodeBin;
  const relayPidPath = getTestPidPath(userDataRoot, "local-cli-acp-relay", "test-plugin.pid", "plugins");

  registryInternals.clearServices();
  try {
    writePluginInstallRoot(installDir, {
      id: "local-cli-acp-relay",
      name: "Local CLI ACP Relay",
      port: 3220,
      deployScriptContent: false
    });
    fs.writeFileSync(
      path.join(installDir, ".env.example"),
      [
        "PORT=3220",
        "AUTH_TOKEN=",
        "NODE_BIN=",
        "CLAUDE_CODE_ACP_COMMAND=",
        "CLAUDE_CODE_ACP_ARGS=",
        "DEFAULT_CWD=~/Desktop",
        "ALLOWED_CWD_ROOTS=~/Desktop",
        "HANDSHAKE_TIMEOUT_MS=60000",
        "RUN_TIMEOUT_MS=600000"
      ].join("\n") + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(installDir, "start.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "mkdir -p run",
        'pid_dir="${ZENMIND_SERVICE_STATE_DIR:-$PWD/run}/pid"',
        'if [ -z "${ZENMIND_SERVICE_STATE_DIR:-}" ]; then pid_dir="$PWD/run"; fi',
        'mkdir -p "$pid_dir"',
        ': "${NODE_BIN:?missing NODE_BIN}"',
        'printf "%s" "$NODE_BIN" > run/node-bin.txt',
        '"$NODE_BIN" -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 &',
        'echo $! > "$pid_dir/test-plugin.pid"',
        "printf started > run/started.txt"
      ].join("\n") + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(installDir, "stop.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `pid_file="${relayPidPath}"`,
        'if [ -f "$pid_file" ]; then',
        '  kill "$(cat "$pid_file")" >/dev/null 2>&1 || true',
        '  rm -f "$pid_file"',
        "fi"
      ].join("\n") + "\n",
      "utf8"
    );
    fs.chmodSync(path.join(installDir, "start.sh"), 0o755);
    fs.chmodSync(path.join(installDir, "stop.sh"), 0o755);

    const initResult = await initializeService(app, "local-cli-acp-relay");
    assert.equal(initResult.ok, true, initResult.message);

    const startResult = await startService(app, "local-cli-acp-relay");
    assert.equal(startResult.ok, true, startResult.message);
    assert.equal(fs.readFileSync(path.join(installDir, "run", "node-bin.txt"), "utf8"), expectedNodeBin);

    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, "local-cli-acp-relay", "plugins"), "utf8");
    assert.doesNotMatch(
      envContent,
      new RegExp(`^NODE_BIN=${expectedNodeBinLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m")
    );
    assert.match(envContent, /^NODE_BIN=$/m);
  } finally {
    try {
      await stopService(app, "local-cli-acp-relay");
    } catch {
      // Ignore cleanup failures for synthetic fixtures.
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("agentWebclientInstallNeedsRefresh catches server.cjs installs with stale dependency checks", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-webclient-stale-launcher-"));
  const installDir = path.join(tempRoot, "agent-webclient");

  fs.mkdirSync(path.join(installDir, "backend"), { recursive: true });
  fs.mkdirSync(path.join(installDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, "manifest.json"),
    JSON.stringify({
      backend: {
        entry: "backend/server.cjs"
      },
      runtime: {
        requiredPaths: [
          "backend/server.cjs",
          "start.sh",
          "stop.sh",
          "deploy.sh",
          "scripts/program-common.sh",
          ".env.example",
          "manifest.json",
          "frontend/dist/index.html"
        ]
      }
    }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(installDir, "backend", "server.cjs"),
    [
      "const http = require('http');",
      "const server = http.createServer();",
      "function createWebSocketProxy() {",
      "  return { upgrade(req, socket, head) { proxy.upgrade(req, socket, head); } };",
      "}",
      "const proxy = createWebSocketProxy();",
      "server.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head));"
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(installDir, "scripts", "program-common.sh"),
    [
      "#!/usr/bin/env bash",
      "BACKEND_ENTRY=\"$BUNDLE_ROOT/backend/server.cjs\"",
      "BACKEND_PACKAGE_FILE=\"$BUNDLE_ROOT/backend/package.json\"",
      "BACKEND_NODE_MODULES_DIR=\"$BUNDLE_ROOT/backend/node_modules\""
    ].join("\n") + "\n",
    "utf8"
  );

  assert.equal(__testInternals.agentWebclientInstallNeedsRefresh(installDir), true);

  fs.writeFileSync(
    path.join(installDir, "scripts", "program-common.sh"),
    "#!/usr/bin/env bash\nBACKEND_ENTRY=\"$BUNDLE_ROOT/backend/server.cjs\"\n",
    "utf8"
  );

  assert.equal(__testInternals.agentWebclientInstallNeedsRefresh(installDir), false);

  fs.writeFileSync(
    path.join(installDir, "scripts", "program-common.sh"),
    "#!/usr/bin/env bash\nBACKEND_ENTRY=\"/backend/server.cjs\"\n",
    "utf8"
  );

  assert.equal(__testInternals.agentWebclientInstallNeedsRefresh(installDir), true);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("initializeService refreshes stale agent-webclient launcher before deploy", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });
  const service = getBuiltinService("agent-webclient");
  const installDir = getTestServiceProgramDir(userDataRoot, service.id, service.version);
  const programCommonPath = path.join(installDir, "scripts", "program-common.sh");

  await installBuiltinService(app, service.id);
  fs.writeFileSync(
    programCommonPath,
    "#!/usr/bin/env bash\nBACKEND_ENTRY=\"/backend/server.cjs\"\n",
    "utf8"
  );
  assert.equal(__testInternals.agentWebclientInstallNeedsRefresh(installDir), true);

  const result = await initializeService(app, service.id);
  assert.equal(result.ok, true);

  const programCommon = fs.readFileSync(programCommonPath, "utf8");
  assert.match(programCommon, /BACKEND_ENTRY="\$BUNDLE_ROOT\/backend\/server\.cjs"/);
  assert.doesNotMatch(programCommon, /BACKEND_ENTRY="\/backend\/server\.cjs"/);
  assert.equal(__testInternals.agentWebclientInstallNeedsRefresh(installDir), false);

  restore();
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements refreshes stale zenmind-app-server install when admin frontend paths drift", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-app-server-prestart-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const fixture = createStartupCoreAssetsFixture();
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot);
  const service = getBuiltinService("zenmind-app-server");
  const installDir = getTestServiceProgramDir(userDataRoot, service.id, service.version);

  await installBuiltinService(app, service.id);
  const installedManifestPath = path.join(installDir, "manifest.json");
  const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
  fs.writeFileSync(
    installedManifestPath,
    JSON.stringify({
      ...installedManifest,
      frontend: {
        ...installedManifest.frontend,
        entry: "/"
      },
      web: {
        ...installedManifest.web,
        routePath: "/"
      }
    }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(installDir, "frontend", "dist", "index.html"),
    "<!doctype html><html><head><script type=\"module\" src=\"/assets/index.js\"></script></head><body></body></html>\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(installDir, ".env"),
    `SERVER_PORT=${service.web.defaultPort}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(installDir, "scripts", "program-common.sh"),
    "#!/usr/bin/env bash\n\"$BACKEND_BIN\" >\"$BACKEND_LOG\" 2>&1 &\n",
    "utf8"
  );

  assert.equal(__testInternals.zenmindAppServerInstallNeedsRefresh(installDir), true);

  await __testInternals.ensurePreStartRequirements(app, service);

  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, "manifest.json"), "utf8"));
  const indexContent = fs.readFileSync(path.join(installDir, "frontend", "dist", "index.html"), "utf8");
  const envContent = fs.readFileSync(path.join(installDir, ".env"), "utf8");
  const programCommon = fs.readFileSync(path.join(installDir, "scripts", "program-common.sh"), "utf8");
  assert.equal(manifest.frontend.entry, "/admin/");
  assert.equal(manifest.web.routePath, "/admin/");
  assert.match(indexContent, /\/admin\/assets\//);
  assert.match(envContent, /FRONTEND_DIST_DIR=\.\/frontend\/dist/);
  assert.match(programCommon, /nohup "\$BACKEND_BIN"/);
  assert.equal(__testInternals.zenmindAppServerInstallNeedsRefresh(installDir), false);

  restore();
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("startService refreshes a stale running zenmind-app-server install before reusing it", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });
  const service = getBuiltinService("zenmind-app-server");
  const installDir = getTestServiceProgramDir(userDataRoot, service.id, service.version);

  try {
    await installBuiltinService(app, service.id);
    const servicePort = await getAvailableLocalPort();
    const envPath = path.join(installDir, ".env");
    fs.writeFileSync(
      envPath,
      fs.readFileSync(envPath, "utf8").replace(/^SERVER_PORT=.*$/m, `SERVER_PORT=${servicePort}`),
      "utf8"
    );
    const firstStart = await startService(app, service.id);
    assert.equal(firstStart.ok, true);
    assert.equal(firstStart.service.status, "running");
    const oldPid = firstStart.service.healthMeta.pid;
    assert.ok(oldPid, "expected first start to record a pid");

    const installedManifestPath = path.join(installDir, "manifest.json");
    const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
    fs.writeFileSync(
      installedManifestPath,
      JSON.stringify({
        ...installedManifest,
        frontend: {
          ...installedManifest.frontend,
          entry: "/"
        },
        web: {
          ...installedManifest.web,
          routePath: "/"
        }
      }, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(installDir, "frontend", "dist", "index.html"),
      "<!doctype html><html><head><script type=\"module\" src=\"/assets/index.js\"></script></head><body></body></html>\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(installDir, ".env"),
      `SERVER_PORT=${servicePort}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(installDir, "scripts", "program-common.sh"),
      "#!/usr/bin/env bash\n\"$BACKEND_BIN\" >\"$BACKEND_LOG\" 2>&1 &\n",
      "utf8"
    );

    const secondStart = await startService(app, service.id);
    assert.equal(secondStart.ok, true);
    assert.equal(secondStart.service.status, "running");
    assert.notEqual(secondStart.service.healthMeta.pid, oldPid);
    assert.equal(await waitForPidExit(oldPid), true);

    const manifest = JSON.parse(fs.readFileSync(path.join(installDir, "manifest.json"), "utf8"));
    const indexContent = fs.readFileSync(path.join(installDir, "frontend", "dist", "index.html"), "utf8");
    const envContent = fs.readFileSync(path.join(installDir, ".env"), "utf8");
    assert.equal(manifest.frontend.entry, "/admin/");
    assert.equal(manifest.web.routePath, "/admin/");
    assert.match(indexContent, /\/admin\/assets\//);
    assert.match(envContent, /FRONTEND_DIST_DIR=\.\/frontend\/dist/);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("startService restarts a running agent-webclient after agent-platform is manually restarted", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });

  try {
    const firstPlatformStart = await startService(app, "agent-platform");
    assert.equal(firstPlatformStart.ok, true, firstPlatformStart.message);

    const firstWebclientStart = await startService(app, "agent-webclient");
    assert.equal(firstWebclientStart.ok, true, firstWebclientStart.message);
    const firstWebclientPid = firstWebclientStart.service.healthMeta.pid;
    assert.ok(firstWebclientPid, "expected agent-webclient to have a pid after first start");

    const platformStop = await stopService(app, "agent-platform");
    assert.equal(platformStop.ok, true, platformStop.message);

    const secondPlatformStart = await startService(app, "agent-platform");
    assert.equal(secondPlatformStart.ok, true, secondPlatformStart.message);

    const webclientState = await getServiceState(app, "agent-webclient");
    assert.equal(webclientState.status, "running");
    assert.ok(webclientState.healthMeta.pid, "expected agent-webclient to have a pid after platform restart");
    assert.notEqual(webclientState.healthMeta.pid, firstWebclientPid);
    assert.equal(await waitForPidExit(firstWebclientPid), true);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("startService restarts a running agent-webclient when agent-platform is refreshed while running", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });
  const platformArchiveDir = path.join(fixture.assetsRoot, "agent-platform");
  const platformArchivePath = path.join(platformArchiveDir, fs.readdirSync(platformArchiveDir)[0]);

  try {
    const firstPlatformStart = await startService(app, "agent-platform");
    assert.equal(firstPlatformStart.ok, true, firstPlatformStart.message);

    const firstWebclientStart = await startService(app, "agent-webclient");
    assert.equal(firstWebclientStart.ok, true, firstWebclientStart.message);
    const firstWebclientPid = firstWebclientStart.service.healthMeta.pid;
    assert.ok(firstWebclientPid, "expected agent-webclient to have a pid after first start");

    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(platformArchivePath, future, future);

    const secondPlatformStart = await startService(app, "agent-platform");
    assert.equal(secondPlatformStart.ok, true, secondPlatformStart.message);

    const webclientState = await getServiceState(app, "agent-webclient");
    assert.equal(webclientState.status, "running");
    assert.ok(webclientState.healthMeta.pid, "expected agent-webclient to have a pid after platform refresh");
    assert.notEqual(webclientState.healthMeta.pid, firstWebclientPid);
    assert.equal(await waitForPidExit(firstWebclientPid), true);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("last running services state round-trips through disk", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-last-running-services-"));
  const app = createApp(tempRoot);

  __testInternals.writeLastRunningServices(app, [
    "agent-platform",
    "agent-webclient",
    "agent-platform",
    "zenmind-app-server"
  ]);

  const statePath = __testInternals.getLastRunningServicesStatePath(app);
  assert.ok(fs.existsSync(statePath));
  assert.deepEqual(__testInternals.readLastRunningServices(app), [
    "zenmind-app-server",
    "agent-platform",
    "agent-webclient"
  ]);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("restore order prioritizes service dependencies", () => {
  assert.deepEqual(
    __testInternals.orderServiceIdsForRestore([
      "agent-webclient",
      "zenmind-app-server",
      "agent-platform",
      "agent-container-hub",
      "custom-plugin"
    ]),
    [
      "agent-container-hub",
      "zenmind-app-server",
      "agent-platform",
      "agent-webclient",
      "custom-plugin"
    ]
  );
});

test("startup restore always includes default quick-start services", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-default-startup-services-"));
  const app = createApp(tempRoot);

  __testInternals.writeLastRunningServices(app, [
    "custom-plugin",
    "agent-webclient"
  ]);

  assert.deepEqual(__testInternals.getDefaultStartupServiceIds(), [
    "zenmind-app-server",
    "agent-platform",
    "agent-webclient"
  ]);
  assert.deepEqual(__testInternals.getServiceIdsToRestore(app), [
    "zenmind-app-server",
    "agent-platform",
    "agent-webclient",
    "custom-plugin"
  ]);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("restoreRunningServices stops after the first startup failure", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-restore-stop-on-failure-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const pluginAFolder = getTestPluginProgramDir(userDataRoot, "plugin-a");
  const pluginBFolder = getTestPluginProgramDir(userDataRoot, "plugin-b");
  const app = createApp(userDataRoot);
  const startupEvents = [];

  registryInternals.clearServices();
  writePluginInstallRoot(pluginAFolder, {
    id: "plugin-a",
    name: "Plugin A",
    port: 9310,
    deployScriptContent: false
  });
  writePluginInstallRoot(pluginBFolder, {
    id: "plugin-b",
    name: "Plugin B",
    port: 9311,
    deployScriptContent: false
  });

  for (const installDir of [pluginAFolder, pluginBFolder]) {
    const pluginId = installDir === pluginAFolder ? "plugin-a" : "plugin-b";
    writeTestEnv(userDataRoot, pluginId, `PORT=${pluginId === "plugin-a" ? 9310 : 9311}\n`, "plugins");
    markInitializationState(getTestInitializationStatePath(userDataRoot, pluginId, "plugins"));
  }

  fs.writeFileSync(path.join(pluginAFolder, "start.sh"), "#!/usr/bin/env bash\nexit 1\n", "utf8");
  fs.chmodSync(path.join(pluginAFolder, "start.sh"), 0o755);
  fs.writeFileSync(path.join(pluginBFolder, "start.sh"), "#!/usr/bin/env bash\nprintf started > run/started.txt\n", "utf8");
  fs.chmodSync(path.join(pluginBFolder, "start.sh"), 0o755);

  __testInternals.writeLastRunningServices(app, ["plugin-a", "plugin-b"]);

  const result = await restoreRunningServices(app, {
    onStarting: (serviceId) => {
      startupEvents.push(`start:${serviceId}`);
    },
    onProgress: (serviceId, phase) => {
      startupEvents.push(`progress:${serviceId}:${phase}`);
    }
  });

  assert.deepEqual(startupEvents, [
    "start:plugin-a",
    "progress:plugin-a:failed"
  ]);
  assert.equal(result.restored.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /plugin-a/u);
  assert.equal(fs.existsSync(path.join(pluginBFolder, "run", "started.txt")), false);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("restoreRunningServices skips services that still need foreground install or initialization", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-restore-skip-install-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const startupEvents = [];

  registryInternals.clearServices();
  registerPlugin({
    id: "plugin-a",
    name: "Plugin A",
    kind: "plugin",
    version: "v1.0.0",
    description: "missing fixture plugin",
    frontend: {
      mode: "none"
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      pidRelativePath: "run/plugin-a.pid",
      logRelativePath: "run/plugin-a.log",
      requiredPaths: ["start.sh", "stop.sh", "manifest.json"]
    },
    web: {
      routePath: "",
      portEnvKey: "PORT",
      defaultPort: 9310
    }
  });
  __testInternals.writeLastRunningServices(app, ["plugin-a"]);

  const result = await restoreRunningServices(app, {
    onStarting: (serviceId) => {
      startupEvents.push(`start:${serviceId}`);
    },
    onProgress: (serviceId, phase) => {
      startupEvents.push(`progress:${serviceId}:${phase}`);
    }
  });

  assert.deepEqual(startupEvents, [
    "progress:plugin-a:skipped"
  ]);
  assert.equal(result.restored.length, 0);
  assert.equal(result.failures.length, 0);

  registryInternals.clearServices();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("restoreRunningServices keeps default startup services running when optional container hub is unavailable", async () => {
  const fixture = createStartupCoreAssetsFixture();
  addContainerHubAssetToFixture(fixture);
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });
  const previousSpawnSync = childProcess.spawnSync;

  try {
    await installBuiltinService(app, "agent-container-hub");
    __testInternals.writeLastRunningServices(app, ["agent-container-hub"]);

    childProcess.spawnSync = (command, args = [], options = {}) => {
      if (isCommandLookup(command, args, "docker") || isCommandLookup(command, args, "podman")) {
        return createSpawnSyncResult(1);
      }
      if ((command === "docker" || command === "podman") && args[0] === "info") {
        return createSpawnSyncResult(1);
      }
      return spawnSync(command, args, options);
    };

    const result = await restoreRunningServices(app);

    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.restored, ["zenmind-app-server", "agent-platform", "agent-webclient"]);
    for (const serviceId of ["zenmind-app-server", "agent-platform", "agent-webclient"]) {
      const service = getBuiltinService(serviceId);
      const installDir = getInstallDir(app, service);
      assert.equal(fs.existsSync(path.join(installDir, "run", "started.txt")), true);
    }
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("restoreRunningServices auto-installs and starts builtin services that are not installed yet", async () => {
  const fixture = createBuiltinRestoreFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot);
  const startupEvents = [];

  try {
    __testInternals.writeLastRunningServices(app, ["custom-builtin"]);

    const result = await restoreRunningServices(app, {
      onStarting: (serviceId) => {
        startupEvents.push(`start:${serviceId}`);
      },
      onProgress: (serviceId, phase) => {
        startupEvents.push(`progress:${serviceId}:${phase}`);
      }
    });

    assert.deepEqual(startupEvents, [
      "start:custom-builtin",
      "progress:custom-builtin:failed"
    ]);
    assert.equal(result.restored.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /custom-builtin/);
    assert.match(result.failures[0], /复查失败|未确认启动/);
    assert.equal(
      fs.existsSync(path.join(getTestServiceProgramDir(userDataRoot, "custom-builtin", "v1.0.0"), "run", "started.txt")),
      true
    );
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation bootstraps packaged first launch with the three core services", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });

  try {
    const result = await runStartupPreparation(app);
    const hubService = getBuiltinService("agent-container-hub");
    const hubInstallDir = getInstallDir(app, hubService);
    const hubState = await getServiceState(app, "agent-container-hub");
	    const hubEnv = fs.readFileSync(getTestEnvPath(userDataRoot, hubService.id), "utf8");

    assert.equal(result.mode, "bootstrap");
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["zenmind-app-server", "agent-platform", "agent-webclient"]);
    assert.equal(fs.existsSync(hubInstallDir), true);
    assert.equal(readInitializationStatePath(getTestInitializationStatePath(userDataRoot, hubService.id))?.status, "succeeded");
    assert.match(hubEnv, /^BIND_ADDR=127\.0\.0\.1:7079$/mu);
    assert.notEqual(hubState.status, "running");
    assert.equal(fs.existsSync(path.join(hubInstallDir, "run", "started.txt")), false);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation does not reinstall healthy packaged core services", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });

  try {
    for (const serviceId of ["agent-container-hub", "zenmind-app-server", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

	    const markerPath = path.join(getTestServiceProgramDir(userDataRoot, "agent-platform", "v1.0.0"), "marker.txt");
    fs.writeFileSync(markerPath, "keep", "utf8");

    const result = await runStartupPreparation(app);
    assert.equal(result.mode, "restore");
    assert.deepEqual(result.failures, []);
    assert.equal(fs.existsSync(markerPath), true);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation installs missing container hub without starting it when core services are healthy", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });

  try {
    for (const serviceId of ["zenmind-app-server", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

	    const markerPath = path.join(getTestServiceProgramDir(userDataRoot, "agent-platform", "v1.0.0"), "marker.txt");
    fs.writeFileSync(markerPath, "keep", "utf8");

    const result = await runStartupPreparation(app);
    const hubService = getBuiltinService("agent-container-hub");
    const hubInstallDir = getInstallDir(app, hubService);
    const hubState = await getServiceState(app, "agent-container-hub");

    assert.equal(result.mode, "bootstrap");
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["zenmind-app-server", "agent-platform", "agent-webclient"]);
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(fs.existsSync(hubInstallDir), true);
    assert.equal(readInitializationStatePath(getTestInitializationStatePath(userDataRoot, hubService.id))?.status, "succeeded");
    assert.notEqual(hubState.status, "running");
    assert.equal(fs.existsSync(path.join(hubInstallDir, "run", "started.txt")), false);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation reinitializes packaged core services that are missing init state", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });

  try {
    for (const serviceId of ["zenmind-app-server", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

    const platformService = getBuiltinService("agent-platform");
    fs.rmSync(getTestStateDir(userDataRoot, platformService.id), { recursive: true, force: true });

    const result = await runStartupPreparation(app);
    assert.equal(result.mode, "bootstrap");
    assert.deepEqual(result.failures, []);
    assert.equal(fs.existsSync(getTestInitializationStatePath(userDataRoot, platformService.id)), true);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation continues after one bootstrap failure and reports the failure", async () => {
  const fixture = createStartupCoreAssetsFixture({ failOnStartServiceId: "zenmind-app-server" });
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: true });

  try {
    const result = await runStartupPreparation(app);
    assert.equal(result.mode, "bootstrap");
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /zenmind-app-server/u);
    assert.deepEqual(result.started, ["agent-platform", "agent-webclient"]);
    assert.equal(fs.existsSync(path.join(getTestServiceProgramDir(userDataRoot, "agent-platform", "v1.0.0"), "run", "started.txt")), true);
    assert.equal(fs.existsSync(path.join(getTestServiceProgramDir(userDataRoot, "agent-webclient", "v1.0.0"), "run", "started.txt")), true);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation keeps development launches on restore mode by default", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, { isPackaged: false });

  try {
    const result = await runStartupPreparation(app);
    assert.equal(result.mode, "restore");
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runExecFile resolves when a daemon child keeps stdout open", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-run-exec-daemon-"));
  const scriptPath = path.join(tempRoot, "start.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "sleep 3 &",
      "echo $! > daemon.pid",
      "echo started"
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);

  const startedAt = Date.now();
  const result = await __testInternals.runExecFile("./start.sh", [], tempRoot);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 2500, `expected command to resolve before daemon exits, took ${elapsedMs}ms`);
  assert.match(result.stdout, /started/);

  const pid = Number(fs.readFileSync(path.join(tempRoot, "daemon.pid"), "utf8"));
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may already be gone on a slow host.
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("stopRunningServicesForShutdown returns quickly when a stop script times out and force cleanup releases the process", async (t) => {
  if (process.platform === "win32") {
    t.skip("This fixture uses POSIX shell scripts; Windows cleanup is covered by the process-tree unit tests.");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-shutdown-timeout-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  let fixture = null;

  registryInternals.clearServices();

  try {
    fixture = prepareRunningPluginFixture(userDataRoot, {
      id: "shutdown-slow-plugin",
      stopScriptContent: [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "sleep 1",
        'if [ -f "run/test-plugin.pid" ]; then',
        '  kill "$(cat "run/test-plugin.pid")" >/dev/null 2>&1 || true',
        '  rm -f "run/test-plugin.pid"',
        "fi"
      ].join("\n")
    });

    const snapshot = __testInternals.captureManagedProcessCleanupSnapshot(app);
    const startedAt = Date.now();
    const result = await stopRunningServicesForShutdown(app, { stopCommandTimeoutMs: 75 });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /timed out/u);
    assert.ok(elapsedMs < 800, `expected shutdown stop to return quickly, took ${elapsedMs}ms`);
    assert.equal(isPidRunning(fixture.child.pid), true);

    await forceCleanupManagedProcesses(app, snapshot);
    assert.equal(await waitForPidExit(fixture.child.pid), true);
  } finally {
    if (fixture?.child?.pid && isPidRunning(fixture.child.pid)) {
      try {
        process.kill(fixture.child.pid, "SIGKILL");
      } catch {
        // Process may already be gone after cleanup.
      }
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("stopRunningServicesForShutdown stops running services concurrently", async (t) => {
  if (process.platform === "win32") {
    t.skip("This fixture uses POSIX shell scripts; Windows cleanup is covered by the process-tree unit tests.");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-shutdown-concurrent-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const sharedDir = path.join(tempRoot, "shutdown-stop-barrier");
  const app = createApp(userDataRoot);
  const fixtures = [];

  registryInternals.clearServices();

  const createBarrierStopScript = (self, peer) => [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `shared_dir=${JSON.stringify(sharedDir)}`,
    'mkdir -p "$shared_dir"',
    `touch "$shared_dir/${self}.started"`,
    "deadline=$((SECONDS + 2))",
    `while [ ! -f "$shared_dir/${peer}.started" ]; do`,
    "  if [ \"$SECONDS\" -ge \"$deadline\" ]; then",
    "    echo peer stop script did not start >&2",
    "    exit 7",
    "  fi",
    "  sleep 0.05",
    "done",
    'if [ -f "run/test-plugin.pid" ]; then',
    '  kill "$(cat "run/test-plugin.pid")" >/dev/null 2>&1 || true',
    '  rm -f "run/test-plugin.pid"',
    "fi"
  ].join("\n");

  try {
    fixtures.push(prepareRunningPluginFixture(userDataRoot, {
      id: "shutdown-peer-a",
      stopScriptContent: createBarrierStopScript("a", "b")
    }));
    fixtures.push(prepareRunningPluginFixture(userDataRoot, {
      id: "shutdown-peer-b",
      stopScriptContent: createBarrierStopScript("b", "a")
    }));

    const startedAt = Date.now();
    const result = await stopRunningServicesForShutdown(app, { stopCommandTimeoutMs: 3000 });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.ok, true);
    assert.equal(result.stopped.length, 2);
    assert.deepEqual(result.runningServiceIds.sort(), ["shutdown-peer-a", "shutdown-peer-b"]);
    assert.ok(elapsedMs < 1500, `expected concurrent stop to finish before the barrier timeout, took ${elapsedMs}ms`);
    assert.equal(await waitForPidExit(fixtures[0].child.pid), true);
    assert.equal(await waitForPidExit(fixtures[1].child.pid), true);
  } finally {
    for (const fixture of fixtures) {
      if (fixture.child?.pid && isPidRunning(fixture.child.pid)) {
        try {
          process.kill(fixture.child.pid, "SIGKILL");
        } catch {
          // Process may already be gone after the stop script.
        }
      }
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("stopService keeps the normal command timeout outside the shutdown path", async (t) => {
  if (process.platform === "win32") {
    t.skip("This fixture uses POSIX shell scripts; Windows service stopping is covered by platform-specific tests.");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-stop-normal-timeout-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const previousVerifyDelay = process.env.ZENMIND_SERVICE_VERIFY_DELAY_MS;
  let fixture = null;

  registryInternals.clearServices();
  process.env.ZENMIND_SERVICE_VERIFY_DELAY_MS = "0";

  try {
    fixture = prepareRunningPluginFixture(userDataRoot, {
      id: "normal-stop-plugin",
      stopScriptContent: [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "sleep 0.15",
        'if [ -f "run/test-plugin.pid" ]; then',
        '  kill "$(cat "run/test-plugin.pid")" >/dev/null 2>&1 || true',
        '  rm -f "run/test-plugin.pid"',
        "fi"
      ].join("\n")
    });

    const result = await stopService(app, "normal-stop-plugin");

    assert.equal(result.ok, true, result.message);
    assert.equal(result.service.status, "stopped");
    assert.equal(await waitForPidExit(fixture.child.pid), true);
  } finally {
    if (previousVerifyDelay === undefined) {
      delete process.env.ZENMIND_SERVICE_VERIFY_DELAY_MS;
    } else {
      process.env.ZENMIND_SERVICE_VERIFY_DELAY_MS = previousVerifyDelay;
    }
    if (fixture?.child?.pid && isPidRunning(fixture.child.pid)) {
      try {
        process.kill(fixture.child.pid, "SIGKILL");
      } catch {
        // Process may already be gone after the stop script.
      }
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
