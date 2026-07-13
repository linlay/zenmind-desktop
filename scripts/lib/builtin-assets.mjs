import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { desktopBuiltinServicesDir } from "./desktop-resources.mjs";

// monorepo 根目录：当前仓库的上一级
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const BUILTIN_ASSETS_SOURCE_ENV = "DESKTOP_BUILTIN_ASSETS_SOURCE";
const SKIP_MAC_TIMESTAMP_ENV = "DESKTOP_SKIP_MAC_TIMESTAMP";
const REQUIRED_DESKTOP_CORE_SERVICE_IDS = [
  "identity-center",
  "agent-platform",
  "agent-webclient"
];
const DEVELOPER_ID_APPLICATION_PREFIX = "Developer ID Application:";
const DARWIN_CODESIGN_IDENTITY_ENV_KEYS = [
  "DESKTOP_DARWIN_CODESIGN_IDENTITY",
  "MACOS_CODESIGN_IDENTITY",
  "CSC_NAME"
];
const STALE_AGENT_PLATFORM_DEPLOY_PROTOCOL_MARKERS = [
  "--local-public-key-file",
  "DEPLOY_LOCAL_PUBLIC_KEY_FILE",
  "DeployLocalPublicKeyFile"
];
const LIFECYCLE_DEPLOY_PROTOCOLS = {
  "identity-center": {
    required: ["--output-dir"],
    message: "Please rebuild the Desktop-ready identity-center bundle with deploy.sh --output-dir support."
  },
  "agent-container-hub": {
    required: ["--output-dir"],
    forbidden: [
      "program_prepare_runtime_dirs",
      "Prepare-ProgramRuntimeDirs",
      'program_apply_layout_args "$@"',
      "Set-ProgramLayoutArgs $args"
    ],
    message: "Please rebuild the Desktop-ready agent-container-hub bundle with deploy-only --output-dir support."
  },
  "agent-webclient": {
    required: ["--output-dir"],
    forbidden: ["deploy is intentionally a no-op"],
    message: "Please rebuild the Desktop-ready agent-webclient bundle so deploy.sh initializes the host-managed .env."
  }
};
const MACHO_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafed00d,
  0x0dd0feca
]);

