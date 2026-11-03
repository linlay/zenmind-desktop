import type { SurfaceIdentity } from "../../shared/surface-identity";

export function formatWebviewDebugSurfaceLabel(surfaceIdentity?: SurfaceIdentity) {
  const surfaceId = surfaceIdentity?.surfaceId.trim() || "";
  const surfaceRole = surfaceIdentity?.surfaceRole.trim() || "";
  const parentSurfaceId = surfaceIdentity?.parentSurfaceId?.trim() || "";
  const parentPrefix = parentSurfaceId ? `${parentSurfaceId} › ` : "";

  if (surfaceId && surfaceId === surfaceRole) {
    return `${parentPrefix}surface: ${surfaceId}`;
  }
  if (surfaceRole && surfaceId) {
    return `${parentPrefix}role: ${surfaceRole} · surfaceId: ${surfaceId}`;
  }
  if (surfaceRole) {
    return `${parentPrefix}role: ${surfaceRole}`;
  }
  return surfaceId ? `${parentPrefix}surfaceId: ${surfaceId}` : "";
}

export function buildWebviewDebugClipboardText(
  url: string,
  surfaceIdentity?: SurfaceIdentity,
) {
  const lines = [formatWebviewDebugSurfaceLabel(surfaceIdentity)].filter(Boolean);
  if (url) lines.push(`url: ${url}`);
  return lines.join("\n");
}
