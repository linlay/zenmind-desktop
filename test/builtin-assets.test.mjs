import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();

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

function writeDarwinCoreServiceArchive(sourceRoot, id, {
  includeAgentPlatformRuntime = true,
  requireAgentPlatformRuntime = true,
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
        "      --output-dir|--data-dir|--state-dir|--log-dir|--bind-addr) shift 2 ;;",
        "      --config-dir|--daemon) echo 'start/runtime argument' >&2; exit 1 ;;",
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
    writeText(path.join(bundleRoot, ".env.example"), "DESKTOP_APP=true\nBASE_URL=http://127.0.0.1:11949\n");
    writeText(
      path.join(bundleRoot, "deploy.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "while [[ $# -gt 0 ]]; do",
        "  case \"$1\" in",
        "    --output-dir|--base-url|--port) shift 2 ;;",
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
    manifest.desktop.envBindings = [
      {
        key: "BASE_URL",
        value: "http://127.0.0.1:11949"
      }
    ];
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
    "#!/usr/bin/env bash\nprogram_apply_layout_args \"$@\"\n"
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
    /agent-container-hub[\s\S]*(Missing lifecycle contract marker "--output-dir"|program_apply_layout_args)/u
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
