import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import { APP_BRAND } from "../../../shared/generated/brand";

export const agentPlatformDesktopRuntimePaths = [
  ["REGISTRIES_DIR", "registries"],
  ["TOOLS_DIR", "tools"],
  ["OWNER_DIR", "owner"],
  ["AGENTS_DIR", "agents"],
  ["TEAMS_DIR", "teams"],
  ["ROOT_DIR", "root"],
  ["SCHEDULES_DIR", "schedules"],
  ["CHATS_DIR", "chats"],
  ["MEMORY_DIR", "memory"],
  ["PAN_DIR", "pan"],
  ["SKILLS_MARKET_DIR", "skills-market"]
] as const;

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

export function resolveDesktopDir(app?: App | null, homeDir = resolveHomeDir(app)) {
  try {
    const desktopPath = app?.getPath("desktop")?.trim();
    if (desktopPath) {
      return desktopPath;
    }
  } catch {
    // Fall back to the conventional desktop location when Electron cannot resolve it.
  }
  return path.join(homeDir, "Desktop");
}

export function expandHomeShortcut(value: string, homeDir = resolveHomeDir()) {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return homeDir;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

export function normalizeConfigPath(value: string, homeDir = resolveHomeDir()) {
  return path.normalize(expandHomeShortcut(value, homeDir)).replace(/\\/gu, "/");
}

export function formatDesktopAgentPlatformRuntimePath(app: App, value: string) {
  if (process.platform === "win32") {
    return value;
  }

  const homeDir = resolveHomeDir(app);
  const normalizedHomeDir = normalizeConfigPath(homeDir, homeDir);
  const normalizedValue = normalizeConfigPath(value, homeDir);
  const runtimeRootDirName = APP_BRAND.paths.runtimeRootDirName;
  const normalizedRuntimeRoot = `${normalizedHomeDir}/${runtimeRootDirName}`;
  if (normalizedValue === normalizedRuntimeRoot) {
    return `~/${runtimeRootDirName}`;
  }
  if (normalizedValue.startsWith(`${normalizedRuntimeRoot}/`)) {
    return `~/${runtimeRootDirName}/${normalizedValue.slice(normalizedRuntimeRoot.length + 1)}`;
  }
  return value;
}

export function resolveAgentPlatformInitializationRuntimeRoot(app: App) {
  return path.join(resolveHomeDir(app), APP_BRAND.paths.runtimeRootDirName);
}

export function formatDesktopAgentPlatformRuntimeRoot(app: App, runtimeRoot: string) {
  return formatDesktopAgentPlatformRuntimePath(app, runtimeRoot);
}

export function resolvePreferredAgentPlatformRuntimeRoot(app?: App | null) {
  return path.join(resolveHomeDir(app), APP_BRAND.paths.runtimeRootDirName);
}

export function resolveAgentPlatformAgentsDir(env: Map<string, string>, desktopRuntimeRoot: string | null) {
  const configuredAgentsDir = env.get("AGENTS_DIR")?.trim();
  if (configuredAgentsDir) {
    return configuredAgentsDir;
  }
  const configuredRuntimeRoot = env.get("RUNTIME_DIR")?.trim();
  if (configuredRuntimeRoot) {
    return path.join(configuredRuntimeRoot, "agents");
  }
  if (hasConfiguredAgentPlatformRuntimePath(env)) {
    return "";
  }
  if (!desktopRuntimeRoot) {
    return "";
  }
  return path.join(desktopRuntimeRoot, "agents");
}

export function hasConfiguredAgentPlatformRuntimePath(env: Map<string, string>) {
  return Boolean(env.get("RUNTIME_DIR")?.trim());
}
