import type {
  MarketItemType,
  MarketAsset,
  MarketDependency,
  MarketScriptSpec,
  MarketDetectSpec,
  MarketSkillProfile,
  MarketPlatformSpec,
  MarketCatalogItem
} from "../../../shared/contracts";
import { asString, asObject, asNumber, asStringArray, asBoolean, asCount } from "./catalog-values";
import type { Catalog } from "./market-model";

export function isMarketItemType(value: unknown): value is MarketItemType {
  return (
    value === "plugin" ||
    value === "skill" ||
    value === "agent" ||
    value === "sandbox-image" ||
    value === "pet" ||
    value === "cli" ||
    value === "mcp" ||
    value === "connector" ||
    value === "website-app" ||
    value === "software-package"
  );
}

export function normalizeMarketItemType(value: unknown): MarketItemType | null {
  if (value === "cli-tool") {
    return "cli";
  }
  if (
    value === "plugin" ||
    value === "skill" ||
    value === "agent" ||
    value === "sandbox-image" ||
    value === "pet" ||
    value === "cli" ||
    value === "mcp" ||
    value === "connector" ||
    value === "website-app" ||
    value === "software-package"
  ) {
    return value;
  }
  return null;
}

export function normalizeSandboxKind(value: unknown) {
  const kind = asString(value).trim();
  return kind === "environment-template"
    ? "environment-template" as const
    : kind === "container-image"
      ? "container-image" as const
      : undefined;
}

export function normalizeWebsiteKind(value: unknown) {
  const kind = asString(value).trim();
  return kind === "external"
    ? "external" as const
    : kind === "local-app"
      ? "local-app" as const
      : undefined;
}

export function isKnownArchiveType(value: string): value is MarketAsset["archiveType"] {
  return (
    value === "tar.gz" ||
    value === "zip" ||
    value === "skill" ||
    value === "md" ||
    value === "agent" ||
    value === "sandbox-template" ||
    value === "container-image" ||
    value === "pet" ||
    value === "cli" ||
    value === "json" ||
    value === "website-app"
  );
}

export function normalizeAsset(value: unknown): MarketAsset | null {
  const raw = asObject(value);
  const url = asString(raw.url).trim();
  if (!url) {
    return null;
  }
  const archiveType = asString(raw.archiveType);
  if (!isKnownArchiveType(archiveType)) {
    return null;
  }
  return {
    url,
    sha256: asString(raw.sha256).trim(),
    integrity: asString(raw.integrity).trim() || undefined,
    sizeBytes: asNumber(raw.sizeBytes),
    archiveType,
    platform: asString(raw.platform).trim() || undefined,
    role: asString(raw.role).trim() || undefined
  };
}

export function normalizeDependency(value: unknown): MarketDependency | null {
  const raw = asObject(value);
  const kind = asString(raw.kind).trim();
  const phase = asString(raw.phase).trim();
  if (!kind && !phase) {
    return null;
  }
  return {
    kind,
    phase,
    required: raw.required === true,
    id: asString(raw.id).trim() || undefined,
    serviceId: asString(raw.serviceId).trim() || undefined,
    command: asString(raw.command).trim() || undefined,
    runtime: asString(raw.runtime).trim() || undefined,
    capability: asString(raw.capability).trim() || undefined,
    version: asString(raw.version).trim() || undefined,
    displayName: asString(raw.displayName).trim() || undefined,
    installHint: asString(raw.installHint).trim() || undefined
  };
}

export function normalizeDependencies(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeDependency).filter((item): item is MarketDependency => Boolean(item))
    : [];
}

export function normalizeScriptSpec(value: unknown): MarketScriptSpec | undefined {
  const raw = asObject(value);
  const spec = {
    command: asString(raw.command).trim() || undefined,
    scriptUrl: asString(raw.scriptUrl).trim() || undefined,
    sha256: asString(raw.sha256).trim() || undefined,
    integrity: asString(raw.integrity).trim() || undefined
  };
  return spec.command || spec.scriptUrl || spec.sha256 || spec.integrity ? spec : undefined;
}

export function normalizeDetectSpec(value: unknown): MarketDetectSpec | undefined {
  const raw = asObject(value);
  const spec = {
    commands: asStringArray(raw.commands).map((item) => item.trim()).filter(Boolean),
    versionCommand: asString(raw.versionCommand).trim() || undefined
  };
  return spec.commands.length > 0 || spec.versionCommand ? spec : undefined;
}

export function normalizeMetadata(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asObject(value))
      .map(([key, item]) => [key, asString(item).trim()])
      .filter(([, item]) => item)
  );
}

