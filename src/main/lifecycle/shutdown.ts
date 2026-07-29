import net from "node:net";
import type { App } from "electron";
import type {
  ShutdownFailure,
  ShutdownMode,
  ShutdownProgress,
  ShutdownReport
} from "../../shared/shutdown";
import {
  captureManagedProcessCleanupSnapshotAsync,
  forceCleanupManagedProcesses,
  stopRunningServicesForShutdown
} from "../services/manager";
import {
  isProcessRunning,
  terminateCapturedProcessTreeAsync
} from "../services/manager/process-cleanup";
import {
  staticSiteHostManager,
  stopAllStaticSiteHosts
} from "../static-site-host-manager";
import {
  listActiveWebappPorts,
  stopAllWebapps
} from "../webs/webapps/runtime";
import { webappWindowManager } from "../webs/webapps/window-manager";
import { stopTunnelHubRuntime } from "../tunnel-hub-runtime";

const USER_SHUTDOWN_BUDGET_MS = 8_000;
const INSTALLER_SHUTDOWN_BUDGET_MS = 10_000;

type ManagedProcessSnapshot = Awaited<
  ReturnType<typeof captureManagedProcessCleanupSnapshotAsync>
>;

type ShutdownPortTarget = {
  kind: "gateway" | "service";
  id: string;
  port: number;
};

export type ShutdownCleanupDependencies = {
  closeWebappWindows: () => string[];
  listOpenWebappWindowIds: () => string[];
  listInitialPortTargets: (app: App) => ShutdownPortTarget[];
  captureManagedProcessSnapshot: (app: App) => Promise<ManagedProcessSnapshot>;
  stopStaticSites: () => ReturnType<typeof stopAllStaticSiteHosts>;
  stopWebapps: (app: App) => ReturnType<typeof stopAllWebapps>;
  stopServices: (
    app: App,
    options: { stopCommandTimeoutMs: number }
  ) => ReturnType<typeof stopRunningServicesForShutdown>;
  stopTunnel: () => ReturnType<typeof stopTunnelHubRuntime>;
  forceCleanup: (
    app: App,
    snapshot: ManagedProcessSnapshot
  ) => ReturnType<typeof forceCleanupManagedProcesses>;
  isProcessRunning: typeof isProcessRunning;
  isPortListening: (port: number) => Promise<boolean>;
};

