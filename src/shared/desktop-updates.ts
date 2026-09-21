/** Desktop update feed v1. URLs and local paths stay in main. */
export interface DesktopUpdateConfig {
  enabled: boolean;
  feedUrl: string;
}
export interface DesktopUpdateArtifact { url: string; size: number; sha256: string }
export interface DesktopUpdateManifest {
  schemaVersion: 1;
  productId: string;
  version: string;
  publishedAt: string;
  releaseNotes: Record<string, string[]>;
  artifacts: Record<string, DesktopUpdateArtifact>;
}
export type DesktopUpdatePhase = "disabled" | "not-configured" | "idle" | "checking" | "current" | "unavailable" | "available" | "downloading" | "verifying" | "ready" | "installing" | "error";
export type DesktopTestUpdateInput = { manifest: unknown } | { version: string; url: string; size: number; sha256: string };
export interface DesktopUpdateState {
  source?: "official" | "test";
  phase: DesktopUpdatePhase;
  currentVersion: string;
  version?: string;
  releaseNotes?: Record<string, string[]>;
  progress: number;
  autoDownload: boolean;
  canInstall: boolean;
  checkedAt?: string;
  error?: "checkFailed" | "downloadFailed" | "verificationFailed" | "installFailed" | "operationFailed" | "configInvalid" | "activeRuns" | "cleanupFailed" | "updateBusy";
}
export interface DesktopUpdatesApi {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  loadTest(input: DesktopTestUpdateInput): Promise<DesktopUpdateState>;
  clearTest(): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  install(): Promise<DesktopUpdateState>;
  setAutoDownload(enabled: boolean): Promise<DesktopUpdateState>;
  onChanged(listener: (state: DesktopUpdateState) => void): () => void;
}
