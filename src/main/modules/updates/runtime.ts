import fs from "node:fs";
import path from "node:path";
import type { DesktopUpdateArtifact, DesktopUpdateConfig, DesktopUpdateManifest, DesktopUpdateState, DesktopTestUpdateInput } from "../../../shared/desktop-updates";
import { compareUpdateVersions, parseUpdateManifest } from "./manifest";
import { downloadUpdateFile, fetchUpdateManifest, verifyUpdateFile } from "./download";

const CHECK_INTERVAL = 4 * 60 * 60_000;
export interface UpdateRuntimeOptions {
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
  let release: DesktopUpdateManifest | undefined;
  let artifact: DesktopUpdateArtifact | undefined;
  let file = "";
  let configKey = "";
  let busy: Promise<DesktopUpdateState> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let lastCheck = 0;
  try { state.autoDownload = JSON.parse(fs.readFileSync(options.preferencesPath, "utf8")).autoDownload === true; } catch { /* Default preference. */ }
  const snapshot = () => structuredClone(state);
  const publish = (change: Partial<DesktopUpdateState>) => {
    state = { ...state, ...change };
    if (!disposed) options.emit(snapshot());
  };
  function refreshConfig() {
    if (testConfig) return testConfig;
    const config = options.readConfig();
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
      publish({ phase: state.packageReady && !state.restartRequired ? "ready" : "error", error: error instanceof Error && ["cleanupFailed", "updateBusy"].includes(error.message) ? error.message as DesktopUpdateState["error"] : failure });
    }).then(snapshot).finally(() => { busy = undefined; });
    return busy;
  }
  function cacheFile(target: DesktopUpdateArtifact) {
    return path.join(options.cacheRoot, `${target.sha256}${options.platform === "darwin" ? ".zip" : ".exe"}`);
  }
  async function download() {
    if (!release || !artifact || compareUpdateVersions(release.version, currentVersion) <= 0) return;
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
    check() {
      if (testConfig) return Promise.resolve(snapshot());
      return action(async () => {
      if (state.restartRequired) return;
      const config = refreshConfig();
      if (!config.enabled || state.packageReady || state.restartRequired || state.phase === "installing") return;
      publish({ phase: "checking", error: undefined });
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 30_000);
      try {
        const raw = await (options.fetchManifest ?? fetchUpdateManifest)(config.feedUrl, controller.signal);
        if (raw === undefined) {
          release = undefined; artifact = undefined; file = "";
          lastCheck = Date.now();
          publish({ phase: "not-configured", checkedAt: new Date(lastCheck).toISOString(), version: undefined, releaseNotes: undefined, progress: 0, error: undefined, packageReady: false });
          return;
        }
        release = parseUpdateManifest(raw, options.productId);
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
          publish({ phase: "ready", progress: 100, packageReady: true });
          return;
        } catch { /* Missing or invalid cache still requires a download. */ }
      }
      if (newer && artifact && state.autoDownload) await download();
    }); },
    async loadTest(input: DesktopTestUpdateInput) {
      if (busy || disposed || state.restartRequired || state.phase === "installing") throw new Error("updateBusy");
      if (!input || typeof input !== "object" || JSON.stringify(input).length > 256 * 1024) throw new Error("Invalid test update");
      const raw = "manifest" in input ? input.manifest : {
        schemaVersion: 1, productId: options.productId, version: input.version,
        publishedAt: new Date().toISOString(), releaseNotes: {},
        artifacts: { [`${options.platform}-${options.arch}`]: { url: input.url, size: input.size, sha256: input.sha256 } }
      };
      const candidate = parseUpdateManifest(raw, options.productId);
      const target = candidate.artifacts[`${options.platform}-${options.arch}`];
      if (!target || compareUpdateVersions(candidate.version, currentVersion) <= 0) throw new Error("Test update requires a newer version for this platform");
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
      try { await options.install(file, release.version); }
      catch (error) { publish({ restartRequired: true }); throw error; }
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
      api.getState();
      startupTimer = setTimeout(() => { void api.check(); }, 15_000);
      timer = setInterval(() => { void api.check(); }, CHECK_INTERVAL);
      startupTimer.unref(); timer.unref();
    },
    resume() { if (Date.now() - lastCheck >= CHECK_INTERVAL) void api.check(); },
    dispose() { disposed = true; clearTimeout(startupTimer); clearInterval(timer); controller?.abort(); }
  };
  return api;
}
