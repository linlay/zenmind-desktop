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

function writeDarwinCoreServiceArchive(sourceRoot, id) {
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
    manifest.runtime.requiredPaths.push("backend/agent-container-hub");
  }

  if (id === "agent-platform") {
    fs.mkdirSync(path.join(bundleRoot, "configs"), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, "runtime"), { recursive: true });
    manifest.runtime.requiredPaths.push("configs", "runtime");
    manifest.desktop.capabilities.requires = [
      {
        phase: "preStart",
        capability: "auth.publicKey",
        action: "copyFile",
        target: "configs/local-public-key.pem"
      }
    ];
  }

  if (id === "agent-webclient") {
    writeText(path.join(bundleRoot, "frontend", "dist", "index.html"), "<html></html>\n");
    writeText(path.join(bundleRoot, ".env.example"), "DESKTOP_APP=true\nBASE_URL=http://127.0.0.1:11949\n");
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
    writeText(path.join(bundleRoot, ".env.example"), "FRONTEND_DIST_DIR=./frontend/dist\n");
    writeText(
      path.join(bundleRoot, "scripts", "program-common.sh"),
      "#!/usr/bin/env bash\nFRONTEND_DIST_DIR=\"${FRONTEND_DIST_DIR:-./frontend/dist}\"\nnohup \"$BACKEND_BIN\" >/dev/null 2>&1 &\n"
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
});
