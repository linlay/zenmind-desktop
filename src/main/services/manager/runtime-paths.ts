import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import { APP_BRAND } from "../../../shared/brand";

export function resolveHomeDir(app?: App | null) {
  try {
    const homePath = app?.getPath("home")?.trim();
    if (homePath) {
      return homePath;
    }
  } catch {
    // Fall back to the process home directory when Electron does not expose a home path yet.
  }
  return process.env.HOME || os.homedir();
}

export function resolvePreferredAgentPlatformRuntimeRoot(app?: App | null) {
  return path.join(resolveHomeDir(app), APP_BRAND.paths.runtimeRootDirName);
}
