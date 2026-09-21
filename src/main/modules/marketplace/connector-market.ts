import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import {
  asObject, asString, catalogItemToMarketItem, downloadAsset, findCatalogItem,
  loadMarketplaceCatalog, normalizeCatalog, readInstalledRecords, removeInstalledRecord,
  resolveMarketAsset, upsertInstalledRecord,
  type MarketplaceOptions, type MarketSectionResult
} from "./common";

export type ConnectorPlatformCall = (targetPath: string, options?: {
  method?: string; body?: unknown; rawBody?: Uint8Array; contentType?: string;
}) => Promise<unknown>;
let platformCall: ConnectorPlatformCall | null = null;
export const MAX_CONNECTOR_ARCHIVE_BYTES = 64 * 1024 * 1024;

export function configureConnectorMarketPlatformCaller(call: ConnectorPlatformCall | null) { platformCall = call; }
export function connectorId(value: unknown) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value) || value.includes("..")) throw new Error("Invalid connector identity");
  return value;
}
export async function callConnectorPlatform(targetPath: string, options?: Parameters<ConnectorPlatformCall>[1]) {
  if (!platformCall) throw new Error(t("market.connector.platformUnavailable"));
  return platformCall(targetPath, options);
}
async function installedConnectors() {
  const result = asObject(await callConnectorPlatform("/api/admin/connectors"));
  if (!Array.isArray(result.connectors)) throw new Error("Invalid connector catalog response");
  return result.connectors.map(asObject);
}

/** Platform's installed package ID is independent of its Market distribution ID. */
export async function listConnectorMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketSectionResult> {
  const result = options.catalog
    ? { catalog: normalizeCatalog(options.catalog), offline: false, message: t("market.main.catalogLoaded"), sourceUrl: options.catalogUrl ?? "" }
    : await loadMarketplaceCatalog(app, options, "connector market catalog request");
  let installed: Record<string, unknown>[] | null = null;
  if (platformCall) {
    try { installed = await installedConnectors(); } catch { /* Public browsing remains available during a Platform outage. */ }
  }
  const records = readInstalledRecords(app).filter(record => record.type === "connector");
  const items: MarketItem[] = result.catalog.items.filter(item => item.type === "connector").map(item => {
    const record = records.find(entry => entry.id === item.id);
    const id = record?.resourceKey || item.metadata?.connectorId || item.id;
    const local = installed?.find(entry => entry.id === id);
    const localItem: MarketItem | undefined = local ? {
      id: item.id, type: "connector", name: asString(local.name), version: asString(local.version),
      description: "", tags: [], state: "local-imported", source: "local"
    } : undefined;
    return {
      ...catalogItemToMarketItem(item, local && record ? { ...record, version: asString(local.version) } : undefined, localItem),
      connectorId: id, connectorInstalled: installed === null ? undefined : Boolean(local)
    };
  });
  for (const local of installed ?? []) {
    const id = asString(local.id);
    if (!id || id.startsWith("builtin.") || items.some(item => item.connectorId === id)) continue;
    items.push({ id, connectorId: id, connectorInstalled: true, type: "connector", name: asString(local.name) || id,
      version: asString(local.version), description: asString(local.description), tags: [], state: "local-imported", source: "local" });
  }
  return { ...result, items };
}

export async function importConnectorBytes(bytes: Uint8Array, overwrite = false, expected?: { id: string; version: string }) {
  if (!bytes.length || bytes.length > MAX_CONNECTOR_ARCHIVE_BYTES) throw new Error(t("market.connector.archiveTooLarge"));
  const boundary = `desktop-connector-${randomUUID()}`;
  const form: Record<string, string> = overwrite ? { overwrite: "true" } : {};
  if (expected) { form.expectedId = connectorId(expected.id); form.expectedVersion = expected.version; }
  const fields = Object.entries(form).map(([name, value]) => {
    if (!value || /[\r\n]/.test(value)) throw new Error("Invalid connector installation identity");
    return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }).join("");
  const rawBody = Buffer.concat([
    Buffer.from(`${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="connector.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const response = asObject(await callConnectorPlatform("/api/admin/connectors/import", {
    method: "POST", rawBody, contentType: `multipart/form-data; boundary=${boundary}`
  }));
  const id = connectorId(response.id);
  if (response.installed !== true || !asString(response.version)) throw new Error("Invalid connector installation response");
  return { id, version: asString(response.version), name: asString(response.name) };
}

export async function installConnectorMarketItem(app: App, itemId: string, options: MarketplaceOptions = {}): Promise<MarketCommandResult> {
  if (!platformCall) throw new Error(t("market.connector.platformUnavailable"));
  const catalog = await loadMarketplaceCatalog(app, options, "connector install catalog request");
  const item = findCatalogItem(catalog.catalog, itemId, "connector");
  const resolved = await resolveMarketAsset(app, item, options);
  if (!resolved.asset.sha256) throw new Error(t("market.main.downloadChecksumFailed"));
  const archive = await downloadAsset(app, resolved.item, resolved.asset, options, resolved.downloadUrl, MAX_CONNECTOR_ARCHIVE_BYTES);
  try {
    const record = readInstalledRecords(app).find(entry => entry.type === "connector" && entry.id === item.id);
    const expectedId = connectorId(record?.resourceKey || resolved.item.metadata?.connectorId || resolved.item.id);
    const existing = (await installedConnectors()).some(entry => entry.id === expectedId);
    const installed = await importConnectorBytes(fs.readFileSync(archive), existing, {
      id: expectedId, version: resolved.item.version
    });
    if (installed.version !== resolved.item.version) throw new Error(t("market.main.resolveIdentityMismatch"));
    upsertInstalledRecord(app, {
      id: item.id, type: "connector", version: installed.version, resourceKey: installed.id,
      source: "cloud", platform: resolved.platform, sha256: resolved.asset.sha256,
      installedAt: new Date().toISOString()
    });
    return { ok: true, itemId: item.id, type: "connector", state: "installed", connectorId: installed.id,
      message: t("market.connector.installed", { name: item.name }) };
  } finally { fs.rmSync(archive, { force: true }); }
}
export async function uninstallConnectorMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  const record = readInstalledRecords(app).find(entry => entry.type === "connector" && entry.id === itemId);
  const id = connectorId(record?.resourceKey || itemId);
  const result = asObject(await callConnectorPlatform(`/api/admin/connectors/detail?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
  if (result.id !== id || result.deleted !== true) throw new Error("Invalid connector deletion response");
  removeInstalledRecord(app, itemId, "connector");
  return { ok: true, itemId, type: "connector", state: "not-installed", connectorId: id, message: t("market.connector.removed") };
}
