const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {object} WebappPackageLimits
 * @property {number} maxArchiveBytes
 * @property {number} maxExpandedBytes
 * @property {number} maxFileBytes
 * @property {number} maxEntries
 * @property {number} maxCompressionRatio
 */

/** @type {Readonly<WebappPackageLimits>} */
const WEBAPP_PACKAGE_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
  maxCompressionRatio: 200
});

const DISALLOWED_PACKAGE_SEGMENT = /^(?:\.env(?:\..*)?|\.git|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|dist-cache|coverage|logs?)$/iu;
const NATIVE_EXTENSIONS = new Set([".dll", ".dylib", ".node", ".pyd", ".so"]);
const MACH_O_HEADERS = new Set(["cafebabe", "bebafeca", "feedface", "feedfacf", "cefaedfe", "cffaedfe"]);

class WebappPackageValidationError extends Error {
  /**
   * @param {"archive" | "package"} stage
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(stage, code, message, details = {}) {
    super(message);
    this.name = "WebappPackageValidationError";
    this.stage = stage;
    this.code = code;
    this.details = details;
  }
}

/** @param {string} value */
function normalizePackagePath(value) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

/**
 * @param {string} value
 * @param {"archive" | "package"} [stage]
 */
function assertSafeRelativePackagePath(value, stage = "package") {
  const normalized = normalizePackagePath(value);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new WebappPackageValidationError(stage, "unsafe_path", `Unsafe package path: ${value}`, {
      path: value
    });
  }
  return normalized;
}

/**
 * @param {string} value
 * @param {"archive" | "package"} [stage]
 */
function assertAllowedPackagePath(value, stage = "package") {
  const normalized = assertSafeRelativePackagePath(value, stage);
  if (normalized.split("/").some((segment) => DISALLOWED_PACKAGE_SEGMENT.test(segment))) {
    throw new WebappPackageValidationError(
      stage,
      "disallowed_path",
      `Development, secret, or runtime-only path is not allowed: ${normalized}`,
      { path: normalized }
    );
  }
  return normalized;
}

/**
 * @typedef {object} ZipEntryDescriptor
 * @property {string} name
 * @property {boolean} [dir]
 * @property {number} [unixPermissions]
 * @property {number} [compressedSize]
 * @property {number} [uncompressedSize]
 */

/**
 * @param {ZipEntryDescriptor[]} entries
 * @param {Partial<WebappPackageLimits> & {archiveBytes?: number}} [options]
 */
function validateZipEntrySafety(entries, options = {}) {
  const limits = { ...WEBAPP_PACKAGE_LIMITS, ...options };
  if (entries.length === 0 || entries.length > limits.maxEntries) {
    throw new WebappPackageValidationError(
      "archive",
      "entry_limit_exceeded",
      `ZIP entry count is invalid: ${entries.length}`,
      { entryCount: entries.length, required: limits.maxEntries }
    );
  }
  if (typeof options.archiveBytes === "number" && options.archiveBytes > limits.maxArchiveBytes) {
    throw new WebappPackageValidationError(
      "archive",
      "archive_too_large",
      "ZIP exceeds the archive size limit.",
      { detected: options.archiveBytes, required: limits.maxArchiveBytes }
    );
  }

  const names = new Set();
  const caseFoldedNames = new Set();
  let expandedBytes = 0;
  for (const entry of entries) {
    const name = assertSafeRelativePackagePath(entry.name, "archive");
    const foldedName = name.toLocaleLowerCase("en-US");
    if (caseFoldedNames.has(foldedName)) {
      throw new WebappPackageValidationError(
        "archive",
        "case_collision",
        `ZIP contains a case-insensitive path collision: ${name}`,
        { path: name }
      );
    }
    caseFoldedNames.add(foldedName);
    names.add(name);

    const unixMode = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
    const unixType = unixMode & 0o170000;
    if (unixType === 0o120000) {
      throw new WebappPackageValidationError("archive", "symbolic_link", `ZIP contains a symbolic link: ${name}`, {
        path: name
      });
    }
    if (unixType && unixType !== 0o100000 && unixType !== 0o040000) {
      throw new WebappPackageValidationError("archive", "special_file", `ZIP contains a special file: ${name}`, {
        path: name
      });
    }
    if (entry.dir) {
      continue;
    }

    const uncompressedSize = Number(entry.uncompressedSize ?? 0);
    const compressedSize = Number(entry.compressedSize ?? 0);
    if (!Number.isFinite(uncompressedSize) || uncompressedSize < 0 || uncompressedSize > limits.maxFileBytes) {
      throw new WebappPackageValidationError("archive", "file_too_large", `ZIP entry is too large: ${name}`, {
        path: name,
        detected: uncompressedSize,
        required: limits.maxFileBytes
      });
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > limits.maxExpandedBytes) {
      throw new WebappPackageValidationError(
        "archive",
        "expanded_size_exceeded",
        "Expanded ZIP size exceeds the limit.",
        { detected: expandedBytes, required: limits.maxExpandedBytes }
      );
    }
    if (
      uncompressedSize > 1024 * 1024 &&
      uncompressedSize / Math.max(1, compressedSize) > limits.maxCompressionRatio
    ) {
      throw new WebappPackageValidationError(
        "archive",
        "compression_ratio_exceeded",
        `ZIP compression ratio exceeds the limit: ${name}`,
        { path: name, detected: uncompressedSize / Math.max(1, compressedSize), required: limits.maxCompressionRatio }
      );
    }
  }
  return { entries: names, expandedBytes };
}

