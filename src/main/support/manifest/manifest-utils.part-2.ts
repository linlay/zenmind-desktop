import fs from "node:fs";

import path from "node:path";

import {
  DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING
} from "../../../shared/contracts";

import { t } from "../i18n/main-i18n";

import type {
  FrontendMode,
  Manifest,
  ManifestApi,
  ManifestBackend,
  ManifestCommand,
  ManifestConfigFile,
  ManifestDesktop,
  ManifestDesktopAction,
  ManifestDesktopCapabilities,
  ManifestDesktopCapabilityProvider,
  ManifestDesktopCapabilityRequirement,
  ManifestDesktopDisabledResponse,
  ManifestDesktopHosting,
  ManifestDesktopProxyRoute,
  ManifestEnvBinding,
  ManifestFrontend,
  ManifestPluginBridge,
  ManifestPluginHooks,
  ManifestPluginResources,
  ManifestPluginSettingField,
  ManifestPluginSettingPlatform,
  ManifestPluginSettingType,
  ManifestPluginSettingValue,
  ManifestPluginSettings,
  ManifestPluginSettingsUi,
  ManifestRuntime,
  ManifestScripts,
  ManifestWeb,
  ServiceId,
  ServiceKind,
  ServiceMode
} from "../../../shared/contracts";

import { listArchiveEntries, readFileFromArchive } from "../archive/archive-utils";

import { NormalizeManifestOptions, ServiceDefinition, applyCoreServiceRuntimeOverride, applyCoreServiceWebOverride, asBoolean, asNumber, asObject, asOptionalString, asString, asStringArray, asStringRecord, assertNoPluginManifestLegacyFields, cloneDisabledResponse, isServiceKind, normalizeRoutePath, resolveApi, resolveBackend, resolveDesktopActions, resolveFrontend, resolvePluginBridge, resolvePluginHooks, resolvePluginResources, resolvePluginSettings, resolveRuntime, resolveScripts, resolveServiceConfigFiles, resolveServiceMode, resolveWeb, toManifestCommand } from "./manifest-utils.part-1";

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

export function resolveEnvBindings(raw: Record<string, unknown>): ManifestEnvBinding[] {
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

export function resolveCapabilityCommand(value: unknown) {
  const command = toManifestCommand(value);
  return command ?? undefined;
}

export function resolveCapabilityProvider(value: unknown): ManifestDesktopCapabilityProvider | null {
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

export function resolveCapabilityRequirement(value: unknown): ManifestDesktopCapabilityRequirement | null {
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
  const authCapability = asOptionalString(requirement.authCapability);
  return {
    phase,
    ...(capability ? { capability } : {}),
    ...(service ? { service } : {}),
    ...(action ? { action } : {}),
    ...(target ? { target } : {}),
    ...(authCapability ? { authCapability } : {})
  };
}

export function resolveDesktopCapabilities(raw: Record<string, unknown>): ManifestDesktopCapabilities & {
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

export function resolveDesktop(
  raw: Record<string, unknown>,
  options: NormalizeManifestOptions,
  serviceId: string,
  frontend: ManifestFrontend,
  settings: ServiceDefinition["settings"]
) {
  const desktop = asObject(raw.desktop);
  const runtimeResources = asOptionalString(desktop.runtimeResources) === "v1" ? "v1" as const : undefined;
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
  assertAgentWebclientPlatformFramePortHosting(serviceId, frontend, hosting);
  const capabilities = resolveDesktopCapabilities(raw);
  const actions = resolveDesktopActions(raw, settings);

  return {
    ...(runtimeResources ? { runtimeResources } : {}),
    assetFileName,
    bundleTopLevelDir,
    envBindings,
    actions,
    capabilities,
    ...(hosting ? { hosting } : {})
  } satisfies ManifestDesktop & {
    bundleTopLevelDir: string;
    envBindings: ManifestEnvBinding[];
    actions: ManifestDesktopAction[];
    capabilities: ManifestDesktopCapabilities & {
      provides: ManifestDesktopCapabilityProvider[];
      requires: ManifestDesktopCapabilityRequirement[];
    };
  };
}

export function normalizeExecutable(entry: string) {
  if (path.isAbsolute(entry) || entry.startsWith("./") || entry.startsWith("../")) {
    return entry;
  }
  return `./${entry}`;
}

export function resolveCommand(command: ManifestCommand | undefined) {
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
  assertNoPluginManifestLegacyFields(raw, options);
  const id = asOptionalString(raw.id);
  if (!id) {
    throw new Error("manifest id is required");
  }

  const serviceMode = resolveServiceMode(raw);
  const scripts = resolveScripts(raw, serviceMode);
  const runtime = applyCoreServiceRuntimeOverride(id, resolveRuntime(raw));
  const frontend = resolveFrontend(raw);
  const settings = resolvePluginSettings(raw);
  const desktop = resolveDesktop(raw, options, id, frontend, settings);
  const resolvedWeb = resolveWeb(raw);
  const web = applyCoreServiceWebOverride(id, resolvedWeb, options);
  const pluginApiVersion = asNumber(raw.pluginApiVersion) ?? 0;

  return {
    pluginApiVersion,
    id,
    name: asOptionalString(raw.name) ?? id,
    kind: isServiceKind(raw.kind) ? raw.kind : (options.defaultKind ?? "plugin"),
    serviceMode,
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
      envBindings: desktop.envBindings
    },
    hooks: resolvePluginHooks(raw),
    bridge: resolvePluginBridge(raw),
    resources: resolvePluginResources(raw),
    settings,
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
