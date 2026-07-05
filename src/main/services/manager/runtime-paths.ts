import os from "node:os";
import type { App } from "electron";
import { resolveRuntimeRootPath } from "../../runtime-root";

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
  return resolveRuntimeRootPath({
    platform: process.platform,
    homePath: resolveHomeDir(app)
  });
}