/**
 * @param {Iterable<string>} entryNames
 * @param {RegExp} idPattern
 */
function validateWebappArchiveLayout(entryNames, idPattern) {
  const normalizedEntries = [...entryNames].map((entry) =>
    assertSafeRelativePackagePath(entry, "archive")
  );
  const topLevelNames = new Set(normalizedEntries.map((entry) => entry.split("/")[0]).filter(Boolean));
  if (topLevelNames.size !== 1) {
    throw new WebappPackageValidationError(
      "archive",
      "invalid_root",
      "ZIP must contain exactly one top-level directory."
    );
  }
  const rootName = [...topLevelNames][0];
  if (!idPattern.test(rootName)) {
    throw new WebappPackageValidationError(
      "archive",
      "invalid_root_id",
      "ZIP top-level directory must match the Desktop-generated WebApp id.",
      { path: rootName }
    );
  }
  const manifestEntry = `${rootName}/webapp.json`;
  const manifests = normalizedEntries.filter((entry) => entry.split("/").at(-1) === "webapp.json");
  if (manifests.length !== 1 || manifests[0] !== manifestEntry) {
    throw new WebappPackageValidationError(
      "archive",
      "manifest_layout_invalid",
      "ZIP must contain one webapp.json directly below its top-level directory.",
      { path: manifestEntry }
    );
  }
  for (const entry of normalizedEntries) {
    const relativePath = entry.slice(rootName.length + 1);
    if (relativePath) {
      assertAllowedPackagePath(relativePath, "archive");
    }
  }
  return rootName;
}

/**
 * @param {string} rootPath
 * @param {string} relativePath
 * @param {"file" | "directory"} expectedType
 * @param {string} [displayPath]
 */
