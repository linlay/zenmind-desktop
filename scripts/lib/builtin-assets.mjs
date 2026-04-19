import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// monorepo 根目录：zenmind-desktop 的上一级
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function pathMtimeMs(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return 0;
  }

  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newest = stats.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    newest = Math.max(newest, pathMtimeMs(path.join(targetPath, entry.name)));
  }
  return newest;
}

export function needsArchiveRefresh(archivePath, sourcePaths) {
  if (!fs.existsSync(archivePath)) {
    return true;
  }

  const archiveMtimeMs = pathMtimeMs(archivePath);
  const sourceMtimeMs = sourcePaths.reduce(
    (newest, sourcePath) => Math.max(newest, pathMtimeMs(sourcePath)),
    0
  );
  return sourceMtimeMs > archiveMtimeMs;
}

function refreshAgentPlatformReleaseArchive({ os, arch } = {}) {
  if (!os || !arch) {
    return;
  }

  const repoRoot = path.join(WORKSPACE_ROOT, "agent-platform");
  const versionPath = path.join(repoRoot, "VERSION");
  const releaseScriptPath = path.join(repoRoot, "scripts", "release-program.sh");
  if (!fs.existsSync(versionPath) || !fs.existsSync(releaseScriptPath)) {
    return;
  }

  const version = fs.readFileSync(versionPath, "utf8").trim();
  const archiveExtension = os === "windows" ? "zip" : "tar.gz";
  const archivePath = path.join(
    repoRoot,
    "dist",
    "release",
    `agent-platform-${version}-${os}-${arch}.${archiveExtension}`
  );
  const sourcePaths = [
    path.join(repoRoot, "VERSION"),
    path.join(repoRoot, "Makefile"),
    path.join(repoRoot, "README.md"),
    path.join(repoRoot, "scripts", "release-program.sh"),
    path.join(repoRoot, "cmd", "agent-platform-runner"),
    path.join(repoRoot, "internal", "app", "app.go"),
    path.join(repoRoot, "internal", "config", "config.go"),
    path.join(repoRoot, "internal", "server", "server.go"),
    path.join(repoRoot, "internal", "server", "handler_query.go"),
    path.join(repoRoot, "internal", "server", "proxy_handler.go"),
    path.join(repoRoot, "internal", "server", "ws_routes.go"),
    path.join(repoRoot, "internal", "ws")
  ];

  if (!needsArchiveRefresh(archivePath, sourcePaths)) {
    return;
  }

  execFileSync("make", ["release-program", `PROGRAM_TARGET_MATRIX=${os}/${arch}`], {
    cwd: repoRoot,
    stdio: "inherit"
  });
}

function refreshKnownReleaseArchives(options = {}) {
  refreshAgentPlatformReleaseArchive(options);
}

function isArchiveFileName(fileName) {
  return fileName.endsWith(".tar.gz") || fileName.endsWith(".zip");
}

function normalizeTarEntry(entry) {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed : trimmed;
}

function isZipArchive(archivePath) {
  return archivePath.toLowerCase().endsWith(".zip");
}

export function listArchiveEntries(archivePath) {
  const output = isZipArchive(archivePath)
    ? execFileSync("unzip", ["-l", archivePath], { encoding: "utf8" })
    : execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" });

  if (isZipArchive(archivePath)) {
    return new Set(
      output
        .split(/\r?\n/u)
        .map((line) => {
          const match = line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/u);
          return match ? normalizeTarEntry(match[1]) : "";
        })
        .filter(Boolean)
    );
  }

  return new Set(
    output
      .split(/\r?\n/u)
      .map((entry) => normalizeTarEntry(entry))
      .filter(Boolean)
  );
}

export function readManifestFromArchive(archivePath) {
  const manifestEntry = [...listArchiveEntries(archivePath)].find(
    (entry) => entry.endsWith("/manifest.json") || entry === "manifest.json"
  );
  if (!manifestEntry) {
    return null;
  }

  const manifestContent = isZipArchive(archivePath)
    ? execFileSync("unzip", ["-p", archivePath, manifestEntry], { encoding: "utf8" })
    : execFileSync("tar", ["-xzf", archivePath, "-O", manifestEntry], {
        encoding: "utf8"
      });
  return JSON.parse(manifestContent);
}

