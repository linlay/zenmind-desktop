import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// monorepo 根目录：zenmind-desktop 的上一级
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const BUILTIN_ASSETS_SOURCE_ENV = "DESKTOP_BUILTIN_ASSETS_SOURCE";
const LEGACY_BUILTIN_ASSETS_SOURCE_ENV = "ZENMIND_BUILTIN_ASSETS_SOURCE";
const BUILTIN_ASSETS_SOURCE_ENV_LABEL = `${BUILTIN_ASSETS_SOURCE_ENV} or ${LEGACY_BUILTIN_ASSETS_SOURCE_ENV}`;
const REQUIRED_DESKTOP_CORE_SERVICE_IDS = [
  "zenmind-app-server",
  "agent-platform",
  "agent-webclient"
];

function isArchiveFileName(fileName) {
  return fileName.endsWith(".zip");
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

function computeAssetSignature(assetPath) {
  const stat = fs.statSync(assetPath);
  const sha256 = createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
  return `${stat.size}:${sha256}`;
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

function validateZenmindAppServerBundleArchive(service, archivePath) {
  const manifest = readManifestFromArchive(archivePath);
  const envExamplePath = `${service.bundleTopLevelDir}/.env.example`;
  const envExample = readArchiveEntryText(archivePath, envExamplePath);
  if (!envExample || !envExample.includes("FRONTEND_DIST_DIR=./frontend/dist")) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected a stale zenmind-app-server env template without FRONTEND_DIST_DIR=./frontend/dist.\n` +
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
          `Detected a stale zenmind-app-server Windows launcher without FRONTEND_DIST_DIR handling.\n` +
          `Please rebuild or reselect the Desktop-ready program bundle.`
      );
    }
    validateZenmindAppServerAuthCapabilities(service, archivePath, manifest, "windowsCommand");
    return;
  }

  if (
    !programCommon.includes('FRONTEND_DIST_DIR="${FRONTEND_DIST_DIR:-./frontend/dist}"') ||
    !programCommon.includes('nohup "$BACKEND_BIN"')
  ) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected a stale zenmind-app-server launcher without Desktop compatibility markers.\n` +
        `Please rebuild or reselect the Desktop-ready program bundle.`
    );
  }

  const commandKey = manifest?.platform?.os === "linux" ? "linuxCommand" : "darwinCommand";
  validateZenmindAppServerAuthCapabilities(service, archivePath, manifest, commandKey);
}

function hasNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

function validateZenmindAppServerAuthCapabilities(service, archivePath, manifest, commandKey) {
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
        `Please rebuild the Desktop-ready zenmind-app-server bundle with manifest-declared auth providers.`
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
        `Please rebuild the Desktop-ready zenmind-app-server bundle with manifest-declared auth providers.`
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
  if (service.id === "zenmind-app-server") {
    validateZenmindAppServerBundleArchive(service, archivePath);
  }
}

export function syncBuiltinAssets(projectRoot = process.cwd(), { os, arch } = {}) {
  const outputRoot = path.join(projectRoot, "build", "resources", "services");
  const platform = { os, arch };
  const services = discoverBuiltinServices(platform);

  assertRequiredDesktopCoreServices(services, platform);

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
      assetFileName: service.assetFileName,
      assetSignature: computeAssetSignature(outputArchivePath)
    };
  });

  fs.writeFileSync(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), services: manifest }, null, 2)}\n`,
    "utf8"
  );

  return manifest;
}
