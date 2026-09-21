import type { MarketCatalogItem, MarketAsset, MarketPlatformSpec } from "../../../shared/contracts";
import { isDesktopInstallableAsset } from "./catalog-normalization";
import type { App } from "electron";
import { t } from "../../support/i18n/main-i18n";

export type ParsedSemanticVersion = {
  core: [string, string, string];
  prerelease: string[];
};

export const SEMANTIC_VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function parseSemanticVersion(value: string): ParsedSemanticVersion | null {
  const match = SEMANTIC_VERSION_PATTERN.exec(String(value || "").trim());
  if (!match) {
    return null;
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    return null;
  }
  return {
    core: [match[1], match[2], match[3]],
    prerelease
  };
}

export function compareNumericIdentifiers(left: string, right: string) {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function compareVersions(left: string, right: string) {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  if (!a || !b) {
    return 0;
  }
  for (let index = 0; index < a.core.length; index += 1) {
    const diff = compareNumericIdentifiers(a.core[index], b.core[index]);
    if (diff !== 0) {
      return diff;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) {
      return 0;
    }
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function platformCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
) {
  const platformName = platform === "win32" ? "windows" : platform;
  const archAliases = arch === "x64"
    ? platform === "darwin" ? ["x64", "amd64"] : ["amd64", "x64"]
    : arch === "ia32"
      ? ["x86", "ia32"]
      : [arch];
  return [...new Set(archAliases.map((alias) => `${platformName}-${alias}`)), "universal"];
}

export function selectAsset(
  item: Pick<MarketCatalogItem, "type" | "sandboxKind"> & {
    assets?: Record<string, MarketAsset>;
  },
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
) {
  const assets = item.assets ?? {};
  for (const candidate of platformCandidates(platform, arch)) {
    const asset = assets[candidate];
    if (asset && isDesktopInstallableAsset(item, asset)) {
      return { key: candidate, asset };
    }
  }
  // Connector distribution on macOS accepts the darwin family as requested.
  // Preserve the selected key for server resolve/download and provenance.
  if (platform === "darwin" && item.type === "connector") {
    for (const key of Object.keys(assets).sort()) {
      const asset = assets[key];
      if (key.startsWith("darwin") && isDesktopInstallableAsset(item, asset)) return { key, asset };
    }
  }
  const universal = assets.universal;
  if (universal && isDesktopInstallableAsset(item, universal)) {
    return { key: "universal", asset: universal };
  }
  return null;
}

export type ResolvedMarketAsset = {
  item: MarketCatalogItem;
  platform: string;
  asset: MarketAsset;
  downloadUrl: string;
};

export function currentDesktopVersion(app: App) {
  try {
    return typeof app.getVersion === "function" ? String(app.getVersion() || "").trim() : "";
  } catch {
    return "";
  }
}

export function assertDesktopVersionCompatible(app: App, item: MarketCatalogItem, platformSpec?: MarketPlatformSpec) {
  const requiredVersion = platformSpec?.minDesktopVersion || item.minDesktopVersion || "";
  const desktopVersion = currentDesktopVersion(app);
  if (requiredVersion && desktopVersion && compareVersions(desktopVersion, requiredVersion) < 0) {
    throw new Error(t("market.main.desktopVersionTooOld", {
      current: desktopVersion,
      required: requiredVersion
    }));
  }
}
