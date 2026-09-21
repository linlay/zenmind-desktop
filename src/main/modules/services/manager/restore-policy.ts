import { type App } from "electron";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { getAllServices, getService } from "../service-registry";
import { integrationPorts } from "./manager-contracts";
import { type ServiceId } from "../../../../shared/contracts";

export function getResourcePluginServiceIdsToRestore(app: App, ports?: ServicesIntegrationPorts) {
  return getAllServices()
    .filter((service) =>
      service.kind === "plugin" &&
      service.serviceMode === "resource" &&
      integrationPorts(ports).readPluginResourceDesiredStatus(app, service) === "running"
    )
    .map((service) => service.id);
}

export function isResourcePluginServiceId(serviceId: ServiceId) {
  try {
    const service = getService(serviceId);
    return service.kind === "plugin" && service.serviceMode === "resource";
  } catch {
    return false;
  }
}
