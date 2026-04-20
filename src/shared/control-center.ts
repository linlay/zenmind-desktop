import type { ServiceState } from "./contracts";

export interface CoreServicesSummary {
  expectedCount: number;
  coreServices: ServiceState[];
  installedCount: number;
  missingInstallServices: ServiceState[];
}

export function getOrderedCoreServices(services: ServiceState[]) {
  return services
    .filter((service) => service.kind === "builtin")
    .sort((left, right) => {
      const orderDiff = (left.desktop.displayOrder ?? 99) - (right.desktop.displayOrder ?? 99);
      if (orderDiff !== 0) {
        return orderDiff;
      }
      return left.name.localeCompare(right.name, "zh-Hans-CN");
    });
}

export function summarizeCoreServices(services: ServiceState[]): CoreServicesSummary {
  const coreServices = getOrderedCoreServices(services);
  const missingInstallServices = coreServices.filter((service) => !service.installed);

  return {
    expectedCount: coreServices.length,
    coreServices,
    installedCount: coreServices.filter((service) => service.installed).length,
    missingInstallServices
  };
}
