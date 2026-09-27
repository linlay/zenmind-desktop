import type { EpochMilliseconds } from "./time-contract";

export interface DesktopArtifactRecord {
  chatId: string;
  artifactId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pushedAt: EpochMilliseconds;
}

export interface DesktopArtifactListInput {
  search?: string;
  offset?: number;
  limit?: number;
}

export interface DesktopArtifactListResult {
  records: DesktopArtifactRecord[];
  total: number;
}

export interface DesktopArtifactActionInput {
  chatId: string;
  artifactId: string;
  action: "view" | "download" | "reveal" | "open-default" | "open-browser";
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
  | { ok: false };
