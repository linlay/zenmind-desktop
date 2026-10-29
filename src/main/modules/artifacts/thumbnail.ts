import { createHash } from "node:crypto";
import type { DesktopArtifactRecord } from "../../../shared/artifacts";
export const ARTIFACT_THUMBNAIL_LIMIT = 3 * 1024 * 1024;
export function canReadArtifactThumbnail(item: DesktopArtifactRecord): boolean {
  return item.sourceState === "active" && item.contentState === "ready" && !!item.runId && item.sizeBytes <= ARTIFACT_THUMBNAIL_LIMIT &&
    ["image/png", "image/jpeg", "image/webp"].includes(item.mimeType.toLowerCase().split(";", 1)[0].trim());
}
export function artifactThumbnailDataUrl(bytes: Buffer, item: DesktopArtifactRecord): string | null {
  if (bytes.length > ARTIFACT_THUMBNAIL_LIMIT || !canReadArtifactThumbnail(item) || bytes.length !== item.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) return null;
  const mime = item.mimeType.toLowerCase().split(";", 1)[0].trim();
  const valid = mime === "image/png" ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" :
    mime === "image/jpeg" ? bytes.subarray(0, 3).toString("hex") === "ffd8ff" :
    bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  return valid ? `data:${mime};base64,${bytes.toString("base64")}` : null;
}
