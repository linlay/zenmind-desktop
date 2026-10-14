export type WebsiteBridgePage = { origin: string; path: string; description?: string; features: string[] };
export type WebsiteBridgeManifest = {
  schemaVersion: 2;
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Stable key -> exact origin. Hosts are declared here and nowhere else in a package. */
  origins: Record<string, string>;
  /** `origin` is a key of `origins`; `path` is root-relative; each feature is `features/<name>.js`. */
  pages: WebsiteBridgePage[];
};
/**
 * `shared` reports that the package ships the optional shared helper.
 * `outdated` marks an installed package from a removed manifest schema; it is never injected.
 */
export type WebsiteBridgeView = WebsiteBridgeManifest & { enabled: boolean; shared?: true; outdated?: true };
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
/** Optional package-level helper, evaluated once per page before the features. */
export const WEBSITE_BRIDGE_SHARED_SCRIPT = "shared.js";
export const websiteBridgeFeatureScript = (feature: string) => `features/${feature}.js`;
/** Every script a package must ship for its manifest, excluding the optional shared helper. */
export const websiteBridgeFeatureScripts = (manifest: WebsiteBridgeManifest) =>
  [...new Set(manifest.pages.flatMap(page => page.features))].sort().map(websiteBridgeFeatureScript);
const slug = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

export function parseWebsiteBridgeManifest(input: unknown): WebsiteBridgeManifest {
  const invalid = () => { throw new WebsiteBridgeError("invalidPackage"); };
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!record(input)) return invalid();
  const value = input as WebsiteBridgeManifest;
  if (value.schemaVersion !== 2 || !slug(value.id, 80) ||
      typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 || typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 4096)) ||
      !record(value.origins) || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 100) return invalid();
  bridgeResourcePath(value.id);
  const keys = Object.keys(value.origins);
  if (!keys.length || keys.length > 20) return invalid();
  const origins: Record<string, string> = {};
  for (const key of keys) {
    const raw = value.origins[key];
    if (!slug(key, 40) || typeof raw !== "string") return invalid();
    let origin: URL;
    try { origin = new URL(raw); } catch { return invalid(); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
        Object.values(origins).includes(origin.origin)) return invalid();
    origins[key] = origin.origin;
  }
  const patterns = new Set<string>();
  const pages = value.pages.map(page => {
    if (!record(page) || typeof page.path !== "string" || page.path.length > 1024 || !page.path.startsWith("/") || /[?#\\*]/.test(page.path) ||
        (page.description !== undefined && (typeof page.description !== "string" || page.description.length > 4096)) ||
        !Array.isArray(page.features) || !page.features.length || page.features.length > 32 ||
        page.features.some(feature => !slug(feature, 80)) || new Set(page.features).size !== page.features.length) return invalid();
    // A single-origin site may omit the key; multi-origin pages must name theirs.
    const originKey = page.origin === undefined && keys.length === 1 ? keys[0] : page.origin;
    if (typeof originKey !== "string" || !Object.hasOwn(origins, originKey)) return invalid();
    const normalized = page.path === "/" ? "/" : page.path.replace(/\/$/, "");
    const names = new Set<string>();
    for (const segment of normalized.slice(1).split("/")) {
      if (segment.startsWith(":")) { if (!/^:[a-zA-Z][a-zA-Z0-9]*$/.test(segment) || names.has(segment)) return invalid(); names.add(segment); }
      else if (segment.includes(":") || segment === "." || segment === ".." || (!segment && normalized !== "/")) return invalid();
    }
    const shape = originKey + " " + normalized.replace(/:[a-zA-Z][a-zA-Z0-9]*/g, ":param");
    if (patterns.has(shape)) return invalid(); patterns.add(shape);
    return { origin: originKey, path: normalized, ...(page.description ? { description: page.description } : {}), features: [...page.features] };
  });
  return { schemaVersion: 2, id: value.id, name: value.name.trim(), version: value.version, ...(value.description ? { description: value.description } : {}), origins, pages };
}

/** Only the top-level page origin and pathname select features. API URLs, query and hash do not. */
export function matchWebsiteBridgePage(manifest: WebsiteBridgeManifest, rawUrl: string) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.username || url.password) return null;
  const originKey = Object.keys(manifest.origins).find(key => manifest.origins[key] === url.origin);
  if (originKey === undefined) return null;
  const actual = (url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "")).split("/");
  const matches = manifest.pages.flatMap((page, index) => {
    if (page.origin !== originKey) return [];
    const pattern = page.path.split("/"); const params: Record<string, string> = {};
    if (pattern.length !== actual.length) return [];
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(":")) {
        if (!actual[i]) return [];
        try { params[pattern[i].slice(1)] = decodeURIComponent(actual[i]); } catch { return []; }
      } else if (pattern[i] !== actual[i]) return [];
    }
    return [{ page, params, originKey, origin: url.origin, index, literals: pattern.filter(part => !part.startsWith(":")).length }];
  });
  return matches.sort((a, b) => b.literals - a.literals || a.index - b.index)[0] ?? null;
}
/** Two packages conflict when any exact origin is claimed by both. */
export function websiteBridgeOriginsOverlap(a: WebsiteBridgeManifest, b: WebsiteBridgeManifest) {
  const claimed = new Set(Object.values(a.origins));
  return Object.values(b.origins).some(origin => claimed.has(origin));
}
