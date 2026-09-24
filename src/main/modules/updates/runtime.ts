import fs from "node:fs";
import path from "node:path";
import type { DesktopUpdateArtifact, DesktopUpdateConfig, DesktopPlatformUpdateManifest, DesktopUpdateState, DesktopTestUpdateInput } from "../../../shared/desktop-updates";
import { compareUpdateVersions, parseUpdateManifest } from "./manifest";
import { downloadUpdateFile, fetchUpdateManifest, verifyUpdateFile, UpdateHttpError } from "./download";
import { verifySignedManifest, type UpdateTrust } from "./signing";
import { UPDATE_TRUST } from "./trust";
import { verifyUpdateTime } from "./security";

const CHECK_INTERVAL = 4 * 60 * 60_000;
const CHECK_RETRY_DELAYS = [5_000, 15_000, 30_000];
function isTransientCheckError(error: unknown) {
  if (error instanceof UpdateHttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ABORT_ERR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
export interface UpdateRuntimeOptions {
  trust?: UpdateTrust;
  now?(): number;
  currentVersion: string;
  productId: string;
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  cacheRoot: string;
  preferencesPath: string;
  readConfig(): DesktopUpdateConfig;
  emit(state: DesktopUpdateState): void;
  prepareInstall(): Promise<boolean>;
  verifyPublisher(file: string): Promise<void>;
  install(file: string, version: string): Promise<void>;
  fetchManifest?: typeof fetchUpdateManifest;
  downloadFile?: typeof downloadUpdateFile;
}
export function createUpdateRuntime(options: UpdateRuntimeOptions) {
  // Desktop app-info uses a display tag (v0.4.5); feed versions remain strict SemVer.
  const currentVersion = options.currentVersion.replace(/^v(?=\d)/, "");
  let state: DesktopUpdateState = { phase: "disabled", currentVersion, progress: 0, autoDownload: false, canInstall: options.packaged && ["darwin", "win32"].includes(options.platform) };
  let testConfig: DesktopUpdateConfig | undefined;
  let release: DesktopPlatformUpdateManifest | undefined;
  let artifact: DesktopUpdateArtifact | undefined;
  let file = "";
  let configKey = "";
  let busy: Promise<DesktopUpdateState> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;
  let mainReadyHandled = false;
  let disposed = false;
  let lastCheck = 0;
  try { state.autoDownload = JSON.parse(fs.readFileSync(options.preferencesPath, "utf8")).autoDownload === true; } catch { /* Default preference. */ }
  const snapshot = () => structuredClone(state);
  const publish = (change: Partial<DesktopUpdateState>) => {
    state = { ...state, ...change };
    if (!disposed) {
      try { options.emit(snapshot()); }
      catch (error) { console.warn("[updates] state notification failed", error); }
    }
  };
  function acceptRelease(candidate: DesktopPlatformUpdateManifest) {
    if (options.platform === "darwin") return; // Native Apple verification remains mandatory below.
    if (candidate.schemaVersion !== 2) throw new Error("signatureInvalid");
    verifyUpdateTime(candidate, (options.now ?? Date.now)());
  }
  function verifyManifest(input: DesktopTestUpdateInput) {
    if (options.platform === "darwin") {
      if (typeof input?.manifest !== "string" || Buffer.byteLength(input.manifest, "utf8") > 256 * 1024) throw new Error("Invalid update manifest");
      return parseUpdateManifest(JSON.parse(input.manifest), options.productId, "darwin");
    }
    const verified = verifySignedManifest(input, options.trust ?? UPDATE_TRUST, options.productId);
    return parseUpdateManifest(verified.value, options.productId);
  }
  function refreshConfig() {
    if (testConfig) return testConfig;
    let config: DesktopUpdateConfig;
    try { config = options.readConfig(); }
    catch (error) {
      console.warn("[updates] configuration unavailable", error);
      throw new Error("configInvalid");
    }
    const key = JSON.stringify(config);
    if (key !== configKey) {
      configKey = key; release = undefined; artifact = undefined; file = "";
      publish({ phase: config.enabled ? "idle" : "disabled", version: undefined, releaseNotes: undefined, error: undefined, progress: 0, packageReady: false, restartRequired: false });
    }
    return config;
  }
  function action(task: () => Promise<void>) {
    if (busy) return busy;
    if (disposed) return Promise.resolve(snapshot());
    busy = Promise.resolve().then(task).catch((error) => {
      // Detailed diagnostics stay in main; URLs/paths never enter the renderer DTO.
      console.warn("[updates] operation failed", error);
      const failure = state.phase === "checking" ? "checkFailed"
        : state.phase === "downloading" ? "downloadFailed"
        : state.phase === "verifying" ? "verificationFailed"
        : state.phase === "installing" ? "installFailed" : "operationFailed";
      publish({ phase: state.packageReady && !state.restartRequired ? "ready" : "error", error: error instanceof Error && ["configInvalid", "cleanupFailed", "updateBusy", "signatureInvalid", "clockInvalid"].includes(error.message) ? error.message as DesktopUpdateState["error"] : failure });
    }).then(snapshot).finally(() => { busy = undefined; });
    return busy;
  }
  function cacheFile(target: DesktopUpdateArtifact) {
    return path.join(options.cacheRoot, `${target.sha256}${options.platform === "darwin" ? ".zip" : ".exe"}`);
  }
  async function download() {
    if (!release || !artifact || compareUpdateVersions(release.version, currentVersion) <= 0) return;
    acceptRelease(release);
    controller = new AbortController();
    const deadline = setTimeout(() => controller?.abort(), 60 * 60_000);
    try {
      fs.mkdirSync(options.cacheRoot, { recursive: true, mode: 0o700 });
      file = cacheFile(artifact);
      publish({ phase: "downloading", progress: 0, error: undefined, packageReady: false });
      let cached = false;
      try { await verifyUpdateFile(file, artifact); cached = true; } catch { /* Download absent or corrupt cache again. */ }
      if (!cached) await (options.downloadFile ?? downloadUpdateFile)(artifact, file, controller.signal, (progress) => publish({ progress }));
      publish({ phase: "verifying", progress: 100 });
      await verifyUpdateFile(file, artifact);
      await options.verifyPublisher(file);
      acceptRelease(release);
      publish({ phase: "ready", progress: 100, packageReady: true });
    } finally { clearTimeout(deadline); controller = undefined; }
  }
  const api = {
    getState() {
      if (!busy && !state.restartRequired) {
        try { refreshConfig(); } catch { publish({ phase: "error", error: "configInvalid" }); }
      }
      return snapshot();
    },
    check(isRetry = false) {
      if (testConfig) return Promise.resolve(snapshot());
      if (busy || disposed) return busy ?? Promise.resolve(snapshot());
      clearTimeout(retryTimer);
      clearTimeout(startupTimer);
      if (!isRetry) retryAttempt = 0;
      return action(async () => {
      if (state.restartRequired) return;
      const config = refreshConfig();
      if (!config.enabled || state.restartRequired || state.phase === "installing") return;
      publish({ packageReady: false });
      publish({ phase: "checking", error: undefined });
      release = undefined; artifact = undefined; file = "";
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 30_000);
      try {
        let raw: DesktopTestUpdateInput | undefined;
        try {
          raw = await (options.fetchManifest ?? fetchUpdateManifest)(config.feedUrl, controller.signal, options.platform);
        } catch (error) {
          if (!disposed && isTransientCheckError(error) && retryAttempt < CHECK_RETRY_DELAYS.length) {
            retryTimer = setTimeout(() => { void api.check(true); }, CHECK_RETRY_DELAYS[retryAttempt++]);
            retryTimer.unref?.();
          }
          throw error;
        }
        retryAttempt = 0;
        if (raw === undefined) {
          release = undefined; artifact = undefined; file = "";
          lastCheck = Date.now();
          publish({ phase: "not-configured", checkedAt: new Date(lastCheck).toISOString(), version: undefined, releaseNotes: undefined, progress: 0, error: undefined, packageReady: false });
          return;
        }
        const candidate = verifyManifest(raw);
        acceptRelease(candidate);
        release = candidate;
      } finally { clearTimeout(deadline); controller = undefined; }
      lastCheck = Date.now();
      artifact = release.artifacts[`${options.platform}-${options.arch}`];
      const newer = compareUpdateVersions(release.version, currentVersion) > 0;
      publish({ checkedAt: new Date(lastCheck).toISOString(), version: newer ? release.version : undefined, releaseNotes: newer ? release.releaseNotes : undefined, phase: !newer ? "current" : artifact ? "available" : "unavailable", progress: 0, packageReady: false });
      // Rediscover a verified cache after restart without asking for another download.
      if (newer && artifact) {
        file = cacheFile(artifact);
        try {
          await verifyUpdateFile(file, artifact);
          await options.verifyPublisher(file);
          acceptRelease(release);
          publish({ phase: "ready", progress: 100, packageReady: true });
          return;
        } catch { /* Missing or invalid cache still requires a download. */ }
      }
      if (newer && artifact && state.autoDownload) await download();
    }); },
    async loadTest(input: DesktopTestUpdateInput) {
      if (busy || disposed || state.restartRequired || state.phase === "installing") throw new Error("updateBusy");
      const candidate = verifyManifest(input);
      const target = candidate.artifacts[`${options.platform}-${options.arch}`];
      if (!target || compareUpdateVersions(candidate.version, currentVersion) <= 0) throw new Error("Test update requires a newer version for this platform");
      acceptRelease(candidate);
      clearTimeout(retryTimer);
      // Validate everything before replacing the current selection. Never persist the test feed.
      testConfig = { enabled: true, feedUrl: "" };
      release = candidate; artifact = target; file = "";
      publish({ source: "test", phase: "available", version: candidate.version, releaseNotes: candidate.releaseNotes,
        progress: 0, checkedAt: undefined, error: undefined, packageReady: false, restartRequired: false });
      return snapshot();
    },
    async clearTest() {
      if (busy || disposed || state.restartRequired || state.phase === "installing") throw new Error("updateBusy");
      if (!testConfig) return snapshot();
      testConfig = undefined; configKey = ""; release = undefined; artifact = undefined; file = ""; lastCheck = 0;
      publish({ source: "official", phase: "idle", version: undefined, releaseNotes: undefined, progress: 0, checkedAt: undefined, error: undefined, packageReady: false, restartRequired: false });
      return api.getState();
    },
    download() { return action(async () => { if (state.restartRequired) return; refreshConfig(); if (!state.restartRequired && !state.packageReady && state.phase !== "installing") await download(); }); },
    install() { return action(async () => {
      if (state.restartRequired || state.phase === "installing") return;
      refreshConfig();
      if (!state.canInstall || !state.packageReady || state.restartRequired || !artifact || !release) return;
      publish({ phase: "installing", error: undefined });
      try {
        acceptRelease(release);
        await verifyUpdateFile(file, artifact);
        await options.verifyPublisher(file);
      } catch (error) {
        publish({ phase: "verifying", packageReady: false });
        throw error;
      }
      try {
        if (!await options.prepareInstall()) { publish({ phase: "ready" }); return; }
      } catch (error) {
        // updateBusy is a pre-cleanup refusal; other failures may have stopped services.
        if (!(error instanceof Error && error.message === "updateBusy")) publish({ restartRequired: true });
        throw error;
      }
      try {
        // Cleanup can take time: recheck signed metadata time and file bytes before execution.
        try {
          acceptRelease(release);
          await verifyUpdateFile(file, artifact);
        } catch (error) {
          publish({ phase: "verifying", packageReady: false });
          throw error;
        }
        await options.install(file, release.version);
      } catch (error) { publish({ restartRequired: true }); throw error; }
    }); },
    setAutoDownload(enabled: boolean) {
      if (typeof enabled !== "boolean") throw new Error("Invalid update preference");
      fs.mkdirSync(path.dirname(options.preferencesPath), { recursive: true });
      fs.writeFileSync(options.preferencesPath, JSON.stringify({ autoDownload: enabled }) + "\n");
      publish({ autoDownload: enabled });
      if (enabled && !testConfig && state.phase === "available") void api.download();
      return snapshot();
    },
    start() {
      if (timer || disposed) return;
      api.getState();
      startupTimer = setTimeout(() => { void api.check(); }, 15_000);
      timer = setInterval(() => { void api.check(); }, CHECK_INTERVAL);
      startupTimer.unref(); timer.unref();
    },
    mainReady() {
      if (mainReadyHandled) return busy ?? Promise.resolve(snapshot());
      mainReadyHandled = true;
      return state.phase === "error" && state.error === "checkFailed" ? api.check() : busy ?? Promise.resolve(snapshot());
    },
    resume() { if (Date.now() - lastCheck >= CHECK_INTERVAL) void api.check(); },
    dispose() { disposed = true; clearTimeout(retryTimer); clearTimeout(startupTimer); clearInterval(timer); controller?.abort(); }
  };
  return api;
}
