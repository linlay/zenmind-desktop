export type ServiceWebviewAuthProtocol = {
  requestType: string;
  responseType: string;
};

export const AGENT_AUTH_REQUEST_TYPE = "desktop:agent-auth:request";
export const AGENT_AUTH_RESPONSE_TYPE = "desktop:agent-auth:response";

const SERVICE_WEBVIEW_AUTH_PROTOCOLS: Record<string, ServiceWebviewAuthProtocol> = {
  "agent-webclient": {
    requestType: AGENT_AUTH_REQUEST_TYPE,
    responseType: AGENT_AUTH_RESPONSE_TYPE
  }
};

export function getServiceWebviewAuthProtocol(
  serviceId?: string | null
): ServiceWebviewAuthProtocol | null {
  if (!serviceId) {
    return null;
  }
  return SERVICE_WEBVIEW_AUTH_PROTOCOLS[serviceId] ?? null;
}

export function isServiceWebviewAuthRequestType(
  protocol: ServiceWebviewAuthProtocol | null | undefined,
  type: string | undefined | null
) {
  return Boolean(type && protocol && type === protocol.requestType);
}

export function isServiceWebviewAuthResponseType(
  protocol: ServiceWebviewAuthProtocol | null | undefined,
  type: string | undefined | null
) {
  return Boolean(type && protocol && type === protocol.responseType);
}

export function resolveServiceWebviewAuthResponseType(protocol: ServiceWebviewAuthProtocol) {
  return protocol.responseType;
}

type BuildServiceWebviewUrlOptions = {
  hostTheme?: "light" | "dark";
  hostLocale?: "zh-CN" | "en-US";
  accessToken?: string;
  baseUrl?: string;
  embedPath?: string;
  wsSource?: string;
};

function getRuntimeUrlBase() {
  const location = (globalThis as { location?: { href?: string } }).location;
  const href = typeof location?.href === "string" ? location.href : "";
  if (!href) {
    return "http://127.0.0.1";
  }

  try {
    const parsed = new URL(href);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return href;
    }
  } catch {
    return "http://127.0.0.1";
  }

  return "http://127.0.0.1";
}

function coerceServiceWebviewUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/iu.test(trimmed)) {
    return `http://${trimmed}`;
  }

  if (/^[a-z0-9.-]+:\d+(?:[/?#]|$)/iu.test(trimmed)) {
    return `http://${trimmed}`;
  }

  return trimmed;
}

function parseServiceWebviewUrl(webUrl: string, baseUrl?: string) {
  const candidate = coerceServiceWebviewUrl(webUrl);
  if (!candidate) {
    return null;
  }

  const bases = [baseUrl, getRuntimeUrlBase(), "http://127.0.0.1"]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);

  for (const base of bases) {
    try {
      return new URL(candidate, base);
    } catch {
      // Try the next base before giving up; service URLs can be migrated from
      // relative paths while the Desktop shell itself is loaded from file://.
    }
  }

  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function normalizeServiceWebviewLocale(value: unknown) {
  return value === "zh-CN" || value === "en-US" ? value : "";
}

export function buildServiceWebviewUrl(
  serviceId: string | undefined,
  webUrl: string,
  options: BuildServiceWebviewUrlOptions = {}
): string {
  const url = parseServiceWebviewUrl(webUrl, options.baseUrl);
  if (!url) {
    return "";
  }

  if (serviceId === "identity-center") {
    url.pathname = "/admin/";
    url.search = "";
    url.hash = "";
  }
  if (serviceId === "agent-platform") {
    url.pathname = "/monitor";
    url.search = "";
    url.hash = "";
    if (options.accessToken?.trim()) {
      url.searchParams.set("access_token", options.accessToken.trim());
    }
  }
  if (serviceId === "agent-webclient") {
    const embedPath = options.embedPath?.trim() || "/";
    const embeddedUrl = new URL(embedPath.startsWith("/") ? embedPath : `/${embedPath}`, "http://agent-webclient.local");
    url.pathname = embeddedUrl.pathname;
    url.search = embeddedUrl.search;
    if (options.hostTheme) {
      url.searchParams.set(url.pathname.startsWith("/agent/") ? "theme" : "hostTheme", options.hostTheme);
    }
    const hostLocale = normalizeServiceWebviewLocale(options.hostLocale);
    if (hostLocale) {
      url.searchParams.set("lang", hostLocale);
    }
    if (options.wsSource?.trim()) {
      url.searchParams.set("wsSource", options.wsSource.trim());
    }
  }
  return url.toString();
}
