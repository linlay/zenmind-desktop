import {
  type ManifestDesktopHosting,
  type ManifestDesktopDisabledResponse,
  type ManifestDesktopProxyRoute,
  type ManifestFrontend,
  DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING
} from "../../../shared/contracts";
import {
  cloneDisabledResponse,
  asObject,
  asNumber,
  asOptionalString,
  normalizeRoutePath,
  asBoolean,
  asStringArray
} from "./manifest-values";

export function cloneDesktopHosting(hosting: ManifestDesktopHosting): ManifestDesktopHosting {
  return {
    ...(hosting.runtimeConfig
      ? {
          runtimeConfig: {
            ...(hosting.runtimeConfig.path === undefined ? {} : { path: hosting.runtimeConfig.path }),
            ...(hosting.runtimeConfig.envKeys === undefined ? {} : { envKeys: [...hosting.runtimeConfig.envKeys] })
          }
        }
      : {}),
    ...(hosting.spaRoutes === undefined ? {} : { spaRoutes: [...hosting.spaRoutes] }),
    ...(hosting.proxyRoutes === undefined
      ? {}
      : {
          proxyRoutes: hosting.proxyRoutes.map((route) => ({
            ...route,
            ...(route.ssePaths === undefined ? {} : { ssePaths: [...route.ssePaths] }),
            ...(route.stripRequestHeaders === undefined ? {} : { stripRequestHeaders: [...route.stripRequestHeaders] }),
            ...(route.disabledResponse === undefined ? {} : { disabledResponse: cloneDisabledResponse(route.disabledResponse) })
          }))
        })
  };
}

export function resolveDesktopDisabledResponse(value: unknown): ManifestDesktopDisabledResponse | undefined {
  if (value === undefined) {
    return undefined;
  }
  const response = asObject(value);
  const status = asNumber(response.status);
  const result: ManifestDesktopDisabledResponse = {
    status: status && status >= 100 && status <= 599 ? Math.trunc(status) : 404
  };
  if ("json" in response) {
    result.json = response.json;
  }
  const body = asOptionalString(response.body);
  if (body !== undefined) {
    result.body = body;
  }
  const contentType = asOptionalString(response.contentType);
  if (contentType !== undefined) {
    result.contentType = contentType;
  }
  return result;
}

export function resolveDesktopProxyRoutes(value: unknown): ManifestDesktopProxyRoute[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const routes: ManifestDesktopProxyRoute[] = [];
  for (const item of value) {
    const route = asObject(item);
    const match = route.match === "exact" || route.match === "prefix" ? route.match : "";
    const routePath = normalizeRoutePath(route.path);
    const targetEnv = asOptionalString(route.targetEnv);
    if (!match || !routePath || !targetEnv) {
      continue;
    }
    const entry: ManifestDesktopProxyRoute = {
      match,
      path: routePath,
      targetEnv
    };
    const httpEnabled = asBoolean(route.http);
    if (httpEnabled !== undefined) entry.http = httpEnabled;
    const websocket = asBoolean(route.websocket);
    if (websocket !== undefined) entry.websocket = websocket;
    const optional = asBoolean(route.optional);
    if (optional !== undefined) entry.optional = optional;
    if (route.auth === "agent-platform-access-token") {
      entry.auth = route.auth;
    }
    const ssePaths = asStringArray(route.ssePaths).map(normalizeRoutePath).filter(Boolean);
    if (ssePaths.length > 0) {
      entry.ssePaths = ssePaths;
    }
    const disableProxyBuffering = asBoolean(route.disableProxyBuffering);
    if (disableProxyBuffering !== undefined) entry.disableProxyBuffering = disableProxyBuffering;
    const stripRequestHeaders = asStringArray(route.stripRequestHeaders);
    if (stripRequestHeaders.length > 0) {
      entry.stripRequestHeaders = stripRequestHeaders;
    }
    const disabledResponse = resolveDesktopDisabledResponse(route.disabledResponse);
    if (disabledResponse) {
      entry.disabledResponse = disabledResponse;
    }
    routes.push(entry);
  }
  return routes;
}

export function resolveDesktopHosting(raw: Record<string, unknown>) {
  const desktop = asObject(raw.desktop);
  if (desktop.hosting === undefined) {
    return undefined;
  }

  const hosting = asObject(desktop.hosting);
  const runtimeConfig = asObject(hosting.runtimeConfig);
  const runtimeConfigPath = normalizeRoutePath(runtimeConfig.path);
  const runtimeConfigEnvKeys = asStringArray(runtimeConfig.envKeys);
  const result: ManifestDesktopHosting = {};
  if (runtimeConfigPath || runtimeConfigEnvKeys.length > 0) {
    result.runtimeConfig = {
      ...(runtimeConfigPath ? { path: runtimeConfigPath } : {}),
      ...(runtimeConfigEnvKeys.length > 0 ? { envKeys: runtimeConfigEnvKeys } : {})
    };
  }

  const spaRoutes = asStringArray(hosting.spaRoutes).map(normalizeRoutePath).filter(Boolean);
  if (spaRoutes.length > 0) {
    result.spaRoutes = spaRoutes;
  }

  const proxyRoutes = resolveDesktopProxyRoutes(hosting.proxyRoutes);
  if (proxyRoutes.length > 0) {
    result.proxyRoutes = proxyRoutes;
  }

  return result;
}

export function resolveDefaultDesktopHosting(serviceId: string, frontend: ManifestFrontend) {
  if (serviceId === "agent-webclient" && frontend.hostManaged === true) {
    return cloneDesktopHosting(DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING);
  }
  return undefined;
}

export function assertAgentWebclientPlatformFramePortHosting(
  serviceId: string,
  frontend: ManifestFrontend,
  hosting: ManifestDesktopHosting | undefined,
) {
  if (serviceId !== "agent-webclient" || frontend.hostManaged !== true) return;
  const routes = hosting?.proxyRoutes ?? [];
  if (routes.some((route) => route.path === "/auth" || route.path === "/ws")) {
    throw new Error("agent-webclient Frame Port manifest must not expose /auth or /ws");
  }
  const apiRoute = routes.find((route) => route.match === "prefix" && route.path === "/api");
  if (
    !apiRoute ||
    apiRoute.targetEnv !== "BASE_URL" ||
    apiRoute.auth !== "agent-platform-access-token" ||
    apiRoute.http !== true ||
    apiRoute.websocket === true ||
    Boolean(apiRoute.ssePaths?.length)
  ) {
    throw new Error(
      "agent-webclient Frame Port manifest requires an HTTP-only authenticated /api route without SSE overrides",
    );
  }
  if (routes.some((route) => route.targetEnv === "BASE_URL" && route.websocket === true)) {
    throw new Error("agent-webclient Frame Port manifest forbids Agent Platform WebSocket proxy routes");
  }
}
