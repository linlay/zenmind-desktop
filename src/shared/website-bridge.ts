/**
 * Page recognition conditions. Every value is an exact match; a rule needs all of its keys, a page needs any one rule.
 * `hashQuery` reads the query after `?` in the URL hash, `title` is `document.title`, and `text` is the
 * whitespace-collapsed own text of one visible element.
 */
export type WebsiteBridgeMatchRule = { hashQuery?: Record<string, string>; title?: string; text?: string };
/** One origin is one site system: its name and description tell callers which implementation it uses. */
export type WebsiteBridgeOrigin = { url: string; name?: string; description?: string };
/**
 * One page is one script, `pages/<id>.js`. `shared` lists `shared/<name>.js` modules loaded before it, in order;
 * a `<originKey>/<name>` module belongs to that origin's system and only serves its pages.
 */
export type WebsiteBridgePage = {
  origin: string; path: string; name?: string; description?: string; match?: WebsiteBridgeMatchRule[]; shared?: string[];
};
export type WebsiteBridgeManifest = {
  schemaVersion: 2;
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Stable key -> exact origin. Hosts are declared here and nowhere else in a package. */
  origins: Record<string, WebsiteBridgeOrigin>;
  /** Page ID -> rule. `origin` is a key of `origins`; `path` is root-relative. */
  pages: Record<string, WebsiteBridgePage>;
};
/** `outdated` marks an installed package from a removed manifest layout; it is never injected. */
export type WebsiteBridgeView = WebsiteBridgeManifest & { enabled: boolean; outdated?: true };
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
export const websiteBridgePageScript = (id: string) => `pages/${id}.js`;
export const websiteBridgeSharedScript = (name: string) => `shared/${name}.js`;
/** The scripts one page loads, in load order: its shared modules, then its own script. */
export const websiteBridgePageScripts = (manifest: WebsiteBridgeManifest, id: string) =>
  [...(manifest.pages[id]?.shared ?? []).map(websiteBridgeSharedScript), websiteBridgePageScript(id)];
/** Every script a package ships: each page script and each referenced shared module, nothing else. */
export const websiteBridgeScripts = (manifest: WebsiteBridgeManifest) =>
  [...new Set(Object.keys(manifest.pages).flatMap(id => websiteBridgePageScripts(manifest, id)))].sort();
export const websiteBridgeOriginUrls = (manifest: WebsiteBridgeManifest) =>
  Object.fromEntries(Object.entries(manifest.origins).map(([key, origin]) => [key, origin.url]));
const slug = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// Match values are compared after collapsing page whitespace, so they must already be in that form.
const exactText = (value: unknown, max: number): value is string => typeof value === "string" && !!value && value.length <= max && value === value.replace(/\s+/g, " ").trim();
const optionalText = (value: unknown, max: number) => value === undefined || (typeof value === "string" && !!value.trim() && value.length <= max);