export type ShutdownCleanupRunnerOptions = {
  app: App;
  getMode: () => ShutdownMode;
  getExistingPromise: () => Promise<ShutdownReport> | null;
  setPromise: (promise: Promise<ShutdownReport>) => void;
  markComplete: (report: ShutdownReport) => void;
  emitProgress: (progress: ShutdownProgress) => void;
  now?: () => number;
  dependencies?: Partial<ShutdownCleanupDependencies>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function appendFailure(
  failures: ShutdownFailure[],
  failure: ShutdownFailure
) {
  failures.push({
    ...failure,
    ...(failure.pids?.length
      ? { pids: [...new Set(failure.pids)].sort((left, right) => left - right) }
      : {})
  });
}

function isLoopbackPortListening(port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port
    });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function createShutdownCleanupRunner(options: ShutdownCleanupRunnerOptions) {
  const dependencies: ShutdownCleanupDependencies = {
    closeWebappWindows: () => webappWindowManager.closeAll(),
    listOpenWebappWindowIds: () => webappWindowManager.openIds(),
    listInitialPortTargets: (app) => [
      ...staticSiteHostManager.list().flatMap((site) =>
        site.running && site.port
          ? [{ kind: "gateway" as const, id: `static-site:${site.siteId}`, port: site.port }]
          : []
      ),
      ...listActiveWebappPorts(app).map((target) => ({
        kind: "gateway" as const,
        id: `webapp:${target.id}`,
        port: target.port
      }))
    ],
    captureManagedProcessSnapshot: (app) =>
      captureManagedProcessCleanupSnapshotAsync(app),
    stopStaticSites: () => stopAllStaticSiteHosts(),
    stopWebapps: (app) => stopAllWebapps(app),
    stopServices: (app, serviceOptions) =>
      stopRunningServicesForShutdown(app, serviceOptions),
    stopTunnel: () => stopTunnelHubRuntime(),
    forceCleanup: (app, snapshot) =>
      forceCleanupManagedProcesses(app, snapshot, {
        platform: process.platform,
        collectManagedProcessCleanupTargetsImpl: () => ({
          roots: [],
          stalePidFilePaths: []
        }),
        listProcessTreePidsImpl: () => [],
        pidMatchesInstallDirImpl: () => true,
        terminateCapturedProcessTreeImpl: (rootPid, capturedPids) =>
          terminateCapturedProcessTreeAsync(rootPid, capturedPids)
      }),
    isProcessRunning,
    isPortListening: isLoopbackPortListening,
    ...options.dependencies
  };

  return function runShutdownCleanup(): Promise<ShutdownReport> {
    const existingPromise = options.getExistingPromise();
    if (existingPromise) {
      return existingPromise;
    }

    const now = options.now ?? Date.now;
    const fallbackStartedAt = now();
    const cleanupPromise = runCleanup().catch((error) => {
      const mode = options.getMode();
      const elapsedMs = Math.max(0, now() - fallbackStartedAt);
      const budgetMs = mode === "installer"
        ? INSTALLER_SHUTDOWN_BUDGET_MS
        : USER_SHUTDOWN_BUDGET_MS;
      const report: ShutdownReport = {
        mode,
        ok: false,
        timedOut: elapsedMs > budgetMs,
        elapsedMs,
        failures: [{
          kind: "service",
          id: "shutdown-coordinator",
          phase: "verify",
          message: errorMessage(error)
        }],
        survivors: []
      };
      try {
        options.emitProgress({
          mode,
          phase: "failed",
          percent: 100,
          message: "",
          elapsedMs
        });
      } catch {
        // A renderer failure must not prevent the installer acknowledgement.
      }
      options.markComplete(report);
      console.error("[main] app shutdown coordinator failed unexpectedly", error);
      return report;
    });
    options.setPromise(cleanupPromise);
    return cleanupPromise;
  };

  async function runCleanup(): Promise<ShutdownReport> {
    const now = options.now ?? Date.now;
    const startedAt = now();
    const mode = options.getMode();
    const failures: ShutdownFailure[] = [];
    const survivors = new Set<number>();
    let portTargets: ShutdownPortTarget[] = [];

    const emitProgress = (
      phase: ShutdownProgress["phase"],
      percent: number,
      message: string
    ) => {
      options.emitProgress({
        mode: options.getMode(),
        phase,
        percent,
        message,
        elapsedMs: Math.max(0, now() - startedAt)
      });
    };

    emitProgress("preparing", 5, "");

    try {
      dependencies.closeWebappWindows();
    } catch (error) {
      appendFailure(failures, {
        kind: "window",
        id: "webapp-windows",
        phase: "graceful",
        message: errorMessage(error)
      });
    }
    try {
      portTargets = dependencies.listInitialPortTargets(options.app);
    } catch (error) {
      appendFailure(failures, {
        kind: "gateway",
        id: "port-snapshot",
        phase: "verify",
        message: errorMessage(error)
      });
    }

    let processCleanupSnapshot: ManagedProcessSnapshot = [];
    try {
      processCleanupSnapshot = await dependencies.captureManagedProcessSnapshot(options.app);
    } catch (error) {
      appendFailure(failures, {
        kind: "service",
        id: "managed-process-snapshot",
        phase: "verify",
        message: errorMessage(error)
      });
    }

    emitProgress("stopping", 20, "");
    const gracefulStopTimeoutMs = mode === "installer" ? 4_500 : 3_500;
    const [staticSitesResult, webappsResult, servicesResult, tunnelResult] = await Promise.allSettled([
      dependencies.stopStaticSites(),
      dependencies.stopWebapps(options.app),
      dependencies.stopServices(options.app, {
        stopCommandTimeoutMs: gracefulStopTimeoutMs
      }),
      dependencies.stopTunnel()
    ]);

    if (staticSitesResult.status === "rejected") {
      appendFailure(failures, {
        kind: "gateway",
        id: "static-sites",
        phase: "graceful",
        message: errorMessage(staticSitesResult.reason)
      });
    }

    if (webappsResult.status === "rejected") {
      appendFailure(failures, {
        kind: "webapp",
        id: "all",
        phase: "graceful",
        message: errorMessage(webappsResult.reason)
      });
    } else {
      for (const result of webappsResult.value) {
        if (result.ok) {
          continue;
        }
        const pids = result.state?.pid && dependencies.isProcessRunning(result.state.pid)
          ? [result.state.pid]
          : [];
        pids.forEach((pid) => survivors.add(pid));
        appendFailure(failures, {
          kind: "webapp",
          id: result.item?.id ?? result.state?.id ?? "unknown",
          phase: "force",
          message: result.message,
          ...(pids.length > 0 ? { pids } : {})
        });
      }
    }

    if (servicesResult.status === "rejected") {
      appendFailure(failures, {
        kind: "service",
        id: "all",
        phase: "graceful",
        message: errorMessage(servicesResult.reason)
      });
    } else {
      portTargets.push(
        ...(servicesResult.value.runningServicePorts ?? []).map((target) => ({
          kind: "service" as const,
          id: target.serviceId,
          port: target.port
        }))
      );
      for (const result of servicesResult.value.failures) {
        appendFailure(failures, {
          kind: "service",
          id: result.serviceId,
          phase: "graceful",
          message: result.message
        });
      }
    }

    if (tunnelResult.status === "rejected") {
      appendFailure(failures, {
        kind: "tunnel",
        id: "desktop-tunnel-hub",
        phase: "graceful",
        message: errorMessage(tunnelResult.reason)
      });
    } else if (!tunnelResult.value.ok) {
      appendFailure(failures, {
        kind: "tunnel",
        id: "desktop-tunnel-hub",
        phase: "graceful",
        message: tunnelResult.value.message
      });
    }

    emitProgress("forcing", 70, "");
    try {
      const forced = await dependencies.forceCleanup(
        options.app,
        processCleanupSnapshot
      );
      for (const failure of forced.failures) {
        failure.pids.forEach((pid) => survivors.add(pid));
        appendFailure(failures, {
          kind: "service",
          id: failure.serviceId,
          phase: "force",
          message: `Managed process tree is still running: ${failure.pids.join(", ")}`,
          pids: failure.pids
        });
      }
    } catch (error) {
      appendFailure(failures, {
        kind: "service",
        id: "managed-process-cleanup",
        phase: "force",
        message: errorMessage(error)
      });
    }

    emitProgress("verifying", 90, "");
    const openWindowIds = dependencies.listOpenWebappWindowIds();
    if (openWindowIds.length > 0) {
      appendFailure(failures, {
        kind: "window",
        id: "webapp-windows",
        phase: "verify",
        message: `WebApp windows are still open: ${openWindowIds.join(", ")}`
      });
    }
    for (const target of processCleanupSnapshot) {
      const targetPids = [...new Set([...target.treePids, target.pid])];
      const remainingPids = targetPids.filter((pid) =>
        dependencies.isProcessRunning(pid)
      );
      if (remainingPids.length === 0) {
        continue;
      }
      remainingPids.forEach((pid) => survivors.add(pid));
      appendFailure(failures, {
        kind: "service",
        id: target.serviceId,
        phase: "verify",
        message: `Process verification failed: ${remainingPids.join(", ")}`,
        pids: remainingPids
      });
    }
    const uniquePortTargets = [
      ...new Map(
        portTargets.map((target) => [
          `${target.kind}:${target.id}:${target.port}`,
          target
        ])
      ).values()
    ];
    const portResults = await Promise.all(
      uniquePortTargets.map(async (target) => ({
        target,
        listening: await dependencies.isPortListening(target.port)
      }))
    );
    for (const { target, listening } of portResults) {
      if (!listening) {
        continue;
      }
      appendFailure(failures, {
        kind: target.kind,
        id: target.id,
        phase: "verify",
        message: `Port verification failed: ${target.port} is still listening.`
      });
    }

    const elapsedMs = Math.max(0, now() - startedAt);
    const reportMode = options.getMode();
    const budgetMs = reportMode === "installer"
      ? INSTALLER_SHUTDOWN_BUDGET_MS
      : USER_SHUTDOWN_BUDGET_MS;
    const survivorList = [...survivors]
      .filter((pid) => dependencies.isProcessRunning(pid))
      .sort((left, right) => left - right);
    const timedOut = elapsedMs > budgetMs;
    const snapshottedServiceIds = new Set(
      processCleanupSnapshot.map((target) => target.serviceId)
    );
    const hasUnverifiedGracefulServiceFailure = failures.some((failure) =>
      failure.kind === "service" &&
      failure.phase === "graceful" &&
      (failure.id === "all" || !snapshottedServiceIds.has(failure.id))
    );
    const ok = !timedOut &&
      survivorList.length === 0 &&
      !hasUnverifiedGracefulServiceFailure &&
      !failures.some((failure) =>
        failure.phase === "force" ||
        failure.phase === "verify" ||
        failure.kind !== "service"
      );
    const report: ShutdownReport = {
      mode: reportMode,
      ok,
      timedOut,
      elapsedMs,
      failures,
      survivors: survivorList
    };

    emitProgress(ok ? "complete" : "failed", 100, "");
    options.markComplete(report);
    console.log(
      `[main] app shutdown cleanup finished mode=${report.mode} ok=${ok} timedOut=${timedOut} ` +
      `elapsedMs=${elapsedMs} survivors=${survivorList.join(",") || "none"}`
    );
    return report;
  }
}

export const __testInternals = {
  USER_SHUTDOWN_BUDGET_MS,
  INSTALLER_SHUTDOWN_BUDGET_MS
};
