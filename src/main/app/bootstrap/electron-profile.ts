import fs from "node:fs";
import type { App } from "electron";
import { getElectronUserDataRoot } from "../../infrastructure/filesystem/user-paths";

export function initializeElectronProfile(app: App, platform: NodeJS.Platform = process.platform) {
  if (app.isReady()) {
    throw new Error("Electron profile paths must be configured before app ready.");
  }
  const profileRoot = getElectronUserDataRoot(app, platform);
  fs.mkdirSync(profileRoot, { recursive: true });
  // Pin both paths before Chromium initializes its network service. Changing only
  // userData after ready leaves persistent partitions unable to write Cookies.
  app.setPath("userData", profileRoot);
  app.setPath("sessionData", profileRoot);
}
