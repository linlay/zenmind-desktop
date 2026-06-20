import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { desktopBuiltinServicesDir } from "./desktop-resources.mjs";

// monorepo 根目录：zenmind-desktop 的上一级
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const BUILTIN_ASSETS_SOURCE_ENV = "DESKTOP_BUILTIN_ASSETS_SOURCE";
const LEGACY_BUILTIN_ASSETS_SOURCE_ENV = "ZENMIND_BUILTIN_ASSETS_SOURCE";
const BUILTIN_ASSETS_SOURCE_ENV_LABEL = `${BUILTIN_ASSETS_SOURCE_ENV} or ${LEGACY_BUILTIN_ASSETS_SOURCE_ENV}`;
const REQUIRED_DESKTOP_CORE_SERVICE_IDS = [
  "identity-center",
  "agent-platform",
  "agent-webclient"
];
const LEGACY_IDENTITY_SERVICE_ID = ["zenmind", "app", "server"].join("-");
const EXCLUDED_DESKTOP_BUILTIN_SERVICE_IDS = new Set([
  LEGACY_IDENTITY_SERVICE_ID
]);
const DEVELOPER_ID_APPLICATION_PREFIX = "Developer ID Application:";
const DARWIN_CODESIGN_IDENTITY_ENV_KEYS = [
  "ZENMIND_DARWIN_CODESIGN_IDENTITY",
  "MACOS_CODESIGN_IDENTITY",
  "CSC_NAME"
];
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
    "--timestamp",
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-darwin-service-extract-"));
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

function listConfiguredReleaseArchives(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`${BUILTIN_ASSETS_SOURCE_ENV_LABEL} does not exist: ${sourceRoot}`);
  }

  if (!fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`${BUILTIN_ASSETS_SOURCE_ENV_LABEL} must point to a directory: ${sourceRoot}`);
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
    if (EXCLUDED_DESKTOP_BUILTIN_SERVICE_IDS.has(manifest.id)) {
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

  const configuredSourceRoot = (
    process.env[BUILTIN_ASSETS_SOURCE_ENV] ??
    process.env[LEGACY_BUILTIN_ASSETS_SOURCE_ENV]
  )?.trim();
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
      `Regenerate or provide the missing upstream release bundle, or set ${BUILTIN_ASSETS_SOURCE_ENV_LABEL} to a directory containing the complete Desktop builtin assets.`
  );
}

export function discoverBuiltinServices({ os, arch } = {}) {
  const services = [];

  for (const archivePath of listReleaseArchives()) {
    let manifest;
    try {
      manifest = readManifestFromArchive(archivePath);
    } catch {
      continue;
    }
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
      platform: {
        os: manifest.platform?.os ?? "",
        arch: manifest.platform?.arch ?? ""
      },
      requiredBundleEntries
    });
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

