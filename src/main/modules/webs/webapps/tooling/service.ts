import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import packageValidation from "../../../../../shared/webapp-package-validation.js";
import {
  WEBAPP_ID_PATTERN,
  WEBAPP_KEY_PATTERN,
  WEBAPP_MANIFEST_MAX_BYTES,
  parseWebappManifest,
  type WebappManifest,
} from "../../../../../shared/webapp-manifest";
import { WebappToolingError } from "./errors";
import { resolveCreatableWorkspacePath, resolveExistingWorkspacePath } from "./workspace";

const {
  WEBAPP_PACKAGE_LIMITS,
  WebappPackageValidationError,
  normalizePackagePath,
  validateWebappArchiveLayout,
  validateWebappPackageDirectory,
  validateZipEntrySafety,
} = packageValidation;

type ToolingZipEntry = JSZip.JSZipObject & {
  _data?: { compressedSize?: number; uncompressedSize?: number };
  unsafeOriginalName?: string;
};

export type WebappToolingTask =
  | { operation: "manifest.init"; workspaceRoot: string; projectPath: string; key: string; label: string; target?: string; _temporaryToken?: string; _retainBuildTemporary?: boolean }
  | { operation: "manifest.validate"; workspaceRoot: string; projectPath: string; _temporaryToken?: string; _retainBuildTemporary?: boolean }
  | { operation: "package.validate"; workspaceRoot: string; projectPath: string; _temporaryToken?: string; _retainBuildTemporary?: boolean }
  | { operation: "package.validate"; workspaceRoot: string; archivePath: string; _temporaryToken?: string; _retainBuildTemporary?: boolean }
  | { operation: "package.build"; workspaceRoot: string; projectPath: string; outputPath: string; _temporaryToken?: string; _retainBuildTemporary?: boolean };

export type WebappToolingResult = Record<string, string | number>;

type ManifestValidationError = Error & { issues?: Array<{ path?: Array<string | number> }> };

function relativeChild(root: string, child: string) {
  return root === "." ? child : `${root}/${child}`;
}

function taskTemporaryToken(task: WebappToolingTask) {
  return /^[a-f\d]{32}$/u.test(task._temporaryToken || "")
    ? task._temporaryToken!
    : randomBytes(16).toString("hex");
}

function extractionTemporaryRoot(task: WebappToolingTask) {
  return path.join(os.tmpdir(), `desktop-webapp-tooling-${taskTemporaryToken(task)}`);
}

