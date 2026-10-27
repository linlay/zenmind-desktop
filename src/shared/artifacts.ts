import type { EpochMilliseconds } from "./time-contract";

export interface DesktopArtifactIdentity {
  chatId: string;
  runId: string;
  artifactId: string;
}

export const ARTIFACT_CATEGORIES = ["image", "web", "document", "media", "archive", "other"] as const;
export type DesktopArtifactCategory = typeof ARTIFACT_CATEGORIES[number];
export type DesktopArtifactContentState = "ready" | "unresolved" | "ambiguous" | "changed" | "missing";
export type DesktopArtifactSourceState = "active" | "archived" | "unavailable";
export type DesktopArtifactAccessState = "unknown" | "available" | "denied" | "error";

export interface DesktopArtifactRecord extends DesktopArtifactIdentity {
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pushedAt: EpochMilliseconds;
  category: DesktopArtifactCategory;
  favorite: boolean;
  tags: string[];
  contentState: DesktopArtifactContentState;
  sourceState: DesktopArtifactSourceState;
  accessState: DesktopArtifactAccessState;
  chatName: string;
  agentKey: string;
}

export interface DesktopArtifactListInput {
  search?: string;
  offset?: number;
  limit?: number;
  category?: DesktopArtifactCategory;
  favoritesOnly?: boolean;
  tag?: string;
  chatId?: string;
}

export interface DesktopArtifactSyncState {
  phase: "idle" | "syncing" | "complete" | "partial" | "offline";
  completed: number;
  total: number;
  failed: number;
  denied: number;
  lastSyncedAt?: EpochMilliseconds;
}

export interface DesktopArtifactListResult {
  records: DesktopArtifactRecord[];
  total: number;
  tags: string[];
  sync: DesktopArtifactSyncState;
}

export interface DesktopArtifactOrganizeInput extends DesktopArtifactIdentity {
  favorite?: boolean;
  tags?: string[];
}

export interface DesktopArtifactActionInput extends DesktopArtifactIdentity {
  action: "view" | "download" | "reveal" | "open-default" | "open-browser";
}

export type DesktopArtifactActionError = "failed" | "denied" | "changed" | "ambiguous" | "missing" | "archived" | "unavailable" | "unresolved";

export function artifactCategory(mimeType: string): DesktopArtifactCategory {
  const mime = mimeType.toLowerCase().split(";", 1)[0].trim();
  if (mime.startsWith("image/")) return "image";
  if (["text/html", "application/xhtml+xml"].includes(mime)) return "web";
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "media";
  if (/zip|compressed|x-tar|x-7z|x-rar|gzip/u.test(mime)) return "archive";
  if (mime.startsWith("text/") || /pdf|msword|officedocument|ms-excel|ms-powerpoint|opendocument|rtf|json|xml|javascript/u.test(mime)) return "document";
  return "other";
}

export function artifactExternalExtension(name: string, mimeType: string): string | null {
  const mime = mimeType.toLowerCase().split(";", 1)[0].trim();
  const extensions: Record<string, string> = {
    "text/html": ".html", "application/xhtml+xml": ".xhtml",
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/svg+xml": ".svg", "image/avif": ".avif",
    "image/bmp": ".bmp", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico",
  };
  return extensions[mime] ?? /\.(html?|xhtml|png|jpe?g|webp|gif|svg|avif|bmp|ico)$/iu.exec(name)?.[0].toLowerCase() ?? null;
}

export type DesktopArtifactActionResult =
  | { ok: true; agentKey: string; relativePath: string; cancelled?: boolean }
  | { ok: false; error?: DesktopArtifactActionError };
