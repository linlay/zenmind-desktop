import type { DesktopUpdateManifest } from "../../../shared/desktop-updates";
export function verifyUpdateTime(manifest: DesktopUpdateManifest, now: number) {
  if (!Number.isFinite(now) || Date.parse(manifest.publishedAt) > now + 5 * 60_000) throw new Error("clockInvalid");
}
