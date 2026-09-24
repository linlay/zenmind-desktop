/** Desktop update feed v2. URLs and local paths stay in main. */
export interface DesktopUpdateConfig {
  enabled: boolean;
  feedUrl: string;
}
export interface DesktopUpdateArtifact { url: string; size: number; sha256: string }
export interface DesktopUpdateManifest {
  schemaVersion: 2;
  keyId: string;
  channel: string;
  productId: string;
  version: string;
  publishedAt: string;
  releaseNotes: Record<string, string[]>;
  artifacts: Record<string, DesktopUpdateArtifact>;
}
/** Existing macOS feed; authenticity is enforced by the native Apple updater. */
export type DesktopNativeUpdateManifest = Omit<DesktopUpdateManifest, "schemaVersion" | "keyId" | "channel"> & { schemaVersion: 1 };
export type DesktopPlatformUpdateManifest = DesktopUpdateManifest | DesktopNativeUpdateManifest;
export type DesktopUpdatePhase = "disabled" | "not-configured" | "idle" | "checking" | "current" | "unavailable" | "available" | "downloading" | "verifying" | "ready" | "installing" | "error";
/** Exact UTF-8 manifest text; never parse/reserialize before verification. */
export type DesktopTestUpdateInput = { manifest: string; signature: string };
export interface DesktopUpdateState {
  source?: "official" | "test";
  phase: DesktopUpdatePhase;
  currentVersion: string;
  version?: string;
  releaseNotes?: Record<string, string[]>;
  progress: number;
  autoDownload: boolean;
  canInstall: boolean;
  /** Verified cached package, independent of the last operation error. */
  packageReady?: boolean;
  /** Cleanup/native install may have stopped services; restart before another attempt. */
  restartRequired?: boolean;
  checkedAt?: string;
  error?: "checkFailed" | "downloadFailed" | "verificationFailed" | "installFailed" | "operationFailed" | "configInvalid" | "cleanupFailed" | "updateBusy" | "signatureInvalid" | "clockInvalid";
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

/** Shared action policy keeps sidebar and About recovery consistent. */
export function desktopUpdateSidebarVisible(state: DesktopUpdateState): boolean {
  return state.phase === "error" || Boolean(state.version &&
    (state.error || ["available", "downloading", "verifying", "ready", "installing"].includes(state.phase)));
}

export function desktopUpdateAction(state: DesktopUpdateState): "install" | "download" | "check" | "restart" | undefined {
  if (["checking", "downloading", "verifying", "installing", "disabled"].includes(state.phase)) return undefined;
  if (state.restartRequired) return "restart";
  if (state.packageReady || state.phase === "ready") return "install";
  if (state.phase === "available" || (state.version && ["downloadFailed", "verificationFailed"].includes(state.error ?? ""))) return "download";
  return "check";
}
