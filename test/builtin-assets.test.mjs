import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

test("dist:mac validates existing builtin assets instead of scanning workspace releases", () => {
  const distMacScript = fs.readFileSync(path.join(projectRoot, "scripts", "dist-mac.mjs"), "utf8");

  assert.match(
    distMacScript,
    /const syncBuiltinAssetArgs = \[\s*"(\.\/)?scripts\/sync-builtin-assets\.mjs",\s*"--use-existing",\s*"--os=darwin",\s*"--arch=arm64"\s*\]/u
  );
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeBuiltinArchive(sourceRoot, id, { os: targetOs = "darwin", arch = "arm64" } = {}) {
  const version = "v999.0.0";
  const assetFileName = `${id}-${version}-${targetOs}-${arch}.tar.gz`;
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zenmind-${id}-archive-`));
  const bundleRoot = path.join(stagingRoot, id);
  fs.mkdirSync(bundleRoot, { recursive: true });
  writeJson(path.join(bundleRoot, "manifest.json"), {
    kind: "builtin",
    id,
    name: id,
    version,
    platform: {
      os: targetOs,
      arch
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    },
    desktop: {
      assetFileName,
      bundleTopLevelDir: id
    }
  });

  const archivePath = path.join(sourceRoot, assetFileName);
  fs.mkdirSync(sourceRoot, { recursive: true });
  execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, id]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  return archivePath;
}

function createAuthCapabilityProviders() {
  return [
    {
      id: "auth.publicKey",
      darwinCommand: ["scripts/setup-public-key.sh"],
      output: "file",
      outputPath: "{{provider.dataDir}}/keys/publicKey.pem",
      retryOnSqliteBusy: true
    },
    {
      id: "auth.accessToken",
      darwinCommand: ["scripts/issue-bridge-access-token.sh"],
      output: "stdoutLastLine",
      dependsOn: ["auth.publicKey"],
      retryOnSqliteBusy: true,
      validateJwtDeviceId: true,
      allowDeviceIdFallback: true
    }
  ];
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function writeZipArchive(archivePath, entries) {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
}

function writeDarwinCoreServiceArchive(sourceRoot, id, {
  includeAgentPlatformRuntime = true,
  requireAgentPlatformRuntime = true,
  includeAgentPlatformSidecar = true,
  requireAgentPlatformSidecar = true,
  agentPlatformProgramCommon = [
    "#!/usr/bin/env bash",
    "program_sync_deploy_env_values() {",
    "  program_set_env_value \"$ENV_FILE\" \"AP_RUNTIME_DIR\" \"$DEPLOY_AP_RUNTIME_DIR\"",
    "  program_set_env_value \"$ENV_FILE\" \"AP_CONTAINER_HUB_BASE_URL\" \"$DEPLOY_CONTAINER_HUB_BASE_URL\"",
    "}",
    "program_apply_deploy_flags() {",
    "  while [[ $# -gt 0 ]]; do",
    "    case \"$1\" in",
    "      --public-key-source-file) shift 2 ;;",
    "      --desktop-config-reset) shift ;;",
    "      --desktop-config-backup-dir|--desktop-version-from|--desktop-version-to) shift 2 ;;",
    "      *) shift ;;",
    "    esac",
    "  done",
    "}"
  ].join("\n") + "\n"
} = {}) {
  const version = "v999.0.0";
  const assetFileName = `${id}-${version}-darwin-arm64.tar.gz`;
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zenmind-${id}-darwin-core-`));
  const bundleRoot = path.join(stagingRoot, id);
  const manifest = {
    kind: "builtin",
    id,
    name: id,
    version,
    platform: {
      os: "darwin",
      arch: "arm64"
    },
    frontend: {
      mode: "none"
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh",
      deploy: "deploy.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json", ".env.example", "scripts/program-common.sh"]
    },
    web: {
      routePath: "",
      portEnvKey: "PORT",
      defaultPort: 0
    },
    desktop: {
      assetFileName,
      bundleTopLevelDir: id,
      capabilities: {
        provides: [],
        requires: []
      }
    }
  };

  writeText(path.join(bundleRoot, "start.sh"), "#!/usr/bin/env bash\n");
  writeText(path.join(bundleRoot, "stop.sh"), "#!/usr/bin/env bash\n");
  writeText(path.join(bundleRoot, "deploy.sh"), "#!/usr/bin/env bash\n");
  writeText(path.join(bundleRoot, ".env.example"), "PORT=0\n");
  writeText(path.join(bundleRoot, "scripts", "program-common.sh"), "#!/usr/bin/env bash\n");

  if (id === "agent-container-hub") {
    writeText(path.join(bundleRoot, "backend", "agent-container-hub"), "fixture\n");
    writeText(
      path.join(bundleRoot, "deploy.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "program_apply_deploy_args() {",
        "  while [[ $# -gt 0 ]]; do",
        "    case \"$1\" in",
        "      --output-dir) shift 2 ;;",
        "      --desktop-config-reset) shift ;;",
        "      --desktop-config-backup-dir|--desktop-version-from|--desktop-version-to) shift 2 ;;",
        "      --config-dir|--data-dir|--state-dir|--log-dir|--bind-addr|--daemon) echo 'start/runtime argument' >&2; exit 1 ;;",
        "      *) echo \"unsupported deploy argument: $1\" >&2; exit 1 ;;",
        "    esac",
        "  done",
        "}",
        "program_apply_deploy_args \"$@\""
      ].join("\n") + "\n"
    );
    manifest.runtime.requiredPaths.push("backend/agent-container-hub");
  }

  if (id === "agent-platform") {
    fs.mkdirSync(path.join(bundleRoot, "configs"), { recursive: true });
    manifest.runtime.requiredPaths.push("configs");
    if (includeAgentPlatformSidecar) {
      writeText(path.join(bundleRoot, "bin", "kbase-lance-engine"), "sidecar fixture\n");
    }
    if (requireAgentPlatformSidecar) {
      manifest.runtime.requiredPaths.push("bin/kbase-lance-engine");
    }
    if (includeAgentPlatformRuntime) {
      fs.mkdirSync(path.join(bundleRoot, "runtime", "registries", "providers"), { recursive: true });
      fs.mkdirSync(path.join(bundleRoot, "runtime", "chats"), { recursive: true });
    }
    if (requireAgentPlatformRuntime) {
      manifest.runtime.requiredPaths.push("runtime");
    }
    writeText(path.join(bundleRoot, "scripts", "program-common.sh"), agentPlatformProgramCommon);
  }

  if (id === "agent-webclient") {
    writeText(path.join(bundleRoot, "frontend", "dist", "index.html"), "<html></html>\n");
    writeText(path.join(bundleRoot, ".env.example"), "# Optional agent-webclient runtime feature flags\n");
    writeText(
      path.join(bundleRoot, "deploy.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "while [[ $# -gt 0 ]]; do",
        "  case \"$1\" in",
        "    --output-dir) shift 2 ;;",
        "    --desktop-config-reset) shift ;;",
        "    --desktop-config-backup-dir|--desktop-version-from|--desktop-version-to) shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done"
      ].join("\n") + "\n"
    );
    manifest.frontend = {
      mode: "standalone",
      hostManaged: true
    };
    manifest.runtime.requiredPaths.push("frontend/dist/index.html");
    manifest.desktop.capabilities.requires = [
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
    ];
  }

  if (id === "identity-center") {
    writeText(path.join(bundleRoot, "frontend", "dist", "index.html"), "<html></html>\n");
    writeText(
      path.join(bundleRoot, "deploy.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "while [[ $# -gt 0 ]]; do",
        "  case \"$1\" in",
        "    --output-dir|--auth-issuer) shift 2 ;;",
        "    --desktop-config-reset) shift ;;",
        "    --desktop-config-backup-dir|--desktop-version-from|--desktop-version-to) shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done"
      ].join("\n") + "\n"
    );
    writeText(
      path.join(bundleRoot, ".env.example"),
      [
        "FRONTEND_PORT=3000",
        "AUTH_ISSUER=https://identity.example.test",
        ""
      ].join("\n")
    );
    writeText(
      path.join(bundleRoot, "scripts", "program-common.sh"),
      "#!/usr/bin/env bash\n"
    );
    manifest.frontend = {
      mode: "standalone"
    };
    manifest.runtime.requiredPaths.push("frontend/dist/index.html");
    manifest.desktop.capabilities.provides = createAuthCapabilityProviders();
  }

  writeJson(path.join(bundleRoot, "manifest.json"), manifest);

  const archivePath = path.join(sourceRoot, assetFileName);
  fs.mkdirSync(sourceRoot, { recursive: true });
  execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, id]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  return archivePath;
}

async function importBuiltinAssetsModule(cacheKey) {
  const moduleUrl = pathToFileURL(path.join(projectRoot, "scripts", "lib", "builtin-assets.mjs"));
  moduleUrl.search = `?cache=${cacheKey}`;
  return import(moduleUrl.href);
}

test("builtin asset readers handle PowerShell ZIP entries without wildcard matches", async (t) => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
  } catch {
    t.skip("requires Info-ZIP unzip");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-windows-backslash-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const archivePath = path.join(tempRoot, "agent-platform-v0.3.18-windows-amd64.zip");
  const manifest = {
    kind: "builtin",
    id: "agent-platform",
    version: "v0.3.18"
  };
  await writeZipArchive(archivePath, {
    "agent-platform\\manifest.json": JSON.stringify(manifest),
    "agent-platform\\builtins.manifest.json": JSON.stringify({ generatedBy: "PowerShell" }),
    "agent-platform\\deploy.ps1": "Write-Output 'agent-platform deploy'\n"
  });

  const { readArchiveEntryText, readManifestFromArchive } = await importBuiltinAssetsModule(`windows-backslash-read-${Date.now()}`);
  assert.deepEqual(readManifestFromArchive(archivePath), manifest);
  assert.equal(
    readArchiveEntryText(archivePath, "agent-platform/deploy.ps1"),
    "Write-Output 'agent-platform deploy'\n"
  );
});

test("syncBuiltinAssets selects the newest PowerShell-style ZIP bundle", async (t) => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
  } catch {
    t.skip("requires Info-ZIP unzip");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-windows-version-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  const id = "windows-backslash-tool";
  const targetOs = "testos";
  const oldArchiveName = `${id}-v0.3.13-${targetOs}-amd64.zip`;
  const newArchiveName = `${id}-v0.3.18-${targetOs}-amd64.zip`;
  const manifestFor = (version, assetFileName) => ({
    kind: "builtin",
    id,
    name: id,
    version,
    platform: { os: targetOs, arch: "amd64" },
    runtime: { requiredPaths: ["manifest.json"] },
    desktop: { assetFileName, bundleTopLevelDir: id }
  });
  await writeZipArchive(path.join(sourceRoot, oldArchiveName), {
    [`${id}/manifest.json`]: JSON.stringify(manifestFor("v0.3.13", oldArchiveName))
  });
  await writeZipArchive(path.join(sourceRoot, newArchiveName), {
    [`${id}\\manifest.json`]: JSON.stringify(manifestFor("v0.3.18", newArchiveName)),
    [`${id}\\builtins.manifest.json`]: JSON.stringify({ generatedBy: "PowerShell" })
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`windows-backslash-sync-${Date.now()}`);
  const services = syncBuiltinAssets(tempRoot, {
    os: targetOs,
    arch: "amd64",
    sourceRoots: [sourceRoot]
  });

  assert.deepEqual(services.map((service) => ({ id: service.id, version: service.version })), [
    { id, version: "v0.3.18" }
  ]);
  assert.equal(
    fs.existsSync(path.join(tempRoot, "build", "resources", "services", id, newArchiveName)),
    true
  );
});

test("syncBuiltinAssets writes brand-neutral service resources and removes legacy brand-scoped services", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-sync-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  const archivePath = writeBuiltinArchive(sourceRoot, "example-desktop-tool", { os: "testos", arch: "arm64" });
  const legacyServicesRoot = path.join(tempRoot, "build", "brands", "cutej", "resources", "services");
  fs.mkdirSync(legacyServicesRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyServicesRoot, "stale.txt"), "stale", "utf8");

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`sync-${Date.now()}`);
  const manifest = syncBuiltinAssets(tempRoot, {
    os: "testos",
    arch: "arm64",
    brandId: "cutej"
  });

  const expectedOutputArchive = path.join(
    tempRoot,
    "build",
    "resources",
    "services",
    "example-desktop-tool",
    path.basename(archivePath)
  );

  assert.deepEqual(manifest.map((service) => service.id), ["example-desktop-tool"]);
  assert.equal(fs.existsSync(expectedOutputArchive), true);
  assert.equal(fs.existsSync(path.join(tempRoot, "build", "resources", "services", "manifest.json")), true);
  assert.equal(fs.existsSync(legacyServicesRoot), false);
});

