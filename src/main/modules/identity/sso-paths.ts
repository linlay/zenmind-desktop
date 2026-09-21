import type { App } from "electron";
import path from "node:path";
import { getDesktopStateRoot, getSecretsRoot } from "../../infrastructure/filesystem/user-paths";
import { SESSION_FILE_NAME, USER_INFO_FILE_NAME, LEGACY_SITE_TOKEN_FILE_NAME, DESKTOP_SSO_CONFIG_FILE_NAME } from "./sso-defaults";
import fs from "node:fs";
import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";

export function getSessionPath(app: App) {
  return path.join(getDesktopStateRoot(app), SESSION_FILE_NAME);
}

export function getDesktopSsoUserInfoFilePath(app: Pick<App, "getPath">) {
  return path.join(getDesktopStateRoot(app as App), USER_INFO_FILE_NAME);
}

export function removeLegacyDesktopSsoSiteTokenFile(app: Pick<App, "getPath">) {
  try {
    fs.rmSync(path.join(getSecretsRoot(app as App), LEGACY_SITE_TOKEN_FILE_NAME), { force: true });
  } catch {
    // The retired duplicate credential is best-effort cleanup; canonical auth state remains authoritative.
  }
}

export function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path;
}

export function resolveDesktopSsoConfigPath(app: Pick<App, "getPath">, platform: NodeJS.Platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.join(resolveRuntimeRoot(app, platform), ".desktop", "config", "desktop", DESKTOP_SSO_CONFIG_FILE_NAME);
}
