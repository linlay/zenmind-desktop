import type { App } from "electron";
import type { MarketCatalogItem, MarketCommandResult, MarketItem } from "../../shared/contracts";
import { t } from "../i18n/main-i18n";
import {
  findCatalogItem,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  readInstalledRecords,
  selectAsset,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

type CliCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

function cliOnlyCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    items: catalog.items.filter((item) => item.type === "cli")
  };
}

async function loadCliCatalog(app: App, options: MarketplaceOptions = {}): Promise<CliCatalogResult> {
  if (options.catalog) {
    return {
      catalog: cliOnlyCatalog(normalizeCatalog(options.catalog)),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? ""
    };
  }

  const result = await loadMarketplaceCatalog(app, options, "cli market catalog request");
  return {
    ...result,
    catalog: cliOnlyCatalog(result.catalog)
  };
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function powerShellSingleQuote(value: string) {
  return `'${value.replace(/'/gu, "''")}'`;
}

function readMetadata(item: MarketCatalogItem | MarketItem, keys: string[]) {
  const metadata = item.metadata ?? {};
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function currentCliPlatform() {
  if (process.platform === "win32") {
    return "windows" as const;
  }
  if (process.platform === "darwin") {
    return "macos" as const;
  }
  return "linux" as const;
}

function installCommandFromScriptUrl(item: MarketCatalogItem | MarketItem) {
  const platform = currentCliPlatform();
  if (platform === "windows") {
    const url = readMetadata(item, [
      "windowsInstallScriptUrl",
      "win32InstallScriptUrl",
      "installPs1Url",
      "installScriptUrl"
    ]);
    if (!url) {
      return "";
    }
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object System.Net.WebClient).DownloadString(${powerShellSingleQuote(url)}))"`;
  }
  if (platform === "macos") {
    const url = readMetadata(item, [
      "macosInstallScriptUrl",
      "darwinInstallScriptUrl",
      "installShUrl",
      "installScriptUrl"
    ]);
    return url ? `curl -fsSL ${shellSingleQuote(url)} | sh` : "";
  }
  return "";
}

function uninstallCommandFromScriptUrl(item: MarketCatalogItem | MarketItem) {
  const platform = currentCliPlatform();
  if (platform === "windows") {
    const url = readMetadata(item, [
      "windowsUninstallScriptUrl",
      "win32UninstallScriptUrl",
      "uninstallPs1Url",
      "uninstallScriptUrl"
    ]);
    if (!url) {
      return "";
    }
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object System.Net.WebClient).DownloadString(${powerShellSingleQuote(url)}))"`;
  }
  if (platform === "macos") {
    const url = readMetadata(item, [
      "macosUninstallScriptUrl",
      "darwinUninstallScriptUrl",
      "uninstallShUrl",
      "uninstallScriptUrl"
    ]);
    return url ? `curl -fsSL ${shellSingleQuote(url)} | sh` : "";
  }
  return "";
}

function generatedArchiveScriptCommand(item: MarketCatalogItem | MarketItem, scriptName: "install" | "uninstall") {
  const selected = "assets" in item ? selectAsset(item) : null;
  const archiveUrl = selected?.asset.url;
  if (!archiveUrl) {
    return "";
  }
  const platform = currentCliPlatform();
  const safeName = `${item.id}-${item.version}`.replace(/[^a-z0-9._-]+/giu, "-");
  if (platform === "windows") {
    const scriptFile = `${scriptName}.ps1`;
    return [
      "powershell -NoProfile -ExecutionPolicy Bypass -Command",
      `"`,
      `$tmp = Join-Path $env:TEMP ${powerShellSingleQuote(`${safeName}.zip`)}; `,
      `$dest = Join-Path $env:TEMP ${powerShellSingleQuote(safeName)}; `,
      `Invoke-WebRequest -Uri ${powerShellSingleQuote(archiveUrl)} -OutFile $tmp; `,
      "Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue; ",
      "New-Item -ItemType Directory -Path $dest | Out-Null; ",
      "tar.exe -xf $tmp -C $dest; ",
      `$script = Get-ChildItem $dest -Recurse -Filter ${powerShellSingleQuote(scriptFile)} | Select-Object -First 1; `,
      "if ($null -eq $script) { throw 'CLI script not found.' }; ",
      "& $script.FullName",
      `"`
    ].join("");
  }
  if (platform === "macos") {
    const scriptFile = `${scriptName}.sh`;
    return [
      `tmp="$(mktemp -d)"`,
      `curl -fsSL ${shellSingleQuote(archiveUrl)} -o "$tmp/${safeName}.tar.gz"`,
      `tar -xzf "$tmp/${safeName}.tar.gz" -C "$tmp"`,
      `script="$(find "$tmp" -name ${shellSingleQuote(scriptFile)} -type f | head -n 1)"`,
      `test -n "$script"`,
      `sh "$script"`
    ].join(" && ");
  }
  return "";
}

