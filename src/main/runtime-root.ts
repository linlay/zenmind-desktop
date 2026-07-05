import { execFileSync } from "node:child_process";
import path from "node:path";
import { APP_BRAND } from "../shared/brand";

export const WINDOWS_RUNTIME_ROOT_REGISTRY_KEY = `Software\\${APP_BRAND.storageNamespace}`;
export const WINDOWS_RUNTIME_ROOT_REGISTRY_VALUE = "DataRoot";

type RuntimeRootPathOptions = {
  platform?: NodeJS.Platform;
  homePath: string;
  registryDataRootPath?: string;
};

let cachedRegistryDataRoot: string | undefined;

function pathApiForRoot(platform: NodeJS.Platform | undefined, rootPath: string) {
  if (platform === "win32") {
    return path.posix.isAbsolute(rootPath) ? path.posix : path.win32;
  }
  if (path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)) {
    return path.win32;
  }
  return path.posix;
}

function expandWindowsEnvironmentVariables(value: string) {
  return value.replace(/%([^%]+)%/gu, (match, name: string) => {
    const replacement = process.env[name] ?? process.env[name.toUpperCase()] ?? process.env[name.toLowerCase()];
    return replacement || match;
  });
}

function unquote(value: string) {
  return value.trim().replace(/^["']|["']$/gu, "").trim();
}

function normalizeConfiguredRuntimeRoot(value: string | undefined, platform: NodeJS.Platform | undefined) {
  const expanded = expandWindowsEnvironmentVariables(unquote(value ?? ""));
  if (!expanded) {
    return "";
  }
  const pathApi = pathApiForRoot(platform, expanded);
  const isAbsolute = pathApi === path.posix
    ? path.posix.isAbsolute(expanded)
    : path.win32.isAbsolute(expanded);
  if (!isAbsolute) {
    return "";
  }
  return pathApi.resolve(expanded);
}

function parseRegQueryValue(output: string) {
  const valuePattern = new RegExp(`^\\s*${WINDOWS_RUNTIME_ROOT_REGISTRY_VALUE}\\s+REG_\\w+\\s+(.+?)\\s*$`, "imu");
  return output.match(valuePattern)?.[1]?.trim() ?? "";
}

export function readWindowsRuntimeRootFromRegistry(platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") {
    return "";
  }
  if (cachedRegistryDataRoot !== undefined) {
    return cachedRegistryDataRoot;
  }

  try {
    const output = execFileSync("reg.exe", [
      "query",
      `HKCU\\${WINDOWS_RUNTIME_ROOT_REGISTRY_KEY}`,
      "/v",
      WINDOWS_RUNTIME_ROOT_REGISTRY_VALUE
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    cachedRegistryDataRoot = parseRegQueryValue(String(output ?? ""));
  } catch {
    cachedRegistryDataRoot = "";
  }
  return cachedRegistryDataRoot;
}

export function resolveRuntimeRootPath({
  platform = process.platform,
  homePath,
  registryDataRootPath = readWindowsRuntimeRootFromRegistry(platform)
}: RuntimeRootPathOptions) {
  const configuredRoot = normalizeConfiguredRuntimeRoot(registryDataRootPath, platform);
  if (platform === "win32" && configuredRoot) {
    return configuredRoot;
  }
  const pathApi = pathApiForRoot(platform, homePath);
  return pathApi.resolve(pathApi.join(homePath, APP_BRAND.paths.runtimeRootDirName));
}

export const __testInternals = {
  normalizeConfiguredRuntimeRoot,
  parseRegQueryValue,
  resolveRuntimeRootPath
};
