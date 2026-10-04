const fs = require("node:fs");
const path = require("node:path");
const { WEBAPP_PACKAGE_LIMITS, WebappPackageValidationError, assertSafeRelativePackagePath } = require("../../../support/archive/package-safety.js");

const DISALLOWED_PACKAGE_SEGMENT = /^(?:\.env(?:\..*)?|\.git|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|dist-cache|coverage|logs?)$/iu;
const NATIVE_EXTENSIONS = new Set([".dll", ".dylib", ".node", ".pyd", ".so"]);
const MACH_O_HEADERS = new Set(["cafebabe", "bebafeca", "feedface", "feedfacf", "cefaedfe", "cffaedfe"]);

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

module.exports = { validateWebappArchiveLayout, validateWebappPackageDirectory };
