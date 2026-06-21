import path from "node:path";

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveElectronBundleRootFromRuntimeDir(
  runtimeModuleDir: string,
  platform: NodeJS.Platform = process.platform
) {
  const pathApi = pathApiForPlatform(platform);
  const currentDirName = pathApi.basename(runtimeModuleDir);
  const parentDir = pathApi.dirname(runtimeModuleDir);
  const parentDirName = pathApi.basename(parentDir);
  const grandparentDir = pathApi.dirname(parentDir);
  const grandparentDirName = pathApi.basename(grandparentDir);

  if (platform === "win32") {
    if (currentDirName === "main" && parentDirName === "dist-electron") {
      return parentDir;
    }
    if (parentDirName === "main" && grandparentDirName === "dist-electron") {
      return grandparentDir;
    }
    return pathApi.resolve(pathApi.join(runtimeModuleDir, "..", ".."));
  }
  if (platform === "darwin") {
    if (currentDirName === "main" && parentDirName === "dist-electron") {
      return parentDir;
    }
    if (parentDirName === "main" && grandparentDirName === "dist-electron") {
      return grandparentDir;
    }
    return pathApi.resolve(pathApi.join(runtimeModuleDir, "..", ".."));
  }
  if (currentDirName === "main" && parentDirName === "dist-electron") {
    return parentDir;
  }
  if (parentDirName === "main" && grandparentDirName === "dist-electron") {
    return grandparentDir;
  }
  return pathApi.resolve(pathApi.join(runtimeModuleDir, "..", ".."));
}

export function getMainPreloadPath(mainProcessDir: string, platform: NodeJS.Platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  if (platform === "win32") {
    return pathApi.join(mainProcessDir, "preload", "index.js");
  }
  if (platform === "darwin") {
    return pathApi.join(mainProcessDir, "preload", "index.js");
  }
  return pathApi.join(mainProcessDir, "preload", "index.js");
}

export function getServiceWebviewPreloadPath(mainProcessDir: string, platform: NodeJS.Platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  if (platform === "win32") {
    return pathApi.join(mainProcessDir, "preload", "service-webview.js");
  }
  if (platform === "darwin") {
    return pathApi.join(mainProcessDir, "preload", "service-webview.js");
  }
  return pathApi.join(mainProcessDir, "preload", "service-webview.js");
}
