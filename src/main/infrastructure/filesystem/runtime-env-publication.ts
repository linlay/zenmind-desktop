import fs from "node:fs";
import path from "node:path";
import {
  ENV_IMPORT_MARKER_RELATIVE_PATH,
  ENV_IMPORT_PENDING_RELATIVE_PATH,
  ENV_INITIAL_MANIFEST_RELATIVE_PATH,
  ENV_INITIAL_PACKAGE_RELATIVE_PATH,
  type EnvZipEntry,
  type EnvZipImportResult
} from "./runtime-env-contracts";
import { resolveSafeTargetPath, restoreImportedShellScriptPermissions } from "./runtime-env-archive";

export const ENV_IMPORT_METADATA_PATHS = [
  ENV_INITIAL_PACKAGE_RELATIVE_PATH,
  ENV_INITIAL_MANIFEST_RELATIVE_PATH,
  ENV_IMPORT_MARKER_RELATIVE_PATH
];

// Validate every existing component under the runtime root, including dangling links.
export function inspectEnvImportTarget(root: string, relativePath: string, directory: boolean) {
  const target = resolveSafeTargetPath(root, relativePath);
  const components = [path.resolve(root)];
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    components.push(path.join(components[components.length - 1], segment));
  }
  let targetStat: fs.Stats | undefined;
  for (const component of components) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const expectsDirectory = component !== target || directory;
    if (stat.isSymbolicLink() || (expectsDirectory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Unsafe runtime import target or file type conflict: ${component}`);
    }
    if (component === target) targetStat = stat;
  }
  return targetStat;
}

export function publishRuntimeEnvImport(input: {
  targetRoot: string;
  stageRoot: string;
  entries: EnvZipEntry[];
  platform: NodeJS.Platform;
  result: EnvZipImportResult;
}) {
  const { targetRoot, stageRoot, entries, platform, result } = input;
  const pendingPath = path.join(targetRoot, ENV_IMPORT_PENDING_RELATIVE_PATH);
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  const replacedFiles: Array<{ target: string; backup: string }> = [];
  const changedModes: Array<{ target: string; mode: number }> = [];
  let pendingWritten = false;
  let preserveStage = false;
  const ensureDirectory = (directory: string) => {
    if (fs.existsSync(directory)) return;
    ensureDirectory(path.dirname(directory));
    fs.mkdirSync(directory);
    createdDirectories.push(directory);
  };

  try {
    for (const entry of entries) inspectEnvImportTarget(targetRoot, entry.relativePath, entry.directory);
    for (const relativePath of [...ENV_IMPORT_METADATA_PATHS, ENV_IMPORT_PENDING_RELATIVE_PATH]) {
      inspectEnvImportTarget(targetRoot, relativePath, false);
    }
    ensureDirectory(path.dirname(pendingPath));
    // The marker blocks startup after a process crash; do not silently adopt partial files.
    fs.writeFileSync(pendingPath, `${JSON.stringify({ schemaVersion: 1, stageRoot })}\n`, { flag: "wx", mode: 0o600 });
    pendingWritten = true;
    for (const entry of entries) {
      const target = resolveSafeTargetPath(targetRoot, entry.relativePath);
      const existing = inspectEnvImportTarget(targetRoot, entry.relativePath, entry.directory);
      if (entry.directory) {
        if (!existing) {
          ensureDirectory(target);
          result.createdDirectories += 1;
        }
        continue;
      }
      if (existing) {
        result.skippedFiles += 1;
        if (platform === "darwin" || platform === "linux") {
          if (path.extname(target).toLowerCase() === ".sh") {
            changedModes.push({ target, mode: existing.mode & 0o777 });
            restoreImportedShellScriptPermissions(target, platform);
          }
        }
        continue;
      }
      ensureDirectory(path.dirname(target));
      try {
        fs.copyFileSync(resolveSafeTargetPath(stageRoot, entry.relativePath), target, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        // COPYFILE_EXCL never authorizes removal of a concurrently created file.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") createdFiles.push(target);
        throw error;
      }
      createdFiles.push(target);
      result.copiedFiles += 1;
    }
    // Publish Desktop metadata last. Existing metadata is backed up for rollback.
    for (const [index, relativePath] of ENV_IMPORT_METADATA_PATHS.entries()) {
      const target = resolveSafeTargetPath(targetRoot, relativePath);
      const existing = inspectEnvImportTarget(targetRoot, relativePath, false);
      ensureDirectory(path.dirname(target));
      if (existing) {
        const backup = path.join(stageRoot, `.metadata-backup-${index}`);
        fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
        replacedFiles.push({ target, backup });
      } else {
        createdFiles.push(target);
      }
      fs.renameSync(resolveSafeTargetPath(stageRoot, relativePath), target);
    }
    fs.unlinkSync(pendingPath);
    pendingWritten = false;
  } catch (error) {
    try {
      for (const { target, backup } of replacedFiles.reverse()) fs.renameSync(backup, target);
      for (const target of createdFiles.reverse()) fs.rmSync(target, { force: true });
      for (const { target, mode } of changedModes.reverse()) fs.chmodSync(target, mode);
      if (pendingWritten) fs.unlinkSync(pendingPath);
      for (const directory of createdDirectories.reverse()) fs.rmdirSync(directory);
    } catch {
      preserveStage = true;
      // Keep a gate even when restoring metadata succeeded but later rollback failed.
      try {
        fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
        fs.writeFileSync(pendingPath, `${JSON.stringify({ schemaVersion: 1, stageRoot })}\n`, { mode: 0o600 });
      } catch { /* Preserve the original failure and staging location. */ }
      throw new Error(`Runtime import failed and rollback is incomplete; preserve ${stageRoot} for recovery.`, { cause: error });
    }
    throw error;
  } finally {
    if (!preserveStage) {
      try { fs.rmSync(stageRoot, { recursive: true, force: true }); }
      catch { /* Staging cleanup must not turn a committed import into a failure. */ }
    }
  }
}
