import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";

const MAX_TCP_PORT = 65535;

function parsePortValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const pieces = trimmed.split(":");
  const portText = pieces[pieces.length - 1] ?? "";
  const port = Number.parseInt(portText, 10);
  return Number.isInteger(port) && port > 0 && port <= MAX_TCP_PORT ? port : null;
}

export function parsePort(service: ServiceDefinition, env: Map<string, string>) {
  if (!service.web.portEnvKey) {
    return service.web.defaultPort;
  }

  const value = env.get(service.web.portEnvKey);
  if (value) {
    const port = parsePortValue(value);
    return port ?? service.web.defaultPort;
  }

  return service.web.defaultPort;
}

export function getWebUrl(service: ServiceDefinition, env: Map<string, string>) {
  const port = parsePort(service, env);
  if (!port) {
    return "";
  }
  const routePath = service.web.routePath;
  return routePath ? `http://127.0.0.1:${port}${routePath}` : `http://127.0.0.1:${port}`;
}
