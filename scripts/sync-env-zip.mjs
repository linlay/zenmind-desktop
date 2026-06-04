import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

export const ENV_ZIP_ENV_VAR = "ENV_ZIP";
export const BUNDLED_ENV_FILE_NAME = "env.zip";
export const BUNDLED_ENV_MANIFEST_FILE_NAME = "manifest.json";

const ENV_ARCHIVE_WRAPPER_DIRS = new Set([".zenmind", "zenmind", "zenmind-env", "env"]);
const VERSION_FILE_NAME = "VERSION";

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

function isEnvArchiveWrapperDir(dirName) {
  const normalizedDirName = dirName.trim().toLowerCase();
  return (
    ENV_ARCHIVE_WRAPPER_DIRS.has(normalizedDirName) ||
    /^zenmind-env[-_].+/u.test(normalizedDirName)
  );
}

function countWrapperSegments(fileNames) {
  let strippedNames = fileNames.map(normalizeArchiveEntryName);
  let wrapperDepth = 0;

  while (strippedNames.length > 0) {
    const segments = strippedNames.map((entryName) => entryName.split("/").filter(Boolean));
    const firstSegment = segments[0]?.[0] ?? "";
    if (
      !firstSegment ||
      !isEnvArchiveWrapperDir(firstSegment) ||
      !segments.every((entrySegmentsValue) =>
        entrySegmentsValue[0] === firstSegment && entrySegmentsValue.length > 1
      )
    ) {
      break;
    }

    wrapperDepth += 1;
    strippedNames = segments.map((entrySegmentsValue) => entrySegmentsValue.slice(1).join("/"));
  }

  return wrapperDepth;
}

function stripWrapperSegments(entryName, wrapperDepth) {
  const segments = entrySegments(entryName).slice(wrapperDepth);
  return segments.join("/");
}

export async function readEnvZipVersion(zipPath) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(zipPath));
  const usableEntries = Object.values(zip.files).filter((entry) => !shouldSkipArchiveEntry(entry.name));
  const fileNames = usableEntries
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name);
  const wrapperDepth = countWrapperSegments(fileNames);
  const versionEntry = usableEntries.find(
    (entry) => !entry.dir && stripWrapperSegments(entry.name, wrapperDepth) === VERSION_FILE_NAME
  );

  if (!versionEntry) {
    return null;
  }
  return normalizeVersion(await versionEntry.async("string")) || null;
}

async function validateEnvZipVersion(zipPath, expectedVersion) {
  const actualVersion = await readEnvZipVersion(zipPath);
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

  await validateEnvZipVersion(sourceZipPath, expectedVersion);
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
