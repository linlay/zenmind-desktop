import path from "node:path";
import {
  AppPathReader,
  ENV_IMPORT_MARKER_RELATIVE_PATH,
  ENV_RUNTIME_DIRS,
  ENV_AGENT_DEFINITION_FILE_NAME,
  AppPackageReader,
  BUNDLED_ENV_RESOURCES_DIR_NAME,
  ENV_ZIP_FILE_NAME,
  AppVersionReader,
  VERSION_FILE_NAME
} from "./runtime-env-contracts";
import os from "node:os";
import { resolveRuntimeRootPath } from "./runtime-root";
import fs from "node:fs";
import { isDesktopDevelopmentRuntime } from "../electron/development-runtime";
import { readVersionFileIfExists, normalizeVersion } from "./runtime-env-archive";
import { t } from "./runtime-environment-translator";

export function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  if (platform === "win32") {
    return path.win32;
  }
  if (platform === "darwin") {
    return path.posix;
  }
  return path.posix;
}

export function pathApiForResolvedRoot(platform: NodeJS.Platform | undefined, rootPath: string) {
  if (platform === "win32") {
    // Cross-platform tests inject POSIX temp directories while simulating Windows behavior.
    if (path.posix.isAbsolute(rootPath)) {
      return path.posix;
    }
    return path.win32;
  }
  if (platform === "darwin") {
    if (path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)) {
      return path.win32;
    }
    return path.posix;
  }
  return path.posix;
}

export function getHomePath(app: AppPathReader) {
  try {
    const homePath = app.getPath("home");
    if (typeof homePath === "string" && homePath.trim()) {
      return homePath;
    }
  } catch {
    // Fall back to Node's user home when Electron cannot provide one yet.
  }
  return process.env.HOME || os.homedir();
}

export function resolveRuntimeRoot(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const homePath = getHomePath(app);
  return resolveRuntimeRootPath({ platform, homePath });
}

export function runtimeRootExists(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const root = resolveRuntimeRoot(app, platform);
  try {
    return fs.existsSync(root) && fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

export function runtimeEnvExists(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const root = resolveRuntimeRoot(app, platform);
  if (!runtimeRootExists(app, platform)) {
    return false;
  }
  if (fs.existsSync(path.join(root, ENV_IMPORT_MARKER_RELATIVE_PATH))) {
    return true;
  }
  return ENV_RUNTIME_DIRS.some((dirName) => {
    const targetPath = path.join(root, dirName);
    try {
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory() && hasDirectoryEntries(targetPath);
    } catch {
      return false;
    }
  });
}

export function runtimeEnvNeedsBundledSeedRefresh(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  if (platform !== "darwin" && platform !== "win32") {
    return false;
  }
  const root = resolveRuntimeRoot(app, platform);
  if (!runtimeRootExists(app, platform)) {
    return false;
  }
  if (fs.existsSync(path.join(root, ENV_IMPORT_MARKER_RELATIVE_PATH))) {
    return false;
  }
  return !hasRuntimeAgentDefinitions(root);
}

export function hasDirectoryEntries(dirPath: string) {
  const stack = [dirPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        return true;
      }
    }
  }
  return false;
}

export function hasRuntimeAgentDefinitions(root: string) {
  const agentsRoot = path.join(root, "agents");
  try {
    return fs.existsSync(agentsRoot) &&
      fs.statSync(agentsRoot).isDirectory() &&
      hasFileNamed(agentsRoot, ENV_AGENT_DEFINITION_FILE_NAME);
  } catch {
    return false;
  }
}

export function hasFileNamed(dirPath: string, fileName: string) {
  const stack = [dirPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === fileName) {
        return true;
      }
    }
  }
  return false;
}

export function shouldRequireEnvZipImport(input: {
  platform?: NodeJS.Platform;
  runtimeEnvExistedAtStartup: boolean;
}) {
  const platform = input.platform ?? process.platform;
  return (platform === "darwin" || platform === "win32") && !input.runtimeEnvExistedAtStartup;
}

export function pushUniquePath(candidates: string[], candidate: string | undefined) {
  if (!candidate) {
    return;
  }
  const normalized = path.resolve(candidate);
  if (!candidates.includes(normalized)) {
    candidates.push(normalized);
  }
}

export function getPackagedAppPath(app: AppPackageReader) {
  try {
    return typeof app.getAppPath === "function" ? app.getAppPath() : "";
  } catch {
    return "";
  }
}

export function bundledResourcesRootCandidates(app: AppPackageReader, resourcesRootOverride?: string) {
  const candidates: string[] = [];
  pushUniquePath(candidates, resourcesRootOverride);

  const isDevelopmentRuntime = isDesktopDevelopmentRuntime(app);
  if (app.isPackaged && !isDevelopmentRuntime) {
    pushUniquePath(candidates, process.resourcesPath);

    const appPath = getPackagedAppPath(app);
    if (appPath) {
      pushUniquePath(candidates, path.dirname(appPath));
    }

    if (process.execPath) {
      pushUniquePath(candidates, path.join(path.dirname(process.execPath), "resources"));
    }
  } else if (!resourcesRootOverride) {
    // Development resources are brand-scoped. Packaged applications must never
    // honor this environment override and remain confined to their app bundle.
    pushUniquePath(candidates, process.env.DESKTOP_DEV_RESOURCES_ROOT);
    pushUniquePath(candidates, path.join(process.cwd(), "build", "resources"));
  }

  return candidates;
}

export function fileExists(filePath: string) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function supportsBundledEnvResources(app: AppPackageReader, platform: NodeJS.Platform) {
  return platform === "darwin" || platform === "win32" || isDesktopDevelopmentRuntime(app, { platform });
}

export function resolveBundledEnvZipPath(
  app: AppPackageReader,
  platform: NodeJS.Platform = process.platform,
  resourcesRootOverride?: string
) {
  if (!supportsBundledEnvResources(app, platform)) {
    return null;
  }

  const candidates = bundledResourcesRootCandidates(app, resourcesRootOverride)
    .map((resourcesRoot) => path.join(resourcesRoot, BUNDLED_ENV_RESOURCES_DIR_NAME, ENV_ZIP_FILE_NAME));
  return candidates.find(fileExists) ?? candidates[0] ?? null;
}

export function resolveDesktopVersion(app: AppVersionReader = {}) {
  const candidateRoots = [
    typeof app.getAppPath === "function" ? app.getAppPath() : "",
    process.cwd()
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidateRoot of candidateRoots) {
    const version = readVersionFileIfExists(path.join(candidateRoot, VERSION_FILE_NAME));
    if (version) {
      return version;
    }
  }

  if (typeof app.getVersion === "function") {
    const version = normalizeVersion(app.getVersion());
    if (version) {
      return version;
    }
  }

  throw new Error(t("envBootstrap.versionReadFailed"));
}