function parseBooleanEnv(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be a boolean value`);
  }
}

function shouldSkipMacTimestamp(env = process.env) {
  return (
    parseBooleanEnv(env.SKIP_NOTARIZE, "SKIP_NOTARIZE") === true ||
    parseBooleanEnv(env[SKIP_MAC_TIMESTAMP_ENV], SKIP_MAC_TIMESTAMP_ENV) === true
  );
}

function isArchiveFileName(fileName) {
  return fileName.endsWith(".tar.gz") || fileName.endsWith(".zip");
}

function archiveAssetDirectoryName(fileName) {
  if (fileName.endsWith(".tar.gz")) {
    return fileName.slice(0, -".tar.gz".length);
  }
  if (fileName.endsWith(".tgz")) {
    return fileName.slice(0, -".tgz".length);
  }
  if (fileName.endsWith(".zip")) {
    return fileName.slice(0, -".zip".length);
  }
  return fileName;
}

function isIgnorableDirectoryReadError(error) {
  return error &&
    typeof error === "object" &&
    ["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(error.code);
}

function readDirectoryEntries(directoryPath, { optional = false } = {}) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (optional && isIgnorableDirectoryReadError(error)) {
      return [];
    }
    throw error;
  }
}

function cleanupLegacyBrandScopedServiceAssets(projectRoot) {
  const brandsRoot = path.join(projectRoot, "build", "brands");
  if (!fs.existsSync(brandsRoot)) {
    return;
  }

  for (const brandEntry of readDirectoryEntries(brandsRoot, { optional: true })) {
    if (!brandEntry.isDirectory()) {
      continue;
    }
    fs.rmSync(path.join(brandsRoot, brandEntry.name, "resources", "services"), {
      recursive: true,
      force: true
    });
  }
}

function listRegularFiles(rootDir) {
  const result = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      result.push(currentPath);
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of readDirectoryEntries(currentPath)) {
        stack.push(path.join(currentPath, entry.name));
      }
      continue;
    }
    if (stat.isFile()) {
      result.push(currentPath);
    }
  }

  return result.sort((left, right) => left.localeCompare(right));
}

function computeFileAssetSignature(assetPath) {
  const stat = fs.statSync(assetPath);
  const sha256 = createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
  return `${stat.size}:${sha256}`;
}

function computeDirectoryAssetSignature(assetPath) {
  const hash = createHash("sha256");
  let totalSize = 0;
  for (const filePath of listRegularFiles(assetPath)) {
    const relativePath = path.relative(assetPath, filePath).replace(/\\/g, "/");
    const stat = fs.lstatSync(filePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(stat.mode & 0o777));
    hash.update("\0");
    if (stat.isSymbolicLink()) {
      hash.update("symlink");
      hash.update("\0");
      hash.update(fs.readlinkSync(filePath));
      hash.update("\0");
      continue;
    }
    totalSize += stat.size;
    hash.update("file");
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return `dir:${totalSize}:${hash.digest("hex")}`;
}

function computeAssetSignature(assetPath) {
  const stat = fs.lstatSync(assetPath);
  if (stat.isDirectory()) {
    return computeDirectoryAssetSignature(assetPath);
  }
  return computeFileAssetSignature(assetPath);
}

function normalizeDeveloperIdApplicationName(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith(DEVELOPER_ID_APPLICATION_PREFIX)) {
    return trimmed;
  }
  return trimmed.slice(DEVELOPER_ID_APPLICATION_PREFIX.length).trim();
}

function parseCodesigningIdentity(line) {
  const match = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"$/iu);
  if (!match) {
    return null;
  }
  return {
    hash: match[1].toUpperCase(),
    name: match[2]
  };
}

function isSha1Fingerprint(value) {
  return /^[0-9A-F]{40}$/iu.test(value.trim());
}

function configuredDarwinSigningIdentityName() {
  for (const envKey of DARWIN_CODESIGN_IDENTITY_ENV_KEYS) {
    const value = process.env[envKey]?.trim();
    if (value) {
      return normalizeDeveloperIdApplicationName(value);
    }
  }
  return "";
}

function assertDarwinSigningHost() {
  if (process.platform !== "darwin") {
    throw new Error("pre-signing bundled Darwin service directories requires a macOS host with codesign available");
  }
}

function resolveDarwinDeveloperIdApplicationIdentity() {
  assertDarwinSigningHost();

  const requestedIdentity = configuredDarwinSigningIdentityName();
  if (requestedIdentity && isSha1Fingerprint(requestedIdentity)) {
    return requestedIdentity.toUpperCase();
  }

  const output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const identities = output
    .split(/\r?\n/u)
    .map((line) => parseCodesigningIdentity(line))
    .filter((identity) => identity && identity.name.startsWith(DEVELOPER_ID_APPLICATION_PREFIX));

  if (requestedIdentity) {
    const requestedWithPrefix = `${DEVELOPER_ID_APPLICATION_PREFIX} ${requestedIdentity}`;
    const match = identities.find((identity) =>
      identity.name === requestedIdentity ||
      identity.name === requestedWithPrefix ||
      normalizeDeveloperIdApplicationName(identity.name) === requestedIdentity ||
      identity.name.includes(requestedIdentity)
    );
    if (match) {
      return match.hash;
    }
    throw new Error(
      `unable to find Developer ID Application signing identity matching ${DARWIN_CODESIGN_IDENTITY_ENV_KEYS.join("/")}=${JSON.stringify(requestedIdentity)}`
    );
  }

  if (identities.length === 1) {
    return identities[0].hash;
  }
  if (identities.length > 1) {
    throw new Error(
      `multiple Developer ID Application signing identities found; set CSC_NAME to one of: ${identities.map((identity) => normalizeDeveloperIdApplicationName(identity.name)).join(", ")}`
    );
  }
  throw new Error("unable to find a valid Developer ID Application signing identity for bundled Darwin service archives");
}

function isMachOFile(filePath) {
  const file = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    if (fs.readSync(file, header, 0, header.length, 0) !== header.length) {
      return false;
    }
    return MACHO_MAGICS.has(header.readUInt32BE(0));
  } finally {
    fs.closeSync(file);
  }
}

function listMachOFiles(rootDir) {
  const result = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of readDirectoryEntries(currentPath)) {
        stack.push(path.join(currentPath, entry.name));
      }
      continue;
    }
    if (stat.isFile() && isMachOFile(currentPath)) {
      result.push(currentPath);
    }
  }

  return result.sort((left, right) => {
    const depthDelta = right.split(path.sep).length - left.split(path.sep).length;
    return depthDelta || left.localeCompare(right);
  });
}

function signMachOFile(filePath, identity) {
  execFileSync("codesign", [
    "--force",
    ...(shouldSkipMacTimestamp() ? [] : ["--timestamp"]),
    "--options",
    "runtime",
    "--sign",
    identity,
    filePath
  ], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", filePath], { stdio: "inherit" });
}

function extractArchiveToBundleDirectory(archivePath, targetDir, service) {
  if (!archivePath.endsWith(".tar.gz")) {
    throw new Error(`Darwin service archives must be .tar.gz files: ${archivePath}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-darwin-service-extract-"));
  const extractRoot = path.join(tempRoot, "extract");
  fs.mkdirSync(extractRoot, { recursive: true });

  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", extractRoot], { stdio: "inherit" });
    const archiveEntries = fs.readdirSync(extractRoot).sort();
    if (archiveEntries.length !== 1) {
      throw new Error(`unexpected Darwin service archive layout for ${service.id}: ${archivePath}`);
    }

    const extractedRoot = path.join(extractRoot, archiveEntries[0]);
    const manifestPath = path.join(extractedRoot, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Darwin service archive root is missing manifest.json for ${service.id}: ${archivePath}`);
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    try {
      fs.renameSync(extractedRoot, targetDir);
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : "";
      if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
      fs.cpSync(extractedRoot, targetDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function signDarwinServiceDirectory(directoryPath, service, identity) {
  const machOFiles = listMachOFiles(directoryPath);
  if (machOFiles.length === 0) {
    return;
  }

  console.log(`[mac-service-sign] Signing ${machOFiles.length} Mach-O file(s) in ${service.id}...`);
  for (const filePath of machOFiles) {
    signMachOFile(filePath, identity);
  }
}

function scanArchiveDirectory(dirPath, tryAddArchive) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  for (const asset of readDirectoryEntries(dirPath, { optional: true })) {
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
  // Normalize backslashes to forward slashes for cross-platform consistency
  return trimmed.replace(/\\/g, "/");
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
    (entry) =>
      entry === "manifest.json" ||
      entry.endsWith("/manifest.json") ||
      entry.endsWith("\\manifest.json")
  );
  if (!manifestEntry) {
    return null;
  }

  const execOpts = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 };
  let raw;
  if (!isZipArchive(archivePath)) {
    raw = execFileSync("tar", ["-xzf", archivePath, "-O", manifestEntry], execOpts);
  } else if (canUseUnzip()) {
    try {
      raw = execFileSync("unzip", ["-p", archivePath, manifestEntry], execOpts);
    } catch {
      try {
        raw = execFileSync("unzip", ["-p", archivePath, "*/manifest.json"], execOpts);
      } catch {
        raw = execFileSync("unzip", ["-p", archivePath, "*manifest.json"], execOpts);
      }
    }
  } else {
    raw = execFileSync("tar", ["-xOf", archivePath, manifestEntry], execOpts);
  }
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;  // 去 UTF-8 BOM
  return JSON.parse(stripped);
}

export function readArchiveEntryText(archivePath, entryPath) {
  const normalizedEntryPath = normalizeTarEntry(entryPath);
  const matchedEntry = [...listArchiveEntries(archivePath)].find((entry) => entry === normalizedEntryPath);
  if (!matchedEntry) {
    return null;
  }

  const execOpts = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 };
  let raw;
  if (!isZipArchive(archivePath)) {
    raw = execFileSync("tar", ["-xzf", archivePath, "-O", matchedEntry], execOpts);
  } else if (canUseUnzip()) {
    try {
      raw = execFileSync("unzip", ["-p", archivePath, matchedEntry], execOpts);
    } catch {
      try {
        raw = execFileSync("unzip", ["-p", archivePath, "*/" + path.basename(normalizedEntryPath)], execOpts);
      } catch {
        raw = execFileSync("unzip", ["-p", archivePath, "*" + path.basename(normalizedEntryPath)], execOpts);
      }
    }
  } else {
    raw = execFileSync("tar", ["-xOf", archivePath, matchedEntry], execOpts);
  }

  if (!raw) {
    return null;
  }
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function listArchivesInDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  return readDirectoryEntries(directoryPath, { optional: true })
    .filter((entry) => entry.isFile() && isArchiveFileName(entry.name))
    .map((entry) => path.join(directoryPath, entry.name));
}

function listConfiguredReleaseArchives(sourceRoot, sourceLabel = BUILTIN_ASSETS_SOURCE_ENV) {
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`${sourceLabel} does not exist: ${sourceRoot}`);
  }

  if (!fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`${sourceLabel} must point to a directory: ${sourceRoot}`);
  }

  const archives = [];
  for (const entry of readDirectoryEntries(sourceRoot)) {
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

function getWorkspaceReleaseRoots() {
  return [
    WORKSPACE_ROOT,
    path.resolve(WORKSPACE_ROOT, "..", "zenmind-tunnel-hub")
  ].filter((root, index, roots) => roots.indexOf(root) === index);
}

function listWorkspaceReleaseArchivesInRoot(workspaceRoot) {
  const archives = [];

  for (const entry of readDirectoryEntries(workspaceRoot, { optional: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryRoot = path.join(workspaceRoot, entry.name);
    archives.push(...listArchivesInDirectory(path.join(entryRoot, "dist", "release")));
    archives.push(...listArchivesInDirectory(entryRoot));

    for (const child of readDirectoryEntries(entryRoot, { optional: true })) {
      if (!child.isDirectory()) {
        continue;
      }

      const childRoot = path.join(entryRoot, child.name);
      archives.push(...listArchivesInDirectory(path.join(childRoot, "dist", "release")));
      archives.push(...listArchivesInDirectory(childRoot));
    }
  }

  for (const entry of readDirectoryEntries(workspaceRoot, { optional: true })) {
    if (!entry.isFile() || !isArchiveFileName(entry.name)) {
      continue;
    }
    archives.push(path.join(workspaceRoot, entry.name));
  }

  return archives;
}

function listWorkspaceReleaseArchives() {
  return getWorkspaceReleaseRoots()
    .flatMap((workspaceRoot) => listWorkspaceReleaseArchivesInRoot(workspaceRoot))
    .sort((left, right) => left.localeCompare(right));
}


function normalizeSourceRoots(sourceRoots) {
  if (!Array.isArray(sourceRoots)) {
    return [];
  }
  return [...new Set(sourceRoots
    .filter((sourceRoot) => typeof sourceRoot === "string" && sourceRoot.trim())
    .map((sourceRoot) => path.resolve(sourceRoot.trim())))]
    .sort((left, right) => left.localeCompare(right));
}

function listReleaseArchives({ sourceRoots = [] } = {}) {
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

  const explicitSourceRoots = normalizeSourceRoots(sourceRoots);
  if (explicitSourceRoots.length > 0) {
    for (const sourceRoot of explicitSourceRoots) {
      for (const archivePath of listConfiguredReleaseArchives(sourceRoot, "--source")) {
        tryAddArchive(archivePath, 3);
      }
    }
  } else {
    const configuredSourceRoot = process.env[BUILTIN_ASSETS_SOURCE_ENV]?.trim();
    if (configuredSourceRoot) {
      for (const archivePath of listConfiguredReleaseArchives(configuredSourceRoot)) {
        tryAddArchive(archivePath, 2);
      }
    }

    for (const archivePath of listWorkspaceReleaseArchives()) {
      tryAddArchive(archivePath, 1);
    }
  }

  return [...archivesByBuildKey.values()]
    .map((entry) => entry.archivePath)
    .sort((left, right) => left.localeCompare(right));
}

function isDesktopTargetOs(osName) {
  return osName === "windows" || osName === "darwin" || osName === "linux";
}

function shouldRequireDesktopCoreServices({ os } = {}) {
  return !os || isDesktopTargetOs(os);
}

function formatPlatformLabel({ os, arch } = {}) {
  if (!os && !arch) {
    return "all platforms";
  }
  return `${os ?? "*"} / ${arch ?? "*"}`;
}

export function assertRequiredDesktopCoreServices(services, platform = {}) {
  if (!shouldRequireDesktopCoreServices(platform)) {
    return;
  }

  const serviceIds = new Set(services.map((service) => service.id));
  const missingServiceIds = REQUIRED_DESKTOP_CORE_SERVICE_IDS.filter((serviceId) => !serviceIds.has(serviceId));
  if (missingServiceIds.length === 0) {
    return;
  }

  throw new Error(
      `missing required Desktop builtin service assets for ${formatPlatformLabel(platform)}: ${missingServiceIds.join(", ")}\n` +
      `Desktop startup requires ${REQUIRED_DESKTOP_CORE_SERVICE_IDS.join(", ")}.\n` +
      `Regenerate or provide the missing upstream release bundle, or set ${BUILTIN_ASSETS_SOURCE_ENV} to a directory containing the complete Desktop builtin assets.`
  );
}

function serviceFromBundleManifest(manifest, assetPath) {
  const requiredBundleEntries = Array.isArray(manifest.runtime?.requiredPaths)
    ? manifest.runtime.requiredPaths.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  if (requiredBundleEntries.length === 0) {
    throw new Error(`builtin manifest missing runtime.requiredPaths: ${assetPath}`);
  }

  return {
    id: manifest.id,
    sourceDir: path.dirname(assetPath),
    assetFileName: path.basename(assetPath),
    bundleTopLevelDir: manifest.desktop?.bundleTopLevelDir ?? manifest.id,
    version: manifest.version,
    platform: {
      os: manifest.platform?.os ?? "",
      arch: manifest.platform?.arch ?? ""
    },
    requiredBundleEntries
  };
}

function matchesTargetPlatform(manifest, { os, arch } = {}) {
  if (os && manifest.platform?.os && manifest.platform.os !== os) {
    return false;
  }
  if (arch && manifest.platform?.arch && manifest.platform.arch !== arch) {
    return false;
  }
  return true;
}

export function discoverBuiltinServices({ os, arch, sourceRoots } = {}) {
  const services = [];

  for (const archivePath of listReleaseArchives({ sourceRoots })) {
    let manifest;
    try {
      manifest = readManifestFromArchive(archivePath);
    } catch {
      continue;
    }
    if (!manifest || manifest.kind !== "builtin") {
      continue;
    }

    if (!matchesTargetPlatform(manifest, { os, arch })) {
      continue;
    }

    services.push(serviceFromBundleManifest(manifest, archivePath));
  }

  const latestByServiceKey = new Map();
  for (const service of services) {
    const platformKey = [service.id, service.platform.os, service.platform.arch].join("|");
    const current = latestByServiceKey.get(platformKey);
    if (!current || compareBuiltinVersions(service.version, current.version) > 0) {
      latestByServiceKey.set(platformKey, service);
    }
  }

  return [...latestByServiceKey.values()].sort((left, right) => {
    const leftKey = `${left.id}|${left.assetFileName}`;
    const rightKey = `${right.id}|${right.assetFileName}`;
    return leftKey.localeCompare(rightKey);
  });
}

function readDirectoryAssetManifest(assetPath) {
  const manifestPath = path.join(assetPath, "manifest.json");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    return null;
  }
  const raw = fs.readFileSync(manifestPath, "utf8");
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(stripped);
}

function readSyncedAssetManifest(outputRoot) {
  const manifestPath = path.join(outputRoot, "manifest.json");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    return null;
  }
  const raw = fs.readFileSync(manifestPath, "utf8");
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(stripped);
}

function writeSyncedAssetManifest(outputRoot, services) {
  fs.writeFileSync(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), services }, null, 2)}\n`,
    "utf8"
  );
}

