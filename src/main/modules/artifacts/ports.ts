import type { DesktopArtifactIdentity, DesktopArtifactRecord } from "../../../shared/artifacts";

export interface ArtifactActionLibrary {
  actionContext(identity: DesktopArtifactIdentity): { record: DesktopArtifactRecord | null; isCurrent(): boolean };
  read(identity: DesktopArtifactIdentity, signal: AbortSignal): Promise<Buffer>;
  reportFailure(identity: DesktopArtifactIdentity, code: string): void;
}