function listReleaseArchives() {
  const archivesByBuildKey = new Map();

  function tryAddArchive(archivePath) {
    let manifest;
    try {
      manifest = readManifestFromArchive(archivePath);
    } catch {
      return;
    }

    if (!manifest || manifest.kind !== "builtin") {
      return;
    }

    const buildKey = [
      manifest.id,
      manifest.version,
      manifest.platform?.os ?? "",
      manifest.platform?.arch ?? ""
    ].join("|");
    const expectedFileName = manifest.desktop?.assetFileName ?? "";
    const preference = path.basename(archivePath) === expectedFileName ? 1 : 0;
    const current = archivesByBuildKey.get(buildKey);
    if (!current || preference > current.preference) {
      archivesByBuildKey.set(buildKey, { archivePath, preference });
    }
  }

  for (const entry of fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const releaseDir = path.join(WORKSPACE_ROOT, entry.name, "dist", "release");
    if (!fs.existsSync(releaseDir)) {
      continue;
    }

    for (const asset of fs.readdirSync(releaseDir, { withFileTypes: true })) {
      if (!asset.isFile() || !isArchiveFileName(asset.name)) {
        continue;
      }
      tryAddArchive(path.join(releaseDir, asset.name));
    }
  }

  for (const entry of fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || !isArchiveFileName(entry.name)) {
      continue;
    }
    tryAddArchive(path.join(WORKSPACE_ROOT, entry.name));
  }

  return [...archivesByBuildKey.values()]
    .map((entry) => entry.archivePath)
    .sort((left, right) => left.localeCompare(right));
}

export function discoverBuiltinServices({ os, arch } = {}) {
  const services = [];

  for (const archivePath of listReleaseArchives()) {
    const manifest = readManifestFromArchive(archivePath);
    if (!manifest || manifest.kind !== "builtin") {
      continue;
    }

    if (os && manifest.platform?.os && manifest.platform.os !== os) {
      continue;
    }
    if (arch && manifest.platform?.arch && manifest.platform.arch !== arch) {
      continue;
    }

    const requiredBundleEntries = Array.isArray(manifest.runtime?.requiredPaths)
      ? manifest.runtime.requiredPaths.filter((entry) => typeof entry === "string" && entry.trim())
      : [];
    if (requiredBundleEntries.length === 0) {
      throw new Error(`builtin manifest missing runtime.requiredPaths: ${archivePath}`);
    }

    services.push({
      id: manifest.id,
      sourceDir: path.dirname(archivePath),
      assetFileName: path.basename(archivePath),
      bundleTopLevelDir: manifest.desktop?.bundleTopLevelDir ?? manifest.id,
      version: manifest.version,
      requiredBundleEntries
    });
  }

  return services;
}

export const builtinServices = discoverBuiltinServices();

export function findMissingBundleEntries(service, entries) {
  return service.requiredBundleEntries.filter((relativePath) => {
    const expectedPath = `${service.bundleTopLevelDir}/${relativePath}`;
    if (entries.has(expectedPath)) {
      return false;
    }
    const normalizedPrefix = expectedPath.endsWith("/") ? expectedPath : `${expectedPath}/`;
    return ![...entries].some((entry) => entry.startsWith(normalizedPrefix));
  });
}

export function validateBundleArchive(service, archivePath) {
  const serviceRoot = path.join(WORKSPACE_ROOT, service.id);
  if (!fs.existsSync(archivePath)) {
    throw new Error(
      `missing builtin asset for ${service.id}: ${archivePath}\n` +
        `Please regenerate the upstream release bundle, for example:\n` +
        `cd ${serviceRoot} && make release-program`
    );
  }

  const entries = listArchiveEntries(archivePath);
  const missingEntries = findMissingBundleEntries(service, entries);
  if (missingEntries.length > 0) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing required entries: ${missingEntries.join(", ")}\n` +
        `Please regenerate the upstream release bundle, for example:\n` +
        `cd ${serviceRoot} && make release-program`
    );
  }
}

export function syncBuiltinAssets(projectRoot = process.cwd(), { os, arch } = {}) {
  const outputRoot = path.join(projectRoot, "build", "resources", "services");
  refreshKnownReleaseArchives({ os, arch });
  const services = discoverBuiltinServices({ os, arch });

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const manifest = services.map((service) => {
    const sourcePath = path.join(service.sourceDir, service.assetFileName);
    validateBundleArchive(service, sourcePath);

    const serviceDir = path.join(outputRoot, service.id);
    fs.mkdirSync(serviceDir, { recursive: true });
    const outputArchivePath = path.join(serviceDir, service.assetFileName);
    fs.copyFileSync(sourcePath, outputArchivePath);
    validateBundleArchive(service, outputArchivePath);

    return {
      id: service.id,
      version: service.version,
      assetFileName: service.assetFileName
    };
  });

  fs.writeFileSync(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), services: manifest }, null, 2)}\n`,
    "utf8"
  );

  return manifest;
}
