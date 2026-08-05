import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import type { App } from "electron";
import type { MarketCommandResult } from "../../shared/contracts";
import { extractArchiveToDir } from "../archive-utils";
import {
  downloadAsset,
  findCatalogItem,
  loadMarketplaceCatalog,
  normalizeCatalog,
  readInstalledRecords,
  removeInstalledRecord,
  selectAsset,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions
} from "./common";

type AgentPlatformCall = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>;
let agentPlatformCall: AgentPlatformCall | null = null;

export function configureAgentMarketPlatformCaller(call: AgentPlatformCall) {
  agentPlatformCall = call;
}

function agentOnlyCatalog(catalog: Catalog): Catalog {
  return { ...catalog, items: catalog.items.filter((item) => item.type === "agent") };
}

async function loadAgentCatalog(app: App, options: MarketplaceOptions) {
  if (options.catalog) {
    return agentOnlyCatalog(normalizeCatalog(options.catalog));
  }
  return agentOnlyCatalog((await loadMarketplaceCatalog(app, options, "agent market catalog request")).catalog);
}

function findAgentManifest(root: string) {
  const matches: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 4 || matches.length > 1) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Agent package cannot contain symbolic links.");
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (entry.isFile() && /^(?:agent\.ya?ml)$/iu.test(entry.name)) matches.push(target);
    }
  };
  visit(root, 0);
  if (matches.length !== 1) throw new Error("Agent package must contain exactly one agent.yml or agent.yaml.");
  return matches[0];
}

function readOptionalText(filePath: string) {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf8");
  if (Buffer.byteLength(content, "utf8") > 512 * 1024) throw new Error(`${path.basename(filePath)} is too large.`);
  return content;
}

export async function installAgentMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const catalog = await loadAgentCatalog(app, options);
  const item = findCatalogItem(catalog, itemId, "agent");
  if (!agentPlatformCall) throw new Error("Agent installation is unavailable until agent-platform is ready.");
  const selected = selectAsset(item);
  if (!selected) throw new Error("No compatible agent package is available.");
  const archivePath = await downloadAsset(app, item, selected.asset);
  const tempRoot = fs.mkdtempSync(path.join(app.getPath("temp"), "desktop-agent-market-"));
  try {
    await extractArchiveToDir(archivePath, tempRoot);
    const manifestPath = findAgentManifest(tempRoot);
    const rawDefinition = loadYaml(fs.readFileSync(manifestPath, "utf8")) as unknown;
    if (!rawDefinition || typeof rawDefinition !== "object" || Array.isArray(rawDefinition)) {
      throw new Error("agent.yml must contain an object definition.");
    }
    const definition = rawDefinition as Record<string, unknown>;
    const agentKey = typeof definition.key === "string" ? definition.key.trim() : "";
    const expectedAgentKey = item.metadata?.agentKey?.trim() || item.id;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(agentKey) || agentKey !== expectedAgentKey) {
      throw new Error("Agent package key must match metadata.agentKey or the market item ID.");
    }
    const packageRoot = path.dirname(manifestPath);
    const body = {
      agentKey,
      definition,
      soulPrompt: readOptionalText(path.join(packageRoot, "SOUL.md")),
      agentsPrompt: readOptionalText(path.join(packageRoot, "AGENTS.md"))
    };
    const installed = readInstalledRecords(app).some((record) => record.type === "agent" && record.id === item.id);
    await agentPlatformCall(installed ? "/api/admin/agents/update" : "/api/admin/agents/create", {
      method: "POST",
      body
    });
    upsertInstalledRecord(app, {
      id: item.id,
      type: "agent",
      version: item.version,
      source: "cloud",
      assetUrl: selected.asset.url,
      sha256: selected.asset.sha256,
      resourceKey: agentKey,
      installedAt: new Date().toISOString()
    });
    return {
      ok: true,
      itemId: item.id,
      type: "agent",
      state: "installed",
      message: `${item.name} installed in agent-platform.`
    };
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function uninstallAgentMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  if (!agentPlatformCall) throw new Error("Agent removal is unavailable until agent-platform is ready.");
  const record = readInstalledRecords(app).find((item) => item.type === "agent" && item.id === itemId);
  const agentKey = record?.resourceKey?.trim() || itemId;
  await agentPlatformCall("/api/admin/agents/delete", { method: "POST", body: { agentKey } });
  removeInstalledRecord(app, itemId, "agent");
  return { ok: true, itemId, type: "agent", state: "not-installed", message: `${itemId} removed from agent-platform.` };
}
