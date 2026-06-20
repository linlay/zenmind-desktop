import path from "node:path";

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
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
