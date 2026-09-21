import { type ServiceId, type ServiceState } from "../../../../shared/contracts";
import { WINDOWS_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS, SHUTDOWN_SERVICE_STOP_TIMEOUT_MS } from "./manager-contracts";
import { type App } from "electron";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { getService } from "../service-registry";
import { isHostManagedService } from "./host-policy";
import { stopAgentWebclientHost } from "../agent-webclient-host";
import { runServiceCommand } from "./service-command";
import { t } from "../../../support/i18n/main-i18n";
import { startedThisSession } from "./session-state";
import { listServices } from "./service-state";
import { writeLastRunningServices } from "./state-files";

export type ShutdownServiceStopResult = {
  ok: boolean;
  serviceId: ServiceId;
  serviceName: string;
  elapsedMs: number;
  message: string;
};

export function getShutdownStopCommandTimeoutMs(timeoutMs: number | undefined, platform: NodeJS.Platform | string = process.platform) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : platform === "win32"
      ? WINDOWS_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS
      : SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function stopServiceForShutdown(
  app: App,
  serviceState: ServiceState,
  timeoutMs: number,
  ports?: ServicesIntegrationPorts
): Promise<ShutdownServiceStopResult> {
  const service = getService(serviceState.id);
  const startedAt = Date.now();

  try {
    if (isHostManagedService(service)) {
      await stopAgentWebclientHost(service.id);
    } else {
      await runServiceCommand(app, service, service.stopCommand, t("service.stopped", { name: service.name }), {
        refreshBuiltinAsset: false,
        commandKind: "stop",
        timeoutMs,
        integrationPorts: ports
      });
    }
    startedThisSession.delete(service.id);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[service-manager] shutdown stop succeeded for ${service.id} in ${elapsedMs}ms`);
    return {
      ok: true,
      serviceId: service.id,
      serviceName: service.name,
      elapsedMs,
      message: ""
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = getErrorMessage(error);
    console.warn(`[service-manager] shutdown stop failed for ${service.id} after ${elapsedMs}ms: ${message}`);
    return {
      ok: false,
      serviceId: service.id,
      serviceName: service.name,
      elapsedMs,
      message
    };
  }
}

export async function stopRunningServicesForShutdown(
  app: App,
  options: { stopCommandTimeoutMs?: number; integrationPorts?: ServicesIntegrationPorts } = {}
) {
  const startedAt = Date.now();
  const timeoutMs = getShutdownStopCommandTimeoutMs(options.stopCommandTimeoutMs);
  const services = await listServices(app, options.integrationPorts);
  const runningServices = services.filter((service) => service.status === "running");
  const servicesToStop = runningServices.filter((service) => service.serviceMode !== "resource");
  writeLastRunningServices(
    app,
    runningServices.map((service) => service.id)
  );

  if (servicesToStop.length === 0) {
    console.log("[service-manager] shutdown stop skipped: no stoppable running services");
    return {
      ok: true,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      runningServiceIds: runningServices.map((service) => service.id),
      runningServicePorts: runningServices.flatMap((service) =>
        service.healthMeta.port
          ? [{ serviceId: service.id, port: service.healthMeta.port }]
          : []
      ),
      stopped: [] as ShutdownServiceStopResult[],
      failures: [] as ShutdownServiceStopResult[]
    };
  }

  const results = await Promise.all(
    servicesToStop.map((service) => stopServiceForShutdown(
      app,
      service,
      timeoutMs,
      options.integrationPorts
    ))
  );
  const stopped = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `[service-manager] shutdown stop summary: services=${servicesToStop.length} stopped=${stopped.length} failed=${failures.length} elapsedMs=${elapsedMs} timeoutMs=${timeoutMs}`
  );

  return {
    ok: failures.length === 0,
    timeoutMs,
    elapsedMs,
    runningServiceIds: runningServices.map((service) => service.id),
    runningServicePorts: runningServices.flatMap((service) =>
      service.healthMeta.port
        ? [{ serviceId: service.id, port: service.healthMeta.port }]
        : []
    ),
    stopped,
    failures
  };
}
