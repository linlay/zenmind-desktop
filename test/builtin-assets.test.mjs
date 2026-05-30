import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  builtinServices,
  discoverBuiltinServices,
  listArchiveEntries,
  readArchiveEntryText,
  readManifestFromArchive,
  syncBuiltinAssets,
  validateBundleArchive
} from "../scripts/lib/builtin-assets.mjs";

const BUILTIN_ASSETS_SOURCE_ENV = "ZENMIND_BUILTIN_ASSETS_SOURCE";
const desktopProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let hasSyncedActualAssets = false;
const requiredDesktopCoreServiceIds = [
  "zenmind-app-server",
  "agent-platform",
  "agent-webclient"
];

function createTarBundle(service, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-asset-"));
  const bundleRoot = path.join(root, service.bundleTopLevelDir);
  fs.mkdirSync(bundleRoot, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(bundleRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }

  const tarPath = path.join(root, `${service.id}.tar.gz`);
  execFileSync("tar", ["-czf", tarPath, "-C", root, service.bundleTopLevelDir]);
  return { root, tarPath };
}

function createZipBundle(service, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-asset-zip-"));
  const bundleRoot = path.join(root, service.bundleTopLevelDir);
  fs.mkdirSync(bundleRoot, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(bundleRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }

  const zipPath = path.join(root, `${service.id}.zip`);
  if (process.platform === "win32") {
    const relativeRoot = service.bundleTopLevelDir.replace(/'/g, "''");
    const escapedZipPath = zipPath.replace(/'/g, "''");
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -Path '${relativeRoot}' -DestinationPath '${escapedZipPath}' -Force`
      ],
      { cwd: root }
    );
  } else {
    execFileSync("zip", ["-qr", zipPath, service.bundleTopLevelDir], { cwd: root });
  }
  return { root, zipPath };
}

function withEnv(name, value, fn) {
  const previousValue = process.env[name];
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return fn();
  } finally {
    if (previousValue == null) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  }
}

function writeBuiltinTarArchive({
  archivePath,
  id,
  version,
  os,
  arch,
  assetFileName,
  requiredBundleEntries = ["start.sh", "stop.sh", ".env.example", "manifest.json"]
}) {
  const service = {
    id,
    bundleTopLevelDir: id,
    requiredBundleEntries
  };
  const fixture = createTarBundle(service, {
    "start.sh": "#!/bin/sh\nexit 0\n",
    "stop.sh": "#!/bin/sh\nexit 0\n",
    ".env.example": "SERVER_PORT=12000\n",
    "manifest.json": JSON.stringify({
      id,
      kind: "builtin",
      version,
      platform: {
        os,
        arch
      },
      runtime: {
        requiredPaths: requiredBundleEntries
      },
      desktop: {
        bundleTopLevelDir: id,
        assetFileName
      }
    })
  });

  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.copyFileSync(fixture.tarPath, archivePath);
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function computeAssetSignature(assetPath) {
  const stat = fs.statSync(assetPath);
  const sha256 = createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
  return `${stat.size}:${sha256}`;
}

function ensureSyncedAssets() {
  if (hasSyncedActualAssets) {
    return;
  }

  if (hasCompleteSyncedAssetsForCurrentPlatform()) {
    hasSyncedActualAssets = true;
    return;
  }

  const manifest = withEnv(BUILTIN_ASSETS_SOURCE_ENV, null, () =>
    syncBuiltinAssets(process.cwd(), {
      os: currentManifestOs(),
      arch: currentManifestArch()
    })
  );
  assert.ok(manifest.length > 0, "expected at least one builtin asset to sync for tests");
  hasSyncedActualAssets = true;
}

function hasCompleteSyncedAssetsForCurrentPlatform() {
  const osName = currentManifestOs();
  const archName = currentManifestArch();
  return requiredDesktopCoreServiceIds.every((serviceId) => {
    const serviceDir = path.join(process.cwd(), "build", "resources", "services", serviceId);
    if (!fs.existsSync(serviceDir)) {
      return false;
    }
    return fs.readdirSync(serviceDir).some((assetFileName) => {
      if (!assetFileName.endsWith(".zip") && !assetFileName.endsWith(".tar.gz")) {
        return false;
      }
      const manifest = readManifestFromArchive(path.join(serviceDir, assetFileName));
      return manifest?.id === serviceId &&
        manifest.platform?.os === osName &&
        manifest.platform?.arch === archName;
    });
  });
}

function getSyncedAsset(serviceId) {
  ensureSyncedAssets();

  const serviceDir = path.join(process.cwd(), "build", "resources", "services", serviceId);
  const assetFileName = fs
    .readdirSync(serviceDir)
    .find((entry) => entry.endsWith(".zip") || entry.endsWith(".tar.gz"));

  assert.ok(assetFileName, `missing synced archive for ${serviceId}`);

  const assetPath = path.join(serviceDir, assetFileName);
  const service = createServiceMetadataFromArchive(assetPath);

  return {
    service,
    assetPath
  };
}

function createServiceMetadataFromArchive(assetPath) {
  const manifest = readManifestFromArchive(assetPath);
  assert.equal(manifest?.kind, "builtin", `expected builtin manifest in ${assetPath}`);
  const requiredBundleEntries = Array.isArray(manifest.runtime?.requiredPaths)
    ? manifest.runtime.requiredPaths.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  assert.ok(requiredBundleEntries.length > 0, `missing runtime.requiredPaths in ${assetPath}`);
  return {
    id: manifest.id,
    sourceDir: path.dirname(assetPath),
    assetFileName: path.basename(assetPath),
    bundleTopLevelDir: manifest.desktop?.bundleTopLevelDir ?? manifest.id,
    version: manifest.version,
    platform: {
      os: manifest.platform?.os ?? "",
      arch: manifest.platform?.arch ?? ""
    },
    requiredBundleEntries
  };
}

function findSyncedAssetForPlatform(serviceId, osName) {
  ensureSyncedAssets();

  const serviceDir = path.join(process.cwd(), "build", "resources", "services", serviceId);
  if (!fs.existsSync(serviceDir)) {
    return null;
  }

  for (const assetFileName of fs.readdirSync(serviceDir)) {
    if (!assetFileName.endsWith(".zip") && !assetFileName.endsWith(".tar.gz")) {
      continue;
    }
    const assetPath = path.join(serviceDir, assetFileName);
    const manifest = readManifestFromArchive(assetPath);
    if (manifest?.id === serviceId && (!osName || manifest.platform?.os === osName)) {
      return {
        service: createServiceMetadataFromArchive(assetPath),
        assetPath
      };
    }
  }

  return null;
}

function getWorkspaceAsset(serviceId, osName) {
  const service = builtinServices.find(
    (item) => item.id === serviceId && item.assetFileName.includes(`-${osName}-`)
  );
  if (!service || !fs.existsSync(path.join(service.sourceDir, service.assetFileName))) {
    const syncedAsset = findSyncedAssetForPlatform(serviceId, osName);
    assert.ok(syncedAsset, `missing builtin service metadata for ${serviceId}/${osName}`);
    return syncedAsset;
  }
  return {
    service,
    assetPath: path.join(service.sourceDir, service.assetFileName)
  };
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
  if (process.platform === "darwin") {
    try {
      const translated = execFileSync("sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" }).trim();
      if (translated === "1") {
        return "arm64";
      }
    } catch {
      // Continue with host-architecture probes.
    }

    try {
      const arm64Capable = execFileSync("sysctl", ["-in", "hw.optional.arm64"], { encoding: "utf8" }).trim();
      if (arm64Capable === "1") {
        return "arm64";
      }
    } catch {
      // Continue with uname fallback.
    }

    try {
      const machine = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
      if (machine === "arm64" || machine === "aarch64") {
        return "arm64";
      }
      if (machine === "x86_64" || machine === "amd64") {
        return "amd64";
      }
    } catch {
      // Fall back to the Node architecture below.
    }
  }

  switch (process.arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      return process.arch;
  }
}

function findBuiltinServiceForCurrentPlatform(serviceId) {
  const service = builtinServices.find(
    (item) => item.id === serviceId && item.platform?.os === currentManifestOs()
  ) ?? builtinServices.find((item) => item.id === serviceId);
  assert.ok(service, `missing builtin service metadata for ${serviceId}`);
  return service;
}

test("agent-webclient release asset remains available for manual install", () => {
  const { service, assetPath } = getWorkspaceAsset("agent-webclient", currentManifestOs());
  validateBundleArchive(service, assetPath);

  const entries = listArchiveEntries(assetPath);
  if (assetPath.endsWith(".zip")) {
    assert.ok(entries.has("agent-webclient/start.ps1"));
    assert.ok(entries.has("agent-webclient/stop.ps1"));
    assert.ok(entries.has("agent-webclient/deploy.ps1"));
  } else {
    assert.ok(entries.has("agent-webclient/start.sh"));
    assert.ok(entries.has("agent-webclient/stop.sh"));
    assert.ok(entries.has("agent-webclient/deploy.sh"));
  }
  assert.ok(entries.has("agent-webclient/backend/server.cjs"));
  assert.ok(entries.has("agent-webclient/manifest.json"));
  assert.ok(entries.has("agent-webclient/frontend/dist/index.html"));
  const programCommonName = assetPath.endsWith(".zip") ? "program-common.ps1" : "program-common.sh";
  const programCommon = readArchiveEntryText(assetPath, `agent-webclient/scripts/${programCommonName}`);
  assert.ok(programCommon, `expected agent-webclient ${programCommonName} to be readable`);
  assert.doesNotMatch(programCommon, /BACKEND_PACKAGE_FILE|BACKEND_NODE_MODULES_DIR|BackendPackageFile|BackendModulesDir/);
  assert.doesNotMatch(programCommon, /backend[\\/]package\.json|backend[\\/]node_modules/);
  if (assetPath.endsWith(".zip")) {
    assert.match(programCommon, /\$Script:BackendEntry\s*=\s*Join-Path\s+\(Join-Path\s+\$Script:BundleRoot\s+['"]backend['"]\)\s+['"]server\.cjs['"]/);
  } else {
    assert.match(programCommon, /BACKEND_ENTRY=["']\$\{?BUNDLE_ROOT\}?\/backend\/server\.cjs["']/);
  }
  assert.equal(entries.has("agent-webclient/README.txt"), false);
  assert.equal(entries.has("agent-webclient/backend/package.json"), false);
  assert.equal(entries.has("agent-webclient/backend/package-lock.json"), false);
  assert.equal(
    [...entries].some((entry) => entry.startsWith("agent-webclient/backend/node_modules/")),
    false
  );
});

test("synced builtin assets include agent-webclient so assistant entry is available in desktop", () => {
  const { service, assetPath } = getSyncedAsset("agent-webclient");
  validateBundleArchive(service, assetPath);

  const entries = listArchiveEntries(assetPath);
  assert.ok(entries.has("agent-webclient/manifest.json"));
  assert.ok(entries.has("agent-webclient/frontend/dist/index.html"));
  const envExample = readArchiveEntryText(assetPath, "agent-webclient/.env.example");
  assert.match(envExample, /^# DESKTOP_APP=true$/m);
  assert.doesNotMatch(envExample, /^DESKTOP_APP=/m);

  const manifest = readManifestFromArchive(assetPath);
  assert.equal(manifest?.backend?.entry, "backend/server.cjs");
  assert.equal(manifest?.frontend?.embedPath, "/");
  assert.equal(manifest?.frontend?.embedParams?.desktopApp, undefined);
  const envBindingKeys = Array.isArray(manifest?.desktop?.envBindings)
    ? manifest.desktop.envBindings.map((binding) => binding?.key)
    : [];
  assert.ok(envBindingKeys.includes("BASE_URL"));
});

test("synced builtin service launchers derive .env from SERVICE_CONFIG_DIR", () => {
  for (const serviceId of ["agent-platform", "agent-container-hub", "agent-webclient", "zenmind-app-server"]) {
    const { service, assetPath } = getSyncedAsset(serviceId);
    validateBundleArchive(service, assetPath);

    const scriptDir = serviceId === "zenmind-app-server" ? "scripts" : "scripts";
    const programCommonName = assetPath.endsWith(".zip") ? "program-common.ps1" : "program-common.sh";
    const programCommon = readArchiveEntryText(assetPath, `${serviceId}/${scriptDir}/${programCommonName}`);
    assert.ok(programCommon, `expected ${serviceId} ${programCommonName} to be readable`);
    assert.doesNotMatch(programCommon, /ZENMIND_SERVICE_/);

    if (assetPath.endsWith(".zip")) {
      assert.match(programCommon, /\$env:SERVICE_CONFIG_DIR/u, `${serviceId} should read SERVICE_CONFIG_DIR`);
      assert.match(programCommon, /Join-Path\s+\$\(if\s+\(\$env:SERVICE_CONFIG_DIR\)/u);
      assert.match(programCommon, /\$env:SERVICE_STATE_DIR/u, `${serviceId} should read SERVICE_STATE_DIR`);
      assert.match(programCommon, /\$env:SERVICE_LOG_DIR/u, `${serviceId} should read SERVICE_LOG_DIR`);
      if (serviceId !== "agent-webclient") {
        assert.match(programCommon, /\$env:SERVICE_DATA_DIR/u, `${serviceId} should read SERVICE_DATA_DIR`);
      }
    } else {
      assert.match(
        programCommon,
        /ENV_FILE="\$\{SERVICE_CONFIG_DIR:-\$BUNDLE_ROOT\}\/\.env"/u,
        `${serviceId} should derive .env from SERVICE_CONFIG_DIR`
      );
      assert.match(programCommon, /RUN_DIR="\$\{SERVICE_STATE_DIR:-\$BUNDLE_ROOT\/run\}"/u);
      assert.match(programCommon, /LOG_DIR="\$\{SERVICE_LOG_DIR:-\$RUN_DIR\}"/u);
      if (serviceId !== "agent-webclient") {
        assert.match(programCommon, /SERVICE_DATA_DIR/u, `${serviceId} should read SERVICE_DATA_DIR`);
      }
    }

    if (serviceId === "agent-platform" && !assetPath.endsWith(".zip")) {
      assert.match(programCommon, /CONFIG_DIR="\$\{SERVICE_CONFIG_DIR:-\$BUNDLE_ROOT\}\/configs"/u);
    }
    if (serviceId === "agent-container-hub" && !assetPath.endsWith(".zip")) {
      assert.match(programCommon, /CONFIG_ENV_DIR="\$\{SERVICE_CONFIG_DIR:-\$BUNDLE_ROOT\}\/configs\/environments"/u);
    }
  }
});

test("validateBundleArchive rejects Desktop-ready agent-webclient bundles with stale launcher checks", () => {
  const { service: discoveredService } = getWorkspaceAsset("agent-webclient", currentManifestOs());
  const requiredBundleEntries = [
    "backend/server.cjs",
    "start.sh",
    "stop.sh",
    "deploy.sh",
    "scripts/program-common.sh",
    ".env.example",
    "manifest.json",
    "frontend/dist/index.html"
  ];
  const service = {
    ...discoveredService,
    requiredBundleEntries
  };

  const fixture = createTarBundle(service, {
    "backend/server.cjs": [
      "const http = require('http');",
      "const server = http.createServer();",
      "function createWebSocketProxy() {",
      "  return { upgrade(req, socket, head) { proxy.upgrade(req, socket, head); } };",
      "}",
      "const proxy = createWebSocketProxy();",
      "server.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head));"
    ].join("\n") + "\n",
    "frontend/dist/index.html": "<!doctype html><html></html>\n",
    "start.sh": "#!/usr/bin/env bash\nexit 0\n",
    "stop.sh": "#!/usr/bin/env bash\nexit 0\n",
    "deploy.sh": "#!/usr/bin/env bash\nexit 0\n",
    "scripts/program-common.sh": [
      "#!/usr/bin/env bash",
      "BACKEND_ENTRY=\"$BUNDLE_ROOT/backend/server.cjs\"",
      "BACKEND_PACKAGE_FILE=\"$BUNDLE_ROOT/backend/package.json\"",
      "BACKEND_NODE_MODULES_DIR=\"$BUNDLE_ROOT/backend/node_modules\""
    ].join("\n") + "\n",
    ".env.example": "PORT=11948\n# DESKTOP_APP=true\n",
    "manifest.json": JSON.stringify({
      id: "agent-webclient",
      kind: "builtin",
      version: "v0.1.0",
      backend: {
        entry: "backend/server.cjs"
      },
      runtime: {
        requiredPaths: requiredBundleEntries
      },
      desktop: {
        bundleTopLevelDir: service.bundleTopLevelDir,
        envBindings: [
          {
            key: "BASE_URL",
            value: "http://127.0.0.1:11949"
          },
          {
            key: "WS_BASE_URL",
            value: "http://127.0.0.1:11949"
          }
        ]
      }
    })
  });

  assert.throws(
    () => validateBundleArchive(service, fixture.tarPath),
    /stale launcher runtime check/
  );

  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("validateBundleArchive rejects Desktop-ready agent-webclient bundles with absolute backend entry", () => {
  const { service: discoveredService } = getWorkspaceAsset("agent-webclient", currentManifestOs());
  const requiredBundleEntries = [
    "backend/server.cjs",
    "start.sh",
    "stop.sh",
    "deploy.sh",
    "scripts/program-common.sh",
    ".env.example",
    "manifest.json",
    "frontend/dist/index.html"
  ];
  const service = {
    ...discoveredService,
    requiredBundleEntries
  };

  const fixture = createTarBundle(service, {
    "backend/server.cjs": [
      "const http = require('http');",
      "const server = http.createServer();",
      "function createWebSocketProxy() {",
      "  return { upgrade(req, socket, head) { proxy.upgrade(req, socket, head); } };",
      "}",
      "const proxy = createWebSocketProxy();",
      "server.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head));"
    ].join("\n") + "\n",
    "frontend/dist/index.html": "<!doctype html><html></html>\n",
    "start.sh": "#!/usr/bin/env bash\nexit 0\n",
    "stop.sh": "#!/usr/bin/env bash\nexit 0\n",
    "deploy.sh": "#!/usr/bin/env bash\nexit 0\n",
    "scripts/program-common.sh": "#!/usr/bin/env bash\nBACKEND_ENTRY=\"/backend/server.cjs\"\n",
    ".env.example": "PORT=11948\n# DESKTOP_APP=true\n",
    "manifest.json": JSON.stringify({
      id: "agent-webclient",
      kind: "builtin",
      version: "v0.1.0",
      backend: {
        entry: "backend/server.cjs"
      },
      runtime: {
        requiredPaths: requiredBundleEntries
      },
      desktop: {
        bundleTopLevelDir: service.bundleTopLevelDir,
        envBindings: [
          {
            key: "BASE_URL",
            value: "http://127.0.0.1:11949"
          },
          {
            key: "WS_BASE_URL",
            value: "http://127.0.0.1:11949"
          }
        ]
      }
    })
  });

  assert.throws(
    () => validateBundleArchive(service, fixture.tarPath),
    /Expected agent-webclient\/scripts\/program-common\.sh to launch \$BUNDLE_ROOT\/backend\/server\.cjs/
  );

  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("actual synced agent-platform asset includes required entries", () => {
  const { service, assetPath } = getSyncedAsset("agent-platform");
  validateBundleArchive(service, assetPath);

  const entries = listArchiveEntries(assetPath);
  if (assetPath.endsWith(".zip")) {
    assert.ok(entries.has("agent-platform/start.ps1"));
    assert.ok(entries.has("agent-platform/stop.ps1"));
    assert.ok(entries.has("agent-platform/backend/agent-platform.exe"));
  } else {
    assert.ok(entries.has("agent-platform/start.sh"));
    assert.ok(entries.has("agent-platform/stop.sh"));
    assert.ok(entries.has("agent-platform/backend/agent-platform"));
  }
  assert.ok(entries.has("agent-platform/configs/channels.example.yml"));
  assert.ok(entries.has("agent-platform/configs/coder-settings.example.yml"));
  assert.ok(entries.has("agent-platform/configs/local-public-key.example.pem"));
  const manifest = readManifestFromArchive(assetPath);
  assert.deepEqual(
    manifest.configFiles?.map?.((entry) => entry.key),
    ["env", "runtime", "host-tools", "ai-tools", "channels", "coder-settings", "local-public-key", "prompts"]
  );
});

test("actual synced agent-platform asset no longer bundles the local relay", () => {
  const { assetPath } = getSyncedAsset("agent-platform");
  const manifest = readManifestFromArchive(assetPath);
  const programCommonName = assetPath.endsWith(".zip") ? "program-common.ps1" : "program-common.sh";
  const programCommon = readArchiveEntryText(assetPath, `agent-platform/scripts/${programCommonName}`);
  const envExample = readArchiveEntryText(assetPath, "agent-platform/.env.example");
  const entries = listArchiveEntries(assetPath);

  assert.ok(programCommon, `expected bundled agent-platform ${programCommonName} to be readable`);
  assert.ok(envExample, "expected bundled agent-platform .env.example to be readable");
  assert.equal([...entries].some((entry) => entry.includes("local-cli-acp-relay")), false);
  assert.doesNotMatch(programCommon, /LOCAL_CLI_ACP_RELAY_/);
  assert.doesNotMatch(envExample, /LOCAL_CLI_ACP_RELAY_|CLAUDE_CODE_ACP_|^HOST_PORT=/m);
  assert.match(envExample, /^SERVER_PORT=/m);
  assert.ok(
    Array.isArray(manifest?.desktop?.envBindings),
    "expected bundled agent-platform manifest to declare desktop env bindings"
  );
  const disallowedLegacyEnvBindings = new Set([
    "HOST_PORT",
    "AGENT_WS_ENABLED",
    "AGENT_CONTAINER_HUB_BASE_URL",
    "AGENT_AUTH_ENABLED",
    "AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE",
    "AUTH_LOCAL_PUBLIC_KEY_FILE"
  ]);
  assert.ok(
    manifest.desktop.envBindings.every(
      (binding) => typeof binding?.key === "string" && !disallowedLegacyEnvBindings.has(binding.key)
    ),
    "expected bundled agent-platform manifest to avoid legacy desktop env bindings"
  );
});

test("validateBundleArchive fails when required entries are missing", () => {
  const service = findBuiltinServiceForCurrentPlatform("agent-platform");

  const fixture = createTarBundle(service, {
    ".env.example": "SERVER_PORT=11949\n",
    "README.txt": "broken bundle\n"
  });

  assert.throws(
    () => validateBundleArchive(service, fixture.tarPath),
    /Missing required entries: .*(start\.sh|start\.ps1)/
  );

  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("validateBundleArchive rejects legacy agent-platform bundles that still embed relay assets", () => {
  const service = findBuiltinServiceForCurrentPlatform("agent-platform");

  const mockFiles = {
    "local-cli-acp-relay/relay.mjs": "console.log('relay');\n",
    ".env.example": "# LOCAL_CLI_ACP_RELAY_ENABLED=true\n",
    "configs/container-hub.example.yml": "containerHub: {}\n",
    "runtime/registries/providers/.keep": "\n",
    "manifest.json": JSON.stringify({
      id: "agent-platform",
      kind: "builtin",
      version: "v0.1.1",
      runtime: {
        requiredPaths: service.requiredBundleEntries
      },
      desktop: {
        bundleTopLevelDir: service.bundleTopLevelDir,
        envBindings: [
          {
            key: "AGENT_AUTH_ENABLED",
            value: "true"
          }
        ]
      }
    })
  };

  for (const entry of service.requiredBundleEntries) {
    if ((path.extname(entry) !== "" || entry.startsWith("backend/")) && !mockFiles[entry]) {
      mockFiles[entry] = "mock content\n";
    }
  }

  const fixture = createTarBundle(service, mockFiles);

  assert.throws(
    () => validateBundleArchive(service, fixture.tarPath),
    /legacy desktop env binding|legacy relay residue/
  );

  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("validateBundleArchive accepts zip bundles", () => {
  const service = {
    id: "agent-container-hub",
    bundleTopLevelDir: "agent-container-hub",
    requiredBundleEntries: [
      "backend/agent-container-hub.exe",
      "start.ps1",
      "stop.ps1",
      "deploy.ps1",
      "scripts/program-common.ps1",
      ".env.example",
      "manifest.json",
      "configs/environments"
    ]
  };

  const fixture = createZipBundle(service, {
    "backend/agent-container-hub.exe": "binary\n",
    "start.ps1": "Write-Host start\n",
    "stop.ps1": "Write-Host stop\n",
    "deploy.ps1": "Write-Host deploy\n",
    ".env.example": "BIND_ADDR=127.0.0.1:11960\n",
    "manifest.json": JSON.stringify({
      id: "agent-container-hub",
      kind: "builtin",
      version: "v0.1.0",
      runtime: {
        requiredPaths: service.requiredBundleEntries
      },
      desktop: {
        bundleTopLevelDir: service.bundleTopLevelDir
      }
    }),
    "configs/environments/example.yml": "name: example\n",
    "scripts/program-common.ps1": "Write-Host common\n"
  });

  validateBundleArchive(service, fixture.zipPath);
  const entries = listArchiveEntries(fixture.zipPath);
  assert.ok(entries.has("agent-container-hub/start.ps1"));
  assert.ok(entries.has("agent-container-hub/backend/agent-container-hub.exe"));

  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("ZENMIND_BUILTIN_ASSETS_SOURCE overrides workspace fallback and syncs builtin assets", () => {
  const workspaceRoot = path.resolve(desktopProjectRoot, "..");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-source-"));
  const serviceId = `builtin-env-priority-${Date.now()}`;
  const version = "v9.9.9";
  const platform = {
    os: `${serviceId}-os`,
    arch: `${serviceId}-arch`
  };
  const fallbackAssetFileName = `${serviceId}-${version}-expected.tar.gz`;
  const fallbackArchivePath = path.join(workspaceRoot, fallbackAssetFileName);
  const sourceRoot = path.join(tempRoot, "source");
  const sourceArchivePath = path.join(sourceRoot, serviceId, `${serviceId}-${version}-env.tar.gz`);
  const projectRoot = path.join(tempRoot, "project");

  writeBuiltinTarArchive({
    archivePath: fallbackArchivePath,
    id: serviceId,
    version,
    os: platform.os,
    arch: platform.arch,
    assetFileName: fallbackAssetFileName
  });
  writeBuiltinTarArchive({
    archivePath: sourceArchivePath,
    id: serviceId,
    version,
    os: platform.os,
    arch: platform.arch,
    assetFileName: fallbackAssetFileName
  });

  try {
    const fallbackServices = withEnv(BUILTIN_ASSETS_SOURCE_ENV, null, () =>
      discoverBuiltinServices(platform)
    );
    assert.equal(fallbackServices.length, 1);
    assert.equal(fallbackServices[0].sourceDir, workspaceRoot);
    assert.equal(fallbackServices[0].assetFileName, fallbackAssetFileName);

    const configuredServices = withEnv(BUILTIN_ASSETS_SOURCE_ENV, sourceRoot, () =>
      discoverBuiltinServices(platform)
    );
    assert.equal(configuredServices.length, 1);
    assert.equal(configuredServices[0].sourceDir, path.dirname(sourceArchivePath));
    assert.equal(configuredServices[0].assetFileName, path.basename(sourceArchivePath));

    const syncedManifest = withEnv(BUILTIN_ASSETS_SOURCE_ENV, sourceRoot, () =>
      syncBuiltinAssets(projectRoot, platform)
    );
    assert.deepEqual(syncedManifest, [
      {
        id: serviceId,
        version,
        assetFileName: path.basename(sourceArchivePath),
        assetSignature: computeAssetSignature(sourceArchivePath)
      }
    ]);

    const outputRoot = path.join(projectRoot, "build", "resources", "services");
    const outputArchivePath = path.join(outputRoot, serviceId, path.basename(sourceArchivePath));
    const outputManifest = JSON.parse(
      fs.readFileSync(path.join(outputRoot, "manifest.json"), "utf8")
    );
    assert.equal(outputManifest.services.length, 1);
    assert.deepEqual(outputManifest.services, syncedManifest);
    assert.equal(outputManifest.services[0].assetSignature, computeAssetSignature(outputArchivePath));
    assert.ok(fs.existsSync(outputArchivePath));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(fallbackArchivePath, { force: true });
  }
});

test("syncBuiltinAssets fails with an actionable error when required Desktop core assets are missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-missing-core-"));
  const sourceRoot = path.join(tempRoot, "source");
  const projectRoot = path.join(tempRoot, "project");
  const platform = {
    os: currentManifestOs(),
    arch: `missing-core-${Date.now()}`
  };

  for (const serviceId of ["zenmind-app-server", "agent-platform"]) {
    writeBuiltinTarArchive({
      archivePath: path.join(sourceRoot, serviceId, `${serviceId}-v1.0.0-${platform.os}-${platform.arch}.tar.gz`),
      id: serviceId,
      version: "v1.0.0",
      os: platform.os,
      arch: platform.arch,
      assetFileName: `${serviceId}-v1.0.0-${platform.os}-${platform.arch}.tar.gz`
    });
  }

  try {
    assert.throws(
      () => withEnv(BUILTIN_ASSETS_SOURCE_ENV, sourceRoot, () => syncBuiltinAssets(projectRoot, platform)),
      /missing required Desktop builtin service assets[\s\S]*agent-webclient[\s\S]*ZENMIND_BUILTIN_ASSETS_SOURCE/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverBuiltinServices keeps only the newest version per service and platform", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-latest-"));
  const sourceRoot = path.join(tempRoot, "source");
  const serviceDir = path.join(sourceRoot, "latest-only-service");
  const platform = {
    os: "latest-only-os",
    arch: "latest-only-arch"
  };

  writeBuiltinTarArchive({
    archivePath: path.join(serviceDir, "latest-only-service-v0.1.0.tar.gz"),
    id: "latest-only-service",
    version: "v0.1.0",
    os: platform.os,
    arch: platform.arch,
    assetFileName: "latest-only-service-v0.1.0.tar.gz"
  });
  writeBuiltinTarArchive({
    archivePath: path.join(serviceDir, "latest-only-service-v0.2.0.tar.gz"),
    id: "latest-only-service",
    version: "v0.2.0",
    os: platform.os,
    arch: platform.arch,
    assetFileName: "latest-only-service-v0.2.0.tar.gz"
  });

  try {
    const services = withEnv(BUILTIN_ASSETS_SOURCE_ENV, sourceRoot, () =>
      discoverBuiltinServices(platform)
    );
    assert.equal(services.length, 1);
    assert.equal(services[0].version, "v0.2.0");
    assert.equal(services[0].assetFileName, "latest-only-service-v0.2.0.tar.gz");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
