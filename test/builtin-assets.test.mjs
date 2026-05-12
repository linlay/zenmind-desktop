import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function ensureSyncedAssets() {
  if (hasSyncedActualAssets) {
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

function getSyncedAsset(serviceId) {
  ensureSyncedAssets();

  const serviceDir = path.join(process.cwd(), "build", "resources", "services", serviceId);
  const assetFileName = fs
    .readdirSync(serviceDir)
    .find((entry) => entry.endsWith(".zip") || entry.endsWith(".tar.gz"));

  assert.ok(assetFileName, `missing synced archive for ${serviceId}`);

  const service = builtinServices.find(
    (item) => item.id === serviceId && item.assetFileName === assetFileName
  );
  assert.ok(service, `missing builtin service metadata for ${serviceId}/${assetFileName}`);

  return {
    service,
    assetPath: path.join(serviceDir, assetFileName)
  };
}

function getWorkspaceAsset(serviceId, osName) {
  const service = builtinServices.find(
    (item) => item.id === serviceId && item.assetFileName.includes(`-${osName}-`)
  );
  assert.ok(service, `missing builtin service metadata for ${serviceId}/${osName}`);
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
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      return process.arch;
  }
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

  const manifest = readManifestFromArchive(assetPath);
  assert.equal(manifest?.backend?.entry, "backend/server.cjs");
  assert.equal(manifest?.frontend?.embedPath, "/appagent");
  assert.equal(manifest?.frontend?.embedParams?.desktopApp, "1");
  const envBindingKeys = Array.isArray(manifest?.desktop?.envBindings)
    ? manifest.desktop.envBindings.map((binding) => binding?.key)
    : [];
  assert.ok(envBindingKeys.includes("BASE_URL"));
  assert.ok(envBindingKeys.includes("WS_BASE_URL"));
});

test("validateBundleArchive rejects Desktop-ready agent-webclient bundles with stale launcher checks", () => {
  const discoveredService = builtinServices.find((item) => item.id === "agent-webclient");
  assert.ok(discoveredService);
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
    ".env.example": "PORT=11948\n",
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
  const discoveredService = builtinServices.find((item) => item.id === "agent-webclient");
  assert.ok(discoveredService);
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
    ".env.example": "PORT=11948\n",
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
    assert.ok(entries.has("agent-platform/backend/agent-platform-runner.exe"));
  } else {
    assert.ok(entries.has("agent-platform/start.sh"));
    assert.ok(entries.has("agent-platform/stop.sh"));
    assert.ok(entries.has("agent-platform/backend/agent-platform-runner"));
  }
});

test("actual synced agent-platform asset no longer bundles the local relay", () => {
  const { assetPath } = getSyncedAsset("agent-platform");
  const manifest = readManifestFromArchive(assetPath);
  const programCommon = readArchiveEntryText(assetPath, "agent-platform/scripts/program-common.sh");
  const envExample = readArchiveEntryText(assetPath, "agent-platform/.env.example");
  const entries = listArchiveEntries(assetPath);

  assert.ok(programCommon, "expected bundled agent-platform program-common.sh to be readable");
  assert.ok(envExample, "expected bundled agent-platform .env.example to be readable");
  assert.equal([...entries].some((entry) => entry.includes("local-cli-acp-relay")), false);
  assert.doesNotMatch(programCommon, /LOCAL_CLI_ACP_RELAY_/);
  assert.doesNotMatch(envExample, /LOCAL_CLI_ACP_RELAY_|CLAUDE_CODE_ACP_/);
  assert.ok(
    Array.isArray(manifest?.desktop?.envBindings),
    "expected bundled agent-platform manifest to declare desktop env bindings"
  );
  const disallowedLegacyEnvBindings = new Set([
    "AGENT_CONTAINER_HUB_BASE_URL",
    "AGENT_AUTH_ENABLED",
    "AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE"
  ]);
  assert.ok(
    manifest.desktop.envBindings.every(
      (binding) => typeof binding?.key === "string" && !disallowedLegacyEnvBindings.has(binding.key)
    ),
    "expected bundled agent-platform manifest to avoid legacy desktop env bindings"
  );
});

test("validateBundleArchive fails when required entries are missing", () => {
  const service = builtinServices.find((item) => item.id === "agent-platform");
  assert.ok(service);

  const fixture = createTarBundle(service, {
    ".env.example": "SERVER_PORT=11949\n",
    "README.txt": "broken bundle\n"
  });

  assert.throws(
    () => validateBundleArchive(service, fixture.tarPath),
    /Missing required entries: .*start\.sh/
  );

  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("validateBundleArchive rejects legacy agent-platform bundles that still embed relay assets", () => {
  const service = builtinServices.find((item) => item.id === "agent-platform");
  assert.ok(service);

  const fixture = createTarBundle(service, {
    "backend/agent-platform-runner": "binary\n",
    "local-cli-acp-relay/relay.mjs": "console.log('relay');\n",
    "start.sh": "#!/usr/bin/env bash\nexit 0\n",
    "stop.sh": "#!/usr/bin/env bash\nexit 0\n",
    "deploy.sh": "#!/usr/bin/env bash\nexit 0\n",
    "scripts/program-common.sh": 'echo legacy relay bundle\n',
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
  });

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
        assetFileName: path.basename(sourceArchivePath)
      }
    ]);

    const outputRoot = path.join(projectRoot, "build", "resources", "services");
    const outputManifest = JSON.parse(
      fs.readFileSync(path.join(outputRoot, "manifest.json"), "utf8")
    );
    assert.equal(outputManifest.services.length, 1);
    assert.deepEqual(outputManifest.services, syncedManifest);
    assert.ok(fs.existsSync(path.join(outputRoot, serviceId, path.basename(sourceArchivePath))));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(fallbackArchivePath, { force: true });
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
