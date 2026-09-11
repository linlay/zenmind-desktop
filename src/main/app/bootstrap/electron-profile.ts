import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { STORAGE_NAMESPACE } from "../../../shared/brand";
import { getElectronUserDataRoot, getProfilesRoot } from "../../infrastructure/filesystem/user-paths";

export function initializeElectronProfile(app: App, platform: NodeJS.Platform = process.platform) {
  if (app.isReady()) {
    throw new Error("Electron profile paths must be configured before app ready.");
  }
  const profileRoot = getElectronUserDataRoot(app, platform);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const legacyProfile = pathApi.join(getProfilesRoot(app, platform), "electron");
  if (!fs.existsSync(profileRoot)) {
    const legacySsoRoot = [
      pathApi.join(legacyProfile, "Partitions", "desktop-sso"),
      pathApi.join(legacyProfile, "Partitions", `${STORAGE_NAMESPACE}-sso`)
    ].find((candidate) => fs.existsSync(candidate));
    // Promote the entire unopened SSO store to the default profile, preserving
    // Cookie databases and website storage together. Never merge existing stores.
    fs.mkdirSync(pathApi.dirname(profileRoot), { recursive: true });
    if (legacySsoRoot) {
      fs.renameSync(legacySsoRoot, profileRoot);
      // Keep Chromium's profile metadata alongside the promoted Cookie store.
      const legacyLocalState = pathApi.join(legacyProfile, "Local State");
      const localState = pathApi.join(profileRoot, "Local State");
      if (fs.existsSync(legacyLocalState) && !fs.existsSync(localState)) {
        fs.copyFileSync(legacyLocalState, localState);
      }
      const remainingPartitions = pathApi.join(legacyProfile, "Partitions");
      const newPartitions = pathApi.join(profileRoot, "Partitions");
      if (fs.existsSync(remainingPartitions) && !fs.existsSync(newPartitions)) {
        fs.renameSync(remainingPartitions, newPartitions);
      }
    } else if (fs.existsSync(legacyProfile)) {
      fs.renameSync(legacyProfile, profileRoot);
    }
  }
  fs.mkdirSync(profileRoot, { recursive: true });
  // Pin both paths before Chromium initializes its network service. Changing only
  // userData after ready leaves persistent partitions unable to write Cookies.
  app.setPath("userData", profileRoot);
  app.setPath("sessionData", profileRoot);
}
