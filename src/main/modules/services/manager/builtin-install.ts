import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import {
  getBuiltinServiceVersionRoot
} from "./layout";
import {
  runExecFile
} from "./command-runner";
import {
  isProcessRunning
} from "./process-cleanup";
import {
  pidMatchesInstallDir
} from "./process-identity";
import {
  readPid,
  resolveRuntimePath
} from "./pid-files";
import {
  forceStopServiceInstallDir
} from "./managed-cleanup";

export function listBuiltinSiblingInstallDirs(app: App, service: ServiceDefinition, currentInstallDir: string) {
  const versionRoot = getBuiltinServiceVersionRoot(app, service.id);
  if (!fs.existsSync(versionRoot)) {
    return [];
  }

  return fs.readdirSync(versionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(versionRoot, entry.name))
    .filter((installDir) => path.normalize(installDir) !== path.normalize(currentInstallDir));
}

export async function stopBuiltinInstallDir(service: ServiceDefinition, installDir: string) {
  const stopCommand = service.stopCommand;
  if (stopCommand.length > 0) {
    try {
      await runExecFile(stopCommand[0], stopCommand.slice(1), installDir);
    } catch {
      // Fall back to direct PID termination below.
    }
  }

  const envPath = path.join(installDir, ".env");
  const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
  forceStopServiceInstallDir(service, installDir, env);
}

export async function reconcileBuiltinSiblingInstallDirs(app: App, service: ServiceDefinition, currentInstallDir: string) {
  const siblingInstallDirs = listBuiltinSiblingInstallDirs(app, service, currentInstallDir);
  if (siblingInstallDirs.length === 0) {
    return siblingInstallDirs;
  }

  for (const installDir of siblingInstallDirs) {
    await stopBuiltinInstallDir(service, installDir);

    const pidFilePath = resolveRuntimePath(installDir, service.runtime.pidRelativePath);
    const pidFromFile = readPid(pidFilePath);
    if (pidFromFile && isProcessRunning(pidFromFile) && pidMatchesInstallDir(pidFromFile, installDir)) {
      continue;
    }

    fs.rmSync(installDir, { recursive: true, force: true });
  }

  return siblingInstallDirs;
}
