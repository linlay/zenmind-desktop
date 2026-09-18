import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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

async function publish(call: SkillPlatformCaller, key: string, archive: Buffer) {
  const boundary = `desktop-skill-${randomUUID()}`;
  const rawBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    archive,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const result = await call(`/api/admin/skills/import?${new URLSearchParams({ key, overwrite: "true" })}`, {
    method: "POST", rawBody, contentType: `multipart/form-data; boundary=${boundary}`
  }) as { kind?: string; skill?: { key?: string } };
  if (result?.kind !== "skill" || result.skill?.key !== key) throw new Error(t("skillInstaller.publicationUnconfirmed"));
}

async function contentDigest(archive: Buffer) {
  const zip = await JSZip.loadAsync(archive);
  const digest = createHash("sha256");
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name];
    digest.update(JSON.stringify([name, entry.dir]));
    if (!entry.dir) digest.update(await entry.async("nodebuffer"));
  }
  return digest.digest("hex");
}

async function remove(call: SkillPlatformCaller, key: string) {
  const response = await call("/api/admin/skills/delete", { method: "POST", body: { key } }) as { deleted?: boolean };
  if (response?.deleted !== true) throw new Error(t("skillInstaller.removalUnconfirmed"));
}

// Serialize local publication and record compensation together. Files under
// skills-center are read-only here: Platform owns every destructive operation.
export function mutateSkillThroughPlatform(key: string, targetDir: string, archive: Buffer | null, commit: () => void) {
  const call = platformCaller;
  const operation = pendingMutation.catch(() => undefined).then(async () => {
    if (!call) throw new Error(t("skillInstaller.platformRequired"));
    if (!key || key === "." || key === ".." || /[\/\\\x00-\x1f]/u.test(key)) throw new Error(t("skillInstaller.invalidId"));
    const previous = fs.existsSync(targetDir) ? await archiveSkillDirectory(targetDir) : null;
    const recoveryRoot = previous ? fs.mkdtempSync(path.join(os.tmpdir(), "desktop-skill-recovery-")) : "";
    const recoveryPath = recoveryRoot ? path.join(recoveryRoot, "previous.zip") : "";
    if (previous) fs.writeFileSync(recoveryPath, previous, { mode: 0o600 });
    try {
      if (archive) await publish(call, key, archive);
      else await remove(call, key);
    } catch (error) {
      // A transport failure may occur after server commit. Never automatically
      // issue an inverse operation when the publication result is uncertain.
      throw new Error(t("skillInstaller.operationUnconfirmed", { recovery: recoveryPath ? t("skillInstaller.recoveryLocation", { path: recoveryPath }) : "", message: String(error) }), { cause: error });
    }
    try {
      commit();
    } catch (error) {
      try {
        if (archive) {
          const current = await archiveSkillDirectory(targetDir);
          if (await contentDigest(current) !== await contentDigest(archive)) {
            throw new Error(t("skillInstaller.changedBeforeRestore"));
          }
        } else if (fs.existsSync(targetDir)) {
          throw new Error(t("skillInstaller.recreatedBeforeRestore"));
        }
        if (previous) await publish(call, key, previous);
        else await remove(call, key);
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
