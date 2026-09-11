import type { App, BrowserWindow } from "electron";
import type { ServiceId } from "../../../shared/contracts";
import {
  detectPortConflict,
  isPortConflictError,
  killProcessByPid,
  showPortConflictDialog
} from "./port-conflict";
import { getService } from "./service-registry";
import { STARTUP_RESTORE_SERVICE_ORDER } from "./startup-order";

export type ServicesRuntimeOptions = {
  app: App;
  getMainWindow: () => BrowserWindow | null;
  notifyServicesChanged: () => void;
  delay: (ms: number) => Promise<void>;
  getServiceState: (app: App, serviceId: ServiceId) => Promise<any>;
  startService: (app: App, serviceId: ServiceId) => Promise<any>;
};

export function createServicesRuntime(options: ServicesRuntimeOptions) {
  let serviceMutationQueue = Promise.resolve();

  async function ensureAssistantTargetServicesRunning(source: string) {
    const failures: string[] = [];

    for (const serviceId of STARTUP_RESTORE_SERVICE_ORDER) {
      try {
        const current = await options.getServiceState(options.app, serviceId);
        if (current.status === "running") {
          continue;
        }

        const result = await options.startService(options.app, serviceId);
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
    const previousTask = serviceMutationQueue;
    let releaseQueue = () => {};
    serviceMutationQueue = new Promise<void>((resolve) => {
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
      return await options.startService(options.app, serviceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isPortConflictError(message)) {
        throw error;
      }

      const service = getService(serviceId);
      const currentState = await options.getServiceState(options.app, serviceId).catch(() => null);
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
      return options.startService(options.app, serviceId);
    }
  }

  return {
    ensureAssistantTargetServicesRunning,
    runServiceMutation,
    handleServiceStart
  };
}

export type ServicesRuntime = ReturnType<typeof createServicesRuntime>;