function validateExistingSyncedAssets(projectRoot, platform = {}, options = {}) {
  const outputRoot = desktopBuiltinServicesDir(projectRoot);
  const manifest = readSyncedAssetManifest(outputRoot);
  if (!manifest || !Array.isArray(manifest.services)) {
    return null;
  }

  const services = [];
  const selectedAssets = [];
  for (const entry of manifest.services) {
    if (!entry || typeof entry.id !== "string" || typeof entry.assetFileName !== "string") {
      continue;
    }

    const assetPath = path.join(outputRoot, entry.id, entry.assetFileName);
    if (!fs.existsSync(assetPath)) {
      throw new Error(`synced builtin asset is missing for ${entry.id}: ${assetPath}`);
    }

    const assetStat = fs.statSync(assetPath);
    const assetManifest = assetStat.isDirectory()
      ? readDirectoryAssetManifest(assetPath)
      : readManifestFromArchive(assetPath);
    if (!assetManifest || assetManifest.kind !== "builtin") {
      throw new Error(`synced builtin asset manifest is invalid for ${entry.id}: ${assetPath}`);
    }
    if (!matchesTargetPlatform(assetManifest, platform)) {
      continue;
    }

    const service = serviceFromBundleManifest(assetManifest, assetPath);
    services.push(service);
    const assetType = assetStat.isDirectory() ? "directory" : "archive";
    if (assetStat.isDirectory()) {
      validateBundleDirectory(service, assetPath);
    } else {
      validateBundleArchive(service, assetPath);
    }

    selectedAssets.push({
      entry,
      service,
      assetPath,
      assetType
    });
  }

  assertRequiredDesktopCoreServices(services, platform);
  if (options.signDarwin) {
    const darwinAssets = selectedAssets.filter(({ service }) => service.platform.os === "darwin");
    if (darwinAssets.length > 0) {
      const archivedAsset = darwinAssets.find((asset) => asset.assetType !== "directory");
      if (archivedAsset) {
        throw new Error(
          `cannot sign existing Darwin builtin archive for ${archivedAsset.service.id}: ${archivedAsset.assetPath}\n` +
            "Run scripts/build-all-dist.sh --sync-os darwin --sync-arch arm64 to sync Darwin services as directories."
        );
      }

      const darwinSigningIdentity = resolveDarwinDeveloperIdApplicationIdentity();
      for (const asset of darwinAssets) {
        signDarwinServiceDirectory(asset.assetPath, asset.service, darwinSigningIdentity);
        validateBundleDirectory(asset.service, asset.assetPath);
        asset.entry.assetSignature = computeAssetSignature(asset.assetPath);
        asset.entry.assetType = asset.assetType;
      }
      writeSyncedAssetManifest(outputRoot, manifest.services);
    }
  }

  return selectedAssets.map(({ service, assetPath, assetType }) => ({
    id: service.id,
    version: service.version,
    assetFileName: path.basename(assetPath),
    assetType,
    assetSignature: computeAssetSignature(assetPath)
  }));
}

