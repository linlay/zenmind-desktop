import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { dump as dumpYaml } from "js-yaml";
import type { MarketCommandResult, MarketItem, MarketMcpRuntimeStatus } from "../../../shared/contracts";
import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";
import { t } from "../../support/i18n/main-i18n";
import {
  asObject,
  asString,
  assertDesktopVersionCompatible,
  findCatalogItem,
  getMarketApiBaseUrl,
  isLoopbackHostname,
  MARKET_AUTH_ME_PATH,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  readInstalledRecords,
  readResponseBytesWithLimit,
  removeInstalledRecord,
  requestMarket,
  requestMarketJson,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

const MCP_REGISTRIES_DIRECTORY = "registries";
const MCP_REGISTRY_CATEGORY = "mcp-servers";
const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
const MCP_AUTH_SOURCE_IDENTITY_FILE = "identity-file";

export type McpRuntimeStatusSnapshot = {
  serverKey: string;
  status: string;
  syncStatus: string;
  toolCount: number;
  message?: string;
};

function mcpOnlyCatalog(catalog: Catalog): Catalog {
  return { ...catalog, items: catalog.items.filter((item) => item.type === "mcp") };
}

async function loadMcpCatalog(app: App, options: MarketplaceOptions = {}) {
  if (options.catalog) {
    return {
      catalog: mcpOnlyCatalog(normalizeCatalog(options.catalog)),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? getMarketApiBaseUrl(app, options)
    };
  }
  const result = await loadMarketplaceCatalog(app, options, "MCP market catalog request");
  return { ...result, catalog: mcpOnlyCatalog(result.catalog) };
}

function installedMcpItems(app: App): MarketItem[] {
  return readInstalledRecords(app)
    .filter((record) => record.type === "mcp")
    .map((record) => ({
      id: record.id,
      type: "mcp" as const,
      name: record.id,
      version: record.version,
      description: "",
      tags: [],
      state: "installed" as const,
      source: record.source,
      installedVersion: record.version,
      installPath: record.installPath,
      mcpServerKey: record.resourceKey || record.id,
      mcpRuntimeStatus: "configuration-written" as const
    }));
}

function normalizedMcpRuntimeStatus(snapshot: McpRuntimeStatusSnapshot): MarketMcpRuntimeStatus {
  const sourceStatus = String(snapshot.status ?? "").trim().toLowerCase();
  const syncStatus = String(snapshot.syncStatus ?? "").trim().toLowerCase();
  if (sourceStatus === "invalid") return "invalid";
  if (sourceStatus === "disabled" || syncStatus === "disabled") return "disabled";
  if (syncStatus === "ready") return "ready";
  if (syncStatus === "unavailable") return "unavailable";
  if (syncStatus === "pending" || syncStatus === "syncing") return "pending";
  return "configuration-written";
}

export function mergeMcpRuntimeStatuses(items: MarketItem[], snapshots: McpRuntimeStatusSnapshot[]) {
  const byKey = new Map(
    snapshots
      .filter((snapshot) => snapshot.serverKey.trim())
      .map((snapshot) => [snapshot.serverKey.trim().toLowerCase(), snapshot])
  );
  return items.map((item) => {
    if (item.type !== "mcp" || !item.installPath) {
      return item;
    }
    const runtimeKey = (item.mcpServerKey || item.id).trim().toLowerCase();
    const snapshot = byKey.get(runtimeKey);
    if (!snapshot) {
      return {
        ...item,
        mcpRuntimeStatus: item.mcpRuntimeStatus ?? "configuration-written"
      };
    }
    return {
      ...item,
      mcpServerKey: snapshot.serverKey,
      mcpRuntimeStatus: normalizedMcpRuntimeStatus(snapshot),
      mcpToolCount: Math.max(0, Math.trunc(snapshot.toolCount || 0)),
      mcpRuntimeMessage: snapshot.message?.trim() || undefined
    };
  });
}

export async function listMcpMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketSectionResult> {
  const result = await loadMcpCatalog(app, options);
  return {
    items: mergeCatalogItems(app, result.catalog.items, installedMcpItems(app)),
    offline: result.offline,
    message: result.message,
    sourceUrl: result.sourceUrl
  };
}

function safeMcpFileName(itemId: string) {
  const id = itemId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  return `${id}.yml`;
}

function mcpRegistryLocation(app: App, itemId: string) {
  const file = safeMcpFileName(itemId);
  const installPath = `${MCP_REGISTRIES_DIRECTORY}/${MCP_REGISTRY_CATEGORY}/${file}`;
  const runtimeRoot = resolveRuntimeRoot(app);
  return {
    installPath,
    runtimeRoot,
    targetPath: path.join(runtimeRoot, MCP_REGISTRIES_DIRECTORY, MCP_REGISTRY_CATEGORY, file)
  };
}

function wrappedMcpFileError(message: string, cause: unknown) {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function assertMcpRegistryTarget(runtimeRoot: string, targetPath: string) {
  const realRuntimeRoot = fs.realpathSync(runtimeRoot);
  const realDirectory = fs.realpathSync(path.dirname(targetPath));
  const relativeDirectory = path.relative(realRuntimeRoot, realDirectory);
  if (relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) {
    throw new Error("MCP registry directory escapes the runtime root");
  }
  if (fs.existsSync(targetPath) && !fs.lstatSync(targetPath).isFile()) {
    throw new Error(t("market.main.mcpFileConflict"));
  }
}

function publishManagedMcpFile(
  runtimeRoot: string,
  targetPath: string,
  content: string,
  allowReplace: boolean,
  commitRecord: () => void
) {
  const directory = path.dirname(targetPath);
  try {
    fs.mkdirSync(directory, { recursive: true });
    assertMcpRegistryTarget(runtimeRoot, targetPath);
  } catch (error) {
    throw wrappedMcpFileError(t("market.main.mcpFileWriteFailed"), error);
  }
  const targetExists = fs.existsSync(targetPath);
  if (targetExists && !allowReplace) {
    throw new Error(t("market.main.mcpFileConflict"));
  }

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${nonce}.tmp`);
  const backupPath = path.join(directory, `.${path.basename(targetPath)}.${nonce}.bak`);
  let backupActive = false;
  let targetPublished = false;
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (targetExists) {
      fs.renameSync(targetPath, backupPath);
      backupActive = true;
    }
    fs.renameSync(temporaryPath, targetPath);
    targetPublished = true;
    commitRecord();
  } catch (error) {
    try {
      if (targetPublished) {
        fs.rmSync(targetPath, { force: true });
      }
      if (backupActive && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, targetPath);
        backupActive = false;
      }
    } catch (rollbackError) {
      throw wrappedMcpFileError(t("market.main.mcpFileRollbackFailed"), rollbackError);
    }
    throw wrappedMcpFileError(t("market.main.mcpFileWriteFailed"), error);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  if (backupActive) {
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      // The new file and install record are already committed. A hidden backup
      // cleanup failure must not report the installation as failed.
    }
  }
}

function removeManagedMcpFile(
  runtimeRoot: string,
  targetPath: string,
  commitRecord: () => void
) {
  if (!fs.existsSync(targetPath)) {
    commitRecord();
    return;
  }
  assertMcpRegistryTarget(runtimeRoot, targetPath);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const backupPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${nonce}.bak`);
  let backupActive = false;
  try {
    fs.renameSync(targetPath, backupPath);
    backupActive = true;
    commitRecord();
  } catch (error) {
    if (backupActive && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, targetPath);
      backupActive = false;
    }
    throw error;
  }
  if (backupActive) {
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      // Registry file and install record are already removed; hidden backup cleanup is best effort.
    }
  }
}

