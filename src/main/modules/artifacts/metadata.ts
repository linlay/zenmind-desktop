import { artifactCategory, type DesktopArtifactRecord, type DesktopArtifactIdentity } from "../../../shared/artifacts";
import { isAgentPlatformEpochMilliseconds } from "../../../shared/time-contract";
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function cleanText(value: unknown, max = 256): string {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : "";
}
export function validIdentity(value: unknown): value is DesktopArtifactIdentity {
  const data = object(value);
  return [data.chatId, data.artifactId].every(v => !!cleanText(v) && v === cleanText(v) && !/[/\\]/u.test(v as string)) &&
    typeof data.runId === "string" && data.runId === cleanText(data.runId) && !/[/\\]/u.test(data.runId);
}
export function parseArtifactMetadata(value: unknown, allowLegacy = false): DesktopArtifactRecord | null {
  const data = object(value);
  const chatId = cleanText(data.chatId), runId = cleanText(data.runId), artifactId = cleanText(data.artifactId);
  const name = cleanText(data.name, 1024), mimeType = cleanText(data.mimeType);
  const pushedAt = data.publishedAt ?? data.pushedAt;
  if (!validIdentity({ chatId, runId, artifactId }) || (!allowLegacy && !runId) || !name ||
    !isAgentPlatformEpochMilliseconds(pushedAt) || !Number.isSafeInteger(data.sizeBytes) || Number(data.sizeBytes) < 0)
    return null;
  return { chatId, runId, artifactId, name, mimeType, sizeBytes: Number(data.sizeBytes), sha256: cleanText(data.sha256), pushedAt,
    category: artifactCategory(mimeType), favorite: false, tags: [], contentState: runId ? "ready" : "unresolved",
    sourceState: "active", accessState: "unknown", agentKey: "", chatName: "", folderId: null, displayName: "" };
}
