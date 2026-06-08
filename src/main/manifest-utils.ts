import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING
} from "../shared/contracts";
import type {
  FrontendMode,
  Manifest,
  ManifestApi,
  ManifestBackend,
  ManifestCommand,
  ManifestConfigFile,
  ManifestDesktop,
  ManifestDesktopCapabilities,
  ManifestDesktopCapabilityProvider,
  ManifestDesktopCapabilityRequirement,
  ManifestDesktopDisabledResponse,
  ManifestDesktopHosting,
  ManifestDesktopProxyRoute,
  ManifestEnvBinding,
  ManifestFrontend,
  ManifestRuntime,
  ManifestScripts,
  ManifestWeb,
  ServiceId,
  ServiceKind
} from "../shared/contracts";
import { listArchiveEntries, readFileFromArchive } from "./archive-utils";

export interface ServiceImportTarget {
  key: string;
  label: string;
  relativePath: string;
  required: boolean;
}

export interface ServiceDefinition extends Manifest {
  id: ServiceId;
  description: string;
  frontend: ManifestFrontend & { mode: FrontendMode };
  frontendMode: FrontendMode;
  configFiles: ManifestConfigFile[];
  runtime: ManifestRuntime & {
    pidRelativePath: string;
    logRelativePath: string;
    errorLogRelativePath: string;
    requiredPaths: string[];
  };
  web: ManifestWeb;
  prerequisites: string[];
  desktop: ManifestDesktop & {
    bundleTopLevelDir: string;
    envBindings: ManifestEnvBinding[];
    capabilities: ManifestDesktopCapabilities & {
      provides: ManifestDesktopCapabilityProvider[];
      requires: ManifestDesktopCapabilityRequirement[];
    };
  };
  assetFileName: string;
  bundleTopLevelDir: string;
  startCommand: string[];
  stopCommand: string[];
  deployCommand: string[] | null;
  importTargets: ServiceImportTarget[];
}

