import type { ServiceState } from "./contracts";

export const CORE_SERVICE_SLOTS = [
  {
    id: "agent-container-hub",
    label: "Container Hub",
    aliases: ["Container Hub"]
  },
  {
    id: "agent-platform",
    label: "智能体平台",
    aliases: ["智能体平台"]
  },
  {
    id: "zenmind-app-server",
    label: "认证服务",
    aliases: ["认证服务", "zenmind-app-server"]
  }
] as const;

export const CORE_SERVICE_NAMES = CORE_SERVICE_SLOTS.map((slot) => slot.label);

export interface CoreServicesSummary {
  expectedCount: number;
  coreServices: ServiceState[];
  installedCount: number;
  missingInstallServices: ServiceState[];
}

function resolveCoreService(services: ServiceState[], slot: (typeof CORE_SERVICE_SLOTS)[number]) {
  const aliases = slot.aliases as readonly string[];
  return services.find((service) => service.id === slot.id)
    ?? services.find((service) => aliases.includes(service.name));
}

export function getOrderedCoreServices(services: ServiceState[]) {
  return CORE_SERVICE_SLOTS.map((slot) => resolveCoreService(services, slot)).filter(
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
