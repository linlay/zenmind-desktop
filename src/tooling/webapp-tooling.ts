#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import packageValidation from "../shared/webapp-package-validation.js";
import {
  WEBAPP_ID_PATTERN,
  WEBAPP_KEY_PATTERN,
  WEBAPP_MANIFEST_MAX_BYTES,
  parseWebappManifest
} from "../../contracts/webapp/webapp-manifest-validator.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const {
  WEBAPP_PACKAGE_LIMITS,
  WebappPackageValidationError,
  normalizePackagePath,
  validateWebappArchiveLayout,
  validateWebappPackageDirectory,
  validateZipEntrySafety
} = packageValidation;

type ToolingStage = "arguments" | "manifest" | "package" | "archive" | "internal";
type ToolingDetails = Record<string, unknown>;
type ToolingOptions = Record<string, string | true>;
type ManifestValidationIssue = {
  path?: Array<string | number>;
};
type ManifestValidationError = Error & {
  issues?: ManifestValidationIssue[];
};
type ToolingZipEntry = JSZip.JSZipObject & {
  _data?: {
    compressedSize?: number;
    uncompressedSize?: number;
  };
};

class ToolingError extends Error {
  stage: ToolingStage;
  code: string;
  details: ToolingDetails;

  constructor(stage: ToolingStage, code: string, message: string, details: ToolingDetails = {}) {
    super(message);
    this.name = "ToolingError";
    this.stage = stage;
    this.code = code;
    this.details = details;
  }
}

function parseOptions(values: string[]) {
  const options: ToolingOptions = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = next;
      index += 1;
    }
  }
  return options;
}

function requireString(options: ToolingOptions, name: string) {
  const value = typeof options[name] === "string" ? options[name].trim() : "";
  if (!value) {
    throw new ToolingError("arguments", "missing_argument", `--${name} is required.`, {
      field: name
    });
  }
  return value;
}

