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
  action: "view" | "download";
}

export type DesktopArtifactActionResult =
  | { ok: true; agentKey: string; relativePath: string; cancelled?: boolean }
  | { ok: false };