function normalizeBuiltinVersion(version) {
  return version
    .trim()
    .replace(/^v/iu, "")
    .split(".")
    .map((segment) => {
      const match = segment.match(/^(\d+)(.*)$/u);
      if (!match) {
        return { number: Number.NaN, suffix: segment };
      }
      return {
        number: Number.parseInt(match[1], 10),
        suffix: match[2] ?? ""
      };
    });
}

function compareBuiltinVersions(leftVersion, rightVersion) {
  const left = normalizeBuiltinVersion(leftVersion);
  const right = normalizeBuiltinVersion(rightVersion);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? { number: 0, suffix: "" };
    const rightPart = right[index] ?? { number: 0, suffix: "" };
    const leftNumber = Number.isFinite(leftPart.number) ? leftPart.number : -1;
    const rightNumber = Number.isFinite(rightPart.number) ? rightPart.number : -1;
    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    if (leftPart.suffix !== rightPart.suffix) {
      return leftPart.suffix.localeCompare(rightPart.suffix);
    }
  }
  return 0;
}

export const builtinServices = discoverBuiltinServices();

function normalizeRequiredPath(relativePath) {
  return relativePath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
}

export function findMissingBundleEntries(service, entries) {
  return service.requiredBundleEntries.filter((relativePath) => {
    const expectedPath = `${service.bundleTopLevelDir}/${normalizeRequiredPath(relativePath)}`;
    if (entries.has(expectedPath)) {
      return false;
    }
    const normalizedPrefix = expectedPath.endsWith("/") ? expectedPath : `${expectedPath}/`;
    return ![...entries].some((entry) => entry.startsWith(normalizedPrefix));
  });
}

