import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseWebsiteBridgeManifest, websiteBridgeFeatureScripts, WEBSITE_BRIDGE_SHARED_SCRIPT, type WebsiteBridgeManifest } from "../../../../shared/website-bridge";

/** `scripts` is keyed by package-relative path: every `features/<name>.js` plus the optional shared helper. */
export type WebsiteBridgePackage = { manifest: WebsiteBridgeManifest; scripts: Map<string, string> };

export class WebsiteBridgeRecoveryError extends Error {}

export type WebsiteBridgeStorage = { packagesRoot: string; configRoot: string };
export const digestOf = (pkg: WebsiteBridgePackage) => createHash("sha256").update(JSON.stringify([pkg.manifest, [...pkg.scripts].sort()])).digest("hex");

function directoryExists(directory: string) {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid package directory");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readPackage(directory: string, id: string, digest: string): WebsiteBridgePackage {
  if (!directoryExists(directory)) throw new Error("Missing package");
  const read = (name: string, limit: number) => {
    let parent = directory;
    for (const part of name.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      if (!directoryExists(parent)) throw new Error("Missing package directory");
    }
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid package");
    return fs.readFileSync(file, "utf8");
  };
  const manifest = parseWebsiteBridgeManifest(JSON.parse(read("bridge.json", 65536)));
  if (manifest.id !== id) throw new Error("Invalid identity");
  const scripts = new Map(websiteBridgeFeatureScripts(manifest).map(name => [name, read(name, 512 * 1024)]));
  if (fs.existsSync(path.join(directory, WEBSITE_BRIDGE_SHARED_SCRIPT))) scripts.set(WEBSITE_BRIDGE_SHARED_SCRIPT, read(WEBSITE_BRIDGE_SHARED_SCRIPT, 512 * 1024));
  const pkg = { manifest, scripts };
  if (digestOf(pkg) !== digest) throw new Error("Package changed");
  return pkg;
}

const backupDir = (storage: WebsiteBridgeStorage, id: string) => path.join(storage.packagesRoot, `.backup-${id}`);
function cleanup(directory: string) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* Retry backup cleanup on the next load/update. */ }
}

/** The catalogue digest is the commit marker, including after a process interruption. */
export function loadPackage(storage: WebsiteBridgeStorage, id: string, digest: string) {
  const target = path.join(storage.packagesRoot, id);
  const backup = backupDir(storage, id);
  let loaded;
  try { loaded = readPackage(target, id, digest); }
  catch (error) {
    if (!directoryExists(backup)) throw error;
    loaded = readPackage(backup, id, digest);
    // Validate the backup before removing an uncommitted replacement.
    if (directoryExists(target)) fs.rmSync(target, { recursive: true });
    fs.renameSync(backup, target);
  }
  cleanup(backup);
  return loaded;
}

/**
 * A package installed under a removed manifest schema stays listed so the user can
 * import its replacement; it is identified only, never verified, migrated or injected.
 */
export function readOutdatedPackage(storage: WebsiteBridgeStorage, id: string) {
  const target = path.join(storage.packagesRoot, id);
  const backup = backupDir(storage, id);
  const legacy = (directory: string) => {
    try {
      if (!directoryExists(directory)) return null;
      const file = path.join(directory, "bridge.json");
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 65536) return null;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value?.schemaVersion !== 1 || value.id !== id) return null;
      return { name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 128) : id,
        version: typeof value.version === "string" && /^\d+\.\d+\.\d+$/.test(value.version) ? value.version : "0.0.0" };
    } catch { return null; }
  };
  // An update interrupted before its catalogue commit leaves the old package in the backup.
  const backedUp = legacy(backup);
  if (backedUp) {
    if (directoryExists(target)) fs.rmSync(target, { recursive: true });
    fs.renameSync(backup, target);
    return backedUp;
  }
  return legacy(target);
}

/** Rename to an absent destination on both Windows and macOS; never replace a populated directory. */
export function savePackage(storage: WebsiteBridgeStorage, pkg: WebsiteBridgePackage, commit: () => void) {
  fs.mkdirSync(storage.packagesRoot, { recursive: true });
  const target = path.join(storage.packagesRoot, pkg.manifest.id);
  const backup = backupDir(storage, pkg.manifest.id);
  const staging = path.join(storage.packagesRoot, `.staging-${randomUUID()}`);
  let backedUp = false;
  let promoted = false;
  try {
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, "bridge.json"), JSON.stringify(pkg.manifest, null, 2) + "\n");
    for (const [name, source] of pkg.scripts) {
      const file = path.join(staging, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    if (directoryExists(backup)) fs.rmSync(backup, { recursive: true });
    if (directoryExists(target)) {
      fs.renameSync(target, backup);
      backedUp = true;
    }
    fs.renameSync(staging, target);
    promoted = true;
    commit();
  } catch (error) {
    try {
      if (promoted) fs.rmSync(target, { recursive: true, force: true });
      if (backedUp) fs.renameSync(backup, target);
    } catch (recoveryError) {
      // Preserve the backup and block further mutations until startup recovery.
      throw new WebsiteBridgeRecoveryError("Package rollback failed", { cause: recoveryError });
    }
    throw error;
  } finally {
    cleanup(staging);
  }
  cleanup(backup);
}
