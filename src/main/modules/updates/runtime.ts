import fs from "node:fs";
import path from "node:path";
import type { DesktopUpdateArtifact, DesktopUpdateConfig, DesktopUpdateManifest, DesktopUpdateState } from "../../../shared/desktop-updates";
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
  let state: DesktopUpdateState = { phase: "disabled", currentVersion: options.currentVersion, progress: 0, autoDownload: true, canInstall: options.packaged && ["darwin", "win32"].includes(options.platform) };
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
  try { state.autoDownload = JSON.parse(fs.readFileSync(options.preferencesPath, "utf8")).autoDownload !== false; } catch { /* Default preference. */ }
  const snapshot = () => structuredClone(state);
  const publish = (change: Partial<DesktopUpdateState>) => {
    state = { ...state, ...change };
    if (!disposed) options.emit(snapshot());
  };
  function refreshConfig() {
    const config = options.readConfig();
    const key = JSON.stringify(config);
    if (key !== configKey) {
      configKey = key; release = undefined; artifact = undefined; file = "";
      publish({ phase: config.enabled ? "idle" : "disabled", version: undefined, releaseNotes: undefined, error: undefined, progress: 0 });
    }
    return config;
  }
  function action(task: () => Promise<void>) {
    if (busy) return busy;
    if (disposed) return Promise.resolve(snapshot());
    busy = Promise.resolve().then(task).catch((error) => {
      // Detailed diagnostics stay in main; URLs/paths never enter the renderer DTO.
      console.warn("[updates] operation failed", error);
      publish({ phase: "error", error: error instanceof Error && ["activeRuns", "cleanupFailed", "updateBusy"].includes(error.message) ? error.message as DesktopUpdateState["error"] : "operationFailed" });
    }).then(snapshot).finally(() => { busy = undefined; });
    return busy;
  }
  async function download() {
    if (!release || !artifact || compareUpdateVersions(release.version, options.currentVersion) <= 0) return;
    controller = new AbortController();
    const deadline = setTimeout(() => controller?.abort(), 60 * 60_000);
    try {
      fs.mkdirSync(options.cacheRoot, { recursive: true, mode: 0o700 });
      file = path.join(options.cacheRoot, `${artifact.sha256}${options.platform === "darwin" ? ".zip" : ".exe"}`);
      publish({ phase: "downloading", progress: 0, error: undefined });
      let cached = false;
      try { await verifyUpdateFile(file, artifact); cached = true; } catch { /* Download absent or corrupt cache again. */ }
      if (!cached) await (options.downloadFile ?? downloadUpdateFile)(artifact, file, controller.signal, (progress) => publish({ progress }));
      publish({ phase: "verifying", progress: 100 });
      await verifyUpdateFile(file, artifact);
      await options.verifyPublisher(file);
      publish({ phase: "ready", progress: 100 });
    } finally { clearTimeout(deadline); controller = undefined; }
  }
  const api = {
    getState() {
      if (!busy) {
        try { refreshConfig(); } catch { publish({ phase: "error", error: "configInvalid" }); }
      }
      return snapshot();
    },
    check() { return action(async () => {
      const config = refreshConfig();
      if (!config.enabled || state.phase === "ready" || state.phase === "installing") return;
      publish({ phase: "checking", error: undefined });
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 30_000);
      try {
        const raw = await (options.fetchManifest ?? fetchUpdateManifest)(config.feedUrl, controller.signal);
        if (raw === undefined) {
          release = undefined; artifact = undefined; file = "";
          lastCheck = Date.now();
          publish({ phase: "not-configured", checkedAt: new Date(lastCheck).toISOString(), version: undefined, releaseNotes: undefined, progress: 0, error: undefined });
          return;
        }
        release = parseUpdateManifest(raw, options.productId, config.channel);
      } finally { clearTimeout(deadline); controller = undefined; }
      lastCheck = Date.now();
      artifact = release.artifacts[`${options.platform}-${options.arch}`];
      const newer = compareUpdateVersions(release.version, options.currentVersion) > 0;
      publish({ checkedAt: new Date(lastCheck).toISOString(), version: newer ? release.version : undefined, releaseNotes: newer ? release.releaseNotes : undefined, phase: !newer ? "current" : artifact ? "available" : "unavailable", progress: 0 });
      if (newer && artifact && state.autoDownload) await download();
    }); },
    download() { return action(async () => { refreshConfig(); if (state.phase !== "ready" && state.phase !== "installing") await download(); }); },
    install() { return action(async () => {
      refreshConfig();
      if (!state.canInstall || state.phase !== "ready" || !artifact || !release) return;
      publish({ phase: "installing", error: undefined });
      await verifyUpdateFile(file, artifact);
      await options.verifyPublisher(file);
      if (!await options.prepareInstall()) { publish({ phase: "ready" }); return; }
      await options.install(file, release.version);
    }); },
    setAutoDownload(enabled: boolean) {
      if (typeof enabled !== "boolean") throw new Error("Invalid update preference");
      fs.mkdirSync(path.dirname(options.preferencesPath), { recursive: true });
      fs.writeFileSync(options.preferencesPath, JSON.stringify({ autoDownload: enabled }) + "\n");
      publish({ autoDownload: enabled });
      if (enabled && state.phase === "available") void api.download();
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
