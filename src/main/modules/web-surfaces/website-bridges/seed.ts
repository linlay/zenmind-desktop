import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import { parseWebsiteBridgeManifest, WEBSITE_BRIDGE_LIMITS as limits } from "../../../../shared/website-bridge";
import type { WebsiteBridgePackage } from "./builtin";
import { digestOf, savePackage, type WebsiteBridgeStorage } from "./storage";

/** Reads inert source files only; seed scripts are never executed in Main. */
function readSeed(root: string, id: string): WebsiteBridgePackage {
  const read = (relative: string, limit: number) => {
    let current = root;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("Website bridge seed cannot contain symbolic links.");
    }
    const stat = fs.statSync(current);
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid website bridge seed file.");
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(current));
  };
  const manifest = parseWebsiteBridgeManifest(JSON.parse(read(`${id}/bridge.json`, limits.manifestBytes)));
  if (manifest.id !== id) throw new Error("Website bridge seed identity mismatch.");
  const scripts = new Map<string, string>();
  let size = 0;
  for (const page of manifest.pages) {
    if (scripts.has(page.script)) continue;
    const source = read(`${id}/${page.script}`, limits.fileBytes);
    size += Buffer.byteLength(source);
    if (size > limits.expandedBytes) throw new Error("Website bridge seed is too large.");
    new Script(`(function(context) {\n${source}\n})`);
    scripts.set(page.script, source);
  }
  return { manifest, scripts };
}

/** First-install only. An existing catalogue (including an empty one) belongs to the user. */
export function initializeWebsiteBridgeSeeds(storage: WebsiteBridgeStorage, root: string, ids: unknown) {
  const catalog = path.join(storage.configRoot, "website-bridges.json");
  if (fs.existsSync(catalog)) return "preserved" as const;
  if (!Array.isArray(ids) || ids.length > 50 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== "string" || id.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) {
    throw new Error("Invalid website bridge seed selection.");
  }
  if (ids.length) {
    // Check both staging ancestors as well as all per-package path components.
    for (const directory of [path.dirname(root), root]) {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid website bridge staging directory.");
    }
  }
  const packages = ids.map(id => readSeed(root, id));
  if (new Set(packages.map(pkg => pkg.manifest.origin)).size !== packages.length) throw new Error("Conflicting website bridge seed origins.");
  for (const id of ids) {
    if (fs.existsSync(path.join(storage.packagesRoot, id))) throw new Error("Website bridge seed would overwrite existing package data.");
  }
  const created: string[] = [];
  const temporary = catalog + `.${randomUUID()}.tmp`;
  try {
    for (const pkg of packages) {
      savePackage(storage, pkg, () => {});
      created.push(path.join(storage.packagesRoot, pkg.manifest.id));
    }
    fs.mkdirSync(storage.configRoot, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, items: packages.map(pkg => ({ id: pkg.manifest.id, digest: digestOf(pkg), enabled: true })) }, null, 2) + "\n");
    fs.renameSync(temporary, catalog);
  } catch (error) {
    for (const directory of created) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
  return "applied" as const;
}