function parseMatch(input: unknown): WebsiteBridgeMatchRule[] | null {
  if (!Array.isArray(input) || !input.length || input.length > 20) return null;
  const rules: WebsiteBridgeMatchRule[] = [];
  for (const raw of input) {
    if (!record(raw)) return null;
    const keys = Object.keys(raw);
    if (!keys.length || keys.some(key => !["hashQuery", "title", "text"].includes(key))) return null;
    const rule: WebsiteBridgeMatchRule = {};
    if (raw.hashQuery !== undefined) {
      if (!record(raw.hashQuery)) return null;
      const entries = Object.entries(raw.hashQuery);
      if (!entries.length || entries.length > 10 || entries.some(([key, value]) => !key || key.length > 100 || /[\s&=#?]/.test(key) ||
          typeof value !== "string" || !value || value.length > 1024)) return null;
      rule.hashQuery = Object.fromEntries(entries) as Record<string, string>;
    }
    if (raw.title !== undefined) { if (!exactText(raw.title, 256)) return null; rule.title = raw.title; }
    if (raw.text !== undefined) { if (!exactText(raw.text, 256)) return null; rule.text = raw.text; }
    rules.push(rule);
  }
  return rules;
}

export function parseWebsiteBridgeManifest(input: unknown): WebsiteBridgeManifest {
  const invalid = () => { throw new WebsiteBridgeError("invalidPackage"); };
  if (!record(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 2 || !slug(value.id, 80) ||
      typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 || typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 4096)) ||
      !record(value.origins) || !record(value.pages)) return invalid();
  bridgeResourcePath(value.id);
  const keys = Object.keys(value.origins);
  if (!keys.length || keys.length > 20) return invalid();
  const origins: Record<string, WebsiteBridgeOrigin> = {};
  for (const key of keys) {
    // A bare string is the URL alone; the object form also names the site system.
    const raw = value.origins[key];
    const entry = typeof raw === "string" ? { url: raw } : raw;
    if (!slug(key, 40) || !record(entry) || typeof entry.url !== "string" || Object.keys(entry).some(name => !["url", "name", "description"].includes(name)) ||
        !optionalText(entry.name, 128) || !optionalText(entry.description, 1024)) return invalid();
    let origin: URL;
    try { origin = new URL(entry.url); } catch { return invalid(); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
        Object.values(origins).some(other => other.url === origin.origin)) return invalid();
    origins[key] = { url: origin.origin, ...(entry.name ? { name: (entry.name as string).trim() } : {}), ...(entry.description ? { description: entry.description as string } : {}) };
  }
  const ids = Object.keys(value.pages);
  if (!ids.length || ids.length > 100) return invalid();
  const groups = new Map<string, { path: string; unconditional: boolean }>();
  const pages: Record<string, WebsiteBridgePage> = {};
  for (const id of ids) {
    const page = value.pages[id];
    if (!slug(id, 80) || !record(page) || Object.keys(page).some(name => !["origin", "path", "name", "description", "match", "shared"].includes(name)) ||
        typeof page.path !== "string" || page.path.length > 1024 || !page.path.startsWith("/") || /[?#\\*]/.test(page.path) ||
        !optionalText(page.name, 128) || !optionalText(page.description, 4096)) return invalid();
    // A single-origin site may omit the key; multi-origin pages must name theirs.
    const originKey = page.origin === undefined && keys.length === 1 ? keys[0] : page.origin;
    if (typeof originKey !== "string" || !Object.hasOwn(origins, originKey)) return invalid();
    const normalized = page.path === "/" ? "/" : page.path.replace(/\/$/, "");
    const names = new Set<string>();
    for (const segment of normalized.slice(1).split("/")) {
      if (segment.startsWith(":")) { if (!/^:[a-zA-Z][a-zA-Z0-9]*$/.test(segment) || names.has(segment)) return invalid(); names.add(segment); }
      else if (segment.includes(":") || segment === "." || segment === ".." || (!segment && normalized !== "/")) return invalid();
    }
    const match = page.match === undefined ? undefined : parseMatch(page.match);
    if (match === null) return invalid();
    // Pages sharing a URL shape are one candidate group: one exact path, and at most one page without `match` as its fallback.
    const shape = originKey + " " + normalized.replace(/:[a-zA-Z][a-zA-Z0-9]*/g, ":param");
    const group = groups.get(shape);
    if (group && (group.path !== normalized || (group.unconditional && !match))) return invalid();
    groups.set(shape, { path: normalized, unconditional: !!group?.unconditional || !match });
    let shared: string[] | undefined;
    if (page.shared !== undefined) {
      if (!Array.isArray(page.shared) || page.shared.length > 32 || new Set(page.shared).size !== page.shared.length) return invalid();
      for (const name of page.shared) {
        // `core` serves every system; `portal/form` serves only pages on the `portal` origin.
        const parts = typeof name === "string" ? name.split("/") : [];
        if (!(parts.length === 1 && slug(parts[0], 80)) && !(parts.length === 2 && parts[0] === originKey && slug(parts[1], 80))) return invalid();
      }
      if (page.shared.length) shared = [...page.shared as string[]];
    }
    pages[id] = { origin: originKey, path: normalized, ...(page.name ? { name: (page.name as string).trim() } : {}),
      ...(page.description ? { description: page.description as string } : {}), ...(match ? { match } : {}), ...(shared ? { shared } : {}) };
  }
  return { schemaVersion: 2, id: value.id, name: value.name.trim(), version: value.version, ...(value.description ? { description: value.description } : {}), origins, pages };
}

/**
 * The host selects candidates by top-level origin and pathname only; query, hash and API URLs do not take part.
 * All pages of the most specific matching URL shape are returned; the page runtime picks one by `match`.
 */
export function matchWebsiteBridgePage(manifest: WebsiteBridgeManifest, rawUrl: string) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.username || url.password) return null;
  const originKey = Object.keys(manifest.origins).find(key => manifest.origins[key].url === url.origin);
  if (originKey === undefined) return null;
  const actual = (url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "")).split("/");
  const matches = Object.entries(manifest.pages).flatMap(([id, page], index) => {
    if (page.origin !== originKey) return [];
    const pattern = page.path.split("/"); const params: Record<string, string> = {};
    if (pattern.length !== actual.length) return [];
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(":")) {
        if (!actual[i]) return [];
        try { params[pattern[i].slice(1)] = decodeURIComponent(actual[i]); } catch { return []; }
      } else if (pattern[i] !== actual[i]) return [];
    }
    return [{ id, page, params, index, literals: pattern.filter(part => !part.startsWith(":")).length }];
  });
  const best = matches.sort((a, b) => b.literals - a.literals || a.index - b.index)[0];
  if (!best) return null;
  return { pages: matches.filter(item => item.page.path === best.page.path).sort((a, b) => a.index - b.index).map(({ id, page }) => ({ id, ...page })),
    params: best.params, originKey, origin: url.origin };
}
/** Two packages conflict when any exact origin is claimed by both. */
export function websiteBridgeOriginsOverlap(a: WebsiteBridgeManifest, b: WebsiteBridgeManifest) {
  const claimed = new Set(Object.values(a.origins).map(origin => origin.url));
  return Object.values(b.origins).some(origin => claimed.has(origin.url));
}
