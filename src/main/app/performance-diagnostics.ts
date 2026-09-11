import { app, screen, webContents, type WebContents } from "electron";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { BrowserSurfaceRegistry } from "../modules/web-surfaces";
import { createAgentRealtimeRuntimeDiagnostics } from "./module-registry.part-1";
import { getDesktopLogRoot } from "../support/logging/desktop";
import { isPerformanceDiagnosticsEnabled, startPerformanceWriter, writePerformanceEvent } from "../support/logging/performance";

export function startPerformanceDiagnostics(registry: BrowserSurfaceRegistry) {
  if (!isPerformanceDiagnosticsEnabled()) return;
  const stopWriter = startPerformanceWriter(getDesktopLogRoot(app));
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const cleanups = new Map<number, () => void>();
  const track = (contents: WebContents) => {
    if (cleanups.has(contents.id)) return;
    const id = contents.id;
    const type = contents.getType();
    let pid = 0;
    const emit = (stage: string) => {
      try { if (!contents.isDestroyed()) pid = contents.getOSProcessId(); } catch { /* Guest is exiting. */ }
      writePerformanceEvent({ stage, webContentsId: id, type, pid });
    };
    const started = () => emit("contents-loading");
    const ready = () => emit("contents-dom-ready");
    const finished = () => emit("contents-loaded");
    const gone = () => emit("contents-render-process-gone");
    const destroyed = () => { emit("contents-destroyed"); cleanups.delete(id); };
    contents.on("did-start-loading", started);
    contents.on("dom-ready", ready);
    contents.on("did-finish-load", finished);
    contents.on("render-process-gone", gone);
    contents.once("destroyed", destroyed);
    cleanups.set(id, () => {
      contents.removeListener("did-start-loading", started);
      contents.removeListener("dom-ready", ready);
      contents.removeListener("did-finish-load", finished);
      contents.removeListener("render-process-gone", gone);
      contents.removeListener("destroyed", destroyed);
    });
    emit("contents-observed");
  };
  const created = (_event: Electron.Event, contents: WebContents) => track(contents);
  app.on("web-contents-created", created);
  webContents.getAllWebContents().forEach(track);
  writePerformanceEvent({ stage: "session-start", mainPid: process.pid,
    platform: process.platform, osRelease: os.release(), arch: process.arch,
    desktopVersion: app.getVersion(), electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome, cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(), gpuFeatures: app.getGPUFeatureStatus(),
    displays: screen.getAllDisplays().map(({ size, scaleFactor }) => ({ size, scaleFactor })),
  });
  let previous = new Map<string, number>();
  const sample = () => {
    try {
      const snapshot = createAgentRealtimeRuntimeDiagnostics(app, registry);
      const next = new Map<string, number>();
      const processes = snapshot.processes.map((item) => {
        const key = `${item.pid}:${item.creationTime}`;
        next.set(key, item.workingSetBytes);
        // Windows private bytes and macOS working set have different accounting semantics.
        const memory = process.platform === "win32" ? { privateBytes: item.privateBytes }
          : process.platform === "darwin" ? {} : {};
        return { pid: item.pid, type: item.type, creationTime: item.creationTime,
          cpuPercent: item.cpuPercent, workingSetBytes: item.workingSetBytes, ...memory,
          deltaBytes: previous.has(key) ? item.workingSetBytes - previous.get(key)! : null };
      });
      previous = next;
      writePerformanceEvent({ stage: "resources", processes,
        surfaceCount: snapshot.surfaceCount, webviewCount: snapshot.webviewCount,
        orphanWebviewCount: snapshot.orphanWebviewCount,
        totalWorkingSetBytes: snapshot.totalWorkingSetBytes,
        mainEventLoopMaxMs: loop.max / 1e6, mainEventLoopP99Ms: loop.percentile(99) / 1e6,
        targets: snapshot.targets.map((target) => ({ surfaceId: target.surfaceId,
          webContentsId: target.webContentsId, pid: target.pid, active: target.active,
          orphaned: target.orphaned, loading: target.loading,
          devToolsOpened: target.devToolsOpened, backgroundThrottling: target.backgroundThrottling })),
      });
      loop.reset();
    } catch { writePerformanceEvent({ stage: "resource-sample-failed" }); }
  };
  const timer = setInterval(sample, 5000);
  timer.unref();
  app.once("will-quit", () => {
    clearInterval(timer); loop.disable();
    app.removeListener("web-contents-created", created);
    cleanups.forEach((cleanup) => cleanup()); cleanups.clear();
    writePerformanceEvent({ stage: "session-end" });
    void stopWriter();
  });
}
