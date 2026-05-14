import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBuiltinServices } = require("../dist-electron/main/builtin-loader.js");
const { listArchiveEntries } = require("../dist-electron/main/archive-utils.js");
const {
  __testInternals: registryInternals,
  getBuiltinService
} = require("../dist-electron/main/service-registry.js");

function createApp(userDataRoot) {
  return {
    isPackaged: false,
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

function quotePowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function createArchive(bundleRoot, archivePath) {
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -LiteralPath ${quotePowerShell(bundleRoot)} -DestinationPath ${quotePowerShell(archivePath)} -Force`
      ],
      { stdio: "pipe" }
    );
    return;
  }

  execFileSync("tar", ["-czf", archivePath, "-C", path.dirname(bundleRoot), path.basename(bundleRoot)]);
}

function writeBundleFiles(bundleRoot, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(bundleRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }
}

function writeServiceArchive(archivePath, manifest, files = {}) {
  const bundleRoot = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `zenmind-builtin-loader-${manifest.platform?.os ?? "generic"}-`)),
    manifest.id
  );
  fs.mkdirSync(bundleRoot, { recursive: true });
  writeBundleFiles(bundleRoot, {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    ...files
  });
  createArchive(bundleRoot, archivePath);
  fs.rmSync(path.dirname(bundleRoot), { recursive: true, force: true });
}

function getCurrentManifestOs() {
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

function getOtherManifestOs() {
  const current = getCurrentManifestOs();
  if (current === "windows") {
    return "linux";
  }
  return "windows";
}

test("loadBuiltinServices skips builtin archives from other platforms", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-loader-test-"));
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  const assetsRoot = path.join(tempRoot, "assets");
  const serviceAssetDir = path.join(assetsRoot, "shared-service");
  const userDataRoot = path.join(tempRoot, "user-data");
  const archiveExtension = process.platform === "win32" ? ".zip" : ".tar.gz";
  const matchedOs = getCurrentManifestOs();
  const otherOs = getOtherManifestOs();
  const matchedArchiveName = `shared-service-a-${matchedOs}${archiveExtension}`;
  const mismatchedArchiveName = `shared-service-z-${otherOs}${archiveExtension}`;

  fs.mkdirSync(serviceAssetDir, { recursive: true });

  writeServiceArchive(path.join(serviceAssetDir, matchedArchiveName), {
    id: "shared-service",
    name: "Shared Service",
    kind: "builtin",
    version: "v1.0.0",
    description: `${matchedOs} build`,
    platform: {
      os: matchedOs,
      arch: "test"
    },
    frontend: {
      mode: "none"
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    }
  });

  writeServiceArchive(path.join(serviceAssetDir, mismatchedArchiveName), {
    id: "shared-service",
    name: "Shared Service",
    kind: "builtin",
    version: "v1.0.0",
    description: `${otherOs} build`,
    platform: {
      os: otherOs,
      arch: "test"
    },
    frontend: {
      mode: "none"
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    }
  });

  process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot;
  registryInternals.clearServices();

  try {
    const loaded = loadBuiltinServices(createApp(userDataRoot));
    const service = getBuiltinService("shared-service");
    const loadedService = loaded.find((item) => item.id === "shared-service");

    assert.ok(loadedService);
    assert.equal(loadedService.description, `${matchedOs} build`);
    assert.equal(loadedService.assetFileName, matchedArchiveName);
    assert.equal(service.description, `${matchedOs} build`);
    assert.equal(service.platform?.os, matchedOs);
  } finally {
    registryInternals.clearServices();
    if (previousAssetsRoot) {
      process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("loadBuiltinServices preserves UTF-8 manifest content from Windows zip archives", { skip: process.platform !== "win32" }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-loader-utf8-"));
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  const assetsRoot = path.join(tempRoot, "assets");
  const serviceAssetDir = path.join(assetsRoot, "utf8-service");
  const archiveName = "utf8-service-windows.zip";
  const archivePath = path.join(serviceAssetDir, archiveName);
  const userDataRoot = path.join(tempRoot, "user-data");

  fs.mkdirSync(serviceAssetDir, { recursive: true });
  writeServiceArchive(
    archivePath,
    {
      id: "utf8-service",
      name: "智能体平台",
      kind: "builtin",
      version: "v1.0.0",
      description: "认证与管理服务",
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
      runtime: {
        requiredPaths: ["manifest.json", "配置/说明.txt"]
      }
    },
    {
      "配置/说明.txt": "支持中文目录\n"
    }
  );

  process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot;
  registryInternals.clearServices();

  try {
    const loaded = loadBuiltinServices(createApp(userDataRoot));
    const service = getBuiltinService("utf8-service");

    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, "智能体平台");
    assert.equal(loaded[0].description, "认证与管理服务");
    assert.equal(service.name, "智能体平台");
    assert.equal(service.description, "认证与管理服务");
  } finally {
    registryInternals.clearServices();
    if (previousAssetsRoot) {
      process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("loadBuiltinServices falls back to installed builtin manifests when synced assets are unavailable", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-loader-installed-"));
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  const assetsRoot = path.join(tempRoot, "empty-assets");
  const userDataRoot = path.join(tempRoot, "user-data");
  const manifestPath = path.join(userDataRoot, "services", "agent-platform", "v1.0.0", "manifest.json");
  const matchedOs = getCurrentManifestOs();

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.mkdirSync(assetsRoot, { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      id: "agent-platform",
      name: "智能体平台",
      kind: "builtin",
      version: "v1.0.0",
      description: "installed fallback",
      platform: {
        os: matchedOs,
        arch: "test"
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
          label: "环境变量",
          relativePath: ".env"
        }
      ],
      runtime: {
        requiredPaths: ["manifest.json"]
      }
    }, null, 2)}\n`,
    "utf8"
  );

  process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot;
  registryInternals.clearServices();

  try {
    const loaded = loadBuiltinServices(createApp(userDataRoot));
    const service = getBuiltinService("agent-platform");

    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, "agent-platform");
    assert.equal(loaded[0].description, "installed fallback");
    assert.equal(service.name, "智能体平台");
    assert.equal(service.configFiles[0].relativePath, ".env");
    assert.ok(service.configFiles.some((configFile) =>
      configFile.key === "prompts" &&
      configFile.relativePath === "configs/prompts.yml" &&
      configFile.templateRelativePath === "configs/prompts.example.yml" &&
      configFile.required === false
    ));
    assert.ok(service.configFiles.some((configFile) =>
      configFile.key === "channels" &&
      configFile.relativePath === "configs/channels.yml" &&
      configFile.templateRelativePath === undefined &&
      configFile.required === false
    ));
  } finally {
    registryInternals.clearServices();
    if (previousAssetsRoot) {
      process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("loadBuiltinServices merges installed builtin manifests for services missing from synced assets", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-loader-partial-installed-"));
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  const assetsRoot = path.join(tempRoot, "assets");
  const userDataRoot = path.join(tempRoot, "user-data");
  const archiveExtension = process.platform === "win32" ? ".zip" : ".tar.gz";
  const matchedOs = getCurrentManifestOs();
  const platformAssetDir = path.join(assetsRoot, "agent-platform");
  const platformArchiveName = `agent-platform-v1.0.0${archiveExtension}`;
  const webclientManifestPath = path.join(userDataRoot, "services", "agent-webclient", "v1.0.0", "manifest.json");

  fs.mkdirSync(platformAssetDir, { recursive: true });
  writeServiceArchive(path.join(platformAssetDir, platformArchiveName), {
    id: "agent-platform",
    name: "智能体平台",
    kind: "builtin",
    version: "v1.0.0",
    description: "synced asset",
    platform: {
      os: matchedOs,
      arch: "test"
    },
    frontend: {
      mode: "none"
    },
    scripts: {
      start: process.platform === "win32" ? "start.ps1" : "start.sh",
      stop: process.platform === "win32" ? "stop.ps1" : "stop.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    }
  });

  fs.mkdirSync(path.dirname(webclientManifestPath), { recursive: true });
  fs.writeFileSync(
    webclientManifestPath,
    `${JSON.stringify({
      id: "agent-webclient",
      name: "智能助理",
      kind: "builtin",
      version: "v1.0.0",
      description: "installed fallback",
      platform: {
        os: matchedOs,
        arch: "test"
      },
      frontend: {
        mode: "service",
        embedPath: "/appagent"
      },
      scripts: {
        start: process.platform === "win32" ? "start.ps1" : "start.sh",
        stop: process.platform === "win32" ? "stop.ps1" : "stop.sh"
      },
      runtime: {
        requiredPaths: ["manifest.json"]
      }
    }, null, 2)}\n`,
    "utf8"
  );

  process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot;
  registryInternals.clearServices();

  try {
    const loaded = loadBuiltinServices(createApp(userDataRoot));
    const platformService = getBuiltinService("agent-platform");
    const webclientService = getBuiltinService("agent-webclient");

    assert.deepEqual(loaded.map((service) => service.id), ["agent-platform", "agent-webclient"]);
    assert.equal(platformService.description, "synced asset");
    assert.equal(platformService.assetFileName, platformArchiveName);
    assert.equal(webclientService.description, "installed fallback");
    assert.equal(webclientService.assetFileName, "");
  } finally {
    registryInternals.clearServices();
    if (previousAssetsRoot) {
      process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
    } else {
      delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("listArchiveEntries preserves UTF-8 zip entry names on Windows", { skip: process.platform !== "win32" }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-archive-utils-utf8-"));
  const archivePath = path.join(tempRoot, "utf8-service.zip");

  try {
    writeServiceArchive(
      archivePath,
      {
        id: "utf8-service",
        name: "UTF-8 Service",
        kind: "builtin",
        version: "v1.0.0",
        description: "UTF-8 entry names",
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
        runtime: {
          requiredPaths: ["manifest.json", "配置/说明.txt"]
        }
      },
      {
        "配置/说明.txt": "支持中文目录\n"
      }
    );

    const entries = listArchiveEntries(archivePath);
    assert.ok(entries.has("utf8-service/配置/说明.txt"));
    assert.ok(entries.has("utf8-service/manifest.json"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
