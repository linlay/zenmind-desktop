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

module.exports = { WEBAPP_PACKAGE_LIMITS, WebappPackageValidationError, assertSafeRelativePackagePath, normalizePackagePath, validateZipEntrySafety };