function findStaleAgentPlatformDeployProtocolMarker(content) {
  if (!content) {
    return "";
  }
  return STALE_AGENT_PLATFORM_DEPLOY_PROTOCOL_MARKERS.find((marker) => content.includes(marker)) || "";
}

function findAgentContainerHubAcceptedDeployLayoutArg(content) {
  const text = content || "";
  const layoutFlags = [
    "--config-dir",
    "--data-dir",
    "--state-dir",
    "--log-dir",
    "--bind-addr",
    "--daemon"
  ];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const flag = layoutFlags.find((candidate) => line.includes(candidate));
    if (!flag) {
      continue;
    }
    const block = lines.slice(index, index + 8).join("\n");
    if (/(?:throw\b|exit\s+[1-9]\d*|return\s+[1-9]\d*|unsupported deploy argument|start\/runtime argument)/iu.test(block)) {
      continue;
    }
    if (
      /(?:\b(?:config|data|state|log|bind|daemon)[A-Za-z0-9_]*\s*=|\$(?:configDir|dataDir|stateDir|logDir|bindAddr|daemon)\s*=|\$i\+\+|shift\s+2)/u.test(block)
    ) {
      return flag;
    }
  }
  return "";
}

function validateAgentPlatformDeployProtocolText(service, sourceLabel, relativePath, content) {
  const staleMarker = findStaleAgentPlatformDeployProtocolMarker(content);
  if (!staleMarker) {
    if (
      content.includes("program_sync_deploy_env_values") ||
      content.includes("Sync-ProgramDeployEnvValues")
    ) {
      return;
    }
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${sourceLabel}\n` +
        `Missing deploy-owned env upsert support in ${relativePath}.\n` +
        `Please rebuild the Desktop-ready agent-platform bundle so deploy.sh updates existing .env files.`
    );
  }
  throw new Error(
    `invalid builtin bundle for ${service.id}: ${sourceLabel}\n` +
      `Detected stale deploy protocol marker ${JSON.stringify(staleMarker)} in ${relativePath}.\n` +
      `Please rebuild the Desktop-ready agent-platform bundle with --public-key-source-file launcher support.`
  );
}

function validateAgentPlatformArchiveDeployProtocol(service, archivePath) {
  const isWindowsArchive = archivePath.endsWith(".zip");
  const programCommonPath = isWindowsArchive
    ? `${service.bundleTopLevelDir}/scripts/program-common.ps1`
    : `${service.bundleTopLevelDir}/scripts/program-common.sh`;
  const programCommon = readArchiveEntryText(archivePath, programCommonPath);
  validateAgentPlatformDeployProtocolText(service, archivePath, programCommonPath, programCommon);
}

function expectedAgentPlatformSidecarPath(service) {
  if (service.platform?.os === "windows") {
    return "bin/kbase-lance-engine.exe";
  }
  if (service.platform?.os === "darwin" || service.platform?.os === "linux") {
    return "bin/kbase-lance-engine";
  }
  throw new Error(
    `invalid builtin bundle for ${service.id}: unsupported agent-platform target OS ${JSON.stringify(service.platform?.os ?? "")}`
  );
}

function validateAgentPlatformSidecarContract(service, sourceLabel, containsPath) {
  if (service.id !== "agent-platform") {
    return;
  }
  const sidecarPath = expectedAgentPlatformSidecarPath(service);
  const requiredPaths = new Set(service.requiredBundleEntries.map((entry) => normalizeRequiredPath(entry)));
  if (!requiredPaths.has(sidecarPath)) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${sourceLabel}\n` +
        `Missing required agent-platform sidecar contract ${sidecarPath} in manifest runtime.requiredPaths.\n` +
        "Please rebuild the upstream agent-platform release bundle."
    );
  }
  if (!containsPath(sidecarPath)) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${sourceLabel}\n` +
        `Missing required agent-platform sidecar file: ${sidecarPath}.\n` +
        "Please rebuild the upstream agent-platform release bundle."
    );
  }
}

function validateAgentPlatformBundleArchive(service, archivePath, entries) {
  validateAgentPlatformArchiveDeployProtocol(service, archivePath);
  validateAgentPlatformSidecarContract(
    service,
    archivePath,
    (relativePath) => entries.has(`${service.bundleTopLevelDir}/${relativePath}`)
  );
}

function lifecycleDeployScriptPathForArchive(service, archivePath) {
  const fileName = archivePath.endsWith(".zip") ? "deploy.ps1" : "deploy.sh";
  return `${service.bundleTopLevelDir}/${fileName}`;
}

function validateLifecycleDeployProtocolText(service, sourceLabel, relativePath, content) {
  const protocol = LIFECYCLE_DEPLOY_PROTOCOLS[service.id];
  if (!protocol) {
    return;
  }
  const text = content || "";
  for (const marker of protocol.required || []) {
    if (!text.includes(marker)) {
      throw new Error(
        `invalid builtin bundle for ${service.id}: ${sourceLabel}\n` +
          `Missing lifecycle contract marker ${JSON.stringify(marker)} in ${relativePath}.\n` +
          protocol.message
      );
    }
  }
  for (const marker of protocol.forbidden || []) {
    if (text.includes(marker)) {
      throw new Error(
        `invalid builtin bundle for ${service.id}: ${sourceLabel}\n` +
          `Detected stale lifecycle contract marker ${JSON.stringify(marker)} in ${relativePath}.\n` +
          protocol.message
      );
    }
  }
  if (service.id === "agent-container-hub") {
    const marker = findAgentContainerHubAcceptedDeployLayoutArg(text);
    if (marker) {
      throw new Error(
        `invalid builtin bundle for ${service.id}: ${sourceLabel}\n` +
          `Detected deploy-time start layout argument ${JSON.stringify(marker)} in ${relativePath}.\n` +
          protocol.message
      );
    }
  }
}

function validateAgentWebclientBundleArchive(service, archivePath) {
  const manifest = readManifestFromArchive(archivePath);
  const isWindowsArchive = archivePath.endsWith(".zip");
  const entries = listArchiveEntries(archivePath);
  const deployScriptPath = lifecycleDeployScriptPathForArchive(service, archivePath);
  const deployScript = readArchiveEntryText(archivePath, deployScriptPath);
  validateLifecycleDeployProtocolText(service, archivePath, deployScriptPath, deployScript);

  if (manifest?.frontend?.hostManaged !== true) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Expected frontend.hostManaged to be true so Desktop can host agent-webclient.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }

  if (manifest?.backend?.entry) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Unexpected backend.entry ${JSON.stringify(manifest.backend.entry)}; Desktop-ready agent-webclient bundles must not ship a backend server.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }

  const requiredPaths = Array.isArray(manifest?.runtime?.requiredPaths)
    ? manifest.runtime.requiredPaths.filter((entry) => typeof entry === "string")
    : [];
  const backendRequiredPath = requiredPaths.find((entry) => entry.replace(/\\/g, "/").startsWith("backend/"));
  if (backendRequiredPath) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Unexpected backend runtime required path ${backendRequiredPath}; Desktop hosts agent-webclient itself.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }

  const programCommonPath = isWindowsArchive
    ? `${service.bundleTopLevelDir}/scripts/program-common.ps1`
    : `${service.bundleTopLevelDir}/scripts/program-common.sh`;
  const programCommon = readArchiveEntryText(archivePath, programCommonPath);
  if (!programCommon) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing ${programCommonPath} in the Desktop-ready agent-webclient bundle.`
    );
  }

  const staleRuntimeMarkers = isWindowsArchive
    ? ["BackendEntry", "BackendPackageFile", "BackendModulesDir", "backend\\server.cjs", "backend\\server.js", "backend\\package.json", "backend\\node_modules"]
    : ["BACKEND_ENTRY", "BACKEND_PACKAGE_FILE", "BACKEND_NODE_MODULES_DIR", "backend/server.cjs", "backend/server.js", "backend/package.json", "backend/node_modules"];
  const staleRuntimeMarker = staleRuntimeMarkers.find((marker) => programCommon.includes(marker));
  if (staleRuntimeMarker) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected stale launcher runtime check ${JSON.stringify(staleRuntimeMarker)} in ${programCommonPath}.\n` +
        `Desktop-ready agent-webclient launchers must not reference backend runtime files.`
    );
  }

  const backendEntry = [...entries].find((entry) => entry.startsWith(`${service.bundleTopLevelDir}/backend/`));
  if (backendEntry) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Unexpected backend runtime file ${backendEntry}; Desktop hosts agent-webclient itself.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }

  const forbiddenEntries = [
    `${service.bundleTopLevelDir}/README.txt`
  ];
  const forbiddenEntry = forbiddenEntries.find((entry) => entries.has(entry));
  if (forbiddenEntry) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Unexpected non-runtime file ${forbiddenEntry} in final bundle.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }

  const requirements = Array.isArray(manifest?.desktop?.capabilities?.requires)
    ? manifest.desktop.capabilities.requires
    : [];
  const hasAccessTokenPreload = requirements.some(
    (requirement) =>
      requirement &&
      requirement.phase === "verifyRunning" &&
      requirement.capability === "auth.accessToken" &&
      requirement.action === "preload"
  );
  if (!hasAccessTokenPreload) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing desktop capability requirement verifyRunning auth.accessToken preload in manifest.json.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle with manifest-declared auth startup dependencies.`
    );
  }
  const hasAgentPlatformWaitHttp = requirements.some(
    (requirement) =>
      requirement &&
      requirement.phase === "verifyRunning" &&
      requirement.service === "agent-platform" &&
      requirement.action === "waitHttp" &&
      requirement.target === "/api/runtime-info" &&
      requirement.authCapability === "auth.accessToken"
  );
  if (!hasAgentPlatformWaitHttp) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing desktop capability requirement verifyRunning agent-platform waitHttp /api/runtime-info with auth.accessToken in manifest.json.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle with manifest-declared platform readiness dependencies.`
    );
  }
}

function validateIdentityCenterBundleArchive(service, archivePath) {
  const manifest = readManifestFromArchive(archivePath);
  const isWindowsArchive = archivePath.endsWith(".zip");
  const deployScriptPath = lifecycleDeployScriptPathForArchive(service, archivePath);
  const deployScript = readArchiveEntryText(archivePath, deployScriptPath);
  validateLifecycleDeployProtocolText(service, archivePath, deployScriptPath, deployScript);
  if (isWindowsArchive) {
    validateIdentityCenterAuthCapabilities(service, archivePath, manifest, "windowsCommand");
    return;
  }

  const commandKey = manifest?.platform?.os === "linux" ? "linuxCommand" : "darwinCommand";
  validateIdentityCenterAuthCapabilities(service, archivePath, manifest, commandKey);
}

function hasNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

function validateIdentityCenterAuthCapabilities(service, archivePath, manifest, commandKey) {
  const providers = Array.isArray(manifest?.desktop?.capabilities?.provides)
    ? manifest.desktop.capabilities.provides
    : [];
  const authPublicKeyProvider = providers.find((provider) => provider?.id === "auth.publicKey");
  if (
    !authPublicKeyProvider ||
    authPublicKeyProvider.output !== "file" ||
    authPublicKeyProvider.outputPath !== "{{provider.dataDir}}/keys/publicKey.pem" ||
    authPublicKeyProvider.retryOnSqliteBusy !== true ||
    !hasNonEmptyStringArray(authPublicKeyProvider[commandKey])
  ) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing desktop capability provider auth.publicKey in manifest.json.\n` +
        `Please rebuild the Desktop-ready identity-center bundle with manifest-declared auth providers.`
    );
  }

  const authAccessTokenProvider = providers.find((provider) => provider?.id === "auth.accessToken");
  if (
    !authAccessTokenProvider ||
    authAccessTokenProvider.output !== "stdoutLastLine" ||
    authAccessTokenProvider.retryOnSqliteBusy !== true ||
    authAccessTokenProvider.validateJwtDeviceId !== true ||
    authAccessTokenProvider.allowDeviceIdFallback !== true ||
    !Array.isArray(authAccessTokenProvider.dependsOn) ||
    !authAccessTokenProvider.dependsOn.includes("auth.publicKey") ||
    !hasNonEmptyStringArray(authAccessTokenProvider[commandKey])
  ) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing desktop capability provider auth.accessToken in manifest.json.\n` +
        `Please rebuild the Desktop-ready identity-center bundle with manifest-declared auth providers.`
    );
  }
}

function validateAgentContainerHubBundleArchive(service, archivePath) {
  const deployScriptPath = lifecycleDeployScriptPathForArchive(service, archivePath);
  const deployScript = readArchiveEntryText(archivePath, deployScriptPath);
  validateLifecycleDeployProtocolText(service, archivePath, deployScriptPath, deployScript);
}

function validateBundleContents(service, archivePath, entries) {
  const readmeEntry = `${service.bundleTopLevelDir}/README.txt`;
  if (entries.has(readmeEntry)) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Unexpected non-runtime file ${readmeEntry} in final bundle.\n` +
        `Please regenerate the upstream release bundle.`
    );
  }
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

  validateBundleContents(service, archivePath, entries);

  if (service.id === "agent-platform") {
    validateAgentPlatformBundleArchive(service, archivePath, entries);
  }
  if (service.id === "agent-container-hub") {
    validateAgentContainerHubBundleArchive(service, archivePath);
  }
  if (service.id === "agent-webclient") {
    validateAgentWebclientBundleArchive(service, archivePath);
  }
  if (service.id === "identity-center") {
    validateIdentityCenterBundleArchive(service, archivePath);
  }
}

