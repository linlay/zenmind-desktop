import { type App } from "electron";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { type ServiceId } from "../../../../shared/contracts";
import { orderServiceIdsForRestore, getServiceIdsToRestore, isNonBlockingRestoreFailure } from "./state-files";
import { getResourcePluginServiceIdsToRestore, isResourcePluginServiceId } from "./restore-policy";
import { getService } from "../service-registry";
import { getServiceState } from "./service-state";
import { startService } from "./service-start";

export async function restoreRunningServices(
  app: App,
  options: {
    integrationPorts?: ServicesIntegrationPorts;
    onStarting?: (serviceId: ServiceId) => void;
    onProgress?: (serviceId: ServiceId, phase: "succeeded" | "failed" | "skipped", message: string) => void;
  } = {}
) {
  const serviceIds = orderServiceIdsForRestore([
    ...getServiceIdsToRestore(app),
    ...getResourcePluginServiceIdsToRestore(app, options.integrationPorts)
  ]);
  const restored: ServiceId[] = [];
  const failures: string[] = [];

  for (const serviceId of serviceIds) {
    try {
      getService(serviceId);
    } catch {
      continue;
    }

    try {
      const current = await getServiceState(app, serviceId, {
        integrationPorts: options.integrationPorts
      });
      if (
        (current.kind === "plugin" && current.status === "not-installed") ||
        current.status === "initialization-required"
      ) {
        options.onProgress?.(serviceId, "skipped", current.message);
        continue;
      }

      options.onStarting?.(serviceId);
      const startedAt = Date.now();
      const result = await startService(app, serviceId, options.integrationPorts);
      const elapsedMs = Date.now() - startedAt;
      if (result.ok) {
        console.info(`[service-manager] restored ${serviceId} in ${elapsedMs}ms`);
        restored.push(serviceId);
        options.onProgress?.(serviceId, "succeeded", result.message);
      } else {
        console.warn(`[service-manager] failed to restore ${serviceId} after ${elapsedMs}ms: ${result.message}`);
        options.onProgress?.(serviceId, "failed", result.message);
        if (isNonBlockingRestoreFailure(serviceId) || isResourcePluginServiceId(serviceId)) {
          continue;
        }
        failures.push(`${serviceId}: ${result.message}`);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onProgress?.(serviceId, "failed", message);
      if (isNonBlockingRestoreFailure(serviceId) || isResourcePluginServiceId(serviceId)) {
        continue;
      }
      failures.push(`${serviceId}: ${message}`);
      break;
    }
  }

  return {
    restored,
    failures
  };
}
