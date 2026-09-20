import JSZip from "jszip";
import type { App } from "electron";
import { asObject, readInstalledRecords } from "./common";
import { callConnectorPlatform, importConnectorBytes } from "./connector-market";

export const CUSTOM_MCP_ID = "desktop-custom-mcp";
const name = "Desktop Custom MCP";
const description = "Desktop managed custom MCP configuration";
const empty = '{\n  "mcpServers": {}\n}';
const location = `${CUSTOM_MCP_ID}/mcp.json`;
export type CustomMcpConfig = { path: string; content: string };

// Detect duplicate keys before JSON.parse can silently discard them.
function parseUniqueJson(content: string): unknown {
  JSON.parse(content);
  const tokens = content.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  let cursor = 0;
  function value(): void {
    const token = tokens[cursor++];
    if (token === "{") {
      const keys = new Set<string>();
      while (tokens[cursor] !== "}") {
        const key = JSON.parse(tokens[cursor++]) as string;
        if (keys.has(key)) throw new Error("MCP JSON contains duplicate keys");
        keys.add(key); cursor++; value();
        if (tokens[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (token === "[") {
      while (tokens[cursor] !== "]") { value(); if (tokens[cursor] !== ",") break; cursor++; }
      cursor++;
    }
  }
  value();
  return JSON.parse(content);
}

export function normalizeCustomMcpConfig(input: unknown): string {
  if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > 1024 * 1024) throw new Error("MCP JSON must be nonempty and under 1 MB");
  const raw = asObject(parseUniqueJson(input));
  if (Object.keys(raw).length !== 1 || !Object.hasOwn(raw, "mcpServers") || !raw.mcpServers || typeof raw.mcpServers !== "object" || Array.isArray(raw.mcpServers)) throw new Error("Expected a JSON object containing mcpServers");
  const servers = asObject(raw.mcpServers);
  if (!Object.keys(servers).length) throw new Error("Keep at least one MCP service. Remove the custom connector from Connector Center to clear it.");
  if (Object.keys(servers).length > 64) throw new Error("Too many MCP services");
  for (const [key, entry] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) throw new Error("Invalid MCP service name");
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each MCP service must be an object");
    const server = entry as Record<string, unknown>;
    const type = server.type ?? (server.url ? "streamableHttp" : "stdio");
    if (!["http", "streamableHttp", "stdio"].includes(String(type))) throw new Error("Supported MCP types: streamableHttp and stdio");
    server.type = type === "http" ? "streamableHttp" : type;
    if (server.type === "stdio") {
      if (typeof server.command !== "string" || !server.command.trim() || server.url !== undefined) throw new Error("stdio MCP requires a nonempty command and no URL");
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== "string"))) throw new Error("MCP args must be a string array");
    } else {
      if (typeof server.url !== "string" || server.command !== undefined || server.args !== undefined) throw new Error("HTTP MCP requires a URL and no command");
      const url = new URL(server.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("MCP URL must use HTTP(S), without credentials, query parameters or fragment");
    }
    for (const field of ["env", "staticEnv", "headers", "staticHeaders"]) {
      if (server[field] === undefined) continue;
      if (!server[field] || typeof server[field] !== "object" || Array.isArray(server[field])) throw new Error(`${field} must be an object`);
      for (const [fieldKey, value] of Object.entries(server[field] as Record<string, unknown>)) {
        if (typeof value !== "string") throw new Error(`${field} values must be strings`);
        if (/\$\{/.test(value)) throw new Error("Credential templates require an authentication schema. Use a connector package with token_schema instead.");
        if (/(token|secret|password|passwd|authorization|cookie|api[_-]?key|credential)/i.test(fieldKey)) throw new Error("Do not put credentials in MCP JSON. Use an authenticated connector package and its credential form.");
      }
    }
    if (/(?:\bbearer\s|--(?:password|token|api-key|secret)(?:=|\s|$))/i.test([server.command, ...(Array.isArray(server.args) ? server.args : [])].join(" "))) throw new Error("Do not put credentials in command arguments");
    const allowed = new Set(["type", "url", "command", "args", "env", "staticEnv", "headers", "staticHeaders", "timeout", "startupTimeout"]);
    if (Object.keys(server).some(field => !allowed.has(field))) throw new Error("Unsupported MCP setting; use a full connector package for advanced authentication");
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

async function installed(app: App): Promise<boolean> {
  if (readInstalledRecords(app).some(record => record.id === CUSTOM_MCP_ID || record.resourceKey === CUSTOM_MCP_ID)) throw new Error("The custom MCP ID is occupied by a market installation; it will not be overwritten");
  const catalog = asObject(await callConnectorPlatform("/api/admin/connectors"));
  if (!Array.isArray(catalog.connectors)) throw new Error("Invalid connector catalog response");
  const item = catalog.connectors.map(asObject).find(value => value.id === CUSTOM_MCP_ID);
  if (!item) return false;
  if (item.name !== name || item.description !== description || item.version !== "1.0.0" || item.type !== "mcp" || item.auth_mode !== null) throw new Error("The custom MCP ID is occupied by another connector; it will not be overwritten");
  return true;
}

export async function getCustomMcpConfig(app: App): Promise<CustomMcpConfig> {
  if (!await installed(app)) return { path: location, content: empty };
  const file = asObject(await callConnectorPlatform(`/api/admin/connectors/detail?id=${CUSTOM_MCP_ID}&file=mcp.json`));
  if (typeof file.content !== "string") throw new Error("Invalid MCP configuration response");
  return { path: location, content: file.content };
}

let mutation: Promise<unknown> = Promise.resolve();
export function saveCustomMcpConfig(app: App, value: unknown): Promise<CustomMcpConfig> {
  const operation = mutation.catch(() => undefined).then(async () => {
    const input = asObject(value);
    if (Object.keys(input).length !== 1) throw new Error("Expected MCP content");
    const content = normalizeCustomMcpConfig(input.content);
    const overwrite = await installed(app);
    const zip = new JSZip();
    zip.file("connector.json", JSON.stringify({ id: CUSTOM_MCP_ID, name, description, version: "1.0.0", type: "mcp", auth_mode: null }));
    zip.file("mcp.json", content);
    await importConnectorBytes(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), overwrite, { id: CUSTOM_MCP_ID, version: "1.0.0" });
    return getCustomMcpConfig(app);
  });
  mutation = operation;
  return operation;
}
