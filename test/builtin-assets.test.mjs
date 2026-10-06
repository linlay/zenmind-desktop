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
  includeAgentPlatformRuntimeCapability = true
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
      requiredPaths: ["manifest.json", ".env.example", "start.sh", "stop.sh", "deploy.sh"]
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
    manifest.runtime.requiredPaths.push("backend/agent-container-hub");
  }

  if (id === "agent-platform") {
    if (includeAgentPlatformRuntimeCapability) {
      manifest.desktop.runtimeResources = "v1";
    }
    fs.mkdirSync(path.join(bundleRoot, "configs"), { recursive: true });
    manifest.runtime.requiredPaths.push("configs");
    writeText(path.join(bundleRoot, "backend", "agent-platform"), "main program fixture\n");
    manifest.runtime.requiredPaths.push("backend/agent-platform");
    if (includeAgentPlatformRuntime) {
      fs.mkdirSync(path.join(bundleRoot, "runtime", "registries", "providers"), { recursive: true });
      fs.mkdirSync(path.join(bundleRoot, "runtime", "chats"), { recursive: true });
    }
    if (requireAgentPlatformRuntime) {
      manifest.runtime.requiredPaths.push("runtime");
    }
  }

  if (id === "agent-webclient") {
    writeText(path.join(bundleRoot, "frontend", "dist", "index.html"), "<html></html>\n");
    writeText(path.join(bundleRoot, ".env.example"), "# Optional agent-webclient runtime feature flags\n");
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
    manifest.desktop.hosting = {
      proxyRoutes: [
        {
          match: "prefix",
          path: "/api/voice",
          targetEnv: "VOICE_BASE_URL",
          optional: true,
          http: true,
          websocket: true
        },
        {
          match: "prefix",
          path: "/api",
          targetEnv: "BASE_URL",
          auth: "agent-platform-access-token",
          http: true,
          websocket: false
        }
      ]
    };
  }

  if (id === "identity-center") {
    writeText(path.join(bundleRoot, "frontend", "dist", "index.html"), "<html></html>\n");
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

test("syncBuiltinAssets writes service resources and their index to the shared build directory", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-sync-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  const archivePath = writeBuiltinArchive(sourceRoot, "example-desktop-tool", { os: "testos", arch: "arm64" });

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
    arch: "arm64"
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

test("syncBuiltinAssets rejects agent-platform archives without runtimeResources v1", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-platform-no-resource-capability-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform", {
    includeAgentPlatformRuntimeCapability: false
  });
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  t.after(() => {
    if (previousSource === undefined) delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    else process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
  });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-no-resource-capability-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, { os: "darwin", arch: "arm64", brandId: "cutej" }),
    /agent-platform[\s\S]*desktop\.runtimeResources must be v1/u
  );
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