test("syncBuiltinAssets uses explicit release sources without scanning configured or workspace releases", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-explicit-sources-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoots = [];
  for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
    const sourceRoot = path.join(tempRoot, serviceId, "dist", "release");
    writeDarwinCoreServiceArchive(sourceRoot, serviceId);
    sourceRoots.push(sourceRoot);
  }

  const staleSourceRoot = path.join(tempRoot, "configured-source");
  writeBuiltinArchive(staleSourceRoot, "workspace-leak");
  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = staleSourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`explicit-sources-${Date.now()}`);
  const manifest = syncBuiltinAssets(tempRoot, {
    os: "darwin",
    arch: "arm64",
    sourceRoots
  });

  assert.deepEqual(manifest.map((service) => service.id), [
    "agent-container-hub",
    "agent-platform",
    "agent-webclient",
    "identity-center"
  ]);
  assert.equal(
    fs.existsSync(path.join(tempRoot, "build", "resources", "services", "manifest.json")),
    true
  );
});

test("syncBuiltinAssets expands Darwin builtin service archives into directories", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-darwin-dir-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
    writeDarwinCoreServiceArchive(sourceRoot, serviceId);
  }

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-dir-${Date.now()}`);
  const manifest = syncBuiltinAssets(tempRoot, {
    os: "darwin",
    arch: "arm64",
    brandId: "cutej"
  });
  const servicesRoot = path.join(tempRoot, "build", "resources", "services");

  assert.equal(manifest.every((service) => service.assetType === "directory"), true);
  assert.equal(manifest.some((service) => service.assetFileName.endsWith(".tar.gz")), false);
  for (const service of manifest) {
    const assetPath = path.join(servicesRoot, service.id, service.assetFileName);
    assert.equal(fs.statSync(assetPath).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(assetPath, "manifest.json")), true);
    assert.match(service.assetSignature, /^dir:/u);
    assert.equal(fs.existsSync(path.join(servicesRoot, service.id, `${service.assetFileName}.tar.gz`)), false);
  }

  const platform = manifest.find((service) => service.id === "agent-platform");
  assert.ok(platform);
  assert.equal(
    fs.existsSync(path.join(servicesRoot, "agent-platform", platform.assetFileName, "runtime")),
    true
  );
});

test("syncBuiltinAssets can reuse current project builtin asset directories", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-reuse-current-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
    writeDarwinCoreServiceArchive(sourceRoot, serviceId);
  }

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-reuse-current-${Date.now()}`);
  syncBuiltinAssets(tempRoot, {
    os: "darwin",
    arch: "arm64"
  });

  const staleArchive = path.join(sourceRoot, "agent-container-hub-v999.0.0-darwin-arm64.tar.gz");
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-hub-stale-source-stage-"));
  execFileSync("tar", ["-xzf", staleArchive, "-C", stagingRoot]);
  writeText(
    path.join(stagingRoot, "agent-container-hub", "deploy.sh"),
    [
      "#!/usr/bin/env bash",
      "case \"$1\" in",
      "  --output-dir) shift 2 ;;",
      "esac",
      "program_prepare_runtime_dirs"
    ].join("\n") + "\n"
  );
  execFileSync("tar", ["-czf", staleArchive, "-C", stagingRoot, "agent-container-hub"]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });

  delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  const manifest = syncBuiltinAssets(tempRoot, {
    os: "darwin",
    arch: "arm64",
    useExisting: true
  });

  assert.equal(manifest.every((service) => service.assetType === "directory"), true);
  assert.equal(manifest.some((service) => service.id === "agent-container-hub"), true);
});