function downloadedMcpConfig(
  value: unknown,
  itemId: string,
  fallbackName: string,
  fallbackAuthSource = "",
  expectedVersion = "",
  expectedServerKey = ""
) {
  const root = asObject(value);
  const market = asObject(root.market);
  const servers = asObject(root.mcpServers);
  const serverEntries = Object.entries(servers);
  if (serverEntries.length !== 1) {
    throw new Error(t("market.main.mcpSingleServerRequired"));
  }
  const [serverKey, serverValue] = serverEntries[0];
  const raw = asObject(serverValue);
  const downloadedId = asString(market.id).trim();
  if (downloadedId !== itemId) {
    throw new Error(t("market.main.mcpIdMismatch", {
      expected: itemId,
      actual: downloadedId || t("common.none")
    }));
  }
  const downloadedVersion = asString(market.version).trim();
  if (expectedVersion && downloadedVersion !== expectedVersion) {
    throw new Error(t("market.main.mcpVersionMismatch", {
      expected: expectedVersion,
      actual: downloadedVersion || t("common.none")
    }));
  }
  if (!serverKey.trim() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(serverKey)) {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  if (expectedServerKey && serverKey !== expectedServerKey) {
    throw new Error(t("market.main.mcpServerKeyMismatch", { expected: expectedServerKey, actual: serverKey }));
  }
  const transport = asString(raw.type).trim();
  if (transport !== "streamable-http") {
    throw new Error(t("market.main.mcpHttpOnly"));
  }
  if (["command", "args", "env", "workingDirectory", "working-directory"].some((key) => Object.hasOwn(raw, key))) {
    throw new Error(t("market.main.mcpHttpOnly"));
  }
  const sourceUrl = asString(raw.url).trim();
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  const loopbackHttp = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    throw new Error(t("market.main.mcpSecureUrlRequired"));
  }
  const baseUrl = parsed.origin;
  const endpointPath = parsed.pathname || "/";
  const config: Record<string, unknown> = {
    serverKey,
    name: fallbackName || serverKey,
    transport: "streamable-http",
    baseUrl,
    endpointPath
  };
  const authToken = asString(raw.authToken || raw["auth-token"]).trim();
  if (authToken) {
    throw new Error(t("market.main.mcpStaticCredentialRejected"));
  }
  const declaredAuthSource = asString(raw.authSource || raw["auth-source"]).trim().toLowerCase();
  if (declaredAuthSource) {
    throw new Error(t("market.main.mcpAuthSourceRejected"));
  }
  const authSource = fallbackAuthSource;
  if (authSource) config.authSource = authSource;
  if (Object.keys(asObject(raw.headers)).length > 0) {
    throw new Error(t("market.main.mcpHeadersRejected"));
  }
  return {
    serverKey,
    yaml: dumpYaml(config, { lineWidth: 120, noRefs: true, quotingType: "\"" })
  };
}

