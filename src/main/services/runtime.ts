import type { App, BrowserWindow } from "electron";
import type { ServiceId } from "../../shared/contracts";
import type { MainAppState } from "../app-state";
import { getServiceState, startService } from "./manager";
import {
  detectPortConflict,
  isPortConflictError,
  killProcessByPid,
  showPortConflictDialog
} from "./port-conflict";
import { getService } from "./service-registry";
import { STARTUP_RESTORE_SERVICE_ORDER } from "../startup-restore";

export type ServicesRuntimeOptions = {
  app: App;
  state: MainAppState;
  getMainWindow: () => BrowserWindow | null;
  notifyServicesChanged: () => void;
  delay: (ms: number) => Promise<void>;
};

export function createServicesRuntime(options: ServicesRuntimeOptions) {
  async function ensureAssistantTargetServicesRunning(source: string) {
    const failures: string[] = [];

    for (const serviceId of STARTUP_RESTORE_SERVICE_ORDER) {
      try {
        const current = await getServiceState(options.app, serviceId);
        if (current.status === "running") {
          continue;
        }

        const result = await startService(options.app, serviceId);
        if (!result.ok || result.service.status !== "running") {
          failures.push(`${result.service.name}: ${result.message}`);
        }
      } catch (error) {
        failures.push(`${serviceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (failures.length > 0) {
      console.warn(`[assistant-entry] failed to prepare assistant services from ${source}`, failures);
    }

    return failures;
  }

  async function runServiceMutation<T>(task: () => Promise<T>) {
    const previousTask = options.state.serviceMutationQueue;
    let releaseQueue = () => {};
    options.state.serviceMutationQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousTask;
    try {
      return await task();
    } finally {
      releaseQueue();
      options.notifyServicesChanged();
    }
  }

  async function handleServiceStart(serviceId: ServiceId) {
    try {
      return await startService(options.app, serviceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isPortConflictError(message)) {
        throw error;
      }

      const service = getService(serviceId);
      const currentState = await getServiceState(options.app, serviceId).catch(() => null);
      const conflict = await detectPortConflict(message, service, {
        fallbackPort: currentState?.healthMeta.port ?? null
      });
      if (!conflict?.processInfo) {
        throw error;
      }

      const confirmed = await showPortConflictDialog(options.getMainWindow(), conflict.port, conflict.processInfo);
      if (!confirmed) {
        throw error;
      }

      const killed = await killProcessByPid(conflict.processInfo.pid);
      if (!killed) {
        throw new Error(
          `Unable to stop process ${conflict.processInfo.name} (PID ${conflict.processInfo.pid}) using port ${conflict.port}.`
        );
      }

      await options.delay(500);
      return startService(options.app, serviceId);
    }
  }

  return {
    ensureAssistantTargetServicesRunning,
    runServiceMutation,
    handleServiceStart
  };
}

export type ServicesRuntime = ReturnType<typeof createServicesRuntime>;
