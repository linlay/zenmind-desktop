export type WebsiteBridgeManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  origin: string;
  description?: string;
  pages: Array<{ path: string; script: string }>;
};
export type WebsiteBridgeView = WebsiteBridgeManifest & { enabled: boolean };
export type WebsiteBridgeResult = { ok: true; items: WebsiteBridgeView[]; selectedId?: string; cancelled?: boolean; script?: string } |
  { ok: false; error: "invalidPackage" | "packageTooLarge" | "invalidScript" | "conflict" | "notFound" | "storageFailed" };
export class WebsiteBridgeError extends Error {
  constructor(readonly code: Extract<WebsiteBridgeResult, { ok: false }>["error"]) { super(code); }
}
export const WEBSITE_BRIDGE_LIMITS = { entries: 150, archiveBytes: 5 * 1024 * 1024, expandedBytes: 10 * 1024 * 1024, fileBytes: 512 * 1024, manifestBytes: 64 * 1024 };
export function bridgeResourcePath(input: string) {
  if (typeof input !== "string" || !input || input.length > 240 || input.includes("\\") ||
      input.split("/").some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new WebsiteBridgeError("invalidPackage");
  return input;
}
export function parseWebsiteBridgeManifest(input: unknown): WebsiteBridgeManifest {
  const invalid = () => { throw new WebsiteBridgeError("invalidPackage"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as WebsiteBridgeManifest;
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) || value.id.length > 80 ||
      typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 || typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      typeof value.origin !== "string" || (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 4096)) ||
      !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 100) return invalid();
  bridgeResourcePath(value.id);
  let origin: URL;
  try { origin = new URL(value.origin); } catch { return invalid(); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return invalid();
  const patterns = new Set<string>();
  const pages = value.pages.map(page => {
    if (!page || typeof page.path !== "string" || page.path.length > 1024 || !page.path.startsWith("/") || /[?#\\*]/.test(page.path) || typeof page.script !== "string" || !page.script.endsWith(".js")) return invalid();
    const normalized = page.path === "/" ? "/" : page.path.replace(/\/$/, "");
    const names = new Set<string>();
    for (const segment of normalized.slice(1).split("/")) {
      if (segment.startsWith(":")) { if (!/^:[a-zA-Z][a-zA-Z0-9]*$/.test(segment) || names.has(segment)) return invalid(); names.add(segment); }
      else if (segment.includes(":") || segment === "." || segment === ".." || (!segment && normalized !== "/")) return invalid();
    }
    const shape = normalized.replace(/:[a-zA-Z][a-zA-Z0-9]*/g, ":param");
    if (patterns.has(shape)) return invalid(); patterns.add(shape);
    return { path: normalized, script: bridgeResourcePath(page.script) };
  });
  return { schemaVersion: 1, id: value.id, name: value.name.trim(), version: value.version, origin: origin.origin, ...(value.description ? { description: value.description } : {}), pages };
}

/** Only top-level page pathname selects a script. API URLs, query and hash do not. */
export function matchWebsiteBridgePage(manifest: WebsiteBridgeManifest, rawUrl: string) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.origin !== manifest.origin || url.username || url.password) return null;
  const actual = (url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "")).split("/");
  const matches = manifest.pages.flatMap((page, index) => {
    const pattern = page.path.split("/"); const params: Record<string, string> = {};
    if (pattern.length !== actual.length) return [];
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(":")) {
        if (!actual[i]) return [];
        try { params[pattern[i].slice(1)] = decodeURIComponent(actual[i]); } catch { return []; }
      } else if (pattern[i] !== actual[i]) return [];
    }
    return [{ page, params, index, literals: pattern.filter(part => !part.startsWith(":")).length }];
  });
  return matches.sort((a, b) => b.literals - a.literals || a.index - b.index)[0] ?? null;
}