function validateAgentPlatformBundleArchive(service, archivePath) {
  const manifest = readManifestFromArchive(archivePath);
  const disallowedLegacyEnvBindings = new Set([
    "HOST_PORT",
    "AGENT_WS_ENABLED",
    "AGENT_CONTAINER_HUB_BASE_URL",
    "AGENT_AUTH_ENABLED",
    "AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE"
  ]);
  const envBindingKeys = Array.isArray(manifest?.desktop?.envBindings)
    ? manifest.desktop.envBindings
      .map((binding) => (binding && typeof binding.key === "string" ? binding.key.trim() : ""))
      .filter(Boolean)
    : [];
  const legacyEnvBinding = envBindingKeys.find((key) => disallowedLegacyEnvBindings.has(key));
  if (legacyEnvBinding) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected legacy desktop env binding ${legacyEnvBinding} in manifest.json.\n` +
      `This usually means a pre-runtime or stale agent-platform bundle was selected instead of the clean Desktop release bundle.`
    );
  }

  const authPublicKeyBinding = Array.isArray(manifest?.desktop?.envBindings)
    ? manifest.desktop.envBindings.find(
      (binding) =>
        binding &&
        typeof binding.key === "string" &&
        binding.key.trim() === "AUTH_LOCAL_PUBLIC_KEY_FILE"
    )
    : undefined;
  if (!authPublicKeyBinding || authPublicKeyBinding.value !== "configs/local-public-key.pem") {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing desktop env binding AUTH_LOCAL_PUBLIC_KEY_FILE=configs/local-public-key.pem in manifest.json.\n` +
        `Please rebuild the Desktop-ready agent-platform bundle with manifest-declared auth.publicKey startup dependencies.`
    );
  }

  const requirements = Array.isArray(manifest?.desktop?.capabilities?.requires)
    ? manifest.desktop.capabilities.requires
    : [];
  const hasAuthPublicKeyRequirement = requirements.some(
    (requirement) =>
      requirement &&
      requirement.phase === "preStart" &&
      requirement.capability === "auth.publicKey" &&
      requirement.action === "copyFile" &&
      requirement.target === "configs/local-public-key.pem"
  );
  if (!hasAuthPublicKeyRequirement) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing desktop capability requirement preStart auth.publicKey copyFile configs/local-public-key.pem in manifest.json.\n` +
        `Please rebuild the Desktop-ready agent-platform bundle with manifest-declared auth.publicKey startup dependencies.`
    );
  }

  const entries = listArchiveEntries(archivePath);
  if ([...entries].some((entry) => entry.includes("local-cli-acp-relay"))) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected legacy relay residue inside the agent-platform bundle.\n` +
        `Please rebuild the clean Desktop release bundle where local-cli-acp-relay ships as a separate plugin.`
    );
  }

  const programCommonPath = `${service.bundleTopLevelDir}/scripts/program-common.sh`;
  const programCommon = readArchiveEntryText(archivePath, programCommonPath);
  const envExamplePath = `${service.bundleTopLevelDir}/.env.example`;
  const envExample = readArchiveEntryText(archivePath, envExamplePath);
  if (
    (programCommon && /LOCAL_CLI_ACP_RELAY_|CLAUDE_CODE_ACP_/u.test(programCommon)) ||
    (envExample && /LOCAL_CLI_ACP_RELAY_|CLAUDE_CODE_ACP_|(^|\n)\s*HOST_PORT\s*=/u.test(envExample))
  ) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected legacy relay or HOST_PORT residue in the bundled startup/config files.\n` +
        `Please rebuild or reselect the clean Desktop release bundle where relay settings live in the standalone plugin and SERVER_PORT is the public port key.`
    );
  }
}

function validateAgentWebclientBundleArchive(service, archivePath) {
  const manifest = readManifestFromArchive(archivePath);
  const isWindowsArchive = archivePath.endsWith(".zip");
  const entries = listArchiveEntries(archivePath);
  const envBindingKeys = Array.isArray(manifest?.desktop?.envBindings)
    ? manifest.desktop.envBindings
      .map((binding) => (binding && typeof binding.key === "string" ? binding.key.trim() : ""))
      .filter(Boolean)
    : [];
  for (const requiredKey of ["BASE_URL"]) {
    if (!envBindingKeys.includes(requiredKey)) {
      throw new Error(
        `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
          `Missing desktop env binding ${requiredKey} in manifest.json.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
      );
    }
  }

  const envExamplePath = `${service.bundleTopLevelDir}/.env.example`;
  const envExample = readArchiveEntryText(archivePath, envExamplePath);
  if (!/\bDESKTOP_APP\s*=/u.test(envExample)) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing DESKTOP_APP in ${envExamplePath}.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }

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
  const envExamplePath = `${service.bundleTopLevelDir}/.env.example`;
  const envExample = readArchiveEntryText(archivePath, envExamplePath);
  if (!envExample || !envExample.includes("FRONTEND_DIST_DIR=./frontend/dist")) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected a stale identity-center env template without FRONTEND_DIST_DIR=./frontend/dist.\n` +
        `Please rebuild or reselect the Desktop-ready program bundle.`
    );
  }

  const isWindowsArchive = archivePath.endsWith(".zip");
  const programCommonPath = isWindowsArchive
    ? `${service.bundleTopLevelDir}/scripts/program-common.ps1`
    : `${service.bundleTopLevelDir}/scripts/program-common.sh`;
  const programCommon = readArchiveEntryText(archivePath, programCommonPath);
  if (!programCommon) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Missing ${programCommonPath} in the Desktop-ready program bundle.`
    );
  }

  if (isWindowsArchive) {
    if (!programCommon.includes("Resolve-ProgramFrontendDistDir") || !programCommon.includes("$env:FRONTEND_DIST_DIR")) {
      throw new Error(
        `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
          `Detected a stale identity-center Windows launcher without FRONTEND_DIST_DIR handling.\n` +
          `Please rebuild or reselect the Desktop-ready program bundle.`
      );
    }
    validateIdentityCenterAuthCapabilities(service, archivePath, manifest, "windowsCommand");
    return;
  }

  if (
    !programCommon.includes('FRONTEND_DIST_DIR="${FRONTEND_DIST_DIR:-./frontend/dist}"') ||
    !programCommon.includes('nohup "$BACKEND_BIN"')
  ) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected a stale identity-center launcher without Desktop compatibility markers.\n` +
        `Please rebuild or reselect the Desktop-ready program bundle.`
    );
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

function validateBundleContents(service, archivePath, entries) {
  const readmeEntry = `${service.bundleTopLevelDir}/README.txt`;
  if (entries.has(readmeEntry)) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Unexpected non-runtime file ${readmeEntry} in final bundle.\n` +
        `Please regenerate the upstream release bundle.`
    );
  }

  if (service.id === "agent-platform" && entries.has(`${service.bundleTopLevelDir}/local-cli-acp-relay/README.md`)) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Unexpected non-runtime file local-cli-acp-relay/README.md in final bundle.\n` +
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
    validateAgentPlatformBundleArchive(service, archivePath);
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
    const normalizedRelativePath = relativePath.replace(/\\/g, "/");
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

  if (service.id === "agent-platform" && fs.existsSync(path.join(directoryPath, "local-cli-acp-relay", "README.md"))) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${directoryPath}\n` +
        `Unexpected non-runtime file local-cli-acp-relay/README.md in final bundle.\n` +
        `Please regenerate the upstream release bundle.`
    );
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
}

export function syncBuiltinAssets(projectRoot = process.cwd(), options = {}) {
  const { os, arch, signDarwin = false } = options;
  const outputRoot = desktopBuiltinServicesDir(projectRoot);
  const platform = { os, arch };
  const services = discoverBuiltinServices(platform);
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

  fs.writeFileSync(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), services: manifest }, null, 2)}\n`,
    "utf8"
  );

  cleanupLegacyBrandScopedServiceAssets(projectRoot);

  return manifest;
}