export interface NormalizeManifestOptions {
  defaultKind?: ServiceKind;
  desktop?: Partial<ManifestDesktop>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asOptionalString(value: unknown) {
  const next = asString(value).trim();
  return next ? next : undefined;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringRecord(value: unknown) {
  const record = asObject(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

type CorePortEnvBinding = {
  key: string;
  value: string;
  defaults: string[];
};

type CoreServicePortOverride = {
  portEnvKey: string;
  defaultPort: number;
  portBindings: CorePortEnvBinding[];
  urlBindingDefaults?: Record<string, string[]>;
};

const sharedCoreServicePortOverrides: Record<string, CoreServicePortOverride> = {
  "agent-container-hub": {
    portEnvKey: "BIND_ADDR",
    defaultPort: 7079,
    portBindings: [
      {
        key: "BIND_ADDR",
        value: "127.0.0.1:{{serviceDefaultPort}}",
        defaults: ["", "127.0.0.1:11960", "localhost:11960", "127.0.0.1:117079", "localhost:117079"]
      }
    ]
  },
  "agent-platform": {
    portEnvKey: "SERVER_PORT",
    defaultPort: 7078,
    portBindings: [
      {
        key: "SERVER_PORT",
        value: "{{serviceDefaultPort}}",
        defaults: ["", "11949", "18081", "7200", "117078"]
      }
    ],
    urlBindingDefaults: {
      CONTAINER_HUB_BASE_URL: [
        "",
        "http://127.0.0.1:7079",
        "http://localhost:7079",
        "http://127.0.0.1:11960",
        "http://localhost:11960",
        "http://host.docker.internal:11960",
        "http://127.0.0.1:117079",
        "http://localhost:117079",
        "http://host.docker.internal:117079"
      ]
    }
  },
  "agent-webclient": {
    portEnvKey: "PORT",
    defaultPort: 7080,
    portBindings: [
      {
        key: "PORT",
        value: "{{serviceDefaultPort}}",
        defaults: ["", "11948", "18082", "117080"]
      }
    ],
    urlBindingDefaults: {
      BASE_URL: [
        "",
        "http://127.0.0.1:7078",
        "http://localhost:7078",
        "http://127.0.0.1:11949",
        "http://localhost:11949",
        "http://127.0.0.1:18081",
        "http://localhost:18081",
        "http://127.0.0.1:117078",
        "http://localhost:117078",
        "http://127.0.0.1:7200",
        "http://localhost:7200",
        "http://127.0.0.1:7000",
        "http://localhost:7000"
      ]
    }
  },
  "zenmind-app-server": {
    portEnvKey: "SERVER_PORT",
    defaultPort: 7076,
    portBindings: [
      {
        key: "SERVER_PORT",
        value: "{{serviceDefaultPort}}",
        defaults: ["", "11950", "18080", "9000", "117076"]
      }
    ]
  }
};

const testCoreServicePortOffsets: Record<string, number> = {
  "agent-webclient": 0,
  "agent-platform": 1,
  "zenmind-app-server": 2,
  "agent-container-hub": 3
};

function getTestCoreServicePortBase() {
  const raw = (process.env.DESKTOP_TEST_CORE_SERVICE_PORT_BASE ?? process.env.ZENMIND_TEST_CORE_SERVICE_PORT_BASE)?.trim() ?? "";
  if (!raw || !/^\d+$/u.test(raw)) {
    return null;
  }

  const portBase = Number.parseInt(raw, 10);
  return Number.isInteger(portBase) && portBase > 0 && portBase + 3 <= 65535
    ? portBase
    : null;
}

function applyTestCoreServicePortBase(
  overrides: Record<string, CoreServicePortOverride>,
  portBase: number | null
) {
  if (!portBase) {
    return overrides;
  }

  return Object.fromEntries(Object.entries(overrides).map(([serviceId, override]) => {
    const offset = testCoreServicePortOffsets[serviceId];
    return [
      serviceId,
      offset === undefined
        ? override
        : {
            ...override,
            defaultPort: portBase + offset
          }
    ];
  }));
}

function getCoreServicePortOverrides(): Record<string, CoreServicePortOverride> {
  // The defaults are currently shared, but builtin service manifests are platform-specific.
  if (process.platform === "win32") {
    return applyTestCoreServicePortBase(sharedCoreServicePortOverrides, getTestCoreServicePortBase());
  }

  if (process.platform === "darwin") {
    return applyTestCoreServicePortBase(sharedCoreServicePortOverrides, getTestCoreServicePortBase());
  }

  return applyTestCoreServicePortBase(sharedCoreServicePortOverrides, getTestCoreServicePortBase());
}

function getCoreServicePortOverride(serviceId: string) {
  return getCoreServicePortOverrides()[serviceId];
}

function mergeStringList(left: readonly string[] = [], right: readonly string[] = []) {
  return [...new Set([...left, ...right])];
}

function applyCoreServiceWebOverride(serviceId: string, web: ManifestWeb) {
  const override = getCoreServicePortOverride(serviceId);
  if (!override) {
    return web;
  }

  return {
    ...web,
    portEnvKey: override.portEnvKey,
    defaultPort: override.defaultPort
  } satisfies ManifestWeb;
}

function applyCoreServiceEnvBindingOverrides(serviceId: string, envBindings: ManifestEnvBinding[]) {
  const override = getCoreServicePortOverride(serviceId);
  if (!override) {
    return envBindings;
  }

  const portBindingsByKey = new Map(override.portBindings.map((binding) => [binding.key, binding]));
  const seenPortBindings = new Set<string>();
  const nextBindings = envBindings.map((binding) => {
    const portBinding = portBindingsByKey.get(binding.key);
    if (portBinding) {
      seenPortBindings.add(binding.key);
      return {
        ...binding,
        value: portBinding.value,
        onlyIfDefault: true,
        defaults: mergeStringList(binding.defaults, portBinding.defaults)
      } satisfies ManifestEnvBinding;
    }

    const urlDefaults = override.urlBindingDefaults?.[binding.key];
    if (urlDefaults) {
      return {
        ...binding,
        onlyIfDefault: true,
        defaults: mergeStringList(binding.defaults, urlDefaults)
      } satisfies ManifestEnvBinding;
    }

    return binding;
  });

  for (const binding of override.portBindings) {
    if (seenPortBindings.has(binding.key)) {
      continue;
    }
    nextBindings.push({
      key: binding.key,
      value: binding.value,
      onlyIfDefault: true,
      defaults: binding.defaults
    });
  }

  return nextBindings;
}

function isFrontendMode(value: unknown): value is FrontendMode {
  return value === "none" || value === "embedded" || value === "standalone";
}

function isServiceKind(value: unknown): value is ServiceKind {
  return value === "builtin" || value === "plugin";
}

function toManifestCommand(value: unknown): ManifestCommand | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  const parts = asStringArray(value);
  return parts.length > 0 ? parts : undefined;
}

function resolveFrontend(raw: Record<string, unknown>) {
  const frontend = asObject(raw.frontend);
  const mode = isFrontendMode(frontend.mode) ? frontend.mode : "none";

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

function resolveScripts(raw: Record<string, unknown>) {
  const scripts = asObject(raw.scripts);

  const start = toManifestCommand(scripts.start);
  const stop = toManifestCommand(scripts.stop);
  const deploy = toManifestCommand(scripts.deploy);

  if (!start || !stop) {
    throw new Error("manifest scripts.start/stop are required");
  }

  return {
    start,
    stop,
    deploy
  } satisfies ManifestScripts;
}

function resolveConfigFiles(raw: Record<string, unknown>) {
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

function resolveServiceConfigFiles(raw: Record<string, unknown>, _serviceId: string) {
  return resolveConfigFiles(raw);
}

function resolveRuntime(raw: Record<string, unknown>) {
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

function applyCoreServiceRuntimeOverride(serviceId: string, runtime: ReturnType<typeof resolveRuntime>) {
  if (serviceId !== "agent-platform") {
    return runtime;
  }

  return {
    ...runtime,
    pidRelativePath: "run/agent-platform.pid",
    logRelativePath: "run/agent-platform.log"
  };
}

function resolveApi(raw: Record<string, unknown>) {
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

function resolveBackend(raw: Record<string, unknown>) {
  if (raw.backend === undefined) {
    return undefined;
  }
  const backend = asObject(raw.backend);
  const entry = asOptionalString(backend.entry);
  return entry ? ({ entry } satisfies ManifestBackend) : undefined;
}

function resolveWeb(raw: Record<string, unknown>) {
  if (raw.web === undefined) {
    return {
      routePath: "",
      portEnvKey: "",
      defaultPort: 0
    } satisfies ManifestWeb;
  }

  const web = asObject(raw.web);
  return {
    routePath: asString(web.routePath),
    portEnvKey: asString(web.portEnvKey),
    defaultPort: asNumber(web.defaultPort) ?? 0
  } satisfies ManifestWeb;
}

function normalizeRoutePath(value: unknown) {
  const pathValue = asOptionalString(value);
  if (!pathValue) {
    return "";
  }
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function cloneDisabledResponse(
  response: ManifestDesktopDisabledResponse | undefined
): ManifestDesktopDisabledResponse | undefined {
  if (!response) {
    return undefined;
  }
  return {
    ...(response.status === undefined ? {} : { status: response.status }),
    ...(response.json === undefined ? {} : { json: response.json }),
    ...(response.body === undefined ? {} : { body: response.body }),
    ...(response.contentType === undefined ? {} : { contentType: response.contentType })
  };
}

function cloneDesktopHosting(hosting: ManifestDesktopHosting): ManifestDesktopHosting {
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

function resolveDesktopDisabledResponse(value: unknown): ManifestDesktopDisabledResponse | undefined {
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

function resolveDesktopProxyRoutes(value: unknown): ManifestDesktopProxyRoute[] {
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

function resolveDesktopHosting(raw: Record<string, unknown>) {
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

function resolveDefaultDesktopHosting(serviceId: string, frontend: ManifestFrontend) {
  if (serviceId === "agent-webclient" && frontend.hostManaged === true) {
    return cloneDesktopHosting(DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING);
  }
  return undefined;
}

function resolveEnvBindings(raw: Record<string, unknown>): ManifestEnvBinding[] {
  const desktop = asObject(raw.desktop);
  if (!Array.isArray(desktop.envBindings)) {
    return [];
  }
  const result: ManifestEnvBinding[] = [];
  for (const item of desktop.envBindings) {
    const binding = asObject(item);
    const key = asString(binding.key).trim();
    if (!key) continue;
    const entry: ManifestEnvBinding = { key };
    const value = asOptionalString(binding.value);
    if (value !== undefined) entry.value = value;
    const fromService = asOptionalString(binding.fromService);
    if (fromService !== undefined) entry.fromService = fromService;
    const template = asOptionalString(binding.template);
    if (template !== undefined) entry.template = template;
    const onlyIfDefault = asBoolean(binding.onlyIfDefault);
    if (onlyIfDefault !== undefined) entry.onlyIfDefault = onlyIfDefault;
    if (Array.isArray(binding.defaults)) {
      entry.defaults = binding.defaults.filter((d): d is string => typeof d === "string");
    }
    result.push(entry);
  }
  return result;
}

function resolveCapabilityCommand(value: unknown) {
  const command = toManifestCommand(value);
  return command ?? undefined;
}

function resolveCapabilityProvider(value: unknown): ManifestDesktopCapabilityProvider | null {
  const provider = asObject(value);
  const id = asOptionalString(provider.id);
  if (!id) {
    return null;
  }

  const entry: ManifestDesktopCapabilityProvider = { id };
  const command = resolveCapabilityCommand(provider.command);
  if (command !== undefined) entry.command = command;
  const windowsCommand = resolveCapabilityCommand(provider.windowsCommand);
  if (windowsCommand !== undefined) entry.windowsCommand = windowsCommand;
  const darwinCommand = resolveCapabilityCommand(provider.darwinCommand);
  if (darwinCommand !== undefined) entry.darwinCommand = darwinCommand;
  const linuxCommand = resolveCapabilityCommand(provider.linuxCommand);
  if (linuxCommand !== undefined) entry.linuxCommand = linuxCommand;
  const env = asStringRecord(provider.env);
  if (Object.keys(env).length > 0) entry.env = env;
  if (
    provider.output !== undefined &&
    provider.output !== "file" &&
    provider.output !== "stdoutLastLine"
  ) {
    throw new Error(`invalid Desktop capability output for ${id}: ${String(provider.output)}`);
  }
  const output = provider.output === "file" || provider.output === "stdoutLastLine"
    ? provider.output
    : undefined;
  if (output !== undefined) entry.output = output;
  const outputPath = asOptionalString(provider.outputPath);
  if (outputPath !== undefined) entry.outputPath = outputPath;
  const dependsOn = asStringArray(provider.dependsOn);
  if (dependsOn.length > 0) entry.dependsOn = dependsOn;
  const retryOnSqliteBusy = asBoolean(provider.retryOnSqliteBusy);
  if (retryOnSqliteBusy !== undefined) entry.retryOnSqliteBusy = retryOnSqliteBusy;
  const validateJwtDeviceId = asBoolean(provider.validateJwtDeviceId);
  if (validateJwtDeviceId !== undefined) entry.validateJwtDeviceId = validateJwtDeviceId;
  const allowDeviceIdFallback = asBoolean(provider.allowDeviceIdFallback);
  if (allowDeviceIdFallback !== undefined) entry.allowDeviceIdFallback = allowDeviceIdFallback;
  return entry;
}

function resolveCapabilityRequirement(value: unknown): ManifestDesktopCapabilityRequirement | null {
  const requirement = asObject(value);
  const phase = requirement.phase === "preStart" || requirement.phase === "verifyRunning"
    ? requirement.phase
    : null;
  if (!phase) {
    if (requirement.capability !== undefined || requirement.service !== undefined) {
      throw new Error(`invalid Desktop capability requirement phase: ${String(requirement.phase)}`);
    }
    return null;
  }

  const capability = asOptionalString(requirement.capability);
  const service = asOptionalString(requirement.service);
  if (!capability && !service) {
    return null;
  }

  const action =
    requirement.action === "copyFile" ||
    requirement.action === "preload" ||
    requirement.action === "waitHttp"
      ? requirement.action
      : undefined;
  if (requirement.action !== undefined && action === undefined) {
    throw new Error(`invalid Desktop capability requirement action: ${String(requirement.action)}`);
  }
  const target = asOptionalString(requirement.target);
  return {
    phase,
    ...(capability ? { capability } : {}),
    ...(service ? { service } : {}),
    ...(action ? { action } : {}),
    ...(target ? { target } : {})
  };
}

function resolveDesktopCapabilities(raw: Record<string, unknown>): ManifestDesktopCapabilities & {
  provides: ManifestDesktopCapabilityProvider[];
  requires: ManifestDesktopCapabilityRequirement[];
} {
  const desktop = asObject(raw.desktop);
  const capabilities = asObject(desktop.capabilities);
  const provides = Array.isArray(capabilities.provides)
    ? capabilities.provides.map(resolveCapabilityProvider).filter((item): item is ManifestDesktopCapabilityProvider => Boolean(item))
    : [];
  const requires = Array.isArray(capabilities.requires)
    ? capabilities.requires.map(resolveCapabilityRequirement).filter((item): item is ManifestDesktopCapabilityRequirement => Boolean(item))
    : [];
  return { provides, requires };
}

function resolveDesktop(
  raw: Record<string, unknown>,
  options: NormalizeManifestOptions,
  serviceId: string,
  frontend: ManifestFrontend
) {
  const desktop = asObject(raw.desktop);
  const assetFileName =
    options.desktop?.assetFileName ?? asOptionalString(desktop.assetFileName);
  const bundleTopLevelDir =
    options.desktop?.bundleTopLevelDir ??
    asOptionalString(desktop.bundleTopLevelDir) ??
    serviceId;
  const envBindings = resolveEnvBindings(raw);
  const hosting =
    (options.desktop?.hosting ? cloneDesktopHosting(options.desktop.hosting) : undefined) ??
    resolveDesktopHosting(raw) ??
    resolveDefaultDesktopHosting(serviceId, frontend);
  const capabilities = resolveDesktopCapabilities(raw);

  return {
    assetFileName,
    bundleTopLevelDir,
    envBindings,
    capabilities,
    ...(hosting ? { hosting } : {})
  } satisfies ManifestDesktop & {
    bundleTopLevelDir: string;
    envBindings: ManifestEnvBinding[];
    capabilities: ManifestDesktopCapabilities & {
      provides: ManifestDesktopCapabilityProvider[];
      requires: ManifestDesktopCapabilityRequirement[];
    };
  };
}

function normalizeExecutable(entry: string) {
  if (path.isAbsolute(entry) || entry.startsWith("./") || entry.startsWith("../")) {
    return entry;
  }
  return `./${entry}`;
}

function resolveCommand(command: ManifestCommand | undefined) {
  if (!command) {
    return null;
  }

  const parts = Array.isArray(command) ? command : [command];
  if (parts.length === 0) {
    return null;
  }

  const [entry, ...args] = parts.map((part) => part.trim()).filter(Boolean);
  if (!entry) {
    return null;
  }

  return [normalizeExecutable(entry), ...args];
}

export function normalizeManifest(manifest: Manifest, options: NormalizeManifestOptions = {}): ServiceDefinition {
  const raw = asObject(manifest);
  const id = asOptionalString(raw.id);
  if (!id) {
    throw new Error("manifest id is required");
  }

  const scripts = resolveScripts(raw);
  const runtime = applyCoreServiceRuntimeOverride(id, resolveRuntime(raw));
  const frontend = resolveFrontend(raw);
  const desktop = resolveDesktop(raw, options, id, frontend);
  const web = applyCoreServiceWebOverride(id, resolveWeb(raw));
  const envBindings = applyCoreServiceEnvBindingOverrides(id, desktop.envBindings);

  return {
    id,
    name: asOptionalString(raw.name) ?? id,
    kind: isServiceKind(raw.kind) ? raw.kind : (options.defaultKind ?? "plugin"),
    version: asOptionalString(raw.version) ?? "",
    description: asOptionalString(raw.description) ?? "",
    platform:
      raw.platform === undefined
        ? undefined
        : {
            os: asString(asObject(raw.platform).os),
            arch: asString(asObject(raw.platform).arch)
          },
    frontend,
    frontendMode: frontend.mode,
    api: resolveApi(raw),
    backend: resolveBackend(raw),
    scripts,
    configFiles: resolveServiceConfigFiles(raw, id),
    runtime,
    web,
    prerequisites: asStringArray(raw.prerequisites),
    desktop: {
      ...desktop,
      envBindings
    },
    assetFileName: desktop.assetFileName ?? "",
    bundleTopLevelDir: desktop.bundleTopLevelDir,
    startCommand: resolveCommand(scripts.start) ?? [],
    stopCommand: resolveCommand(scripts.stop) ?? [],
    deployCommand: resolveCommand(scripts.deploy),
    importTargets: []
  };
}

export function readManifestFile(manifestPath: string) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
}

export function listTarEntries(archivePath: string) {
  return [...listArchiveEntries(archivePath)];
}

export function findManifestEntry(archivePath: string) {
  return listTarEntries(archivePath).find((entry) => entry.endsWith("/manifest.json") || entry.endsWith("\\manifest.json") || entry === "manifest.json") ?? null;
}

export function readManifestFromArchive(archivePath: string) {
  const manifestEntry = findManifestEntry(archivePath);
  if (!manifestEntry) {
    throw new Error(`archive does not contain manifest.json: ${archivePath}`);
  }

  const manifestContent = readFileFromArchive(archivePath, manifestEntry);
  return JSON.parse(manifestContent) as Manifest;
}