function buildTemporaryPath(outputPath: string, task: WebappToolingTask) {
  return path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${taskTemporaryToken(task)}.tmp.zip`,
  );
}

function normalizePackageError(error: unknown): never {
  if (error instanceof WebappPackageValidationError) {
    throw new WebappToolingError(error.stage, error.code, error.message, error.details);
  }
  throw error;
}

function readManifest(projectPath: string, displayProjectPath: string) {
  const manifestPath = path.join(projectPath, "webapp.json");
  const displayManifestPath = relativeChild(displayProjectPath, "webapp.json");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(manifestPath);
  } catch {
    throw new WebappToolingError("manifest", "manifest_missing", "webapp.json is missing.", {
      path: displayManifestPath,
      suggestion: "Initialize the WebApp manifest before building the package.",
    });
  }
  if (!stat.isFile()) {
    throw new WebappToolingError("manifest", "manifest_not_file", "webapp.json must be an ordinary file.", {
      path: displayManifestPath,
    });
  }
  if (stat.size > WEBAPP_MANIFEST_MAX_BYTES) {
    throw new WebappToolingError("manifest", "manifest_too_large", "webapp.json exceeds the size limit.", {
      path: displayManifestPath,
      detected: stat.size,
      required: WEBAPP_MANIFEST_MAX_BYTES,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new WebappToolingError("manifest", "invalid_json", "webapp.json is not valid JSON.", {
      path: displayManifestPath,
    });
  }
  try {
    return parseWebappManifest(value);
  } catch (error) {
    const validationError = error as ManifestValidationError;
    const issue = Array.isArray(validationError.issues) ? validationError.issues[0] : null;
    throw new WebappToolingError("manifest", "manifest_invalid", error instanceof Error ? error.message : "webapp.json is invalid.", {
      path: displayManifestPath,
      ...(issue ? { field: issue.path?.join(".") || "webapp.json" } : {}),
    });
  }
}

function validateProjectDirectory(projectPath: string, displayProjectPath: string) {
  const manifest = readManifest(projectPath, displayProjectPath);
  try {
    return { manifest, ...validateWebappPackageDirectory(projectPath, manifest) };
  } catch (error) {
    normalizePackageError(error);
  }
}

async function validateArchiveFile(archivePath: string, displayArchivePath: string, task: WebappToolingTask) {
  let archiveStat: fs.Stats;
  try {
    archiveStat = fs.statSync(archivePath);
  } catch {
    throw new WebappToolingError("archive", "archive_missing", "The WebApp ZIP does not exist.", {
      path: displayArchivePath,
    });
  }
  if (!archiveStat.isFile() || archiveStat.size > WEBAPP_PACKAGE_LIMITS.maxArchiveBytes) {
    throw new WebappToolingError("archive", "archive_too_large", "ZIP is missing or exceeds the size limit.", {
      path: displayArchivePath,
      detected: archiveStat.size,
      required: WEBAPP_PACKAGE_LIMITS.maxArchiveBytes,
    });
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(archivePath), { checkCRC32: true });
  } catch {
    throw new WebappToolingError("archive", "invalid_archive", "The WebApp ZIP is invalid.", {
      path: displayArchivePath,
    });
  }
  const entries = Object.values(zip.files) as ToolingZipEntry[];
  try {
    const inspected = validateZipEntrySafety(entries.map((entry) => ({
      name: entry.unsafeOriginalName || entry.name,
      dir: entry.dir,
      unixPermissions: typeof entry.unixPermissions === "number" ? entry.unixPermissions : undefined,
      compressedSize: Number(entry._data?.compressedSize ?? 0),
      uncompressedSize: Number(entry._data?.uncompressedSize ?? 0),
    })), { archiveBytes: archiveStat.size });
    const rootName = validateWebappArchiveLayout(inspected.entries, WEBAPP_ID_PATTERN);
    const temporaryRoot = extractionTemporaryRoot(task);
    fs.mkdirSync(temporaryRoot, { mode: 0o700 });
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
      const project = validateProjectDirectory(path.join(temporaryRoot, rootName), rootName);
      if (project.manifest.id !== rootName) {
        throw new WebappToolingError("archive", "id_mismatch", "ZIP directory name and manifest id do not match.", {
          path: rootName,
          expected: rootName,
          detected: project.manifest.id,
        });
      }
      return {
        manifest: project.manifest,
        archiveBytes: archiveStat.size,
        totalBytes: inspected.expandedBytes,
        entryCount: entries.length,
        sha256: createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex"),
      };
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  } catch (error) {
    normalizePackageError(error);
  }
}

function writeInitialIndex(indexPath: string) {
  try {
    fs.writeFileSync(
      indexPath,
      "<!doctype html>\n<html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>WebApp</title><body></body></html>\n",
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function ensureMinimalFrontend(projectPath: string, manifest: WebappManifest) {
  const indexPath = path.join(projectPath, manifest.frontend.root, manifest.frontend.index);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  writeInitialIndex(indexPath);
}

function initializeManifest(task: Extract<WebappToolingTask, { operation: "manifest.init" }>) {
  const project = resolveCreatableWorkspacePath(task.workspaceRoot, task.projectPath, "manifest");
  const key = task.key.trim();
  const label = task.label.trim();
  if (!WEBAPP_KEY_PATTERN.test(key) || key.length < 3 || key.length > 64) {
    throw new WebappToolingError("manifest", "invalid_key", "key must be 3-64 lowercase letters, digits, or single hyphen-separated segments.", {
      field: "key",
    });
  }
  if (!label) {
    throw new WebappToolingError("manifest", "invalid_label", "label is required.", { field: "label" });
  }
  fs.mkdirSync(project.absolutePath, { recursive: true });
  const manifestPath = path.join(project.absolutePath, "webapp.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = readManifest(project.absolutePath, project.relativePath);
    ensureMinimalFrontend(project.absolutePath, manifest);
    return {
      projectPath: project.relativePath,
      manifestPath: relativeChild(project.relativePath, "webapp.json"),
      id: manifest.id,
      key: manifest.key,
    };
  }
  const id = `webapp-${randomBytes(8).toString("hex")}`;
  let manifest: WebappManifest;
  try {
    manifest = parseWebappManifest({
      schemaVersion: 2,
      id,
      key,
      label,
      version: "1.0.0",
      target: task.target?.trim() || "any",
      appConfig: {},
      frontend: {
        root: "frontend",
        index: "index.html",
        routeConfig: { backendPrefixes: [] },
      },
    });
  } catch (error) {
    throw new WebappToolingError("manifest", "manifest_invalid", error instanceof Error ? error.message : "Manifest input is invalid.");
  }
  ensureMinimalFrontend(project.absolutePath, manifest);
  try {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readManifest(project.absolutePath, project.relativePath);
    return {
      projectPath: project.relativePath,
      manifestPath: relativeChild(project.relativePath, "webapp.json"),
      id: existing.id,
      key: existing.key,
    };
  }
  return {
    projectPath: project.relativePath,
    manifestPath: relativeChild(project.relativePath, "webapp.json"),
    id,
    key,
  };
}

async function buildPackage(task: Extract<WebappToolingTask, { operation: "package.build" }>) {
  const project = resolveExistingWorkspacePath(task.workspaceRoot, task.projectPath, "directory", "package");
  const output = resolveCreatableWorkspacePath(task.workspaceRoot, task.outputPath, "package");
  if (path.extname(output.absolutePath).toLowerCase() !== ".zip") {
    throw new WebappToolingError("package", "unsupported_format", "WebApp packages must use the .zip format.", {
      path: output.relativePath,
    });
  }
  if (fs.existsSync(output.absolutePath)) {
    throw new WebappToolingError("package", "output_exists", "Refusing to overwrite an existing WebApp ZIP.", {
      path: output.relativePath,
      suggestion: "Choose a new output path or archive the previous ZIP first.",
    });
  }
  const validated = validateProjectDirectory(project.absolutePath, project.relativePath);
  fs.mkdirSync(path.dirname(output.absolutePath), { recursive: true });
  const temporaryPath = buildTemporaryPath(output.absolutePath, task);
  let committed = false;
  try {
    const zip = new JSZip();
    for (const file of validated.files) {
      zip.file(`${validated.manifest.id}/${file.relativePath}`, fs.readFileSync(file.absolutePath), {
        unixPermissions: file.stat.mode & 0o777,
      });
    }
    await pipeline(
      zip.generateNodeStream({
        type: "nodebuffer",
        streamFiles: true,
        platform: "UNIX",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      }),
      fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    const archive = await validateArchiveFile(temporaryPath, output.relativePath, task);
    try {
      fs.linkSync(temporaryPath, output.absolutePath);
      committed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WebappToolingError("package", "output_exists", "Refusing to overwrite an existing WebApp ZIP.", {
          path: output.relativePath,
        });
      }
      throw new WebappToolingError("package", "output_commit_failed", "Desktop could not commit the WebApp ZIP.", {
        path: output.relativePath,
      });
    }
    return {
      projectPath: project.relativePath,
      outputPath: output.relativePath,
      id: validated.manifest.id,
      key: validated.manifest.key,
      fileCount: validated.files.length,
      sourceBytes: validated.totalBytes,
      archiveBytes: archive.archiveBytes,
      expandedBytes: archive.totalBytes,
      sha256: archive.sha256,
    };
  } finally {
    if (!committed || !task._retainBuildTemporary) {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}

export async function executeWebappToolingTask(task: WebappToolingTask): Promise<WebappToolingResult> {
  switch (task.operation) {
    case "manifest.init":
      return initializeManifest(task);
    case "manifest.validate": {
      const project = resolveExistingWorkspacePath(task.workspaceRoot, task.projectPath, "directory", "manifest");
      const manifest = readManifest(project.absolutePath, project.relativePath);
      return {
        projectPath: project.relativePath,
        manifestPath: relativeChild(project.relativePath, "webapp.json"),
        id: manifest.id,
        key: manifest.key,
      };
    }
    case "package.validate": {
      if ("archivePath" in task) {
        const archive = resolveExistingWorkspacePath(task.workspaceRoot, task.archivePath, "file", "archive");
        if (path.extname(archive.absolutePath).toLowerCase() !== ".zip") {
          throw new WebappToolingError("archive", "unsupported_format", "WebApp packages must use the .zip format.", {
            path: archive.relativePath,
          });
        }
        const result = await validateArchiveFile(archive.absolutePath, archive.relativePath, task);
        return {
          archivePath: archive.relativePath,
          id: result.manifest.id,
          key: result.manifest.key,
          entryCount: result.entryCount,
          archiveBytes: result.archiveBytes,
          expandedBytes: result.totalBytes,
          sha256: result.sha256,
        };
      }
      const project = resolveExistingWorkspacePath(task.workspaceRoot, task.projectPath, "directory", "package");
      const result = validateProjectDirectory(project.absolutePath, project.relativePath);
      return {
        projectPath: project.relativePath,
        id: result.manifest.id,
        key: result.manifest.key,
        fileCount: result.files.length,
        totalBytes: result.totalBytes,
      };
    }
    case "package.build":
      return buildPackage(task);
  }
}

export function cleanupWebappToolingTemporaryArtifacts(
  task: WebappToolingTask,
  options: { rollbackCommittedOutput?: boolean } = {},
) {
  try {
    fs.rmSync(extractionTemporaryRoot(task), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup must not replace the original Worker outcome.
  }
  if (task.operation !== "package.build") return;
  try {
    const output = resolveCreatableWorkspacePath(task.workspaceRoot, task.outputPath, "package");
    const temporaryPath = buildTemporaryPath(output.absolutePath, task);
    if (options.rollbackCommittedOutput && fs.existsSync(temporaryPath) && fs.existsSync(output.absolutePath)) {
      const temporaryStat = fs.statSync(temporaryPath);
      const outputStat = fs.statSync(output.absolutePath);
      if (temporaryStat.dev === outputStat.dev && temporaryStat.ino === outputStat.ino) {
        fs.rmSync(output.absolutePath, { force: true });
      }
    }
    fs.rmSync(temporaryPath, { force: true });
  } catch {
    // Cleanup must never replace the original Worker outcome.
  }
}
