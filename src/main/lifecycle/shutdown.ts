import type { App } from "electron";
import {
  captureManagedProcessCleanupSnapshot,
  forceCleanupManagedProcesses,
  stopRunningServicesForShutdown
} from "../services/manager";
import { stopAllStaticSiteHosts } from "../static-site-host-manager";
import { stopAllWebapps } from "../webs/webapps/runtime";
import { runWithShutdownDeadline } from "../shutdown-cleanup";
import { stopTunnelHubRuntime } from "../tunnel-hub-runtime";

export type ShutdownCleanupRunnerOptions = {
  app: App;
  timeoutMs: number;
  getExistingPromise: () => Promise<void> | null;
  setPromise: (promise: Promise<void>) => void;
  markComplete: () => void;
};

export function createShutdownCleanupRunner(options: ShutdownCleanupRunnerOptions) {
  return function runShutdownCleanup(): Promise<void> {
    const existingPromise = options.getExistingPromise();
    if (existingPromise) {
      return existingPromise;
    }
    const shutdownStartedAt = Date.now();
    const processCleanupSnapshot = captureManagedProcessCleanupSnapshot(options.app);
    const cleanupPromise = runWithShutdownDeadline(
      () => stopAllStaticSiteHosts()
        .catch((error) => {
          console.error("failed while shutting down static site hosts", error);
        })
        .then(() => stopAllWebapps(options.app))
        .catch((error) => {
          console.error("failed while shutting down webapps", error);
        })
        .then(() => stopRunningServicesForShutdown(options.app))
        .catch((error) => {
          console.error("failed while shutting down desktop services", error);
        })
        .then(() => stopTunnelHubRuntime())
        .catch((error) => {
          console.error("failed while shutting down Desktop Tunnel Hub", error);
        })
        .then(async () => {
          const cleanupStartedAt = Date.now();
          await forceCleanupManagedProcesses(options.app, processCleanupSnapshot);
          console.log(`[main] desktop service force cleanup finished in ${Date.now() - cleanupStartedAt}ms`);
        })
        .catch((error) => {
          console.error("failed while force-cleaning desktop service processes", error);
        }),
      { timeoutMs: options.timeoutMs }
    )
      .then(() => undefined)
      .finally(() => {
        options.markComplete();
        console.log(`[main] app shutdown cleanup finished in ${Date.now() - shutdownStartedAt}ms`);
      });
    options.setPromise(cleanupPromise);
    return cleanupPromise;
  };
}
