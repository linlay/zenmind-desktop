import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// monorepo 根目录：zenmind-desktop 的上一级
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const BUILTIN_ASSETS_SOURCE_ENV = "ZENMIND_BUILTIN_ASSETS_SOURCE";

function isArchiveFileName(fileName) {
  return fileName.endsWith(".tar.gz") || fileName.endsWith(".zip");
}

function scanArchiveDirectory(dirPath, tryAddArchive) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  for (const asset of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!asset.isFile() || !isArchiveFileName(asset.name)) {
      continue;
    }
    tryAddArchive(path.join(dirPath, asset.name));
  }
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

function canUseUnzip() {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function listArchiveEntries(archivePath) {
  const execOpts = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  const output = isZipArchive(archivePath)
    ? canUseUnzip()
      ? execFileSync("unzip", ["-l", archivePath], execOpts)
      : execFileSync("tar", ["-tf", archivePath], execOpts)
    : execFileSync("tar", ["-tzf", archivePath], execOpts);

  if (isZipArchive(archivePath)) {
    if (!canUseUnzip()) {
      return new Set(
        output
          .split(/\r?\n/u)
          .map((entry) => normalizeTarEntry(entry))
          .filter(Boolean)
      );
    }

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

  const execOpts = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  const manifestContent = isZipArchive(archivePath)
    ? canUseUnzip()
      ? execFileSync("unzip", ["-p", archivePath, manifestEntry], execOpts)
      : execFileSync("tar", ["-xOf", archivePath, manifestEntry], execOpts)
    : execFileSync("tar", ["-xzf", archivePath, "-O", manifestEntry], execOpts);
  return JSON.parse(manifestContent);
}

function listArchivesInDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isArchiveFileName(entry.name))
    .map((entry) => path.join(directoryPath, entry.name));
}

function listConfiguredReleaseArchives(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`${BUILTIN_ASSETS_SOURCE_ENV} does not exist: ${sourceRoot}`);
  }

  if (!fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`${BUILTIN_ASSETS_SOURCE_ENV} must point to a directory: ${sourceRoot}`);
  }

  const archives = [];
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      archives.push(...listArchivesInDirectory(path.join(sourceRoot, entry.name)));
      continue;
    }

    if (entry.isFile() && isArchiveFileName(entry.name)) {
      archives.push(path.join(sourceRoot, entry.name));
    }
  }

  return archives.sort((left, right) => left.localeCompare(right));
}

function listWorkspaceReleaseArchives() {
  const archives = [];

  for (const entry of fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryRoot = path.join(WORKSPACE_ROOT, entry.name);
    archives.push(...listArchivesInDirectory(path.join(entryRoot, "dist", "release")));
    archives.push(...listArchivesInDirectory(entryRoot));

    for (const child of fs.readdirSync(entryRoot, { withFileTypes: true })) {
      if (!child.isDirectory()) {
        continue;
      }

      const childRoot = path.join(entryRoot, child.name);
      archives.push(...listArchivesInDirectory(path.join(childRoot, "dist", "release")));
      archives.push(...listArchivesInDirectory(childRoot));
    }
  }

  for (const entry of fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || !isArchiveFileName(entry.name)) {
      continue;
    }
    archives.push(path.join(WORKSPACE_ROOT, entry.name));
  }

  return archives.sort((left, right) => left.localeCompare(right));
}

function listReleaseArchives() {
  const archivesByBuildKey = new Map();

  function tryAddArchive(archivePath, sourcePreference = 0) {
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
    const archiveDir = path.dirname(archivePath);
    const pathPreference =
      (archivePath.includes(`${path.sep}dist${path.sep}release${path.sep}`) ? 100 : 0) +
      (path.basename(archiveDir) === manifest.id ? 10 : 0);
    const fileNamePreference = path.basename(archivePath) === expectedFileName ? 1 : 0;
    const current = archivesByBuildKey.get(buildKey);
    if (
      !current ||
      sourcePreference > current.sourcePreference ||
      (sourcePreference === current.sourcePreference &&
        pathPreference > current.pathPreference) ||
      (sourcePreference === current.sourcePreference &&
        pathPreference === current.pathPreference &&
        fileNamePreference > current.fileNamePreference)
    ) {
      archivesByBuildKey.set(buildKey, {
        archivePath,
        sourcePreference,
        pathPreference,
        fileNamePreference
      });
    }
  }

  const configuredSourceRoot = process.env[BUILTIN_ASSETS_SOURCE_ENV]?.trim();
  if (configuredSourceRoot) {
    for (const archivePath of listConfiguredReleaseArchives(configuredSourceRoot)) {
      tryAddArchive(archivePath, 2);
    }
  }

  for (const archivePath of listWorkspaceReleaseArchives()) {
    tryAddArchive(archivePath, 1);
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