function findMissingBundleDirectoryEntries(service, directoryPath) {
  return service.requiredBundleEntries.filter((relativePath) => {
    const normalizedRelativePath = normalizeRequiredPath(relativePath);
    return !fs.existsSync(path.join(directoryPath, ...normalizedRelativePath.split("/").filter(Boolean)));
  });
}

function validateBundleDirectoryContents(service, directoryPath) {
  if (fs.existsSync(path.join(directoryPath, "README.txt"))) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${directoryPath}\n` +
        `Unexpected non-runtime file README.txt in final bundle.\n` +
        `Please regenerate the upstream release bundle.`
    );
  }
}

function validateAgentPlatformBundleDirectory(service, directoryPath) {
  if (service.id !== "agent-platform") {
    return;
  }

  for (const relativePath of ["scripts/program-common.sh", "scripts/program-common.ps1"]) {
    const filePath = path.join(directoryPath, ...relativePath.split("/"));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      continue;
    }
    validateAgentPlatformDeployProtocolText(
      service,
      directoryPath,
      relativePath,
      fs.readFileSync(filePath, "utf8")
    );
  }
  validateAgentPlatformSidecarContract(
    service,
    directoryPath,
    (relativePath) => {
      const filePath = path.join(directoryPath, ...relativePath.split("/"));
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    }
  );
}

function validateBundleDirectoryDeployProtocol(service, directoryPath) {
  for (const relativePath of ["deploy.sh", "deploy.ps1"]) {
    const filePath = path.join(directoryPath, relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      continue;
    }
    validateLifecycleDeployProtocolText(service, directoryPath, relativePath, fs.readFileSync(filePath, "utf8"));
  }
}

export function validateBundleDirectory(service, directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    throw new Error(`missing builtin asset directory for ${service.id}: ${directoryPath}`);
  }
  if (!fs.statSync(directoryPath).isDirectory()) {
    throw new Error(`builtin asset path is not a directory for ${service.id}: ${directoryPath}`);
  }

  const manifestPath = path.join(directoryPath, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`builtin asset directory missing manifest.json for ${service.id}: ${directoryPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest?.id !== service.id || manifest?.version !== service.version) {
    throw new Error(
      `builtin asset directory manifest mismatch for ${service.id}: ${directoryPath}\n` +
        `Expected ${service.id}@${service.version}, found ${manifest?.id ?? "unknown"}@${manifest?.version ?? "unknown"}.`
    );
  }

  const missingEntries = findMissingBundleDirectoryEntries(service, directoryPath);
  if (missingEntries.length > 0) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${directoryPath}\n` +
        `Missing required entries: ${missingEntries.join(", ")}`
    );
  }

  validateBundleDirectoryContents(service, directoryPath);
  validateAgentPlatformBundleDirectory(service, directoryPath);
  if (service.id === "agent-container-hub") {
    validateBundleDirectoryDeployProtocol(service, directoryPath);
  }
  if (service.id === "agent-webclient") {
    validateBundleDirectoryDeployProtocol(service, directoryPath);
  }
  if (service.id === "identity-center") {
    validateBundleDirectoryDeployProtocol(service, directoryPath);
  }
}

export function syncBuiltinAssets(projectRoot = process.cwd(), options = {}) {
  const { os, arch, signDarwin = false, sourceRoots, useExisting = false } = options;
  const outputRoot = desktopBuiltinServicesDir(projectRoot);
  const platform = { os, arch };
  if (useExisting) {
    const existingManifest = validateExistingSyncedAssets(projectRoot, platform, { signDarwin });
    if (existingManifest) {
      return existingManifest;
    }
    throw new Error(
      `missing current Desktop builtin service assets for ${formatPlatformLabel(platform)}: ${outputRoot}\n` +
        `Run scripts/build-all-dist.sh${os ? ` --sync-os ${os}` : ""}${arch ? ` --sync-arch ${arch}` : ""} to build and sync them, ` +
        `or set ${BUILTIN_ASSETS_SOURCE_ENV} to a directory containing the complete release assets.`
    );
  }

  const services = discoverBuiltinServices({ ...platform, sourceRoots });
  const darwinSigningIdentity = signDarwin && services.some((service) => service.platform.os === "darwin")
    ? resolveDarwinDeveloperIdApplicationIdentity()
    : "";

  assertRequiredDesktopCoreServices(services, platform);

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const manifest = services.map((service) => {
    const sourcePath = path.join(service.sourceDir, service.assetFileName);
    validateBundleArchive(service, sourcePath);

    const serviceDir = path.join(outputRoot, service.id);
    fs.mkdirSync(serviceDir, { recursive: true });
    const isDarwinService = service.platform.os === "darwin";
    const assetFileName = isDarwinService
      ? archiveAssetDirectoryName(service.assetFileName)
      : service.assetFileName;
    const outputAssetPath = path.join(serviceDir, assetFileName);

    if (isDarwinService) {
      extractArchiveToBundleDirectory(sourcePath, outputAssetPath, service);
      if (darwinSigningIdentity) {
        signDarwinServiceDirectory(outputAssetPath, service, darwinSigningIdentity);
      }
      validateBundleDirectory(service, outputAssetPath);
    } else {
      fs.copyFileSync(sourcePath, outputAssetPath);
      validateBundleArchive(service, outputAssetPath);
    }

    return {
      id: service.id,
      version: service.version,
      assetFileName,
      assetType: isDarwinService ? "directory" : "archive",
      assetSignature: computeAssetSignature(outputAssetPath)
    };
  });

  writeSyncedAssetManifest(outputRoot, manifest);

  cleanupLegacyBrandScopedServiceAssets(projectRoot);

  return manifest;
}
