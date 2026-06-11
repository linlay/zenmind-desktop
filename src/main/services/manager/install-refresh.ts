import type { ServiceDefinition } from "../../manifest-utils";

// Service-specific internals must not trigger reinstall. Generic refresh and
// repair are driven by bundled asset signatures, init-state, and required paths.
export function agentWebclientInstallNeedsRefresh(_installDir: string) {
  return false;
}

export function zenmindAppServerInstallNeedsRefresh(_installDir: string) {
  return false;
}

export function agentPlatformInstallNeedsRefresh(_installDir: string) {
  return false;
}

export function serviceInstallNeedsRefresh(_service: ServiceDefinition, _installDir: string) {
  return false;
}
