import type { Manifest, ServiceId, ServiceKind } from "../../shared/contracts";
import { normalizeManifest, type NormalizeManifestOptions, type ServiceDefinition } from "../manifest-utils";

const services = new Map<ServiceId, ServiceDefinition>();

export function registerService(manifest: Manifest, options: NormalizeManifestOptions = {}) {
  const definition = normalizeManifest(manifest, options);
  services.set(definition.id, definition);
  return definition;
}

export function unregisterService(serviceId: string) {
  services.delete(serviceId);
}

export function getAllServices() {
  return [...services.values()];
}

export function getService(serviceId: ServiceId) {
  const service = services.get(serviceId);
  if (!service) {
    throw new Error(`unknown service id: ${serviceId}`);
  }
  return service;
}

export function clearServices(kind?: ServiceKind) {
  if (!kind) {
    services.clear();
    return;
  }

  for (const [serviceId, service] of services) {
    if (service.kind === kind) {
      services.delete(serviceId);
    }
  }
}

export const registerPlugin = registerService;
export const unregisterPlugin = unregisterService;
export const getBuiltinService = getService;

export const __testInternals = {
  clearServices
};
