import type { ServiceState } from "@shared/contracts";

function appendEndpointPath(baseUrl: string, endpointPath: string) {
  const normalizedBaseUrl = baseUrl.trim();
  if (!normalizedBaseUrl) {
    return "";
  }

  try {
    const url = new URL(normalizedBaseUrl);
    const normalizedEndpointPath = endpointPath.startsWith("/")
      ? endpointPath
      : `/${endpointPath}`;
    if (url.pathname === normalizedEndpointPath) {
      return url.toString();
    }
    url.pathname = normalizedEndpointPath;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const trimmedEndpointPath = endpointPath.startsWith("/")
      ? endpointPath
      : `/${endpointPath}`;
    return `${normalizedBaseUrl.replace(/\/+$/u, "")}${trimmedEndpointPath}`;
  }
}

export function resolveControlCenterEndpoint(service: ServiceState) {
  const baseUrl = service.healthMeta.webUrl;
  if (service.id === "identity-center") {
    return appendEndpointPath(baseUrl, "/admin/");
  }
  if (service.id === "agent-platform") {
    return appendEndpointPath(baseUrl, "/monitor");
  }
  return baseUrl;
}

export function shouldOpenControlCenterEndpointInternally(service: ServiceState) {
  return service.frontendMode !== "none" || service.id === "agent-platform";
}
