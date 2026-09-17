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