export function normalizeSkillProfile(value: unknown): MarketSkillProfile | undefined {
  const raw = asObject(value);
  const kind = asString(raw.kind).trim().toLowerCase();
  if (kind !== "single" && kind !== "package") {
    return undefined;
  }
  const includedSkills = Array.isArray(raw.includedSkills)
    ? raw.includedSkills.flatMap((entry) => {
      const item = asObject(entry);
      const id = asString(item.id).trim();
      if (!id) return [];
      return [{
        id,
        name: asString(item.name).trim() || undefined,
        optional: asBoolean(item.optional),
        sortOrder: asNumber(item.sortOrder)
      }];
    })
    : [];
  return {
    kind,
    category: asString(raw.category).trim() || undefined,
    scenario: asString(raw.scenario).trim() || undefined,
    featured: raw.featured === true,
    packageMode: asString(raw.packageMode).trim() || undefined,
    includedSkills: includedSkills.length > 0 ? includedSkills : undefined
  };
}

export function normalizePlatformSpec(key: string, value: unknown): MarketPlatformSpec | null {
  const raw = asObject(value);
  const platform = asString(raw.platform).trim() || asString(raw.key).trim() || key.trim() || "universal";
  if (!platform) {
    return null;
  }
  const dependencies = normalizeDependencies(raw.dependencies);
  const metadata = normalizeMetadata(raw.metadata);
  const spec: MarketPlatformSpec = {
    platform,
    os: asString(raw.os).trim() || undefined,
    arch: asString(raw.arch).trim() || undefined,
    description: asString(raw.description).trim() || undefined,
    readme: asString(raw.readme).trim() || undefined,
    minDesktopVersion: asString(raw.minDesktopVersion).trim() || undefined,
    metadata,
    dependencies,
    install: normalizeScriptSpec(raw.install),
    uninstall: normalizeScriptSpec(raw.uninstall),
    detect: normalizeDetectSpec(raw.detect)
  };
  return spec;
}

export function normalizeTargets(value: unknown, assets: Record<string, MarketAsset>) {
  const targets: Record<string, MarketPlatformSpec> = {};
  for (const [key, rawPlatform] of Object.entries(asObject(value))) {
    const normalizedKey = key.trim() || "universal";
    const platform = normalizePlatformSpec(normalizedKey, rawPlatform);
    if (platform) {
      targets[platform.platform] = platform;
    }
  }
  for (const [key] of Object.entries(assets)) {
    const normalizedKey = key.trim() || "universal";
    if (!targets[normalizedKey]) {
      targets[normalizedKey] = {
        platform: normalizedKey
      };
    }
  }
  return targets;
}

export function isDesktopInstallableAsset(
  item: Pick<MarketCatalogItem, "type" | "sandboxKind">,
  asset: MarketAsset
) {
  if (item.type === "plugin" || item.type === "skill" || item.type === "connector") {
    return asset.archiveType === "zip";
  }
  if (item.type === "agent") {
    return asset.archiveType === "zip" || asset.archiveType === "agent";
  }
  if (item.type === "pet") {
    return asset.archiveType === "zip" || asset.archiveType === "pet";
  }
  if (item.type === "cli") {
    return asset.archiveType === "zip" || asset.archiveType === "cli";
  }
  if (item.type === "website-app") {
    return asset.archiveType === "zip" || asset.archiveType === "website-app";
  }
  if (item.type === "software-package") {
    return asset.archiveType === "zip" || asset.archiveType === "tar.gz";
  }
  if (item.type === "sandbox-image") {
    if (item.sandboxKind === "container-image" || asset.archiveType === "container-image") {
      return asset.archiveType === "container-image" || asset.archiveType === "tar.gz";
    }
    return asset.archiveType === "zip" || asset.archiveType === "sandbox-template";
  }
  return false;
}

export function shouldRequireInstallableAsset(item: MarketCatalogItem) {
  return item.type === "plugin" ||
    item.type === "connector" ||
    (item.type === "skill" && item.skill?.kind !== "package") ||
    item.type === "agent" ||
    item.type === "pet" ||
    item.type === "website-app" ||
    item.type === "software-package" ||
    (item.type === "sandbox-image" && item.sandboxKind === "environment-template");
}

