import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_SOURCE_ROOT = path.join(WORKSPACE_ROOT, "zenmind-dist");
const SOURCE_ENV = "ZENMIND_BUNDLED_PLUGINS_SOURCE";
const PLUGIN_IDS = ["pan-webclient"];

const platform = {};
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=");
  if (key === "--os") platform.os = value;
  if (key === "--arch") platform.arch = value;
}

function isArchiveFileName(fileName) {
  return fileName.endsWith(".tar.gz") || fileName.endsWith(".zip");
}

function listArchives(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }
  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isArchiveFileName(entry.name))
    .map((entry) => path.join(directoryPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function archiveMatchesPlatform(archivePath, target) {
  const fileName = path.basename(archivePath);
  if (target.os && !fileName.includes(`-${target.os}-`)) {
    return false;
  }
  if (target.arch && !fileName.includes(`-${target.arch}.`)) {
    return false;
  }
  return true;
}

function extractArchive(archivePath, targetDir) {
  if (archivePath.endsWith(".zip")) {
    execFileSync("unzip", ["-q", archivePath, "-d", targetDir]);
    return;
  }
  execFileSync("tar", ["-xzf", archivePath, "-C", targetDir]);
}

function createArchive(bundleRoot, outputArchivePath, targetOs) {
  fs.mkdirSync(path.dirname(outputArchivePath), { recursive: true });
  fs.rmSync(outputArchivePath, { force: true });
  const parentDir = path.dirname(bundleRoot);
  const bundleDirName = path.basename(bundleRoot);
  if (targetOs === "windows") {
    execFileSync("zip", ["-qr", outputArchivePath, bundleDirName], { cwd: parentDir });
    return;
  }
  execFileSync("tar", ["-czf", outputArchivePath, "-C", parentDir, bundleDirName]);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildPanManifest(rawManifest, targetOs) {
  const isWindows = targetOs === "windows";
  const executable = isWindows ? "pan-api.exe" : "pan-api";
  const startScript = isWindows ? "release-scripts/windows/start.ps1" : "start.sh";
  const stopScript = isWindows ? "release-scripts/windows/stop.ps1" : "stop.sh";

  return {
    ...rawManifest,
    kind: "plugin",
    frontend: {
      mode: "standalone",
      entry: "/",
      directAccess: true,
      hostManaged: false
    },
    backend: {
      entry: executable
    },
    scripts: {
      start: startScript,
      stop: stopScript
    },
    runtime: {
      ...rawManifest.runtime,
      requiredPaths: [
        "manifest.json",
        ".env.example",
        executable,
        startScript,
        stopScript,
        "frontend/dist/index.html"
      ]
    }
  };
}

function normalizePluginBundle(bundleRoot, targetOs) {
  const manifestPath = path.join(bundleRoot, "manifest.json");
  const legacyManifestPath = path.join(bundleRoot, "plugin-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    if (manifest.kind !== "plugin") {
      manifest.kind = "plugin";
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
    return manifest;
  }

  if (!fs.existsSync(legacyManifestPath)) {
    throw new Error(`plugin bundle missing manifest: ${bundleRoot}`);
  }

  const legacyManifest = readJson(legacyManifestPath);
  const manifest = legacyManifest.id === "pan-webclient"
    ? buildPanManifest(legacyManifest, targetOs)
    : { ...legacyManifest, kind: "plugin" };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function syncPluginArchive(sourceArchivePath, outputRoot, targetOs) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-plugin-sync-"));
  try {
    extractArchive(sourceArchivePath, tempRoot);
    const entries = fs.readdirSync(tempRoot).filter((entry) => !entry.startsWith("__MACOSX"));
    if (entries.length !== 1) {
      throw new Error(`plugin archive should contain one top-level directory: ${sourceArchivePath}`);
    }

    const bundleRoot = path.join(tempRoot, entries[0]);
    const manifest = normalizePluginBundle(bundleRoot, targetOs);
    const extension = targetOs === "windows" ? ".zip" : ".tar.gz";
    const outputArchivePath = path.join(
      outputRoot,
      manifest.id,
      `${manifest.id}-${manifest.version}-${targetOs}-${platform.arch}${extension}`
    );
    createArchive(bundleRoot, outputArchivePath, targetOs);
    return outputArchivePath;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function syncBundledPlugins(projectRoot = process.cwd(), target = platform) {
  const sourceRoot = process.env[SOURCE_ENV]?.trim() || DEFAULT_SOURCE_ROOT;
  const outputRoot = path.join(projectRoot, "build", "resources", "plugins");
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const synced = [];
  for (const pluginId of PLUGIN_IDS) {
    const sourceDir = path.join(sourceRoot, pluginId);
    const archive = listArchives(sourceDir).find((candidate) => archiveMatchesPlatform(candidate, target));
    if (!archive) {
      throw new Error(`missing bundled plugin archive for ${pluginId} (${target.os}/${target.arch}) in ${sourceDir}`);
    }
    synced.push(syncPluginArchive(archive, outputRoot, target.os));
  }

  return synced;
}

const synced = syncBundledPlugins();
console.log(`synced ${synced.length} bundled plugin asset${synced.length === 1 ? "" : "s"}${platform.os ? ` (${platform.os}/${platform.arch ?? "*"})` : ""}`);
