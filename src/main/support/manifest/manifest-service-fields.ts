import {
  type FrontendMode,
  type ServiceKind,
  type ManifestCommand,
  type ManifestFrontend,
  type ServiceMode,
  type ManifestScripts,
  type ManifestConfigFile,
  type ManifestRuntime,
  type ManifestApi,
  type ManifestBackend,
  type ManifestWeb
} from "../../../shared/contracts";
import { asStringArray, asObject, asOptionalString, asBoolean, asString, asNumber } from "./manifest-values";

export function isFrontendMode(value: unknown): value is FrontendMode {
  return value === "none" || value === "embedded" || value === "standalone";
}

export function isServiceKind(value: unknown): value is ServiceKind {
  return value === "builtin" || value === "plugin";
}

export function toManifestCommand(value: unknown): ManifestCommand | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  const parts = asStringArray(value);
  return parts.length > 0 ? parts : undefined;
}

export function resolveFrontend(raw: Record<string, unknown>) {
  const frontend = asObject(raw.frontend);
  const service = asObject(raw.service);
  const mode = isFrontendMode(frontend.mode)
    ? frontend.mode
    : isFrontendMode(service.ui)
    ? service.ui
    : "none";

  return {
    mode,
    entry: asOptionalString(frontend.entry),
    assetsPrefix: asOptionalString(frontend.assetsPrefix),
    directAccess: asBoolean(frontend.directAccess),
    hostManaged: asBoolean(frontend.hostManaged),
    dist: asOptionalString(frontend.dist),
    index: asOptionalString(frontend.index),
    spa: asBoolean(frontend.spa)
  } satisfies ManifestFrontend;
}

export function hasPluginResources(raw: Record<string, unknown>) {
  const resources = asObject(raw.resources);
  return (
    Array.isArray(resources.webapps) ||
    Array.isArray(resources.agents) ||
    Array.isArray(resources.automations)
  );
}

export function resolveServiceMode(raw: Record<string, unknown>): ServiceMode {
  const scripts = asObject(raw.scripts);
  const lifecycle = asObject(raw.lifecycle);
  const hasStartOrStop =
    lifecycle.start !== undefined ||
    lifecycle.stop !== undefined ||
    scripts.start !== undefined ||
    scripts.stop !== undefined;
  return hasStartOrStop || !hasPluginResources(raw) ? "service" : "resource";
}

export function resolveScripts(raw: Record<string, unknown>, serviceMode: ServiceMode) {
  const scripts = asObject(raw.scripts);
  const lifecycle = asObject(raw.lifecycle);

  const start = toManifestCommand(lifecycle.start) ?? toManifestCommand(scripts.start);
  const stop = toManifestCommand(lifecycle.stop) ?? toManifestCommand(scripts.stop);
  const deploy = toManifestCommand(lifecycle.deploy) ?? toManifestCommand(scripts.deploy);

  if ((!start || !stop) && serviceMode === "service") {
    throw new Error("manifest lifecycle.start/stop are required");
  }

  return {
    start: start ?? [],
    stop: stop ?? [],
    deploy
  } satisfies ManifestScripts;
}

export function resolveConfigFiles(raw: Record<string, unknown>) {
  if (!Array.isArray(raw.configFiles)) {
    return [];
  }

  return raw.configFiles.map((item) => {
    const config = asObject(item);
    return {
      key: asString(config.key),
      label: asString(config.label),
      relativePath: asString(config.relativePath),
      templateRelativePath: asOptionalString(config.templateRelativePath),
      required: config.required !== false
    } satisfies ManifestConfigFile;
  });
}

export function resolveServiceConfigFiles(raw: Record<string, unknown>, _serviceId: string) {
  return resolveConfigFiles(raw);
}

export function resolveRuntime(raw: Record<string, unknown>) {
  const runtime = asObject(raw.runtime);
  return {
    pidRelativePath: asOptionalString(runtime.pidRelativePath) ?? "",
    logRelativePath: asOptionalString(runtime.logRelativePath) ?? "",
    errorLogRelativePath: asOptionalString(runtime.errorLogRelativePath) ?? "",
    requiredPaths: asStringArray(runtime.requiredPaths)
  } satisfies ManifestRuntime & {
    pidRelativePath: string;
    logRelativePath: string;
    errorLogRelativePath: string;
    requiredPaths: string[];
  };
}

export function applyCoreServiceRuntimeOverride(serviceId: string, runtime: ReturnType<typeof resolveRuntime>) {
  if (serviceId !== "agent-platform") {
    return runtime;
  }

  return {
    ...runtime,
    pidRelativePath: "run/agent-platform.pid",
    logRelativePath: "run/agent-platform.log"
  };
}

export function resolveApi(raw: Record<string, unknown>) {
  if (raw.api === undefined) {
    return undefined;
  }
  const api = asObject(raw.api);
  return {
    enabled: api.enabled !== false,
    adminBaseUrl: asOptionalString(api.adminBaseUrl),
    openidBaseUrl: asOptionalString(api.openidBaseUrl),
    oauth2BaseUrl: asOptionalString(api.oauth2BaseUrl)
  } satisfies ManifestApi;
}

export function resolveBackend(raw: Record<string, unknown>) {
  if (raw.backend === undefined) {
    return undefined;
  }
  const backend = asObject(raw.backend);
  const entry = asOptionalString(backend.entry);
  return entry ? ({ entry } satisfies ManifestBackend) : undefined;
}

export function resolveWeb(raw: Record<string, unknown>) {
  const service = asObject(raw.service);
  const serviceWeb = asObject(service.web);
  if (raw.web === undefined && service.web === undefined) {
    return {
      routePath: "",
      portEnvKey: "",
      defaultPort: 0
    } satisfies ManifestWeb;
  }

  const web = asObject(raw.web);
  return {
    routePath: asString(serviceWeb.healthPath) || asString(web.routePath),
    portEnvKey: asString(serviceWeb.portEnvKey) || asString(web.portEnvKey),
    defaultPort: asNumber(serviceWeb.defaultPort) ?? asNumber(web.defaultPort) ?? 0
  } satisfies ManifestWeb;
}
