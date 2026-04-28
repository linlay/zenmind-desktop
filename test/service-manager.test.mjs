import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
  const {
    __testInternals,
    getServiceState,
    getInstallDir,
    initializeService,
    installBuiltinService,
    readServiceLog,
    readServiceConfig,
    restoreRunningServices,
    startService
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

function createApp(userDataRoot, options = {}) {
  const {
    isPackaged = false,
    homePath = process.env.HOME ?? os.homedir(),
    desktopPath = path.join(homePath, "Desktop")
  } = options;
  return {
    isPackaged,
    getPath(name) {
      switch (name) {
        case "userData":
          return userDataRoot;
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

test("normalizeAgentPlatformEnvContentForSave records whether ACP relay was manually enabled", () => {
  const enabledContent = __testInternals.normalizeAgentPlatformEnvContentForSave(
    "HOST_PORT=11949\nLOCAL_CLI_ACP_RELAY_ENABLED=true\n"
  );
  const disabledContent = __testInternals.normalizeAgentPlatformEnvContentForSave(
    "HOST_PORT=11949\nLOCAL_CLI_ACP_RELAY_ENABLED=false\n"
  );

  assert.match(enabledContent, /^LOCAL_CLI_ACP_RELAY_USER_ENABLED=true$/m);
  assert.match(disabledContent, /^LOCAL_CLI_ACP_RELAY_USER_ENABLED=false$/m);
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

test("cleanupAgentPlatformRelayBeforeStart stops managed relay leftovers and clears pid file", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-relay-cleanup-"));
  const installDir = path.join(tempRoot, "agent-platform");
  const relayDir = path.join(installDir, "local-cli-acp-relay");
  const runDir = path.join(installDir, "run");
  const relayScriptPath = path.join(relayDir, "relay-fixture.mjs");
  const relayPidFilePath = path.join(runDir, "local-cli-acp-relay.pid");

  fs.mkdirSync(relayDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(relayScriptPath, "setInterval(() => {}, 1000);\n", "utf8");

  const relayProcess = spawn(process.execPath, [relayScriptPath], {
    stdio: "ignore"
  });

  assert.ok(relayProcess.pid, "expected relay fixture to expose a pid");
  fs.writeFileSync(relayPidFilePath, `${relayProcess.pid}\n`, "utf8");

  __testInternals.cleanupAgentPlatformRelayBeforeStart(installDir, new Map([
    ["LOCAL_CLI_ACP_RELAY_PORT", "3220"]
  ]));

  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(fs.existsSync(relayPidFilePath), false);
  assert.equal(spawnSync("kill", ["-0", String(relayProcess.pid)]).status, 1);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("cleanupAgentPlatformRelayBeforeStart stops managed relay leftovers that only occupy the relay port", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-relay-port-cleanup-"));
  const installDir = path.join(tempRoot, "agent-platform");
  const relayDir = path.join(installDir, "local-cli-acp-relay");
  const relayScriptPath = path.join(relayDir, "relay-port-fixture.mjs");
  const relayPort = 33220 + Math.floor(Math.random() * 1000);

  fs.mkdirSync(relayDir, { recursive: true });
  fs.writeFileSync(
    relayScriptPath,
    `import http from "node:http";
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(${relayPort}, "127.0.0.1");
setInterval(() => {}, 1000);
`,
    "utf8"
  );

  const relayProcess = spawn(process.execPath, [relayScriptPath], {
    stdio: "ignore"
  });

  assert.ok(relayProcess.pid, "expected relay fixture to expose a pid");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (spawnSync("lsof", ["-nP", `-iTCP:${relayPort}`, "-sTCP:LISTEN"]).status === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  __testInternals.cleanupAgentPlatformRelayBeforeStart(installDir, new Map([
    ["LOCAL_CLI_ACP_RELAY_PORT", String(relayPort)]
  ]));

  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(spawnSync("kill", ["-0", String(relayProcess.pid)]).status, 1);

  fs.rmSync(tempRoot, { recursive: true, force: true });
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
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
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
    fs.writeFileSync(path.join(installDir, "run", "test-plugin.pid"), `${child.pid}\n`, "utf8");

    const roots = __testInternals.collectManagedRootPids(app);
    assert.equal(roots.some((root) => root.pid === child.pid && root.serviceId === "test-plugin"), true);

    fs.writeFileSync(path.join(installDir, "run", "test-plugin.pid"), `${process.pid}\n`, "utf8");
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

test("collectManagedRootPids includes agent-platform relay pid files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-managed-relay-root-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "agent-platform");
  const app = createApp(userDataRoot);
  const relayDir = path.join(installDir, "local-cli-acp-relay");
  const relayPath = path.join(relayDir, "relay-fixture.mjs");
  let child = null;

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    id: "agent-platform",
    port: 0,
    deployScriptContent: false
  });
  fs.mkdirSync(relayDir, { recursive: true });
  fs.writeFileSync(relayPath, "setInterval(() => {}, 1000);\n", "utf8");

  try {
    child = spawn(process.execPath, [relayPath], {
      cwd: installDir,
      stdio: "ignore"
    });
    assert.ok(child.pid, "expected relay fixture process to expose a pid");
    fs.writeFileSync(path.join(installDir, "run", "local-cli-acp-relay.pid"), `${child.pid}\n`, "utf8");

    const roots = __testInternals.collectManagedRootPids(app);
    assert.equal(roots.some((root) => root.pid === child.pid && root.serviceId === "agent-platform"), true);
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

test("installBuiltinService migrates env from sibling version directories and removes stale versions", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sibling-install-migrate-"));
  const envContent = "BIND_ADDR=127.0.0.1:13000\n";
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);
  const siblingInstallDir = path.join(userDataRoot, "services", "agent-container-hub", "v9.9.9");

  fs.mkdirSync(siblingInstallDir, { recursive: true });
  fs.writeFileSync(path.join(siblingInstallDir, ".env"), envContent, "utf8");
  fs.writeFileSync(path.join(siblingInstallDir, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(path.join(siblingInstallDir, "README.txt"), "stale version\n", "utf8");

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);

  assert.equal(fs.readFileSync(path.join(installDir, ".env"), "utf8"), envContent);
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

test("installBuiltinService prepares agent platform desktop config during first initialization", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-first-init-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const installDir = path.join(userDataRoot, "services", platformService.id, platformService.version);

  try {
    await installBuiltinService(app, "agent-platform");

    const envContent = fs.readFileSync(path.join(installDir, ".env"), "utf8");
    assert.match(envContent, /^AUTH_ENABLED=true$/m);
    assert.match(envContent, /^AUTH_LOCAL_PUBLIC_KEY_FILE=configs\/local-public-key\.pem$/m);
    assert.match(envContent, /^SERVER_PORT=11949$/m);
    assert.equal(fs.existsSync(path.join(installDir, "configs", "local-public-key.pem")), true);
  } finally {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

test("startService treats a matching port listener as already running and restores the pid file", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-port-detect-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "plugins", "test-plugin");
  const app = createApp(userDataRoot);
  const port = 19300 + Math.floor(Math.random() * 1000);
  const pidFilePath = path.join(installDir, "run", "test-plugin.pid");
  let child = null;

  registryInternals.clearServices();
  writePluginInstallRoot(installDir, {
    port,
    deployScriptContent: false
  });
  fs.writeFileSync(path.join(installDir, ".env"), `PORT=${port}\n`, "utf8");
  fs.writeFileSync(
    path.join(installDir, "start.sh"),
    "#!/usr/bin/env bash\necho should-not-run >&2\nexit 1\n",
    "utf8"
  );
  fs.chmodSync(path.join(installDir, "start.sh"), 0o755);
  fs.writeFileSync(
    (() => {
      const initStatePath = __testInternals.getInitializationStatePath(installDir);
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

test("startService returns a port conflict error for agent-container-hub when an external process occupies the port", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-container-hub-port-conflict-"));
  const { assetsRoot, userDataRoot, installDir } = createContainerHubBundleFixture(tempRoot);
  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");
  const port = 19600 + Math.floor(Math.random() * 1000);
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
    fs.writeFileSync(path.join(installDir, ".env"), `BIND_ADDR=127.0.0.1:${port}\n`, "utf8");

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
  const hubInstallDir = path.join(userDataRoot, "services", hubService.id, hubService.version);
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);
  const desktopRuntimeRoot = path.join(homeRoot, "zenmind");
  const codeAssistantDir = path.join(desktopRuntimeRoot, "agents", "codeAssistant");
  const codeAssistantConfigPath = path.join(codeAssistantDir, "agent.yml");

  fs.mkdirSync(hubInstallDir, { recursive: true });
  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "registries"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "agents"), { recursive: true });
  fs.writeFileSync(path.join(hubInstallDir, ".env"), "BIND_ADDR=0.0.0.0:12960\n", "utf8");
  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    "HOST_PORT=11949\nAGENT_CONTAINER_HUB_BASE_URL=http://host.docker.internal:11960\nAGENT_AUTH_ENABLED=false\nLOCAL_CLI_ACP_RELAY_PORT=3210\nGATEWAY_WS_URL=ws://10.0.0.1:8080/ws/agent\nGATEWAY_USER_ID=demo\n",
    "utf8"
  );
  fs.mkdirSync(codeAssistantDir, { recursive: true });
  fs.writeFileSync(
    codeAssistantConfigPath,
    "name: codeAssistant\ncolor: \"#10B981\"\nmode: PROXY\nproxyConfig:\n  baseUrl: http://127.0.0.1:3210\n  token: \"demo-token\"\n  timeoutMs: 300000\n",
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
  assert.match(envContent, /CONTAINER_HUB_BASE_URL=http:\/\/127\.0\.0\.1:12960/);
  assert.match(envContent, /SERVER_PORT=11949/);
  assert.match(envContent, /^AGENT_WS_ENABLED=true$/m);
  assert.match(envContent, /^AUTH_ENABLED=true$/m);
  assert.match(envContent, /^AUTH_LOCAL_PUBLIC_KEY_FILE=configs\/local-public-key\.pem$/m);
  assert.match(envContent, /^LOCAL_CLI_ACP_RELAY_ENABLED=false$/m);
  assert.doesNotMatch(envContent, /^GATEWAY_WS_URL=/m);
  assert.doesNotMatch(envContent, /^GATEWAY_USER_ID=/m);
  assert.doesNotMatch(envContent, /^AGENT_CONTAINER_HUB_BASE_URL=/m);
  assert.doesNotMatch(envContent, /^AGENT_AUTH_ENABLED=/m);
  assert.doesNotMatch(envContent, /^AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE=/m);

  const expectedNodeBinLiteral = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
  assert.match(
    envContent,
    new RegExp(`NODE_BIN=${expectedNodeBinLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  const locator = process.platform === "win32" ? "where" : "which";
  const acpResult = spawnSync(locator, ["claude-code-acp"], { encoding: "utf8", timeout: 1500 });
  if (acpResult.status === 0 && !acpResult.error) {
    const resolvedAcp = acpResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean);
    if (resolvedAcp) {
      const expectedAcpLiteral = resolvedAcp.includes(" ") ? `"${resolvedAcp}"` : resolvedAcp;
      assert.match(
        envContent,
        new RegExp(`CLAUDE_CODE_ACP_COMMAND=${expectedAcpLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
      assert.match(envContent, /^CLAUDE_CODE_ACP_ARGS=""$/m);
    }
  } else {
    const npxResult = spawnSync(locator, ["npx"], { encoding: "utf8", timeout: 1500 });
    if (npxResult.status === 0 && !npxResult.error) {
      const resolvedNpx = npxResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean);
      if (resolvedNpx) {
        const expectedNpxLiteral = resolvedNpx.includes(" ") ? `"${resolvedNpx}"` : resolvedNpx;
        assert.match(
          envContent,
          new RegExp(`CLAUDE_CODE_ACP_COMMAND=${expectedNpxLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
        );
        assert.match(envContent, /^CLAUDE_CODE_ACP_ARGS='-y @zed-industries\/claude-code-acp'$/m);
      }
    }
  }
  assert.match(
    envContent,
    new RegExp(`REGISTRIES_DIR=${path.join(desktopRuntimeRoot, "registries").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    envContent,
    new RegExp(`AGENTS_DIR=${path.join(desktopRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  const agentConfigContent = fs.readFileSync(codeAssistantConfigPath, "utf8");
  assert.match(agentConfigContent, /baseUrl: http:\/\/127\.0\.0\.1:3210/);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements preserves custom relay port and custom codeAssistant proxy baseUrl", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-custom-prestart-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);
  const desktopRuntimeRoot = path.join(homeRoot, "zenmind");
  const customAgentsDir = path.join(tempRoot, "custom-agents");
  const codeAssistantDir = path.join(customAgentsDir, "codeAssistant");
  const codeAssistantConfigPath = path.join(codeAssistantDir, "agent.yml");

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "registries"), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntimeRoot, "agents"), { recursive: true });
  fs.mkdirSync(codeAssistantDir, { recursive: true });
  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    `HOST_PORT=11949\nLOCAL_CLI_ACP_RELAY_ENABLED=true\nLOCAL_CLI_ACP_RELAY_PORT=4555\nAGENTS_DIR=${customAgentsDir}\nCLAUDE_CODE_ACP_COMMAND=/custom/bin/claude-code-acp\nCLAUDE_CODE_ACP_ARGS=--stdio\n`,
    "utf8"
  );
  fs.writeFileSync(
    codeAssistantConfigPath,
    "name: codeAssistant\nmode: PROXY\nproxyConfig:\n  baseUrl: http://127.0.0.1:4555\n  token: \"demo-token\"\n",
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
  assert.match(envContent, /^LOCAL_CLI_ACP_RELAY_ENABLED=true$/m);
  assert.match(envContent, /LOCAL_CLI_ACP_RELAY_PORT=4555/);
  assert.match(envContent, /AGENTS_DIR=/);
  assert.doesNotMatch(envContent, /REGISTRIES_DIR=/);
  assert.match(envContent, /CLAUDE_CODE_ACP_COMMAND=\/custom\/bin\/claude-code-acp/);
  assert.match(envContent, /CLAUDE_CODE_ACP_ARGS=--stdio/);
  const agentConfigContent = fs.readFileSync(codeAssistantConfigPath, "utf8");
  assert.match(agentConfigContent, /baseUrl: http:\/\/127\.0\.0\.1:4555/);
  assert.doesNotMatch(agentConfigContent, /3220/);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements migrates stale default ACP relay settings back to disabled", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-acp-migrate-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    [
      "HOST_PORT=11949",
      "LOCAL_CLI_ACP_RELAY_ENABLED=true",
      "LOCAL_CLI_ACP_RELAY_PORT=3220",
      "CLAUDE_CODE_ACP_COMMAND=/Users/example/.nvm/versions/node/v22.22.1/bin/npx",
      `CLAUDE_CODE_ACP_ARGS=${JSON.stringify("-y @zed-industries/claude-code-acp")}`
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
  assert.match(envContent, /^LOCAL_CLI_ACP_RELAY_ENABLED=false$/m);
  assert.doesNotMatch(envContent, /^LOCAL_CLI_ACP_RELAY_USER_ENABLED=true$/m);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements preserves manually enabled ACP relay when the user marker is present", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-acp-user-enabled-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const homeRoot = path.join(tempRoot, "home");
  const { app, restore } = loadBuiltinsForTest(userDataRoot, undefined, {
    homePath: homeRoot,
    desktopPath: path.join(homeRoot, "Desktop")
  });
  const platformService = getBuiltinService("agent-platform");
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    [
      "HOST_PORT=11949",
      "LOCAL_CLI_ACP_RELAY_ENABLED=true",
      "LOCAL_CLI_ACP_RELAY_USER_ENABLED=true",
      "LOCAL_CLI_ACP_RELAY_PORT=3220",
      "CLAUDE_CODE_ACP_COMMAND=/Users/example/.nvm/versions/node/v22.22.1/bin/npx",
      `CLAUDE_CODE_ACP_ARGS=${JSON.stringify("-y @zed-industries/claude-code-acp")}`
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
  assert.match(envContent, /^LOCAL_CLI_ACP_RELAY_ENABLED=true$/m);
  assert.match(envContent, /^LOCAL_CLI_ACP_RELAY_USER_ENABLED=true$/m);

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
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);
  const legacyRuntimeRoot = path.join(tempRoot, "legacy-runtime");
  const codeAssistantDir = path.join(legacyRuntimeRoot, "agents", "codeAssistant");
  const codeAssistantConfigPath = path.join(codeAssistantDir, "agent.yml");

  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.mkdirSync(path.join(homeRoot, "zenmind", "registries"), { recursive: true });
  fs.mkdirSync(path.join(homeRoot, "zenmind", "agents"), { recursive: true });
  fs.mkdirSync(codeAssistantDir, { recursive: true });
  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    `HOST_PORT=11949\nRUNTIME_DIR=${legacyRuntimeRoot}\nLOCAL_CLI_ACP_RELAY_PORT=3220\n`,
    "utf8"
  );
  fs.writeFileSync(
    codeAssistantConfigPath,
    "name: codeAssistant\nmode: PROXY\nproxyConfig:\n  baseUrl: http://127.0.0.1:3220\n  token: \"demo-token\"\n",
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
  assert.doesNotMatch(envContent, /^RUNTIME_DIR=/m);
  assert.match(
    envContent,
    new RegExp(`REGISTRIES_DIR=${path.join(legacyRuntimeRoot, "registries").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    envContent,
    new RegExp(`AGENTS_DIR=${path.join(legacyRuntimeRoot, "agents").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(envContent, /LOCAL_CLI_ACP_RELAY_PORT=3220/);

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
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);
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
      `SKILLS_MARKET_DIR=${legacyRuntimeRoot}/skills-market`,
      "LOCAL_CLI_ACP_RELAY_PORT=3220"
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
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);
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
      `SKILLS_MARKET_DIR=${legacyRuntimeRoot}/skills-market`,
      "LOCAL_CLI_ACP_RELAY_PORT=3220"
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
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);
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
      `SKILLS_MARKET_DIR=${legacyRuntimeRoot}/skills-market`,
      "LOCAL_CLI_ACP_RELAY_PORT=3220"
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
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);
  const webclientInstallDir = path.join(userDataRoot, "services", webclientService.id, webclientService.version);

  fs.mkdirSync(path.join(platformInstallDir, "run"), { recursive: true });
  fs.writeFileSync(path.join(platformInstallDir, ".env"), "SERVER_PORT=12949\n", "utf8");
  await installBuiltinService(app, webclientService.id);
  fs.writeFileSync(
    path.join(webclientInstallDir, ".env"),
    "BASE_URL=http://localhost:11949\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(webclientInstallDir, "backend", "server.js"),
    "const { createProxyMiddleware } = require('http-proxy-middleware');\n",
    "utf8"
  );

  assert.equal(__testInternals.agentWebclientInstallNeedsRefresh(webclientInstallDir), true);

  await __testInternals.ensurePreStartRequirements(app, webclientService);

  const envContent = fs.readFileSync(path.join(webclientInstallDir, ".env"), "utf8");
  const serverContent = fs.readFileSync(path.join(webclientInstallDir, "backend", "server.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(webclientInstallDir, "manifest.json"), "utf8"));
  assert.match(envContent, /BASE_URL=http:\/\/127\.0\.0\.1:12949/);
  assert.match(envContent, /PORT=11948/);
  const expectedNodeBinLiteral = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
  assert.match(
    envContent,
    new RegExp(`NODE_BIN=${expectedNodeBinLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(serverContent, /function createWebSocketProxy\(/);
  assert.equal(__testInternals.agentWebclientInstallNeedsRefresh(webclientInstallDir), false);
  assert.equal(manifest.frontend.embedPath, "/appagent");
  assert.equal(manifest.frontend.embedParams?.desktopApp, "1");

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
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
  const pluginAFolder = path.join(userDataRoot, "plugins", "plugin-a");
  const pluginBFolder = path.join(userDataRoot, "plugins", "plugin-b");
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
    fs.writeFileSync(path.join(installDir, ".env"), `PORT=${installDir === pluginAFolder ? 9310 : 9311}\n`, "utf8");
    fs.writeFileSync(
      (() => {
        const initStatePath = __testInternals.getInitializationStatePath(installDir);
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
      "progress:custom-builtin:succeeded"
    ]);
    assert.deepEqual(result.failures, []);
    assert.equal(
      fs.existsSync(path.join(userDataRoot, "services", "custom-builtin", "v1.0.0", "run", "started.txt")),
      true
    );
  } finally {
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
