import type { ServiceState } from "./contracts";

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
