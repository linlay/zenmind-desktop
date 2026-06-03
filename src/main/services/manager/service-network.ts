import type { ServiceDefinition } from "../../manifest-utils";

const MAX_TCP_PORT = 65535;

export const DESKTOP_MANAGED_PLATFORM_URL_PORTS = new Set([
  "7078",
  "11949",
  "18081",
  "7200",
  "7000",
  "11953",
  "117078"
]);
export const DESKTOP_MANAGED_CONTAINER_HUB_URL_PORTS = new Set(["7079", "11960", "117079"]);
export const LOCAL_SERVICE_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);
export const CONTAINER_HUB_SERVICE_HOSTS = new Set([...LOCAL_SERVICE_HOSTS, "host.docker.internal"]);

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

export function getServicePortEnvKeys(service: ServiceDefinition) {
  return service.web.portEnvKey ? [service.web.portEnvKey] : [];
}

export function parsePort(service: ServiceDefinition, env: Map<string, string>) {
  const portEnvKeys = getServicePortEnvKeys(service);
  if (portEnvKeys.length === 0) {
    return service.web.defaultPort;
  }

  for (const key of portEnvKeys) {
    const value = env.get(key);
    if (!value) {
      continue;
    }
    const port = parsePortValue(value);
    if (port) {
      return port;
    }
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

function normalizeUrlHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
}

function readHttpUrlHostPort(value: string) {
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return {
      hostname: normalizeUrlHostname(parsed.hostname),
      port: parsed.port
    };
  } catch {
    // URL rejects invalid TCP ports such as 117078; those stale desktop-managed
    // defaults still need to be recognized and migrated.
  }

  const match = raw.match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::([0-9]+))?(?:[/?#]|$)/iu);
  if (!match) {
    return null;
  }

  return {
    hostname: normalizeUrlHostname(match[1] ?? ""),
    port: match[2] ?? ""
  };
}

export function isDesktopManagedHttpUrl(
  value: string,
  managedPorts: Set<string>,
  managedHosts: Set<string>,
  allowMissingPort = false
) {
  const parsed = readHttpUrlHostPort(value);
  if (!parsed || !managedHosts.has(parsed.hostname)) {
    return false;
  }
  if (!parsed.port) {
    return allowMissingPort;
  }
  return managedPorts.has(parsed.port);
}