function jsonResult(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function asToolingError(error: unknown) {
  if (error instanceof WebappPackageValidationError) {
    return new ToolingError(error.stage, error.code, error.message, error.details);
  }
  return error;
}

function readManifest(projectPath: string) {
  const manifestPath = path.join(projectPath, "webapp.json");
  let stat;
  try {
    stat = fs.statSync(manifestPath);
  } catch {
    throw new ToolingError("manifest", "manifest_missing", "webapp.json is missing.", {
      path: manifestPath,
      suggestion: "Run manifest init before building the package."
    });
  }
  if (!stat.isFile()) {
    throw new ToolingError("manifest", "manifest_not_file", "webapp.json must be an ordinary file.", {
      path: manifestPath
    });
  }
  if (stat.size > WEBAPP_MANIFEST_MAX_BYTES) {
    throw new ToolingError("manifest", "manifest_too_large", "webapp.json exceeds the size limit.", {
      path: manifestPath,
      detected: stat.size,
      required: WEBAPP_MANIFEST_MAX_BYTES
    });
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new ToolingError("manifest", "invalid_json", error instanceof Error ? error.message : String(error), {
      path: manifestPath
    });
  }
  try {
    return parseWebappManifest(value);
  } catch (error) {
    const validationError = error as ManifestValidationError;
    const issue = Array.isArray(validationError.issues) ? validationError.issues[0] : null;
    throw new ToolingError("manifest", "manifest_invalid", error instanceof Error ? error.message : String(error), {
      path: manifestPath,
      ...(issue ? { field: issue.path?.join(".") || "webapp.json" } : {})
    });
  }
}

function validateProject(projectPath: string) {
  const absoluteProjectPath = path.resolve(projectPath);
  if (!fs.existsSync(absoluteProjectPath) || !fs.statSync(absoluteProjectPath).isDirectory()) {
    throw new ToolingError("package", "project_missing", "The WebApp project directory does not exist.", {
      path: absoluteProjectPath
    });
  }
  const manifest = readManifest(absoluteProjectPath);
  try {
    return {
      manifest,
      ...validateWebappPackageDirectory(absoluteProjectPath, manifest)
    };
  } catch (error) {
    throw asToolingError(error);
  }
}

async function validateArchive(archivePath: string) {
  const absoluteArchivePath = path.resolve(archivePath);
  if (path.extname(absoluteArchivePath).toLowerCase() !== ".zip") {
    throw new ToolingError("archive", "unsupported_format", "WebApp packages must use the .zip format.", {
      path: absoluteArchivePath
    });
  }
  let archiveStat;
  try {
    archiveStat = fs.statSync(absoluteArchivePath);
  } catch {
    throw new ToolingError("archive", "archive_missing", "The WebApp ZIP does not exist.", {
      path: absoluteArchivePath
    });
  }
  if (!archiveStat.isFile() || archiveStat.size > WEBAPP_PACKAGE_LIMITS.maxArchiveBytes) {
    throw new ToolingError("archive", "archive_too_large", "ZIP is missing or exceeds the size limit.", {
      path: absoluteArchivePath,
      detected: archiveStat.size,
      required: WEBAPP_PACKAGE_LIMITS.maxArchiveBytes
    });
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(absoluteArchivePath), { checkCRC32: true });
  } catch (error) {
    throw new ToolingError(
      "archive",
      "invalid_archive",
      error instanceof Error ? error.message : String(error),
      { path: absoluteArchivePath }
    );
  }
  const entries = Object.values(zip.files) as ToolingZipEntry[];
  try {
    const inspected = validateZipEntrySafety(entries.map((entry) => {
      const data = entry._data;
      return {
        name: entry.name,
        dir: entry.dir,
        unixPermissions: typeof entry.unixPermissions === "number" ? entry.unixPermissions : undefined,
        compressedSize: Number(data?.compressedSize ?? 0),
        uncompressedSize: Number(data?.uncompressedSize ?? 0)
      };
    }), { archiveBytes: archiveStat.size });
    const rootName = validateWebappArchiveLayout(inspected.entries, WEBAPP_ID_PATTERN);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-tooling-"));
    try {
      for (const entry of entries) {
        const normalized = normalizePackagePath(entry.name);
        const targetPath = path.join(temporaryRoot, ...normalized.split("/"));
        if (entry.dir) {
          fs.mkdirSync(targetPath, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, await entry.async("nodebuffer"));
        if (typeof entry.unixPermissions === "number") {
          fs.chmodSync(targetPath, entry.unixPermissions & 0o777);
        }
      }
      const project = validateProject(path.join(temporaryRoot, rootName));
      if (project.manifest.id !== rootName) {
        throw new ToolingError("archive", "id_mismatch", "ZIP directory name and manifest id do not match.", {
          path: rootName,
          expected: rootName,
          detected: project.manifest.id
        });
      }
      return {
        archivePath: absoluteArchivePath,
        manifest: project.manifest,
        totalBytes: inspected.expandedBytes,
        entryCount: entries.length
      };
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  } catch (error) {
    throw asToolingError(error);
  }
}

async function initManifest(options: ToolingOptions) {
  const projectPath = path.resolve(typeof options.project === "string" ? options.project : process.cwd());
  const key = requireString(options, "key");
  const label = requireString(options, "label");
  if (!WEBAPP_KEY_PATTERN.test(key) || key.length < 3 || key.length > 64) {
    throw new ToolingError("manifest", "invalid_key", "key must be 3-64 lowercase letters, digits, or single hyphen-separated segments.", {
      field: "key",
      detected: key
    });
  }
  fs.mkdirSync(projectPath, { recursive: true });
  const manifestPath = path.join(projectPath, "webapp.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = readManifest(projectPath);
    return {
      ok: true,
      stage: "manifest",
      code: "manifest_exists",
      message: "Existing WebApp id preserved.",
      projectPath,
      manifestPath,
      id: manifest.id,
      key: manifest.key
    };
  }
  const id = `webapp-${randomBytes(8).toString("hex")}`;
  const manifest = parseWebappManifest({
    schemaVersion: 2,
    id,
    key,
    label,
    version: "1.0.0",
    target: typeof options.target === "string" ? options.target : "any",
    appConfig: {},
    frontend: {
      root: "frontend",
      index: "index.html",
      routeConfig: { backendPrefixes: [] }
    }
  });
  fs.mkdirSync(path.join(projectPath, "frontend"), { recursive: true });
  const indexPath = path.join(projectPath, "frontend", "index.html");
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, "<!doctype html>\n<html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>WebApp</title><body></body></html>\n", "utf8");
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    ok: true,
    stage: "manifest",
    code: "initialized",
    message: "WebApp manifest initialized with a Desktop-generated id.",
    projectPath,
    manifestPath,
    id,
    key
  };
}

