import type { ServiceState, StartupRestoreState } from "./contracts";

const STARTUP_WAITING_STATUSES = new Set<ServiceState["status"]>([
  "not-installed",
  "stopped"
]);

const STARTUP_BLOCKING_STATUSES = new Set<ServiceState["status"]>([
  "initialization-required",
  "config-required",
  "dependency-missing",
  "error"
]);

export function isStartupServiceWaiting(service: ServiceState | null) {
  if (!service) {
    return true;
  }
  return STARTUP_WAITING_STATUSES.has(service.status);
}

export function getStartupBlockingService(startupServices: Array<ServiceState | null>, servicesLoading: boolean) {
  if (servicesLoading) {
    return null;
  }
  return startupServices.find((service) => service !== null && STARTUP_BLOCKING_STATUSES.has(service.status)) ?? null;
}

export type StartupSurfaceMode = "loading" | "slow" | "failed";

export function resolveStartupSurfaceMode(
  startupRestoreState: StartupRestoreState | null,
  startupAllReady: boolean,
  timedOut: boolean,
  currentPathname = "/"
): StartupSurfaceMode | null {
  if (currentPathname === "/settings" || currentPathname.startsWith("/settings/")) {
    return null;
  }

  if (startupAllReady) {
    return null;
  }

  if (
    startupRestoreState?.phase === "env-import-required"
  ) {
    return null;
  }

  if (
    startupRestoreState?.phase === "failed" ||
    startupRestoreState?.phase === "succeeded"
  ) {
    return "failed";
  }

  return timedOut ? "slow" : "loading";
}
