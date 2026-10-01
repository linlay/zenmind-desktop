import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { parseWebsiteBridgeManifest, WebsiteBridgeError, type WebsiteBridgeResult, type WebsiteBridgeView } from "../../../../shared/website-bridge";
import { builtinForumBridge, type WebsiteBridgePackage } from "./builtin";
import { readWebsiteBridgeArchive } from "./archive";

type Installed = WebsiteBridgePackage & { enabled: boolean; digest: string };
export type WebsiteBridgeStorage = { packagesRoot: string; configRoot: string; legacy?: { packagesRoot: string; configRoot: string } };
const digestOf = (pkg: WebsiteBridgePackage) => createHash("sha256").update(JSON.stringify([pkg.manifest, [...pkg.scripts].sort()])).digest("hex");

/** Immutable package directories plus one atomic catalogue keep failed updates inactive. */
export function createWebsiteBridgeManager(storage?: WebsiteBridgeStorage) {
  let installed: Installed[] = [];
  let failed = false;
  const listeners = new Set<() => void>();
  const catalog = storage && path.join(storage.configRoot, "website-bridges.json");
  const packageDir = (id: string, digest: string) => path.join(storage!.packagesRoot, id, digest);
  function writePackage(pkg: WebsiteBridgePackage) {
    const digest = digestOf(pkg);
    if (!storage) return digest;
    const target = packageDir(pkg.manifest.id, digest);
    if (fs.existsSync(target)) return digest;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), ".staging-" + randomUUID());
    try {
      fs.mkdirSync(temporary);
      fs.writeFileSync(path.join(temporary, "bridge.json"), JSON.stringify(pkg.manifest, null, 2) + "\n");
      for (const [name, source] of pkg.scripts) {
        const file = path.join(temporary, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, source);
      }
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    return digest;
  }
  function persist(items: Installed[]) {
    if (!catalog) return;
    fs.mkdirSync(path.dirname(catalog), { recursive: true });
    const temporary = catalog + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, items: items.map(item => ({ id: item.manifest.id, digest: item.digest, enabled: item.enabled })) }, null, 2) + "\n");
      fs.renameSync(temporary, catalog);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  try {
    // Copy only a validated legacy catalogue. Publish the new catalogue last;
    // interrupted copies remain inactive and the old installation is preserved.
    const legacyCatalog = storage?.legacy && path.join(storage.legacy.configRoot, "website-bridges.json");
    const migrating = !!(catalog && !fs.existsSync(catalog) && legacyCatalog && fs.existsSync(legacyCatalog));
    const sourceCatalog = migrating ? legacyCatalog : catalog;
    const sourceRoot = migrating ? storage!.legacy!.packagesRoot : storage?.packagesRoot;
    if (sourceCatalog && fs.existsSync(sourceCatalog)) {
      if (fs.statSync(sourceCatalog).size > 65536) throw new Error("Invalid catalogue");
      const data = JSON.parse(fs.readFileSync(sourceCatalog, "utf8"));
      if (data.schemaVersion !== 1 || !Array.isArray(data.items) || data.items.length > 50) throw new Error("Invalid catalogue");
      const ids = new Set<string>();
      installed = data.items.map((entry: { id: string; digest: string; enabled: boolean }) => {
        if (typeof entry.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || ids.has(entry.id) || !/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.enabled !== "boolean") throw new Error("Invalid catalogue");
        ids.add(entry.id);
        const directory = path.join(sourceRoot!, entry.id, entry.digest);
        const read = (name: string, limit: number) => { const file = path.join(directory, name); if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > limit) throw new Error("Invalid package"); return fs.readFileSync(file, "utf8"); };
        const manifest = parseWebsiteBridgeManifest(JSON.parse(read("bridge.json", 65536)));
        if (manifest.id !== entry.id) throw new Error("Invalid identity");
        const scripts = new Map(manifest.pages.map(page => [page.script, read(page.script, 512 * 1024)]));
        if (digestOf({ manifest, scripts }) !== entry.digest) throw new Error("Package changed");
        return { manifest, scripts, digest: entry.digest, enabled: entry.enabled };
      });
      if (migrating) {
        for (const item of installed) writePackage(item);
        persist(installed);
      }
    } else {
      const pkg = builtinForumBridge(); installed = [{ ...pkg, enabled: true, digest: writePackage(pkg) }]; persist(installed);
    }
  } catch { installed = []; failed = true; }
  const views = (): WebsiteBridgeView[] => installed.map(({ manifest, enabled }) => ({ ...JSON.parse(JSON.stringify(manifest)), enabled }));
  function changed(next: Installed[]) {
    persist(next); const previous = installed; installed = next;
    for (const listener of listeners) { try { listener(); } catch { /* A failed guest cannot roll back storage. */ } }
    if (storage) for (const item of previous) if (!next.some(value => value.manifest.id === item.manifest.id && value.digest === item.digest)) {
      try { fs.rmSync(packageDir(item.manifest.id, item.digest), { recursive: true, force: true }); } catch { /* Inactive immutable data can be removed later. */ }
    }
  }
  const find = (id: string) => { const item = installed.find(item => item.manifest.id === id); if (!item) throw new WebsiteBridgeError("notFound"); return item; };
  let queue = Promise.resolve();
  function run(operation: () => Promise<Partial<Extract<WebsiteBridgeResult, { ok: true }>>> | Partial<Extract<WebsiteBridgeResult, { ok: true }>>): Promise<WebsiteBridgeResult> {
    const result = queue.then(async (): Promise<WebsiteBridgeResult> => {
      if (failed) return { ok: false, error: "storageFailed" };
      try { const extra = await operation(); return { ok: true, items: views(), ...extra }; }
      catch (error) { return { ok: false, error: error instanceof WebsiteBridgeError ? error.code : "storageFailed" }; }
    });
    queue = result.then(() => undefined); return result;
  }
  return {
    list: (): WebsiteBridgeResult => failed ? { ok: false, error: "storageFailed" } : { ok: true, items: views() },
    runtimePackages: () => installed.filter(item => item.enabled),
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    importFile(file: string, checkOwner: () => void = () => {}, expectedId?: string) { return run(async () => {
      const pkg = await readWebsiteBridgeArchive(file); checkOwner();
      if (expectedId !== undefined && pkg.manifest.id !== expectedId) throw new WebsiteBridgeError("invalidPackage");
      const existing = installed.find(item => item.manifest.id === pkg.manifest.id);
      if (!existing && installed.length >= 50) throw new WebsiteBridgeError("packageTooLarge");
      const enabled = existing?.enabled ?? true;
      if (enabled && installed.some(item => item.enabled && item.manifest.id !== pkg.manifest.id && item.manifest.origin === pkg.manifest.origin)) throw new WebsiteBridgeError("conflict");
      const item = { ...pkg, enabled, digest: writePackage(pkg) };
      changed(existing ? installed.map(old => old === existing ? item : old) : [...installed, item]);
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
      if (failed) throw new WebsiteBridgeError("storageFailed");
      const item = find(id); const zip = new JSZip(); zip.file("bridge.json", JSON.stringify(item.manifest, null, 2));
      for (const [name, source] of item.scripts) zip.file(name, source);
      return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    },
  };
}
