export interface ConnectorPackageInput { connectorJson: string; mcpJson?: string; cliJson?: string }
export interface BasicConnectorInput { id: string; name: string; url: string; authMode: "none" | "mcp" | "token" }
const secretKey = /^(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|authToken|token|secret)$/i;
const variable = /^(?:Bearer\s+)?\$\{[A-Z][A-Z0-9_]*\}$/i;
function inspect(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(inspect); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "password" && record.defaultValue !== undefined) throw new Error("market.connector.customForm.secret");
  for (const [key, entry] of Object.entries(record)) {
    if (secretKey.test(key) && typeof entry === "string" && entry.trim() && !variable.test(entry.trim())) throw new Error("market.connector.customForm.secret");
    if (key.toLowerCase() === "url" && typeof entry === "string") {
      try { const url = new URL(entry); if (url.username || url.password || [...url.searchParams].some(([name, contents]) => secretKey.test(name) && contents && !variable.test(contents))) throw new Error("market.connector.customForm.secret"); }
      catch (error) { if (error instanceof Error && error.message === "market.connector.customForm.secret") throw error; }
    }
    inspect(entry);
  }
}
export function validateConnectorPackage(input: ConnectorPackageInput): { id: string; name: string; version: string } {
  let manifest: Record<string, unknown> | undefined;
  for (const [file, text] of Object.entries(input)) {
    if (!text?.trim()) continue;
    if (text.length > 256 * 1024) throw new Error("market.connector.customForm.invalid");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("market.connector.customForm.invalid"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("market.connector.customForm.invalid");
    inspect(parsed);
    if (file === "connectorJson") manifest = parsed as Record<string, unknown>;
  }
  if (!manifest || typeof manifest.id !== "string" || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(manifest.id) || manifest.id.length > 96 || typeof manifest.name !== "string" || !manifest.name.trim() || typeof manifest.version !== "string") throw new Error("market.connector.customForm.invalid");
  return { id: manifest.id, name: manifest.name, version: manifest.version };
}
export function createBasicConnectorPackage(input: BasicConnectorInput): ConnectorPackageInput {
  let endpoint: URL;
  try { endpoint = new URL(input.url.trim()); } catch { throw new Error("market.connector.customForm.invalid"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.hash || endpoint.username || endpoint.password) throw new Error("market.connector.customForm.invalid");
  const connector = { id: input.id.trim(), name: input.name.trim(), version: "1.0.0", type: "mcp", auth_mode: input.authMode === "none" ? null : input.authMode,
    ...(input.authMode === "token" ? { token_schema: { fields: [{ key: "API_KEY", label: "API Key", type: "password", required: true }] } } : {}) };
  const mcp = { mcpServers: { main: { type: "streamableHttp", url: endpoint.href,
    ...(input.authMode === "token" ? { headers: { Authorization: "Bearer ${API_KEY}" } } : {}) } } };
  const result = { connectorJson: JSON.stringify(connector, null, 2), mcpJson: JSON.stringify(mcp, null, 2) };
  validateConnectorPackage(result); return result;
}

/** A dialog owns continuations only while the same visible instance is mounted. */
export function createConnectorDialogScope() {
  let visible = false;
  let generation = 0;
  return {
    setVisible(next: boolean) { visible = next; generation++; },
    capture() { const revision = generation; return () => visible && revision === generation; },
  };
}
export async function runConnectorDialogRequest<T>(current: () => boolean, request: () => Promise<T>, accept: (result: T) => void): Promise<void> {
  if (!current()) return;
  const result = await request();
  // Installation can finish in Platform. Only this still-visible user intent may continue.
  if (current()) accept(result);
}
