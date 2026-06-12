import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadBrandConfig, resolveBrandId } from "./lib/brand-config.mjs";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

export const ENV_ZIP_ENV_VAR = "ENV_ZIP";
export const BUNDLED_ENV_FILE_NAME = "env.zip";
export const BUNDLED_ENV_MANIFEST_FILE_NAME = "manifest.json";

const VERSION_FILE_NAME = "VERSION";
const ENV_ZIP_ROOT_DIR_NAME = "env";

function normalizeVersion(value) {
  return String(value ?? "").trim().replace(/^v/iu, "");
}

function readDesktopVersion(rootDir) {
  const versionPath = path.join(rootDir, VERSION_FILE_NAME);
  const version = normalizeVersion(fs.readFileSync(versionPath, "utf8"));
  if (!version) {
    throw new Error(`empty VERSION file: ${versionPath}`);
  }
  return version;
}

function bundledEnvRoot(rootDir) {
  return path.join(rootDir, "build", "resources", "env");
}

function resolveBrandRuntimeRootDirName(rootDir, env) {
  const brandId = resolveBrandId([], env);
  try {
    return loadBrandConfig(rootDir, brandId).paths.runtimeRootDirName;
  } catch (error) {
    if (fs.existsSync(path.join(rootDir, "brands"))) {
      throw error;
    }
    return `.${brandId}`;
  }
}

function normalizeArchiveEntryName(entryName) {
  let normalized = entryName.replace(/\\/gu, "/").replace(/^\/+/u, "");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function entrySegments(entryName) {
  return normalizeArchiveEntryName(entryName).split("/").filter(Boolean);
}

function shouldSkipArchiveEntry(entryName) {
  const segments = entrySegments(entryName);
  if (segments.length === 0) {
    return true;
  }
  return segments[0] === "__MACOSX" || segments[segments.length - 1] === ".DS_Store";
}

function normalizeSafeRelativePath(relativePath) {
  const normalized = path.posix.normalize(relativePath.replace(/\\/gu, "/"));
  if (
    !normalized ||
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`ENV_ZIP contains an unsafe path: ${relativePath}`);
  }
  return normalized;
}

function isNestedEnvWrapperSegment(segment, runtimeRootDirName) {
  const normalized = segment.trim().toLowerCase();
  const normalizedRuntimeRootDirName = runtimeRootDirName.trim().toLowerCase();
  const normalizedRuntimeRootName = normalizedRuntimeRootDirName.replace(/^\./u, "");
  return (
    normalized === ENV_ZIP_ROOT_DIR_NAME ||
    normalized === normalizedRuntimeRootDirName ||
    normalized === normalizedRuntimeRootName ||
    normalized === ".zenmind" ||
    normalized === "zenmind" ||
    normalized === "zenmind-env" ||
    /^zenmind-env[-_].+/u.test(normalized)
  );
}

function normalizeEnvZipEntryRelativePath(entryName, runtimeRootDirName) {
  const segments = entrySegments(entryName);
  if (segments.length === 0) {
    return null;
  }
  if (segments[0] !== ENV_ZIP_ROOT_DIR_NAME) {
    throw new Error(`ENV_ZIP must contain a single top-level env/ directory; found ${entryName}`);
  }
  if (segments.length === 1) {
    return null;
  }
  if (isNestedEnvWrapperSegment(segments[1] ?? "", runtimeRootDirName)) {
    throw new Error(`ENV_ZIP must not contain a nested environment wrapper under env/: ${entryName}`);
  }
  return normalizeSafeRelativePath(segments.slice(1).join("/"));
}

