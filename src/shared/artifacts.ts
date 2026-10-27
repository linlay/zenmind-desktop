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
  folderId: string | null;
  displayName: string;
}

export interface DesktopArtifactFolder {
  id: string;
  parentId: string | null;
  name: string;
  directCount: number;
  totalCount: number;
  childCount: number;
}

export type DesktopArtifactFolderInput =
  | { action: "create"; parentId: string | null; name: string }
  | { action: "rename"; id: string; name: string }
  | { action: "delete"; id: string };

export interface DesktopArtifactBatchInput {
  items: DesktopArtifactIdentity[];
  folderId?: string | null;
  favorite?: boolean;
}

export type DesktopArtifactMutationResult = { ok: true } | {
  ok: false;
  error: "invalid_name" | "duplicate_name" | "folder_missing" | "folder_not_empty" | "items_missing" | "invalid_request" | "folder_depth";
};

export interface DesktopArtifactListInput {
  search?: string;
  offset?: number;
  limit?: number;
  category?: DesktopArtifactCategory;
  favoritesOnly?: boolean;
  tag?: string;
  chatId?: string;
  folderId?: string | null;
  recent?: boolean;
  sort?: "date" | "name" | "type";
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
  folders: DesktopArtifactFolder[];
  counts: { all: number; starred: number; unfiled: number; recent: number };
  categories: Partial<Record<DesktopArtifactCategory, number>>;
}

export interface DesktopArtifactOrganizeInput extends DesktopArtifactIdentity {
  favorite?: boolean;
  tags?: string[];
  displayName?: string;
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
