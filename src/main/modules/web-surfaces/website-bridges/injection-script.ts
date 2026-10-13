import { createHash } from "node:crypto";
import { matchWebsiteBridgePage, websiteBridgeFeatureScript, WEBSITE_BRIDGE_SHARED_SCRIPT } from "../../../../shared/website-bridge";
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
export function buildWebsiteBridgeScript(url: string, packages: WebsiteBridgePackage[]) {
  const selected = selectWebsiteBridgePage(url, packages);
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return "void 0"; }
  let install = "";
  let revision: string | null = null;
  if (selected) {
    const { manifest, scripts } = selected.pkg;
    const shared = scripts.get(WEBSITE_BRIDGE_SHARED_SCRIPT);
    const features = selected.page.features.map(name => ({ name, source: scripts.get(websiteBridgeFeatureScript(name)) }));
    revision = createHash("sha256").update(JSON.stringify([manifest, selected.page, shared, features, pathname])).digest("hex");
    if (features.every(feature => feature.source !== undefined)) {
      const origins = Object.entries(manifest.origins);
      const config: WebsiteBridgeRuntimeConfig = {
        id: manifest.id, version: manifest.version,
        site: { name: manifest.name, description: [
          manifest.description, selected.page.description,
          // The page world resolves `{ origin: key, path }` results with this map; packages hold no hosts elsewhere.
          origins.length > 1 ? `Origins by key: ${origins.map(([key, origin]) => `${key}=${origin}`).join(", ")}. This page: ${selected.originKey}.` : undefined,
        ].filter(Boolean).join("\n\n") || manifest.name },
        origins: manifest.origins, originKey: selected.originKey, origin: selected.origin, pathname, params: selected.params, revision,
      };
      install = `
    // An existing native AWCP implementation owns its page.
    if (globalThis.awcp !== undefined && globalThis.awcp !== null) return;
    (${installWebsiteBridgeRuntime.toString()})(${JSON.stringify(config)}, ${shared === undefined ? "null" : body(shared)}, [${
      features.map(feature => `{ name: ${JSON.stringify(feature.name)}, setup: ${body(feature.source!)} }`).join(", ")}]);`;
    }
  }
  return `(() => {
    if (window.top !== window || location.href !== ${JSON.stringify(url)}) return;
    const previous = globalThis.__zenmindWebsiteBridge;
    if (previous && previous.revision === ${JSON.stringify(revision)} && globalThis.awcp != null) return;
    try { previous?.dispose(); } catch { /* A faulty cleanup must not block the next page bridge. */ }${install}
  })()`;
}
