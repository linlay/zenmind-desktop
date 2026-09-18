import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import {
  getBuiltinServiceVersionRoot,
  getServiceLayout,
  type ServiceLayout
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
  forceStopServiceInstallDir,
  collectManagedServiceStopState
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

export async function stopBuiltinInstallDir(service: ServiceDefinition, installDir: string, layout?: ServiceLayout) {
  const stopCommand = service.stopCommand;
  if (stopCommand.length > 0) {
    try {
      await runExecFile(stopCommand[0], stopCommand.slice(1), installDir);
    } catch {
      // Fall back to direct PID termination below.
    }
  }

  const envPath = layout?.envPath ?? path.join(installDir, ".env");
  const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
  if (!forceStopServiceInstallDir(service, layout ?? installDir, env)) {
    throw new Error(`${service.id} process could not be stopped; installation was not replaced`);
  }
  const remaining = collectManagedServiceStopState(service, layout ?? installDir, env);
  if (remaining.managedMainPid || remaining.managedPortPids.length > 0) {
    throw new Error(`${service.id} process is still running; installation was not replaced`);
  }
}

export async function reconcileBuiltinSiblingInstallDirs(app: App, service: ServiceDefinition, currentInstallDir: string) {
  const siblingInstallDirs = listBuiltinSiblingInstallDirs(app, service, currentInstallDir);
  if (siblingInstallDirs.length === 0) {
    return siblingInstallDirs;
  }

  for (const installDir of siblingInstallDirs) {
    const layout = { ...getServiceLayout(app, service), programDir: installDir };
    await stopBuiltinInstallDir(service, installDir, layout);

    const pidFilePath = resolveRuntimePath(layout, service.runtime.pidRelativePath);
    const pidFromFile = readPid(pidFilePath);
    if (pidFromFile && isProcessRunning(pidFromFile) && pidMatchesInstallDir(pidFromFile, installDir)) {
      continue;
    }

    fs.rmSync(installDir, { recursive: true, force: true });
  }

  return siblingInstallDirs;
}
