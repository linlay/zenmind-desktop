import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { t } from "../../support/i18n/main-i18n";

export type SkillPlatformCaller = (targetPath: string, options?: {
  method?: string; body?: unknown; rawBody?: Uint8Array; contentType?: string;
}) => Promise<unknown>;

let platformCaller: SkillPlatformCaller | null = null;
let pendingMutation: Promise<unknown> = Promise.resolve();

export function configureSkillInstallerPlatformCaller(caller: SkillPlatformCaller | null) {
  platformCaller = caller;
}

// Only regular files/directories may cross the import boundary. In particular,
// do not follow local symlinks (including a symlink supplied as the root).
export async function archiveSkillDirectory(root: string): Promise<Buffer> {
  const zip = new JSZip();
  let size = 0;
  let entries = 0;
  function visit(current: string, relative: string) {
    if (++entries > 4097) throw new Error(t("skillInstaller.archiveLimit"));
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(t("skillInstaller.unsafeSymlink"));
    if (stat.isDirectory()) {
      if (relative) zip.folder(relative);
      for (const name of fs.readdirSync(current)) {
        if (name.includes("\\") || /[\x00-\x1f]/u.test(name)) throw new Error(t("skillInstaller.invalidFilename"));
        visit(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(t("skillInstaller.unsupportedFileType"));
    size += stat.size;
    if (stat.size > 32 * 1024 * 1024 || size > 256 * 1024 * 1024) throw new Error(t("skillInstaller.archiveLimit"));
    zip.file(relative, fs.readFileSync(current), { unixPermissions: stat.mode & 0o777 });
  }
  visit(root, "");
  const archive = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
  if (archive.length > 32 * 1024 * 1024) throw new Error(t("skillInstaller.archiveLimit"));
  return archive;
}

type SkillSnapshot = { key: string; exists: boolean; revision: string; archiveBase64?: string };

async function transact(call: SkillPlatformCaller, key: string, operation: "snapshot" | "replace" | "delete", expectedRevision?: string, archive?: Buffer): Promise<SkillSnapshot> {
  const result = await call("/api/admin/skills/transaction", {
    method: "POST", body: { key, operation, expectedRevision, ...(archive ? { archiveBase64: archive.toString("base64") } : {}) }
  }) as SkillSnapshot;
  if (result?.key !== key || typeof result.exists !== "boolean" ||
      (result.exists ? !/^[a-f0-9]{64}$/.test(result.revision ?? "") : result.revision !== "missing") ||
      (operation === "replace" && !result.exists) || (operation === "delete" && result.exists)) {
    throw new Error(t("skillInstaller.publicationUnconfirmed"));
  }
  return result;
}

// Serialize local publication and record compensation together. Files under
// Platform owns both the consistent snapshot and the conditional mutation.
// No filesystem read of a live skill occurs in Desktop, including compensation.
export function mutateSkillThroughPlatform(key: string, _targetDir: string, archive: Buffer | null, commit: () => void) {
  const call = platformCaller;
  const operation = pendingMutation.catch(() => undefined).then(async () => {
    if (!call) throw new Error(t("skillInstaller.platformRequired"));
    if (!key || key === "." || key === ".." || /[\/\\\x00-\x1f]/u.test(key)) throw new Error(t("skillInstaller.invalidId"));
    const snapshot = await transact(call, key, "snapshot");
    if (snapshot.exists && (typeof snapshot.archiveBase64 !== "string" || snapshot.archiveBase64.length > 44 * 1024 * 1024)) {
      throw new Error(t("skillInstaller.publicationUnconfirmed"));
    }
    const previous = snapshot.exists ? Buffer.from(snapshot.archiveBase64!, "base64") : null;
    if (previous && (previous.length === 0 || previous.length > 32 * 1024 * 1024)) throw new Error(t("skillInstaller.archiveLimit"));
    if (previous && previous.toString("base64") !== snapshot.archiveBase64) throw new Error(t("skillInstaller.publicationUnconfirmed"));
    const recoveryRoot = previous ? fs.mkdtempSync(path.join(os.tmpdir(), "desktop-skill-recovery-")) : "";
    const recoveryPath = recoveryRoot ? path.join(recoveryRoot, "previous.zip") : "";
    if (previous) fs.writeFileSync(recoveryPath, previous, { mode: 0o600 });
    let published: SkillSnapshot;
    try {
      published = await transact(call, key, archive ? "replace" : "delete", snapshot.revision, archive ?? undefined);
    } catch (error) {
      // A transport failure may occur after server commit. Never automatically
      // issue an inverse operation when the publication result is uncertain.
      throw new Error(t("skillInstaller.operationUnconfirmed", { recovery: recoveryPath ? t("skillInstaller.recoveryLocation", { path: recoveryPath }) : "", message: String(error) }), { cause: error });
    }
    try {
      commit();
    } catch (error) {
      try {
        // Compare and restore happen under one Platform transaction lock.
        // A later edit/recreation is rejected by the server with 409.
        await transact(call, key, previous ? "replace" : "delete", published.revision, previous ?? undefined);
      } catch (rollbackError) {
        throw new Error(t("skillInstaller.compensationFailed", { message: String(error), rollback: String(rollbackError), recovery: recoveryPath ? t("skillInstaller.recoveryLocation", { path: recoveryPath }) : "" }), { cause: error });
      }
      if (recoveryRoot) {
        try { fs.rmSync(recoveryRoot, { recursive: true, force: true }); } catch { /* Preserve original record error. */ }
      }
      throw error;
    }
    if (recoveryRoot) {
      try { fs.rmSync(recoveryRoot, { recursive: true, force: true }); } catch { /* Committed; cleanup is best effort. */ }
    }
  });
  pendingMutation = operation;
  return operation;
}
