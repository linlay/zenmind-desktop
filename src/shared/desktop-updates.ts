/** Desktop update feed v1. URLs and local paths stay in main. */
export interface DesktopUpdateConfig {
  enabled: boolean;
  feedUrl: string;
  channel: string;
}
export interface DesktopUpdateArtifact { url: string; size: number; sha256: string }
export interface DesktopUpdateManifest {
  schemaVersion: 1;
  productId: string;
  channel: string;
  version: string;
  publishedAt: string;
  releaseNotes: Record<string, string[]>;
  artifacts: Record<string, DesktopUpdateArtifact>;
}
export type DesktopUpdatePhase = "disabled" | "not-configured" | "idle" | "checking" | "current" | "unavailable" | "available" | "downloading" | "verifying" | "ready" | "installing" | "error";
export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  version?: string;
  releaseNotes?: Record<string, string[]>;
  progress: number;
  autoDownload: boolean;
  canInstall: boolean;
  checkedAt?: string;
  error?: "operationFailed" | "configInvalid" | "activeRuns" | "cleanupFailed" | "updateBusy";
}
export interface DesktopUpdatesApi {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  install(): Promise<DesktopUpdateState>;
  setAutoDownload(enabled: boolean): Promise<DesktopUpdateState>;
  onChanged(listener: (state: DesktopUpdateState) => void): () => void;
}
