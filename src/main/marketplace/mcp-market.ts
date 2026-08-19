import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { dump as dumpYaml } from "js-yaml";
import type { MarketCommandResult, MarketItem } from "../../shared/contracts";
import { resolveRuntimeRoot } from "../env-bootstrap";
import { t } from "../i18n/main-i18n";
import {
  asNumber,
  asObject,
  asString,
  findCatalogItem,
  getMarketApiBaseUrl,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  readInstalledRecords,
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
      installPath: record.installPath
    }));
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
  return {
    installPath,
    targetPath: path.join(resolveRuntimeRoot(app), MCP_REGISTRIES_DIRECTORY, MCP_REGISTRY_CATEGORY, file)
  };
}

function wrappedMcpFileError(message: string, cause: unknown) {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function publishManagedMcpFile(
  targetPath: string,
  content: string,
  allowReplace: boolean,
  commitRecord: () => void
) {
  const directory = path.dirname(targetPath);
  try {
    fs.mkdirSync(directory, { recursive: true });
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
    fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
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

function stringRecord(value: unknown) {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(asObject(value))) {
    if (key.trim() && typeof entry === "string" && entry.trim()) {
      result[key] = entry.trim();
    }
  }
  return result;
}

function downloadedMcpConfig(value: unknown, itemId: string, fallbackName: string) {
  const root = asObject(value);
  const servers = asObject(root.mcpServers);
  const serverEntries = Object.entries(servers);
  const nested = asObject(root.config || root.registry || root.server);
  const raw = Object.keys(nested).length > 0
    ? nested
    : serverEntries.length > 0
      ? asObject(servers[itemId] ?? serverEntries[0]?.[1])
      : root;
  const downloadedId = asString(root.id || raw.id).trim();
  if (downloadedId && downloadedId !== itemId) {
    throw new Error(t("market.main.mcpIdMismatch", { expected: itemId, actual: downloadedId }));
  }
  const serverKey = asString(raw.serverKey || raw.key || root.serverKey).trim() || itemId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(serverKey)) {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  const transport = asString(raw.transport || raw.type).trim() || "streamable-http";
  if (transport !== "streamable-http" && transport !== "http") {
    throw new Error(t("market.main.mcpHttpOnly"));
  }
  const declaredBaseUrl = asString(raw.baseUrl || root.baseUrl).trim();
  const declaredEndpointUrl = asString(raw.url || raw.endpoint || root.url).trim();
  const sourceUrl = declaredBaseUrl || declaredEndpointUrl;
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    throw new Error(t("market.main.mcpSecureUrlRequired"));
  }
  let baseUrl = sourceUrl;
  let endpointPath = asString(raw.endpointPath || raw.path).trim();
  if (!declaredBaseUrl && declaredEndpointUrl && !endpointPath) {
    baseUrl = parsed.origin;
    endpointPath = parsed.pathname || "/";
  }
  const config: Record<string, unknown> = {
    serverKey,
    name: asString(raw.name || root.name).trim() || fallbackName || serverKey,
    transport: "streamable-http",
    baseUrl
  };
  if (endpointPath) config.endpointPath = endpointPath;
  const authToken = asString(raw.authToken).trim();
  if (authToken) config.authToken = authToken;
  const headers = stringRecord(raw.headers);
  if (Object.keys(headers).length > 0) config.headers = headers;
  const connectTimeout = asNumber(raw["connect-timeout"] ?? raw.connectTimeout);
  const readTimeout = asNumber(raw["read-timeout"] ?? raw.readTimeout);
  const retry = asNumber(raw.retry);
  if (connectTimeout > 0) config["connect-timeout"] = Math.trunc(connectTimeout);
  if (readTimeout > 0) config["read-timeout"] = Math.trunc(readTimeout);
  if (retry >= 0) config.retry = Math.trunc(retry);
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
  const apiBaseUrl = getMarketApiBaseUrl(app, options).replace(/\/+$/u, "");
  if (!apiBaseUrl) throw new Error(t("market.main.marketApiNotConfigured"));
  await requestMarketJson(app, `${apiBaseUrl}/auth/me`, options, "MCP market authentication request");
  const response = await requestMarket(
    app,
    `${apiBaseUrl}/mcps/${encodeURIComponent(item.id)}/download`,
    {},
    options,
    "MCP market download"
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_MCP_CONFIG_BYTES) {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(t("market.main.mcpInvalidConfig"));
  }
  const config = downloadedMcpConfig(payload, item.id, item.name);
  const { installPath, targetPath } = mcpRegistryLocation(app, item.id);
  const installedRecord = readInstalledRecords(app).find((record) => record.type === "mcp" && record.id === item.id);
  publishManagedMcpFile(targetPath, config.yaml, Boolean(installedRecord), () => {
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
    const { targetPath } = mcpRegistryLocation(app, itemId);
    try {
      fs.rmSync(targetPath, { force: true });
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

export const __mcpMarketInternals = { downloadedMcpConfig, loadMcpCatalog, mcpRegistryLocation };
