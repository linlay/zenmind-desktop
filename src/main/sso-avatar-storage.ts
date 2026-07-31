import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getRuntimeDataRoot } from "./user-paths";

function pathApiForPlatform(platform: NodeJS.Platform | string) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function getDesktopSsoAvatarCacheDir(
  app: App,
  platform: NodeJS.Platform | string = process.platform,
) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.join(getRuntimeDataRoot(app, platform as NodeJS.Platform), "desktop", "sso-avatar");
}

export function clearCachedDesktopSsoAvatar(
  app: App,
  platform: NodeJS.Platform | string = process.platform,
) {
  try {
    fs.rmSync(getDesktopSsoAvatarCacheDir(app, platform), {
      recursive: true,
      force: true,
    });
  } catch {
    // Local logout remains successful when cache cleanup is best effort.
  }
}
