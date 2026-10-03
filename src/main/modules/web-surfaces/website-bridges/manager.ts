import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { WebsiteBridgeError, type WebsiteBridgeResult, type WebsiteBridgeView } from "../../../../shared/website-bridge";
import { type WebsiteBridgePackage } from "./builtin";
import { readWebsiteBridgeArchive } from "./archive";
import { digestOf, loadPackage, savePackage, WebsiteBridgeRecoveryError, type WebsiteBridgeStorage } from "./storage";
export type { WebsiteBridgeStorage } from "./storage";

type Installed = WebsiteBridgePackage & { enabled: boolean; digest: string };
/** Stable ID directories with staged replacement and catalogue-based recovery. */
export function createWebsiteBridgeManager(storage?: WebsiteBridgeStorage) {
  let installed: Installed[] = [];
  let failed = false;
  const listeners = new Set<() => void>();
  const catalog = storage && path.join(storage.configRoot, "website-bridges.json");
  function persist(items: Installed[]) {
    if (!catalog) return;
    fs.mkdirSync(path.dirname(catalog), { recursive: true });
    const temporary = catalog + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, items: items.map(item => ({ id: item.manifest.id, digest: item.digest, enabled: item.enabled })) }, null, 2) + "\n");
      fs.renameSync(temporary, catalog);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  let loaded = false;
  // The registry is assembled before desktop-init; read disk on first use after bootstrap.
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      if (catalog && fs.existsSync(catalog)) {
        if (fs.statSync(catalog).size > 65536) throw new Error("Invalid catalogue");
        const data = JSON.parse(fs.readFileSync(catalog, "utf8"));
        if (data.schemaVersion !== 1 || !Array.isArray(data.items) || data.items.length > 50) throw new Error("Invalid catalogue");
        const ids = new Set<string>();
        installed = data.items.map((entry: { id: string; digest: string; enabled: boolean }) => {
          if (typeof entry.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || ids.has(entry.id) || !/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.enabled !== "boolean") throw new Error("Invalid catalogue");
          ids.add(entry.id);
          const pkg = loadPackage(storage!, entry.id, entry.digest);
          return { ...pkg, digest: entry.digest, enabled: entry.enabled };
        });
      }
    } catch { installed = []; failed = true; }
  }
  const views = (): WebsiteBridgeView[] => installed.map(({ manifest, enabled }) => ({ ...JSON.parse(JSON.stringify(manifest)), enabled }));
  function changed(next: Installed[], pkg?: WebsiteBridgePackage) {
    if (storage && pkg) savePackage(storage, pkg, () => persist(next));
    else persist(next);
    const previous = installed; installed = next;
    for (const listener of listeners) { try { listener(); } catch { /* A failed guest cannot roll back storage. */ } }
    if (storage) for (const item of previous) if (!next.some(value => value.manifest.id === item.manifest.id)) {
      try { fs.rmSync(path.join(storage.packagesRoot, item.manifest.id), { recursive: true, force: true }); } catch { /* Inactive package data can be removed later. */ }
    }
  }
  const find = (id: string) => { const item = installed.find(item => item.manifest.id === id); if (!item) throw new WebsiteBridgeError("notFound"); return item; };
  let queue = Promise.resolve();
  function run(operation: () => Promise<Partial<Extract<WebsiteBridgeResult, { ok: true }>>> | Partial<Extract<WebsiteBridgeResult, { ok: true }>>): Promise<WebsiteBridgeResult> {
    const result = queue.then(async (): Promise<WebsiteBridgeResult> => {
      ensureLoaded();
      if (failed) return { ok: false, error: "storageFailed" };
      try { const extra = await operation(); return { ok: true, items: views(), ...extra }; }
      catch (error) {
        if (error instanceof WebsiteBridgeRecoveryError) failed = true;
        return { ok: false, error: error instanceof WebsiteBridgeError ? error.code : "storageFailed" };
      }
    });
    queue = result.then(() => undefined); return result;
  }
  return {
    list: (): WebsiteBridgeResult => { ensureLoaded(); return failed ? { ok: false, error: "storageFailed" } : { ok: true, items: views() }; },
    runtimePackages: () => { ensureLoaded(); return installed.filter(item => item.enabled); },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    importFile(file: string, checkOwner: () => void = () => {}, expectedId?: string) { return run(async () => {
      const pkg = await readWebsiteBridgeArchive(file); checkOwner();
      if (expectedId !== undefined && pkg.manifest.id !== expectedId) throw new WebsiteBridgeError("invalidPackage");
      const existing = installed.find(item => item.manifest.id === pkg.manifest.id);
      if (!existing && installed.length >= 50) throw new WebsiteBridgeError("packageTooLarge");
      const enabled = existing?.enabled ?? true;
      if (enabled && installed.some(item => item.enabled && item.manifest.id !== pkg.manifest.id && item.manifest.origin === pkg.manifest.origin)) throw new WebsiteBridgeError("conflict");
      const item = { ...pkg, enabled, digest: digestOf(pkg) };
      changed(existing ? installed.map(old => old === existing ? item : old) : [...installed, item], pkg);
      return { selectedId: pkg.manifest.id };
    }); },
    setEnabled(id: string, enabled: boolean, checkOwner: () => void = () => {}) { return run(() => {
      checkOwner();
      const item = find(id); if (typeof enabled !== "boolean") throw new WebsiteBridgeError("invalidPackage");
      if (enabled && installed.some(other => other !== item && other.enabled && other.manifest.origin === item.manifest.origin)) throw new WebsiteBridgeError("conflict");
      changed(installed.map(old => old === item ? { ...old, enabled } : old)); return { selectedId: id };
    }); },
    remove(id: string, checkOwner: () => void = () => {}) { return run(() => { checkOwner(); find(id); changed(installed.filter(item => item.manifest.id !== id)); return {}; }); },
    readScript(id: string, script: string) { return run(() => { const source = find(id).scripts.get(script); if (source === undefined) throw new WebsiteBridgeError("notFound"); return { script: source }; }); },
    async exportBytes(id: string) {
      ensureLoaded();
      if (failed) throw new WebsiteBridgeError("storageFailed");
      const item = find(id); const zip = new JSZip(); zip.file("bridge.json", JSON.stringify(item.manifest, null, 2));
      for (const [name, source] of item.scripts) zip.file(name, source);
      return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    },
  };
}
