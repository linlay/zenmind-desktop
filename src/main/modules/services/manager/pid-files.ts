import fs from "node:fs";
import path from "node:path";
import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";
import {
  resolveServiceRuntimePath,
  type ServiceLayout
} from "./layout";
import {
  matchProcessInstallDir
} from "./process-identity";

type ReadManagedPidFileOptions = {
  isProcessRunningImpl: (pid: number | null) => boolean;
  matchProcessInstallDirImpl?: typeof matchProcessInstallDir;
  removePidFileImpl?: typeof removePidFile;
  verifyInstallDir?: boolean;
};

export function resolveRuntimePath(layoutOrInstallDir: ServiceLayout | string, relativePath: string) {
  if (!relativePath) {
    return "";
  }
  if (typeof layoutOrInstallDir === "string") {
    return path.join(layoutOrInstallDir, relativePath);
  }
  return resolveServiceRuntimePath(layoutOrInstallDir, relativePath);
}

export function readPid(pidFilePath: string) {
  if (!fs.existsSync(pidFilePath)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(pidFilePath, "utf8").trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EBUSY") {
      return null;
    }
    throw error;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function writePidFile(pidFilePath: string, pid: number) {
  ensureDir(path.dirname(pidFilePath));
  fs.writeFileSync(pidFilePath, `${pid}\n`, "utf8");
}

export function removePidFile(pidFilePath: string) {
  try {
    fs.rmSync(pidFilePath, { force: true });
  } catch {
    // Ignore pid cleanup failures and let the next startup attempt surface a real error if needed.
  }
}

export function uniqueNonEmptyPaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean))];
}

export function getManagedPidFilePaths(service: ServiceDefinition, layout: ServiceLayout) {
  if (!service.runtime.pidRelativePath) {
    return [];
  }

  const pidFileName = path.basename(service.runtime.pidRelativePath);
  return uniqueNonEmptyPaths([
    resolveRuntimePath(layout, service.runtime.pidRelativePath),
    resolveRuntimePath(layout.programDir, service.runtime.pidRelativePath),
    pidFileName ? path.join(layout.stateDir, "pid", pidFileName) : ""
  ]);
}

export function readManagedPidFile(
  pidFilePaths: string[],
  installDir: string | undefined,
  options: ReadManagedPidFileOptions
) {
  const matchProcessInstallDirImpl = options.matchProcessInstallDirImpl ?? matchProcessInstallDir;
  const removePidFileImpl = options.removePidFileImpl ?? removePidFile;

  for (const pidFilePath of pidFilePaths) {
    const pid = readPid(pidFilePath);
    if (!pid) {
      if (fs.existsSync(pidFilePath)) {
        removePidFileImpl(pidFilePath);
      }
      continue;
    }
    if (!options.isProcessRunningImpl(pid)) {
      removePidFileImpl(pidFilePath);
      continue;
    }
    if (installDir && options.verifyInstallDir !== false) {
      const match = matchProcessInstallDirImpl(pid, installDir);
      if (match === "mismatched") {
        removePidFileImpl(pidFilePath);
        continue;
      }
      if (match === "unknown") {
        return pid;
      }
    }
    if (pid) {
      return pid;
    }
  }
  return null;
}

export function writeManagedPidFiles(pidFilePaths: string[], pid: number) {
  for (const pidFilePath of pidFilePaths) {
    writePidFile(pidFilePath, pid);
  }
}
