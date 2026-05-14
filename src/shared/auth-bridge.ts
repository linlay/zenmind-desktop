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
  desktopAuthContext?: string;
  baseUrl?: string;
  embedPath?: string;
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

export function buildPluginEmbeddedUrl(
  serviceId: string | undefined,
  webUrl: string,
  options: BuildPluginEmbeddedUrlOptions = {}
): string {
  const url = parsePluginWebUrl(webUrl, options.baseUrl);
  if (!url) {
    return "";
  }

  if (serviceId === "agent-webclient") {
    const embedPath = options.embedPath?.trim() || "/appagent";
    url.pathname = embedPath.startsWith("/") ? embedPath : `/${embedPath}`;
    url.searchParams.set("desktopApp", "1");
    if (options.hostTheme) {
      url.searchParams.set("hostTheme", options.hostTheme);
    }
    if (options.desktopAuthContext?.trim()) {
      url.searchParams.set("desktopAuthContext", options.desktopAuthContext.trim());
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
