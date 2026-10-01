import { createHash } from "node:crypto";
import { matchWebsiteBridgePage } from "../../../../shared/website-bridge";
import type { WebsiteBridgePackage } from "./builtin";

export function selectWebsiteBridgePage(url: string, packages: WebsiteBridgePackage[]) {
  for (const pkg of packages) {
    const match = matchWebsiteBridgePage(pkg.manifest, url);
    if (match) return { pkg, ...match };
  }
  return null;
}
export function buildWebsiteBridgeScript(url: string, packages: WebsiteBridgePackage[]) {
  const selected = selectWebsiteBridgePage(url, packages);
  const source = selected?.pkg.scripts.get(selected.page.script);
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return "void 0"; }
  const revision = selected ? createHash("sha256").update(JSON.stringify([selected.pkg.manifest, selected.page, source, pathname])).digest("hex") : null;
  const context = { pathname, params: selected?.params ?? {}, revision };
  return `(() => {
    if (window.top !== window || location.href !== ${JSON.stringify(url)}) return;
    const key = '__zenmindWebsiteBridge';
    const previous = globalThis[key];
    if (previous && previous.revision === ${JSON.stringify(revision)} && globalThis.awcp != null) return;
    try { previous?.dispose(); } catch { /* A faulty cleanup must not block the next page bridge. */ }
    ${selected && source !== undefined ? `
    // An existing native AWCP implementation owns its page.
    if (globalThis.awcp !== undefined && globalThis.awcp !== null) return;
    const controller = new AbortController();
    const context = Object.freeze({ ...${JSON.stringify(context)}, signal: controller.signal });
    let cleanup, installed;
    const state = { revision: ${JSON.stringify(revision)}, dispose() {
      controller.abort();
      window.removeEventListener('pagehide', state.dispose);
      try { if (typeof cleanup === 'function') cleanup(); } finally {
        if (globalThis.awcp === installed) delete globalThis.awcp;
        if (globalThis[key] === state) delete globalThis[key];
      }
    } };
    try {
      cleanup = (function(context) {\n${source}\n}).call(window, context);
      installed = globalThis.awcp;
      if (cleanup && typeof cleanup.then === 'function') throw new Error('Bridge setup must be synchronous.');
    } catch (error) { installed = globalThis.awcp; state.dispose(); throw error; }
    globalThis[key] = state;
    window.addEventListener('pagehide', state.dispose, { once: true });
    ` : ""}
  })()`;
}
