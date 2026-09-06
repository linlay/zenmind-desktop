import os from "node:os";
import type { App } from "electron";
import type { DesktopDeviceInfo } from "../../../shared/contracts";
import {
  getDesktopDeviceIdentity,
  type DesktopDeviceIdentityOptions
} from "./device-identity";
import { readDesktopProfileFromRoot } from "../../infrastructure/filesystem/profile-store";
import { t } from "../../support/i18n/main-i18n";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

type DesktopDeviceInfoOptions = {
  arch?: string;
  identityOptions?: DesktopDeviceIdentityOptions;
  platform?: NodeJS.Platform;
  readHostname?: () => string;
  readUsername?: () => string;
};

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function shortDeviceId(deviceId: string) {
  const text = readText(deviceId);
  return text ? text.slice(0, 8) : "";
}

function normalizeFallbackHostname(value: unknown) {
  return readText(value).replace(/\.local$/iu, "");
}

function readHostname(read: () => string = os.hostname) {
  try {
    return readText(read());
  } catch {
    return "";
  }
}

function readUsername(read: () => string = () => os.userInfo().username) {
  try {
    return readText(read());
  } catch {
    return "";
  }
}

export function buildDesktopDeviceName(input: {
  configuredDeviceName?: string;
  deviceId?: string;
  hostname?: string;
  username?: string;
}) {
  const configuredDeviceName = readText(input.configuredDeviceName);
  if (configuredDeviceName) {
    return configuredDeviceName;
  }

  const systemName = [normalizeFallbackHostname(input.hostname), readText(input.username)].filter(Boolean).join(" · ");
  return systemName ||
    shortDeviceId(readText(input.deviceId)) ||
    t("settings.general.deviceNameFallback");
}

export function getDesktopDeviceInfo(
  app: App,
  options: DesktopDeviceInfoOptions = {}
): DesktopDeviceInfo {
  const platform = options.platform ?? process.platform;
  const identity = getDesktopDeviceIdentity(app, {
    ...options.identityOptions,
    platform: options.identityOptions?.platform ?? platform
  });
  const hostname = readHostname(options.readHostname);
  const username = readUsername(options.readUsername);
  const configuredDeviceName = readText(readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.deviceName);
  const deviceName = buildDesktopDeviceName({
    configuredDeviceName,
    deviceId: identity.deviceId,
    hostname,
    username
  });

  return {
    deviceId: identity.deviceId,
    deviceName,
    configuredDeviceName,
    hostname,
    username,
    platform,
    arch: readText(options.arch) || process.arch
  };
}