async function buildPackage(options: ToolingOptions) {
  const projectPath = path.resolve(typeof options.project === "string" ? options.project : process.cwd());
  const { manifest, files, totalBytes } = validateProject(projectPath);
  const outputPath = path.resolve(
    typeof options.output === "string"
      ? options.output
      : path.join(path.dirname(projectPath), `${manifest.id}.zip`)
  );
  if (fs.existsSync(outputPath)) {
    throw new ToolingError("package", "output_exists", "Refusing to overwrite an existing WebApp ZIP.", {
      path: outputPath,
      suggestion: "Choose a new output path or archive the previous ZIP first."
    });
  }
  const zip = new JSZip();
  for (const file of files) {
    zip.file(`${manifest.id}/${file.relativePath}`, fs.readFileSync(file.absolutePath), {
      unixPermissions: file.stat.mode & 0o777
    });
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await pipeline(
    zip.generateNodeStream({
      type: "nodebuffer",
      streamFiles: true,
      platform: "UNIX",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    }),
    fs.createWriteStream(temporaryPath, { mode: 0o600 })
  );
  fs.renameSync(temporaryPath, outputPath);
  try {
    const archive = await validateArchive(outputPath);
    const sha256 = createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");
    return {
      ok: true,
      stage: "package",
      code: "package_built",
      message: "WebApp ZIP built and validated.",
      projectPath,
      outputPath,
      id: manifest.id,
      key: manifest.key,
      fileCount: files.length,
      sourceBytes: totalBytes,
      expandedBytes: archive.totalBytes,
      sha256
    };
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
}

async function run() {
  const [group, command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (group === "manifest" && command === "init") {
    return initManifest(options);
  }
  if (group === "manifest" && command === "validate") {
    const projectPath = path.resolve(typeof options.project === "string" ? options.project : process.cwd());
    const manifest = readManifest(projectPath);
    return {
      ok: true,
      stage: "manifest",
      code: "manifest_valid",
      message: "webapp.json is valid.",
      projectPath,
      id: manifest.id,
      key: manifest.key
    };
  }
  if (group === "package" && command === "validate") {
    if (typeof options.archive === "string") {
      const result = await validateArchive(options.archive);
      return {
        ok: true,
        stage: "archive",
        code: "archive_valid",
        message: "WebApp ZIP is valid.",
        archivePath: result.archivePath,
        id: result.manifest.id,
        key: result.manifest.key,
        entryCount: result.entryCount,
        expandedBytes: result.totalBytes
      };
    }
    const projectPath = path.resolve(typeof options.project === "string" ? options.project : process.cwd());
    const result = validateProject(projectPath);
    return {
      ok: true,
      stage: "package",
      code: "project_valid",
      message: "WebApp package directory is valid.",
      projectPath: result.projectPath,
      id: result.manifest.id,
      key: result.manifest.key,
      fileCount: result.files.length,
      totalBytes: result.totalBytes
    };
  }
  if (group === "package" && command === "build") {
    return buildPackage(options);
  }
  throw new ToolingError(
    "arguments",
    "unknown_command",
    "Use: manifest init|validate or package validate|build.",
    { repoRoot }
  );
}

try {
  jsonResult(await run());
} catch (error) {
  const normalized = error instanceof ToolingError
    ? error
    : new ToolingError("internal", "tooling_failed", error instanceof Error ? error.message : String(error));
  jsonResult({
    ok: false,
    stage: normalized.stage,
    code: normalized.code,
    message: normalized.message,
    ...normalized.details
  });
  process.exitCode = 1;
}