export async function installMcpMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const { catalog } = await loadMcpCatalog(app, options);
  const item = findCatalogItem(catalog, itemId, "mcp");
  const itemMetadata = asObject(item.metadata);
  const gatewayTagged = item.tags.some((tag) => tag.trim().toLowerCase() === "gateway");
  const gatewayServerCode = asString(itemMetadata.gatewayServerCode).trim();
  if (gatewayTagged && !gatewayServerCode) {
    throw new Error(t("market.main.mcpGatewayServerCodeRequired"));
  }
  const requiresDesktopIdentity = gatewayTagged || Boolean(gatewayServerCode);
  const installedRecord = readInstalledRecords(app).find((record) => record.type === "mcp" && record.id === item.id);
  const { installPath, runtimeRoot, targetPath } = mcpRegistryLocation(app, item.id);
  const apiBaseUrl = getMarketApiBaseUrl(app, options).replace(/\/+$/u, "");
  if (!apiBaseUrl) throw new Error(t("market.main.marketApiNotConfigured"));
  await requestMarketJson(app, `${apiBaseUrl}${MARKET_AUTH_ME_PATH}`, options, "MCP market authentication request");
  const platform = "universal";
  const resolveQuery = new URLSearchParams({ version: item.version, platform });
  const resolved = asObject(await requestMarketJson(
    app,
    `${apiBaseUrl}/mcps/${encodeURIComponent(item.id)}/resolve?${resolveQuery.toString()}`,
    options,
    "MCP market resolve request"
  ));
  const resolvedItem = asObject(resolved.item);
  if (
    asString(resolvedItem.id).trim() !== item.id ||
    asString(resolvedItem.type).trim() !== "mcp" ||
    asString(resolved.version).trim() !== item.version ||
    (asString(resolved.platform).trim() && asString(resolved.platform).trim() !== platform)
  ) {
    throw new Error(t("market.main.resolveIdentityMismatch"));
  }
  const resolvedPlatformSpec = asObject(resolved.platformSpec);
  const resolvedMinDesktopVersion = asString(resolvedPlatformSpec.minDesktopVersion).trim();
  assertDesktopVersionCompatible(app, {
    ...item,
    minDesktopVersion: resolvedMinDesktopVersion || item.minDesktopVersion
  });
  const response = await requestMarket(
    app,
    `${apiBaseUrl}/mcps/${encodeURIComponent(item.id)}/download?${resolveQuery.toString()}`,
    {},
    options,
    "MCP market download"
  );
  const bytes = await readResponseBytesWithLimit(response, MAX_MCP_CONFIG_BYTES);
  if (bytes.length === 0) {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  const config = downloadedMcpConfig(
    payload,
    item.id,
    item.name,
    requiresDesktopIdentity ? MCP_AUTH_SOURCE_IDENTITY_FILE : "",
    item.version,
    gatewayServerCode
  );
  publishManagedMcpFile(runtimeRoot, targetPath, config.yaml, Boolean(installedRecord), () => {
    upsertInstalledRecord(app, {
      id: item.id,
      type: "mcp",
      version: item.version,
      source: "cloud",
      resourceKey: config.serverKey,
      installPath,
      installedAt: new Date().toISOString()
    });
  });
  return {
    ok: true,
    itemId: item.id,
    type: "mcp",
    state: "installed",
    message: t("market.main.mcpInstalled", { name: item.name }),
    installPath
  };
}

export async function uninstallMcpMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  const installedRecord = readInstalledRecords(app).find((record) => record.type === "mcp" && record.id === itemId);
  if (installedRecord) {
    const { runtimeRoot, targetPath } = mcpRegistryLocation(app, itemId);
    try {
      removeManagedMcpFile(runtimeRoot, targetPath, () => {
        removeInstalledRecord(app, itemId, "mcp");
      });
    } catch (error) {
      throw wrappedMcpFileError(t("market.main.mcpFileRemoveFailed"), error);
    }
  }
  return {
    ok: true,
    itemId,
    type: "mcp",
    state: "not-installed",
    message: t("market.main.mcpUninstalled", { id: itemId })
  };
}

export const __mcpMarketInternals = {
  assertMcpRegistryTarget,
  downloadedMcpConfig,
  loadMcpCatalog,
  mcpRegistryLocation
};
