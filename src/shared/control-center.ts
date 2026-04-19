import type { ServiceState } from "./contracts";

export const CORE_SERVICE_NAMES = ["Container Hub", "智能体平台", "认证服务"] as const;

export interface CoreServicesSummary {
  expectedCount: number;
  coreServices: ServiceState[];
  installedCount: number;
  missingInstallServices: ServiceState[];
}

export function getOrderedCoreServices(services: ServiceState[]) {
  return CORE_SERVICE_NAMES.map((name) => services.find((service) => service.name === name)).filter(
    (service): service is ServiceState => Boolean(service)
  );
}

export function summarizeCoreServices(services: ServiceState[]): CoreServicesSummary {
  const coreServices = getOrderedCoreServices(services);
  const missingInstallServices = coreServices.filter((service) => service.kind === "builtin" && !service.installed);

  return {
    expectedCount: CORE_SERVICE_NAMES.length,
    coreServices,
    installedCount: coreServices.filter((service) => service.installed).length,
    missingInstallServices
  };
}
