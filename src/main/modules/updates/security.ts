import type { DesktopUpdateManifest } from "../../../shared/desktop-updates";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
export function verifyUpdateTime(manifest: DesktopUpdateManifest, now: number) {
  if (!Number.isFinite(now) || Date.parse(manifest.publishedAt) > now + 5 * 60_000) throw new Error("clockInvalid");
  if (Date.parse(manifest.expiresAt) <= now) throw new Error("manifestExpired");
}
/** One main-process update operation owns this atomic, fail-closed state. */
export function acceptUpdateSequence(root: string, manifest: DesktopUpdateManifest, digest: string) {
  const scope = createHash("sha256").update(JSON.stringify([manifest.productId, manifest.channel])).digest("hex");
  const file = path.join(root, `${scope}.json`);
  let previous: { sequence: number; digest: string } | undefined;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid state");
    previous = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!previous || !Number.isSafeInteger(previous.sequence) || previous.sequence < 1 || !/^[a-f0-9]{64}$/.test(previous.digest)) throw new Error("Invalid state");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("securityStateInvalid");
  }
  if (previous && (manifest.releaseSequence < previous.sequence || (manifest.releaseSequence === previous.sequence && digest !== previous.digest))) throw new Error("manifestReplay");
  if (previous?.sequence === manifest.releaseSequence) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ sequence: manifest.releaseSequence, digest })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } catch { throw new Error("securityStateInvalid"); }
  finally { try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the fail-closed state error. */ } }
}