// Platform can reorganize helpers and lifecycle implementation without a Desktop update.
for (const targetOs of ["darwin", "windows", "linux"]) {
  for (const helpers of [[], ["kbx", "memx"], ["future-helper"]]) {
    test(`Platform ${targetOs} accepts its own component layout: ${helpers.join(",") || "main only"}`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-platform-boundary-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const bundleRoot = path.join(root, "agent-platform");
      const isWindows = targetOs === "windows";
      const suffix = isWindows ? ".exe" : "";
      const scriptSuffix = isWindows ? ".ps1" : ".sh";
      const requiredPaths = [
        "manifest.json", `backend/agent-platform${suffix}`,
        ...["deploy", "start", "stop"].map(name => `${name}${scriptSuffix}`),
        ...helpers.map(name => `bin/${name}${suffix}`)
      ];
      const manifest = {
        kind: "builtin", id: "agent-platform", version: "v999.0.0",
        platform: { os: targetOs, arch: isWindows ? "amd64" : "arm64" },
        desktop: { runtimeResources: "v1", bundleTopLevelDir: "agent-platform" },
        runtime: { requiredPaths }
      };
      for (const entry of requiredPaths) writeText(path.join(bundleRoot, entry), "fixture\n");
      writeJson(path.join(bundleRoot, "manifest.json"), manifest);
      // Neither documentation nor historical strings in private scripts are contracts.
      writeText(path.join(bundleRoot, "README.txt"), "Platform release notes\n");
      writeText(path.join(bundleRoot, "scripts", `program-common${scriptSuffix}`),
        "# --local-public-key-file DEPLOY_LOCAL_PUBLIC_KEY_FILE DeployLocalPublicKeyFile\n");
      const service = { ...manifest, bundleTopLevelDir: "agent-platform", requiredBundleEntries: requiredPaths };
      const { validateBundleArchive, validateBundleDirectory } = await importBuiltinAssetsModule(`boundary-${targetOs}-${helpers.length}`);
      const archivePath = path.join(root, isWindows ? "platform.zip" : "platform.tar.gz");
      const pack = async () => {
        if (isWindows) {
          const entries = {};
          for (const entry of [...requiredPaths, "README.txt", `scripts/program-common${scriptSuffix}`]) {
            const file = path.join(bundleRoot, entry);
            if (fs.existsSync(file)) entries[`agent-platform/${entry}`] = fs.readFileSync(file);
          }
          await writeZipArchive(archivePath, entries);
        } else {
          execFileSync("tar", ["-czf", archivePath, "-C", root, "agent-platform"]);
        }
      };
      await pack();
      assert.doesNotThrow(() => validateBundleArchive(service, archivePath));
      assert.doesNotThrow(() => validateBundleDirectory(service, bundleRoot));

      // The upstream manifest remains authoritative for every target.
      const missingPath = helpers.length ? `bin/${helpers[0]}${suffix}` : `backend/agent-platform${suffix}`;
      fs.rmSync(path.join(bundleRoot, missingPath));
      await pack();
      for (const validate of [
        () => validateBundleArchive(service, archivePath),
        () => validateBundleDirectory(service, bundleRoot)
      ]) {
        assert.throws(validate, error => error.message.includes(`Missing required entries: ${missingPath}`));
      }
    });
  }
}

test("syncBuiltinAssets rejects a legacy Agent WebClient manifest before packaging", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-webclient-bridge-v1-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-container-hub");
  writeDarwinCoreServiceArchive(sourceRoot, "identity-center");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-platform");
  writeDarwinCoreServiceArchive(sourceRoot, "agent-webclient");

  const archivePath = path.join(sourceRoot, "agent-webclient-v999.0.0-darwin-arm64.tar.gz");
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webclient-bridge-v1-stage-"));
  execFileSync("tar", ["-xzf", archivePath, "-C", stagingRoot]);
  const manifestPath = path.join(stagingRoot, "agent-webclient", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.desktop.hosting.proxyRoutes.push({
    match: "exact",
    path: "/ws",
    targetEnv: "BASE_URL",
    http: false,
    websocket: true
  });
  writeJson(manifestPath, manifest);
  execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, "agent-webclient"]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });

  const { syncBuiltinAssets } = await importBuiltinAssetsModule(`darwin-webclient-bridge-v1-${Date.now()}`);
  assert.throws(
    () => syncBuiltinAssets(tempRoot, {
      os: "darwin",
      arch: "arm64",
      sourceRoots: [sourceRoot]
    }),
    /agent-webclient[\s\S]*Frame Port manifest must not expose \/auth or \/ws/u
  );
});

