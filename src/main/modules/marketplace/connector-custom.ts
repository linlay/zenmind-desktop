import fs from "node:fs/promises";
import JSZip from "jszip";
import type { MarketCommandResult } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { importConnectorBytes, MAX_CONNECTOR_ARCHIVE_BYTES } from "./connector-market";

function importedResult(result: { id: string; name: string }): MarketCommandResult {
  return { ok: true, itemId: result.id, connectorId: result.id, type: "connector", state: "local-imported", message: t("market.connector.installed", { name: result.name || result.id }) };
}

/** Only the native file picker supplies this path; renderers never submit filesystem paths. */
export async function importConnectorArchive(archivePath: string): Promise<MarketCommandResult> {
  const file = await fs.open(archivePath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CONNECTOR_ARCHIVE_BYTES) throw new Error(t("market.connector.archiveTooLarge"));
    return importedResult(await importConnectorBytes(await file.readFile()));
  } finally { await file.close(); }
}

/** Platform owns schema/package validation. Keep original JSON text so duplicate keys are rejected there. */
export async function createCustomConnector(value: unknown): Promise<MarketCommandResult> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid connector package input");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["connectorJson", "mcpJson", "cliJson"].includes(key))) throw new Error("Invalid connector package input");
  const zip = new JSZip();
  for (const [field, filename] of [["connectorJson", "connector.json"], ["mcpJson", "mcp.json"], ["cliJson", "cli.json"]]) {
    const content = raw[field];
    if (content === undefined && field !== "connectorJson") continue;
    if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content) > 1024 * 1024) throw new Error("Invalid connector JSON input");
    zip.file(filename, content);
  }
  return importedResult(await importConnectorBytes(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })));
}
