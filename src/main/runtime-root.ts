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

type WindowsRegistryExecFileSync = (
  command: string,
  args: string[],
  options: {
    stdio: ["ignore", "pipe", "ignore"];
    windowsHide: true;
  }
) => Buffer;

type WindowsRegistryReadOptions = {
  platform?: NodeJS.Platform;
  execFileSyncImpl?: WindowsRegistryExecFileSync;
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

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function quotePowerShellLiteral(value: string) {
  return `'${value.replace(/'/gu, "''")}'`;
}

function buildWindowsRegistryReadScript() {
  const registryKey = quotePowerShellLiteral(WINDOWS_RUNTIME_ROOT_REGISTRY_KEY);
  const registryValue = quotePowerShellLiteral(WINDOWS_RUNTIME_ROOT_REGISTRY_VALUE);
  return `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${registryKey})
if ($null -ne $key) {
  try {
    $value = $key.GetValue(${registryValue}, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $value) {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$value)
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      [Console]::Out.Write([System.Convert]::ToBase64String($bytes))
    }
  } finally {
    $key.Dispose()
  }
}
`;
}

function decodeBase64Utf8(value: Buffer) {
  const encoded = value.toString("ascii").trim();
  if (!encoded) {
    return "";
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

function readWindowsRuntimeRootFromRegistryUncached({
  platform = process.platform,
  execFileSyncImpl = execFileSync as WindowsRegistryExecFileSync
}: WindowsRegistryReadOptions = {}) {
  if (platform !== "win32") {
    return "";
  }

  try {
    const encodedCommand = Buffer.from(buildWindowsRegistryReadScript(), "utf16le").toString("base64");
    const output = execFileSyncImpl(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedCommand
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    return decodeBase64Utf8(output);
  } catch {
    return "";
  }
}

export function readWindowsRuntimeRootFromRegistry(platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") {
    return "";
  }
  if (cachedRegistryDataRoot !== undefined) {
    return cachedRegistryDataRoot;
  }

  cachedRegistryDataRoot = readWindowsRuntimeRootFromRegistryUncached({ platform });
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
  readWindowsRuntimeRootFromRegistryUncached,
  resolveRuntimeRootPath
};
