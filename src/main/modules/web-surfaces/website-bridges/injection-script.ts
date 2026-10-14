import { createHash } from "node:crypto";
import { matchWebsiteBridgePage, websiteBridgeOriginUrls, websiteBridgePageScript, websiteBridgeSharedScript, type WebsiteBridgeManifest } from "../../../../shared/website-bridge";
import { installWebsiteBridgeRuntime, type WebsiteBridgeRuntimeConfig } from "./page-runtime";
import type { WebsiteBridgePackage } from "./storage";

export function selectWebsiteBridgePage(url: string, packages: WebsiteBridgePackage[]) {
  for (const pkg of packages) {
    const match = matchWebsiteBridgePage(pkg.manifest, url);
    if (match) return { pkg, ...match };
  }
  return null;
}
// Package scripts are function bodies receiving `context`; they never see a module system.
const body = (source: string) => `function(context) {\n${source}\n}`;
/** Names every origin as a separate site system; the current origin also carries its implementation notes. */
function originsGuide(manifest: WebsiteBridgeManifest, current: string) {
  const entries = Object.entries(manifest.origins);
  if (entries.length < 2 && !entries.some(([, origin]) => origin.name || origin.description)) return undefined;
  return [`Origins by key (each origin is a separate site system): ${entries.map(([key, origin]) => `${key}=${origin.url}${origin.name ? ` (${origin.name})` : ""}`).join(", ")}. This page: ${current}.`,
    manifest.origins[current].description].filter(Boolean).join("\n");
}
export function buildWebsiteBridgeScript(url: string, packages: WebsiteBridgePackage[]) {
  const selected = selectWebsiteBridgePage(url, packages);
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return "void 0"; }
  let install = "";
  let revision: string | null = null;
  if (selected) {
    const { manifest, scripts } = selected.pkg;
    const moduleNames = [...new Set(selected.pages.flatMap(page => page.shared ?? []))];
    const modules = moduleNames.map(name => ({ name, source: scripts.get(websiteBridgeSharedScript(name)) }));
    const pages = selected.pages.map(page => ({ id: page.id, source: scripts.get(websiteBridgePageScript(page.id)) }));
    revision = createHash("sha256").update(JSON.stringify([manifest, selected.pages, modules, pages, pathname])).digest("hex");
    if ([...modules, ...pages].every(script => script.source !== undefined)) {
      const config: WebsiteBridgeRuntimeConfig = {
        id: manifest.id, version: manifest.version,
        site: { name: manifest.name, description: [manifest.description, originsGuide(manifest, selected.originKey)].filter(Boolean).join("\n\n") },
        // The page world resolves `{ origin: key, path }` results with this map; packages hold no hosts elsewhere.
        origins: websiteBridgeOriginUrls(manifest), originKey: selected.originKey, origin: selected.origin, pathname, params: selected.params, revision,
        pages: selected.pages.map(page => ({ id: page.id, ...(page.name ? { name: page.name } : {}), ...(page.description ? { description: page.description } : {}),
          ...(page.match ? { match: page.match } : {}), shared: page.shared ?? [] })),
      };
      install = `
    // An existing native AWCP implementation owns its page.
    if (globalThis.awcp !== undefined && globalThis.awcp !== null) return;
    (${installWebsiteBridgeRuntime.toString()})(${JSON.stringify(config)}, [${
      modules.map(module => `{ name: ${JSON.stringify(module.name)}, setup: ${body(module.source!)} }`).join(", ")}], [${
      pages.map(page => `{ id: ${JSON.stringify(page.id)}, setup: ${body(page.source!)} }`).join(", ")}]);`;
    }
  }
  return `(() => {
    if (window.top !== window || location.href !== ${JSON.stringify(url)}) return;
    const previous = globalThis.__zenmindWebsiteBridge;
    if (previous && previous.revision === ${JSON.stringify(revision)} && globalThis.awcp != null) return;
    try { previous?.dispose(); } catch { /* A faulty cleanup must not block the next page bridge. */ }${install}
  })()`;
}
