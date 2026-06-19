import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { DesktopAppInfo } from "../shared/contracts";
import { PRODUCT_NAME } from "../shared/brand";

type DesktopBuildMetadata = {
  productName?: unknown;
  version?: unknown;
  buildTime?: unknown;
};

type DesktopMetadataOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

type NativeAboutTarget = {
  setAboutPanelOptions(options: {
    applicationName?: string;
    applicationVersion?: string;
    version?: string;
  }): void;
};

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeDesktopVersion(value: unknown) {
  const version = asString(value).replace(/^v/iu, "");
  return version ? `v${version}` : "";
}

export function formatUtcBuildTime(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function normalizeExplicitBuildTime(value: unknown) {
  const trimmed = asString(value);
  if (!trimmed) {
    return "";
  }

  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? formatUtcBuildTime(new Date(timestamp)) : trimmed;
}

function buildTimeFromSourceDateEpoch(value: unknown) {
  const trimmed = asString(value);
  if (!trimmed) {
    return "";
  }

  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) {
    return "";
  }
  return formatUtcBuildTime(new Date(seconds * 1000));
}

export function resolveDesktopBuildTime(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
) {
  return (
    normalizeExplicitBuildTime(env.DESKTOP_BUILD_TIME) ||
    normalizeExplicitBuildTime(env.BUILD_TIME) ||
    buildTimeFromSourceDateEpoch(env.SOURCE_DATE_EPOCH) ||
    formatUtcBuildTime(now())
  );
}

function readPackagedBuildMetadata(app: Pick<App, "getAppPath">): DesktopBuildMetadata {
  try {
    const packagePath = path.join(app.getAppPath(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const metadata = packageJson?.desktopBuildMetadata;
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata as DesktopBuildMetadata
      : {};
  } catch {
    return {};
  }
}

export function resolveDesktopAppInfo(
  app: Pick<App, "getAppPath" | "getVersion">,
  options: DesktopMetadataOptions = {}
): DesktopAppInfo {
  const metadata = readPackagedBuildMetadata(app);
  const version = normalizeDesktopVersion(metadata.version) || normalizeDesktopVersion(app.getVersion());
  const buildTime = normalizeExplicitBuildTime(metadata.buildTime) || resolveDesktopBuildTime(options.env, options.now);
  return {
    productName: asString(metadata.productName) || PRODUCT_NAME,
    version,
    buildTime
  };
}

export function configureNativeAboutPanel(
  platform: NodeJS.Platform,
  app: NativeAboutTarget,
  appInfo: DesktopAppInfo
) {
  if (platform === "darwin") {
    app.setAboutPanelOptions({
      applicationName: appInfo.productName,
      applicationVersion: appInfo.version,
      version: appInfo.buildTime
    });
    return;
  }

  if (platform === "win32") {
    app.setAboutPanelOptions({
      applicationName: appInfo.productName,
      applicationVersion: appInfo.version
    });
    return;
  }

  app.setAboutPanelOptions({
    applicationName: appInfo.productName,
    applicationVersion: appInfo.version
  });
}