function cliInstallCommand(item: MarketCatalogItem | MarketItem) {
  const platform = currentCliPlatform();
  const direct = platform === "windows"
    ? readMetadata(item, ["windowsInstallCommand", "win32InstallCommand", "installCommand"])
    : platform === "macos"
      ? readMetadata(item, ["macosInstallCommand", "darwinInstallCommand", "installCommand"])
      : readMetadata(item, ["linuxInstallCommand", "installCommand"]);
  return direct || installCommandFromScriptUrl(item) || generatedArchiveScriptCommand(item, "install");
}

function cliUninstallCommand(item: MarketCatalogItem | MarketItem) {
  const platform = currentCliPlatform();
  const direct = platform === "windows"
    ? readMetadata(item, ["windowsUninstallCommand", "win32UninstallCommand", "uninstallCommand"])
    : platform === "macos"
      ? readMetadata(item, ["macosUninstallCommand", "darwinUninstallCommand", "uninstallCommand"])
      : readMetadata(item, ["linuxUninstallCommand", "uninstallCommand"]);
  return direct || uninstallCommandFromScriptUrl(item) || generatedArchiveScriptCommand(item, "uninstall");
}

function cliDetailCommand(item: MarketCatalogItem | MarketItem) {
  return readMetadata(item, [
    "detailCommand",
    "readmeUrl",
    "homepageUrl",
    "manifestUrl"
  ]);
}

function listInstalledCliRecordItems(app: App): MarketItem[] {
  return readInstalledRecords(app)
    .filter((record) => record.type === "cli")
    .map((record) => ({
      id: record.id,
      type: "cli" as const,
      name: record.id,
      version: record.version,
      description: "",
      tags: [],
      state: "installed" as const,
      source: record.source,
      installedVersion: record.version,
      installPath: record.installPath
    }));
}

function withCliCommands(catalog: Catalog, items: MarketItem[]) {
  const catalogById = new Map(catalog.items.map((item) => [item.id, item]));
  return items.map((item) => {
    const catalogItem = catalogById.get(item.id);
    return {
      ...item,
      cliInstallCommand: cliInstallCommand(catalogItem ?? item),
      cliUninstallCommand: cliUninstallCommand(catalogItem ?? item),
      cliDetailCommand: cliDetailCommand(catalogItem ?? item)
    };
  });
}

export async function listCliMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketSectionResult> {
  const result = await loadCliCatalog(app, options);
  return {
    items: withCliCommands(result.catalog, mergeCatalogItems(app, result.catalog.items, listInstalledCliRecordItems(app))),
    offline: result.offline,
    message: result.message,
    sourceUrl: result.sourceUrl
  };
}

export async function installCliMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const { catalog } = await loadCliCatalog(app, options);
  findCatalogItem(catalog, itemId, "cli");
  return {
    ok: false,
    itemId,
    type: "cli",
    state: "not-installed",
    message: t("market.cli.desktopDoesNotInstall")
  };
}

export async function uninstallCliMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const { catalog } = await loadCliCatalog(app, options);
  findCatalogItem(catalog, itemId, "cli");
  return {
    ok: false,
    itemId,
    type: "cli",
    state: "installed",
    message: t("market.cli.desktopDoesNotInstall")
  };
}

export const __cliMarketInternals = {
  cliInstallCommand,
  cliUninstallCommand,
  loadCliCatalog
};