function resolveRequiredPath(rootPath, relativePath, expectedType, displayPath = relativePath) {
  const normalized = assertSafeRelativePackagePath(relativePath, "package");
  const root = fs.realpathSync(rootPath);
  const targetPath = path.resolve(root, ...normalized.split("/"));
  let realTarget;
  try {
    realTarget = fs.realpathSync(targetPath);
  } catch {
    throw new WebappPackageValidationError(
      "package",
      expectedType === "file" ? "required_file_missing" : "required_directory_missing",
      `Required ${expectedType} is missing: ${displayPath}`,
      { path: displayPath }
    );
  }
  if (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`)) {
    throw new WebappPackageValidationError("package", "path_escape", `Path escapes the package: ${displayPath}`, {
      path: displayPath
    });
  }
  const stat = fs.statSync(realTarget);
  if (expectedType === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new WebappPackageValidationError(
      "package",
      expectedType === "file" ? "required_file_missing" : "required_directory_missing",
      `Required ${expectedType} is missing: ${displayPath}`,
      { path: displayPath }
    );
  }
  return realTarget;
}

/**
 * @param {string} rootPath
 * @param {any} manifest
 * @param {{outputPath?: string}} [options]
 */
function validateWebappPackageDirectory(rootPath, manifest, options = {}) {
  const absoluteRoot = path.resolve(rootPath);
  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) {
    throw new WebappPackageValidationError("package", "project_missing", "The WebApp package directory does not exist.", {
      path: absoluteRoot
    });
  }
  const root = fs.realpathSync(absoluteRoot);
  const resolvedOutput = options.outputPath ? path.resolve(options.outputPath) : "";
  /** @type {Array<{absolutePath: string, relativePath: string, stat: import("node:fs").Stats}>} */
  const files = [];
  /** @type {string[]} */
  const nativeArtifacts = [];
  let totalBytes = 0;
  /** @param {string} directory */
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (resolvedOutput && path.resolve(absolutePath) === resolvedOutput) {
        continue;
      }
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      assertAllowedPackagePath(relativePath, "package");
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new WebappPackageValidationError("package", "symbolic_link", `Symbolic links are not allowed: ${relativePath}`, {
          path: relativePath
        });
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new WebappPackageValidationError("package", "special_file", `Only ordinary files are allowed: ${relativePath}`, {
          path: relativePath
        });
      }
      if (stat.size > WEBAPP_PACKAGE_LIMITS.maxFileBytes) {
        throw new WebappPackageValidationError("package", "file_too_large", `Package file is too large: ${relativePath}`, {
          path: relativePath,
          detected: stat.size,
          required: WEBAPP_PACKAGE_LIMITS.maxFileBytes
        });
      }
      files.push({ absolutePath, relativePath, stat });
      totalBytes += stat.size;
      if (NATIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        nativeArtifacts.push(relativePath);
      }
      if (files.length > WEBAPP_PACKAGE_LIMITS.maxEntries || totalBytes > WEBAPP_PACKAGE_LIMITS.maxExpandedBytes) {
        throw new WebappPackageValidationError(
          "package",
          "package_limit_exceeded",
          "Package file count or total size exceeds the limit.",
          { fileCount: files.length, totalBytes }
        );
      }
    }
  };
  visit(root);

  const frontendRoot = resolveRequiredPath(root, manifest.frontend.root, "directory");
  resolveRequiredPath(frontendRoot, manifest.frontend.index, "file", `${manifest.frontend.root}/${manifest.frontend.index}`);
  if (manifest.frontend.routeConfig.navigationFallback) {
    resolveRequiredPath(
      frontendRoot,
      manifest.frontend.routeConfig.navigationFallback,
      "file",
      `${manifest.frontend.root}/${manifest.frontend.routeConfig.navigationFallback}`
    );
  }

  if (manifest.target === "any" && nativeArtifacts.length > 0) {
    throw new WebappPackageValidationError(
      "package",
      "native_artifact_forbidden",
      `target any cannot contain native artifacts: ${nativeArtifacts.join(", ")}`,
      { paths: nativeArtifacts }
    );
  }
  if (
    manifest.target.startsWith("darwin-") &&
    nativeArtifacts.some((entry) => [".dll", ".pyd"].includes(path.extname(entry).toLowerCase()))
  ) {
    throw new WebappPackageValidationError(
      "package",
      "native_artifact_platform_mismatch",
      "macOS WebApp packages cannot contain Windows native artifacts.",
      { paths: nativeArtifacts }
    );
  }
  if (
    manifest.target.startsWith("win32-") &&
    nativeArtifacts.some((entry) => [".dylib", ".so"].includes(path.extname(entry).toLowerCase()))
  ) {
    throw new WebappPackageValidationError(
      "package",
      "native_artifact_platform_mismatch",
      "Windows WebApp packages cannot contain macOS or Linux native artifacts.",
      { paths: nativeArtifacts }
    );
  }

  const command = manifest.backend?.command;
  if (command) {
    const entryPath = resolveRequiredPath(root, command.entry, "file");
    const extension = path.extname(entryPath).toLowerCase();
    if (command.type === "electron-node" && ![".js", ".cjs", ".mjs"].includes(extension)) {
      throw new WebappPackageValidationError(
        "package",
        "invalid_backend_entry",
        "electron-node backend script must be a .js, .cjs, or .mjs file.",
        { path: command.entry }
      );
    }
    if (command.type === "executable") {
      const header = fs.readFileSync(entryPath).subarray(0, 4).toString("hex");
      if (manifest.target.startsWith("win32-")) {
        if (extension !== ".exe" || !header.startsWith("4d5a")) {
          throw new WebappPackageValidationError(
            "package",
            "invalid_executable_format",
            "Windows backend executable must be a valid PE .exe file.",
            { path: command.entry, target: manifest.target }
          );
        }
      } else if (manifest.target.startsWith("darwin-") && !MACH_O_HEADERS.has(header)) {
        throw new WebappPackageValidationError(
          "package",
          "invalid_executable_format",
          "macOS backend executable must be a valid Mach-O or universal binary.",
          { path: command.entry, target: manifest.target }
        );
      }
    }
  }

  return { projectPath: absoluteRoot, files, totalBytes, nativeArtifacts };
}

module.exports = {
  WEBAPP_PACKAGE_LIMITS,
  WebappPackageValidationError,
  assertAllowedPackagePath,
  assertSafeRelativePackagePath,
  normalizePackagePath,
  validateWebappArchiveLayout,
  validateWebappPackageDirectory,
  validateZipEntrySafety
};
