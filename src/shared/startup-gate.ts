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

export function shouldShowStartupProgressCard(
  startupRestoreState: StartupRestoreState | null,
  startupAllReady: boolean,
  currentPathname = "/"
) {
  if (currentPathname === "/settings") {
    return false;
  }

  if (!startupRestoreState) {
    return !startupAllReady;
  }

  if (startupRestoreState.phase === "env-import-required") {
    return false;
  }

  if (startupAllReady) {
    return false;
  }

  if (startupRestoreState.phase === "succeeded") {
    return false;
  }

  return (
    startupRestoreState.phase === "idle" ||
    startupRestoreState.phase === "running" ||
    startupRestoreState.phase === "failed"
  );
}