test("syncBuiltinAssets use-existing mode does not scan workspace releases", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-use-existing-missing-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-use-existing-missing-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      useExisting: true
    }),
    /missing current Desktop builtin service assets/u
  );
});

test("syncBuiltinAssets use-existing signing refuses existing Darwin archives", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-use-existing-darwin-archive-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  const servicesRoot = path.join(tempRoot, "build", "resources", "services");
  const services = [];
  for (const serviceId of ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"]) {
    const archivePath = writeDarwinCoreServiceArchive(sourceRoot, serviceId);
    const assetFileName = path.basename(archivePath);
    fs.mkdirSync(path.join(servicesRoot, serviceId), { recursive: true });
    fs.copyFileSync(archivePath, path.join(servicesRoot, serviceId, assetFileName));
    services.push({
      id: serviceId,
      version: "v999.0.0",
      assetFileName,
      assetType: "archive",
      assetSignature: "fixture-signature"
    });
  }
  writeJson(path.join(servicesRoot, "manifest.json"), {
    generatedAt: "2026-07-08T00:00:00.000Z",
    services
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-use-existing-archive-sign-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      useExisting: true,
      signDarwin: true
    }),
    /cannot sign existing Darwin builtin archive/u
  );
});

test("syncBuiltinAssets allows agent-container-hub runtime helpers outside deploy scripts", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-hub-start-helpers-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const hubArchive = path.join(sourceRoot, "agent-container-hub-v999.0.0-darwin-arm64.tar.gz");
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-hub-start-helpers-stage-"));
  execFileSync("tar", ["-xzf", hubArchive, "-C", stagingRoot]);
  writeText(
    path.join(stagingRoot, "agent-container-hub", "scripts", "program-common.sh"),
    [
      "#!/usr/bin/env bash",
      "program_prepare_runtime_dirs() {",
      "  mkdir -p \"$DATA_DIR\" \"$RUN_DIR\" \"$LOG_DIR\"",
      "}"
    ].join("\n") + "\n"
  );
  writeText(
    path.join(stagingRoot, "agent-container-hub", "start.sh"),
    [
      "#!/usr/bin/env bash",
      ". \"$(dirname \"$0\")/scripts/program-common.sh\"",
      "program_prepare_runtime_dirs"
    ].join("\n") + "\n"
  );
  execFileSync("tar", ["-czf", hubArchive, "-C", stagingRoot, "agent-container-hub"]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-hub-start-helpers-${Date.now()}`);
  const manifest = syncBuiltinAssets(tempRoot, {
    os: "darwin",
    arch: "arm64",
    brandId: "cutej"
  });

  const hub = manifest.find((service) => service.id === "agent-container-hub");
  assert.ok(hub);
  assert.equal(hub.assetType, "directory");
});

test("syncBuiltinAssets rejects agent-platform archives without required runtime directory", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-platform-no-runtime-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform", {
    includeAgentPlatformRuntime: false,
    requireAgentPlatformRuntime: true
  });
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-no-runtime-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      brandId: "cutej"
    }),
    /Missing required entries: runtime/u
  );
});

test("syncBuiltinAssets rejects agent-platform archives that omit the sidecar contract", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-platform-no-sidecar-contract-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform", {
    includeAgentPlatformSidecar: false,
    requireAgentPlatformSidecar: false
  });
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-no-sidecar-contract-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      brandId: "cutej"
    }),
    /Missing required agent-platform sidecar contract bin\/kbase-lance-engine/u
  );
});

test("syncBuiltinAssets rejects agent-platform archives that declare but omit the sidecar file", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-platform-no-sidecar-file-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform", {
    includeAgentPlatformSidecar: false,
    requireAgentPlatformSidecar: true
  });
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-no-sidecar-file-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      brandId: "cutej"
    }),
    /Missing required entries: bin\/kbase-lance-engine/u
  );
});

test("validateBundleDirectory rejects a Windows agent-platform sidecar without the exe suffix", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-platform-windows-sidecar-"));
  const directoryPath = path.join(tempRoot, "agent-platform");
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  writeText(path.join(directoryPath, "bin", "kbase-lance-engine"), "wrong platform sidecar\n");
  writeJson(path.join(directoryPath, "manifest.json"), {
    kind: "builtin",
    id: "agent-platform",
    version: "v999.0.0",
    platform: { os: "windows", arch: "amd64" },
    runtime: { requiredPaths: ["manifest.json", "bin/kbase-lance-engine"] }
  });

  const { validateBundleDirectory } = await importBuiltinAssetsModule(`windows-sidecar-suffix-${Date.now()}`);
  assert.throws(
    () => validateBundleDirectory({
      id: "agent-platform",
      version: "v999.0.0",
      platform: { os: "windows", arch: "amd64" },
      requiredBundleEntries: ["manifest.json", "bin/kbase-lance-engine"]
    }, directoryPath),
    /Missing required agent-platform sidecar contract bin\/kbase-lance-engine\.exe/u
  );
});

test("syncBuiltinAssets rejects stale agent-platform public key deploy flag", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-platform-stale-key-flag-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform", {
    agentPlatformProgramCommon: [
      "#!/usr/bin/env bash",
      "program_apply_deploy_flags() {",
      "  while [[ $# -gt 0 ]]; do",
      "    case \"$1\" in",
      "      --local-public-key-file) shift 2 ;;",
      "      *) shift ;;",
      "    esac",
      "  done",
      "}"
    ].join("\n") + "\n"
  });
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-stale-key-flag-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      brandId: "cutej"
    }),
    /Detected stale deploy protocol marker "--local-public-key-file"/u
  );
});

test("syncBuiltinAssets rejects identity-center deploy scripts without output-dir support", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-identity-old-deploy-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const oldArchive = path.join(sourceRoot, "identity-center-v999.0.0-darwin-arm64.tar.gz");
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-identity-old-deploy-stage-"));
  execFileSync("tar", ["-xzf", oldArchive, "-C", stagingRoot]);
  writeText(path.join(stagingRoot, "identity-center", "deploy.sh"), "#!/usr/bin/env bash\n# old deploy\n");
  execFileSync("tar", ["-czf", oldArchive, "-C", stagingRoot, "identity-center"]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-identity-old-deploy-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      brandId: "cutej"
    }),
    /identity-center[\s\S]*Missing lifecycle contract marker "--output-dir"/u
  );
});

test("syncBuiltinAssets rejects core deploy scripts without Desktop config reset support", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-missing-config-reset-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const archivePath = path.join(sourceRoot, "identity-center-v999.0.0-darwin-arm64.tar.gz");
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-missing-config-reset-stage-"));
  execFileSync("tar", ["-xzf", archivePath, "-C", stagingRoot]);
  writeText(
    path.join(stagingRoot, "identity-center", "deploy.sh"),
    "#!/usr/bin/env bash\n# supports --output-dir only\n"
  );
  execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, "identity-center"]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    else process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-missing-config-reset-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, { os: "darwin", arch: "arm64", brandId: "cutej" }),
    /identity-center[\s\S]*Missing lifecycle contract marker "--desktop-config-reset"/u
  );
});

test("syncBuiltinAssets rejects agent-container-hub deploy scripts that reuse start layout args", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-hub-old-deploy-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const oldArchive = path.join(sourceRoot, "agent-container-hub-v999.0.0-darwin-arm64.tar.gz");
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-hub-old-deploy-stage-"));
  execFileSync("tar", ["-xzf", oldArchive, "-C", stagingRoot]);
	  writeText(
	    path.join(stagingRoot, "agent-container-hub", "deploy.sh"),
	    [
	      "#!/usr/bin/env bash",
	      "set -euo pipefail",
	      "while [[ $# -gt 0 ]]; do",
	      "  case \"$1\" in",
	      "    --output-dir) config_dir=\"$2\"; shift 2 ;;",
	      "    --desktop-config-reset) shift ;;",
	      "    --desktop-config-backup-dir|--desktop-version-from|--desktop-version-to) shift 2 ;;",
	      "    --data-dir) data_dir=\"$2\"; shift 2 ;;",
	      "    *) shift ;;",
	      "  esac",
	      "done"
	    ].join("\n") + "\n"
	  );
  execFileSync("tar", ["-czf", oldArchive, "-C", stagingRoot, "agent-container-hub"]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-hub-old-deploy-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      brandId: "cutej"
    }),
	    /agent-container-hub[\s\S]*Detected deploy-time start layout argument "--data-dir"/u
	  );
	});

test("syncBuiltinAssets rejects agent-container-hub deploy scripts that prepare runtime dirs", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-hub-runtime-deploy-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const oldArchive = path.join(sourceRoot, "agent-container-hub-v999.0.0-darwin-arm64.tar.gz");
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-hub-runtime-deploy-stage-"));
  execFileSync("tar", ["-xzf", oldArchive, "-C", stagingRoot]);
  writeText(
    path.join(stagingRoot, "agent-container-hub", "deploy.sh"),
    [
      "#!/usr/bin/env bash",
      "case \"$1\" in",
      "  --output-dir) shift 2 ;;",
      "  --desktop-config-reset) shift ;;",
      "  --desktop-config-backup-dir|--desktop-version-from|--desktop-version-to) shift 2 ;;",
      "esac",
      "program_prepare_runtime_dirs"
    ].join("\n") + "\n"
  );
  execFileSync("tar", ["-czf", oldArchive, "-C", stagingRoot, "agent-container-hub"]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-hub-runtime-deploy-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      brandId: "cutej"
    }),
    /agent-container-hub[\s\S]*program_prepare_runtime_dirs/u
  );
});

test("syncBuiltinAssets rejects no-op agent-webclient deploy scripts", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-webclient-noop-deploy-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const oldArchive = path.join(sourceRoot, "agent-webclient-v999.0.0-darwin-arm64.tar.gz");
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webclient-noop-stage-"));
  execFileSync("tar", ["-xzf", oldArchive, "-C", stagingRoot]);
  writeText(
    path.join(stagingRoot, "agent-webclient", "deploy.sh"),
    "#!/usr/bin/env bash\n# Desktop hosts agent-webclient directly; deploy is intentionally a no-op.\n:\n"
  );
  execFileSync("tar", ["-czf", oldArchive, "-C", stagingRoot, "agent-webclient"]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-webclient-noop-deploy-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      brandId: "cutej"
    }),
    /agent-webclient[\s\S]*(Missing lifecycle contract marker "--output-dir"|deploy is intentionally a no-op)/u
  );
});
