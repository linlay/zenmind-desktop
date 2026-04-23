import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  builtinServices,
  listArchiveEntries,
  validateBundleArchive
} from "../scripts/lib/builtin-assets.mjs";

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
  execFileSync("zip", ["-qr", zipPath, service.bundleTopLevelDir], { cwd: root });
  return { root, zipPath };
}

function getSyncedAsset(serviceId) {
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

test("agent-webclient release asset remains available for manual install", () => {
  const { service, assetPath } = getWorkspaceAsset("agent-webclient", currentManifestOs());
  validateBundleArchive(service, assetPath);

  const entries = listArchiveEntries(assetPath);
  assert.ok(entries.has("agent-webclient/manifest.json"));
  assert.ok(entries.has("agent-webclient/frontend/dist/index.html"));
});

test("synced builtin assets include agent-webclient so assistant entry is available in desktop", () => {
  const { service, assetPath } = getSyncedAsset("agent-webclient");
  validateBundleArchive(service, assetPath);

  const entries = listArchiveEntries(assetPath);
  assert.ok(entries.has("agent-webclient/manifest.json"));
  assert.ok(entries.has("agent-webclient/frontend/dist/index.html"));
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
