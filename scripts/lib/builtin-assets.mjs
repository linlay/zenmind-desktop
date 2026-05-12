import fs from "node:fs";
import os from "node:os";
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

  const execOpts = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  let raw;
  if (!isZipArchive(archivePath)) {
    raw = execFileSync("tar", ["-xzf", archivePath, "-O", manifestEntry], execOpts);
  } else if (canUseUnzip()) {
    // 通配符同时覆盖正斜杠（标准 zip）和反斜杠（PowerShell Compress-Archive 旧产物）
    raw = execFileSync("unzip", ["-p", archivePath, "*manifest.json"], execOpts);
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-archive-"));
  try {
    if (!isZipArchive(archivePath)) {
      execFileSync("tar", ["-xzf", archivePath, "-C", tempRoot], { stdio: "ignore" });
    } else if (canUseUnzip()) {
      execFileSync("unzip", ["-qq", archivePath, "-d", tempRoot], { stdio: "ignore" });
    } else {
      execFileSync("tar", ["-xf", archivePath, "-C", tempRoot], { stdio: "ignore" });
    }

    const extractedPath = path.join(tempRoot, ...matchedEntry.split("/"));
    if (!fs.existsSync(extractedPath)) {
      return null;
    }

    const raw = fs.readFileSync(extractedPath, "utf8");
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
    (envExample && /LOCAL_CLI_ACP_RELAY_|CLAUDE_CODE_ACP_/u.test(envExample))
  ) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected legacy relay residue in the bundled startup/config files.\n` +
        `Please rebuild or reselect the clean Desktop release bundle where relay settings live in the standalone plugin.`
    );
  }
}

function validateAgentWebclientBundleArchive(service, archivePath) {
  const manifest = readManifestFromArchive(archivePath);
  const isWindowsArchive = archivePath.endsWith(".zip");
  const envBindingKeys = Array.isArray(manifest?.desktop?.envBindings)
    ? manifest.desktop.envBindings
      .map((binding) => (binding && typeof binding.key === "string" ? binding.key.trim() : ""))
      .filter(Boolean)
    : [];
  for (const requiredKey of ["BASE_URL", "WS_BASE_URL"]) {
    if (!envBindingKeys.includes(requiredKey)) {
      throw new Error(
        `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
          `Missing desktop env binding ${requiredKey} in manifest.json.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
      );
    }
  }

  if (manifest?.backend?.entry !== "backend/server.cjs") {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Expected backend.entry to be backend/server.cjs, got ${JSON.stringify(manifest?.backend?.entry)}.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }

  const entries = listArchiveEntries(archivePath);
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
    ? ["BackendPackageFile", "BackendModulesDir", "backend\\package.json", "backend\\node_modules"]
    : ["BACKEND_PACKAGE_FILE", "BACKEND_NODE_MODULES_DIR", "backend/package.json", "backend/node_modules"];
  const staleRuntimeMarker = staleRuntimeMarkers.find((marker) => programCommon.includes(marker));
  if (staleRuntimeMarker) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected stale launcher runtime check ${JSON.stringify(staleRuntimeMarker)} in ${programCommonPath}.\n` +
        `The Desktop-ready agent-webclient bundle is self-contained in backend/server.cjs and must not require backend/package.json or backend/node_modules.`
    );
  }
  const hasBundleRelativeBackendEntry = isWindowsArchive
    ? /\$Script:BackendEntry\s*=\s*Join-Path\s+\(Join-Path\s+\$Script:BundleRoot\s+['"]backend['"]\)\s+['"]server\.cjs['"]/u.test(programCommon)
    : /BACKEND_ENTRY=["']\$\{?BUNDLE_ROOT\}?\/backend\/server\.cjs["']/u.test(programCommon);
  if (!hasBundleRelativeBackendEntry) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Expected ${programCommonPath} to launch $BUNDLE_ROOT/backend/server.cjs instead of an absolute or legacy backend path.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }

  const forbiddenEntries = [
    `${service.bundleTopLevelDir}/backend/package.json`,
    `${service.bundleTopLevelDir}/backend/package-lock.json`,
    `${service.bundleTopLevelDir}/README.txt`
  ];
  const forbiddenPrefixes = [
    `${service.bundleTopLevelDir}/backend/node_modules/`
  ];
  const forbiddenEntry = forbiddenEntries.find((entry) => entries.has(entry));
  if (forbiddenEntry) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Unexpected legacy runtime file ${forbiddenEntry} in bundled backend.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }
  const forbiddenPrefix = forbiddenPrefixes.find((prefix) => [...entries].some((entry) => entry.startsWith(prefix)));
  if (forbiddenPrefix) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Unexpected legacy runtime directory ${forbiddenPrefix} in bundled backend.\n` +
        `Please rebuild the Desktop-ready agent-webclient bundle.`
    );
  }

  const serverPath = `${service.bundleTopLevelDir}/${manifest.backend.entry}`;
  const serverContent = readArchiveEntryText(archivePath, serverPath);
  if (
    !serverContent ||
    serverContent.includes("(secure ? https : http).request") ||
    serverContent.includes("function buildUpgradeRequest(") ||
    !serverContent.includes("function createWebSocketProxy(") ||
    !serverContent.includes("proxy.upgrade(req, socket, head)") ||
    !serverContent.includes("server.on('upgrade'")
  ) {
    throw new Error(
      `invalid builtin bundle for ${service.id}: ${archivePath}\n` +
        `Detected a stale agent-webclient websocket proxy in bundled backend entry ${manifest.backend.entry}.\n` +
        `Please rebuild the bundle with the http-proxy-middleware WebSocket upgrade proxy.`
    );
  }
}

function validateZenmindAppServerBundleArchive(service, archivePath) {
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