export function normalizeCatalog(input: unknown): Catalog {
  const raw = asObject(input);
  const itemsRaw = Array.isArray(raw.items) ? raw.items : [];
  const items: MarketCatalogItem[] = [];
  for (const itemRaw of itemsRaw) {
    const item = asObject(itemRaw);
    const id = asString(item.id).trim();
    const type = normalizeMarketItemType(item.type);
    if (!id || !type) {
      continue;
    }
    const sandboxKind = normalizeSandboxKind(item.sandboxKind);
    const websiteKind = normalizeWebsiteKind(item.websiteKind);
    const assets: Record<string, MarketAsset> = {};
    for (const [key, assetRaw] of Object.entries(asObject(item.assets))) {
      const asset = normalizeAsset(assetRaw);
      if (asset) {
        assets[key] = asset;
      }
    }
    const rawMetadata = asObject(item.metadata);
    const metadata = normalizeMetadata(rawMetadata);
    const installSpec = normalizeScriptSpec(item.install);
    const uninstallSpec = normalizeScriptSpec(item.uninstall);
    const detectSpec = normalizeDetectSpec(item.detect);
    const install = asObject(installSpec);
    const installCommand = asString(install.command).trim();
    const installScriptUrl = asString(install.scriptUrl).trim();
    if (installCommand) metadata.installCommand = installCommand;
    if (installScriptUrl) metadata.installScriptUrl = installScriptUrl;
    const uninstall = asObject(uninstallSpec);
    const uninstallCommand = asString(uninstall.command).trim();
    const uninstallScriptUrl = asString(uninstall.scriptUrl).trim();
    if (uninstallCommand) metadata.uninstallCommand = uninstallCommand;
    if (uninstallScriptUrl) metadata.uninstallScriptUrl = uninstallScriptUrl;
    const publishedAt = asString(item.publishedAt).trim() || undefined;
    const updatedAt = asString(item.updatedAt).trim() || undefined;
    const createdAt = asString(item.createdAt).trim() || asString(rawMetadata.createdAt).trim() || publishedAt;
    const author = asString(item.author).trim() || metadata.author || undefined;
    const downloadCount = asCount(item.downloadCount ?? rawMetadata.downloadCount ?? rawMetadata.downloads ?? item.downloads);
    const favoriteCount = asCount(item.favoriteCount ?? rawMetadata.favoriteCount ?? rawMetadata.favorites ?? item.favorites);
    const favorited = asBoolean(item.favorited ?? rawMetadata.favorited ?? rawMetadata.favorite);
    const targets = normalizeTargets(item.targets, assets);
    if (publishedAt) metadata.publishedAt = publishedAt;
    if (updatedAt) metadata.updatedAt = updatedAt;
    if (createdAt) metadata.createdAt = createdAt;
    const rawScripts = asObject(rawMetadata.scripts || item.scripts);
    const scriptPlatforms = [
      ["macos", "macos"],
      ["darwin", "darwin"],
      ["windows", "windows"],
      ["win32", "win32"],
      ["linux", "linux"]
    ] as const;
    for (const [sourceKey, metadataPrefix] of scriptPlatforms) {
      const script = asObject(rawScripts[sourceKey]);
      const installCommand = asString(script.installCommand).trim();
      const uninstallCommand = asString(script.uninstallCommand).trim();
      const installScriptUrl = asString(script.installScriptUrl || script.installUrl).trim();
      const uninstallScriptUrl = asString(script.uninstallScriptUrl || script.uninstallUrl).trim();
      if (installCommand) metadata[`${metadataPrefix}InstallCommand`] = installCommand;
      if (uninstallCommand) metadata[`${metadataPrefix}UninstallCommand`] = uninstallCommand;
      if (installScriptUrl) metadata[`${metadataPrefix}InstallScriptUrl`] = installScriptUrl;
      if (uninstallScriptUrl) metadata[`${metadataPrefix}UninstallScriptUrl`] = uninstallScriptUrl;
    }
    items.push({
      id,
      type,
      name: asString(item.name).trim() || id,
      version: asString(item.version).trim() || "0.0.0",
      description: asString(item.description),
      readme: asString(item.readme).trim() || undefined,
      tags: asStringArray(item.tags),
      minDesktopVersion: asString(item.minDesktopVersion).trim() || undefined,
      sandboxKind,
      websiteKind,
      npmPackage: asString(item.npmPackage).trim() || undefined,
      author,
      createdAt,
      downloadCount,
      favoriteCount,
      favorited,
      skill: normalizeSkillProfile(item.skill),
      // Featured is administrator-owned item metadata; legacy skill flags cannot override removal.
      featured: item.featured === true,
      skillFeatured: item.featured === true,
      dependencies: normalizeDependencies(item.dependencies),
      metadata,
      targets,
      install: installSpec,
      uninstall: uninstallSpec,
      detect: detectSpec,
      publishedAt,
      updatedAt,
      assets
    });
  }
  return {
    schemaVersion: asNumber(raw.schemaVersion) || 1,
    generatedAt: asString(raw.generatedAt).trim() || undefined,
    items
  };
}
