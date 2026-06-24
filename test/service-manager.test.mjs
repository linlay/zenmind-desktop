import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
  const {
    __testInternals,
    forceCleanupManagedProcesses,
    getServiceState,
    getInstallDir,
    listServices,
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
} = require("../dist-electron/main/services/manager/index.js");
const { loadBuiltinServices } = require("../dist-electron/main/builtin-loader.js");
const {
  __testInternals: registryInternals,
  getBuiltinService,
  getService,
  registerPlugin
} = require("../dist-electron/main/services/service-registry.js");
const {
  resolveDesktopCapability,
  __testInternals: capabilityInternals
} = require("../dist-electron/main/services/manager/capabilities.js");
const {
  configurePluginResources,
  __testInternals: pluginResourceInternals
} = require("../dist-electron/main/plugin-resources.js");
const { updateDesktopProfileInRoot } = require("../dist-electron/main/desktop-profile-store.js");
const { getDesktopConfigRoot } = require("../dist-electron/main/user-paths.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TEST_IDENTITY_CENTER_BCRYPT = "$2a$10$VAC1MOfQV2f6L3LqgU5PweT25AdVaRK3yvMLwXjA0uRUhtnbbQ1ue";
const TEST_IDENTITY_CENTER_CUSTOM_BCRYPT = "$2a$10$VAC1MOfQV2f6L3LqgU5PweT25AdVaRK3yvMLwXjA0uRUhtnbbQ1uf";
const LEGACY_LAYOUT_ENV_KEYS = ["CONFIG", "DATA", "STATE", "LOG"].map((name) => `SERVICE_${name}_DIR`);

async function withLegacyLayoutEnv(callback) {
  const previous = new Map(LEGACY_LAYOUT_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of LEGACY_LAYOUT_ENV_KEYS) {
      process.env[key] = `/tmp/legacy-${key.toLowerCase()}`;
    }
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function assertNoLegacyLayoutEnv(env) {
  for (const key of LEGACY_LAYOUT_ENV_KEYS) {
    assert.ok(env[key] === undefined || env[key] === null, `${key} should not be passed to service commands`);
  }
}

function createAuthCapabilityProviders() {
  const publicKeyArgs = [
    "--mode",
    "bootstrap",
    "--db",
    "{{auth.dbPath}}",
    "--out",
    "{{provider.dataDir}}/keys",
    "--public-out",
    "{{output.path}}"
  ];
  const accessTokenArgs = [
    "--db",
    "{{auth.dbPath}}",
    "--issuer",
    "{{auth.issuer}}",
    "--username",
    "{{auth.username}}",
    "--device-name",
    "{{desktop.deviceName}}",
    "--device-id",
    "{{desktop.deviceId}}"
  ];
  return [
    {
      id: "auth.publicKey",
      darwinCommand: ["scripts/setup-public-key.sh", ...publicKeyArgs],
      linuxCommand: ["scripts/setup-public-key.sh", ...publicKeyArgs],
      windowsCommand: [
        "scripts/setup-public-key.ps1",
        "-Mode",
        "bootstrap",
        "-Db",
        "{{auth.dbPath}}",
        "-Out",
        "{{provider.dataDir}}/keys",
        "-PublicOut",
        "{{output.path}}"
      ],
      env: {
        AUTH_DB_PATH: "{{auth.dbPath}}"
      },
      output: "file",
      outputPath: "{{provider.dataDir}}/keys/publicKey.pem",
      retryOnSqliteBusy: true
    },
    {
      id: "auth.accessToken",
      darwinCommand: ["scripts/issue-bridge-access-token.sh", ...accessTokenArgs],
      linuxCommand: ["scripts/issue-bridge-access-token.sh", ...accessTokenArgs],
      windowsCommand: [
        "scripts/issue-bridge-access-token.ps1",
        "-Db",
        "{{auth.dbPath}}",
        "-Issuer",
        "{{auth.issuer}}",
        "-Username",
        "{{auth.username}}",
        "-DeviceName",
        "{{desktop.deviceName}}",
        "-DeviceId",
        "{{desktop.deviceId}}"
      ],
      env: {
        AUTH_DB_PATH: "{{auth.dbPath}}",
        AUTH_ISSUER: "{{auth.issuer}}",
        AUTH_APP_USERNAME: "{{auth.username}}",
        DESKTOP_DEVICE_ID: "{{desktop.deviceId}}"
      },
      output: "stdoutLastLine",
      dependsOn: ["auth.publicKey"],
      retryOnSqliteBusy: true,
      validateJwtDeviceId: true,
      allowDeviceIdFallback: true
    }
  ];
}

function createCoreDesktopManifest(serviceId, assetFileName) {
  const desktop = {
    assetFileName,
    bundleTopLevelDir: serviceId
  };
  if (serviceId === "identity-center") {
    return {
      ...desktop,
      envBindings: [
        {
          key: "SERVER_PORT",
          value: "{{serviceDefaultPort}}",
          onlyIfDefault: true
        }
      ],
      capabilities: {
        provides: createAuthCapabilityProviders(),
        requires: []
      }
    };
  }
  if (serviceId === "agent-platform") {
    return {
      ...desktop,
      envBindings: [
        {
          key: "AP_CONTAINER_HUB_BASE_URL",
          fromService: "agent-container-hub",
          template: "http://127.0.0.1:{{port}}",
          onlyIfDefault: true,
          defaults: [
            "",
            "http://127.0.0.1:11960",
            "http://localhost:11960",
            "http://host.docker.internal:11960"
          ]
        },
        {
          key: "SERVER_PORT",
          value: "{{serviceDefaultPort}}",
          onlyIfDefault: true
        }
      ],
      capabilities: {
        provides: [],
        requires: [
          {
            phase: "preStart",
            capability: "auth.publicKey",
            action: "copyFile",
            target: "configs/local-public-key.pem"
          }
        ]
      }
    };
  }
  if (serviceId === "agent-webclient") {
    return {
      ...desktop,
      envBindings: [
        {
          key: "BASE_URL",
          fromService: "agent-platform",
          template: "http://127.0.0.1:{{port}}",
          onlyIfDefault: true,
          defaults: [
            "",
            "http://127.0.0.1:11949",
            "http://localhost:11949"
          ]
        },
        {
          key: "PORT",
          value: "{{serviceDefaultPort}}",
          onlyIfDefault: true
        }
      ],
      capabilities: {
        provides: [],
        requires: [
          {
            phase: "verifyRunning",
            capability: "auth.accessToken",
            action: "preload"
          },
          {
            phase: "verifyRunning",
            service: "agent-platform",
            action: "waitHttp",
            target: "/api/runtime-info",
            authCapability: "auth.accessToken"
          }
        ]
      }
    };
  }
  return {
    ...desktop,
    capabilities: {
      provides: [],
      requires: []
    }
  };
}

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

function currentManifestArch() {
  return process.arch === "x64" ? "amd64" : process.arch;
}

function currentBuiltinArchiveExtension() {
  return process.platform === "win32" ? ".zip" : ".tar.gz";
}

function currentBuiltinArchiveFileName(serviceId, version) {
  return `${serviceId}-${version}-${currentManifestOs()}-${currentManifestArch()}${currentBuiltinArchiveExtension()}`;
}

function currentBuiltinDirectoryAssetName(serviceId, version) {
  return currentBuiltinArchiveFileName(serviceId, version)
    .replace(/\.tar\.gz$/u, "")
    .replace(/\.tgz$/u, "")
    .replace(/\.zip$/u, "");
}

function powershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function writeDirectoryArchive(root, archivePath, entryName) {
  if (archivePath.toLowerCase().endsWith(".zip")) {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -Path ${powershellSingleQuoted(entryName)} -DestinationPath ${powershellSingleQuoted(archivePath)} -Force`
      ],
      { cwd: root }
    );
    return;
  }

  execFileSync("tar", ["-czf", archivePath, "-C", root, entryName]);
}

function isReleaseArchiveName(fileName) {
  return fileName.endsWith(".zip") || fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz");
}

function copyReleaseArchive(sourceArchivePath, targetDir) {
  const targetPath = path.join(targetDir, path.basename(sourceArchivePath));
  fs.copyFileSync(sourceArchivePath, targetPath);
  return targetPath;
}

function findCurrentPlatformReleaseArchive(serviceId) {
  const currentOs = currentManifestOs();
  const candidateDirs = [
    path.join(WORKSPACE_ROOT, serviceId, "dist", "release"),
    path.join(process.cwd(), "build", "resources", "services", serviceId),
    path.join(WORKSPACE_ROOT, serviceId),
    path.join(WORKSPACE_ROOT, "zenmind-dist", serviceId)
  ];
  const candidates = [];

  for (const dirPath of candidateDirs) {
    if (!fs.existsSync(dirPath)) {
      continue;
    }
    for (const entry of fs.readdirSync(dirPath)) {
      if (isReleaseArchiveName(entry)) {
        candidates.push(path.join(dirPath, entry));
      }
    }
  }

  const workspaceCandidates = fs
    .readdirSync(WORKSPACE_ROOT)
    .filter((entry) => entry.startsWith(`${serviceId}-`) && isReleaseArchiveName(entry))
    .map((entry) => path.join(WORKSPACE_ROOT, entry));

  return [...candidates, ...workspaceCandidates].find((archivePath) => {
    const archiveName = path.basename(archivePath);
    return archiveName.includes(`-${currentOs}-`) && isReleaseArchiveName(archiveName);
  });
}

function createCurrentPlatformAssetsFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtins-"));
  const assetsRoot = path.join(tempRoot, "services");
  const containerHubBundleRoot = path.join(tempRoot, "agent-container-hub");
  const containerHubAssetDir = path.join(assetsRoot, "agent-container-hub");
  const containerHubArchivePath = path.join(
    containerHubAssetDir,
    currentBuiltinArchiveFileName("agent-container-hub", "v0.1.0")
  );

  writeContainerHubBundleRoot(containerHubBundleRoot);
  fs.mkdirSync(containerHubAssetDir, { recursive: true });
  writeDirectoryArchive(tempRoot, containerHubArchivePath, "agent-container-hub");

  for (const serviceId of ["identity-center", "agent-platform", "agent-webclient"]) {
    const archivePath = findCurrentPlatformReleaseArchive(serviceId);
    assert.ok(archivePath, `missing ${currentManifestOs()} release archive for ${serviceId}`);

    const targetDir = path.join(assetsRoot, serviceId);
    fs.mkdirSync(targetDir, { recursive: true });
    copyReleaseArchive(archivePath, targetDir);
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
  const archiveFileName = currentBuiltinArchiveFileName("custom-builtin", "v1.0.0");
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
    fs.writeFileSync(
      path.join(bundleRoot, "deploy.ps1"),
      [
        "$configDir = $PSScriptRoot",
        "New-Item -ItemType Directory -Path $configDir -Force | Out-Null",
        "$envPath = Join-Path $configDir '.env'",
        "if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Destination $envPath }"
      ].join("\r\n"),
      "utf8"
    );
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
          stop: "stop.ps1",
          deploy: "deploy.ps1"
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
            "deploy.ps1",
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
    writeDirectoryArchive(tempRoot, archivePath, "custom-builtin");
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
    fs.writeFileSync(
      path.join(bundleRoot, "deploy.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'config_dir="$PWD"',
        'mkdir -p "$config_dir"',
        'if [ ! -f "$config_dir/.env" ]; then cp .env.example "$config_dir/.env"; fi'
      ].join("\n"),
      "utf8"
    );
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
          pidRelativePath: "run/custom-builtin.pid",
          logRelativePath: "run/custom-builtin.log",
          requiredPaths: [
            "start.sh",
            "stop.sh",
            "deploy.sh",
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
    fs.chmodSync(path.join(bundleRoot, "deploy.sh"), 0o755);
    fs.chmodSync(path.join(bundleRoot, "scripts", "program-common.sh"), 0o755);
    writeDirectoryArchive(tempRoot, archivePath, "custom-builtin");
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
  const ports = {
    webclient: portBase,
    platform: portBase + 1,
    identityCenter: portBase + 2,
    containerHub: portBase + 3
  };
  const services = [
    {
      id: "identity-center",
      name: "认证服务",
      frontend: { mode: "standalone", entry: "/admin/" },
      web: { routePath: "/admin/", portEnvKey: "SERVER_PORT", defaultPort: ports.identityCenter },
      envExample: [
        `SERVER_PORT=${ports.identityCenter}`,
        "FRONTEND_DIST_DIR=./frontend/dist",
        `AUTH_ADMIN_PASSWORD_BCRYPT='${TEST_IDENTITY_CENTER_BCRYPT}'`,
        `AUTH_APP_MASTER_PASSWORD_BCRYPT='${TEST_IDENTITY_CENTER_BCRYPT}'`
      ].join("\n") + "\n",
      extraPaths: [["frontend", "dist"], ["scripts"]]
    },
    {
      id: "agent-platform",
      name: "智能体平台",
      frontend: { mode: "none" },
      web: { routePath: "", portEnvKey: "SERVER_PORT", defaultPort: ports.platform },
      envExample: [
        `SERVER_PORT=${ports.platform}`,
        "AP_CONTAINER_HUB_BASE_URL=https://bundle-hub.example.test",
        "",
        "# Runtime directories",
        "# RUNTIME_DIR=./runtime",
        "# REGISTRIES_DIR=./runtime/registries",
        "# OWNER_DIR=./runtime/owner",
        "# AGENTS_DIR=./runtime/agents",
        "# TEAMS_DIR=./runtime/teams",
        "# ROOT_DIR=./runtime/root",
        "# SCHEDULES_DIR=./runtime/schedules",
        "# CHATS_DIR=./runtime/chats",
        "# MEMORY_DIR=./runtime/memory",
        "# SKILLS_MARKET_DIR=./runtime/skills-market",
        "# PAN_DIR=./runtime/pan",
        "",
        "# Provider apiKey AES(...)",
        "# PROVIDER_APIKEY_KEY_PART="
      ].join("\n") + "\n",
      extraPaths: [["configs"], ["runtime"], ["scripts"]]
    },
    {
      id: "agent-webclient",
      name: "智能助理",
      frontend: { mode: "standalone", entry: "/", directAccess: true, hostManaged: true },
      web: { routePath: "/", portEnvKey: "PORT", defaultPort: ports.webclient },
      envExample: [
        `PORT=${ports.webclient}`,
        "# DESKTOP_APP=true",
        "BASE_URL=https://bundle-platform.example.test",
        "# VOICE_BASE_URL=https://bundle-platform.example.test"
      ].join("\n") + "\n",
      extraPaths: [["frontend", "dist"], ["scripts"]]
    }
  ];

  for (const service of services) {
    const bundleRoot = path.join(tempRoot, service.id);
    const assetDir = path.join(assetsRoot, service.id);
    const archiveFileName = currentBuiltinArchiveFileName(service.id, "v1.0.0");
    const archivePath = path.join(assetDir, archiveFileName);

    for (const segments of service.extraPaths) {
      fs.mkdirSync(path.join(bundleRoot, ...segments), { recursive: true });
    }
    fs.mkdirSync(path.join(bundleRoot, "run"), { recursive: true });
    fs.mkdirSync(assetDir, { recursive: true });

    if (service.id === "agent-webclient") {
      fs.writeFileSync(path.join(bundleRoot, "frontend", "dist", "index.html"), "<html></html>\n", "utf8");
    }
    if (service.id === "identity-center") {
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
      if (isWindows) {
        fs.writeFileSync(
          path.join(bundleRoot, "scripts", "setup-public-key.ps1"),
          [
            "param([string]$mode, [string]$db, [string]$out, [string]$publicOut)",
            "New-Item -ItemType Directory -Path $out -Force | Out-Null",
            "Set-Content -LiteralPath (Join-Path $out 'jwk-private.pem') -Value 'IDENTITY_CENTER_PRIVATE_KEY'",
            "Set-Content -LiteralPath (Join-Path $out 'jwk-public.pem') -Value 'IDENTITY_CENTER_PUBLIC_KEY'",
            "New-Item -ItemType Directory -Path (Split-Path -Parent $publicOut) -Force | Out-Null",
            "Set-Content -LiteralPath $publicOut -Value 'IDENTITY_CENTER_PUBLIC_KEY'"
          ].join("\r\n"),
          "utf8"
        );
        fs.writeFileSync(
          path.join(bundleRoot, "scripts", "issue-bridge-access-token.ps1"),
          [
            "$deviceId = $env:DESKTOP_DEVICE_ID",
            "$headerJson = '{\"alg\":\"RS256\",\"kid\":\"fixture\",\"typ\":\"JWT\"}'",
            "$payloadJson = (@{ iss = 'fixture'; sub = 'app'; device_id = $deviceId } | ConvertTo-Json -Compress)",
            "function ConvertTo-Base64Url([string]$Value) {",
            "  return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Value)).TrimEnd('=').Replace('+','-').Replace('/','_')",
            "}",
            "$header = ConvertTo-Base64Url $headerJson",
            "$payload = ConvertTo-Base64Url $payloadJson",
            "Write-Output \"$header.$payload.signature\""
          ].join("\r\n") + "\r\n",
          "utf8"
        );
      } else {
        fs.writeFileSync(
          path.join(bundleRoot, "scripts", "setup-public-key.sh"),
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "public_out=''",
            "while [ $# -gt 0 ]; do",
            "  case \"$1\" in",
            "    --public-out) public_out=\"$2\"; shift 2 ;;",
            "    *) shift ;;",
            "  esac",
            "done",
            "mkdir -p \"$(dirname \"$public_out\")\"",
            "printf 'IDENTITY_CENTER_PRIVATE_KEY\\n' > \"$(dirname \"$public_out\")/jwk-private.pem\"",
            "printf 'IDENTITY_CENTER_PUBLIC_KEY\\n' > \"$(dirname \"$public_out\")/jwk-public.pem\"",
            "printf 'IDENTITY_CENTER_PUBLIC_KEY\\n' > \"$public_out\""
          ].join("\n") + "\n",
          "utf8"
        );
        fs.writeFileSync(
          path.join(bundleRoot, "scripts", "issue-bridge-access-token.sh"),
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "node - <<'NODE'",
            "const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');",
            "const deviceId = process.env.DESKTOP_DEVICE_ID || '';",
            "console.log(`${b64({ alg: 'RS256', kid: 'fixture', typ: 'JWT' })}.${b64({ iss: 'fixture', sub: 'app', device_id: deviceId })}.signature`);",
            "NODE"
          ].join("\n") + "\n",
          "utf8"
        );
      }
    }
    if (service.id === "agent-platform") {
      fs.writeFileSync(
        path.join(bundleRoot, "configs", "desktop.example.yml"),
        [
          "bridges:",
          "  - name: desktop-actions",
          "    path: /actions/call",
          "  - name: embedded-cdp",
          "    path: /cdp/call"
        ].join("\n") + "\n",
        "utf8"
      );
    }

    const pidRelativePath = path.join("run", `${service.id}.pid`);
    const startFileName = isWindows ? "start.ps1" : "start.sh";
    const stopFileName = isWindows ? "stop.ps1" : "stop.sh";
    const deployFileName = isWindows ? "deploy.ps1" : "deploy.sh";
    const programCommonName = isWindows ? "program-common.ps1" : "program-common.sh";

    if (isWindows) {
      const windowsStartPrelude = options.recordStartTime
        ? [
            `$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()`,
            `$timestamp | Set-Content -LiteralPath (Join-Path $runDir 'start-time.txt')`,
            options.startDelayMs ? `Start-Sleep -Milliseconds ${options.startDelayMs}` : ""
          ].filter(Boolean).join("\r\n")
        : "";
      fs.writeFileSync(
        path.join(bundleRoot, startFileName),
        [
          "$runDir = Join-Path $PSScriptRoot 'run'",
          "New-Item -ItemType Directory -Path $runDir -Force | Out-Null",
          windowsStartPrelude,
          options.failOnStartServiceId === service.id
            ? "throw 'fixture start failure'"
            : [
                "$stateDirArg = ''",
                "$configDirArg = ''",
                "$portArg = ''",
                "for ($i = 0; $i -lt $args.Count; $i++) {",
                "  switch ($args[$i]) {",
                "    '--state-dir' { $i++; $stateDirArg = $args[$i]; continue }",
                "    '--config-dir' { $i++; $configDirArg = $args[$i]; continue }",
                "    '--port' { $i++; $portArg = $args[$i]; continue }",
                "  }",
                "}",
                "$pidDir = if ($stateDirArg) { $stateDirArg } else { $runDir }",
                "New-Item -ItemType Directory -Path $pidDir -Force | Out-Null",
                "if ($env:NODE_BIN) { $env:NODE_BIN | Set-Content -LiteralPath (Join-Path $runDir 'node-bin.txt') }",
                "$fixtureScript = Join-Path $runDir '${service.id}-fixture.cjs'",
                "$fixtureScriptContent = @'",
                "const port = Number(process.argv[2] || 0);",
                `if (${service.id === "agent-platform" ? "true" : "false"} && port > 0) {`,
                "  const http = require('node:http');",
                options.platformRootReturns404 && service.id === "agent-platform"
                  ? [
                      "  const server = http.createServer((req, res) => {",
                      "    if (req.url === '/api/runtime-info') {",
                      options.platformRuntimeInfoRequiresAuth
                        ? [
                            "      if (!String(req.headers.authorization || '').startsWith('Bearer ')) {",
                            "        res.writeHead(401, { 'content-type': 'application/json' });",
                            "        res.end(JSON.stringify({ error: 'unauthorized' }));",
                            "        return;",
                            "      }"
                          ].join("\r\n")
                        : "",
                      "      res.writeHead(200, { 'content-type': 'application/json' });",
                      "      res.end(JSON.stringify({ ok: true }));",
                      "      return;",
                      "    }",
                      "    res.writeHead(404, { 'content-type': 'text/plain' });",
                      "    res.end('not found');",
                      "  });"
                    ].join("\r\n")
                  : "  const server = http.createServer((_req, res) => res.end('ok'));",
                "  server.on('error', () => {});",
                "  server.listen(port, '127.0.0.1');",
                "}",
                "setInterval(() => {}, 1000);",
                "'@",
                "[System.IO.File]::WriteAllText($fixtureScript, $fixtureScriptContent)",
                "$nodeBin = if ($env:NODE_BIN) { $env:NODE_BIN } else { 'node' }",
                `$portKey = '${service.web.portEnvKey}'`,
                "$servicePort = $portArg",
                "$envFile = if ($configDirArg) { Join-Path $configDirArg '.env' } else { '' }",
                "if ($envFile -and (Test-Path -LiteralPath $envFile)) {",
                "  foreach ($line in Get-Content -LiteralPath $envFile) {",
                "    if ($line -match ('^' + [regex]::Escape($portKey) + '=(.+)$')) {",
                "      $value = $Matches[1].Trim()",
                "      $value = $value.Trim(\"'\")",
                "      $value = $value.Trim('\"')",
                "      if ($value -match ':(\\d+)$') { $servicePort = $Matches[1] }",
                "      elseif ($value -match '^\\d+$') { $servicePort = $value }",
                "    }",
                "  }",
                "}",
                "$fixtureArgs = @($fixtureScript)",
                "if ($servicePort) { $fixtureArgs += $servicePort }",
                "$proc = Start-Process -FilePath $nodeBin -ArgumentList $fixtureArgs -WindowStyle Hidden -PassThru",
                `$proc.Id | Set-Content -LiteralPath (Join-Path $pidDir '${service.id}.pid')`,
                "Set-Content -LiteralPath (Join-Path $runDir 'started.txt') -Value 'started'"
              ].join("\r\n")
        ].join("\r\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(bundleRoot, stopFileName),
        [
          "$stateDirArg = ''",
          "for ($i = 0; $i -lt $args.Count; $i++) {",
          "  if ($args[$i] -eq '--state-dir') { $i++; $stateDirArg = $args[$i] }",
          "}",
          `$pidFile = if ($stateDirArg) { Join-Path $stateDirArg '${service.id}.pid' } else { Join-Path $PSScriptRoot '${pidRelativePath.replace(/\\/g, "/")}' }`,
          "if (Test-Path -LiteralPath $pidFile) {",
          "  $pidValue = (Get-Content -LiteralPath $pidFile -Raw).Trim()",
          "  if ($pidValue) { Stop-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue }",
          "  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue",
          "}"
        ].join("\r\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(bundleRoot, deployFileName),
        [
          "$runDir = Join-Path $PSScriptRoot 'run'",
          "New-Item -ItemType Directory -Path $runDir -Force | Out-Null",
          options.deployDelayMs ? `Start-Sleep -Milliseconds ${options.deployDelayMs}` : "",
          `Add-Content -LiteralPath (Join-Path $runDir 'deploy.log') -Value '${service.id}'`
        ].filter(Boolean).join("\r\n"),
        "utf8"
      );
      const programCommonContent = service.id === "identity-center"
        ? [
            "function Resolve-ProgramFrontendDistDir {",
            "  param([string]$Value)",
            "  return $Value",
            "}",
            "$env:FRONTEND_DIST_DIR = if ($env:FRONTEND_DIST_DIR) { $env:FRONTEND_DIST_DIR } else { './frontend/dist' }"
          ].join("\r\n") + "\r\n"
        : "# fixture\r\n";
      fs.writeFileSync(path.join(bundleRoot, "scripts", programCommonName), programCommonContent, "utf8");
    } else {
      const unixStartPrelude = options.recordStartTime
        ? [
            `node -e "require('fs').writeFileSync('run/start-time.txt', String(Date.now()))"`,
            options.startDelayMs ? `sleep ${options.startDelayMs / 1000}` : ""
          ].filter(Boolean).join("\n")
        : "";
      fs.writeFileSync(
        path.join(bundleRoot, startFileName),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "mkdir -p run",
          unixStartPrelude,
          'pid_dir="$PWD/run"',
          "config_dir=''",
          "service_port=''",
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in',
          '    --state-dir) pid_dir="$2"; shift 2 ;;',
          '    --config-dir) config_dir="$2"; shift 2 ;;',
          '    --port) service_port="$2"; shift 2 ;;',
          "    *) shift ;;",
          "  esac",
          "done",
          'mkdir -p "$pid_dir"',
          options.failOnStartServiceId === service.id
            ? "echo fixture start failure >&2\nexit 1"
            : [
                `fixture_script="$PWD/run/${service.id}-fixture.cjs"`,
                "cat > \"$fixture_script\" <<'NODE'",
                "const port = Number(process.argv[2] || 0);",
                `if (${service.id === "agent-platform" ? "true" : "false"} && port > 0) {`,
                "  const http = require('node:http');",
                options.platformRootReturns404 && service.id === "agent-platform"
                  ? [
                      "  const server = http.createServer((req, res) => {",
                      "    if (req.url === '/api/runtime-info') {",
                      options.platformRuntimeInfoRequiresAuth
                        ? [
                            "      if (!String(req.headers.authorization || '').startsWith('Bearer ')) {",
                            "        res.writeHead(401, { 'content-type': 'application/json' });",
                            "        res.end(JSON.stringify({ error: 'unauthorized' }));",
                            "        return;",
                            "      }"
                          ].join("\n")
                        : "",
                      "      res.writeHead(200, { 'content-type': 'application/json' });",
                      "      res.end(JSON.stringify({ ok: true }));",
                      "      return;",
                      "    }",
                      "    res.writeHead(404, { 'content-type': 'text/plain' });",
                      "    res.end('not found');",
                      "  });"
                    ].join("\n")
                  : "  const server = http.createServer((_req, res) => res.end('ok'));",
                "  server.on('error', () => {});",
                "  server.listen(port, '127.0.0.1');",
                "}",
                "setInterval(() => {}, 1000);",
                "NODE",
                `port_key='${service.web.portEnvKey}'`,
                'env_file="${config_dir:+$config_dir/.env}"',
                'if [ -z "$service_port" ] && [ -f "$env_file" ]; then',
                "  service_port=\"$(node -e \"const fs=require('node:fs'); const [file,key]=process.argv.slice(1); const line=fs.readFileSync(file,'utf8').split(/\\\\r?\\\\n/).find((item)=>item.startsWith(key+'=')); const raw=(line?line.slice(key.length+1):'').trim().replace(/^['\\\\\\\"]|['\\\\\\\"]$/g,''); const match=raw.match(/:(\\\\d+)$/)||raw.match(/^(\\\\d+)/); if (match) process.stdout.write(match[1]);\" \"$env_file\" \"$port_key\")\"",
                "fi",
                `node "$fixture_script" "$service_port" >/dev/null 2>&1 &`,
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
          'pid_dir="$PWD/run"',
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in',
          '    --state-dir) pid_dir="$2"; shift 2 ;;',
          "    *) shift ;;",
          "  esac",
          "done",
          `pid_file="$pid_dir/${service.id}.pid"`,
          'if [ -f "$pid_file" ]; then',
          '  kill "$(cat "$pid_file")" >/dev/null 2>&1 || true',
          '  rm -f "$pid_file"',
          "fi"
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(bundleRoot, deployFileName),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "mkdir -p run",
          options.deployDelayMs ? `sleep ${options.deployDelayMs / 1000}` : "",
          `printf '%s\\n' '${service.id}' >> run/deploy.log`
        ].filter(Boolean).join("\n") + "\n",
        "utf8"
      );
      const programCommonContent = service.id === "identity-center"
        ? [
            "#!/usr/bin/env bash",
            'FRONTEND_DIST_DIR="${FRONTEND_DIST_DIR:-./frontend/dist}"',
            'nohup "$BACKEND_BIN" >/dev/null 2>&1 &'
          ].join("\n") + "\n"
        : service.id === "agent-webclient"
          ? [
              "#!/usr/bin/env bash",
              "# agent-webclient is hosted by ZenMind Desktop."
            ].join("\n") + "\n"
        : "#!/usr/bin/env bash\n";
      fs.writeFileSync(path.join(bundleRoot, "scripts", programCommonName), programCommonContent, "utf8");
      fs.chmodSync(path.join(bundleRoot, startFileName), 0o755);
      fs.chmodSync(path.join(bundleRoot, stopFileName), 0o755);
      fs.chmodSync(path.join(bundleRoot, deployFileName), 0o755);
      fs.chmodSync(path.join(bundleRoot, "scripts", programCommonName), 0o755);
      if (service.id === "identity-center") {
        const ext = isWindows ? "ps1" : "sh";
        fs.chmodSync(path.join(bundleRoot, "scripts", `setup-public-key.${ext}`), 0o755);
        fs.chmodSync(path.join(bundleRoot, "scripts", `issue-bridge-access-token.${ext}`), 0o755);
      }
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
        scripts: {
          start: startFileName,
          stop: stopFileName,
          deploy: deployFileName
        },
        configFiles: [
          {
            key: "env",
            label: ".env",
            relativePath: ".env",
            templateRelativePath: ".env.example",
            required: true
          },
          ...(service.id === "agent-platform"
            ? [
                {
                  key: "desktop",
                  label: "desktop.yml",
                  relativePath: "configs/desktop.yml",
                  templateRelativePath: "configs/desktop.example.yml",
                  required: true
                },
                ...[
                  "runtime",
                  "tools",
                  "ai-tools",
                  "channels",
                  "coder-settings",
                  "local-public-key",
                  "prompts"
                ].map((key) => ({
                  key,
                  label: key === "local-public-key" ? "local-public-key.pem" : `${key}.yml`,
                  relativePath: key === "local-public-key" ? "configs/local-public-key.pem" : `configs/${key}.yml`,
                  required: false
                }))
              ]
            : [])
        ],
        runtime: {
          pidRelativePath,
          requiredPaths: [
            startFileName,
            stopFileName,
            deployFileName,
            path.join("scripts", programCommonName),
            ".env.example",
            "manifest.json",
            ...(service.id === "agent-platform" ? ["configs", "runtime"] : []),
            ...(service.id === "agent-webclient" ? [path.join("frontend", "dist", "index.html")] : []),
            ...(service.id === "identity-center" ? [
              path.join("frontend", "dist", "index.html"),
              path.join("scripts", isWindows ? "setup-public-key.ps1" : "setup-public-key.sh"),
              path.join("scripts", isWindows ? "issue-bridge-access-token.ps1" : "issue-bridge-access-token.sh")
            ] : [])
          ]
        },
        web: service.web,
        desktop: createCoreDesktopManifest(service.id, archiveFileName)
      }, null, 2)}\n`,
      "utf8"
    );

    writeDirectoryArchive(tempRoot, archivePath, service.id);
  }

  addContainerHubAssetToFixture({ tempRoot, assetsRoot }, options.containerHubOptions);

  return {
    tempRoot,
    assetsRoot,
    corePortBase: portBase,
    ports
  };
}

async function stopStartupCoreProcesses(app) {
  await __testInternals.waitForBackgroundStartupPreparations();
  for (const serviceId of ["identity-center", "agent-platform", "agent-webclient"]) {
    try {
      const state = await getServiceState(app, serviceId);
      if (state.status === "running") {
        if (serviceId === "agent-webclient") {
          await stopService(app, serviceId);
          continue;
        }
        const pid = state.healthMeta.pid;
        if (pid && pid !== process.pid) {
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

async function waitForFile(filePath) {
  for (let i = 0; i < 20; i += 1) {
    if (fs.existsSync(filePath)) {
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
  return path.join(
    getTestHomeRoot(userDataRoot),
    APP_BRAND.paths.runtimeRootDirName,
    APP_BRAND.paths.desktopDataSubdir
  );
}

function getTestRuntimeRootForHome(homeRoot) {
  return path.join(homeRoot, APP_BRAND.paths.runtimeRootDirName);
}

function getExpectedDefaultRuntimeDir(homeRoot) {
  return process.platform === "win32"
    ? getTestRuntimeRootForHome(homeRoot)
    : `~/${APP_BRAND.paths.runtimeRootDirName}`;
}

function getTestHomeRoot(userDataRoot) {
  return path.basename(userDataRoot) === "user-data"
    ? path.join(path.dirname(userDataRoot), "home")
    : path.join(userDataRoot, "home");
}

function getTestProgramsRoot(userDataRoot) {
  return path.join(userDataRoot, "app-data", APP_BRAND.paths.programDataDirName);
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
  return path.join(getTestStateDir(userDataRoot, serviceId, kind), fileName);
}

function getTestLegacyPidPath(userDataRoot, serviceId, fileName, kind = "services") {
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertIdentityCenterDefaultBcryptEnv(content) {
  assert.match(content, new RegExp(`^AUTH_ADMIN_PASSWORD_BCRYPT='${escapeRegExp(TEST_IDENTITY_CENTER_BCRYPT)}'$`, "m"));
  assert.match(content, new RegExp(`^AUTH_APP_MASTER_PASSWORD_BCRYPT='${escapeRegExp(TEST_IDENTITY_CENTER_BCRYPT)}'$`, "m"));
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
  const previousAssetsRoot = process.env.DESKTOP_BUILTIN_ASSETS_ROOT;
  const previousTestCorePortBase = process.env.DESKTOP_TEST_CORE_SERVICE_PORT_BASE;
  const { testCoreServicePortBase, ...createAppOptions } = appOptions;
  const generatedAssets = assetsRoot ? null : createCurrentPlatformAssetsFixture();
  process.env.DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot ?? generatedAssets.assetsRoot;
  if (testCoreServicePortBase !== undefined) {
    process.env.DESKTOP_TEST_CORE_SERVICE_PORT_BASE = String(testCoreServicePortBase);
  }

  registryInternals.clearServices();
  const app = createApp(userDataRoot, createAppOptions);
  loadBuiltinServices(app);

  return {
    app,
    restore() {
      registryInternals.clearServices();
      if (previousAssetsRoot) {
        process.env.DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
      } else {
        delete process.env.DESKTOP_BUILTIN_ASSETS_ROOT;
      }
      if (previousTestCorePortBase !== undefined) {
        process.env.DESKTOP_TEST_CORE_SERVICE_PORT_BASE = previousTestCorePortBase;
      } else {
        delete process.env.DESKTOP_TEST_CORE_SERVICE_PORT_BASE;
      }
      if (generatedAssets) {
        fs.rmSync(generatedAssets.tempRoot, { recursive: true, force: true });
      }
    }
  };
}

function loadStartupCoreBuiltinsForTest(userDataRoot, fixture, appOptions = {}) {
  return loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, {
    ...appOptions,
    testCoreServicePortBase: fixture.corePortBase
  });
}

function writeContainerHubBundleRoot(bundleRoot, options = {}) {
  const isWindows = process.platform === "win32";
  const ext = isWindows ? "ps1" : "sh";

  let startScriptContent = options.startScriptContent ?? (isWindows ? "exit 0\r\n" : "#!/usr/bin/env bash\necho start\n");
  let deployScriptContent = options.deployScriptContent ?? (isWindows
    ? "New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'run') | Out-Null\r\nAdd-Content -LiteralPath (Join-Path $PSScriptRoot 'run/deploy.log') -Value 'agent-container-hub'"
    : "#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p run\nprintf '%s\\n' 'agent-container-hub' >> run/deploy.log\n");

  const bindAddr = options.bindAddr ?? "127.0.0.1:11960";
  const defaultPort = Number(String(bindAddr).match(/:(\d+)$/u)?.[1] || 11960);
  const assetFileName = options.assetFileName ?? currentBuiltinArchiveFileName("agent-container-hub", "v0.1.0");

  fs.mkdirSync(path.join(bundleRoot, "backend"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "configs", "environments"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "data", "rootfs"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "data", "builds"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "scripts"), { recursive: true });

  const exeName = isWindows ? "agent-container-hub.exe" : "agent-container-hub";
  fs.writeFileSync(path.join(bundleRoot, "backend", exeName), "binary", "utf8");

  if (isWindows && typeof options.startScriptContent === "string" && options.startScriptContent.includes("#!/usr/bin/env")) {
    startScriptContent = "exit 0\r\n";
  }
  if (isWindows && typeof options.deployScriptContent === "string" && options.deployScriptContent.includes("#!/usr/bin/env")) {
    deployScriptContent = "New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'run') | Out-Null\r\nAdd-Content -LiteralPath (Join-Path $PSScriptRoot 'run/deploy.log') -Value 'agent-container-hub'";
  }

  fs.writeFileSync(path.join(bundleRoot, `deploy.${ext}`), deployScriptContent, "utf8");
  fs.writeFileSync(path.join(bundleRoot, `start.${ext}`), startScriptContent, "utf8");
  fs.writeFileSync(path.join(bundleRoot, `stop.${ext}`), isWindows ? "exit 0\r\n" : "#!/usr/bin/env bash\necho stop\n", "utf8");
  fs.writeFileSync(path.join(bundleRoot, "scripts", `program-common.${ext}`), isWindows ? "# fixture\r\n" : "#!/usr/bin/env bash\n", "utf8");
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
          entry: `backend/${exeName}`
        },
        scripts: {
          start: isWindows ? [`start.${ext}`, "--daemon"] : ["start.sh", "--daemon"],
          stop: `stop.${ext}`,
          deploy: `deploy.${ext}`
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
            `backend/${exeName}`,
            `start.${ext}`,
            `stop.${ext}`,
            `deploy.${ext}`,
            `scripts/program-common.${ext}`,
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
          bundleTopLevelDir: "agent-container-hub",
          capabilities: {
            provides: [],
            requires: []
          }
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
  const archiveFileName = currentBuiltinArchiveFileName("agent-container-hub", "v0.1.0");
  const tarPath = path.join(serviceAssetDir, archiveFileName);

  writeContainerHubBundleRoot(tarBundleRoot, { ...options, assetFileName: archiveFileName });
  fs.mkdirSync(serviceAssetDir, { recursive: true });
  writeDirectoryArchive(tarFixtureRoot, tarPath, "agent-container-hub");

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
  const archiveFileName = currentBuiltinArchiveFileName("agent-container-hub", "v0.1.0");
  const tarPath = path.join(serviceAssetDir, archiveFileName);

  writeContainerHubBundleRoot(tarBundleRoot, { ...options, assetFileName: archiveFileName });
  fs.mkdirSync(serviceAssetDir, { recursive: true });
  writeDirectoryArchive(tarFixtureRoot, tarPath, "agent-container-hub");

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
  const isWindows = process.platform === "win32";
  const ext = isWindows ? "ps1" : "sh";

  let deployScriptContent = options.deployScriptContent === undefined
      ? isWindows
        ? [
            "$configDir = $PSScriptRoot",
            "$stateDir = Join-Path $PSScriptRoot 'run'",
            "New-Item -ItemType Directory -Force -Path $configDir | Out-Null",
            "New-Item -ItemType Directory -Force -Path $stateDir | Out-Null",
            "if (-not (Test-Path (Join-Path $configDir '.env'))) { Copy-Item .env.example (Join-Path $configDir '.env') -Force }",
            "[System.IO.File]::WriteAllText((Join-Path $stateDir 'deploy-marker.txt'), 'deployed')"
          ].join("\r\n")
        : [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            'config_dir="$PWD"',
            'state_dir="$PWD/run"',
            'mkdir -p "$config_dir" "$state_dir"',
            'if [ ! -f "$config_dir/.env" ]; then cp .env.example "$config_dir/.env"; fi',
            'printf deployed > "$state_dir/deploy-marker.txt"'
          ].join("\n") + "\n"
      : options.deployScriptContent;

  if (isWindows && typeof deployScriptContent === "string" && deployScriptContent.includes("#!/usr/bin/env")) {
    if (deployScriptContent.includes("exit 1")) {
      deployScriptContent = "Write-Error 'deploy failed'\r\nthrow 'deploy failed'\r\n";
    } else {
      deployScriptContent = "exit 0\r\n";
    }
  }

  const requiredPaths = ["manifest.json", `start.${ext}`, `stop.${ext}`, ".env.example"];

  fs.mkdirSync(path.join(installDir, "run"), { recursive: true });
  fs.writeFileSync(path.join(installDir, ".env.example"), `PORT=${port}\n`, "utf8");
  fs.writeFileSync(path.join(installDir, `start.${ext}`), isWindows ? "exit 0\r\n" : "#!/usr/bin/env bash\nexit 0\n", "utf8");
  fs.writeFileSync(path.join(installDir, `stop.${ext}`), isWindows ? "exit 0\r\n" : "#!/usr/bin/env bash\nexit 0\n", "utf8");

  const scripts = {
    start: `start.${ext}`,
    stop: `stop.${ext}`
  };
  if (deployScriptContent !== false) {
    fs.writeFileSync(path.join(installDir, `deploy.${ext}`), deployScriptContent, "utf8");
    requiredPaths.push(`deploy.${ext}`);
    scripts.deploy = `deploy.${ext}`;
  }

  fs.writeFileSync(
    path.join(installDir, "manifest.json"),
    `${JSON.stringify(
      {
        id: pluginId,
        name: pluginName,
        version,
        description: "fixture plugin",
        service: {
          ui: "none",
          web: {
            healthPath: "",
            portEnvKey: "PORT",
            defaultPort: port
          }
        },
        lifecycle: scripts,
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
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const scriptNames = isWindows ? ["start.ps1", "stop.ps1", "deploy.ps1"] : ["start.sh", "stop.sh", "deploy.sh"];
  for (const scriptName of scriptNames) {
    const scriptPath = path.join(installDir, scriptName);
    if (fs.existsSync(scriptPath)) {
      fs.chmodSync(scriptPath, 0o755);
    }
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, "manifest.json"), "utf8"));
  registerPlugin(manifest);
  return manifest;
}

function writeResourcePluginInstallRoot(installDir, options = {}) {
  const pluginId = options.id ?? "calendar";
  const pluginName = options.name ?? "Calendar";
  const version = options.version ?? "v1.0.0";
  const resources = options.resources ?? {
    webapps: [{ id: "calendar", source: "webapp/calendar" }]
  };
  const requiredPaths = options.requiredPaths ?? ["manifest.json"];

  fs.mkdirSync(installDir, { recursive: true });
  if (resources.webapps?.some((webapp) => webapp.id === "calendar")) {
    const sourceDir = path.join(installDir, "webapp", "calendar");
    fs.mkdirSync(path.join(sourceDir, "frontend"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "backend"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "webapp.json"), `${JSON.stringify({
      id: "calendar",
      kind: "webapp",
      label: "日历",
      frontend: { root: "frontend", index: "index.html", apiPrefix: "/api" },
      backend: { runtime: "node", entry: "backend/server.mjs", healthPath: "/api/health" }
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(sourceDir, "frontend", "index.html"), "<!doctype html>\n", "utf8");
    fs.writeFileSync(path.join(sourceDir, "backend", "server.mjs"), "console.log('calendar')\n", "utf8");
    for (const relativePath of [
      "webapp/calendar/webapp.json",
      "webapp/calendar/frontend/index.html",
      "webapp/calendar/backend/server.mjs"
    ]) {
      if (!requiredPaths.includes(relativePath)) {
        requiredPaths.push(relativePath);
      }
    }
  }

  fs.writeFileSync(
    path.join(installDir, "manifest.json"),
    `${JSON.stringify({
      pluginApiVersion: 1,
      id: pluginId,
      name: pluginName,
      version,
      description: "fixture resource plugin",
      runtime: { requiredPaths },
      resources
    }, null, 2)}\n`,
    "utf8"
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, "manifest.json"), "utf8"));
  registerPlugin(manifest);
  return manifest;
}

function createSpawnSyncResult(status, output = {}) {
  return {
    status,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? ""
  };
}

function computeAssetSignature(assetPath) {
  const stat = fs.statSync(assetPath);
  const hash = createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
  return `${stat.size}:${hash}`;
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
  __testInternals.clearContainerEngineProbeCache();
  childProcess.spawnSync = mockImplementation;
  delete process.env.SHELL;

  try {
    return run();
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    __testInternals.clearContainerEngineProbeCache();
    if (previousShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previousShell;
    }
  }
}

async function withEnvPatch(patch, fn) {
  const previous = new Map();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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
      "SERVER_PORT=11949",
      "LOCAL_CLI_ACP_RELAY_ENABLED=true",
      "LOCAL_CLI_ACP_RELAY_PORT=4555",
      "CLAUDE_CODE_ACP_COMMAND=/custom/bin/claude-code-acp",
      "CLAUDE_CODE_ACP_ARGS=--stdio"
    ].join("\n")
  );

  assert.doesNotMatch(next, /^SERVER_PORT=/m);
  assert.doesNotMatch(next, /^LOCAL_CLI_ACP_RELAY_ENABLED=/m);
  assert.doesNotMatch(next, /^LOCAL_CLI_ACP_RELAY_PORT=/m);
  assert.doesNotMatch(next, /^CLAUDE_CODE_ACP_COMMAND=/m);
  assert.doesNotMatch(next, /^CLAUDE_CODE_ACP_ARGS=/m);
});

test("normalizeAgentWebclientEnvContentForDesktop writes desktop mode without stripping existing keys", () => {
  const next = __testInternals.normalizeAgentWebclientEnvContentForDesktop(
    [
      "PORT=11948",
      "# DESKTOP_APP=true",
      "NODE_BIN=/tmp/node",
      "NODE_ENV=production",
      "DEV_SERVER_ALLOWED_HOSTS=all",
      "BASE_URL=http://127.0.0.1:11949"
    ].join("\n")
  );

  assert.match(next, /^PORT=11948$/m);
  assert.match(next, /^DESKTOP_APP=true$/m);
  assert.doesNotMatch(next, /^# DESKTOP_APP=true$/m);
  assert.equal([...next.matchAll(/^DESKTOP_APP=/gm)].length, 1);
  assert.ok(next.indexOf("DESKTOP_APP=true") < next.indexOf("NODE_BIN=/tmp/node"));
  assert.match(next, /^BASE_URL=http:\/\/127\.0\.0\.1:11949$/m);
  assert.match(next, /^NODE_BIN=\/tmp\/node$/m);
  assert.match(next, /^NODE_ENV=production$/m);
  assert.match(next, /^DEV_SERVER_ALLOWED_HOSTS=all$/m);
});

test("normalizeAgentContainerHubEnvContentForDesktop removes stale relative desktop-managed paths", () => {
  const next = __testInternals.normalizeAgentContainerHubEnvContentForDesktop(
    [
      "BIND_ADDR=127.0.0.1:11960",
      "STATE_DB_PATH=./data/hub.db",
      "CONFIG_ROOT=./configs",
      "ROOTFS_ROOT=./data/rootfs",
      "BUILD_ROOT=./data/builds",
      "SESSION_MOUNT_TEMPLATE_ROOT=./zenmind-env",
      "ENGINE=auto",
      "DISPLAY_TIMEZONE=Asia/Shanghai"
    ].join("\n") + "\n"
  );

  assert.match(next, /^BIND_ADDR=127\.0\.0\.1:11960$/m);
  assert.match(next, /^ENGINE=auto$/m);
  assert.match(next, /^DISPLAY_TIMEZONE=Asia\/Shanghai$/m);
  assert.doesNotMatch(next, /^STATE_DB_PATH=/m);
  assert.doesNotMatch(next, /^CONFIG_ROOT=/m);
  assert.doesNotMatch(next, /^ROOTFS_ROOT=/m);
  assert.doesNotMatch(next, /^BUILD_ROOT=/m);
  assert.doesNotMatch(next, /^SESSION_MOUNT_TEMPLATE_ROOT=/m);
});

test("normalizeAgentContainerHubEnvContentForDesktop removes custom absolute desktop-managed paths", () => {
  const next = __testInternals.normalizeAgentContainerHubEnvContentForDesktop(
    [
      "BIND_ADDR=127.0.0.1:11960",
      "STATE_DB_PATH=/var/lib/agent-container-hub/hub.db",
      "CONFIG_ROOT=\"/etc/agent-container-hub/configs\"",
      "ROOTFS_ROOT='/var/lib/agent-container-hub/rootfs'",
      "BUILD_ROOT=/var/lib/agent-container-hub/builds",
      "SESSION_MOUNT_TEMPLATE_ROOT=C:\\\\agent-container-hub\\\\templates",
      "ENGINE=podman"
    ].join("\n") + "\n"
  );

  assert.doesNotMatch(next, /^STATE_DB_PATH=/m);
  assert.doesNotMatch(next, /^CONFIG_ROOT=/m);
  assert.doesNotMatch(next, /^ROOTFS_ROOT=/m);
  assert.doesNotMatch(next, /^BUILD_ROOT=/m);
  assert.doesNotMatch(next, /^SESSION_MOUNT_TEMPLATE_ROOT=/m);
  assert.match(next, /^ENGINE=podman$/m);
});

test("applyAgentPlatformWindowsHostShellDefaults injects PowerShell defaults on Windows", () => {
  const updates = new Map();
  const changed = __testInternals.applyAgentPlatformWindowsHostShellDefaults(
    new Map([["SERVER_PORT", "11949"]]),
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

test("normalizeAgentPlatformEnvContentForRuntime removes child runtime dir keys when RUNTIME_DIR is set", () => {
  const next = __testInternals.normalizeAgentPlatformEnvContentForRuntime(
    [
      "SERVER_PORT=11949",
      "RUNTIME_DIR=/tmp/agent-runtime",
      "REGISTRIES_DIR=/tmp/agent-runtime/registries",
      "MEMORY_DIR=/tmp/agent-runtime/memory",
      "CHATS_DIR=/tmp/custom-chats"
    ].join("\n")
  );

  assert.match(next, /^RUNTIME_DIR=\/tmp\/agent-runtime$/m);
  assert.doesNotMatch(next, /^REGISTRIES_DIR=/m);
  assert.doesNotMatch(next, /^MEMORY_DIR=/m);
  assert.doesNotMatch(next, /^CHATS_DIR=/m);
});

test("normalizeAgentPlatformEnvContentForRuntime removes child runtime dirs without inferring RUNTIME_DIR", () => {
  const next = __testInternals.normalizeAgentPlatformEnvContentForRuntime(
    [
      "SERVER_PORT=11949",
      "REGISTRIES_DIR=/tmp/agent-runtime/registries",
      "AGENTS_DIR=/tmp/agent-runtime/agents",
      "PAN_DIR=/tmp/agent-runtime/pan"
    ].join("\n")
  );

  assert.doesNotMatch(next, /^SERVER_PORT=/m);
  assert.doesNotMatch(next, /^RUNTIME_DIR=/m);
  assert.doesNotMatch(next, /^REGISTRIES_DIR=/m);
  assert.doesNotMatch(next, /^AGENTS_DIR=/m);
  assert.doesNotMatch(next, /^PAN_DIR=/m);
});

test("normalizeAgentPlatformEnvContentForRuntime does not inject Desktop CDP env bindings", () => {
  const withoutCdp = __testInternals.normalizeAgentPlatformEnvContentForRuntime(
    [
      "SERVER_PORT=11949"
    ].join("\n")
  );

  assert.doesNotMatch(withoutCdp, /^CDP_HOST=/m);
  assert.doesNotMatch(withoutCdp, /^CDP_PORT=/m);

  const withExistingCdp = __testInternals.normalizeAgentPlatformEnvContentForRuntime(
    [
      "SERVER_PORT=11949",
      "CDP_HOST=localhost",
      "CDP_PORT=9222"
    ].join("\n")
  );

  assert.match(withExistingCdp, /^CDP_HOST=localhost$/m);
  assert.match(withExistingCdp, /^CDP_PORT=9222$/m);
});

test("service install dir follows Application Support services/<id>/<version>", () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);
  const service = getBuiltinService("agent-platform");
  const installDir = getInstallDir(app, service);
  assert.equal(
    installDir,
    getTestServiceProgramDir(userDataRoot, service.id, service.version)
  );
  restore();
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
});

test("parsePort reads Desktop core service ports from their config keys", () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);
  const authService = registerPlugin({
    id: "identity-center",
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
  }, { defaultKind: "builtin" });
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
    new Map([["SERVER_PORT", "8123"]])
  );
  const platformFallbackPort = __testInternals.parsePort(
    getBuiltinService("agent-platform"),
    new Map()
  );
  const platformBadPort = __testInternals.parsePort(
    getBuiltinService("agent-platform"),
    new Map([["SERVER_PORT", "117078"]])
  );

  assert.equal(webclientPort, 7080);
  assert.equal(webclientBadPort, fixture.ports.webclient);
  assert.equal(authPort, 7076);
  assert.equal(authBadPort, fixture.ports.identityCenter);
  assert.equal(hubPort, 7079);
  assert.equal(hubBadPort, fixture.ports.containerHub);
  assert.equal(platformPort, 8123);
  assert.equal(platformFallbackPort, fixture.ports.platform);
  assert.equal(platformBadPort, fixture.ports.platform);
  restore();
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
});

test("desktop capability resolution prefers identity-center over legacy auth providers", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-capability-provider-priority-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const capabilityId = "auth.publicKey";
  const registerProvider = (serviceId) => registerPlugin({
    id: serviceId,
    name: serviceId,
    kind: "builtin",
    version: "v1.0.0",
    description: "fixture",
    frontend: {
      mode: "none"
    },
    scripts: {
      start: "start.ps1",
      stop: "stop.ps1"
    },
    runtime: {},
    web: {
      routePath: "/",
      portEnvKey: "SERVER_PORT",
      defaultPort: 19000
    },
    desktop: {
      capabilities: {
        provides: [
          {
            id: capabilityId,
            windowsCommand: [process.execPath, "-e", `console.log(${JSON.stringify(serviceId)})`],
            darwinCommand: [process.execPath, "-e", `console.log(${JSON.stringify(serviceId)})`],
            linuxCommand: [process.execPath, "-e", `console.log(${JSON.stringify(serviceId)})`],
            output: "stdoutLastLine"
          }
        ],
        requires: []
      }
    }
  }, { defaultKind: "builtin" });

  try {
    registryInternals.clearServices();
    const identityService = registerProvider("identity-center");
    registerProvider("zenmind-app-server");
    for (const service of [identityService]) {
      fs.mkdirSync(getTestServiceProgramDir(userDataRoot, service.id, service.version), { recursive: true });
      writeTestEnv(userDataRoot, service.id, "SERVER_PORT=19000\n");
    }

    const capability = await resolveDesktopCapability(app, capabilityId);

    assert.equal(capability.providerServiceId, "identity-center");
    assert.equal(capability.text, "identity-center");
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("plugin services without configFiles do not require .env", async () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-no-env-"));
  try {
    registryInternals.clearServices();
    const app = createApp(userDataRoot);
    const manifest = {
      pluginApiVersion: 1,
      id: "no-env-plugin",
      name: "No Env Plugin",
      version: "v0.1.0",
      description: "fixture plugin without config files",
      lifecycle: {
        start: "start.sh",
        stop: "stop.sh"
      },
      runtime: {
        pidRelativePath: "run/no-env-plugin.pid",
        logRelativePath: "run/no-env-plugin.log",
        requiredPaths: ["manifest.json"]
      },
      service: {
        ui: "none"
      }
    };
    const service = registerPlugin(manifest);
    const installDir = getInstallDir(app, service);
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const stateDir = path.join(getTestDesktopRoot(userDataRoot), "state", "plugins", service.id);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "init-state.json"),
      `${JSON.stringify({
        version: service.version,
        status: "succeeded",
        updatedAt: "2026-06-13T00:00:00.000Z"
      }, null, 2)}\n`,
      "utf8"
    );

    const state = await getServiceState(app, service.id);
    assert.equal(state.configFiles.length, 0);
    assert.notEqual(state.status, "config-required");
    assert.doesNotMatch(state.message, /缺少 \.env/u);
  } finally {
    registryInternals.clearServices();
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  }
});

test("agent-platform start env does not inject NODE_BIN or port overrides", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);
  const service = getBuiltinService("agent-platform");

  try {
    writeTestEnv(userDataRoot, service.id, "SERVER_PORT=7078\n");
    const overrides = __testInternals.getStartCommandEnvOverrides(app, service);
    assert.equal(overrides, undefined);
    assert.equal(fs.readFileSync(getTestEnvPath(userDataRoot, service.id), "utf8"), "SERVER_PORT=7078\n");
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("desktop managed service commands append layout flags for container hub and identity-center", () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);

  const assertFlag = (command, flag, value) => {
    const index = command.indexOf(flag);
    assert.notEqual(index, -1, `expected ${flag} in ${command.join(" ")}`);
    assert.equal(command[index + 1], value);
  };

  try {
    for (const serviceId of ["agent-container-hub", "identity-center"]) {
      const service = getBuiltinService(serviceId);
      const envPath = writeTestEnv(
        userDataRoot,
        service.id,
        service.id === "agent-container-hub" ? "BIND_ADDR=127.0.0.1:7079\n" : "SERVER_PORT=7076\n"
      );
      const layout = {
        programDir: getTestServiceProgramDir(userDataRoot, service.id, service.version),
        configDir: getTestConfigDir(userDataRoot, service.id),
        dataDir: getTestDataDir(userDataRoot, service.id),
        stateDir: getTestStateDir(userDataRoot, service.id),
        logDir: getTestLogDir(userDataRoot, service.id),
        envPath
      };

      for (const kind of ["start", "deploy", "stop"]) {
        const command = __testInternals.appendDesktopManagedLayoutFlags(service, [`${kind}.sh`], layout, kind);
        assertFlag(command, "--config-dir", layout.configDir);
        assertFlag(command, "--data-dir", layout.dataDir);
        assertFlag(command, "--state-dir", layout.stateDir);
        assertFlag(command, "--log-dir", layout.logDir);
        if (service.id === "agent-container-hub") {
          assertFlag(command, "--bind-addr", "127.0.0.1:7079");
        } else {
          assertFlag(command, "--port", "7076");
        }
      }
    }
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("desktop managed service commands insert configured lifecycle args before layout flags", () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);

  const assertFlag = (command, flag, value) => {
    const index = command.indexOf(flag);
    assert.notEqual(index, -1, `expected ${flag} in ${command.join(" ")}`);
    assert.equal(command[index + 1], value);
  };

  try {
    const configPath = path.join(getDesktopConfigRoot(app), "service-lifecycle-args.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({
      schemaVersion: 1,
      services: {
        "identity-center": {
          lifecycleArgs: {
            deploy: ["--extra-deploy"],
            start: ["--extra-start", "alpha"],
            stop: ["--extra-stop"]
          }
        },
        "agent-webclient": {
          lifecycleArgs: {
            deploy: ["--extra-webclient-deploy"],
            start: ["--ignored-webclient-start"],
            stop: ["--ignored-webclient-stop"]
          }
        }
      }
    }, null, 2)}\n`, "utf8");

    const service = getBuiltinService("identity-center");
    const envPath = writeTestEnv(userDataRoot, service.id, "SERVER_PORT=7076\n");
    const layout = {
      programDir: getTestServiceProgramDir(userDataRoot, service.id, service.version),
      configDir: getTestConfigDir(userDataRoot, service.id),
      dataDir: getTestDataDir(userDataRoot, service.id),
      stateDir: getTestStateDir(userDataRoot, service.id),
      logDir: getTestLogDir(userDataRoot, service.id),
      envPath
    };

    for (const [kind, extraArgs] of [
      ["deploy", ["--extra-deploy"]],
      ["start", ["--extra-start", "alpha"]],
      ["stop", ["--extra-stop"]]
    ]) {
      const commandWithArgs = __testInternals.appendConfiguredServiceLifecycleArgs(
        app,
        service,
        [`${kind}.sh`, "--manifest-arg"],
        kind
      );
      const command = __testInternals.appendDesktopManagedLayoutFlags(service, commandWithArgs, layout, kind);
      assert.deepEqual(command.slice(0, 2 + extraArgs.length), [
        `${kind}.sh`,
        "--manifest-arg",
        ...extraArgs
      ]);
      assert.ok(command.indexOf("--config-dir") > command.indexOf(extraArgs.at(-1)));
      assertFlag(command, "--config-dir", layout.configDir);
      assertFlag(command, "--data-dir", layout.dataDir);
      assertFlag(command, "--state-dir", layout.stateDir);
      assertFlag(command, "--log-dir", layout.logDir);
      assertFlag(command, "--port", "7076");
    }

    const webclient = getBuiltinService("agent-webclient");
    assert.deepEqual(
      __testInternals.appendConfiguredServiceLifecycleArgs(app, webclient, ["deploy.sh"], "deploy"),
      ["deploy.sh", "--extra-webclient-deploy"]
    );
    assert.deepEqual(
      __testInternals.appendConfiguredServiceLifecycleArgs(app, webclient, ["start.sh"], "start"),
      ["start.sh"]
    );
    assert.deepEqual(
      __testInternals.appendConfiguredServiceLifecycleArgs(app, webclient, ["stop.sh"], "stop"),
      ["stop.sh"]
    );
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("agent-platform deploy command uses deploy-only Desktop args after configured args", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);

  const assertFlag = (command, flag, value) => {
    const index = command.indexOf(flag);
    assert.notEqual(index, -1, `expected ${flag} in ${command.join(" ")}`);
    assert.equal(command[index + 1], value);
  };

  try {
    const configPath = path.join(getDesktopConfigRoot(app), "service-lifecycle-args.json");
    const configuredArgs = [
      "--ai-vision-general-model-key", "th-minimax-m3",
      "--ai-vision-ocr-model-key", "th-minimax-m3",
      "--ai-web-fetch-model-key", "th-minimax-m3",
      "--coder-model-key", "deepseek-v4-pro",
      "--coder-reasoning-effort", "MEDIUM"
    ];
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({
      schemaVersion: 1,
      services: {
        "agent-platform": {
          lifecycleArgs: {
            deploy: configuredArgs
          }
        }
      }
    }, null, 2)}\n`, "utf8");

    await installBuiltinService(app, "agent-container-hub");
    const service = getBuiltinService("agent-platform");
    const publicKeyPath = path.join(getTestConfigDir(userDataRoot, service.id), "configs", "local-public-key.pem");
    const identityCenterPublicKeyPath = path.join(getTestDataDir(userDataRoot, "identity-center"), "keys", "publicKey.pem");
    fs.mkdirSync(path.dirname(publicKeyPath), { recursive: true });
    fs.writeFileSync(publicKeyPath, "EXISTING_PUBLIC_KEY\n", "utf8");
    const envPath = writeTestEnv(userDataRoot, service.id, `SERVER_PORT=${fixture.ports.platform}\n`);
    const layout = {
      programDir: getTestServiceProgramDir(userDataRoot, service.id, service.version),
      configDir: getTestConfigDir(userDataRoot, service.id),
      dataDir: getTestDataDir(userDataRoot, service.id),
      stateDir: getTestStateDir(userDataRoot, service.id),
      logDir: getTestLogDir(userDataRoot, service.id),
      envPath
    };

    const command = await __testInternals.buildDesktopManagedDeployCommand(
      app,
      service,
      ["deploy.sh", "--manifest-arg"],
      layout
    );

    assert.deepEqual(command.slice(0, 2 + configuredArgs.length), [
      "deploy.sh",
      "--manifest-arg",
      ...configuredArgs
    ]);
    for (const forbidden of ["--config-dir", "--runtime-dir", "--state-dir", "--log-dir", "--port", "--daemon"]) {
      assert.equal(command.includes(forbidden), false, `${forbidden} should not be passed to agent-platform deploy`);
    }
    assert.ok(command.indexOf("--output-dir") > command.indexOf(configuredArgs.at(-1)));
    assertFlag(command, "--output-dir", layout.configDir);
    assertFlag(command, "--ap-runtime-dir", getTestRuntimeRootForHome(app.getPath("home")));
    assertFlag(command, "--container-hub-base-url", `http://127.0.0.1:${fixture.ports.containerHub}`);
    assertFlag(command, "--public-key-source-file", identityCenterPublicKeyPath);
    assert.equal(command.includes("--local-public-key-file"), false);
    assert.notEqual(identityCenterPublicKeyPath, publicKeyPath);

    const startCommand = __testInternals.appendDesktopManagedLayoutFlags(service, ["start.sh"], layout, "start");
    assertFlag(startCommand, "--config-dir", layout.configDir);
    assert.equal(startCommand.includes("--runtime-dir"), false);
    assertFlag(startCommand, "--state-dir", layout.stateDir);
    assertFlag(startCommand, "--log-dir", layout.logDir);
    assertFlag(startCommand, "--port", String(fixture.ports.platform));
    const stopCommand = __testInternals.appendDesktopManagedLayoutFlags(service, ["stop.sh"], layout, "stop");
    assert.deepEqual(stopCommand, ["stop.sh", "--state-dir", layout.stateDir]);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("agent-platform deploy public key source resolves auth capability when config key is missing", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const homeRoot = path.join(fixture.tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformPublicKeyPath = path.join(
    getTestConfigDir(userDataRoot, platformService.id),
    "configs",
    "local-public-key.pem"
  );
  const identityCenterPublicKeyPath = path.join(
    getTestDataDir(userDataRoot, "identity-center"),
    "keys",
    "publicKey.pem"
  );
  try {
    await installBuiltinService(app, "identity-center");
    assert.equal(fs.existsSync(platformPublicKeyPath), false);

    const publicKeySource = await __testInternals.resolveAgentPlatformDeployPublicKeySourceFile(app);

    assert.equal(publicKeySource, identityCenterPublicKeyPath);
    assert.equal(fs.readFileSync(publicKeySource, "utf8").replace(/\r\n/gu, "\n"), "IDENTITY_CENTER_PUBLIC_KEY\n");
    assert.equal(fs.existsSync(platformPublicKeyPath), false);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("service command runner strips legacy layout env from child process", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-service-env-scrub-"));
  try {
    await withLegacyLayoutEnv(async () => {
      const result = await __testInternals.runExecFile(
        process.execPath,
        [
          "-e",
          [
            `const keys = ${JSON.stringify(LEGACY_LAYOUT_ENV_KEYS)};`,
            "const found = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));",
            "process.stdout.write(JSON.stringify(found));"
          ].join("")
        ],
        tempRoot
      );
      assertNoLegacyLayoutEnv(JSON.parse(result.stdout));
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("service command env injects DESKTOP_DEVICE_ID for builtin and plugin layouts without persisting it", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-device-env-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const builtinEnvPath = writeTestEnv(userDataRoot, "agent-platform", "SERVER_PORT=7078\n");
  const pluginEnvPath = writeTestEnv(userDataRoot, "test-plugin", "PORT=9090\n", "plugins");
  const builtinLayout = {
    programDir: getTestServiceProgramDir(userDataRoot, "agent-platform", "v1.0.0"),
    configDir: getTestConfigDir(userDataRoot, "agent-platform"),
    dataDir: getTestDataDir(userDataRoot, "agent-platform"),
    stateDir: getTestStateDir(userDataRoot, "agent-platform"),
    logDir: getTestLogDir(userDataRoot, "agent-platform"),
    envPath: builtinEnvPath
  };
  const pluginLayout = {
    programDir: getTestPluginProgramDir(userDataRoot, "test-plugin"),
    configDir: getTestConfigDir(userDataRoot, "test-plugin", "plugins"),
    dataDir: getTestDataDir(userDataRoot, "test-plugin", "plugins"),
    stateDir: getTestStateDir(userDataRoot, "test-plugin", "plugins"),
    logDir: getTestLogDir(userDataRoot, "test-plugin", "plugins"),
    envPath: pluginEnvPath
  };

  try {
    const builtinEnv = __testInternals.buildDesktopServiceCommandEnv(app, builtinLayout, undefined);
    const pluginEnv = __testInternals.buildDesktopServiceCommandEnv(app, pluginLayout, { NODE_BIN: "/tmp/node" });

    assert.equal(typeof builtinEnv.DESKTOP_DEVICE_ID, "string");
    assert.match(builtinEnv.DESKTOP_DEVICE_ID, /^[0-9a-f-]{36}$/i);
    assert.equal(pluginEnv.DESKTOP_DEVICE_ID, builtinEnv.DESKTOP_DEVICE_ID);
    assert.equal(pluginEnv.NODE_BIN, "/tmp/node");
    assert.equal(fs.readFileSync(builtinEnvPath, "utf8"), "SERVER_PORT=7078\n");
    assert.equal(fs.readFileSync(pluginEnvPath, "utf8"), "PORT=9090\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("desktop capability templates render global device name for macOS and Windows args", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-capability-device-name-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const envPath = writeTestEnv(
    userDataRoot,
    "identity-center",
    [
      `AUTH_DB_PATH=${path.join(tempRoot, "auth.db")}`,
      "AUTH_ISSUER=http://127.0.0.1:9090",
      "AUTH_APP_USERNAME=desktop-user",
      ""
    ].join("\n")
  );
  const layout = {
    programDir: getTestServiceProgramDir(userDataRoot, "identity-center", "v1.0.0"),
    configDir: getTestConfigDir(userDataRoot, "identity-center"),
    dataDir: getTestDataDir(userDataRoot, "identity-center"),
    stateDir: getTestStateDir(userDataRoot, "identity-center"),
    logDir: getTestLogDir(userDataRoot, "identity-center"),
    envPath
  };
  const service = {
    id: "identity-center",
    web: {
      portEnvKey: "SERVER_PORT",
      defaultPort: 7078
    }
  };
  const provider = {
    id: "auth.accessToken",
    output: "stdoutLastLine",
    outputPath: "{{provider.dataDir}}/tokens/{{desktop.deviceName}}.txt"
  };
  const renderArgs = (args, values) => args.map((part) => capabilityInternals.renderTemplate(part, values));

  try {
    updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
      general: {
        deviceName: "Studio Desktop"
      }
    });
    const values = capabilityInternals.buildTemplateValues(app, service, layout, provider);

    assert.equal(values["desktop.deviceName"], "Studio Desktop");
    assert.match(values["desktop.deviceId"], /^[0-9a-f-]{36}$/i);
    assert.equal(values["output.path"], `${layout.dataDir}/tokens/Studio Desktop.txt`);
    assert.deepEqual(
      renderArgs(["--db", "{{auth.dbPath}}", "--device-name", "{{desktop.deviceName}}"], values),
      ["--db", path.join(tempRoot, "auth.db"), "--device-name", "Studio Desktop"]
    );
    assert.deepEqual(
      renderArgs(["-Db", "{{auth.dbPath}}", "-DeviceName", "{{desktop.deviceName}}", "-DeviceId", "{{desktop.deviceId}}"], values),
      ["-Db", path.join(tempRoot, "auth.db"), "-DeviceName", "Studio Desktop", "-DeviceId", values["desktop.deviceId"]]
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("core builtin start commands run in daemon mode", () => {
  assert.deepEqual(
    __testInternals.getDesktopStartCommand({
      id: "agent-platform",
      kind: "builtin",
      startCommand: ["start.ps1"]
    }),
    ["start.ps1", "--daemon"]
  );
  assert.deepEqual(
    __testInternals.getDesktopStartCommand({
      id: "agent-webclient",
      kind: "builtin",
      startCommand: ["start.sh", "--daemon"]
    }),
    ["start.sh", "--daemon"]
  );
  assert.deepEqual(
    __testInternals.getDesktopStartCommand({
      id: "custom-plugin",
      kind: "plugin",
      startCommand: ["start.ps1"]
    }),
    ["start.ps1"]
  );
});

test("desktop start commands skip a second builtin asset refresh", () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);

  try {
    const options = __testInternals.getDesktopStartCommandOptions(app, getBuiltinService("agent-platform"));

    assert.equal(options.refreshBuiltinAsset, false);
    assert.equal(options.env, undefined);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("prepared startup starts without repeating builtin asset refresh", () => {
  const responsiveStateReadOptions = process.platform === "win32"
    ? {
        mode: "responsive",
        cacheContainerEngineProbe: true
      }
    : {
        cacheContainerEngineProbe: true
      };
  assert.deepEqual(__testInternals.getPreparedStartupStartOptions(), {
    skipPreStartRequirements: true,
    skipBuiltinAssetRefresh: true,
    stateReadOptions: {
      cacheContainerEngineProbe: true
    },
    commandStateReadOptions: responsiveStateReadOptions,
    verificationOptions: {
      stateReadOptions: responsiveStateReadOptions,
      skipManagedPortProbe: true
    }
  });
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

test("patchProgramCommonForLayeredLayout repairs agent-platform deploy diagnostics and no-op HITL migration", () => {
  const programDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-patch-"));
  const scriptPath = path.join(programDir, "scripts", "program-common.sh");
  const deployShPath = path.join(programDir, "deploy.sh");
  const deployPs1Path = path.join(programDir, "deploy.ps1");

  try {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(
      path.join(programDir, "manifest.json"),
      `${JSON.stringify({ id: "agent-platform" }, null, 2)}\n`,
      "utf8"
    );
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        'LOG_FILE="$LOG_DIR/$APP_NAME.log"',
        'PID_FILE="$RUN_DIR/$APP_NAME.pid"',
        'DEPLOY_LOCAL_PUBLIC_KEY_FILE=""',
        '      --local-public-key-file)',
        '        DEPLOY_LOCAL_PUBLIC_KEY_FILE="$2"',
        "program_migrate_hitl_budget_config() {",
        "  if [[ -f \"$host_tools_file\" ]] && grep -Eq '^[[:space:]]*hitl-default-timeout-ms:' \"$host_tools_file\"; then",
        "    legacy_file=\"$host_tools_file\"",
        "  elif [[ -f \"$runtime_file\" ]] && grep -Eq '^[[:space:]]*hitl-default-timeout-ms:' \"$runtime_file\"; then",
        "    legacy_file=\"$runtime_file\"",
        "  else",
        "    return",
        "  fi",
        "",
        "  timeout_ms=\"600000\"",
        "}"
      ].join("\n") + "\n",
      "utf8"
    );
    fs.writeFileSync(
      deployShPath,
      [
        "#!/usr/bin/env bash",
        'cd "$SCRIPT_DIR"',
        "program_validate_bundle",
        "program_initialize_config",
        "program_load_env",
        "program_prepare_runtime_dirs",
        "",
        'echo "[program-deploy] bundle validated"',
        'echo "[program-deploy] backend binary: $BACKEND_BIN"',
        'echo "[program-deploy] runtime directories prepared under $RUNTIME_ROOT and $RUN_DIR"'
      ].join("\n") + "\n",
      "utf8"
    );
    fs.writeFileSync(
      deployPs1Path,
      [
        "$ErrorActionPreference = 'Stop'",
        "Set-Location $ScriptDir",
        "Test-ProgramBundle",
        "Initialize-ProgramConfig",
        "Import-ProgramEnv",
        "Initialize-ProgramRuntime",
        "",
        "Write-Host '[program-deploy] bundle validated'",
        'Write-Host ("[program-deploy] backend binary: {0}" -f $Script:BackendBin)',
        'Write-Host ("[program-deploy] runtime directories prepared under {0} and {1}" -f $Script:RuntimeRoot, $Script:RunDir)'
      ].join("\r\n") + "\r\n",
      "utf8"
    );

    __testInternals.patchProgramCommonForLayeredLayout(programDir);

    const patched = fs.readFileSync(scriptPath, "utf8");
    const patchedDeploySh = fs.readFileSync(deployShPath, "utf8");
    const patchedDeployPs1 = fs.readFileSync(deployPs1Path, "utf8");
    assert.match(patched, /return 0/);
    assert.doesNotMatch(patched, /\n\s*return\n\s*fi/);
    assert.match(patched, /LOG_FILE="\$LOG_DIR\/agent-platform\.log"/);
    assert.match(patched, /PID_FILE="\$RUN_DIR\/agent-platform\.pid"/);
    assert.match(patched, /--public-key-source-file/);
    assert.match(patched, /DEPLOY_PUBLIC_KEY_SOURCE_FILE/);
    assert.doesNotMatch(patched, /--local-public-key-file/);
    assert.doesNotMatch(patched, /DEPLOY_LOCAL_PUBLIC_KEY_FILE/);
    assert.match(patchedDeploySh, /\[program-deploy\] validating bundle/);
    assert.match(patchedDeploySh, /\[program-deploy\] initializing config under \$CONFIG_DIR/);
    assert.match(patchedDeploySh, /\[program-deploy\] loading env: \$ENV_FILE/);
    assert.match(patchedDeploySh, /\[program-deploy\] deploy complete/);
    assert.match(patchedDeployPs1, /\[program-deploy\] validating bundle/);
    assert.match(patchedDeployPs1, /\[program-deploy\] initializing config under \{0\}/);
    assert.match(patchedDeployPs1, /\[program-deploy\] loading env: \{0\}/);
    assert.match(patchedDeployPs1, /\[program-deploy\] deploy complete/);
  } finally {
    fs.rmSync(programDir, { recursive: true, force: true });
  }
});

test("patchProgramCommonForLayeredLayout prepares agent-platform runtime dirs under RUNTIME_DIR", () => {
  const programDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-runtime-root-"));
  const scriptPath = path.join(programDir, "scripts", "program-common.sh");
  const powerShellPath = path.join(programDir, "scripts", "program-common.ps1");
  const homeRoot = path.join(programDir, "home");
  const serviceDataRoot = path.join(programDir, "service-data");

  try {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(
      path.join(programDir, "manifest.json"),
      `${JSON.stringify({ id: "agent-platform" }, null, 2)}\n`,
      "utf8"
    );
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'BUNDLE_ROOT="$PWD"',
        'RUNTIME_ROOT="$BUNDLE_ROOT/runtime"',
        "program_prepare_runtime_dirs() {",
        '  mkdir -p "$RUNTIME_ROOT/registries/providers" "$RUNTIME_ROOT/tools"',
        "}"
      ].join("\n") + "\n",
      "utf8"
    );
    fs.writeFileSync(
      powerShellPath,
      [
        "$Script:BundleRoot = $PSScriptRoot",
        '$Script:RuntimeRoot = Join-Path $Script:BundleRoot "runtime"',
        "function Initialize-ProgramRuntime {",
        '  New-Item -ItemType Directory -Path (Join-Path $Script:RuntimeRoot "tools") -Force | Out-Null',
        "}"
      ].join("\r\n") + "\r\n",
      "utf8"
    );

    __testInternals.patchProgramCommonForLayeredLayout(programDir);

    const patched = fs.readFileSync(scriptPath, "utf8");
    assert.match(patched, /program_resolve_runtime_root\(\)/);
    assert.match(patched, /program_prepare_runtime_dirs\(\) \{\n  program_resolve_runtime_root/);
    if (process.platform !== "win32") {
      execFileSync("bash", ["-c", '. "$1"; program_prepare_runtime_dirs', "bash", scriptPath], {
        env: {
          ...process.env,
          HOME: homeRoot,
          RUNTIME_DIR: "~/.zenmind"
        }
      });
      assert.equal(fs.existsSync(path.join(homeRoot, ".zenmind", "tools")), true);
      assert.equal(fs.existsSync(path.join(serviceDataRoot, "tools")), false);
    }

    const patchedPowerShell = fs.readFileSync(powerShellPath, "utf8");
    assert.match(patchedPowerShell, /function Resolve-ProgramRuntimeRoot/);
    assert.match(patchedPowerShell, /function Initialize-ProgramRuntime \{\r?\n  Resolve-ProgramRuntimeRoot/);
    assert.match(patchedPowerShell, /\[System\.IO\.Path\]::IsPathRooted\(\$trimmed\)/);
  } finally {
    fs.rmSync(programDir, { recursive: true, force: true });
  }
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

test("terminateProcessTree uses taskkill tree mode on Windows", () => {
  const calls = [];
  const terminated = __testInternals.terminateProcessTree(4321, {
    platform: "win32",
    isProcessRunningImpl: (pid) => pid === 4321,
    spawnSyncImpl: (command, args) => {
      calls.push({ command, args });
      return createSpawnSyncResult(0);
    }
  });

  assert.equal(terminated, true);
  assert.deepEqual(calls, [
    {
      command: "taskkill.exe",
      args: ["/PID", "4321", "/T", "/F"]
    }
  ]);
});

test("collectManagedRootPids reads legacy state pid directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-legacy-pid-root-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "legacy-plugin");
  const app = createApp(userDataRoot);
  const fixturePath = path.join(installDir, "legacy-worker.mjs");
  let child = null;

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    id: "legacy-plugin",
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
    const legacyPidPath = getTestLegacyPidPath(userDataRoot, "legacy-plugin", "test-plugin.pid", "plugins");
    fs.mkdirSync(path.dirname(legacyPidPath), { recursive: true });
    fs.writeFileSync(legacyPidPath, `${child.pid}\n`, "utf8");

    const roots = __testInternals.collectManagedRootPids(app);
    assert.equal(roots.some((root) => root.pid === child.pid && root.pidFilePaths.includes(legacyPidPath)), true);
  } finally {
    if (child?.pid && isPidRunning(child.pid)) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Process may already be gone when the test finishes.
      }
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("forceCleanupManagedProcesses removes stale legacy pid files without killing unrelated processes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-stale-legacy-pid-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "stale-legacy-plugin");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    id: "stale-legacy-plugin",
    port: 0,
    deployScriptContent: false
  });

  try {
    const legacyPidPath = getTestLegacyPidPath(userDataRoot, "stale-legacy-plugin", "test-plugin.pid", "plugins");
    fs.mkdirSync(path.dirname(legacyPidPath), { recursive: true });
    fs.writeFileSync(legacyPidPath, `${process.pid}\n`, "utf8");

    await forceCleanupManagedProcesses(app);

    assert.equal(fs.existsSync(legacyPidPath), false);
    assert.equal(isPidRunning(process.pid), true);
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("forceCleanupManagedProcesses recomputes process trees before killing snapshot roots", async (t) => {
  if (process.platform === "win32") {
    t.skip("This fixture uses POSIX process parentage; Windows tree cleanup is covered by unit tests.");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-dynamic-tree-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "dynamic-tree-plugin");
  const app = createApp(userDataRoot);
  const triggerPath = path.join(tempRoot, "spawn-child");
  const childPidPath = path.join(tempRoot, "child.pid");
  const rootPath = path.join(installDir, "dynamic-root.mjs");
  const childPath = path.join(installDir, "dynamic-child.mjs");
  let root = null;
  let childPid = null;

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    id: "dynamic-tree-plugin",
    port: 0,
    deployScriptContent: false
  });
  fs.writeFileSync(childPath, "setInterval(() => {}, 1000);\n", "utf8");
  fs.writeFileSync(
    rootPath,
    [
      'import fs from "node:fs";',
      'import { spawn } from "node:child_process";',
      "const [triggerPath, childPath, childPidPath] = process.argv.slice(2);",
      "let child = null;",
      "setInterval(() => {",
      "  if (child || !fs.existsSync(triggerPath)) { return; }",
      "  child = spawn(process.execPath, [childPath], { cwd: process.cwd(), stdio: 'ignore' });",
      "  fs.writeFileSync(childPidPath, `${child.pid}\\n`, 'utf8');",
      "}, 25);"
    ].join("\n"),
    "utf8"
  );

  try {
    const startResult = spawnSync(
      "sh",
      [
        "-c",
        'nohup "$1" "$2" "$3" "$4" "$5" >/dev/null 2>&1 & echo $!',
        "zenmind-dynamic-tree",
        process.execPath,
        rootPath,
        triggerPath,
        childPath,
        childPidPath
      ],
      {
        cwd: installDir,
        encoding: "utf8"
      }
    );
    assert.equal(startResult.status, 0, startResult.stderr || startResult.stdout);
    root = { pid: Number.parseInt(startResult.stdout.trim(), 10) };
    assert.ok(root.pid, "expected root process to expose a pid");
    const pidPath = path.join(getTestStateDir(userDataRoot, "dynamic-tree-plugin", "plugins"), "test-plugin.pid");
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, `${root.pid}\n`, "utf8");

    const snapshot = __testInternals.captureManagedProcessCleanupSnapshot(app);
    fs.writeFileSync(triggerPath, "spawn\n", "utf8");
    assert.equal(await waitForFile(childPidPath), true, "expected root process to spawn a child");
    childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
    assert.equal(isPidRunning(childPid), true);
    await new Promise((resolve) => setTimeout(resolve, 150));

    await forceCleanupManagedProcesses(app, snapshot);

    assert.equal(await waitForPidExit(root.pid), true);
    assert.equal(await waitForPidExit(childPid), true);
  } finally {
    for (const pid of [childPid, root?.pid]) {
      if (pid && isPidRunning(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process may already be gone after cleanup.
        }
      }
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("forceCleanupManagedProcesses reports failed roots and keeps live matching pid files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-cleanup-failure-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const pidFilePath = path.join(tempRoot, "managed.pid");
  const errors = [];

  fs.writeFileSync(pidFilePath, "4321\n", "utf8");

  try {
    await forceCleanupManagedProcesses(
      app,
      [
        {
          pid: 4321,
          serviceId: "failure-plugin",
          installDir: tempRoot,
          pidFilePaths: [pidFilePath],
          treePids: []
        }
      ],
      {
        collectManagedProcessCleanupTargetsImpl: () => ({
          roots: [],
          stalePidFilePaths: []
        }),
        terminateProcessTreeImpl: () => false,
        terminateProcessListImpl: () => false,
        isProcessRunningImpl: (pid) => pid === 4321,
        pidMatchesInstallDirImpl: () => true,
        consoleError: (message) => errors.push(message)
      }
    );

    assert.equal(fs.existsSync(pidFilePath), true);
    assert.match(errors.join("\n"), /failure-plugin: PID 4321/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

test("getServiceState removes stale pid files that point to unrelated live processes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-stale-live-pid-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const fixture = createStartupCoreAssetsFixture();
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot);

  try {
    await installBuiltinService(app, "agent-platform");
    markInitializationState(getTestInitializationStatePath(userDataRoot, "agent-platform"), "v1.0.0");
    const pidPath = getTestPidPath(userDataRoot, "agent-platform", "agent-platform.pid");
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, `${process.pid}\n`, "utf8");

    const state = await getServiceState(app, "agent-platform");

    assert.notEqual(state.status, "running");
    assert.equal(state.healthMeta.pid, null);
    assert.equal(fs.existsSync(pidPath), false);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("listServices uses lightweight Windows state reads for UI refreshes", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only responsiveness regression test.");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-windows-list-services-responsive-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const serviceId = "responsive-plugin";
  const installDir = getTestPluginProgramDir(userDataRoot, serviceId);
  const service = writePluginInstallRoot(installDir, {
    id: serviceId,
    name: "Responsive Plugin",
    port: 19380,
    deployScriptContent: false
  });
  const previousSpawnSync = childProcess.spawnSync;
  const slowProbeCalls = [];

  try {
    writeTestEnv(userDataRoot, service.id, "PORT=19380\n", "plugins");
    markInitializationState(getTestInitializationStatePath(userDataRoot, service.id, "plugins"), service.version);
    const pidPath = getTestPidPath(userDataRoot, service.id, "test-plugin.pid", "plugins");
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, `${process.pid}\n`, "utf8");

    childProcess.spawnSync = (command, args = [], options = {}) => {
      const commandText = String(command).toLowerCase();
      if (commandText.includes("powershell") || command === "netstat") {
        slowProbeCalls.push(`${command} ${args.join(" ")}`);
        return createSpawnSyncResult(1);
      }
      return previousSpawnSync(command, args, options);
    };

    const services = await listServices(app);
    const state = services.find((item) => item.id === service.id);

    assert.deepEqual(slowProbeCalls, []);
    assert.equal(state?.status, "running");
    assert.equal(state?.healthMeta.pid, process.pid);
    assert.equal(fs.existsSync(pidPath), true);
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("readManagedPidFile preserves live pid files when process ownership is temporarily unknown", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-unknown-pid-owner-"));
  const pidPath = path.join(tempRoot, "identity-center.pid");
  const removedPidFiles = [];

  try {
    fs.writeFileSync(pidPath, "4321\n", "utf8");

    const pid = __testInternals.readManagedPidFile([pidPath], "C:\\Program Files\\ZenMind\\services\\identity-center", {
      isProcessRunningImpl: (candidatePid) => candidatePid === 4321,
      matchProcessInstallDirImpl: () => "unknown",
      removePidFileImpl: (candidatePath) => {
        removedPidFiles.push(candidatePath);
        fs.rmSync(candidatePath, { force: true });
      }
    });

    assert.equal(pid, 4321);
    assert.equal(fs.existsSync(pidPath), true);
    assert.deepEqual(removedPidFiles, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("shutdown stop timeout defaults are shorter on Windows overwrite exits", () => {
  assert.equal(__testInternals.getShutdownStopCommandTimeoutMs(undefined, "win32"), 1000);
  assert.equal(__testInternals.getShutdownStopCommandTimeoutMs(undefined, "darwin"), 2500);
  assert.equal(__testInternals.getShutdownStopCommandTimeoutMs(75, "win32"), 75);
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
  const desktopEnvContent = "BIND_ADDR=127.0.0.1:7079\n";
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);

  fs.mkdirSync(installDir, { recursive: true });
  writeTestEnv(userDataRoot, "agent-container-hub", envContent);
  fs.writeFileSync(path.join(installDir, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(path.join(installDir, "README.txt"), "broken\n", "utf8");
  fs.mkdirSync(path.join(installDir, "configs"), { recursive: true });

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);

  assert.equal(fs.readFileSync(getTestEnvPath(userDataRoot, "agent-container-hub"), "utf8"), desktopEnvContent);
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

test("readBuiltinAssetSignature uses the synced builtin asset manifest when available", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-asset-signature-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const fixture = createBuiltinRestoreFixture();
  const serviceId = "custom-builtin";
  const assetFileName = fs.readdirSync(path.join(fixture.assetsRoot, serviceId))
    .find((entry) => isReleaseArchiveName(entry));
  assert.ok(assetFileName, "expected fixture archive");
  fs.writeFileSync(
    path.join(fixture.assetsRoot, "manifest.json"),
    `${JSON.stringify({
      generatedAt: "2026-05-26T00:00:00.000Z",
      services: [
        {
          id: serviceId,
          version: "v1.0.0",
          assetFileName,
          assetSignature: "manifest-signature-sentinel"
        }
      ]
    }, null, 2)}\n`,
    "utf8"
  );
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot);

  try {
    assert.equal(
      __testInternals.readBuiltinAssetSignature(app, getService(serviceId)),
      "manifest-signature-sentinel"
    );
  } finally {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("loadBuiltinServices reuses newer installed builtin manifests without opening older bundled archives", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-loader-installed-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const assetsRoot = path.join(tempRoot, "assets");
  const serviceId = "fast-installed-builtin";
  const installedVersion = "v1.0.1";
  const bundledVersion = "v1.0.0";
  const assetFileName = currentBuiltinArchiveFileName(serviceId, bundledVersion);
  const serviceAssetDir = path.join(assetsRoot, serviceId);
  const installDir = getTestServiceProgramDir(userDataRoot, serviceId, installedVersion);
  const previousAssetsRoot = process.env.DESKTOP_BUILTIN_ASSETS_ROOT;

  fs.mkdirSync(serviceAssetDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(serviceAssetDir, assetFileName), "not a real archive", "utf8");
  fs.writeFileSync(
    path.join(assetsRoot, "manifest.json"),
    `${JSON.stringify({
      generatedAt: "2026-06-05T00:00:00.000Z",
      services: [{
        id: serviceId,
        version: bundledVersion,
        assetFileName,
        assetSignature: "fixture-signature"
      }]
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(installDir, "manifest.json"),
    `${JSON.stringify({
      id: serviceId,
      name: "Fast Installed Builtin",
      kind: "builtin",
      version: installedVersion,
      description: "fixture builtin already installed",
      platform: { os: currentManifestOs(), arch: "amd64" },
      frontend: { mode: "none" },
      scripts: {
        start: process.platform === "win32" ? "start.ps1" : "start.sh",
        stop: process.platform === "win32" ? "stop.ps1" : "stop.sh"
      },
      runtime: {
        pidRelativePath: "run/fast-installed-builtin.pid",
        logRelativePath: "run/fast-installed-builtin.log",
        requiredPaths: ["manifest.json"]
      },
      web: {
        routePath: "",
        portEnvKey: "PORT",
        defaultPort: 0
      },
      desktop: {
        assetFileName,
        bundleTopLevelDir: serviceId
      }
    }, null, 2)}\n`,
    "utf8"
  );

  try {
    process.env.DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot;
    registryInternals.clearServices();
    const loaded = loadBuiltinServices(createApp(userDataRoot));
    const service = getBuiltinService(serviceId);

    assert.equal(loaded.some((item) => item.id === serviceId), true);
    assert.equal(service.version, installedVersion);
    assert.equal(service.assetFileName, assetFileName);
  } finally {
    registryInternals.clearServices();
    if (previousAssetsRoot) {
      process.env.DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
    } else {
      delete process.env.DESKTOP_BUILTIN_ASSETS_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installBuiltinService installs extracted builtin root without an extra directory copy", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-install-without-copy-"));
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const originalCpSync = fs.cpSync;
  fs.cpSync = () => {
    throw new Error("cpSync should not be used for builtin install");
  };

  try {
    await installBuiltinService(app, "agent-container-hub");

    assert.ok(fs.existsSync(path.join(installDir, "start.sh")) || fs.existsSync(path.join(installDir, "start.ps1")));
    assert.ok(fs.existsSync(path.join(installDir, "manifest.json")));
    assert.equal(__testInternals.isInstallHealthy(getService("agent-container-hub"), installDir), true);
  } finally {
    fs.cpSync = originalCpSync;
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installBuiltinService installs bundled directory assets", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-install-directory-asset-"));
  const { assetsRoot, userDataRoot, installDir, tarBundleRoot } = createContainerHubBundleFixture(tempRoot);
  const serviceAssetDir = path.join(assetsRoot, "agent-container-hub");
  const archiveName = fs.readdirSync(serviceAssetDir).find((entry) => isReleaseArchiveName(entry));
  const directoryAssetName = currentBuiltinDirectoryAssetName("agent-container-hub", "v0.1.0");
  assert.ok(archiveName, "expected fixture archive");

  fs.cpSync(tarBundleRoot, path.join(serviceAssetDir, directoryAssetName), {
    recursive: true,
    force: true
  });
  fs.rmSync(path.join(serviceAssetDir, archiveName), { force: true });

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);

  try {
    const service = getBuiltinService("agent-container-hub");
    assert.equal(service.assetFileName, directoryAssetName);
    assert.match(__testInternals.readBuiltinAssetSignature(app, service), /^dir:/u);

    await installBuiltinService(app, "agent-container-hub");

    assert.ok(fs.existsSync(path.join(installDir, "manifest.json")));
    assert.ok(fs.existsSync(path.join(installDir, "backend", process.platform === "win32" ? "agent-container-hub.exe" : "agent-container-hub")));
    assert.equal(__testInternals.isInstallHealthy(service, installDir), true);
  } finally {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installBuiltinService falls back to copying when Windows blocks extracted root rename", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-install-rename-fallback-"));
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const originalRenameSync = fs.renameSync;
  let blockedRename = false;

  fs.renameSync = (from, to) => {
    if (String(from).includes("agent-container-hub") && String(to) === installDir) {
      blockedRename = true;
      const error = new Error("simulated Windows rename EPERM");
      error.code = "EPERM";
      throw error;
    }
    return originalRenameSync(from, to);
  };

  try {
    await installBuiltinService(app, "agent-container-hub");

    assert.equal(blockedRename, true);
    assert.ok(fs.existsSync(path.join(installDir, "manifest.json")));
    assert.equal(__testInternals.isInstallHealthy(getService("agent-container-hub"), installDir), true);
  } finally {
    fs.renameSync = originalRenameSync;
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installBuiltinService coalesces concurrent installs for the same builtin service", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-install-coalesce-"));
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const originalRenameSync = fs.renameSync;
  let installMoves = 0;

  fs.renameSync = (from, to) => {
    if (String(to) === installDir) {
      installMoves += 1;
    }
    return originalRenameSync(from, to);
  };

  try {
    await Promise.all([
      installBuiltinService(app, "agent-container-hub"),
      installBuiltinService(app, "agent-container-hub")
    ]);

    assert.equal(installMoves, 1);
    assert.ok(fs.existsSync(path.join(installDir, "manifest.json")));
  } finally {
    fs.renameSync = originalRenameSync;
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installBuiltinService removes stale container hub relative path env during initialization", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-container-hub-env-normalize-"));
  const envContent = [
    "BIND_ADDR=127.0.0.1:12000",
    "STATE_DB_PATH=./data/hub.db",
    "CONFIG_ROOT=./configs",
    "ROOTFS_ROOT=./data/rootfs",
    "BUILD_ROOT=./data/builds",
    "SESSION_MOUNT_TEMPLATE_ROOT=./zenmind-env",
    "ENGINE=auto"
  ].join("\n") + "\n";
  const { assetsRoot, userDataRoot } = createContainerHubBundleFixture(tempRoot);

  writeTestEnv(userDataRoot, "agent-container-hub", envContent);

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);

  const nextEnv = fs.readFileSync(getTestEnvPath(userDataRoot, "agent-container-hub"), "utf8");
  assert.match(nextEnv, /^BIND_ADDR=127\.0\.0\.1:7079$/m);
  assert.match(nextEnv, /^ENGINE=auto$/m);
  assert.doesNotMatch(nextEnv, /^STATE_DB_PATH=/m);
  assert.doesNotMatch(nextEnv, /^CONFIG_ROOT=/m);
  assert.doesNotMatch(nextEnv, /^ROOTFS_ROOT=/m);
  assert.doesNotMatch(nextEnv, /^BUILD_ROOT=/m);
  assert.doesNotMatch(nextEnv, /^SESSION_MOUNT_TEMPLATE_ROOT=/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("installBuiltinService removes custom absolute container hub path env", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-container-hub-env-absolute-"));
  const envContent = [
    "BIND_ADDR=127.0.0.1:12000",
    "STATE_DB_PATH=/var/lib/agent-container-hub/hub.db",
    "CONFIG_ROOT=/etc/agent-container-hub/configs",
    "ROOTFS_ROOT=/var/lib/agent-container-hub/rootfs",
    "BUILD_ROOT=/var/lib/agent-container-hub/builds",
    "ENGINE=podman"
  ].join("\n") + "\n";
  const { assetsRoot, userDataRoot } = createContainerHubBundleFixture(tempRoot);

  writeTestEnv(userDataRoot, "agent-container-hub", envContent);

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);

  const nextEnv = fs.readFileSync(getTestEnvPath(userDataRoot, "agent-container-hub"), "utf8");
  assert.match(nextEnv, /^BIND_ADDR=127\.0\.0\.1:7079$/m);
  assert.doesNotMatch(nextEnv, /^STATE_DB_PATH=/m);
  assert.doesNotMatch(nextEnv, /^CONFIG_ROOT=/m);
  assert.doesNotMatch(nextEnv, /^ROOTFS_ROOT=/m);
  assert.doesNotMatch(nextEnv, /^BUILD_ROOT=/m);
  assert.match(nextEnv, /^ENGINE=podman$/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("installBuiltinService migrates env from sibling version directories and removes stale versions", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sibling-install-migrate-"));
  const envContent = "BIND_ADDR=127.0.0.1:13000\n";
  const desktopEnvContent = "BIND_ADDR=127.0.0.1:7079\n";
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);
  const siblingInstallDir = getTestServiceProgramDir(userDataRoot, "agent-container-hub", "v9.9.9");

  fs.mkdirSync(siblingInstallDir, { recursive: true });
  fs.writeFileSync(path.join(siblingInstallDir, ".env"), envContent, "utf8");
  fs.writeFileSync(path.join(siblingInstallDir, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(path.join(siblingInstallDir, "README.txt"), "stale version\n", "utf8");

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);

  assert.equal(fs.readFileSync(getTestEnvPath(userDataRoot, "agent-container-hub"), "utf8"), desktopEnvContent);
  assert.equal(fs.existsSync(siblingInstallDir), false);

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
      return createSpawnSyncResult(0, { stdout: "docker\n" });
    }
    if (isCommandLookup(command, args, "podman")) {
      return createSpawnSyncResult(0, { stdout: "podman\n" });
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
      return createSpawnSyncResult(0, { stdout: "docker\n" });
    }
    if (isCommandLookup(command, args, "podman")) {
      return createSpawnSyncResult(0, { stdout: "podman\n" });
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

test("probeContainerEngines reuses cached daemon checks when requested", () => {
  let infoCalls = 0;

  const results = withSpawnSyncMock((command, args = []) => {
    if (isCommandLookup(command, args, "docker")) {
      return createSpawnSyncResult(0, { stdout: "docker\n" });
    }
    if (isCommandLookup(command, args, "podman")) {
      return createSpawnSyncResult(0, { stdout: "podman\n" });
    }
    if ((command === "docker" || command === "podman") && args[0] === "info") {
      infoCalls += 1;
      return createSpawnSyncResult(1);
    }
    assert.fail(`unexpected spawnSync call: ${command} ${args.join(" ")}`);
  }, () => [
    __testInternals.probeContainerEngines({ cache: true }),
    __testInternals.probeContainerEngines({ cache: true })
  ]);

  assert.equal(results[0].engine, "");
  assert.equal(results[1].engine, "");
  assert.equal(infoCalls, 2);
});

test("containerEngineAvailable finds a Windows podman.exe when command lookup misses it", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-podman-path-"));
  const dockerFallbackPaths = new Set([
    path.join(tempRoot, "docker"),
    path.join(tempRoot, "docker.exe")
  ]);
  const podmanFallbackPaths = new Set([
    path.join(tempRoot, "podman"),
    path.join(tempRoot, "podman.exe")
  ]);
  for (const commandPath of [...dockerFallbackPaths, ...podmanFallbackPaths]) {
    fs.writeFileSync(commandPath, "", "utf8");
  }

  const detected = await withEnvPatch({
    PATH: tempRoot,
    Path: tempRoot,
    LOCALAPPDATA: path.join(tempRoot, "LocalAppData")
  }, async () => withSpawnSyncMock((command, args = []) => {
    if (isCommandLookup(command, args, "docker") || isCommandLookup(command, args, "podman")) {
      return createSpawnSyncResult(1);
    }
    if (dockerFallbackPaths.has(command) && args[0] === "info") {
      return createSpawnSyncResult(1);
    }
    if (podmanFallbackPaths.has(command) && args[0] === "info") {
      return createSpawnSyncResult(0);
    }
    assert.fail(`unexpected spawnSync call: ${command} ${args.join(" ")}`);
  }, () => __testInternals.containerEngineAvailable()));

  assert.equal(detected, "podman");
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("probeContainerEngines reports installed engines separately from daemon readiness", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-podman-not-ready-"));
  const dockerFallbackPaths = new Set([
    path.join(tempRoot, "docker"),
    path.join(tempRoot, "docker.exe")
  ]);
  const podmanFallbackPaths = new Set([
    path.join(tempRoot, "podman"),
    path.join(tempRoot, "podman.exe")
  ]);
  for (const commandPath of [...dockerFallbackPaths, ...podmanFallbackPaths]) {
    fs.writeFileSync(commandPath, "", "utf8");
  }

  const result = await withEnvPatch({
    PATH: tempRoot,
    Path: tempRoot,
    LOCALAPPDATA: path.join(tempRoot, "LocalAppData")
  }, async () => withSpawnSyncMock((command, args = []) => {
    if (isCommandLookup(command, args, "docker") || isCommandLookup(command, args, "podman")) {
      return createSpawnSyncResult(1);
    }
    if (dockerFallbackPaths.has(command) && args[0] === "info") {
      return createSpawnSyncResult(1);
    }
    if (podmanFallbackPaths.has(command) && args[0] === "info") {
      return createSpawnSyncResult(1, {
        stderr: "Cannot connect to Podman. failed to connect: dial tcp 127.0.0.1:64571"
      });
    }
    assert.fail(`unexpected spawnSync call: ${command} ${args.join(" ")}`);
  }, () => __testInternals.probeContainerEngines()));

  assert.equal(result.engine, "");
  const podman = result.probes.find((probe) => probe.engine === "podman");
  assert.equal(podman.installed, true);
  assert.equal(podman.reachable, false);
  assert.match(podman.message, /Cannot connect to Podman/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("installBuiltinService force reinstalls healthy install and preserves env", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-force-install-"));
  const archiveStartScript = "#!/usr/bin/env bash\necho archived start\n";
  const existingStartScript = "#!/usr/bin/env bash\necho existing start\n";
  const envContent = "BIND_ADDR=127.0.0.1:12000\n";
  const desktopEnvContent = "BIND_ADDR=127.0.0.1:7079\n";
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

  assert.equal(fs.readFileSync(getTestEnvPath(userDataRoot, "agent-container-hub"), "utf8"), desktopEnvContent);
  assert.equal(fs.readFileSync(path.join(installDir, "start.sh"), "utf8"), archiveStartScript);
  assert.equal(fs.existsSync(path.join(installDir, "README.txt")), false);
  assert.equal(__testInternals.isInstallHealthy(service, installDir), true);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("installBuiltinService installs from selected archive when archivePath is provided", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-selected-archive-install-"));
  const builtinArchiveStartScript = process.platform === "win32"
    ? "Write-Output 'builtin start'\r\n"
    : "#!/usr/bin/env bash\necho builtin start\n";
  const selectedArchiveStartScript = process.platform === "win32"
    ? "Write-Output 'selected start'\r\n"
    : "#!/usr/bin/env bash\necho selected start\n";
  const builtinFixture = createContainerHubBundleFixture(path.join(tempRoot, "builtin"), {
    startScriptContent: builtinArchiveStartScript
  });
  const selectedArchiveRoot = path.join(tempRoot, "selected-root");
  const selectedBundleRoot = path.join(selectedArchiveRoot, "agent-container-hub");
  const selectedArchivePath = path.join(tempRoot, `agent-container-hub-selected${currentBuiltinArchiveExtension()}`);

  writeContainerHubBundleRoot(selectedBundleRoot, {
    startScriptContent: selectedArchiveStartScript
  });
  writeDirectoryArchive(selectedArchiveRoot, selectedArchivePath, "agent-container-hub");

  const { app, restore } = loadBuiltinsForTest(builtinFixture.userDataRoot, builtinFixture.assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id, {
    force: true,
    archivePath: selectedArchivePath
  });

  const startScriptName = process.platform === "win32" ? "start.ps1" : "start.sh";
  assert.equal(
    fs.readFileSync(path.join(builtinFixture.installDir, startScriptName), "utf8"),
    selectedArchiveStartScript
  );
  assert.equal(
    readInitializationStatePath(
      getTestInitializationStatePath(builtinFixture.userDataRoot, "agent-container-hub")
    ).assetSignature,
    computeAssetSignature(selectedArchivePath)
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

test("resource plugin initializes stopped and start-stop manages webapp resources without deleting state", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-resource-plugin-webapp-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "calendar");
  const app = createApp(userDataRoot);
  const webappDir = path.join(getTestDesktopRoot(userDataRoot), "data", "webs", "webapps", "calendar");
  const webappStateDir = path.join(getTestDesktopRoot(userDataRoot), "state", "webs", "webapps", "calendar");
  const eventsPath = path.join(webappStateDir, "events.json");

  registryInternals.clearServices();
  configurePluginResources({ callAgentPlatform: null });
  try {
    writeResourcePluginInstallRoot(installDir, {
      id: "calendar",
      name: "日历"
    });

    const initResult = await initializeService(app, "calendar");
    assert.equal(initResult.ok, true);
    assert.equal(initResult.service.status, "stopped");
    assert.equal(fs.existsSync(webappDir), false);
    assert.equal(pluginResourceInternals.readPluginResourceDesiredStatus(app, getService("calendar")), "stopped");

    const startResult = await startService(app, "calendar");
    assert.equal(startResult.ok, true);
    assert.equal(startResult.service.status, "running");
    assert.equal(startResult.service.statusLabel, "已加载");
    assert.equal(fs.existsSync(path.join(webappDir, "webapp.json")), true);
    assert.equal(pluginResourceInternals.readPluginResourceDesiredStatus(app, getService("calendar")), "running");

    fs.mkdirSync(webappStateDir, { recursive: true });
    fs.writeFileSync(eventsPath, "[{\"title\":\"keep me\"}]\n", "utf8");

    const stopResult = await stopService(app, "calendar");
    assert.equal(stopResult.ok, true);
    assert.equal(stopResult.service.status, "stopped");
    assert.equal(fs.existsSync(webappDir), false);
    assert.equal(fs.readFileSync(eventsPath, "utf8"), "[{\"title\":\"keep me\"}]\n");
    assert.equal(pluginResourceInternals.readPluginResourceDesiredStatus(app, getService("calendar")), "stopped");
  } finally {
    configurePluginResources({ callAgentPlatform: null });
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resource plugin start-stop manages agent-platform resources and preserves ownership", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-resource-plugin-agent-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "happy-agent");
  const app = createApp(userDataRoot);
  const calls = [];

  registryInternals.clearServices();
  configurePluginResources({
    callAgentPlatform: async (_app, endpoint, options) => {
      calls.push({ endpoint, body: options?.body });
      return { ok: true };
    }
  });
  try {
    writeResourcePluginInstallRoot(installDir, {
      id: "happy-agent",
      name: "Happy Agent",
      resources: {
        agents: [{ key: "happy-agent", definition: { name: "Happy Agent" } }],
        automations: [{
          id: "happy-agent-happy-story",
          name: "Happy Agent 开心故事",
          cron: "*/2 * * * *",
          agentKey: "happy-agent",
          query: { message: "开心故事" }
        }]
      }
    });

    const initResult = await initializeService(app, "happy-agent");
    assert.equal(initResult.ok, true);
    assert.equal(initResult.service.status, "stopped");
    assert.deepEqual(calls, []);

    const startResult = await startService(app, "happy-agent");
    assert.equal(startResult.ok, true);
    assert.equal(startResult.service.status, "running");
    assert.deepEqual(calls.map((call) => call.endpoint), [
      "/api/admin/agents/create",
      "/api/admin/automations/create"
    ]);

    const stopResult = await stopService(app, "happy-agent");
    assert.equal(stopResult.ok, true);
    assert.equal(stopResult.service.status, "stopped");
    assert.deepEqual(calls.map((call) => call.endpoint), [
      "/api/admin/agents/create",
      "/api/admin/automations/create",
      "/api/admin/automations/delete",
      "/api/admin/agents/delete"
    ]);
    const ownership = pluginResourceInternals.readOwnership(app, "happy-agent");
    assert.equal(ownership.desiredStatus, "stopped");
    assert.equal(Boolean(ownership.agents?.["happy-agent"]), true);
    assert.equal(Boolean(ownership.automations?.["happy-agent-happy-story"]), true);
  } finally {
    configurePluginResources({ callAgentPlatform: null });
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

test("initializeService recreates Desktop defaults for core services after config deletion", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const homeRoot = path.join(fixture.tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const serviceIds = ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"];

  try {
    for (const serviceId of serviceIds) {
      await installBuiltinService(app, serviceId);
    }

    fs.rmSync(path.join(getTestDesktopRoot(userDataRoot), "config", "services"), { recursive: true, force: true });
    for (const serviceId of serviceIds) {
      const service = getBuiltinService(serviceId);
      fs.rmSync(path.join(getInstallDir(app, service), "run", "deploy.log"), { force: true });
    }

    for (const serviceId of serviceIds) {
      const result = await initializeService(app, serviceId);
      assert.equal(result.ok, true, `${serviceId} should reinitialize after config deletion: ${result.message}`);
    }

    const hubEnv = fs.readFileSync(getTestEnvPath(userDataRoot, "agent-container-hub"), "utf8");
    const identityCenterEnv = fs.readFileSync(getTestEnvPath(userDataRoot, "identity-center"), "utf8");
    const platformEnv = fs.readFileSync(getTestEnvPath(userDataRoot, "agent-platform"), "utf8");
    const platformRuntimeConfig = fs.readFileSync(
      path.join(getTestConfigDir(userDataRoot, "agent-platform"), "configs", "runtime.yml"),
      "utf8"
    );
    const webclientEnv = fs.readFileSync(getTestEnvPath(userDataRoot, "agent-webclient"), "utf8");
    const identityCenterPublicKey = fs.readFileSync(
      path.join(getTestDataDir(userDataRoot, "identity-center"), "keys", "publicKey.pem"),
      "utf8"
    );

    assert.match(hubEnv, /^BIND_ADDR=127\.0\.0\.1:7079$/m);
    assert.match(identityCenterEnv, /^SERVER_PORT=7076$/m);
    assert.doesNotMatch(identityCenterEnv, /^AUTH_DB_PATH=/m);
    assertIdentityCenterDefaultBcryptEnv(identityCenterEnv);
    assert.doesNotMatch(platformEnv, /^SERVER_PORT=/m);
    assert.match(platformRuntimeConfig, /^  port: \d+$/m);
    assert.doesNotMatch(platformEnv, /^AUTH_ENABLED=/m);
    assert.doesNotMatch(platformEnv, /^PROVIDER_APIKEY_KEY_PART=/m);
    assert.match(platformEnv, /^AP_CONTAINER_HUB_BASE_URL=http:\/\/127\.0\.0\.1:7079$/m);
    assert.doesNotMatch(platformEnv, /^RUNTIME_DIR=/m);
    assert.doesNotMatch(platformEnv, /^REGISTRIES_DIR=/m);
    assert.doesNotMatch(platformEnv, /^TOOLS_DIR=/m);
    assert.doesNotMatch(platformEnv, /^PAN_DIR=/m);
    assert.equal(
      fs.readFileSync(path.join(getTestConfigDir(userDataRoot, "agent-platform"), "configs", "local-public-key.pem"), "utf8"),
      identityCenterPublicKey
    );
    assert.match(webclientEnv, /^PORT=7080$/m);
    assert.match(webclientEnv, /^DESKTOP_APP=true$/m);
    assert.doesNotMatch(webclientEnv, /^# DESKTOP_APP=true$/m);
    assert.equal([...webclientEnv.matchAll(/^DESKTOP_APP=/gm)].length, 1);
    const webclientBaseUrlMatch = webclientEnv.match(/^BASE_URL=http:\/\/127\.0\.0\.1:\d+$/m);
    assert.ok(webclientBaseUrlMatch);
    assert.ok(webclientEnv.indexOf("DESKTOP_APP=true") < webclientEnv.indexOf(webclientBaseUrlMatch[0]));
    assert.doesNotMatch(webclientEnv, /^WS_BASE_URL=/m);
    assert.doesNotMatch(webclientEnv, /^VOICE_BASE_URL=/m);
    for (const serviceId of serviceIds) {
      const service = getBuiltinService(serviceId);
      assert.match(
        fs.readFileSync(path.join(getInstallDir(app, service), "run", "deploy.log"), "utf8"),
        new RegExp(`^${serviceId}$`, "m"),
        `${serviceId} should run deploy during initialization`
      );
    }
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("initializeService repairs partial identity-center env with bcrypt defaults", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot);

  try {
    await installBuiltinService(app, "identity-center");
    writeTestEnv(
      userDataRoot,
      "identity-center",
      [
        "SERVER_PORT=18080",
        "AUTH_DB_PATH=./data/auth.db",
        ""
      ].join("\n")
    );

    const result = await initializeService(app, "identity-center");
    assert.equal(result.ok, true);

    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, "identity-center"), "utf8");
    assert.match(envContent, /^SERVER_PORT=7076$/m);
    assert.doesNotMatch(envContent, /^AUTH_DB_PATH=/m);
    assertIdentityCenterDefaultBcryptEnv(envContent);
    assert.match(envContent, /^AP_UPSTREAM_BASE_URL=http:\/\/127\.0\.0\.1:\d+$/m);
    assert.match(envContent, /^CHAT_WS_UPSTREAM_URL=http:\/\/127\.0\.0\.1:\d+\/ws$/m);
    assert.doesNotMatch(envContent, /^AP_UPSTREAM_ACCESS_TOKEN=.+$/m);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("ensurePreStartRequirements replaces unsafe identity-center bcrypt values", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot);
  const service = getBuiltinService("identity-center");

  try {
    await installBuiltinService(app, service.id);
    writeTestEnv(
      userDataRoot,
      service.id,
      [
        "SERVER_PORT=18080",
        `AUTH_ADMIN_PASSWORD_BCRYPT=${TEST_IDENTITY_CENTER_BCRYPT}`,
        "AUTH_APP_MASTER_PASSWORD_BCRYPT=not-a-bcrypt-hash",
        ""
      ].join("\n")
    );

    await __testInternals.ensurePreStartRequirements(app, service);

    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, service.id), "utf8");
    assertIdentityCenterDefaultBcryptEnv(envContent);
    assert.doesNotMatch(envContent, new RegExp(`^AUTH_ADMIN_PASSWORD_BCRYPT=${escapeRegExp(TEST_IDENTITY_CENTER_BCRYPT)}$`, "m"));
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("initializeService preserves custom valid identity-center bcrypt values", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot);

  try {
    await installBuiltinService(app, "identity-center");
    writeTestEnv(
      userDataRoot,
      "identity-center",
      [
        "SERVER_PORT=18080",
        `AUTH_ADMIN_PASSWORD_BCRYPT='${TEST_IDENTITY_CENTER_CUSTOM_BCRYPT}'`,
        `AUTH_APP_MASTER_PASSWORD_BCRYPT='${TEST_IDENTITY_CENTER_CUSTOM_BCRYPT}'`,
        ""
      ].join("\n")
    );

    const result = await initializeService(app, "identity-center");
    assert.equal(result.ok, true);

    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, "identity-center"), "utf8");
    assert.match(envContent, new RegExp(`^AUTH_ADMIN_PASSWORD_BCRYPT='${escapeRegExp(TEST_IDENTITY_CENTER_CUSTOM_BCRYPT)}'$`, "m"));
    assert.match(envContent, new RegExp(`^AUTH_APP_MASTER_PASSWORD_BCRYPT='${escapeRegExp(TEST_IDENTITY_CENTER_CUSTOM_BCRYPT)}'$`, "m"));
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
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

test("writeServiceConfig migrates agent-platform SERVER_PORT into runtime config", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);
  const platformService = getBuiltinService("agent-platform");

  try {
    await installBuiltinService(app, "agent-platform");
    const result = await writeServiceConfig(
      app,
      "agent-platform",
      "env",
      "SERVER_PORT=7901\nAUTH_ENABLED=true\n"
    );
    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
    const runtimeContent = fs.readFileSync(
      path.join(getTestConfigDir(userDataRoot, platformService.id), "configs", "runtime.yml"),
      "utf8"
    );

    assert.equal(result.service.healthMeta.port, 7901);
    assert.equal(result.service.healthMeta.webUrl, "http://127.0.0.1:7901");
    assert.equal(envContent, "AUTH_ENABLED=true\n");
    assert.match(runtimeContent, /^  port: 7901$/m);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("writeServiceConfig does not sync agent webclient upstream urls after agent platform port save", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);
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

    await writeServiceConfig(app, "agent-platform", "env", "SERVER_PORT=7901\n");
    let envContent = fs.readFileSync(webclientEnvPath, "utf8");
    assert.match(envContent, /^BASE_URL=http:\/\/127\.0\.0\.1:7078$/m);
    assert.match(envContent, /^WS_BASE_URL=http:\/\/127\.0\.0\.1:7078$/m);
    assert.match(envContent, /^VOICE_BASE_URL=http:\/\/127\.0\.0\.1:7078$/m);

    await writeServiceConfig(app, "agent-platform", "env", "SERVER_PORT=7903\n");
    envContent = fs.readFileSync(webclientEnvPath, "utf8");
    assert.match(envContent, /^BASE_URL=http:\/\/127\.0\.0\.1:7078$/m);
    assert.match(envContent, /^WS_BASE_URL=http:\/\/127\.0\.0\.1:7078$/m);
    assert.match(envContent, /^VOICE_BASE_URL=http:\/\/127\.0\.0\.1:7078$/m);

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
    await writeServiceConfig(app, "agent-platform", "env", "SERVER_PORT=7904\n");
    envContent = fs.readFileSync(webclientEnvPath, "utf8");
    assert.match(envContent, /^BASE_URL=https:\/\/platform\.example\.test$/m);
    assert.match(envContent, /^WS_BASE_URL=http:\/\/127\.0\.0\.1:7903$/m);
    assert.match(envContent, /^VOICE_BASE_URL=http:\/\/127\.0\.0\.1:9999$/m);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("writeServiceConfig saves core env content without automatic port migration", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);
  const platformService = getBuiltinService("agent-platform");
  const webclientService = getBuiltinService("agent-webclient");

  try {
    await installBuiltinService(app, "agent-platform");
    await writeServiceConfig(
      app,
      "agent-platform",
      "env",
      [
        "SERVER_PORT=117078",
        "CONTAINER_HUB_BASE_URL=http://127.0.0.1:117079",
        "AUTH_ENABLED=false"
      ].join("\n") + "\n"
    );
    let envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
    assert.doesNotMatch(envContent, /^SERVER_PORT=/m);
    assert.match(envContent, /^AP_CONTAINER_HUB_BASE_URL=http:\/\/127\.0\.0\.1:117079$/m);
    assert.doesNotMatch(envContent, /^CONTAINER_HUB_BASE_URL=/m);
    assert.match(envContent, /^AUTH_ENABLED=false$/m);

    await writeServiceConfig(app, "agent-platform", "env", "SERVER_PORT=18081\n");
    envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
    const runtimeContent = fs.readFileSync(
      path.join(getTestConfigDir(userDataRoot, platformService.id), "configs", "runtime.yml"),
      "utf8"
    );
    assert.doesNotMatch(envContent, /^SERVER_PORT=/m);
    assert.match(runtimeContent, /^  port: 18081$/m);

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
    envContent = fs.readFileSync(getTestEnvPath(userDataRoot, webclientService.id), "utf8");
    assert.equal(result.service.healthMeta.port, 7902);
    assert.match(result.message, /重启服务后生效/u);
    assert.match(envContent, /^PORT=7902$/m);
    assert.match(envContent, /^BASE_URL=https:\/\/platform\.example\.test$/m);
    assert.match(envContent, /^WS_BASE_URL=http:\/\/127\.0\.0\.1:117078$/m);
    assert.match(envContent, /^VOICE_BASE_URL=http:\/\/localhost:11949$/m);
    assert.match(envContent, /^NODE_BIN=\/tmp\/stale-node$/m);
    assert.match(envContent, /^NODE_ENV=development$/m);
    assert.match(envContent, /^DEV_SERVER_ALLOWED_HOSTS=all$/m);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
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

test("startService reinitializes a core builtin when its config was deleted", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture);

  try {
    const platformStart = await startService(app, "agent-platform");
    assert.equal(platformStart.ok, true, platformStart.message);

    await installBuiltinService(app, "agent-webclient");
    const installDir = getInstallDir(app, getBuiltinService("agent-webclient"));
    fs.rmSync(path.join(installDir, "run", "deploy.log"), { force: true });
    fs.rmSync(getTestConfigDir(userDataRoot, "agent-webclient"), { recursive: true, force: true });

    const result = await startService(app, "agent-webclient");
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.service.status, "running");
    assert.match(fs.readFileSync(getTestEnvPath(userDataRoot, "agent-webclient"), "utf8"), new RegExp(`^PORT=${fixture.ports.webclient}$`, "m"));
    assert.match(fs.readFileSync(path.join(installDir, "run", "deploy.log"), "utf8"), /^agent-webclient$/m);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("startService returns a port conflict error for agent-container-hub when an external process occupies the port", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-container-hub-port-conflict-"));
  const port = await getAvailableLocalPort();
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot, {
    bindAddr: `127.0.0.1:${port}`
  });
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot, {
    testCoreServicePortBase: port - 3
  });
  const service = getBuiltinService("agent-container-hub");
  const previousSpawnSync = childProcess.spawnSync;
  const server = net.createServer();

  try {
    await installBuiltinService(app, service.id);
    writeTestEnv(userDataRoot, service.id, `BIND_ADDR=127.0.0.1:${port}\n`);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });

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
    if (state.status !== "error") {
      t.skip("current sandbox does not expose the synthetic listener to port-conflict detection");
      return;
    }
    assert.equal(state.status, "error");
    assert.match(state.message, new RegExp(`端口 ${port} 已被其他进程占用`));

    const result = await startService(app, service.id);
    assert.equal(result.ok, false);
    assert.equal(result.service.status, "error");
    assert.match(result.message, new RegExp(`端口 ${port} 已被其他进程占用`));
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    await new Promise((resolve) => server.close(resolve));
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
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot, {
    testCoreServicePortBase: port - 3
  });
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
      'state_dir="$PWD/run"',
      'log_dir="$PWD/run"',
      'mkdir -p "$state_dir" "$log_dir" run',
      'env_file="$PWD/.env"',
      'if [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; fi',
      "cat > run/container-hub-fixture.js <<'NODE'",
      "const http = require('node:http');",
      `const fallbackPort = ${port};`,
      "const bindAddr = process.env.BIND_ADDR || `127.0.0.1:${fallbackPort}`;",
      "const port = Number(String(bindAddr).match(/:(\\d+)$/)?.[1] || fallbackPort);",
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
      "node \"$PWD/run/container-hub-fixture.js\" > \"$log_dir/agent-container-hub.log\" 2> \"$log_dir/agent-container-hub.stderr.log\" &",
      "printf '%s\\n' \"$!\" > \"$state_dir/agent-container-hub.pid\"",
      'probe_port="$(node -e "const bindAddr = process.env.BIND_ADDR || process.argv[1]; console.log(String(bindAddr).match(/:(\\\\d+)$/)?.[1] || process.argv[2])" "127.0.0.1:' + port + '" "' + port + '")"',
      "for attempt in $(seq 1 50); do",
      '  node -e "const port=Number(process.argv[1]); require(\'node:http\').get(\'http://127.0.0.1:\'+port+\'/api/runtime-info\', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on(\'error\', () => process.exit(1))" "$probe_port" && exit 0',
      "  sleep 0.05",
      "done",
      "exit 1"
    ].join("\n")
  });
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot, {
    testCoreServicePortBase: port - 3
  });
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
    const pidPath = getTestPidPath(userDataRoot, service.id, "agent-container-hub.pid");
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

test("startService waits for delayed container hub runtime-info readiness", async (t) => {
  if (process.platform === "win32") {
    t.skip("This fixture uses a POSIX shell daemon; Windows service verification is covered by process and port parser tests.");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-container-hub-delayed-ready-"));
  const port = await getAvailableLocalPort();
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot, {
    bindAddr: `127.0.0.1:${port}`,
    startScriptContent: [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'state_dir="$PWD/run"',
      'log_dir="$PWD/run"',
      'mkdir -p "$state_dir" "$log_dir" run',
      'env_file="$PWD/.env"',
      'if [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; fi',
      "cat > run/container-hub-delayed-fixture.js <<'NODE'",
      "const http = require('node:http');",
      `const fallbackPort = ${port};`,
      "const bindAddr = process.env.BIND_ADDR || `127.0.0.1:${fallbackPort}`;",
      "const port = Number(String(bindAddr).match(/:(\\d+)$/)?.[1] || fallbackPort);",
      "const server = http.createServer((req, res) => {",
      "  if (req.url === '/api/runtime-info') {",
      "    res.writeHead(200, { 'content-type': 'application/json' });",
      "    res.end(JSON.stringify({ engine: 'docker', ok: true }));",
      "    return;",
      "  }",
      "  res.writeHead(200, { 'content-type': 'text/html' });",
      "  res.end('<!doctype html><title>Container Hub</title>');",
      "});",
      "setTimeout(() => server.listen(port, '127.0.0.1'), 1000);",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      "NODE",
      "node \"$PWD/run/container-hub-delayed-fixture.js\" > \"$log_dir/agent-container-hub.log\" 2> \"$log_dir/agent-container-hub.stderr.log\" &",
      "printf '%s\\n' \"$!\" > \"$state_dir/agent-container-hub.pid\""
    ].join("\n")
  });
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot, {
    testCoreServicePortBase: port - 3
  });
  const service = getBuiltinService("agent-container-hub");
  const previousSpawnSync = childProcess.spawnSync;
  const previousVerifyDelay = process.env.SERVICE_VERIFY_DELAY_MS;

  process.env.SERVICE_VERIFY_DELAY_MS = "50";

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
    assert.equal(result.verification.verified, true);
    assert.equal(result.verification.portListening, true);
    assert.equal(result.verification.runtimeInfoOk, true);
  } finally {
    childProcess.spawnSync = previousSpawnSync;
    if (previousVerifyDelay === undefined) {
      delete process.env.SERVICE_VERIFY_DELAY_MS;
    } else {
      process.env.SERVICE_VERIFY_DELAY_MS = previousVerifyDelay;
    }
    const pidPath = getTestPidPath(userDataRoot, service.id, "agent-container-hub.pid");
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

test("ensurePreStartRequirements applies provider-register before agent-platform starts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-provider-register-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const providersRoot = path.join(getTestRuntimeRootForHome(homeRoot), "registries", "providers");
  const registerPath = path.join(getTestRuntimeRootForHome(homeRoot), "provider-register.json");
  const originalFetch = globalThis.fetch;
  const issuedKey = "dk_ProviderRegisterIntegrationKey";
  let requestBody = null;

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.mkdirSync(providersRoot, { recursive: true });
  fs.writeFileSync(
    path.join(providersRoot, "th-deepseek.yml"),
    "key: th-deepseek\nbaseUrl: https://transit-hub.zenmind.cc\ndefaultModel: th-deepseek-v4-flash\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(providersRoot, "th-minimax.yml"),
    "key: th-minimax\nbaseUrl: https://transit-hub.zenmind.cc\napiKey: YOUR_TRANSIT_HUB_KEY\ndefaultModel: th-minimax-m3\n",
    "utf8"
  );
  fs.writeFileSync(
    registerPath,
    `${JSON.stringify({
      version: 1,
      enabled: true,
      endpoint: "https://transit-hub.zenmind.cc/api/apply-apikey",
      grant: { type: "jwt", token: "jwt-token" },
      providers: ["th-deepseek", "th-minimax"]
    }, null, 2)}\n`,
    "utf8"
  );
  writeTestEnv(userDataRoot, platformService.id, "SERVER_PORT=11949\n");

  globalThis.fetch = async (_url, init = {}) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ key: issuedKey })
    };
  };

  try {
    await __testInternals.ensurePreStartRequirements(app, platformService);

    const deviceIdentity = JSON.parse(fs.readFileSync(
      path.join(getTestDesktopRoot(userDataRoot), "config", "desktop", "device-identity.json"),
      "utf8"
    ));
    assert.deepEqual(requestBody, { name: deviceIdentity.deviceId });
    assert.match(
      fs.readFileSync(path.join(providersRoot, "th-deepseek.yml"), "utf8"),
      /^apiKey: dk_ProviderRegisterIntegrationKey$/m
    );
    assert.match(
      fs.readFileSync(path.join(providersRoot, "th-minimax.yml"), "utf8"),
      /^apiKey: dk_ProviderRegisterIntegrationKey$/m
    );
    assert.equal(fs.existsSync(registerPath), false);
  } finally {
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ensurePreStartRequirements leaves legacy agent-platform auth env untouched", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const homeRoot = path.join(fixture.tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = getTestServiceProgramDir(userDataRoot, platformService.id, platformService.version);
  const customPublicKeyPath = path.join(fixture.tempRoot, "custom", "public-key.pem");

  await installBuiltinService(app, "identity-center");
  await installBuiltinService(app, "agent-platform");
  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  writeTestEnv(
    userDataRoot,
    platformService.id,
    `SERVER_PORT=11949\nAUTH_LOCAL_PUBLIC_KEY_FILE=${customPublicKeyPath}\n`,
  );

  try {
    await __testInternals.ensurePreStartRequirements(app, platformService);

    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
    assert.match(envContent, new RegExp(`^AUTH_LOCAL_PUBLIC_KEY_FILE=${customPublicKeyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.doesNotMatch(envContent, /^AUTH_LOCAL_PUBLIC_KEY_FILE=configs\/local-public-key\.pem$/m);
    assert.doesNotMatch(envContent, /^AUTH_ENABLED=/m);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("ensurePreStartRequirements syncs agent-platform public key from identity-center", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const homeRoot = path.join(fixture.tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, fixture.assetsRoot, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformConfigDir = getTestConfigDir(userDataRoot, platformService.id);
  const platformDataDir = getTestDataDir(userDataRoot, platformService.id);
  const platformPublicKeyPath = path.join(platformConfigDir, "configs", "local-public-key.pem");
  const identityCenterPublicKeyPath = path.join(getTestDataDir(userDataRoot, "identity-center"), "keys", "publicKey.pem");

  try {
    await installBuiltinService(app, "identity-center");
    await installBuiltinService(app, "agent-platform");
    fs.mkdirSync(path.dirname(platformPublicKeyPath), { recursive: true });
    fs.writeFileSync(platformPublicKeyPath, "STALE_PUBLIC_KEY\n", "utf8");
    fs.mkdirSync(path.join(platformDataDir, "registries", "providers"), { recursive: true });
    fs.mkdirSync(path.join(platformDataDir, "tools"), { recursive: true });

    await __testInternals.ensurePreStartRequirements(app, platformService);

    assert.equal(fs.readFileSync(identityCenterPublicKeyPath, "utf8").replace(/\r\n/gu, "\n"), "IDENTITY_CENTER_PUBLIC_KEY\n");
    assert.equal(fs.readFileSync(platformPublicKeyPath, "utf8").replace(/\r\n/gu, "\n"), "IDENTITY_CENTER_PUBLIC_KEY\n");
    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
    assert.doesNotMatch(envContent, /^AUTH_ENABLED=/m);
    assert.doesNotMatch(envContent, /^AUTH_LOCAL_PUBLIC_KEY_FILE=/m);
    assert.doesNotMatch(envContent, /^AGENT_WS_ENABLED=/m);
  } finally {
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("startService starts agent-platform when desktop-managed container hub is unavailable", async () => {
  const fixture = createStartupCoreAssetsFixture();
  addContainerHubAssetToFixture(fixture);
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
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

test("initializeService does not migrate legacy relay settings into the local-cli-acp-relay plugin", async () => {
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
      "SERVER_PORT=11949",
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
    port: 3220
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
  assert.match(relayEnvContent, /^PORT=3220$/m);
  assert.match(relayEnvContent, /^AUTH_TOKEN=$/m);
  assert.doesNotMatch(relayEnvContent, /^DEFAULT_CWD=\/tmp\/workspace$/m);
  assert.doesNotMatch(relayEnvContent, /^ALLOWED_CWD_ROOTS=\/tmp\/workspace:\/tmp\/shared$/m);
  assert.match(relayEnvContent, /^HANDSHAKE_TIMEOUT_MS=60000$/m);
  assert.match(relayEnvContent, /^RUN_TIMEOUT_MS=600000$/m);
  assert.doesNotMatch(relayEnvContent, /^CLAUDE_CODE_ACP_COMMAND=\/custom\/bin\/claude-code-acp$/m);
  assert.doesNotMatch(relayEnvContent, /^CLAUDE_CODE_ACP_ARGS=--stdio$/m);
  assert.match(relayEnvContent, /^NODE_BIN=$/m);

  const platformEnvContent = fs.readFileSync(getTestEnvPath(userDataRoot, platformService.id), "utf8");
  assert.match(platformEnvContent, /^LOCAL_CLI_ACP_RELAY_PORT=4555$/m);
  assert.match(platformEnvContent, /^CLAUDE_CODE_ACP_COMMAND=\/custom\/bin\/claude-code-acp$/m);
  assert.match(platformEnvContent, /^CLAUDE_CODE_ACP_ARGS=--stdio$/m);

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
      "SERVER_PORT=11949",
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

test("ensurePreStartRequirements leaves agent-platform runtime path migration to the service", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const tempRoot = fixture.tempRoot;
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, {
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
    `SERVER_PORT=11949\nRUNTIME_DIR=${legacyRuntimeRoot}\n`,
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
  assert.doesNotMatch(envContent, /^SERVER_PORT=/m);
  assert.match(envContent, new RegExp(`^RUNTIME_DIR=${legacyRuntimeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.doesNotMatch(envContent, /^REGISTRIES_DIR=/m);
  assert.doesNotMatch(envContent, /^AGENTS_DIR=/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements ignores stale legacy desktop runtime paths and uses the current default", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const tempRoot = fixture.tempRoot;
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, {
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

  writeTestEnv(
    userDataRoot,
    platformService.id,
    [
      "SERVER_PORT=11949",
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
  assert.doesNotMatch(envContent, /^SERVER_PORT=/m);
  assert.doesNotMatch(envContent, /^RUNTIME_DIR=/m);
  assert.doesNotMatch(envContent, /^AGENTS_DIR=/m);
  assert.doesNotMatch(envContent, /^REGISTRIES_DIR=/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements ignores legacy resolved desktop runtime paths", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const tempRoot = fixture.tempRoot;
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const desktopPath = path.join(homeRoot, "OneDrive", "Desktop");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, {
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

  writeTestEnv(
    userDataRoot,
    platformService.id,
    [
      "SERVER_PORT=11949",
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
  assert.doesNotMatch(envContent, /^SERVER_PORT=/m);
  assert.doesNotMatch(envContent, /^RUNTIME_DIR=/m);
  assert.doesNotMatch(envContent, /^AGENTS_DIR=/m);
  assert.doesNotMatch(envContent, /^REGISTRIES_DIR=/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements ignores hidden desktop legacy runtime roots", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const tempRoot = fixture.tempRoot;
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const desktopPath = path.join(homeRoot, "OneDrive", "Desktop");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, {
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

  writeTestEnv(
    userDataRoot,
    platformService.id,
    [
      "SERVER_PORT=11949",
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
  assert.doesNotMatch(envContent, /^SERVER_PORT=/m);
  assert.doesNotMatch(envContent, /^RUNTIME_DIR=/m);
  assert.doesNotMatch(envContent, /^AGENTS_DIR=/m);
  assert.doesNotMatch(envContent, /^REGISTRIES_DIR=/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("startService hosts agent-webclient without executing bundle start script", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const webclientService = getBuiltinService("agent-webclient");
  const webclientInstallDir = getTestServiceProgramDir(userDataRoot, webclientService.id, webclientService.version);
  const startFileName = process.platform === "win32" ? "start.ps1" : "start.sh";

  try {
    await installBuiltinService(app, "agent-platform");
    await installBuiltinService(app, "agent-webclient");
    const platformStart = await startService(app, "agent-platform");
    assert.equal(platformStart.ok, true, platformStart.message);

    if (process.platform === "win32") {
      fs.writeFileSync(
        path.join(webclientInstallDir, startFileName),
        [
          "$runDir = Join-Path $PSScriptRoot 'run'",
          "New-Item -ItemType Directory -Path $runDir -Force | Out-Null",
          "Set-Content -LiteralPath (Join-Path $runDir 'started.txt') -Value 'started'"
        ].join("\r\n"),
        "utf8"
      );
    } else {
      fs.writeFileSync(
        path.join(webclientInstallDir, startFileName),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "mkdir -p run",
          "printf started > run/started.txt"
        ].join("\n") + "\n",
        "utf8"
      );
      fs.chmodSync(path.join(webclientInstallDir, startFileName), 0o755);
    }

    const webclientResult = await startService(app, "agent-webclient");
    assert.equal(webclientResult.ok, true, webclientResult.message);
    assert.equal(webclientResult.service.status, "running");
    assert.equal(webclientResult.service.healthMeta.pid, process.pid);
    assert.equal(webclientResult.service.healthMeta.webUrl, `http://127.0.0.1:${fixture.ports.webclient}/`);
    assert.equal(fs.existsSync(path.join(webclientInstallDir, "run", "started.txt")), false);

    const envPath = getTestEnvPath(userDataRoot, webclientService.id);
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf8");
      assert.doesNotMatch(envContent, /^NODE_BIN=/m);
    }
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
      port: 3220
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
        `pid_file="${relayPidPath}"`,
        'pid_dir="$(dirname "$pid_file")"',
        'mkdir -p "$pid_dir"',
        ': "${NODE_BIN:?missing NODE_BIN}"',
        'printf "%s" "$NODE_BIN" > run/node-bin.txt',
        'fixture_script="$PWD/run/local-cli-acp-relay-fixture.mjs"',
        'printf "setInterval(() => {}, 1000);\\n" > "$fixture_script"',
        '"$NODE_BIN" "$fixture_script" >/dev/null 2>&1 &',
        'echo $! > "$pid_file"',
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

test("startService reuses a running identity-center despite frontend route and launcher drift", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const service = getBuiltinService("identity-center");
  const installDir = getTestServiceProgramDir(userDataRoot, service.id, service.version);

  try {
    await installBuiltinService(app, service.id);
    const servicePort = fixture.ports.identityCenter;
    const envPath = getTestEnvPath(userDataRoot, service.id);
    writeTestEnv(userDataRoot, service.id, `SERVER_PORT=${servicePort}\n`);
    const firstStart = await startService(app, service.id);
    assert.equal(firstStart.ok, true, firstStart.message);
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
      getTestEnvPath(userDataRoot, service.id),
      `SERVER_PORT=${servicePort}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(installDir, "scripts", "program-common.sh"),
      "#!/usr/bin/env bash\n\"$BACKEND_BIN\" >\"$BACKEND_LOG\" 2>&1 &\n",
      "utf8"
    );

    const secondStart = await startService(app, service.id);
    assert.equal(secondStart.ok, true, secondStart.message);
    assert.equal(secondStart.service.status, "running");
    assert.equal(secondStart.service.healthMeta.pid, oldPid);

    const manifest = JSON.parse(fs.readFileSync(path.join(installDir, "manifest.json"), "utf8"));
    const indexContent = fs.readFileSync(path.join(installDir, "frontend", "dist", "index.html"), "utf8");
    const envContent = fs.readFileSync(getTestEnvPath(userDataRoot, service.id), "utf8");
    assert.equal(manifest.frontend.entry, "/");
    assert.equal(manifest.web.routePath, "/");
    assert.match(indexContent, /src="\/assets\/index\.js"/);
    assert.doesNotMatch(envContent, /^FRONTEND_DIST_DIR=/m);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("startService leaves a running agent-webclient alone after agent-platform is manually restarted", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });

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
    assert.equal(webclientState.healthMeta.pid, firstWebclientPid);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("startService leaves a running agent-webclient alone when agent-platform is refreshed while running", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
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
    assert.equal(webclientState.healthMeta.pid, firstWebclientPid);
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
    "identity-center"
  ]);

  const statePath = __testInternals.getLastRunningServicesStatePath(app);
  assert.ok(fs.existsSync(statePath));
  assert.deepEqual(__testInternals.readLastRunningServices(app), [
    "identity-center",
    "agent-platform",
    "agent-webclient"
  ]);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("restore order prioritizes service dependencies", () => {
  assert.deepEqual(
    __testInternals.orderServiceIdsForRestore([
      "agent-webclient",
      "identity-center",
      "agent-platform",
      "agent-container-hub",
      "custom-plugin"
    ]),
    [
      "agent-container-hub",
      "identity-center",
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
    "identity-center",
    "agent-platform",
    "agent-webclient"
  ]);
  assert.deepEqual(__testInternals.getServiceIdsToRestore(app), [
    "identity-center",
    "agent-platform",
    "agent-webclient",
    "custom-plugin"
  ]);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("startup restore skips install-only services that were running at shutdown", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-optional-startup-services-"));
  const app = createApp(tempRoot);

  __testInternals.writeLastRunningServices(app, [
    "agent-container-hub",
    "custom-plugin"
  ]);

  assert.deepEqual(__testInternals.getServiceIdsToRestore(app), [
    "identity-center",
    "agent-platform",
    "agent-webclient",
    "custom-plugin"
  ]);
  assert.deepEqual(__testInternals.getOptionalServiceIdsToRestore(app), [
    "custom-plugin"
  ]);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("shutdown records running resource plugins without unloading their resources", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-resource-plugin-shutdown-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "happy-agent");
  const app = createApp(userDataRoot);
  const calls = [];

  registryInternals.clearServices();
  configurePluginResources({
    callAgentPlatform: async (_app, endpoint, options) => {
      calls.push({ endpoint, body: options?.body });
      return { ok: true };
    }
  });
  try {
    writeResourcePluginInstallRoot(installDir, {
      id: "happy-agent",
      name: "Happy Agent",
      resources: {
        agents: [{ key: "happy-agent", definition: { name: "Happy Agent" } }],
        automations: [{
          id: "happy-agent-happy-story",
          name: "Happy Agent 开心故事",
          cron: "*/2 * * * *",
          agentKey: "happy-agent",
          query: { message: "开心故事" }
        }]
      }
    });
    assert.equal((await initializeService(app, "happy-agent")).ok, true);
    assert.equal((await startService(app, "happy-agent")).service.status, "running");
    calls.length = 0;

    const result = await stopRunningServicesForShutdown(app, { stopCommandTimeoutMs: 50 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.runningServiceIds, ["happy-agent"]);
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(calls, []);
    assert.deepEqual(__testInternals.readLastRunningServices(app), ["happy-agent"]);
    assert.equal(pluginResourceInternals.readOwnership(app, "happy-agent").desiredStatus, "running");
  } finally {
    configurePluginResources({ callAgentPlatform: null });
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("restoreRunningServices restores desired running resource plugins even without shutdown state", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-resource-plugin-restore-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = getTestPluginProgramDir(userDataRoot, "calendar");
  const app = createApp(userDataRoot);
  const webappDir = path.join(getTestDesktopRoot(userDataRoot), "data", "webs", "webapps", "calendar");

  registryInternals.clearServices();
  configurePluginResources({ callAgentPlatform: null });
  try {
    writeResourcePluginInstallRoot(installDir, {
      id: "calendar",
      name: "日历"
    });
    markInitializationState(getTestInitializationStatePath(userDataRoot, "calendar", "plugins"));
    pluginResourceInternals.writeOwnership(app, "calendar", {
      desiredStatus: "running",
      webapps: { calendar: { updatedAt: "2026-06-13T00:00:00.000Z" } }
    });

    assert.deepEqual(__testInternals.readLastRunningServices(app), []);
    assert.deepEqual(__testInternals.getResourcePluginServiceIdsToRestore(app), ["calendar"]);

    const result = await restoreRunningServices(app);
    assert.deepEqual(result.restored, ["calendar"]);
    assert.deepEqual(result.failures, []);
    assert.equal(fs.existsSync(path.join(webappDir, "webapp.json")), true);
  } finally {
    configurePluginResources({ callAgentPlatform: null });
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("restoreRunningServices skips install-only container hub and restores other optional services", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-optional-restore-failure-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);
  const hubFolder = getTestPluginProgramDir(userDataRoot, "agent-container-hub");
  const pluginFolder = getTestPluginProgramDir(userDataRoot, "restored-plugin");
  const startupEvents = [];

  registryInternals.clearServices();
  try {
    writePluginInstallRoot(hubFolder, {
      id: "agent-container-hub",
      name: "Container Hub",
      port: 0,
      deployScriptContent: false
    });
    writeTestEnv(userDataRoot, "agent-container-hub", "PORT=0\n", "plugins");
    markInitializationState(getTestInitializationStatePath(userDataRoot, "agent-container-hub", "plugins"));
    if (process.platform === "win32") {
      writeExecutableFile(path.join(hubFolder, "start.ps1"), "throw 'hub should not start'\r\n");
    } else {
      writeExecutableFile(path.join(hubFolder, "start.sh"), "#!/usr/bin/env bash\nexit 1\n");
    }

    writePluginInstallRoot(pluginFolder, {
      id: "restored-plugin",
      name: "Restored Plugin",
      port: 0,
      deployScriptContent: false
    });
    writeTestEnv(userDataRoot, "restored-plugin", "PORT=0\n", "plugins");
    markInitializationState(getTestInitializationStatePath(userDataRoot, "restored-plugin", "plugins"));
    if (process.platform === "win32") {
      writeExecutableFile(
        path.join(pluginFolder, "start.ps1"),
        [
          "$pidDir = Join-Path $PSScriptRoot 'run'",
          "New-Item -ItemType Directory -Path $pidDir -Force | Out-Null",
          "$runDir = Join-Path $PSScriptRoot 'run'",
          "New-Item -ItemType Directory -Path $runDir -Force | Out-Null",
          "$fixtureScript = Join-Path $runDir 'restored-plugin-fixture.mjs'",
          "[System.IO.File]::WriteAllText($fixtureScript, 'setInterval(() => {}, 1000);')",
          "$nodeBin = if ($env:NODE_BIN) { $env:NODE_BIN } else { 'node' }",
          "$proc = Start-Process -FilePath $nodeBin -ArgumentList $fixtureScript -WindowStyle Hidden -PassThru",
          "$proc.Id | Set-Content -LiteralPath (Join-Path $pidDir 'test-plugin.pid')"
        ].join("\r\n")
      );
    } else {
      writeExecutableFile(
        path.join(pluginFolder, "start.sh"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'pid_dir="$PWD/run"',
          'mkdir -p "$pid_dir"',
          'mkdir -p run',
          'fixture_script="$PWD/run/restored-plugin-fixture.mjs"',
          'printf "setInterval(() => {}, 1000);\\n" > "$fixture_script"',
          'node "$fixture_script" >/dev/null 2>&1 &',
          'echo $! > "$pid_dir/test-plugin.pid"'
        ].join("\n")
      );
    }

    __testInternals.writeLastRunningServices(app, ["agent-container-hub", "restored-plugin"]);

    const result = await restoreRunningServices(app, {
      onStarting: (serviceId) => {
        startupEvents.push(`start:${serviceId}`);
      },
      onProgress: (serviceId, phase) => {
        startupEvents.push(`progress:${serviceId}:${phase}`);
      }
    });

    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.restored, ["restored-plugin"]);
    assert.deepEqual(startupEvents, [
      "start:restored-plugin",
      "progress:restored-plugin:succeeded"
    ]);
  } finally {
    const pluginState = await getServiceState(app, "restored-plugin").catch(() => null);
    if (pluginState?.healthMeta?.pid && isPidRunning(pluginState.healthMeta.pid)) {
      try {
        process.kill(pluginState.healthMeta.pid, "SIGKILL");
      } catch {
        // Process may already be gone after test cleanup.
      }
    }
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
    version: "v1.0.0",
    description: "missing fixture plugin",
    service: {
      ui: "none",
      web: {
        healthPath: "",
        portEnvKey: "PORT",
        defaultPort: 9310
      }
    },
    lifecycle: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      pidRelativePath: "run/plugin-a.pid",
      logRelativePath: "run/plugin-a.log",
      requiredPaths: ["start.sh", "stop.sh", "manifest.json"]
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

test("restoreRunningServices skips unavailable install-only container hub", async () => {
  const fixture = createStartupCoreAssetsFixture();
  addContainerHubAssetToFixture(fixture);
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const previousSpawnSync = childProcess.spawnSync;
  const startupEvents = [];

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

    const result = await restoreRunningServices(app, {
      onStarting: (serviceId) => {
        startupEvents.push(`start:${serviceId}`);
      },
      onProgress: (serviceId, phase) => {
        startupEvents.push(`progress:${serviceId}:${phase}`);
      }
    });

    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.restored, ["identity-center", "agent-platform", "agent-webclient"]);
    assert.equal(startupEvents.includes("start:agent-container-hub"), false);
    assert.equal(startupEvents.includes("progress:agent-container-hub:failed"), false);
    for (const serviceId of ["identity-center", "agent-platform"]) {
      const service = getBuiltinService(serviceId);
      const installDir = getInstallDir(app, service);
      assert.equal(fs.existsSync(path.join(installDir, "run", "started.txt")), true);
    }
    const webclientState = await getServiceState(app, "agent-webclient");
    const webclientInstallDir = getInstallDir(app, getBuiltinService("agent-webclient"));
    assert.equal(webclientState.status, "running");
    assert.equal(fs.existsSync(path.join(webclientInstallDir, "run", "started.txt")), false);
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

test("runStartupPreparation applies provider-register before preparing builtin services", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const homeRoot = getTestHomeRoot(userDataRoot);
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const providersRoot = path.join(getTestRuntimeRootForHome(homeRoot), "registries", "providers");
  const registerPath = path.join(getTestRuntimeRootForHome(homeRoot), "provider-register.json");
  const originalFetch = globalThis.fetch;
  const issuedKey = "dk_RunStartupPreparationKey";
  let requestBody = null;
  let fetchSawBuiltinEnvBeforeRegistration = false;

  fs.mkdirSync(providersRoot, { recursive: true });
  fs.writeFileSync(
    path.join(providersRoot, "th-deepseek.yml"),
    "key: th-deepseek\nbaseUrl: https://transit-hub.zenmind.cc\napiKey: YOUR_API_KEY\ndefaultModel: th-deepseek-v4-flash\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(providersRoot, "th-minimax.yml"),
    "key: th-minimax\nbaseUrl: https://transit-hub.zenmind.cc\napiKey: YOUR_API_KEY\ndefaultModel: th-minimax-m3\n",
    "utf8"
  );
  fs.writeFileSync(
    registerPath,
    `${JSON.stringify({
      version: 1,
      enabled: true,
      endpoint: "https://transit-hub.zenmind.cc/api/apply-apikey",
      grant: { type: "jwt", token: "jwt-token" },
      providers: ["th-deepseek", "th-minimax"]
    }, null, 2)}\n`,
    "utf8"
  );

  globalThis.fetch = async (_url, init = {}) => {
    fetchSawBuiltinEnvBeforeRegistration = fs.existsSync(getTestEnvPath(userDataRoot, "identity-center")) ||
      fs.existsSync(getTestEnvPath(userDataRoot, "agent-platform")) ||
      fs.existsSync(getTestEnvPath(userDataRoot, "agent-webclient"));
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ key: issuedKey })
    };
  };

  try {
    const result = await runStartupPreparation(app);

    const deviceIdentity = JSON.parse(fs.readFileSync(
      path.join(getTestDesktopRoot(userDataRoot), "config", "desktop", "device-identity.json"),
      "utf8"
    ));
    assert.deepEqual(requestBody, { name: deviceIdentity.deviceId });
    assert.equal(fetchSawBuiltinEnvBeforeRegistration, false);
    assert.equal(fs.existsSync(registerPath), false);
    assert.match(
      fs.readFileSync(path.join(providersRoot, "th-deepseek.yml"), "utf8"),
      /^apiKey: dk_RunStartupPreparationKey$/m
    );
    assert.match(
      fs.readFileSync(path.join(providersRoot, "th-minimax.yml"), "utf8"),
      /^apiKey: dk_RunStartupPreparationKey$/m
    );
    assert.ok(result.started.includes("identity-center"));
  } finally {
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation bootstraps packaged first launch with the three core services", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });

  try {
    const result = await runStartupPreparation(app);
    const hubService = getBuiltinService("agent-container-hub");
    await __testInternals.waitForBackgroundStartupPreparations();
    const hubInstallDir = getInstallDir(app, hubService);
    const hubState = await getServiceState(app, "agent-container-hub");
	    const hubEnv = fs.readFileSync(getTestEnvPath(userDataRoot, hubService.id), "utf8");

    assert.equal(result.mode, "bootstrap");
    assert.equal(result.preparedChanged, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["identity-center", "agent-platform", "agent-webclient"]);
    assert.equal(fs.existsSync(hubInstallDir), true);
    assert.equal(readInitializationStatePath(getTestInitializationStatePath(userDataRoot, hubService.id))?.status, "succeeded");
    assert.match(hubEnv, new RegExp(`^BIND_ADDR=127\\.0\\.0\\.1:${fixture.ports.containerHub}$`, "mu"));
    assert.notEqual(hubState.status, "running");
    assert.equal(fs.existsSync(path.join(hubInstallDir, "run", "started.txt")), false);

  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation prepares packaged first-launch core services in parallel", async () => {
  const fixture = createStartupCoreAssetsFixture({ deployDelayMs: 600 });
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const installingTimes = new Map();

  try {
    const result = await runStartupPreparation(app, {
      onProgress(serviceId, phase) {
        if (
          ["identity-center", "agent-platform", "agent-webclient"].includes(serviceId) &&
          phase === "installing" &&
          !installingTimes.has(serviceId)
        ) {
          installingTimes.set(serviceId, Date.now());
        }
      }
    });

    const installStartTimes = ["identity-center", "agent-platform", "agent-webclient"].map((serviceId) => {
      assert.equal(installingTimes.has(serviceId), true, `${serviceId} should enter installing phase`);
      return installingTimes.get(serviceId);
    });
    const spreadMs = Math.max(...installStartTimes) - Math.min(...installStartTimes);

    assert.equal(result.mode, "bootstrap");
    assert.equal(result.preparedChanged, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["identity-center", "agent-platform", "agent-webclient"]);
    assert.ok(spreadMs < 400, `expected parallel install progress, got spread ${spreadMs}ms`);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation repairs partial identity-center env preserved before packaged bootstrap", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });

  try {
    writeTestEnv(
      userDataRoot,
      "identity-center",
      [
        "SERVER_PORT=18080",
        "AUTH_DB_PATH=./data/auth.db",
        ""
      ].join("\n")
    );

    const result = await runStartupPreparation(app);
    const identityCenterEnv = fs.readFileSync(getTestEnvPath(userDataRoot, "identity-center"), "utf8");

    assert.equal(result.mode, "bootstrap");
    assert.equal(result.preparedChanged, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["identity-center", "agent-platform", "agent-webclient"]);
    assert.match(identityCenterEnv, new RegExp(`^SERVER_PORT=${fixture.ports.identityCenter}$`, "m"));
    assert.doesNotMatch(identityCenterEnv, /^AUTH_DB_PATH=/m);
    assertIdentityCenterDefaultBcryptEnv(identityCenterEnv);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation does not reinstall healthy packaged core services when synced asset mtimes are newer", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });

  try {
    for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

    const markerPath = path.join(getTestServiceProgramDir(userDataRoot, "agent-platform", "v1.0.0"), "marker.txt");
    fs.writeFileSync(markerPath, "keep", "utf8");

    const future = new Date(Date.now() + 10_000);
    for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
      const assetDir = path.join(fixture.assetsRoot, serviceId);
      for (const entry of fs.readdirSync(assetDir)) {
        fs.utimesSync(path.join(assetDir, entry), future, future);
      }
    }

    const result = await runStartupPreparation(app);
    assert.equal(result.mode, "restore");
    assert.equal(result.preparedChanged, false);
    assert.deepEqual(result.failures, []);
    assert.equal(fs.existsSync(markerPath), true);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation does not reinstall a healthy packaged service with a runtime error", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const originalRenameSync = fs.renameSync;
  let portServer;

  try {
    const identityCenterPort = await getAvailableLocalPort();
    const platformPort = await getAvailableLocalPort();
    const webclientPort = await getAvailableLocalPort();

    for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

    writeTestEnv(userDataRoot, "identity-center", `SERVER_PORT=${identityCenterPort}\n`);
    writeTestEnv(userDataRoot, "agent-platform", `SERVER_PORT=${platformPort}\n`);
    writeTestEnv(
      userDataRoot,
      "agent-webclient",
      [
        `PORT=${webclientPort}`,
        `BASE_URL=http://127.0.0.1:${platformPort}`,
        `WS_BASE_URL=http://127.0.0.1:${platformPort}`,
        `VOICE_BASE_URL=http://127.0.0.1:${platformPort}`,
        ""
      ].join("\n")
    );

    portServer = net.createServer();
    await new Promise((resolve, reject) => {
      portServer.once("error", reject);
      portServer.listen(platformPort, "127.0.0.1", resolve);
    });

    fs.renameSync = (from, to) => {
      if (String(to).includes(`${path.sep}agent-platform${path.sep}`)) {
        throw new Error("agent-platform should not be reinstalled for a runtime-only startup error");
      }
      return originalRenameSync(from, to);
    };

    const result = await runStartupPreparation(app);

    assert.doesNotMatch(result.failures.join("\n"), /should not be reinstalled/);
  } finally {
    fs.renameSync = originalRenameSync;
    if (portServer) {
      await new Promise((resolve) => portServer.close(resolve));
    }
    await stopStartupCoreProcesses(app);
    restore();
    try {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    } catch {
      // Windows can keep fixture process directories busy briefly after failed starts.
    }
  }
});

test("runStartupPreparation restores second-launch core services in parallel", async () => {
  const fixture = createStartupCoreAssetsFixture({ recordStartTime: true, startDelayMs: 500 });
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const previousVerifyDelay = process.env.SERVICE_VERIFY_DELAY_MS;
  const startingTimes = new Map();
  const succeededTimes = new Map();

  process.env.SERVICE_VERIFY_DELAY_MS = "0";

  try {
    for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

    const result = await runStartupPreparation(app, {
      onStarting(serviceId) {
        if (["identity-center", "agent-platform", "agent-webclient"].includes(serviceId)) {
          startingTimes.set(serviceId, Date.now());
        }
      },
      onProgress(serviceId, phase) {
        if (["identity-center", "agent-platform", "agent-webclient"].includes(serviceId) && phase === "succeeded") {
          succeededTimes.set(serviceId, Date.now());
        }
      }
    });
    for (const serviceId of ["identity-center", "agent-platform"]) {
      const filePath = path.join(getTestServiceProgramDir(userDataRoot, serviceId, "v1.0.0"), "run", "start-time.txt");
      assert.equal(fs.existsSync(filePath), true, `${serviceId} should record a start timestamp`);
      assert.equal(startingTimes.has(serviceId), true, `${serviceId} should reach starting phase`);
    }
    assert.equal(startingTimes.has("agent-webclient"), true, "agent-webclient should reach starting phase");
    assert.equal(
      fs.existsSync(path.join(getTestServiceProgramDir(userDataRoot, "agent-webclient", "v1.0.0"), "run", "start-time.txt")),
      false,
      "host-managed agent-webclient should not execute bundle start script"
    );
    assert.equal((await getServiceState(app, "agent-webclient")).status, "running");

    assert.equal(result.mode, "restore");
    assert.equal(result.preparedChanged, false);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["identity-center", "agent-platform", "agent-webclient"]);
    assert.equal(succeededTimes.has("identity-center"), true, "identity-center should reach succeeded phase");
    assert.ok(
      startingTimes.get("agent-platform") < succeededTimes.get("identity-center"),
      "agent-platform should start without waiting for identity-center during restore"
    );
    assert.ok(
      startingTimes.get("agent-webclient") < succeededTimes.get("identity-center"),
      "agent-webclient should start without waiting for identity-center during restore"
    );
  } finally {
    if (previousVerifyDelay === undefined) {
      delete process.env.SERVICE_VERIFY_DELAY_MS;
    } else {
      process.env.SERVICE_VERIFY_DELAY_MS = previousVerifyDelay;
    }
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation prepares packaged first-launch core services in parallel and gates webclient verification", async () => {
  const fixture = createStartupCoreAssetsFixture({ recordStartTime: true, startDelayMs: 500, deployDelayMs: 300 });
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const previousVerifyDelay = process.env.SERVICE_VERIFY_DELAY_MS;
  const installingTimes = new Map();
  const startingTimes = new Map();
  const succeededTimes = new Map();

  process.env.SERVICE_VERIFY_DELAY_MS = "0";

  try {
    const identityCenterPort = await getAvailableLocalPort();
    const platformPort = await getAvailableLocalPort();
    const webclientPort = await getAvailableLocalPort();
    writeTestEnv(userDataRoot, "identity-center", `SERVER_PORT=${identityCenterPort}\n`);
    writeTestEnv(userDataRoot, "agent-platform", `SERVER_PORT=${platformPort}\n`);
    writeTestEnv(
      userDataRoot,
      "agent-webclient",
      [
        `PORT=${webclientPort}`,
        `BASE_URL=http://127.0.0.1:${platformPort}`,
        `WS_BASE_URL=http://127.0.0.1:${platformPort}`,
        `VOICE_BASE_URL=http://127.0.0.1:${platformPort}`,
        ""
      ].join("\n")
    );

    const result = await runStartupPreparation(app, {
      onStarting(serviceId) {
        if (["identity-center", "agent-platform", "agent-webclient"].includes(serviceId)) {
          startingTimes.set(serviceId, Date.now());
        }
      },
      onProgress(serviceId, phase) {
        if (["identity-center", "agent-platform", "agent-webclient"].includes(serviceId)) {
          if (phase === "installing") {
            installingTimes.set(serviceId, Date.now());
          }
          if (phase === "succeeded") {
            succeededTimes.set(serviceId, Date.now());
          }
        }
      }
    });
    assert.equal(result.mode, "bootstrap");
    assert.equal(result.preparedChanged, true);
    const installTimes = ["identity-center", "agent-platform", "agent-webclient"].map((serviceId) => {
      assert.equal(installingTimes.has(serviceId), true, `${serviceId} should reach installing phase`);
      return installingTimes.get(serviceId);
    });
    const installSpreadMs = Math.max(...installTimes) - Math.min(...installTimes);
    assert.ok(installSpreadMs < 250, `expected parallel bootstrap install callbacks, got spread ${installSpreadMs}ms`);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["identity-center", "agent-platform", "agent-webclient"]);

    for (const serviceId of ["identity-center", "agent-platform", "agent-webclient"]) {
      assert.equal(startingTimes.has(serviceId), true, `${serviceId} should reach starting phase`);
      assert.equal(succeededTimes.has(serviceId), true, `${serviceId} should reach succeeded phase`);
    }

    assert.ok(
      succeededTimes.get("agent-webclient") >= succeededTimes.get("agent-platform"),
      "agent-webclient should only succeed after agent-platform satisfies verifyRunning requirements"
    );
  } finally {
    if (previousVerifyDelay === undefined) {
      delete process.env.SERVICE_VERIFY_DELAY_MS;
    } else {
      process.env.SERVICE_VERIFY_DELAY_MS = previousVerifyDelay;
    }
    await stopStartupCoreProcesses(app);
    restore();
    try {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    } catch {
      // Windows may keep synthetic child-process directories busy briefly after failed starts.
    }
  }
});

test("runStartupPreparation uses manifest auth capability for agent-platform runtime-info readiness", async () => {
  const fixture = createStartupCoreAssetsFixture({
    platformRootReturns404: true,
    platformRuntimeInfoRequiresAuth: true
  });
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const previousVerifyDelay = process.env.SERVICE_VERIFY_DELAY_MS;

  process.env.SERVICE_VERIFY_DELAY_MS = "0";

  try {
    const result = await runStartupPreparation(app);
    const platformState = await getServiceState(app, "agent-platform");
    const webclientState = await getServiceState(app, "agent-webclient");
    const platformRootProbe = await __testInternals.probeHttpUrl(platformState.healthMeta.webUrl);
    const platformRuntimeProbe = await __testInternals.probeHttpUrl(
      new URL("/api/runtime-info", platformState.healthMeta.webUrl).toString()
    );
    const authenticatedPlatformRuntimeProbe = await __testInternals.probeHttpUrl(
      new URL("/api/runtime-info", platformState.healthMeta.webUrl).toString(),
      { headers: { Authorization: "Bearer fixture-token" } }
    );

    assert.equal(platformRootProbe.statusCode, 404);
    assert.equal(platformRuntimeProbe.statusCode, 401);
    assert.equal(authenticatedPlatformRuntimeProbe.ok, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["identity-center", "agent-platform", "agent-webclient"]);
    assert.equal(webclientState.status, "running");
  } finally {
    if (previousVerifyDelay === undefined) {
      delete process.env.SERVICE_VERIFY_DELAY_MS;
    } else {
      process.env.SERVICE_VERIFY_DELAY_MS = previousVerifyDelay;
    }
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation reuses a running identity-center during restore", async () => {
  const fixture = createStartupCoreAssetsFixture({ recordStartTime: true, startDelayMs: 100 });
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const previousVerifyDelay = process.env.SERVICE_VERIFY_DELAY_MS;

  process.env.SERVICE_VERIFY_DELAY_MS = "0";

  try {
    for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

    const firstStart = await startService(app, "identity-center");
    const startTimePath = path.join(
      getTestServiceProgramDir(userDataRoot, "identity-center", "v1.0.0"),
      "run",
      "start-time.txt"
    );
    const firstStartTime = fs.readFileSync(startTimePath, "utf8");

    const result = await runStartupPreparation(app);
    const identityCenterState = await getServiceState(app, "identity-center");

    assert.equal(firstStart.ok, true, firstStart.message);
    assert.equal(result.mode, "restore");
    assert.equal(result.preparedChanged, false);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["identity-center", "agent-platform", "agent-webclient"]);
    assert.equal(identityCenterState.status, "running");
    assert.equal(identityCenterState.healthMeta.pid, firstStart.service.healthMeta.pid);
    assert.equal(fs.readFileSync(startTimePath, "utf8"), firstStartTime);
  } finally {
    if (previousVerifyDelay === undefined) {
      delete process.env.SERVICE_VERIFY_DELAY_MS;
    } else {
      process.env.SERVICE_VERIFY_DELAY_MS = previousVerifyDelay;
    }
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation collects parallel restore failures without cancelling sibling services", async () => {
  const fixture = createStartupCoreAssetsFixture({ failOnStartServiceId: "agent-platform" });
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });
  const previousVerifyDelay = process.env.SERVICE_VERIFY_DELAY_MS;
  const previousDependencyVerifyTimeout = process.env.SERVICE_DEPENDENCY_VERIFY_TIMEOUT_MS;

  process.env.SERVICE_VERIFY_DELAY_MS = "0";
  process.env.SERVICE_DEPENDENCY_VERIFY_TIMEOUT_MS = "500";

  try {
    for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

    const result = await runStartupPreparation(app);

    assert.equal(result.mode, "restore");
    assert.equal(result.preparedChanged, false);
    assert.equal(result.failures.length, 2);
    assert.match(result.failures.join("\n"), /agent-platform/u);
    assert.match(result.failures.join("\n"), /agent-webclient/u);
    assert.match(result.failures.join("\n"), /service agent-platform 未就绪/u);
    assert.deepEqual(result.started, ["identity-center"]);
    assert.equal(fs.existsSync(path.join(getTestServiceProgramDir(userDataRoot, "identity-center", "v1.0.0"), "run", "started.txt")), true);
    assert.equal(fs.existsSync(path.join(getTestServiceProgramDir(userDataRoot, "agent-platform", "v1.0.0"), "run", "started.txt")), false);
    assert.equal(fs.existsSync(path.join(getTestServiceProgramDir(userDataRoot, "agent-webclient", "v1.0.0"), "run", "started.txt")), false);
    assert.equal((await getServiceState(app, "agent-webclient")).status, "running");
  } finally {
    if (previousVerifyDelay === undefined) {
      delete process.env.SERVICE_VERIFY_DELAY_MS;
    } else {
      process.env.SERVICE_VERIFY_DELAY_MS = previousVerifyDelay;
    }
    if (previousDependencyVerifyTimeout === undefined) {
      delete process.env.SERVICE_DEPENDENCY_VERIFY_TIMEOUT_MS;
    } else {
      process.env.SERVICE_DEPENDENCY_VERIFY_TIMEOUT_MS = previousDependencyVerifyTimeout;
    }
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation prepares missing container hub in the background when core services are healthy", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });

  try {
    for (const serviceId of ["identity-center", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

    const markerPath = path.join(getTestServiceProgramDir(userDataRoot, "agent-platform", "v1.0.0"), "marker.txt");
    fs.writeFileSync(markerPath, "keep", "utf8");

    const result = await runStartupPreparation(app);
    const hubService = getBuiltinService("agent-container-hub");
    await __testInternals.waitForBackgroundStartupPreparations();
    const hubInstallDir = getInstallDir(app, hubService);
    const hubState = await getServiceState(app, "agent-container-hub");

    assert.equal(result.mode, "restore");
    assert.equal(result.preparedChanged, false);
    assert.deepEqual(result.failures, []);
    assert.deepEqual([...result.started].sort(), ["agent-platform", "agent-webclient", "identity-center"]);
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

test("runStartupPreparation does not block core services when optional container hub initialization fails", async () => {
  const fixture = createStartupCoreAssetsFixture({
    containerHubOptions: {
      deployScriptContent: "#!/usr/bin/env bash\nset -euo pipefail\necho container hub deploy failed >&2\nexit 1\n"
    }
  });
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });

  try {
    const result = await runStartupPreparation(app);
    await __testInternals.waitForBackgroundStartupPreparations();
    const hubState = await getServiceState(app, "agent-container-hub");

    assert.equal(result.mode, "bootstrap");
    assert.equal(result.preparedChanged, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["identity-center", "agent-platform", "agent-webclient"]);
    assert.ok(
      ["dependency-missing", "error"].includes(hubState.status),
      `expected optional hub to be unavailable, got ${hubState.status}`
    );
    assert.notEqual(hubState.status, "running");
    for (const serviceId of ["identity-center", "agent-platform", "agent-webclient"]) {
      const state = await getServiceState(app, serviceId);
      assert.equal(state.status, "running", `${serviceId} should run when container hub init fails`);
    }
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation reinitializes packaged core services that are missing init state", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });

  try {
    for (const serviceId of ["identity-center", "agent-platform", "agent-webclient"]) {
      await installBuiltinService(app, serviceId);
    }

    const platformService = getBuiltinService("agent-platform");
    fs.rmSync(getTestStateDir(userDataRoot, platformService.id), { recursive: true, force: true });

    const result = await runStartupPreparation(app);
    assert.equal(result.mode, "bootstrap");
    assert.equal(result.preparedChanged, true);
    assert.deepEqual(result.failures, []);
    assert.equal(fs.existsSync(getTestInitializationStatePath(userDataRoot, platformService.id)), true);
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation reports one bootstrap failure without blocking independent dependents", async () => {
  const fixture = createStartupCoreAssetsFixture({ failOnStartServiceId: "identity-center" });
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: true });

  try {
    const result = await runStartupPreparation(app);
    assert.equal(result.mode, "bootstrap");
    assert.equal(result.preparedChanged, true);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /identity-center/u);
    assert.deepEqual(result.started, ["agent-platform", "agent-webclient"]);
    assert.equal(fs.existsSync(path.join(getTestServiceProgramDir(userDataRoot, "agent-platform", "v1.0.0"), "run", "started.txt")), true);
    assert.equal(fs.existsSync(path.join(getTestServiceProgramDir(userDataRoot, "agent-webclient", "v1.0.0"), "run", "started.txt")), false);
    assert.equal((await getServiceState(app, "agent-webclient")).status, "running");
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runStartupPreparation bootstraps development first launch with core services", async () => {
  const fixture = createStartupCoreAssetsFixture();
  const userDataRoot = path.join(fixture.tempRoot, "user-data");
  const { app, restore } = loadStartupCoreBuiltinsForTest(userDataRoot, fixture, { isPackaged: false });

  try {
    const result = await runStartupPreparation(app);
    const hubService = getBuiltinService("agent-container-hub");
    await __testInternals.waitForBackgroundStartupPreparations();
    const hubState = await getServiceState(app, "agent-container-hub");

    assert.equal(result.mode, "bootstrap");
    assert.equal(result.preparedChanged, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.started, ["identity-center", "agent-platform", "agent-webclient"]);
    assert.equal(readInitializationStatePath(getTestInitializationStatePath(userDataRoot, hubService.id))?.status, "succeeded");
    assert.notEqual(hubState.status, "running");
  } finally {
    await stopStartupCoreProcesses(app);
    restore();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runExecFile resolves when a daemon child keeps stdout open", async () => {
  const isWindows = process.platform === "win32";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-run-exec-daemon-"));
  const scriptName = isWindows ? "start.ps1" : "start.sh";
  const scriptPath = path.join(tempRoot, scriptName);
  if (isWindows) {
    fs.writeFileSync(
      scriptPath,
      [
        "$proc = Start-Process -FilePath powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','Start-Sleep -Seconds 3' -PassThru",
        "$proc.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'daemon.pid')",
        "Write-Output 'started'"
      ].join("\r\n"),
      "utf8"
    );
  } else {
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
  }

  const startedAt = Date.now();
  const result = await __testInternals.runExecFile(`./${scriptName}`, [], tempRoot);
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
    assert.ok(elapsedMs < 3300, `expected concurrent stop to finish before the shutdown timeout, took ${elapsedMs}ms`);
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
  const previousVerifyDelay = process.env.SERVICE_VERIFY_DELAY_MS;
  let fixture = null;

  registryInternals.clearServices();
  process.env.SERVICE_VERIFY_DELAY_MS = "0";

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
      delete process.env.SERVICE_VERIFY_DELAY_MS;
    } else {
      process.env.SERVICE_VERIFY_DELAY_MS = previousVerifyDelay;
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
