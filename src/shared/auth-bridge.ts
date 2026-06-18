export type PluginAuthBridgeProtocol = {
  requestType: string;
  responseType: string;
};

const AUTH_BRIDGE_PROTOCOLS: Record<string, PluginAuthBridgeProtocol> = {
  "agent-webclient": {
    requestType: "zenmind:agent-app-auth:request",
    responseType: "zenmind:agent-app-auth:response"
  },
  "pan-webclient": {
    requestType: "zenmind:pan-app-auth:request",
    responseType: "zenmind:pan-app-auth:response"
  }
};

export function getPluginAuthBridgeProtocol(
  serviceId?: string | null
): PluginAuthBridgeProtocol | null {
  if (!serviceId) {
    return null;
  }
  return AUTH_BRIDGE_PROTOCOLS[serviceId] ?? null;
}

type BuildPluginEmbeddedUrlOptions = {
  hostTheme?: "light" | "dark";
  hostLocale?: "zh-CN" | "en-US";
  desktopAuthContext?: string;
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

function coercePluginWebUrl(value: string) {
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

function parsePluginWebUrl(webUrl: string, baseUrl?: string) {
  const candidate = coercePluginWebUrl(webUrl);
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

function normalizePluginLocale(value: unknown) {
  return value === "zh-CN" || value === "en-US" ? value : "";
}

export function buildPluginEmbeddedUrl(
  serviceId: string | undefined,
  webUrl: string,
  options: BuildPluginEmbeddedUrlOptions = {}
): string {
  const url = parsePluginWebUrl(webUrl, options.baseUrl);
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
    const hostLocale = normalizePluginLocale(options.hostLocale);
    if (hostLocale) {
      url.searchParams.set("lang", hostLocale);
    }
    if (options.desktopAuthContext?.trim()) {
      url.searchParams.set("desktopAuthContext", options.desktopAuthContext.trim());
    }
    if (options.wsSource?.trim()) {
      url.searchParams.set("wsSource", options.wsSource.trim());
    }
  }
  if (serviceId === "pan-webclient") {
    url.searchParams.set("desktopApp", "1");
    if (options.hostTheme) {
      url.searchParams.set("hostTheme", options.hostTheme);
    }
  }
  return url.toString();
}