export async function readEnvZipVersion(zipPath, options = {}) {
  const runtimeRootDirName = options.runtimeRootDirName ?? resolveBrandRuntimeRootDirName(
    options.rootDir ?? projectRoot,
    options.env ?? process.env
  );
  const zip = await JSZip.loadAsync(await fs.promises.readFile(zipPath));
  const usableEntries = Object.values(zip.files).filter((entry) => !shouldSkipArchiveEntry(entry.name));
  let versionEntry = null;

  for (const entry of usableEntries) {
    const relativePath = normalizeEnvZipEntryRelativePath(entry.name, runtimeRootDirName);
    if (!entry.dir && relativePath === VERSION_FILE_NAME) {
      versionEntry = entry;
      break;
    }
  }

  if (!versionEntry) {
    return null;
  }
  return normalizeVersion(await versionEntry.async("string")) || null;
}

async function validateEnvZipVersion(zipPath, expectedVersion, options) {
  const actualVersion = await readEnvZipVersion(zipPath, options);
  if (!actualVersion) {
    throw new Error("ENV_ZIP is missing a VERSION file.");
  }
  if (actualVersion !== expectedVersion) {
    throw new Error(`ENV_ZIP VERSION mismatch: expected ${expectedVersion}, got ${actualVersion}.`);
  }
}

function resolveEnvZipPath(rootDir, env) {
  const rawEnvZip = String(env[ENV_ZIP_ENV_VAR] ?? "").trim();
  if (!rawEnvZip) {
    return null;
  }
  return path.isAbsolute(rawEnvZip) ? rawEnvZip : path.resolve(rootDir, rawEnvZip);
}

function isPathInside(parentDir, candidatePath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function computeFileSha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeManifest(envRoot, manifest) {
  fs.writeFileSync(
    path.join(envRoot, BUNDLED_ENV_MANIFEST_FILE_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

export async function prepareBundledEnvZip({
  rootDir = projectRoot,
  env = process.env,
  logger = console
} = {}) {
  const envRoot = bundledEnvRoot(rootDir);
  const expectedVersion = readDesktopVersion(rootDir);
  const sourceZipPath = resolveEnvZipPath(rootDir, env);
  const runtimeRootDirName = resolveBrandRuntimeRootDirName(rootDir, env);

  if (sourceZipPath) {
    if (isPathInside(envRoot, sourceZipPath)) {
      throw new Error(`ENV_ZIP must not point inside ${path.relative(rootDir, envRoot)} because that directory is recreated.`);
    }
    if (path.extname(sourceZipPath).toLowerCase() !== ".zip") {
      throw new Error(`ENV_ZIP must point to a .zip file: ${sourceZipPath}`);
    }
    if (!fs.existsSync(sourceZipPath) || !fs.statSync(sourceZipPath).isFile()) {
      throw new Error(`ENV_ZIP file not found: ${sourceZipPath}`);
    }
  }

  fs.rmSync(envRoot, { recursive: true, force: true });
  fs.mkdirSync(envRoot, { recursive: true });

  if (!sourceZipPath) {
    const manifest = {
      bundled: false,
      fileName: null,
      version: expectedVersion
    };
    writeManifest(envRoot, manifest);
    logger.log(`no ${ENV_ZIP_ENV_VAR} provided; packaged app will not include env.zip`);
    return {
      ...manifest,
      outputPath: null
    };
  }

  await validateEnvZipVersion(sourceZipPath, expectedVersion, { rootDir, env, runtimeRootDirName });
  const outputPath = path.join(envRoot, BUNDLED_ENV_FILE_NAME);
  fs.copyFileSync(sourceZipPath, outputPath);
  const stat = fs.statSync(outputPath);
  const manifest = {
    bundled: true,
    fileName: BUNDLED_ENV_FILE_NAME,
    version: expectedVersion,
    size: stat.size,
    sha256: computeFileSha256(outputPath)
  };
  writeManifest(envRoot, manifest);
  logger.log(`bundled ${ENV_ZIP_ENV_VAR} into ${path.relative(rootDir, outputPath)}`);
  return {
    ...manifest,
    outputPath
  };
}

async function main() {
  await prepareBundledEnvZip();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