for (const targetOs of ["darwin", "windows"]) {
  for (const id of ["identity-center", "agent-webclient", "agent-container-hub"]) {
    test(`${id} ${targetOs} validates public capabilities without inspecting private components`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-service-boundary-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const source = writeDarwinCoreServiceArchive(root, id);
      const staging = path.join(root, "staging");
      fs.mkdirSync(staging);
      execFileSync("tar", ["-xzf", source, "-C", staging]);
      const bundleRoot = path.join(staging, id);
      const manifestPath = path.join(bundleRoot, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const isWindows = targetOs === "windows";
      manifest.platform = { os: targetOs, arch: isWindows ? "amd64" : "arm64" };
      fs.rmSync(path.join(bundleRoot, "scripts"), { recursive: true });
      for (const name of ["deploy", "start", "stop"]) {
        const file = `${name}${isWindows ? ".ps1" : ".sh"}`;
        if (isWindows) {
          fs.renameSync(path.join(bundleRoot, `${name}.sh`), path.join(bundleRoot, file));
          manifest.runtime.requiredPaths = manifest.runtime.requiredPaths.map(p => p === `${name}.sh` ? file : p);
        }
        writeText(path.join(bundleRoot, file), "# implementation delegated to service-owned code\n");
      }
      writeText(path.join(bundleRoot, "README.txt"), "release notes\n");
      // Even backend-named private files in the host-managed WebClient are not a server declaration.
      const privateFile = "backend/private-resource.txt";
      writeText(path.join(bundleRoot, privateFile), "opaque payload\n");
      manifest.runtime.requiredPaths.push(privateFile);
      if (id === "identity-center") {
        for (const provider of manifest.desktop.capabilities.provides) {
          if (isWindows) {
            provider.windowsCommand = ["auth-provider.ps1"];
            delete provider.darwinCommand;
          }
          delete provider.retryOnSqliteBusy;
          delete provider.allowDeviceIdFallback;
        }
        manifest.desktop.capabilities.provides[0].outputPath = "{{provider.dataDir}}/auth/custom-public.pem";
      }
      const archive = path.join(root, isWindows ? "service.zip" : "service.tar.gz");
      const pack = async () => {
        writeJson(manifestPath, manifest);
        if (isWindows) {
          const entries = {};
          const collect = (dir, relative = id) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const file = path.join(dir, entry.name);
              const key = `${relative}/${entry.name}`;
              if (entry.isDirectory()) collect(file, key);
              else entries[key] = fs.readFileSync(file);
            }
          };
          collect(bundleRoot);
          await writeZipArchive(archive, entries);
        } else {
          execFileSync("tar", ["-czf", archive, "-C", staging, id]);
        }
      };
      const { validateBundleArchive, validateBundleDirectory } = await importBuiltinAssetsModule(`${id}-${targetOs}-public`);
      const service = { ...manifest, bundleTopLevelDir: id, requiredBundleEntries: manifest.runtime.requiredPaths };
      const validators = [
        () => validateBundleArchive(service, archive),
        () => validateBundleDirectory(service, bundleRoot)
      ];
      await pack();
      for (const validate of validators) assert.doesNotThrow(validate);
      fs.rmSync(path.join(bundleRoot, privateFile));
      await pack();
      for (const validate of validators) assert.throws(validate, /Missing required entries: backend\/private-resource.txt/u);
      writeText(path.join(bundleRoot, privateFile), "restored\n");
      if (id === "identity-center") {
        manifest.desktop.capabilities.provides[0][isWindows ? "windowsCommand" : "darwinCommand"] = [];
        await pack();
        for (const validate of validators) assert.throws(validate, /Missing desktop capability provider auth.publicKey/u);
      }
      if (id === "agent-webclient") {
        const originalRoutes = manifest.desktop.hosting.proxyRoutes;
        const apiRoute = originalRoutes.find(route => route.match === "prefix" && route.path === "/api");
        for (const routes of [
          [...originalRoutes, { ...apiRoute }],
          [...originalRoutes, { ...apiRoute, auth: undefined }],
          [{ ...apiRoute, auth: undefined }, ...originalRoutes]
        ]) {
          manifest.desktop.hosting.proxyRoutes = routes;
          await pack();
          for (const validate of validators) assert.throws(validate, /requires exactly one/u);
        }
        manifest.desktop.hosting.proxyRoutes = originalRoutes;
        manifest.frontend.hostManaged = false;
        await pack();
        for (const validate of validators) assert.throws(validate, /Expected frontend.hostManaged/u);
        manifest.frontend.hostManaged = true;
        manifest.desktop.capabilities.requires = [];
        await pack();
        for (const validate of validators) assert.throws(validate, /auth.accessToken preload/u);
      }
    });
  }
}
